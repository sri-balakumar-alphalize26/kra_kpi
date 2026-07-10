import logging
from odoo import models, api, _
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)


class WhatsAppMixin(models.AbstractModel):
    """
    Mixin to add WhatsApp send capability to any Odoo model.

    Usage in your custom module:
    ----------------------------
        class SaleOrder(models.Model):
            _inherit = ['sale.order', 'whatsapp.mixin']

        Then call:
            record.wa_send_text(phone='919876543210', message='Hello!')
            record.wa_send_report(
                phone='919876543210',
                report_xmlid='sale.report_saleorder',
            )
    """
    _name = 'whatsapp.mixin'
    _description = 'WhatsApp Messaging Mixin'

    def _get_whatsapp_session(self):
        """Get the first connected WhatsApp session."""
        session = self.env['whatsapp.session'].sudo().search([
            ('status', '=', 'connected'),
            '|',
            ('company_id', '=', self.env.company.id),
            ('company_id', '=', False),
        ], limit=1)
        if not session:
            raise UserError(_(
                "No active WhatsApp session found.\n"
                "Please go to WhatsApp → Sessions and connect first."
            ))
        return session

    def _get_wa_phone(self, phone='', phone_field='phone'):
        """Resolve phone number from arguments or record fields."""
        if phone:
            return phone
        record_phone = getattr(self, phone_field, '') or ''
        if not record_phone and hasattr(self, 'partner_id') and self.partner_id:
            record_phone = self.partner_id.phone or ''
        return record_phone

    def wa_send_text(self, phone='', message='', phone_field='phone'):
        """Send a text message via WhatsApp."""
        session = self._get_whatsapp_session()
        for record in self:
            target_phone = record._get_wa_phone(phone, phone_field)
            if not target_phone:
                _logger.warning(
                    "No phone for record %s [%s]", record._name, record.id
                )
                continue
            session.send_message(target_phone, message)

    def wa_send_report(self, phone='', report_xmlid='',
                       caption='', phone_field='phone'):
        """Send an Odoo PDF report via WhatsApp."""
        session = self._get_whatsapp_session()
        for record in self:
            target_phone = record._get_wa_phone(phone, phone_field)
            if not target_phone:
                continue
            session.send_odoo_report(
                target_phone, report_xmlid, record, caption
            )

    def wa_send_document(self, phone='', file_data=None,
                         filename='', caption='', phone_field='phone'):
        """Send a file/document via WhatsApp."""
        session = self._get_whatsapp_session()
        for record in self:
            target_phone = record._get_wa_phone(phone, phone_field)
            if not target_phone:
                continue
            session.send_document(
                target_phone, file_data, filename, caption
            )

    def action_send_whatsapp(self):
        """
        Generic action to open WhatsApp send wizard from any model.
        Override _wa_get_default_phone() and _wa_get_default_message()
        in your model to customize.
        """
        self.ensure_one()
        phone = self._get_wa_phone()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Send WhatsApp Message'),
            'res_model': 'whatsapp.send.message.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'default_phone': phone,
                'default_res_model': self._name,
                'default_res_id': self.id,
            },
        }
