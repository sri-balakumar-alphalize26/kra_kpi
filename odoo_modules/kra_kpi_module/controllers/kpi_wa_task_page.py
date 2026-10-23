"""WhatsApp "📋 KPI details" -> one task's page in the browser.

The bot sends the developer a private link (/kpi/wa/task/<token>): one person,
one task, 2 hours. The page shows the task like the web app's task panel --
details, updates with their files and links, GitHub links, user manuals, logs --
and lets them add an update, add a user manual, or finish the task. Every save
goes through the same helpers as the WhatsApp poll flow
(kpi.wa.group.router.page_save / page_complete), so the rules cannot drift.

auth='public' like the client approval page: the phone is not logged in to
Odoo; the token is the key, and every file is checked to belong to this task.
"""

import base64
import hmac
import json
import logging
import secrets
from datetime import timedelta
from types import SimpleNamespace
from urllib.parse import urlencode

from odoo import fields, http
from odoo.exceptions import UserError
from odoo.http import request

from .kpi_wa_approval import _render
from .kra_api import serve_file, _guess_mime
from .kpi_client_chat import chat_file_response, chat_upload_files
from ..models.kpi_legacy import is_audio
from ..models.kpi_wa_staff_menu import STARTED_STATES

_logger = logging.getLogger(__name__)


def _page_state(token):
    if not token or len(token) < 16 or len(token) > 64:
        return None
    st = request.env['kpi.wa.group.intake'].sudo().search([('staff_page_token', '=', token)], limit=1)
    if not st or not hmac.compare_digest(st.staff_page_token or '', token):
        return None
    if not st.staff_page_expires or st.staff_page_expires < fields.Datetime.now():
        return None
    if not st.staff_page_kpi_id.exists():
        return None
    return st


def _links_of(raw):
    try:
        val = json.loads(raw or '[]')
    except (TypeError, ValueError):
        return []
    out = []
    for v in val if isinstance(val, list) else []:
        v = v.get('url') if isinstance(v, dict) else v
        if isinstance(v, str) and v.strip():
            out.append(v.strip())
    return out


class KpiWaTaskPage(http.Controller):

    # ---------------------------------------------------------------- helpers
    def _resolve(self, token):
        st = _page_state(token)
        if not st:
            return None, None, None
        router = request.env['kpi.wa.group.router'].sudo()
        user, ok = router._staff_member(st, st.group_id)
        if not ok:
            return None, None, None
        return st, user, st.staff_page_kpi_id.sudo()

    def _expired(self):
        return _render('kra_kpi_module.wa_approval_expired', {
            'reason': 'This task link has expired. Tap 📋 KPI details in WhatsApp for a fresh one.'})

    def _back(self, token, ok='', err=''):
        """The page sends its forms in the background (so a mistake does not
        reload it and throw away the chosen files) and gets JSON back. A plain
        form post -- no JavaScript -- still gets the old redirect."""
        if request.httprequest.headers.get('X-Requested-With') == 'XMLHttpRequest':
            return request.make_json_response({'ok': bool(ok), 'message': ok or err})
        q = urlencode({'ok': ok} if ok else {'err': err})
        return request.redirect('/kpi/wa/task/%s?%s' % (token, q), local=True)

    def _notify(self, st, user, text):
        """A line in the WhatsApp group, as when the same thing is done from a poll."""
        try:
            session = request.env['whatsapp.session'].sudo().search([('status', '=', 'connected')], limit=1)
            if session and st.group_id.jid:
                msg = SimpleNamespace(phone=st.group_id.jid, session_id=session)
                request.env['kpi.wa.group.router'].sudo().with_context(
                    kpi_wa_owner_mark=user._kpi_wa_color()[0])._text(msg, text)
        except Exception as exc:
            _logger.warning('task page WhatsApp note failed: %s', exc)

    def _files(self, token, kind, entry, primary):
        """Each file with its download link and its id on the entry (0 = the
        entry's own file), which the Edit form's "remove" boxes send back."""
        out = []
        if entry.file_name:
            out.append({'name': entry.file_name, 'att': 0,
                        'url': '/kpi/wa/task/%s/file?kind=%s&entry=%s&att=0' % (token, kind, entry.id)})
        link = 'progress_id' if kind == 'progress' else 'manual_id'
        for a in request.env['kpi.file.attachment'].sudo().search([(link, '=', entry.id)], order='sequence, id'):
            out.append({'name': a.file_name, 'att': a.id,
                        'url': '/kpi/wa/task/%s/file?kind=%s&entry=%s&att=%s' % (token, kind, entry.id, a.id)})
        return out

    def _ctx(self, token, st, user, task, ok='', err=''):
        router = request.env['kpi.wa.group.router'].sudo()
        when = lambda dt: router._when(user, dt)  # noqa: E731
        sel = lambda f, v: dict(task._fields[f].selection or []).get(v, v or '')  # noqa: E731
        path, cur = [], task.kra_id
        while cur:
            path.insert(0, cur.name or '')
            cur = cur.parent_id
        spent = task.timer_total_seconds or 0
        if task.timer_start_datetime:
            spent += max(0, (fields.Datetime.now() - task.timer_start_datetime).total_seconds())
        m = int(round(spent / 60.0))
        # Edit / Delete: the board's rule -- own entry or an admin -- and only
        # once the task has started (page_entry checks the same on save).
        started = task.task_state in STARTED_STATES
        admin = router._is_admin(user)
        # Signed off by the client: nothing can be added, edited or deleted
        # (admins excepted) -- kra.kpi._details_locked_for.
        locked = task._details_locked_for(user)
        mine = lambda owner: started and not locked and (admin or owner.id == user.id)  # noqa: E731
        updates = [{
            'id': p.id, 'can': mine(p.user_id) and not p.from_client, 'from_client': p.from_client,
            'who': p.employee_name or p.user_id.name or '', 'when': when(p.create_date),
            'edited': when(p.edited_at) if p.edited_at else '',
            'text': p.summary or '', 'files': self._files(token, 'progress', p, 'uploaded_file'),
            'links': _links_of(p.related_links),
        } for p in request.env['kpi.progress'].sudo().search([('kpi_id', '=', task.id)], order='create_date desc')]
        manuals = [{
            'id': mm.id, 'can': mine(mm.uploaded_by),
            'who': mm.uploader_name or mm.uploaded_by.name or '', 'when': when(mm.upload_date),
            'text': mm.description or '', 'files': self._files(token, 'manual', mm, 'manual_file'),
            'links': _links_of(mm.related_links),
        } for mm in request.env['kpi.user.manual'].sudo().search([('kpi_id', '=', task.id)], order='id desc')]
        github = [{'id': g.id, 'can': mine(g.user_id),
                   'url': g.github_url, 'branch': g.branch_name or '', 'who': g.employee_name or '',
                   'when': when(g.create_date)}
                  for g in request.env['kpi.github.link'].sudo().search([('kpi_id', '=', task.id)], order='id desc')]
        # What the client attached when raising the task gets its own section;
        # "Updates" (and the summary Complete accepts) is the team's work only.
        client_updates = [x for x in updates if x['from_client']]
        updates = [x for x in updates if not x['from_client']]
        # KPI Details of a From-old-DB bug / update (read-only here). Voice notes
        # play through this page's own token links -- the phone is not logged in.
        legacy = task.legacy_details()
        if legacy:
            legacy['voice_notes'] = [f for c in client_updates for f in c['files'] if is_audio(f['name'])]
            legacy['confirmed_on'] = when(task.legacy_confirmed_on) if task.legacy_confirmed_on else ''
        # 👤 Every time the client sent it (kra.kpi.client_sends, the web's Client
        # tab), shown once there is more than one: who refused it and why. The
        # files themselves are in "From the client" below.
        sends = []
        for s in task.client_sends():
            at = lambda v: when(fields.Datetime.to_datetime(v)) if v else ''  # noqa: E731
            sends.append({
                'round': s.get('round'), 'when': at(s.get('sent_at')), 'by': s.get('sent_by') or '',
                'name': s.get('name') or '', 'text': s.get('description') or '',
                'files': len(s.get('files') or []), 'status': s.get('status') or '',
                'refused_by': s.get('refused_by') or '', 'refused_at': at(s.get('refused_at')),
                'reason': s.get('reason') or '',
            })
        if len(sends) < 2:
            sends = []
        logs = [{'label': label, 'rows': router.log_rows(task, user, key)}
                for key, label, _e in router.LOG_KINDS]
        # Under Estimate, as on the board: the original, then each extension
        # "+01:05 → 02:05 · "reason" — who, when" (kpi.action.log estimate_extended).
        est_rows = []
        for r in request.env['kpi.action.log'].sudo().search(
                [('kpi_id', '=', task.id), ('event', '=', 'estimate_extended')], order='id asc'):
            try:
                p = json.loads(r.payload_json or '{}') or {}
            except (TypeError, ValueError):
                p = {}
            est_rows.append({
                'from': p.get('from') or '', 'to': p.get('to') or '',
                'added': '+%02d:%02d' % (int(p.get('added_hours') or 0), int(p.get('added_minutes') or 0)),
                'reason': p.get('reason') or '',
                'who': r.actor_label or (r.actor_user_id.name or ''),
                'when': when(r.create_date),
            })
        est_original = est_rows[0]['from'] if est_rows else ''
        return {
            'token': token, 'user_name': user.name, 'ok': ok, 'err': err, 'theme': user._kpi_wa_color()[1],
            'est_rows': est_rows, 'est_original': est_original,
            't': {
                'ref': task.external_ref or '#%s' % task.id, 'name': task.name or '',
                'state': sel('task_state', task.task_state), 'priority': (sel('priority', task.priority) or '').upper(),
                'project': ' › '.join(path), 'deadline': task.deadline.strftime('%d %b %Y') if task.deadline else '—',
                'estimate': '%02d:%02d' % (task.estimate_hours, task.estimate_minutes),
                'spent': '%dh %02dm' % (m // 60, m % 60), 'description': task.description or '',
                # Rework too: that is where the client's "send back" reason sits.
                'paused_reason': task.paused_reason if task.task_state in ('paused', 'rework') else '',
            },
            # ↩ Every time the client sent it back, with the proof; files open
            # through this page's token (the phone is not logged in).
            'sendbacks': [dict(s, when=when(fields.Datetime.to_datetime(s['at'])) if s['at'] else '')
                          for s in task.sendback_rows(file_url='/kpi/wa/task/%s/sendback/file/%%d' % token)],
            # 👍 The client said finished (or the review timed out): 🏁 Full Complete
            # once the manual / GitHub link are on it (models/kpi_finish.py).
            'finish': {
                'pending': bool(task.full_complete_pending),
                'missing': task._full_complete_missing() if task.full_complete_pending else [],
                'can': bool(task.full_complete_pending) and not task._may_full_complete(user),
                'done': when(task.full_complete_at) if task.full_complete_at else '',
            },
            'updates': updates, 'client_updates': client_updates,
            'legacy': legacy, 'sends': sends,
            'manuals': manuals, 'github': github, 'logs': logs,
            'doubts': router._task_doubts(task, user),
            'chat_waiting': task.chat_waiting(),
            'started': started,
            'locked': locked,
            'can_add': not locked and task.task_state in ('in_progress', 'paused', 'partially_completed',
                                           'awaiting_client', 'completed'),
            'can_complete': task.task_state in ('in_progress', 'paused', 'hold', 'rework'),
            # ⏱️ Ask for more time: pickers instead of typing "2h 30m reason".
            'can_time': not task._may_extend_estimate(user),
            # The board's "Complete This Task" boxes, word for word, pre-ticked
            # the way openCompleteFromCard does (GitHub links -> 1, a manual -> 3, 4).
            'checklist': [
                ('verify_github', '1. Verify GitHub URL', 'All code pushed to the correct repository', bool(github)),
                ('deployed_task', '2. Deployed the Task', 'Deployed to staging/production', False),
                ('user_manual', '3. User Manual Uploaded', 'Documentation uploaded and accessible', bool(manuals)),
                ('documentation', '4. Documentation Submission', 'Technical documentation complete', bool(manuals)),
                ('tested_code', '5. Manually Tested the Code', 'All features tested and working', False),
            ],
            'has_manual': bool(manuals),
            'has_github': bool(github),
            'github_required': task._github_required(),
            'has_update': bool(updates),
            'last_update': updates[0]['text'] if updates else '',
        }

    @staticmethod
    def _uploads():
        return [(f.filename or 'file', f.read(), f.mimetype or '')
                for f in request.httprequest.files.getlist('files') if f and f.filename]

    # ---------------------------------------------------------------- routes
    @http.route('/kpi/wa/task/<string:token>', type='http', auth='public',
                methods=['GET'], csrf=False, website=False)
    def page(self, token, ok='', err='', **kw):
        st, user, task = self._resolve(token)
        if not task:
            return self._expired()
        return _render('kra_kpi_module.wa_task_page', self._ctx(token, st, user, task, ok, err))

    # 💬 Chat with the client (models/kpi_chat.py): the page's chat window
    # loads and sends here, in the background, as JSON.
    def _chat_json(self, task, user, ok=True, message='', token=''):
        Report = request.env['kpi.wa.group.report'].sudo()
        url = '/kpi/wa/task/%s/chat/file/%%d' % token
        locked = task._details_locked_for(user)
        admin = request.env['kra.kpi']._user_is_kpi_admin(user)
        return request.make_json_response({
            'ok': ok, 'message': message,
            'messages': task.chat_rows(viewer=user, file_url=url, admin=admin), 'waiting': task.chat_waiting(),
            'can_send': bool(Report._group_for_kpi(task)),
            'locked': locked, 'can_act': not locked,
            'client': task.client_kra_id.name or task.kra_id.name or ''})

    @http.route('/kpi/wa/task/<string:token>/chat/act', type='http', auth='public',
                methods=['POST'], csrf=False, website=False)
    def chat_act(self, token, **post):
        """Long-press on a bubble: react / edit / delete."""
        st, user, task = self._resolve(token)
        if not task:
            return request.make_json_response({'ok': False, 'message': 'This link has expired.'})
        locked = task._details_locked_for(user)
        if locked:
            return self._chat_json(task, user, ok=False, message=locked, token=token)
        try:
            task.chat_act(post.get('msg_id'), post.get('action') or '', 'u:%d' % user.id,
                          emoji=post.get('emoji'), text=post.get('text'),
                          admin=request.env['kra.kpi']._user_is_kpi_admin(user))
        except Exception as exc:
            return self._chat_json(task, user, ok=False, message=str(exc).strip()[:300], token=token)
        return self._chat_json(task, user, token=token)

    @http.route('/kpi/wa/task/<string:token>/chat', type='http', auth='public',
                methods=['GET'], csrf=False, website=False)
    def chat_list(self, token, visible=None, active=None, **kw):
        st, user, task = self._resolve(token)
        if not task:
            return request.make_json_response({'ok': False, 'message': 'This link has expired.'})
        # ?visible=1: the chat overlay is open and on screen, so the client's
        # messages are now seen (blue ✓✓ on their page).
        # active=1: also touched in the last minute = online.
        if visible:
            task.chat_mark_seen('team', active=bool(active))
        return self._chat_json(task, user, token=token)

    @http.route('/kpi/wa/task/<string:token>/chat/retry', type='http', auth='public',
                methods=['POST'], csrf=False, website=False)
    def chat_retry(self, token, **post):
        st, user, task = self._resolve(token)
        if not task:
            return request.make_json_response({'ok': False, 'message': 'This link has expired.'})
        try:
            task.chat_retry(post.get('message_id'))
        except Exception as exc:
            return self._chat_json(task, user, ok=False, message=str(exc).strip()[:300], token=token)
        return self._chat_json(task, user, token=token)

    @http.route('/kpi/wa/task/<string:token>/chat', type='http', auth='public',
                methods=['POST'], csrf=False, website=False)
    def chat_send(self, token, **post):
        st, user, task = self._resolve(token)
        if not task:
            return request.make_json_response({'ok': False, 'message': 'This link has expired.'})
        locked = task._details_locked_for(user)
        if locked:
            return self._chat_json(task, user, ok=False, message=locked, token=token)
        try:
            # 📎 photos / videos / audio come in the same form, as `files`.
            task.chat_post_team(post.get('text') or '', user, source='wa_page', files=chat_upload_files(),
                                reply_to=post.get('reply_to'))
        except Exception as exc:
            return self._chat_json(task, user, ok=False, message=str(exc).strip()[:300], token=token)
        return self._chat_json(task, user, message='Sent to the client.', token=token)

    @http.route('/kpi/wa/task/<string:token>/chat/file/<int:att_id>', type='http', auth='public',
                methods=['GET'], csrf=False, website=False)
    def chat_file(self, token, att_id, **kw):
        st, user, task = self._resolve(token)
        if not task:
            return request.not_found()
        return chat_file_response(task, att_id)

    @http.route('/kpi/wa/task/<string:token>/update', type='http', auth='public',
                methods=['POST'], csrf=False, website=False)
    def add_update(self, token, **post):
        st, user, task = self._resolve(token)
        if not task:
            return self._expired()
        router = request.env['kpi.wa.group.router'].sudo()
        ok, msg = router.page_save(user, task, 'progress', post.get('summary'), post.get('links'),
                                   post.get('gh_url'), post.get('gh_branch'), self._uploads(),
                                   replace_same=bool(post.get('replace_same')))
        if ok:
            self._notify(st, user, '📝 %s added an update on %s.' % (user.name, task.external_ref or task.id))
        return self._back(token, ok=msg if ok else '', err='' if ok else msg)

    @http.route('/kpi/wa/task/<string:token>/addtime', type='http', auth='public',
                methods=['POST'], csrf=False, website=False)
    def add_time(self, token, **post):
        """⏱️ Ask for more time from the page: hours + minutes + reason."""
        st, user, task = self._resolve(token)
        if not task:
            return self._expired()
        ok, msg = task.extend_estimate(user, post.get('hours'), post.get('minutes'),
                                       post.get('reason'), source='whatsapp')
        return self._back(token, ok=msg if ok else '', err='' if ok else msg)

    @http.route('/kpi/wa/task/<string:token>/manual', type='http', auth='public',
                methods=['POST'], csrf=False, website=False)
    def add_manual(self, token, **post):
        st, user, task = self._resolve(token)
        if not task:
            return self._expired()
        router = request.env['kpi.wa.group.router'].sudo()
        ok, msg = router.page_save(user, task, 'manual', post.get('description'), post.get('links'),
                                   files=self._uploads(), replace_same=bool(post.get('replace_same')))
        if ok:
            self._notify(st, user, '📘 %s added a user manual on %s.' % (user.name, task.external_ref or task.id))
        return self._back(token, ok=msg if ok else '', err='' if ok else msg)

    @http.route('/kpi/wa/task/<string:token>/entry/edit', type='http', auth='public',
                methods=['POST'], csrf=False, website=False)
    def edit_entry(self, token, **post):
        """✏️ Edit an update / manual already on the task (own, or as an admin)."""
        st, user, task = self._resolve(token)
        if not task:
            return self._expired()
        router = request.env['kpi.wa.group.router'].sudo()
        kind = post.get('kind') or ''
        ok, msg = router.page_edit(
            user, task, kind, post.get('entry'),
            summary=post.get('summary') if 'summary' in post else None,
            raw_links=post.get('links') if 'links' in post else None,
            remove=request.httprequest.form.getlist('remove'), files=self._uploads(),
            replace_same=bool(post.get('replace_same')))
        if ok and msg != 'Nothing changed.':
            self._notify(st, user, '✏️ %s edited %s on %s.' % (
                user.name, 'an update' if kind == 'progress' else 'a user manual', task.external_ref or task.id))
        return self._back(token, ok=msg if ok else '', err='' if ok else msg)

    @http.route('/kpi/wa/task/<string:token>/entry/delete', type='http', auth='public',
                methods=['POST'], csrf=False, website=False)
    def delete_entry(self, token, **post):
        """🗑️ Delete an update / manual / GitHub link (own, or as an admin)."""
        st, user, task = self._resolve(token)
        if not task:
            return self._expired()
        router = request.env['kpi.wa.group.router'].sudo()
        kind = post.get('kind') or ''
        ok, msg = router.page_delete(user, task, kind, post.get('entry'))
        if ok:
            self._notify(st, user, '🗑️ %s deleted %s on %s.' % (
                user.name, {'progress': 'an update', 'manual': 'a user manual', 'github': 'a GitHub link'}.get(kind, 'an item'),
                task.external_ref or task.id))
        return self._back(token, ok=msg if ok else '', err='' if ok else msg)

    @http.route('/kpi/wa/task/<string:token>/complete', type='http', auth='public',
                methods=['POST'], csrf=False, website=False)
    def complete(self, token, **post):
        st, user, task = self._resolve(token)
        if not task:
            return self._expired()
        router = request.env['kpi.wa.group.router'].sudo()
        partial = post.get('mode') == 'partial'
        ok, msg = router.page_complete(
            user, task, request.httprequest.form.getlist('check'), partial,
            summary=post.get('summary'), raw_links=post.get('links'),
            gh_url=post.get('gh_url'), gh_branch=post.get('gh_branch'),
            # Partial finish needs no manual; files chosen there are not sent.
            files=[] if partial else self._uploads())
        if ok:
            self._notify(st, user, ('🏁 %s finished %s as a partial finish — sent for review with the summary.'
                                    if partial else '✅ %s finished %s. It is with a manager to check.')
                         % (user.name, task.external_ref or task.id))
        return self._back(token, ok=msg if ok else '', err='' if ok else msg)

    @http.route('/kpi/wa/task/<string:token>/full_complete', type='http', auth='public',
                methods=['POST'], csrf=False, website=False)
    def full_complete(self, token, **post):
        """🏁 Full Complete from the page the developer's WhatsApp message opens."""
        st, user, task = self._resolve(token)
        if not task:
            return self._expired()
        try:
            task.full_complete(user=user, source='wa_page')
        except UserError as exc:
            return self._back(token, err=str(exc))
        return self._back(token, ok='🏁 %s is fully complete — it moves to billing.'
                          % (task.external_ref or task.id))

    # ------------------------------------------------- 📂 My work (projects & documents)
    def _my_ctx(self, token, user):
        router = request.env['kpi.wa.group.router'].sudo()
        tasks = request.env['kra.kpi'].sudo().browse(router.my_task_ids(user)).exists()
        when = lambda dt: router._when_short(user, dt) if dt else ''  # noqa: E731
        groups = [('running', '▶️ Running', ('in_progress',)), ('paused', '⏸️ Paused', ('paused',)),
                  ('review', '👁️ In review', ('partially_completed', 'awaiting_client')),
                  ('done', '🏁 Done', ('completed',))]
        projects = {}
        for t in tasks:
            path, cur = [], t.kra_id
            while cur:
                path.insert(0, cur.name or '')
                cur = cur.parent_id
            key = t.kra_id.id or 0
            p = projects.setdefault(key, {'name': ' › '.join(path) or 'No project', 'tasks': [],
                                          'counts': {g: 0 for g, _l, _s in groups + [('todo', '', ())]}})
            bucket = next((g for g, _l, sts in groups if t.task_state in sts), 'todo')
            p['counts'][bucket] += 1
            p['tasks'].append({'ref': t.external_ref or '#%s' % t.id, 'name': t.name or '', 'bucket': bucket,
                               'state': dict(t._fields['task_state'].selection).get(t.task_state, t.task_state),
                               'url': '/kpi/wa/my/%s/task/%s' % (token, t.id)})
        docs = []
        for t in tasks:
            for f in router._task_files(t, user):
                docs.append({'name': f['name'], 'ref': t.external_ref or '#%s' % t.id, 'task': t.name or '',
                             'who': f['who'] or '', 'when': when(f['when']), 'sort': f['when'] or fields.Datetime.now(),
                             'kind': '📘' if f['kind'] == 'manual' else '📎',
                             'url': '/kpi/wa/my/%s/file?kind=%s&entry=%s&att=%s' % (token, f['kind'], f['entry'], f['att'])})
            for g in request.env['kpi.github.link'].sudo().search([('kpi_id', '=', t.id)]):
                docs.append({'name': '%s (%s)' % (g.github_url, g.branch_name or ''), 'ref': t.external_ref or '#%s' % t.id,
                             'task': t.name or '', 'who': g.employee_name or '', 'when': when(g.create_date),
                             'sort': g.create_date or fields.Datetime.now(), 'kind': '🐙', 'url': g.github_url})
        docs.sort(key=lambda x: x['sort'], reverse=True)
        plist = sorted(projects.values(), key=lambda p: (-(p['counts']['running'] + p['counts']['paused']),
                                                          -len(p['tasks']), p['name']))
        return {'token': token, 'user_name': user.name, 'theme': user._kpi_wa_color()[1],
                'projects': plist, 'groups': [(g, l) for g, l, _s in groups] + [('todo', '📝 To do')],
                'docs': docs, 'task_count': len(tasks)}

    @http.route('/kpi/wa/my/<string:token>', type='http', auth='public', methods=['GET'], csrf=False, website=False)
    def my_work(self, token, **kw):
        st, user = request.env['kpi.wa.group.router'].sudo().my_work_resolve(token)
        if not user:
            return _render('kra_kpi_module.wa_approval_expired', {
                'reason': 'This link has expired. Tap 📋 My tasks → 📂 Projects & documents in WhatsApp for a fresh one.'})
        return _render('kra_kpi_module.wa_my_work', self._my_ctx(token, user))

    @http.route('/kpi/wa/my/<string:token>/task/<int:kpi_id>', type='http', auth='public', methods=['GET'],
                csrf=False, website=False)
    def my_work_task(self, token, kpi_id, **kw):
        """A task on the My-work page → that task's own page (a fresh task link,
        the same thing 📋 KPI details would send)."""
        router = request.env['kpi.wa.group.router'].sudo()
        st, user = router.my_work_resolve(token)
        if not user or kpi_id not in router.my_task_ids(user):
            return request.not_found()
        tok = secrets.token_urlsafe(24)
        st.sudo().write({'staff_page_token': tok, 'staff_page_kpi_id': kpi_id,
                         'staff_page_expires': fields.Datetime.now() + timedelta(hours=2)})
        return request.redirect('/kpi/wa/task/%s' % tok, local=True)

    @http.route('/kpi/wa/my/<string:token>/file', type='http', auth='public', methods=['GET'], csrf=False,
                website=False)
    def my_work_file(self, token, kind='', entry='0', att='0', **kw):
        router = request.env['kpi.wa.group.router'].sudo()
        st, user = router.my_work_resolve(token)
        if not user:
            return request.not_found()
        return self._send_file(kind, entry, att, set(router.my_task_ids(user)), kw.get('download'))

    def _send_file(self, kind, entry, att, allowed_task_ids, download=None):
        """One file of a progress update / manual, only if its task is allowed."""
        model, field = {'progress': ('kpi.progress', 'uploaded_file'),
                        'manual': ('kpi.user.manual', 'manual_file')}.get(kind, (None, None))
        if not model:
            return request.not_found()
        rec = request.env[model].sudo().browse(int(entry or 0)).exists()
        if not rec or rec.kpi_id.id not in allowed_task_ids:
            return request.not_found()
        if int(att or 0):
            link = 'progress_id' if kind == 'progress' else 'manual_id'
            a = request.env['kpi.file.attachment'].sudo().browse(int(att)).exists()
            if not a or a[link] != rec:
                return request.not_found()
            data, name, mime = a.file, a.file_name, a.mimetype
        else:
            data, name, mime = rec[field], rec.file_name, None
        if not data:
            return request.not_found()
        # Its real type and Range support, so it opens in the View popup (and a
        # video can be seeked) instead of the phone downloading it.
        return serve_file(base64.b64decode(data), name or 'file', _guess_mime(name, mime or ''),
                          inline=download not in ('1', 'true'))

    @http.route('/kpi/wa/task/<string:token>/file', type='http', auth='public',
                methods=['GET'], csrf=False, website=False)
    def file(self, token, kind='', entry='0', att='0', **kw):
        st, user, task = self._resolve(token)
        if not task:
            return request.not_found()
        model, field = {'progress': ('kpi.progress', 'uploaded_file'),
                        'manual': ('kpi.user.manual', 'manual_file')}.get(kind, (None, None))
        if not model:
            return request.not_found()
        rec = request.env[model].sudo().browse(int(entry or 0)).exists()
        if not rec or rec.kpi_id != task:          # only this task's files
            return request.not_found()
        if int(att or 0):
            link = 'progress_id' if kind == 'progress' else 'manual_id'
            a = request.env['kpi.file.attachment'].sudo().browse(int(att)).exists()
            if not a or a[link] != rec:
                return request.not_found()
            data, name, mime = a.file, a.file_name, a.mimetype
        else:
            data, name, mime = rec[field], rec.file_name, None
        if not data:
            return request.not_found()
        # Its real type and Range support, so it opens in the View popup (and a
        # video can be seeked) instead of the phone downloading it.
        return serve_file(base64.b64decode(data), name or 'file', _guess_mime(name, mime or ''),
                          inline=kw.get('download') not in ('1', 'true'))
