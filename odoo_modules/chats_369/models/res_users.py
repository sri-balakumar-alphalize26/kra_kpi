"""res.users — 369Chats presence + privacy.

`chat_last_seen` is stamped on every poll/heartbeat while the chat is open; the
controller derives online (< window) / last-seen from it, honouring the per-user
privacy settings and WhatsApp's reciprocity rule (hide yours -> can't see others').
"""
from odoo import fields, models


class ResUsers(models.Model):
    _inherit = 'res.users'

    chat_last_seen = fields.Datetime(string='369Chats Last Seen')
    chat_last_seen_privacy = fields.Selection(
        [('everyone', 'Everyone'), ('contacts', 'My contacts'), ('nobody', 'Nobody')],
        string='Last Seen Visible To', default='everyone', required=True)
    chat_online_privacy = fields.Selection(
        [('everyone', 'Everyone'), ('same', 'Same as last seen')],
        string='Online Visible To', default='everyone', required=True)
    # Profile + settings (WhatsApp-style, office-lean)
    chat_about = fields.Char(string='369Chats About', default='Available')
    chat_read_receipts = fields.Boolean(string='Send Read Receipts', default=True)
    chat_notif_messages = fields.Boolean(string='Notify Direct Messages', default=True)
    chat_notif_groups = fields.Boolean(string='Notify Group Messages', default=True)
    chat_notif_sound = fields.Boolean(string='Notification Sound', default=True)
    chat_notif_preview = fields.Boolean(string='Notification Preview', default=True)
    # People I have blocked (they can't message me and I can't message them).
    chat_blocked_user_ids = fields.Many2many(
        'res.users', 'chat_block_rel', 'blocker_id', 'blocked_id',
        string='369Chats Blocked Users')

    def _chat_touch_presence(self):
        """Mark the caller active right now (cheap; called from poll/heartbeat)."""
        if self:
            self.sudo().write({'chat_last_seen': fields.Datetime.now()})
