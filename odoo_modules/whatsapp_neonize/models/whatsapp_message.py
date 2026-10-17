import logging
from odoo import models, fields, api

from . import wa_jid

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

    # Voice / audio
    is_voice_message = fields.Boolean('Voice Message', default=False, index=True)
    voice_transcription = fields.Text('Voice Transcription')
    voice_language = fields.Char('Voice Language')

    # ---------------- Evolution fields (additive; 16 Oct 2026) ----------------
    # `phone` is overloaded: it is both the chat key and, for 1:1, a real phone
    # number. `remote_jid` is the verbatim wire value and is the new truth.
    remote_jid = fields.Char('Remote JID', index=True,
                             help='Raw chat id, e.g. 9198...@s.whatsapp.net or 1203...@g.us')
    participant_jid = fields.Char(
        'Participant JID',
        help='WHO sent it inside a group. The neonize build never read this -- '
             'it recorded only the chat -- so a group message could not be '
             'attributed to a person. May be a @lid, which carries no digits.')
    push_name = fields.Char('Sender Display Name')
    from_me = fields.Boolean('Sent By Us', index=True, default=False)
    message_type = fields.Selection([
        ('text', 'Text'), ('image', 'Image'), ('audio', 'Audio'),
        ('video', 'Video'), ('document', 'Document'), ('sticker', 'Sticker'),
        ('location', 'Location'), ('contact', 'Contact'),
        ('reaction', 'Reaction'),
        ('poll', 'Poll'), ('poll_vote', 'Poll Vote'),
        ('other', 'Other'),
    ], string='Type', default='text', index=True)
    message_timestamp = fields.Datetime('Sent At (WhatsApp)')
    evolution_event = fields.Char('Evolution Event', help='MESSAGES_UPSERT, SEND_MESSAGE, ...')
    interactive_reply_id = fields.Char(
        'Tapped Option Id', index=True,
        help="When the member TAPPED a button or picked a list row rather than "
             "typing, this is the id we attached to that option (e.g. 'bug'). "
             "Matching on this instead of the visible label means the flow does "
             "not break when the wording changes or is translated.")
    error_message = fields.Text('Send Error')
    quoted_wa_message_id = fields.Char('In Reply To', index=True)

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

    @api.depends('phone', 'remote_jid')
    def _compute_is_group(self):
        """Group detection that actually works.

        This used to be `'@g.us' in phone` alone. The neonize gateway STRIPPED
        the suffix when recording an inbound message, so for every inbound group
        row this evaluated False -- 407 of them in this database. Two things
        followed: the WA Tracker showed group chatter as one-to-one, and
        kra_kpi's inbound hook, which skips on the same test, never skipped
        group traffic at all and handed a group id to the reply parser as if it
        were a client's phone number.

        Now: trust `remote_jid` first, keep the `phone` test so already-correct
        rows stay correct, and fall back to the shape of a bare group id for
        historical rows that have neither.
        """
        for rec in self:
            rec.is_group = wa_jid.is_group_jid(rec.remote_jid or rec.phone or '')

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
