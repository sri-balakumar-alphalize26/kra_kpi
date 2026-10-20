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
from types import SimpleNamespace
from urllib.parse import urlencode

from odoo import fields, http
from odoo.http import request

from .kpi_wa_approval import _render

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
        out = []
        if entry.file_name:
            out.append({'name': entry.file_name,
                        'url': '/kpi/wa/task/%s/file?kind=%s&entry=%s&att=0' % (token, kind, entry.id)})
        link = 'progress_id' if kind == 'progress' else 'manual_id'
        for a in request.env['kpi.file.attachment'].sudo().search([(link, '=', entry.id)], order='sequence, id'):
            out.append({'name': a.file_name,
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
        updates = [{
            'who': p.employee_name or p.user_id.name or '', 'when': when(p.create_date),
            'text': p.summary or '', 'files': self._files(token, 'progress', p, 'uploaded_file'),
            'links': _links_of(p.related_links),
        } for p in request.env['kpi.progress'].sudo().search([('kpi_id', '=', task.id)], order='create_date desc')]
        manuals = [{
            'who': mm.uploader_name or mm.uploaded_by.name or '', 'when': when(mm.upload_date),
            'text': mm.description or '', 'files': self._files(token, 'manual', mm, 'manual_file'),
            'links': _links_of(mm.related_links),
        } for mm in request.env['kpi.user.manual'].sudo().search([('kpi_id', '=', task.id)], order='id desc')]
        github = [{'url': g.github_url, 'branch': g.branch_name or '', 'who': g.employee_name or '',
                   'when': when(g.create_date)}
                  for g in request.env['kpi.github.link'].sudo().search([('kpi_id', '=', task.id)], order='id desc')]
        logs = [{'label': label, 'rows': router.log_rows(task, user, key)}
                for key, label, _e in router.LOG_KINDS]
        return {
            'token': token, 'user_name': user.name, 'ok': ok, 'err': err, 'theme': user._kpi_wa_color()[1],
            't': {
                'ref': task.external_ref or '#%s' % task.id, 'name': task.name or '',
                'state': sel('task_state', task.task_state), 'priority': (sel('priority', task.priority) or '').upper(),
                'project': ' › '.join(path), 'deadline': task.deadline.strftime('%d %b %Y') if task.deadline else '—',
                'estimate': '%02d:%02d' % (task.estimate_hours, task.estimate_minutes),
                'spent': '%dh %02dm' % (m // 60, m % 60), 'description': task.description or '',
                'paused_reason': task.paused_reason if task.task_state == 'paused' else '',
            },
            'updates': updates, 'manuals': manuals, 'github': github, 'logs': logs,
            'can_add': task.task_state in ('in_progress', 'paused', 'partially_completed',
                                           'awaiting_client', 'completed'),
            'can_complete': task.task_state in ('in_progress', 'paused', 'hold', 'rework'),
            'checklist': [('verify_github', 'Verify GitHub URL'), ('deployed_task', 'Deployed the task'),
                          ('user_manual', 'User manual uploaded'), ('documentation', 'Documentation submission'),
                          ('tested_code', 'Manually tested the code')],
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

    @http.route('/kpi/wa/task/<string:token>/complete', type='http', auth='public',
                methods=['POST'], csrf=False, website=False)
    def complete(self, token, **post):
        st, user, task = self._resolve(token)
        if not task:
            return self._expired()
        router = request.env['kpi.wa.group.router'].sudo()
        partial = post.get('mode') == 'partial'
        ok, msg = router.page_complete(user, task, request.httprequest.form.getlist('check'), partial)
        if ok:
            self._notify(st, user, ('🏁 %s finished %s as a partial finish — sent for review with the summary.'
                                    if partial else '✅ %s finished %s. It is with a manager to check.')
                         % (user.name, task.external_ref or task.id))
        return self._back(token, ok=msg if ok else '', err='' if ok else msg)

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
        return request.make_response(base64.b64decode(data), headers=[
            ('Content-Type', mime or 'application/octet-stream'),
            ('Content-Disposition', 'inline; filename="%s"' % (name or 'file').replace('"', '')),
            ('Cache-Control', 'no-store'),
        ])
