"""Meetings: requested on WhatsApp, confirmed by a person, opened by a cron.

WHAT WAS THERE BEFORE
---------------------
`📅 Request a Meeting` existed in the intake menu and produced an ordinary
Requirement ticket (`kpi_wa_group_intake.py` mapped 'meeting' -> 'requirement'
and nothing else happened). `kra.kpi.is_meeting` existed as a Boolean that no
code read. Everything else in the module called "meeting" -- `kpi.break.log`,
`kpi.nontask.block` -- is developer TIME ACCOUNTING: a record that somebody was
in a meeting, not a meeting anybody could join.

So a client could ask for a call and nothing was scheduled, nobody was named,
and no link existed.

THREE THINGS A MEETING NEEDS, AND WHO SUPPLIES THEM
---------------------------------------------------
* WHEN  -- the client taps a slot, or asks for a time in their own words.
* WHO   -- an ADMIN names the person who will join. This is deliberately not
           guessed from the ticket's assignee: at the point a meeting is
           requested the ticket usually has no assignee at all, and telling a
           client "Rashid will call you" because of a default is worse than
           asking somebody to choose.
* WHERE -- a join link, minted on confirmation.

WHY JITSI
---------
`meet.jit.si` needs no account, no OAuth and no API key, and works in a phone
browser. Google Meet would need a service account with domain-wide delegation
-- a deployment project of its own -- and Odoo has no credentials for one here.
`provider='manual'` covers the case where somebody wants to paste a Meet or
Zoom link instead.

A public Jitsi room is only as private as its URL, so the room name carries 8
random hex characters. Point `kra_kpi.meet_base_url` at a self-hosted Jitsi if
that is not enough.

NOTHING IS RECORDED AUTOMATICALLY
---------------------------------
No software inside Odoo can record a call. Jitsi needs a separate Jibri
service to record server-side. "Recording" here means somebody uploads the
file afterwards, and the summary is typed -- or drafted by `kpi.ai` when a key
is configured, which none is today.

THE CRON OPENS, IT DOES NOT DECIDE
----------------------------------
`_cron_open_meetings` posts the link for a meeting a human already confirmed.
It never creates, confirms, reschedules or cancels anything.
"""

import logging
import secrets

from odoo import _, api, fields, models
from odoo.exceptions import UserError, ValidationError

_logger = logging.getLogger(__name__)

DEFAULT_MEET_BASE = 'https://meet.jit.si'
DEFAULT_LEAD_MINUTES = 10
DEFAULT_REMIND_MINUTES = 60
DEFAULT_DURATION = 30

# A room name a stranger cannot guess. 8 hex characters is 4 billion rooms;
# the limit on a public Jitsi is the URL staying unshared, not the entropy.
ROOM_SUFFIX_BYTES = 4


class KpiMeeting(models.Model):
    _name = 'kpi.meeting'
    _description = 'Client Meeting'
    _order = 'scheduled_start desc, id desc'
    _rec_name = 'name'

    name = fields.Char(required=True, string='Subject')
    kpi_id = fields.Many2one(
        'kra.kpi', string='Task', required=True, ondelete='cascade',
        index=True, help='The request this meeting belongs to.')
    client_kra_id = fields.Many2one(
        'kra.master', string='Client', related='kpi_id.client_kra_id',
        store=True, index=True)
    client_db_id = fields.Many2one(
        'kpi.client.db', string='Database', related='kpi_id.client_db_id',
        store=True)

    # ---- when ---------------------------------------------------------- #
    scheduled_start = fields.Datetime(
        string='Starts', index=True,
        help='Empty while the client has asked for a time in their own words '
             'and nobody has set one yet.')
    duration_minutes = fields.Integer(default=DEFAULT_DURATION,
                                      string='Minutes')
    scheduled_end = fields.Datetime(compute='_compute_scheduled_end',
                                    store=True)
    requested_text = fields.Char(
        string='Asked For',
        help="The client's own words when they did not tap a slot.")
    local_when = fields.Char(compute='_compute_local_when',
                             string='Local Time')

    # ---- who ----------------------------------------------------------- #
    organizer_id = fields.Many2one(
        'res.users', string='Who Will Join', ondelete='set null',
        help='The person from our side. Named to the client when the link '
             'goes out, so they know who to expect.')
    attendee_user_ids = fields.Many2many(
        'res.users', 'kpi_meeting_user_rel', 'meeting_id', 'user_id',
        string='Also Joining')
    requested_by_name = fields.Char(string='Asked By', readonly=True)
    requested_by_number = fields.Char(string='Asked By (number)',
                                      readonly=True)

    # ---- where --------------------------------------------------------- #
    provider = fields.Selection([
        ('jitsi', 'Jitsi (no account needed)'),
        ('manual', 'A link I will paste'),
    ], default='jitsi', required=True)
    room_name = fields.Char(readonly=True)
    join_url = fields.Char(string='Join Link')

    # ---- lifecycle ----------------------------------------------------- #
    state = fields.Selection([
        ('requested', 'Requested'),
        ('confirmed', 'Confirmed'),
        ('live', 'Opened'),
        ('done', 'Finished'),
        ('cancelled', 'Cancelled'),
    ], default='requested', required=True, index=True)
    confirmed_by_id = fields.Many2one('res.users', readonly=True,
                                      ondelete='set null')
    confirmed_at = fields.Datetime(readonly=True)
    reminder_sent_at = fields.Datetime(readonly=True)
    link_posted_at = fields.Datetime(readonly=True)
    opened_at = fields.Datetime(readonly=True)
    ended_at = fields.Datetime(readonly=True)
    cancel_reason = fields.Text(readonly=True)

    # ---- after --------------------------------------------------------- #
    recording_ids = fields.Many2many(
        'ir.attachment', 'kpi_meeting_recording_rel', 'meeting_id',
        'attachment_id', string='Recordings',
        help='Uploaded by hand after the call. Nothing records it for you.')
    summary = fields.Text()
    summary_source = fields.Char(readonly=True)
    action_items = fields.Text()
    summary_posted = fields.Boolean(readonly=True)

    notes = fields.Text(help='Internal only. Never sent to the client.')

    # ------------------------------------------------------------------
    # computes
    # ------------------------------------------------------------------
    @api.depends('scheduled_start', 'duration_minutes')
    def _compute_scheduled_end(self):
        from datetime import timedelta
        for rec in self:
            if rec.scheduled_start:
                rec.scheduled_end = rec.scheduled_start + timedelta(
                    minutes=rec.duration_minutes or DEFAULT_DURATION)
            else:
                rec.scheduled_end = False

    @api.depends('scheduled_start')
    def _compute_local_when(self):
        Tz = self.env['kpi.tz']
        for rec in self:
            rec.local_when = Tz.fmt(rec.scheduled_start) \
                if rec.scheduled_start else ''

    # ------------------------------------------------------------------
    # config
    # ------------------------------------------------------------------
    @api.model
    def _param(self, key, default):
        raw = self.env['ir.config_parameter'].sudo().get_param(
            'kra_kpi.%s' % key)
        if raw in (None, False, ''):
            return default
        if isinstance(default, int):
            try:
                return int(raw)
            except (TypeError, ValueError):
                return default
        return raw

    # ------------------------------------------------------------------
    # the link
    # ------------------------------------------------------------------
    def _mint_join_url(self):
        """A room nobody can guess, named so a human can recognise it."""
        self.ensure_one()
        if self.provider != 'jitsi':
            return self.join_url or ''
        ref = (self.kpi_id.external_ref or str(self.kpi_id.id) or 'kpi')
        slug = ''.join(ch for ch in ref.lower() if ch.isalnum() or ch == '-')
        room = 'alphalize-%s-%s' % (slug, secrets.token_hex(ROOM_SUFFIX_BYTES))
        base = (self._param('meet_base_url', DEFAULT_MEET_BASE) or '').rstrip('/')
        self.sudo().write({'room_name': room,
                           'join_url': '%s/%s' % (base, room)})
        return self.join_url

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------
    def action_confirm(self):
        """Lock in the time and the person, mint the link, tell the client."""
        for rec in self:
            if rec.state not in ('requested', 'confirmed'):
                raise UserError(_('%s is already %s.') % (rec.name, rec.state))
            if not rec.scheduled_start:
                raise UserError(_(
                    'Set a start time first — the client asked for '
                    '"%s".') % (rec.requested_text or '—'))
            if not rec.organizer_id:
                raise UserError(_(
                    'Say who will join. The client is told their name, and '
                    '"somebody will call you" is how a meeting gets missed.'))
            if rec.provider == 'manual' and not rec.join_url:
                raise UserError(_('Paste the meeting link, or switch the '
                                  'provider to Jitsi to generate one.'))
            if rec.provider == 'jitsi' and not rec.join_url:
                rec._mint_join_url()
            rec.sudo().write({'state': 'confirmed',
                              'confirmed_by_id': rec.env.user.id,
                              'confirmed_at': fields.Datetime.now()})
            rec._log('meeting_confirmed', {
                'when': fields.Datetime.to_string(rec.scheduled_start),
                'who': rec.organizer_id.name, 'url': rec.join_url})
            rec._post_confirmation()
        return True

    def action_cancel(self, reason=''):
        for rec in self:
            if rec.state == 'done':
                raise UserError(_('%s already happened.') % rec.name)
            rec.sudo().write({'state': 'cancelled',
                              'cancel_reason': reason or rec.cancel_reason})
            rec._log('meeting_cancelled', {'reason': reason})
            rec._post(_(
                "❌ *Meeting cancelled*\n"
                "%(subject)s\n"
                "Was: %(when)s\n\n"
                "%(reason)s") % {
                    'subject': rec.name or '',
                    'when': rec.local_when or _('not yet set'),
                    'reason': reason or _('We will be in touch to rearrange.')})
        return True

    def action_mark_done(self):
        for rec in self:
            rec.sudo().write({'state': 'done',
                              'ended_at': fields.Datetime.now()})
            rec._log('meeting_done', {})
        return True

    def action_open_now(self):
        """Post the link immediately, whatever the clock says."""
        for rec in self:
            if rec.state != 'confirmed':
                raise UserError(_('Confirm %s first.') % rec.name)
            rec._open()
        return True

    def action_post_summary(self):
        """Send the written summary to the client's group."""
        for rec in self:
            if not (rec.summary or '').strip():
                raise UserError(_('Write the summary first.'))
            body = _(
                "📝 *Meeting summary*\n"
                "%(subject)s — %(when)s\n\n"
                "%(summary)s") % {
                    'subject': rec.name or '',
                    'when': rec.local_when or '',
                    'summary': rec.summary}
            if (rec.action_items or '').strip():
                body += _('\n\n*Next steps*\n%s') % rec.action_items
            if rec._post(body):
                rec.sudo().write({'summary_posted': True})
                rec._log('meeting_summary_posted', {})
        return True

    # ------------------------------------------------------------------
    # talking to the client
    # ------------------------------------------------------------------
    def _post(self, body):
        """Into the group that belongs to THIS meeting's client. Never raises."""
        self.ensure_one()
        try:
            return bool(self.env['kpi.wa.group.report'].sudo()
                        .post_for_kpi(self.kpi_id, body))
        except Exception as exc:
            _logger.warning('meeting %s: could not post: %s', self.id, exc)
            return False

    def _who_line(self):
        """'Rashid' or 'Rashid and 2 others' -- the answer to "which person?"."""
        self.ensure_one()
        names = [self.organizer_id.name] if self.organizer_id else []
        extra = [u.name for u in self.attendee_user_ids
                 if u != self.organizer_id]
        if not names and not extra:
            return _('our team')
        if not extra:
            return names[0]
        if len(extra) == 1:
            return _('%(a)s and %(b)s') % {'a': names[0] or extra[0],
                                           'b': extra[0]}
        return _('%(a)s and %(n)s others') % {'a': names[0] or extra[0],
                                              'n': len(extra)}

    def _post_confirmation(self):
        """Told at confirmation, so the client can put it in their day."""
        self.ensure_one()
        return self._post(_(
            "📅 *Meeting confirmed*%(ref)s\n"
            "%(subject)s\n\n"
            "🕒 %(when)s\n"
            "👤 %(who)s will join\n"
            "🔗 %(url)s\n\n"
            "_The link will be posted again just before we start. "
            "Nothing to install — it opens in your browser._") % {
                'ref': (' — %s' % self.kpi_id.external_ref)
                       if self.kpi_id.external_ref else '',
                'subject': self.name or '',
                'when': self.local_when or '',
                'who': self._who_line(),
                'url': self.join_url or '—'})

    def _open(self):
        """Post the link and mark it opened. The 'auto-opened meeting'."""
        self.ensure_one()
        posted = self._post(_(
            "🔴 *Starting now*\n"
            "%(subject)s\n\n"
            "👤 %(who)s is waiting\n"
            "🔗 %(url)s") % {
                'subject': self.name or '',
                'who': self._who_line(),
                'url': self.join_url or '—'})
        self.sudo().write({'state': 'live',
                           'opened_at': fields.Datetime.now(),
                           'link_posted_at': fields.Datetime.now()})
        self._log('meeting_opened', {'posted': posted, 'url': self.join_url})
        try:
            self.kpi_id.sudo()._notify(
                'meeting_opening',
                extra_users=(self.organizer_id | self.attendee_user_ids).ids)
        except Exception as exc:
            # A notification must never stop a meeting opening.
            _logger.info('meeting %s: team notify skipped (%s)', self.id, exc)
        return posted

    def _remind(self):
        self.ensure_one()
        posted = self._post(_(
            "⏰ *Reminder — in about an hour*\n"
            "%(subject)s\n"
            "🕒 %(when)s\n"
            "👤 %(who)s\n"
            "🔗 %(url)s") % {
                'subject': self.name or '',
                'when': self.local_when or '',
                'who': self._who_line(),
                'url': self.join_url or '—'})
        self.sudo().write({'reminder_sent_at': fields.Datetime.now()})
        return posted

    # ------------------------------------------------------------------
    def _log(self, event, payload):
        self.ensure_one()
        try:
            self.kpi_id.sudo()._log_action(
                event, source='web',
                actor_user_id=self.env.user.id if self.env.user else None,
                payload=dict(payload or {}, meeting_id=self.id,
                             subject=self.name))
        except Exception as exc:
            _logger.warning('meeting %s: could not log %s: %s',
                            self.id, event, exc)

    # ------------------------------------------------------------------
    # crons -- they open and remind, they never decide
    # ------------------------------------------------------------------
    @api.model
    def _cron_open_meetings(self):
        """Post the link for confirmed meetings that are about to start."""
        from datetime import timedelta
        lead = self._param('meet_open_lead_minutes', DEFAULT_LEAD_MINUTES)
        now = fields.Datetime.now()
        due = self.sudo().search([
            ('state', '=', 'confirmed'),
            ('scheduled_start', '!=', False),
            ('scheduled_start', '<=', now + timedelta(minutes=lead)),
            # Not one that was scheduled days ago and missed: posting "starting
            # now" for a meeting that was due on Tuesday is noise, and the cron
            # has no business deciding it still stands.
            ('scheduled_start', '>=', now - timedelta(hours=2)),
            ('link_posted_at', '=', False),
        ])
        for rec in due:
            try:
                rec._open()
            except Exception as exc:
                _logger.exception('could not open meeting %s: %s', rec.id, exc)
        if due:
            _logger.info('kpi.meeting: opened %s meeting(s)', len(due))
        return True

    @api.model
    def _cron_remind_meetings(self):
        from datetime import timedelta
        ahead = self._param('meet_remind_minutes', DEFAULT_REMIND_MINUTES)
        now = fields.Datetime.now()
        due = self.sudo().search([
            ('state', '=', 'confirmed'),
            ('scheduled_start', '!=', False),
            ('scheduled_start', '<=', now + timedelta(minutes=ahead)),
            ('scheduled_start', '>=', now),
            ('reminder_sent_at', '=', False),
        ])
        for rec in due:
            try:
                rec._remind()
            except Exception as exc:
                _logger.warning('could not remind for meeting %s: %s',
                                rec.id, exc)
        return True

    # ------------------------------------------------------------------
    # slots offered on WhatsApp
    # ------------------------------------------------------------------
    @api.model
    def slot_options(self, count=4):
        """[(iso_utc, label)] -- the next few sensible times, in local words.

        Deliberately simple: the next working-hours slots from now, with no
        attempt to model a weekend. India and Oman do not share one, the
        module has no working-time calendar, and a slot the client taps is a
        REQUEST that an admin confirms -- so an awkward suggestion costs a
        reschedule, not a missed meeting.
        """
        import pytz
        from datetime import timedelta
        Tz = self.env['kpi.tz']
        tzname = Tz.tz_name()
        tz = pytz.timezone(tzname)
        now_local = fields.Datetime.now().replace(tzinfo=pytz.utc).astimezone(tz)

        hours = [10, 12, 16]
        out = []
        day = 0
        while len(out) < count and day < 7:
            base = (now_local + timedelta(days=day)).replace(
                minute=0, second=0, microsecond=0)
            for hour in hours:
                if len(out) >= count:
                    break
                slot = base.replace(hour=hour)
                # At least an hour's notice -- "today at 10" offered at 09:55
                # is not a meeting anybody can get to.
                if slot <= now_local + timedelta(hours=1):
                    continue
                if day == 0:
                    word = _('Today')
                elif day == 1:
                    word = _('Tomorrow')
                else:
                    word = slot.strftime('%a %d %b')
                label = '🕒 %s %s' % (word,
                                      slot.strftime('%I:%M %p').lstrip('0'))
                out.append((slot.astimezone(pytz.utc)
                            .strftime('%Y-%m-%d %H:%M:%S'), label))
            day += 1
        return out

    # ------------------------------------------------------------------
    @api.model
    def create_from_intake(self, kpi, state):
        """Called by the WhatsApp router once the ticket exists."""
        vals = {
            'name': kpi.name or _('Meeting'),
            'kpi_id': kpi.id,
            'state': 'requested',
            'requested_by_name': state.participant_name or '',
            'requested_by_number': self.env['kpi.wa.group.router']
                                       ._participant_number(state),
        }
        if state.meet_start:
            vals['scheduled_start'] = state.meet_start
        else:
            vals['requested_text'] = (state.meet_text or '')[:120]
        rec = self.sudo().create(vals)
        rec._log('meeting_requested', {
            'when': fields.Datetime.to_string(rec.scheduled_start)
                    if rec.scheduled_start else '',
            'asked_for': rec.requested_text or ''})
        return rec

    @api.constrains('provider', 'join_url')
    def _check_manual_url(self):
        for rec in self:
            if rec.provider == 'manual' and rec.join_url \
                    and not rec.join_url.startswith(('http://', 'https://')):
                raise ValidationError(_(
                    'A meeting link has to start with http:// or https://.'))


class KraKpiMeeting(models.Model):
    _inherit = 'kra.kpi'

    meeting_ids = fields.One2many('kpi.meeting', 'kpi_id', string='Meetings')
    meeting_count = fields.Integer(compute='_compute_meeting_count')
    next_meeting_id = fields.Many2one(
        'kpi.meeting', compute='_compute_meeting_count',
        help='The next meeting on this task that has not happened yet.')

    def _compute_meeting_count(self):
        Meeting = self.env['kpi.meeting'].sudo()
        for rec in self:
            rows = Meeting.search(
                [('kpi_id', '=', rec.id)]) if rec.id else Meeting
            rec.meeting_count = len(rows)
            upcoming = rows.filtered(
                lambda m: m.state in ('requested', 'confirmed', 'live'))
            rec.next_meeting_id = upcoming[:1].id if upcoming else False

    def action_view_meetings(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Meetings'),
            'res_model': 'kpi.meeting',
            'view_mode': 'list,form',
            'domain': [('kpi_id', '=', self.id)],
            'context': {'default_kpi_id': self.id,
                        'default_name': self.name},
        }
