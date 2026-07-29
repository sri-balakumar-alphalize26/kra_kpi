"""kpi.work.session — one row per (developer, day) tracking login/logout.

The session is a thin wrapper around the existing `kpi.time.log` rows:
  * `productive_seconds` = SUM(duration_seconds) of the developer's time-logs
    whose work_date matches this session_date.
  * `presence_seconds`   = wall-clock = (logout_at or now) - login_at.

So we do NOT duplicate time-tracking data; we just record the day boundaries
+ a state flag so we know if the session is still open (developer logged in)
or closed (explicit End Workday or cron auto-closed).

Driven by:
  * `/kpi_workday/ping`   - OWL onMounted on the KPI Action Board.
  * `/kpi_workday/end`    - OWL End Workday button.
  * `_cron_auto_close_sessions()` - safety net at 23:55 each day.
"""

import logging
from datetime import datetime, time, timedelta

import pytz

from odoo import api, fields, models

# Safe: kpi_nontask_block imports nothing from here, so there is no cycle. Shared
# so the session's open-block note and the saved block row can't disagree on the
# limit.
from .kpi_nontask_block import (NOTE_MAX as NONTASK_NOTE_MAX, NONTASK_REASONS,
                                NONTASK_REASON_CODES)

_logger = logging.getLogger(__name__)

# How long after login (or after the last prompt) we check that SOMETHING is in
# progress. The developer is asked, not the admin — a quiet 10 minutes is usually
# a meeting, and telling admins about it would cry wolf.
IDLE_CHECK_MIN = 10
# Stop asking after this many prompts, so a developer who never answers isn't
# nagged forever.
IDLE_CHECK_MAX = 3
# Once admins ARE told a developer has no tasks, repeat this often while the
# notification stays UNREAD; reading it stops the repeats (same rule as the
# Client Task Queue nudge).
NO_TASK_NUDGE_MIN = 15
NO_TASK_NUDGE_MAX = 5


# --------------------------------------------------------------------------- #
# Interval arithmetic — the basis of every multi-task number                   #
# --------------------------------------------------------------------------- #
# A developer with kpi_allow_multitask can have two timers running at once, so
# their kpi.time.log rows OVERLAP. Summing durations then answers the wrong
# question twice over: it reports 4h of work for 2h of two concurrent tasks, and
# it cannot tell a task's genuinely solo time apart from time it shared with
# another task. Both are answered by measuring intervals rather than adding
# durations, so the arithmetic lives here, once, in pure functions.

def _merge_intervals(intervals):
    """Sort and coalesce (start, end) pairs into non-overlapping spans.

    Touching spans (a.end == b.start) are merged too: back-to-back work is one
    continuous stretch, not two.
    """
    clean = sorted((s, e) for (s, e) in intervals if s and e and e > s)
    merged = []
    for start, end in clean:
        if merged and start <= merged[-1][1]:
            if end > merged[-1][1]:
                merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    return merged


def _measure(intervals):
    """Total seconds COVERED by intervals — overlapping time counted once."""
    return sum((e - s).total_seconds() for (s, e) in _merge_intervals(intervals))


def _intersect_seconds(intervals, others):
    """Seconds of `intervals` that also fall inside `others`.

    Both sides are merged first, so a task overlapping three others for the same
    hour is credited with one shared hour, not three.
    """
    a = _merge_intervals(intervals)
    b = _merge_intervals(others)
    if not a or not b:
        return 0.0
    total = 0.0
    i = j = 0
    while i < len(a) and j < len(b):
        lo = max(a[i][0], b[j][0])
        hi = min(a[i][1], b[j][1])
        if hi > lo:
            total += (hi - lo).total_seconds()
        # Advance whichever span ends first — neither can overlap anything later
        # in the other list once it is behind.
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return total


def _to_user_tz_str(dt, user, fmt='%Y-%m-%d %H:%M:%S'):
    """Convert a UTC datetime to the user's timezone for display.
    Odoo stores datetimes naive-UTC; we localize then convert.
    Defaults to Asia/Kolkata (IST) if the user has no tz set.
    """
    if not dt:
        return ''
    try:
        tz_name = (user.tz if user else None) or 'Asia/Kolkata'
        if dt.tzinfo is None:
            utc_dt = pytz.UTC.localize(dt)
        else:
            utc_dt = dt
        local = utc_dt.astimezone(pytz.timezone(tz_name))
        return local.strftime(fmt)
    except Exception as exc:
        _logger.warning("tz conversion failed (%s) — falling back to naive str: %s", exc, dt)
        return fields.Datetime.to_string(dt)


def _local_day_start_utc(day, user=None):
    """The naive-UTC instant at which `day` BEGINS in the user's timezone.

    Same correction as _local_day_end_utc, for the other edge. Used to ask "did
    this start before today?" — with a naive midnight that question was really
    "before 05:30 IST today", so anything a developer started in the small hours
    counted as yesterday's leftover and was force-closed out from under them.
    """
    try:
        tz_name = (user.tz if user else None) or 'Asia/Kolkata'
        local = pytz.timezone(tz_name).localize(datetime.combine(day, time(0, 0)))
        return local.astimezone(pytz.UTC).replace(tzinfo=None)
    except Exception as exc:
        _logger.warning("day-start tz conversion failed (%s) for %s — using naive UTC", exc, day)
        return datetime.combine(day, time(0, 0))


def _local_day_end_utc(day, user=None):
    """The naive-UTC instant at which `day` ENDS in the user's timezone.

    `day` is a LOCAL date — session_date comes from fields.Date.context_today(),
    which is the developer's calendar day, not UTC's.

    The obvious spelling, datetime.combine(day, time(23, 59, 59)), builds a naive
    datetime that Odoo then stores as UTC. For IST (+5:30) that instant is 05:29
    the FOLLOWING morning local time, so every "cap this at the end of its day"
    was capping 5h30m too late: an auto-closed cross-midnight workday had its
    presence inflated by the whole offset, and a time log left running overnight
    gained the same. It fed met_standard, the daily summary and the frozen
    snapshot image.

    Falls back to the naive combine only if tz handling itself fails — a wrong
    cap is still better than no cap.
    """
    try:
        tz_name = (user.tz if user else None) or 'Asia/Kolkata'
        local = pytz.timezone(tz_name).localize(
            datetime.combine(day, time(23, 59, 59)))
        return local.astimezone(pytz.UTC).replace(tzinfo=None)
    except Exception as exc:
        _logger.warning("day-end tz conversion failed (%s) for %s — using naive UTC", exc, day)
        return datetime.combine(day, time(23, 59, 59))


def _fmt_hms(seconds):
    """Format an integer number of seconds as 'Hh Mm'."""
    s = int(seconds or 0)
    h, rem = divmod(s, 3600)
    m = rem // 60
    if h and m:
        return f"{h}h {m}m"
    if h:
        return f"{h}h"
    return f"{m}m"


class KpiWorkSession(models.Model):
    _name = 'kpi.work.session'
    _description = 'Developer Workday Session'
    _order = 'session_date desc, login_at desc'

    user_id = fields.Many2one(
        'res.users', string='Developer',
        required=True, index=True, ondelete='cascade',
    )
    session_date = fields.Date(
        string='Date', required=True, index=True,
        default=fields.Date.today,
    )
    login_at = fields.Datetime(
        string='Login At', required=True,
        default=fields.Datetime.now,
    )
    logout_at = fields.Datetime(string='Logout At', readonly=True)
    state = fields.Selection(
        [('open', 'Open'), ('closed', 'Closed')],
        default='open', required=True, index=True,
    )
    auto_closed = fields.Boolean(
        string='Auto-closed by cron',
        default=False, readonly=True,
        help='True when the 23:55 cron closed this session because the developer never pressed End Workday.',
    )
    note = fields.Text(string='End-of-day note')

    # The board POSTs a heartbeat every 15s. It is now purely a liveness stamp
    # for reporting — the admin Live Tracking screen shows a developer as "at the
    # desk" while it is fresh. It no longer pauses tasks or ends workdays.
    last_heartbeat = fields.Datetime(string='Last Heartbeat', index=True)
    # RETIRED, kept only so the column survives without a migration. Nothing
    # writes it. It used to be stamped when the board tab closed, which un-paired
    # the device and paused the running task a few seconds later.
    leaving_at = fields.Datetime(
        string='Board Leaving At (unused)', readonly=True,
        help="Unused. Left in place so removing it does not require a migration.")
    awayed_task_id = fields.Many2one(
        'kra.kpi', string='Auto-awayed Task', readonly=True, ondelete='set null',
        help='Set by the auto-away cron to the task it paused; cleared once the board '
             'has told the developer (so it can offer a one-click Resume).',
    )

    # ── Idle check: workday open but nothing in progress ─────────────────────
    # The developer is asked BEFORE any admin is told — a 10-minute silence is
    # usually a meeting, and crying wolf to admins is how a notification feed
    # stops being read. Only "I have no tasks" reaches them.
    # Same shape as the queue nudge (frequent cron + per-record due timestamp);
    # see _cron_check_idle_developers.
    idle_check_at = fields.Datetime(
        string='Idle Check At', index=True, copy=False,
        help='When to check that a task is in progress. Armed at login (+10 min) and '
             'cleared the moment any task starts.',
    )
    idle_check_count = fields.Integer(
        string='Idle Prompts Sent', default=0, copy=False,
        help='How many times the developer has been asked why nothing is running. '
             'Capped so it can never nag forever.',
    )

    # ── Non-task block (Meeting / Break) ─────────────────────────────────────
    # A developer can only give a reason by PAUSING a running task — with no task
    # started there is nothing to pause, so meeting time was invisible and looked
    # identical to sitting idle. This records it.
    # It shows in the Workday Map and in presence, and NEVER in task time:
    # a meeting is not work on a task, and counting it would corrupt
    # actual-vs-estimate, the completion certificate and anything billable.
    nontask_reason = fields.Selection(
        NONTASK_REASONS, string='Non-task Reason', copy=False,
        help='Set while the developer is in a meeting / on a break / has no tasks, '
             'with no task running. Mirrors kpi.nontask.block.reason — keep the two '
             'selections in step.',
    )
    nontask_note = fields.Char(
        string='Non-task Note', size=NONTASK_NOTE_MAX, copy=False,
        help='Optional free text for the OPEN block. Copied onto kpi.nontask.block '
             'when the block closes; shown under it on the Workday Map.',
    )
    nontask_started_at = fields.Datetime(
        string='Non-task Started At', copy=False,
        help='Open block start. Closed when a task starts (at that same instant, so the '
             'block and the task never overlap), when End is tapped, or at End Workday.',
    )

    # ── "No tasks" nudge to admins: repeat while UNREAD, stop once read ──────
    # Mirrors the Client Task Queue nudge (kra.kpi.queue_nudge_next_at) —
    # "seen" == an admin read the in-app notification.
    no_task_nudge_at = fields.Datetime(
        string='No-task Nudge At', index=True, copy=False,
        help='When to re-tell the admins this developer has no tasks. Cleared once any '
             'admin reads the notification, or the developer starts a task.',
    )
    no_task_nudge_count = fields.Integer(
        string='No-task Nudges Sent', default=0, copy=False,
    )
    # The exact notification rows the last nudge created. Needed because
    # kpi.notification has no link back to a session or to the developer it is
    # ABOUT (only to its recipient) — so with two idle developers, "is the
    # no-task notification read?" would be unanswerable from the event name
    # alone. Holding the ids makes the read-check exact.
    no_task_notif_ids = fields.Many2many(
        'kpi.notification', 'kpi_session_no_task_notif_rel', 'session_id', 'notif_id',
        string='No-task Notifications', copy=False,
    )

    # NOT stored: time-log changes don't propagate through @api.depends so a
    # stored value would freeze at the value at session-creation time.  Read
    # cost is trivial (one search per row), and reports do their own SQL.
    productive_seconds = fields.Float(
        string='Productive (task time)',
        compute='_compute_totals',
    )
    presence_seconds = fields.Float(
        string='Presence (wall clock)',
        compute='_compute_totals',
    )
    task_count = fields.Integer(
        string='Tasks Touched',
        compute='_compute_totals',
    )

    # Multiple sessions per day are explicitly allowed so a developer can
    # restart a workday after an accidental End Workday.  The only invariant
    # we still enforce (at the application level, in _get_or_open_today) is
    # at most ONE 'open' session per user per day.

    # ------------------------------------------------------------------ #
    # Compute                                                            #
    # ------------------------------------------------------------------ #
    @api.depends('user_id', 'session_date', 'login_at', 'logout_at', 'state')
    def _compute_totals(self):
        """Per-session totals: only count time-logs whose start_time falls
        inside this session's login_at..logout_at window.  This way two
        sessions on the same day don't double-count the same logs.
        """
        Log = self.env['kpi.time.log'].sudo()
        for rec in self:
            if not rec.user_id or not rec.login_at:
                rec.productive_seconds = 0.0
                rec.presence_seconds = 0.0
                rec.task_count = 0
                continue
            domain = [
                ('user_id',   '=', rec.user_id.id),
                ('is_active', '=', False),
                ('start_time', '>=', rec.login_at),
            ]
            if rec.logout_at:
                domain.append(('start_time', '<', rec.logout_at))
            logs = Log.search(domain)
            # Wall-clock covered by task work, NOT the sum of task durations.
            # A multitasking developer's logs overlap, and summing them reported
            # 4h productive for 2h of two concurrent tasks — more productive time
            # than there was presence to hold it, which then made the other_idle
            # residual (max(0, presence - productive - metered)) floor to zero and
            # hide the contradiction instead of showing it.
            rec.productive_seconds = _measure(
                [(l.start_time, l.end_time) for l in logs])
            rec.task_count = len(set(logs.mapped('kpi_id').ids))
            end = rec.logout_at or fields.Datetime.now()
            try:
                rec.presence_seconds = max(0.0, (end - rec.login_at).total_seconds())
            except Exception:
                rec.presence_seconds = 0.0

    # ------------------------------------------------------------------ #
    # One start + one end per day                                        #
    # ------------------------------------------------------------------ #
    @api.model
    def _ended_session_today(self, user=None):
        """The session the developer EXPLICITLY ended today, if any — i.e. a
        closed session (auto_closed=False) for today with NO open session left.

        This is what enforces "one start + one end per day": once returned, the
        day is done and must not be re-opened until local midnight. Auto-closed
        sessions (idle / cross-midnight cron, auto_closed=True) are deliberately
        EXCLUDED — a developer who was auto-ended can still restart the same day.
        Returns the closed record (truthy) or an empty recordset.
        """
        user = user or self.env.user
        today = fields.Date.context_today(self)
        Session = self.sudo()
        has_open = Session.search_count([
            ('user_id',      '=', user.id),
            ('session_date', '=', today),
            ('state',        '=', 'open'),
        ])
        if has_open:
            return Session.browse()          # still working → not done
        return Session.search([
            ('user_id',      '=', user.id),
            ('session_date', '=', today),
            ('state',        '=', 'closed'),
            ('auto_closed',  '=', False),
        ], limit=1)

    @api.model
    def _day_done(self, user=None):
        """Boolean form of _ended_session_today — did the developer end their
        own workday today (and so may not start another until tomorrow)?"""
        return bool(self._ended_session_today(user=user))

    # ------------------------------------------------------------------ #
    # Open / fetch today's session — idempotent                          #
    # ------------------------------------------------------------------ #
    @api.model
    def _get_or_open_today(self, user=None):
        """Return the currently OPEN session for (user, today), or create one.

        Multiple sessions per day are allowed (so a developer can restart their
        workday after an *auto*-close), with ONE invariant: at most one 'open'
        session per user per day.  BUT if the developer EXPLICITLY ended today
        (End Workday), the day is done — return that closed session and do NOT
        open a new one (one start + one end per day). Callers that open the
        workday must treat a returned state=='closed' as "refuse to start".
        Closed sessions from earlier today are left intact and their time still
        counts in the day-wide summary.
        """
        user = user or self.env.user
        today = fields.Date.context_today(self)
        # Already have an open session today? Return it (idempotent).
        existing_open = self.sudo().search([
            ('user_id',      '=', user.id),
            ('session_date', '=', today),
            ('state',        '=', 'open'),
        ], limit=1)
        if existing_open:
            return existing_open
        # One start + one end per day: developer already ended today themselves →
        # hand back the closed session instead of opening a fresh one. This is the
        # single choke point every re-open path funnels through (ping, verify,
        # today_summary), so the rule can't be bypassed by any one caller.
        ended_today = self._ended_session_today(user=user)
        if ended_today:
            return ended_today
        # Take a row-exclusive lock to dodge double-create on parallel tab loads.
        self.env.cr.execute("LOCK TABLE kpi_work_session IN ROW EXCLUSIVE MODE")
        existing_open = self.sudo().search([
            ('user_id',      '=', user.id),
            ('session_date', '=', today),
            ('state',        '=', 'open'),
        ], limit=1)
        if existing_open:
            return existing_open
        # Self-heal before opening today's session: a workday that crossed midnight
        # without a clean close can leave an is_active time-log or break-log from a
        # PREVIOUS day. Left open it reads as this developer's "current" task/break
        # forever — and silences the idle "what are you doing?" prompt exactly when
        # it should fire. Close any such cross-day leftovers, capped at their own
        # day-end so durations stay sane.
        try:
            for lg in self.env['kpi.time.log'].sudo().search([
                    ('user_id', '=', user.id), ('is_active', '=', True), ('work_date', '<', today)]):
                lg.write({'is_active': False,
                          'end_time': _local_day_end_utc(lg.work_date, user)})
            for bk in self.env['kpi.break.log'].sudo().search([
                    ('user_id', '=', user.id), ('is_active', '=', True),
                    ('start_time', '<', _local_day_start_utc(today, user))]):
                bk.write({'is_active': False,
                          'end_time': _local_day_end_utc(bk.work_date or bk.start_time.date(), user)})
        except Exception as exc:
            _logger.warning("_get_or_open_today heal stale-active failed for %s: %s", user.id, exc)
        new_sess = self.sudo().create({
            'user_id':      user.id,
            'session_date': today,
            'login_at':     fields.Datetime.now(),
            'state':        'open',
            'last_heartbeat': fields.Datetime.now(),
            # Arm the idle check. If a task is running by then the cron just clears
            # it; if not, the DEVELOPER gets asked why (never the admin first).
            'idle_check_at': fields.Datetime.now() + timedelta(minutes=IDLE_CHECK_MIN),
        })
        # Tell owner + coordinator the workday started (attendance only) — but
        # ONLY on the first start of the day. Multiple sessions per day are
        # allowed (restart after an accidental End Workday), and re-announcing
        # attendance each time is noise: it says nothing new, and a feed that
        # repeats itself is a feed that stops being read. Counts closed sessions
        # too, so an end-then-restart stays silent.
        prior_today = self.sudo().search_count([
            ('user_id',      '=', user.id),
            ('session_date', '=', today),
            ('id',           '!=', new_sess.id),
        ])
        if prior_today:
            _logger.info(
                "workday_started: session %s is start #%s today for %s — not "
                "re-notifying admins", new_sess.id, prior_today + 1, user.login)
        else:
            try:
                new_sess._fire_workday_started()
            except Exception as exc:
                _logger.warning("workday_started notification failed: %s", exc)
        return new_sess

    def _fire_workday_started(self):
        """Tell owner + coordinator that this developer started their workday."""
        self.ensure_one()
        u = self.user_id
        ctx = {
            'dev':          u.name or u.login or '—',
            'session_date': str(self.session_date),
            'login_at':     _to_user_tz_str(self.login_at, u),
        }
        Kpi = self.env['kra.kpi'].sudo()
        any_kpi = Kpi.search([('user_id', '=', self.user_id.id)],
                             order='id desc', limit=1) \
                  or Kpi.search([], order='id desc', limit=1)
        if not any_kpi:
            _logger.info("workday_started: no kra.kpi to anchor _notify on")
            return
        any_kpi._notify('workday_started', **ctx)
        try:
            any_kpi._log_action(
                'workday_started_sent',
                source='web',
                actor_user_id=self.user_id.id,
                payload={'session_id': self.id,
                         'login_at': ctx['login_at']},
            )
        except Exception:
            pass

    # ------------------------------------------------------------------ #
    # 🆕 Part C: heartbeat + live status + auto-away                      #
    # ------------------------------------------------------------------ #
    @api.model
    def touch_heartbeat(self, user=None):
        """Bump today's open session heartbeat.

        The heartbeat is now only a liveness stamp for reporting (the admin Live
        Tracking screen reads its freshness). It no longer decides anything: with
        auto-pause off nothing pauses a task for a stale heartbeat, and with the
        PIN gone there is no pairing state to report back.

        `was_away` is still answered because sessions paused by the old auto-away
        cron may still carry awayed_task_id, and the board's one-click Resume
        nudge should keep working for them.

        Does NOT open a session — a heartbeat must never auto-start a workday
        (that only happens on the explicit Start Workday button)."""
        user = user or self.env.user
        sess = self.sudo().search([
            ('user_id', '=', user.id),
            ('session_date', '=', fields.Date.context_today(self)),
            ('state', '=', 'open'),
        ], limit=1)
        if not sess:
            return {'status': True, 'was_away': False, 'no_session': True}
        was_away = bool(sess.awayed_task_id)
        awayed_id = sess.awayed_task_id.id if was_away else False
        awayed_name = sess.awayed_task_id.name if was_away else ''
        vals = {'last_heartbeat': fields.Datetime.now()}
        if was_away:
            vals['awayed_task_id'] = False
        sess.sudo().write(vals)
        # `paired` is reported as True for any older client still checking it.
        return {'status': True, 'was_away': was_away, 'paired': True,
                'awayed_task_id': awayed_id, 'awayed_task_name': awayed_name}

    @api.model
    def live_status(self, user=None):
        """Data for the live activity strip: the running task, the active break
        (with source task + start clock), and the day's presence/productive anchors.
        Datetime anchors are raw Odoo strings so the client ticks them the same way
        getDisplayTime() ticks a running task."""
        user = user or self.env.user
        Log = self.env['kpi.time.log'].sudo()
        Break = self.env['kpi.break.log'].sudo()

        def _task_payload(t):
            return {
                'id': t.id,
                'name': t.name or '',
                # Same ISO+Z serialization the tasks payload uses so the client
                # ticks it identically to getDisplayTime (UTC-safe).
                'timer_start': (t.timer_start_datetime.isoformat() + 'Z') if t.timer_start_datetime else False,
                'timer_total_seconds': t.timer_total_seconds or 0.0,
                'task_state': t.task_state or '',
            }

        # A multitasking developer can have more than one timer running, so ship
        # them all. `active_task` stays the first one for every existing caller
        # (the live strip, the app); `active_tasks` is the complete list.
        active_logs = Log.search([('user_id', '=', user.id), ('is_active', '=', True)],
                                 order='start_time asc')
        running_tasks = [l.kpi_id for l in active_logs if l.kpi_id]
        active_tasks = [_task_payload(t) for t in running_tasks]
        active_task = active_tasks[0] if active_tasks else False

        active_break = False
        brk = Break.search([('user_id', '=', user.id), ('is_active', '=', True)], limit=1)
        if brk:
            active_break = {
                'id': brk.id,
                'type': brk.break_type,
                'type_label': dict(Break._fields['break_type'].selection).get(brk.break_type, brk.break_type),
                'start_raw': (brk.start_time.isoformat() + 'Z') if brk.start_time else False,
                'start_display': _to_user_tz_str(brk.start_time, user, fmt='%H:%M') if brk.start_time else '',
                'source_task_name': brk.source_task_id.name if brk.source_task_id else '',
                'reason_note': brk.reason_note or '',
            }

        # Day anchors for the running Presence / Productive counters.
        sess = self.sudo().search([
            ('user_id', '=', user.id),
            ('session_date', '=', fields.Date.context_today(self)),
            ('state', '=', 'open'),
        ], limit=1)
        login_raw = (sess.login_at.isoformat() + 'Z') if sess and sess.login_at else False
        today = fields.Date.context_today(self)
        done_logs = Log.search([('user_id', '=', user.id), ('work_date', '=', today), ('is_active', '=', False)])
        # Wall-clock covered, not the sum of durations — the live counter has to
        # agree with the End Workday summary, which measures the same way.
        productive_base = _measure([(l.start_time, l.end_time) for l in done_logs])

        # The open Meeting/Break block, so the board can show the pill. It rides
        # on this poll rather than a second one, which also means the pill
        # survives a board re-mount — the block lives on the server, not in
        # component state.
        nontask = False
        if sess and sess.nontask_started_at:
            # The row doesn't exist until the block CLOSES, so number the running
            # one as "the next one" using the same helper create() will use — the
            # pill and the saved row must never disagree on the number.
            nt_seq = self.env['kpi.nontask.block'].sudo()._next_seq(
                user.id, sess.nontask_reason, sess.session_date)
            base_label = dict(self._fields['nontask_reason'].selection).get(
                sess.nontask_reason, sess.nontask_reason or '')
            nontask = {
                'reason': sess.nontask_reason or '',
                'seq': nt_seq,
                'reason_label': ('%s %s' % (base_label, nt_seq)) if base_label else base_label,
                # ISO+Z, exactly like active_break.start_raw, so the client ticks
                # it with the same helper and can't drift from the server clock.
                'start_raw': sess.nontask_started_at.isoformat() + 'Z',
                'start_display': _to_user_tz_str(sess.nontask_started_at, user, fmt='%H:%M'),
            }

        # "Nothing is running and you haven't said why" — the board raises the
        # popup on this, because dev_idle_check carries no kpi_id and so can't be
        # tapped through to anywhere.
        #
        # Deliberately NOT gated on idle_check_count: the question is asked from the
        # MOMENT THE WORKDAY OPENS, not 10 minutes later. Starting your day is
        # exactly when "meeting / break / no tasks" is the honest answer, and the
        # 09:30 start / 09:31 meeting case can't be recorded truthfully if nobody
        # asks until 09:40. The cron's job is only to ASK AGAIN.
        #
        # FOUR ways of answering, and every one of them must close it — otherwise
        # the popup asks something the developer has already told us.
        #
        #   1. started a task           -> active_task
        #   2. declared meeting/break/  -> nontask        (a kpi.nontask.block)
        #      lunch with no task
        #   3. said "I have no tasks"   -> no_task_nudge_count (via /idle_reason)
        #   4. PAUSED a task with a     -> active_break   (a kpi.break.log)
        #      reason
        #
        # #4 was missed. A pause writes a break-LOG, not a block, so `nontask`
        # stays false — and the popup asked "why is nothing running?" at someone who
        # had just answered "Break" two seconds earlier. It was already recorded,
        # already metered, already on the Map as "Break 1"; only this line couldn't
        # see it.
        #
        # A pause with NO reason writes no break-log, so it correctly still asks:
        # nothing was declared, so the question genuinely stands.
        idle_prompt = bool(
            sess and not active_task and not nontask and not active_break
            and not sess.no_task_nudge_count
        )
        # WHICH ask this is. 1 = the one at workday start (the cron hasn't run yet);
        # each cron re-ask bumps it. The app opens the popup once per NUMBER rather
        # than once per boolean, so dismissing the first ask doesn't swallow the
        # later ones — that is what keeps the cap-of-3 a cap-of-3 and not of 1.
        idle_prompt_seq = ((sess.idle_check_count or 0) + 1) if idle_prompt else 0

        return {
            'status': True,
            'workday_open': bool(sess),
            'active_task': active_task,
            'active_tasks': active_tasks,   # every running timer (multitask)
            'active_break': active_break,
            'nontask': nontask,
            'idle_prompt': idle_prompt,
            'idle_prompt_seq': idle_prompt_seq,
            'login_raw': login_raw,           # anchor for live Presence (now - login)
            'productive_base': productive_base,  # finished-log seconds; add running task live
        }

    # Reasons the developer told us THEMSELVES that they'd be away from the desk.
    # While one of these is open, a dead heartbeat is not evidence they vanished —
    # a laptop that sleeps through a lunch hour is exactly what lunch looks like.
    # Both stale-heartbeat crons (auto-away, idle workday close) skip these.
    #
    # 'away' is deliberately NOT in this list: it is the code auto-away itself
    # writes, so excusing it would let the first auto-pause permanently immunise a
    # session against the idle close. 'meeting' is out too — add it here (one word)
    # if a meeting should also hold the timers off.
    _DECLARED_BREAK_REASONS = ('break', 'lunch')

    # Upper bound on the exemption above. A declared Break/Lunch still open after
    # this long is no longer a break — it's a developer who declared lunch and went
    # home — so the idle close is allowed to run again. Without it, the only thing
    # that would ever end that workday is the midnight sweep, which caps logout at
    # 23:59:59 and inflates the day's Presence with an evening nobody worked.
    _MAX_DECLARED_BREAK_MINUTES = 180

    def _on_declared_break(self):
        """True while this session's developer has an OPEN Break/Lunch they declared
        themselves — paused from a running task (kpi.break.log) or with no task
        running (kpi.nontask.block) — and it started less than
        _MAX_DECLARED_BREAK_MINUTES ago.

        Never raises: a bookkeeping error must not be what decides whether someone's
        workday gets closed underneath them."""
        self.ensure_one()
        floor = fields.Datetime.now() - timedelta(minutes=self._MAX_DECLARED_BREAK_MINUTES)
        try:
            if self.env['kpi.break.log'].sudo().search_count([
                ('user_id', '=', self.user_id.id),
                ('is_active', '=', True),
                ('break_type', 'in', self._DECLARED_BREAK_REASONS),
                ('start_time', '>=', floor),
            ]):
                return True
            return bool(self.env['kpi.nontask.block'].sudo().search_count([
                ('session_id', '=', self.id),
                ('end_at', '=', False),
                ('reason', 'in', self._DECLARED_BREAK_REASONS),
                ('start_at', '>=', floor),
            ]))
        except Exception as exc:
            _logger.warning("declared-break check failed for session %s: %s", self.id, exc)
            return False

    @api.model
    def _cron_auto_away(self):
        """Pause the running task of any developer whose board heartbeat has gone
        stale, past company.away_after_minutes.

        DISABLED BY DEFAULT — away_after_minutes ships as 0, and the cron record
        itself is inactive. A sleeping laptop is not evidence that someone stopped
        working, and pausing on it (plus the un-pairing that used to follow) was
        the single biggest source of daily friction: five minutes with the lid
        shut cost you your board.

        Left in place, not deleted, so a company that WANTS strict idle pausing
        can set away_after_minutes and re-activate the cron. 0 now genuinely means
        off — it used to be swallowed by `max(1, x or 5)`, so the setting could
        never actually disable the thing it claimed to control."""
        try:
            minutes = int(self.env.company.away_after_minutes or 0)
        except Exception:
            minutes = 0
        if minutes <= 0:
            return 0
        now = fields.Datetime.now()
        today = fields.Date.context_today(self)
        cutoff = now - timedelta(minutes=minutes)
        stale = self.sudo().search([
            ('state', '=', 'open'),
            ('session_date', '=', today),
            ('last_heartbeat', '!=', False),
            ('last_heartbeat', '<', cutoff),
        ])
        paused = 0
        for s in stale:
            if s._on_declared_break():
                continue   # on Break/Lunch: being away IS the declared state
            try:
                s._pause_running_task(reason='Away (auto)')
                paused += 1
            except Exception as exc:
                _logger.warning("auto-away failed for session %s: %s", s.id, exc)
        return paused

    # ------------------------------------------------------------------ #
    # End-of-day                                                         #
    # ------------------------------------------------------------------ #
    def action_end_day(self, note=''):
        """Close this session and fire a day-wide summary WhatsApp.
        Summary aggregates every session this developer has had TODAY so a
        re-started workday rolls up everything in one message.
        Idempotent — re-calling on a closed session just returns the payload.
        """
        self.ensure_one()
        if self.state == 'closed':
            return self._daily_summary_payload(full_day=True)
        self.sudo().write({
            'logout_at': fields.Datetime.now(),
            'state':     'closed',
            'note':      (note or '').strip() or False,
        })
        # Stop a task the developer left running when they pressed End Workday,
        # so its timer is closed at logout instead of accruing forever. Same
        # helper the idle/midnight auto-close use (they call it too), keeping the
        # manual and automatic close paths consistent — without this the task
        # stays in_progress with an open time log and its elapsed time bleeds.
        try:
            self._pause_running_task(reason='Workday ended')
        except Exception as exc:
            _logger.warning("end-workday pause failed for session %s: %s", self.id, exc)
        # Close everything still "running" (break/lunch, Meeting/Break block, idle
        # timers) and un-pair the device. Shared with the midnight auto-close so the
        # two paths can't drift — see _finalize_day_cleanup.
        self._finalize_day_cleanup()
        payload = self._daily_summary_payload(full_day=True)
        # Freeze the day into an image BEFORE anything else reads it: everything in
        # the payload is a live compute, so this is the only record of what the day
        # actually looked like at End Workday. Snapshot first, then notify, so the
        # notification can point at a row that already exists.
        snap = self._capture_snapshot(payload)
        self._fire_daily_summary(payload, snapshot=snap)
        return payload

    def _finalize_day_cleanup(self):
        """Close everything still 'running' when a workday ends, and un-pair.

        Shared by the manual End Workday (action_end_day) AND the cross-midnight
        auto-close (_close_overdue) so a forgotten workday is cleaned up exactly
        like a manual one. Without this on the auto-close path, an open Break/Lunch
        or Meeting block (and the pair record) carries into the next day — which,
        e.g., silences the idle "what are you doing?" prompt because the board still
        thinks a Break is running. The running task itself is auto-PAUSED by the
        caller (action_end_day already stopped it; _close_overdue calls
        _pause_running_task first), so time is saved, not lost. Every step is
        defensive: a cleanup failure must never block the close itself."""
        self.ensure_one()
        at = self.logout_at or fields.Datetime.now()
        try:
            self.env['kpi.break.log'].stop_break(self.user_id.id, at=at)
        except Exception as exc:
            _logger.warning("finalize cleanup: stop_break failed for session %s: %s", self.id, exc)
        try:
            self._close_nontask_block(at=at)
            self._stop_idle_tracking('workday ended')
        except Exception as exc:
            _logger.warning("finalize cleanup: nontask/idle failed for session %s: %s", self.id, exc)
        # There used to be an _unpair() here, to send the device back to the PIN
        # screen at end of day. Pairing is retired — see models/kpi_pair.py.

    def _capture_snapshot(self, payload):
        """Draw + save today's summary image. Deliberately swallows everything: a
        drawing bug must NEVER stop a developer from ending their day."""
        self.ensure_one()
        try:
            return self.env['kpi.workday.snapshot'].sudo()._capture(self, payload)
        except Exception as exc:
            _logger.exception("workday snapshot failed for session %s: %s", self.id, exc)
            return self.env['kpi.workday.snapshot'].browse()

    def _daily_summary_payload(self, full_day=False):
        """Build the dict the popup + WhatsApp template both consume.

        full_day=False (default): just THIS session.
        full_day=True: aggregate every session this user has had today.
        Use full_day=True at logout / cron-close so the message reflects
        the whole day even when the dev had several login/logout cycles.
        """
        self.ensure_one()
        Session = self.env['kpi.work.session'].sudo()
        if full_day:
            sessions = Session.search([
                ('user_id',      '=', self.user_id.id),
                ('session_date', '=', self.session_date),
            ], order='login_at asc')
            if not sessions:
                sessions = self
        else:
            sessions = self

        # Gather logs strictly within each session's window so two sessions
        # on the same day don't double-count the same kpi.time.log rows.
        Log = self.env['kpi.time.log'].sudo()
        per_task = {}
        segments = []   # flat, time-ordered task work-segments for the Workday Map
        for s in sessions:
            if not s.login_at:
                continue
            dom = [
                ('user_id',   '=', s.user_id.id),
                ('is_active', '=', False),
                ('start_time', '>=', s.login_at),
            ]
            if s.logout_at:
                dom.append(('start_time', '<', s.logout_at))
            for log in Log.search(dom):
                k = log.kpi_id
                if not k:
                    continue
                d = per_task.setdefault(k.id, {
                    'kpi_id':           k.id,
                    'ref':              k.external_ref or f"#{k.id}",
                    'name':             k.name or '',
                    'duration_seconds': 0.0,
                    'intervals':        [],
                })
                d['duration_seconds'] += (log.duration_seconds or 0.0)
                if log.start_time and log.end_time:
                    d['intervals'].append((log.start_time, log.end_time))
                    segments.append({
                        'kpi_id': k.id,
                        'ref':    k.external_ref or f"#{k.id}",
                        'name':   k.name or '',
                        'start':  log.start_time,
                        'end':    log.end_time,
                        'active': False,
                    })

        # Fold in EVERY currently-running segment before anything is measured, so
        # live work counts and a running task takes part in the concurrency split
        # like any other. This used to happen after the grouping, with limit=1 —
        # so a multitasking developer with two timers going had the second one
        # dropped from Productive and from the Map until it stopped.
        now_ts = fields.Datetime.now()
        for log in Log.search([('user_id', '=', self.user_id.id), ('is_active', '=', True)]):
            k = log.kpi_id
            if not k or not log.start_time:
                continue
            running_secs = max(0.0, (now_ts - log.start_time).total_seconds())
            if running_secs <= 0:
                continue
            d = per_task.setdefault(k.id, {
                'kpi_id':           k.id,
                'ref':              k.external_ref or f"#{k.id}",
                'name':             k.name or '',
                'duration_seconds': 0.0,
                'intervals':        [],
            })
            d['duration_seconds'] += running_secs
            d['intervals'].append((log.start_time, now_ts))
            segments.append({
                'kpi_id': k.id,
                'ref':    k.external_ref or f"#{k.id}",
                'name':   k.name or '',
                'start':  log.start_time,
                'end':    None,
                'active': True,
            })

        # Every work interval of the day, kept aside now: the per-task dicts are
        # stripped of their 'intervals' key further down (it must not reach the
        # payload), and the day's Productive total is measured from this.
        all_intervals = [iv for t in per_task.values() for iv in t['intervals']]

        # Concurrency grouping: link tasks whose time-log intervals overlap, so a
        # multi-task dev's summary can GROUP tasks that ran at the same time
        # (adjacent + flagged) instead of implying they were sequential.
        task_list = list(per_task.values())
        for t in task_list:
            iv = [(s, e) for (s, e) in t.get('intervals', []) if s and e]
            t['_iv'] = iv
            t['_start'] = min((s for (s, e) in iv), default=None)
        parent = {t['kpi_id']: t['kpi_id'] for t in task_list}

        def _find(x):
            r = x
            while parent[r] != r:
                r = parent[r]
            while parent[x] != r:
                parent[x], x = r, parent[x]
            return r

        for a_i in range(len(task_list)):
            for b_i in range(a_i + 1, len(task_list)):
                a, b = task_list[a_i], task_list[b_i]
                if any(sa < eb and sb < ea
                       for (sa, ea) in a['_iv'] for (sb, eb) in b['_iv']):
                    parent[_find(a['kpi_id'])] = _find(b['kpi_id'])

        comps = {}
        for t in task_list:
            comps.setdefault(_find(t['kpi_id']), []).append(t)
        _far = fields.Datetime.now()
        ordered_groups = sorted(
            comps.values(),
            key=lambda g: min((t['_start'] for t in g if t['_start']), default=_far))
        # Solo vs shared, measured PER INTERVAL rather than per task.
        #
        # The grouping above answers "which tasks ran alongside each other", and
        # that is all it should answer. It used to also decide the concurrent
        # FLAG, which made the whole of a task concurrent as soon as any one of
        # its intervals overlapped: a task worked on solo for 20 minutes in the
        # morning and then again for two hours alongside another task reported
        # 2h20m entirely shared, and the solo 20 minutes vanished into the
        # multitask block. The split below is what keeps them apart.
        for t in task_list:
            others = [iv for o in task_list if o['kpi_id'] != t['kpi_id'] for iv in o['_iv']]
            shared = _intersect_seconds(t['_iv'], others)
            # Cap at the measured span: duration_seconds is a SUM and can exceed
            # the covered span if a task's own logs ever overlap each other.
            own = _measure(t['_iv'])
            t['shared_seconds'] = min(shared, own)
            t['solo_seconds'] = max(0.0, own - t['shared_seconds'])

        tasks = []
        for gi, g in enumerate(ordered_groups):
            for t in sorted(g, key=lambda d: d['duration_seconds'], reverse=True):
                t['group'] = gi
                # Now derived from the task's OWN shared time, not from how many
                # tasks happen to sit in its group.
                t['concurrent'] = t['shared_seconds'] > 0
                t['duration_display'] = _fmt_hms(t['duration_seconds'])
                t['solo_display'] = _fmt_hms(t['solo_seconds'])
                t['shared_display'] = _fmt_hms(t['shared_seconds'])
                for _k in ('_iv', '_start', 'intervals'):
                    t.pop(_k, None)
                tasks.append(t)

        # Aggregate totals across the bucketed sessions.
        #
        # Productive is the WALL-CLOCK covered by task work — the union of every
        # interval gathered above, running segments included — not the sum of the
        # per-task durations. Summing counted two concurrent tasks twice, so a 2h
        # multitasking stretch read as 4h productive against 2h of presence, and
        # other_idle = max(0, presence - productive - metered) then floored to
        # zero and hid it. Built from the same intervals the task rows are built
        # from, so the summary can never disagree with its own task list.
        #
        # Per-task duration_seconds stays real elapsed time: if two tasks ran for
        # 2h together, each of them genuinely took 2h. Only the day's total has
        # to reconcile with the clock.
        productive = _measure(all_intervals)
        presence   = sum(sessions.mapped('presence_seconds'))

        # First login + last logout across all of today's sessions for display.
        login_candidates  = [s.login_at  for s in sessions if s.login_at]
        logout_candidates = [s.logout_at for s in sessions if s.logout_at]
        first_login = min(login_candidates) if login_candidates else self.login_at
        last_logout = max(logout_candidates) if logout_candidates else self.logout_at

        # Break / Lunch (metered) + Other-Idle within Presence. These live ONLY in
        # kpi.break.log (never kpi.time.log), so they're in Presence, not Productive.
        blogs = self.env['kpi.break.log'].sudo().search([
            ('user_id', '=', self.user_id.id),
            ('work_date', '=', self.session_date),
        ], order='start_time asc')
        # Non-task blocks: Meeting / Break / No-tasks recorded when NO task was
        # running. They were previously written and read by NOBODY — so that time
        # fell into the other_idle residual below and displayed as unexplained
        # idle, which is the exact thing recording it was meant to prevent.
        closed_blocks = self.env['kpi.nontask.block'].sudo().search([
            ('user_id', '=', self.user_id.id),
            ('session_id.session_date', '=', self.session_date),
        ], order='start_at asc')

        # Normalized to plain dicts so the STILL-OPEN block can join them. A block
        # only becomes a row when it closes, so a running meeting had no row and was
        # missing from the Map entirely — open the End Workday preview mid-meeting
        # and the meeting simply wasn't there. A running TASK already appears (its
        # live segment is appended with outcome='active'); blocks now do the same.
        _now = fields.Datetime.now()
        blocks = [{
            'reason': bk.reason, 'start_at': bk.start_at, 'end_at': bk.end_at,
            'seconds': bk.seconds or 0.0, 'note': bk.note or '', 'open': False,
        } for bk in closed_blocks]
        for s in sessions:
            if not s.nontask_started_at:
                continue
            blocks.append({
                'reason': s.nontask_reason or 'meeting',
                'start_at': s.nontask_started_at,
                'end_at': False,                       # still running
                'seconds': max(0.0, (_now - s.nontask_started_at).total_seconds()),
                'note': s.nontask_note or '',
                'open': True,
            })
        blocks.sort(key=lambda b: b['start_at'])

        def _blk(kind):
            return sum(bk['seconds'] for bk in blocks if bk['reason'] == kind)

        def _blog_secs(b):
            """A break-log's seconds, counting an OPEN one live.

            duration_seconds is computed from end_time, so an open break is 0 until
            it closes — which meant that while a developer was ON a break, the break
            bucket read 0m and the time slid into the other_idle residual, i.e. it
            was reported as unexplained idle. An open BLOCK already counts live, so
            the two paths disagreed about the same question.

            Only the live preview was ever wrong: action_end_day calls stop_break
            BEFORE building the payload, so the saved image was always correct.
            """
            if b.is_active and b.start_time:
                return max(0.0, (_now - b.start_time).total_seconds())
            return b.duration_seconds or 0.0

        def _log(kind):
            return sum(_blog_secs(b) for b in blogs if b.break_type == kind)

        break_secs   = _log('break') + _blk('break')
        # + _blk('lunch') matters: without it a no-task lunch is UNMETERED and slides
        # into other_idle, reading as unexplained idle — the very bug the block model
        # exists to prevent, sneaking back in through the new Lunch option.
        lunch_secs   = _log('lunch') + _blk('lunch')
        meeting_secs = _log('meeting') + _blk('meeting')
        away_secs    = _log('away')
        # Time the developer had nothing assigned. Its own bucket on purpose: it is
        # not the developer's fault and must not read as slacking.
        no_tasks_secs = _blk('no_tasks')
        # 'other' + 'leave' + 'urgent' + anything unexpected roll up under "Other".
        other_secs   = sum(_blog_secs(b) for b in blogs
                           if b.break_type in ('other', 'leave', 'urgent'))
        metered = (break_secs + lunch_secs + meeting_secs + away_secs
                   + other_secs + no_tasks_secs)
        # Residual idle = presence not covered by productive work OR any metered reason.
        other_idle = max(0.0, presence - productive - metered)

        # The company's standard working day. `or 9.0` covers a company row that
        # predates the field (a stored 0 would make every day green).
        std_hours = self.env.company.standard_workday_hours or 9.0
        std_seconds = std_hours * 3600.0

        # ONE ordered, numbered list — the Map. away_events is derived FROM it just
        # below, so the Map and the Away list cannot drift apart (they used to
        # number the same event differently: "Meeting" vs "Meeting 1").
        timeline = self._build_workday_timeline(segments, blogs, blocks,
                                                first_login, last_logout)

        away_events = []
        for n in timeline:
            if n.get('kind') != 'break':
                continue
            _t = n.get('time') or ''
            away_events.append({
                'label': n['label'],          # already numbered by the timeline
                'type': n.get('break_type') or '',
                'start': _t.split('-')[0],
                'end': _t.split('-')[1] if '-' in _t else '(open)',
                'duration_display': n.get('duration_display') or '',
                'from': n.get('from') or '',  # the task a pause came from (blocks: none)
                'note': n.get('reason') or '',
            })

        u = self.user_id
        return {
            'session_id':         self.id,
            'user_id':            u.id,
            'dev':                u.name or u.login or '—',
            'session_date':       str(self.session_date),
            'session_count':      len(sessions),
            # All datetimes displayed in user's tz (IST = Asia/Kolkata default).
            'login_at':           _to_user_tz_str(first_login, u),
            'logout_at':          _to_user_tz_str(last_logout, u) if last_logout else '',
            'productive_seconds': float(productive),
            'presence_seconds':   float(presence),
            'productive_display': _fmt_hms(productive),
            'presence_display':   _fmt_hms(presence),
            # ONE figure for "time that is accounted for": task work + meetings +
            # lunch + breaks + no-tasks (+ away / other, which are metered the same
            # way and would otherwise make this not add up).
            #
            # It is the counterpart to other_idle, and the two are what reconcile
            # the day: accounted + other_idle == presence, always. Reading five
            # separate buckets and adding them by eye was the only way to answer
            # "is my day explained?" before this.
            'accounted_seconds':  float(productive + metered),
            'accounted_display':  _fmt_hms(productive + metered),
            # A normal working day vs what was actually here. Decided ONCE, server
            # side, so the app, the web popup and the saved image can never render
            # a different verdict for the same day.
            # Deliberately measured against PRESENCE (wall clock), not Productive:
            # that is what was asked for. It means a long day with little task work
            # still reads green — which is why productive_display sits next to it.
            'standard_hours':     float(std_hours),
            'standard_display':   _fmt_hms(std_seconds),
            'met_standard':       bool(presence >= std_seconds),
            'task_count':         len(tasks),
            'tasks':              tasks,
            'auto_closed':        any(sessions.mapped('auto_closed')),
            'allow_multitask':    self.user_id.kpi_allow_multitask,
            'break_seconds':      float(break_secs),
            'lunch_seconds':      float(lunch_secs),
            'meeting_seconds':    float(meeting_secs),
            'other_seconds':      float(other_secs),
            'away_seconds':       float(away_secs),
            'no_tasks_seconds':   float(no_tasks_secs),
            'other_idle_seconds': float(other_idle),
            'break_display':      _fmt_hms(break_secs),
            'lunch_display':      _fmt_hms(lunch_secs),
            'meeting_display':    _fmt_hms(meeting_secs),
            'other_display':      _fmt_hms(other_secs),
            'away_display':       _fmt_hms(away_secs),
            'no_tasks_display':   _fmt_hms(no_tasks_secs),
            'other_idle_display': _fmt_hms(other_idle),
            'away_events':        away_events,
            'timeline':           timeline,
            'note':               self.note or '',
        }

    # ------------------------------------------------------------------ #
    # Workday Map — ordered timeline for the End Workday popup            #
    # ------------------------------------------------------------------ #
    def _build_workday_timeline(self, segments, blogs, blocks, first_login, last_logout):
        """Merge task work-segments + break/lunch intervals + non-task blocks into
        ONE ordered, NUMBERED list of nodes for the End Workday "Workday Map":

            Started workday
            Meeting 1              <- kpi.nontask.block (no task was running)
            Task 1 · REF name
            Break 1                <- kpi.break.log (a running task was paused)
            No tasks 1
            Lunch 1
            Task 2 · REF name      <- same task resumed = a NEW block of work
            Break 2
            Meeting 2
            Ended workday

        Every node is numbered per type in the order the day actually happened, so
        the Map reads as a story. Numbering deliberately spans BOTH recorders
        (kpi.break.log AND kpi.nontask.block): a Meeting is a Meeting whether or
        not a task happened to be running, and two things called "Meeting 1" would
        be a lie.

        Each task node carries the last reason/note typed for it — the pause
        reason (from the break it triggered) or, for its final segment, the
        completion outcome + latest progress summary. Purely read-only; built
        from existing kpi.time.log / kpi.break.log / kpi.nontask.block /
        kpi.progress / kra.kpi.
        """
        self.ensure_one()
        u = self.user_id
        _break_meta = {
            'break':    ('☕', 'Break'),
            'lunch':    ('🍽', 'Lunch'),
            'meeting':  ('👥', 'Meeting'),
            'away':     ('💤', 'Away'),
            'leave':    ('🚪', 'Leave'),
            'urgent':   ('⚡', 'Urgent'),
            # No tasks assigned — recorded so it can never be mistaken for idling.
            'no_tasks': ('📭', 'No tasks'),
            # 'other' says "Other", matching _type_labels. It used to say "Break"
            # here and "Other" there — the same event, named two different things.
            'other':    ('⏸', 'Other'),
        }

        def _hm(dt):
            return _to_user_tz_str(dt, u, fmt='%H:%M') if dt else ''

        def _range(start, end):
            a, b = _hm(start), _hm(end)
            if a and b:
                return a + '-' + b
            return a or b or ''

        _far = fields.Datetime.now()
        # Same clock for every "still running" duration on this Map, so two chips
        # drawn in one render can't disagree by a few milliseconds.
        _now_ts = _far
        nodes = []

        # Start node
        if first_login:
            nodes.append({'kind': 'start', 'icon': '🌅', 'label': 'Started workday',
                          'time': _hm(first_login), '_sort': first_login})

        # Per-task final state + latest progress summary (for completion nodes)
        kpi_ids = list({s['kpi_id'] for s in segments})
        Kpi = self.env['kra.kpi'].sudo()
        _kpis_rs = Kpi.browse(kpi_ids) if kpi_ids else Kpi.browse()
        state_by = {k.id: k.task_state for k in _kpis_rs}
        # Current assignee per task — to flag segments where the task was MOVED
        # (reassigned) to a developer other than the one whose day this is.
        assignee_by = {k.id: (k.user_id.id, k.user_id.name if k.user_id else '') for k in _kpis_rs}
        Progress = self.env['kpi.progress'].sudo()
        prog_by = {}
        for kid in kpi_ids:
            p = Progress.search([('kpi_id', '=', kid)], order='create_date desc', limit=1)
            prog_by[kid] = (p.summary or '').strip() if p else ''

        # Latest end-time per task — completion outcome only lands on its final segment.
        last_end_by = {}
        for s in segments:
            e = s.get('end')
            if e and (s['kpi_id'] not in last_end_by or e > last_end_by[s['kpi_id']]):
                last_end_by[s['kpi_id']] = e

        task_breaks = [b for b in blogs if b.source_task_id]

        # Task nodes
        for s in segments:
            start, end = s.get('start'), s.get('end')
            outcome, reason = 'worked', ''
            if s.get('active') or not end:
                outcome = 'active'
            else:
                is_last = last_end_by.get(s['kpi_id']) == end
                cur_uid, cur_name = assignee_by.get(s['kpi_id'], (None, None))
                # (0) moved away? — the task now belongs to a DIFFERENT developer
                #     (reassigned while/after this dev worked it).
                if is_last and cur_uid and cur_uid != u.id:
                    outcome = 'moved'
                    reason = (f"Reassigned to {cur_name}" if cur_name else "Reassigned away")
                else:
                    # (1) paused? — a break from THIS task starting ~when the segment ended
                    match = None
                    for b in task_breaks:
                        if (b.source_task_id.id == s['kpi_id'] and b.start_time
                                and abs((b.start_time - end).total_seconds()) <= 120):
                            match = b
                            break
                    if match is not None:
                        outcome, reason = 'paused', (match.reason_note or '').strip()
                    else:
                        # (2) completed / submitted? — only on the task's final segment
                        st = state_by.get(s['kpi_id'])
                        if is_last and st in ('completed', 'partially_completed'):
                            outcome = 'completed' if st == 'completed' else 'submitted'
                            reason = prog_by.get(s['kpi_id'], '')
            nodes.append({
                'kind': 'task', 'icon': '🛠',
                'ref': s['ref'], 'name': s['name'] or '',
                'label': (str(s['ref']) + ' ' + (s['name'] or '')).strip(),
                'time': _range(start, end), 'outcome': outcome, 'reason': reason,
                '_sort': start or first_login or _far,
            })

        # Break / lunch nodes — a RUNNING task was paused with a reason.
        # An OPEN one renders live, exactly like an open block: same question, so it
        # must not get a different answer depending on which model recorded it.
        for b in blogs:
            icon, label = _break_meta.get(b.break_type, ('⏸', 'Other'))
            b_running = bool(b.is_active and not b.end_time)
            b_secs = (max(0.0, (_now_ts - b.start_time).total_seconds())
                      if (b_running and b.start_time) else (b.duration_seconds or 0.0))
            nodes.append({
                'kind': 'break', 'icon': icon, 'label': label, 'break_type': b.break_type,
                'time': (_hm(b.start_time) + ' - now') if b_running
                        else _range(b.start_time, b.end_time),
                'duration_display': _fmt_hms(b_secs),
                'reason': (b.reason_note or '').strip(),
                'running': b_running,
                'from': b.source_task_id.name if b.source_task_id else '',
                '_sort': b.start_time or first_login or _far,
            })

        # Non-task blocks — NO task was running (the 09:30 start / 09:31 meeting
        # case). Same node shape as a break so they sort and number together: one
        # counter across both recorders, for free.
        # Plain dicts, not records: the STILL-OPEN block has no row yet and is passed
        # in alongside the saved ones, so a running meeting shows on the Map straight
        # away instead of only appearing once it ends.
        for bk in blocks:
            icon, label = _break_meta.get(bk['reason'], ('⏸', 'Other'))
            running = bk.get('open') and not bk.get('end_at')
            nodes.append({
                'kind': 'break', 'icon': icon, 'label': label,
                'break_type': bk['reason'],
                # "09:31 - now" while it runs, so the card reads as live rather than
                # as a block that mysteriously has no end.
                'time': (_hm(bk['start_at']) + ' - now') if running
                        else _range(bk['start_at'], bk.get('end_at')),
                'duration_display': _fmt_hms(bk.get('seconds') or 0),
                'reason': (bk.get('note') or '').strip(),
                'running': bool(running),
                'from': '',   # no task was running — that is the whole point
                '_sort': bk['start_at'] or first_login or _far,
            })

        nodes.sort(key=lambda n: n['_sort'] or _far)

        # Number every node per type, in the order the day actually happened:
        #   Meeting 1 -> Task 1 -> Break 1 -> No tasks 1 -> Task 2 -> Break 2 ...
        # AFTER the sort, so numbers follow the clock and not the query order.
        # Start/End are never numbered — there is only one of each.
        _seq = {}
        for n in nodes:
            key = 'task' if n['kind'] == 'task' else n.get('break_type')
            if not key:
                continue
            _seq[key] = _seq.get(key, 0) + 1
            n['seq'] = _seq[key]
            if n['kind'] == 'task':
                # Keep the task's identity — an admin reading the saved image must
                # still be able to tell WHICH task this was.
                n['label'] = ('Task %d · %s' % (_seq[key], n['label'])).strip()
            else:
                n['label'] = '%s %d' % (n['label'], _seq[key])

        # End node — always last, and never numbered.
        if last_logout:
            nodes.append({'kind': 'end', 'icon': '🌙', 'label': 'Ended workday', 'time': _hm(last_logout)})
        else:
            nodes.append({'kind': 'end', 'icon': '⏳', 'label': 'Still working', 'time': ''})

        for n in nodes:
            n.pop('_sort', None)
        return nodes

    def _fire_daily_summary(self, payload, snapshot=None):
        """Tell owner + coordinator this developer ended their workday.

        IN-APP ONLY now — the WhatsApp template was removed. The point of this
        notification is that admins TAP it and land on the day's frozen summary
        image, which a WhatsApp text cannot do. (It reached nobody before anyway:
        kpi_wa_task_notifications defaults False.)

        `snapshot`: the kpi.workday.snapshot just saved. Passed down through the
        CONTEXT so no signature in the _notify chain has to change; the persist
        block stamps it onto each created row as snapshot_id, which is what makes
        the notification tappable.

        _notify resolves recipients off a kra.kpi record, so we pick any
        task this dev has ever owned. Falls back to a direct send when the
        dev has none.
        """
        # Build the task_lines + auto_note strings here (the template just
        # interpolates strings — no Jinja).
        def _task_line(t):
            line = (f"  {'⚡' if t.get('concurrent') else '•'} {t['ref']}  "
                    f"{t['name'][:48]}  —  {t['duration_display']}")
            # Spell out the split only when a task was worked BOTH alone and
            # alongside something else — that is the case the flag alone gets
            # wrong, and the one the developer will query.
            if t.get('concurrent') and (t.get('solo_seconds') or 0) > 0:
                line += f" ({t.get('solo_display')} alone + {t.get('shared_display')} shared)"
            return line

        if payload['tasks']:
            task_lines = "\n".join(_task_line(t) for t in payload['tasks'])
        else:
            task_lines = "  (no task time logged)"
        # Productive is now measured as wall-clock covered (overlap counted once),
        # so it can no longer exceed Presence — the old note promised the opposite.
        multitask_note = ("⚡ Multi-task on — tasks marked ⚡ overlapped in time. "
                          "Productive counts that overlap ONCE, so it stays within "
                          "Presence; each task still shows its own full duration.\n"
                          if payload.get('allow_multitask') else '')
        auto_note = ('(Auto-closed by system — dev did not press End Workday.)'
                     if payload['auto_closed'] else '')
        sess_n = payload.get('session_count') or 1
        session_note = (f"(Across {sess_n} sessions today.)\n" if sess_n > 1 else '')
        ctx = {
            'dev':            payload['dev'],
            'session_date':   payload['session_date'],
            'login_at':       payload['login_at'],
            'logout_at':      payload['logout_at'] or '(open)',
            'productive':     payload['productive_display'],
            'presence':       payload['presence_display'],
            'accounted':      payload['accounted_display'],
            'task_count':     payload['task_count'],
            'task_lines':     task_lines,
            'auto_note':      auto_note,
            'session_count':  sess_n,
            'session_note':   session_note,
            'multitask_note': multitask_note,
        }
        Kpi = self.env['kra.kpi'].sudo()
        any_kpi = Kpi.search([('user_id', '=', self.user_id.id)],
                             order='id desc', limit=1)
        if not any_kpi:
            any_kpi = Kpi.search([], order='id desc', limit=1)
        if any_kpi:
            try:
                # kpi_snapshot_id rides the context: _notify's persist block stamps
                # it on each created row, which is what makes the notification
                # tappable through to the day's image.
                if snapshot:
                    any_kpi = any_kpi.with_context(kpi_snapshot_id=snapshot.id)
                any_kpi._notify('daily_summary', **ctx)
                any_kpi._log_action(
                    'daily_summary_sent',
                    source='cron' if payload['auto_closed'] else 'web',
                    actor_user_id=self.user_id.id,
                    payload={'session_id': self.id,
                             'productive_seconds': payload['productive_seconds'],
                             'presence_seconds':   payload['presence_seconds'],
                             'task_count':         payload['task_count']},
                )
            except Exception as exc:
                _logger.warning("daily_summary _notify failed: %s", exc)
        else:
            _logger.info("No kra.kpi available to anchor daily_summary _notify; skipping.")

    # ------------------------------------------------------------------ #
    # Cron — close stragglers at 23:55                                   #
    # ------------------------------------------------------------------ #
    def _pause_running_task(self, reason='Workday ended (auto)'):
        """Pause this developer's in-progress task(s), recorded as non-productive
        'away' time. Used by the midnight auto-close so a task left running when
        the day rolls over is stopped.

        EVERY running task, not just the first: a developer with
        kpi_allow_multitask can have two timers going, and pausing one of them
        left the other's kpi.time.log open across the close — an open segment
        with no end, which the next day then counts as live work."""
        self.ensure_one()
        Log = self.env['kpi.time.log'].sudo()
        for active_log in Log.search([('user_id', '=', self.user_id.id),
                                      ('is_active', '=', True)]):
            task = active_log.kpi_id
            if task and task.task_state == 'in_progress':
                task.with_user(self.user_id).pause_task(reason=reason, reason_code='away')

    def _fire_workday_auto_closed(self):
        """Tell the developer their workday was auto-closed at midnight (they
        never pressed End Workday) — WhatsApp + in-app push. Anchored on one of
        the dev's own tasks so the 'developer' recipient resolves to them."""
        self.ensure_one()
        u = self.user_id
        ctx = {'dev': u.name or u.login or '—', 'session_date': str(self.session_date)}
        any_kpi = self.env['kra.kpi'].sudo().search(
            [('user_id', '=', u.id)], order='id desc', limit=1)
        if not any_kpi:
            _logger.info("workday_auto_closed: %s has no kra.kpi to anchor on", u.login)
            return
        any_kpi._notify('workday_auto_closed', **ctx)

    @api.model
    def _close_overdue(self):
        """Close every OPEN session from a previous day (it crossed midnight):
        pause a task the developer left running, close it (cap logout at that
        day's 23:59:59), fire the daily summary, and notify the developer it was
        auto-closed. Idempotent — safe to run frequently. Returns count closed."""
        today = fields.Date.context_today(self)
        stragglers = self.sudo().search([
            ('state', '=', 'open'),
            ('session_date', '<', today),
        ])
        for s in stragglers:
            # Stop a task the developer left running when the day rolled over.
            try:
                s._pause_running_task()
            except Exception as exc:
                _logger.warning("overdue-close pause failed for session %s: %s", s.id, exc)
            # logout_at = end of session_date IN THE DEVELOPER'S TIMEZONE — caps
            # presence growth. session_date is a local date, so a naive combine
            # stored as UTC put this 05:29 the next morning for IST and inflated
            # every auto-closed cross-midnight day by the offset.
            eod = _local_day_end_utc(s.session_date, s.user_id)
            s.write({
                'logout_at':   eod,
                'state':       'closed',
                'auto_closed': True,
            })
            # Same full cleanup a manual End Workday does — close the open
            # Break/Lunch/Meeting (capped at eod via logout_at) and un-pair. Runs
            # BEFORE the snapshot below so the saved image reflects the finalized
            # day, and stops a stale 'active' break/task carrying into tomorrow
            # (which would silence the idle prompt / show a phantom activity).
            try:
                s._finalize_day_cleanup()
            except Exception as exc:
                _logger.warning("overdue-close cleanup failed for session %s: %s", s.id, exc)
            try:
                # full_day=True to match action_end_day — this is the same day's
                # record, and it must not differ just because a cron closed it.
                payload = s._daily_summary_payload(full_day=True)
                # The image matters MOST here: this fires for exactly the people
                # who forgot to end their day, and there is no browser in a cron —
                # which is why the whole thing renders server-side.
                snap = s._capture_snapshot(payload)
                s._fire_daily_summary(payload, snapshot=snap)
            except Exception as exc:
                _logger.warning("overdue-close summary failed for session %s: %s", s.id, exc)
            # Tell the developer we auto-closed the workday they left open.
            try:
                s._fire_workday_auto_closed()
            except Exception as exc:
                _logger.warning("overdue-close notify failed for session %s: %s", s.id, exc)
        return len(stragglers)

    @api.model
    def _close_idle_workdays(self):
        """Auto-close TODAY's workdays the developer forgot to End: the board
        heartbeat has gone stale (tab closed / device gone) for longer than
        company.workday_idle_close_minutes. Does the FULL End Workday — pause the
        running task, close breaks/blocks, un-pair, fire the daily summary + snapshot,
        and notify the dev — exactly like the manual button and the midnight close.

        logout_at is capped at last_heartbeat (when the dev was actually last
        present), NOT 'now', so presence isn't inflated by the idle window. A dev
        who keeps the board open keeps heartbeating and is never touched.

        A dev on a declared Break/Lunch is never touched either, board open or not:
        they told us they were stepping away, and a laptop asleep through lunch is
        the normal case, not a forgotten workday. See _on_declared_break.
        Idempotent — safe to run every few minutes. Returns count closed."""
        try:
            minutes = int(self.env.company.workday_idle_close_minutes or 0)
        except Exception:
            minutes = 15
        if minutes <= 0:
            return 0
        now = fields.Datetime.now()
        today = fields.Date.context_today(self)
        cutoff = now - timedelta(minutes=minutes)
        idle = self.sudo().search([
            ('state', '=', 'open'),
            ('session_date', '=', today),
            ('last_heartbeat', '!=', False),
            ('last_heartbeat', '<', cutoff),
        ])
        closed = 0
        for s in idle:
            # On a declared Break/Lunch → not a forgotten workday. Leave it open;
            # the timer effectively restarts from the heartbeat they send the
            # moment they're back at the board.
            if s._on_declared_break():
                _logger.info("idle-close: skipping session %s — %s is on a declared break/lunch",
                             s.id, s.user_id.login)
                continue
            closed += 1
            try:
                s._pause_running_task()
            except Exception as exc:
                _logger.warning("idle-close pause failed for session %s: %s", s.id, exc)
            # Cap logout at the last heartbeat (last time the dev was present), not
            # now — the idle window is not working time.
            s.write({
                'logout_at':   s.last_heartbeat or now,
                'state':       'closed',
                'auto_closed': True,
            })
            try:
                s._finalize_day_cleanup()
            except Exception as exc:
                _logger.warning("idle-close cleanup failed for session %s: %s", s.id, exc)
            try:
                payload = s._daily_summary_payload(full_day=True)
                snap = s._capture_snapshot(payload)
                s._fire_daily_summary(payload, snapshot=snap)
            except Exception as exc:
                _logger.warning("idle-close summary failed for session %s: %s", s.id, exc)
            try:
                s._fire_workday_auto_closed()
            except Exception as exc:
                _logger.warning("idle-close notify failed for session %s: %s", s.id, exc)
        if closed:
            _logger.info("idle-close: auto-ended %s forgotten workday(s) (>%s min idle)", closed, minutes)
        return closed

    @api.model
    def _cron_close_idle_workdays(self):
        """Frequent cron (~5 min): auto-End workdays a developer forgot to close
        once the board has been gone longer than the idle threshold. See
        `_close_idle_workdays`."""
        return self._close_idle_workdays()

    @api.model
    def _cron_close_overdue_workdays(self):
        """Frequent cron (~5 min): promptly end workdays that crossed midnight
        (pause the running task + notify the developer). See `_close_overdue`."""
        return self._close_overdue()

    @api.model
    def _cron_auto_close_sessions(self):
        """Daily safety net: close any workday that crossed midnight (via
        `_close_overdue`), then retro-create closed sessions for developers who
        logged task time today but never hit the Action Board (so their summary
        still fires).

        Returns closed + retro-created. It used to `return len(stragglers)` — a
        local of _close_overdue that does not exist here — so the cron did all of
        its work and THEN raised NameError, was recorded as failed on every run,
        and was on its way to being auto-deactivated for repeated failure.
        """
        today = fields.Date.context_today(self)
        Session = self.sudo()

        # Part 1: close stragglers (shared with the frequent midnight cron).
        closed = self._close_overdue() or 0
        retro = 0

        # Part 2: retro-create sessions for users who logged time today
        # but never opened the dashboard.
        Log = self.env['kpi.time.log'].sudo()
        rows = Log.read_group(
            domain=[('work_date', '=', today), ('is_active', '=', False)],
            fields=['user_id'],
            groupby=['user_id'],
        )
        for row in rows:
            uid = row['user_id'] and row['user_id'][0]
            if not uid:
                continue
            existing = Session.search([
                ('user_id', '=', uid),
                ('session_date', '=', today),
            ], limit=1)
            if existing:
                continue
            # Synthesize a session bracketing the actual work.
            first = Log.search([
                ('user_id', '=', uid),
                ('work_date', '=', today),
            ], order='start_time asc', limit=1)
            last = Log.search([
                ('user_id', '=', uid),
                ('work_date', '=', today),
                ('end_time', '!=', False),
            ], order='end_time desc', limit=1)
            new_s = Session.create({
                'user_id':     uid,
                'session_date': today,
                'login_at':    first.start_time if first else fields.Datetime.now(),
                'logout_at':   (last.end_time if last else fields.Datetime.now()),
                'state':       'closed',
                'auto_closed': True,
                'note':        'Retro-created by cron (dev never opened dashboard).',
            })
            retro += 1
            try:
                payload = new_s._daily_summary_payload()
                new_s._fire_daily_summary(payload)
            except Exception as exc:
                _logger.warning("auto_close retro-summary failed for user %s: %s", uid, exc)

        return closed + retro

    # ================================================================== #
    # Idle check — workday open, nothing in progress                      #
    # ------------------------------------------------------------------ #
    # The DEVELOPER is asked before any admin is told. A quiet 10 minutes is
    # usually a meeting (start 09:30, meeting 09:31), and reporting that to an
    # admin would be a false alarm — the fastest way to make a notification feed
    # worth ignoring. Only "I have no tasks" is the admin's problem, and only
    # that reaches them.
    # ================================================================== #

    def _has_running_task(self):
        """True when this developer has a live timer.

        kpi.time.log.is_active is the authoritative 'working right now' signal —
        the same one _pause_running_task uses — rather than re-deriving it from
        kra.kpi.task_state.
        """
        self.ensure_one()
        return bool(self.env['kpi.time.log'].sudo().search_count([
            ('user_id', '=', self.user_id.id),
            ('is_active', '=', True),
        ]))

    def _anchor_kpi(self):
        """A kra.kpi to hang _notify() on (it lives on that model).

        An idle developer may have NO tasks — that's the whole point of the
        alert — so fall back to any task at all. Both events this anchors are
        _PASSTHROUGH_EVENTS, so the anchor never leaks into the message text,
        and neither resolves recipients from the anchor's assignee.
        """
        self.ensure_one()
        Kpi = self.env['kra.kpi'].sudo()
        return (Kpi.search([('user_id', '=', self.user_id.id)], order='id desc', limit=1)
                or Kpi.search([], order='id desc', limit=1))

    def _idle_ctx(self):
        self.ensure_one()
        u = self.user_id
        return {
            'dev':      u.name or u.login or '—',
            'login_at': _to_user_tz_str(self.login_at, u),
        }

    def _fire_idle_check(self):
        """Ask the DEVELOPER why nothing is running. Admins hear nothing."""
        self.ensure_one()
        anchor = self._anchor_kpi()
        if not anchor:
            _logger.info("idle check: no kra.kpi to anchor _notify on")
            return
        # extra_users, not the role matrix: 'developer' would resolve to the
        # ANCHOR task's assignee, which may be someone else entirely.
        anchor._notify('dev_idle_check', extra_users=[self.user_id.id], **self._idle_ctx())

    def _fire_no_task(self):
        """Tell the admins this developer has nothing to work on, and remember
        the rows so we can tell whether they've read it."""
        self.ensure_one()
        anchor = self._anchor_kpi()
        if not anchor:
            _logger.info("no-task alert: no kra.kpi to anchor _notify on")
            return
        Notif = self.env['kpi.notification'].sudo()
        before = Notif.search([('event', '=', 'dev_no_task')], order='id desc', limit=1)
        anchor._notify('dev_no_task', **self._idle_ctx())
        # The rows _notify just created (same transaction, so id > the last one
        # that existed a moment ago). _notify doesn't hand them back, and
        # kpi.notification has no link to the developer it's ABOUT — only to its
        # recipient — so this is what makes the later read-check exact.
        fresh = Notif.search([('event', '=', 'dev_no_task'),
                              ('id', '>', before.id if before else 0)])
        if fresh:
            self.sudo().write({'no_task_notif_ids': [(6, 0, fresh.ids)]})

    def _admins_read_no_task(self):
        """True once ANY admin has read the latest no-task notification."""
        self.ensure_one()
        rows = self.no_task_notif_ids
        if not rows:
            return False          # nothing recorded → nothing to have read
        return not any(not r.is_read for r in rows)

    def _close_nontask_block(self, at=None):
        """Close an open Meeting/Break block. Returns True if one was open.

        `at` lets the caller close it at an EXACT instant — start_task passes the
        moment the timer starts, so the block ends and the task begins on the same
        tick: no overlap, no gap.

        The block is recorded on kpi.nontask.block for the Workday Map. It is
        deliberately NOT written to kpi.time.log and never touches
        timer_total_seconds: a meeting is not work on a task, and counting it
        would corrupt actual-vs-estimate, the completion certificate and anything
        billable. Wall-clock (presence_seconds) already covers it.
        """
        self.ensure_one()
        if not self.nontask_started_at:
            return False
        end = at or fields.Datetime.now()
        self.env['kpi.nontask.block'].sudo().create({
            'session_id': self.id,
            'user_id':    self.user_id.id,
            'reason':     self.nontask_reason or 'meeting',
            'note':       self.nontask_note or False,
            'start_at':   self.nontask_started_at,
            'end_at':     end,
        })
        _logger.info("non-task block closed: %s %s → %s (%s)",
                     self.user_id.login, self.nontask_started_at, end, self.nontask_reason)
        self.sudo().write({'nontask_started_at': False, 'nontask_reason': False,
                           'nontask_note': False})
        return True

    def _set_nontask_reason(self, reason, note=''):
        """Declare what the developer is doing while no task runs:
        meeting | break | no_tasks. Returns {switched_from, admins_notified}.

        SWITCHING is how a block ends — "morning meeting over, I have no tasks" is
        ONE tap: the meeting closes and no-tasks begins, both landing on the Map.

        Rules:
          * different reason -> close the open block AT NOW, open the new one AT NOW.
            Same instant, so the two never overlap and never leave a gap — the same
            contract start_task uses when it closes a block at the tick the timer
            starts.
          * same reason -> idempotent: keep the original start, or re-tapping would
            restart the clock and throw away time already spent.

        This lives on the model, not in the controller, so it is reachable from an
        Odoo shell probe — the controller version could only ever be tested by
        re-implementing it, which tests the copy and not the code.

        The bug this fixes: it used to overwrite `nontask_reason` while KEEPING the
        original start, so a 09:31 meeting switched at 10:00 collapsed into a single
        block labelled "No tasks 09:31-10:30". The meeting vanished from the Map, its
        time was relabelled, and admins were told there had been no tasks since 09:31
        — untrue, unfair to the developer, and frozen into the End Workday image.
        """
        self.ensure_one()
        if reason not in NONTASK_REASON_CODES:
            raise ValueError('bad non-task reason: %s' % reason)
        note = (note or '').strip()[:NONTASK_NOTE_MAX]
        now = fields.Datetime.now()

        open_reason = self.nontask_reason if self.nontask_started_at else False
        switched_from = False
        if open_reason and open_reason != reason:
            self._close_nontask_block(at=now)
            switched_from = open_reason
            open_reason = False

        vals = {'nontask_reason': reason, 'nontask_note': note or False}
        if not open_reason:
            vals['nontask_started_at'] = now

        admins_notified = False
        if reason == 'no_tasks':
            # Only on a NEW declaration. open_reason is still 'no_tasks' ONLY when
            # they re-tapped the same button (the switch above cleared it otherwise),
            # and re-tapping must not tell the admins twice — the 15-min re-nudge is
            # what chases them.
            if open_reason != 'no_tasks':
                self._fire_no_task()
                admins_notified = True
                vals['no_task_nudge_at'] = now + timedelta(minutes=NO_TASK_NUDGE_MIN)
                vals['no_task_nudge_count'] = 1
            # They answered — stop asking them.
            vals['idle_check_at'] = False
        else:
            # Keep checking: a block left open all day is its own problem.
            vals['idle_check_at'] = now + timedelta(minutes=IDLE_CHECK_MIN)
            # Switching AWAY from "no tasks" (work arrived, or it was a meeting after
            # all) → stop chasing admins about it.
            if switched_from == 'no_tasks':
                vals['no_task_nudge_at'] = False
                vals['no_task_nudge_count'] = 0

        self.sudo().write(vals)
        _logger.info("non-task reason: %s %s%s", self.user_id.login, reason,
                     (' (was %s)' % switched_from) if switched_from else '')
        return {'switched_from': switched_from or '',
                'admins_notified': admins_notified}

    def _stop_idle_tracking(self, reason=''):
        """A task is running (or the day is over) → drop every timer."""
        self.ensure_one()
        vals = {}
        if self.idle_check_at:
            vals['idle_check_at'] = False
            vals['idle_check_count'] = 0
        if self.no_task_nudge_at:
            vals['no_task_nudge_at'] = False
        if vals:
            _logger.info("idle tracking stopped for %s (%s)", self.user_id.login, reason)
            self.sudo().write(vals)

    @api.model
    def _cron_check_idle_developers(self):
        """Two jobs, one sweep (see data/kpi_idle_check_cron.xml, every 5 min).

        1. Workday open with nothing in progress → ask the DEVELOPER
           (Meeting / Break / I have no tasks), every IDLE_CHECK_MIN, capped.
        2. Admins told 'no tasks' → repeat every NO_TASK_NUDGE_MIN while the
           notification stays UNREAD; reading it stops the repeats.
        """
        now = fields.Datetime.now()
        asked = nudged = 0

        # ── 1. ask the developer ──────────────────────────────────────────
        for s in self.sudo().search([
            ('state', '=', 'open'),
            ('idle_check_at', '!=', False),
            ('idle_check_at', '<=', now),
        ]):
            try:
                if s._has_running_task():
                    s._stop_idle_tracking('task running')
                    continue
                # Already told us why (meeting/break) → silent, just look again later.
                if s.nontask_started_at:
                    s.sudo().write({'idle_check_at': now + timedelta(minutes=IDLE_CHECK_MIN)})
                    continue
                # Never answered. Per the rule "only 'no task' goes to the admin",
                # silence is NOT escalated — we simply stop asking.
                if s.idle_check_count >= IDLE_CHECK_MAX:
                    s.sudo().write({'idle_check_at': False})
                    continue
                s._fire_idle_check()
                s.sudo().write({
                    'idle_check_at': now + timedelta(minutes=IDLE_CHECK_MIN),
                    'idle_check_count': s.idle_check_count + 1,
                })
                asked += 1
            except Exception as exc:
                _logger.warning("idle check failed for session %s: %s", s.id, exc)

        # ── 2. re-nudge the admins while unread ───────────────────────────
        for s in self.sudo().search([
            ('state', '=', 'open'),
            ('no_task_nudge_at', '!=', False),
            ('no_task_nudge_at', '<=', now),
        ]):
            try:
                if s._has_running_task():
                    s._stop_idle_tracking('task running — no-task alert resolved')
                    continue
                if s._admins_read_no_task():
                    _logger.info("no-task nudge stopped for %s: an admin read it", s.user_id.login)
                    s.sudo().write({'no_task_nudge_at': False})
                    continue
                if s.no_task_nudge_count >= NO_TASK_NUDGE_MAX:
                    s.sudo().write({'no_task_nudge_at': False})
                    continue
                s._fire_no_task()
                s.sudo().write({
                    'no_task_nudge_at': now + timedelta(minutes=NO_TASK_NUDGE_MIN),
                    'no_task_nudge_count': s.no_task_nudge_count + 1,
                })
                nudged += 1
            except Exception as exc:
                _logger.warning("no-task nudge failed for session %s: %s", s.id, exc)

        return {'asked': asked, 'nudged': nudged}
