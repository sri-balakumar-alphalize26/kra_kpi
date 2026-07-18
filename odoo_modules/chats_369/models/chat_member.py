"""chat.member — one row per user in a conversation.

Holds the per-user chat state: the two read cursors that drive unread counts
and (Phase 3) WhatsApp-style ticks —
  * last_read_message_id        → the BLUE "read" tick + unread count
  * delivered_up_to_message_id  → the double-grey "delivered" tick
plus group flags (is_admin), mute, and join/leave timestamps.
"""

from odoo import fields, models


class ChatMember(models.Model):
    _name = 'chat.member'
    _description = '369Chats Conversation Member'
    _order = 'id'

    conversation_id = fields.Many2one(
        'chat.conversation', string='Conversation',
        required=True, ondelete='cascade', index=True)
    user_id = fields.Many2one(
        'res.users', string='User',
        required=True, ondelete='cascade', index=True)

    # Read cursors (both exist from Phase 1; the tick UI ships in Phase 3).
    last_read_message_id = fields.Many2one(
        'chat.message', string='Last Read', ondelete='set null')
    delivered_up_to_message_id = fields.Many2one(
        'chat.message', string='Delivered Up To', ondelete='set null')

    is_admin = fields.Boolean(string='Group Admin', default=False)
    muted = fields.Boolean(string='Muted', default=False)
    muted_until = fields.Datetime(string='Muted Until')       # empty + muted = forever
    pinned = fields.Boolean(string='Pinned', default=False)   # this user pinned the chat to the top
    favourite = fields.Boolean(string='Favourite', default=False)
    archived = fields.Boolean(string='Archived', default=False)
    manual_unread = fields.Boolean(string='Marked Unread', default=False)
    hidden = fields.Boolean(string='Hidden', default=False)   # "delete chat" for a 1:1 (until a new msg)
    joined_at = fields.Datetime(string='Joined At', default=fields.Datetime.now)
    left_at = fields.Datetime(string='Left At')

    # Odoo 19 dropped `_sql_constraints` (silently ignored) — use models.Constraint.
    _conv_user_uniq = models.Constraint(
        'unique(conversation_id, user_id)',
        'A user can only be a member of a conversation once.',
    )

    def _unread_count(self):
        """Count messages in this conversation authored by someone else and
        newer than this member's last-read cursor."""
        self.ensure_one()
        domain = [
            ('conversation_id', '=', self.conversation_id.id),
            ('author_id', '!=', self.user_id.id),
            ('kind', '!=', 'system'),
        ]
        if self.last_read_message_id:
            domain.append(('id', '>', self.last_read_message_id.id))
        return self.env['chat.message'].sudo().search_count(domain)
