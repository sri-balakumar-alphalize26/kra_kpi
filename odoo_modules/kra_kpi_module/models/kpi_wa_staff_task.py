"""The task-details page, in the internal WhatsApp group.

Everything a developer does on a task's details page on the board can be done
here too, with the same rules:

* Add update -- a progress summary (required), related links, GitHub links
  with their branch, and files (PDF, docs, screenshots) sent straight into
  the chat. Saved as an ordinary kpi.progress / kpi.github.link, so the board,
  the web and the app show it like any other update.
* Add user manual -- PDF / DOC / DOCX only, up to 25 MB, plus a description
  and links. Saved as kpi.user.manual.
* My updates & files -- change the text, add or remove files and links, or
  delete an update / manual / GitHub link the developer added.
* Completed -- summary first, then the employee checklist (one tick is
  enough), or Partial finish with the summary only. Same rule as
  /kra_kpi/task/complete.
* Pause -- the board's reason list; Other / Urgent / Meeting need words, and a
  meeting asks who it is with (or Team meeting).
* Ask for more time, Task details.

WHY THE RULES ARE RESTATED HERE
-------------------------------
The board's checks live in http controllers (request.env.user, request.*).
This runs inside the webhook, with no request user, so the checks are applied
again against the developer the message came from. They are the same checks,
named after the controller method they mirror, so the two can be compared.

Every step is a poll where a poll fits; typed text is what is being asked for
(a summary, a branch name, a reason). "cancel" stops any step.
"""

import base64
import json
import logging
import mimetypes
import os
import re
from urllib.parse import urlparse

import pytz

from odoo import _, fields, models

from .kpi_wa_group_intake import _strip_emoji
from .kpi_wa_staff_menu import ESTIMATE_LOCKED_STATES, STARTED_STATES, _kpi_actions_for

_logger = logging.getLogger(__name__)

# /kpi/progress/upload_file and the board's picker: 50 MB per file.
PROGRESS_MAX_BYTES = 50 * 1024 * 1024
# kra_api._check_manual_upload: documents only, 25 MB.
MANUAL_EXTENSIONS = ('.pdf', '.doc', '.docx')
MANUAL_MAX_BYTES = 25 * 1024 * 1024
# PAUSE_NOTE_MAX / NONTASK_NOTE_MAX: the note has to fit a Workday Map chip.
NOTE_MAX = 60
TEAM_MEETING_LABEL = 'Team meeting'
MEDIA_TYPES = ('image', 'video', 'document', 'audio')
# What the webhook stores as the body of a media message with no caption.
_MEDIA_PLACEHOLDERS = ('[Image]', '[Video]', '[Voice]', '[Document]', '[Sticker]')

# The board's "Employee Completion Checklist", same keys and wording.
CHECKLIST = [
    ('verify_github', '🔗 Verify GitHub URL'),
    ('deployed_task', '🚀 Deployed the task'),
    ('user_manual', '📘 User manual uploaded'),
    ('documentation', '📄 Documentation submission'),
    ('tested_code', '🧪 Manually tested the code'),
]

# The board's pause dialog, same codes, same order. The second value is what
# the board stores as the reason when no note is typed (the option's text).
PAUSE_CODES = [
    ('priority_task', '🔀 Moved to another task'),
    ('break', '☕ Break'),
    ('lunch', '🍽️ Lunch'),
    # No 'meeting' here: a meeting is started from 📅 Meeting, which pauses the
    # running task itself (_meet_done), so offering it twice would be two
    # roads to the same place.
    ('day_end', '🌙 Day End'),
    ('awaiting_approval', '⏳ Waiting for Approval'),
    ('technical_issue', '🛠️ Technical Issue'),
    ('leave', '🏖️ Leave'),
    ('other', '✍️ Other'),
    ('urgent', '🚨 Urgent — notify now'),
]
PAUSE_STORED = {
    'priority_task': '🔀 Moved to another task', 'break': 'Break',
    'lunch': 'Lunch', 'meeting': 'Meeting', 'day_end': '🌙 Day End',
    'awaiting_approval': 'Waiting for Approval',
    'technical_issue': 'Technical Issue', 'leave': 'Leave', 'other': 'Other',
    'urgent': '🚨 Urgent — notify now',
}
# Only these need words (PAUSE_NOTE_CODES on the board).
PAUSE_NOTE_CODES = ('other', 'urgent', 'meeting')

# A link inside a message: with a scheme, starting www., or a bare domain
# followed by a path (github.com/org/repo). A bare "file.pdf" is not a link.
_URL_RE = re.compile(r'(?:https?://|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/\S*', re.I)

SAVE_UPDATE = '✅ Save update'
SAVE_MANUAL = '✅ Save manual'
SAVE_CHANGES = '✅ Save changes'
CANCEL = '❌ Cancel'
BACK = '↩️ Back'
PEOPLE_PAGE = 6


def _github_key(url):
    """kra_api._github_key: one repo typed two ways compares equal."""
    u = (url or '').strip().lower()
    u = re.sub(r'^https?://', '', u)
    u = re.sub(r'^www\.', '', u)
    u = u.rstrip('/')
    if u.endswith('.git'):
        u = u[:-4]
    return u.rstrip('/')


def _is_github_repo(url):
    return bool(re.match(r'^github\.com/[^/]+/[^/]+', _github_key(url)))


def _norm_url(token):
    """A pasted link as a full URL, or None when it is not one.

    WhatsApp shows "www.x.com" and "github.com/a/b" as links, so they are
    accepted and given https:// -- what is stored is always a full URL, the
    same shape the board's `new URL()` check lets through.
    """
    tok = (token or '').strip().rstrip('.,;:!?)]}>\'"')
    if not tok:
        return None
    if not re.match(r'^https?://', tok, re.I):
        tok = 'https://' + tok
    try:
        p = urlparse(tok)
    except ValueError:
        return None
    if p.scheme not in ('http', 'https') or '.' not in (p.netloc or ''):
        return None
    return tok


def _file_key(name):
    """'Report (2).PDF' -> 'report.pdf': the board's _fileKey."""
    base, ext = os.path.splitext((name or '').strip().lower())
    base = re.sub(r'\s*\(\d+\)$', '', base)
    return base + ext


def _free_name(name, taken):
    """'a.pdf' -> 'a (2).pdf', the first name nobody on the task has."""
    base, ext = os.path.splitext(name)
    n = 2
    while ('%s (%d)%s' % (base, n, ext)).lower() in taken:
        n += 1
    return '%s (%d)%s' % (base, n, ext)


def kpi_tz_name(env, user):
    """The timezone to show this person's times in.

    Their own, else the company's, else the admin's. Many staff users have no
    tz set, and the webhook runs without a user timezone, so falling straight
    to UTC put every time five and a half hours early for an IST team.
    """
    admin = env.ref('base.user_admin', raise_if_not_found=False)
    return (user.tz or env.company.partner_id.tz
            or (admin and admin.sudo().tz) or 'UTC')


def _hm(secs):
    m = int(round((secs or 0) / 60.0))
    return '%dh %02dm' % (m // 60, m % 60)


def _links_of(raw):
    """related_links is a JSON list of URL strings; tolerate older shapes."""
    try:
        val = json.loads(raw or '[]')
    except (TypeError, ValueError):
        return []
    out = []
    for v in val if isinstance(val, list) else []:
        if isinstance(v, dict):
            v = v.get('url') or v.get('link') or ''
        if isinstance(v, str) and v.strip():
            out.append(v.strip())
    return out


class KpiWaStaffTask(models.AbstractModel):
    _inherit = 'kpi.wa.group.router'

    # ================================================================== #
    # plumbing                                                            #
    # ================================================================== #
    def _fd(self, state):
        try:
            d = json.loads(state.staff_draft or '{}')
        except (TypeError, ValueError):
            d = {}
        return d if isinstance(d, dict) else {}

    def _fsave(self, state, d, **vals):
        # default=str: a duplicate-file question parks the old file's
        # datetime in the draft; only its ids are read back afterwards.
        vals['staff_draft'] = json.dumps(d, default=str)
        vals.setdefault('step', 'staff_flow')
        state._touch(**vals)

    def _fask(self, message, state, d, question, options):
        """Send a poll and remember exactly what it offered."""
        d['opts'] = list(options)
        self._fsave(state, d)
        self._poll(message, question, list(options))
        return True

    @staticmethod
    def _fchoice(d, tapped, low, allow_number=True):
        opts = d.get('opts') or []
        clean = _strip_emoji(tapped)
        if clean:
            for i, o in enumerate(opts):
                if _strip_emoji(o) == clean:
                    return i
        n = (low or '').strip()
        if allow_number and n.isdigit() and 1 <= int(n) <= len(opts):
            return int(n) - 1
        return None

    def _when(self, user, dt):
        if not dt:
            return ''
        try:
            tz = pytz.timezone(kpi_tz_name(self.env, user))
        except pytz.UnknownTimeZoneError:
            tz = pytz.UTC
        return pytz.UTC.localize(dt).astimezone(tz).strftime('%d %b %Y, %I:%M %p')

    def _when_short(self, user, dt):
        """'20 Oct 07:29 PM' -- for poll rows, which have 100 characters."""
        full = self._when(user, dt)
        return (full[:6] + full[11:]) if full else ''

    @staticmethod
    def _is_admin(user):
        return (user.has_group('kra_kpi_module.group_kra_owner')
                or user.has_group('kra_kpi_module.group_kra_admin')
                or user.has_group('kra_kpi_module.group_kra_manager')
                or user.has_group('base.group_system'))

    def _tmp_clear(self, state):
        self.env['ir.attachment'].sudo().search([
            ('res_model', '=', 'kpi.wa.group.intake'),
            ('res_id', '=', state.id)]).unlink()

    def _back_to_task(self, message, state, task, note=''):
        """Done with one thing: show the task's options again, so the next
        thing is one tap away instead of a fresh "hi"."""
        if note:
            self._text(message, note)
        self._tmp_clear(state)
        if task and task.exists():
            return self._staff_offer_actions(message, state, task)
        state._reset()
        return True

    @staticmethod
    def _ref(task):
        return task.external_ref or ('#%s' % task.id)

    # ================================================================== #
    # dispatch                                                            #
    # ================================================================== #
    def _flow(self, message, state, user, tapped, low, body):
        d = self._fd(state)
        at = d.get('at')
        handler = {
            'collect': self._fl_collect, 'branch': self._fl_branch,
            'dupfile': self._fl_dupfile, 'done_pick': self._fl_done_pick,
            'check': self._fl_check, 'mine': self._fl_mine,
            'entry': self._fl_entry, 'entry_text': self._fl_entry_text,
            'entry_file': self._fl_entry_file, 'entry_link': self._fl_entry_link,
            'entry_del': self._fl_entry_del, 'time': self._fl_time,
            'pause_code': self._fl_pause_code, 'pause_note': self._fl_pause_note,
            'meet_who': self._fl_meet_who, 'meet_note': self._fl_meet_note,
            'meet_menu': self._fl_meet_menu, 'meet_client': self._fl_meet_client,
            'kpi_menu': self._fl_kpi_menu,
            'guide': self._fl_guide, 'resume_reason': self._fl_resume_reason,
            'undo': self._fl_undo, 'files': self._fl_files, 'logs': self._fl_logs,
            'c_name': self._fl_c_name, 'c_proj': self._fl_c_proj, 'c_type': self._fl_c_type,
            'c_deliv': self._fl_c_deliv, 'c_prio': self._fl_c_prio, 'c_est': self._fl_c_est,
            'c_confirm': self._fl_c_confirm,
        }.get(at)
        if not handler:
            state._reset()
            return False
        task = state.staff_kpi_id
        needs_task = not (at in ('meet_menu', 'meet_client') or (at or '').startswith('c_')
                          or (at in ('meet_who', 'meet_note') and d.get('purpose') == 'nontask'))
        if needs_task and (not task or not task.exists()):
            state._reset()
            return False
        if message.message_type in MEDIA_TYPES and at != 'collect':
            self._text(message, _('Finish this step first, then send the file '
                                  '(through 📝 Add update or 📘 Add user manual).'))
            return True
        return handler(message, state, user, d, task, tapped, low, body)

    # ================================================================== #
    # Add update / Add user manual / add to an existing one               #
    # ================================================================== #
    def _upd_begin(self, message, state, user, task, mode='progress',
                   target=None, after=None):
        """mode: progress | manual | add_progress | add_manual."""
        if mode in ('progress', 'manual') and task.task_state not in STARTED_STATES:
            return self._back_to_task(message, state, task, _(
                'Start %s first — updates, files, manuals and GitHub links are '
                'added once a task has been started.') % self._ref(task))
        self._tmp_clear(state)
        d = {'at': 'collect', 'mode': mode, 'target': target, 'after': after,
             'text': '', 'links': [], 'gh': [], 'gh_queue': [], 'files': [],
             'replace': []}
        ref = '%s — %s' % (self._ref(task), task.name or '')
        if mode == 'progress':
            intro = _(
                '📝 Update for %s\n\nSend in any order:\n'
                '• What you did — required, this is what your manager reads\n'
                '• Links (Drive, docs…) — just paste them\n'
                '• GitHub repo link — I will ask for the branch\n'
                '• Files — PDF, docs, screenshots, up to 50 MB each\n\n'
                'Then tap ✅ Save update.') % ref
            if after == 'done':
                intro = _('Before finishing, add a progress summary.\n\n') + intro
            elif after == 'partial':
                intro = _('Partial finish sends the task as-is. Say what was '
                          'done and what is left.\n\n') + intro
            save = SAVE_UPDATE
        elif mode == 'manual':
            intro = _(
                '📘 User manual for %s\n\n'
                '• Send the manual file — PDF, DOC or DOCX, up to 25 MB each '
                '(required)\n'
                '• Optional: a short description and related links\n\n'
                'Then tap ✅ Save manual.') % ref
            save = SAVE_MANUAL
        else:
            intro = _('➕ Adding to your %s on %s.\nSend files, links or more '
                      'text, then tap ✅ Save changes.') % (
                _('update') if mode == 'add_progress' else _('user manual'), ref)
            save = SAVE_CHANGES
        d['save'] = save
        return self._fask(message, state, d, intro, [save, CANCEL])

    def _collect_prompt(self, message, state, d, notes):
        mode = d.get('mode')
        bits = []
        if mode in ('progress', 'add_progress'):
            bits.append(_('summary ✓') if d.get('text') else
                        (_('summary — not yet') if mode == 'progress' else _('no new text')))
        elif d.get('text'):
            bits.append(_('description ✓'))
        if d.get('links'):
            bits.append(_('%d link(s)') % len(d['links']))
        for g in d.get('gh') or []:
            bits.append(_('GitHub: %s (%s)') % (_github_key(g['url']).replace('github.com/', ''), g['branch']))
        if d.get('files'):
            bits.append(_('%d file(s): %s') % (len(d['files']), ', '.join(f['name'] for f in d['files'])))
        q = '\n'.join([n for n in notes if n] + ['', _('So far: ') + (' · '.join(bits) or _('nothing yet')),
                                                 _('Send more, or:')]).strip()
        return self._fask(message, state, d, q, [d.get('save') or SAVE_UPDATE, CANCEL])

    def _fl_collect(self, message, state, user, d, task, tapped, low, body):
        is_media = message.message_type in MEDIA_TYPES
        if not is_media:
            i = self._fchoice(d, tapped, low, allow_number=False)
            if i is None and low.strip() in ('save', 'done', 'submit'):
                i = 0
            if i == 0:
                return self._upd_save(message, state, user, d, task)
            if i == 1:
                return self._back_to_task(message, state, task, _('Cancelled — nothing was saved.'))
        notes = []
        text = (body or '').strip()
        if text in _MEDIA_PLACEHOLDERS:
            text = ''
        if text:
            notes += self._take_text(d, task, text)
        if is_media:
            got = self._take_file(message, state, user, d, task)
            if got is None:            # a same-name question was asked instead
                return True
            notes += got
        if d.get('gh_queue'):
            return self._ask_branch(message, state, d, notes)
        return self._collect_prompt(message, state, d, notes)

    def _take_text(self, d, task, text):
        notes = []
        github_ok = d.get('mode') in ('progress', 'add_progress')
        for tok in _URL_RE.findall(text):
            url = _norm_url(tok)
            if not url:
                notes.append(_('⚠ "%s" is not a valid link (e.g. https://example.com).') % tok)
                continue
            if github_ok and _is_github_repo(url):
                if any(_github_key(u) == _github_key(url) for u in d['gh_queue']):
                    continue
                d['gh_queue'].append(url)
                continue
            dup = self._link_dup(task, url, d)
            if dup:
                notes.append('⚠ ' + dup)
                continue
            d['links'].append(url)
            notes.append(_('🔗 Link added: %s') % url)
        rest = ' '.join(_URL_RE.sub(' ', text).split()).strip()
        if rest:
            d['text'] = ('%s\n%s' % (d.get('text') or '', rest)).strip()
            notes.append(_('✍️ Summary noted') if d.get('mode') in ('progress', 'add_progress')
                         else _('✍️ Description noted'))
        return notes

    def _link_index(self, task):
        """kpi_action._taskLinkIndex: every link already on the task."""
        idx = {}

        def put(url, who, when, where):
            k = _github_key(url)
            if k and k not in idx:
                idx[k] = (who, when, where)
        for g in self.env['kpi.github.link'].sudo().search([('kpi_id', '=', task.id)]):
            put(g.github_url, g.employee_name or g.user_id.name, g.create_date,
                _('GitHub, branch %s') % (g.branch_name or ''))
        for p in self.env['kpi.progress'].sudo().search([('kpi_id', '=', task.id)]):
            for u in _links_of(p.related_links):
                put(u, p.employee_name or p.user_id.name, p.create_date, _('related link'))
        for m in self.env['kpi.user.manual'].sudo().search([('kpi_id', '=', task.id)]):
            for u in _links_of(m.related_links):
                put(u, m.uploader_name or m.uploaded_by.name, m.upload_date, _('manual link'))
        return idx

    def _link_dup(self, task, url, d):
        k = _github_key(url)
        if any(_github_key(u) == k for u in d.get('links') or []):
            return _('Already added to this list.')
        hit = self._link_index(task).get(k)
        if hit:
            who, when, where = hit
            return _('Already on this task (%s): added by %s on %s.') % (
                where, who or _('someone'), self._when(self.env.user, when))
        return ''

    # ---- GitHub branch ------------------------------------------------ #
    def _ask_branch(self, message, state, d, notes):
        url = d['gh_queue'][0]
        d['at'] = 'branch'
        q = '\n'.join([n for n in notes if n] + [
            '', _('🐙 GitHub link: %s\nWhich branch? Tap one or type the branch name.') % url]).strip()
        return self._fask(message, state, d, q, ['🌿 main', '🌿 master', '⏭️ Skip this link'])

    def _fl_branch(self, message, state, user, d, task, tapped, low, body):
        url = d['gh_queue'][0]
        i = self._fchoice(d, tapped, low, allow_number=False)
        notes = []
        if i == 2:
            notes.append(_('Skipped %s') % url)
        else:
            branch = 'main' if i == 0 else 'master' if i == 1 else (body or '').strip()
            if not branch or ' ' in branch or len(branch) > 100:
                self._text(message, _('Please enter a branch name — one word, e.g. main or feature/login.'))
                return True
            notes.append(self._add_github(d, task, url, branch))
        d['gh_queue'] = d['gh_queue'][1:]
        d['at'] = 'collect'
        if d['gh_queue']:
            return self._ask_branch(message, state, d, notes)
        return self._collect_prompt(message, state, d, notes)

    def _add_github(self, d, task, url, branch):
        """kpi_action.githubDup + /kpi/github/add: the same repo AND branch
        twice is refused; another branch of the same repo is fine."""
        key, b = _github_key(url), branch.strip().lower()
        for g in d['gh']:
            if _github_key(g['url']) == key and g['branch'].lower() == b:
                return _('⚠ Already added to this list (branch %s).') % branch
        same = self.env['kpi.github.link'].sudo().search([('kpi_id', '=', task.id)]).filtered(
            lambda g: _github_key(g.github_url) == key)
        exact = same.filtered(lambda g: (g.branch_name or '').strip().lower() == b)[:1]
        if exact:
            return _('⚠ Already linked by %s on %s (branch %s).') % (
                exact.employee_name or _('someone'), self._when(self.env.user, exact.create_date),
                exact.branch_name)
        d['gh'].append({'url': url, 'branch': branch.strip()})
        note = _('🐙 GitHub link added (branch %s)') % branch
        if same:
            note += _(' — this repo is also linked on branch %s.') % ', '.join(
                (g.branch_name or '') for g in same)
        return note

    # ---- files --------------------------------------------------------- #
    def _wa_media(self, message):
        """Download the file a message carries: (name, bytes, mimetype)."""
        s = self._session(message)
        if not s:
            raise ValueError(_('WhatsApp is not connected'))
        api, inst = s.sudo()._get_client()
        res = {}
        try:
            res = api.get_base64_from_media(inst, message.wa_message_id) or {}
        except Exception as exc:
            _logger.info('media by id failed (%s), retrying with the full key', exc)
        if not (isinstance(res, dict) and res.get('base64')):
            key = {'id': message.wa_message_id, 'fromMe': False,
                   'remoteJid': message.remote_jid or message.phone}
            if message.participant_jid:
                key['participant'] = message.participant_jid
            res = api._send('/chat/getBase64FromMediaMessage/%s' % inst,
                            {'message': {'key': key}}, timeout=(5, 120)) or {}
        b64 = res.get('base64') if isinstance(res, dict) else None
        if not b64:
            raise ValueError(_('the file could not be fetched from WhatsApp'))
        raw = base64.b64decode(b64)
        mime = (res.get('mimetype') or res.get('mimeType') or 'application/octet-stream').split(';')[0].strip()
        name = (res.get('fileName') or res.get('filename') or '').strip()
        if not name or '.' not in name:
            ext = mimetypes.guess_extension(mime) or ''
            stamp = fields.Datetime.now().strftime('%Y%m%d_%H%M%S')
            name = (name or 'whatsapp_%s' % stamp) + ext
        return name, raw, mime

    def _task_files(self, task, user):
        """kra_api.task_files_index: every file name on the task, whoever
        added it, and whether this developer may replace it."""
        Att = self.env['kpi.file.attachment'].sudo()
        admin = self._is_admin(user)
        out = []
        for p in self.env['kpi.progress'].sudo().search([('kpi_id', '=', task.id)]):
            can = admin or p.user_id.id == user.id
            who = p.employee_name or p.user_id.name
            if p.file_name:
                out.append({'kind': 'progress', 'entry': p.id, 'att': 0, 'name': p.file_name,
                            'who': who, 'when': p.file_at or p.create_date, 'can': can})
            for a in Att.search([('progress_id', '=', p.id)], order='sequence, id'):
                out.append({'kind': 'progress', 'entry': p.id, 'att': a.id, 'name': a.file_name,
                            'who': who, 'when': a.create_date, 'can': can})
        for m in self.env['kpi.user.manual'].sudo().search([('kpi_id', '=', task.id)]):
            can = admin or m.uploaded_by.id == user.id
            who = m.uploader_name or m.uploaded_by.name
            if m.file_name:
                out.append({'kind': 'manual', 'entry': m.id, 'att': 0, 'name': m.file_name,
                            'who': who, 'when': m.file_at or m.upload_date, 'can': can})
            for a in Att.search([('manual_id', '=', m.id)], order='sequence, id'):
                out.append({'kind': 'manual', 'entry': m.id, 'att': a.id, 'name': a.file_name,
                            'who': who, 'when': a.create_date, 'can': can})
        return out

    def _take_file(self, message, state, user, d, task):
        """Download, check, park. None when a same-name question was asked."""
        try:
            name, raw, mime = self._wa_media(message)
        except Exception as exc:
            _logger.warning('staff media download failed: %s', exc)
            return [_('⚠ Could not download that file (%s). Send it again.') % str(exc)[:120]]
        if not raw:
            return [_('⚠ That file came through empty. Send it again.')]
        size_mb = len(raw) / (1024.0 * 1024.0)
        if d.get('mode') in ('manual', 'add_manual'):
            if not name.lower().endswith(MANUAL_EXTENSIONS):
                return [_('⚠ "%s": only PDF, DOC and DOCX files can be uploaded as a manual.') % name]
            if len(raw) > MANUAL_MAX_BYTES:
                return [_('⚠ "%s" exceeds the 25 MB limit.') % name]
        elif len(raw) > PROGRESS_MAX_BYTES:
            return [_('⚠ "%s" is %.1f MB — over the 50 MB limit. Add a Drive or GitHub '
                      'link instead.') % (name, size_mb)]
        att = self.env['ir.attachment'].sudo().create({
            'name': name, 'datas': base64.b64encode(raw), 'mimetype': mime,
            'res_model': 'kpi.wa.group.intake', 'res_id': state.id,
        })
        on_task = self._task_files(task, user)
        lower = name.lower()
        old = next((f for f in on_task if (f['name'] or '').lower() == lower), None) \
            or next((f for f in on_task if _file_key(f['name']) == _file_key(name)), None)
        repeat = any(f['name'].lower() == lower for f in d['files'])
        if old or repeat:
            taken = {(f['name'] or '').lower() for f in on_task} | {f['name'].lower() for f in d['files']}
            keep = _free_name(name, taken) if lower in taken else name
            claimed = {(r['kind'], r['entry'], r['att']) for r in d['replace']}
            can = bool(old and not repeat and old['can']
                       and (old['kind'], old['entry'], old['att']) not in claimed)
            d['dup'] = {'att': att.id, 'name': name, 'keep': keep, 'old': old, 'can': can}
            d['at'] = 'dupfile'
            if old and not repeat:
                same = old['name'].lower() == lower
                q = (_('"%s" is already on this task.') % name if same else
                     _('"%s" looks like "%s", which is already on this task.') % (name, old['name']))
                q += '\n' + _('Uploaded by %s on %s.') % (old['who'] or _('someone'),
                                                          self._when(user, old['when']))
                kept = '' if keep == name else _(' (the new one is saved as "%s")') % keep
                q += '\n\n' + (_('Replace it with the new file, or keep both%s?') % kept if can
                               else _('Keep both%s?') % kept)
                if not old['can']:
                    q += '\n' + _('Only the uploader or an admin can replace it.')
            else:
                q = _('You already sent a file named "%s". Keep both (saved as "%s")?') % (name, keep)
            opts = (['♻️ Replace the old file'] if can else []) + ['➕ Keep both', '⏭️ Skip this file']
            self._fask(message, state, d, q, opts)
            return None
        d['files'].append({'att': att.id, 'name': name})
        return [_('📎 %s added (%.1f MB)') % (name, size_mb)]

    def _fl_dupfile(self, message, state, user, d, task, tapped, low, body):
        dup = d.get('dup') or {}
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        choice = (['replace'] if dup.get('can') else []) + ['keep', 'skip']
        choice = choice[i] if i < len(choice) else 'skip'
        att = self.env['ir.attachment'].sudo().browse(dup.get('att'))
        note = ''
        if choice == 'skip':
            att.unlink()
            note = _('⏭️ Skipped %s') % dup.get('name')
        elif choice == 'replace':
            old = dup['old']
            d['replace'].append({'kind': old['kind'], 'entry': old['entry'], 'att': old['att']})
            d['files'].append({'att': att.id, 'name': dup['name']})
            note = _('♻️ %s will replace the old file when you save.') % dup['name']
        else:
            if dup.get('keep') and dup['keep'] != dup['name']:
                att.write({'name': dup['keep']})
            d['files'].append({'att': att.id, 'name': dup.get('keep') or dup['name']})
            note = _('📎 %s added') % (dup.get('keep') or dup['name'])
        d.pop('dup', None)
        d['at'] = 'collect'
        if d.get('gh_queue'):
            return self._ask_branch(message, state, d, [note])
        return self._collect_prompt(message, state, d, [note])

    # ---- saving -------------------------------------------------------- #
    def _attach(self, record, primary_field, atts):
        """kra_api._store_entry_files: the first file on the entry's own field
        (everything outside the web reads only that), the rest as
        kpi.file.attachment rows in order."""
        link = 'progress_id' if record._name == 'kpi.progress' else 'manual_id'
        Att = self.env['kpi.file.attachment'].sudo()
        seq = max(Att.search([(link, '=', record.id)]).mapped('sequence') or [10])
        now = fields.Datetime.now()
        for a in atts:
            if not record.file_name:
                record.sudo().write({primary_field: a.datas, 'file_name': a.name, 'file_at': now})
            else:
                seq += 10
                Att.create({link: record.id, 'file': a.datas, 'file_name': a.name,
                            'mimetype': a.mimetype, 'sequence': seq})

    def _remove_file(self, kind, entry, att_id):
        """kra_api.remove_entry_file. Returns 'deleted' when a manual lost its
        last file and was removed with it."""
        Att = self.env['kpi.file.attachment'].sudo()
        field = 'uploaded_file' if kind == 'progress' else 'manual_file'
        link = 'progress_id' if kind == 'progress' else 'manual_id'
        if att_id:
            Att.browse(att_id).exists().unlink()
            left = True
        else:
            nxt = Att.search([(link, '=', entry.id)], order='sequence, id', limit=1)
            if nxt:
                entry.sudo().write({field: nxt.file, 'file_name': nxt.file_name,
                                    'file_at': nxt.create_date})
                nxt.unlink()
                left = True
            else:
                entry.sudo().write({field: False, 'file_name': False, 'file_at': False})
                left = False
        if kind == 'manual' and not left and not Att.search_count([(link, '=', entry.id)]):
            entry.sudo().unlink()
            return 'deleted'
        if kind == 'progress':
            entry.sudo().write({'edited_at': fields.Datetime.now()})
        return 'ok'

    def _upd_save(self, message, state, user, d, task):
        mode = d.get('mode')
        atts = self.env['ir.attachment'].sudo().browse([f['att'] for f in d.get('files') or []]).exists()
        text = (d.get('text') or '').strip()
        if mode == 'progress' and not text:
            return self._collect_prompt(message, state, d, [_(
                '⚠ Describe what you did before saving — this is what your manager reads.')])
        if mode == 'manual' and not atts:
            return self._collect_prompt(message, state, d, [_(
                '⚠ A file is required — send the manual (PDF, DOC or DOCX).')])
        if mode in ('add_progress', 'add_manual') and not (atts or d.get('links') or d.get('gh') or text):
            return self._collect_prompt(message, state, d, [_(
                '⚠ Nothing to add yet — send a file, a link or some text.')])
        env_u = self.env(user=user.id, su=True)
        done = []
        try:
            with self.env.cr.savepoint():
                if mode == 'progress':
                    rec = env_u['kpi.progress'].create({
                        'kpi_id': task.id, 'summary': text, 'user_id': user.id,
                        'related_links': json.dumps(d.get('links') or [])})
                    self._attach(rec, 'uploaded_file', atts)
                elif mode == 'manual':
                    rec = env_u['kpi.user.manual'].create({
                        'kpi_id': task.id, 'description': text,
                        'related_links': json.dumps(d.get('links') or []),
                        'uploaded_by': user.id, 'upload_date': fields.Datetime.now()})
                    self._attach(rec, 'manual_file', atts)
                else:
                    model = 'kpi.progress' if mode == 'add_progress' else 'kpi.user.manual'
                    rec = env_u[model].browse(int(d.get('target') or 0)).exists()
                    owner = rec.user_id if model == 'kpi.progress' else rec.uploaded_by
                    if not rec or not (owner.id == user.id or self._is_admin(user)):
                        raise ValueError(_('Only the uploader or an admin can change this.'))
                    vals = {}
                    if d.get('links'):
                        vals['related_links'] = json.dumps(_links_of(rec.related_links) + d['links'])
                    tf = 'summary' if model == 'kpi.progress' else 'description'
                    if text:
                        vals[tf] = ('%s\n%s' % (rec[tf] or '', text)).strip()
                    if model == 'kpi.progress':
                        vals['edited_at'] = fields.Datetime.now()
                    if vals:
                        rec.write(vals)
                    self._attach(rec, 'uploaded_file' if model == 'kpi.progress' else 'manual_file', atts)
                for g in d.get('gh') or []:
                    env_u['kpi.github.link'].create({
                        'kpi_id': task.id, 'github_url': g['url'],
                        'branch_name': g['branch'], 'user_id': user.id})
                for r in d.get('replace') or []:
                    model = 'kpi.progress' if r['kind'] == 'progress' else 'kpi.user.manual'
                    entry = self.env[model].sudo().browse(r['entry']).exists()
                    if entry:
                        self._remove_file(r['kind'], entry, r['att'])
        except Exception as exc:
            _logger.exception('staff update save failed')
            return self._collect_prompt(message, state, d, [_('⚠ Could not save: %s') % str(exc)[:200]])
        if text and mode != 'manual':
            done.append(_('summary'))
        elif text:
            done.append(_('description'))
        if d.get('links'):
            done.append(_('%d link(s)') % len(d['links']))
        if atts:
            done.append(_('%d file(s)') % len(atts))
        if d.get('gh'):
            done.append(_('%d GitHub link(s)') % len(d['gh']))
        what = {'progress': _('Update saved'), 'manual': _('User manual saved')}.get(mode, _('Changes saved'))
        note = '✅ %s on %s — %s.' % (what, self._ref(task), ', '.join(done) or _('nothing new'))
        self._tmp_clear(state)
        after = d.get('after')
        if after == 'done':
            self._text(message, note)
            return self._done_checklist(message, state, user, task, fresh=True)
        if after == 'partial':
            self._text(message, note)
            return self._done_finish(message, state, user, task, [], partial=True)
        if mode in ('add_progress', 'add_manual'):
            return self._mine_begin(message, state, user, task, note=note)
        return self._back_to_task(message, state, task, note)

    # ================================================================== #
    # Completed                                                           #
    # ================================================================== #
    def _done_begin(self, message, state, user, task):
        if task.task_state not in STARTED_STATES:
            return self._back_to_task(message, state, task, _(
                'Resume %s first — a task has to be started before it can be finished.')
                % self._ref(task))
        Progress = self.env['kpi.progress'].sudo()
        last = Progress.search([('kpi_id', '=', task.id)], order='create_date desc, id desc', limit=1)
        if not last:
            return self._upd_begin(message, state, user, task, mode='progress', after='done')
        snippet = (last.summary or '').strip().replace('\n', ' ')
        if len(snippet) > 160:
            snippet = snippet[:157] + '…'
        q = _('✅ Finish %s — %s\n\nLast update (%s, %s):\n"%s"\n\nAdd a new update first, '
              'or go on with the last one?') % (
            self._ref(task), task.name or '', last.employee_name or last.user_id.name or '',
            self._when(user, last.create_date), snippet)
        return self._fask(message, state, {'at': 'done_pick'}, q,
                          ['📝 Add a new update', '➡️ Go on with the last update', CANCEL])

    def _fl_done_pick(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i == 0:
            return self._upd_begin(message, state, user, task, mode='progress', after='done')
        if i == 1:
            return self._done_checklist(message, state, user, task, fresh=False)
        if i == 2:
            return self._back_to_task(message, state, task)
        return False

    def _done_checklist(self, message, state, user, task, fresh, ticked=None):
        ticked = list(ticked or [])
        labels = dict(CHECKLIST)
        spent = task.timer_total_seconds or 0
        if task.timer_start_datetime:
            spent += max(0, (fields.Datetime.now() - task.timer_start_datetime).total_seconds())
        q = _('✅ Finish %s — %s\nTick what you have done (one is enough), then tap Submit '
              'for approval. The task goes to your manager.\n\nTicked: %s\nTime spent: %s') % (
            self._ref(task), task.name or '',
            ', '.join(labels[k] for k in ticked) or _('nothing yet'), _hm(spent))
        opts = [l for k, l in CHECKLIST if k not in ticked]
        if ticked:
            opts.append('📤 Submit for approval')
        opts += ['🏁 Partial finish — summary only', CANCEL]
        return self._fask(message, state, {'at': 'check', 'ticked': ticked, 'fresh': fresh}, q, opts)

    def _fl_check(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        picked = d['opts'][i]
        by_label = {l: k for k, l in CHECKLIST}
        if picked in by_label:
            return self._done_checklist(message, state, user, task, d.get('fresh'),
                                        d.get('ticked', []) + [by_label[picked]])
        if picked == CANCEL:
            return self._back_to_task(message, state, task)
        if picked.startswith('📤'):
            return self._done_finish(message, state, user, task, d.get('ticked') or [])
        # Partial finish: the board asks for a summary every time.
        if d.get('fresh'):
            return self._done_finish(message, state, user, task, [], partial=True)
        return self._upd_begin(message, state, user, task, mode='progress', after='partial')

    def _done_finish(self, message, state, user, task, ticked, partial=False):
        """/kra_kpi/task/complete, rule for rule."""
        if not self.env['kpi.progress'].sudo().search_count([('kpi_id', '=', task.id)]):
            return self._back_to_task(message, state, task, _(
                'Please submit a Progress Summary before completing this task.'))
        checklist = {} if partial else {k: (k in ticked) for k, _l in CHECKLIST}
        if not partial and not any(checklist.values()):
            return self._done_checklist(message, state, user, task, True)
        return self._staff_run(message, state, user, task, 'complete',
                               checklist=checklist, partial=partial)

    # ================================================================== #
    # My updates & files                                                  #
    # ================================================================== #
    def _mine_items(self, task, user):
        items = []
        for p in self.env['kpi.progress'].sudo().search(
                [('kpi_id', '=', task.id), ('user_id', '=', user.id)], order='create_date desc'):
            items.append(('p', p.id, p.create_date))
        for m in self.env['kpi.user.manual'].sudo().search(
                [('kpi_id', '=', task.id), ('uploaded_by', '=', user.id)]):
            items.append(('m', m.id, m.upload_date or m.create_date))
        for g in self.env['kpi.github.link'].sudo().search(
                [('kpi_id', '=', task.id), ('user_id', '=', user.id)]):
            items.append(('g', g.id, g.create_date))
        items.sort(key=lambda x: x[2] or fields.Datetime.now(), reverse=True)
        return items[:8]

    def _entry_files(self, kind, entry):
        Att = self.env['kpi.file.attachment'].sudo()
        link = 'progress_id' if kind == 'p' else 'manual_id'
        out = [(0, entry.file_name)] if entry.file_name else []
        out += [(a.id, a.file_name) for a in Att.search([(link, '=', entry.id)], order='sequence, id')]
        return out

    def _mine_label(self, n, kind, rid, user):
        if kind == 'p':
            p = self.env['kpi.progress'].sudo().browse(rid)
            nf = len(self._entry_files('p', p))
            txt = ' '.join((p.summary or '').split())[:38]
            extra = (_(' (%d file)') % nf) if nf == 1 else (_(' (%d files)') % nf if nf else '')
            return '%d. 📝 %s — %s%s' % (n, self._when_short(user, p.create_date), txt, extra)
        if kind == 'm':
            m = self.env['kpi.user.manual'].sudo().browse(rid)
            return '%d. 📘 %s — %s' % (n, self._when_short(user, m.upload_date),
                                       (m.file_name or _('manual'))[:40])
        g = self.env['kpi.github.link'].sudo().browse(rid)
        return '%d. 🐙 %s (%s)' % (n, _github_key(g.github_url).replace('github.com/', '')[:45],
                                   (g.branch_name or '')[:20])

    def _mine_begin(self, message, state, user, task, note=''):
        items = self._mine_items(task, user)
        if not items:
            return self._back_to_task(message, state, task, (note + '\n\n' if note else '') + _(
                'You have not added anything to %s yet.') % self._ref(task))
        opts = [self._mine_label(i + 1, k, r, user)[:95] for i, (k, r, _w) in enumerate(items)]
        q = ((note + '\n\n') if note else '') + _(
            '🗂️ Your updates, files & links on %s — pick one to change or remove.') % self._ref(task)
        d = {'at': 'mine', 'items': [[k, r] for k, r, _w in items]}
        return self._fask(message, state, d, q, opts + [BACK])

    def _fl_mine(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        if i >= len(d['items']):
            return self._back_to_task(message, state, task)
        kind, rid = d['items'][i]
        return self._entry_show(message, state, user, task, kind, rid)

    def _entry_rec(self, kind, rid, user):
        model = {'p': 'kpi.progress', 'm': 'kpi.user.manual', 'g': 'kpi.github.link'}[kind]
        rec = self.env[model].sudo().browse(rid).exists()
        if not rec:
            return rec
        owner = rec.uploaded_by if kind == 'm' else rec.user_id
        if owner.id != user.id and not self._is_admin(user):
            return self.env[model]
        return rec

    def _entry_show(self, message, state, user, task, kind, rid, note=''):
        rec = self._entry_rec(kind, rid, user)
        if not rec:
            return self._mine_begin(message, state, user, task, note=_('That entry is gone.'))
        lines = [note, ''] if note else []
        acts = []
        if kind == 'g':
            lines.append(_('🐙 GitHub link: %s\nBranch: %s\nAdded %s') % (
                rec.github_url, rec.branch_name or '', self._when(user, rec.create_date)))
            acts = [('del', '❌ Delete this link')]
        else:
            files = self._entry_files(kind, rec)
            links = _links_of(rec.related_links)
            if kind == 'p':
                lines.append(_('📝 Your update of %s:\n"%s"') % (self._when(user, rec.create_date),
                                                                (rec.summary or '').strip()[:600]))
                acts.append(('text', '✏️ Change the text'))
            else:
                lines.append(_('📘 Your user manual of %s:\nDescription: %s') % (
                    self._when(user, rec.upload_date), (rec.description or '—').strip()[:400]))
                acts.append(('text', '✏️ Change the description'))
            lines.append(_('Files: %s') % (', '.join(n for _i, n in files) or '—'))
            lines.append(_('Links: %s') % (', '.join(links) or '—'))
            acts.append(('add', '➕ Add files or links'))
            if files:
                acts.append(('rmfile', '🗑️ Remove a file'))
            if links:
                acts.append(('rmlink', '🔗 Remove a link'))
            acts.append(('del', '❌ Delete this update' if kind == 'p' else '❌ Delete this manual'))
        acts.append(('back', BACK))
        d = {'at': 'entry', 'kind': kind, 'id': rid, 'acts': [a for a, _l in acts]}
        return self._fask(message, state, d, '\n'.join(lines).strip(), [l for _a, l in acts])

    def _fl_entry(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        act, kind, rid = d['acts'][i], d['kind'], d['id']
        rec = self._entry_rec(kind, rid, user)
        if act == 'back' or not rec:
            return self._mine_begin(message, state, user, task)
        if act == 'text':
            d.update({'at': 'entry_text'})
            self._fsave(state, d)
            self._text(message, _('Send the new text. It replaces the current one. (Type cancel to stop.)'))
            return True
        if act == 'add':
            return self._upd_begin(message, state, user, task,
                                   mode='add_progress' if kind == 'p' else 'add_manual', target=rid)
        if act == 'rmfile':
            files = self._entry_files(kind, rec)[:9]
            d.update({'at': 'entry_file', 'files': [f for f, _n in files]})
            return self._fask(message, state, d, _('Which file should be removed?'),
                              ['📄 %s' % (n or _('file'))[:90] for _f, n in files] + [BACK])
        if act == 'rmlink':
            links = _links_of(rec.related_links)[:9]
            d.update({'at': 'entry_link', 'links': links})
            return self._fask(message, state, d, _('Which link should be removed?'),
                              ['🔗 %s' % u[:90] for u in links] + [BACK])
        if act == 'del':
            d.update({'at': 'entry_del'})
            what = {'p': _('this update'), 'm': _('this user manual'), 'g': _('this GitHub link')}[kind]
            return self._fask(message, state, d, _('Delete %s? This cannot be undone.') % what,
                              ['🗑️ Yes, delete it', '↩️ No, keep it'])
        return False

    def _fl_entry_text(self, message, state, user, d, task, tapped, low, body):
        text = (body or '').strip()
        rec = self._entry_rec(d['kind'], d['id'], user)
        if not rec:
            return self._mine_begin(message, state, user, task)
        if not text:
            self._text(message, _('Summary cannot be empty.'))
            return True
        if d['kind'] == 'p':
            if (rec.summary or '') != text:
                rec.write({'summary': text, 'edited_at': fields.Datetime.now()})
        else:
            rec.write({'description': text})
        return self._entry_show(message, state, user, task, d['kind'], d['id'], note=_('✏️ Text updated.'))

    def _fl_entry_file(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        rec = self._entry_rec(d['kind'], d['id'], user)
        if i >= len(d['files']) or not rec:
            return self._entry_show(message, state, user, task, d['kind'], d['id'])
        name = d['opts'][i][2:].strip()
        res = self._remove_file('progress' if d['kind'] == 'p' else 'manual', rec, d['files'][i])
        if res == 'deleted':
            return self._mine_begin(message, state, user, task, note=_(
                '🗑️ %s removed. The manual had no other file, so it was deleted.') % name)
        return self._entry_show(message, state, user, task, d['kind'], d['id'],
                                note=_('🗑️ %s removed.') % name)

    def _fl_entry_link(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        rec = self._entry_rec(d['kind'], d['id'], user)
        if i >= len(d['links']) or not rec:
            return self._entry_show(message, state, user, task, d['kind'], d['id'])
        gone = d['links'][i]
        keep = [u for u in _links_of(rec.related_links) if u != gone]
        vals = {'related_links': json.dumps(keep)}
        if d['kind'] == 'p':
            vals['edited_at'] = fields.Datetime.now()
        rec.write(vals)
        return self._entry_show(message, state, user, task, d['kind'], d['id'],
                                note=_('🔗 Link removed.'))

    def _fl_entry_del(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        rec = self._entry_rec(d['kind'], d['id'], user)
        if i != 0 or not rec:
            return self._entry_show(message, state, user, task, d['kind'], d['id'])
        rec.unlink()
        return self._mine_begin(message, state, user, task, note=_('🗑️ Deleted.'))

    # ================================================================== #
    # Task details                                                        #
    # ================================================================== #
    def _info_show(self, message, state, user, task, then_menu=True):
        labels = dict(task._fields['task_state'].selection)
        prio = dict(task._fields['priority'].selection or []).get(task.priority, task.priority or '—')
        path, cur = [], task.kra_id
        while cur:
            path.insert(0, cur.name or '')
            cur = cur.parent_id
        spent = task.timer_total_seconds or 0
        if task.timer_start_datetime:
            spent += max(0, (fields.Datetime.now() - task.timer_start_datetime).total_seconds())
        status = labels.get(task.task_state, '')
        if task.task_state == 'paused' and task.paused_reason:
            status += ' — %s' % task.paused_reason
        lines = [
            '📋 %s — %s' % (self._ref(task), task.name or ''),
            _('Project: %s') % (' › '.join(path) or '—'),
            _('Status: %s · Priority: %s') % (status, prio),
            _('Deadline: %s') % (task.deadline.strftime('%d %b %Y') if task.deadline else '—'),
            _('Estimate: %02d:%02d · Time spent: %s') % (task.estimate_hours, task.estimate_minutes, _hm(spent)),
        ]
        if task.estimate_extend_reason:
            lines.append(_('Time added: %s') % task.estimate_extend_reason)
        if (task.description or '').strip():
            desc = task.description.strip()
            lines += ['', _('Description:'), desc[:500] + ('…' if len(desc) > 500 else '')]
        Progress = self.env['kpi.progress'].sudo()
        ups = Progress.search([('kpi_id', '=', task.id)], order='create_date desc')
        files = self._task_files(task, user)
        gh = self.env['kpi.github.link'].sudo().search([('kpi_id', '=', task.id)])
        manuals = self.env['kpi.user.manual'].sudo().search_count([('kpi_id', '=', task.id)])
        lines += ['', _('Updates: %d · Files: %d · User manuals: %d') % (len(ups), len(files), manuals)]
        for p in ups[:3]:
            lines.append('• %s, %s: %s' % (self._when(user, p.create_date), p.employee_name or p.user_id.name or '',
                                           ' '.join((p.summary or '').split())[:120]))
        for g in gh[:5]:
            lines.append('🐙 %s (%s)' % (g.github_url, g.branch_name or ''))
        if task.task_state == 'partially_completed':
            ticks = [l for k, l in CHECKLIST if task['employee_checklist_%s' % {
                'verify_github': 'github', 'deployed_task': 'deployed', 'user_manual': 'manual',
                'documentation': 'docs', 'tested_code': 'tested'}[k]]]
            lines += ['', _('Your checklist: %s') % (', '.join(ticks) or '—')]
        self._text(message, '\n'.join(lines))
        if not then_menu:
            return True
        return self._back_to_task(message, state, task)

    def _kpi_details(self, message, state, user, task):
        """📋 KPI details: the details first, then a poll with Completed and
        the update rows (Add update, My updates & files, Add user manual)."""
        self._info_show(message, state, user, task, then_menu=False)
        rows = _kpi_actions_for(task)
        if not rows:
            return self._back_to_task(message, state, task)
        d = {'at': 'kpi_menu', 'codes': [c for c, _l in rows] + ['back']}
        return self._fask(message, state, d, _('📋 %s — what next?') % self._ref(task),
                          [l for _c, l in rows] + [BACK])

    def _fl_kpi_menu(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        code = (d.get('codes') or ['back'])[i] if i < len(d.get('codes') or []) else 'back'
        if code == 'back':
            return self._back_to_task(message, state, task)
        return self._staff_begin(message, state, user, task, code)

    # ================================================================== #
    # Start with guidelines / resume with a reason / switch / undo start #
    # ================================================================== #
    def _guidelines_begin(self, message, state, user, task):
        """The board's Start dialog: the task's guidelines, then agree."""
        g = (task.guidelines or '').strip()
        q = _('📌 Guidelines for %s — %s\n\n%s\n\nAgree to start the task.') % (
            self._ref(task), task.name or '', g[:1500])
        return self._fask(message, state, {'at': 'guide'}, q, ['✅ I agree — start', CANCEL])

    def _fl_guide(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        if i == 0:
            return self._staff_run(message, state, user, task, 'start')
        return self._back_to_task(message, state, task)

    def _resume_reason_begin(self, message, state, user, task):
        self._fsave(state, {'at': 'resume_reason'})
        self._text(message, _('↩️ %s was sent back by an admin%s.\nWhat did you change? '
                              '(Required — type cancel to stop.)') % (
            self._ref(task), (': "%s"' % task.self_review_note) if task.self_review_note else ''))
        return True

    def _fl_resume_reason(self, message, state, user, d, task, tapped, low, body):
        """/kra_kpi/task/resume_with_reason, step for step."""
        reason = (body or '').strip()
        if not reason:
            self._text(message, _('Please say what you changed before resuming.'))
            return True
        if task.user_id and task.user_id.id != user.id and not self._is_admin(user):
            return self._back_to_task(message, state, task, _('Only the assigned developer can resume this task.'))
        rec = task.with_user(user).sudo()
        try:
            rec._snapshot_before_start()
            rec.write({'self_resume_note': reason, 'self_resume_by': user.name,
                       'self_needs_resume_reason': False})
            rec._arm_admin_accept_deadline(force=True)
            rec.resume_task()
        except Exception as exc:
            state._reset()
            self._text(message, _('%(ref)s: %(why)s') % {'ref': self._ref(task), 'why': str(exc).strip()[:300]})
            self._menu_again(message, state, user)
            return True
        state._reset()
        self._text(message, _('▶️ %(who)s is back on %(ref)s — changed: %(why)s') % {
            'who': user.name, 'ref': self._ref(task), 'why': reason})
        return True

    def _switch_to(self, message, state, user, task):
        """kra.kpi.switch_to_task: stop what runs, start this, in one step."""
        try:
            res = task.with_user(user).sudo().switch_to_task(from_kpi_id=None, note='')
        except Exception as exc:
            res = {'status': False, 'message': str(exc).strip()[:300]}
        state._reset()
        if not res or res.get('status') is False:
            self._text(message, _('%(ref)s: %(why)s') % {
                'ref': self._ref(task), 'why': (res or {}).get('message') or _('could not switch')})
            self._menu_again(message, state, user)
            return True
        self._text(message, _('🔀 %(who)s switched to %(ref)s.') % {'who': user.name, 'ref': self._ref(task)})
        return True

    def _undo_begin(self, message, state, user, task):
        q = _('↩️ Undo today\'s start of %s?\nIt goes back to how it was before today\'s first '
              'start, and today\'s time on it is removed.') % self._ref(task)
        return self._fask(message, state, {'at': 'undo'}, q, ['↩️ Yes, undo start', '❌ No, keep it'])

    def _fl_undo(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        if i != 0:
            return self._back_to_task(message, state, task)
        try:
            res = task.with_user(user).sudo().undo_today_start()
        except Exception as exc:
            res = {'status': False, 'message': str(exc).strip()[:300]}
        if not res or res.get('status') is False:
            return self._back_to_task(message, state, task, _('Could not undo: %s') % ((res or {}).get('message') or ''))
        state._reset()
        self._text(message, '↩️ ' + ((res or {}).get('message') or _('Start undone.')))
        return True

    # ================================================================== #
    # 📎 Get a file -- sent privately                                     #
    # ================================================================== #
    def _files_begin(self, message, state, user, task):
        files = self._task_files(task, user)[:9]
        if not files:
            return self._back_to_task(message, state, task, _('No files on %s yet.') % self._ref(task))
        d = {'at': 'files', 'files': [[f['kind'], f['entry'], f['att'], f['name']] for f in files]}
        return self._fask(message, state, d, _('📎 Which file? It is sent to you privately.'),
                          ['📄 %s' % (f['name'] or _('file'))[:90] for f in files] + [BACK])

    def _fl_files(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        files = d.get('files') or []
        if i >= len(files):
            return self._back_to_task(message, state, task)
        kind, entry_id, att_id, name = files[i]
        if att_id:
            a = self.env['kpi.file.attachment'].sudo().browse(att_id).exists()
            data, mime = (a.file, a.mimetype) if a else (False, '')
        else:
            model, field = (('kpi.progress', 'uploaded_file') if kind == 'progress'
                            else ('kpi.user.manual', 'manual_file'))
            e = self.env[model].sudo().browse(entry_id).exists()
            data, mime = (e[field], '') if e else (False, '')
        number = ''.join(ch for ch in (user.kpi_wa_number or '') if ch.isdigit())
        if not data:
            return self._back_to_task(message, state, task, _('That file is no longer there.'))
        if not number:
            return self._back_to_task(message, state, task, _(
                'I do not have your WhatsApp number — set your login mobile in Login Management.'))
        b64 = data.decode('ascii') if isinstance(data, bytes) else data
        mime = mime or mimetypes.guess_type(name or '')[0] or 'application/octet-stream'
        try:
            s = self._session(message).sudo()
            caption = '%s — %s' % (self._ref(task), name)
            if mime.startswith('image/'):
                s.send_image(number, b64, caption=caption)
            else:
                s.send_document(number, b64, name or 'file', caption=caption, mimetype=mime)
        except Exception as exc:
            _logger.warning('private file send failed: %s', exc)
            return self._back_to_task(message, state, task, _('Could not send the file: %s') % str(exc)[:150])
        return self._back_to_task(message, state, task, _('📩 %s sent to you privately.') % name)

    # ================================================================== #
    # 🧾 Logs -- the details page's log dropdown                          #
    # ================================================================== #
    LOG_KINDS = [
        ('pause', '⏸️ Pause log', ['pause', 'resume', 'start_undone']),
        ('heading', '✏️ Heading log', ['meta_updated', 'priority_changed']),
        ('time', '⏱️ Time log', ['estimate_extended', 'time_reduced']),
        ('reassign', '🔁 Reassignments', None),
    ]
    LOG_LABELS = {'meta_updated': 'Renamed', 'priority_changed': 'Priority changed',
                  'start_undone': 'Start undone', 'time_reduced': "Yesterday's time reduced",
                  'estimate_extended': 'Estimate extended'}

    def _logs_begin(self, message, state, user, task):
        return self._fask(message, state, {'at': 'logs'}, _('🧾 Which log for %s?') % self._ref(task),
                          [l for _k, l, _e in self.LOG_KINDS] + [BACK])

    def _fl_logs(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        if i >= len(self.LOG_KINDS):
            return self._back_to_task(message, state, task)
        key, label, events = self.LOG_KINDS[i]
        lines = ['%s — %s' % (label, self._ref(task))]
        if key == 'reassign':
            rows = self.env['kpi.reassignment.history'].sudo().search(
                [('kpi_id', '=', task.id)], order='reassignment_date desc', limit=10)
            for r in rows:
                lines.append('• %s · %s → %s · by %s%s' % (
                    self._when_short(user, r.reassignment_date), r.previous_assignee_name,
                    r.new_assignee_name, r.reassigned_by_name,
                    (' — "%s"' % r.reassignment_reason) if r.reassignment_reason else ''))
        else:
            rows = self.env['kpi.action.log'].sudo().search(
                [('kpi_id', '=', task.id), ('event', 'in', events)], order='id desc', limit=10)
            for r in rows:
                try:
                    p = json.loads(r.payload_json or '{}')
                except (TypeError, ValueError):
                    p = {}
                if not isinstance(p, dict):
                    p = {}
                if r.event == 'meta_updated':
                    detail = '"%s" → "%s"' % (p.get('name_from', ''), p.get('name_to', ''))
                elif p.get('from') is not None and p.get('to') is not None:
                    detail = '%s%s → %s' % (('%s: ' % p['date']) if p.get('date') else '', p['from'], p['to'])
                    if p.get('reason'):
                        detail += ' · "%s"' % p['reason']
                else:
                    detail = p.get('reason') or p.get('note') or ''
                lines.append('• %s · %s · %s%s' % (
                    self._when_short(user, r.create_date),
                    self.LOG_LABELS.get(r.event) or (r.event or '').replace('_', ' ').capitalize(),
                    r.actor_label or (r.actor_user_id.name or ''),
                    (' — %s' % detail) if detail else ''))
        if len(lines) == 1:
            lines.append(_('Nothing logged yet.'))
        self._text(message, '\n'.join(lines))
        return self._back_to_task(message, state, task)

    # ================================================================== #
    # ➕ Create my own task -- kra.kpi.self_create_task                    #
    # ================================================================== #
    C_TYPES = [('requirement', '✨ Requirement'), ('update', '🔧 Update'), ('bug', '🐞 Bug')]
    C_DELIV = [('module', '🧩 Module'), ('app', '📱 App'), ('exe', '💻 EXE')]
    C_PRIO = [('regular', '⚪ Regular'), ('important', '🟡 Important'), ('urgent', '🔴 Urgent')]

    def _create_begin(self, message, state, user):
        if not self.env['kra.kpi'].with_user(user)._actor_workday_open():
            state._reset()
            self._text(message, _('Start your workday before creating a task.'))
            return True
        self._fsave(state, {'at': 'c_name', 'c': {}}, staff_kpi_id=False)
        self._text(message, _('➕ New task — what is it? Type a short name. (Type cancel to stop.)'))
        return True

    def _fl_c_name(self, message, state, user, d, task, tapped, low, body):
        name = (body or '').strip()
        if not name:
            self._text(message, _('Task name is required.'))
            return True
        d['c'] = {'name': name[:200]}
        return self._c_proj_ask(message, state, user, d)

    def _kra_path(self, k):
        path, cur = [], k
        while cur:
            path.insert(0, cur.name or '')
            cur = cur.parent_id
        return ' › '.join(path)

    def _c_proj_ask(self, message, state, user, d, only=None, note=''):
        Kra = self.env['kra.master'].sudo()
        if only is None:
            # The projects this person works in first, then the rest.
            mine = self.env['kra.kpi'].sudo().search([('user_id', '=', user.id)], order='id desc',
                                                     limit=50).mapped('kra_id')
            rest = Kra.search([('id', 'not in', mine.ids)], order='name')
            only = (mine | rest)[:8]
        d['at'] = 'c_proj'
        d['proj_ids'] = only.ids
        q = ((note + '\n\n') if note else '') + _('📁 Which project? Tap one, or type part of its name.')
        return self._fask(message, state, d, q, ['📁 %s' % self._kra_path(k)[:90] for k in only] + [CANCEL])

    def _fl_c_proj(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low, allow_number=False)
        ids = d.get('proj_ids') or []
        if i is None:
            q = (body or '').strip()
            if not q:
                return False
            hits = self.env['kra.master'].sudo().search([('name', 'ilike', q)], limit=8)
            if len(hits) == 1:
                d['c']['kra_id'] = hits.id
                return self._c_type_ask(message, state, d)
            return self._c_proj_ask(message, state, user, d, only=hits if hits else None,
                                    note=_('No project matches "%s".') % q if not hits else '')
        if i >= len(ids):
            state._reset()
            self._text(message, _('Cancelled — no task created.'))
            return True
        d['c']['kra_id'] = ids[i]
        return self._c_type_ask(message, state, d)

    def _c_type_ask(self, message, state, d):
        d['at'] = 'c_type'
        return self._fask(message, state, d, _('What kind of task is it?'), [l for _c, l in self.C_TYPES])

    def _fl_c_type(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        d['c']['doc_type'] = self.C_TYPES[i][0]
        d['c']['deliv'] = []
        return self._c_deliv_ask(message, state, d)

    def _c_deliv_ask(self, message, state, d):
        """Module / App / EXE -- at least one, tick one at a time."""
        d['at'] = 'c_deliv'
        picked = d['c'].get('deliv') or []
        labels = dict(self.C_DELIV)
        opts = [l for c, l in self.C_DELIV if c not in picked]
        if picked:
            opts.append('➡️ Next')
        q = _('What does it deliver? Tick at least one type — Module, App or EXE.\nTicked: %s') % (
            ', '.join(labels[c] for c in picked) or _('nothing yet'))
        if len(opts) < 2:
            opts.append(CANCEL)
        return self._fask(message, state, d, q, opts)

    def _fl_c_deliv(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        label = d['opts'][i]
        if label == CANCEL:
            state._reset()
            self._text(message, _('Cancelled — no task created.'))
            return True
        if label.startswith('➡️'):
            d['at'] = 'c_prio'
            return self._fask(message, state, d, _('Priority?'), [l for _c, l in self.C_PRIO])
        code = {l: c for c, l in self.C_DELIV}.get(label)
        if code and code not in d['c']['deliv']:
            d['c']['deliv'].append(code)
        return self._c_deliv_ask(message, state, d)

    def _fl_c_prio(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        d['c']['priority'] = self.C_PRIO[i][0]
        d['at'] = 'c_est'
        return self._fask(message, state, d, _('⏱️ Estimate? Type it like *2h 30m*, or skip — the admin can '
                                               'set it when accepting.'), ['⏭️ Skip', CANCEL])

    def _fl_c_est(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low, allow_number=False)
        if i == 1:
            state._reset()
            self._text(message, _('Cancelled — no task created.'))
            return True
        h = m = 0
        if i != 0:
            mt = re.match(r'^\s*(?:(\d{1,3})\s*h\w*)?\s*(?:(\d{1,2})\s*m\w*)?\s*$', body or '', re.I)
            if not mt or not (mt.group(1) or mt.group(2)):
                self._text(message, _('Type it like *2h 30m* or *45m*, or tap Skip.'))
                return True
            h, m = int(mt.group(1) or 0), int(mt.group(2) or 0)
            if m > 59:
                self._text(message, _('Minutes must be 0–59.'))
                return True
        d['c']['est_h'], d['c']['est_m'] = h, m
        c = d['c']
        kra = self.env['kra.master'].sudo().browse(c.get('kra_id'))
        labels = dict(self.C_TYPES + self.C_DELIV + self.C_PRIO)
        q = _('➕ Create this task?\n\nName: %s\nProject: %s\nType: %s\nDelivers: %s\nPriority: %s\n'
              'Estimate: %s\n\nIt waits in Pending review until an admin accepts it.') % (
            c['name'], self._kra_path(kra), labels[c['doc_type']],
            ', '.join(labels[x] for x in c['deliv']), labels[c['priority']],
            ('%dh %02dm' % (h, m)) if (h or m) else _('not set'))
        d['at'] = 'c_confirm'
        return self._fask(message, state, d, q, ['✅ Create task', CANCEL])

    def _fl_c_confirm(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        if i != 0:
            state._reset()
            self._text(message, _('Cancelled — no task created.'))
            return True
        c = d['c']
        res = self.env['kra.kpi'].with_user(user).self_create_task({
            'name': c['name'], 'kra_id': c['kra_id'], 'doc_type': c['doc_type'],
            'deliverable_type': c['deliv'], 'priority': c['priority'],
            'estimate_hours': c.get('est_h') or 0, 'estimate_minutes': c.get('est_m') or 0,
        })
        state._reset()
        if not res or not res.get('status'):
            self._text(message, _('Could not create it: %s') % ((res or {}).get('message') or ''))
            return True
        self._text(message, _('✅ %(ref)s created — "%(name)s". It is in your Pending review lane; '
                              'you can start it now, and an admin will accept it.') % {
            'ref': res.get('external_ref') or '', 'name': c['name']})
        return True

    # ================================================================== #
    # Pause / resume my day, No tasks                                     #
    # ================================================================== #
    def _staff_day_control(self, message, state, user, choice):
        sess, is_open, _e = self._workday(user)
        state._reset()
        if not is_open or not sess:
            self._text(message, _('Your day is not open.'))
            return True
        S = sess.with_user(user).sudo()
        try:
            if choice == 'day_pause':
                res = S.action_pause_workday(note='')
                ok = _('⏸️ Your day is paused, %s. Running tasks were paused too. Tap ▶️ Resume my day '
                       'when you are back.') % (user.name or '')
            elif choice == 'day_resume':
                res = S.action_resume_workday()
                ok = _('▶️ Your day is running again, %s. Your tasks stay paused — resume the one you '
                       'are working on.') % (user.name or '')
            else:
                res = S._set_nontask_reason('no_tasks', note='')
                ok = _('🙅 Noted, %s — you have no tasks. The admins have been told.') % (user.name or '')
        except Exception as exc:
            res = {'status': False, 'message': str(exc).strip()[:200]}
        if isinstance(res, dict) and res.get('status') is False:
            self._text(message, _('Could not do that: %s') % (res.get('message') or ''))
        else:
            self._text(message, ok)
        return self._show_staff_menu(message, state, user)

    # ================================================================== #
    # Ask for more time                                                   #
    # ================================================================== #
    def _time_begin(self, message, state, user, task):
        """/kra_kpi/task/add_time."""
        if task.task_state in ESTIMATE_LOCKED_STATES:
            return self._back_to_task(message, state, task, _(
                "This task is with the client — its estimate is what they signed off "
                "against and can't be changed now."))
        if not (task.user_id.id == user.id or user.id in task.contributor_ids.ids or self._is_admin(user)):
            return self._back_to_task(message, state, task, _('You can only add time to your own tasks.'))
        self._fsave(state, {'at': 'time'})
        self._text(message, _(
            '⏱️ %s — estimate %02d:%02d.\nHow much more time, and why? Example:\n'
            '*2h 30m client asked for a new report*\nThe reason is shown on the task card. '
            '(Type cancel to stop.)') % (self._ref(task), task.estimate_hours, task.estimate_minutes))
        return True

    def _fl_time(self, message, state, user, d, task, tapped, low, body):
        m = re.match(r'^\s*(?:(\d{1,3})\s*h(?:ours?|rs?)?)?\s*(?:(\d{1,3})\s*m(?:in(?:ute)?s?)?)?\b'
                     r'\s*[-–:,]?\s*(.*)$', body or '', re.I | re.S)
        add_h = int(m.group(1) or 0) if m else 0
        add_m = int(m.group(2) or 0) if m else 0
        reason = (m.group(3) if m else '').strip()
        if add_h == 0 and add_m == 0:
            self._text(message, _('Add more than 0 minutes. Example: *1h 30m testing took longer*'))
            return True
        if not reason:
            self._text(message, _('Give a reason — it is shown on the task card. Example: '
                                  '*%s client changed the layout*') % (body or '').strip())
            return True
        before = '%02d:%02d' % (task.estimate_hours, task.estimate_minutes)
        total = task.estimate_hours * 60 + task.estimate_minutes + add_h * 60 + add_m
        task.sudo().write({
            'estimate_hours': total // 60, 'estimate_minutes': total % 60,
            'estimate_extend_reason': reason[:255],
            'estimate_extension_count': (task.estimate_extension_count or 0) + 1,
            'estimate_extended_by_id': user.id,
            'estimate_extended_at': fields.Datetime.now(),
        })
        after = '%02d:%02d' % (task.estimate_hours, task.estimate_minutes)
        self.env['kpi.action.log'].sudo().create({
            'kpi_id': task.id, 'event': 'estimate_extended', 'source': 'whatsapp',
            'actor_user_id': user.id, 'actor_label': user.name or user.login or '',
            'payload_json': json.dumps({'from': before, 'to': after, 'added_hours': add_h,
                                        'added_minutes': add_m, 'reason': reason}),
        })
        return self._back_to_task(message, state, task, _('⏱️ Estimate extended from %s to %s — %s') % (
            before, after, reason))

    # ================================================================== #
    # Pause, with the board's reasons                                     #
    # ================================================================== #
    def _pause_begin(self, message, state, user, task):
        return self._fask(message, state, {'at': 'pause_code'},
                          _('⏸️ Why are you pausing %s?') % self._ref(task),
                          [l for _c, l in PAUSE_CODES])

    def _fl_pause_code(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        code = PAUSE_CODES[i][0]
        if code == 'meeting':
            return self._meet_begin(message, state, user, purpose='pause')
        if code in ('other', 'urgent'):
            self._fsave(state, {'at': 'pause_note', 'code': code})
            self._text(message, _('Describe the issue — this note is sent to the owner / configured '
                                  'recipients.') if code == 'urgent'
                       else _("Please say what you're pausing for (short)."))
            return True
        return self._pause_apply(message, state, user, task, code, PAUSE_STORED[code], [])

    def _fl_pause_note(self, message, state, user, d, task, tapped, low, body):
        note = (body or '').strip()[:NOTE_MAX]
        if not note:
            self._text(message, _("Please say what you're pausing for."))
            return True
        return self._pause_apply(message, state, user, task, d.get('code') or 'other', note, [])

    def _pause_apply(self, message, state, user, task, code, note, meet_ids):
        ref = self._ref(task)
        try:
            task.with_user(user).sudo().pause_task(reason=note, reason_code=code,
                                                   meeting_with_ids=meet_ids or [])
        except Exception as exc:
            state._reset()
            self._text(message, _('%(ref)s: %(why)s') % {'ref': ref, 'why': str(exc).strip()[:300]})
            self._menu_again(message, state, user)
            return True
        state._reset()
        who = ''
        if meet_ids:
            who = _(' (with %s)') % ', '.join(self.env['res.users'].sudo().browse(meet_ids).mapped('name'))
        self._text(message, _('⏸️ %(ref)s paused — %(why)s%(who)s') % {'ref': ref, 'why': note, 'who': who})
        return True

    # ================================================================== #
    # Current status -- privately, to the person's own number             #
    # ================================================================== #
    def _status_text(self, user):
        """The KPI Actions live strip, in words (kpi.work.session.live_status)."""
        Session = self.env['kpi.work.session'].sudo()
        live = Session.live_status(user=user)
        now = fields.Datetime.now()

        def since(raw):
            if not raw:
                return 0
            dt = fields.Datetime.from_string(raw.rstrip('Z').replace('T', ' ')[:19])
            return max(0, (now - dt).total_seconds())

        def clock(raw):
            if not raw:
                return ''
            dt = fields.Datetime.from_string(raw.rstrip('Z').replace('T', ' ')[:19])
            return self._when(user, dt)[13:]

        lines = ['📍 %s — %s' % (user.name or '', self._when(user, now))]
        sess, is_open, ended = self._workday(user)
        Kpi = self.env['kra.kpi'].sudo()
        if not is_open:
            if ended:
                lines.append(_('🌙 Your day is finished.'))
            elif sess and sess.reverted:
                lines.append(_('🔁 Your day was reopened by %s%s — tap 🌅 Start my day to continue.') % (
                    sess.reverted_by_id.name or _('an admin'),
                    (' (%s)' % sess.revert_reason) if sess.revert_reason else ''))
            else:
                lines.append(_('🌅 Your day has not started.'))
            # Whatever is actually running is shown regardless of the day, so the
            # status can never contradict the board.
            for t in live.get('active_tasks') or []:
                k = Kpi.browse(t['id'])
                run = since(t.get('timer_start'))
                lines.append(_('▶️ Running: %s — %s · %s') % (self._ref(k), k.name or '', _hm(run)))
            return '\n'.join(lines)
        presence = since(live.get('login_raw')) - (live.get('paused_base') or 0) - since(live.get('paused_since'))
        productive = (live.get('productive_base') or 0) + sum(
            since(t.get('timer_start')) for t in live.get('active_tasks') or [])
        lines.append(_('Day open since %s · Presence %s · Productive %s') % (
            clock(live.get('login_raw')), _hm(max(0, presence)), _hm(productive)))
        if live.get('is_paused'):
            lines.append(_('⏸️ Workday paused since %s') % clock(live.get('paused_since')))
        for t in live.get('active_tasks') or []:
            k = Kpi.browse(t['id'])
            run = since(t.get('timer_start'))
            lines.append(_('▶️ Working on %s — %s\n    running %s · total %s') % (
                self._ref(k), k.name or '', _hm(run), _hm((t.get('timer_total_seconds') or 0) + run)))
        brk = live.get('active_break')
        if brk:
            line = _('%s since %s (%s)') % (brk.get('type_label') or '', clock(brk.get('start_raw')),
                                             _hm(since(brk.get('start_raw'))))
            if brk.get('source_task_id'):
                k = Kpi.browse(brk['source_task_id'])
                line += _(' — paused %s') % self._ref(k)
            if brk.get('reason_note'):
                line += ' · %s' % brk['reason_note']
            lines.append('☕ ' + line)
        nt = live.get('nontask')
        if nt:
            line = _('%s since %s (%s)') % (nt.get('reason_label') or '', clock(nt.get('start_raw')),
                                             _hm(since(nt.get('start_raw'))))
            if sess.nontask_note:
                line += ' · %s' % sess.nontask_note
            if sess.nontask_meeting_with_ids:
                line += _(' · with %s') % ', '.join(sess.nontask_meeting_with_ids.mapped('name'))
            lines.append('👥 ' + line)
        if not (live.get('active_tasks') or brk or nt or live.get('is_paused')):
            lines.append(_('○ Idle — nothing running.'))
        paused = Kpi.search([('user_id', '=', user.id), ('task_state', '=', 'paused')],
                            order='write_date desc', limit=5)
        if paused:
            lines += ['', _('Paused tasks:')]
            for k in paused:
                lines.append('⏸️ %s — %s%s' % (self._ref(k), k.name or '',
                                               (' · %s' % k.paused_reason) if k.paused_reason else ''))
        return '\n'.join(lines)

    def _staff_status(self, message, state, user):
        number = ''.join(ch for ch in (user.kpi_wa_number or '') if ch.isdigit())
        state._reset()
        if not number:
            self._text(message, _('%s, I do not have your WhatsApp number — set your login mobile in '
                                  'Login Management.') % (user.name or ''))
            return True
        try:
            s = self._session(message)
            s.sudo().send_message(number, self._status_text(user))
        except Exception as exc:
            _logger.warning('private status send failed: %s', exc)
            self._text(message, _('Could not send your status privately: %s') % str(exc)[:150])
            return True
        self._text(message, _('📩 %s, your current status is in your private chat.') % (user.name or ''))
        return True

    # ================================================================== #
    # 📅 Meeting -- one menu row, then: manager / client / developer / team #
    # ================================================================== #
    MEET_MENU = ['🧑‍💼 Meeting with manager', '🤝 Meeting with client',
                 '👨‍💻 Meeting with developer', '👥 Team meeting', BACK]

    def _meeting_menu(self, message, state, user):
        return self._fask(message, state, {'at': 'meet_menu'}, _('📅 Meeting with whom?'),
                          self.MEET_MENU)

    def _day_open_or_say(self, message, state, user):
        _s, is_open, _e = self._workday(user)
        if not is_open:
            state._reset()
            self._text(message, _('Start your day first — a meeting is recorded inside your workday.'))
        return is_open

    def _fl_meet_menu(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        if i == 0:
            # The existing request flow: pick the task, say what about, and it
            # goes to the manager (kpi.doubt kind meet_admin).
            state._touch(step='staff_menu', staff_action='meet_admin', staff_draft=False)
            return self._staff_offer_tasks(message, state, user, 'meet_admin')
        if i == 1:
            return self._meet_client_pick(message, state, user)
        if i == 2:
            if not self._day_open_or_say(message, state, user):
                return True
            return self._meet_begin(message, state, user, purpose='nontask', devs_only=True)
        if i == 3:
            if not self._day_open_or_say(message, state, user):
                return True
            return self._meet_done(message, state, user, None, 'nontask', [], TEAM_MEETING_LABEL)
        state._reset()
        return self._show_staff_menu(message, state, user)

    def _client_tasks(self, user):
        """{client: tasks} over this person's open tasks. A client meeting is
        always ABOUT a task (kpi.doubt needs one), so the clients offered are
        the ones they have work for."""
        out = {}
        for t in self._my_tasks(user):
            c = t.client_kra_id
            if not c:
                c = t.kra_id
                while c and c.parent_id:
                    c = c.parent_id
            if c:
                out.setdefault(c, self.env['kra.kpi'])
                out[c] |= t
        return out

    def _meet_client_pick(self, message, state, user):
        groups = self._client_tasks(user)
        if not groups:
            state._reset()
            self._text(message, _('You have no open task for any client, so there is nothing to '
                                  'meet a client about yet.'))
            return True
        clients = sorted(groups, key=lambda c: (c.name or '').lower())[:9]
        if len(clients) == 1:
            return self._meet_client_tasks(message, state, user, groups[clients[0]])
        d = {'at': 'meet_client', 'ids': [c.id for c in clients]}
        return self._fask(message, state, d, _('🤝 Which client?'),
                          ['🏢 %s' % (c.name or '')[:80] for c in clients] + [BACK])

    def _fl_meet_client(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        ids = d.get('ids') or []
        if i >= len(ids):
            return self._meeting_menu(message, state, user)
        groups = self._client_tasks(user)
        client = self.env['kra.master'].sudo().browse(ids[i])
        tasks = groups.get(client) or self.env['kra.kpi']
        if not tasks:
            state._reset()
            self._text(message, _('You have no open task for %s.') % (client.name or ''))
            return True
        return self._meet_client_tasks(message, state, user, tasks)

    def _meet_client_tasks(self, message, state, user, tasks):
        """Then the existing client-meeting flow, on that client's tasks only."""
        if len(tasks) == 1:
            state._touch(staff_action='meet_client', staff_draft=False)
            return self._staff_begin(message, state, user, tasks[0], 'meet_client')
        labels = dict(tasks._fields['task_state'].selection)
        opts = ['%s — %s · %s' % (self._ref(t), (t.name or '')[:30], labels.get(t.task_state, t.task_state))
                for t in tasks[:10]]
        state._touch(step='staff_pick_task', staff_action='meet_client', staff_draft=False,
                     menu_csv=','.join(str(t.id) for t in tasks[:10]))
        self._poll(message, _('Which task is the client meeting about?'), opts)
        return True

    # ================================================================== #
    # Meeting: who it is with, and what about                             #
    # ================================================================== #
    def _people(self, user, devs_only=False):
        """/kra_kpi/get_people: everyone a meeting can be with."""
        people = self.env['res.users'].sudo().search([
            ('active', '=', True), ('share', '=', False), ('id', '!=', 1),
            ('id', '!=', user.id)]).sorted('name')
        if devs_only:
            people = people.filtered(lambda u: u.has_group('kra_kpi_module.group_kra_developer'))
        return people

    def _meet_begin(self, message, state, user, purpose, picked=None, page=0, only=None, note='',
                    devs_only=False):
        picked = list(picked or [])
        people = self._people(user, devs_only)
        rest = only if only is not None else people.filtered(lambda u: u.id not in picked)
        pages = max(1, (len(rest) + PEOPLE_PAGE - 1) // PEOPLE_PAGE)
        page = page % pages
        chunk = rest[page * PEOPLE_PAGE:(page + 1) * PEOPLE_PAGE]
        names = self.env['res.users'].sudo().browse(picked).mapped('name')
        # devs_only = "Meeting with developer": developers only, at least one,
        # and no Team row (Team meeting is its own choice in the Meeting menu).
        if devs_only:
            q = _('👨‍💻 Which developer? Tap each one (or type a name), then Done.\n\nPicked: %s')
        else:
            q = _('👥 Who is the meeting with? Tap each person (or type a name), then Done.\n'
                  'Or pick Team meeting — the whole team, no names or note needed.\n\nPicked: %s')
        q = ((note + '\n\n') if note else '') + q % (', '.join(names) or _('nobody yet'))
        opts, kinds = [], []
        if not devs_only:
            opts.append('👥 Team meeting'); kinds.append('team')
        for u in chunk:
            opts.append('👤 %s' % (u.name or '')[:60]); kinds.append('u%d' % u.id)
        if pages > 1 and only is None:
            opts.append('➡️ More people'); kinds.append('more')
        if picked:
            opts.append(_('✅ Done — %d picked') % len(picked)); kinds.append('done')
        elif not devs_only:
            opts.append('⏭️ Nobody to name'); kinds.append('done')
        if len(opts) < 2:
            opts.append(BACK); kinds.append('back')
        d = {'at': 'meet_who', 'purpose': purpose, 'picked': picked, 'page': page,
             'kinds': kinds, 'devs_only': devs_only}
        return self._fask(message, state, d, q, opts)

    def _fl_meet_who(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low, allow_number=False)
        picked, purpose = d.get('picked') or [], d.get('purpose')
        devs_only = bool(d.get('devs_only'))
        if i is None:
            q = (body or '').strip().lower()
            if not q:
                return False
            hits = self._people(user, devs_only).filtered(
                lambda u: q in (u.name or '').lower() and u.id not in picked)
            if not hits:
                return self._meet_begin(message, state, user, purpose, picked, d.get('page', 0),
                                        note=_('No one matches "%s".') % body.strip(), devs_only=devs_only)
            if len(hits) == 1:
                return self._meet_begin(message, state, user, purpose, picked + hits.ids, 0,
                                        note=_('Added %s.') % hits.name, devs_only=devs_only)
            return self._meet_begin(message, state, user, purpose, picked, 0, only=hits[:PEOPLE_PAGE],
                                    devs_only=devs_only)
        kind = (d.get('kinds') or [])[i] if i < len(d.get('kinds') or []) else ''
        if kind == 'team':
            return self._meet_done(message, state, user, task, purpose, [], TEAM_MEETING_LABEL)
        if kind == 'more':
            return self._meet_begin(message, state, user, purpose, picked, d.get('page', 0) + 1,
                                    devs_only=devs_only)
        if kind == 'back':
            return self._meeting_menu(message, state, user)
        if kind == 'done':
            self._fsave(state, {'at': 'meet_note', 'purpose': purpose, 'picked': picked})
            self._text(message, _('What is the meeting about? Short — e.g. sprint planning.'))
            return True
        if kind.startswith('u'):
            return self._meet_begin(message, state, user, purpose, picked + [int(kind[1:])],
                                    d.get('page', 0), devs_only=devs_only)
        return False

    def _fl_meet_note(self, message, state, user, d, task, tapped, low, body):
        note = (body or '').strip()[:NOTE_MAX]
        if not note:
            self._text(message, _('Please say what the meeting is about.'))
            return True
        return self._meet_done(message, state, user, task, d.get('purpose'), d.get('picked') or [], note)

    def _meet_done(self, message, state, user, task, purpose, picked, note):
        if purpose == 'pause':
            return self._pause_apply(message, state, user, task, 'meeting', note, picked)
        # 📅 Meeting while a task is running: pause it with reason Meeting, as the
        # board's pause does (pause_all_running -- every running timer, one shared
        # reason, the attendees on the break). Nothing running: record the
        # meeting as non-task time instead.
        Log = self.env['kpi.time.log'].sudo()
        running = Log.search([('user_id', '=', user.id), ('is_active', '=', True)]).mapped('kpi_id').filtered(
            lambda k: k.task_state == 'in_progress')
        if running:
            try:
                res = self.env['kra.kpi'].sudo().with_user(user).pause_all_running(
                    reason=note, reason_code='meeting', meeting_with_ids=picked or [])
            except Exception as exc:
                res = {'status': False, 'message': str(exc).strip()[:200]}
            state._reset()
            if not res or res.get('status') is False:
                self._text(message, _('Could not pause for the meeting: %s') % ((res or {}).get('message') or ''))
                self._menu_again(message, state, user)
                return True
            who = ''
            if picked:
                who = _(' with %s') % ', '.join(self.env['res.users'].sudo().browse(picked).mapped('name'))
            self._text(message, _('👥 Meeting%(who)s — %(note)s.\n⏸️ Paused %(tasks)s. Tap *Resume* on it '
                                  'when you are back.') % {
                'who': who, 'note': note, 'tasks': ', '.join(self._ref(k) for k in running)})
            return True
        # "In a meeting" from the menu: the same _set_nontask_reason the board's
        # idle dialog uses, with the attendees.
        try:
            Session = self.env['kpi.work.session'].sudo()
            sess = Session.with_user(user).sudo()._get_or_open_today(user=user)
            sess.with_user(user).sudo()._set_nontask_reason('meeting', note=note,
                                                            meeting_with_ids=picked)
        except Exception as exc:
            state._reset()
            self._text(message, _('Could not record that: %s') % str(exc).strip()[:200])
            return True
        state._reset()
        who = ''
        if picked:
            who = _(' with %s') % ', '.join(self.env['res.users'].sudo().browse(picked).mapped('name'))
        self._text(message, _('👥 Meeting noted%(who)s — %(note)s. Tap *Back to work* afterwards.') % {
            'who': who, 'note': note})
        return True
