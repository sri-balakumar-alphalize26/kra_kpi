"""KPI Details of a bug / update about an OLD database requirement
(models/kpi_legacy.py): read the card, save it, and the admins' Needs linking
list. One set of routes for web, the app and the Odoo screens."""

import logging

from odoo import http
from odoo.exceptions import AccessError, UserError
from odoo.http import request

from ..models.kpi_legacy import is_audio

_logger = logging.getLogger(__name__)


def _may_edit(user):
    """Admins / owners and managers fill in the details. Clients only read."""
    Kpi = request.env['kra.kpi'].sudo()
    return bool(Kpi._user_is_kpi_admin(user) or user.has_group('kra_kpi_module.group_kra_manager'))


def _readable(kpi_id):
    """The task, if the caller may see it (record rules apply), else None."""
    try:
        kpi = request.env['kra.kpi'].browse(int(kpi_id or 0)).exists()
        if not kpi:
            return None
        kpi.check_access('read')
        return kpi
    except (AccessError, TypeError, ValueError):
        return None


def _voice_notes(kpi):
    """The audio the client attached, playable in the card."""
    out = []
    Att = request.env['kpi.file.attachment'].sudo()
    for p in request.env['kpi.progress'].sudo().search([('kpi_id', '=', kpi.id)], order='id'):
        if p.file_name and is_audio(p.file_name):
            out.append({'name': p.file_name, 'url': '/kpi/progress/view?progress_id=%s' % p.id})
        for a in Att.search([('progress_id', '=', p.id)], order='sequence, id'):
            if is_audio(a.file_name, a.mimetype):
                out.append({'name': a.file_name,
                            'url': '/kpi/attachment/download?attachment_id=%s' % a.id})
    return out


def _edit_state(kpi, user):
    """(can_edit, locked_reason) for the KPI Details card: managers only, and
    not once the task is fully completed (admins excepted)."""
    locked = kpi.sudo()._details_locked_for(user)
    return bool(_may_edit(user) and not locked), locked or ''


def _card(kpi):
    data = kpi.sudo().legacy_details()
    if not data:
        return False
    data['voice_notes'] = _voice_notes(kpi)
    return data


class KpiLegacyAPI(http.Controller):

    @http.route('/kra_kpi/legacy/get', type='json', auth='user', methods=['POST'], csrf=False)
    def legacy_get(self, kpi_id=None, **kw):
        kpi = _readable(kpi_id)
        if not kpi:
            return {'status': False, 'message': 'Task not found.'}
        can_edit, locked = _edit_state(kpi, request.env.user)
        return {'status': True, 'legacy': _card(kpi), 'can_edit': can_edit, 'locked_reason': locked}

    @http.route('/kra_kpi/legacy/save', type='json', auth='user', methods=['POST'], csrf=False)
    def legacy_save(self, kpi_id=None, ref=None, name=None, note=None, **kw):
        """Save the KPI Details. A Request ID links the task under that old
        requirement and marks it Confirmed with client."""
        if not _may_edit(request.env.user):
            return {'status': False, 'message': 'Only an admin or manager can fill in KPI Details.'}
        kpi = _readable(kpi_id)
        if not kpi:
            return {'status': False, 'message': 'Task not found.'}
        try:
            with request.env.cr.savepoint():
                kpi.sudo().legacy_save_details(ref=ref, name=name, note=note, user=request.env.user)
        except UserError as exc:
            return {'status': False, 'message': str(exc)}
        kpi.sudo()._log_action('legacy_details_saved', source='web', payload={
            'ref': kpi.sudo().legacy_req_ref or '', 'new_ref': kpi.sudo().external_ref or ''})
        return {'status': True, 'legacy': _card(kpi), 'ref': kpi.sudo().external_ref or '',
                'message': 'KPI Details saved.'}

    @http.route('/kra_kpi/client_sends', type='json', auth='user', methods=['POST'], csrf=False)
    def client_sends(self, kpi_id=None, **kw):
        """The task's Client tab: every time the client sent it, oldest first,
        each with its files and -- for a refused one -- who refused and why."""
        kpi = _readable(kpi_id)
        if not kpi:
            return {'status': False, 'message': 'Task not found.'}
        sends = kpi.sudo().client_sends()
        for s in sends:
            for f in s.get('files', []):
                f['url'] = ('/kpi/attachment/download?attachment_id=%s' % f['att'] if f['att']
                            else '/kpi/progress/view?progress_id=%s' % f['entry'])
        can_edit, locked = _edit_state(kpi, request.env.user)
        return {'status': True, 'sends': sends, 'legacy': _card(kpi),
                'can_edit': can_edit, 'locked_reason': locked}

    @http.route('/kra_kpi/legacy/pending', type='json', auth='user', methods=['POST'], csrf=False)
    def legacy_pending(self, client_kra_id=None, **kw):
        """Needs linking: From-old-DB tasks still waiting for their Request ID,
        oldest first."""
        if not _may_edit(request.env.user):
            return {'status': False, 'message': 'Only an admin or manager can see this list.'}
        dom = [('legacy_req_link', '=', True), ('is_legacy', '=', False),
               ('legacy_status', '=', 'pending')]
        if client_kra_id:
            dom.append(('client_kra_id', '=', int(client_kra_id)))
        rows = request.env['kra.kpi'].sudo().search(dom, order='create_date asc', limit=500)
        return {'status': True, 'tasks': [{
            'id': k.id, 'ref': k.external_ref or '', 'name': k.name or '',
            'client': k.client_kra_id.name or '', 'client_id': k.client_kra_id.id or False,
            'db': k.client_db_id.db_name or '',
            'legacy_name': k.legacy_req_name or '',
            'note': k.legacy_note or '', 'transcript': k.legacy_transcript or '',
            'voice_notes': _voice_notes(k),
            'by': k.submitted_by_uid.name or k.create_uid.name or '',
            'date': k.create_date.strftime('%d-%m-%Y') if k.create_date else '',
            'state': k.task_state or '',
        } for k in rows]}
