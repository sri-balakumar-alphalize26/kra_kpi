"""Inbound webhook from the Evolution API server.

This replaces TWO drifted in-process neonize callbacks (`_on_message` was
duplicated in `action_connect` and in `_reconnect_session`, and the copies had
diverged on media-caption handling). There is now exactly one inbound path.

DESIGN NOTES THAT ARE EASY TO GET WRONG
---------------------------------------
* `type='http'`, NOT `'json'`/`'jsonrpc'`. Evolution POSTs a plain JSON object.
  Odoo's JSON-RPC dispatcher expects an envelope and unwraps `params`, so the
  body would arrive mangled. (The pre-existing `/whatsapp/webhook/incoming`
  route in main.py is declared `type='jsonrpc'`, which is very likely why it
  could never have worked with a real gateway.)
* `save_session=False`, or every webhook POST writes a session row.
* RETURN 200 FOR EVERYTHING EXCEPT AUTH FAILURE. Evolution's own
  `WEBHOOK_RETRY_NON_RETRYABLE_STATUS_CODES` defaults to `400,401,403,404,422`
  and it retries anything else up to `WEBHOOK_RETRY_MAX_ATTEMPTS` (10) with
  exponential backoff. A 500 on a bad payload therefore becomes an infinite
  redelivery loop that re-fires kra_kpi's create hook each time.
* Never do slow work here. Evolution's `WEBHOOK_REQUEST_TIMEOUT_MS` is 60s;
  a timeout is treated as a failure and redelivered.
"""

import hmac
import json
import logging
from datetime import datetime

from odoo import http, fields, api
from odoo.http import request

from ..models import wa_jid

_logger = logging.getLogger(__name__)

# Status may only move forwards. Evolution gives no ordering guarantee and Odoo
# workers run concurrently, so a late 'sent' must not overwrite a 'read'.
_STATUS_RANK = {
    'pending': 0, 'sent': 1, 'received': 1,
    'delivered': 2, 'read': 3, 'failed': 9,
}

_MSG_TYPE_MAP = {
    'conversation': 'text',
    'extendedTextMessage': 'text',
    'imageMessage': 'image',
    'videoMessage': 'video',
    'audioMessage': 'audio',
    'pttMessage': 'audio',
    'documentMessage': 'document',
    'documentWithCaptionMessage': 'document',
    'stickerMessage': 'sticker',
    'locationMessage': 'location',
    'contactMessage': 'contact',
    'reactionMessage': 'reaction',
    'pollCreationMessage': 'poll',
    'pollCreationMessageV2': 'poll',
    'pollCreationMessageV3': 'poll',
    'pollUpdateMessage': 'poll_vote',
}

_PLACEHOLDER = {
    'image': '[Image]', 'video': '[Video]', 'audio': '[Voice]',
    'document': '[Document]', 'sticker': '[Sticker]',
    'location': '[Location]', 'contact': '[Contact]', 'reaction': '[Reaction]',
}


def _ok(payload=None, status=200):
    return request.make_json_response(payload or {'ok': True}, status=status)


class EvolutionWebhook(http.Controller):

    @http.route('/whatsapp/evolution/<int:session_id>/<string:token>',
                type='http', auth='public', methods=['POST'],
                csrf=False, save_session=False)
    def evolution_webhook(self, session_id, token, **kw):
        # ---------- auth ----------
        session = request.env['whatsapp.session'].sudo().browse(session_id)
        if not session.exists():
            return _ok({'ok': False, 'error': 'unknown session'}, status=403)
        secret = session.webhook_secret or ''
        if not secret or not hmac.compare_digest(str(token), str(secret)):
            _logger.warning('Evolution webhook: bad token for session %s', session_id)
            return _ok({'ok': False, 'error': 'forbidden'}, status=403)

        # ---------- parse ----------
        try:
            raw = request.httprequest.get_data()
            payload = json.loads(raw or b'{}')
        except Exception as exc:
            _logger.warning('Evolution webhook: unparseable body: %s', exc)
            return _ok({'ok': False, 'error': 'bad json'})   # 200 on purpose

        if not isinstance(payload, dict):
            return _ok({'ok': False, 'error': 'bad payload'})

        event = (payload.get('event') or '').upper().replace('.', '_')
        instance = payload.get('instance') or ''
        if session.instance_name and instance and instance != session.instance_name:
            _logger.warning('Evolution webhook: instance mismatch %s != %s',
                            instance, session.instance_name)
            return _ok({'ok': False, 'error': 'instance mismatch'}, status=403)

        session.sudo().write({'last_webhook_at': fields.Datetime.now()})

        try:
            handler = {
                'QRCODE_UPDATED': self._h_qr,
                'CONNECTION_UPDATE': self._h_connection,
                'LOGOUT_INSTANCE': self._h_logout,
                'REMOVE_INSTANCE': self._h_logout,
                'MESSAGES_UPSERT': self._h_message,
                'SEND_MESSAGE': self._h_message,
                'MESSAGES_UPDATE': self._h_status,
                # Evolution's own enum is inconsistent here: GROUPS_UPSERT is
                # plural, GROUP_UPDATE is singular. Both spellings of the
                # update event are accepted so a server-side rename cannot
                # silently stop group-name refreshes.
                'GROUPS_UPSERT': self._h_groups,
                'GROUP_UPDATE': self._h_groups,
                'GROUPS_UPDATE': self._h_groups,
                'GROUP_PARTICIPANTS_UPDATE': self._h_groups,
            }.get(event)
            if handler is None:
                return _ok({'ok': True, 'ignored': event})
            return handler(session, payload) or _ok()
        except Exception as exc:
            # Catch-all: a handler bug must not become a redelivery storm.
            _logger.exception('Evolution webhook handler failed (%s): %s', event, exc)
            return _ok({'ok': False, 'error': 'handler failed'})

    # ------------------------------------------------------------------
    # handlers
    # ------------------------------------------------------------------
    def _h_qr(self, session, payload):
        from ..models.evolution_api import strip_data_uri
        data = payload.get('data') or {}
        b64 = strip_data_uri(data.get('base64') or (data.get('qrcode') or {}).get('base64') or '')
        vals = {'qr_last_update': fields.Datetime.now(), 'status': 'waiting_qr'}
        if b64:
            vals['qr_image'] = b64
        if data.get('pairingCode'):
            vals['pairing_code'] = data['pairingCode']
        session.sudo().write(vals)
        return _ok()

    def _h_connection(self, session, payload):
        data = payload.get('data') or {}
        state = (data.get('state') or data.get('connection') or '').lower()
        # Ordering guard: a late 'close' must not bury a current 'open'.
        stamp = self._event_dt(payload)
        if stamp and session.last_connection_event and stamp < session.last_connection_event:
            return _ok({'ok': True, 'stale': True})
        vals = {'last_connection_event': stamp or fields.Datetime.now()}
        if state == 'open':
            vals.update(status='connected', qr_image=False, error_message=False)
            if not session.phone_number:
                vals.update(session.sudo()._owner_phone_vals())
        elif state == 'connecting':
            vals['status'] = 'waiting_qr' if session.qr_image else 'reconnecting'
        elif state in ('close', 'closed'):
            vals['status'] = 'disconnected'
        session.sudo().write(vals)
        return _ok()

    def _h_logout(self, session, payload):
        session.sudo().write({
            'status': 'disconnected', 'qr_image': False,
            'error_message': 'Instance logged out or removed on the Evolution server.',
        })
        return _ok()

    def _h_status(self, session, payload):
        data = payload.get('data') or {}
        wa_id = ((data.get('key') or {}).get('id')) or data.get('keyId')
        new = (data.get('status') or '').lower()
        mapping = {'delivery_ack': 'delivered', 'read': 'read', 'played': 'read',
                   'server_ack': 'sent', 'pending': 'pending', 'error': 'failed'}
        new = mapping.get(new, new)
        if not wa_id or new not in _STATUS_RANK:
            return _ok({'ok': True, 'ignored': 'status'})
        Msg = request.env['whatsapp.message'].sudo()
        row = Msg.search([('session_id', '=', session.id),
                          ('wa_message_id', '=', wa_id)], limit=1)
        if row and _STATUS_RANK[new] > _STATUS_RANK.get(row.status or 'pending', 0):
            row.write({'status': new})
        return _ok()

    def _h_groups(self, session, payload):
        data = payload.get('data') or {}
        rows = data if isinstance(data, list) else [data]
        Group = request.env['whatsapp.group'].sudo()
        for g in rows:
            jid_full = (g.get('id') or g.get('jid') or '').strip()
            if not jid_full or '@g.us' not in jid_full:
                continue
            bare = jid_full.split('@', 1)[0]
            row = Group.search([('jid', '=', bare),
                                ('session_id', '=', session.id)], limit=1)
            vals = {'name': g.get('subject') or bare,
                    'subject': g.get('subject') or '',
                    'last_refreshed': fields.Datetime.now()}
            if g.get('size'):
                vals['participant_count'] = g['size']
            if row:
                row.write(vals)
            else:
                vals.update(jid=bare, session_id=session.id)
                Group.create(vals)
        return _ok()

    def _h_message(self, session, payload):
        data = payload.get('data') or {}
        key = data.get('key') or {}
        wa_id = key.get('id')
        if not wa_id:
            return _ok({'ok': False, 'error': 'no message id'})

        Msg = request.env['whatsapp.message'].sudo()
        existing = Msg.search([('session_id', '=', session.id),
                               ('wa_message_id', '=', wa_id)], limit=1)
        from_me = bool(key.get('fromMe'))

        if existing:
            # Our own send, echoed back by SEND_MESSAGE. Confirm, do not duplicate.
            if from_me and existing.status in ('pending', 'sent'):
                existing.write({'status': 'sent'})
            return _ok({'ok': True, 'duplicate': True})

        remote_jid = key.get('remoteJid') or ''
        phone, is_group = wa_jid.split_jid(remote_jid)
        if not phone:
            return _ok({'ok': False, 'error': 'no addressable sender'})

        msg_type, body = self._extract_body(data)
        tapped = self._extract_interactive_id(data)

        vals = {
            'session_id': session.id,
            'phone': phone,
            'remote_jid': remote_jid,
            'participant_jid': key.get('participant') or '',
            'push_name': data.get('pushName') or '',
            'message': body,
            'message_type': msg_type,
            'wa_message_id': wa_id,
            'from_me': from_me,
            'evolution_event': payload.get('event') or '',
            'interactive_reply_id': tapped,
            'quoted_wa_message_id': self._quoted_id(data),
            'message_timestamp': self._msg_dt(data),
            # from_me rows are recorded as outgoing, which is also what makes
            # them inert: kra_kpi's hook returns early unless direction is
            # 'incoming', so an echo can never trigger a self-reply loop.
            'direction': 'outgoing' if from_me else 'incoming',
            'status': 'sent' if from_me else 'received',
            'is_voice_message': msg_type == 'audio',
        }
        try:
            with request.env.cr.savepoint():
                Msg.create(vals)
        except Exception as exc:
            # A concurrent redelivery in another worker. Treat as a duplicate.
            _logger.info('Evolution webhook: create raced for %s (%s)', wa_id, exc)
            return _ok({'ok': True, 'duplicate': True})

        # Keep the group cache warm. This is what the deleted neonize
        # monkey-wrap in kra_kpi used to do -- except that one threw the body
        # away and only ever saw a display name.
        if is_group and 'kpi.wa.group' in request.env:
            try:
                request.env['kpi.wa.group'].sudo().record_seen(
                    phone, name='', sender=data.get('pushName') or '')
            except Exception as exc:
                # WARNING, not debug. This was debug-level once and it hid a
                # real fault for an afternoon: record_seen had been moved onto
                # the wrong class, so every group silently stopped being
                # recorded while the webhook kept returning 200.
                _logger.warning('kpi.wa.group.record_seen failed for %s: %s',
                                phone, exc)

        return _ok()

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _extract_body(data):
        msg = data.get('message') or {}
        mtype = data.get('messageType') or ''
        kind = _MSG_TYPE_MAP.get(mtype, '')
        if not kind:
            for k in msg:
                if k in _MSG_TYPE_MAP:
                    kind = _MSG_TYPE_MAP[k]
                    mtype = k
                    break
        kind = kind or 'other'

        text = msg.get('conversation') or ''
        if not text:
            text = ((msg.get('extendedTextMessage') or {}).get('text')) or ''
        if not text:
            # A tapped button / picked row carries its visible label here. Keep
            # it as the body so the message still READS correctly in the log --
            # the machine-readable id goes to interactive_reply_id separately.
            text = (
                (msg.get('buttonsResponseMessage') or {}).get('selectedDisplayText')
                or ((msg.get('listResponseMessage') or {}).get('title'))
                or ((msg.get('templateButtonReplyMessage') or {}).get('selectedDisplayText'))
                or ''
            )
        if not text:
            # A poll vote. Keep the chosen option as the body so the message
            # reads correctly in the log and the WA Tracker; the router also
            # gets it via interactive_reply_id.
            opts = (((msg.get('pollUpdateMessage') or {}).get('vote') or {})
                    .get('selectedOptions') or [])
            if opts:
                text = str(opts[0])
            else:
                for k in ('pollCreationMessage', 'pollCreationMessageV2',
                          'pollCreationMessageV3'):
                    name = (msg.get(k) or {}).get('name')
                    if name:
                        text = name
                        break
        if not text:
            # Caption on a media message. The two neonize callbacks disagreed
            # about whether to read this; one did, the other did not.
            for k in ('imageMessage', 'videoMessage', 'documentMessage',
                      'documentWithCaptionMessage'):
                cap = (msg.get(k) or {}).get('caption')
                if cap:
                    text = cap
                    break
        if not text:
            text = _PLACEHOLDER.get(kind, '')
        return kind, text

    @staticmethod
    def _extract_interactive_id(data):
        """The id behind a tapped button / picked list row, '' if they typed.

        WhatsApp has shipped three shapes for this and old clients still send
        the old ones, so all three are read. Verified renderable on this
        connection 16 Oct 2026; if a future WhatsApp build drops interactive
        messages the flow still works because every step also accepts the
        typed number.
        """
        msg = data.get('message') or {}

        # 1. Classic reply buttons.
        btn = msg.get('buttonsResponseMessage') or {}
        if btn.get('selectedButtonId'):
            return str(btn['selectedButtonId'])

        # 2. Classic list picker.
        lst = (msg.get('listResponseMessage') or {}).get('singleSelectReply') or {}
        if lst.get('selectedRowId'):
            return str(lst['selectedRowId'])

        # 3. Newer "interactive" envelope (native flow / cta).
        inter = msg.get('interactiveResponseMessage') or {}
        native = inter.get('nativeFlowResponseMessage') or {}
        if native.get('paramsJson'):
            try:
                params = json.loads(native['paramsJson'])
                for k in ('id', 'selectedId', 'rowId', 'buttonId'):
                    if params.get(k):
                        return str(params[k])
            except Exception:
                pass

        # 4. A template button reply.
        tmpl = msg.get('templateButtonReplyMessage') or {}
        if tmpl.get('selectedId'):
            return str(tmpl['selectedId'])

        # 5. A POLL VOTE -- the one tappable mechanism that actually works on
        #    an unofficial connection. WhatsApp restricts buttons and list
        #    messages to the official Business API, but polls are a normal
        #    consumer feature, and Evolution decrypts the vote for us:
        #        {"pollUpdateMessage": {"vote": {"selectedOptions": ["..."]}}}
        #    Note this yields the option's VISIBLE TEXT, not an id we chose, so
        #    the caller has to map the label back to its option.
        vote = ((msg.get('pollUpdateMessage') or {}).get('vote') or {})
        opts = vote.get('selectedOptions') or []
        if opts:
            return str(opts[0])
        return ''

    @staticmethod
    def _quoted_id(data):
        msg = data.get('message') or {}
        # A poll vote points at the poll it answers. Recorded here so a group
        # bot can tell WHOSE poll was tapped -- everybody in a group sees every
        # poll, and a vote on someone else's menu must not act as your own.
        poll_key = ((msg.get('pollUpdateMessage') or {}).get('pollCreationMessageKey') or {})
        if poll_key.get('id'):
            return poll_key['id']
        for value in msg.values():
            if isinstance(value, dict):
                ctx = value.get('contextInfo') or {}
                if ctx.get('stanzaId'):
                    return ctx['stanzaId']
        return ''

    @staticmethod
    def _msg_dt(data):
        ts = data.get('messageTimestamp')
        try:
            return datetime.utcfromtimestamp(int(ts)) if ts else False
        except (TypeError, ValueError):
            return False

    @staticmethod
    def _event_dt(payload):
        raw = payload.get('date_time') or ''
        for fmt in ('%Y-%m-%dT%H:%M:%S.%fZ', '%Y-%m-%dT%H:%M:%SZ',
                    '%Y-%m-%d %H:%M:%S'):
            try:
                return datetime.strptime(raw, fmt)
            except (TypeError, ValueError):
                continue
        return False
