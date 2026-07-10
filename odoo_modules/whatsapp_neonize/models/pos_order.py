import logging
import threading
from odoo import models, api

_logger = logging.getLogger(__name__)


class PosOrder(models.Model):
    _inherit = 'pos.order'

    def _send_whatsapp_notification(self, order_id):
        """Send WhatsApp notification for POS order."""
        try:
            order = self.browse(order_id)
            if not order.exists():
                _logger.error("POS WA: Order %s not found", order_id)
                return

            config = self.env['whatsapp.config'].sudo().get_config(
                order.company_id.id
            )
            if not config.pos_notify_enabled:
                _logger.info("POS WA: Notifications disabled")
                return

            # Get WhatsApp session — prefer the one that is actually connected.
            wa_session = config.pos_session_id
            if not wa_session:
                from odoo.addons.whatsapp_neonize.models.whatsapp_session import (
                    _wa_status as _st,
                )
                candidates = self.env['whatsapp.session'].sudo().search([
                    '|',
                    ('company_id', '=', order.company_id.id),
                    ('company_id', '=', False),
                ])
                connected = candidates.filtered(lambda s: _st.get(s.id) == 'connected')
                wa_session = (connected[:1] or candidates[:1])

            if not wa_session:
                _logger.warning("POS WA: No WhatsApp session found")
                return

            # Check in-memory client status
            from odoo.addons.whatsapp_neonize.models.whatsapp_session import (
                _wa_clients, _wa_status,
            )
            mem_status = _wa_status.get(wa_session.id, 'unknown')
            has_client = wa_session.id in _wa_clients
            _logger.info(
                "POS WA: Session %s | DB status: %s | Memory status: %s | Has client: %s",
                wa_session.name, wa_session.status, mem_status, has_client,
            )

            if mem_status != 'connected' or not has_client:
                _logger.error(
                    "POS WA: WhatsApp not connected in memory! DB says '%s' but memory says '%s'",
                    wa_session.status, mem_status,
                )
                return

            # Format message
            message = config.format_pos_message(order)
            _logger.info("POS WA: Message formatted, length: %d", len(message))

            # Send to owners
            if config.pos_notify_owners:
                for owner in config.owner_number_ids.filtered('active'):
                    _logger.info("POS WA: Sending to owner %s (%s)", owner.name, owner.phone)
                    try:
                        wa_session.send_message(owner.phone, message)
                        _logger.info("POS WA: SENT to owner %s (%s)", owner.name, owner.phone)
                    except Exception as e:
                        _logger.error("POS WA: FAILED to send to %s: %s", owner.phone, e)

            # Send to customer
            if config.pos_notify_customer and order.partner_id:
                customer_phone = order.partner_id.phone
                if customer_phone:
                    customer_phone = customer_phone.replace('+', '').replace(' ', '').replace('-', '')
                    _logger.info("POS WA: Sending to customer %s (%s)", order.partner_id.name, customer_phone)
                    try:
                        wa_session.send_message(customer_phone, message)
                        _logger.info("POS WA: SENT to customer %s", customer_phone)
                    except Exception as e:
                        _logger.error("POS WA: FAILED to send to customer %s: %s", customer_phone, e)

        except Exception as e:
            _logger.error("POS WA notification error: %s", e, exc_info=True)

    @api.model
    def sync_from_ui(self, orders):
        """Override POS sync to trigger WhatsApp notification."""
        _logger.info("=== POS sync_from_ui called with %d orders ===", len(orders))
        result = super().sync_from_ui(orders)

        # Debug: log the result structure
        _logger.info("sync_from_ui result type: %s", type(result))
        if isinstance(result, dict):
            _logger.info("sync_from_ui result keys: %s", list(result.keys()))
            if result.get('pos.order'):
                _logger.info("pos.order entries: %d", len(result['pos.order']))

        # Get order IDs from result
        try:
            order_ids = []
            if isinstance(result, dict) and result.get('pos.order'):
                for order_data in result['pos.order']:
                    if isinstance(order_data, dict) and order_data.get('id'):
                        order_ids.append(order_data['id'])
            elif isinstance(result, list):
                for item in result:
                    if isinstance(item, dict) and item.get('id'):
                        order_ids.append(item['id'])

            _logger.info("Extracted order IDs: %s", order_ids)

            # Send WhatsApp for completed (paid) orders
            for order_id in order_ids:
                order = self.browse(order_id)
                _logger.info(
                    "Order %s state: %s",
                    order.name, order.state,
                )
                if order.exists() and order.state in ('paid', 'done', 'invoiced'):
                    self._send_whatsapp_notification(order_id)
                    _logger.info(
                        "POS WhatsApp notification queued for order %s (state: %s)",
                        order.name, order.state,
                    )
                else:
                    _logger.info(
                        "Skipping WhatsApp for order %s (state: %s)",
                        order.name, order.state,
                    )
        except Exception as e:
            _logger.error("Error triggering POS WhatsApp: %s", e)

        return result
