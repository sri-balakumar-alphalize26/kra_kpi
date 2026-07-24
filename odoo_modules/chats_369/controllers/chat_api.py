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
import hashlib
import re
import uuid

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
        if msg.kind == 'poll':
            return '📊 %s' % (msg.body or 'Poll')
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

        delivered = all(cur(m, 'delivered_up_to_message_id') >= msg.id for m in others)
        if conv.is_group:
            read = all(cur(m, 'last_read_message_id') >= msg.id for m in others)
        else:
            # 1:1 respects read receipts: sender must send theirs to ever see 'read',
            # and the reader must send theirs for it to count.
            read = msg.author_id.chat_read_receipts and all(
                (cur(m, 'last_read_message_id') >= msg.id and m.user_id.chat_read_receipts)
                for m in others)
        if read:
            return 'read'
        if delivered:
            return 'delivered'
        return 'sent'

    # ================================================================== #
    # Realtime (bus) + presence helpers                                   #
    # ================================================================== #
    _ONLINE_WINDOW = 45   # seconds since chat_last_seen to still count as "online"

    def _user_channel(self, user):
        """Non-guessable per-user bus channel so members can't eavesdrop by uid."""
        secret = request.env['ir.config_parameter'].sudo().get_param('database.secret') or 'chat369'
        tok = hashlib.sha256(('chat369:%s:%s' % (user.id, secret)).encode()).hexdigest()[:20]
        return 'chat369_%s_%s' % (user.id, tok)

    def _bus_message(self, conv, msg, event='message', exclude_uid=None):
        """Push a PER-RECIPIENT serialized message to each active member's channel
        so 'mine'/reactions/starred/status are correct for every viewer."""
        Bus = request.env['bus.bus'].sudo()
        for m in conv.member_ids.filtered(lambda x: not x.left_at):
            uid = m.user_id.id
            if exclude_uid and uid == exclude_uid:
                continue
            Bus._sendone(self._user_channel(m.user_id), 'chat369.event', {
                'event': event, 'conversation_id': conv.id,
                'message': self._serialize_message(msg, uid, conv),
            })

    def _bus_conv(self, conv, event, payload, exclude_uid=None):
        """Push a lightweight event (read/delivered receipt, typing) to members."""
        Bus = request.env['bus.bus'].sudo()
        data = dict(payload)
        data['event'] = event
        data['conversation_id'] = conv.id
        for m in conv.member_ids.filtered(lambda x: not x.left_at):
            uid = m.user_id.id
            if exclude_uid and uid == exclude_uid:
                continue
            Bus._sendone(self._user_channel(m.user_id), 'chat369.event', data)

    def _presence(self, me, other):
        """{'online':bool,'last_seen':iso|False} for `other`, honouring the privacy
        settings + WhatsApp reciprocity (hide your last seen -> can't see others')."""
        res = {'online': False, 'last_seen': False}
        if not other:
            return res
        # No presence either way when one of you has blocked the other.
        if other.id in me.chat_blocked_user_ids.ids or me.id in other.chat_blocked_user_ids.ids:
            return res
        now = fields.Datetime.now()
        i_hide = (me.chat_last_seen_privacy == 'nobody')
        ls_ok = (other.chat_last_seen_privacy != 'nobody') and not i_hide
        is_online = bool(other.chat_last_seen
                         and (now - other.chat_last_seen) < timedelta(seconds=self._ONLINE_WINDOW))
        online_ok = True if other.chat_online_privacy == 'everyone' else ls_ok
        if is_online and online_ok:
            res['online'] = True
        elif ls_ok and other.chat_last_seen:
            res['last_seen'] = self._dt(other.chat_last_seen)
        return res

    def _link_preview(self, msg):
        """A fetched link-preview card for a text message, or False."""
        if msg.deleted or not msg.link_done or not (msg.link_title or msg.link_image):
            return False
        return {
            'url': msg.link_url or '', 'title': msg.link_title or '',
            'desc': msg.link_desc or '', 'image': msg.link_image or '',
        }

    def _serialize_message(self, msg, me_id, conv):
        media_kinds = ('image', 'video', 'audio', 'document')
        deleted = msg.deleted
        # View once: media is served until it's been opened — never to the sender,
        # and to a recipient only until they've viewed it a single time.
        media_ok = bool(not deleted and msg.kind in media_kinds and msg.attachment)
        if media_ok and msg.view_once:
            if msg.author_id.id == me_id or me_id in msg.viewed_by_user_ids.ids:
                media_ok = False
        reply = msg.reply_to_id
        reply_body = ''
        reply_author = reply.author_id.name if reply else ''
        if reply:
            reply_body = 'This message was deleted' if reply.deleted else (reply.body or self._preview(reply))[:120]
        elif msg.quote_author or msg.quote_body:
            # Cross-chat "reply privately" quote — render in the same quote block.
            reply_author = msg.quote_author or ''
            reply_body = (msg.quote_body or '')[:120]
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
            'has_media': media_ok,
            'media_url': ('/chats_369/media/%s' % msg.id) if media_ok else False,
            'view_once': msg.view_once,
            'viewed': me_id in msg.viewed_by_user_ids.ids,
            'link': self._link_preview(msg),
            'reply_to_id': reply.id if reply else False,
            'reply_to_author': reply_author,
            'reply_to_body': reply_body,
            'quoted': bool(reply or msg.quote_author or msg.quote_body),
            'edited': msg.edited,
            'forwarded': msg.forwarded,
            'is_meet': msg.is_meet,
            'poll': self._serialize_poll(msg, me_id) if msg.kind == 'poll' else False,
            'starred': me_id in msg.starred_user_ids.ids,
            'reactions': self._reactions_of(msg, me_id),
            'created': self._dt(msg.create_date),
            'status': self._msg_status(msg, conv),
        }

    def _serialize_poll(self, msg, me_id):
        """Live poll tally for a poll message: options with counts + my votes."""
        poll = request.env['chat.poll'].sudo().search([('message_id', '=', msg.id)], limit=1)
        if not poll:
            return False
        options = []
        voters = set()
        for opt in poll.option_ids:
            uids = opt.vote_ids.mapped('user_id').ids
            voters.update(uids)
            options.append({
                'id': opt.id, 'text': opt.text or '',
                'votes': len(uids), 'mine': me_id in uids,
            })
        return {
            'question': poll.question or '', 'multi': poll.multi,
            'options': options, 'total': len(voters),
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
        blocked_by_me = False
        presence = {'online': False, 'last_seen': False}
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
            if other:
                me_user = request.env['res.users'].sudo().browse(me_id)
                presence = self._presence(me_user, other)
                blocked_by_me = other.id in me_user.chat_blocked_user_ids.ids
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
            'online': presence['online'],
            'last_seen': presence['last_seen'],
            'pinned': bool(member.pinned) if member else False,
            'favourite': bool(member.favourite) if member else False,
            'archived': bool(member.archived) if member else False,
            'muted': bool(member and member.muted and (not member.muted_until or member.muted_until > fields.Datetime.now())),
            'manual_unread': bool(member.manual_unread) if member else False,
            'other_user_id': other_user_id,
            'other_mobile': other_mobile,
            'blocked_by_me': blocked_by_me,
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
            if getattr(msg, 'is_meet', False):
                preview = '📹 Please join the meeting'   # meet link → everyone gets a clear "join" push
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

    def _notify_mentions(self, conv, msg, author, body):
        """Group @mentions → a distinct 'X mentioned you' push to those members
        (@all = everyone). Best-effort, never raises."""
        try:
            if not conv.is_group or not body or '@' not in body:
                return
            low = body.lower()
            others = conv._other_members(author.id).filtered(lambda m: not m.left_at)
            if '@all' in low:
                targets = others
            else:
                targets = others.filtered(
                    lambda m: m.user_id and ('@' + (m.user_id.name or '')).lower() in low)
            if not targets:
                return
            tokens = request.env['kpi.push.token'].sudo().tokens_for_users(targets.mapped('user_id').ids)
            if not tokens:
                return
            gname = conv.name or 'Group'
            messages = [{
                'to': tok,
                'title': '💬 %s' % gname[:110],
                'body': '%s mentioned you' % (author.name or 'Someone')[:150],
                'data': {'chat_id': conv.id, 'event': 'chat_mention'},
                'sound': 'default', 'channelId': 'default',
            } for tok in tokens]
            dbname = request.env.cr.dbname
            threading.Thread(target=self._push_send_async, args=(dbname, messages), daemon=True).start()
        except Exception as exc:
            _logger.warning("369chats mention notify failed: %s", exc)

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
                    from odoo.modules.registry import Registry
                    with Registry(dbname).cursor() as cr:
                        env = odoo.api.Environment(cr, odoo.SUPERUSER_ID, {})
                        for tok in bad:
                            env['kpi.push.token'].deactivate(tok)
                        cr.commit()
            except Exception:
                pass

    @staticmethod
    def _url_is_private(url):
        """SSRF guard: True if the URL points at localhost / a private network,
        so we never let a pasted link make the server fetch its own intranet."""
        from urllib.parse import urlparse
        host = (urlparse(url).hostname or '').lower()
        if not host or host == 'localhost' or host.endswith('.local') or host.endswith('.internal'):
            return True
        if host.startswith(('127.', '10.', '192.168.', '169.254.', '0.')):
            return True
        if host.startswith('172.'):
            try:
                if 16 <= int(host.split('.')[1]) <= 31:
                    return True
            except (ValueError, IndexError):
                pass
        return False

    @staticmethod
    def _scrape_og(url):
        """Fetch a URL and pull its Open Graph title/description/image. Best-effort;
        returns {'title','desc','image'} (empty strings on any failure)."""
        from urllib.parse import urljoin
        out = {'title': '', 'desc': '', 'image': ''}
        # Normalise a capitalized scheme (e.g. "Https://") so the fetch always works.
        url = re.sub(r'^\s*(https?)://', lambda m: m.group(1).lower() + '://', url, flags=re.I)
        try:
            resp = requests.get(
                url, timeout=6, allow_redirects=True, stream=True,
                headers={'User-Agent': 'Mozilla/5.0 (369Chats link preview)'})
            html = ''
            if 'html' in (resp.headers.get('Content-Type') or ''):
                raw = resp.raw.read(200000, decode_content=True) or b''
                html = raw.decode(resp.encoding or 'utf-8', 'ignore')

            def meta(prop):
                p = re.escape(prop)
                m = re.search(r'<meta[^>]+(?:property|name)=["\']%s["\'][^>]*content=["\']([^"\']*)["\']' % p, html, re.I)
                if not m:
                    m = re.search(r'<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']%s["\']' % p, html, re.I)
                return (m.group(1).strip() if m else '')

            title = meta('og:title')
            if not title:
                tm = re.search(r'<title[^>]*>([^<]*)</title>', html, re.I)
                title = tm.group(1).strip() if tm else ''
            image = meta('og:image')
            out['title'] = title
            out['desc'] = meta('og:description') or meta('description')
            out['image'] = urljoin(url, image) if image else ''
        except Exception:
            pass
        return out

    @classmethod
    def _fetch_link_preview_async(cls, dbname, msg_id, url):
        """Runs off-request: scrape the URL's card and store it on the message (the
        client picks it up on its next poll). Best-effort."""
        data = cls._scrape_og(url)
        try:
            from odoo.modules.registry import Registry
            with Registry(dbname).cursor() as cr:
                env = odoo.api.Environment(cr, odoo.SUPERUSER_ID, {})
                msg = env['chat.message'].browse(msg_id)
                if msg.exists():
                    msg.write({
                        'link_title': (data['title'] or '')[:200], 'link_desc': (data['desc'] or '')[:300],
                        'link_image': (data['image'] or '')[:600], 'link_done': True,
                    })
                    cr.commit()
        except Exception as exc:
            _logger.warning("369chats link preview failed: %s", exc)

    def _is_blocked(self, me, other):
        """True if either side has blocked the other (1:1 messaging is refused)."""
        if not other:
            return False
        return other.id in me.chat_blocked_user_ids.ids or me.id in other.chat_blocked_user_ids.ids

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
        me._chat_touch_presence()                 # polling this keeps my presence fresh
        flt = params.get('filter') or 'all'      # all|unread|favourites|groups|archived|admin_all|<list_id>
        # Admin oversight: monitor EVERY conversation in the system (read-only). Admins only.
        if flt == 'admin_all':
            if self._chat_role(me) != 'admin':
                return {'status': True, 'conversations': [], 'unread_total': 0}
            rows = []
            for c in request.env['chat.conversation'].sudo().search(
                    [('active', '=', True), ('is_self', '=', False)], order='last_message_at desc'):
                if not (c.is_group or c.last_message_id):
                    continue
                r = self._serialize_conversation(c, me.id)
                r['oversight'] = True                 # read-only monitor row (admin is not a member)
                if c.is_group:
                    r['title'] = c.name or 'Group'
                rows.append(r)
            return {'status': True, 'conversations': rows, 'unread_total': 0}
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
            # Admin oversight: read-only monitoring of ANY conversation (admins only).
            if self._chat_role(me) == 'admin':
                conv = request.env['chat.conversation'].sudo().browse(int(params.get('conversation_id') or 0))
                if not conv.exists():
                    return {'status': False, 'message': 'Chat not found.'}
                member = request.env['chat.member'].sudo().browse()   # empty → monitor, sees full history
            else:
                return {'status': False, 'message': 'Not a member of this chat.'}
        Message = request.env['chat.message'].sudo()
        # Exclude messages this user "deleted for me" + any disappearing message
        # whose timer has already passed (belt-and-braces with the purge cron).
        now = fields.Datetime.now()
        domain = [('conversation_id', '=', conv.id), ('hidden_for_user_ids', 'not in', [me.id]),
                  '|', ('expire_at', '=', False), ('expire_at', '>', now)]
        # "Send message history" off -> members only see messages from when they joined.
        if conv.is_group and not conv.perm_send_history and member and member.joined_at:
            domain.append(('create_date', '>=', member.joined_at))
        after_id = int(params.get('after_id') or 0)
        before_id = int(params.get('before_id') or 0)
        limit = min(int(params.get('limit') or 50), 100)

        if after_id:
            msgs = Message.search(domain + [('id', '>', after_id)], order='id asc', limit=limit)
        elif before_id:
            msgs = Message.search(domain + [('id', '<', before_id)], order='id desc', limit=limit).sorted('id')
        else:
            msgs = Message.search(domain, order='id desc', limit=limit).sorted('id')

        # Bump the caller's delivered cursor to the newest message they've now fetched
        # (stamps delivered_at + tells authors, over the bus, that it was delivered).
        me._chat_touch_presence()
        if msgs and member:
            deliv = member._advance_cursors(delivered_id=msgs[-1].id)
            if deliv.get('delivered_up_to_message_id'):
                self._bus_conv(conv, 'delivered',
                               {'user_id': me.id, 'up_to_id': deliv['delivered_up_to_message_id'],
                                'at': self._dt(fields.Datetime.now())}, exclude_uid=me.id)

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
        if not conv.is_group and not conv.is_self:
            other = conv._other_members(me.id)[:1].user_id
            if self._is_blocked(me, other):
                blocked_me = other and me.id in other.chat_blocked_user_ids.ids
                return {'status': False, 'message':
                        "You can't message this contact." if blocked_me
                        else 'Unblock this contact to send a message.'}
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
        if 'reply_to_id' not in vals:
            qa = (params.get('quote_author') or '').strip()
            qb = (params.get('quote_body') or '').strip()
            if qa or qb:   # "reply privately" quote carried over from another chat
                vals['quote_author'] = qa[:120]
                vals['quote_body'] = qb[:200]
        msg = request.env['chat.message'].sudo().create(vals)
        # The author has, by definition, read + received their own message.
        member._advance_cursors(read_id=msg.id, delivered_id=msg.id)
        # Link preview: fetch the first URL's Open Graph card off-request.
        urls = [u for u in _URL_RE.findall(body) if not self._url_is_private(u)]
        if urls:
            msg.sudo().write({'link_url': urls[0]})
            threading.Thread(target=self._fetch_link_preview_async,
                             args=(request.env.cr.dbname, msg.id, urls[0]), daemon=True).start()
        self._push_chat(conv, msg, me)
        self._notify_mentions(conv, msg, me, body)   # @mentions → 'X mentioned you' ping
        self._bus_message(conv, msg, 'message', exclude_uid=me.id)
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
        if not conv.is_group and not conv.is_self:
            other = conv._other_members(me.id)[:1].user_id
            if self._is_blocked(me, other):
                blocked_me = other and me.id in other.chat_blocked_user_ids.ids
                return {'status': False, 'message':
                        "You can't message this contact." if blocked_me
                        else 'Unblock this contact to send a message.'}
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
            # View once (photos/videos only): opened a single time, then gone.
            'view_once': bool(params.get('view_once')) and kind in ('image', 'video'),
        }
        rid = int(params.get('reply_to_id') or 0)
        if rid:
            r = request.env['chat.message'].sudo().browse(rid)
            if r.exists() and r.conversation_id.id == conv.id:
                vals['reply_to_id'] = rid
        msg = request.env['chat.message'].sudo().create(vals)
        member._advance_cursors(read_id=msg.id, delivered_id=msg.id)
        self._push_chat(conv, msg, me)
        self._bus_message(conv, msg, 'message', exclude_uid=me.id)
        return {'status': True, 'message': self._serialize_message(msg, me.id, conv)}

    @http.route('/chats_369/media/<int:msg_id>', type='http', auth='user')
    def chat_media(self, msg_id, **kw):
        me = request.env.user
        msg = request.env['chat.message'].sudo().browse(msg_id)
        if not msg.exists() or not msg.attachment or msg.deleted:
            return request.not_found()
        if me.id not in msg.conversation_id.member_ids.mapped('user_id').ids:
            return request.not_found()
        # View once: never serve to the sender, or to a recipient who already opened it.
        if msg.view_once and (msg.author_id.id == me.id or me.id in msg.viewed_by_user_ids.ids):
            return request.not_found()
        data = base64.b64decode(msg.attachment)
        headers = [('Content-Type', msg.mimetype or 'application/octet-stream'),
                   ('Cache-Control', 'private, max-age=3600')]
        if kw.get('dl') or msg.kind == 'document':
            ext = (msg.mimetype or '').split('/')[-1] or 'bin'
            fname = msg.file_name or ('media_%s.%s' % (msg.id, ext))
            headers.append(('Content-Disposition', 'attachment; filename="%s"' % fname))
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
            vals = member._advance_cursors(read_id=up_to, delivered_id=up_to)
            if vals.get('last_read_message_id'):
                # Let the authors' clients turn their ticks blue live.
                self._bus_conv(conv, 'read',
                               {'user_id': me.id, 'up_to_id': up_to,
                                'at': self._dt(fields.Datetime.now())}, exclude_uid=me.id)
        return {'status': True}

    @http.route('/chat/typing', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_typing(self, **params):
        """Broadcast a transient 'typing' signal to the other members (not stored)."""
        me = request.env.user
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False}
        self._bus_conv(conv, 'typing',
                       {'user_id': me.id, 'name': me.name, 'typing': bool(params.get('typing'))},
                       exclude_uid=me.id)
        return {'status': True}

    @http.route('/chat/heartbeat', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_heartbeat(self, **params):
        """Keep the caller's presence fresh (called on a slow interval by the app)."""
        request.env.user._chat_touch_presence()
        return {'status': True}

    @http.route('/chat/bus_channel', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_bus_channel(self, **params):
        """The caller's private realtime channel (fetch once, then addChannel it)."""
        return {'status': True, 'channel': self._user_channel(request.env.user)}

    @http.route('/chat/group/invite', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_group_invite(self, **params):
        """Get / (re)generate / revoke the group's employee-only invite link."""
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv or not conv.is_group:
            return {'status': False, 'message': 'Not a group you are in.'}
        if not (member.is_admin or conv.perm_invite):
            return {'status': False, 'message': 'You are not allowed to invite via link.'}
        action = params.get('action') or 'get'
        if action == 'revoke':
            conv.sudo().write({'invite_token': False})
            return {'status': True, 'token': False, 'link': False}
        if action in ('create', 'reset') or not conv.invite_token:
            conv.sudo().write({'invite_token': uuid.uuid4().hex})
        token = conv.invite_token
        base = (request.env['ir.config_parameter'].sudo().get_param('web.base.url') or '').rstrip('/')
        return {'status': True, 'token': token, 'link': ('%s/chat/join/%s' % (base, token)) if token else False}

    @http.route('/chat/join/<string:token>', type='http', auth='user')
    def chat_join(self, token, **kw):
        """Employee opens an invite link -> joins the group, then lands in Odoo.
        auth='user' forces login first; portal/share users are turned away."""
        user = request.env.user
        conv = request.env['chat.conversation'].sudo().search(
            [('invite_token', '=', token), ('is_group', '=', True)], limit=1)
        if not conv or user.share:
            return request.redirect('/odoo')
        member = conv.member_ids.filtered(lambda m: m.user_id.id == user.id)[:1]
        if member and not member.left_at:
            return request.redirect('/odoo')          # already a member
        if member:
            member.sudo().write({'left_at': False, 'joined_at': fields.Datetime.now()})
        else:
            request.env['chat.member'].sudo().create({'conversation_id': conv.id, 'user_id': user.id})
        sysmsg = self._system_message(conv, user, '%s joined via invite link' % user.name)
        self._bus_message(conv, sysmsg, 'message', exclude_uid=user.id)
        return request.redirect('/odoo')

    # ================================================================== #
    # My profile + settings (WhatsApp-style, office-lean)                 #
    # ================================================================== #
    @http.route('/chat/me', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_me(self, **params):
        """My profile + all my settings, for the Profile/Settings screen."""
        me = request.env.user
        return {'status': True, 'me': {
            'id': me.id, 'name': me.name, 'avatar_url': self._avatar_url(me),
            'mobile': me.kpi_mobile_number or '', 'role': self._chat_role(me),
            'about': me.chat_about or '',
            'last_seen_privacy': me.chat_last_seen_privacy, 'online_privacy': me.chat_online_privacy,
            'read_receipts': me.chat_read_receipts,
            'notif_messages': me.chat_notif_messages, 'notif_groups': me.chat_notif_groups,
            'notif_sound': me.chat_notif_sound, 'notif_preview': me.chat_notif_preview,
        }}

    @http.route('/chat/profile', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_profile(self, **params):
        """Update my name / about."""
        me = request.env.user
        vals = {}
        if params.get('name'):
            vals['name'] = params['name'].strip()[:120]
        if 'about' in params:
            vals['chat_about'] = (params.get('about') or '').strip()[:139]
        avatar = params.get('avatar')
        if avatar:
            # Accept a raw base64 image (strip any data:...;base64, prefix) → user photo.
            if ',' in avatar[:40] and avatar[:5].lower() == 'data:':
                avatar = avatar.split(',', 1)[1]
            vals['image_1920'] = avatar
        if vals:
            me.sudo().write(vals)
        return {'status': True, 'name': me.name, 'about': me.chat_about or '',
                'avatar_url': self._avatar_url(me)}

    @http.route('/chat/settings', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_settings(self, **params):
        """Update my read-receipts + notification preferences (booleans)."""
        me = request.env.user
        cols = {'read_receipts': 'chat_read_receipts', 'notif_messages': 'chat_notif_messages',
                'notif_groups': 'chat_notif_groups', 'notif_sound': 'chat_notif_sound',
                'notif_preview': 'chat_notif_preview'}
        vals = {col: bool(params[k]) for k, col in cols.items() if k in params}
        if vals:
            me.sudo().write(vals)
        return {'status': True}

    @http.route('/chat/all_media', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_all_media(self, **params):
        """All media across every chat/group I'm in. tab 'media' -> image|video;
        'docs' -> document|audio. Newest first, with month headers + chat name."""
        me = request.env.user
        me._chat_touch_presence()
        mem = request.env['chat.member'].sudo().search([('user_id', '=', me.id), ('left_at', '=', False)])
        conv_ids = mem.mapped('conversation_id').ids
        if not conv_ids:
            return {'status': True, 'items': []}
        tab = params.get('tab') or 'media'
        Msg = request.env['chat.message'].sudo()
        base = [('conversation_id', 'in', conv_ids), ('deleted', '=', False),
                ('hidden_for_user_ids', 'not in', [me.id])]
        items = []
        if tab == 'links':
            for m in Msg.search(base + [('kind', '!=', 'system'), ('body', 'ilike', 'http')],
                                order='id desc', limit=300):
                match = _URL_RE.search(m.body or '')
                if not match:
                    continue
                items.append({
                    'id': m.id, 'kind': 'link', 'url': match.group(0), 'name': match.group(0),
                    'chat': self._conv_title(m.conversation_id, me.id), 'author': m.author_id.name,
                    'created': self._dt(m.create_date), 'month_label': self._month_label(m.create_date)})
        else:
            kinds = ['image', 'video'] if tab == 'media' else ['document', 'audio']
            for m in Msg.search(base + [('kind', 'in', kinds), ('attachment', '!=', False)],
                                order='id desc', limit=400):
                items.append({
                    'id': m.id, 'kind': m.kind, 'url': '/chats_369/media/%s' % m.id,
                    'name': m.file_name or (m.kind or '').title(), 'duration': m.duration or 0,
                    'chat': self._conv_title(m.conversation_id, me.id), 'author': m.author_id.name,
                    'created': self._dt(m.create_date), 'month_label': self._month_label(m.create_date)})
        return {'status': True, 'items': items}

    @http.route('/chat/privacy', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_privacy(self, **params):
        """Get (no args) or set my last-seen / online privacy, WhatsApp-style."""
        me = request.env.user
        vals = {}
        lsp = params.get('last_seen_privacy')
        onp = params.get('online_privacy')
        if lsp in ('everyone', 'contacts', 'nobody'):
            vals['chat_last_seen_privacy'] = lsp
        if onp in ('everyone', 'same'):
            vals['chat_online_privacy'] = onp
        if vals:
            me.sudo().write(vals)
        return {'status': True,
                'last_seen_privacy': me.chat_last_seen_privacy,
                'online_privacy': me.chat_online_privacy}

    @http.route('/chat/message_info', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_message_info(self, **params):
        """Per-recipient delivered/read state + times for one of MY messages
        (WhatsApp 'Message info'). Author-only."""
        msg, conv, member = self._member_msg(params.get('message_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        me = request.env.user
        if msg.author_id.id != me.id:
            return {'status': False, 'message': 'Info is only available for your own messages.'}
        read, delivered = [], []
        others = conv._other_members(me.id)
        for m in others:
            brief = {'user_id': m.user_id.id, 'name': m.user_id.name,
                     'avatar_url': self._avatar_url(m.user_id)}
            read_id = m.last_read_message_id.id if m.last_read_message_id else 0
            deliv_id = m.delivered_up_to_message_id.id if m.delivered_up_to_message_id else 0
            if read_id >= msg.id:
                read.append(dict(brief, at=self._dt(m.last_read_at)))
            if deliv_id >= msg.id:
                delivered.append(dict(brief, at=self._dt(m.delivered_at)))
        return {'status': True, 'is_group': conv.is_group,
                'read': read, 'delivered': delivered, 'member_count': len(others)}

    # ================================================================== #
    # Google Meet — auto-generate a real, free, open (guest) meeting link #
    # ================================================================== #
    def _gmeet_param(self, key, default=''):
        return request.env['ir.config_parameter'].sudo().get_param('chats_369.%s' % key, default)

    def _gmeet_base(self):
        """Base URL used to build the OAuth redirect. Admin override, else web.base.url."""
        P = request.env['ir.config_parameter'].sudo()
        return (P.get_param('chats_369.gmeet_base_url') or P.get_param('web.base.url') or '').rstrip('/')

    def _gmeet_triggers(self):
        raw = self._gmeet_param('gmeet_triggers', '') or ''
        return [w.strip().lower() for w in raw.replace('\n', ',').split(',') if w.strip()]

    def _gmeet_can(self, me, conv, member):
        """(allowed, error) — admin-only + scope gates."""
        if self._gmeet_param('gmeet_admin_only', '1') != '0':
            if self._chat_role(me) != 'admin' and not (conv.is_group and member and member.is_admin):
                return False, 'Only admins can start a meeting here.'
        scope = self._gmeet_param('gmeet_scope', 'both')
        if scope == 'groups' and not conv.is_group:
            return False, 'Meetings are enabled for groups only.'
        if scope == 'direct' and conv.is_group:
            return False, 'Meetings are enabled for 1:1 chats only.'
        return True, ''

    def _gmeet_token(self):
        P = request.env['ir.config_parameter'].sudo()
        cid = P.get_param('chats_369.gmeet_client_id')
        csec = P.get_param('chats_369.gmeet_client_secret')
        rtok = P.get_param('chats_369.gmeet_refresh_token')
        if not (cid and csec and rtok):
            return None
        try:
            r = requests.post('https://oauth2.googleapis.com/token', data={
                'client_id': cid, 'client_secret': csec, 'refresh_token': rtok,
                'grant_type': 'refresh_token'}, timeout=15)
            return r.json().get('access_token')
        except Exception:
            _logger.warning('gmeet token refresh failed', exc_info=True)
            return None

    def _gmeet_create_link(self, emails=None):
        token = self._gmeet_token()
        if not token:
            return None
        now = fields.Datetime.now()
        body = {
            'summary': '369Chats meeting',
            'start': {'dateTime': now.strftime('%Y-%m-%dT%H:%M:%SZ'), 'timeZone': 'UTC'},
            'end': {'dateTime': (now + timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M:%SZ'), 'timeZone': 'UTC'},
            'guestsCanModify': True,
            'conferenceData': {'createRequest': {
                'requestId': uuid.uuid4().hex,
                'conferenceSolutionKey': {'type': 'hangoutsMeet'}}},
        }
        if emails:
            body['attendees'] = [{'email': e} for e in emails if e]
        try:
            r = requests.post(
                'https://www.googleapis.com/calendar/v3/calendars/primary/events'
                '?conferenceDataVersion=1&sendUpdates=none',
                headers={'Authorization': 'Bearer %s' % token, 'Content-Type': 'application/json'},
                data=json.dumps(body), timeout=20)
            data = r.json()
            for ep in (data.get('conferenceData', {}).get('entryPoints') or []):
                if ep.get('entryPointType') == 'video' and ep.get('uri'):
                    return ep['uri']
            return data.get('hangoutLink')
        except Exception:
            _logger.warning('gmeet create link failed', exc_info=True)
            return None

    @http.route('/chat/gmeet/status', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_gmeet_status(self, **params):
        me = request.env.user
        P = request.env['ir.config_parameter'].sudo()
        is_admin = self._chat_role(me) == 'admin'
        base = self._gmeet_base()
        return {'status': True,
                'connected': bool(P.get_param('chats_369.gmeet_refresh_token')),
                'has_creds': bool(P.get_param('chats_369.gmeet_client_id') and P.get_param('chats_369.gmeet_client_secret')),
                'is_admin': is_admin,
                'triggers': self._gmeet_triggers(),
                'scope': self._gmeet_param('gmeet_scope', 'both'),
                'admin_only': self._gmeet_param('gmeet_admin_only', '1') != '0',
                'client_id': (P.get_param('chats_369.gmeet_client_id') or '') if is_admin else '',
                'base_url': (P.get_param('chats_369.gmeet_base_url') or '') if is_admin else '',
                'redirect_uri': ('%s/chat/gmeet/oauth/callback' % base) if is_admin else ''}

    @http.route('/chat/gmeet/config', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_gmeet_config(self, **params):
        if self._chat_role(request.env.user) != 'admin':
            return {'status': False, 'message': 'Admins only.'}
        P = request.env['ir.config_parameter'].sudo()
        if 'client_id' in params:
            P.set_param('chats_369.gmeet_client_id', (params.get('client_id') or '').strip())
        if params.get('client_secret'):
            P.set_param('chats_369.gmeet_client_secret', params['client_secret'].strip())
        if 'triggers' in params:
            P.set_param('chats_369.gmeet_triggers', params.get('triggers') or '')
        if params.get('scope') in ('groups', 'direct', 'both'):
            P.set_param('chats_369.gmeet_scope', params['scope'])
        if 'admin_only' in params:
            P.set_param('chats_369.gmeet_admin_only', '1' if params['admin_only'] else '0')
        if 'base_url' in params:
            P.set_param('chats_369.gmeet_base_url', (params.get('base_url') or '').strip())
        return {'status': True}

    @http.route('/chat/gmeet/oauth/start', type='http', auth='user')
    def chat_gmeet_oauth_start(self, **kw):
        if self._chat_role(request.env.user) != 'admin':
            return request.redirect('/odoo')
        P = request.env['ir.config_parameter'].sudo()
        cid = P.get_param('chats_369.gmeet_client_id')
        base = self._gmeet_base()
        if not cid:
            return request.redirect('/odoo')
        from urllib.parse import urlencode
        q = urlencode({
            'client_id': cid,
            'redirect_uri': '%s/chat/gmeet/oauth/callback' % base,
            'response_type': 'code',
            'scope': 'https://www.googleapis.com/auth/calendar.events',
            'access_type': 'offline', 'prompt': 'consent'})
        return request.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q, local=False)

    @http.route('/chat/gmeet/oauth/callback', type='http', auth='user')
    def chat_gmeet_oauth_callback(self, **kw):
        if self._chat_role(request.env.user) != 'admin':
            return request.redirect('/odoo')
        code = kw.get('code')
        P = request.env['ir.config_parameter'].sudo()
        cid = P.get_param('chats_369.gmeet_client_id')
        csec = P.get_param('chats_369.gmeet_client_secret')
        base = self._gmeet_base()
        if code and cid and csec:
            try:
                r = requests.post('https://oauth2.googleapis.com/token', data={
                    'client_id': cid, 'client_secret': csec, 'code': code,
                    'redirect_uri': '%s/chat/gmeet/oauth/callback' % base,
                    'grant_type': 'authorization_code'}, timeout=15)
                rt = r.json().get('refresh_token')
                if rt:
                    P.set_param('chats_369.gmeet_refresh_token', rt)
            except Exception:
                _logger.warning('gmeet oauth callback failed', exc_info=True)
        return request.redirect('/odoo')

    @http.route('/chat/create_meet', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_create_meet(self, **params):
        me = request.env.user
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        ok, err = self._gmeet_can(me, conv, member)
        if not ok:
            return {'status': False, 'message': err}
        if not request.env['ir.config_parameter'].sudo().get_param('chats_369.gmeet_refresh_token'):
            return {'status': False, 'message': 'Google Meet is not set up yet — an admin must connect it in Settings.'}
        emails = [m.user_id.email for m in conv.member_ids.filtered(lambda x: not x.left_at) if m.user_id.email]
        link = self._gmeet_create_link(emails)
        if not link:
            return {'status': False, 'message': 'Could not create the meeting link. Check the Google connection.'}
        msg = request.env['chat.message'].sudo().create({
            'conversation_id': conv.id, 'author_id': me.id, 'kind': 'text',
            'body': link, 'is_meet': True})
        member._advance_cursors(read_id=msg.id, delivered_id=msg.id)
        self._push_chat(conv, msg, me)
        self._bus_message(conv, msg, 'message', exclude_uid=me.id)
        # In a group, follow the link with an "@all Please join the meeting" line so
        # the mention system pings everyone (@all) with a clear join prompt.
        if conv.is_group:
            join = request.env['chat.message'].sudo().create({
                'conversation_id': conv.id, 'author_id': me.id, 'kind': 'text',
                'body': '@all Please join the meeting'})
            member._advance_cursors(read_id=join.id, delivered_id=join.id)
            self._notify_mentions(conv, join, me, join.body)
            self._bus_message(conv, join, 'message', exclude_uid=me.id)
        return {'status': True, 'message': self._serialize_message(msg, me.id, conv)}

    # ================================================================== #
    # Disappearing messages                                               #
    # ================================================================== #
    _DISAPPEAR_LABELS = {0: 'off', 86400: '24 hours', 604800: '7 days', 7776000: '90 days'}

    @http.route('/chat/set_disappear', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_set_disappear(self, **params):
        """Turn disappearing messages on/off for a chat. In a group only admins may
        change it; 1:1 either person can. Posts a system line so everyone sees it."""
        me = request.env.user
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        if conv.is_group and not member.is_admin:
            return {'status': False, 'message': 'Only admins can change disappearing messages.'}
        secs = int(params.get('seconds') or 0)
        if secs not in self._DISAPPEAR_LABELS:
            secs = 0
        conv.sudo().write({'disappear_seconds': secs})
        label = self._DISAPPEAR_LABELS[secs]
        if secs:
            text = '%s turned on disappearing messages · %s' % (me.name, label)
        else:
            text = '%s turned off disappearing messages' % me.name
        sysmsg = self._system_message(conv, me, text)
        self._bus_message(conv, sysmsg, 'message', exclude_uid=me.id)
        return {'status': True, 'disappear_seconds': secs}

    # ================================================================== #
    # Polls                                                               #
    # ================================================================== #
    @http.route('/chat/poll/create', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_poll_create(self, **params):
        me = request.env.user
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        if conv.is_group and not member.is_admin and not conv.perm_send:
            return {'status': False, 'message': 'Only admins can send messages in this group.'}
        question = (params.get('question') or '').strip()
        options = [(o or '').strip() for o in (params.get('options') or []) if (o or '').strip()]
        if not question or len(options) < 2:
            return {'status': False, 'message': 'Add a question and at least 2 options.'}
        options = options[:12]
        msg = request.env['chat.message'].sudo().create({
            'conversation_id': conv.id, 'author_id': me.id, 'kind': 'poll', 'body': question})
        request.env['chat.poll'].sudo().create({
            'message_id': msg.id, 'question': question, 'multi': bool(params.get('multi')),
            'option_ids': [(0, 0, {'text': t, 'sequence': i * 10}) for i, t in enumerate(options)],
        })
        member._advance_cursors(read_id=msg.id, delivered_id=msg.id)
        self._push_chat(conv, msg, me)
        self._bus_message(conv, msg, 'message', exclude_uid=me.id)
        return {'status': True, 'message': self._serialize_message(msg, me.id, conv)}

    @http.route('/chat/poll/vote', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_poll_vote(self, **params):
        me = request.env.user
        option = request.env['chat.poll.option'].sudo().browse(int(params.get('option_id') or 0))
        if not option.exists():
            return {'status': False, 'message': 'Poll option not found.'}
        poll = option.poll_id
        msg = poll.message_id
        conv, member = self._member_conv(msg.conversation_id.id)
        if not conv:
            return {'status': False, 'message': 'Not a member of this chat.'}
        Vote = request.env['chat.poll.vote'].sudo()
        mine = Vote.search([('option_id', '=', option.id), ('user_id', '=', me.id)], limit=1)
        if mine:
            mine.unlink()   # tap again to remove the vote
        else:
            if not poll.multi:
                Vote.search([('poll_id', '=', poll.id), ('user_id', '=', me.id)]).unlink()
            Vote.create({'option_id': option.id, 'user_id': me.id})
        self._bus_message(conv, msg, 'update', exclude_uid=me.id)
        return {'status': True, 'message': self._serialize_message(msg, me.id, conv)}

    # ================================================================== #
    # View once · Block contacts                                          #
    # ================================================================== #
    @http.route('/chat/view_once_seen', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_view_once_seen(self, **params):
        """Mark a view-once message as opened by me — after this its media is gone."""
        me = request.env.user
        msg, conv, member = self._member_msg(params.get('message_id'))
        if not msg:
            return {'status': False, 'message': 'Not found.'}
        if msg.view_once and msg.author_id.id != me.id and me.id not in msg.viewed_by_user_ids.ids:
            msg.sudo().write({'viewed_by_user_ids': [(4, me.id)]})
            self._bus_message(conv, msg, 'update', exclude_uid=me.id)
        return {'status': True, 'message': self._serialize_message(msg, me.id, conv)}

    @http.route('/chat/block', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_block(self, **params):
        """Block / unblock a contact. Blocked = neither side can message the other."""
        me = request.env.user
        other = request.env['res.users'].sudo().browse(int(params.get('user_id') or 0))
        if not other.exists() or other.id == me.id:
            return {'status': False, 'message': 'User not found.'}
        blocked = bool(params.get('blocked'))
        op = (4, other.id) if blocked else (3, other.id)
        me.sudo().write({'chat_blocked_user_ids': [op]})
        return {'status': True, 'blocked': blocked}

    @http.route('/chat/link_preview', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_link_preview(self, **params):
        """Compose-time preview: scrape a URL's card so the client can show it above
        the composer before sending (WhatsApp-style)."""
        url = (params.get('url') or '').strip()
        if not url.lower().startswith(('http://', 'https://')):
            return {'status': False}
        if self._url_is_private(url):   # SSRF guard: never fetch internal/loopback hosts
            return {'status': False}
        data = self._scrape_og(url)
        if not (data['title'] or data['image']):
            return {'status': False}
        return {'status': True, 'url': url, 'title': data['title'],
                'desc': data['desc'], 'image': data['image']}

    # ================================================================== #
    # Calls — in-app WebRTC (1:1), signaling relayed over the bus         #
    # ================================================================== #
    def _bus_to_user(self, user, event, payload):
        data = dict(payload or {}); data['event'] = event
        request.env['bus.bus'].sudo()._sendone(self._user_channel(user), 'chat369.event', data)

    def _call_other(self, conv, me):
        others = conv._other_members(me.id).filtered(lambda m: not m.left_at)
        return others[:1].user_id if others else False

    def _ice_servers(self):
        P = request.env['ir.config_parameter'].sudo()
        servers = [{'urls': P.get_param('chats_369.stun_url') or 'stun:stun.l.google.com:19302'}]
        turn = P.get_param('chats_369.turn_url')
        if turn:
            servers.append({'urls': turn, 'username': P.get_param('chats_369.turn_user') or '',
                            'credential': P.get_param('chats_369.turn_cred') or ''})
        return servers

    def _push_call(self, other, me, video):
        try:
            tokens = request.env['kpi.push.token'].sudo().tokens_for_users([other.id])
            if not tokens:
                return
            messages = [{'to': t, 'title': me.name, 'body': '📞 Incoming %s call' % ('video' if video else 'voice'),
                         'data': {'event': 'chat_call'}, 'sound': 'default', 'channelId': 'default'} for t in tokens]
            threading.Thread(target=self._push_send_async, args=(request.env.cr.dbname, messages), daemon=True).start()
        except Exception:
            pass

    @http.route('/chat/call/ice', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_call_ice(self, **params):
        return {'status': True, 'ice': self._ice_servers()}

    @http.route('/chat/call/start', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_call_start(self, **params):
        me = request.env.user
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv or conv.is_group or conv.is_self:
            return {'status': False, 'message': 'Calls are 1:1 only for now.'}
        other = self._call_other(conv, me)
        if not other:
            return {'status': False, 'message': 'No one to call.'}
        if self._is_blocked(me, other):
            return {'status': False, 'message': "You can't call this contact."}
        call_id = uuid.uuid4().hex
        video = bool(params.get('video'))
        self._bus_to_user(other, 'call_ring', {
            'call_id': call_id, 'conversation_id': conv.id, 'video': video,
            'from_id': me.id, 'name': me.name, 'avatar': self._avatar_url(me)})
        self._push_call(other, me, video)
        return {'status': True, 'call_id': call_id, 'ice': self._ice_servers()}

    @http.route('/chat/call/accept', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_call_accept(self, **params):
        me = request.env.user
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False}
        other = self._call_other(conv, me)
        if other:
            self._bus_to_user(other, 'call_accept', {'call_id': params.get('call_id'), 'conversation_id': conv.id, 'from_id': me.id})
        return {'status': True}

    @http.route('/chat/call/reject', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_call_reject(self, **params):
        me = request.env.user
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False}
        other = self._call_other(conv, me)
        if other:
            self._bus_to_user(other, 'call_reject', {'call_id': params.get('call_id'), 'conversation_id': conv.id})
        return {'status': True}

    @http.route('/chat/call/signal', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_call_signal(self, **params):
        me = request.env.user
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False}
        other = self._call_other(conv, me)
        if other:
            self._bus_to_user(other, 'call_signal', {
                'call_id': params.get('call_id'), 'conversation_id': conv.id,
                'kind': params.get('kind'), 'data': params.get('data'), 'from_id': me.id})
        return {'status': True}

    @http.route('/chat/call/end', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_call_end(self, **params):
        me = request.env.user
        conv, member = self._member_conv(params.get('conversation_id'))
        if not conv:
            return {'status': False}
        other = self._call_other(conv, me)
        if other:
            self._bus_to_user(other, 'call_end', {'call_id': params.get('call_id'), 'conversation_id': conv.id})
        # Only the caller logs a history line + call record (avoids duplicates).
        if params.get('log'):
            missed = bool(params.get('missed'))
            dur = int(params.get('duration') or 0)
            text = '📞 Missed call' if missed else '📞 Call · %d:%02d' % divmod(dur, 60)
            sysmsg = self._system_message(conv, me, text)
            self._bus_message(conv, sysmsg, 'message', exclude_uid=me.id)
            request.env['chat.call'].sudo().create({
                'conversation_id': conv.id, 'caller_id': me.id, 'callee_id': other.id if other else False,
                'video': bool(params.get('video')), 'status': 'missed' if missed else 'answered', 'duration': dur,
            })
        return {'status': True}

    @http.route('/chat/calls', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_calls(self, **params):
        """WhatsApp-style Calls tab data: recent history + favourite contacts + upcoming."""
        me = request.env.user
        recent = []
        for c in request.env['chat.call'].sudo().search(
                ['|', ('caller_id', '=', me.id), ('callee_id', '=', me.id)], limit=80):
            outgoing = c.caller_id.id == me.id
            other = c.callee_id if outgoing else c.caller_id
            recent.append({
                'id': c.id, 'conversation_id': c.conversation_id.id if c.conversation_id else False,
                'user_id': other.id if other else False,
                'name': other.name if other else 'Unknown', 'avatar': self._avatar_url(other) if other else False,
                'outgoing': outgoing, 'video': c.video, 'missed': c.status == 'missed',
                'duration': c.duration, 'created': self._dt(c.started_at),
            })
        favorites = []
        for m in request.env['chat.member'].sudo().search([('user_id', '=', me.id), ('favourite', '=', True)]):
            conv = m.conversation_id
            if not conv or conv.is_group or conv.is_self:
                continue
            other = conv._other_members(me.id)[:1].user_id
            if other:
                favorites.append({'conversation_id': conv.id, 'user_id': other.id,
                                  'name': other.name, 'avatar': self._avatar_url(other)})
        now = fields.Datetime.now()
        upcoming = []
        for s in request.env['chat.call.schedule'].sudo().search(
                ['&', ('scheduled_at', '>=', now - timedelta(hours=1)),
                 '|', ('organizer_id', '=', me.id), ('invitee_ids', 'in', [me.id])]):
            upcoming.append({
                'id': s.id, 'title': s.title, 'when': self._dt(s.scheduled_at), 'video': s.video,
                'mine': s.organizer_id.id == me.id, 'organizer': s.organizer_id.name,
                'conversation_id': s.conversation_id.id if s.conversation_id else False,
            })
        return {'status': True, 'recent': recent, 'favorites': favorites, 'upcoming': upcoming}

    @http.route('/chat/call/schedule', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_call_schedule(self, **params):
        me = request.env.user
        title = (params.get('title') or '').strip()
        when = params.get('when') or ''
        if not title or not when:
            return {'status': False, 'message': 'Add a title and a time.'}
        vals = {'title': title[:120], 'scheduled_at': when.replace('T', ' ').replace('Z', '')[:19],
                'organizer_id': me.id, 'video': bool(params.get('video'))}
        conv_id = int(params.get('conversation_id') or 0)
        if conv_id:
            conv, member = self._member_conv(conv_id)
            if conv:
                vals['conversation_id'] = conv.id
                ids = conv._other_members(me.id).mapped('user_id').ids
                if ids:
                    vals['invitee_ids'] = [(6, 0, ids)]
        sched = request.env['chat.call.schedule'].sudo().create(vals)
        return {'status': True, 'id': sched.id}

    @http.route('/chat/call/schedule/cancel', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_call_schedule_cancel(self, **params):
        me = request.env.user
        s = request.env['chat.call.schedule'].sudo().browse(int(params.get('id') or 0))
        if s.exists() and s.organizer_id.id == me.id:
            s.unlink()
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
        self._bus_message(conv, msg, 'update', exclude_uid=request.env.user.id)
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
        self._bus_message(conv, msg, 'update', exclude_uid=me.id)
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
        if msg.create_date and (fields.Datetime.now() - msg.create_date) > timedelta(minutes=15):
            return {'status': False, 'message': 'You can only edit a message within 15 minutes.'}
        body = (params.get('body') or '').strip()
        if not body:
            return {'status': False, 'message': 'Message cannot be empty.'}
        msg.sudo().write({'body': body, 'edited': True})
        self._bus_message(conv, msg, 'update', exclude_uid=request.env.user.id)
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
        self._bus_message(conv, msg, 'update', exclude_uid=me.id)
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
        if src.deleted:
            return {'status': False, 'message': 'Nothing to forward.'}
        vals = {'conversation_id': tconv.id, 'author_id': me.id,
                'kind': src.kind, 'body': src.body or '', 'forwarded': True}
        if src.kind in ('image', 'video', 'audio', 'document') and src.attachment:
            vals.update({'attachment': src.attachment, 'file_name': src.file_name,
                         'mimetype': src.mimetype, 'file_size': src.file_size,
                         'duration': src.duration})
        elif not (src.body or '').strip():
            return {'status': False, 'message': 'Nothing to forward.'}
        msg = request.env['chat.message'].sudo().create(vals)
        tmember._advance_cursors(read_id=msg.id, delivered_id=msg.id)
        self._push_chat(tconv, msg, me)
        self._bus_message(tconv, msg, 'message', exclude_uid=me.id)
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
            'disappear_seconds': conv.disappear_seconds or 0,
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
                'blocked_by_me': bool(other and other.id in me.chat_blocked_user_ids.ids),
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

    @http.route('/chat/search_all', type='json', auth='user', methods=['POST'], csrf=False)
    def chat_search_all(self, **params):
        """Global search: find my messages across every chat I'm a member of."""
        me = request.env.user
        q = (params.get('query') or '').strip()
        if len(q) < 2:
            return {'status': True, 'results': []}
        conv_ids = request.env['chat.member'].sudo().search(
            [('user_id', '=', me.id), ('left_at', '=', False)]).mapped('conversation_id').ids
        if not conv_ids:
            return {'status': True, 'results': []}
        msgs = request.env['chat.message'].sudo().search([
            ('conversation_id', 'in', conv_ids),
            ('deleted', '=', False),
            ('kind', '!=', 'system'),
            ('body', 'ilike', q),
            ('hidden_for_user_ids', 'not in', [me.id]),
        ], order='id desc', limit=50)
        results = []
        for m in msgs:
            body = m.body or self._preview(m)
            results.append({
                'msg_id': m.id,
                'conv_id': m.conversation_id.id,
                'conv_title': self._conv_title(m.conversation_id, me.id),
                'author': 'You' if m.author_id.id == me.id else (m.author_id.name or ''),
                'snippet': (body or '')[:90],
                'created': self._dt(m.create_date),
            })
        return {'status': True, 'results': results}

    @http.route('/chat/export/<int:conversation_id>', type='http', auth='user')
    def chat_export(self, conversation_id, **kw):
        """Download a plain-text transcript of one chat (office record-keeping)."""
        me = request.env.user
        conv, member = self._member_conv(conversation_id)
        if not conv:
            return request.not_found()
        msgs = request.env['chat.message'].sudo().search([
            ('conversation_id', '=', conv.id),
            ('hidden_for_user_ids', 'not in', [me.id]),
        ], order='id asc')
        title = self._conv_title(conv, me.id)
        lines = ['369Chats transcript', title,
                 'Exported %s' % fields.Datetime.now().strftime('%Y-%m-%d %H:%M'), '']
        for m in msgs:
            ts = (m.create_date or fields.Datetime.now()).strftime('%Y-%m-%d %H:%M')
            if m.kind == 'system':
                lines.append('[%s] * %s' % (ts, m.body or ''))
                continue
            author = 'You' if m.author_id.id == me.id else (m.author_id.name or 'Unknown')
            if m.deleted:
                text = '[deleted]'
            elif m.kind == 'image':
                text = '[Photo]' + ((' ' + m.body) if m.body else '')
            elif m.kind == 'video':
                text = '[Video]' + ((' ' + m.body) if m.body else '')
            elif m.kind == 'audio':
                text = '[Voice message]'
            elif m.kind == 'document':
                text = '[Document: %s]' % (m.file_name or 'file')
            elif m.kind == 'poll':
                text = '[Poll] %s' % (m.body or '')
            elif getattr(m, 'is_meet', False):
                text = '[Meeting] %s' % (m.body or '')
            else:
                text = m.body or ''
            lines.append('[%s] %s: %s' % (ts, author, text))
        content = '\n'.join(lines)
        safe = re.sub(r'[^A-Za-z0-9_-]+', '_', title).strip('_') or 'chat'
        return request.make_response(content.encode('utf-8'), headers=[
            ('Content-Type', 'text/plain; charset=utf-8'),
            ('Content-Disposition', 'attachment; filename="369chats_%s.txt"' % safe),
        ])

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
