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

            # Get WhatsApp session: prefer the global default, then pos_session_id (legacy),
            # then any connected session.
            wa_session = config.default_whatsapp_session_id or config.pos_session_id
            if not wa_session:
                wa_session = self.env['whatsapp.session'].sudo().search(
                    [('status', '=', 'connected')], limit=1,
                )

            if not wa_session:
                _logger.warning("POS WA: No WhatsApp session found")
                return

            # Transport liveness. The old check read neonize's in-process client
            # registry, which no longer exists -- sending is now a stateless HTTP
            # call to Evolution, so there is no "memory vs DB" split to reconcile.
            try:
                alive = bool(wa_session.wa_is_alive())
            except Exception as exc:
                # Fail OPEN: a receipt that might send beats one that definitely
                # does not because a liveness probe had a bad day.
                _logger.warning("POS WA: liveness probe failed (%s) — trying anyway", exc)
                alive = True
            _logger.info(
                "POS WA: Session %s | status: %s | alive: %s",
                wa_session.name, wa_session.status, alive,
            )

            if not alive:
                _logger.error(
                    "POS WA: WhatsApp session '%s' is not connected (status=%s)",
                    wa_session.name, wa_session.status,
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
                    try:
                        self._send_pos_email_notification(order_id)
                    except Exception as e:
                        _logger.error("POS Email notification failed for %s: %s", order.name, e)
                else:
                    _logger.info(
                        "Skipping WhatsApp/Email for order %s (state: %s)",
                        order.name, order.state,
                    )
        except Exception as e:
            _logger.error("Error triggering POS WhatsApp/Email: %s", e)

        return result

    # ──────────────────────────────────────────────────────────────────────
    # EMAIL MIRROR
    # ──────────────────────────────────────────────────────────────────────

    def _send_pos_email_notification(self, order_id):
        """Email mirror of _send_whatsapp_notification — uses the same trigger.
        Resolves the SMTP server from the default Email Session so the mail.mail
        actually goes out."""
        order = self.browse(order_id)
        if not order.exists():
            return
        config = self.env['whatsapp.config'].sudo().get_config(order.company_id.id)
        if not config.pos_email_notify_enabled:
            _logger.info("POS Email: disabled for company %s", order.company_id.name)
            return

        email_session = config.default_email_session_id
        if not email_session:
            email_session = self.env['email.session'].sudo().get_default_session(order.company_id.id)
        if not email_session:
            _logger.warning(
                "POS Email: no default Email Session. "
                "Add one under WhatsApp and Email → Email Sessions."
            )
            return

        text_msg = config.format_pos_message(order)
        body_html = '<pre style="font-family:inherit;white-space:pre-wrap;">%s</pre>' % (text_msg or '')
        subject = 'POS Order %s - %s' % (order.name, order.company_id.name)
        from_email = email_session.get_from_email()

        recipients = []
        if config.pos_email_notify_owners:
            if not config.pos_owner_emails:
                _logger.warning(
                    "POS Email: 'Email POS Order to Owners' is ON but "
                    "'Owner Emails' is empty. Add at least one address (comma-separated) "
                    "in WhatsApp and Email Settings → POS Notifications."
                )
            else:
                for addr in config.pos_owner_emails.split(','):
                    addr = (addr or '').strip()
                    if addr:
                        recipients.append(addr)
        if config.pos_email_notify_customer:
            if not order.partner_id:
                _logger.info(
                    "POS Email: customer email skipped for order %s — no customer attached.",
                    order.name,
                )
            elif not order.partner_id.email:
                _logger.info(
                    "POS Email: customer '%s' has no email on file; skipped.",
                    order.partner_id.display_name,
                )
            else:
                recipients.append(order.partner_id.email)

        if not recipients:
            _logger.warning(
                "POS Email: no recipients resolved for order %s. "
                "Check the toggles + 'Owner Emails' field under "
                "WhatsApp and Email Settings → POS Notifications.",
                order.name,
            )
            return

        for to in recipients:
            try:
                mail_vals = {
                    'subject': subject,
                    'body_html': body_html,
                    'email_to': to,
                    'email_from': from_email,
                    'auto_delete': False,
                }
                if email_session.mail_server_id:
                    mail_vals['mail_server_id'] = email_session.mail_server_id.id
                mail = self.env['mail.mail'].sudo().create(mail_vals)
                mail.send(raise_exception=False)
                _logger.info("POS Email: SENT to %s for order %s via session %s",
                             to, order.name, email_session.email_address)
            except Exception as e:
                _logger.error("POS Email: FAILED to %s: %s", to, e)
