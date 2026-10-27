"""More app notifications (19.0.8.7): the moments people were missing.

Each is a plain kra.kpi._notify event (feed row + phone push), registered in
kpi_notify.py's tables; this file only decides WHEN they fire and WHO gets them.

  approval_your_turn  an approver: a request reached their step of the chain
  approval_moved      the developer: their own task moved up a step (no reply)
  task_can_start      the developer: every approval is in, start now
  client_replied      the task's developers: the client wrote on it
  meeting_soon        attendees: the task's meeting starts in ~10 minutes
  estimate_80         the developer: 80 % of the estimate is used
  task_running_late   the developer: a timer still runs in the evening
  review_closing      client + admins: the sign-off review closes tomorrow
  database_ready      developer + client: the new database is live
  invoice_overdue     admins: an unpaid invoice is past its due date

Recipients come in through extra_users (the role matrix would resolve
'developer' to the anchor task's assignee, which is right only for some), and
every message renders from ctx alone (_PASSTHROUGH_EVENTS). Never raises: a
notification must not stop the work that triggered it.
"""

import logging
from datetime import datetime, timedelta

import pytz

from odoo import api, fields, models

from .kpi_wa_staff_task import _hm, kpi_tz_name

_logger = logging.getLogger(__name__)

ESTIMATE_WARN_SHARE = 0.8     # estimate_80
LATE_RUN_HOUR = 19            # task_running_late: 7 pm in the person's own time


class KraKpiNotifyMore(models.Model):
    _inherit = 'kra.kpi'

    estimate_warned_at = fields.Datetime(copy=False, readonly=True,
                                         help='When the 80 % estimate warning went; cleared when the estimate changes.')
    late_run_told_on = fields.Date(copy=False, readonly=True,
                                   help='Last day the "still running in the evening" reminder went.')
    review_reminded_at = fields.Datetime(copy=False, readonly=True,
                                         help='When "review closes tomorrow" went; cleared when the review date changes.')

    # ------------------------------------------------------------------ #
    # plumbing                                                            #
    # ------------------------------------------------------------------ #
    def _nudge(self, event, users, **ctx):
        """_notify(event) to exactly these users, with the task's basics in ctx."""
        self.ensure_one()
        ids = [u.id for u in users if u] if not isinstance(users, list) else [u for u in users if u]
        if not ids and event not in ('review_closing', 'database_ready', 'invoice_overdue'):
            return
        base = {'title': self.name or 'Task #%s' % self.id,
                'ref': self.external_ref or '#%s' % self.id,
                'project': (self.kra_id.name or '') if self.kra_id else ''}
        try:
            self._notify(event, extra_users=ids, **dict(base, **ctx))
        except Exception as exc:
            _logger.warning('%s for %s failed: %s', event, self.id, exc)

    def _task_people(self):
        """The assignee and contributors: who works on this task."""
        self.ensure_one()
        return (self.user_id | self.contributor_ids).filtered('active')

    @staticmethod
    def _local(user, dt):
        tz = pytz.timezone(kpi_tz_name(user.env, user))
        return pytz.UTC.localize(dt).astimezone(tz)

    # ------------------------------------------------------------------ #
    # 1 + 2  approval chain                                              #
    # ------------------------------------------------------------------ #
    def _esc_ask(self, tier, kind, note=''):
        users = super()._esc_ask(tier, kind, note)
        try:
            tiers = self.env['kpi.escalation.tier'].chain()
            level = (list(tiers.ids).index(tier.id) + 1) if tier.id in tiers.ids else 1
            who = (self.user_id.name if self.is_self_created and self.user_id
                   else (self.submitted_by_uid.name if getattr(self, 'submitted_by_uid', False) else '')) \
                or 'A request'
            self._nudge('approval_your_turn', users, who=who, level=level, tier=tier.name or '',
                        note_line=('\n%s' % note) if note else '')
            # Moved up (not the first ask, not a reminder of the last step): the
            # developer of their own task hears where it is now.
            if note and note.startswith('⏰') and self.is_self_created and self.user_id:
                self._nudge('approval_moved', self.user_id, level=level, tier=tier.name or '')
        except Exception as exc:
            _logger.warning('approval nudge for %s failed: %s', self.id, exc)
        return users

    # ------------------------------------------------------------------ #
    # 3  you can start now  ·  6  estimate warning reset                  #
    # ------------------------------------------------------------------ #
    def write(self, vals):
        became_startable = self.browse()
        if vals.get('task_state') == 'pre_approval_approved':
            became_startable = self.filtered(lambda r: r.task_state != 'pre_approval_approved')
        if {'estimate_hours', 'estimate_minutes'} & set(vals) and 'estimate_warned_at' not in vals:
            vals = dict(vals, estimate_warned_at=False)
        if 'review_due_at' in vals and 'review_reminded_at' not in vals:
            vals = dict(vals, review_reminded_at=False)
        res = super().write(vals)
        # The same write naming the developer is an assignment: task_assigned
        # already tells them, so "you can start" would only repeat it.
        if became_startable and 'user_id' not in vals:
            for rec in became_startable.filtered(lambda r: r.user_id and r.active):
                rec._nudge('task_can_start', rec._task_people())
        return res

    # ------------------------------------------------------------------ #
    # 6 + 7  timers  (cron, every 10 minutes)                             #
    # ------------------------------------------------------------------ #
    @api.model
    def _cron_timer_nudges(self):
        """80 % of the estimate, and a timer still running in the evening."""
        now = fields.Datetime.now()
        running = self.sudo().search([('task_state', '=', 'in_progress'),
                                      ('timer_start_datetime', '!=', False)], limit=500)
        sent = 0
        for rec in running:
            try:
                live = max(0, (now - rec.timer_start_datetime).total_seconds())
                spent = (rec.timer_total_seconds or 0) + live
                est = (rec.estimate_hours or 0) * 3600 + (rec.estimate_minutes or 0) * 60
                if est and not rec.estimate_warned_at and spent >= est * ESTIMATE_WARN_SHARE:
                    rec.write({'estimate_warned_at': now})
                    rec._nudge('estimate_80', rec._task_people(), spent=_hm(spent), estimate=_hm(est))
                    sent += 1
                user = rec.user_id
                if user:
                    local = rec._local(user, now)
                    if local.hour >= LATE_RUN_HOUR and rec.late_run_told_on != local.date():
                        rec.write({'late_run_told_on': local.date()})
                        rec._nudge('task_running_late', user, at=local.strftime('%I:%M %p').lstrip('0'),
                                   running=_hm(live))
                        sent += 1
            except Exception as exc:
                _logger.warning('timer nudge for %s failed: %s', rec.id, exc)
        return sent

    # ------------------------------------------------------------------ #
    # 4  the client wrote                                                 #
    # ------------------------------------------------------------------ #
    CLIENT_BURST_MIN = 3     # one push per burst, not one per line typed

    def chat_post_client(self, text, name='', number='', source='whatsapp', files=None, reply_to=None):
        msg = super().chat_post_client(text, name=name, number=number, source=source,
                                       files=files, reply_to=reply_to)
        try:
            since = fields.Datetime.now() - timedelta(minutes=self.CLIENT_BURST_MIN)
            earlier = self.env['kpi.chat.message'].sudo().search_count([
                ('kpi_id', '=', self.id), ('side', '=', 'client'),
                ('create_date', '>=', since), ('id', '!=', msg.id if msg else 0)])
            if not earlier:
                snippet = ' '.join((text or '').split())
                snippet = (snippet[:117] + '…') if len(snippet) > 120 else (snippet or '📎 a file')
                client = name or (self.client_kra_id.name if self.client_kra_id else '') or 'The client'
                self._nudge('client_replied', self._chat_task_devs(), client=client, snippet=snippet)
        except Exception as exc:
            _logger.warning('client_replied for %s failed: %s', self.id, exc)
        return msg

    # ------------------------------------------------------------------ #
    # 9  the new database is live                                         #
    # ------------------------------------------------------------------ #
    def set_provision_step(self, field, value):
        was = {rec.id: bool(rec.provision_chk_registered) for rec in self}
        res = super().set_provision_step(field, value)
        if field == 'provision_chk_registered' and value:
            for rec in self.filtered(lambda r: not was.get(r.id) and r.provision_chk_registered):
                rec._nudge('database_ready', rec._task_people() | rec.requested_by_id,
                           db=rec.provision_db_name or '—', url=rec.provision_url or '—')
        return res

    # ------------------------------------------------------------------ #
    # 8  review closes tomorrow  (cron, hourly)                           #
    # ------------------------------------------------------------------ #
    @api.model
    def _cron_review_closing(self):
        now = fields.Datetime.now()
        due = self.sudo().search([('task_state', '=', 'awaiting_client'),
                                  ('review_due_at', '>', now),
                                  ('review_due_at', '<=', now + timedelta(hours=24)),
                                  ('review_reminded_at', '=', False)], limit=200)
        for rec in due:
            try:
                rec.write({'review_reminded_at': now})
                who = rec.user_id or self.env.user
                rec._nudge('review_closing', [],
                           due=rec._local(who, rec.review_due_at).strftime('%a %d %b, %I:%M %p'))
            except Exception as exc:
                _logger.warning('review_closing for %s failed: %s', rec.id, exc)
        return len(due)


class KpiMeetingNotifyMore(models.Model):
    _inherit = 'kpi.meeting'

    # ------------------------------------------------------------------ #
    # 5  meeting in ~10 minutes: when the meeting opens (its lead time)   #
    # ------------------------------------------------------------------ #
    def _open(self):
        res = super()._open()
        for m in self:
            try:
                users = (m.organizer_id | m.attendee_user_ids).filtered('active')
                if not users or not m.scheduled_start:
                    continue
                now = fields.Datetime.now()
                mins = max(0, int(round((m.scheduled_start - now).total_seconds() / 60)))
                at = m.kpi_id._local(users[0], m.scheduled_start).strftime('%I:%M %p').lstrip('0')
                m.kpi_id._nudge('meeting_soon', users, meeting=m.name or 'Meeting', at=at, mins=mins)
            except Exception as exc:
                _logger.warning('meeting_soon for %s failed: %s', m.id, exc)
        return res


class KpiClientInvoiceNotifyMore(models.Model):
    _inherit = 'kpi.client.invoice'

    overdue_told_on = fields.Date(copy=False, readonly=True,
                                  help='Last day admins were told this invoice is overdue (repeats weekly).')

    OVERDUE_REPEAT_DAYS = 7

    # ------------------------------------------------------------------ #
    # 10  invoice overdue  (cron, hourly; once a week per invoice)        #
    # ------------------------------------------------------------------ #
    @api.model
    def _cron_invoice_overdue(self):
        """Due = invoice date + payment term (kra_kpi.payment_term_days, as the
        invoice page shows it). Tells the admins, then again every week."""
        term = int(self.env['ir.config_parameter'].sudo().get_param('kra_kpi.payment_term_days', 15) or 15)
        today = fields.Date.context_today(self)
        anchor = self.env['kra.kpi'].sudo().search([], order='id desc', limit=1)
        if not anchor:
            return 0
        told = 0
        for inv in self.sudo().search([('payment_status', '=', 'unpaid'),
                                       ('state', 'in', ('finalized', 'sent')),
                                       ('invoice_date', '!=', False),
                                       ('invoice_date', '<', today - timedelta(days=term))], limit=200):
            try:
                if inv.overdue_told_on and inv.overdue_told_on > today - timedelta(days=self.OVERDUE_REPEAT_DAYS):
                    continue
                days = (today - (inv.invoice_date + timedelta(days=term))).days
                amount = ('%s %.2f' % (inv.currency_id.symbol or '', inv.total_amount)).strip() \
                    if inv.total_amount else '—'
                inv.write({'overdue_told_on': today})
                anchor.with_context(kpi_invoice_id=inv.id)._notify(
                    'invoice_overdue', extra_users=[], number=inv.name or '',
                    client=(inv.client_kra_id.name or '') if inv.client_kra_id else '',
                    days=days, amount=amount)
                told += 1
            except Exception as exc:
                _logger.warning('invoice_overdue for %s failed: %s', inv.id, exc)
        return told
