"""chat.conversation — a 369Chats thread (1:1 or group).

A conversation groups a set of members (chat.member) and their messages
(chat.message). For 1:1 chats `is_group` is False and there is exactly one
conversation per unordered pair of users (see `_get_or_create_direct`). For
groups `is_group` is True with a name/photo and an owner.

Security note: the mobile controllers always resolve the caller from
`request.env.user` and check membership before returning anything, so the chat
identity comes from the number login, never from a client-sent id.
"""

from odoo import api, fields, models
from odoo.exceptions import ValidationError


class ChatConversation(models.Model):
    _name = 'chat.conversation'
    _description = '369Chats Conversation'
    _order = 'last_message_at desc, id desc'
    _rec_name = 'title'

    name = fields.Char(string='Group Name')          # blank for 1:1
    description = fields.Text(string='Group Description')   # groups only
    # Readable label for the Odoo admin views (group name, or the 1:1 members).
    title = fields.Char(string='Title', compute='_compute_title', store=True)
    is_group = fields.Boolean(string='Is Group', default=False, index=True)
    is_self = fields.Boolean(string='Self Chat', default=False)   # "Message yourself"
    image = fields.Binary(string='Group Photo', attachment=True)   # Phase 2
    owner_id = fields.Many2one('res.users', string='Created By', ondelete='set null')

    # Group permissions (WhatsApp-style). Enforced in the controllers.
    perm_edit_info = fields.Boolean(string='Members Can Edit Info', default=True)
    perm_send = fields.Boolean(string='Members Can Send', default=True)
    perm_add_members = fields.Boolean(string='Members Can Add Members', default=True)
    perm_send_history = fields.Boolean(string='Members Can Send History', default=True)
    perm_invite = fields.Boolean(string='Members Can Invite Via Link', default=True)
    admin_approve = fields.Boolean(string='Admins Approve New Members', default=False)
    invite_token = fields.Char(string='Invite Token', index=True, copy=False)   # employee-only join link

    # Disappearing messages: 0 = off, else seconds after which new messages self-delete.
    disappear_seconds = fields.Integer(string='Disappearing Timer (s)', default=0)

    member_ids = fields.One2many('chat.member', 'conversation_id', string='Members')
    message_ids = fields.One2many('chat.message', 'conversation_id', string='Messages')

    # Denormalised for a cheap dashboard sort + preview (bumped on every message).
    last_message_id = fields.Many2one('chat.message', string='Last Message', ondelete='set null')
    last_message_at = fields.Datetime(string='Last Activity', index=True)

    active = fields.Boolean(default=True)

    member_count = fields.Integer(string='Members', compute='_compute_member_count')

    @api.depends('member_ids', 'member_ids.left_at')
    def _compute_member_count(self):
        for conv in self:
            conv.member_count = len(conv.member_ids.filtered(lambda m: not m.left_at))

    @api.depends('is_group', 'name', 'member_ids.user_id')
    def _compute_title(self):
        for conv in self:
            if conv.is_group:
                conv.title = conv.name or 'Group'
            else:
                names = [n for n in conv.member_ids.mapped('user_id.name') if n]
                conv.title = ' / '.join(names[:2]) if names else 'Chat'

    # ------------------------------------------------------------------ #
    # 1:1 get-or-create                                                  #
    # ------------------------------------------------------------------ #
    @api.model
    def _get_or_create_direct(self, user_a_id, user_b_id):
        """Return the single 1:1 conversation between two users, creating it if
        it doesn't exist. Searches first so a pair never gets two threads (a
        rare concurrent double-open would still be possible — acceptable for an
        internal chat; both threads would just show the same messages once
        merged manually)."""
        user_a_id, user_b_id = int(user_a_id), int(user_b_id)
        if user_a_id == user_b_id:
            raise ValidationError("You can't open a chat with yourself.")
        convs = self.sudo().search([
            ('is_group', '=', False),
            ('member_ids.user_id', '=', user_a_id),
        ])
        for conv in convs:
            uids = set(conv.member_ids.mapped('user_id').ids)
            if uids == {user_a_id, user_b_id}:
                return conv
        return self.sudo().create({
            'is_group': False,
            'member_ids': [
                (0, 0, {'user_id': user_a_id}),
                (0, 0, {'user_id': user_b_id}),
            ],
        })

    @api.model
    def _get_or_create_self(self, user_id):
        """The user's own note-to-self chat ("Message yourself")."""
        user_id = int(user_id)
        conv = self.sudo().search([('is_self', '=', True), ('member_ids.user_id', '=', user_id)], limit=1)
        if conv:
            return conv
        return self.sudo().create({
            'is_self': True, 'is_group': False,
            'member_ids': [(0, 0, {'user_id': user_id})],
        })

    # ------------------------------------------------------------------ #
    # Membership helpers (used by the controllers)                        #
    # ------------------------------------------------------------------ #
    def _member_for(self, user_id):
        self.ensure_one()
        return self.member_ids.filtered(lambda m: m.user_id.id == int(user_id))[:1]

    def _other_members(self, user_id):
        """Active members other than `user_id` (excludes anyone who left)."""
        self.ensure_one()
        uid = int(user_id)
        return self.member_ids.filtered(lambda m: m.user_id.id != uid and not m.left_at)

    def _is_active_member(self, user_id):
        self.ensure_one()
        m = self._member_for(user_id)
        return bool(m) and not m.left_at
