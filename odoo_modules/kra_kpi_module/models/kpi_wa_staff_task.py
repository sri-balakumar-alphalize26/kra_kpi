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
import secrets
from datetime import timedelta
from types import SimpleNamespace
import logging
import mimetypes
import os
import re
from hmac import compare_digest as hmac_compare
from urllib.parse import urlparse

import pytz

from odoo import _, fields, models

from .kpi_wa_group_intake import _strip_emoji
from .kpi_wa_staff_menu import (ESTIMATE_LOCKED_STATES, STAFF_BY_ID, STAFF_CREATE_LABEL, STARTED_STATES,
                                _kpi_actions_for, _switch_targets)

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
    ('break', '☕ Break'),
    ('lunch', '🍽️ Lunch'),
    ('priority_task', '🔀 Moved to another task'),
    # Meeting asks who it is with next (_fl_pause_meet): developer / team /
    # manager pause now; a client meeting is booked for later and does not.
    ('meeting', '👥 Meeting'),
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
# These ask for a typed reason before pausing; Break, Lunch, Moved to another
# task and Day End pause at once (their label is the reason).
PAUSE_NOTE_CODES = ('awaiting_approval', 'technical_issue', 'leave', 'other', 'urgent')

# A link inside a message: with a scheme, starting www., or a bare domain
# followed by a path (github.com/org/repo). A bare "file.pdf" is not a link.
_URL_RE = re.compile(r'(?:https?://|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/\S*', re.I)

HOME = '🏠 Main menu'
SAVE_UPDATE = '✅ Save update'
SAVE_MANUAL = '✅ Save manual'
SAVE_CHANGES = '✅ Save changes'
CANCEL = '❌ Cancel'
BACK = '↩️ Back'
PEOPLE_PAGE = 5          # leaves room for Team · More · Done · Back · 🏠 Main menu


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

    # Steps one level below the main menu already go there with ↩️ Back, and
    # the typing steps (an update being collected) have their own Cancel; every
    # other poll gets 🏠 Main menu as its last row.
    NO_HOME_STEPS = ('mt_phase', 'meet_menu', 'day_pausemenu', 'collect', 'branch', 'dupfile')

    def _fask(self, message, state, d, question, options):
        """Send a poll and remember exactly what it offered."""
        options = list(options)
        if d.get('at') not in self.NO_HOME_STEPS and len(options) < 10:
            options.append(HOME)
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
            'done_mode': self._fl_done_mode,
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
            'mt_phase': self._fl_mt_phase, 'mt_lane': self._fl_mt_lane, 'mt_task': self._fl_mt_task,
            'mt_search': self._fl_mt_search, 'mt_filter': self._fl_mt_filter, 'mt_proj': self._fl_mt_proj,
            'pause_meet': self._fl_pause_meet, 'day_pausemenu': self._fl_day_pausemenu,
            'switch_pick': self._fl_switch_pick, 'switch_search': self._fl_switch_search,
            'pause_which': self._fl_pause_which, 'switch_from_which': self._fl_switch_from_which,
            'day_pick': self._fl_day_pick,
            # A long list of tasks / clients / projects, paged (_pick_list).
            'lp': self._fl_lp, 'lp_search': self._fl_lp_search,
            # Smart typing's ✅ Yes / ❌ No and "what next" polls (kpi_wa_smart).
            'smart_pick': self._fl_smart_pick,
            # 💬 Reply to client (kpi_chat.py).
            'client_reply': self._fl_client_reply, 'client_reply_confirm': self._fl_client_reply_confirm,
        }.get(at)
        if not handler:
            state._reset()
            return False
        task = state.staff_kpi_id
        needs_task = not (at in ('meet_menu', 'meet_client', 'day_pausemenu', 'pause_which', 'day_pick',
                                 'smart_pick', 'lp', 'lp_search')
                          or (at or '').startswith('mt_')
                          or (at in ('pause_code', 'pause_note', 'pause_meet') and d.get('all'))
                          or (at in ('meet_who', 'meet_note') and d.get('purpose') in ('nontask', 'pauseall')))
        if needs_task and (not task or not task.exists()):
            state._reset()
            return False
        # 🏠 Main menu from any deep poll: straight back to the first one.
        if _strip_emoji(tapped) == _strip_emoji(HOME) and HOME in (d.get('opts') or []):
            self._tmp_clear(state)
            state._reset()
            return self._show_staff_menu(message, state, user)
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
    # Shared with the 📋 KPI details web page (controllers/kpi_wa_task_page) #
    # -- the same checks as the poll flow above, for one submitted form.   #
    # ================================================================== #
    def _page_files(self, task, user, files, replace_same, manual=False):
        """files: [(name, raw, mime)] -> (attachments-like list, replace list, error)."""
        on_task = self._task_files(task, user)
        taken = {(f['name'] or '').lower() for f in on_task}
        out, replace = [], []
        for name, raw, mime in files:
            if not raw:
                continue
            if manual:
                if not name.lower().endswith(MANUAL_EXTENSIONS):
                    return None, None, '"%s": only PDF, DOC and DOCX files can be uploaded as a manual.' % name
                if len(raw) > MANUAL_MAX_BYTES:
                    return None, None, '"%s" exceeds the 25 MB limit.' % name
            elif len(raw) > PROGRESS_MAX_BYTES:
                return None, None, ('"%s" is %.1f MB — over the 50 MB limit. Add a Drive or GitHub link '
                                    'instead.' % (name, len(raw) / 1048576.0))
            lower = name.lower()
            old = next((f for f in on_task if (f['name'] or '').lower() == lower), None) \
                or next((f for f in on_task if _file_key(f['name']) == _file_key(name)), None)
            if old and replace_same and old['can'] and \
                    (old['kind'], old['entry'], old['att']) not in {(r['kind'], r['entry'], r['att']) for r in replace}:
                replace.append({'kind': old['kind'], 'entry': old['entry'], 'att': old['att']})
            elif lower in taken:
                name = _free_name(name, taken)
            taken.add(name.lower())
            out.append(SimpleNamespace(name=name, datas=base64.b64encode(raw),
                                       mimetype=mime or mimetypes.guess_type(name)[0] or 'application/octet-stream'))
        return out, replace, ''

    def _page_links(self, task, raw_links):
        links, d = [], {'links': []}
        for tok in re.split(r'[\s,]+', raw_links or ''):
            if not tok.strip():
                continue
            url = _norm_url(tok)
            if not url:
                return None, '"%s" is not a valid link (e.g. https://example.com).' % tok
            dup = self._link_dup(task, url, d)
            if dup:
                return None, dup
            d['links'].append(url)
            links.append(url)
        return links, ''

    def page_save(self, user, task, kind, summary='', raw_links='', gh_url='', gh_branch='',
                  files=None, replace_same=False, finishing=False):
        """Add an update ('progress') or a user manual ('manual') from the page.
        Returns (ok, message).

        `finishing`: saved as part of ✅ Completed / Partial finish (page_complete),
        which has already checked the state -- a task sent back (rework) or on
        hold is finished from there too, so it is not refused here."""
        locked = task._details_locked_for(user)
        if locked:
            return False, locked
        if not finishing and task.task_state not in STARTED_STATES:
            return False, ('Start %s first — updates, files, manuals and GitHub links are added once '
                           'a task has been started.' % self._ref(task))
        summary = (summary or '').strip()
        if kind == 'progress' and not summary:
            return False, 'Describe what you did before submitting — this is what your manager reads.'
        links, err = self._page_links(task, raw_links)
        if err:
            return False, err
        gh = []
        if kind == 'progress' and (gh_url or '').strip():
            url = _norm_url(gh_url)
            if not url or not re.match(r'^https?://(www\.)?github\.com/.+', url, re.I):
                return False, 'Please enter a valid GitHub URL (must start with https://github.com/).'
            if not (gh_branch or '').strip() or ' ' in gh_branch.strip():
                return False, 'Please enter a branch name.'
            d = {'gh': []}
            note = self._add_github(d, task, url, gh_branch.strip())
            if not d['gh']:
                return False, note.lstrip('⚠ ')
            gh = d['gh']
        atts, replace, err = self._page_files(task, user, files or [], replace_same, manual=(kind == 'manual'))
        if err:
            return False, err
        if kind == 'manual' and not atts:
            return False, 'A file is required — the manual (PDF, DOC or DOCX).'
        env_u = self.env(user=user.id, su=True)
        try:
            with self.env.cr.savepoint():
                if kind == 'progress':
                    rec = env_u['kpi.progress'].create({
                        'kpi_id': task.id, 'summary': summary, 'user_id': user.id,
                        'related_links': json.dumps(links)})
                    self._attach(rec, 'uploaded_file', atts)
                else:
                    rec = env_u['kpi.user.manual'].create({
                        'kpi_id': task.id, 'description': summary, 'related_links': json.dumps(links),
                        'uploaded_by': user.id, 'upload_date': fields.Datetime.now()})
                    self._attach(rec, 'manual_file', atts)
                for g in gh:
                    env_u['kpi.github.link'].create({'kpi_id': task.id, 'github_url': g['url'],
                                                     'branch_name': g['branch'], 'user_id': user.id})
                for r in replace:
                    model = 'kpi.progress' if r['kind'] == 'progress' else 'kpi.user.manual'
                    entry = self.env[model].sudo().browse(r['entry']).exists()
                    if entry:
                        self._remove_file(r['kind'], entry, r['att'])
        except Exception as exc:
            _logger.exception('page save failed')
            return False, 'Could not save: %s' % str(exc)[:200]
        bits = [p for p in (
            'summary' if summary and kind == 'progress' else ('description' if summary else ''),
            ('%d link(s)' % len(links)) if links else '', ('%d file(s)' % len(atts)) if atts else '',
            ('GitHub (%s)' % gh[0]['branch']) if gh else '') if p]
        what = 'Update saved' if kind == 'progress' else 'User manual saved'
        return True, '%s — %s.' % (what, ', '.join(bits) or 'saved')

    PAGE_KINDS = {'progress': 'p', 'manual': 'm', 'github': 'g'}

    def page_entry(self, user, task, kind, entry_id):
        """The page's Edit / Delete target: (record, error). Own entry or an admin
        (_entry_rec, the chat flow's rule), on THIS task, once it has started."""
        locked = task._details_locked_for(user)
        if locked:
            return None, locked
        if task.task_state not in STARTED_STATES:
            return None, ('Start %s first — what was added can be changed once the task has started.'
                          % self._ref(task))
        code = self.PAGE_KINDS.get(kind)
        if not code:
            return None, 'Unknown item.'
        try:
            rid = int(entry_id or 0)
        except (TypeError, ValueError):
            rid = 0
        model = {'p': 'kpi.progress', 'm': 'kpi.user.manual', 'g': 'kpi.github.link'}[code]
        raw = self.env[model].sudo().browse(rid).exists()
        if not raw or raw.kpi_id != task:
            return None, 'That item is no longer on this task.'
        rec = self._entry_rec(code, rid, user)
        if not rec:
            return None, 'Only the person who added it, or an admin, can change it.'
        return rec, ''

    def page_edit(self, user, task, kind, entry_id, summary=None, raw_links=None, remove=None,
                  files=None, replace_same=False):
        """Edit an update / manual from the page, as the board's /kpi/progress/update
        and /kpi/file/remove do: only what was sent is written, an update's text
        can't be emptied, "Edited" is stamped only on a real change, and a manual
        left with no file is removed (board rule). All or nothing. (ok, message)."""
        rec, err = self.page_entry(user, task, kind, entry_id)
        if err:
            return False, err
        if kind == 'github':
            return False, 'A GitHub link can only be deleted.'
        text_field = 'summary' if kind == 'progress' else 'description'
        vals, changed = {}, False
        if summary is not None:
            text = summary.strip()
            if kind == 'progress' and not text:
                return False, 'The update text cannot be empty.'
            if (rec[text_field] or '') != text:
                vals[text_field] = text
        if raw_links is not None:
            # The links box holds the entry's full list: what is left is what stays.
            keep, d = [], {'links': []}
            for tok in re.split(r'[\s,]+', raw_links or ''):
                if not tok.strip():
                    continue
                url = _norm_url(tok)
                if not url:
                    return False, '"%s" is not a valid link (e.g. https://example.com).' % tok
                if url not in keep:
                    keep.append(url)
            before = []
            try:
                before = [v.get('url') if isinstance(v, dict) else v for v in json.loads(rec.related_links or '[]')]
            except (TypeError, ValueError):
                pass
            new_links = [u for u in keep if u not in before]
            for url in new_links:                       # only NEW links are checked for duplicates
                dup = self._link_dup(task, url, d)
                if dup:
                    return False, dup
                d['links'].append(url)
            if keep != before:
                vals['related_links'] = json.dumps(keep)
        atts, replace, ferr = self._page_files(task, user, files or [], replace_same, manual=(kind == 'manual'))
        if ferr:
            return False, ferr
        removed = [int(x) for x in (remove or []) if str(x).lstrip('-').isdigit()]
        own_atts = set(self.env['kpi.file.attachment'].sudo().search(
            [('progress_id' if kind == 'progress' else 'manual_id', '=', rec.id)]).ids)
        if any(a and a not in own_atts for a in removed):
            return False, 'That file is not on this entry.'
        deleted = False
        try:
            with self.env.cr.savepoint():
                if vals:
                    rec.sudo().write(vals)
                    changed = True
                # New files go on BEFORE anything is removed, so swapping a manual's
                # only file for another never empties (and so deletes) the manual.
                if atts:
                    self._attach(rec, 'uploaded_file' if kind == 'progress' else 'manual_file', atts)
                    changed = True
                # Attachment rows first, the entry's own file (0) last, so the
                # promotion in _remove_file never moves a file that is about to go.
                for a in sorted(removed, reverse=True):
                    if self._remove_file(kind, rec, a) == 'deleted':
                        deleted = True
                        break
                    changed = True
                if not deleted:
                    for r in replace:
                        model = 'kpi.progress' if r['kind'] == 'progress' else 'kpi.user.manual'
                        entry = self.env[model].sudo().browse(r['entry']).exists()
                        if entry and entry != rec:
                            self._remove_file(r['kind'], entry, r['att'])
                if changed and kind == 'progress' and not deleted:
                    rec.sudo().write({'edited_at': fields.Datetime.now()})
        except Exception as exc:
            _logger.exception('page edit failed')
            return False, 'Could not save: %s' % str(exc)[:200]
        if deleted:
            return True, 'The manual had no file left, so it was removed.'
        if not changed:
            return True, 'Nothing changed.'
        return True, ('Update saved.' if kind == 'progress' else 'User manual saved.')

    def page_delete(self, user, task, kind, entry_id):
        """Delete an update / manual / GitHub link from the page (own or admin). (ok, message)."""
        rec, err = self.page_entry(user, task, kind, entry_id)
        if err:
            return False, err
        try:
            rec.sudo().unlink()
        except Exception as exc:
            return False, 'Could not delete: %s' % str(exc)[:200]
        return True, {'progress': 'Update deleted.', 'manual': 'User manual deleted.',
                      'github': 'GitHub link deleted.'}[kind]

    def page_complete(self, user, task, ticks, partial=False, summary='', raw_links='',
                      gh_url='', gh_branch='', files=None, extra=None):
        """The page's Complete form: /kra_kpi/task/complete's rules, plus what
        the form brings with it -- a summary (with optional links / GitHub) and
        the user manual file(s).

        All or nothing: the summary and manual are saved, then the task is
        completed, inside ONE savepoint, so a refusal at any step leaves no
        half-saved update behind and the form can simply be sent again.
        Returns (ok, message)."""
        if task.task_state not in ('in_progress', 'paused', 'hold', 'rework'):
            return False, 'Only a running or paused task can be finished.'
        summary = (summary or '').strip()
        files = files or []
        if not summary and ((raw_links or '').strip() or (gh_url or '').strip()):
            return False, 'Write a summary to go with the links.'
        no_summary = not summary and not self.env['kpi.progress'].sudo().search_count([('kpi_id', '=', task.id), ('from_client', '=', False)])
        # Only the client's files on the task: say they don't count, not just "missing".
        client_only = no_summary and bool(self.env['kpi.progress'].sudo().search_count(
            [('kpi_id', '=', task.id), ('from_client', '=', True)]))
        summary_item = ("a summary of what you did (the client's files don't count)" if client_only
                        else 'a summary of what you did')
        if no_summary and task._is_db_task():
            no_summary = False                      # a database task: summary optional
        if partial and no_summary:
            return False, ("The client's files don't count as your summary — write what you did."
                           if client_only else 'Write a summary of what you did — this is what your manager reads.')
        checklist = {} if partial else {k: (k in ticks) for k, _l in CHECKLIST}
        # What the form brings for this task's type: app link, manual link,
        # website, database details (saved with the rest, inside the savepoint).
        extra = {k: (v or '').strip() for k, v in (extra or {}).items()}
        field_of = {'app_link': 'app_link', 'website_url': 'website_url', 'db_url': 'provision_url',
                    'db_name': 'provision_db_name', 'db_user': 'provision_username',
                    'db_password': 'provision_password'}
        if not partial:
            # Everything missing at once, so one reply says all of it (the same
            # list the page's "you still need" popup shows).
            missing = []
            if no_summary:
                missing.append(summary_item)
            if not files and not extra.get('user_manual_url') and task._manual_required_refusal():
                missing.append('the user manual (a PDF, DOC or DOCX file, or a link)')
            if not (gh_url or '').strip() and task._github_required_refusal():
                missing.append('the GitHub link + branch (this is a Module / App task)')
            # The rest this task's type asks for (app link, database details).
            for r in task._completion_rules():
                if (r['required'] and not r['done'] and r['key'] not in ('summary', 'manual', 'github')
                        and not extra.get(field_of.get(r['key'], ''))):
                    missing.append(r['label'])
            for f in ('app_link', 'user_manual_url', 'website_url', 'provision_url'):
                if extra.get(f) and not extra[f].lower().startswith(('http://', 'https://')):
                    return False, '%s must start with http:// or https://' % task._fields[f].string
            if missing:
                return False, ('Before completing, you still need: %s. Or use Partial finish to send a '
                               'summary only.' % '; '.join(missing))

        class _Refused(Exception):
            pass

        try:
            with self.env.cr.savepoint():
                vals = {k: v for k, v in extra.items() if v}
                if vals:
                    task.sudo().write(vals)
                if summary:
                    ok, msg = self.page_save(user, task, 'progress', summary, raw_links, gh_url, gh_branch,
                                             finishing=True)
                    if not ok:
                        raise _Refused(msg)
                if files:
                    ok, msg = self.page_save(user, task, 'manual', '', '', files=files, finishing=True)
                    if not ok:
                        raise _Refused(msg)
                if not partial:
                    refused = task._completion_refusal()
                    if refused:
                        raise _Refused(refused)
                    done = {r['key'] for r in task._completion_rules() if r['done']}
                    checklist.update(user_manual=checklist.get('user_manual') or 'manual' in done,
                                     verify_github=checklist.get('verify_github') or 'github' in done)
                task.with_user(user).sudo().with_context(
                    kpi_partial_finish=partial, kpi_finish_source='whatsapp').complete_task(employee_checklist=checklist)
        except _Refused as exc:
            return False, str(exc)
        except Exception as exc:
            return False, str(exc).strip()[:300]
        return True, ('Finished as a partial finish — the client is sent your summary.' if partial
                      else 'Finished — it is with a manager to check.')

    def log_rows(self, task, user, key):
        """One log, newest first, as text lines (📋 KPI details › Logs and the page)."""
        lines = []
        if key == 'reassign':
            for r in self.env['kpi.reassignment.history'].sudo().search(
                    [('kpi_id', '=', task.id)], order='reassignment_date desc', limit=20):
                lines.append('%s · %s → %s · by %s%s' % (
                    self._when_short(user, r.reassignment_date), r.previous_assignee_name,
                    r.new_assignee_name, r.reassigned_by_name,
                    (' — "%s"' % r.reassignment_reason) if r.reassignment_reason else ''))
            return lines
        events = dict((k, e) for k, _l, e in self.LOG_KINDS).get(key) or []
        for r in self.env['kpi.action.log'].sudo().search(
                [('kpi_id', '=', task.id), ('event', 'in', events)], order='id desc', limit=20):
            try:
                p = json.loads(r.payload_json or '{}')
            except (TypeError, ValueError):
                p = {}
            p = p if isinstance(p, dict) else {}
            if r.event == 'meta_updated':
                detail = '"%s" → "%s"' % (p.get('name_from', ''), p.get('name_to', ''))
            elif p.get('from') is not None and p.get('to') is not None:
                detail = '%s%s → %s' % (('%s: ' % p['date']) if p.get('date') else '', p['from'], p['to'])
                if p.get('reason'):
                    detail += ' · "%s"' % p['reason']
            else:
                detail = p.get('reason') or p.get('note') or ''
            lines.append('%s · %s · %s%s' % (
                self._when_short(user, r.create_date),
                self.LOG_LABELS.get(r.event) or (r.event or '').replace('_', ' ').capitalize(),
                r.actor_label or (r.actor_user_id.name or ''), (' — %s' % detail) if detail else ''))
        return lines

    # ================================================================== #
    # Completed                                                           #
    # ================================================================== #
    DONE_FULL = '✅ Completed'
    DONE_PARTIAL = '🏁 Partial finish — summary only'

    def _done_begin(self, message, state, user, task):
        """✅ Completed: first Completed or Partial finish, then the task page.

        Finishing happens on the page, not in the chat: it asks for what this
        task's type needs (Completed) or only the summary (Partial finish), and
        keeps the form filled on a mistake, which a poll cannot. The page opens
        with the choice already picked."""
        if task.task_state not in STARTED_STATES:
            return self._back_to_task(message, state, task, _(
                'Resume %s first — a task has to be started before it can be finished.')
                % self._ref(task))
        needed = ', '.join(r['label'] for r in task._completion_rules() if r['required']) \
            or _('nothing more')
        q = _('✅ Finish %(ref)s — %(name)s\n\n%(full)s — everything this task needs (%(needed)s).\n'
              '%(partial)s — only a summary; the client is sent it.') % {
            'ref': self._ref(task), 'name': task.name or '', 'full': self.DONE_FULL,
            'needed': needed, 'partial': self.DONE_PARTIAL}
        return self._fask(message, state, {'at': 'done_mode'}, q,
                          [self.DONE_FULL, self.DONE_PARTIAL, CANCEL])

    def _fl_done_mode(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        if i == 2:
            return self._back_to_task(message, state, task)
        state._reset()
        ref, who = self._ref(task), user.name or ''
        if i == 1:
            self._send_page_link(message, state, user, task, anchor='partial', group_note=_(
                '⏳ %(ref)s is not finished yet, %(who)s. Open the link in your private chat, write the '
                'summary, then tap *Send partial finish*.') % {'ref': ref, 'who': who})
            return True
        needed = ', '.join(r['label'] for r in task._completion_rules() if r['required']) \
            or _('nothing more')
        self._send_page_link(message, state, user, task, anchor='complete', group_note=_(
            '⏳ %(ref)s is not completed yet, %(who)s. Open the link in your private chat, fill in '
            'what this task needs (%(needed)s), then tap *Submit for approval*.') % {
            'ref': ref, 'who': who, 'needed': needed})
        return True

    # The in-chat finish below is no longer started (✅ Completed sends the page
    # link). It stays for polls sent before that change, which still land here.
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
        Progress = self.env['kpi.progress'].sudo()
        if not task._is_db_task() and not Progress.search_count(
                [('kpi_id', '=', task.id), ('from_client', '=', False)]):
            if Progress.search_count([('kpi_id', '=', task.id), ('from_client', '=', True)]):
                return self._back_to_task(message, state, task, _(
                    "The client's files don't count as your summary — add your own progress update "
                    "(what you did), then complete."))
            return self._back_to_task(message, state, task, _(
                'Please submit a Progress Summary before completing this task.'))
        checklist = {} if partial else {k: (k in ticked) for k, _l in CHECKLIST}
        if not partial and task._completion_missing():
            # A manual / GitHub link is added on the page: send them there.
            return self._done_begin(message, state, user, task)
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
            files = self._entry_files(kind, rec)[:8]
            d.update({'at': 'entry_file', 'files': [f for f, _n in files]})
            return self._fask(message, state, d, _('Which file should be removed?'),
                              ['📄 %s' % (n or _('file'))[:90] for _f, n in files] + [BACK])
        if act == 'rmlink':
            links = _links_of(rec.related_links)[:8]
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
    DOUBT_KIND = {'question': '❓', 'meet_admin': '📅', 'meet_client': '🤝', 'escalation': '🚨'}
    DOUBT_STATE = {'open': '⏳ waiting for the manager', 'answered': '✅ answered',
                   'released': '📤 sent to the client', 'client_replied': '💬 client replied',
                   'rejected': '✖️ declined', 'closed': '✔️ closed'}

    def _task_doubts(self, task, user):
        """The questions and meeting requests raised on this task, newest first,
        with the manager's answer -- what the web lists under the task (the
        WhatsApp group only ever saw each answer once). Plain dicts, for the
        chat and the task page alike."""
        out = []
        # Client messages live in the 💬 chat (kpi_chat.py), not here.
        for x in self.env['kpi.doubt'].sudo().search([('kpi_id', '=', task.id), ('kind', '!=', 'client_msg')],
                                                     order='id desc', limit=15):
            out.append({
                'icon': self.DOUBT_KIND.get(x.kind, '❓'),
                'question': ' '.join((x.question or '').split()),
                'asked_by': x.raised_by_id.name or '',
                'asked': self._when_short(user, x.create_date),
                'state': self.DOUBT_STATE.get(x.state, x.state or ''),
                'answer': ' '.join((x.answer or '').split()),
                'answered_by': x.answered_by_id.name or '',
                'answered': self._when_short(user, x.answered_at) if x.answered_at else '',
                'client_answer': ' '.join((x.client_answer or '').split()),
            })
        return out

    def _answers_show(self, message, state, user, task):
        """💬 Manager answers: every question on the task and how it was answered."""
        rows = self._task_doubts(task, user)
        if not rows:
            return self._back_to_task(message, state, task, _('No questions have been asked on %s yet.')
                                      % self._ref(task))
        lines = [_('💬 %s — questions to the manager') % self._ref(task)]
        for n, r in enumerate(rows, 1):
            lines.append('')
            lines.append('%d. %s "%s" — %s, %s' % (n, r['icon'], r['question'][:200], r['asked_by'], r['asked']))
            if r['answer']:
                lines.append('   → %s "%s" — %s%s' % (r['state'].split(' ')[0], r['answer'][:300], r['answered_by'],
                                                     (', %s' % r['answered']) if r['answered'] else ''))
            else:
                lines.append('   → %s' % r['state'])
            if r['client_answer']:
                lines.append(_('   🧑‍💼 Client: "%s"') % r['client_answer'][:300])
        return self._back_to_task(message, state, task, '\n'.join(lines))

    # ================================================================== #
    # 💬 Reply to client -- the task's chat with the client (kpi_chat.py)  #
    # ================================================================== #
    def _client_reply_begin(self, message, state, user, task):
        locked = task._details_locked_for(user)
        if locked:
            return self._back_to_task(message, state, task, '🔒 ' + locked)
        lines = [_('💬 %s — chat with the client') % self._ref(task)]
        rows = task.chat_rows(viewer=user, limit=6)
        for r in rows:
            when = self._when_short(user, fields.Datetime.to_datetime(r['at']))
            who = r['who'] if r['side'] == 'client' else '%s (%s)' % (_('Team'), r['who'])
            lines.append('%s %s, %s:\n   %s' % ('🧑‍💼' if r['side'] == 'client' else '👥', who, when,
                                              ' '.join(r['text'].split())[:300]))
        if not rows:
            lines.append(_('No messages yet — yours will be the first.'))
        lines += ['', _('Type your message to the client. It reaches their group as "Reply from our team". '
                        '(Type cancel to stop.)')]
        self._fsave(state, {'at': 'client_reply'})
        self._text(message, '\n'.join(lines))
        return True

    def _fl_client_reply(self, message, state, user, d, task, tapped, low, body):
        text = (body or '').strip()
        if not text or text in _MEDIA_PLACEHOLDERS:
            self._text(message, _('Type the message as text (type cancel to stop).'))
            return True
        d = {'at': 'client_reply_confirm', 'text': text[:1000]}
        return self._fask(message, state, d, _('💬 %(ref)s — send this to the client?\n\n"%(text)s"') % {
            'ref': self._ref(task), 'text': text[:1000]},
            [_('✅ Send to client'), _('✏️ Retype'), CANCEL])

    def _fl_client_reply_confirm(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        if i == 1:
            return self._client_reply_begin(message, state, user, task)
        if i != 0:
            return self._back_to_task(message, state, task, _('Cancelled — nothing was sent.'))
        try:
            task.chat_post_team(d.get('text') or '', user, source='whatsapp')
        except Exception as exc:
            return self._back_to_task(message, state, task, _('Could not send: %s') % str(exc).strip()[:200])
        return self._back_to_task(message, state, task, _('📨 Sent to the client for %s.') % self._ref(task))

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
        doubts = self._task_doubts(task, user)
        if doubts:
            lines.append(_('💬 Questions to the manager: %(n)d · answered %(a)d — tap 💬 Manager answers') % {
                'n': len(doubts), 'a': len([x for x in doubts if x['answer']])})
        if task.task_state == 'partially_completed':
            # What this task's type needed, as sent for review.
            lines += ['', _('Sent with: %s') % (', '.join(
                '%s %s' % ('✓' if r['done'] else '✗', r['label'])
                for r in task._completion_rules() if r['required']) or '—')]
        self._text(message, '\n'.join(lines))
        if not then_menu:
            return True
        return self._back_to_task(message, state, task)

    def _kpi_details(self, message, state, user, task):
        """📋 KPI details: the page link and the details, then a poll with
        Completed, Get a file and Logs (updates and manuals are on the page)."""
        self._send_page_link(message, state, user, task)
        self._info_show(message, state, user, task, then_menu=False)
        rows = _kpi_actions_for(task)
        if not rows:
            return self._back_to_task(message, state, task)
        d = {'at': 'kpi_menu', 'codes': [c for c, _l in rows] + ['back']}
        return self._fask(message, state, d, _('📋 %s — what next?') % self._ref(task),
                          [l for _c, l in rows] + [BACK])

    def _send_page_link(self, message, state, user, task, group_note='', anchor='', intro=''):
        """A private link to this task's page (controllers/kpi_wa_task_page.py):
        everything on the task, plus add update / manual / complete. Only this
        person, only this task, for 2 hours.

        `group_note` replaces the usual "the link is in your private chat" line
        in the group (✅ Completed uses it to say the task is not finished yet)."""
        token = secrets.token_urlsafe(24)
        state.sudo().write({'staff_page_token': token, 'staff_page_kpi_id': task.id,
                            'staff_page_expires': fields.Datetime.now() + timedelta(hours=2)})
        base = self.env['whatsapp.config'].sudo().get_config().get_kpi_public_base_url()
        # `anchor` opens the page on one section (e.g. #addtime); `intro` replaces
        # the usual line, with %(ref)s and %(url)s.
        url = '%s/kpi/wa/task/%s%s' % (base, token, ('#' + anchor) if anchor else '')
        text = (intro % {'ref': self._ref(task), 'url': url}) if intro else _(
            '🔗 Open %s in your browser (only for you, 2 hours) — see everything and add updates, '
            'files, GitHub links or finish it there:\n%s') % (self._ref(task), url)
        number = ''.join(ch for ch in (user.kpi_wa_number or '') if ch.isdigit())
        if number:
            try:
                self._session(message).sudo().send_message(number, text)
                self._text(message, group_note or _('📩 %s, the %s page link is in your private chat.')
                           % (user.name or '', self._ref(task)))
                return
            except Exception as exc:
                _logger.warning('private task page link failed: %s', exc)
        self._text(message, ('%s\n\n%s' % (group_note, text)) if group_note else text)

    # ------------------------------------------------------------------ #
    # 📂 Projects & documents: a private "My work" page. Its link is SIGNED #
    # (state, person, expiry) rather than stored, so it never displaces the #
    # task-page link held on the same state row.                           #
    # ------------------------------------------------------------------ #
    MY_WORK_HOURS = 2

    def _my_work_sig(self, state_id, user_id, exp):
        from odoo.tools.misc import hmac as odoo_hmac
        return odoo_hmac(self.env(su=True), 'kpi_wa_my_work', '%s:%s:%s' % (state_id, user_id, exp))[:32]

    def my_work_token(self, state, user):
        exp = int((fields.Datetime.now() + timedelta(hours=self.MY_WORK_HOURS)).timestamp())
        return '%s-%s-%s' % (state.id, exp, self._my_work_sig(state.id, user.id, exp))

    def my_work_resolve(self, token):
        """(state, user) for a valid, unexpired My-work link, else (None, None)."""
        try:
            sid, exp, sig = (token or '').split('-', 2)
            sid, exp = int(sid), int(exp)
        except (ValueError, TypeError):
            return None, None
        if exp < fields.Datetime.now().timestamp():
            return None, None
        st = self.env['kpi.wa.group.intake'].sudo().browse(sid).exists()
        if not st:
            return None, None
        user, ok = self._staff_member(st, st.group_id)
        if not ok or not hmac_compare(sig, self._my_work_sig(sid, user.id, exp)):
            return None, None
        return st, user

    def my_task_ids(self, user):
        """The tasks the My-work page covers: the person's own board tasks."""
        return list({i for ids in self._board_lanes(user).values() for i in ids})

    def _send_overview_link(self, message, state, user):
        base = self.env['whatsapp.config'].sudo().get_config().get_kpi_public_base_url()
        url = '%s/kpi/wa/my/%s' % (base, self.my_work_token(state, user))
        text = _('📂 Your projects & documents (only for you, %d hours):\n%s') % (self.MY_WORK_HOURS, url)
        state._reset()
        return self._send_private(message, user, text,
                                  _('📩 %s, your projects & documents page is in your private chat.') % (user.name or ''))

    def _send_endday_link(self, message, state, user):
        """🌙 End my day: a private link to the End Workday page. Only this
        person, 2 hours. The group is told the day ends only after the summaries."""
        token = secrets.token_urlsafe(24)
        state._reset()
        state.sudo().write({'staff_end_token': token,
                            'staff_end_expires': fields.Datetime.now() + timedelta(hours=2)})
        base = self.env['whatsapp.config'].sudo().get_config().get_kpi_public_base_url()
        url = '%s/kpi/wa/endday/%s' % (base, token)
        text = _('🌙 End your day here (only for you, 2 hours):\n%s\n\nAdd a summary for each task you worked '
                 'on today, then tap *End workday*.') % url
        number = ''.join(ch for ch in (user.kpi_wa_number or '') if ch.isdigit())
        sent = False
        if number:
            try:
                self._session(message).sudo().send_message(number, text)
                sent = True
            except Exception as exc:
                _logger.warning('private end-day link failed: %s', exc)
        self._text(message, _('🌙 %s, use the link in your private chat and put the summary for each task you '
                              'worked on today — your day ends only after that.') % (user.name or '')
                   if sent else text)
        return True

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

    def _switch_to(self, message, state, user, task, from_task=None):
        """kra.kpi.switch_to_task: stop what runs, start this, in one step.

        With several running (multitask) the person says which one hands over,
        as the web's per-card Switch does; without a from_kpi_id the server
        would stop every running task."""
        running = self._running_tasks(user) - task
        if from_task is None and len(running) > 1:
            d = {'at': 'switch_from_which', 'ids': running.ids}
            return self._fask(message, state, d,
                              _('🔀 Start %s — which running task should stop?') % self._ref(task),
                              [self._task_line(t, True) for t in running] + [BACK])
        try:
            res = task.with_user(user).sudo().switch_to_task(
                from_kpi_id=from_task.id if from_task else None, note='')
        except Exception as exc:
            res = {'status': False, 'message': str(exc).strip()[:300]}
        state._reset()
        if not res or res.get('status') is False:
            self._text(message, _('%(ref)s: %(why)s') % {
                'ref': self._ref(task), 'why': (res or {}).get('message') or _('could not switch')})
            self._menu_again(message, state, user)
            return True
        self._text(message, _('🔀 %(who)s switched to %(ref)s.%(still)s') % {
            'who': user.name, 'ref': self._ref(task), 'still': self._still_running(user, task)})
        return True

    def _fl_switch_from_which(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        ids = d.get('ids') or []
        if i >= len(ids):
            return self._back_to_task(message, state, task)
        from_task = self.env['kra.kpi'].sudo().browse(ids[i]).exists()
        if not from_task or from_task.task_state != 'in_progress':
            self._text(message, _('That task is no longer running.'))
            return self._switch_to(message, state, user, task)
        return self._switch_to(message, state, user, task, from_task=from_task)

    def _still_running(self, user, task):
        """' (still running: REF-A, REF-B)' when others keep going (multitask), else ''."""
        others = self._running_tasks(user) - task
        return (_(' (still running: %s)') % ', '.join(self._ref(t) for t in others)) if others else ''

    def _switch_from_begin(self, message, state, user, task, ids=None, query=''):
        """From the RUNNING task: pick the task to move to (the web's Switch to…).
        Ends with 🔍 Search: type part of a ref or name to narrow the list."""
        targets = self.env['kra.kpi'].sudo().browse(ids).exists() if ids is not None \
            else _switch_targets(task, user)
        if not targets and not query:
            return self._back_to_task(message, state, task, _('You have no other task to switch to.'))
        d = {'at': 'switch_pick', 'ids': targets.ids, 'search': True}
        head = _('🔀 Switch from %s to which task? %s pauses ("Moved to another task") and the '
                 'one you pick starts.') % (self._ref(task), self._ref(task))
        if query:
            head = _('🔍 "%(q)s" — %(n)d found. %(head)s') % {'q': query, 'n': len(targets), 'head': head}
        return self._fask(message, state, d, head,
                          [self._task_line(t, True) for t in targets] + [self.SEARCH, BACK])

    def _switch_search_ids(self, user, task, query):
        """Tasks this person could switch to that match the typed text: the
        same matching as 📋 My tasks › 🔍 Search, over every switchable task."""
        allowed = set(self.env['kra.kpi'].sudo().search([
            ('user_id', '=', user.id), ('active', '=', True), ('id', '!=', task.id),
            ('task_state', 'not in', ('in_progress', 'partially_completed', 'awaiting_client', 'completed')),
        ]).ids)
        return [i for i in self._mt_search_ids(user, query) if i in allowed][:9]

    def _fl_switch_search(self, message, state, user, d, task, tapped, low, body):
        q = (body or '').strip()
        if not q:
            return False
        return self._switch_from_begin(message, state, user, task,
                                       ids=self._switch_search_ids(user, task, q), query=q)

    def _fl_switch_pick(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            # Typed instead of tapped: treat it as a search.
            if d.get('search') and (body or '').strip():
                return self._fl_switch_search(message, state, user, d, task, tapped, low, body)
            return False
        ids = d.get('ids') or []
        if d.get('search') and i == len(ids):               # 🔍 Search
            self._fsave(state, {'at': 'switch_search'})
            self._text(message, _('🔍 Type part of the task number or name to switch to — e.g. REQ-014, '
                                  'req14, or a word from the name. (Type cancel to stop.)'))
            return True
        if i >= len(ids):
            return self._back_to_task(message, state, task)
        target = self.env['kra.kpi'].sudo().browse(ids[i]).exists()
        if not target:
            return self._back_to_task(message, state, task, _('That task is no longer there.'))
        try:
            res = target.with_user(user).sudo().switch_to_task(from_kpi_id=task.id, note='')
        except Exception as exc:
            res = {'status': False, 'message': str(exc).strip()[:300]}
        if not res or res.get('status') is False:
            return self._back_to_task(message, state, task, _('Could not switch: %s')
                                      % ((res or {}).get('message') or ''))
        state._reset()
        self._text(message, _('🔀 %(who)s switched from %(a)s to %(b)s. %(a)s is paused (moved to another task).')
                   % {'who': user.name, 'a': self._ref(task), 'b': self._ref(target)})
        return True

    def _undo_begin(self, message, state, user, task):
        q = _('↩️ Undo today\'s start of %s?\nIt goes back to how it was before today\'s first '
              'start, and today\'s time on it is removed.') % self._ref(task)
        keeps = task._undo_keeps_line()
        if keeps:
            q += '\n\n✅ ' + keeps
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
        files = self._task_files(task, user)[:8]
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
                  'estimate_extended': 'Estimate extended',
                  'client_chat_message': 'Client message (Discuss)', 'client_chat_reply': 'Reply to the client',
                  'client_chat_forwarded': 'Client question sent to the developer'}

    def _logs_begin(self, message, state, user, task):
        return self._fask(message, state, {'at': 'logs'}, _('🧾 Which log for %s?') % self._ref(task),
                          [l for _k, l, _e in self.LOG_KINDS] + [BACK])

    def _fl_logs(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        if i >= len(self.LOG_KINDS):
            return self._back_to_task(message, state, task)
        key, label, _events = self.LOG_KINDS[i]
        lines = ['%s — %s' % (label, self._ref(task))]
        lines += ['• %s' % r for r in self.log_rows(task, user, key)[:10]]
        if len(lines) == 1:
            lines.append(_('Nothing logged yet.'))
        self._text(message, '\n'.join(lines))
        return self._back_to_task(message, state, task)

    # ================================================================== #
    # ➕ Create my own task -- kra.kpi.self_create_task                    #
    # ================================================================== #
    def _create_begin(self, message, state, user):
        """➕ Create my own task: a private link to the New Task page -- the
        board's form, same fields and rules (controllers/kpi_wa_task_form.py).
        One person, one use, 30 minutes."""
        if not self.env['kra.kpi'].with_user(user)._actor_workday_open():
            state._reset()
            self._text(message, _('Start your workday before creating a task.'))
            return True
        token = secrets.token_urlsafe(24)
        state._reset()
        state.sudo().write({'staff_form_token': token,
                            'staff_form_expires': fields.Datetime.now() + timedelta(minutes=30)})
        base = self.env['whatsapp.config'].sudo().get_config().get_kpi_public_base_url()
        url = '%s/kpi/wa/newtask/%s' % (base, token)
        text = _('➕ New task — fill it in here (only for you, works once, for 30 minutes):\n%s\n\n'
                 'Tap *Create Task* on the page and come back to WhatsApp — the task is shown here.') % url
        number = ''.join(ch for ch in (user.kpi_wa_number or '') if ch.isdigit())
        sent = False
        if number:
            try:
                self._session(message).sudo().send_message(number, text)
                sent = True
            except Exception as exc:
                _logger.warning('private new-task link failed: %s', exc)
        if sent:
            self._text(message, _('📩 %s, the new-task form is in your private chat.') % (user.name or ''))
        else:
            self._text(message, text)
        return True

    # ================================================================== #
    # 📋 My tasks -- the web board: PLAN / DO / CHECK → lane → task       #
    # ================================================================== #
    # web/components/board/Board.jsx PHASES and web/lib/services/kpiActions.js
    # laneForTask, mirrored so the two show a developer the same grouping.
    PHASES = [
        ('plan', '📝 PLAN', ['regular', 'important', 'urgent']),
        ('do', '⚙️ DO', ['today', 'in_progress', 'paused']),
        ('check', '✅ CHECK', ['pending_review', 'approvals', 'awaiting_client', 'completed']),
    ]
    LANE_LABEL = {
        'regular': '⚪ Regular', 'important': '🟣 Important', 'urgent': '🔴 Urgent',
        'today': '☀️ Today', 'in_progress': '▶️ In progress', 'paused': '⏸️ Paused',
        'pending_review': '👁️ Pending review', 'approvals': '📝 Pending approvals',
        'awaiting_client': '🤝 Awaiting client', 'completed': '🏁 Completed',
    }

    # Plain lane names for the heading brackets (a poll row holds 100 chars).
    LANE_SHORT = {
        'regular': 'Regular', 'important': 'Important', 'urgent': 'Urgent',
        'today': 'Today', 'in_progress': 'In progress', 'paused': 'Paused',
        'pending_review': 'Pending review', 'approvals': 'Approvals',
        'awaiting_client': 'Awaiting client', 'completed': 'Completed',
    }

    @staticmethod
    def _lane_of(t):
        if t.is_self_created and not t.admin_accepted:
            return 'pending_review'
        st = t.task_state
        if st in ('in_progress', 'paused'):
            return st
        if st == 'partially_completed':
            return 'approvals'
        if st in ('awaiting_client', 'completed'):
            return st
        if t.priority == 'urgent' or st == 'urgent':
            return 'urgent'
        if t.priority == 'important' or st == 'important':
            return 'important'
        return 'regular'

    def _board_lanes(self, user):
        """{lane: [tasks newest-worked first]} -- the developer's web board:
        own tasks, minus completed AND client-signed (/kra_kpi/tasks/get)."""
        tasks = self.env['kra.kpi'].sudo().search([
            ('user_id', '=', user.id), ('active', '=', True),
            '!', '&', ('task_state', '=', 'completed'), ('client_final_approved', '=', True)])
        Log = self.env['kpi.time.log'].sudo()
        last = {}
        for l in Log.search_read([('kpi_id', 'in', tasks.ids)], ['kpi_id', 'start_time']):
            k = l['kpi_id'][0]
            if l['start_time'] and (k not in last or l['start_time'] > last[k]):
                last[k] = l['start_time']
        today = fields.Date.context_today(self.with_context(tz=kpi_tz_name(self.env, user)))
        today_ids = set(Log.search([('user_id', '=', user.id), ('work_date', '=', today),
                                    ('kpi_id', 'in', tasks.ids)]).mapped('kpi_id').ids)
        order = sorted(tasks, key=lambda t: (t.id not in last, -(last[t.id].timestamp() if t.id in last else 0),
                                             -t.id))
        lanes = {}
        for t in order:
            lanes.setdefault(self._lane_of(t), []).append(t.id)
            if t.id in today_ids:
                lanes.setdefault('today', []).append(t.id)
        return lanes

    def _mytasks_begin(self, message, state, user):
        lanes = self._board_lanes(user)
        opts, codes = [], []
        total = 0
        # Straight to the running task(s): the one thing a developer most often
        # wants, without going through DO first.
        running = lanes.get('in_progress', [])
        opts.append('%s (%d)' % (self.LANE_LABEL['in_progress'], len(running)))
        codes.append('inprog')
        for key, label, keys in self.PHASES:
            n = len({i for k in keys for i in lanes.get(k, [])})
            total += n
            # Always shown, like the board's columns -- (0) when empty. The lanes
            # inside are named so the sections are visible from the first poll:
            # "⚙️ DO — ☀️ Today 1 · ⏸️ Paused 3".
            # Every lane named in the brackets, empty ones too:
            # "📝 PLAN (Regular 1 · Important 0 · Urgent 2)".
            inside = ' · '.join('%s %d' % (self.LANE_SHORT[k].upper(), len(lanes.get(k, []))) for k in keys)
            opts.append(('%s (%s)' % (label, inside))[:99])
            codes.append(key)
        opts += [self.FILTER, self.OVERVIEW, STAFF_CREATE_LABEL, self.SEARCH, BACK]
        codes += ['filter', 'overview', 'new', 'search', 'back']
        q = _('📋 Your tasks — pick a section') if total \
            else _('📋 Nothing is assigned to you yet — create your own, or wait for a manager to assign one.')
        self._fsave(state, {}, staff_kpi_id=False)
        return self._fask(message, state, {'at': 'mt_phase', 'codes': codes}, q, opts)

    def _fl_mt_phase(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        code = d['codes'][i]
        if code == 'inprog':
            if not self._board_lanes(user).get('in_progress'):
                self._text(message, _('Nothing is in progress right now.'))
                return self._mytasks_begin(message, state, user)
            return self._mt_tasks(message, state, user, 'do', 'in_progress', 0)
        if code == 'new':
            return self._create_begin(message, state, user)
        if code == 'filter':
            return self._mt_filter_menu(message, state, user)
        if code == 'overview':
            return self._send_overview_link(message, state, user)
        if code == 'search':                      # search all tasks from the top
            self._fsave(state, {'at': 'mt_search', 'phase': None, 'lane': None})
            self._text(message, _('🔍 Search task name or tag — e.g. REQ-014, req14, REQ, or part of '
                                  'the name. (Type cancel to stop.)'))
            return True
        if code == 'back':
            state._reset()
            return self._show_staff_menu(message, state, user)
        return self._mt_lanes(message, state, user, code)

    def _mt_lanes(self, message, state, user, phase):
        lanes = self._board_lanes(user)
        keys = [k for p, _l, ks in self.PHASES if p == phase for k in ks if lanes.get(k)]
        # Always shown, even with one lane, so the lane's name is seen.
        if not keys:
            label = dict((p, l) for p, l, _k in self.PHASES).get(phase, '')
            self._text(message, _('Nothing in %s right now.') % label)
            return self._mytasks_begin(message, state, user)
        label = dict((p, l) for p, l, _k in self.PHASES)[phase]
        opts = ['%s (%d)' % (self.LANE_LABEL[k], len(lanes[k])) for k in keys] + [BACK]
        return self._fask(message, state, {'at': 'mt_lane', 'phase': phase, 'keys': keys},
                          _('%s — pick a lane') % label, opts)

    def _fl_mt_lane(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        keys = d.get('keys') or []
        if i >= len(keys):
            return self._mytasks_begin(message, state, user)
        return self._mt_tasks(message, state, user, d['phase'], keys[i], 0)

    SEARCH = '🔍 Search'
    FILTER = '🎯 Filter'
    OVERVIEW = '📂 Projects & documents'

    # ------------------------------------------------------------------ #
    # 🎯 Filter: taps only. Each filter is a "lane" named f_… so the list,  #
    # paging, Search, Back and the task menu's Back all work unchanged.   #
    # ------------------------------------------------------------------ #
    FILTERS = [('f_urgent', '🔴 Urgent'), ('f_important', '🟣 Important'), ('f_regular', '⚪ Regular'),
               ('f_active', '▶️ Running & paused')]
    FINISHED = ('partially_completed', 'awaiting_client', 'completed')

    def _filter_ids(self, user, lane):
        lanes = self._board_lanes(user)
        order = []
        for k in ('in_progress', 'paused', 'urgent', 'important', 'regular', 'pending_review',
                  'approvals', 'awaiting_client', 'completed'):
            order += [i for i in lanes.get(k, []) if i not in order]
        tasks = self.env['kra.kpi'].sudo().browse(order).exists()
        if lane == 'f_active':
            keep = tasks.filtered(lambda t: t.task_state in ('in_progress', 'paused'))
        elif lane.startswith('f_p'):
            kra = int(lane[3:] or 0)
            keep = tasks.filtered(lambda t: t.kra_id.id == kra)
        else:
            prio = lane[2:]
            keep = tasks.filtered(lambda t: (t.priority or 'regular') == prio and t.task_state not in self.FINISHED)
        return keep.ids

    def _filter_title(self, lane):
        if lane.startswith('f_p'):
            kra = self.env['kra.master'].sudo().browse(int(lane[3:] or 0)).exists()
            return '📁 %s' % (kra.display_name if kra else _('Project'))
        return dict(self.FILTERS).get(lane, lane)

    def _mt_filter_menu(self, message, state, user):
        opts, codes = [], []
        for code, label in self.FILTERS:
            opts.append('%s (%d)' % (label, len(self._filter_ids(user, code))))
            codes.append(code)
        opts += [_('📁 By project'), BACK]
        codes += ['projects', 'back']
        return self._fask(message, state, {'at': 'mt_filter', 'codes': codes}, _('🎯 Show which tasks?'), opts)

    def _fl_mt_filter(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        code = (d.get('codes') or [])[i] if i < len(d.get('codes') or []) else 'back'
        if code == 'back':
            return self._mytasks_begin(message, state, user)
        if code == 'projects':
            return self._mt_projects(message, state, user)
        return self._mt_tasks(message, state, user, 'filter', code, 0)

    def _mt_projects(self, message, state, user):
        """📁 By project: the projects this person has tasks in, busiest first."""
        tasks = self.env['kra.kpi'].sudo().browse(
            list({i for ids in self._board_lanes(user).values() for i in ids})).exists()
        count = {}
        for t in tasks:
            if t.kra_id:
                count[t.kra_id] = count.get(t.kra_id, 0) + 1
        projects = sorted(count, key=lambda k: (-count[k], k.display_name or ''))
        if not projects:
            self._text(message, _('None of your tasks has a project yet.'))
            return self._mt_filter_menu(message, state, user)
        return self._pick_list(message, state, user, {
            'kind': 'project', 'all': [p.id for p in projects],
            'count': {str(p.id): count[p] for p in projects}})

    def _fl_mt_proj(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        ids = d.get('ids') or []
        if i >= len(ids):
            return self._mt_filter_menu(message, state, user)
        return self._mt_tasks(message, state, user, 'filter', 'f_p%d' % ids[i], 0)

    def _mt_tasks(self, message, state, user, phase, lane, page, query=None, note=''):
        """One page of tasks -- a lane's, a filter's (lane f_…), or search results
        (query set). Every page ends with 🔍 Search and ↩️ Back (and ➡️ More)."""
        if query is not None:
            ids = self._mt_search_ids(user, query)
            title = _('🔍 "%s" — %d found') % (query, len(ids))
        elif (lane or '').startswith('f_'):
            ids = self._filter_ids(user, lane)
            title = '%s — %s' % (self._filter_title(lane), _('pick a task') if ids else _('nothing here right now'))
        else:
            ids = self._board_lanes(user).get(lane, [])
            title = '%s — %s' % (self.LANE_LABEL.get(lane, lane), _('pick a task'))
        tasks = self.env['kra.kpi'].sudo().browse(ids).exists()
        per = 7 if len(tasks) <= 7 else 6        # room for More · Search · Back · 🏠
        pages = max(1, (len(tasks) + per - 1) // per)
        page = page % pages
        chunk = tasks[page * per:(page + 1) * per]
        # A lane already says the state; Today and search results mix states,
        # so those lines carry it too.
        with_state = query is not None or lane == 'today' or (lane or '').startswith('f_')
        opts = [self._task_line(t, with_state) for t in chunk]
        if pages > 1:
            opts.append('➡️ More')
        opts += [self.SEARCH, BACK]
        d = {'at': 'mt_task', 'phase': phase, 'lane': lane, 'page': page, 'ids': chunk.ids,
             'query': query}
        return self._fask(message, state, d, ((note + '\n\n') if note else '') + title, opts)

    @staticmethod
    def _task_line(t, with_state=False):
        """'REQ-005 — Billing slow (URGENT)' -- the priority in capitals."""
        prio = (dict(t._fields['priority'].selection or []).get(t.priority) or t.priority or 'regular')
        line = '%s — %s' % (t.external_ref or ('#%s' % t.id), (t.name or '')[:40])
        if with_state:
            line += ' · %s' % dict(t._fields['task_state'].selection).get(t.task_state, t.task_state)
        return ('%s (%s)' % (line, str(prio).upper()))[:99]

    @staticmethod
    def _norm(s):
        return re.sub(r'[^a-z0-9]', '', (s or '').lower())

    def _mt_search_ids(self, user, query):
        """The web search box, over all of this person's board tasks: a ref
        typed any way (REQ-014, req14, req 14, REQ), or part of the name."""
        q = (query or '').strip()
        qn = self._norm(q)
        m = re.match(r'^([a-z]+)0*(\d+)$', qn)
        out = []
        lanes = self._board_lanes(user)
        seen = []
        for k in ('in_progress', 'paused', 'urgent', 'important', 'regular', 'pending_review',
                  'approvals', 'awaiting_client', 'completed'):
            seen += [i for i in lanes.get(k, []) if i not in seen]
        for t in self.env['kra.kpi'].sudo().browse(seen).exists():
            if self._task_hit(t, q):
                out.append(t.id)
        return out

    def _task_hit(self, t, query):
        """A ref typed any way (REQ-014, req14, req 14, REQ), or part of the name."""
        q = (query or '').strip()
        qn = self._norm(q)
        m = re.match(r'^([a-z]+)0*(\d+)$', qn)
        ref = self._norm(t.external_ref)
        rm = re.match(r'^([a-z]+)0*(\d+)$', ref)
        return bool(qn) and bool(
            (m and rm and rm.group(1).startswith(m.group(1)) and rm.group(2) == m.group(2))
            or (qn.isdigit() and rm and rm.group(2) == (qn.lstrip('0') or '0'))
            or (not m and ref.startswith(qn))
            or q.lower() in (t.name or '').lower())

    # ================================================================== #
    # A long list, paged: tasks ("Which one?"), clients, projects          #
    # ================================================================== #
    # d: kind ('task' / 'client' / 'project'), all (every id, in order),
    # ctx (for a task: the action it is picked for), page, query.
    LIST_PAGE = 6            # with More · Search · Back · 🏠 Main menu = 10

    def _lp_rows(self, user, d):
        """(records, label of one) for this list, search applied."""
        kind, q = d.get('kind'), d.get('query')
        if kind == 'task':
            rows = self.env['kra.kpi'].sudo().browse(d.get('all') or []).exists()
            if q:
                rows = rows.filtered(lambda r: self._task_hit(r, q))
            return rows, lambda r: self._task_line(r, True)
        rows = self.env['kra.master'].sudo().browse(d.get('all') or []).exists()
        if q:
            rows = rows.filtered(lambda r: q.lower() in (r.display_name or r.name or '').lower())
        if kind == 'project':
            count = d.get('count') or {}
            return rows, lambda r: ('%s (%s)' % (r.display_name or r.name or '', count.get(str(r.id), 0)))[:99]
        return rows, lambda r: ('🏢 %s' % (r.name or ''))[:99]

    def _pick_list(self, message, state, user, d, note=''):
        """One page: up to 6 rows (7 when it all fits), then ➡️ More and
        🔍 Search when there is more than one page, then ↩️ Back."""
        d = dict(d, at='lp', page=d.get('page') or 0)
        rows, label = self._lp_rows(user, d)
        if d.get('query') and not rows:
            note = _('🔍 Nothing matches "%s".') % d['query']
            d['query'] = None
            rows, label = self._lp_rows(user, d)
        many = len(rows) > self.LIST_PAGE + 1
        per = self.LIST_PAGE if many else self.LIST_PAGE + 1
        pages = max(1, (len(rows) + per - 1) // per)
        d['page'] = d['page'] % pages
        chunk = rows[d['page'] * per:(d['page'] + 1) * per]
        d['ids'] = chunk.ids
        opts = [label(r) for r in chunk]
        if pages > 1:
            opts.append(_('➡️ More (page %(p)d of %(n)d)') % {'p': d['page'] + 1, 'n': pages})
        if many or d.get('query'):
            opts.append(self.SEARCH)
        opts.append(BACK)
        if d.get('kind') == 'task':
            title = (_('Which task is the client meeting about?') if d.get('ctx') == 'meet_client'
                     else _('Which one? (%s)') % STAFF_BY_ID.get(d.get('ctx'), ''))
        else:
            title = _('📁 Which project?') if d.get('kind') == 'project' else _('🤝 Which client?')
        if d.get('query'):
            title += '\n' + _('🔍 "%(q)s": %(n)d found') % {'q': d['query'], 'n': len(rows)}
        return self._fask(message, state, d, ((note + '\n\n') if note else '') + title, opts)

    def _fl_lp(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            # Typed instead of tapped: a search.
            if (body or '').strip() and not low.strip().isdigit():
                return self._pick_list(message, state, user, dict(d, query=body.strip(), page=0))
            return False
        ids = d.get('ids') or []
        label = d['opts'][i]
        if i < len(ids):
            return self._lp_open(message, state, user, d, ids[i])
        if label.startswith('➡️'):
            return self._pick_list(message, state, user, dict(d, page=d.get('page', 0) + 1))
        if label == self.SEARCH:
            self._fsave(state, dict(d, at='lp_search'))
            what = {'client': _('part of the client name'), 'project': _('part of the project name')}.get(
                d.get('kind'), _('the task number or part of its name — e.g. REQ-014, req14'))
            self._text(message, _('🔍 Type %s. (Type cancel to stop.)') % what)
            return True
        if d.get('query'):                        # Back from results → the whole list
            return self._pick_list(message, state, user, dict(d, query=None, page=0))
        return self._lp_back(message, state, user, d)

    def _fl_lp_search(self, message, state, user, d, task, tapped, low, body):
        q = (body or '').strip()
        if not q:
            return False
        return self._pick_list(message, state, user, dict(d, query=q, page=0))

    def _lp_open(self, message, state, user, d, rec_id):
        kind = d.get('kind')
        if kind == 'client':
            client = self.env['kra.master'].sudo().browse(rec_id)
            tasks = self._client_tasks(user).get(client) or self.env['kra.kpi']
            if not tasks:
                state._reset()
                self._text(message, _('You have no open task for %s.') % (client.name or ''))
                return True
            return self._meet_client_tasks(message, state, user, tasks)
        if kind == 'project':
            return self._mt_tasks(message, state, user, 'filter', 'f_p%d' % rec_id, 0)
        picked = self.env['kra.kpi'].sudo().browse(rec_id).exists()
        if not picked:
            return self._pick_list(message, state, user, d, note=_('That task is no longer there.'))
        action = d.get('ctx') or 'mytasks'
        state._touch(staff_kpi_id=picked.id, staff_action=action, staff_draft=False)
        if action == 'mytasks':
            return self._staff_offer_actions(message, state, picked)
        return self._staff_begin(message, state, user, picked, action)

    def _lp_back(self, message, state, user, d):
        kind, ctx = d.get('kind'), d.get('ctx')
        if kind == 'project':
            return self._mt_filter_menu(message, state, user)
        if kind == 'client' or ctx == 'meet_admin':
            return self._meeting_menu(message, state, user)
        if ctx == 'meet_client':
            return self._meet_client_pick(message, state, user)
        state._reset()
        return self._show_staff_menu(message, state, user)

    def _fl_mt_task(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        ids = d.get('ids') or []
        label = d['opts'][i]
        if i < len(ids):
            picked = self.env['kra.kpi'].sudo().browse(ids[i]).exists()
            if not picked:
                return self._mt_tasks(message, state, user, d['phase'], d['lane'], d.get('page', 0))
            # Remembered so ↩️ Back on the task menu returns to this lane.
            state._touch(staff_kpi_id=picked.id,
                         staff_action='mt:%s:%s' % (d['phase'], d['lane']))
            return self._staff_offer_actions(message, state, picked)
        if label.startswith('➡️'):
            return self._mt_tasks(message, state, user, d['phase'], d['lane'], d.get('page', 0) + 1,
                                  query=d.get('query'))
        if label == self.SEARCH:
            self._fsave(state, {'at': 'mt_search', 'phase': d['phase'], 'lane': d['lane']})
            self._text(message, _('🔍 Search task name or tag — e.g. REQ-014, req14, REQ, or part of '
                                  'the name. (Type cancel to stop.)'))
            return True
        if not d.get('phase'):                    # searched from the top → My tasks
            return self._mytasks_begin(message, state, user)
        if d.get('phase') == 'filter' and d.get('query') is None:   # a filter's list → its menu
            if (d.get('lane') or '').startswith('f_p'):
                return self._mt_projects(message, state, user)
            return self._mt_filter_menu(message, state, user)
        if d.get('query') is not None:            # Back from results → the lane
            return self._mt_tasks(message, state, user, d['phase'], d['lane'], 0)
        return self._mt_lanes(message, state, user, d['phase'])

    def _fl_mt_search(self, message, state, user, d, task, tapped, low, body):
        q = (body or '').strip()
        if not q:
            return False
        ids = self._mt_search_ids(user, q)
        if len(ids) == 1:                          # one match: open it
            picked = self.env['kra.kpi'].sudo().browse(ids[0])
            state._touch(staff_kpi_id=picked.id,
                         staff_action='mt:%s:%s' % (d['phase'], d['lane']))
            return self._staff_offer_actions(message, state, picked)
        if not ids:
            if not d.get('phase'):
                self._text(message, _('🔍 No task matches "%s".') % q)
                return self._mytasks_begin(message, state, user)
            return self._mt_tasks(message, state, user, d['phase'], d['lane'], 0,
                                  note=_('🔍 No task matches "%s".') % q)
        return self._mt_tasks(message, state, user, d['phase'], d['lane'], 0, query=q)

    # ================================================================== #
    # Main menu ⏸️ Pause: Break · Lunch · Meeting · Pause my whole day     #
    # ================================================================== #
    # The old main-menu Pause poll. ⏸️ Pause now opens the full reasons
    # (_pause_menu, below); this stays so a poll sent before that still works.
    PAUSE_MENU = ['☕ Break', '🍽️ Lunch', '👥 Meeting', '🗓️ Pause my whole day', BACK]

    def _fl_day_pausemenu(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        if i in (0, 1):
            code = ('break', 'lunch')[i]
            running = self.env['kpi.time.log'].sudo().search_count(
                [('user_id', '=', user.id), ('is_active', '=', True)])
            if running:
                # A task is running: pause every running timer with this reason,
                # as the web's Pause all does; the reply names each one.
                return self._pause_all_apply(message, state, user, code, PAUSE_STORED[code], [])
            # Nothing running: record it as break / lunch time on the day.
            return self._staff_nontask(message, state, user, 'nt_%s' % code)
        if i == 2:
            return self._meeting_menu(message, state, user)
        if i == 3:
            return self._staff_day_control(message, state, user, 'day_pause')
        state._reset()
        return self._show_staff_menu(message, state, user)

    SWITCH_ICONS = {'break': '☕', 'lunch': '🍽️', 'meeting': '👥'}

    def _switch_open_break(self, message, state, user, code, note='', picked=None):
        """Break / Lunch / Meeting while a task's break is still open.

        Pausing a task for a break opens a break row. Recording Lunch as non-task
        time on top of it left both open, so the Workday Map showed them
        overlapping. Instead the open break is split at now, as the web's
        "switch without resuming" button does, and the task stays paused.

        Returns None when no break is open, so the caller records non-task time
        as before."""
        Break = self.env['kpi.break.log'].sudo()
        if not Break.search_count([('user_id', '=', user.id), ('is_active', '=', True)]):
            return None
        state._reset()
        try:
            res = Break.switch_open_break(code, user_id=user.id,
                                          reason_note=note or PAUSE_STORED.get(code) or '',
                                          meeting_with_ids=picked or None)
        except Exception as exc:
            self._text(message, _('Could not record that: %s') % str(exc).strip()[:200])
            return True
        if res is False:
            return None
        icon = self.SWITCH_ICONS.get(code, '')
        what = PAUSE_STORED.get(code) or code
        task = self.env['kra.kpi'].sudo().browse(res.get('source_task_id') or 0).exists()
        back = (_(' %s stays paused — tap *Resume* on it when you are back.') % self._ref(task)
                if task else _(' Tap *Back to work* when you are in.'))
        prev = res.get('switched_from')
        if not prev:
            self._text(message, _('%(icon)s %(what)s is already noted.%(back)s') % {
                'icon': icon, 'what': what, 'back': back})
            return True
        self._text(message, _('%(from_icon)s %(from)s → %(icon)s %(what)s.%(back)s') % {
            'from_icon': self.SWITCH_ICONS.get(prev, ''), 'from': PAUSE_STORED.get(prev) or prev,
            'icon': icon, 'what': what, 'back': back})
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
        # Or pick it on the task page instead of typing: the link opens right on
        # the ⏱️ Ask for more time section (kpi_wa_task_page, #addtime).
        try:
            self._send_page_link(message, state, user, task, anchor='addtime',
                                 group_note=_('📩 %s, or pick the time on the page — the link is in your '
                                              'private chat.') % (user.name or ''),
                                 intro=_('⏱️ Pick the extra time for %(ref)s instead of typing '
                                         '(only for you, 2 hours):\n%(url)s'))
        except Exception as exc:
            _logger.warning('add-time page link failed: %s', exc)
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
    # The poll holds 10, so the reasons sit on two polls, each with ↩️ Back:
    # the common ones (and Urgent) first, the rest under ➕ More reasons….
    # 🗓️ Pause my whole day sits with the reasons too, as the web's Pause dialog
    # sits beside its Pause workday button.
    PAUSE_TOP = ['break', 'lunch', 'priority_task', 'meeting', 'day_end', 'urgent', 'more',
                 'day_pause', 'back']
    PAUSE_MORE = ['awaiting_approval', 'technical_issue', 'leave', 'other', 'back_top']

    # d['all'] = True: the same polls, but every running task pauses together
    # (kra.kpi.pause_all_running), for a multitask person who chose "All".
    def _pause_poll(self, message, state, task, codes, question, all_=False):
        labels = dict(PAUSE_CODES, more='➕ More reasons…', back=BACK, back_top=BACK,
                      day_pause='🗓️ Pause my whole day')
        return self._fask(message, state, {'at': 'pause_code', 'codes': codes, 'all': all_}, question,
                          [labels[c] for c in codes])

    def _pause_begin(self, message, state, user, task, all_=False):
        if all_:
            refs = ', '.join(self._ref(t) for t in self._running_tasks(user))
            q = _('⏸️ Why are you pausing all your running tasks (%s)?') % refs
        else:
            q = _('⏸️ Why are you pausing %s?') % self._ref(task)
        return self._pause_poll(message, state, task, self.PAUSE_TOP, q, all_=all_)

    def _running_tasks(self, user):
        """Every task this person has a timer running on (several when multitasking)."""
        return self.env['kpi.time.log'].sudo().search(
            [('user_id', '=', user.id), ('is_active', '=', True)]).mapped('kpi_id').filtered(
            lambda k: k.task_state == 'in_progress')

    def _pause_menu(self, message, state, user):
        """Main-menu ⏸️ Pause. One task running: straight to its reasons. Several
        (multitask): which one, or all of them."""
        running = self._running_tasks(user)
        if not running:
            state._reset()
            self._text(message, _('Nothing is running to pause.'))
            return self._show_staff_menu(message, state, user)
        if len(running) == 1:
            state._touch(staff_kpi_id=running.id)
            return self._pause_begin(message, state, user, running)
        d = {'at': 'pause_which', 'ids': running.ids}
        return self._fask(message, state, d, _('⏸️ Pause which? You have %d tasks running.') % len(running),
                          [self._task_line(t, True) for t in running]
                          + [_('⏸️ All %d tasks') % len(running), BACK])

    def _fl_pause_which(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        ids = d.get('ids') or []
        if i < len(ids):
            picked = self.env['kra.kpi'].sudo().browse(ids[i]).exists()
            if not picked or picked.task_state != 'in_progress':
                self._text(message, _('That task is no longer running.'))
                return self._pause_menu(message, state, user)
            state._touch(staff_kpi_id=picked.id)
            return self._pause_begin(message, state, user, picked)
        if i == len(ids):
            return self._pause_begin(message, state, user, task, all_=True)
        state._reset()
        return self._show_staff_menu(message, state, user)

    def _pause_all_apply(self, message, state, user, code, note, meet_ids):
        """Pause every running task with one reason (multitask "All")."""
        refs = ', '.join(self._ref(t) for t in self._running_tasks(user))
        try:
            res = self.env['kra.kpi'].sudo().with_user(user).pause_all_running(
                reason=note, reason_code=code, meeting_with_ids=meet_ids or [])
        except Exception as exc:
            res = {'status': False, 'message': str(exc).strip()[:200]}
        state._reset()
        if not res or res.get('status') is False:
            self._text(message, _('Could not pause: %s') % ((res or {}).get('message') or ''))
            self._menu_again(message, state, user)
            return True
        who = ''
        if meet_ids:
            who = _(' (with %s)') % ', '.join(self.env['res.users'].sudo().browse(meet_ids).mapped('name'))
        self._text(message, _('⏸️ Paused %(refs)s — %(why)s%(who)s') % {'refs': refs, 'why': note, 'who': who})
        return True

    def _fl_pause_code(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        all_ = bool(d.get('all'))
        codes = d.get('codes') or [c for c, _l in PAUSE_CODES]
        code = codes[i] if i < len(codes) else 'back'
        if code == 'back':
            if all_:
                return self._pause_menu(message, state, user)
            return self._back_to_task(message, state, task)
        if code == 'back_top':
            return self._pause_begin(message, state, user, task, all_=all_)
        if code == 'more':
            return self._pause_poll(message, state, task, self.PAUSE_MORE,
                                    _('⏸️ %s — other reasons') % (_('All tasks') if all_ else self._ref(task)),
                                    all_=all_)
        if code == 'day_pause':
            return self._staff_day_control(message, state, user, 'day_pause')
        if code == 'meeting':
            return self._fask(message, state, {'at': 'pause_meet', 'all': all_},
                              _('👥 Meeting with whom?'), self.PAUSE_MEET)
        if code in PAUSE_NOTE_CODES:
            self._fsave(state, {'at': 'pause_note', 'code': code, 'all': all_})
            prompt = {
                'urgent': _('Describe the issue — this note is sent to the owner / configured recipients.'),
                'awaiting_approval': _('Waiting for whose approval, on what? (short)'),
                'technical_issue': _('What is the technical issue? (short)'),
                'leave': _('Leave — what for / until when? (short)'),
            }.get(code, _("Please say what you're pausing for (short)."))
            self._text(message, prompt + _(' (Type cancel to stop.)'))
            return True
        # Break / Lunch / Moved to another task / Day End: the label is the reason.
        if all_:
            return self._pause_all_apply(message, state, user, code, PAUSE_STORED[code], [])
        return self._pause_apply(message, state, user, task, code, PAUSE_STORED[code], [])

    def _fl_pause_note(self, message, state, user, d, task, tapped, low, body):
        note = (body or '').strip()[:NOTE_MAX]
        if not note:
            self._text(message, _("Please say what you're pausing for."))
            return True
        code = d.get('code') or 'other'
        if code == 'meeting':                      # "With manager — <topic>"
            note = (_('With manager — %s') % note)[:NOTE_MAX]
        if d.get('all'):
            return self._pause_all_apply(message, state, user, code, note, [])
        return self._pause_apply(message, state, user, task, code, note, [])

    PAUSE_MEET = ['👨‍💻 With developer', '👥 Team meeting', '🧑‍💼 With manager', '🤝 With client', BACK]

    def _fl_pause_meet(self, message, state, user, d, task, tapped, low, body):
        """Pause → Meeting → with whom. Developer / team / manager are happening
        now, so the task pauses. A client meeting is booked for a set time: no
        pause -- it goes to the client-meeting request and the task keeps running."""
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        all_ = bool(d.get('all'))
        if all_ and i in (0, 1, 3):
            # All tasks: the 📅 Meeting flow already pauses every running task
            # (_meet_done → pause_all_running), and books client meetings.
            if i == 0:
                return self._meet_begin(message, state, user, purpose='pauseall', devs_only=True)
            if i == 1:
                return self._pause_all_apply(message, state, user, 'meeting', TEAM_MEETING_LABEL, [])
            return self._meet_client_pick(message, state, user)
        if i == 0:
            return self._meet_begin(message, state, user, purpose='pause', devs_only=True)
        if i == 1:
            return self._pause_apply(message, state, user, task, 'meeting', TEAM_MEETING_LABEL, [])
        if i == 2:
            self._fsave(state, {'at': 'pause_note', 'code': 'meeting', 'all': all_})
            self._text(message, _('What is the meeting with the manager about? (short — type cancel to stop)'))
            return True
        if i == 3:
            self._text(message, _('🤝 Client meetings are booked for a set time, so %s keeps running.')
                       % self._ref(task))
            # staff_action is still 'pause' here, and _staff_do_text reads the
            # request kind from it -- without this it is filed as a question.
            state._touch(staff_action='meet_client', staff_draft=False)
            return self._staff_begin(message, state, user, task, 'meet_client')
        return self._pause_begin(message, state, user, task, all_=all_)

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
        # Timers running side by side (multitask) cover the SAME wall-clock time,
        # so the live part counts once -- from the earliest start -- not once per
        # timer. Summing them made Productive run ahead of Presence.
        active = live.get('active_tasks') or []
        productive = (live.get('productive_base') or 0) + max(
            [since(t.get('timer_start')) for t in active] or [0])
        lines.append(_('Day open since %s · Presence %s · Productive %s') % (
            clock(live.get('login_raw')), _hm(max(0, presence)), _hm(productive)))
        if live.get('is_paused'):
            lines.append(_('⏸️ Workday paused since %s') % clock(live.get('paused_since')))
        if len(active) > 1:
            lines.append(_('⚡ Multi-tasking %d tasks:') % len(active))
        for t in active:
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
        """📍 Current status: which day? Today is the live status; an earlier day
        is that day's summary (the End Workday numbers), both sent privately."""
        today = fields.Date.context_today(self.with_context(tz=kpi_tz_name(self.env, user)))
        yesterday = today - timedelta(days=1)
        worked = self.env['kpi.work.session'].sudo().search_read(
            [('user_id', '=', user.id), ('session_date', '<', yesterday)],
            ['session_date'], order='session_date desc', limit=40)
        earlier = []
        for r in worked:
            if r['session_date'] not in earlier:
                earlier.append(r['session_date'])
            if len(earlier) == 6:
                break
        dates = ['today', fields.Date.to_string(yesterday)] + [fields.Date.to_string(x) for x in earlier]
        labels = [_('📍 Today (live)'), _('Yesterday — %s') % yesterday.strftime('%a %d %b')] + [
            x.strftime('%a %d %b') for x in earlier]
        return self._fask(message, state, {'at': 'day_pick', 'dates': dates}, _('📅 Which day?'),
                          labels + [BACK])

    def _fl_day_pick(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        dates = d.get('dates') or []
        state._reset()
        if i >= len(dates):
            return self._show_staff_menu(message, state, user)
        if dates[i] == 'today':
            return self._send_private(message, user, self._status_text(user),
                                      _('📩 %s, your current status is in your private chat.') % (user.name or ''))
        day = fields.Date.from_string(dates[i])
        text, image = self._day_summary(user, day)
        return self._send_private(message, user, text,
                                  _('📩 %(who)s, your summary for %(day)s is in your private chat.') % {
                                      'who': user.name or '', 'day': day.strftime('%a %d %b')}, image=image)

    def _send_private(self, message, user, text, ack, image=None):
        """Send to the person's own number; the group only hears that it went."""
        number = ''.join(ch for ch in (user.kpi_wa_number or '') if ch.isdigit())
        if not number:
            self._text(message, _('%s, I do not have your WhatsApp number — set your login mobile in '
                                  'Login Management.') % (user.name or ''))
            return True
        try:
            s = self._session(message).sudo()
            s.send_message(number, text)
            if image:
                try:
                    s.send_image(number, image, caption=_('End Workday summary'))
                except Exception as exc:          # the text already went; the picture is extra
                    _logger.warning('private day image failed: %s', exc)
        except Exception as exc:
            _logger.warning('private status send failed: %s', exc)
            self._text(message, _('Could not send it privately: %s') % str(exc)[:150])
            return True
        self._text(message, ack)
        return True

    def _day_summary(self, user, day):
        """(text, image b64 | None) for one earlier day: hours, each task, breaks,
        the note -- kpi.work.session._daily_summary_payload, with today's running
        timers kept out of it."""
        label = day.strftime('%a %d %b %Y')
        sess = self.env['kpi.work.session'].sudo().search(
            [('user_id', '=', user.id), ('session_date', '=', day)], order='login_at asc', limit=1)
        if not sess:
            return _('📅 %s — you did not work that day.') % label, None
        p = sess.with_context(kpi_summary_no_live=True)._daily_summary_payload(full_day=True)
        hhmm = lambda s: (s or '')[11:16] or (s or '')  # noqa: E731  'YYYY-MM-DD HH:MM:SS' → 'HH:MM'
        lines = ['📅 %s' % label,
                 _('%(start)s → %(end)s · Presence %(presence)s · Productive %(productive)s') % {
                     'start': hhmm(p.get('login_at')) or '—', 'end': hhmm(p.get('logout_at')) or _('(not ended)'),
                     'presence': p.get('presence_display'), 'productive': p.get('productive_display')}]
        if (p.get('paused_seconds') or 0) >= 60:
            lines.append(_('⏸️ Day paused %s') % p.get('paused_display'))
        tasks = p.get('tasks') or []
        lines.append('')
        lines += ['%s %s %s — %s' % ('⚡' if t.get('concurrent') else '•', t.get('ref') or '',
                                     (t.get('name') or '')[:48], t.get('duration_display') or '')
                  for t in tasks] or [_('(no task time logged)')]
        away = [(k, lab) for k, lab in (('break', _('☕ Break')), ('lunch', _('🍽️ Lunch')),
                                         ('meeting', _('👥 Meeting')), ('away', _('🚶 Away')))
                if p.get('%s_seconds' % k)]
        if away:
            lines += ['', ' · '.join('%s %s' % (lab, p.get('%s_display' % k)) for k, lab in away)]
        if p.get('note'):
            lines += ['', '📝 %s' % p['note']]
        snap = self.env['kpi.workday.snapshot'].sudo().search(
            [('user_id', '=', user.id), ('session_date', '=', day), ('superseded', '=', False)], limit=1)
        image = snap.image.decode() if snap and snap.image else None
        return '\n'.join(lines), image

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
        for t in self._my_tasks(user, limit=None):
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
        clients = sorted(groups, key=lambda c: (c.name or '').lower())
        if len(clients) == 1:
            return self._meet_client_tasks(message, state, user, groups[clients[0]])
        return self._pick_list(message, state, user, {'kind': 'client', 'all': [c.id for c in clients]})

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
        state._touch(staff_action='meet_client')
        return self._pick_list(message, state, user, {'kind': 'task', 'ctx': 'meet_client', 'all': tasks.ids})

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
            if purpose == 'pause':                 # back to "Meeting with whom?"
                return self._fask(message, state, {'at': 'pause_meet'},
                                  _('👥 Meeting with whom?'), self.PAUSE_MEET)
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
        # A task's break still open: split it into the meeting, task stays paused.
        switched = self._switch_open_break(message, state, user, 'meeting', note, picked)
        if switched is not None:
            return switched
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
