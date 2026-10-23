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
    'speaking', 'idle', 'bot_left', 'sound', 'rec_paused', 'rec_resumed',
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
  /* Who are you: the WhatsApp number box, shown only when we don't know yet. */
  #who { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; padding: 24px 16px; }
  #who[hidden], .me[hidden] { display: none; }
  #who form { width: 100%%; max-width: 380px; background: #171d26; border: 1px solid #242c38;
    border-radius: 14px; padding: 22px; display: flex; flex-direction: column; gap: 12px; }
  #who h2 { margin: 0; font-size: 18px; }
  #who p { margin: 0; color: #93a1b3; font-size: 13.5px; }
  #who input { height: 46px; border-radius: 10px; border: 1px solid #344052; background: #0f141b;
    color: #e6ebf2; padding: 0 14px; font: inherit; font-size: 16px; }
  #who button { height: 46px; border: 0; border-radius: 10px; background: #2f6fed; color: #fff;
    font: inherit; font-weight: 700; cursor: pointer; }
  #who .err { color: #ffb4bd; font-size: 13.5px; }
  /* The silence popup: "Continue?" with a countdown. */
  #ask { position: fixed; inset: 0; z-index: 50; background: rgba(5,8,12,.7);
    display: flex; align-items: center; justify-content: center; padding: 16px; }
  #ask[hidden] { display: none; }
  #ask div { width: 100%%; max-width: 380px; background: #171d26; border: 1px solid #344052;
    border-radius: 14px; padding: 22px; display: flex; flex-direction: column; gap: 12px; text-align: center; }
  #ask b { font-size: 17px; }
  #ask big { font-size: 40px; font-weight: 800; color: #ffd36b; }
  #ask button { height: 48px; border: 0; border-radius: 10px; background: #2f6fed; color: #fff;
    font: inherit; font-weight: 700; font-size: 16px; cursor: pointer; }
  #bye { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; padding: 24px;
    text-align: center; color: #93a1b3; }
  #bye[hidden] { display: none; }
  #bye b { color: #e6ebf2; display: block; font-size: 18px; margin-bottom: 6px; }
  .me { margin-left: auto; color: #93a1b3; font-size: 13px; }
  .me a { margin-left: 6px; }
</style>
</head>
<body>
<header>
  <b>%(subject)s</b>
  <span>%(when)s</span>
  <span class="me" id="me" hidden></span>
  %(rec_notice)s
</header>
<div id="who" hidden>
  <form id="whoForm" autocomplete="on">
    <h2>Join the meeting</h2>
    <p>Enter your WhatsApp number. Your name is taken from our records.</p>
    <label for="phone" style="position:absolute;left:-9999px">WhatsApp number</label>
    <input id="phone" name="tel" type="tel" inputmode="tel" autocomplete="tel" placeholder="WhatsApp number" required>
    <span class="err" id="whoErr" hidden></span>
    <button type="submit" id="whoBtn">Join</button>
  </form>
</div>
<div id="room"></div>
<div id="ask" hidden role="alertdialog" aria-labelledby="askTitle">
  <div>
    <b id="askTitle">No one has spoken for a while</b>
    <span id="askText">Are you still in the meeting? You will be taken out of the call in</span>
    <big id="askLeft">30</big>
    <button type="button" id="askBtn">Continue meeting</button>
  </div>
</div>
<div id="bye" hidden><span><b id="byeTitle">You have left the meeting</b><span id="byeText"></span></span></div>
<div id="msg" hidden>
  <b>The meeting could not be opened here.</b>
  %(fallback_block)s
</div>
<script src="%(api_js)s"></script>
<script>
(function () {
  var TOKEN = %(token)s, ROOM = %(room)s, WHO = %(who)s, JWT = %(jwt)s, PASS = %(pass)s;
  var seen = {};
  // The name always comes from Odoo: a logged-in screen sends a pass (?p=)
  // that already knows the person; the WhatsApp link asks for the number
  // once, matches it in Odoo (/whoami) and remembers it on this device.
  var KEY = 'kpi_meet_phone';
  function store(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function stored(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }

  function rpc(path, params) {
    return fetch('/kpi/meet/' + TOKEN + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: params || {} })
    }).then(function (r) { return r.json(); }).then(function (j) { return j.result || {}; });
  }

  function tell(kind, pid, name) {
    try {
      fetch('/kpi/meet/' + TOKEN + '/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'call',
          params: { kind: kind, pid: pid || '', name: name || '', pass: PASS || '' } }),
        keepalive: true
      });
    } catch (e) { /* never let bookkeeping break the call */ }
  }

  if (typeof JitsiMeetExternalAPI !== 'function') {
    document.getElementById('room').hidden = true;
    document.getElementById('msg').hidden = false;
    return;
  }

  var who = document.getElementById('who'), form = document.getElementById('whoForm'),
      phone = document.getElementById('phone'), err = document.getElementById('whoErr'),
      btn = document.getElementById('whoBtn'), me = document.getElementById('me');

  function showMe(name, canChange) {
    me.hidden = false;
    me.textContent = 'Joined as ' + name;
    if (canChange) {
      var a = document.createElement('a'); a.href = '#'; a.textContent = 'Not you? Change';
      a.onclick = function (e) { e.preventDefault(); store(KEY, null); location.reload(); };
      me.appendChild(a);
    }
  }

  function lookup(num) {
    btn.disabled = true; err.hidden = true;
    rpc('/whoami', { phone: num }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) {
        store(KEY, null);
        who.hidden = false;
        err.textContent = r.message || 'This number is not registered with us. Please ask the team.';
        err.hidden = false;
        return;
      }
      store(KEY, num);
      PASS = r.pass; JWT = r.jwt || '';
      who.hidden = true;
      showMe(r.name, true);
      start(r.name);
    }).catch(function () {
      btn.disabled = false; who.hidden = false;
      err.textContent = 'Could not check the number. Please try again.'; err.hidden = false;
    });
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); lookup(phone.value.trim()); });

  if (PASS && WHO) { showMe(WHO, false); start(WHO); }
  else if (stored(KEY)) { lookup(stored(KEY)); }
  else { who.hidden = false; phone.focus(); }

  function start(name) {
  var opts = {
    roomName: ROOM,
    parentNode: document.getElementById('room'),
    userInfo: { displayName: name },
    configOverwrite: {
      // No Jitsi name screen: the name is already the one from Odoo.
      prejoinPageEnabled: false, prejoinConfig: { enabled: false },
      requireDisplayName: false, readOnlyName: true,
      disableDeepLinking: true, disableInviteFunctions: true,
      // Only microphone, camera, screen share and leave.
      toolbarButtons: ['microphone', 'camera', 'desktop', 'hangup'],
      hideConferenceSubject: true, disableProfile: true,
      // After hang-up Jitsi would load its own close page (an 8x8 advert);
      // our "You left the meeting" box below replaces it.
      enableClosePage: false
    },
    interfaceConfigOverwrite: {
      MOBILE_APP_PROMO: false, SHOW_JITSI_WATERMARK: false, SHOW_BRAND_WATERMARK: false,
      SHOW_WATERMARK_FOR_GUESTS: false, SHOW_POWERED_BY: false,
      TOOLBAR_BUTTONS: ['microphone', 'camera', 'desktop', 'hangup'],
      HIDE_INVITE_MORE_HEADER: true
    }
  };
  // The token is what gets a guest in at all on a server that requires one.
  // Without it a hosted Jitsi shows "no moderators have yet arrived" and the
  // call never starts.
  if (JWT) { opts.jwt = JWT; }
  var api = new JitsiMeetExternalAPI(%(domain_js)s, opts);

  var myId = '', beatTimer = null, countTimer = null, left = 0, done = false;
  var ask = document.getElementById('ask'), askLeft = document.getElementById('askLeft');

  // Heartbeat: tells Odoo this person is still here (so a meeting is never
  // closed while someone is in it), and brings back the "Continue?" question
  // after a long silence, or the order to leave if they did not answer.
  function beat() {
    if (!myId || done) return;
    rpc('/beat', { pid: myId, pass: PASS || '' }).then(function (r) {
      if (r.ended) { finish('The meeting has ended', ''); return; }
      if (r.leave) { finish('You were taken out of the meeting', 'Nobody answered "Continue" after a long silence.'); return; }
      if (r.ask) {
        if (ask.hidden) {
          document.getElementById('askTitle').textContent = 'No one has spoken for ' + r.silent_min + ' min';
          ask.hidden = false;
        }
        left = r.seconds_left; askLeft.textContent = left;
        if (!countTimer) countTimer = setInterval(function () {
          left = Math.max(0, left - 1); askLeft.textContent = left;
        }, 1000);
      } else { closeAsk(); }
      schedule(r.ask ? 3000 : 15000);
    }).catch(function () { schedule(15000); });
  }
  function schedule(ms) { clearTimeout(beatTimer); beatTimer = setTimeout(beat, ms); }
  function closeAsk() { ask.hidden = true; clearInterval(countTimer); countTimer = null; }
  function finish(title, text) {
    if (done) return;
    done = true; closeAsk(); clearTimeout(beatTimer);
    try { api.executeCommand('hangup'); } catch (e) {}
    try { api.dispose(); } catch (e) {}
    document.getElementById('room').hidden = true;
    document.getElementById('byeTitle').textContent = title;
    document.getElementById('byeText').textContent = text;
    document.getElementById('bye').hidden = false;
  }
  document.getElementById('askBtn').addEventListener('click', function () {
    closeAsk();
    rpc('/continue', { pid: myId, pass: PASS || '' }).then(function () { schedule(3000); });
  });

  api.addEventListener('videoConferenceJoined', function (e) {
    seen[e.id] = 1;
    myId = e.id;
    leftSent = false;
    tell('joined', e.id, e.displayName);
    schedule(15000);
  });
  // Someone is speaking: keeps the silence clock from running out.
  var lastSpeechSent = 0;
  api.addEventListener('dominantSpeakerChanged', function () {
    var now = Date.now();
    if (now - lastSpeechSent > 20000) { lastSpeechSent = now; tell('speech', myId, ''); }
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
  // One "left" per person, with their OWN id. (It used to be sent twice,
  // with whichever id was seen first, and could mark someone else as gone.)
  var leftSent = false;
  function sayLeft() {
    if (leftSent || !myId) return;
    leftSent = true;
    tell('left', myId, '');
  }
  api.addEventListener('videoConferenceLeft', sayLeft);
  window.addEventListener('pagehide', sayLeft);
  // Hang-up: our own goodbye box instead of Jitsi's close page. readyToClose
  // comes right after the person hangs up; videoConferenceLeft is the
  // fallback, given a moment in case Jitsi is only reconnecting.
  var byeTimer = null;
  function leftForGood() {
    finish('You have left the meeting', ' You can close this page. To join again, open the same link.');
  }
  api.addEventListener('readyToClose', function () { sayLeft(); leftForGood(); });
  api.addEventListener('videoConferenceLeft', function () {
    clearTimeout(byeTimer);
    byeTimer = setTimeout(leftForGood, 2500);
  });
  api.addEventListener('videoConferenceJoined', function () { clearTimeout(byeTimer); });
  }
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
  var SEG_MS = %(seg_ms)d, PAUSE_MS = %(pause_ms)d;
  // Level above which the call counts as "someone is talking" (0..1 RMS).
  var VOICE_RMS = 0.012;

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
    listen();
    ev('rec_started', '', '', { label: st.captureLabel, mime: st.mime });
    return st;
  };

  // ---- silence: pause the recording, pick it up again when someone talks ---- //
  // The call's own audio is measured ten times a second. After PAUSE_MS with
  // nobody talking the recorder pauses (nothing silent is saved or sent to
  // speech-to-text); the first sound resumes it at once, in the same file.
  // While voices are heard, Odoo is told every ~20 s ('sound'), which is what
  // the "Continue?" silence check trusts.
  st.lastSound = Date.now(); st.paused = false; st.rollPending = false;
  var lastSoundSent = 0;
  function listen() {
    var ctx, an, buf;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      an = ctx.createAnalyser(); an.fftSize = 2048;
      ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(an);
      buf = new Float32Array(an.fftSize);
    } catch (e) { return; /* no level meter: just record everything */ }
    setInterval(function () {
      if (!st.recording || !rec) return;
      an.getFloatTimeDomainData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) { sum += buf[i] * buf[i]; }
      var rms = Math.sqrt(sum / buf.length), now = Date.now();
      if (rms > VOICE_RMS) {
        st.lastSound = now; st.lastActivity = now;
        if (st.paused && rec.state === 'paused') {
          try { rec.resume(); } catch (e) {}
          st.paused = false;
          ev('rec_resumed', '', '', {});
          if (st.rollPending) { st.rollPending = false; rollOver(); }
        }
        if (now - lastSoundSent > 20000) { lastSoundSent = now; ev('sound', '', '', {}); }
      } else if (!st.paused && rec.state === 'recording' && now - st.lastSound >= PAUSE_MS) {
        try { rec.pause(); st.paused = true; ev('rec_paused', '', '', {}); } catch (e) {}
      }
    }, 100);
  }

  function rollOver() {
    // Stop this segment (which uploads it) and open the next.
    if (rec && rec.state !== 'inactive') { rec.stop(); }
    startSegment();
  }

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
    st.paused = false;
    segTimer = setTimeout(function () {
      // While paused there is nothing new to upload: roll over once someone
      // talks again, so a piece never ends up all silence.
      if (st.paused) { st.rollPending = true; return; }
      rollOver();
    }, SEG_MS);
  }

  window.kpiStopCapture = function (why) {
    if (segTimer) { clearTimeout(segTimer); segTimer = null; }
    var was = st.recording;
    st.recording = false;
    try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (e) {}
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
        # Finished a while ago: say so plainly, instead of letting people in
        # and hanging up on them. A meeting that ended only minutes ago
        # reopens when someone joins (kpi_meeting.record_room_event).
        if meeting.state == 'done' and not meeting._can_reopen():
            return request.make_response(
                '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
                '<body style="font-family:system-ui,sans-serif;background:#11151c;color:#e6ebf2;'
                'display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">'
                '<div><h2>This meeting has ended</h2><p style="color:#93a1b3">Ask the team for a new meeting link.</p></div>',
                headers=[('Content-Type', 'text/html; charset=utf-8')])

        domain = meeting.meet_domain()
        # Who is opening it. A pass (?p=, from a logged-in screen or an
        # earlier number match) already names the person from Odoo; without
        # one the page asks for the WhatsApp number first (/whoami) and the
        # Jitsi token is made then, with the right name in it.
        kind, rec = meeting._read_pass(kw.get('p'))
        name = meeting._pass_name(kind, rec) if rec else ''
        # A client is never a moderator. They are admitted by the token and
        # nothing more.
        jwt = meeting.meet_jwt(name, moderator=False) if name else ''
        html = _PAGE % {
            'domain': domain,
            'domain_js': json.dumps(domain),
            'api_js': meeting.meet_api_js(),
            'jwt': json.dumps(jwt),
            'subject': (meeting.name or 'Meeting').replace('<', '&lt;'),
            'when': (meeting.local_when or '').replace('<', '&lt;'),
            'room': json.dumps(meeting.meet_room_path()),
            'token': json.dumps(token),
            'who': json.dumps(name),
            'pass': json.dumps(kw.get('p') if rec else ''),
            # Never the raw room link: it would let anyone in without the
            # number check above (only people in Odoo may join).
            'fallback_block': (
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
        if kind not in ('joined', 'peer_joined', 'left', 'peer_left', 'name', 'speech'):
            return {'ok': False}
        # The name that counts is Odoo's: with a valid pass, the row gets
        # the real person whatever Jitsi was told.
        pkind, prec = meeting._read_pass(params.get('pass'))
        name = meeting._pass_name(pkind, prec) if prec else params.get('name')
        try:
            meeting.record_room_event(kind, pid=params.get('pid'), name=name)
            if prec and kind in ('joined', 'name') and params.get('pid'):
                row = request.env['kpi.meeting.participant'].sudo().search(
                    [('meeting_id', '=', meeting.id),
                     ('jitsi_id', '=', (params.get('pid') or '')[:64])], limit=1)
                if row:
                    vals = {'person_name': name}
                    if pkind == 'u':
                        vals['user_id'] = prec.id
                    elif pkind == 'p':
                        vals['partner_id'] = prec.id
                    elif pkind == 'm':
                        vals.update(user_id=prec.user_id.id or False, phone=prec.phone or False)
                    row.write(vals)
        except Exception as exc:
            _logger.warning('meeting %s: event %s failed: %s',
                            meeting.id, kind, exc)
            return {'ok': False}
        # Tell the page whether recording is still wanted. Un-ticking the box
        # mid-call has to actually stop the recorder, and this is the only
        # channel back into a page that is already open.
        return {'ok': True, 'rec': bool(meeting.sudo().record_meeting)}

    @http.route('/kpi/meet/<string:token>/whoami', type='json', auth='public',
                methods=['POST'], csrf=False)
    def meeting_whoami(self, token, phone='', **kw):
        """The WhatsApp link: match the visitor's number to a person in Odoo.

        -> {ok, name, pass, jwt} or {ok: False, message}. Only people tied to
        this meeting (its group, our users, its client's contacts) are found,
        so the link cannot be used to look up anybody else.
        """
        meeting = self._meeting(token)
        if not meeting or meeting.state == 'cancelled':
            return {'ok': False, 'message': 'This meeting link is not valid.'}
        kind, rec = meeting._who_by_phone(phone)
        if not rec:
            return {'ok': False, 'message': 'This number is not registered with us. '
                                            'Please use the WhatsApp number you message us from, '
                                            'or ask the team.'}
        name = meeting._pass_name(kind, rec)
        return {'ok': True, 'name': name, 'pass': meeting._make_pass(kind, rec.id),
                'jwt': meeting.meet_jwt(name, moderator=False)}

    @http.route('/kpi/meet/<string:token>/beat', type='json', auth='public',
                methods=['POST'], csrf=False)
    def meeting_beat(self, token, pid='', **kw):
        """A page's heartbeat -> {ask, seconds_left, silent_min, leave, ended}."""
        meeting = self._meeting(token)
        if not meeting:
            return {'ended': True}
        try:
            return meeting._room_beat(pid)
        except Exception as exc:
            _logger.warning('meeting %s: beat failed: %s', meeting.id, exc)
            return {}

    @http.route('/kpi/meet/<string:token>/continue', type='json', auth='public',
                methods=['POST'], csrf=False)
    def meeting_continue(self, token, pid='', **kw):
        meeting = self._meeting(token)
        if meeting:
            meeting._room_continue(pid)
        return {'ok': bool(meeting)}

    # ---- Configuration › Meetings: every meeting timing in one place ----
    _MEET_SETTINGS = (
        # key, default, minimum
        ('meet_record_all', True, None),
        ('meet_rec_pause_min', 1, 1),
        ('meet_ask_after_min', 5, 1),
        ('meet_reply_sec', 30, 10),
        ('meet_gone_min', 3, 1),
        ('meet_bot_alone_min', 2, 1),
        ('meet_rec_max_h', 6, 1),
        ('meet_record_keep_days', 180, 0),
    )

    def _is_meet_admin(self):
        u = request.env.user
        return any(u.has_group(g) for g in ('kra_kpi_module.group_kra_admin', 'base.group_system',
                                            'kra_kpi_module.group_kra_owner'))

    @http.route('/kpi_config/meeting_get', type='json', auth='user', methods=['POST'], csrf=False)
    def meeting_settings_get(self, **kw):
        M = request.env['kpi.meeting'].sudo()
        out = {'status': True}
        for key, default, _min in self._MEET_SETTINGS:
            out[key] = M._param_bool(key, default) if isinstance(default, bool) else M._param(key, default)
        return out

    @http.route('/kpi_config/meeting_set', type='json', auth='user', methods=['POST'], csrf=False)
    def meeting_settings_set(self, **vals):
        if not self._is_meet_admin():
            return {'status': False, 'message': 'Only an admin can change meeting settings.'}
        P = request.env['ir.config_parameter'].sudo()
        for key, default, minimum in self._MEET_SETTINGS:
            if key not in vals:
                continue
            if isinstance(default, bool):
                P.set_param('kra_kpi.%s' % key, 'True' if vals[key] else 'False')
            else:
                try:
                    n = int(vals[key])
                except (TypeError, ValueError):
                    return {'status': False, 'message': 'Enter a whole number.'}
                P.set_param('kra_kpi.%s' % key, str(max(minimum, n)))
        return self.meeting_settings_get()

    @http.route('/kpi_meeting/my_link', type='json', auth='user', methods=['POST'], csrf=False)
    def meeting_my_link(self, meeting_id=None, **kw):
        """Web, app and Odoo: the room for the LOGGED-IN user, named from Odoo.
        -> {status, url} or {status: False, message}."""
        try:
            meeting = request.env['kpi.meeting'].sudo().browse(int(meeting_id or 0)).exists()
        except (TypeError, ValueError):
            meeting = None
        if not meeting:
            return {'status': False, 'message': 'Meeting not found.'}
        if meeting.state == 'cancelled':
            return {'status': False, 'message': 'This meeting was cancelled.'}
        user = request.env.user
        if not meeting._user_can_join(user):
            return {'status': False, 'message': 'You are not invited to this meeting.'}
        url = meeting._pass_url('u', user.id)
        if not url:
            return {'status': False, 'message': 'This meeting has no room yet. Confirm it first.'}
        return {'status': True, 'url': url}

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
            # Configuration › Meetings: pause recording after this much silence.
            'pause_ms': max(1, meeting._param('meet_rec_pause_min', 1)) * 60 * 1000,
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
