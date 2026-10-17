"""Wizard that lets the user pick which Email session and which WhatsApp
session to use for a manual send (when multiple are connected)."""

from odoo import models, fields, api, _
from odoo.exceptions import UserError
import logging

_logger = logging.getLogger(__name__)


class SendChannelWizard(models.TransientModel):
    _name = 'whatsapp.send.channel.wizard'
    _description = 'Pick channel(s) for sending a document'

    res_model = fields.Char(required=True)
    res_id = fields.Integer(required=True)

    record_label = fields.Char(readonly=True)
    partner_id = fields.Many2one('res.partner', readonly=True)

    send_email = fields.Boolean(string='Send by Email', default=True)
    send_whatsapp = fields.Boolean(string='Send by WhatsApp', default=True)

    email_session_id = fields.Many2one(
        'email.session', string='From Email Account',
        domain="[('active', '=', True), ('status', '=', 'connected')]",
    )
    whatsapp_session_id = fields.Many2one(
        'whatsapp.session', string='From WhatsApp Session',
        domain="[('status', '=', 'connected')]",
    )

    @api.model
    def default_get(self, fields_list):
        vals = super().default_get(fields_list)
        ctx = self.env.context
        if ctx.get('default_res_model') and ctx.get('default_res_id'):
            record = self.env[ctx['default_res_model']].browse(ctx['default_res_id'])
            if record.exists():
                partner = getattr(record, 'partner_id', False)
                vals.setdefault('partner_id', partner.id if partner else False)
                vals.setdefault('record_label', getattr(record, 'display_name', '') or getattr(record, 'name', ''))

        # Pre-pick defaults
        dispatch = self.env['whatsapp.email.dispatch']
        e = dispatch.get_default_email_session()
        w = dispatch.get_default_whatsapp_session()
        if 'email_session_id' in fields_list and e:
            vals.setdefault('email_session_id', e.id)
        if 'whatsapp_session_id' in fields_list and w:
            vals.setdefault('whatsapp_session_id', w.id)
        return vals

    def action_send(self):
        self.ensure_one()
        if not (self.send_email or self.send_whatsapp):
            raise UserError(_("Select at least one channel (Email or WhatsApp)."))
        if self.send_email and not self.email_session_id:
            raise UserError(_("Pick an Email account, or uncheck Send by Email."))
        if self.send_whatsapp and not self.whatsapp_session_id:
            raise UserError(_("Pick a WhatsApp session, or uncheck Send by WhatsApp."))

        record = self.env[self.res_model].browse(self.res_id)
        if not record.exists():
            raise UserError(_("Record no longer exists."))

        if hasattr(record, '_send_via_channels_with_sessions'):
            res = record._send_via_channels_with_sessions(
                send_email=self.send_email,
                send_whatsapp=self.send_whatsapp,
                email_session=self.email_session_id if self.send_email else None,
                whatsapp_session=self.whatsapp_session_id if self.send_whatsapp else None,
            )
            return res
        raise UserError(_(
            "Model %s does not implement _send_via_channels_with_sessions yet."
        ) % self.res_model)
