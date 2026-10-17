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
        session = request.env['whatsapp.session'].browse(session_id)
        if not session.exists():
            return {'status': 'error', 'message': 'Session not found'}

        # There is no in-memory state any more. Evolution pushes QRCODE_UPDATED
        # and CONNECTION_UPDATE to the webhook, which writes straight to the row,
        # so the database IS the single source of truth -- and the multi-worker
        # "memory says one thing, DB says another" problem this used to paper
        # over cannot occur.
        result = {
            'status': session.status,
            'session_id': session_id,
        }
        if session.status == 'waiting_qr' and session.qr_image:
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
        session = request.env['whatsapp.session'].browse(session_id)
        qr = session.qr_image if session.exists() else None
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
        '/whatsapp/webhook/incoming',
        type='jsonrpc', auth='public', methods=['POST'], csrf=False,
    )
    def webhook_incoming(self, **kwargs):
        """
        Public webhook for external gateways / bridge services to push
        incoming WhatsApp messages into Odoo.

        POST /whatsapp/webhook/incoming  (Content-Type: application/json)
        Body params:
            from:   sender phone (e.g. "919944080209" or "919944080209@s.whatsapp.net")
            body:   message text
            secret: must match the `whatsapp_neonize.webhook_secret`
                    system parameter (default: 'neonize-webhook')

        Returns: {'ok': bool, ...}
        """
        phone = kwargs.get('from', '')
        body = kwargs.get('body', '')
        secret = kwargs.get('secret', '')

        _logger.info("WhatsApp webhook: from=%s body=%r", phone, body)

        expected = request.env['ir.config_parameter'].sudo().get_param(
            'whatsapp_neonize.webhook_secret', 'neonize-webhook',
        )
        if secret != expected:
            _logger.warning("Webhook: invalid secret from %s", phone)
            return {'ok': False, 'error': 'Invalid secret'}

        if not phone or not body:
            return {'ok': False, 'error': 'Missing from or body'}

        phone_clean = (
            phone.replace('@c.us', '')
                 .replace('@s.whatsapp.net', '')
                 .replace('@g.us', '')
                 .replace('@lid', '')
                 .replace('+', '').replace(' ', '').replace('-', '')
        )

        try:
            session = request.env['whatsapp.session'].sudo().search(
                [('status', '=', 'connected')], limit=1,
            )
            request.env['whatsapp.message'].sudo().create({
                'session_id': session.id if session else False,
                'phone': phone_clean,
                'message': body,
                'direction': 'incoming',
                'status': 'received',
            })
            _logger.info(
                "Webhook: saved incoming message from %s: %r",
                phone_clean, body,
            )
            return {'ok': True, 'status': 'message_saved'}
        except Exception as e:
            _logger.error("Webhook save error: %s", e, exc_info=True)
            return {'ok': False, 'error': str(e)}

    @http.route(
        '/whatsapp/debug/status',
        type='http', auth='user', methods=['GET'],
    )
    def debug_status(self, **kwargs):
        """Diagnostic endpoint: what Odoo stores vs what Evolution reports."""
        import json

        sessions = request.env['whatsapp.session'].sudo().search([])
        info = {'transport': 'evolution-api', 'db_sessions': []}
        for s in sessions:
            row = {
                'id': s.id,
                'name': s.name,
                'db_status': s.status,
                'base_url': s.base_url,
                'instance_name': s.instance_name,
                'last_webhook_at': str(s.last_webhook_at or ''),
                'last_state_check': str(s.last_state_check or ''),
                'webhook_url': s.webhook_url,
            }
            # One live probe, so the two sides can be compared directly. This is
            # the whole diagnostic now -- there is no third "in-memory" state to
            # disagree with them.
            try:
                row['evolution_state'] = s._api().connection_state(s.instance_name)
            except Exception as exc:
                row['evolution_state'] = 'probe failed: %s' % exc
            info['db_sessions'].append(row)

        return request.make_response(
            json.dumps(info, indent=2),
            headers=[('Content-Type', 'application/json')],
        )
