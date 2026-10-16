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
        help='Uploaded after the call. Odoo cannot record a browser call: '
             'server-side recording needs Jitsi with Jibri, which is a '
             'separate deployment.')
    summary = fields.Text()
    summary_source = fields.Char(readonly=True)
    action_items = fields.Text()
    summary_posted = fields.Boolean(readonly=True)

    # ---- how long it actually ran ------------------------------------- #
    #
    # From the link going out to the admin pressing Finished. This is the
    # real elapsed time, not the scheduled `duration_minutes`, and it is
    # deliberately NOT added to the task's work time -- see the long note in
    # kpi_nontask_block.py. It is shown beside the task as its own figure.
    actual_minutes = fields.Integer(
        string='Ran For (min)', compute='_compute_actual_minutes', store=True)
    log_ids = fields.Many2many(
        'kpi.action.log', string='Meeting Log',
        compute='_compute_log_ids')

    notes = fields.Text(help='Internal only. Never sent to the client.')

    # ---- who was actually in the room ---------------------------------- #
    #
    # Filled from INSIDE the call. The client opens an Odoo page that embeds
    # Jitsi, and that page reports joins, leaves and name changes back here.
    # A bare meet.jit.si link cannot do this: the call happens on somebody
    # else's server and Odoo never sees it, which is why a meeting run from
    # the raw link recorded nobody and no times.
    access_token = fields.Char(readonly=True, copy=False, index=True)
    participant_ids = fields.One2many(
        'kpi.meeting.participant', 'meeting_id', string='Who Joined')
    participant_summary = fields.Char(
        compute='_compute_participant_summary', store=True,
        string='Joined')
    last_event_at = fields.Datetime(
        readonly=True,
        help='The last thing we heard from inside the room. Used to close a '
             'meeting whose browser went away without saying goodbye.')

    @api.depends('participant_ids.person_name')
    def _compute_participant_summary(self):
        for rec in self:
            names = [p.person_name for p in rec.participant_ids
                     if p.person_name]
            rec.participant_summary = ', '.join(names) if names else ''

    # ------------------------------------------------------------------
    def _ensure_token(self):
        """A room link nobody can guess, on our own domain."""
        self.ensure_one()
        if not self.access_token:
            self.sudo().write({'access_token': secrets.token_hex(16)})
        return self.access_token

    def page_url(self):
        """The link the client is actually sent.

        Points at Odoo, not at meet.jit.si, so the call can be observed:
        names, join and leave times all come from this page. Falls back to
        the bare Jitsi link when no public address is configured, because a
        link to localhost is worse than a plain room.
        """
        self.ensure_one()
        base = (self.env['whatsapp.config'].sudo()
                .get_kpi_public_base_url() or '').rstrip('/')
        if not base or 'localhost' in base or '127.0.0.1' in base:
            return self.join_url or ''
        return '%s/kpi/meet/%s' % (base, self._ensure_token())

    # ------------------------------------------------------------------
    @api.model
    def _from_token(self, token):
        token = (token or '').strip()
        if not token or len(token) < 16:
            return self.browse()
        rec = self.sudo().search([('access_token', '=', token)], limit=1)
        # Constant-time compare, same as the approval page does.
        import hmac
        if rec and hmac.compare_digest(rec.access_token or '', token):
            return rec
        return self.browse()

    def record_room_event(self, kind, pid=None, name=None):
        """One event from inside the room. Times are the SERVER's, always.

        A browser clock can be wrong by hours, and these timestamps are what
        the duration and the log are built from.
        """
        self.ensure_one()
        now = fields.Datetime.now()
        Part = self.env['kpi.meeting.participant'].sudo()
        pid = (pid or '')[:64]
        name = (name or '').strip()[:120]
        vals = {'last_event_at': now}

        if kind in ('joined', 'peer_joined'):
            if self.state in ('requested', 'confirmed'):
                vals['state'] = 'live'
            if not self.opened_at:
                vals['opened_at'] = now
            row = Part.search([('meeting_id', '=', self.id),
                               ('jitsi_id', '=', pid)], limit=1) if pid else Part
            if row:
                row.write({'left_at': False,
                           'person_name': name or row.person_name})
            else:
                Part.create({'meeting_id': self.id, 'jitsi_id': pid,
                             'person_name': name or _('Guest'),
                             'joined_at': now})
        elif kind == 'name' and pid:
            row = Part.search([('meeting_id', '=', self.id),
                               ('jitsi_id', '=', pid)], limit=1)
            if row and name:
                row.write({'person_name': name})
        elif kind in ('left', 'peer_left'):
            if pid:
                row = Part.search([('meeting_id', '=', self.id),
                                   ('jitsi_id', '=', pid),
                                   ('left_at', '=', False)], limit=1)
                if row:
                    row.write({'left_at': now})
            still_in = Part.search_count([('meeting_id', '=', self.id),
                                          ('left_at', '=', False)])
            if not still_in and self.state == 'live':
                vals.update({'state': 'done', 'ended_at': now})

        self.sudo().write(vals)
        return True

    @api.model
    def _cron_close_stale_meetings(self):
        """Close a room whose browser vanished without saying goodbye.

        A tab killed, a laptop shut, a phone losing signal: no leave event
        ever arrives and the meeting would sit at 'live' forever. The end
        time used is the LAST THING WE HEARD, not now -- recording a meeting
        as having run until the cron noticed would invent minutes.
        """
        from datetime import timedelta
        quiet = self._param('meet_silence_minutes', 10)
        cutoff = fields.Datetime.now() - timedelta(minutes=quiet)
        stale = self.sudo().search([('state', '=', 'live'),
                                    ('last_event_at', '!=', False),
                                    ('last_event_at', '<', cutoff)])
        for rec in stale:
            rec.sudo().write({'state': 'done',
                              'ended_at': rec.last_event_at})
            rec.participant_ids.filtered(lambda p: not p.left_at).sudo().write(
                {'left_at': rec.last_event_at})
            rec._log('meeting_closed_quiet', {
                'ran_for_minutes': rec.actual_minutes,
                'who': rec.participant_summary})
        if stale:
            _logger.info('kpi.meeting: closed %s silent room(s)', len(stale))
        return True


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

    @api.depends('opened_at', 'ended_at')
    def _compute_actual_minutes(self):
        for rec in self:
            if rec.opened_at and rec.ended_at and rec.ended_at > rec.opened_at:
                rec.actual_minutes = int(
                    (rec.ended_at - rec.opened_at).total_seconds() // 60)
            else:
                rec.actual_minutes = 0

    def _compute_log_ids(self):
        """This meeting's own events, newest first.

        Filtered by the meeting id inside the log's payload rather than by
        event name alone, so a task with two meetings does not show both
        trails under each.
        """
        Log = self.env['kpi.action.log'].sudo()
        for rec in self:
            if not rec.kpi_id or not rec.id:
                rec.log_ids = False
                continue
            rows = Log.search([('kpi_id', '=', rec.kpi_id.id),
                               ('event', 'like', 'meeting_%')],
                              order='create_date desc', limit=200)
            mine = rows.filtered(
                lambda r: ('"meeting_id": %s' % rec.id) in (r.payload_json or '')
                or ('"meeting_id":%s' % rec.id) in (r.payload_json or ''))
            rec.log_ids = mine

    @api.depends('scheduled_start')
    def _compute_local_when(self):
        """'Fri 17 Oct · 4:00 PM IST · 2:30 PM Oman/Dubai'.

        Both zones, because these groups span India and the Gulf and a bare
        '4:00 PM' is an hour and a half wrong for half the people reading it.
        """
        import pytz
        for rec in self:
            if not rec.scheduled_start:
                rec.local_when = ''
                continue
            try:
                here = rec.scheduled_start.replace(tzinfo=pytz.utc).astimezone(
                    pytz.timezone(rec.env['kpi.tz'].tz_name()))
                rec.local_when = '%s · %s' % (
                    here.strftime('%a %d %b'),
                    rec._slot_label(here).replace('🕒 ', ''))
            except Exception:
                rec.local_when = rec.env['kpi.tz'].fmt(rec.scheduled_start)

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
        """The admin closing the meeting. This is what stops the clock.

        There is deliberately no cron that closes a meeting on its scheduled
        end: a call that overran would be recorded as having stopped while
        people were still in it, and the duration is the one number here that
        has to be true.
        """
        for rec in self:
            now = fields.Datetime.now()
            vals = {'state': 'done', 'ended_at': now}
            if not rec.opened_at:
                # Finished without ever being opened -- somebody ran it
                # outside the link. Fall back to the scheduled start so the
                # duration is a real figure rather than zero.
                vals['opened_at'] = rec.scheduled_start or now
            rec.sudo().write(vals)
            rec._log('meeting_done', {
                'ran_for_minutes': rec.actual_minutes,
                'opened_at': fields.Datetime.to_string(rec.opened_at),
                'ended_at': fields.Datetime.to_string(rec.ended_at),
                'attendees': (rec.organizer_id | rec.attendee_user_ids
                              ).mapped('name'),
                'recordings': len(rec.recording_ids)})
        return True

    def action_draft_summary(self):
        """Draft the summary with the LLM, when one is configured.

        Honest about what it has: with no transcript there is nothing to
        summarise from except the meeting's own details, so this drafts a
        skeleton for a person to correct, and says so. It never invents what
        was discussed.
        """
        self.ensure_one()
        Ai = self.env['kpi.ai']
        if not Ai.is_available():
            raise UserError(_(
                'No AI key is set on this database, so there is nothing to '
                'draft with. Add one under the kra_kpi.gemini_api_key, '
                'kra_kpi.groq_api_key or kra_kpi.anthropic_api_key system '
                'parameter — or just type the summary.'))
        if not self.recording_ids:
            raise UserError(_(
                'Attach the recording or your notes first. Without a '
                'transcript there is nothing to summarise, and a summary '
                'invented from the meeting title is worse than a blank box.'))
        raise UserError(_(
            'Transcribing a recording is not wired up yet. The audio has to '
            'be sent to a speech-to-text service first; the groundwork for '
            'that exists in the WhatsApp module but is switched off. Type '
            'the summary for now.'))

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
            ran = _('\n⏱️ Ran for %s minutes') % rec.actual_minutes \
                if rec.actual_minutes else ''
            body = _(
                "📝 *Meeting summary*\n"
                "%(subject)s — %(when)s%(ran)s\n\n"
                "%(summary)s") % {
                    'subject': rec.name or '',
                    'when': rec.local_when or '',
                    'ran': ran,
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
            "_%(note)s_\n"
            "_The link will be posted again just before we start._") % {
                'ref': (' — %s' % self.kpi_id.external_ref)
                       if self.kpi_id.external_ref else '',
                'subject': self.name or '',
                'when': self.local_when or '',
                'who': self._who_line(),
                'url': self.page_url() or '—',
                'note': _('Opens in your browser — nothing to install.')})

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
                'url': self.page_url() or '—'})
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
                'url': self.page_url() or '—'})
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
    # The zones a slot is shown in. Oman and the UAE are BOTH UTC+04:00 with
    # no daylight saving, so they are one column, not two -- printing Muscat
    # and Dubai separately would show the same clock time twice and waste the
    # poll's 100-character label budget. India is the only other zone these
    # groups span.
    SLOT_ZONES = [('Asia/Kolkata', 'IST'), ('Asia/Dubai', 'Oman/Dubai')]

    @api.model
    def _slot_label(self, slot_local, with_day=False):
        """'4:00 PM IST · 2:30 PM Oman/Dubai' for one moment in time."""
        import pytz
        parts = []
        for tzname, short in self.SLOT_ZONES:
            try:
                there = slot_local.astimezone(pytz.timezone(tzname))
            except Exception:
                continue
            parts.append('%s %s' % (there.strftime('%I:%M %p').lstrip('0'),
                                    short))
        body = ' · '.join(parts)
        if not with_day:
            return '🕒 %s' % body
        return '🕒 %s %s' % (slot_local.strftime('%a %d'), body)

    @api.model
    def _now_local(self):
        import pytz
        tz = pytz.timezone(self.env['kpi.tz'].tz_name())
        return fields.Datetime.now().replace(tzinfo=pytz.utc).astimezone(tz)

    # Parts of the day, so a whole day's times can be picked in two taps
    # instead of typed. A poll fits 12 options, and 9am-9pm at half-hour
    # steps is 25 -- which is why the band exists at all.
    # Night runs to midnight because a 10pm request should still be able to
    # pick 11pm; the working day ends at `meet_day_end_hour`, the day does not.
    BANDS = [
        ('morning', '🌅 Morning', 9, 12),
        ('afternoon', '☀️ Afternoon', 12, 17),
        ('evening', '🌆 Evening', 17, 21),
        ('night', '🌙 Night', 21, 24),
    ]

    @api.model
    def hour_options(self, count=4, now=None):
        """FOUR rows: within the hour, then the next three hours. Today only.

            asked at 12:00 -> within 1 hour · after 1:00 · after 2:00 · after 3:00
            asked at  5:00 -> within 1 hour · after 6:00 · after 7:00 · after 8:00

        FOUR, not "every hour left today". A poll holds 12 options and the
        whole-day version produced 13 with the escape row, so WhatsApp
        refused the poll and it arrived as a numbered text list -- the exact
        thing this flow exists to avoid. Three hours ahead is also as far as
        anybody picks in practice; past that they say a day.
        """
        from datetime import timedelta
        # `now` is injectable so the menu can be checked at any clock time
        # without waiting for that hour to come round; it defaults to the
        # real one everywhere in production.
        now = now or self._now_local()
        lead = self._param('meet_lead_minutes', 15)
        earliest = (now + timedelta(minutes=lead)).replace(
            second=0, microsecond=0)
        rem = earliest.minute % 15
        if rem:
            earliest += timedelta(minutes=15 - rem)

        out = []
        top = earliest.replace(minute=0) + timedelta(hours=1)
        # The part-hour we are standing in, but only when there is actually
        # room in it: at 12:58 "within the hour" would hold nothing.
        if earliest < top and top.date() == now.date():
            # Named by the FIRST slot it holds, not by the hour it ends in.
            # At 12:58 the soonest is 1:15, and calling that "within the
            # hour — by 2:00" read as though it meant before 1:00.
            out.append(('now', _('⏱️ Within 1 hour — from %s')
                        % self._clock_both(earliest)))
        cursor = top
        while (len(out) < count and cursor.date() == now.date()
               and cursor.hour < 24):
            out.append((cursor.strftime('%H'),
                        _('🕐 After %s') % self._clock_both(cursor)))
            nxt = cursor + timedelta(hours=1)
            if nxt.date() != now.date():
                break
            cursor = nxt
        return out

    @api.model
    def _clock_both(self, moment):
        """'2:00 PM IST · 12:30 PM Oman' -- the dev's zone and the client's."""
        import pytz
        parts = []
        for tzname, short in self.SLOT_ZONES:
            try:
                there = moment.astimezone(pytz.timezone(tzname))
            except Exception:
                continue
            parts.append('%s %s' % (there.strftime('%I:%M %p').lstrip('0'),
                                    short))
        return ' · '.join(parts)

    @api.model
    def day_options(self, count=6):
        """[(offset, label)] -- which day, asked first.

        Today is dropped once nothing is left on it, so the menu never offers
        a day whose picker would come back empty. Each day carries its date,
        because "Tomorrow" read the next morning means the wrong thing.
        """
        from datetime import timedelta
        now_local = self._now_local()
        out = []
        for offset in range(count):
            if offset == 0 and not self.band_options(day_offset=0):
                continue
            day = now_local + timedelta(days=offset)
            if offset == 0:
                label = _('📅 Today (%s)') % day.strftime('%a %d %b')
            elif offset == 1:
                label = _('📅 Tomorrow (%s)') % day.strftime('%a %d %b')
            else:
                label = '📅 %s' % day.strftime('%a %d %b')
            out.append((str(offset), label))
        return out

    @api.model
    def band_options(self, day_offset=0):
        """[(code, label)] -- only the parts of that day that still have a slot."""
        out = []
        for code, label, start, end in self.BANDS:
            if not self.slot_options(day_offset=day_offset, band=code,
                                     probe=True):
                continue
            out.append((code, '%s (%s)' % (label,
                                           self._band_range_label(start, end))))
        return out

    @api.model
    def _band_range_label(self, start, end):
        def hh(h):
            h = h % 24
            suffix = 'am' if h < 12 else 'pm'
            base = h % 12 or 12
            return '%d%s' % (base, suffix)
        return '%s–%s' % (hh(start), hh(end))

    @api.model
    def day_label(self, day_offset):
        """'Today (Fri 17 Oct)' -- used in prompts and on the confirm card."""
        from datetime import timedelta
        day = self._now_local() + timedelta(days=max(int(day_offset or 0), 0))
        if int(day_offset or 0) == 0:
            return _('Today, %s') % day.strftime('%a %d %b')
        if int(day_offset or 0) == 1:
            return _('Tomorrow, %s') % day.strftime('%a %d %b')
        return day.strftime('%a %d %b')

    @api.model
    def hour_slots(self, hour_key, count=4, now=None):
        """FOUR quarter hours, matching the row that was tapped.

            'after 6:00'   -> 6:15 · 6:30 · 6:45 · 7:00
            'within 1 hour'-> the next four quarters from now + the lead

        "After 6" starts at 6:15, not 6:00 -- 6:00 itself is reachable from
        the "within 1 hour" row of the previous hour, so nothing is lost and
        the label stays true to the word "after".
        """
        import pytz
        from datetime import timedelta

        now = now or self._now_local()
        lead = self._param('meet_lead_minutes', 15)
        earliest = (now + timedelta(minutes=lead)).replace(
            second=0, microsecond=0)
        rem = earliest.minute % 15
        if rem:
            earliest += timedelta(minutes=15 - rem)

        key = (hour_key or '').strip()
        if key == 'now':
            cursor = earliest
        else:
            try:
                hour = int(key)
            except (TypeError, ValueError):
                return []
            if not 0 <= hour <= 23:
                return []
            # "After 6" starts a quarter past, so the first option is 6:15.
            cursor = now.replace(hour=hour, minute=15, second=0,
                                 microsecond=0)
            if cursor < earliest:
                cursor = earliest

        out = []
        while len(out) < count:
            if cursor.date() != now.date():
                break                       # never spill into tomorrow
            out.append((cursor.astimezone(pytz.utc)
                        .strftime('%Y-%m-%d %H:%M:%S'),
                        self._slot_label(cursor)))
            cursor += timedelta(minutes=15)
        return out

    @api.model
    def slot_options(self, day_offset=0, band=None, count=None, probe=False):
        """[(iso_utc, label)] -- the times still open on that day.

        TODAY starts at **now + 15 minutes**, rounded up to the next half
        hour, and runs in 30-minute steps to the end of the evening: somebody
        asking at 10 pm wants tonight, not a slot the day after. ANY OTHER DAY
        runs from the configured day start on the hour, because at that
        distance a half-hour grid is just a longer menu.

        A tapped slot is a REQUEST an admin confirms, so an awkward suggestion
        costs a reschedule, not a missed meeting. There is deliberately no
        weekend logic: India and the Gulf do not share one and this module has
        no working-time calendar.
        """
        import pytz
        from datetime import timedelta

        try:
            day_offset = int(day_offset or 0)
        except (TypeError, ValueError):
            day_offset = 0

        now_local = self._now_local()
        lead = self._param('meet_lead_minutes', 15)
        if count is None:
            count = 10

        band_def = {c: (s, e) for c, _l, s, e in self.BANDS}
        if band in band_def:
            start_h, end_h = band_def[band]
        else:
            # No band named: the whole day, so that a caller which only wants
            # "is there anything left" gets a straight answer.
            start_h, end_h = 0, 24

        base = (now_local + timedelta(days=day_offset)).replace(
            minute=0, second=0, microsecond=0)
        cursor = base.replace(hour=int(start_h))
        # 24:00 is midnight the next morning, which `replace` cannot express.
        last = (base.replace(hour=23, minute=59)
                if int(end_h) >= 24 else base.replace(hour=int(end_h)))

        # Quarter hours TODAY so a meeting can start in 15 minutes; half
        # hours further out, where that precision is just a longer menu.
        step = timedelta(minutes=15 if day_offset == 0 else 30)

        if day_offset == 0:
            earliest = (now_local + timedelta(minutes=lead)).replace(
                second=0, microsecond=0)
            # Round up to the next quarter hour. Rounding to :00/:30 turned a
            # 15-minute lead into a 40-minute wait at 10:49 pm, which is not
            # what "after 15 minutes" means.
            rem = earliest.minute % 15
            earliest = earliest if rem == 0 else earliest + timedelta(
                minutes=15 - rem)
            if cursor < earliest:
                cursor = earliest

        # The end of a band is EXCLUSIVE: 12:00 belongs to the afternoon, not
        # to the morning as well. An inclusive end put the same slot in two
        # bands, so picking it twice booked two different-looking times.
        out = []
        guard = 0
        while cursor < last and len(out) < count and guard < 128:
            guard += 1
            out.append((cursor.astimezone(pytz.utc)
                        .strftime('%Y-%m-%d %H:%M:%S'),
                        self._slot_label(cursor)))
            if probe:
                return out
            cursor += step
        return out

    # ------------------------------------------------------------------
    # a time somebody typed
    # ------------------------------------------------------------------
    @api.model
    def tz_options(self):
        """The zones a typed time could mean. '11:50' is ambiguous by 90
        minutes across these groups, so it is always asked, never assumed."""
        return [('Asia/Kolkata', _('🇮🇳 India (IST)')),
                ('Asia/Dubai', _('🇴🇲 Oman / Dubai'))]

    @api.model
    def parse_time_text(self, text, tzname, day_offset=None):
        """'11:50' + a zone -> a stored UTC datetime, or False.

        Returns (utc_string_or_False, local_or_None). Never raises: an
        unparseable answer is kept as the client's own words for an admin to
        read, which is better than booking the wrong hour.

        When the hour is ambiguous (no am/pm, hour <= 12) the NEXT occurrence
        wins -- at 22:55, "11:50" means 23:50 tonight, not 11:50 tomorrow
        morning. The admin confirms either way.
        """
        import re
        import pytz
        from datetime import timedelta

        raw = (text or '').strip().lower()
        if not raw:
            return False, None
        try:
            tz = pytz.timezone(tzname or 'Asia/Kolkata')
        except Exception:
            return False, None
        now_local = fields.Datetime.now().replace(
            tzinfo=pytz.utc).astimezone(tz)

        # A day word in the text beats the day already picked.
        day = day_offset
        if 'day after' in raw:
            day = 2
        elif 'tomorrow' in raw or 'tmrw' in raw or 'tmr' in raw:
            day = 1
        elif 'today' in raw or 'tonight' in raw:
            day = 0

        m = re.search(r'(\d{1,2})\s*[:.\s]?\s*(\d{2})?\s*(am|pm)?', raw)
        if not m:
            return False, None
        try:
            hour = int(m.group(1))
            minute = int(m.group(2) or 0)
        except (TypeError, ValueError):
            return False, None
        if minute > 59:
            return False, None
        suffix = m.group(3)

        cands = []
        if suffix == 'am':
            cands = [hour % 12]
        elif suffix == 'pm':
            cands = [(hour % 12) + 12]
        elif hour > 12:
            cands = [hour]
        else:
            # Ambiguous: try both readings and take the soonest still ahead.
            cands = [hour % 12, (hour % 12) + 12]
        cands = [h for h in cands if 0 <= h <= 23]
        if not cands:
            return False, None

        # A future time is required for today and for "no day given"; every
        # hour of a later day is already ahead. The bar is simply "not in the
        # past" -- an earlier version demanded five minutes' clearance, which
        # rejected "11:24" typed at 23:23 and silently dropped the whole
        # answer back to raw text.
        need_future = day is None or day == 0
        base_day = now_local + timedelta(days=max(day or 0, 0))
        best = None
        for h in cands:
            try:
                cand = tz.localize(base_day.replace(
                    tzinfo=None).replace(hour=h, minute=minute,
                                         second=0, microsecond=0))
            except Exception:
                continue
            if need_future and cand <= now_local:
                continue
            if best is None or cand < best:
                best = cand
        if best is None:
            return False, None
        return best.astimezone(pytz.utc).strftime('%Y-%m-%d %H:%M:%S'), best

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
        # The link is minted as soon as a real time is on the record, so the
        # client gets it in the same breath as the confirmation. Who will
        # join is still an admin's decision -- the link alone promises a room,
        # not a person, and the reply says so.
        if rec.scheduled_start and rec.provider == 'jitsi' and not rec.join_url:
            rec._mint_join_url()
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


class KpiMeetingParticipant(models.Model):
    """One person who was actually in the room, as the call reported them.

    AT THE END OF THE FILE ON PURPOSE. This class was first written in the
    middle of KpiMeeting's field block, which silently moved every method
    below it -- action_confirm included -- onto this model, and the views
    failed to load with "action_confirm is not a valid action on
    kpi.meeting". A second class goes after the first one is finished, never
    between its fields and its methods.
    """
    _name = 'kpi.meeting.participant'
    _description = 'Someone who was in a meeting'
    _order = 'joined_at, id'

    meeting_id = fields.Many2one('kpi.meeting', required=True,
                                 ondelete='cascade', index=True)
    # NOT `display_name`: that is Odoo's own computed field on every model.
    # Declaring a Char by that name creates no column at all -- the first
    # attempt here failed with 'column "display_name" does not exist', the
    # same trap that hit kpi.wa.group.member earlier and was fixed the same
    # way.
    person_name = fields.Char(
        string='Name', help='Exactly as they typed it when joining.')
    jitsi_id = fields.Char(string='Room ID', readonly=True)
    joined_at = fields.Datetime(readonly=True)
    left_at = fields.Datetime(readonly=True)
    minutes = fields.Integer(compute='_compute_minutes', store=True)

    @api.depends('joined_at', 'left_at')
    def _compute_minutes(self):
        for rec in self:
            if rec.joined_at and rec.left_at and rec.left_at > rec.joined_at:
                rec.minutes = int(
                    (rec.left_at - rec.joined_at).total_seconds() // 60)
            else:
                rec.minutes = 0

