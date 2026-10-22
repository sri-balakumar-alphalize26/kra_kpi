"""The client's chat page for one task (/kpi/wa/chat/<token>).

Sent in the client's WhatsApp group when a manager hands their 💬 Discuss
question to a developer (kpi_chat.chat_ask_developer). It shows THAT chat and
nothing else -- the reference, the title and the messages with their times.
No hours, people, files or notes: KPI details are for the team only. Team
messages read "Our team", never a name.

auth='public' like the other WhatsApp pages: the phone opening the link is
not logged in. The token is the key and it lasts CLIENT_CHAT_HOURS.
"""

import hmac
import logging

from odoo import fields, http
from odoo.exceptions import UserError
from odoo.http import request

from .kpi_wa_approval import _render
from ..models.kpi_chat import CLIENT_CHAT_HOURS

_logger = logging.getLogger(__name__)


def _task_for(token):
    """The task this chat link opens, while it is still valid."""
    if not token or len(token) < 16 or len(token) > 64:
        return None
    kpi = request.env['kra.kpi'].sudo().with_context(active_test=False).search(
        [('client_chat_token', '=', token)], limit=1)
    if not kpi or not hmac.compare_digest(kpi.client_chat_token or '', token):
        return None
    if not kpi.client_chat_expires or kpi.client_chat_expires < fields.Datetime.now():
        return None
    return kpi


def _rows(kpi):
    """The thread as the client may see it: no staff names."""
    return [{'id': r['id'], 'side': r['side'], 'body': r['body'], 'at': r['at'],
             'who': r['who'] if r['side'] == 'client' else 'Our team'}
            for r in kpi.chat_rows(limit=200)]


class KpiClientChat(http.Controller):

    def _expired(self):
        return _render('kra_kpi_module.wa_approval_expired', {
            'meta': 'This chat link can no longer be used.',
            'reason': 'Chat links last %d hours.' % CLIENT_CHAT_HOURS,
            'hint': 'Send “hi” in your WhatsApp group and choose 💬 Discuss to write to us again.'})

    @http.route('/kpi/wa/chat/<string:token>', type='http', auth='public',
                methods=['GET'], csrf=False, website=False)
    def page(self, token, **kw):
        kpi = _task_for(token)
        if not kpi:
            return self._expired()
        return _render('kra_kpi_module.wa_client_chat', {
            'token': token, 'ref': kpi._chat_ref(), 'title': kpi.name or '',
            'client': kpi.client_kra_id.name or kpi.kra_id.name or '',
            'expires': fields.Datetime.to_string(kpi.client_chat_expires),
        })

    @http.route('/kpi/wa/chat/<string:token>/rows', type='json', auth='public',
                methods=['POST'], csrf=False)
    def rows(self, token, **kw):
        kpi = _task_for(token)
        if not kpi:
            return {'ok': False, 'expired': True}
        return {'ok': True, 'rows': _rows(kpi)}

    @http.route('/kpi/wa/chat/<string:token>/send', type='json', auth='public',
                methods=['POST'], csrf=False)
    def send(self, token, text='', name='', **kw):
        kpi = _task_for(token)
        if not kpi:
            return {'ok': False, 'expired': True}
        name = ' '.join((name or '').split())[:60]
        if not name:
            return {'ok': False, 'message': 'Type your name first.'}
        try:
            kpi.chat_post_client(text, name=name, source='client_page')
        except UserError as exc:
            return {'ok': False, 'message': str(exc)}
        except Exception as exc:
            _logger.exception('client chat send failed for %s: %s', kpi.id, exc)
            return {'ok': False, 'message': 'Sorry — that could not be sent. Please try again.'}
        return {'ok': True, 'rows': _rows(kpi)}
