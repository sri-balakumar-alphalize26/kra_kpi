from odoo import models, fields, api, _
import logging

_logger = logging.getLogger(__name__)


class SaleOrder(models.Model):
    _inherit = 'sale.order'

    auto_wa_sent_at_quote = fields.Boolean(default=False, copy=False)
    auto_email_sent_at_confirm = fields.Boolean(default=False, copy=False)
    auto_wa_sent_at_confirm = fields.Boolean(default=False, copy=False)

    def action_confirm(self):
        result = super().action_confirm()
        for so in self:
            so._auto_send_so_on_confirm()
        return result

    def write(self, vals):
        """Detect transition INTO 'sent' (Odoo's standard Send-by-Email wizard
        sets this). On that event, fire the WhatsApp side of auto-send.
        Email side stays out of this — Odoo's wizard already emails the
        quotation, so we'd duplicate."""
        becoming_sent_ids = []
        if vals.get('state') == 'sent':
            for so in self:
                if so.state != 'sent':
                    becoming_sent_ids.append(so.id)
        result = super().write(vals)
        if becoming_sent_ids:
            for so in self.browse(becoming_sent_ids):
                try:
                    so._auto_send_so_on_quotation()
                except Exception as e:
                    _logger.exception("SO quotation WA hook failed: %s", e)
                    so.message_post(body=_("📱 Auto-WhatsApp on quotation FAILED: %s") % e)
        return result

    # ──────────────────────────────────────────────────────────────────────

    def _auto_send_so_on_quotation(self):
        """Fires when SO state moves to 'sent' (Odoo's Send-by-Email wizard).
        Sends WhatsApp only — Odoo's wizard handles the email."""
        self.ensure_one()
        config = self.env['whatsapp.email.dispatch'].get_config()
        if not config:
            return
        send_wa = bool(config.auto_send_so_quotation_wa) and not self.auto_wa_sent_at_quote
        if not send_wa:
            return
        self._dispatch_so(send_email=False, send_whatsapp=True)
        self.write({'auto_wa_sent_at_quote': True})

    def _auto_send_so_on_confirm(self):
        self.ensure_one()
        config = self.env['whatsapp.email.dispatch'].get_config()
        if not config:
            return
        send_email = bool(config.auto_send_so_confirm_email) and not self.auto_email_sent_at_confirm
        send_wa = bool(config.auto_send_so_confirm_wa) and not self.auto_wa_sent_at_confirm
        if not (send_email or send_wa):
            return
        self._dispatch_so(send_email, send_wa)
        flags = {}
        if send_email:
            flags['auto_email_sent_at_confirm'] = True
        if send_wa:
            flags['auto_wa_sent_at_confirm'] = True
        if flags:
            self.write(flags)

    def _dispatch_so(self, send_email, send_whatsapp,
                     email_session=None, whatsapp_session=None):
        self.ensure_one()
        self.env['whatsapp.email.dispatch'].send_record(
            record=self,
            partner=self.partner_id,
            report_xmlid='sale.action_report_saleorder',
            subject=_('Sale Order %s - %s') % (self.name, self.env.company.name),
            wa_caption=_('📄 Sale Order %s\nTotal: %s %s') % (
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
        """Called by the send-channel wizard with the user's chosen sessions."""
        self.ensure_one()
        self._dispatch_so(send_email, send_whatsapp,
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
        """Manual button — opens the channel/session picker wizard."""
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Send WhatsApp & Email'),
            'res_model': 'whatsapp.send.channel.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'default_res_model': 'sale.order',
                'default_res_id': self.id,
            },
        }
