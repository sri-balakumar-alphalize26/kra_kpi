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
import io
import logging
import re

from dateutil.relativedelta import relativedelta

from odoo import api, fields, models

_logger = logging.getLogger(__name__)

# Canvas
IMG_W = 980
PAD = 26

# Palette — mirrors AWAY_COLORS in kpi_action.js and WorkdayMapChip in the app.
C_INK = '#0F172A'
C_MUTED = '#64748B'
C_LINE = '#E2E8F0'
C_BG = '#FFFFFF'
C_PANEL = '#F8FAFC'
C_GREEN = '#16A34A'
C_RED = '#DC2626'
C_BLUE = '#1E40AF'
AWAY_COLORS = {
    'break': '#F59E0B', 'lunch': '#10B981', 'meeting': '#3B82F6',
    'away': '#6B7280', 'leave': '#8B5CF6', 'urgent': '#EF4444',
    'no_tasks': '#0891B2', 'other': '#F59E0B',
}
OUTCOME_COLORS = {
    'completed': '#16A34A', 'submitted': '#0D9488', 'paused': '#F59E0B',
    'active': '#3B82F6', 'worked': '#64748B', 'moved': '#F97316',
}

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


def _clean(text):
    """Emoji-free, single-line text safe to hand to Pillow."""
    s = '' if text is None else str(text)
    s = _EMOJI_RE.sub('', s)
    s = s.replace('\r', ' ').replace('\n', ' ')
    return ' '.join(s.split()).strip()


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
    standard_hours = fields.Float(string='Standard Day (h)')
    met_standard = fields.Boolean(string='Met the Standard Day')
    task_count = fields.Integer(string='Tasks Touched')
    generated_at = fields.Datetime(string='Generated At')

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
    def _font(self, size, bold=False):
        from PIL import ImageFont
        for path in (_FONT_BOLD_CANDIDATES if bold else _FONT_CANDIDATES):
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

        # Draw on a generously tall canvas, then crop to what we used. Simpler and
        # safer than trying to pre-compute the height of a variable-length map.
        img = Image.new('RGB', (IMG_W, 4000), C_BG)
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
            ('Presence (wall clock)', p.get('presence_display', '0m'), verdict,
             '%s %s standard' % ('over' if met else 'under', p.get('standard_display', ''))),
            ('Tasks touched', str(p.get('task_count', 0)), C_INK, ''),
        ]
        tw = (IMG_W - PAD * 2 - 2 * 12) / 3.0
        for i, (lbl, val, col, foot) in enumerate(tiles):
            x0 = PAD + i * (tw + 12)
            d.rounded_rectangle([x0, y, x0 + tw, y + 92], radius=10,
                                fill=C_PANEL, outline=C_LINE)
            text((x0 + 14, y + 12), lbl, f_lbl, C_MUTED)
            text((x0 + 14, y + 32), val, f_big, col)
            if foot:
                text((x0 + 14, y + 70), foot, f_small, col)
        y += 92 + 18

        # ---- Away time ----------------------------------------------------
        text((PAD, y), 'Away time  (inside Presence — never Productive)', f_h2, C_INK)
        y += 24
        away = [
            ('Break', p.get('break_display')), ('Lunch', p.get('lunch_display')),
            ('Meeting', p.get('meeting_display')), ('No tasks', p.get('no_tasks_display')),
            ('Other', p.get('other_display')), ('Away (auto)', p.get('away_display')),
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
        text((PAD, y), 'Workday Map  (your day in order)', f_h2, C_INK)
        y += 24
        for n in (p.get('timeline') or []):
            kind = n.get('kind')
            if kind == 'break':
                col = AWAY_COLORS.get(n.get('break_type'), '#F59E0B')
            elif kind == 'task':
                col = OUTCOME_COLORS.get(n.get('outcome'), '#64748B')
            else:
                col = '#94A3B8'
            note = n.get('reason') or ''
            row_h = 40 if not note else 56
            d.rounded_rectangle([PAD, y, IMG_W - PAD, y + row_h], radius=8,
                                fill=C_PANEL, outline=C_LINE)
            # Left colour bar carries the meaning the emoji used to.
            d.rounded_rectangle([PAD, y, PAD + 5, y + row_h], radius=2, fill=col)
            text((PAD + 16, y + 9), ellipsize(n.get('label'), f_bold, 560), f_bold, C_INK)
            when = n.get('time') or ''
            if n.get('duration_display'):
                when = ('%s · %s' % (when, n['duration_display'])).strip(' ·')
            if when:
                text((IMG_W - PAD - 12 - width(when, f_txt), y + 10), when, f_txt, C_MUTED)
            if note:
                text((PAD + 16, y + 32), ellipsize(note, f_small, IMG_W - PAD * 2 - 40),
                     f_small, C_MUTED)
            y += row_h + 6
        y += 14

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
        else:
            text((PAD + 4, y), 'No tasks were worked on this day.', f_txt, C_MUTED)
            y += 22
        y += 6

        if p.get('note'):
            text((PAD, y), 'Note: %s' % ellipsize(p['note'], f_txt, IMG_W - PAD * 2 - 60),
                 f_txt, C_MUTED)
            y += 24

        img = img.crop((0, 0, IMG_W, min(4000, int(y) + PAD)))
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
            'standard_hours': payload.get('standard_hours') or 0.0,
            'met_standard': bool(payload.get('met_standard')),
            'task_count': payload.get('task_count') or 0,
            'generated_at': fields.Datetime.now(),
        }
        rec = self.sudo().search([
            ('user_id', '=', session.user_id.id),
            ('session_date', '=', session.session_date),
        ], limit=1)
        if rec:
            rec.write(vals)
        else:
            rec = self.sudo().create(vals)
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
