"""Finishing a task: Partial Complete -> client check -> Full Complete -> bill.

Oct 2026 rules:

* The developer's finish (Partial Finish or Complete, manual optional) goes
  STRAIGHT to the client: no admin check in between (the admins are told and
  can still revert). Turn the admin check back on with the ICP
  `kra_kpi.client_review_skip_admin` = 0.
* The client says ✅ Finished, or sends it back WITH what is still wrong. Sent
  back = rework for the same developer, no manager in between.
* No answer in `kra_kpi.client_review_days` days (default 3) closes the review
  on its own. The clock restarts with every new finish.
* Either way the task then waits for FULL COMPLETE: the user manual (and the
  GitHub link for a module / app) must be on it. Already there -> done at once.
  Missing -> the developer is asked. Full Complete is what billing counts.

States, so nothing else in the module has to learn a new one:
  awaiting_client                         = with the client (the timer runs)
  completed + full_complete_pending       = waiting for Full Complete
  completed + full_complete_at            = Full Complete, billable
"""

import logging
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

PARAM_REVIEW_DAYS = 'kra_kpi.client_review_days'
PARAM_SKIP_ADMIN = 'kra_kpi.client_review_skip_admin'
DEFAULT_REVIEW_DAYS = 3


class KraKpiFinish(models.Model):
    _inherit = 'kra.kpi'

    review_started_at = fields.Datetime(string='With Client Since', copy=False, readonly=True)
    review_due_at = fields.Datetime(string='Client Review Ends', copy=False, readonly=True, index=True)
    review_close_reason = fields.Selection([
        ('client', 'Client said finished'),
        ('timeout', 'No client reply in time'),
        ('admin', 'Closed by an admin'),
    ], string='Client Review Closed By', copy=False, readonly=True)
    client_revert_count = fields.Integer(string='Sent Back by Client', copy=False, readonly=True)
    full_complete_pending = fields.Boolean(
        string='Waiting for Full Complete', copy=False, readonly=True, index=True,
        help='The client review is over; the user manual (and GitHub link for a '
             'module / app) must be added and Full Complete tapped.')
    full_complete_at = fields.Datetime(string='Full Complete On', copy=False, readonly=True, index=True)
    full_complete_by_id = fields.Many2one('res.users', string='Full Complete By', copy=False,
                                          readonly=True, ondelete='set null')

    # ------------------------------------------------------------------ #
    @api.model
    def _review_days(self):
        raw = self.env['ir.config_parameter'].sudo().get_param(PARAM_REVIEW_DAYS, DEFAULT_REVIEW_DAYS)
        try:
            return max(1, min(60, int(raw)))
        except (TypeError, ValueError):
            return DEFAULT_REVIEW_DAYS

    @api.model
    def _skip_admin_qa(self):
        val = self.env['ir.config_parameter'].sudo().get_param(PARAM_SKIP_ADMIN, '1')
        return val not in ('0', 'false', 'False', '')

    def _wa_ask_admins(self, kind=None):
        # The finish goes to the client, not to an admin's QA link.
        if kind == 'qa' and self.env.context.get('kpi_finish_skip_qa'):
            return 0
        return super()._wa_ask_admins(kind)

    # ------------------------------------------------------------------ #
    # Developer finishes -> the client                                     #
    # ------------------------------------------------------------------ #
    def complete_task(self, employee_checklist=None):
        if not self._skip_admin_qa():
            return super().complete_task(employee_checklist=employee_checklist)
        recs = self.with_context(kpi_finish_skip_qa=True)
        result = super(KraKpiFinish, recs).complete_task(employee_checklist=employee_checklist)
        for rec in recs:
            if rec.task_state == 'partially_completed' and not rec.admin_approved:
                rec._send_to_client_review()
        return result

    def _send_to_client_review(self):
        """partially_completed -> awaiting_client without an admin's check.
        approve_task does the rest the same way an admin's tap would: a fresh
        sign-off link, or straight to completed when the client has nobody who
        could sign."""
        self.ensure_one()
        me = self.env.user
        self.sudo().with_context(kpi_finish_auto_review=True).approve_task()
        self.sudo().write({'admin_approved_by': False})
        self._log_action('client_review_started', source='system',
                         actor_user_id=me.id,
                         payload={'days': self._review_days(), 'state': self.task_state})

    # ------------------------------------------------------------------ #
    # Watch the state moves, whichever path made them                      #
    # ------------------------------------------------------------------ #
    def write(self, vals):
        new_state = vals.get('task_state')
        if not new_state or self.env.context.get('kpi_finish_in_write'):
            return super().write(vals)
        into_review = self.filtered(lambda r: r.task_state != 'awaiting_client') \
            if new_state == 'awaiting_client' else self.browse()
        out_of_review = self.filtered(lambda r: r.task_state == 'awaiting_client') \
            if new_state != 'awaiting_client' else self.browse()
        into_done = self.filtered(lambda r: r.task_state != 'completed' and not r.full_complete_at) \
            if new_state == 'completed' and not self.env.context.get('kpi_full_complete') else self.browse()
        sent_back = out_of_review.filtered(lambda r: new_state == 'rework')
        res = super().write(vals)
        inner = self.with_context(kpi_finish_in_write=True).sudo()
        now = fields.Datetime.now()
        if into_review:
            days = self._review_days()
            inner.browse(into_review.ids).write({
                'review_started_at': now,
                'review_due_at': now + timedelta(days=days),
                'review_close_reason': False,
                'full_complete_pending': False,
            })
            into_review._after_commit_in_background('_finish_tell_review')
        for rec in inner.browse(sent_back.ids):
            rec.write({'review_due_at': False, 'review_close_reason': False,
                       'client_revert_count': rec.client_revert_count + 1})
        if sent_back:
            sent_back._after_commit_in_background('_finish_tell_revert')
        other_out = out_of_review - sent_back - into_done
        if other_out:
            inner.browse(other_out.ids).write({'review_due_at': False})
        for rec in inner.browse(into_done.ids):
            reason = vals.get('review_close_reason') or rec.review_close_reason or (
                'client' if rec.client_final_approved else 'admin')
            rec.write({'full_complete_pending': True, 'review_due_at': False,
                       'review_close_reason': reason})
        if into_done:
            into_done._after_commit_in_background('_finish_after_review')
        return res

    # ------------------------------------------------------------------ #
    # The client sends it back: a reason is a must                         #
    # ------------------------------------------------------------------ #
    def record_client_final_decision(self, action, partner_name='', feedback='', source='web',
                                     ip=None, user_agent=None, partner_id=None):
        if action == 'reject' and len((feedback or '').strip()) < 3:
            raise UserError(_('Please write what is still wrong, so the developer knows what to fix.'))
        return super().record_client_final_decision(
            action, partner_name=partner_name, feedback=feedback, source=source,
            ip=ip, user_agent=user_agent, partner_id=partner_id)

    # ------------------------------------------------------------------ #
    # No reply in time                                                     #
    # ------------------------------------------------------------------ #
    @api.model
    def _cron_client_review_timeout(self):
        now = fields.Datetime.now()
        self.env['kra.kpi'].flush_model(['task_state', 'active', 'review_due_at'])
        self.env.cr.execute("""
            SELECT id FROM kra_kpi
             WHERE task_state = 'awaiting_client' AND active
               AND review_due_at IS NOT NULL AND review_due_at <= %s
             ORDER BY review_due_at
             LIMIT 50
               FOR UPDATE SKIP LOCKED""", (now,))
        ids = [r[0] for r in self.env.cr.fetchall()]
        for rec in self.sudo().browse(ids):
            try:
                with self.env.cr.savepoint():
                    rec.write({'task_state': 'completed', 'review_close_reason': 'timeout',
                               'approval_token_used': True, 'approval_date': now})
                    rec._log_action('client_review_timeout', source='cron',
                                    payload={'days': self._review_days()})
            except Exception as exc:
                _logger.warning('client review timeout for %s failed: %s', rec.id, exc)
        return len(ids)

    # ------------------------------------------------------------------ #
    # Full Complete                                                        #
    # ------------------------------------------------------------------ #
    def _finish_payload(self):
        """What every task screen needs about the finish (board, web, app)."""
        self.ensure_one()
        dt = fields.Datetime.to_string
        return {
            'review_started_at': dt(self.review_started_at) if self.review_started_at else '',
            'review_due_at': dt(self.review_due_at) if self.review_due_at else '',
            'review_close_reason': self.review_close_reason or '',
            'client_revert_count': self.client_revert_count or 0,
            'full_complete_pending': bool(self.full_complete_pending),
            'full_complete_at': dt(self.full_complete_at) if self.full_complete_at else '',
            'full_complete_missing': self._full_complete_missing() if self.full_complete_pending else [],
        }

    def _full_complete_missing(self):
        """What Full Complete still needs, as plain sentences (empty = ready)."""
        self.ensure_one()
        out = []
        if not self.env['kpi.user.manual'].sudo().search_count([('kpi_id', '=', self.id)]):
            out.append(_('Upload the user manual (PDF, DOC or DOCX).'))
        if self._github_required() and not self.env['kpi.github.link'].sudo().search_count(
                [('kpi_id', '=', self.id)]):
            out.append(_('Add the GitHub link (repository + branch) — this is a Module / App task.'))
        return out

    def _may_full_complete(self, user):
        """'' when `user` may tap Full Complete on this task, else why not."""
        self.ensure_one()
        if self.task_state != 'completed' or not self.full_complete_pending:
            return _('%s is not waiting for Full Complete.') % (self.external_ref or self.name)
        if user and (user == self.user_id or self._is_kpi_admin_user(user)):
            return ''
        return _('Only the developer on this task or an admin can do Full Complete.')

    def full_complete(self, user=None, source='web', auto=False):
        """Close the task for billing. Raises UserError with what is missing."""
        self.ensure_one()
        user = user or self.env.user
        if not auto:
            why = self._may_full_complete(user)
            if why:
                raise UserError(why)
        elif self.task_state != 'completed' or not self.full_complete_pending:
            return False
        missing = self._full_complete_missing()
        if missing:
            raise UserError(_('Before Full Complete:\n• %s') % '\n• '.join(missing))
        self.sudo().with_context(kpi_full_complete=True).write({
            'full_complete_pending': False,
            'full_complete_at': fields.Datetime.now(),
            'full_complete_by_id': user.id if user else False,
        })
        self._log_action('full_complete', source=source,
                         actor_user_id=user.id if user else None,
                         payload={'auto': bool(auto), 'closed_by': self.review_close_reason or ''})
        self._after_commit_in_background('_finish_after_full')
        return True

    # ------------------------------------------------------------------ #
    # Messages (all run after commit, in the background; never raise)       #
    # ------------------------------------------------------------------ #
    def _finish_ref(self):
        return self.external_ref or '#%s' % self.id

    def _finish_alpha(self, text, users=None):
        Report = self.env['kpi.wa.group.report'].sudo()
        mentions = [d for d in (Report._mention_digits(u) for u in (users or [])) if d]
        try:
            Report._post(text, mentions=mentions or None)
        except Exception as exc:
            _logger.warning('alpha post for %s failed: %s', self.id, exc)

    def _finish_client_group(self, text):
        try:
            return self.env['kpi.wa.group.report'].sudo().post_for_kpi(self, text)
        except Exception as exc:
            _logger.warning('client group post for %s failed: %s', self.id, exc)
            return False

    def _finish_dm(self, user, text):
        try:
            return self.env['kpi.wa.group.report'].sudo().post_text_to_user(user, text)
        except Exception as exc:
            _logger.warning('dm for %s failed: %s', self.id, exc)
            return False

    def _finish_tell_review(self):
        Report = self.env['kpi.wa.group.report'].sudo()
        Intake = self.env['kpi.wa.group.intake'].sudo()
        days = self._review_days()
        for rec in self:
            if rec.task_state != 'awaiting_client':
                continue
            ref, dev = rec._finish_ref(), rec.user_id
            link = Intake._approval_link(rec) if hasattr(Intake, '_approval_link') else ''
            text = _('✅ *%(ref)s* — %(name)s\n\nOur team has finished this. Please check it on your side.\n') % {
                'ref': ref, 'name': rec.name or ''}
            if link:
                text += _('👉 Tap to say it is finished, or send it back with what is wrong:\n%s\n') % link
            text += _('\nIf we don\'t hear back in %d days, we\'ll close it.') % days
            rec._finish_client_group(text)
            who = Report._mention(dev) if dev else _('The team')
            rec._finish_alpha(_('✅ %(who)s finished *%(ref)s* — %(name)s. It is with the client to check '
                                '(%(days)d days).') % {'who': who, 'ref': ref, 'name': rec.name or '',
                                                       'days': days}, users=dev)

    def _finish_tell_revert(self):
        Report = self.env['kpi.wa.group.report'].sudo()
        for rec in self:
            ref, dev = rec._finish_ref(), rec.user_id
            why = (rec.pre_approval_feedback or '').strip() or _('(no details)')
            who = Report._mention(dev) if dev else _('team')
            rec._finish_alpha(_('↩️ The client sent *%(ref)s* back: %(why)s\n%(who)s, it is back with you.') % {
                'ref': ref, 'why': why, 'who': who}, users=dev)
            rec._finish_client_group(_('↩️ Got it — *%s* is back with our team. We\'ll tell you when it is ready again.')
                                     % ref)
            if dev:
                rec._finish_dm(dev, _('↩️ The client sent %(ref)s — %(name)s back.\n\nWhat\'s wrong: %(why)s\n\n'
                                      'Start it again from 📋 My tasks when you are on it.') % {
                    'ref': ref, 'name': rec.name or '', 'why': why})

    def _finish_after_review(self):
        """Review over (client said finished, or the timer): Full Complete now
        if everything is already on the task, else ask the developer."""
        Report = self.env['kpi.wa.group.report'].sudo()
        for rec in self:
            if rec.task_state != 'completed' or not rec.full_complete_pending:
                continue
            if not rec._full_complete_missing():
                try:
                    rec.full_complete(user=rec.user_id, source='system', auto=True)
                    continue
                except Exception as exc:
                    _logger.warning('auto full complete for %s failed: %s', rec.id, exc)
            ref, dev = rec._finish_ref(), rec.user_id
            timeout = rec.review_close_reason == 'timeout'
            head = (_('⏰ The client hasn\'t closed %s in %d days.') % (ref, rec._review_days())) if timeout \
                else (_('👍 The client said %s is finished.') % ref)
            if dev:
                rec._finish_dm(dev, _('%(head)s\n\nUpload the user manual and tap 🏁 Full Complete so it moves to '
                                      'billing.\nNeeded: %(need)s\n\nIn WhatsApp: 📋 My tasks → %(ref)s → '
                                      '📋 KPI details → open the page → 🏁 Full Complete.') % {
                    'head': head, 'need': ' '.join(rec._full_complete_missing()), 'ref': ref})
            who = Report._mention(dev) if dev else _('team')
            rec._finish_alpha(_('%(head)s %(who)s, upload the user manual → 🏁 Full Complete.') % {
                'head': head, 'who': who}, users=dev)

    def _finish_after_full(self):
        for rec in self:
            # kpi_billing.py makes the bill and tells everyone (or says why not).
            try:
                rec._auto_bill()
            except Exception as exc:
                _logger.warning('auto bill for %s failed: %s', rec.id, exc)
                rec._finish_alpha(_('🏁 *%s* is fully complete — the bill could not be made: %s')
                                  % (rec._finish_ref(), exc))
