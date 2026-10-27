"""WhatsApp "➕ Create my own task" -> the New Task form as a web page.

The bot sends the developer a private link (/kpi/wa/newtask/<token>): one
person, one use, 30 minutes. The page has the board's New Task fields; Create
calls kra.kpi.self_create_task as that developer -- the same rules and record
as the board -- and the bot then shows the new task back in the WhatsApp group
with its menu. Admin acceptance and client approval follow as for any
self-created task.

auth='public' like the client approval page (kpi_wa_approval.py): the phone
opening the link is not logged in to Odoo. The token is the key.
"""

import hmac
import logging
from types import SimpleNamespace

from odoo import fields, http
from odoo.http import request

from .kpi_wa_approval import _render

_logger = logging.getLogger(__name__)


def _state_for(token):
    """The WhatsApp conversation this link belongs to, if still valid."""
    if not token or len(token) < 16 or len(token) > 64:
        return None
    st = request.env['kpi.wa.group.intake'].sudo().search(
        [('staff_form_token', '=', token)], limit=1)
    if not st or not hmac.compare_digest(st.staff_form_token or '', token):
        return None
    if not st.staff_form_expires or st.staff_form_expires < fields.Datetime.now():
        return None
    return st


def _clients_projects():
    """Client (top-level KRA) and Project / version (everything under it), as
    the web's New Task dialog offers them. A client with nothing under it is
    its own only project."""
    Kra = request.env['kra.master'].sudo()
    clients, projects = [], []
    for root in Kra.search([('parent_id', '=', False)]).sorted(lambda r: (r.name or '').lower()):
        clients.append({'id': root.id, 'name': root.name or ''})
        under = Kra.search([('id', 'child_of', root.id), ('id', '!=', root.id)])
        rows = []
        for k in (under or root):
            path, cur = [], k
            while cur and cur != root:
                path.insert(0, cur.name or '')
                cur = cur.parent_id
            rows.append({'id': k.id, 'client_id': root.id, 'display': ' › '.join(path) or (root.name or '')})
        projects += sorted(rows, key=lambda p: p['display'].lower())
    return clients, projects


class KpiWaTaskForm(http.Controller):

    def _user(self, st):
        router = request.env['kpi.wa.group.router'].sudo()
        user, ok = router._staff_member(st, st.group_id)
        return user if ok else None

    def _expired(self):
        return _render('kra_kpi_module.wa_approval_expired', {
            'reason': 'This new-task link has expired or was already used. '
                      'Tap ➕ Create my own task in WhatsApp for a fresh one.'})

    @http.route('/kpi/wa/newtask/<string:token>', type='http', auth='public',
                methods=['GET'], csrf=False, website=False)
    def form(self, token, **kw):
        st = _state_for(token)
        user = st and self._user(st)
        if not user:
            return self._expired()
        clients, projects = _clients_projects()
        return _render('kra_kpi_module.wa_task_form', {
            'token': token, 'user_name': user.name, 'clients': clients, 'projects': projects,
            'values': {}, 'error': '', 'theme': user._kpi_wa_color()[1]})

    @http.route('/kpi/wa/newtask/<string:token>/create', type='http', auth='public',
                methods=['POST'], csrf=False, website=False)
    def create(self, token, **post):
        st = _state_for(token)
        user = st and self._user(st)
        if not user:
            return self._expired()
        deliverable = request.httprequest.form.getlist('deliverable_type')
        values = dict(post, deliverable=deliverable)
        err = ''
        try:
            minutes = int(post.get('estimate_minutes') or 0)
            hours = int(post.get('estimate_hours') or 0)
        except ValueError:
            hours = minutes = -1
        # The board's own checks (kpi_action.js submitNewTask), then the model's.
        if not (post.get('name') or '').strip():
            err = 'Please enter a task name.'
        elif not post.get('kra_id'):
            err = 'Please choose a client and project.'
        elif not deliverable:
            err = 'Tick at least one type — Module, App, EXE or Other.'
        elif 'other' in deliverable and not (post.get('deliverable_other') or '').strip():
            err = 'Type what the Other type is (e.g. Plugin, Website).'
        elif hours < 0 or not 0 <= minutes <= 59:
            err = 'Estimate: whole hours, and minutes 0–59.'
        res = None
        if not err:
            res = request.env['kra.kpi'].with_user(user).self_create_task({
                'name': post.get('name'), 'kra_id': post.get('kra_id'),
                'estimate_hours': hours, 'estimate_minutes': minutes,
                'priority': post.get('priority') or 'regular',
                'doc_type': post.get('doc_type') or 'requirement',
                'description': post.get('description') or '',
                'deliverable_type': deliverable,
                'deliverable_other': post.get('deliverable_other') or '',
            })
            if not res or not res.get('status'):
                err = (res or {}).get('message') or 'Could not create the task.'
        if err:
            clients, projects = _clients_projects()
            return _render('kra_kpi_module.wa_task_form', {
                'token': token, 'user_name': user.name, 'clients': clients, 'projects': projects,
                'values': values, 'error': err, 'theme': user._kpi_wa_color()[1]})

        # One use: the link stops working the moment the task exists.
        st.sudo().write({'staff_form_token': False, 'staff_form_expires': False})
        task = request.env['kra.kpi'].sudo().browse(res['id'])
        self._show_in_whatsapp(st, user, task)
        return _render('kra_kpi_module.wa_task_form_done', {
            'ref': task.external_ref or '', 'name': task.name or '', 'theme': user._kpi_wa_color()[1]})

    def _show_in_whatsapp(self, st, user, task):
        """Back in the group: say it was created and open its task menu."""
        try:
            session = request.env['whatsapp.session'].sudo().search(
                [('status', '=', 'connected')], limit=1)
            if not session or not st.group_id.jid:
                return
            msg = SimpleNamespace(phone=st.group_id.jid, session_id=session, message='',
                                  message_type='text', interactive_reply_id='')
            router = request.env['kpi.wa.group.router'].sudo().with_context(
                kpi_wa_state_id=st.id, kpi_wa_owner_name=user.name or '',
                kpi_wa_owner_mark=user._kpi_wa_color()[0])
            router._text(msg, '✅ %s, your task %s — "%s" is created.\n⏳ %s. You can start '
                              'once it is approved, then the client approves it.'
                         % (user.name or '', task.external_ref or '', task.name or '',
                            task.approval_stage_label or 'Waiting for approval'))
            st.sudo()._reset()
            router._staff_offer_actions(msg, st, task)
        except Exception as exc:
            _logger.warning('new task created but WhatsApp follow-up failed: %s', exc)
