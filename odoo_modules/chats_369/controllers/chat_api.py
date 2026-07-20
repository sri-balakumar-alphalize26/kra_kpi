"""369Chats JSON API for the React Native app.

Every route is `type='json', auth='user'` and resolves the caller from
`request.env.user` (the number-login session), NEVER a client-sent id. Reads use
sudo() but are always gated by an explicit membership check, mirroring how
kra_kpi's /kpi_notifications/* routes scope by user. Delivery reuses the KRA/KPI
Expo push infra (kpi.push.token) with a chat-specific `{chat_id}` payload so a
tap can open the thread.

Phase 1 = TEXT chat (1:1 + groups). Media (image/video/audio/document) and
read-tick rendering land in Phases 2 & 3; the fields already exist.
"""

from odoo import http, fields
from odoo.http import request
from datetime import timedelta
import odoo
import json
import logging
import threading
import requests
import base64
import re

_logger = logging.getLogger(__name__)
_EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
_URL_RE = re.compile(r'https?://[^\s<>"\')]+', re.IGNORECASE)
_PERM_FIELDS = ('perm_edit_info', 'perm_send', 'perm_add_members',
                'perm_send_history', 'perm_invite', 'admin_approve')


class Chat369API(http.Controller):

    # ================================================================== #
    # Helpers                                                            #
    # ================================================================== #
    def _member_conv(self, conversation_id):
        """Return (conversation, my_member) if the caller is an ACTIVE member,
        else (False, False)."""
        me = request.env.user
        conv = request.env['chat.conversation'].sudo().browse(int(conversation_id or 0))
        if not conv.exists():
            return False, False
        member = conv.member_ids.filtered(
            lambda m: m.user_id.id == me.id and not m.left_at)[:1]
        return (conv, member) if member else (False, False)

    def _member_msg(self, message_id):
        """(message, conversation, my_member) if the caller is a member of the
        message's conversation, else (False, False, False)."""
        msg = request.env['chat.message'].sudo().browse(int(message_id or 0))
        if not msg.exists():
            return False, False, False
        conv, member = self._member_conv(msg.conversation_id.id)
        if not conv:
            return False, False, False
        return msg, conv, member

    def _chat_role(self, user):
        if (user.has_group('base.group_system')
                or user.has_group('kra_kpi_module.group_kra_owner')
                or user.has_group('kra_kpi_module.group_kra_admin')):
            return 'admin'
        if user.has_group('kra_kpi_module.group_kra_client'):
            return 'client'
        return 'developer'

    def _avatar_url(self, user):
        """Cacheable avatar URL (the browser caches it) — no base64 in the payload."""
        return ('/chats_369/avatar/user/%s' % user.id) if (user and user.image_128) else False

    def _conv_avatar_url(self, conv):
        return ('/chats_369/avatar/conv/%s' % conv.id) if (conv and conv.image) else False

    def _dt(self, dt):
        """UTC datetime -> ISO 8601 'Z' string the app parses as UTC."""
        if not dt:
            return False
        return dt.strftime('%Y-%m-%dT%H:%M:%SZ')

    def _month_label(self, dt):
        """WhatsApp-style month header: 'This Month' / 'June 2026'."""
        if not dt:
            return ''
        now = fields.Datetime.now()
        if dt.year == now.year and dt.month == now.month:
            return 'This Month'
        return dt.strftime('%B %Y')

    def _group_perms(self, conv):
        return {f: bool(conv[f]) for f in _PERM_FIELDS}

    def _user_brief(self, user):
        return {
            'id': user.id,
            'name': user.name,
            'mobile': user.kpi_mobile_number or '',
            'role': self._chat_role(user),
            'avatar_url': self._avatar_url(user),
        }

    def _preview(self, msg):
        if not msg:
            return ''
        if msg.kind == 'text':
            return (msg.body or '')[:80]
        if msg.kind == 'system':
            return msg.body or ''
        labels = {
            'image': 'Photo', 'video': 'Video',
            'audio': 'Voice message', 'document': 'Document',
        }
        return labels.get(msg.kind, msg.body or '')

    def _msg_status(self, msg, conv):
        """WhatsApp-style status for the AUTHOR's own message: sent -> delivered
        -> read, from the other members' cursors (group = min across members).
        (Rendered as ticks in Phase 3; returned now so the app can adopt it.)"""
        others = conv._other_members(msg.author_id.id)
        if not others:
            return 'sent'

        def cur(m, field):
            rec = m[field]
            return rec.id if rec else 0

        if all(cur(m, 'last_read_message_id') >= msg.id for m in others):
            return 'read'
        if all(cur(m, 'delivered_up_to_message_id') >= msg.id for m in others):
            return 'delivered'
        return 'sent'

    def _serialize_message(self, msg, me_id, conv):
        media_kinds = ('image', 'video', 'audio', 'document')
        deleted = msg.deleted
        reply = msg.reply_to_id
        reply_body = ''
        if reply:
            reply_body = 'This message was deleted' if reply.deleted else (reply.body or self._preview(reply))[:120]
        return {
            'id': msg.id,
            'conversation_id': msg.conversation_id.id,
            'author_id': msg.author_id.id,
            'author_name': msg.author_id.name,
            'mine': msg.author_id.id == me_id,
            'body': '' if deleted else (msg.body or ''),
            'deleted': deleted,
            'pinned': msg._is_pinned_now(),
            'pin_expiry': self._dt(msg.pin_expiry) if (msg.pinned and msg.pin_expiry) else False,
            'kind': msg.kind,
            'file_name': '' if deleted else (msg.file_name or ''),
            'mimetype': msg.mimetype or '',
            'file_size': msg.file_size or 0,
            'duration': msg.duration or 0,
            'has_media': bool(not deleted and msg.kind in media_kinds and msg.attachment),
            'media_url': ('/chats_369/media/%s' % msg.id) if (not deleted and msg.kind in media_kinds and msg.attachment) else False,
            'reply_to_id': reply.id if reply else False,
            'reply_to_author': reply.author_id.name if reply else '',
            'reply_to_body': reply_body,
            'edited': msg.edited,
            'starred': me_id in msg.starred_user_ids.ids,
            'reactions': self._reactions_of(msg, me_id),
            'created': self._dt(msg.create_date),
            'status': self._msg_status(msg, conv),
        }

    def _reactions_of(self, msg, me_id):
        """Group a message's reactions by emoji -> [{emoji, count, mine}]."""
        groups = {}
        for r in msg.reaction_ids:
            g = groups.setdefault(r.emoji, {'emoji': r.emoji, 'count': 0, 'mine': False})
            g['count'] += 1
            if r.user_id.id == me_id:
                g['mine'] = True
        return list(groups.values())

    def _nick_for(self, me_id, target_id):
        """My private nickname for a contact, or '' if none."""
        if not target_id:
            return ''
        n = request.env['chat.nickname'].sudo().search(
            [('owner_user_id', '=', me_id), ('target_user_id', '=', int(target_id))], limit=1)
        return n.nick or ''

    def _conv_title(self, conv, me_id):
        if conv.is_group:
            return conv.name or 'Group'
        other = conv._other_members(me_id)[:1].user_id
        if not other:
            return 'Chat'
        return self._nick_for(me_id, other.id) or other.name

    def _serialize_conversation(self, conv, me_id):
        member = conv._member_for(me_id)
        others = conv._other_members(me_id)
        other_mobile = ''
        if conv.is_self:
            me_user = request.env['res.users'].sudo().browse(me_id)
            title = (me_user.name or 'You') + ' (You)'
            avatar = self._avatar_url(me_user)
            other_user_id = False
        elif conv.is_group:
            title = conv.name or 'Group'
            avatar = self._conv_avatar_url(conv)
            other_user_id = False
        else:
            other = others[:1].user_id
            title = ((self._nick_for(me_id, other.id) or other.name) if other else 'Chat')
            avatar = self._avatar_url(other) if other else False
            other_user_id = other.id if other else False
            other_mobile = (other.kpi_mobile_number or '') if other else ''
        last = conv.last_message_id
        return {
            'id': conv.id,
            'is_group': conv.is_group,
            'title': title,
            'avatar_url': avatar,
            'last_preview': self._preview(last),
            'last_kind': last.kind if last else False,
            'last_at': self._dt(conv.last_message_at),
            'unread_count': (member._unread_count() if member else 0),
            'unread': bool((member._unread_count() if member else 0) > 0 or (member and member.manual_unread)),
            'online': False,          # presence lands in Phase 3
            'pinned': bool(member.pinned) if member else False,
            'favourite': bool(member.favourite) if member else False,
            'archived': bool(member.archived) if member else False,
            'muted': bool(member and member.muted and (not member.muted_until or member.muted_until > fields.Datetime.now())),
            'manual_unread': bool(member.manual_unread) if member else False,
            'other_user_id': other_user_id,
            'other_mobile': other_mobile,
            'member_count': len(conv.member_ids.filtered(lambda m: not m.left_at)),
        }

    def _system_message(self, conv, actor, text):
        return request.env['chat.message'].sudo().create({
            'conversation_id': conv.id,
            'author_id': actor.id,
            'body': text,
            'kind': 'system',
        })

    def _push_chat(self, conv, msg, author):
        """Best-effort Expo push to the other members' devices (never raises)."""
        try:
            try:
                config = request.env['whatsapp.config'].sudo().get_config()
                if not getattr(config, 'kpi_push_enabled', True):
                    return
            except Exception:
                pass
            now = fields.Datetime.now()
            # Don't push to members who have muted this chat.
            others = conv._other_members(author.id).filtered(
                lambda m: not (m.muted and (not m.muted_until or m.muted_until > now)))
            user_ids = others.mapped('user_id').ids
            tokens = request.env['kpi.push.token'].sudo().tokens_for_users(user_ids)
            if not tokens:
                return
            preview = self._preview(msg)
            if conv.is_group:
                title = conv.name or 'Group'
                body = '%s: %s' % (author.name, preview)
            else:
                title = author.name
                body = preview
            data = {'chat_id': conv.id, 'event': 'chat_message'}
            messages = [{
                'to': tok,
                'title': (title or 'New message')[:120],
                'body': (body or 'New message')[:160],
                'data': data,
                'sound': 'default',
                'channelId': 'default',
            } for tok in tokens]
            # Fire the (slow) network POST in a daemon thread so /chat/send returns
            # in milliseconds instead of waiting on Expo (was blocking up to 10s).
            dbname = request.env.cr.dbname
            threading.Thread(target=self._push_send_async, args=(dbname, messages), daemon=True).start()
        except Exception as exc:
            _logger.warning("369chats push failed: %s", exc)

    @staticmethod
    def _push_send_async(dbname, messages):
        """Runs off-request: POST to Expo + deactivate dead tokens (fresh cursor)."""
        for i in range(0, len(messages), 100):
            batch = messages[i:i + 100]
            try:
                resp = requests.post(
                    _EXPO_PUSH_URL, data=json.dumps(batch),
                    headers={'Content-Type': 'application/json', 'Accept': 'application/json'},
                    timeout=15)
                data = resp.json().get('data') or []
                bad = [b.get('to') for b, t in zip(batch, data)
                       if isinstance(t, dict) and t.get('status') == 'error'
                       and (t.get('details') or {}).get('error') == 'DeviceNotRegistered']
                if bad:
                    with odoo.registry(dbname).cursor() as cr:
                        env = odoo.api.Environment(cr, odoo.SUPERUSER_ID, {})
                        for tok in bad:
                            env['kpi.push.token'].deactivate(tok)
                        cr.commit()
            except Exception:
                pass

    # ================================================================== #
    # Avatars — served as cacheable images (no base64 in JSON payloads)   #
    # ================================================================== #
    @http.route('/chats_369/avatar/user/<int:uid>', type='http', auth='user')
    def chat_avatar_user(self, uid, **kw):
        user = request.env['res.users'].sudo().browse(uid)
        img = user.image_128 if user.exists() else None
        if not img:
            return request.not_found()
        return request.make_response(
            base64.b64decode(img),
            [('Content-Type', 'image/png'), ('Cache-Control', 'public, max-age=3600')])

    @http.route('/chats_369/avatar/conv/<int:cid>', type='http', auth='user')
    def chat_avatar_conv(self, cid, **kw):
        conv = request.env['chat.conversation'].sudo().browse(cid)
        img = conv.image if conv.exists() else None
        if not img:
            return request.not_found()
        return request.make_response(
            base64.b64decode(img),
            [('Content-Type', 'image/png'), ('Cache-Control', 'public, max-age=3600')])

    # ================================================================== #
    # Contacts (New chat) — every company number                         #
    # ================================================================== #
    @http.route('/chat/contacts', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_contacts(self, **params):
        me = request.env.user
        users = request.env['res.users'].sudo().search([
            ('id', '!=', me.id),
            ('share', '=', False),
            ('active', '=', True),
            ('kpi_app_login_enabled', '=', True),
            ('kpi_mobile_number', '!=', False),
        ])
        q = (params.get('query') or '').strip().lower()
        out = []
        for u in users:
            if q and q not in (u.name or '').lower() and q not in (u.kpi_mobile_number or ''):
                continue
            out.append(self._user_brief(u))
        out.sort(key=lambda x: (x['name'] or '').lower())
        return {'status': True, 'contacts': out}

    # ================================================================== #
    # Dashboard — your conversations                                     #
    # ================================================================== #
    @http.route('/chat/conversations', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_conversations(self, **params):
        me = request.env.user
        flt = params.get('filter') or 'all'      # all|unread|favourites|groups|archived|<list_id>
        members = request.env['chat.member'].sudo().search([
            ('user_id', '=', me.id),
            ('left_at', '=', False),
            ('hidden', '=', False),
        ])
        # Archived chats only show under the Archived filter.
        if flt == 'archived':
            members = members.filtered(lambda m: m.archived)
        else:
            members = members.filtered(lambda m: not m.archived)

        # List filter → only conversations in that custom list.
        list_conv_ids = None
        if isinstance(flt, int) or (isinstance(flt, str) and flt.isdigit()):
            lst = request.env['chat.list'].sudo().browse(int(flt))
            if lst.exists() and lst.owner_user_id.id == me.id:
                list_conv_ids = set(lst.conversation_ids.ids)

        # "Once chatted it appears": groups always, 1:1 only after a first message.
        convs = members.mapped('conversation_id').filtered(
            lambda c: c.active and (c.is_group or c.last_message_id))
        rows = [self._serialize_conversation(c, me.id) for c in convs]

        if flt == 'unread':
            rows = [r for r in rows if r['unread']]
        elif flt == 'favourites':
            rows = [r for r in rows if r['favourite']]
        elif flt == 'groups':
            rows = [r for r in rows if r['is_group']]
        elif list_conv_ids is not None:
            rows = [r for r in rows if r['id'] in list_conv_ids]

        rows.sort(key=lambda r: (1 if r.get('pinned') else 0, r['last_at'] or ''), reverse=True)
        return {
            'status': True,
            'conversations': rows,
            'unread_total': sum(r['unread_count'] for r in rows),
        }

    @http.route('/chat/unread_total', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_unread_total(self, **params):
        me = request.env.user
        members = request.env['chat.member'].sudo().search([
            ('user_id', '=', me.id),
            ('left_at', '=', False),
        ])
        return {'status': True, 'unread_total': sum(m._unread_count() for m in members)}

    # ================================================================== #
    # Open / create conversations                                        #
    # ================================================================== #
    @http.route('/chat/open_direct', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_open_direct(self, **params):
        me = request.env.user
        other_id = int(params.get('user_id') or 0)
        other = request.env['res.users'].sudo().browse(other_id)
        if not other.exists() or other_id == me.id:
            return {'status': False, 'message': 'Invalid user.'}
        conv = request.env['chat.conversation'].sudo()._get_or_create_direct(me.id, other_id)
        return {'status': True, 'conversation': self._serialize_conversation(conv, me.id)}

    @http.route('/chat/open_self', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_open_self(self, **params):
        me = request.env.user
        conv = request.env['chat.conversation'].sudo()._get_or_create_self(me.id)
        return {'status': True, 'conversation': self._serialize_conversation(conv, me.id)}

    @http.route('/chat/create_group', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_create_group(self, **params):
        me = request.env.user
        name = (params.get('name') or '').strip()
        if not name:
            return {'status': False, 'message': 'Group name is required.'}
        ids = set()
        for x in (params.get('member_ids') or []):
            try:
                ids.add(int(x))
            except (TypeError, ValueError):
                continue
        ids.add(me.id)
        cmds = [(0, 0, {'user_id': uid, 'is_admin': uid == me.id}) for uid in ids]
        conv = request.env['chat.conversation'].sudo().create({
            'is_group': True,
            'name': name,
            'owner_id': me.id,
            'member_ids': cmds,
        })
        self._system_message(conv, me, '%s created "%s"' % (me.name, name))
        return {'status': True, 'conversation': self._serialize_conversation(conv, me.id)}

    @http.route('/chat/group/update', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_group_update(self, **params):
        me = request.env.user
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        if not conv.is_group:
            return {'status': False, 'message': 'Not a group.'}
        action = params.get('action')

        if action == 'leave':
            member.sudo().write({'left_at': fields.Datetime.now()})
            self._system_message(conv, me, '%s left' % me.name)
            return {'status': True}

        # Per-action gating (group permissions relax the old admin-only rule):
        #   rename / description / photo -> admin OR perm_edit_info
        #   add                          -> admin OR perm_add_members
        #   remove / promote             -> admin only
        is_admin = bool(member.is_admin)
        denied = {'status': False, 'message': 'Only a group admin can do that.'}
        if action in ('rename', 'description', 'photo'):
            if not (is_admin or conv.perm_edit_info):
                return denied
        elif action == 'add':
            if not (is_admin or conv.perm_add_members):
                return denied
        elif action in ('remove', 'promote'):
            if not is_admin:
                return denied
        else:
            return {'status': False, 'message': 'Unknown action.'}

        if action == 'rename':
            new = (params.get('name') or '').strip()
            if not new:
                return {'status': False, 'message': 'Name required.'}
            conv.sudo().write({'name': new})
            self._system_message(conv, me, '%s renamed the group to "%s"' % (me.name, new))
        elif action == 'description':
            desc = (params.get('description') or '').strip()
            conv.sudo().write({'description': desc})
            self._system_message(conv, me, '%s changed the group description' % me.name)
        elif action == 'add':
            for x in (params.get('member_ids') or []):
                try:
                    uid = int(x)
                except (TypeError, ValueError):
                    continue
                existing = conv.member_ids.filtered(lambda m: m.user_id.id == uid)
                if existing:
                    existing.sudo().write({'left_at': False})
                else:
                    request.env['chat.member'].sudo().create({
                        'conversation_id': conv.id, 'user_id': uid})
                u = request.env['res.users'].sudo().browse(uid)
                self._system_message(conv, me, '%s added %s' % (me.name, u.name))
        elif action == 'remove':
            uid = int(params.get('user_id') or 0)
            tgt = conv.member_ids.filtered(lambda m: m.user_id.id == uid and not m.left_at)
            if tgt:
                uname = tgt.user_id.name
                tgt.sudo().write({'left_at': fields.Datetime.now()})
                self._system_message(conv, me, '%s removed %s' % (me.name, uname))
        elif action == 'photo':
            conv.sudo().write({'image': params.get('image_b64') or False})
            self._system_message(conv, me, '%s changed the group photo' % me.name)
        elif action == 'promote':
            uid = int(params.get('user_id') or 0)
            tgt = conv.member_ids.filtered(lambda m: m.user_id.id == uid and not m.left_at)
            if tgt:
                tgt.sudo().write({'is_admin': not tgt.is_admin})
                self._system_message(conv, me, '%s is now %s' % (
                    tgt.user_id.name, 'an admin' if tgt.is_admin else 'no longer an admin'))
        return {'status': True, 'conversation': self._serialize_conversation(conv, me.id)}

    @http.route('/chat/group/permissions', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_group_permissions(self, **params):
        """Read (no field) or set (admin-only) a group's permission toggles."""
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        if not conv.is_group:
            return {'status': False, 'message': 'Not a group.'}
        field = params.get('field')
        if field:
            if not member.is_admin:
                return {'status': False, 'message': 'Only a group admin can do that.'}
            if field not in _PERM_FIELDS:
                return {'status': False, 'message': 'Unknown permission.'}
            conv.sudo().write({field: bool(params.get('value'))})
        return {'status': True, 'permissions': self._group_perms(conv)}

    @http.route('/chat/media_list', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_media_list(self, **params):
        """Media / Docs / Links of a chat, newest-first with a month header.
        tab 'media' -> image|video; 'docs' -> document|audio;
        'links' -> messages whose body contains an http(s) URL."""
        me = request.env.user
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        tab = params.get('tab') or 'media'
        Msg = request.env['chat.message'].sudo()
        base = [('conversation_id', '=', conv.id), ('deleted', '=', False),
                ('hidden_for_user_ids', 'not in', [me.id])]
        items = []
        if tab == 'links':
            msgs = Msg.search(base + [('kind', '!=', 'system'), ('body', 'ilike', 'http')],
                              order='id desc', limit=300)
            for m in msgs:
                match = _URL_RE.search(m.body or '')
                if not match:
                    continue
                url = match.group(0)
                items.append({
                    'id': m.id, 'kind': 'link', 'url': url, 'name': url,
                    'created': self._dt(m.create_date),
                    'month_label': self._month_label(m.create_date),
                })
        else:
            kinds = ['image', 'video'] if tab == 'media' else ['document', 'audio']
            msgs = Msg.search(base + [('kind', 'in', kinds), ('attachment', '!=', False)],
                              order='id desc', limit=300)
            for m in msgs:
                items.append({
                    'id': m.id, 'kind': m.kind,
                    'url': '/chats_369/media/%s' % m.id,
                    'name': m.file_name or (m.kind or '').title(),
                    'created': self._dt(m.create_date),
                    'month_label': self._month_label(m.create_date),
                })
        return {'status': True, 'items': items}

    # ================================================================== #
    # Messages                                                           #
    # ================================================================== #
    @http.route('/chat/messages', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_messages(self, **params):
        me = request.env.user
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        Message = request.env['chat.message'].sudo()
        # Exclude messages this user "deleted for me".
        domain = [('conversation_id', '=', conv.id), ('hidden_for_user_ids', 'not in', [me.id])]
        after_id = int(params.get('after_id') or 0)
        before_id = int(params.get('before_id') or 0)
        limit = min(int(params.get('limit') or 50), 100)

        if after_id:
            msgs = Message.search(domain + [('id', '>', after_id)], order='id asc', limit=limit)
        elif before_id:
            msgs = Message.search(domain + [('id', '<', before_id)], order='id desc', limit=limit).sorted('id')
        else:
            msgs = Message.search(domain, order='id desc', limit=limit).sorted('id')

        # Bump the caller's delivered cursor to the newest message they've now fetched.
        if msgs:
            top = msgs[-1].id
            cur = member.delivered_up_to_message_id.id if member.delivered_up_to_message_id else 0
            if top > cur:
                member.sudo().write({'delivered_up_to_message_id': top})

        return {
            'status': True,
            'messages': [self._serialize_message(m, me.id, conv) for m in msgs],
        }

    @http.route('/chat/send', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_send(self, **params):
        me = request.env.user
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        if conv.is_group and not member.is_admin and not conv.perm_send:
            return {'status': False, 'message': 'Only admins can send messages in this group.'}
        body = (params.get('body') or '').strip()
        if not body:
            return {'status': False, 'message': 'Empty message.'}
        vals = {
            'conversation_id': conv.id,
            'author_id': me.id,
            'body': body,
            'kind': 'text',
        }
        rid = int(params.get('reply_to_id') or 0)
        if rid:
            r = request.env['chat.message'].sudo().browse(rid)
            if r.exists() and r.conversation_id.id == conv.id:
                vals['reply_to_id'] = rid
        msg = request.env['chat.message'].sudo().create(vals)
        # The author has, by definition, read + received their own message.
        member.sudo().write({
            'last_read_message_id': msg.id,
            'delivered_up_to_message_id': msg.id,
        })
        self._push_chat(conv, msg, me)
        return {'status': True, 'message': self._serialize_message(msg, me.id, conv)}

    MEDIA_LIMITS = {'image': 10 * 1024 * 1024, 'video': 16 * 1024 * 1024,
                    'audio': 16 * 1024 * 1024, 'document': 25 * 1024 * 1024}

    @http.route('/chat/send_media', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_send_media(self, **params):
        """Send an image / video / audio / document (base64). Size-limited per kind."""
        me = request.env.user
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        if conv.is_group and not member.is_admin and not conv.perm_send:
            return {'status': False, 'message': 'Only admins can send messages in this group.'}
        kind = params.get('kind') or 'document'
        if kind not in ('image', 'video', 'audio', 'document'):
            kind = 'document'
        file_b64 = params.get('file_b64') or ''
        if not file_b64:
            return {'status': False, 'message': 'No file.'}
        try:
            size = len(base64.b64decode(file_b64))
        except Exception:
            return {'status': False, 'message': 'Bad file.'}
        if size > self.MEDIA_LIMITS.get(kind, 25 * 1024 * 1024):
            mb = self.MEDIA_LIMITS.get(kind, 0) // (1024 * 1024)
            return {'status': False, 'message': '%s is too large (max %s MB).' % (kind.title(), mb)}
        vals = {
            'conversation_id': conv.id, 'author_id': me.id, 'kind': kind,
            'body': (params.get('caption') or '').strip(),
            'attachment': file_b64, 'file_name': (params.get('file_name') or '')[:200],
            'mimetype': (params.get('mimetype') or '')[:100], 'file_size': size,
            'duration': int(params.get('duration') or 0),
        }
        rid = int(params.get('reply_to_id') or 0)
        if rid:
            r = request.env['chat.message'].sudo().browse(rid)
            if r.exists() and r.conversation_id.id == conv.id:
                vals['reply_to_id'] = rid
        msg = request.env['chat.message'].sudo().create(vals)
        member.sudo().write({'last_read_message_id': msg.id, 'delivered_up_to_message_id': msg.id})
        self._push_chat(conv, msg, me)
        return {'status': True, 'message': self._serialize_message(msg, me.id, conv)}

    @http.route('/chats_369/media/<int:msg_id>', type='http', auth='user')
    def chat_media(self, msg_id, **kw):
        me = request.env.user
        msg = request.env['chat.message'].sudo().browse(msg_id)
        if not msg.exists() or not msg.attachment or msg.deleted:
            return request.not_found()
        if me.id not in msg.conversation_id.member_ids.mapped('user_id').ids:
            return request.not_found()
        data = base64.b64decode(msg.attachment)
        headers = [('Content-Type', msg.mimetype or 'application/octet-stream'),
                   ('Cache-Control', 'private, max-age=3600')]
        if msg.kind == 'document':
            headers.append(('Content-Disposition', 'attachment; filename="%s"' % (msg.file_name or 'file')))
        return request.make_response(data, headers)

    @http.route('/chat/mark_read', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_mark_read(self, **params):
        me = request.env.user
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        if member.manual_unread:
            member.sudo().write({'manual_unread': False})   # opening clears "marked unread"
        up_to = int(params.get('up_to_message_id') or 0)
        if not up_to:
            last = request.env['chat.message'].sudo().search(
                [('conversation_id', '=', conv.id)], order='id desc', limit=1)
            up_to = last.id if last else 0
        if up_to:
            vals = {}
            read_cur = member.last_read_message_id.id if member.last_read_message_id else 0
            deliv_cur = member.delivered_up_to_message_id.id if member.delivered_up_to_message_id else 0
            if up_to > read_cur:
                vals['last_read_message_id'] = up_to
            if up_to > deliv_cur:
                vals['delivered_up_to_message_id'] = up_to
            if vals:
                member.sudo().write(vals)
        return {'status': True}

    # ================================================================== #
    # Pin chat · Pin message · Delete message · Pinned list               #
    # ================================================================== #
    @http.route('/chat/pin_conversation', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_pin_conversation(self, **params):
        """Pin/unpin a chat to the top of MY dashboard (per-user). Max 3 pinned
        chats, like WhatsApp."""
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        pinned = bool(params.get('pinned'))
        if pinned and not member.pinned:
            count = request.env['chat.member'].sudo().search_count([
                ('user_id', '=', request.env.user.id),
                ('pinned', '=', True),
                ('left_at', '=', False),
            ])
            if count >= 3:
                return {'status': False, 'message': 'You can only pin up to 3 chats.'}
        member.sudo().write({'pinned': pinned})
        return {'status': True}

    MAX_MSG_PINS = 3   # per chat (WhatsApp-style)

    @http.route('/chat/pin_message', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_pin_message(self, **params):
        """Pin/unpin a message for everyone in the chat. Pins auto-expire after
        1/7/14/30 days; max 5 active pins per chat (mirrors customer_support)."""
        msg, conv, member = self._member_msg(params.get('message_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        pinned = bool(params.get('pinned'))
        if pinned:
            if not msg._is_pinned_now():
                now = fields.Datetime.now()
                active = request.env['chat.message'].sudo().search([
                    ('conversation_id', '=', conv.id),
                    ('pinned', '=', True),
                    ('deleted', '=', False),
                ]).filtered(lambda m: not m.pin_expiry or m.pin_expiry > now)
                if len(active) >= self.MAX_MSG_PINS:
                    return {'status': False,
                            'message': 'You can pin up to %s messages in a chat.' % self.MAX_MSG_PINS}
            days = int(params.get('days') or 7)
            if days not in (1, 7, 14, 30):
                days = 7
            msg.sudo().write({'pinned': True,
                              'pin_expiry': fields.Datetime.now() + timedelta(days=days)})
        else:
            msg.sudo().write({'pinned': False, 'pin_expiry': False})
        return {'status': True, 'message': self._serialize_message(msg, request.env.user.id, conv)}

    @http.route('/chat/delete_message', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_delete_message(self, **params):
        """scope='me' → hide from my view only; scope='everyone' → soft-delete for
        all ("This message was deleted"), author only."""
        msg, conv, member = self._member_msg(params.get('message_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        me = request.env.user
        scope = params.get('scope') or 'everyone'
        if scope == 'me':
            msg.sudo().write({'hidden_for_user_ids': [(4, me.id)]})
            return {'status': True, 'removed': True, 'message_id': msg.id}
        if msg.author_id.id != me.id:
            return {'status': False, 'message': 'You can only delete your own messages for everyone.'}
        msg.sudo().write({'deleted': True, 'pinned': False, 'pin_expiry': False})
        return {'status': True, 'message': self._serialize_message(msg, me.id, conv)}

    @http.route('/chat/edit_message', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_edit_message(self, **params):
        """Edit your own text message (marks it 'edited')."""
        msg, conv, member = self._member_msg(params.get('message_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        if msg.author_id.id != request.env.user.id:
            return {'status': False, 'message': 'You can only edit your own messages.'}
        if msg.deleted:
            return {'status': False, 'message': 'Cannot edit a deleted message.'}
        body = (params.get('body') or '').strip()
        if not body:
            return {'status': False, 'message': 'Message cannot be empty.'}
        msg.sudo().write({'body': body, 'edited': True})
        return {'status': True, 'message': self._serialize_message(msg, request.env.user.id, conv)}

    @http.route('/chat/react', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_react(self, **params):
        """Toggle/replace my emoji reaction on a message (one per user per msg)."""
        msg, conv, member = self._member_msg(params.get('message_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        me = request.env.user
        emoji = (params.get('emoji') or '').strip()
        R = request.env['chat.message.reaction'].sudo()
        existing = R.search([('message_id', '=', msg.id), ('user_id', '=', me.id)], limit=1)
        if existing:
            if not emoji or existing.emoji == emoji:
                existing.unlink()            # tap same → remove
            else:
                existing.write({'emoji': emoji})   # different → replace
        elif emoji:
            R.create({'message_id': msg.id, 'user_id': me.id, 'emoji': emoji})
        msg.invalidate_recordset(['reaction_ids'])
        return {'status': True, 'message': self._serialize_message(msg, me.id, conv)}

    @http.route('/chat/star', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_star(self, **params):
        """Star/unstar a message for me (bookmark)."""
        msg, conv, member = self._member_msg(params.get('message_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        me = request.env.user
        cmd = (4, me.id) if bool(params.get('starred')) else (3, me.id)
        msg.sudo().write({'starred_user_ids': [cmd]})
        return {'status': True, 'message': self._serialize_message(msg, me.id, conv)}

    @http.route('/chat/forward', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_forward(self, **params):
        """Forward a message's text into another chat I'm a member of."""
        src, sconv, smember = self._member_msg(params.get('message_id'))
        if not sconv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        tconv, tmember = self._member_conv(params.get('to_conversation_id'))
        if not tconv:
            return {'status': False, 'message': 'Not a member of the target chat.'}
        me = request.env.user
        body = '' if src.deleted else (src.body or '')
        if not body:
            return {'status': False, 'message': 'Nothing to forward.'}
        msg = request.env['chat.message'].sudo().create({
            'conversation_id': tconv.id, 'author_id': me.id, 'body': body, 'kind': 'text',
        })
        tmember.sudo().write({'last_read_message_id': msg.id, 'delivered_up_to_message_id': msg.id})
        self._push_chat(tconv, msg, me)
        return {'status': True}

    @http.route('/chat/starred_messages', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_starred_messages(self, **params):
        """All messages I've starred, across my chats (WhatsApp 'Starred messages')."""
        me = request.env.user
        mem = request.env['chat.member'].sudo().search([('user_id', '=', me.id), ('left_at', '=', False)])
        conv_ids = mem.mapped('conversation_id').ids
        msgs = request.env['chat.message'].sudo().search([
            ('conversation_id', 'in', conv_ids),
            ('starred_user_ids', 'in', [me.id]),
            ('deleted', '=', False),
            ('hidden_for_user_ids', 'not in', [me.id]),
        ], order='id desc', limit=200)
        out = []
        for m in msgs:
            d = self._serialize_message(m, me.id, m.conversation_id)
            d['conversation_title'] = self._conv_title(m.conversation_id, me.id)
            out.append(d)
        return {'status': True, 'messages': out}

    @http.route('/chat/mark_all_read', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_mark_all_read(self, **params):
        """Mark every one of my chats as read."""
        me = request.env.user
        mem = request.env['chat.member'].sudo().search([('user_id', '=', me.id), ('left_at', '=', False)])
        for member in mem:
            last = request.env['chat.message'].sudo().search(
                [('conversation_id', '=', member.conversation_id.id)], order='id desc', limit=1)
            vals = {'manual_unread': False}
            if last:
                vals.update({'last_read_message_id': last.id, 'delivered_up_to_message_id': last.id})
            member.write(vals)
        return {'status': True}

    # ================================================================== #
    # Chat-row actions: archive · mark-unread · favourite · mute · clear · leave
    # ================================================================== #
    @http.route('/chat/archive', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_archive(self, **params):
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        member.sudo().write({'archived': bool(params.get('archived'))})
        return {'status': True}

    @http.route('/chat/mark_unread', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_mark_unread(self, **params):
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        member.sudo().write({'manual_unread': True})
        return {'status': True}

    @http.route('/chat/favourite', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_favourite(self, **params):
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        member.sudo().write({'favourite': bool(params.get('favourite'))})
        return {'status': True}

    @http.route('/chat/mute', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_mute(self, **params):
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        if bool(params.get('muted')):
            hours = int(params.get('hours') or 0)   # 0 = Always
            until = (fields.Datetime.now() + timedelta(hours=hours)) if hours > 0 else False
            member.sudo().write({'muted': True, 'muted_until': until})
        else:
            member.sudo().write({'muted': False, 'muted_until': False})
        return {'status': True}

    @http.route('/chat/clear_chat', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_clear_chat(self, **params):
        """Empty the thread for ME (hide every current message)."""
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        me = request.env.user
        msgs = request.env['chat.message'].sudo().search([('conversation_id', '=', conv.id)])
        if msgs:
            msgs.write({'hidden_for_user_ids': [(4, me.id)]})
        return {'status': True}

    @http.route('/chat/leave_chat', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_leave_chat(self, **params):
        """Group → leave; 1:1 → remove from my dashboard (reappears on a new msg)."""
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        me = request.env.user
        if conv.is_group:
            member.sudo().write({'left_at': fields.Datetime.now()})
            self._system_message(conv, me, '%s left' % me.name)
        else:
            member.sudo().write({'hidden': True})
        return {'status': True}

    # ================================================================== #
    # Custom Lists (WhatsApp "Lists")                                     #
    # ================================================================== #
    @http.route('/chat/lists', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_lists(self, **params):
        me = request.env.user
        conv_id = int(params.get('conversation_id') or 0)
        lists = request.env['chat.list'].sudo().search([('owner_user_id', '=', me.id)])
        out = [{
            'id': l.id, 'name': l.name, 'emoji': l.emoji or '',
            'count': len(l.conversation_ids),
            'has': (conv_id in l.conversation_ids.ids) if conv_id else False,
        } for l in lists]
        return {'status': True, 'lists': out}

    @http.route('/chat/create_list', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_create_list(self, **params):
        me = request.env.user
        name = (params.get('name') or '').strip()
        if not name:
            return {'status': False, 'message': 'List name is required.'}
        my_convs = set(request.env['chat.member'].sudo().search(
            [('user_id', '=', me.id), ('left_at', '=', False)]).mapped('conversation_id').ids)
        conv_ids = [int(x) for x in (params.get('conversation_ids') or []) if int(x) in my_convs]
        lst = request.env['chat.list'].sudo().create({
            'owner_user_id': me.id, 'name': name, 'emoji': (params.get('emoji') or ''),
            'conversation_ids': [(6, 0, conv_ids)],
        })
        return {'status': True, 'list_id': lst.id}

    @http.route('/chat/list_toggle', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_list_toggle(self, **params):
        me = request.env.user
        lst = request.env['chat.list'].sudo().browse(int(params.get('list_id') or 0))
        if not lst.exists() or lst.owner_user_id.id != me.id:
            return {'status': False, 'message': 'List not found.'}
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        cmd = (3, conv.id) if conv.id in lst.conversation_ids.ids else (4, conv.id)
        lst.sudo().write({'conversation_ids': [cmd]})
        return {'status': True, 'has': cmd[0] == 4, 'count': len(lst.conversation_ids)}

    @http.route('/chat/delete_list', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_delete_list(self, **params):
        me = request.env.user
        lst = request.env['chat.list'].sudo().browse(int(params.get('list_id') or 0))
        if lst.exists() and lst.owner_user_id.id == me.id:
            lst.unlink()
        return {'status': True}

    # ================================================================== #
    # Contact / Group info · nickname · in-chat search                    #
    # ================================================================== #
    @http.route('/chat/set_nickname', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_set_nickname(self, **params):
        me = request.env.user
        uid = int(params.get('user_id') or 0)
        nick = (params.get('nick') or '').strip()
        if not request.env['res.users'].sudo().browse(uid).exists():
            return {'status': False, 'message': 'User not found.'}
        N = request.env['chat.nickname'].sudo()
        rec = N.search([('owner_user_id', '=', me.id), ('target_user_id', '=', uid)], limit=1)
        if nick:
            if rec:
                rec.write({'nick': nick})
            else:
                N.create({'owner_user_id': me.id, 'target_user_id': uid, 'nick': nick})
        elif rec:
            rec.unlink()
        return {'status': True}

    @http.route('/chat/contact_info', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_contact_info(self, **params):
        me = request.env.user
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        Msg = request.env['chat.message'].sudo()
        base = [('conversation_id', '=', conv.id), ('deleted', '=', False),
                ('hidden_for_user_ids', 'not in', [me.id])]
        info = {
            'conversation_id': conv.id, 'is_group': conv.is_group, 'is_self': conv.is_self,
            'title': self._conv_title(conv, me.id),
            'favourite': bool(member.favourite), 'muted': bool(member.muted),
            'media': {
                'photos': Msg.search_count(base + [('kind', '=', 'image')]),
                'videos': Msg.search_count(base + [('kind', '=', 'video')]),
                'docs': Msg.search_count(base + [('kind', 'in', ['document', 'audio'])]),
            },
        }
        if conv.is_group:
            active = conv.member_ids.filtered(lambda m: not m.left_at)
            info.update({
                'name': conv.name or '', 'member_count': len(active), 'me_id': me.id,
                'description': conv.description or '',
                'permissions': self._group_perms(conv),
                'avatar_url': self._conv_avatar_url(conv), 'is_admin': bool(member.is_admin),
                'members': [{'id': m.user_id.id, 'name': m.user_id.name, 'is_admin': m.is_admin,
                             'mobile': m.user_id.kpi_mobile_number or '',
                             'avatar_url': self._avatar_url(m.user_id)} for m in active],
            })
        else:
            other = conv._other_members(me.id)[:1].user_id
            info.update({
                'user_id': other.id if other else False,
                'name': (other.name if other else ''),
                'mobile': ((other.kpi_mobile_number or '') if other else ''),
                'role': (self._chat_role(other) if other else ''),
                'nickname': (self._nick_for(me.id, other.id) if other else ''),
                'avatar_url': (self._avatar_url(other) if other else False),
            })
        return {'status': True, 'info': info}

    @http.route('/chat/search_messages', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_search_messages(self, **params):
        me = request.env.user
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        q = (params.get('query') or '').strip()
        date = params.get('date')
        Msg = request.env['chat.message'].sudo()
        domain = [('conversation_id', '=', conv.id), ('deleted', '=', False),
                  ('kind', '!=', 'system'), ('hidden_for_user_ids', 'not in', [me.id])]
        if q:
            domain.append(('body', 'ilike', q))
        if date:
            domain += [('create_date', '>=', date + ' 00:00:00'), ('create_date', '<=', date + ' 23:59:59')]
        msgs = Msg.search(domain, order='id desc', limit=100)
        return {'status': True, 'messages': [self._serialize_message(m, me.id, conv) for m in msgs]}

    @http.route('/chat/messages_around', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_messages_around(self, **params):
        me = request.env.user
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        mid = int(params.get('message_id') or 0)
        Msg = request.env['chat.message'].sudo()
        base = [('conversation_id', '=', conv.id), ('hidden_for_user_ids', 'not in', [me.id])]
        before = Msg.search(base + [('id', '<=', mid)], order='id desc', limit=30).sorted('id')
        after = Msg.search(base + [('id', '>', mid)], order='id asc', limit=30)
        msgs = before + after
        return {'status': True, 'messages': [self._serialize_message(m, me.id, conv) for m in msgs]}

    @http.route('/chat/pinned_messages', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_pinned_messages(self, **params):
        """The currently-pinned (not expired, not deleted) messages of a chat."""
        me = request.env.user
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        now = fields.Datetime.now()
        msgs = request.env['chat.message'].sudo().search([
            ('conversation_id', '=', conv.id),
            ('pinned', '=', True),
            ('deleted', '=', False),
            ('hidden_for_user_ids', 'not in', [me.id]),
        ], order='id desc')
        msgs = msgs.filtered(lambda m: not m.pin_expiry or m.pin_expiry > now)
        return {'status': True, 'messages': [self._serialize_message(m, me.id, conv) for m in msgs]}
