import base64
from odoo import models, fields, api, _
from odoo.exceptions import UserError


class WhatsAppSendMessageWizard(models.TransientModel):
    _name = 'whatsapp.send.message.wizard'
    _description = 'Send WhatsApp Message Wizard'

    session_id = fields.Many2one(
        'whatsapp.session', string='Session',
        domain="[('status', '=', 'connected')]",
        default=lambda self: self.env['whatsapp.session'].search(
            [('status', '=', 'connected')], limit=1
        ).id,
    )
    partner_id = fields.Many2one('res.partner', string='Contact')
    phone = fields.Char('Phone Number', required=True)
    message = fields.Text('Message', required=True)

    # Optional attachment
    attachment = fields.Binary('Attachment')
    attachment_name = fields.Char('Filename')

    # Source record reference
    res_model = fields.Char('Source Model')
    res_id = fields.Integer('Source Record ID')

    @api.onchange('partner_id')
    def _onchange_partner_id(self):
        if self.partner_id:
            self.phone = (
                self.partner_id.phone
                or ''
            )

    def action_send(self):
        """Send the WhatsApp message."""
        self.ensure_one()

        if not self.session_id:
            raise UserError(_(
                "Please select a connected WhatsApp session."
            ))
        if not self.phone:
            raise UserError(_("Please provide a phone number."))
        if not self.message and not self.attachment:
            raise UserError(_(
                "Please provide a message or attachment."
            ))

        # Send text message
        if self.message:
            self.session_id.send_message(self.phone, self.message)

        # Send attachment if provided
        if self.attachment and self.attachment_name:
            file_data = base64.b64decode(self.attachment)
            mimetype = 'application/octet-stream'
            name_lower = self.attachment_name.lower()
            if name_lower.endswith('.pdf'):
                mimetype = 'application/pdf'
            elif name_lower.endswith(('.jpg', '.jpeg')):
                mimetype = 'image/jpeg'
            elif name_lower.endswith('.png'):
                mimetype = 'image/png'
            elif name_lower.endswith(('.xls', '.xlsx')):
                mimetype = (
                    'application/vnd.openxmlformats-'
                    'officedocument.spreadsheetml.sheet'
                )
            elif name_lower.endswith(('.doc', '.docx')):
                mimetype = (
                    'application/vnd.openxmlformats-'
                    'officedocument.wordprocessingml.document'
                )

            if mimetype.startswith('image/'):
                self.session_id.send_image(
                    self.phone, file_data,
                    caption=self.message or '',
                )
            else:
                self.session_id.send_document(
                    self.phone, file_data, self.attachment_name,
                    caption=self.message or '',
                    mimetype=mimetype,
                )

        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('WhatsApp'),
                'message': _('Message sent to %s', self.phone),
                'type': 'success',
                'sticky': False,
            },
        }

    def action_send_report(self):
        """Send an Odoo report for the source record."""
        self.ensure_one()
        if not self.res_model or not self.res_id:
            raise UserError(_("No source record specified."))

        record = self.env[self.res_model].browse(self.res_id)
        if not record.exists():
            raise UserError(_("Source record not found."))

        reports = self.env['ir.actions.report'].search([
            ('model', '=', self.res_model),
            ('report_type', '=', 'qweb-pdf'),
        ])
        if not reports:
            raise UserError(_(
                "No PDF report found for model %s", self.res_model
            ))

        self.session_id.send_odoo_report(
            self.phone, reports[0].report_name, record,
            caption=self.message or record.display_name,
        )

        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('WhatsApp'),
                'message': _('Report sent to %s', self.phone),
                'type': 'success',
                'sticky': False,
            },
        }
