import base64
import logging

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)


class WhatsAppController(http.Controller):
    """
    HTTP endpoints for WhatsApp functionality.
    Used by the JS widget to poll QR status and for external integrations.
    """

    @http.route(
        '/whatsapp/qr/status/<int:session_id>',
        type='jsonrpc', auth='user', methods=['POST'],
    )
    def qr_status(self, session_id, **kwargs):
        """
        Poll endpoint for QR code status.
        Returns current status and QR image if available.
        Falls back to database when in-memory state is unavailable
        (handles multi-worker Odoo deployments).
        """
        from odoo.addons.whatsapp_neonize.models.whatsapp_session import (
            _wa_status, _wa_qr_image,
        )

        session = request.env['whatsapp.session'].browse(session_id)
        if not session.exists():
            return {'status': 'error', 'message': 'Session not found'}

        # Prefer in-memory status; fall back to DB status
        # (in-memory may be empty when a different worker handled the connect)
        mem_status = _wa_status.get(session_id) or session.status
        result = {
            'status': mem_status,
            'session_id': session_id,
        }

        if mem_status == 'waiting_qr':
            # Try in-memory QR first (same worker), then fall back to DB
            qr = _wa_qr_image.get(session_id)
            if qr:
                result['qr_image'] = (
                    qr.decode('utf-8') if isinstance(qr, bytes) else qr
                )
            elif session.qr_image:
                # DB fallback — critical for multi-worker servers
                result['qr_image'] = (
                    session.qr_image.decode('utf-8')
                    if isinstance(session.qr_image, bytes)
                    else session.qr_image
                )

        return result

    @http.route(
        '/whatsapp/qr/image/<int:session_id>',
        type='http', auth='user', methods=['GET'],
    )
    def qr_image(self, session_id, **kwargs):
        """Serve the QR code as a PNG image."""
        from odoo.addons.whatsapp_neonize.models.whatsapp_session import (
            _wa_qr_image,
        )

        qr = _wa_qr_image.get(session_id)
        if qr:
            image_data = base64.b64decode(qr)
            return request.make_response(
                image_data,
                headers=[
                    ('Content-Type', 'image/png'),
                    ('Cache-Control',
                     'no-cache, no-store, must-revalidate'),
                ],
            )
        # 1x1 transparent pixel fallback
        pixel = base64.b64decode(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
            'AAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
        )
        return request.make_response(
            pixel, headers=[('Content-Type', 'image/png')]
        )

    @http.route(
        '/whatsapp/send',
        type='jsonrpc', auth='user', methods=['POST'],
    )
    def send_message(self, **kwargs):
        """
        API endpoint to send WhatsApp message.

        POST /whatsapp/send
        Body: {
            "phone": "919876543210",
            "message": "Hello!",
            "session_id": 1  (optional)
        }
        """
        phone = kwargs.get('phone', '')
        message = kwargs.get('message', '')
        session_id = kwargs.get('session_id')

        if not phone or not message:
            return {
                'success': False,
                'error': 'Phone and message are required',
            }

        try:
            if session_id:
                session = request.env['whatsapp.session'].browse(
                    int(session_id)
                )
            else:
                session = request.env['whatsapp.session'].search(
                    [('status', '=', 'connected')], limit=1
                )

            if not session:
                return {
                    'success': False,
                    'error': 'No connected WhatsApp session',
                }

            session.send_message(phone, message)
            return {'success': True, 'message': 'Message sent'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    @http.route(
        '/whatsapp/send/document',
        type='jsonrpc', auth='user', methods=['POST'],
    )
    def send_document(self, **kwargs):
        """
        API endpoint to send a document via WhatsApp.

        POST /whatsapp/send/document
        Body: {
            "phone": "919876543210",
            "file_base64": "...",
            "filename": "invoice.pdf",
            "caption": "Your invoice",
            "session_id": 1  (optional)
        }
        """
        phone = kwargs.get('phone', '')
        file_b64 = kwargs.get('file_base64', '')
        filename = kwargs.get('filename', 'document')
        caption = kwargs.get('caption', '')
        session_id = kwargs.get('session_id')

        if not phone or not file_b64:
            return {
                'success': False,
                'error': 'Phone and file_base64 are required',
            }

        try:
            file_data = base64.b64decode(file_b64)

            if session_id:
                session = request.env['whatsapp.session'].browse(
                    int(session_id)
                )
            else:
                session = request.env['whatsapp.session'].search(
                    [('status', '=', 'connected')], limit=1
                )

            if not session:
                return {
                    'success': False,
                    'error': 'No connected WhatsApp session',
                }

            session.send_document(phone, file_data, filename, caption)
            return {'success': True, 'message': 'Document sent'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    @http.route(
        '/whatsapp/debug/status',
        type='http', auth='user', methods=['GET'],
    )
    def debug_status(self, **kwargs):
        """Diagnostic endpoint to check in-memory WhatsApp status."""
        import json
        from odoo.addons.whatsapp_neonize.models.whatsapp_session import (
            _wa_clients, _wa_status,
        )

        sessions = request.env['whatsapp.session'].sudo().search([])
        info = {
            'memory_clients': {str(k): str(type(v).__name__) for k, v in _wa_clients.items()},
            'memory_status': dict(_wa_status),
            'db_sessions': [],
        }
        for s in sessions:
            info['db_sessions'].append({
                'id': s.id,
                'name': s.name,
                'db_status': s.status,
                'mem_status': _wa_status.get(s.id, 'NOT IN MEMORY'),
                'has_client': s.id in _wa_clients,
                'db_path': s.db_path,
            })

        return request.make_response(
            json.dumps(info, indent=2),
            headers=[('Content-Type', 'application/json')],
        )
