"""chat.nickname — a user's private nickname for a contact (WhatsApp custom
name). Private to the owner; used to override the 1:1 conversation title."""

from odoo import fields, models


class ChatNickname(models.Model):
    _name = 'chat.nickname'
    _description = '369Chats Contact Nickname'
    _order = 'id'

    owner_user_id = fields.Many2one('res.users', string='Owner', required=True, ondelete='cascade', index=True)
    target_user_id = fields.Many2one('res.users', string='Contact', required=True, ondelete='cascade', index=True)
    nick = fields.Char(string='Nickname')

    _owner_target_uniq = models.Constraint(
        'unique(owner_user_id, target_user_id)',
        'One nickname per contact.')
