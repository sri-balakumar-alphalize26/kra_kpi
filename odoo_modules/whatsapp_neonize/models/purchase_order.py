from odoo import models, fields, api, _
import logging

_logger = logging.getLogger(__name__)


class PurchaseOrder(models.Model):
    _inherit = 'purchase.order'

    auto_email_sent_at_confirm = fields.Boolean(default=False, copy=False)
    auto_wa_sent_at_confirm = fields.Boolean(default=False, copy=False)

    def button_confirm(self):
        result = super().button_confirm()
        for po in self:
            try:
                po._auto_send_po_on_confirm()
            except Exception as e:
                _logger.exception("PO confirm auto-send failed: %s", e)
                po.message_post(body=_("📱 Auto-send error: %s") % e)
        return result

    def _auto_send_po_on_confirm(self):
        self.ensure_one()
        config = self.env['whatsapp.email.dispatch'].get_config()
        if not config:
            return
        send_email = bool(config.auto_send_po_confirm_email) and not self.auto_email_sent_at_confirm
        send_wa = bool(config.auto_send_po_confirm_wa) and not self.auto_wa_sent_at_confirm
        if not (send_email or send_wa):
            return
        self._dispatch_po(send_email, send_wa)
        flags = {}
        if send_email:
            flags['auto_email_sent_at_confirm'] = True
        if send_wa:
            flags['auto_wa_sent_at_confirm'] = True
        if flags:
            self.write(flags)

    def _dispatch_po(self, send_email, send_whatsapp,
                     email_session=None, whatsapp_session=None):
        self.ensure_one()
        self.env['whatsapp.email.dispatch'].send_record(
            record=self,
            partner=self.partner_id,
            report_xmlid='purchase.action_report_purchase_order',
            subject=_('Purchase Order %s - %s') % (self.name, self.env.company.name),
            wa_caption=_('📦 Purchase Order %s\nTotal: %s %s') % (
                self.name,
                self.currency_id.symbol or '',
                '{:,.2f}'.format(self.amount_total or 0),
            ),
            send_email=send_email,
            send_whatsapp=send_whatsapp,
            email_session=email_session,
            whatsapp_session=whatsapp_session,
        )

    def _send_via_channels_with_sessions(self, send_email, send_whatsapp,
                                         email_session=None, whatsapp_session=None):
        self.ensure_one()
        self._dispatch_po(send_email, send_whatsapp,
                          email_session=email_session,
                          whatsapp_session=whatsapp_session)
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('Send Result'),
                'message': _('Send dispatched. Check the chatter for per-channel status.'),
                'type': 'success',
                'sticky': False,
            },
        }

    def action_send_via_channels(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Send WhatsApp & Email'),
            'res_model': 'whatsapp.send.channel.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'default_res_model': 'purchase.order',
                'default_res_id': self.id,
            },
        }
