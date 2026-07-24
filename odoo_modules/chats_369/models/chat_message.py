"""chat.message — a single message in a conversation.

`kind` = text (Phase 1) or image/video/audio/document (Phase 2 media) or
`system` (auto lines like "X created the group" / "X added Y"). Media rides in
the `attachment` Binary (filestore) with file_name/mimetype/file_size/duration.
On create the parent conversation's last_message pointer + timestamp are bumped
so the Chats dashboard can sort/preview cheaply.
"""

from datetime import timedelta

from odoo import api, fields, models


class ChatMessage(models.Model):
    _name = 'chat.message'
    _description = '369Chats Message'
    _order = 'id'

    conversation_id = fields.Many2one(
        'chat.conversation', string='Conversation',
        required=True, ondelete='cascade', index=True)
    author_id = fields.Many2one(
        'res.users', string='Author',
        required=True, ondelete='cascade', index=True)

    body = fields.Text(string='Message')     # text, or media caption / system text
    kind = fields.Selection([
        ('text', 'Text'),
        ('image', 'Image'),
        ('video', 'Video'),
        ('audio', 'Audio'),
        ('document', 'Document'),
        ('poll', 'Poll'),
        ('system', 'System'),
    ], string='Kind', default='text', required=True)

    # Media (fields exist from Phase 1 so no migration when Phase 2 lands).
    attachment = fields.Binary(string='Attachment', attachment=True)
    file_name = fields.Char(string='File Name')
    mimetype = fields.Char(string='MIME Type')
    file_size = fields.Integer(string='File Size (bytes)')
    duration = fields.Integer(string='Duration (s)')   # audio / video

    reply_to_id = fields.Many2one('chat.message', string='Reply To', ondelete='set null')
    # Cross-chat "reply privately": a free-text quote of a message from another chat
    # (a real reply_to_id only points within one conversation).
    quote_author = fields.Char(string='Quoted Author')
    quote_body = fields.Char(string='Quoted Text')

    # WhatsApp-style extras
    pinned = fields.Boolean(string='Pinned', default=False, index=True)
    pin_expiry = fields.Datetime(string='Pinned Until')   # empty = pinned indefinitely
    deleted = fields.Boolean(string='Deleted', default=False)   # "delete for everyone" (soft)
    edited = fields.Boolean(string='Edited', default=False)
    forwarded = fields.Boolean(string='Forwarded', default=False)   # shows a "Forwarded" tag
    is_meet = fields.Boolean(string='Google Meet Link', default=False)   # renders as a Join-meeting card
    # Disappearing messages: when set, the message is auto-deleted by a cron once
    # this moment passes (stamped on create from the conversation's timer).
    expire_at = fields.Datetime(string='Disappears At', index=True)

    # Link preview (fetched off-request from the first URL in a text message).
    link_url = fields.Char(string='Link URL')
    link_title = fields.Char(string='Link Title')
    link_desc = fields.Char(string='Link Description')
    link_image = fields.Char(string='Link Image URL')
    link_done = fields.Boolean(string='Link Fetched', default=False)

    # View once: media that can be opened a single time, then is gone.
    view_once = fields.Boolean(string='View Once', default=False)
    viewed_by_user_ids = fields.Many2many(
        'res.users', 'chat_message_viewed_user_rel', 'message_id', 'user_id',
        string='Viewed By')
    # "Delete for me": the message is hidden from these users' view only.
    hidden_for_user_ids = fields.Many2many(
        'res.users', 'chat_message_hidden_user_rel', 'message_id', 'user_id',
        string='Hidden For')
    # "Star" (bookmark) — per user.
    starred_user_ids = fields.Many2many(
        'res.users', 'chat_message_star_user_rel', 'message_id', 'user_id',
        string='Starred By')
    reaction_ids = fields.One2many('chat.message.reaction', 'message_id', string='Reactions')

    def _is_pinned_now(self):
        self.ensure_one()
        if not self.pinned:
            return False
        return (not self.pin_expiry) or self.pin_expiry > fields.Datetime.now()

    @api.model_create_multi
    def create(self, vals_list):
        msgs = super().create(vals_list)
        for msg in msgs:
            conv = msg.conversation_id
            conv.sudo().write({
                'last_message_id': msg.id,
                'last_message_at': msg.create_date or fields.Datetime.now(),
            })
            # Disappearing messages: stamp an expiry on new real messages when the
            # chat has a timer set (system lines never disappear).
            if not msg.expire_at and msg.kind != 'system' and conv.disappear_seconds:
                msg.expire_at = fields.Datetime.now() + timedelta(seconds=conv.disappear_seconds)
            # A new message re-surfaces the chat for anyone who hid/archived it.
            resurf = conv.member_ids.filtered(lambda m: (m.hidden or m.archived) and not m.left_at)
            if resurf:
                resurf.write({'hidden': False, 'archived': False})
        return msgs

    @api.model
    def _gc_expired(self):
        """Cron: delete messages whose disappearing timer has passed."""
        now = fields.Datetime.now()
        expired = self.sudo().search([('expire_at', '!=', False), ('expire_at', '<', now)])
        if expired:
            expired.unlink()
