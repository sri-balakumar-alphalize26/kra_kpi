"""Send payment receipts via Email + WhatsApp on account.payment.

Two paths:
  - Manual button on the payment form ("📱 Send Receipt via WhatsApp & Email")
  - Auto-send when the payment is posted, gated by toggles on whatsapp.config:
      * auto_send_payment_receipt_email  (default False)
      * auto_send_payment_receipt_wa     (default False)

Sends payment-type-aware messages: customer payments get a thank-you receipt,
vendor payments get a remittance confirmation.
"""

import logging

from odoo import models, fields, api, _

_logger = logging.getLogger(__name__)


PAYMENT_RECEIPT_REPORT_CANDIDATES = [
    'account.action_report_payment_receipt',
    'account.report_payment_receipt',
]


class AccountPayment(models.Model):
    _inherit = 'account.payment'

    auto_email_receipt_sent = fields.Boolean(default=False, copy=False)
    auto_wa_receipt_sent = fields.Boolean(default=False, copy=False)

    # ──────────────────────────────────────────────────────────────────────
    # Auto-send hook (fires after action_post)
    # ──────────────────────────────────────────────────────────────────────

    def action_post(self):
        result = super().action_post()
        for payment in self:
            try:
                payment._auto_send_receipt()
            except Exception as e:
                _logger.exception("Payment receipt auto-send failed: %s", e)
                payment.message_post(body=_("📱 Auto-send error: %s") % e)
        return result

    def _auto_send_receipt(self):
        self.ensure_one()
        if self.state != 'posted':
            return
        config = self.env['whatsapp.email.dispatch'].get_config()
        if not config:
            return
        send_email = (
            bool(getattr(config, 'auto_send_payment_receipt_email', False))
            and not self.auto_email_receipt_sent
        )
        send_wa = (
            bool(getattr(config, 'auto_send_payment_receipt_wa', False))
            and not self.auto_wa_receipt_sent
        )
        if not (send_email or send_wa):
            return

        self._dispatch_receipt(send_email=send_email, send_whatsapp=send_wa)

        flags = {}
        if send_email:
            flags['auto_email_receipt_sent'] = True
        if send_wa:
            flags['auto_wa_receipt_sent'] = True
        if flags:
            self.write(flags)

    # ──────────────────────────────────────────────────────────────────────
    # Manual send button
    # ──────────────────────────────────────────────────────────────────────

    def action_send_via_channels(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Send Receipt via Email & WhatsApp'),
            'res_model': 'whatsapp.send.channel.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'default_res_model': 'account.payment',
                'default_res_id': self.id,
            },
        }

    def _send_via_channels_with_sessions(self, send_email, send_whatsapp,
                                         email_session=None, whatsapp_session=None):
        self.ensure_one()
        return self._dispatch_receipt(
            send_email=send_email,
            send_whatsapp=send_whatsapp,
            email_session=email_session,
            whatsapp_session=whatsapp_session,
        )

    # ──────────────────────────────────────────────────────────────────────
    # Internal — does the actual dispatch
    # ──────────────────────────────────────────────────────────────────────

    def _resolve_payment_receipt_report(self):
        """Return the first valid receipt-report xmlid available, or ''."""
        for xmlid in PAYMENT_RECEIPT_REPORT_CANDIDATES:
            try:
                self.env.ref(xmlid)
                return xmlid
            except ValueError:
                continue
        return ''

    def _dispatch_receipt(self, send_email, send_whatsapp,
                          email_session=None, whatsapp_session=None):
        self.ensure_one()
        partner = self.partner_id
        if not partner:
            return {
                'type': 'ir.actions.client',
                'tag': 'display_notification',
                'params': {
                    'title': _('Cannot send'),
                    'message': _('Payment has no partner — cannot send receipt.'),
                    'type': 'warning',
                    'sticky': False,
                },
            }

        is_inbound = self.payment_type == 'inbound'
        emoji = '✅' if is_inbound else '💸'
        label = _('Payment Receipt') if is_inbound else _('Payment Sent')
        intro = (
            _('Thank you! We have received your payment.')
            if is_inbound else
            _('We have processed a payment to your account.')
        )

        symbol = self.currency_id.symbol if self.currency_id else ''
        amount_str = '{:,.2f}'.format(self.amount or 0)

        subject = _('%s %s - %s') % (
            label, self.name or '', self.env.company.name,
        )
        caption = _(
            '%(emoji)s *%(label)s*\n'
            '%(intro)s\n\n'
            '👤 %(partner)s\n'
            '💰 Amount: %(symbol)s %(amount)s\n'
            '🧾 Reference: %(name)s\n'
            '📅 Date: %(date)s\n'
            '— %(company)s'
        ) % {
            'emoji': emoji,
            'label': label,
            'intro': intro,
            'partner': partner.name,
            'symbol': symbol,
            'amount': amount_str,
            'name': self.name or '',
            'date': self.date.strftime('%d/%m/%Y') if self.date else '',
            'company': self.env.company.name,
        }

        report_xmlid = self._resolve_payment_receipt_report()

        self.env['whatsapp.email.dispatch'].send_record(
            record=self,
            partner=partner,
            report_xmlid=report_xmlid or False,
            subject=subject,
            wa_caption=caption,
            send_email=send_email,
            send_whatsapp=send_whatsapp,
            email_session=email_session,
            whatsapp_session=whatsapp_session,
        )

        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('Receipt Send Result'),
                'message': _(
                    'Receipt dispatched. Check the chatter for per-channel status.'
                ),
                'type': 'success',
                'sticky': False,
            },
        }
