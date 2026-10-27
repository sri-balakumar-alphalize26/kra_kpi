# A frozen picture of one developer's day, drawn when they End Workday.
#
# WHY AN IMAGE AND NOT A REPORT: the End Workday summary is computed live and
# thrown away. productive_seconds / presence_seconds are NON-stored computes
# (kpi_work_session.py says so explicitly), and action_end_day stamps only
# logout_at / state / note. So the summary is retroactively mutable — edit a time
# log next week and a day closed today silently reports different numbers; complete
# a task tomorrow and *yesterday's* map re-renders as "Completed". There is no
# record of what the day actually looked like at End Workday. This is that record.
#
# WHY IT IS DRAWN SERVER-SIDE (Pillow) AND NOT SCREENSHOTTED IN A BROWSER:
#   * The midnight cron (_close_overdue) has NO browser — and it fires for exactly
#     the developers who forgot to end their day. A screenshot can never cover them.
#   * The phone app cannot screenshot itself (react-native-view-shot isn't installed).
#   * jsPDF / html2canvas here are CDN-loaded, so client rendering dies offline.
#   * _daily_summary_payload is already presentation-ready (every number has a
#     *_display string, every time is pre-localized).
# One server path covers web + app + cron.

import base64
import calendar
import io
import logging
import re
import time

from dateutil.relativedelta import relativedelta
from psycopg2 import IntegrityError

from odoo import api, fields, models

_logger = logging.getLogger(__name__)

# Canvas
IMG_W = 980
PAD = 26

# Palette for the header, tiles and away strip.
C_INK = '#0F172A'
C_MUTED = '#64748B'
C_LINE = '#E2E8F0'
C_BG = '#FFFFFF'
C_PANEL = '#F8FAFC'
C_GREEN = '#16A34A'
C_RED = '#DC2626'
C_BLUE = '#1E40AF'
# Paused. The same amber the app uses for every paused marker, so the saved
# image and the screen agree; C_MUTED read as disabled text beside two figures
# that carry colour.
C_AMBER = '#B45309'
# The Workday Map's own colours are WT_CATEGORY / WT_PILL below.

# Pillow with a normal TTF draws colour emoji as TOFU BOXES. The timeline keeps
# its icon in a separate key so labels are already clean, but names and typed
# notes are free text and can contain anything. Strip rather than gamble.
_EMOJI_RE = re.compile(
    '[\U0001F000-\U0001FAFF\U00002190-\U000021FF\U00002300-\U000027BF'
    '\U00002B00-\U00002BFF\U0000FE00-\U0000FE0F\U0001F1E6-\U0001F1FF]+',
    flags=re.UNICODE)

# Font candidates, best first. DejaVuSans is NOT present on this box and Pillow
# ships no fonts dir here — verified, not assumed — so Windows UI fonts lead and
# load_default(size=) is the real backstop.
_FONT_CANDIDATES = (
    r'C:\Windows\Fonts\segoeui.ttf',
    r'C:\Windows\Fonts\arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    'DejaVuSans.ttf',
)
_FONT_BOLD_CANDIDATES = (
    r'C:\Windows\Fonts\segoeuib.ttf',
    r'C:\Windows\Fonts\arialbd.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    'DejaVuSans-Bold.ttf',
)
# Notes and idle lines, italic as on screen. Falls back to the regular face.
_FONT_ITALIC_CANDIDATES = (
    r'C:\Windows\Fonts\segoeuii.ttf',
    r'C:\Windows\Fonts\ariali.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf',
    'DejaVuSans-Oblique.ttf',
) + _FONT_CANDIDATES


def _clean(text):
    """Emoji-free, single-line text safe to hand to Pillow."""
    s = '' if text is None else str(text)
    s = _EMOJI_RE.sub('', s)
    s = s.replace('\r', ' ').replace('\n', ' ')
    return ' '.join(s.split()).strip()


# --------------------------------------------------------------------------- #
# Workday Map, worked out once: the to-scale day bar, the cards in time order  #
# and what changed between one card and the next.                             #
#                                                                             #
# A Python copy of buildWorkdayTimeline in utils/workdayTimeline.js (the app)  #
# and static/src/components/kpi_workday_timeline/workday_timeline.js (Odoo     #
# web), so the saved image tells the same story as the End Workday popup.      #
# Change all three together. Times are epoch SECONDS here, not ms.            #
# --------------------------------------------------------------------------- #
WT_IDLE_MIN_MINUTES = 5

# One colour per KIND of time; outcome is a labelled pill, never a colour.
# Insertion order is the legend order.
WT_CATEGORY = {
    'work':     ('Working',  '#2563EB'),
    'break':    ('Break',    '#F59E0B'),
    'lunch':    ('Lunch',    '#EC4899'),
    'meeting':  ('Meeting',  '#8B5CF6'),
    'no_tasks': ('No tasks', '#0891B2'),
    'urgent':   ('Urgent',   '#EF4444'),
    'away':     ('Away',     '#64748B'),
    'idle':     ('Idle',     '#CBD5E1'),
}
WT_BREAK_CATEGORY = {
    'break': 'break', 'lunch': 'lunch', 'meeting': 'meeting', 'no_tasks': 'no_tasks',
    'urgent': 'urgent', 'away': 'away', 'leave': 'away', 'other': 'away',
}
WT_BREAK_TITLE = {
    'break': 'Break', 'lunch': 'Lunch', 'meeting': 'Meeting', 'no_tasks': 'No tasks',
    'urgent': 'Urgent', 'away': 'Away', 'leave': 'Leave', 'other': 'Other',
}
WT_OUTCOME = {
    'active':    ('Working now', 'live'),
    'completed': ('Completed',   'good'),
    'submitted': ('Submitted',   'info'),
    'paused':    ('Paused',      'warn'),
    'moved':     ('Reassigned',  'alert'),
    'worked':    ('Switched',    'muted'),
}
# (background, text) per pill tone — the .wt-pill-* colours in workday_timeline.css.
WT_PILL = {
    'live': ('#DBEAFE', '#1D4ED8'), 'good': ('#DCFCE7', '#15803D'),
    'info': ('#CCFBF1', '#0F766E'), 'warn': ('#FEF3C7', '#B45309'),
    'alert': ('#FFEDD5', '#C2410C'), 'muted': ('#F1F5F9', '#475569'),
}
_WT_TS_RE = re.compile(r'^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})')


def _wt_ts(ts):
    """'YYYY-MM-DD HH:MM:SS' in UTC -> epoch seconds, or None."""
    m = _WT_TS_RE.match(ts or '')
    return calendar.timegm(tuple(int(g) for g in m.groups()) + (0, 0, 0)) if m else None


def _wt_dur(seconds):
    s = max(0, int(round(seconds or 0)))
    if s < 60:
        return '<1m'
    h, m = s // 3600, (s % 3600) // 60
    if not h:
        return '%dm' % m
    return '%dh %dm' % (h, m) if m else '%dh' % h


def _wt_ordinal(n):
    if 11 <= n % 100 <= 13:
        return '%dth' % n
    return '%d%s' % (n, {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th'))


def _wt_offset_minutes(nodes):
    """The developer's UTC offset, read off one node's local `time` against its
    UTC instant — so bar ticks and idle gaps are in the same clock as the cards."""
    for n in nodes:
        ts = _wt_ts(n.get('ts') or n.get('start_ts'))
        hm = re.match(r'^(\d{1,2}):(\d{2})', n.get('time') or '')
        if ts is None or not hm:
            continue
        g = time.gmtime(ts)
        off = int(hm.group(1)) * 60 + int(hm.group(2)) - (g.tm_hour * 60 + g.tm_min)
        if off > 840:
            off -= 1440
        if off < -720:
            off += 1440
        return off
    return 330   # IST, the house default, when no node carries both


def _wt_hm(sec, off):
    return '' if sec is None else time.strftime('%H:%M', time.gmtime(sec + off * 60))


def _wt_card(n, now):
    start = _wt_ts(n.get('start_ts'))
    running = bool(n.get('running'))
    end = now if running else _wt_ts(n.get('end_ts'))
    seconds = n.get('seconds')
    if seconds is None:
        seconds = (end - start) if (start is not None and end is not None) else 0
    if n.get('kind') == 'task':
        label, tone = WT_OUTCOME.get(n.get('outcome'), WT_OUTCOME['worked'])
        visit = n.get('visit') or 1
        return {
            'kind': 'task', 'cat': 'work', 'running': running,
            'title': n.get('name') or n.get('label') or 'Task', 'ref': str(n.get('ref') or ''),
            'task_id': n.get('task_id'),
            'visit_label': ('%s time today' % _wt_ordinal(visit)) if visit > 1 else '',
            'outcome': n.get('outcome') or 'worked', 'outcome_label': label, 'tone': tone,
            'note': (n.get('reason') or '').strip(), 'with': '',
            'start': start, 'end': end, 'seconds': seconds,
        }
    kind = n.get('break_type') or 'other'
    return {
        'kind': 'break', 'cat': WT_BREAK_CATEGORY.get(kind, 'away'), 'running': running,
        'title': WT_BREAK_TITLE.get(kind, 'Other'), 'ref': '', 'task_id': None,
        'visit_label': '', 'outcome': '',
        'outcome_label': 'Now' if running else '', 'tone': 'live' if running else '',
        'note': (n.get('reason') or '').strip(), 'with': (n.get('with') or '').strip(),
        'start': start, 'end': end, 'seconds': seconds,
    }


def _wt_transition(a, b, idle_sec):
    """What happened between two cards, as the short line under the card."""
    if a['kind'] == 'task' and b['kind'] == 'task':
        if a['task_id'] and a['task_id'] == b['task_id']:
            verb = 'Picked %s up again' % b['title']
        elif a['outcome'] in ('completed', 'submitted'):
            verb = 'Finished %s, started %s' % (a['title'], b['title'])
        elif a['outcome'] == 'moved':
            verb = '%s was reassigned; started %s' % (a['title'], b['title'])
        else:
            verb = 'Moved from %s to %s' % (a['title'], b['title'])
    elif a['kind'] == 'task':
        if a['outcome'] == 'paused':
            verb = 'Paused %s for %s' % (a['title'], b['title'].lower())
        elif a['outcome'] == 'completed':
            verb = 'Finished %s, then %s' % (a['title'], b['title'].lower())
        else:
            verb = 'Went on %s' % b['title'].lower()
    elif b['kind'] == 'task':
        if b['task_id'] and b['task_id'] == a.get('resume_task_id'):
            verb = 'Back from %s to %s' % (a['title'].lower(), b['title'])
        else:
            verb = 'After %s, started %s' % (a['title'].lower(), b['title'])
    else:
        # "to", not an arrow: _clean() strips U+2192.
        verb = '%s to %s' % (a['title'], b['title'])
    idle = idle_sec >= WT_IDLE_MIN_MINUTES * 60
    return {'type': 'link', 'idle': idle,
            'short': ('Idle %s · %s' % (_wt_dur(idle_sec), verb)) if idle else verb}


def _wt_build(timeline, now=None):
    """The server's timeline nodes -> {empty, start_label, end_label, live,
    items, strip, ticks, legend}, the same shape the JS builders return."""
    nodes = timeline if isinstance(timeline, list) else []
    now = time.time() if now is None else now
    off = _wt_offset_minutes(nodes)
    start_node = next((n for n in nodes if n.get('kind') == 'start'), None)
    end_node = next((n for n in nodes if n.get('kind') == 'end'), None)
    cards = [_wt_card(n, now) for n in nodes if n.get('kind') in ('task', 'break')]
    cards = sorted((c for c in cards if c['start'] is not None), key=lambda c: c['start'])

    end_ts = _wt_ts(end_node.get('ts')) if end_node else None
    ended = end_ts is not None
    live = not ended and any(c['running'] for c in cards)
    day_start = _wt_ts(start_node.get('ts')) if start_node else None
    if day_start is None and cards:
        day_start = cards[0]['start']
    last_end = max([c['end'] if c['end'] is not None else c['start'] for c in cards]
                   + [day_start or 0])
    day_end = end_ts if ended else max(last_end, now if live else last_end)

    out = {'start_label': _wt_hm(day_start, off) if day_start is not None else '',
           'end_label': _wt_hm(day_end, off) if ended else '', 'live': live,
           'empty': True, 'items': [], 'strip': [], 'ticks': [], 'legend': []}
    if not cards or day_start is None or not day_end > day_start:
        return out

    for prev, cur in zip(cards, cards[1:]):
        if cur['kind'] == 'break' and prev['kind'] == 'task':
            cur['resume_task_id'] = prev['task_id']

    span = float(day_end - day_start)

    def pct(t):
        return min(100.0, max(0.0, (t - day_start) / span * 100.0))

    strip, items, covered = [], [], day_start
    for i, c in enumerate(cards):
        end = c['end'] if c['end'] is not None else c['start']
        gap = c['start'] - covered
        if gap >= WT_IDLE_MIN_MINUTES * 60:
            strip.append({'cat': 'idle', 'left': pct(covered),
                          'width': pct(c['start']) - pct(covered)})
        strip.append({'cat': c['cat'], 'left': pct(c['start']),
                      'width': max(0.6, pct(end) - pct(c['start']))})
        if i:
            items.append(_wt_transition(cards[i - 1], c, max(0, gap)))
        items.append(dict(c, type='card', start_label=_wt_hm(c['start'], off),
                          end_label='' if c['running'] else _wt_hm(end, off),
                          duration_label=_wt_dur(c['seconds'])))
        covered = max(covered, end)

    # Hour marks; every 2h on a long day so they don't crowd.
    step = 2 if span > 10 * 3600 else 1
    t = -(-(day_start + off * 60) // 3600) * 3600   # ceil to the local hour
    ticks = []
    while t - off * 60 <= day_end:
        hour = time.gmtime(t).tm_hour
        if hour % step == 0:
            ticks.append({'pct': pct(t - off * 60), 'label': '%02d' % hour})
        t += 3600

    present = {s['cat'] for s in strip}
    out.update(empty=False, items=items, strip=strip, ticks=ticks,
               legend=[k for k in WT_CATEGORY if k in present])
    return out


class KpiWorkdaySnapshot(models.Model):
    _name = 'kpi.workday.snapshot'
    _description = 'Frozen End-Workday summary image (one per developer per day)'
    _order = 'session_date desc, id desc'

    user_id = fields.Many2one(
        'res.users', string='Developer', required=True, index=True, ondelete='cascade')
    session_date = fields.Date(string='Day', required=True, index=True)

    # attachment=True keeps bytes in the FILESTORE, not a db bytea column — the
    # house rule (see the comment on kpi.user.manual.manual_file). In-DB blobs
    # bloat the database and every backup forever.
    image = fields.Binary(string='Summary Image', attachment=True)
    image_name = fields.Char(string='File Name')

    # STORED on purpose — this is the snapshot. The live computes on
    # kpi.work.session will drift; these must not.
    presence_seconds = fields.Float(string='Presence (s)')
    productive_seconds = fields.Float(string='Productive (s)')
    # THREE eras of `presence_seconds`, and this column is how you tell them
    # apart. Originally presence subtracted paused time; 19.0.2.6 made it the raw
    # login->logout clock with pauses included; it now subtracts again, because
    # Pause Workday is meant to stop the clock.
    #
    # Pre-19.0.2.6 rows cannot be recomputed — the underlying sessions may be
    # gone and paused was never stored — and are deliberately NOT backfilled: an
    # old row reads 0.0 here, so read a zero-paused row as "unknown", not as "the
    # day had no pauses". 19.0.2.6-era rows DO carry paused, so a stored presence
    # from that window is the raw clock and its at-work figure is
    # presence - paused. Nothing is rewritten either way: a snapshot is a record
    # of what was reported on the day, not a view that follows the definition.
    paused_seconds = fields.Float(string='Paused (s)')
    standard_hours = fields.Float(string='Standard Day (h)')
    met_standard = fields.Boolean(string='Met the Standard Day')
    task_count = fields.Integer(string='Tasks Touched')
    # What the developer wrote when they ended the day. Copied from
    # kpi.work.session.note at capture time so the snapshot is a complete record on its
    # own — the session can be reopened and re-ended, and this freezes what was said at
    # the moment the day was closed.
    #
    # Deliberately NOT drawn into the image: that layout is fixed and a dozen lines of
    # prose would either overflow it or shrink to unreadable. It lives on the row, which
    # is also the part that survives the retention cron (only the PNG is cleared).
    note = fields.Text(string='End-of-Day Note')
    # If an admin reopened this day, why. Copied off the session at capture time: the
    # reopen happens between one End Workday and the next, so by the time the day is
    # re-ended the session still carries the reason and this freezes it next to the
    # figures it explains. Without it the day silently shows different numbers from the
    # summary someone already received, with nothing saying a human reopened it.
    reopen_reason = fields.Text(string='Reopened Because', readonly=True)
    reopened_by_id = fields.Many2one('res.users', string='Reopened By', readonly=True)
    reopened_at = fields.Datetime(string='Reopened At', readonly=True)
    generated_at = fields.Datetime(string='Generated At')

    # Set when an admin reopens the day this image was drawn for. The image is
    # kept, not deleted: it is the only record of what the day looked like at
    # End Workday, and notifications already link to it. This flag is what stops
    # it being read as the final word once work resumed. It is cleared again by
    # _capture, so the next close overwrites the row and un-supersedes it.
    superseded = fields.Boolean(
        string='Superseded by a reopened day', default=False, copy=False,
        help='An admin reopened this workday after this summary was frozen, so '
             'the numbers here are no longer the whole day.')

    # ONE image per developer per day. A restart after an accidental End Workday
    # redraws this same row rather than adding a second, so the last redraw is the
    # complete day.
    #
    # models.Constraint, NOT _sql_constraints: Odoo 19 SILENTLY IGNORES the old
    # attribute — no error, no constraint, no clue. A probe caught this (the DB
    # cheerfully took a duplicate). Matches kra.kpi._kpi_approval_token_uniq and
    # Odoo 19 core (res_users._login_key).
    _uniq_user_day = models.Constraint(
        'UNIQUE (user_id, session_date)',
        'A workday snapshot already exists for this developer and day.',
    )

    # ------------------------------------------------------------------ #
    # Fonts                                                              #
    # ------------------------------------------------------------------ #
    @api.model
    def _font(self, size, bold=False, italic=False):
        from PIL import ImageFont
        paths = (_FONT_BOLD_CANDIDATES if bold
                 else _FONT_ITALIC_CANDIDATES if italic else _FONT_CANDIDATES)
        for path in paths:
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
        try:
            return ImageFont.load_default(size=size)
        except Exception:
            # Ancient Pillow: load_default() takes no size. Ugly but never fatal —
            # a missing font must not stop someone ending their day.
            return ImageFont.load_default()

    # ------------------------------------------------------------------ #
    # The renderer                                                       #
    # ------------------------------------------------------------------ #
    @api.model
    def _render_summary_image(self, p):
        """Draw the End Workday summary. Pure function of the payload dict from
        kpi.work.session._daily_summary_payload(full_day=True). Returns PNG bytes."""
        from PIL import Image, ImageDraw

        f_h1 = self._font(26, bold=True)
        f_h2 = self._font(15, bold=True)
        f_big = self._font(30, bold=True)
        f_lbl = self._font(12)
        f_txt = self._font(13)
        f_bold = self._font(13, bold=True)
        f_small = self._font(11)
        f_small_b = self._font(11, bold=True)
        f_ital = self._font(12, italic=True)
        f_title = self._font(14, bold=True)

        # Draw on a generously tall canvas, then crop to what we used. Simpler and
        # safer than trying to pre-compute the height of a variable-length map.
        # 8000, not 4000: a Map card plus its link line is ~100px, so a busy day
        # (30+ switches) ran off the old canvas and was silently cut.
        canvas_h = 8000
        img = Image.new('RGB', (IMG_W, canvas_h), C_BG)
        d = ImageDraw.Draw(img)

        def text(xy, s, font, fill=C_INK):
            d.text(xy, _clean(s), font=font, fill=fill)

        def width(s, font):
            return d.textlength(_clean(s), font=font)

        def ellipsize(s, font, maxw):
            s = _clean(s)
            if width(s, font) <= maxw:
                return s
            while s and width(s + '…', font) > maxw:
                s = s[:-1]
            return (s + '…') if s else ''

        met = bool(p.get('met_standard'))
        verdict = C_GREEN if met else C_RED
        y = PAD

        # ---- Header -------------------------------------------------------
        d.rounded_rectangle([PAD, y, IMG_W - PAD, y + 78], radius=12, fill=C_BLUE)
        text((PAD + 18, y + 14), 'Workday Summary — %s' % p.get('dev', ''), f_h1, '#FFFFFF')
        # login_at/logout_at are full "YYYY-MM-DD HH:MM:SS" strings and the date is
        # already in the line — show clock times only, or it reads the date 3 times.
        # And say "to", not an arrow: U+2192 sits in the range _clean() strips, so
        # an arrow here silently vanishes (it did).
        def _hhmm(s):
            s = _clean(s)
            return s.split(' ')[1][:5] if ' ' in s else s
        sub = '%s   ·   %s to %s' % (
            p.get('session_date', ''),
            _hhmm(p.get('login_at', '')) or '—',
            _hhmm(p.get('logout_at', '')) or 'still working')
        text((PAD + 18, y + 48), sub, f_lbl, '#C7D8F7')
        y += 78 + 16

        # ---- Stat tiles ---------------------------------------------------
        tiles = [
            ('Productive (task time)', p.get('productive_display', '0m'), C_GREEN, ''),
            # Words, not a tick: U+2713 is inside the emoji range _clean() strips,
            # and "over/under" says it plainly anyway. Colour carries it too.
            ('Presence (at work)', p.get('presence_display', '0m'), verdict,
             '%s %s standard' % ('over' if met else 'under', p.get('standard_display', ''))),
            # Everything the day is accounted for by, in one number: task work +
            # meeting + lunch + break + no-tasks (+ away/other) + paused.
            # Accounted plus Other/Idle is exactly the CLOCK -- not Presence, now
            # that the pause sits outside Presence and inside this.
            ('Accounted', p.get('accounted_display', '0m'), C_INK,
             'task+meet+lunch+break+paused'),
            ('Tasks touched', str(p.get('task_count', 0)), C_INK, ''),
        ]
        # Only when the day was actually paused — an always-present "0m Paused"
        # tile would just make every normal day look like it had a gap.
        if (p.get('paused_seconds') or 0) > 0:
            tiles.append(('Workday paused', p.get('paused_display', '0m'), C_AMBER,
                          'outside Presence'))
        # Width derived from the tile COUNT — it was hardcoded to 3, so adding a
        # tile silently drew it off the edge of the image.
        tw = (IMG_W - PAD * 2 - (len(tiles) - 1) * 12) / float(len(tiles))

        def _x0(i):
            return PAD + i * (tw + 12)

        # Presence and Accounted are drawn as ONE box divided by a rule, the same
        # pairing the app popup and the web popup use: Presence is time at work,
        # Accounted is the day explained, and the gap between them IS the pause.
        # Only the OUTLINES change here -- every label keeps the exact x it would
        # have had, so the rest of the row is untouched and nothing reflows.
        #
        # Found by label rather than hardcoded: the list above has grown before
        # (the paused tile), and an index would silently pair the wrong two boxes
        # the next time something is inserted above them.
        pair_i = next((i for i, t in enumerate(tiles)
                       if t[0].startswith('Presence')), -1)
        for i, (lbl, val, col, foot) in enumerate(tiles):
            if i == pair_i:
                d.rounded_rectangle([_x0(i), y, _x0(i + 1) + tw, y + 92], radius=10,
                                    fill=C_PANEL, outline=C_LINE)
                d.line([_x0(i + 1) - 6, y + 10, _x0(i + 1) - 6, y + 82],
                       fill=C_LINE, width=1)
            elif i != pair_i + 1:
                d.rounded_rectangle([_x0(i), y, _x0(i) + tw, y + 92], radius=10,
                                    fill=C_PANEL, outline=C_LINE)
            text((_x0(i) + 14, y + 12), lbl, f_lbl, C_MUTED)
            text((_x0(i) + 14, y + 32), val, f_big, col)
            if foot:
                text((_x0(i) + 14, y + 70), foot, f_small, col)
        y += 92 + 18

        # ---- Away time ----------------------------------------------------
        text((PAD, y), 'Away time  (inside Presence — never Productive)', f_h2, C_INK)
        y += 24
        away = [
            ('Break', p.get('break_display')), ('Lunch', p.get('lunch_display')),
            ('Meeting', p.get('meeting_display')), ('No tasks', p.get('no_tasks_display')),
            ('Other', p.get('other_display')), ('Away (system)', p.get('away_display')),
            ('Other / Idle', p.get('other_idle_display')),
        ]
        aw = (IMG_W - PAD * 2 - 6 * 8) / 7.0
        for i, (lbl, val) in enumerate(away):
            x0 = PAD + i * (aw + 8)
            d.rounded_rectangle([x0, y, x0 + aw, y + 54], radius=8,
                                fill='#FFFBEB', outline='#FDE68A')
            text((x0 + 8, y + 8), lbl, f_small, C_MUTED)
            text((x0 + 8, y + 26), val or '0m', f_bold, C_INK)
        y += 54 + 20

        # ---- Workday Map --------------------------------------------------
        # The End Workday popup's layout (workday_timeline.js / WorkdayTimeline.js):
        # a to-scale bar of the day with hour ticks and a legend, then one card per
        # task or break in time order, joined by a line saying what changed.
        text((PAD, y), 'Workday Map  (your day in order)', f_h2, C_INK)
        y += 26
        wt = _wt_build(p.get('timeline') or [])
        if wt['empty']:
            text((PAD + 4, y), 'No activity recorded on this day.', f_txt, C_MUTED)
            y += 30
        else:
            bar_w, bar_h = IMG_W - PAD * 2, 18
            bar = Image.new('RGB', (bar_w, bar_h), '#EEF2F7')
            bd = ImageDraw.Draw(bar)
            for seg in wt['strip']:
                x0 = int(seg['left'] / 100.0 * bar_w)
                x1 = max(x0 + 1, int((seg['left'] + seg['width']) / 100.0 * bar_w))
                if seg['cat'] == 'idle':
                    # Hatched, as on screen: idle is an absence, not a colour.
                    hatch = Image.new('RGB', (x1 - x0, bar_h), '#E2E8F0')
                    hd = ImageDraw.Draw(hatch)
                    for sx in range(-bar_h, x1 - x0, 8):
                        hd.line([sx, bar_h, sx + bar_h, 0], fill=WT_CATEGORY['idle'][1], width=3)
                    bar.paste(hatch, (x0, 0))
                else:
                    bd.rectangle([x0, 0, x1, bar_h], fill=WT_CATEGORY[seg['cat']][1])
            mask = Image.new('L', (bar_w, bar_h), 0)
            ImageDraw.Draw(mask).rounded_rectangle([0, 0, bar_w - 1, bar_h - 1],
                                                   radius=bar_h // 2, fill=255)
            img.paste(bar, (PAD, int(y)), mask)
            y += bar_h + 3
            for tk in wt['ticks']:
                tx = PAD + tk['pct'] / 100.0 * bar_w - width(tk['label'], f_small) / 2
                text((min(max(PAD, tx), IMG_W - PAD - 14), y), tk['label'], f_small, C_MUTED)
            y += 20
            lx = PAD
            for cat in wt['legend']:
                lbl, col = WT_CATEGORY[cat]
                d.rounded_rectangle([lx, y + 3, lx + 10, y + 13], radius=3, fill=col)
                text((lx + 15, y), lbl, f_small_b, C_MUTED)
                lx += 15 + width(lbl, f_small_b) + 16
            y += 24

            rail_x = PAD + 25                      # centre of the 50px time rail
            card_x0, card_x1 = PAD + 56, IMG_W - PAD
            edge_col = '#1E3A8A'
            text((PAD + 4, y), 'Started %s' % wt['start_label'], f_bold, edge_col)
            y += 24
            # Room kept below the Map for the task list. A day that would need more
            # than the canvas says so instead of being cut off mid-card.
            map_limit = canvas_h - 300 - 26 * len(p.get('tasks') or [])
            for idx, it in enumerate(wt['items']):
                if y > map_limit:
                    rest = sum(1 for x in wt['items'][idx:] if x['type'] == 'card')
                    text((card_x0 + 4, y + 6),
                         '… and %d more entr%s, not shown here' % (rest, 'y' if rest == 1 else 'ies'),
                         f_ital, C_MUTED)
                    y += 30
                    break
                if it['type'] == 'link':
                    h = 26
                    if it['idle']:
                        for dy in range(0, h, 8):
                            d.line([rail_x, y + dy, rail_x, y + min(h, dy + 4)],
                                   fill='#CBD5E1', width=2)
                    else:
                        d.line([rail_x, y, rail_x, y + h], fill=C_LINE, width=2)
                    # A drawn chevron: U+2193 is in the range _clean() strips.
                    cx, cy = card_x0 + 5, y + 13
                    d.polygon([(cx - 4, cy - 3), (cx + 4, cy - 3), (cx, cy + 3)],
                              fill='#94A3B8')
                    f_link = f_ital if it['idle'] else f_small_b
                    text((card_x0 + 16, y + 5),
                         ellipsize(it['short'], f_link, card_x1 - card_x0 - 24),
                         f_link, C_MUTED if it['idle'] else '#475569')
                    y += h
                    continue

                col = WT_CATEGORY[it['cat']][1]
                meta = [m for m in (' · '.join(x for x in (it['ref'], it['visit_label']) if x),
                                    ('with %s' % it['with']) if it['with'] else '') if m]
                h = 54 + 17 * len(meta) + (19 if it['note'] else 0)
                # Rail: start time, a dot in the category colour, a line on down.
                tl = it['start_label']
                text((rail_x - width(tl, f_small_b) / 2, y + 6), tl, f_small_b, C_MUTED)
                if it['running']:
                    d.ellipse([rail_x - 8, y + 21, rail_x + 8, y + 37], fill='#BFDBFE')
                d.ellipse([rail_x - 5, y + 24, rail_x + 5, y + 34], fill=col)
                d.line([rail_x, y + 37, rail_x, y + h + 6], fill=C_LINE, width=2)
                # Card, with the category colour down its left edge.
                d.rounded_rectangle([card_x0, y + 3, card_x1, y + h], radius=10, fill=col)
                d.rounded_rectangle([card_x0 + 4, y + 3, card_x1, y + h], radius=9,
                                    fill='#FFFFFF', outline=C_LINE)
                pill_w = 0
                if it['outcome_label']:
                    bg, fg = WT_PILL.get(it['tone'], WT_PILL['muted'])
                    pw = width(it['outcome_label'], f_small_b) + 14
                    px1 = card_x1 - 10
                    d.rounded_rectangle([px1 - pw, y + 11, px1, y + 29], radius=6, fill=bg)
                    text((px1 - pw + 7, y + 12), it['outcome_label'], f_small_b, fg)
                    pill_w = pw + 12
                tx = card_x0 + 16
                text((tx, y + 9), ellipsize(it['title'], f_title,
                                            card_x1 - tx - 12 - pill_w), f_title, C_INK)
                # En dash, not an arrow: U+2192 would be stripped by _clean().
                span_txt = '%s – %s' % (it['start_label'], 'now' if it['running']
                                        else it['end_label'])
                text((tx, y + 31), span_txt, f_bold, C_INK)
                # Gap by offset: text() runs _clean(), which squashes repeated spaces.
                text((tx + width(span_txt, f_bold) + 6, y + 31),
                     '· %s' % it['duration_label'], f_txt, C_MUTED)
                ly = y + 52
                for m in meta:
                    text((tx, ly), ellipsize(m, f_small, card_x1 - tx - 14), f_small, C_MUTED)
                    ly += 17
                if it['note']:
                    text((tx, ly), ellipsize('“%s”' % it['note'], f_ital, card_x1 - tx - 14),
                         f_ital, '#374151')
                y += h + 3

            if wt['live']:
                end_txt, end_col = 'Still working', '#1D4ED8'
            elif wt['end_label']:
                end_txt, end_col = 'Ended %s' % wt['end_label'], edge_col
            else:
                end_txt, end_col = 'Not ended yet', edge_col
            text((PAD + 4, y + 6), end_txt, f_bold, end_col)
            y += 34
        y += 6

        # ---- Tasks --------------------------------------------------------
        tasks = p.get('tasks') or []
        text((PAD, y), 'Tasks worked today (%d)' % len(tasks), f_h2, C_INK)
        y += 24
        if tasks:
            d.line([PAD, y, IMG_W - PAD, y], fill=C_LINE, width=1)
            y += 8
            for t in tasks:
                ref = str(t.get('ref') or '')
                text((PAD + 4, y), ref, f_txt, C_MUTED)
                name = ellipsize(t.get('name'), f_txt, IMG_W - PAD * 2 - 240)
                if t.get('concurrent'):
                    name = '* ' + name    # multi-tasked; '⚡' would be tofu
                text((PAD + 90, y), name, f_txt, C_INK)
                dur = t.get('duration_display') or ''
                text((IMG_W - PAD - 4 - width(dur, f_bold), y), dur, f_bold, C_INK)
                y += 22
                # Only worth a second line when the task was BOTH: time on its own
                # and time shared with another task. A wholly-shared task already
                # says so with the '*'.
                if t.get('concurrent') and (t.get('solo_seconds') or 0) > 0:
                    split = '%s alone + %s shared' % (t.get('solo_display') or '',
                                                      t.get('shared_display') or '')
                    text((PAD + 90, y), split, f_txt, C_MUTED)
                    y += 18
        else:
            text((PAD + 4, y), 'No tasks were worked on this day.', f_txt, C_MUTED)
            y += 22
        y += 6

        # The note keeps the user's lines (End Workday summaries are multi-line):
        # "*Task*" headings in bold, each summary line under it, a long line
        # wrapped to at most 3 rows. _clean() flattens newlines, so split first.
        note = (p.get('note') or '').replace('\r\n', '\n').strip()
        if note:
            def wrap(s, font, maxw, rows=3):
                words, out, cur = _clean(s).split(' '), [], ''
                for w in words:
                    nxt = (cur + ' ' + w) if cur else w
                    if cur and width(nxt, font) > maxw:
                        out.append(cur)
                        cur = w
                    else:
                        cur = nxt
                if cur:
                    out.append(cur)
                if len(out) > rows:
                    out = out[:rows - 1] + [' '.join(out[rows - 1:])]
                return [ellipsize(x, font, maxw) for x in out]

            text((PAD, y), 'Note', f_bold, C_INK)
            y += 20
            maxw = IMG_W - PAD * 2 - 24
            for raw in note.split('\n')[:80]:
                ln = raw.strip()
                if not ln:
                    y += 8
                    continue
                if len(ln) > 2 and ln.startswith('*') and ln.endswith('*'):
                    text((PAD + 4, y), ellipsize(ln[1:-1], f_bold, maxw), f_bold, C_INK)
                    y += 19
                    continue
                for row in wrap(ln, f_txt, maxw - 14):
                    text((PAD + 18, y), row, f_txt, C_MUTED)
                    y += 18
            y += 8

        img = img.crop((0, 0, IMG_W, min(canvas_h, int(y) + PAD)))
        buf = io.BytesIO()
        img.save(buf, format='PNG', optimize=True)
        return buf.getvalue()

    # ------------------------------------------------------------------ #
    # Save                                                               #
    # ------------------------------------------------------------------ #
    @api.model
    def _capture(self, session, payload):
        """Draw + store the day's image. ONE row per (developer, day): a restart
        after an accidental End Workday redraws this row rather than adding a
        second, so the last redraw is the complete day.

        Returns the snapshot record, or an empty recordset on failure — the
        caller must never let a drawing bug block someone ending their day.
        """
        try:
            png = self._render_summary_image(payload)
        except Exception as exc:
            _logger.exception("workday snapshot render failed for %s: %s",
                              session.user_id.login, exc)
            return self.browse()

        vals = {
            'user_id': session.user_id.id,
            'session_date': session.session_date,
            'image': base64.b64encode(png),
            'image_name': 'workday-%s-%s.png' % (
                session.user_id.login or session.user_id.id, session.session_date),
            'presence_seconds': payload.get('presence_seconds') or 0.0,
            'productive_seconds': payload.get('productive_seconds') or 0.0,
            'paused_seconds': payload.get('paused_seconds') or 0.0,
            'standard_hours': payload.get('standard_hours') or 0.0,
            'met_standard': bool(payload.get('met_standard')),
            'task_count': payload.get('task_count') or 0,
            # Straight off the session — action_end_day() writes the note before it
            # captures, so this is the note just submitted. `or False` keeps an empty
            # note out of the column rather than storing ''.
            'note': (session.note or '').strip() or False,
            # Carried across a reopen: session.reverted stays set after the admin's
            # revert, so a re-ended day explains itself.
            'reopen_reason': (session.revert_reason or '').strip() or False,
            'reopened_by_id': session.reverted_by_id.id if session.reverted_by_id else False,
            'reopened_at': session.reverted_at or False,
            'generated_at': fields.Datetime.now(),
            # A redraw is a complete, current picture of the day, so it clears
            # any supersede left by an earlier reopen. Without this, a day that
            # was reopened and then properly re-ended would keep warning that
            # its summary is stale when it is the freshest thing there is.
            'superseded': False,
        }
        Snap = self.sudo()
        dom = [
            ('user_id', '=', session.user_id.id),
            ('session_date', '=', session.session_date),
        ]
        rec = Snap.search(dom, limit=1)
        if rec:
            rec.write(vals)
        else:
            # SAVEPOINT around the INSERT, because search-then-create is
            # check-then-act against UNIQUE (user_id, session_date) and it loses:
            # the 5-minute midnight cron and the daily one BOTH call
            # _close_overdue(), so two workers can search (finding nothing) and
            # then create the same day.
            #
            # Without the savepoint the duplicate aborted the whole TRANSACTION.
            # The caller's try/except swallowed the Python exception, but the
            # cursor was already dead, so every later statement in that cron run
            # failed with "current transaction is aborted" — losing the snapshot,
            # the daily summary, AND every session still to be closed in that run.
            # Observed on 2026-07-19 (session 180). The savepoint scopes the
            # failure to this one INSERT and leaves the transaction usable.
            try:
                with self.env.cr.savepoint():
                    rec = Snap.create(vals)
            except IntegrityError:
                # The other writer won. Same developer, same day — so write ours
                # over theirs and keep the rule that the last redraw wins.
                rec = Snap.search(dom, limit=1)
                if not rec:
                    raise
                rec.write(vals)
        _logger.info("workday snapshot saved: %s %s (%s bytes)",
                     session.user_id.login, session.session_date, len(png))
        return rec

    # ------------------------------------------------------------------ #
    # Retention — daily cron clears old images                           #
    # ------------------------------------------------------------------ #
    @api.model
    def _gc_snapshot_images(self):
        """Clear snapshot PNGs older than the company's configured retention.

        Only the image (a filestore attachment) is dropped — the lightweight
        stats row (date / presence / productive / tasks / met_standard) is kept
        so historical numbers survive. Writing False to the attachment=True
        Binary deletes the underlying ir.attachment file.

        Retention comes from res.company.kpi_snapshot_retention_number/_unit;
        number <= 0 means keep forever (no-op). Called by the daily cron in
        data/kpi_snapshot_cleanup_cron.xml — mirrors kpi.notification._gc_notifications.
        """
        company = self.env.company
        number = company.kpi_snapshot_retention_number or 0
        if number <= 0:
            return 0
        unit = company.kpi_snapshot_retention_unit or 'months'
        cutoff = fields.Date.context_today(self) - relativedelta(**{unit: number})
        old = self.sudo().search([
            ('session_date', '<', cutoff),
            ('image', '!=', False),
        ])
        count = len(old)
        if old:
            old.write({'image': False, 'image_name': False})
        _logger.info("snapshot image GC: cleared %s image(s) older than %s (%s %s)",
                     count, cutoff, number, unit)
        return count
