"""The meeting recorder: a headless Chrome that joins the call and listens.

NOT an Odoo module. A standalone script Odoo launches with Popen, one process
per meeting, detached so that an HTTP request reporting "somebody joined" is
not held open while a browser starts.

    python.exe meeting_recorder.py --base http://127.0.0.1:8069 \
        --token <bot token> --meeting 42

WHAT IT DOES
------------
Opens /kpi/meet/<bot_token>/bot, which joins the Jitsi room as an ordinary
participant under a display name that says it is recording. The page captures
the audio the tab is playing -- everyone else in the call -- and POSTs it back
to Odoo in segments. This process only decides WHEN: start capture, roll the
segments, and leave when the room is empty or has gone quiet.

WHY A SEPARATE PROCESS
----------------------
A browser lives for the length of a meeting. An Odoo worker cannot.

THE FOUR THINGS THAT MAKE THE CAPTURE WORK
------------------------------------------
Each of these was established by experiment, and each looks optional until it
is missing:

1. `ignore_default_args=['--mute-audio']`. Playwright adds --mute-audio
   whenever headless=True. A muted tab renders no audio, so getDisplayMedia
   returns a healthy-looking 'Tab audio' track that is digitally silent --
   RMS exactly 0.00000. Nothing errors. Nothing warns.
2. `--auto-accept-this-tab-capture` plus `preferCurrentTab: true`. This is
   what removes the picker and the Allow click.
   `--use-fake-ui-for-media-stream` appears to do the same thing and instead
   substitutes Chrome's synthetic 'Fake audio' device: a 398 Hz tone that
   does not change when the page does.
3. The page is loaded over http://127.0.0.1, a secure context.
   `navigator.mediaDevices` is simply undefined otherwise.
4. Capture is started from HERE with page.evaluate, not from inside a Jitsi
   event callback. getDisplayMedia needs transient activation and throws
   NotAllowedError when called from an ordinary event handler.

VERIFY A RECORDING BY DECODING IT, NEVER BY ITS SIZE. Opus encodes silence to
perfectly plausible bytes.
"""

import argparse
import json
import logging
import sys
import time
import urllib.error
import urllib.request

_logger = logging.getLogger('kpi.meeting.recorder')

# Chrome flags. Everything here has a reason; see the module docstring.
CHROME_ARGS = [
    '--auto-accept-this-tab-capture',
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    # No real devices on a server, and Jitsi errors out enumerating none.
    # This fakes the INPUTS only; it does not touch what we capture.
    '--use-fake-device-for-media-stream',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
]

# How often to look at the room, in seconds. The page keeps the state; this
# only reads it.
POLL_SECONDS = 5

# Give the room this long to let the bot in before giving up.
JOIN_TIMEOUT = 90

# Absolute ceiling, whatever else happens. A browser that somehow never
# notices the room emptied must not record until the disk fills.
MAX_MEETING_SECONDS = 6 * 3600


def report(base, token, kind, extra=None):
    """Tell Odoo something. Never raises: this is bookkeeping."""
    url = '%s/kpi/meet/%s/botevent' % (base.rstrip('/'), token)
    payload = {'jsonrpc': '2.0', 'method': 'call',
               'params': {'kind': kind, 'pid': '', 'name': '',
                          'extra': extra or {}}}
    try:
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode('utf-8'), method='POST')
        req.add_header('Content-Type', 'application/json')
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as exc:
        _logger.warning('could not report %s: %s', kind, exc)
        return None


# The prejoin screen's Join button. Its test id has moved between Jitsi
# releases, so try several rather than break on the next one.
PREJOIN_SELECTORS = (
    '[data-testid="prejoin.joinMeeting"]',
    '.prejoin-preview-btn-container button',
    'div[role="button"]:has-text("Join meeting")',
    'button:has-text("Join meeting")',
)

# Things a Jitsi server says instead of letting you in. Matched so the
# meeting record can carry the real reason.
BLOCKERS = (
    ('no moderators have yet arrived',
     'This Jitsi server will not start a conference until a logged-in '
     'moderator joins, so the recorder cannot get in. A self-hosted Jitsi '
     '(kra_kpi.meet_base_url) does not do this.'),
    ('waiting for a moderator',
     'Waiting for a moderator: this server requires an authenticated host '
     'before the call starts.'),
    ('waiting for the host', 'The server is holding the recorder in a lobby.'),
    ('asking to join', 'The recorder was left in the lobby and never admitted.'),
    ('meeting has not started', 'The server would not start the conference.'),
)


# Set from --domain. The old hard-coded 'jit' only ever matched meet.jit.si
# and 8x8.vc never; on our own meet.alphalize.com it found no frame at all,
# so the prejoin click and the blocker text both silently did nothing.
DOMAIN_HINT = 'jit'


def jitsi_frame(page, domain_hint=None):
    domain_hint = domain_hint or DOMAIN_HINT
    for fr in page.frames:
        url = fr.url or ''
        if url and domain_hint in url and 'localhost' not in url:
            return fr
    return None


def click_prejoin(page):
    """Click through the prejoin screen. -> True once something was clicked.

    The public meet.jit.si IGNORES configOverwrite.prejoinPageEnabled=false
    and shows its 'Join meeting' screen anyway, where the iframe sits for
    ever and no videoConferenceJoined is ever fired. Nothing errors, so
    without this the only symptom is a join that never happens.
    """
    frame = jitsi_frame(page)
    if not frame:
        return False
    for sel in PREJOIN_SELECTORS:
        try:
            el = frame.wait_for_selector(sel, timeout=1500, state='visible')
            if el:
                el.click(timeout=4000)
                _logger.info('clicked the prejoin button (%s)', sel)
                return True
        except Exception:
            continue
    return False


def read_blocker(page):
    """Whatever the Jitsi server is showing instead of the call."""
    frame = jitsi_frame(page)
    if not frame:
        return ''
    try:
        txt = frame.evaluate(
            "() => (document.body && document.body.innerText || '')") or ''
    except Exception:
        return ''
    low = txt.lower()
    for needle, explanation in BLOCKERS:
        if needle in low:
            return explanation
    one_line = ' '.join(txt.split())[:220]
    return ('The Jitsi server did not let the recorder in. It showed: %s'
            % one_line) if one_line else ''


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', required=True)
    ap.add_argument('--token', required=True)
    ap.add_argument('--meeting', required=True)
    ap.add_argument('--alone-seconds', type=int, default=120)
    # Kept so an older Odoo calling with it does not crash; silence no
    # longer makes the recorder leave (it pauses recording instead).
    ap.add_argument('--idle-seconds', type=int, default=0)
    ap.add_argument('--max-seconds', type=int, default=MAX_MEETING_SECONDS)
    ap.add_argument('--log')
    # The Jitsi host the room runs on, e.g. meet.alphalize.com.
    ap.add_argument('--domain', default='')
    args = ap.parse_args(argv)
    global DOMAIN_HINT
    if args.domain:
        DOMAIN_HINT = args.domain

    logging.basicConfig(
        filename=args.log or None, level=logging.INFO,
        format='%(asctime)s %(levelname)s %(message)s')

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        report(args.base, args.token, 'rec_failed',
               {'reason': 'playwright is not installed on this server'})
        return 2

    page_url = '%s/kpi/meet/%s/bot' % (args.base.rstrip('/'), args.token)
    started = time.time()
    outcome = 'stopped'

    try:
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(
                    channel='chrome', headless=True, args=CHROME_ARGS,
                    # THE ONE THAT MATTERS. Without this the recording is
                    # silence and everything else looks fine.
                    ignore_default_args=['--mute-audio'])
            except Exception as exc:
                report(args.base, args.token, 'rec_failed',
                       {'reason': 'Chrome would not start: %s' % exc})
                return 3

            ctx = browser.new_context(permissions=['microphone'])
            page = ctx.new_page()
            page.on('console', lambda m: _logger.info(
                'page console.%s: %s', m.type, m.text[:300])
                if m.type == 'error' else None)

            try:
                page.goto(page_url, wait_until='load', timeout=60000)
            except Exception as exc:
                report(args.base, args.token, 'rec_failed',
                       {'reason': 'recorder page did not load: %s' % exc})
                browser.close()
                return 4

            # Wait to actually be in the room. Capturing before that records
            # an empty room, and the bot might be refused entry.
            deadline = time.time() + JOIN_TIMEOUT
            joined = False
            clicked_prejoin = False
            while time.time() < deadline:
                try:
                    st = page.evaluate('window.kpiStatus && window.kpiStatus()')
                except Exception:
                    st = None
                if st and st.get('joined'):
                    joined = True
                    break
                if st and st.get('error'):
                    report(args.base, args.token, 'rec_failed',
                           {'reason': st['error']})
                    browser.close()
                    return 5
                if not clicked_prejoin:
                    clicked_prejoin = click_prejoin(page)
                page.wait_for_timeout(1000)

            if not joined:
                # Say WHY, in the words the server used. 'Timed out' sends
                # somebody hunting through Chrome flags for a problem that is
                # an account policy.
                reason = read_blocker(page) or (
                    'the recorder could not join the room within %ds'
                    % JOIN_TIMEOUT)
                report(args.base, args.token, 'rec_failed', {'reason': reason})
                _logger.warning('could not join: %s', reason)
                browser.close()
                return 6

            # Start capture from HERE, not from a page event handler.
            try:
                st = page.evaluate('window.kpiStartCapture()')
            except Exception as exc:
                report(args.base, args.token, 'rec_failed',
                       {'reason': 'capture would not start: %s' % exc})
                browser.close()
                return 7
            if st and st.get('error'):
                # The page has already reported the specific kind.
                _logger.warning('capture failed: %s', st['error'])
                browser.close()
                return 8

            _logger.info('meeting %s: recording, source=%r',
                         args.meeting, (st or {}).get('captureLabel'))

            # ---- watch the room ---------------------------------------- #
            alone_since = None
            while True:
                page.wait_for_timeout(POLL_SECONDS * 1000)
                try:
                    st = page.evaluate('window.kpiStatus()')
                except Exception as exc:
                    _logger.warning('lost the page: %s', exc)
                    outcome = 'the recorder page went away'
                    break

                now_ms = time.time() * 1000
                if time.time() - started > args.max_seconds:
                    outcome = 'reached the maximum recording length'
                    break

                # Everybody else has gone.
                if not st.get('peers'):
                    alone_since = alone_since or time.time()
                    if time.time() - alone_since >= args.alone_seconds:
                        outcome = 'everyone else left'
                        break
                else:
                    alone_since = None

                # Silence no longer ends anything here: the page pauses the
                # recording itself and the server's "Continue?" popup decides
                # who stays (kpi_meeting._silence_tick).

                if not st.get('recording'):
                    outcome = 'recording stopped'
                    break

            # ---- wrap up ----------------------------------------------- #
            try:
                page.evaluate('window.kpiStopCapture(%s)'
                              % json.dumps(outcome))
                # Give the last segment a moment to upload before the browser
                # goes away with it.
                page.wait_for_timeout(4000)
                page.evaluate('window.kpiLeave()')
                page.wait_for_timeout(1500)
            except Exception as exc:
                _logger.warning('could not wrap up cleanly: %s', exc)

            report(args.base, args.token, 'bot_left', {'reason': outcome})
            if outcome == 'idle':
                report(args.base, args.token, 'idle', {'reason': outcome})
            browser.close()
    except Exception as exc:
        _logger.exception('recorder died')
        report(args.base, args.token, 'rec_failed',
               {'reason': 'recorder crashed: %s' % exc})
        return 1

    _logger.info('meeting %s: finished (%s) after %.0fs',
                 args.meeting, outcome, time.time() - started)
    return 0


if __name__ == '__main__':
    sys.exit(main())
