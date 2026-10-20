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

RECORDING
---------
Audio recording IS available, and it is not Jibri. A headless Chrome on this
server opens `/kpi/meet/<bot_token>/bot`, joins the same room as an ordinary
participant, and captures the audio the tab is playing -- which is everyone
else in the call. See `tools/meeting_recorder.py`.

Three things make that work, each of which cost a wrong turn to find:

* `--auto-accept-this-tab-capture` with `getDisplayMedia({preferCurrentTab:
  true})` captures the tab with no picker and no Allow click.
  `--use-fake-ui-for-media-stream` looks like it should do the same job but
  hands back Chrome's synthetic 'Fake audio' device instead -- a 398 Hz tone
  that ignores the page completely.
* Playwright adds `--mute-audio` whenever `headless=True`. A muted tab
  renders no audio, so the capture succeeds and records digital silence.
  `ignore_default_args=['--mute-audio']` is not optional.
* `navigator.mediaDevices` only exists in a secure context, which is why the
  bot loads this page over http://localhost and not from a file.

What is still impossible: VIDEO. Nobody needs it for a summary, and audio at
32 kbps is about 11 MB an hour against gigabytes for the picture.

`lib-jitsi-meet` would have given one audio track per speaker, which is
better for attribution -- but meet.jit.si refuses third-party clients
(`CONNECTION_FAILED: connection.passwordRequired`), so the mixed tab audio
is what there is. Per-speaker attribution comes from `dominantSpeakerChanged`
instead.

THE RECORDER IS VISIBLE, ALWAYS
-------------------------------
The bot joins under a display name that says it is recording, so everyone in
the call can see it in the participant list for the whole call. Jitsi shows
no REC badge for this -- that badge belongs to Jibri -- so this name and the
banner on this page are the only indication the other party gets. Do not
"tidy" either of them away.

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
def _csp(domain):
    """Built from the configured Jitsi host, not a hard-coded one.

    A self-hosted Jitsi is a different domain, and a CSP still naming
    meet.jit.si would block it with no visible error at all -- the iframe
    would simply stay blank.
    """
    return (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://{d}; "
        "style-src 'self' 'unsafe-inline'; "
        "frame-src https://{d}; "
        "connect-src 'self' https://{d} wss://{d}; "
        "img-src 'self' data: https:; "
        "font-src 'self' data: https://{d}"
    ).format(d=domain)

# What the recorder's page is allowed to report. A whitelist rather than a
# pass-through, so a route that is public by token cannot be used to write
# arbitrary event kinds onto a meeting.
_BOT_EVENT_KINDS = (
    'bot_joined', 'peer_joined', 'peer_left', 'name',
    'rec_started', 'rec_stopped', 'rec_failed', 'rec_no_audio',
    'speaking', 'idle', 'bot_left',
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
  /* Not a toast and not dismissible. It is the notice that the people in
     the call are being recorded, so it stays on screen for the whole call. */
  .rec { display: flex; gap: 8px; align-items: baseline; flex-basis: 100%%;
    background: #3a1d22; color: #ffd9de; border: 1px solid #7d2b36;
    border-radius: 6px; padding: 8px 10px; font-size: 13px; }
  .rec b { color: #fff; }
</style>
</head>
<body>
<header>
  <b>%(subject)s</b>
  <span>%(when)s</span>
  %(rec_notice)s
</header>
<div id="room"></div>
<div id="msg" hidden>
  <b>The meeting could not be opened here.</b>
  %(fallback_block)s
</div>
<script src="%(api_js)s"></script>
<script>
(function () {
  var TOKEN = %(token)s, ROOM = %(room)s, WHO = %(who)s, JWT = %(jwt)s;
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

  var opts = {
    roomName: ROOM,
    parentNode: document.getElementById('room'),
    userInfo: WHO ? { displayName: WHO } : undefined,
    configOverwrite: { prejoinPageEnabled: true, disableDeepLinking: true },
    interfaceConfigOverwrite: { MOBILE_APP_PROMO: false }
  };
  // The token is what gets a guest in at all on a server that requires one.
  // Without it a hosted Jitsi shows "no moderators have yet arrived" and the
  // call never starts.
  if (JWT) { opts.jwt = JWT; }
  var api = new JitsiMeetExternalAPI(%(domain_js)s, opts);

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


_BOT_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>%(title)s</title>
</head>
<body>
<div id="room" style="width:1024px;height:640px"></div>
<script src="%(api_js)s"></script>
<script>
(function () {
  var TOKEN = %(token)s, ROOM = %(room)s, WHO = %(who)s, JWT = %(jwt)s;
  var SEG_MS = %(seg_ms)d;

  var st = {
    joined: false, peers: 0, lastActivity: Date.now(), lastSpeech: 0,
    speaking: null, speakingSince: 0, recording: false, segments: 0,
    bytes: 0, error: '', captureLabel: ''
  };
  window.kpiStatus = function () { return st; };

  function post(path, body, isJson) {
    return fetch('/kpi/meet/' + TOKEN + '/' + path, {
      method: 'POST',
      headers: isJson ? { 'Content-Type': 'application/json' } : {},
      body: isJson ? JSON.stringify(body) : body
    });
  }
  function ev(kind, pid, name, extra) {
    st.lastActivity = Date.now();
    return post('botevent', { kind: kind, pid: pid || '', name: name || '',
                              extra: extra || {} }, true).catch(function () {});
  }

  // ---- the call ----------------------------------------------------- //
  if (typeof JitsiMeetExternalAPI !== 'function') {
    st.error = 'external_api.js did not load';
    return;
  }
  var botOpts = {
    roomName: ROOM,
    parentNode: document.getElementById('room'),
    userInfo: { displayName: WHO },
    configOverwrite: {
      // No prejoin screen: nobody is here to click Join.
      prejoinPageEnabled: false,
      disableDeepLinking: true,
      // The recorder listens. It has no microphone and no camera, and a
      // server has neither anyway.
      startWithAudioMuted: true,
      startWithVideoMuted: true,
      disableAP: true,
      // Keep the audio we are capturing unprocessed: echo cancellation and
      // noise suppression are tuned for a microphone in a room, and they
      // chew holes in a mixed-down recording.
      disableAEC: true, disableNS: true, disableAGC: true,
      disableSelfView: true
    },
    interfaceConfigOverwrite: {
      MOBILE_APP_PROMO: false, SHOW_JITSI_WATERMARK: false,
      DISABLE_JOIN_LEAVE_NOTIFICATIONS: true
    }
  };
  // A MODERATOR token. This is the whole reason the recorder can get into a
  // room with no human present: a server that waits for a moderator is
  // satisfied by this and starts the conference.
  if (JWT) { botOpts.jwt = JWT; }
  var api = new JitsiMeetExternalAPI(%(domain_js)s, botOpts);

  api.addEventListener('videoConferenceJoined', function (e) {
    st.joined = true;
    ev('bot_joined', e.id, WHO);
  });
  api.addEventListener('participantJoined', function (e) {
    st.peers += 1;
    ev('peer_joined', e.id, e.displayName);
  });
  api.addEventListener('participantLeft', function (e) {
    st.peers = Math.max(0, st.peers - 1);
    ev('peer_left', e.id, '');
  });
  api.addEventListener('displayNameChange', function (e) {
    ev('name', e.id, e.displayname || e.displayName);
  });

  // Who is talking, and for how long. This is the only speaker attribution
  // available: the mixed tab audio cannot be separated after the fact.
  api.addEventListener('dominantSpeakerChanged', function (e) {
    var now = Date.now();
    if (st.speaking && st.speakingSince) {
      ev('speaking', st.speaking, '',
         { seconds: Math.round((now - st.speakingSince) / 1000) });
    }
    st.speaking = e.id;
    st.speakingSince = now;
    st.lastSpeech = now;
    st.lastActivity = now;
  });
  api.addEventListener('videoConferenceLeft', function () {
    st.joined = false;
  });

  // ---- capture ------------------------------------------------------ //
  // Started from Python with page.evaluate, NOT from inside a Jitsi event
  // callback: getDisplayMedia needs transient activation and throws
  // NotAllowedError when called from a plain event handler.
  var stream = null, rec = null, segTimer = null;

  window.kpiStartCapture = async function () {
    if (st.recording) return st;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true, audio: true, preferCurrentTab: true });
    } catch (e) {
      st.error = 'getDisplayMedia: ' + e.name + ': ' + e.message;
      ev('rec_failed', '', '', { reason: st.error });
      return st;
    }
    // Audio-only display capture is refused by Chrome, so we ask for video
    // and drop the track at once. A transcript never reads the pixels.
    stream.getVideoTracks().forEach(function (t) { t.stop(); });
    var tracks = stream.getAudioTracks();
    if (!tracks.length) {
      st.error = 'the captured stream carried no audio track';
      ev('rec_no_audio', '', '', { reason: st.error });
      return st;
    }
    st.captureLabel = tracks[0].label;
    // If somebody stops the share, stop recording -- otherwise MediaRecorder
    // keeps emitting silent segments for the rest of the call.
    tracks[0].onended = function () { window.kpiStopCapture('share_ended'); };

    var types = ['audio/webm;codecs=opus', 'audio/webm',
                 'audio/ogg;codecs=opus'];
    st.mime = types.filter(function (t) {
      return MediaRecorder.isTypeSupported(t); })[0] || '';
    if (!st.mime) {
      st.error = 'no supported audio container';
      ev('rec_failed', '', '', { reason: st.error });
      return st;
    }

    st.recording = true;
    startSegment();
    ev('rec_started', '', '', { label: st.captureLabel, mime: st.mime });
    return st;
  };

  function startSegment() {
    if (!st.recording || !stream) return;
    var parts = [];
    rec = new MediaRecorder(new MediaStream(stream.getAudioTracks()),
                            { mimeType: st.mime, audioBitsPerSecond: 32000 });
    rec.ondataavailable = function (e) {
      if (e.data && e.data.size) parts.push(e.data);
    };
    rec.onstop = function () {
      var seq = st.segments;
      st.segments += 1;
      var blob = new Blob(parts, { type: st.mime });
      if (!blob.size) return;
      st.bytes += blob.size;
      // Each segment is a COMPLETE file with its own header, so it plays and
      // transcribes on its own. That is why there is no stitching step, and
      // why a crash costs one segment rather than the meeting.
      post('rec?seq=' + seq + '&mime=' + encodeURIComponent(st.mime), blob,
           false).catch(function () {});
    };
    rec.start();
    segTimer = setTimeout(function () {
      // Roll over: stop this segment (which uploads it) and open the next.
      if (rec && rec.state === 'recording') { rec.stop(); }
      startSegment();
    }, SEG_MS);
  }

  window.kpiStopCapture = function (why) {
    if (segTimer) { clearTimeout(segTimer); segTimer = null; }
    var was = st.recording;
    st.recording = false;
    try { if (rec && rec.state === 'recording') rec.stop(); } catch (e) {}
    try {
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    } catch (e) {}
    if (was) ev('rec_stopped', '', '', { reason: why || 'stopped' });
    return st;
  };

  window.kpiLeave = function () {
    // Flush the speaking window that is open right now, or the last speaker
    // of every meeting would be credited with nothing.
    if (st.speaking && st.speakingSince) {
      ev('speaking', st.speaking, '',
         { seconds: Math.round((Date.now() - st.speakingSince) / 1000) });
      st.speaking = null;
    }
    try { api.executeCommand('hangup'); } catch (e) {}
    return st;
  };
})();
</script>
</body>
</html>"""


class KpiMeetingPage(http.Controller):

    def _meeting(self, token):
        return request.env['kpi.meeting'].sudo()._from_token(token)

    def _bot_meeting(self, token):
        """Resolve a BOT token only.

        Deliberately a different method and a different column from
        _meeting(): the client link circulates in WhatsApp groups, and the
        routes that accept audio must not be reachable with it.
        """
        return request.env['kpi.meeting'].sudo()._from_bot_token(token)

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

        domain = meeting.meet_domain()
        # A client is never a moderator. They are admitted by the token and
        # nothing more.
        jwt = meeting.meet_jwt(meeting.requested_by_name or 'Guest',
                               moderator=False)
        html = _PAGE % {
            'domain': domain,
            'domain_js': json.dumps(domain),
            'api_js': meeting.meet_api_js(),
            'jwt': json.dumps(jwt),
            'subject': (meeting.name or 'Meeting').replace('<', '&lt;'),
            'when': (meeting.local_when or '').replace('<', '&lt;'),
            'room': json.dumps(meeting.meet_room_path()),
            'token': json.dumps(token),
            'who': json.dumps(meeting.requested_by_name or ''),
            # Only offer the raw room link where it would actually work. On a
            # token-gated server it leads to 'no moderators have yet arrived',
            # which looks like our fault and is worse than no link at all.
            'fallback_block': (
                'You can still join directly: '
                '<a href="%s">%s</a>' % (meeting.join_url, meeting.join_url)
            ) if (meeting.join_url and not jwt) else (
                'Please reopen the link that was sent to you. This meeting '
                'can only be joined from that link.'),
            # Rendered from record_meeting at page load. Turning recording ON
            # mid-call is refused in kpi.meeting.write() precisely because
            # this notice cannot be updated afterwards -- nobody should ever
            # be recorded under a page that told them they were not.
            'rec_notice': (
                '<div class="rec"><b>Recording.</b> The audio of this call is '
                'being saved to Alphalize\'s system and used to write the '
                'summary. You can see the recorder in the participant list. '
                'Please leave the call if you do not want to be recorded.'
                '</div>') if meeting.sudo().record_meeting else '',
        }
        return request.make_response(html, headers=[
            ('Content-Type', 'text/html; charset=utf-8'),
            ('Content-Security-Policy', _csp(domain)),
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
        # Tell the page whether recording is still wanted. Un-ticking the box
        # mid-call has to actually stop the recorder, and this is the only
        # channel back into a page that is already open.
        return {'ok': True, 'rec': bool(meeting.sudo().record_meeting)}

    # ------------------------------------------------------------------
    # The recorder bot. Bot token only, never the client's.
    # ------------------------------------------------------------------
    @http.route('/kpi/meet/<string:token>/bot', type='http', auth='public',
                csrf=False, website=False, sitemap=False)
    def meeting_bot_page(self, token, **kw):
        """The page the headless Chrome on this server opens.

        Served over http://localhost, which matters: navigator.mediaDevices
        exists only in a secure context, and localhost counts as one.
        """
        import json

        meeting = self._bot_meeting(token)
        if not meeting:
            return request.make_response('not found', status=404, headers=[
                ('Content-Type', 'text/plain; charset=utf-8')])
        if not meeting.record_meeting:
            return request.make_response('recording is not enabled',
                                         status=403, headers=[
                ('Content-Type', 'text/plain; charset=utf-8')])

        seg_min = meeting._param('meet_segment_minutes', 5)
        domain = meeting.meet_domain()
        html = _BOT_PAGE % {
            'title': 'recorder',
            'domain': domain,
            'domain_js': json.dumps(domain),
            'api_js': meeting.meet_api_js(),
            # MODERATOR, and only here. This token never leaves the server:
            # it is rendered into a page only the local recorder opens.
            'jwt': json.dumps(meeting.meet_jwt(
                meeting._recorder_display_name(), moderator=True)),
            'room': json.dumps(meeting.meet_room_path()),
            'token': json.dumps(token),
            'who': json.dumps(meeting._recorder_display_name()),
            'seg_ms': max(30, int(seg_min) * 60) * 1000,
        }
        return request.make_response(html, headers=[
            ('Content-Type', 'text/html; charset=utf-8'),
            ('Content-Security-Policy', _csp(domain)),
            ('Referrer-Policy', 'no-referrer'),
            ('Cache-Control', 'no-store'),
        ])

    @http.route('/kpi/meet/<string:token>/botevent', type='json',
                auth='public', methods=['POST'], csrf=False)
    def meeting_bot_event(self, token, **params):
        """One event from inside the recorder's own page."""
        meeting = self._bot_meeting(token)
        if not meeting:
            return {'ok': False}
        kind = (params.get('kind') or '').strip()
        if kind not in _BOT_EVENT_KINDS:
            return {'ok': False}
        try:
            meeting.record_bot_event(kind, pid=params.get('pid'),
                                     name=params.get('name'),
                                     extra=params.get('extra') or {})
        except Exception as exc:
            _logger.warning('meeting %s: bot event %s failed: %s',
                            meeting.id, kind, exc)
            return {'ok': False}
        return {'ok': True, 'rec': bool(meeting.sudo().record_meeting)}

    @http.route('/kpi/meet/<string:token>/rec', type='http', auth='public',
                methods=['POST'], csrf=False, website=False, sitemap=False)
    def meeting_bot_segment(self, token, seq=None, mime=None, **kw):
        """One finished audio segment.

        type='http' rather than 'json' because the body is binary and would
        not survive a JSON decode. Every rejection answers the same way: a
        route that explains WHICH check failed is a tool for probing tokens.
        """
        bad = request.make_response('no', status=400, headers=[
            ('Content-Type', 'text/plain; charset=utf-8')])

        meeting = self._bot_meeting(token)
        if not meeting:
            return bad
        try:
            data = request.httprequest.get_data()
            ok = meeting.store_recording_segment(
                data, seq=seq, mimetype=mime,
                content_length=request.httprequest.content_length)
        except Exception as exc:
            _logger.warning('meeting %s: segment rejected: %s',
                            meeting.id, exc)
            return bad
        if not ok:
            return bad
        return request.make_json_response({'ok': True})
