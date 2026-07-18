"""chat.message.reaction — one emoji reaction by a user on a message.

One reaction per user per message (WhatsApp-style): reacting again with the
same emoji removes it; a different emoji replaces it. Reactions are grouped by
emoji for display (emoji + count + whether it's mine).
"""

from odoo import fields, models


class ChatMessageReaction(models.Model):
    _name = 'chat.message.reaction'
    _description = '369Chats Message Reaction'
    _order = 'id'

    message_id = fields.Many2one(
        'chat.message', string='Message', required=True, ondelete='cascade', index=True)
    user_id = fields.Many2one(
        'res.users', string='User', required=True, ondelete='cascade', index=True)
    emoji = fields.Char(string='Emoji', required=True)

    _msg_user_uniq = models.Constraint(
        'unique(message_id, user_id)',
        'One reaction per user per message.')
