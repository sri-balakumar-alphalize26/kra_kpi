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
    def legacy_save_details(self, ref=None, name=None, note=None):
        """Save the KPI Details card. A Request ID links + confirms it."""
        self.ensure_one()
        if not self.legacy_req_link:
            raise UserError('This task is not marked From old DB.')
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
    def _legacy_voice_files(self):
        """[(name, bytes, mimetype)] audio the client attached to this task."""
        import base64
        out = []
        for p in self.env['kpi.progress'].sudo().search([('kpi_id', '=', self.id)], order='id'):
            if p.file_name and p.uploaded_file and is_audio(p.file_name):
                out.append((p.file_name, base64.b64decode(p.uploaded_file), ''))
            for a in self.env['kpi.file.attachment'].sudo().search([('progress_id', '=', p.id)]):
                if a.file and is_audio(a.file_name, a.mimetype):
                    out.append((a.file_name, base64.b64decode(a.file), a.mimetype or ''))
        return out

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
