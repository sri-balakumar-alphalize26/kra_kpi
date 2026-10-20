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
import os
import secrets

from odoo import _, api, fields, models
from odoo.exceptions import UserError, ValidationError
from odoo.tools import config

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
    # Between US, not with the client. A developer asking their manager for a
    # word is about the client's work but is no business of theirs -- so every
    # message for this meeting goes to the internal team group instead, and
    # the client never learns it happened. See _post.
    is_internal = fields.Boolean(
        string='Internal Only', default=False, index=True,
        help='Between staff. Nothing about it is posted to the client.')

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
        help='Audio of the call, in segments. Written by the recorder bot '
             'when Record This Meeting is ticked, or uploaded by hand.')

    # ---- recording ----------------------------------------------------- #
    #
    # A bot joins the room from this server and captures what it hears, so
    # nobody has to click Allow and a meeting held entirely on phones records
    # as well as one held at a desk. It is NOT Jibri: it is an ordinary
    # participant, visible to everyone in the participant list, which is also
    # how the people in the call are told they are being recorded.
    #
    # Only an admin may turn it on. `groups=` on the FIELD (not just the view)
    # is the part that matters: ir.model.access grants developers write on
    # kpi.meeting, so without this a developer could tick it through the JSON
    # API.
    record_meeting = fields.Boolean(
        string='Record This Meeting', default=False, copy=False,
        groups='kra_kpi_module.group_kra_admin',
        help='A recorder joins the call and captures the audio, then writes '
             'the summary from it. Everyone in the call can see it in the '
             'participant list.')
    recording_state = fields.Selection([
        ('off', 'Not recording'),
        ('starting', 'Starting'),
        ('running', 'Recording'),
        ('no_audio', 'Joined but heard nothing'),
        ('failed', 'Could not record'),
        ('stopped', 'Stopped'),
    ], default='off', readonly=True, copy=False, string='Recorder')
    # Why it failed, in words, on the record. A recording everyone BELIEVES
    # happened is worse than one they know did not.
    recording_detail = fields.Char(readonly=True, copy=False)
    recording_started_at = fields.Datetime(readonly=True, copy=False)
    recording_seconds = fields.Integer(readonly=True, copy=False, default=0)
    bot_pid = fields.Integer(readonly=True, copy=False)
    # A SECOND token, for the bot's page only. The client token circulates in
    # WhatsApp groups; this one never leaves this server, and it is the only
    # token the segment-upload route accepts.
    bot_token = fields.Char(readonly=True, copy=False, index=True)

    transcript = fields.Text(readonly=True, copy=False)
    transcript_language = fields.Char(readonly=True, copy=False)
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
    # Time somebody was actually talking, as opposed to the room being open.
    # Deliberately a SEPARATE figure rather than a redefinition of
    # actual_minutes: that one is stored and has already been written into
    # task logs, and quietly changing what it counts would alter records
    # already taken. 0 when nothing recorded the call.
    active_minutes = fields.Integer(
        string='Active (min)', readonly=True, copy=False, default=0,
        help='Time with somebody speaking. Silence while the room sat open '
             'is not counted. Only filled when the meeting was recorded.')
    # Kept in seconds and shown in minutes: a five-minute meeting of which
    # ninety seconds was speech rounds to 2 minutes, and rounding at every
    # addition instead of at the end loses most of it.
    active_seconds = fields.Integer(readonly=True, copy=False, default=0)
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

    @api.depends('participant_ids.person_name', 'participant_ids.is_recorder')
    def _compute_participant_summary(self):
        for rec in self:
            # The recorder is not a person. Listing it here would put
            # "Recorder" in the recap the client reads as if it had attended.
            names = [p.person_name for p in rec.participant_ids
                     if p.person_name and not p.is_recorder]
            rec.participant_summary = ', '.join(names) if names else ''

    # ------------------------------------------------------------------
    def _ensure_token(self):
        """A room link nobody can guess, on our own domain."""
        self.ensure_one()
        if not self.access_token:
            self.sudo().write({'access_token': secrets.token_hex(16)})
        return self.access_token

    def _ensure_bot_token(self):
        """The recorder's own token.

        Separate from access_token on purpose. The client's link gets
        forwarded around WhatsApp groups; this one is handed to a local
        process and nothing else, and it is the only token the segment-upload
        route will accept. A leaked client link therefore cannot be used to
        push audio at us.
        """
        self.ensure_one()
        if not self.bot_token:
            self.sudo().write({'bot_token': secrets.token_hex(24)})
        return self.bot_token

    def page_url(self):
        """The link the client is actually sent.

        Points at Odoo, not at meet.jit.si, so the call can be observed:
        names, join and leave times all come from this page. Falls back to
        the bare Jitsi link when no public address is configured, because a
        link to localhost is worse than a plain room.
        """
        self.ensure_one()
        # get_config() FIRST. get_kpi_public_base_url() calls ensure_one(),
        # so calling it straight off the model is an empty recordset and a
        # "Expected singleton" every single time -- which meant every meeting
        # confirmation raised, and is why requested meetings piled up.
        base = (self.env['whatsapp.config'].sudo().get_config()
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

    @api.model
    def _from_bot_token(self, token):
        """Resolve the recorder's token, and ONLY the recorder's token.

        A separate method rather than a second branch inside _from_token, so
        that a client link can never reach the upload route by accident: the
        two token spaces are checked by two callers that never swap.
        """
        token = (token or '').strip()
        if not token or len(token) < 32:
            return self.browse()
        rec = self.sudo().search([('bot_token', '=', token)], limit=1)
        import hmac
        if rec and hmac.compare_digest(rec.bot_token or '', token):
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
        close_now = False

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
            # The recorder bot does not count towards the room being busy.
            # While it sits in the call the room would never look empty, and
            # a meeting everyone had left would stay 'live' until the stale
            # cron noticed.
            still_in = Part.search_count([('meeting_id', '=', self.id),
                                          ('left_at', '=', False),
                                          ('is_recorder', '=', False)])
            close_now = not still_in and self.state == 'live'

        self.sudo().write(vals)

        # Somebody is in the room and this meeting is meant to be recorded:
        # start the recorder. Guarded by bot_pid inside _start_recorder, so
        # the second and third person joining do not each launch a browser.
        if (kind in ('joined', 'peer_joined') and not close_now
                and self.sudo().record_meeting and not self.sudo().bot_pid):
            try:
                self._start_recorder()
            except Exception as exc:
                # A recorder that will not start must never stop the meeting
                # from being held.
                _logger.warning('meeting %s: recorder did not start: %s',
                                self.id, exc)

        if close_now:
            # Everybody has gone. Close through the ONE path that posts the
            # recap and writes the task log. This used to set state='done'
            # inline, which is why a meeting that simply emptied out left no
            # trace in the group and no entry on the task -- it closed
            # silently.
            self.close_meeting(quiet=True, at=now)
        return True

    # ------------------------------------------------------------------
    # the recorder
    # ------------------------------------------------------------------
    # ---- which Jitsi, and how we are allowed in ------------------------ #
    #
    # The public meet.jit.si stopped letting anyone start a conference on
    # 18-19 Oct 2026: 'The conference has not yet started because no
    # moderators have yet arrived. If you'd like to become a moderator please
    # log-in.' Verified on fresh rooms, headless AND windowed, from this
    # server -- so it is not automation detection and no browser flag gets
    # past it. It blocks clients and staff exactly as it blocks the recorder.
    #
    # The way in is a JWT, which is what 8x8's hosted Jitsi (JaaS) issues and
    # what a self-hosted Jitsi with token auth accepts. With one, whoever
    # presents it is admitted -- and can be admitted AS a moderator, which is
    # how the recorder gets in without a human.
    @api.model
    def _jaas(self):
        """-> (app_id, api_key_id, private_key_pem). Empty when unconfigured.

        All three are needed; one or two set is a half-finished setup and is
        treated as none, because a JWT signed with the wrong kid fails as a
        blank page rather than an error anyone can read.
        """
        p = self.env['ir.config_parameter'].sudo()
        app = (p.get_param('kra_kpi.jaas_app_id', '') or '').strip()
        kid = (p.get_param('kra_kpi.jaas_api_key_id', '') or '').strip()
        pem = (p.get_param('kra_kpi.jaas_private_key', '') or '').strip()
        # The 8x8 console shows the App ID both bare and with the
        # 'vpaas-magic-cookie-' prefix, depending where you look. Accept
        # either: pasting the prefixed form and having this code add the
        # prefix again produces a tenant that does not exist, and the only
        # symptom is an empty meeting box.
        if app.startswith('vpaas-magic-cookie-'):
            app = app[len('vpaas-magic-cookie-'):]
        # The key id is passed through to the JWT header exactly as given,
        # because 8x8's own docs and their mirrors disagree about its shape.
        # Whatever the console shows is what is correct.
        return (app, kid, pem) if (app and kid and pem) else ('', '', '')

    @api.model
    def meet_domain(self):
        """The Jitsi host, as a bare domain for the external API."""
        if self._jaas()[0]:
            return (self._param('jaas_domain', '8x8.vc') or '8x8.vc').strip()
        base = (self._param('meet_base_url', DEFAULT_MEET_BASE)
                or DEFAULT_MEET_BASE).strip().rstrip('/')
        return base.split('://', 1)[-1] if '://' in base else base

    @api.model
    def meet_tenant(self):
        """JaaS puts every room under a tenant; plain Jitsi has none."""
        app = self._jaas()[0]
        return ('vpaas-magic-cookie-%s' % app) if app else ''

    def meet_room_path(self):
        """The roomName the external API is given.

        On JaaS this must carry the tenant -- '<tenant>/<room>'. Passing the
        bare room name silently lands in somebody else's namespace and the
        JWT is then rejected for a room it does not cover.
        """
        self.ensure_one()
        tenant = self.meet_tenant()
        room = self.room_name or ''
        return '%s/%s' % (tenant, room) if tenant else room

    def meet_api_js(self):
        """URL of external_api.js. JaaS serves it under the tenant."""
        self.ensure_one()
        tenant = self.meet_tenant()
        domain = self.meet_domain()
        return ('https://%s/%s/external_api.js' % (domain, tenant)) if tenant \
            else ('https://%s/external_api.js' % domain)

    def meet_jwt(self, display_name, moderator=False, hours=6):
        """A token that gets this person into this room. '' when not needed.

        Minted per page load and short-lived, so a link that leaks stops
        working on its own. `moderator` is what lets the recorder in with no
        human present, and is never given to a client.
        """
        self.ensure_one()
        app, kid, pem = self._jaas()
        if not app:
            return ''
        try:
            import time as _time

            import jwt as _jwt
            now = int(_time.time())
            payload = {
                'aud': 'jitsi',
                'iss': 'chat',
                'sub': 'vpaas-magic-cookie-%s' % app,
                # Scoped to THIS room, not '*': a token for every room is a
                # token worth stealing.
                'room': self.room_name or '*',
                'nbf': now - 10,
                'exp': now + int(hours) * 3600,
                'context': {
                    'user': {
                        'id': 'kpi-meeting-%s' % self.id,
                        'name': (display_name or 'Guest')[:80],
                        'avatar': '',
                        'email': '',
                        'moderator': 'true' if moderator else 'false',
                    },
                    'features': {
                        # We record ourselves, by listening. Jitsi's own
                        # recording is a different thing and stays off.
                        'recording': 'false',
                        'livestreaming': 'false',
                        'transcription': 'false',
                        'outbound-call': 'false',
                    },
                },
            }
            return _jwt.encode(payload, pem, algorithm='RS256',
                               headers={'kid': kid})
        except Exception as exc:
            # Never let this raise into a page render: a meeting with no
            # token still shows a readable message, where a traceback does
            # not.
            _logger.warning('meeting %s: could not mint a meeting token: %s',
                            self.id, exc)
            return ''

    @api.model
    def _recorder_display_name(self):
        """What everyone in the call sees in the participant list.

        This IS the consent notice for anyone who joined from the Jitsi app
        rather than our page. Jitsi shows no REC badge for a capture like
        ours -- that badge belongs to Jibri -- so if this name stops saying
        what it says, the only people who know the call is being recorded are
        the ones who happened to read our page.
        """
        return '🔴 Recorder — this call is being recorded'

    _MAX_SEGMENT_BYTES = 32 * 1024 * 1024
    _MAX_SEGMENTS = 500

    def store_recording_segment(self, data, seq=None, mimetype=None,
                                content_length=None):
        """One finished audio segment from the recorder. -> bool.

        Checks are cheapest-first, and every refusal looks identical to the
        caller. The token is 48 hex characters and never leaves this server,
        but these bound the damage if it ever did.
        """
        self.ensure_one()
        me = self.sudo()

        if not me.record_meeting:
            return False
        if me.state not in ('live', 'confirmed'):
            # The room has to be open. The token does not expire by design,
            # so this is what closes the window: it opens on the first join
            # and shuts in close_meeting.
            return False
        # content_length is attacker-supplied, so check it to avoid reading a
        # huge body AND check the real length afterwards.
        if content_length and int(content_length) > self._MAX_SEGMENT_BYTES:
            return False
        if not data or len(data) > self._MAX_SEGMENT_BYTES:
            return False
        if me.recording_seconds and me.recording_seconds < 0:
            return False
        if len(me.recording_ids) >= self._MAX_SEGMENTS:
            _logger.warning('meeting %s: segment cap reached', me.id)
            return False

        # Audio-shaped bytes only. Without this the route is general-purpose
        # file storage; and storing something that a later route might serve
        # inline is how a stored-XSS turns up on our own domain.
        magic = data[:4]
        if magic == b'\x1a\x45\xdf\xa3':
            mime, ext = 'audio/webm', 'webm'
        elif magic == b'OggS':
            mime, ext = 'audio/ogg', 'ogg'
        else:
            _logger.warning('meeting %s: segment was not webm or ogg', me.id)
            return False

        try:
            n = int(seq)
        except (TypeError, ValueError):
            n = len(me.recording_ids)

        att = self.env['ir.attachment'].sudo().create({
            'name': 'meeting-%s-%03d.%s' % (me.id, n, ext),
            'raw': data,
            # res_model/res_id are the important lines: they make
            # /web/content apply kpi.meeting's own access rules. An
            # attachment with neither is readable by any logged-in user who
            # guesses the id.
            'res_model': 'kpi.meeting',
            'res_id': me.id,
            'mimetype': mime,
            'public': False,
            'description': 'recording segment %d' % n,
        })
        me.write({
            'recording_ids': [(4, att.id)],
            'recording_seconds': me.recording_seconds + 0,
        })

        # Tell the group once, on the FIRST segment that actually arrives --
        # not when the recorder launched. A bot that failed to capture
        # anything must not announce a recording that does not exist.
        if len(me.recording_ids) == 1:
            try:
                me._post(_(
                    '🎙️ *This meeting is being recorded*\n'
                    'The audio is saved to our system and used to write the '
                    'summary.'))
            except Exception as exc:
                _logger.warning('meeting %s: could not announce recording: %s',
                                me.id, exc)
        return True

    def record_bot_event(self, kind, pid=None, name=None, extra=None):
        """One event from the recorder's page."""
        self.ensure_one()
        me = self.sudo()
        extra = extra or {}
        now = fields.Datetime.now()

        if kind in ('peer_joined', 'peer_left', 'name'):
            # Ordinary room bookkeeping, same as a human page reports.
            return me.record_room_event(kind, pid=pid, name=name)

        Part = self.env['kpi.meeting.participant'].sudo()
        if kind == 'bot_joined':
            row = Part.search([('meeting_id', '=', me.id),
                               ('is_recorder', '=', True)], limit=1)
            vals = {'jitsi_id': (pid or '')[:64], 'left_at': False}
            if row:
                row.write(vals)
            else:
                Part.create(dict(vals, meeting_id=me.id, is_recorder=True,
                                 person_name=me._recorder_display_name(),
                                 joined_at=now))
            me.write({'last_event_at': now})

        elif kind == 'rec_started':
            me.write({'recording_state': 'running',
                      'recording_started_at': now,
                      'recording_detail': (extra.get('label') or '')[:200],
                      'last_event_at': now})
        elif kind == 'rec_stopped':
            me.write({'recording_state': 'stopped',
                      'recording_detail': (extra.get('reason') or '')[:200]})
        elif kind == 'rec_failed':
            # Loud, on the record. A meeting everyone believes was recorded
            # is worse than one they know was not.
            me.write({'recording_state': 'failed',
                      'recording_detail': (extra.get('reason') or '')[:200]})
            _logger.warning('meeting %s: recorder failed: %s',
                            me.id, extra.get('reason'))
        elif kind == 'rec_no_audio':
            me.write({'recording_state': 'no_audio',
                      'recording_detail': (extra.get('reason') or '')[:200]})
            _logger.warning('meeting %s: recorder heard nothing: %s',
                            me.id, extra.get('reason'))

        elif kind == 'speaking':
            try:
                secs = max(0, min(int(extra.get('seconds') or 0), 3600))
            except (TypeError, ValueError):
                secs = 0
            if secs:
                row = Part.search([('meeting_id', '=', me.id),
                                   ('jitsi_id', '=', (pid or '')[:64])],
                                  limit=1)
                if row:
                    row.write({'talk_seconds': row.talk_seconds + secs})
                total = me.active_seconds + secs
                me.write({'active_seconds': total,
                          'active_minutes': int(round(total / 60.0)),
                          'last_event_at': now})

        elif kind == 'idle':
            # The room went quiet. Close as of the last thing that actually
            # happened, never as of now -- inventing minutes here would feed
            # straight into what people read when deciding what to bill.
            me.write({'recording_state': 'stopped'})
            me.close_meeting(quiet=True, at=me.last_event_at)

        elif kind == 'bot_left':
            row = Part.search([('meeting_id', '=', me.id),
                               ('is_recorder', '=', True),
                               ('left_at', '=', False)], limit=1)
            if row:
                row.write({'left_at': now})
            me.write({'bot_pid': 0})
        return True

    # ------------------------------------------------------------------
    def _start_recorder(self):
        """Launch the recorder for this meeting, if it is wanted and absent.

        Popen and return: the caller is an HTTP request reporting somebody
        joining a call, and it must not wait for a browser to start.
        """
        self.ensure_one()
        me = self.sudo()
        if not me.record_meeting or me.bot_pid:
            return False

        import subprocess
        import sys as _sys

        base = 'http://127.0.0.1:%s' % (
            self.env['ir.config_parameter'].sudo().get_param(
                'kra_kpi.meet_bot_port') or config.get('http_port') or 8069)
        script = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            'tools', 'meeting_recorder.py')
        if not os.path.exists(script):
            me.write({'recording_state': 'failed',
                      'recording_detail': 'recorder script is missing'})
            return False

        args = [_sys.executable, '-u', script,
                '--base', base,
                '--token', me._ensure_bot_token(),
                '--meeting', str(me.id),
                '--alone-seconds', str(me._param('meet_bot_alone_seconds', 120)),
                '--idle-seconds', str(me._param('meet_idle_seconds', 300))]
        try:
            flags = 0
            if os.name == 'nt':
                # Detached and windowless: Odoo runs as a service, and a
                # console window here would either flash on someone's desktop
                # or fail outright in session 0.
                flags = (getattr(subprocess, 'CREATE_NO_WINDOW', 0)
                         | getattr(subprocess, 'DETACHED_PROCESS', 0))
            proc = subprocess.Popen(
                args, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=flags, close_fds=True)
        except Exception as exc:
            _logger.warning('meeting %s: could not start the recorder: %s',
                            me.id, exc)
            me.write({'recording_state': 'failed',
                      'recording_detail': str(exc)[:200]})
            return False

        me.write({'bot_pid': proc.pid, 'recording_state': 'starting',
                  'recording_detail': ''})
        _logger.info('meeting %s: recorder started, pid %s', me.id, proc.pid)
        return True

    def _stop_recorder(self, reason='stopped'):
        """Kill the recorder process. Segments already stored are kept."""
        self.ensure_one()
        me = self.sudo()
        pid = me.bot_pid
        if not pid:
            return False
        try:
            import psutil
            proc = psutil.Process(pid)
            proc.terminate()
            try:
                proc.wait(timeout=8)
            except psutil.TimeoutExpired:
                proc.kill()
        except Exception as exc:
            _logger.info('meeting %s: recorder pid %s already gone (%s)',
                         me.id, pid, exc)
        me.write({'bot_pid': 0,
                  'recording_state': 'stopped',
                  'recording_detail': reason[:200]})
        return True

    @api.model
    def _recorder_pid_alive(self, pid):
        if not pid:
            return False
        try:
            import psutil
            return psutil.pid_exists(pid)
        except Exception:
            return False

    @api.model
    def _cron_purge_old_recordings(self):
        """Delete audio once it has been written up.

        Nothing used to delete a recording, and at a meeting a day this grows
        by tens of gigabytes a year. Only the AUDIO goes: the transcript and
        the summary are the part worth keeping, and they stay on the record.

        A recording is only removed once there is a summary to replace it --
        otherwise a transcription that failed quietly would take the evidence
        with it.
        """
        from datetime import timedelta
        days = self._param('meet_record_keep_days', 180)
        if days <= 0:
            return True
        cutoff = fields.Datetime.now() - timedelta(days=int(days))
        done = self.sudo().search([('state', '=', 'done'),
                                   ('ended_at', '<', cutoff),
                                   ('recording_ids', '!=', False)])
        removed = 0
        for rec in done:
            if not (rec.summary or '').strip():
                continue
            atts = rec.recording_ids
            rec.write({'recording_ids': [(5, 0, 0)]})
            removed += len(atts)
            atts.unlink()
            rec._log('meeting_recording_purged', {
                'files': len(atts), 'kept_days': int(days)})
        if removed:
            _logger.info('purged %d meeting recordings older than %s days',
                         removed, days)
        return True

    @api.model
    def _cron_recorder_watchdog(self):
        """Start a recorder that should be running and is not.

        Covers the case the spawn-on-join path cannot: Odoo restarting in the
        middle of a recorded meeting leaves bot_pid pointing at a process
        that no longer exists.
        """
        live = self.sudo().search([('state', '=', 'live'),
                                   ('record_meeting', '=', True)])
        for rec in live:
            if rec.bot_pid and not self._recorder_pid_alive(rec.bot_pid):
                _logger.info('meeting %s: recorder pid %s is gone, restarting',
                             rec.id, rec.bot_pid)
                rec.write({'bot_pid': 0})
                rec._start_recorder()
            elif not rec.bot_pid and rec.recording_state in ('off', 'starting'):
                rec._start_recorder()
        return True

    def write(self, vals):
        """Guard the recording switch.

        Turning recording ON once the call is live is refused: the notice on
        the meeting page is rendered at page load and there is no way to
        update a page that is already open, so flipping this on mid-call
        would record people who read "not being recorded".

        Turning it OFF mid-call is allowed and really stops it.
        """
        if 'record_meeting' in vals:
            want = bool(vals['record_meeting'])
            for rec in self:
                if want and not rec.record_meeting and rec.state == 'live':
                    raise UserError(_(
                        'This meeting is already running, so recording '
                        'cannot be switched on now: the people in the call '
                        'were shown a page saying it is not being recorded, '
                        'and that page cannot be changed underneath them.\n\n'
                        'End this meeting and start another if it needs to '
                        'be recorded.'))
        res = super().write(vals)
        if 'record_meeting' in vals and not vals['record_meeting']:
            for rec in self:
                if rec.bot_pid:
                    rec._stop_recorder(
                        'switched off by %s' % (self.env.user.name or ''))
                    rec._log('meeting_recording_stopped', {
                        'by': self.env.user.login,
                        'segments_kept': len(rec.recording_ids)})
        return res

    def _recap_body(self, closed_by=None, quiet=False):
        """What the room actually did: how long, and who was in it."""
        self.ensure_one()
        tz = self.env['kpi.tz']
        who = self.participant_summary or _('nobody we could see')
        mins = self.actual_minutes or 0
        ran = (_('%d min') % mins) if mins else _('under a minute')
        lines = [
            _('🏁 *Meeting finished*%s') % (
                (' — %s' % self.kpi_id.external_ref)
                if self.kpi_id.external_ref else ''),
            self.name or '',
            '',
            _('⏱️ Ran for %s') % ran,
            _('👥 In the room: %s') % who,
        ]
        if self.active_minutes:
            lines.append(_('🗣️ Talking for %d min') % self.active_minutes)
        if self.opened_at:
            lines.append(_('▶️ Started %s') % tz.fmt(self.opened_at))
        if self.ended_at:
            lines.append(_('⏹️ Ended %s') % tz.fmt(self.ended_at))

        # Say what was captured, and say so when nothing was. Silence here
        # would let everyone assume a recording exists until somebody goes
        # looking for it.
        if self.sudo().record_meeting:
            n = len(self.sudo().recording_ids)
            if n:
                lines.append(_('🎙️ Recorded — %d audio file(s)') % n)
            else:
                lines.append(_(
                    '⚠️ This call was NOT recorded — %s')
                    % (self.sudo().recording_detail
                       or _('the recorder could not capture anything')))
        if quiet:
            lines.append('')
            lines.append(_('_Closed automatically — the room went quiet._'))
        elif closed_by:
            lines.append('')
            lines.append(_('_Closed by %s_') % (closed_by.name or ''))
        return '\n'.join(l for l in lines if l is not None)

    def close_meeting(self, closed_by=None, quiet=False, at=None):
        """End the room, post what happened, and write it on the task.

        One method for both ways a meeting ends -- somebody says so, or the
        cron notices the room went quiet -- because the recap and the task
        log entry are the same in both cases, and two copies would drift.

        The end time for a quiet close is the LAST THING WE HEARD, never now:
        recording a meeting as having run until a cron noticed would invent
        minutes, and those minutes are read by people deciding what to bill.
        """
        self.ensure_one()
        if self.state == 'done':
            return False
        end = at or (self.last_event_at if quiet else fields.Datetime.now())
        end = end or fields.Datetime.now()
        vals = {'state': 'done', 'ended_at': end}
        if not self.opened_at:
            # Finished without ever being opened -- somebody ran it outside
            # the link. Fall back to the scheduled start so the duration is a
            # real figure rather than zero. This used to live only in
            # action_mark_done, which is why closing from the form and closing
            # from WhatsApp produced different durations for the same meeting.
            vals['opened_at'] = self.scheduled_start or end
        self.sudo().write(vals)
        self.participant_ids.filtered(lambda p: not p.left_at).sudo().write(
            {'left_at': self.ended_at})
        # Recompute before reading them for the recap.
        self.invalidate_recordset(['actual_minutes', 'participant_summary'])

        # The recorder has nothing left to listen to. Stop it before the
        # recap so the recap can state what was actually captured.
        if self.sudo().bot_pid:
            try:
                self.sudo()._stop_recorder('the meeting ended')
            except Exception as exc:
                _logger.warning('meeting %s: could not stop the recorder: %s',
                                self.id, exc)

        self._post(self._recap_body(closed_by=closed_by, quiet=quiet))

        # Write the summary, if a provider is configured and this is wanted.
        # AFTER the recap, and never allowed to interfere with it: a meeting
        # that cannot be summarised still has to end, post its recap and log
        # its time. Transcription is a network call to a speech service and
        # it can fail or be slow for reasons that have nothing to do with
        # this meeting.
        if self._param_bool('meet_auto_summary', True):
            try:
                ok, msg = self.draft_summary()
                if ok and self._param_bool('meet_auto_post_summary', False):
                    self.action_post_summary()
                elif ok:
                    _logger.info('meeting %s: summary drafted, not sent -- '
                                 'somebody should read it first', self.id)
            except Exception as exc:
                _logger.warning('meeting %s: summary failed: %s',
                                self.id, exc)

        # The task's own log, so the meeting shows on the task rather than
        # only inside the meeting record.
        self._log('meeting_finished', {
            'ran_for_minutes': self.actual_minutes,
            'who': self.participant_summary,
            'started_at': fields.Datetime.to_string(self.opened_at or ''),
            'ended_at': fields.Datetime.to_string(self.ended_at or ''),
            'closed_by': (closed_by.login if closed_by else
                          ('cron' if quiet else '')),
            # Stated in the log itself: meeting time is NOT task time. It is
            # never written to kpi.time.log and never touches
            # timer_total_seconds, or it would land in hourly invoicing.
            'counts_as_task_time': False,
        })
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
            # Through the shared path, so a quietly-closed meeting gets the
            # same recap and the same task-log entry as one somebody ended.
            # It used to only write a log line, which is why a meeting could
            # finish and nobody was told anything.
            rec.close_meeting(quiet=True, at=rec.last_event_at)
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

    @api.model
    def _param_bool(self, key, default):
        """A yes/no parameter.

        Separate from _param because `isinstance(True, int)` is True in
        Python, so a boolean default comes back from _param as 1 or 0 and
        every caller has to remember that.
        """
        raw = self.env['ir.config_parameter'].sudo().get_param(
            'kra_kpi.%s' % key)
        if raw in (None, False, ''):
            return bool(default)
        return str(raw).strip().lower() in ('1', 'true', 'yes', 'on')

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
        """The admin closing the meeting from the form. This stops the clock.

        There is deliberately no cron that closes a meeting on its scheduled
        end: a call that overran would be recorded as having stopped while
        people were still in it, and the duration is the one number here that
        has to be true.

        DELEGATES, rather than closing the meeting itself. It used to write
        state and ended_at directly and log its own 'meeting_done', which
        meant pressing Finished posted NO recap to the group, never stamped
        left_at on whoever was still in the room, and never wrote
        'meeting_finished' to the task log -- while the WhatsApp button and
        the stale cron did all three. Anything hung on the end of a meeting
        has to hang on one path or it silently does nothing.
        """
        for rec in self:
            rec.close_meeting(closed_by=self.env.user)
        return True

    # ------------------------------------------------------------------
    # transcript and summary
    # ------------------------------------------------------------------
    _SUMMARY_PROMPT = (
        "You write up a short internal meeting between a software team and "
        "their client, from a transcript.\n"
        "\n"
        "THE TRANSCRIPT MIXES TAMIL, MALAYALAM AND ENGLISH, often inside one "
        "sentence. That is normal here and is not an error. Read all three.\n"
        "\n"
        "WRITE THE SUMMARY IN ENGLISH. The tasks, invoices and records it "
        "goes beside are in English.\n"
        "\n"
        "Return ONLY this JSON object:\n"
        '{"summary": "<what was discussed and decided, 2-6 short sentences>",\n'
        ' "action_items": "<one per line, \'who - what\'; empty string if '
        'none were agreed>",\n'
        ' "unclear": "<anything you could not make out; empty string if '
        'nothing>"}\n'
        "\n"
        "RULES, and the first one matters most:\n"
        "- Do NOT invent anything. If the transcript does not say it, it did "
        "not happen. Where a stretch is marked [not captured], say nothing "
        "about it rather than guessing what filled the gap.\n"
        "- Do not attribute a statement to somebody unless the transcript "
        "makes clear who said it.\n"
        "- Keep the client's own product nouns and numbers exactly as spoken.\n"
        "- No greetings, no filler, no 'in this meeting'. Start with the "
        "substance.\n"
        "- If the transcript is too thin to summarise, say so in `summary` "
        "in one sentence and leave action_items empty."
    )

    def _speaker_hint(self):
        """Names for Whisper's decoder bias, so it mangles fewer of them."""
        self.ensure_one()
        names = [p.person_name for p in self.participant_ids
                 if p.person_name and not p.is_recorder]
        bits = ['Tamil, Malayalam and English.']
        if names:
            bits.append('Speakers: %s.' % ', '.join(names[:8]))
        if self.kpi_id.name:
            bits.append('Topic: %s.' % self.kpi_id.name[:120])
        return ' '.join(bits)

    def build_transcript(self):
        """Transcribe every segment, in order. -> (text, language, problems).

        Segments are transcribed separately and joined, which is the whole
        reason they exist: each is a complete file, each is well under the
        size the speech services accept, and one that fails leaves a marked
        gap instead of losing the meeting.
        """
        self.ensure_one()
        Ai = self.env['kpi.ai']
        atts = self.sudo().recording_ids.sorted(key=lambda a: a.name or '')
        if not atts:
            return '', '', []

        hint = self._speaker_hint()
        parts, langs, problems = [], [], []
        for att in atts:
            raw = att.raw or b''
            if not raw:
                problems.append('%s: nothing stored' % att.name)
                parts.append('[not captured]')
                continue
            res = Ai.transcribe(raw, mimetype=att.mimetype, hint=hint)
            text = (res.get('text') or '').strip()
            if text:
                parts.append(text)
                if res.get('language'):
                    langs.append(res['language'])
            else:
                # A marked gap, never a silent one: the summary prompt is
                # told not to guess what filled it.
                problems.append('%s: %s' % (att.name,
                                            res.get('error') or 'no words'))
                parts.append('[not captured]')

        text = '\n'.join(parts).strip()
        lang = ', '.join(sorted(set(langs))) if langs else ''
        self.sudo().write({'transcript': text, 'transcript_language': lang})
        return text, lang, problems

    def _facts_block(self):
        """What is known without any audio at all."""
        self.ensure_one()
        tz = self.env['kpi.tz']
        who = []
        for p in self.participant_ids:
            if p.is_recorder:
                continue
            bit = p.person_name or 'Guest'
            if p.talk_seconds:
                bit += ' (spoke about %d min)' % max(1, round(
                    p.talk_seconds / 60.0))
            who.append(bit)
        lines = [
            'Meeting: %s' % (self.name or ''),
            'Task: %s %s' % (self.kpi_id.external_ref or '',
                             self.kpi_id.name or ''),
            'Started: %s' % (tz.fmt(self.opened_at) if self.opened_at else '?'),
            'Room open for: %d min' % (self.actual_minutes or 0),
        ]
        if self.active_minutes:
            lines.append('Somebody talking for: %d min' % self.active_minutes)
        lines.append('In the room: %s' % (', '.join(who) or 'nobody we saw'))
        if self.requested_by_name:
            lines.append('Asked for by: %s' % self.requested_by_name)
        if self.notes:
            # Internal notes only, and this never leaves the summary draft
            # that a person reads before anything is sent to a client.
            lines.append('Internal note: %s' % self.notes[:500])
        return '\n'.join(lines)

    def draft_summary(self, raise_on_problem=False):
        """Write the summary. -> (ok: bool, message: str). Never raises
        unless asked to, because this runs from close_meeting and a meeting
        that cannot be summarised must still end.
        """
        self.ensure_one()
        Ai = self.env['kpi.ai']
        if not Ai.is_available():
            msg = _('No AI provider is configured, so there is nothing to '
                    'summarise with. Settings → AI & Transcription.')
            if raise_on_problem:
                raise UserError(msg)
            return False, msg

        transcript, lang, problems = ('', '', [])
        if self.sudo().recording_ids:
            transcript, lang, problems = self.build_transcript()

        facts = self._facts_block()
        if transcript and transcript.replace('[not captured]', '').strip():
            user_text = ('%s\n\nTRANSCRIPT (as spoken, mixed languages):\n%s'
                         % (facts, transcript))
            source = 'ai-transcript'
        else:
            # No audio, or none of it produced words. Summarise what IS
            # known. Not a transcript, but true, and better than a blank box.
            user_text = (
                '%s\n\nTHERE IS NO TRANSCRIPT for this meeting. Write the '
                'summary from the facts above only, state in one sentence '
                'that no recording was available, and leave action_items '
                'empty unless the facts themselves name one.' % facts)
            source = 'ai-facts-only'

        data, provider = Ai.complete_json(self._SUMMARY_PROMPT, user_text,
                                          max_tokens=900)
        if not isinstance(data, dict) or not (data.get('summary') or '').strip():
            msg = _('The AI provider did not answer. Nothing was changed.')
            if problems:
                msg += '\n\n' + '\n'.join(problems[:5])
            if raise_on_problem:
                raise UserError(msg)
            return False, msg

        summary = str(data.get('summary') or '').strip()
        unclear = str(data.get('unclear') or '').strip()
        if source == 'ai-facts-only':
            summary = _('(No recording — written from the meeting details '
                        'only.)\n') + summary
        if problems:
            summary += _('\n\nNote: part of the audio could not be '
                         'transcribed, so some of the call is missing from '
                         'this summary.')
        if unclear:
            summary += _('\n\nNot clear from the recording: %s') % unclear

        self.sudo().write({
            'summary': summary,
            'action_items': str(data.get('action_items') or '').strip(),
            'summary_source': '%s/%s' % (source, provider),
        })
        return True, _('Summary written by %s.') % provider

    def action_draft_summary(self):
        """The button. Same work, but it tells you what happened."""
        self.ensure_one()
        ok, msg = self.draft_summary(raise_on_problem=True)
        raise UserError(msg if ok else msg)

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
        """Into the right group, and never raises.

        A meeting is normally between us and a client, so this posts into
        that client's group. An INTERNAL meeting -- a developer wanting a
        word with their manager -- must not go there: the client has no part
        in it and would be handed a link to a conversation about them.

        The branch lives here, in the one method every meeting message passes
        through, rather than at the call sites. There are five of them
        (confirmation, reminder, opening, cancellation, summary) and a rule
        enforced in five places is a rule that holds in four.
        """
        self.ensure_one()
        try:
            if self.is_internal:
                group = self.env['kpi.wa.group'].sudo()._staff_group()
                if not group:
                    _logger.warning(
                        'meeting %s is internal but no team group is marked; '
                        'not posting rather than guessing.', self.id)
                    return False
                return bool(self.env['kpi.wa.group.report'].sudo()
                            ._post(body, jid=group.jid))
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
    # Our own recorder, not a person. It joins like anybody else, so without
    # this flag it would be listed as an attendee in the recap sent to the
    # client and would stop the room ever counting as empty.
    is_recorder = fields.Boolean(readonly=True, default=False)
    # Seconds this person was the dominant speaker. Summed from the bot's
    # reports, so it is 0 for a meeting nobody recorded.
    talk_seconds = fields.Integer(readonly=True, default=0)

    @api.depends('joined_at', 'left_at')
    def _compute_minutes(self):
        for rec in self:
            if rec.joined_at and rec.left_at and rec.left_at > rec.joined_at:
                rec.minutes = int(
                    (rec.left_at - rec.joined_at).total_seconds() // 60)
            else:
                rec.minutes = 0

