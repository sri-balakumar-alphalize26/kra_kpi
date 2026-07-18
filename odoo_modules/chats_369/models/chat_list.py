"""chat.list — a user's custom chat list (WhatsApp "Lists"), a private filter
grouping conversations (e.g. Work, Family). Per owner."""

from odoo import fields, models


class ChatList(models.Model):
    _name = 'chat.list'
    _description = '369Chats Custom List'
    _order = 'name'

    owner_user_id = fields.Many2one('res.users', string='Owner', required=True, ondelete='cascade', index=True)
    name = fields.Char(string='Name', required=True)
    emoji = fields.Char(string='Emoji')
    conversation_ids = fields.Many2many(
        'chat.conversation', 'chat_list_conv_rel', 'list_id', 'conv_id', string='Conversations')
