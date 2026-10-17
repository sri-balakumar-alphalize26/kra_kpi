"""Thin HTTP client for a self-hosted Evolution API server.

Plain Python -- NOT an Odoo model, so it can be unit-tested and so the ORM
layer above it stays free of transport detail.

Replaces the in-process neonize/whatsmeow client. The practical consequences:

* Sending is now a stateless HTTP POST, so ANY worker, cron or webhook request
  can send. The old build kept the client in one worker's memory while `status`
  lived in Postgres, so a second worker saw 'connected' and had no client.
* WhatsApp's client-version check is Evolution's problem, not ours. The old
  build was dead with `Client outdated (405)` because the whatsmeow version was
  compiled into neonize's .dll.

VERIFIED against Evolution 2.3.7 on 16 Oct 2026:
    GET  /                                     -> {version, clientName, ...}
    POST /instance/create                      -> {instance:{instanceId,...}, hash, qrcode:{base64,...}}
    GET  /instance/connect/{inst}              -> {pairingCode, code, base64, count}
    GET  /instance/connectionState/{inst}      -> {instance:{state: open|connecting|close}}
    GET  /instance/fetchInstances              -> [{name, connectionStatus, ownerJid, profileName, ...}]
    POST /message/sendText/{inst}              -> {key:{id, remoteJid}, status}
    GET  /group/fetchAllGroups/{inst}          -> [{id, subject, size, ...}]
    POST /chat/whatsappNumbers/{inst}          -> [{jid, exists, number, name}]
NOT yet exercised here (shapes follow the same docs, treat with care):
    /message/sendMedia, /message/sendWhatsAppAudio, /chat/getBase64FromMediaMessage,
    /instance/logout, /instance/delete, /webhook/set

The `qrcode.base64` value carries a `data:image/png;base64,` prefix which MUST
be stripped before it goes into a Binary field -- see `strip_data_uri`.
"""

import base64
import json
import logging

import requests
from requests.adapters import HTTPAdapter

try:                                     # urllib3 v2 vs v1 import path
    from urllib3.util.retry import Retry
except ImportError:                      # pragma: no cover
    from requests.packages.urllib3.util.retry import Retry  # type: ignore

_logger = logging.getLogger(__name__)

# Evolution refuses a poll with more than this -- a 400, not a truncation.
# Confirmed from its own error: 'values does not meet maximum length of 10'.
MAX_POLL_OPTIONS = 10
DEFAULT_TIMEOUT = (5, 30)        # (connect, read)
MEDIA_TIMEOUT = (5, 120)         # base64 media round-trips are slow


class EvolutionError(Exception):
    """Base. Carries enough to diagnose without re-reading the response."""

    def __init__(self, message, status=None, body=None, endpoint=None):
        super().__init__(message)
        self.status = status
        self.body = body
        self.endpoint = endpoint


class EvolutionAuthError(EvolutionError):
    """401/403 -- wrong apikey."""


class EvolutionNotFoundError(EvolutionError):
    """404 -- instance does not exist on the server."""


class EvolutionNotConnectedError(EvolutionError):
    """The instance exists but is not linked to WhatsApp."""


class EvolutionRateLimitError(EvolutionError):
    """429."""


class EvolutionServerError(EvolutionError):
    """5xx."""


class EvolutionTimeoutError(EvolutionError):
    """Connect or read timeout."""


def strip_data_uri(value):
    """'data:image/png;base64,iVBOR...' -> 'iVBOR...'. Safe on a bare string."""
    s = (value or '')
    if s.startswith('data:') and ',' in s:
        return s.split(',', 1)[1]
    return s


def mask(secret):
    """Never log a key in full."""
    s = (secret or '')
    if len(s) <= 8:
        return '***'
    return '%s...%s' % (s[:4], s[-4:])


def to_b64(data):
    """Accept bytes or an already-base64 str; always return a base64 str."""
    if data is None:
        return ''
    if isinstance(data, bytes):
        return base64.b64encode(data).decode('ascii')
    return str(data)


class EvolutionClient:
    """One instance of this per (base_url, apikey). Cheap to construct."""

    def __init__(self, base_url, apikey, timeout=DEFAULT_TIMEOUT, retries=2):
        self.base_url = (base_url or '').rstrip('/')
        self.apikey = apikey or ''
        self.timeout = timeout
        self._session = requests.Session()
        # IMPORTANT: idempotent verbs only. A POST /message/sendText that times
        # out on READ may well have been delivered; retrying it double-sends.
        # The send helpers below do one explicit connect-phase retry instead.
        retry = Retry(
            total=retries,
            backoff_factor=0.5,
            status_forcelist=(429, 502, 503, 504),
            allowed_methods=frozenset(['GET', 'DELETE']),
            respect_retry_after_header=True,
        )
        adapter = HTTPAdapter(max_retries=retry)
        self._session.mount('http://', adapter)
        self._session.mount('https://', adapter)

    # ------------------------------------------------------------------
    # plumbing
    # ------------------------------------------------------------------
    def _headers(self):
        return {'apikey': self.apikey, 'Content-Type': 'application/json'}

    def _url(self, path):
        return '%s%s' % (self.base_url, path if path.startswith('/') else '/' + path)

    def _request(self, method, path, payload=None, timeout=None, params=None):
        url = self._url(path)
        try:
            resp = self._session.request(
                method, url,
                headers=self._headers(),
                data=json.dumps(payload) if payload is not None else None,
                params=params,
                timeout=timeout or self.timeout,
            )
        except requests.exceptions.Timeout as exc:
            raise EvolutionTimeoutError('Evolution timed out: %s' % exc, endpoint=path) from exc
        except requests.exceptions.RequestException as exc:
            raise EvolutionError('Evolution unreachable: %s' % exc, endpoint=path) from exc

        body = resp.text
        try:
            parsed = resp.json()
        except ValueError:
            parsed = None

        if resp.status_code in (401, 403):
            raise EvolutionAuthError(
                'Evolution rejected the API key (%s) for %s' % (resp.status_code, path),
                status=resp.status_code, body=body, endpoint=path)
        if resp.status_code == 404:
            raise EvolutionNotFoundError(
                'Evolution has no such resource: %s' % path,
                status=404, body=body, endpoint=path)
        if resp.status_code == 429:
            raise EvolutionRateLimitError(
                'Evolution rate limit on %s' % path, status=429, body=body, endpoint=path)
        if resp.status_code >= 500:
            raise EvolutionServerError(
                'Evolution server error %s on %s' % (resp.status_code, path),
                status=resp.status_code, body=body, endpoint=path)
        if resp.status_code >= 400:
            raise EvolutionError(
                'Evolution refused %s (%s): %s' % (path, resp.status_code, body[:400]),
                status=resp.status_code, body=body, endpoint=path)
        return parsed if parsed is not None else {}

    def _send(self, path, payload, timeout=None):
        """POST that must not be auto-retried. One manual retry, connect-phase only."""
        try:
            return self._request('POST', path, payload, timeout=timeout)
        except EvolutionError as exc:
            # Only safe to retry when we know no bytes reached the server.
            cause = exc.__cause__
            connect_phase = isinstance(cause, requests.exceptions.ConnectTimeout) or \
                isinstance(cause, requests.exceptions.ConnectionError)
            if not connect_phase:
                raise
            _logger.warning('Evolution connect failed on %s, retrying once', path)
            return self._request('POST', path, payload, timeout=timeout)

    # ------------------------------------------------------------------
    # server / instance
    # ------------------------------------------------------------------
    def server_info(self):
        return self._request('GET', '/')

    def create_instance(self, instance, webhook_url=None, events=None, headers=None):
        payload = {
            'instanceName': instance,
            'qrcode': True,
            'integration': 'WHATSAPP-BAILEYS',
        }
        if webhook_url:
            payload['webhook'] = {
                'enabled': True,
                'url': webhook_url,
                'byEvents': False,
                'base64': True,
                'events': events or [],
                'headers': headers or {},
            }
        return self._send('/instance/create', payload)

    def connect_instance(self, instance):
        """Returns the QR payload: {pairingCode, code, base64, count}."""
        return self._request('GET', '/instance/connect/%s' % instance)

    def connection_state(self, instance):
        """-> 'open' | 'connecting' | 'close' | ''"""
        data = self._request('GET', '/instance/connectionState/%s' % instance)
        return ((data or {}).get('instance') or {}).get('state') or ''

    def fetch_instances(self):
        data = self._request('GET', '/instance/fetchInstances')
        return data if isinstance(data, list) else []

    def logout_instance(self, instance):
        return self._request('DELETE', '/instance/logout/%s' % instance)

    def delete_instance(self, instance):
        return self._request('DELETE', '/instance/delete/%s' % instance)

    def set_webhook(self, instance, webhook_url, events=None, headers=None):
        payload = {'webhook': {
            'enabled': True,
            'url': webhook_url,
            'byEvents': False,
            'base64': True,
            'events': events or [],
            'headers': headers or {},
        }}
        return self._send('/webhook/set/%s' % instance, payload)

    def find_webhook(self, instance):
        """Where Evolution is actually delivering: {'url', 'enabled', ...}.

        Needed because an instance can be 'open' while its webhook points at
        something else entirely -- a different Odoo database, or a port that
        no longer listens. Nothing about the connection state reveals that,
        and the symptom is messages that simply never arrive.
        """
        data = self._request('GET', '/webhook/find/%s' % instance)
        return data if isinstance(data, dict) else {}

    # ------------------------------------------------------------------
    # messaging
    # ------------------------------------------------------------------
    def send_text(self, instance, number, text, delay=0, mentions=None, quoted=None):
        payload = {'number': number, 'text': text}
        if delay:
            payload['delay'] = int(delay)
        if mentions:
            payload['mentioned'] = list(mentions)
        if quoted:
            payload['quoted'] = quoted
        return self._send('/message/sendText/%s' % instance, payload)

    def send_media(self, instance, number, mediatype, media_b64, mimetype=None,
                   caption='', file_name=None, delay=0):
        """mediatype: 'image' | 'video' | 'document'.

        Base64 in the body rather than a URL on purpose: Odoo attachments are
        not publicly reachable and we must not mint public URLs for invoices.
        Operational consequence -- raise the reverse proxy's body-size limit;
        nginx's 1MB default rejects a 3MB PDF with a 413.
        """
        payload = {'number': number, 'mediatype': mediatype, 'media': media_b64}
        if mimetype:
            payload['mimetype'] = mimetype
        if caption:
            payload['caption'] = caption
        if file_name:
            payload['fileName'] = file_name
        if delay:
            payload['delay'] = int(delay)
        return self._send('/message/sendMedia/%s' % instance, payload, timeout=MEDIA_TIMEOUT)

    def send_audio(self, instance, number, audio_b64, delay=0):
        payload = {'number': number, 'audio': audio_b64}
        if delay:
            payload['delay'] = int(delay)
        return self._send('/message/sendWhatsAppAudio/%s' % instance, payload,
                          timeout=MEDIA_TIMEOUT)

    def send_buttons(self, instance, number, title, description, buttons,
                     footer='', delay=0):
        """Up to THREE tappable reply buttons. WhatsApp hard-caps it at 3 --
        use send_list() for more. `buttons` is [{'id':..,'text':..}]."""
        payload = {
            'number': number,
            'title': title,
            'description': description,
            'buttons': [{'type': 'reply',
                         'displayText': b['text'][:20],   # WA truncates ~20
                         'id': b['id']} for b in buttons[:3]],
        }
        if footer:
            payload['footer'] = footer
        if delay:
            payload['delay'] = int(delay)
        return self._send('/message/sendButtons/%s' % instance, payload)

    def send_list(self, instance, number, title, description, button_text,
                  rows, section_title='', footer='', delay=0):
        """A tappable picker, up to 10 rows. `rows` is
        [{'id':..,'title':..,'description':..}]."""
        payload = {
            'number': number,
            'title': title,
            'description': description,
            'buttonText': button_text,
            'sections': [{
                'title': section_title or title,
                'rows': [{'rowId': r['id'],
                          'title': r['title'][:24],
                          'description': (r.get('description') or '')[:72]}
                         for r in rows[:10]],
            }],
        }
        if footer:
            payload['footerText'] = footer
        if delay:
            payload['delay'] = int(delay)
        return self._send('/message/sendList/%s' % instance, payload)

    def send_poll(self, instance, number, name, options, selectable=1, delay=0):
        """A native WhatsApp poll -- the ONE tappable menu that works here.

        Buttons and list messages are restricted to the official Business API
        and silently fail to render on an unofficial connection. A poll is an
        ordinary consumer feature, so it renders everywhere, and Evolution
        decrypts the vote server-side into plain `selectedOptions` text.

        EVOLUTION CAPS A POLL AT **10** OPTIONS, not 12. This said 12 and
        sliced to 12, which was worse than no cap at all: Evolution does not
        truncate, it refuses the whole request --

            400 {"message":[["values does not meet maximum length of 10"]]}

        -- and whatsapp.session then falls back to a numbered TEXT list. So an
        11- or 12-row menu did not lose its last rows, it stopped being
        tappable at all, which is how the developer menu arrived as "1 - ...
        2 - ..." after growing past ten.

        Slicing here is the backstop. A caller that needs more than ten rows
        should split or shorten the menu rather than silently lose options.
        `selectable=1` makes it single-choice.
        """
        payload = {
            'number': number,
            'name': name[:255],
            'selectableCount': int(selectable),
            'values': [str(o)[:100] for o in options[:MAX_POLL_OPTIONS]],
        }
        if delay:
            payload['delay'] = int(delay)
        return self._send('/message/sendPoll/%s' % instance, payload)

    def check_numbers(self, instance, numbers):
        """-> [{jid, exists, number, name}]"""
        data = self._send('/chat/whatsappNumbers/%s' % instance, {'numbers': list(numbers)})
        return data if isinstance(data, list) else []

    def get_base64_from_media(self, instance, wa_message_id):
        """Download inbound media. Evolution wants the whole message key."""
        return self._send('/chat/getBase64FromMediaMessage/%s' % instance,
                          {'message': {'key': {'id': wa_message_id}}},
                          timeout=MEDIA_TIMEOUT)

    # ------------------------------------------------------------------
    # groups
    # ------------------------------------------------------------------
    def fetch_all_groups(self, instance, get_participants=False):
        data = self._request(
            'GET', '/group/fetchAllGroups/%s' % instance,
            params={'getParticipants': 'true' if get_participants else 'false'},
            timeout=MEDIA_TIMEOUT,          # this call is slow on big accounts
        )
        return data if isinstance(data, list) else []

    def group_participants(self, instance, group_jid):
        data = self._request('GET', '/group/participants/%s' % instance,
                             params={'groupJid': group_jid})
        return (data or {}).get('participants') or []

    def group_invite_code(self, instance, group_jid):
        return self._request('GET', '/group/inviteCode/%s' % instance,
                             params={'groupJid': group_jid})

    def group_info_from_invite(self, instance, invite_code):
        return self._request('GET', '/group/inviteInfo/%s' % instance,
                             params={'inviteCode': invite_code})

    def group_join(self, instance, invite_code):
        return self._request('GET', '/group/acceptInviteCode/%s' % instance,
                             params={'inviteCode': invite_code})
