import logging
from odoo import models, fields, api

_logger = logging.getLogger(__name__)


class WhatsAppMessage(models.Model):
    _name = 'whatsapp.message'
    _description = 'WhatsApp Message'
    _order = 'create_date desc'
    _rec_name = 'phone'

    session_id = fields.Many2one(
        'whatsapp.session', string='Session',
        required=True, ondelete='cascade', index=True,
    )
    phone = fields.Char('Phone Number', required=True, index=True)
    message = fields.Text('Message')
    direction = fields.Selection([
        ('incoming', 'Incoming'),
        ('outgoing', 'Outgoing'),
    ], string='Direction', required=True, index=True)
    status = fields.Selection([
        ('pending', 'Pending'),
        ('sent', 'Sent'),
        ('delivered', 'Delivered'),
        ('read', 'Read'),
        ('received', 'Received'),
        ('failed', 'Failed'),
    ], string='Status', default='pending', index=True)
    wa_message_id = fields.Char('WA Message ID', index=True)
    partner_id = fields.Many2one(
        'res.partner', string='Contact',
        compute='_compute_partner', store=True, index=True,
    )
    attachment_ids = fields.Many2many(
        'ir.attachment', string='Attachments',
    )
    company_id = fields.Many2one(
        related='session_id.company_id', store=True,
    )
    is_group = fields.Boolean(
        'Group Message', compute='_compute_is_group', store=True,
    )

    # ----------------------------------------------------------
    # Computed Fields
    # ----------------------------------------------------------
    @api.depends('phone')
    def _compute_partner(self):
        """Auto-match phone number to res.partner."""
        for rec in self:
            if rec.phone:
                phone_suffix = (
                    rec.phone[-10:]
                    if len(rec.phone) >= 10
                    else rec.phone
                )
                partner = self.env['res.partner'].search([
                    ('phone', 'like', f'%{phone_suffix}'),
                ], limit=1)
                rec.partner_id = partner.id if partner else False
            else:
                rec.partner_id = False

    @api.depends('phone')
    def _compute_is_group(self):
        for rec in self:
            rec.is_group = '@g.us' in (rec.phone or '')

    # ----------------------------------------------------------
    # Actions
    # ----------------------------------------------------------
    def action_reply(self):
        """Open send message wizard pre-filled with this phone."""
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': 'Reply via WhatsApp',
            'res_model': 'whatsapp.send.message.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'default_session_id': self.session_id.id,
                'default_phone': self.phone,
            },
        }

    def action_open_partner(self):
        """Open the linked partner."""
        self.ensure_one()
        if self.partner_id:
            return {
                'type': 'ir.actions.act_window',
                'res_model': 'res.partner',
                'res_id': self.partner_id.id,
                'view_mode': 'form',
            }
