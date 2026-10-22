"""Bugs and updates about a requirement from the OLD database.

The new database starts empty, so a client reporting a bug about an old
requirement has nothing to pick. The create forms get a "From old DB" toggle:

  * Request ID and Task name are optional -- people often do not know them.
  * Something must say what it is about: a voice note (the normal way), the
    Request ID, the Task name, or a typed explanation. Nothing at all is
    refused (legacy_input_problem). The same rule runs on every create path.
  * Without a Request ID the task waits as "Pending — confirm with client" in
    its KPI Details. An admin checks the old system / asks the client, saves
    the Request ID, and the task is renumbered under it (BUG001-REQ-012).
  * A task still Pending cannot be completed.

The old requirement itself is a small placeholder task (is_legacy): ARCHIVED,
so every report, queue, count and invoice -- which all search active tasks --
leaves it out without having to know about it.
"""

import logging
import re

from odoo import api, fields, models
from odoo.exceptions import UserError

from .kpi_workflow import REF_PREFIX_FOR_DOC_TYPE

_logger = logging.getLogger(__name__)

# What counts as "enough to trace it later". Same numbers in every form.
LEGACY_NOTE_MIN = 30          # typed explanation: "ok" / "same issue" do not count
LEGACY_NAME_MIN = 15          # task name: 15 characters or 3 words
LEGACY_NAME_MIN_WORDS = 3
VOICE_MIN_SECONDS = 5
# A recording whose length is not in its name: ~3-4 KB a second (voice_utils.py),
# so anything under this is a few seconds at most or silence.
VOICE_MIN_BYTES = 16000

LEGACY_MISSING_MSG = ('Add a photo or video of the old screen if you can — if not possible, record a voice note or type a message (or add the Request ID).')
VOICE_SHORT_MSG = ('The voice note is too short (5 seconds or more) — add a photo or video if you can, if not possible record again or type a message.')

_REF_RE = re.compile(r'^\s*REQ\s*-?\s*(\d{1,9})\s*$', re.I)
_AUDIO_EXT_RE = re.compile(r'\.(webm|ogg|opus|mp3|wav|m4a|aac|amr|3gp)$', re.I)
# The recorders name their files "Voice note 1 (0m07s).webm".
_VOICE_LEN_RE = re.compile(r'\((\d+)m(\d{1,2})s\)')
_IMAGE_EXT_RE = re.compile(r'\.(jpe?g|png|gif|webp|bmp|heic|heif)$', re.I)
_VIDEO_EXT_RE = re.compile(r'\.(mp4|mov|mkv|avi|3gp|m4v)$', re.I)

LEGACY_STATUS = [
    ('pending', 'Pending — confirm with client'),
    ('confirmed', 'Confirmed with client'),
]


def normalize_legacy_ref(ref):
    """'req 12' / 'REQ-12' / 'REQ-012' -> 'REQ-012'. '' when empty, None when
    it is not a REQ number at all."""
    s = (ref or '').strip()
    if not s:
        return ''
    m = _REF_RE.match(s)
    if not m:
        return None
    return 'REQ-%03d' % int(m.group(1))


def is_image_or_video(name, mimetype=''):
    m = (mimetype or '').lower()
    if m.startswith(('image/', 'video/')):
        return True
    return bool(_IMAGE_EXT_RE.search(name or '') or _VIDEO_EXT_RE.search(name or ''))


def is_audio(name, mimetype=''):
    if (mimetype or '').lower().startswith('video/'):
        return False
    return (mimetype or '').lower().startswith('audio/') or bool(_AUDIO_EXT_RE.search(name or ''))


def voice_seconds(name):
    """Length written in the recorder's file name, or None."""
    m = _VOICE_LEN_RE.search(name or '')
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


def is_usable_voice(name, size, mimetype=''):
    if not is_audio(name, mimetype):
        return False
    secs = voice_seconds(name)
    if secs is not None:
        return secs >= VOICE_MIN_SECONDS
    return (size or 0) >= VOICE_MIN_BYTES


def legacy_input_problem(ref, name, note, files):
    """'' when the From-old-DB request says enough, else the message to show.

    files: [(name, bytes_or_size, mimetype)] -- what is being attached.
    Any ONE of: a voice note (5 s+), a typed message, a photo, a video, the
    Request ID or the task name.
    """
    if (ref or '').strip():
        return '' if normalize_legacy_ref(ref) else 'The Request ID looks like REQ-012.'
    n = ' '.join((name or '').split())
    if len(n) >= LEGACY_NAME_MIN or len(n.split()) >= LEGACY_NAME_MIN_WORDS:
        return ''
    if len(' '.join((note or '').split())) >= LEGACY_NOTE_MIN:
        return ''
    rows = [(f[0], f[1] if isinstance(f[1], int) else len(f[1] or b''), f[2] if len(f) > 2 else '')
            for f in (files or [])]
    # A photo or a video of the old screen says what it is about by itself.
    if any(size and is_image_or_video(n, mt) for n, size, mt in rows):
        return ''
    audio = [r for r in rows if is_audio(r[0], r[2])]
    if any(is_usable_voice(*a) for a in audio):
        return ''
    return VOICE_SHORT_MSG if audio else LEGACY_MISSING_MSG


class KraKpiLegacy(models.Model):
    _inherit = 'kra.kpi'

    # The placeholder for a requirement that lives in the old database.
    is_legacy = fields.Boolean(
        string='Old DB Requirement', index=True, copy=False,
        help='A requirement from the old database, added so bugs and updates '
             'about it have something to sit under. Archived: never counted as work.')

    # A bug / update raised with "From old DB" on.
    legacy_req_link = fields.Boolean(
        string='From old DB', index=True, copy=False,
        help='This bug or update is about a requirement from the old database.')
    legacy_req_ref = fields.Char(string='Old Request ID', copy=False)
    legacy_req_name = fields.Char(string='Old Task Name', copy=False)
    legacy_note = fields.Text(string='About the old requirement', copy=False,
        help='What the reporter typed instead of (or as well as) a voice note.')
    legacy_transcript = fields.Text(string='Voice note transcript', copy=False, readonly=True)
    legacy_status = fields.Selection(LEGACY_STATUS, string='KPI Details', copy=False, index=True)
    legacy_confirmed_by = fields.Many2one('res.users', string='Confirmed By', copy=False,
                                          readonly=True)
    legacy_confirmed_on = fields.Datetime(string='Confirmed On', copy=False, readonly=True)

    # Every earlier time the client sent this request (JSON, oldest first) --
    # kept when they send it again after a refusal. See client_sends().
    client_send_log = fields.Text(string='Earlier Client Sends', copy=False, readonly=True)
    client_last_sent_at = fields.Datetime(string='Last Sent By Client', copy=False, readonly=True)

    # ------------------------------------------------------------------
    # numbering
    # ------------------------------------------------------------------
    @api.model
    def _legacy_ref_floor(self, prefix='REQ'):
        """Highest number the OLD database used for `prefix`, set once before
        go-live (Settings → kra_kpi.legacy_ref_floor.REQ). 0 = not set."""
        try:
            return int(self.env['ir.config_parameter'].sudo().get_param(
                'kra_kpi.legacy_ref_floor.%s' % prefix) or 0)
        except (TypeError, ValueError):
            return 0

    @api.model
    def _next_ref_for_prefix(self, prefix):
        # New work never takes a number the old database already used.
        n = super()._next_ref_for_prefix(prefix)
        floor = self._legacy_ref_floor(prefix) if prefix else 0
        return max(n, floor + 1)

    # ------------------------------------------------------------------
    # the old requirement placeholder
    # ------------------------------------------------------------------
    @api.model
    def _legacy_check_ref(self, ref, kra):
        """-> (normalized ref, existing record or empty, error) for old Request
        ID `ref` in the client that project `kra` belongs to. Creates nothing,
        so a bulk upload can check every row before making any."""
        ref_n = normalize_legacy_ref(ref)
        Kpi = self.env['kra.kpi'].sudo().with_context(active_test=False)
        if not ref_n:
            return '', Kpi, 'The Request ID looks like REQ-012.'
        floor = self._legacy_ref_floor('REQ')
        if floor and int(ref_n.split('-')[1]) > floor:
            return ref_n, Kpi, ('%s is not an old number — the old database went up to '
                                'REQ-%03d. Pick it from the list instead.') % (ref_n, floor)
        client = kra
        while client and not client.is_client:
            client = client.parent_id
        scope = client._get_descendant_ids() if client else [kra.id]
        found = Kpi.search([('external_ref', '=ilike', ref_n), ('kra_id', 'in', scope)], limit=1)
        if found and not found.is_legacy and found.active:
            return ref_n, found, ('%s is already a requirement in the new system — pick it '
                                  'from the list instead of From old DB.') % ref_n
        return ref_n, found, ''

    def _legacy_find_or_create(self, ref, name, near):
        """The placeholder REQ for `ref` in `near`'s client, made if missing.
        -> (record, error). `near` is the bug / update (or a task in the same
        project) it is for."""
        ref_n, found, err = self._legacy_check_ref(ref, near.kra_id)
        if err:
            return None, err
        Kpi = self.env['kra.kpi'].sudo().with_context(active_test=False)
        if found:
            # A placeholder first made without a name gets the first one given.
            if name and found.is_legacy and not found.legacy_req_name:
                found.write({'name': ' '.join(name.split())[:200], 'legacy_req_name': name})
            return found, ''
        title = ' '.join((name or '').split())[:200] or 'Old requirement %s' % ref_n
        rec = Kpi.with_context(kpi_no_admin_arm=True, kpi_legacy_quiet=True).create({
            'name': title,
            'kra_id': near.kra_id.id,
            'external_ref': ref_n,
            'is_legacy': True,
            'legacy_req_ref': ref_n,
            'legacy_req_name': name or False,
            'client_db_id': near.client_db_id.id or False,
            'deliverable_type': near.deliverable_type or False,
            'deliverable_other': near.deliverable_other or False,
            'task_state': 'completed',
            'published': False,
            'description': 'Requirement from the old database — added when %s was reported%s.' % (
                near.external_ref or 'a task',
                ' by %s' % self.env.user.name if self.env.user and not self.env.user._is_public() else ''),
        })
        # Archived: out of every report, queue and invoice.
        rec.active = False
        return rec, ''

    def _legacy_link(self, ref, name=None, confirm=True):
        """Put this bug / update under old requirement `ref` and renumber it
        <PREFIX>NNN-REQ-012. -> error ('' when done)."""
        self.ensure_one()
        parent, err = self._legacy_find_or_create(ref, name, self)
        if err:
            return err
        kind = self._legacy_kind()
        vals = {'legacy_req_link': True, 'legacy_req_ref': parent.external_ref,
                'related_req_ref': parent.external_ref}
        if name:
            vals['legacy_req_name'] = name
        if kind and not (self.external_ref or '').upper().endswith('-' + parent.external_ref.upper()):
            prefix = REF_PREFIX_FOR_DOC_TYPE[kind]
            vals['external_ref'] = '%s%03d-%s' % (
                prefix, self._next_child_number(prefix, parent.external_ref), parent.external_ref)
            if self.external_ref:
                vals['previous_external_ref'] = self.external_ref
        if confirm:
            vals.update(legacy_status='confirmed', legacy_confirmed_by=self.env.user.id,
                        legacy_confirmed_on=fields.Datetime.now())
        self.sudo().write(vals)
        return ''

    def _legacy_kind(self):
        ref = (self.external_ref or '').upper()
        name = (self.name or '').lower()
        if ref.startswith('BUG') or name.startswith('[bug]') or self.requested_doc_type == 'bug':
            return 'bug'
        if ref.startswith(('UPT', 'UPD')) or name.startswith('[update]') or self.requested_doc_type == 'update':
            return 'update'
        return ''

    @api.model
    def _legacy_new_ref(self, kind):
        """Ref for a From-old-DB bug / update with no Request ID yet: BUG-031.
        Renumbered under the requirement once it is known."""
        prefix = REF_PREFIX_FOR_DOC_TYPE[kind]
        return '%s-%03d' % (prefix, self._next_ref_for_prefix(prefix))

    @api.model
    def _legacy_vals(self, ref, name, note):
        """Fields for a new From-old-DB task (before any linking)."""
        return {
            'legacy_req_link': True,
            'legacy_req_name': ' '.join((name or '').split())[:200] or False,
            'legacy_note': (note or '').strip()[:4000] or False,
            'legacy_status': 'pending',
        }

    # ------------------------------------------------------------------
    # KPI Details: filled in later by the team
    # ------------------------------------------------------------------
    def legacy_save_details(self, ref=None, name=None, note=None, user=None):
        """Save the KPI Details card. A Request ID links + confirms it.
        `user`: who is saving (the routes call this under sudo). Locked with the
        rest of the task's details once it is fully completed; admins excepted
        (kpi_time_adjust._details_locked_for)."""
        self.ensure_one()
        if not self.legacy_req_link:
            raise UserError('This task is not marked From old DB.')
        locked = self._details_locked_for(user or self.env.user)
        if locked:
            raise UserError(locked)
        vals = {}
        if name is not None:
            vals['legacy_req_name'] = ' '.join((name or '').split())[:200] or False
        if note is not None:
            vals['legacy_note'] = (note or '').strip()[:4000] or False
        if vals:
            self.sudo().write(vals)
        if (ref or '').strip():
            err = self._legacy_link(ref, vals.get('legacy_req_name', self.legacy_req_name))
            if err:
                raise UserError(err)
        return self.legacy_details()

    def legacy_details(self):
        """The KPI Details card, as every front end shows it."""
        self.ensure_one()
        if not self.legacy_req_link:
            return False
        parent = self.related_req_kpi_id
        return {
            'on': True,
            'status': self.legacy_status or 'pending',
            'status_label': dict(LEGACY_STATUS).get(self.legacy_status or 'pending'),
            'ref': self.legacy_req_ref or '',
            'name': self.legacy_req_name or (parent.name if parent else '') or '',
            'note': self.legacy_note or '',
            'transcript': self.legacy_transcript or '',
            'confirmed_by': self.legacy_confirmed_by.name or '',
            'confirmed_on': fields.Datetime.to_string(self.legacy_confirmed_on)
            if self.legacy_confirmed_on else '',
            'parent_id': parent.id if parent else False,
        }

    # ------------------------------------------------------------------
    # voice note -> text, after the request is saved
    # ------------------------------------------------------------------
    def _legacy_client_files(self):
        """The files the CLIENT attached to this task (WhatsApp form / portal),
        oldest first: [{'entry': progress id, 'att': attachment id or 0,
        'name', 'mime', 'data': base64}]. A declined request that is fixed and
        sent again keeps them, so they still count as what it is about."""
        out = []
        Att = self.env['kpi.file.attachment'].sudo()
        for p in self.env['kpi.progress'].sudo().search(
                [('kpi_id', '=', self.id), ('from_client', '=', True)], order='id'):
            if p.file_name and p.uploaded_file:
                out.append({'entry': p.id, 'att': 0, 'name': p.file_name, 'mime': '',
                            'data': p.uploaded_file})
            for a in Att.search([('progress_id', '=', p.id)], order='sequence, id'):
                if a.file:
                    out.append({'entry': p.id, 'att': a.id, 'name': a.file_name or 'file',
                                'mime': a.mimetype or '', 'data': a.file})
        return out

    def _legacy_existing_inputs(self):
        """The client's files as legacy_input_problem() reads them:
        [(name, size in bytes, mimetype)]."""
        import base64
        return [(f['name'], len(base64.b64decode(f['data'])), f['mime'])
                for f in self._legacy_client_files()]

    def _legacy_voice_files(self):
        """[(name, bytes, mimetype)] audio the client attached to this task."""
        import base64
        return [(f['name'], base64.b64decode(f['data']), f['mime'])
                for f in self._legacy_client_files() if is_audio(f['name'], f['mime'])]

    def _legacy_transcribe(self):
        """Run in the background after commit. Never fails the request: no
        transcript just means the admin listens to the recording instead."""
        for rec in self:
            if not rec.legacy_req_link or rec.legacy_transcript:
                continue
            texts = []
            for name, data, mime in rec._legacy_voice_files():
                if not is_usable_voice(name, len(data), mime):
                    continue
                res = self.env['kpi.ai'].transcribe(data, mimetype=mime or None)
                if res.get('text') and not res.get('error'):
                    texts.append(res['text'].strip())
                else:
                    _logger.info('old-DB voice note on %s not transcribed: %s', rec.id, res.get('error'))
            if texts:
                rec.sudo().write({'legacy_transcript': '\n\n'.join(texts)[:8000]})

    # ------------------------------------------------------------------
    # earlier bugs / updates under a requirement (the client forms show them
    # when the requirement is picked, so a 3rd bug is not a repeat of the 1st)
    # ------------------------------------------------------------------
    def _child_status(self):
        """Where a bug / update is, in the client's words."""
        self.ensure_one()
        if not self.active:
            return '❌ Not taken forward' if self.decline_mode else '❌ Closed'
        st = self.task_state or ''
        if st == 'completed':
            return '✅ Completed'
        if st == 'awaiting_client':
            return '👀 Ready for you to check'
        if not (self.published or self.admin_accepted) or st in ('queue_waiting', 'pre_approval_pending',
                                                               'pre_approval_partial'):
            return '⏳ Waiting for approval'
        return '🔧 In progress'

    def _child_requests(self, kind):
        """The bugs (or updates) already raised under this requirement, oldest
        first, and the ref the next one gets:
        {'items': [{ref, name, status, date}], 'next_ref': 'BUG003-REQ-012'}."""
        self.ensure_one()
        prefix = REF_PREFIX_FOR_DOC_TYPE[kind]
        req = self.external_ref or ''
        if not req:
            return {'items': [], 'next_ref': ''}
        Kpi = self.env['kra.kpi'].sudo().with_context(active_test=False)
        rows = Kpi.search([('external_ref', '=ilike', '%s%%-%s' % (prefix, req))], order='id')
        rx = re.compile(r'^%s\d{1,9}-%s$' % (re.escape(prefix), re.escape(req)), re.I)
        return {
            'items': [{'ref': k.external_ref, 'name': k.name or '', 'status': k._child_status(),
                       'date': k.create_date.strftime('%d %b') if k.create_date else ''}
                      for k in rows if rx.match((k.external_ref or '').strip())],
            'next_ref': '%s%03d-%s' % (prefix, self._next_child_number(prefix, req), req),
        }

    # ------------------------------------------------------------------
    # every time the client sent this request (the task's Client tab)
    # ------------------------------------------------------------------
    def _client_send_copy(self, done_ids):
        """What the client sent this time, as it stands now."""
        self.ensure_one()
        desc = self.description or ''
        # Drop what the form itself appended (About:, Database:, footer).
        desc = re.split(r'\n\n(?:About: |Database: |— Sent (?:again )?from the WhatsApp form)',
                        desc)[0].strip()
        files = [f for f in self._legacy_client_files() if f['entry'] not in done_ids]
        return {
            'sent_at': fields.Datetime.to_string(self.client_last_sent_at or self.create_date),
            'sent_by': self.submitted_by_uid.name or '',
            'ref': self.external_ref or '',
            'name': self.name or '',
            'description': desc[:4000],
            'old_db': bool(self.legacy_req_link),
            'files': [{'name': f['name'], 'entry': f['entry'], 'att': f['att']} for f in files],
        }

    def _client_sends_saved(self):
        import json
        try:
            return json.loads(self.client_send_log or '[]')
        except ValueError:
            return []

    def _client_send_snapshot(self):
        """Keep the send the client is about to replace, with its refusal."""
        import json
        self.ensure_one()
        saved = self._client_sends_saved()
        done = {f['entry'] for s in saved for f in s.get('files', [])}
        copy = self._client_send_copy(done)
        copy.update({
            'status': 'refused' if self.decline_mode == 'decline' else (
                'retyped' if self.decline_mode == 'reclassify' else 'replaced'),
            'refused_by': self.declined_by_id.name or '',
            'refused_at': fields.Datetime.to_string(self.declined_at) if self.declined_at else '',
            'reason': self.decline_note or '',
        })
        saved.append(copy)
        super(KraKpiLegacy, self.sudo()).write({'client_send_log': json.dumps(saved)})

    def client_sends(self):
        """Every send, oldest first: the kept copies, then the current one."""
        self.ensure_one()
        saved = self._client_sends_saved()
        done = {f['entry'] for s in saved for f in s.get('files', [])}
        current = self._client_send_copy(done)
        if not self.active and self.decline_mode:
            current.update(status='refused', refused_by=self.declined_by_id.name or '',
                           refused_at=fields.Datetime.to_string(self.declined_at)
                           if self.declined_at else '', reason=self.decline_note or '')
        elif self.published or self.admin_accepted:
            current['status'] = 'accepted'
        else:
            current['status'] = 'waiting'
        out = saved + [current]
        for n, s in enumerate(out, start=1):
            s['round'] = n
        return out

    # ------------------------------------------------------------------
    # rules
    # ------------------------------------------------------------------
    def _notify(self, event, extra_users=None, **ctx):
        # The old-requirement placeholder is bookkeeping, not new work.
        if self.is_legacy or self.env.context.get('kpi_legacy_quiet'):
            return
        return super()._notify(event, extra_users=extra_users, **ctx)

    @api.depends('related_req_ref', 'client_kra_id', 'kra_id')
    def _compute_related_req_kpi(self):
        # Same as the base, but an archived old-requirement placeholder matches too.
        Kpi = self.env['kra.kpi'].with_context(active_test=False)
        for rec in self:
            ref = (rec.related_req_ref or '').strip()
            if not ref or not rec.client_kra_id:
                rec.related_req_kpi_id = False
                continue
            match = Kpi.search([
                ('external_ref', '=', ref),
                ('kra_id', 'in', rec.client_kra_id._get_descendant_ids()),
                ('id', '!=', rec.id),
                '|', ('active', '=', True), ('is_legacy', '=', True),
            ], limit=1)
            rec.related_req_kpi_id = match.id if match else False

    def _legacy_relink_children(self):
        """A REQ saved after bugs already named it: link those bugs now
        (related_req_kpi_id only recomputes when the BUG changes)."""
        reqs = self.filtered(lambda r: (r.external_ref or '').upper().startswith('REQ-'))
        if not reqs:
            return
        Kpi = self.env['kra.kpi'].sudo().with_context(active_test=False)
        kids = Kpi.search([('related_req_ref', 'in', reqs.mapped('external_ref'))])
        if kids:
            kids._compute_related_req_kpi()

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        records._legacy_relink_children()
        return records

    def write(self, vals):
        # A client sending a declined request again (fix form or corrected
        # wording): keep a copy of what they sent before, with its refusal,
        # before the new send overwrites it. Shown in the task's Client tab.
        if vals.get('correction_round'):
            for rec in self:
                if vals['correction_round'] > (rec.correction_round or 0):
                    rec._client_send_snapshot()
            vals = dict(vals, client_last_sent_at=fields.Datetime.now())
        if vals.get('task_state') == 'completed':
            blocked = self.filtered(lambda r: r.legacy_req_link and not r.is_legacy
                                    and (r.legacy_status or 'pending') == 'pending')
            if blocked:
                raise UserError(
                    '%s is about an old DB requirement that is still Pending. Add its Request '
                    'ID in KPI Details (ask an admin, who will confirm it with the client) '
                    'before completing it.' % (blocked[0].external_ref or blocked[0].name))
        res = super().write(vals)
        if 'external_ref' in vals:
            self._legacy_relink_children()
        return res
