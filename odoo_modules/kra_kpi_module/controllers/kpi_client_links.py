# -*- coding: utf-8 -*-
"""The client's WhatsApp-only features, for a logged-in client.

The Odoo client dashboard, the web portal and the phone app open the SAME
pages a client gets from their WhatsApp group, so every screen behaves the
same:

  * 🔧 Fix a declined request -> /kpi/wa/fix/<token>     (kpi_decline.fix_url)
  * 🗄️ New / 💥 Destroy a database -> /kpi/wa/client/<token>
        (the 30-minute form link kpi_wa_group_intake._client_form_begin posts)
  * 📋 Live databases -> listed here (WhatsApp shows them as polls, no page)
  * 💬 Chat with the team -> /kpi/wa/chat/<token>        (kpi_chat._client_chat_link)

Fix and the database forms belong to the client's WhatsApp group (the form
files the request under it and posts the receipt there), so they are offered
only when the client has one.
"""
import logging
import secrets
from datetime import timedelta

from odoo import fields, http
from odoo.http import request

from ..models.kpi_wa_group_intake import CLIENT_FORM_TTL_MINUTES

_logger = logging.getLogger(__name__)

DB_FORM_KINDS = ('newdb', 'dbdisconnect')


def _client_kras():
    """The root KRAs the logged-in user is a client of."""
    return request.env['kra.master'].sudo().search(
        [('client_user_ids', 'in', [request.env.user.id])])


def _group_for(kra):
    return request.env['kpi.wa.group'].sudo().search(
        [('kra_id', '=', kra.id), ('active', '=', True), ('is_staff_group', '=', False)], limit=1)


def _when(dt):
    return fields.Datetime.to_string(dt) if dt else ''


class KpiClientLinks(http.Controller):

    def _scope(self):
        kras = _client_kras()
        ids = set()
        for k in kras:
            ids.update(k._get_descendant_ids())
        return kras, ids

    @http.route('/kpi_client_portal/links/info', type='json', auth='user', methods=['POST'], csrf=False)
    def links_info(self, **kw):
        """What to offer: the declined requests that can be fixed, the live
        databases, and whether the client has a WhatsApp group.
        -> {status, has_group, declined:[{id, ref, name, reason, declined_at,
            declined_by, url}], live_dbs:[{id, name, label, server, created,
            expires}], can_destroy}"""
        try:
            kras, ids = self._scope()
            if not kras:
                return {'status': False, 'message': 'You are not linked to a client.'}
            has_group = any(_group_for(k) for k in kras)
            declined = []
            if has_group and ids:
                rows = request.env['kra.kpi'].sudo().with_context(active_test=False).search(
                    [('kra_id', 'in', list(ids)), ('client_fix_token', '!=', False)],
                    order='declined_at desc', limit=50)
                for k in rows:
                    declined.append({
                        'id': k.id, 'ref': k.external_ref or '', 'name': k.name or '',
                        'reason': k.decline_note or '',
                        'declined_at': _when(k.declined_at),
                        'declined_by': k.declined_by_id.name or '',
                        'url': k.fix_url(),
                    })
            Db = request.env['kpi.client.db'].sudo()
            dbs = Db.search([('client_kra_id', 'in', kras.ids), ('state', '=', 'live')])
            live = [{
                'id': d.id, 'name': d.db_name or '', 'label': d.label or '',
                'server': d.server_id.poll_label() if d.server_id else '',
                'created': fields.Date.to_string(d.activated_on or (d.first_seen_at and d.first_seen_at.date()))
                if (d.activated_on or d.first_seen_at) else '',
                'expires': fields.Date.to_string(d.expires_on) if d.track_term and d.expires_on else '',
            } for d in dbs]
            return {'status': True, 'has_group': has_group, 'declined': declined,
                    'live_dbs': live, 'can_destroy': has_group and bool(live)}
        except Exception as e:
            _logger.warning('client links info failed: %s', e)
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_portal/links/db_form', type='json', auth='user', methods=['POST'], csrf=False)
    def links_db_form(self, kind='', **kw):
        """A fresh 30-minute link to the New / Destroy database form, the same
        link the WhatsApp menu posts (kpi_wa_group_intake._client_form_begin).
        -> {status, url}"""
        try:
            if kind not in DB_FORM_KINDS:
                return {'status': False, 'message': 'Unknown form.'}
            kras, _ids = self._scope()
            group = next((g for g in (_group_for(k) for k in kras) if g), None)
            if not group:
                return {'status': False, 'message': 'Your WhatsApp group is not linked yet. Ask the team.'}
            user = request.env.user
            # The request is credited to a group member (kpi_wa_group_intake._member_for
            # matches the key); a client with no member row still gets the form.
            member = request.env['kpi.wa.group.member'].sudo().search(
                [('group_id', '=', group.id), ('user_id', '=', user.id)], limit=1)
            key = (member.lid or member.phone) if member else 'web-%s' % user.id
            state = request.env['kpi.wa.group.intake'].sudo()._get_or_create(group, key, user.name or '')
            token = secrets.token_urlsafe(24)
            state._reset()
            state.sudo().write({
                'client_form_token': token, 'client_form_kind': kind,
                'client_form_fix_kpi_id': False,
                'client_form_expires': fields.Datetime.now() + timedelta(minutes=CLIENT_FORM_TTL_MINUTES)})
            base = request.env['whatsapp.config'].sudo().get_config().get_kpi_public_base_url()
            return {'status': True, 'url': '%s/kpi/wa/client/%s' % (base, token)}
        except Exception as e:
            _logger.warning('client db form link failed: %s', e)
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_portal/links/chat', type='json', auth='user', methods=['POST'], csrf=False)
    def links_chat(self, kpi_id=None, **kw):
        """The client chat page (24 h link, kpi_chat._client_chat_link): about
        one of their tasks, or with no kpi_id the general questions thread.
        -> {status, url}"""
        try:
            kras, ids = self._scope()
            if not kras:
                return {'status': False, 'message': 'You are not linked to a client.'}
            Kpi = request.env['kra.kpi'].sudo().with_context(active_test=False)
            if kpi_id:
                task = Kpi.browse(int(kpi_id)).exists()
                if not task or task.kra_id.id not in ids:
                    return {'status': False, 'message': 'Task not found.'}
            else:
                task = Kpi._chat_general_task(kras[0])
            return {'status': True, 'url': task._client_chat_link()}
        except Exception as e:
            _logger.warning('client chat link failed: %s', e)
            return {'status': False, 'message': str(e)}
