"""The meeting page: Jitsi, embedded in a page Odoo can watch.

WHY THIS EXISTS
---------------
A bare `meet.jit.si/<room>` link is a call on somebody else's server. Odoo
never sees it, so a meeting run from that link recorded nothing at all --
no participants, no start, no end. That is exactly what happened on
17 Oct 2026: a meeting ran for about six minutes and its record still said
"Requested" with every time field empty.

Embedding the same room in a page we serve changes that. Jitsi's external
API fires events in the page's own JavaScript -- somebody joined, somebody
renamed themselves, somebody left -- and the page posts each one back here.
The room, the video and the audio still run on Jitsi's servers; only the
bookkeeping comes home.

WHAT IT STILL CANNOT DO
-----------------------
**It cannot record the video.** Recording a Jitsi call server-side needs
Jibri, a separate service on its own machine; the public meet.jit.si will
not hand a recording back to anyone. The external API can start a LOCAL
recording, but that file is written to the participant's own device and we
never see it. So: participants and timing are automatic, the recording is
not.

TIMES ARE THE SERVER'S
----------------------
Every timestamp is taken here, never from the browser. A device clock can
be wrong by hours and these times are what the duration, the log and any
later argument about the meeting are built from.

PUBLIC BY TOKEN
---------------
Same shape as the client approval page: `auth='public'`, a 32-character
token in the URL, constant-time compared. There is no session and no login
-- a client is not an Odoo user.
"""

import logging

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)

# Only what the embedded room needs. Jitsi loads its own scripts, styles,
# fonts and websockets from its domain, so that domain is named explicitly
# rather than opening the page up to everything.
_CSP = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline' https://meet.jit.si; "
    "style-src 'self' 'unsafe-inline'; "
    "frame-src https://meet.jit.si; "
    "connect-src 'self' https://meet.jit.si wss://meet.jit.si; "
    "img-src 'self' data: https:; "
    "font-src 'self' data: https://meet.jit.si"
)

_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>%(subject)s</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%%; margin: 0; background: #11151c; color: #e6ebf2;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  body { display: flex; flex-direction: column; }
  header { padding: 10px max(14px, env(safe-area-inset-left,0px));
    padding-top: calc(10px + env(safe-area-inset-top, 0px));
    background: #171d26; border-bottom: 1px solid #242c38;
    display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  header b { font-size: 15px; font-weight: 600; }
  header span { color: #93a1b3; font-size: 13px; }
  #room { flex: 1 1 auto; min-height: 0; }
  #room iframe { width: 100%%; height: 100%%; border: 0; display: block; }
  #msg { padding: 24px max(14px, env(safe-area-inset-left,0px)); color: #93a1b3; }
  #msg b { color: #e6ebf2; display: block; margin-bottom: 6px; font-size: 16px; }
  a { color: #7fc4ff; }
</style>
</head>
<body>
<header>
  <b>%(subject)s</b>
  <span>%(when)s</span>
</header>
<div id="room"></div>
<div id="msg" hidden>
  <b>The meeting could not be opened here.</b>
  You can still join directly: <a href="%(fallback)s">%(fallback)s</a>
</div>
<script src="https://meet.jit.si/external_api.js"></script>
<script>
(function () {
  var TOKEN = %(token)s, ROOM = %(room)s, WHO = %(who)s;
  var seen = {};

  function tell(kind, pid, name) {
    try {
      fetch('/kpi/meet/' + TOKEN + '/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'call',
          params: { kind: kind, pid: pid || '', name: name || '' } }),
        keepalive: true
      });
    } catch (e) { /* never let bookkeeping break the call */ }
  }

  if (typeof JitsiMeetExternalAPI !== 'function') {
    document.getElementById('room').hidden = true;
    document.getElementById('msg').hidden = false;
    return;
  }

  var api = new JitsiMeetExternalAPI('meet.jit.si', {
    roomName: ROOM,
    parentNode: document.getElementById('room'),
    userInfo: WHO ? { displayName: WHO } : undefined,
    configOverwrite: { prejoinPageEnabled: true, disableDeepLinking: true },
    interfaceConfigOverwrite: { MOBILE_APP_PROMO: false }
  });

  api.addEventListener('videoConferenceJoined', function (e) {
    seen[e.id] = 1;
    tell('joined', e.id, e.displayName);
  });
  api.addEventListener('participantJoined', function (e) {
    seen[e.id] = 1;
    tell('peer_joined', e.id, e.displayName);
  });
  api.addEventListener('displayNameChange', function (e) {
    tell('name', e.id, e.displayname || e.displayName);
  });
  api.addEventListener('participantLeft', function (e) {
    tell('peer_left', e.id, '');
  });
  api.addEventListener('videoConferenceLeft', function () {
    tell('left', Object.keys(seen)[0] || '', '');
  });
  window.addEventListener('pagehide', function () {
    tell('left', Object.keys(seen)[0] || '', '');
  });
})();
</script>
</body>
</html>"""


class KpiMeetingPage(http.Controller):

    def _meeting(self, token):
        return request.env['kpi.meeting'].sudo()._from_token(token)

    @http.route('/kpi/meet/<string:token>', type='http', auth='public',
                csrf=False, website=False, sitemap=False)
    def meeting_room(self, token, **kw):
        """The room itself. One page, no login, token in the URL."""
        import json

        meeting = self._meeting(token)
        if not meeting:
            return request.make_response(
                '<h1>This meeting link is not valid.</h1>',
                headers=[('Content-Type', 'text/html; charset=utf-8')])
        if meeting.state == 'cancelled':
            return request.make_response(
                '<h1>This meeting was cancelled.</h1>',
                headers=[('Content-Type', 'text/html; charset=utf-8')])

        html = _PAGE % {
            'subject': (meeting.name or 'Meeting').replace('<', '&lt;'),
            'when': (meeting.local_when or '').replace('<', '&lt;'),
            'room': json.dumps(meeting.room_name or ''),
            'token': json.dumps(token),
            'who': json.dumps(meeting.requested_by_name or ''),
            'fallback': meeting.join_url or '',
        }
        return request.make_response(html, headers=[
            ('Content-Type', 'text/html; charset=utf-8'),
            ('Content-Security-Policy', _CSP),
            ('Referrer-Policy', 'no-referrer'),
            ('Cache-Control', 'no-store'),
        ])

    @http.route('/kpi/meet/<string:token>/event', type='json', auth='public',
                methods=['POST'], csrf=False)
    def meeting_event(self, token, **params):
        """One event from inside the room.

        Always answers ok. A client whose bookkeeping call fails would get a
        console error in the middle of a meeting, and nothing about this is
        worth interrupting a call for.
        """
        meeting = self._meeting(token)
        if not meeting:
            return {'ok': False}
        kind = (params.get('kind') or '').strip()
        if kind not in ('joined', 'peer_joined', 'left', 'peer_left', 'name'):
            return {'ok': False}
        try:
            meeting.record_room_event(kind, pid=params.get('pid'),
                                      name=params.get('name'))
        except Exception as exc:
            _logger.warning('meeting %s: event %s failed: %s',
                            meeting.id, kind, exc)
            return {'ok': False}
        return {'ok': True}
