from odoo import models, fields, _


class ResPartner(models.Model):
    _inherit = 'res.partner'

    whatsapp_message_ids = fields.One2many(
        'whatsapp.message', 'partner_id', string='WhatsApp Messages',
    )
    whatsapp_message_count = fields.Integer(
        compute='_compute_whatsapp_message_count',
        string='WA Messages',
    )

    def _compute_whatsapp_message_count(self):
        msg_model = self.env['whatsapp.message']
        for partner in self:
            partner.whatsapp_message_count = msg_model.search_count([
                ('partner_id', '=', partner.id)
            ])

    def action_view_whatsapp_messages(self):
        """View all WhatsApp messages for this partner."""
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('WhatsApp Messages'),
            'res_model': 'whatsapp.message',
            'view_mode': 'list,form',
            'domain': [('partner_id', '=', self.id)],
        }

    def action_send_whatsapp(self):
        """Open WhatsApp send wizard for this partner."""
        self.ensure_one()
        phone = self.phone or ''
        return {
            'type': 'ir.actions.act_window',
            'name': _('Send WhatsApp Message'),
            'res_model': 'whatsapp.send.message.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'default_phone': phone,
                'default_partner_id': self.id,
            },
        }
