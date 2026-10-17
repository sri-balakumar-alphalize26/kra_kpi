"""kpi.work.session — one row per (developer, day) tracking login/logout.

The session is a thin wrapper around the existing `kpi.time.log` rows:
  * `productive_seconds` = SUM(duration_seconds) of the developer's time-logs
    whose work_date matches this session_date.
  * `presence_seconds`   = time at work = (logout_at or now) - login_at, MINUS
    any time the day was paused (Pause Workday).

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
from psycopg2 import errors as pg_errors

from odoo import api, fields, models
from odoo.exceptions import ConcurrencyError

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

# How many times an over-running BREAK is mentioned before we stop. Same rule and
# the same reason as IDLE_CHECK_MAX: a developer on a genuinely long break has
# already been told, and a reminder that never stops is one people learn to
# ignore — which costs us the reminders that DO matter. 4 x 15 min = pings at
# 15/30/45/60, then silence.
BREAK_ALERT_MAX = 4

# Which open intervals get an over-run reminder, and whether it repeats.
#   reason code -> (res.company threshold field, repeats?)
# Anything NOT listed here is deliberately never alerted on:
#   'away'  — the SYSTEM paused the task (Pause Workday / midnight close); the
#             developer did not choose it, so a reminder would be nonsense.
#   'leave' / 'urgent' / 'other' — exceptional states with their own handling.
#   'no_tasks' — already has its own machinery (dev_no_task + the admin nudge in
#             _cron_check_idle_developers). Alerting here too would double up.
_BREAK_ALERT_RULES = {
    'break':   ('break_alert_minutes',   True),
    'lunch':   ('lunch_alert_minutes',   False),
    'meeting': ('meeting_alert_minutes', False),
}

# Event name per reason code, for _cron_check_long_breaks. Separate events rather
# than one with the kind in ctx so each gets its own push TITLE and feed icon —
# "Lunch is running long" is the whole value of the notification, and a generic
# title would throw it away.
_BREAK_ALERT_EVENTS = {
    'break':   'break_running_long',
    'lunch':   'lunch_running_long',
    'meeting': 'meeting_running_long',
}


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
    """Format an integer number of seconds as 'Hh Mm'.

    Negatives are floored to zero. Python's divmod rounds toward negative
    infinity, so divmod(-1, 3600) is (-1, 3599) and a single negative second
    used to render as "-1h 59m" — a two-hour error from one second of clock
    skew, shown in the End Workday summary and the app's Accounted tile.
    A duration display has no meaningful negative value, so clamp rather than
    propagate: the raw *_seconds fields are still in the payload for debugging.
    """
    s = max(0, int(seconds or 0))
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

    def init(self):
        """At most one OPEN session per developer per day, enforced by the database.

        _get_or_open_today used to guard its create with LOCK TABLE ... IN ROW
        EXCLUSIVE MODE, which does not conflict with itself, so a burst of Start
        Workday calls each opened their own session. End Workday closes one, the
        status call still finds another open, and the button stays red.

        Duplicates already in the table are closed first, or the index could not
        be built. The one kept is the one the code has been reading as live
        (search() with _order: latest login_at). The others become zero-length
        auto-closed rows: they add no presence and do not count as "day ended".
        """
        self.env.cr.execute("""
            UPDATE kpi_work_session s
               SET state = 'closed', auto_closed = TRUE, logout_at = s.login_at
             WHERE s.state = 'open'
               AND EXISTS (
                   SELECT 1 FROM kpi_work_session k
                    WHERE k.user_id = s.user_id
                      AND k.session_date = s.session_date
                      AND k.state = 'open'
                      AND (k.login_at > s.login_at
                           OR (k.login_at = s.login_at AND k.id > s.id)))
        """)
        if self.env.cr.rowcount:
            _logger.warning("kpi.work.session: closed %s duplicate open session(s)",
                            self.env.cr.rowcount)
        self.env.cr.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS kpi_work_session_one_open_per_day
                ON kpi_work_session (user_id, session_date) WHERE state = 'open'
        """)

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

    # ---- Revert (admin undo of End Workday) ------------------------------ #
    # End Workday was one-way by design: "one start + one end per day". It still
    # is for the DEVELOPER — these are only ever written by action_revert_day,
    # which is admin-only. They exist so a reopened day is visibly a reopened
    # day and not indistinguishable from one that never ended, because the
    # summary notification for the original close has already gone out and
    # cannot be recalled.
    reverted = fields.Boolean(
        string='Reopened by admin', default=False, readonly=True, copy=False,
        help='An admin reopened this day after it had been explicitly ended.')
    reverted_at = fields.Datetime(string='Reopened At', readonly=True, copy=False)
    reverted_by_id = fields.Many2one(
        'res.users', string='Reopened By', readonly=True, copy=False, ondelete='set null')
    revert_reason = fields.Text(string='Reason for reopening', copy=False)

    # ---- Pause Workday --------------------------------------------------- #
    # Freezing the whole day without ending it. A developer who works to 04:00,
    # stops, and returns at 10:00 the SAME date has no other option: End Workday
    # buries the day (one start + one end), and leaving it open books the six
    # idle hours as unexplained idle time, which reads as a tracking failure.
    # Pausing does not stop Presence — Presence is the raw clock — it moves
    # those hours into `accounted` and takes them off the standard-day check.
    #
    # Deliberately a FLAG beside state='open' rather than a new state value.
    # `state = 'open'` is searched in a dozen places — _get_or_open_today,
    # _day_done, the crons, live_status — and adding 'paused' would silently
    # change every one of them. A flag keeps the blast radius to the code that
    # should actually care.
    is_paused = fields.Boolean(
        string='Workday Paused', default=False, copy=False,
        help="The developer paused their whole workday. Tasks cannot run until "
             "they resume, and Presence stops accruing for as long as it lasts. "
             "The paused time is reported separately, counts towards Accounted "
             "(the day explained) and does not count towards the standard day.")
    paused_at = fields.Datetime(
        string='Paused At', readonly=True, copy=False,
        help="Start of the CURRENT pause. Empty while the workday is running.")
    paused_seconds = fields.Float(
        string='Paused (seconds)', default=0.0, readonly=True, copy=False,
        help="Total of COMPLETED pauses. The open pause is added on the fly by "
             "_compute_totals so a running clock is never written to the row.")

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
    nontask_meeting_with_ids = fields.Many2many(
        'res.users', 'kpi_work_session_nontask_meeting_rel', 'session_id', 'user_id',
        string='Non-task Meeting With', copy=False,
        help='Who the OPEN meeting block is with. Held here for exactly the same '
             'reason as nontask_note: the kpi.nontask.block row does not exist '
             'until the block CLOSES, so the open one lives on the session and is '
             'copied across at that moment. Empty for every reason but meeting.',
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

    # ── Break / lunch / meeting over-run reminders (developer only) ──────────
    # De-duplication state ONLY. Unlike the idle nudges above there is no
    # "..._at" due timestamp, because nothing arms these: _cron_check_long_breaks
    # finds whatever interval is open and derives elapsed time from its own start
    # every sweep. That is what keeps start_break / switch_break /
    # _set_nontask_reason / pause / pause_all / idle_reason free of any change —
    # six call sites that would each have had to remember to arm a timer, and any
    # one of them could have been missed.
    break_alert_key = fields.Char(
        string='Break Alert Key', copy=False,
        help="Which open interval the reminders below were sent for: 'blog:<id>' for "
             "a kpi.break.log, 'blk:<session>:<start>' for an open non-task block. A "
             "CHANGED key means a different interval, which resets the count — this is "
             "what makes switching Break -> Meeting restart the clock at the meeting's "
             "own threshold instead of carrying the break's elapsed time over.",
    )
    break_alert_count = fields.Integer(
        string='Break Reminders Sent', default=0, copy=False,
        help='How many reminders have gone out for the interval in break_alert_key. '
             'Capped at BREAK_ALERT_MAX for repeating kinds; 1 is the cap for the '
             'once-only kinds (lunch / meeting).',
    )
    break_budget_alerted = fields.Boolean(
        string='Break Budget Alerted', default=False, copy=False,
        help="The day's break + lunch total passed res.company.break_budget_minutes "
             'and the developer has been told. Once per day, so it is a flag rather '
             'than a counter.',
    )
    overtime_alerted = fields.Boolean(
        string='Overtime Alerted', default=False, copy=False,
        help='Presence passed res.company.standard_workday_hours and the developer has '
             'been reminded their workday is still open. Once per session.',
    )

    # NOT stored: time-log changes don't propagate through @api.depends so a
    # stored value would freeze at the value at session-creation time.  Read
    # cost is trivial (one search per row), and reports do their own SQL.
    productive_seconds = fields.Float(
        string='Productive (task time)',
        compute='_compute_totals',
    )
    presence_seconds = fields.Float(
        string='Presence (at work)',
        compute='_compute_totals',
    )
    task_count = fields.Integer(
        string='Tasks Touched',
        compute='_compute_totals',
    )

    # Multiple sessions per day are explicitly allowed so a developer can
    # restart a workday after an accidental End Workday.  The only invariant
    # we still enforce is at most ONE 'open' session per user per day: by the
    # partial unique index built in init(), which _get_or_open_today relies on.

    # ------------------------------------------------------------------ #
    # Compute                                                            #
    # ------------------------------------------------------------------ #
    @api.depends('user_id', 'session_date', 'login_at', 'logout_at', 'state',
                 'is_paused', 'paused_at', 'paused_seconds')
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
                # Back-filled work is not time spent in this session.
                ('is_manual', '=', False),
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
                # PRESENCE IS TIME AT WORK: the login -> logout clock MINUS the
                # time the developer deliberately froze the day for. Pause Workday
                # stops this figure — that is the point of pausing.
                #
                # The raw clock is not lost: it is recoverable anywhere as
                # presence + paused, and both halves are carried side by side in
                # every payload that reports either.
                #
                # _paused_total() rather than the stored `paused_seconds`: the
                # CURRENTLY OPEN pause is deliberately never written to the row,
                # so a day read while it is still frozen would otherwise
                # under-subtract by however long the developer has been away.
                span = (end - rec.login_at).total_seconds()
                rec.presence_seconds = max(0.0, span - rec._paused_total())
            except (TypeError, AttributeError):
                # login_at is unset — a session row that exists before the
                # developer has actually logged in. Anything else is a bug and
                # must not be swallowed: a bare `except` here once hid a
                # NameError that zeroed presence on every session in the system.
                rec.presence_seconds = 0.0

    def _paused_total(self):
        """Total paused seconds across this recordset, including an open pause.

        `paused_seconds` on the row only holds COMPLETED pauses — the running
        one is deliberately never written, so a currently-paused day would
        under-report by however long the developer has been away. Every report
        that shows paused time needs the same sum, so it lives here rather than
        being re-derived (three earlier copies had already started to drift).
        """
        total = 0.0
        now = fields.Datetime.now()
        for rec in self:
            total += (rec.paused_seconds or 0.0)
            if rec.is_paused and rec.paused_at:
                end = rec.logout_at or now
                total += max(0.0, (end - rec.paused_at).total_seconds())
        return total

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

        A REVERTED session is excluded for the same reason. An admin reopening a
        day is them saying "that ending does not stand", so it stops counting as
        the developer having ended their day — which is what lets the Start button
        come back. The session itself stays closed: reverting restores the RIGHT
        to start, it does not start anything. Pressing Start is the developer's
        decision and the honest record of when they actually resumed.
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
            ('reverted',     '=', False),
        ], limit=1)

    @api.model
    def _day_done(self, user=None):
        """Boolean form of _ended_session_today — did the developer end their
        own workday today (and so may not start another until tomorrow)?"""
        return bool(self._ended_session_today(user=user))

    @api.model
    def _tasks_missing_progress_today(self, user=None):
        """Tasks this user worked on today with no progress summary from them today.

        What the End Workday screen warns about. A day's work with no note against
        it is invisible to everyone downstream — the manager reads these, and by
        tomorrow nobody can reconstruct what the hours went on.

        Two grouped queries, no per-task loop:

        1. worked today, from kpi.time.log's `work_date`. That field is stored,
           indexed and computed in the DEVELOPER's timezone, so "today" means their
           day, not the server's — which is the whole reason it exists. The active
           rows are included deliberately: a task started an hour ago and still
           running has duration_seconds == 0 and would otherwise be missed, and it
           is exactly the task most likely to have no note yet.
        2. of those, the ones that already carry a summary from this user inside
           their local day. kpi.progress has no work_date of its own, so the window
           is built from the same local-day helpers used elsewhere in this file
           rather than by comparing UTC dates — kpi_employee_report does the latter
           and gets the boundary wrong for anyone not on UTC.

        Whitespace-only summaries are filtered in Python: the model requires the
        field, but " " satisfies that and says nothing.

        Returns [{'kpi_id', 'name', 'external_ref'}], newest task first.
        """
        user = user or self.env.user
        today = fields.Date.context_today(self.with_user(user))
        Log = self.env['kpi.time.log'].sudo()

        worked = Log.read_group(
            [('user_id', '=', user.id), ('work_date', '=', today), ('is_manual', '=', False)],
            ['kpi_id'], ['kpi_id'], lazy=False)
        worked_ids = {g['kpi_id'][0] for g in worked if g.get('kpi_id')}
        if not worked_ids:
            return []

        start = _local_day_start_utc(today, user)
        end = _local_day_end_utc(today, user)
        done = self.env['kpi.progress'].sudo().search([
            ('user_id', '=', user.id),
            ('kpi_id', 'in', list(worked_ids)),
            ('create_date', '>=', start),
            ('create_date', '<=', end),
        ])
        covered = {p.kpi_id.id for p in done if (p.summary or '').strip()}

        missing = worked_ids - covered
        if not missing:
            return []
        return [{
            'kpi_id': k.id,
            'name': k.name or '',
            'external_ref': k.external_ref or '',
        } for k in self.env['kra.kpi'].sudo().browse(sorted(missing, reverse=True)).exists()]

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
        # Parallel Start calls (several tabs, a double click, app + web) race to
        # here. The unique index in init() lets one insert win; the others wait
        # for it to commit and then fail. Under REPEATABLE READ this transaction
        # cannot see the winner's row, so ConcurrencyError hands the request back
        # to Odoo, which retries it with a fresh snapshot that returns that row.
        try:
            with self.env.cr.savepoint():
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
        except pg_errors.UniqueViolation as exc:
            raise ConcurrencyError(
                "Another request opened this workday at the same time") from exc
        # Announce the start to the owner/coordinator feed, but ONLY on the first
        # start of the day. Multiple sessions per day
        # are allowed (restart after an accidental End Workday), and re-announcing
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
                "re-notifying admins or the WhatsApp group",
                new_sess.id, prior_today + 1, user.login)
        else:
            # No WhatsApp group post here any more: the "@Name present 9:30"
            # line is posted by hr_attendance_369_whatsapp when the bridge
            # creates the day's attendance, so every check-in path reports the
            # same way and nothing posts twice.
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
                # The id, not just the name: the strip names the task the break came
                # from, and naming it is not much use without being able to go back
                # to it — the Resume button on the pill needs something to resume.
                'source_task_id': brk.source_task_id.id if brk.source_task_id else False,
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
        done_logs = Log.search([('user_id', '=', user.id), ('work_date', '=', today),
                                ('is_active', '=', False), ('is_manual', '=', False)])
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
        #
        # A PAUSED workday is the same miss one level up. Pausing stops every
        # timer by design, so `active_task` is false and the prompt fired the
        # instant the day was frozen — asking "why is nothing running?" of
        # someone who just answered that question by pausing. Worse than noise:
        # the answers open a break or a non-task block, and action_pause_workday
        # deliberately CLOSES both so the same minutes are not counted as paused
        # and as lunch. Taking the popup up on its offer would recreate the exact
        # double-count the pause code exists to prevent.
        idle_prompt = bool(
            sess and not sess.is_paused
            and not active_task and not nontask and not active_break
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
            'login_raw': login_raw,           # anchor for live Presence (now - login - paused)
            'productive_base': productive_base,  # finished-log seconds; add running task live
            # `is_paused` drives the paused banner and the refused Start buttons.
            #
            # paused_base / paused_since are how a client takes the pause OFF the
            # live Presence clock: base is the completed pauses, since is the open
            # one (false when not paused). BOTH are needed — the open pause is
            # deliberately never written to paused_seconds, so a client reading
            # only base would keep counting Presence straight through the freeze.
            #
            # They were briefly dead, during the period when Presence meant the
            # raw login->logout clock. An older installed build that ignores them
            # just keeps that older behaviour rather than breaking.
            'is_paused': bool(sess and sess.is_paused),
            'paused_base': float(sess.paused_seconds or 0.0) if sess else 0.0,
            'paused_since': ((sess.paused_at.isoformat() + 'Z')
                             if sess and sess.is_paused and sess.paused_at else False),
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
        never actually disable the thing it claimed to control.

        IF YOU RE-ACTIVATE THIS: it pauses the task SILENTLY. The developer is not
        told. There was a full `task_auto_away` notification — recipients, wording,
        title, in-app row, its own config toggle — but nothing ever dispatched it,
        so the toggle promised something that could not happen. It was removed
        rather than left as decoration. Bringing idle pausing back means adding
        `self._notify('task_auto_away', ...)` here and restoring those entries in
        kpi_notify.py; otherwise a developer's timer stops with no explanation."""
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
    # Pause / resume the whole workday                                    #
    # ------------------------------------------------------------------ #
    def action_pause_workday(self, note=''):
        """Freeze the day: stop every running task and stop accruing Presence.

        The gap between End Workday and leaving the day open. Ending buries the
        date (one start + one end), and leaving it open books idle hours as
        Presence — neither is true of "I stopped at 4am and I'm back at 10".

        Reuses _pause_running_task rather than looping over timers again, so the
        multitask handling lives in exactly one place.
        """
        self.ensure_one()
        if self.state != 'open':
            return {'status': False, 'message': 'Your workday is not open.'}
        if self.is_paused:
            return {'status': False, 'message': 'Your workday is already paused.'}
        try:
            self._pause_running_task(reason=('Workday paused'
                                             + (' — %s' % note if note else '')))
        except Exception as exc:
            _logger.warning("pause-workday: stopping tasks failed for %s: %s", self.id, exc)
        # STAMP THE CLOCK **AFTER** PAUSING, NOT BEFORE.
        #
        # _pause_running_task opens an 'away' break using its own, later, now().
        # Taking `now` first and then passing it to stop_break below closed that
        # break at an instant BEFORE it started, writing a negative
        # duration_seconds — which then flowed into `metered` and made the whole
        # day's Accounted total negative ("-1h 59m" in the End Workday summary,
        # because divmod() of a negative rounds the wrong way).
        #
        # It only ever cost a second or two, which is exactly why it survived:
        # big enough to corrupt a sum, too small to notice in a break list.
        now = fields.Datetime.now()
        # STOP EVERYTHING, not just the task timers. An open Break/Lunch or a
        # non-task block would otherwise keep running through the pause, so the
        # same minutes would be counted twice — once as paused, once as lunch —
        # and Accounted would exceed the day. Note _pause_running_task itself
        # opens an 'away' break when it stops a task, so this also closes that.
        try:
            self.env['kpi.break.log'].stop_break(self.user_id.id, at=now)
        except Exception as exc:
            _logger.warning("pause-workday: stop_break failed for %s: %s", self.id, exc)
        try:
            self._close_nontask_block(at=now)
        except Exception as exc:
            _logger.warning("pause-workday: close nontask failed for %s: %s", self.id, exc)
        self.sudo().write({'is_paused': True, 'paused_at': now})
        try:
            self._log_paused_action('workday_paused', note)
        except Exception:
            pass
        return {'status': True, 'is_paused': True,
                'message': "Workday paused. Paused time won't count as worked time."}

    def action_resume_workday(self):
        """Un-freeze the day, so tasks can be started again.

        Tasks stay paused on purpose: resuming the DAY is not the same as
        resuming a TASK, and which one to pick up is the developer's choice.
        """
        self.ensure_one()
        if self.state != 'open':
            return {'status': False, 'message': 'Your workday is not open.'}
        if not self.is_paused:
            return {'status': False, 'message': 'Your workday is not paused.'}
        # Bank the pause that just ended. The elapsed time is added here and the
        # marker cleared, so it can never be counted twice.
        banked = (self.paused_seconds or 0.0)
        if self.paused_at:
            banked += max(0.0, (fields.Datetime.now() - self.paused_at).total_seconds())
        self.sudo().write({'is_paused': False, 'paused_at': False,
                           'paused_seconds': banked})
        try:
            self._log_paused_action('workday_resumed', '')
        except Exception:
            pass
        return {'status': True, 'is_paused': False,
                'message': 'Workday resumed.'}

    def _log_paused_action(self, event, note):
        """Audit pause/resume on any task this developer owns.

        kpi.action.log hangs off a task, not a session, so there is nowhere else
        to put it. Best-effort and never raises: an audit line must not be what
        stops somebody pausing their day.
        """
        self.ensure_one()
        kpi = self.env['kra.kpi'].sudo().search(
            [('user_id', '=', self.user_id.id)], order='id desc', limit=1)
        if kpi:
            kpi._log_action(event, source='web', actor_user_id=self.user_id.id,
                            payload={'session_id': self.id, 'note': note or ''})

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
        # ONE instant for both the session and the task it stops. Two separate
        # now() calls land milliseconds apart, which is enough for the task log to
        # end after logout_at and make Productive a hair larger than Presence —
        # a contradiction in the reconciliation for no reason at all.
        closed_at = fields.Datetime.now()
        self.sudo().write({
            'logout_at': closed_at,
            'state':     'closed',
            'note':      (note or '').strip() or False,
        })
        # Stop a task the developer left running when they pressed End Workday,
        # so its timer is closed at logout instead of accruing forever. Same
        # helper the idle/midnight auto-close use (they call it too), keeping the
        # manual and automatic close paths consistent — without this the task
        # stays in_progress with an open time log and its elapsed time bleeds.
        try:
            self._pause_running_task(reason='Workday ended', at=closed_at)
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
        # Same contract as the start hook: never let a group report affect the
        # workday. Ending a day is one-way, so a raise here would be unrecoverable.
        try:
            self.env['kpi.wa.group.report'].post_workday_end(
                self.user_id,
                fields.Datetime.context_timestamp(
                    self, fields.Datetime.now()).strftime('%I:%M %p · %a %d %b'),
                payload.get('productive_seconds') or 0,
                tasks_touched=payload.get('task_count') or 0,
                note=payload.get('note') or '')
        except Exception as exc:
            _logger.warning("wa group end report failed for session %s: %s", self.id, exc)
        return payload

    # ------------------------------------------------------------------ #
    # Revert — admin reopens a day that was explicitly ended               #
    # ------------------------------------------------------------------ #
    def action_revert_day(self, reason=''):
        """Let a developer start again on a day they had already ended.

        End Workday is one-way for the developer, and stays that way: this is an
        admin action, for the case where somebody pressed it by accident or was
        asked to come back. Everything it can honestly undo, it undoes; the rest
        it declares rather than hides:

        * The ended session stays CLOSED, with its logout_at intact. What comes
          back is the Start button, not the clock — the developer is notified with
          the admin's reason and starts when they are ready, which is the honest
          record of when they actually resumed. Pressing Start opens a fresh
          session for the same date; the day's totals aggregate every session.
        * The task that End Workday paused is deliberately LEFT paused. Its timer
          was closed at logout_at, and silently restarting it would book time
          nobody worked. The developer presses Resume, which is one click and is
          also the honest record of when they actually resumed.
        * The frozen snapshot is kept and marked superseded, not deleted — it is
          the only record of what the day looked like when it was ended, and
          notifications already point at it (kpi.notification.snapshot_id).
        * The daily summary WhatsApp/push has ALREADY been sent to the owner and
          coordinator. It cannot be recalled, so a follow-up goes out saying the
          day was reopened. A silent revert would leave them holding a summary
          that quietly stopped being true.

        Same date only: reopening an older day would let time land on a date the
        reporting has already closed over.
        """
        self.ensure_one()
        if not self.env['kra.kpi'].sudo()._user_is_kpi_admin(self.env.user):
            return {'status': False,
                    'message': 'Only an admin can reopen a workday.'}
        if self.state != 'closed':
            return {'status': False,
                    'message': 'That workday is already open.'}
        if self.session_date != fields.Date.context_today(self):
            return {'status': False,
                    'message': "Only today's workday can be reopened."}
        # REQUIRED. The developer's day just came back to life underneath them and
        # everyone who received the daily summary is about to be told it no longer
        # stands — "an admin reopened it, no reason given" answers nobody. Enforced
        # here and not only in the two dialogs, because this is the rule.
        if not (reason or '').strip():
            return {'status': False,
                    'message': 'Please say why you are reopening this workday — '
                               'the developer is told, in your words.'}
        # An open session for the same developer+date would break the "at most
        # one open session per user per day" invariant _get_or_open_today keeps.
        clash = self.sudo().search_count([
            ('user_id', '=', self.user_id.id),
            ('session_date', '=', self.session_date),
            ('state', '=', 'open'),
        ])
        if clash:
            return {'status': False,
                    'message': 'That developer already has an open workday today.'}

        now = fields.Datetime.now()
        reason = (reason or '').strip()
        # EVERY session that ended the day, not just this one. _ended_session_today
        # reads "day done" as ANY closed, hand-ended, unreverted session today, but
        # hands back only the first. A day with several (a burst of Start clicks
        # once opened six sessions at once, and each was ended) needed one Reopen
        # per session: each click reverted one, the next still counted as "ended",
        # and the header stayed on "Workday ended for today" while the admin
        # assumed the reopen had failed.
        ended = self | self.sudo().search([
            ('user_id', '=', self.user_id.id),
            ('session_date', '=', self.session_date),
            ('state', '=', 'closed'),
            ('auto_closed', '=', False),
            ('reverted', '=', False),
        ])
        ended.sudo().write({
            # The session stays CLOSED, and logout_at is kept. Reverting restores the
            # RIGHT to work today, it does not put the developer back on the clock:
            # they get a notification with the reason and press Start themselves.
            #
            # This used to set state='open', logout_at=False — the day came back to
            # life underneath them with no decision on their part, and the board
            # jumped straight to "End Workday". Worse, the clock was running again
            # from a moment nobody chose, so time could accrue before they had even
            # read the notification. _ended_session_today now ignores a reverted
            # session, which is what brings the Start button back.
            # `note` is deliberately KEPT. It is what the developer typed when
            # they ended the day; deleting it destroys their words to tidy up a
            # field that action_end_day will overwrite on the next close anyway.
            #
            # last_heartbeat / idle_check_at are NOT re-armed any more: the idle
            # sweep only looks at open sessions, so setting them on a closed one
            # was inert, and it implied a clock that is not running.
            'reverted':       True,
            'reverted_at':    now,
            'reverted_by_id': self.env.user.id,
            'revert_reason':  reason or False,
        })

        # Keep the frozen image, but stop it being read as the final word. The
        # snapshot is keyed by developer + day (one row per day, redrawn on each
        # close), not by session. _capture clears the flag on the next close.
        try:
            self.env['kpi.workday.snapshot'].sudo().search([
                ('user_id', '=', self.user_id.id),
                ('session_date', '=', self.session_date),
            ]).write({
                'superseded': True,
                # Stamp the reason NOW, not only when the day is next ended.
                # _capture also copies it, but that runs on the next close — so
                # between the reopen and the re-end there was a superseded snapshot
                # with nothing anywhere saying who reopened it or why, which is
                # exactly the window someone goes looking.
                'reopen_reason': (reason or '').strip() or False,
                'reopened_by_id': self.env.user.id,
                'reopened_at': now,
            })
        except Exception as exc:
            _logger.warning("revert: snapshot supersede failed for session %s: %s",
                            self.id, exc)

        try:
            self._log_paused_action('workday_reverted', reason)
        except Exception:
            pass

        try:
            self._fire_workday_reverted(reason)
        except Exception as exc:
            _logger.warning("workday_reverted notification failed: %s", exc)

        return {'status': True,
                'session_id': self.id,
                'message': 'The developer can start their workday again. They have been '
                           'told why, and the day starts when they press Start.'}

    def _fire_workday_reverted(self, reason=''):
        """Tell the developer and the admins that an ended day was reopened.

        The developer needs it because their day silently became live again; the
        admins need it because they are holding a daily summary that has just
        stopped being final.
        """
        self.ensure_one()
        u = self.user_id
        ctx = {
            'dev':          u.name or u.login or '—',
            'session_date': str(self.session_date),
            'admin':        self.env.user.name or self.env.user.login or '—',
            # action_revert_day refuses an empty one, so this is always the
            # admin's actual words — no "no reason given" fallback to fall into.
            'reason':       (reason or '').strip(),
        }
        Kpi = self.env['kra.kpi'].sudo()
        any_kpi = Kpi.search([('user_id', '=', u.id)], order='id desc', limit=1) \
            or Kpi.search([], order='id desc', limit=1)
        if not any_kpi:
            _logger.info("workday_reverted: no kra.kpi to anchor _notify on")
            return
        any_kpi._notify('workday_reverted', extra_users=[u.id], **ctx)

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
            # Drop the over-run reminder state too. The day may be reverted later,
            # which makes this same session live again — and it must not come back
            # still holding "we already told them" from the first time round.
            self._clear_break_alerts('workday ended')
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
                # Back-filled work did not happen inside this session.
                ('is_manual', '=', False),
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
        # Time the developer deliberately froze the day for. Reported on its own
        # line rather than dropped: a six-hour hole with no explanation reads as
        # a tracking failure to whoever reviews the day. Presence EXCLUDES it —
        # presence is time at work — so it is added to `accounted` and left
        # out of `other_idle` below.
        paused_secs = sessions._paused_total()
        # The wall clock: presence as it stood before the pauses came off it. The
        # day reconciles against THIS rather than against presence, now that the
        # paused minutes sit outside presence — see `other_idle` below.
        raw_span   = presence + paused_secs

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

        # The day's total is MEASURED, not added up.
        #
        # `productive` is already a de-duplicated union (see above), but `metered`
        # is a plain SUM of break-log and block durations, and nothing kept the two
        # from covering the same minutes. Adding them counted a pause left open
        # across task work twice: a real day reported Accounted 12h29m against
        # Presence 9h38m, and the max(0.0, ...) below floored the negative residual
        # to zero so nothing ever said so. It is the same defect the per-task sum
        # had, one level up — and the same cure: measure the union.
        #
        # Clipped to the presence spans so a break still running past logout, or a
        # block that outlived its session, cannot inflate the day beyond the clock.
        spans = [(s.login_at, s.logout_at or _now) for s in sessions if s.login_at]

        def _clip(intervals):
            out = []
            for start, end in intervals:
                if not start:
                    continue
                end = end or _now
                for span_start, span_end in spans:
                    lo, hi = max(start, span_start), min(end, span_end)
                    if hi > lo:
                        out.append((lo, hi))
            return out

        explained = _clip(
            list(all_intervals)
            + [(b.start_time, _now if b.is_active else b.end_time)
               for b in blogs if b.start_time]
            + [(bk['start_at'], _now if bk.get('open') else bk.get('end_at'))
               for bk in blocks if bk.get('start_at')]
        )
        # Paused cannot join the union: only COMPLETED pauses are kept, and as a
        # single total on the session rather than intervals (see _paused_total), so
        # there is nothing to merge. It is added, and the result held to the clock.
        accounted = _measure(explained) + paused_secs
        # Held to the RAW SPAN, not to presence. Accounted legitimately exceeds
        # presence on any paused day — that is the shape of the two figures now:
        # presence is time at work, accounted is the day explained, and the pause
        # is exactly the difference. Clamping at presence would delete the gap
        # this pair exists to show.
        #
        # Against the raw span it is still impossible, and now means something
        # sharper than it used to: nothing may run during a pause —
        # action_pause_workday closes tasks, breaks and blocks before it stamps
        # paused_at — so an overshoot here is an interval that survived one.
        # An orphaned open kpi.time.log is the known path.
        if accounted > raw_span:
            # Previously invisible: the overshoot landed in a negative residual
            # that max(0.0, ...) silently swallowed, so the only symptom was a
            # total that looked wrong to a human. Say it out loud instead — this
            # line is what identifies the workflow path that left an interval
            # open, which the arithmetic below can correct but not prevent.
            _logger.warning(
                "workday accounted (%.0fs) exceeds the clock (%.0fs) by %.0fs for "
                "user=%s date=%s — some interval is counted twice or ran through "
                "a pause; look for a break, block or time-log left open",
                accounted, raw_span, accounted - raw_span,
                self.user_id.login, self.session_date)
            accounted = raw_span
        # Residual idle = time AT WORK not covered by productive work or any
        # metered reason. The pause is taken back OFF `accounted` here because it
        # is no longer inside presence: comparing the two directly would subtract
        # a pause from a figure that never contained it, and every paused day
        # would produce a negative residual floored to zero.
        #
        # The day still reconciles exactly, one level up:
        #     accounted + other_idle == raw_span
        other_idle = max(0.0, presence - (accounted - paused_secs))

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
                'with': n.get('with') or '',  # meeting participants, if any
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
            # ONE figure for "time that is accounted for": the wall clock COVERED
            # by task work, meetings, lunch, breaks, no-tasks and away/other, plus
            # PAUSED. Measured as a union above — minutes explained by two things
            # at once (a pause left open across task work) are counted once.
            #
            # Paused belongs here because this is the DAY EXPLAINED, not the time
            # worked. Presence is the time worked, and the pause is exactly the
            # difference between the two — which is why accounted can, and on a
            # paused day should, read HIGHER than presence.
            #
            # It is the counterpart to other_idle, and the two are what reconcile
            # the day: accounted + other_idle == raw_span, always. That holds by
            # construction rather than by trusting the buckets not to overlap,
            # which is what it used to rest on — and what broke it.
            'accounted_seconds':  float(accounted),
            'accounted_display':  _fmt_hms(accounted),
            # Workday paused (e.g. stopped at 04:00, back at 10:00). OUTSIDE
            # presence — presence stops while the day is frozen — and inside
            # accounted, so this figure IS the gap between those two numbers.
            'paused_seconds':     float(paused_secs),
            'paused_display':     _fmt_hms(paused_secs),
            # A normal working day vs what was actually here. Decided ONCE, server
            # side, so the app, the web popup and the saved image can never render
            # a different verdict for the same day.
            'standard_hours':     float(std_hours),
            'standard_display':   _fmt_hms(std_seconds),
            # Judged on WORKED time. Presence already excludes paused time, so
            # this is a plain comparison now — subtracting the pause a second
            # time here would deduct it twice and fail a day that actually met
            # the standard.
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

        # Raw UTC instants beside the formatted `time`, so a renderer can draw the
        # day to scale and see the gaps between nodes. Additive: every existing
        # reader (the snapshot image, the web popup) keeps using `time`.
        def _ts(dt):
            return fields.Datetime.to_string(dt) if dt else ''

        _far = fields.Datetime.now()
        # Same clock for every "still running" duration on this Map, so two chips
        # drawn in one render can't disagree by a few milliseconds.
        _now_ts = _far
        nodes = []

        # Start node
        if first_login:
            nodes.append({'kind': 'start', 'icon': '🌅', 'label': 'Started workday',
                          'time': _hm(first_login), 'ts': _ts(first_login),
                          '_sort': first_login})

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
            t_running = outcome == 'active'
            t_secs = (max(0.0, ((_now_ts if t_running else end) - start).total_seconds())
                      if start and (end or t_running) else 0.0)
            nodes.append({
                'kind': 'task', 'icon': '🛠',
                'ref': s['ref'], 'name': s['name'] or '',
                'task_id': s['kpi_id'],
                'label': (str(s['ref']) + ' ' + (s['name'] or '')).strip(),
                'time': _range(start, end), 'outcome': outcome, 'reason': reason,
                'start_ts': _ts(start), 'end_ts': '' if t_running else _ts(end),
                'seconds': t_secs, 'duration_display': _fmt_hms(t_secs),
                'running': t_running,
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
                # Who a meeting was with. Its own key rather than glued into
                # `reason`, so every renderer can lay the two out as it likes —
                # and so the 60-char note budget stays the note's alone.
                'with': (b.meeting_with_display or '').strip(),
                'running': b_running,
                'from': b.source_task_id.name if b.source_task_id else '',
                'start_ts': _ts(b.start_time),
                'end_ts': '' if b_running else _ts(b.end_time),
                'seconds': b_secs,
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
                'start_ts': _ts(bk['start_at']),
                'end_ts': '' if running else _ts(bk.get('end_at')),
                'seconds': bk.get('seconds') or 0,
                '_sort': bk['start_at'] or first_login or _far,
            })

        nodes.sort(key=lambda n: n['_sort'] or _far)

        # Number every node per type, in the order the day actually happened:
        #   Meeting 1 -> Task 1 -> Break 1 -> No tasks 1 -> Task 2 -> Break 2 ...
        # AFTER the sort, so numbers follow the clock and not the query order.
        # Start/End are never numbered — there is only one of each.
        _seq = {}
        _visits = {}
        for n in nodes:
            key = 'task' if n['kind'] == 'task' else n.get('break_type')
            if not key:
                continue
            _seq[key] = _seq.get(key, 0) + 1
            n['seq'] = _seq[key]
            if n['kind'] == 'task':
                # Which time today THIS task is being worked: "Task 5" alone hides
                # that it is the same task as Task 1 picked up again.
                _visits[n['task_id']] = _visits.get(n['task_id'], 0) + 1
                n['visit'] = _visits[n['task_id']]
                # Keep the task's identity — an admin reading the saved image must
                # still be able to tell WHICH task this was.
                n['label'] = ('Task %d · %s' % (_seq[key], n['label'])).strip()
            else:
                n['label'] = '%s %d' % (n['label'], _seq[key])

        # End node — always last, and never numbered.
        if last_logout:
            nodes.append({'kind': 'end', 'icon': '🌙', 'label': 'Ended workday',
                          'time': _hm(last_logout), 'ts': _ts(last_logout)})
        else:
            nodes.append({'kind': 'end', 'icon': '⏳', 'label': 'Still working', 'time': '',
                          'ts': ''})

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
    def _pause_running_task(self, reason='Workday ended (auto)', at=None):
        """Pause this developer's in-progress task(s), recorded as non-productive
        'away' time. Used by the midnight auto-close so a task left running when
        the day rolls over is stopped.

        EVERY running task, not just the first: a developer with
        kpi_allow_multitask can have two timers going, and pausing one of them
        left the other's kpi.time.log open across the close — an open segment
        with no end, which the next day then counts as live work.

        `at` CAPS when the work stopped. The midnight close must pass its local
        day-end: without it the log closed at now(), so a cron firing hours late
        credited that gap as task time to a session already ended, and Accounted
        came out larger than Presence. A live pause passes nothing, because for a
        developer pressing Pause now() IS the answer."""
        self.ensure_one()
        Log = self.env['kpi.time.log'].sudo()
        for active_log in Log.search([('user_id', '=', self.user_id.id),
                                      ('is_active', '=', True)]):
            task = active_log.kpi_id
            if task and task.task_state == 'in_progress':
                task.with_user(self.user_id).pause_task(
                    reason=reason, reason_code='away', at=at)

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

    def _close_one_overdue(self, s):
        """Close ONE straggler — the whole body of the old _close_overdue loop.

        Split out so the caller can wrap each session in its own savepoint: a
        failure here used to abort the transaction and take every session still
        queued in that run down with it."""
        # logout_at = end of session_date IN THE DEVELOPER'S TIMEZONE — caps
        # presence growth. session_date is a local date, so a naive combine
        # stored as UTC put this 05:29 the next morning for IST and inflated
        # every auto-closed cross-midnight day by the offset.
        #
        # COMPUTED FIRST, because the task pause below has to close at the
        # SAME instant the session does. It used to be computed after, so
        # _pause_running_task() stamped now() while logout_at got the day-end:
        # a cron firing late then recorded task time after the session had
        # ended. One real case ran a log to 13h07m against a 5h20m session,
        # which pushed Accounted above Presence and floored other_idle to 0 —
        # silently, on the screen whose whole job is to reconcile.
        eod = _local_day_end_utc(s.session_date, s.user_id)
        # Stop a task the developer left running when the day rolled over,
        # capped at that same day-end.
        try:
            s._pause_running_task(at=eod)
        except Exception as exc:
            _logger.warning("overdue-close pause failed for session %s: %s", s.id, exc)
        # Bank a pause that was never resumed BEFORE anything reads presence.
        # "Paused at 04:00 and went to bed" is the case this exists for: the
        # pause has to end at the same instant the day does, or presence for
        # the date is computed against a pause with no end.
        if s.is_paused and s.paused_at:
            s.sudo().write({
                'is_paused': False,
                'paused_at': False,
                'paused_seconds': (s.paused_seconds or 0.0)
                                  + max(0.0, (eod - s.paused_at).total_seconds()),
            })
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

    @api.model
    def _close_overdue(self):
        """Close every OPEN session whose day has ENDED in the DEVELOPER'S OWN
        timezone (it crossed midnight): pause a task they left running, close it
        (cap logout at that day's 23:59:59), fire the daily summary, and notify
        them it was auto-closed. Idempotent — safe to run frequently.
        Returns the number actually closed.
        """
        # The day is over WHEN IT IS OVER FOR THE DEVELOPER, not for UTC. This
        # filtered on `session_date < fields.Date.context_today(self)`, and in a
        # cron self.env.user is __system__ — whose tz is EMPTY — so 'today'
        # resolved in UTC. For an Asia/Kolkata team that date cannot roll over
        # before 05:30 local, which made local midnight structurally unreachable:
        # the 5-minute cron ran ~66 times between 00:00 and 05:29 IST and closed
        # nothing. Measured in production, days were closing 9-11 hours late.
        #
        # The SQL stays a cheap indexed superset (no timezone is a full day from
        # UTC); _local_day_end_utc then decides per developer. Sharing that helper
        # is the point — it is the same one that computes the cap written to
        # logout_at, so 'is this day over' can no longer disagree with the instant
        # we stamp as its end.
        now = fields.Datetime.now()
        stragglers = self.sudo().search([
            ('state', '=', 'open'),
            ('session_date', '<=', fields.Date.context_today(self)),
        ]).filtered(lambda s: s.session_date
                    and now >= _local_day_end_utc(s.session_date, s.user_id))
        closed = 0
        for s in stragglers:
            # One savepoint per session. Without it a single failure — a duplicate
            # snapshot was the real case — aborted the whole transaction, and every
            # session still queued in this run died on 'current transaction is
            # aborted' rather than being closed.
            try:
                with self.env.cr.savepoint():
                    self._close_one_overdue(s)
                closed += 1
            except Exception as exc:
                _logger.exception("overdue-close failed for session %s: %s", s.id, exc)
        return closed

    def _close_one_idle(self, s):
        """Close ONE forgotten workday — the body of the _close_idle_workdays loop.

        Split out for the same reason as _close_one_overdue: so each session can
        run inside its own savepoint and a failure cannot poison the rest."""
        # Cap logout at the last heartbeat (last time the dev was present), not
        # now — the idle window is not working time.
        #
        # The SAME cap has to reach the task pause, and computing it here is
        # what lets it. Previously logout_at was capped but the running
        # kpi.time.log still closed at now(), so the idle window this code
        # exists to exclude was counted as task time anyway — the comment
        # above was true of the session and false of the work.
        cap = s.last_heartbeat or now
        try:
            s._pause_running_task(at=cap)
        except Exception as exc:
            _logger.warning("idle-close pause failed for session %s: %s", s.id, exc)
        s.write({
            'logout_at':   cap,
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
            # Own savepoint per session, matching _close_overdue — one failure
            # must not abort the transaction the remaining sessions still need.
            try:
                with self.env.cr.savepoint():
                    self._close_one_idle(s)
                closed += 1
            except Exception as exc:
                _logger.exception("idle-close failed for session %s: %s", s.id, exc)
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
        # but never opened the dashboard. Back-filled (is_manual) time is not a
        # sign anyone was at work today, so it never invents a session.
        Log = self.env['kpi.time.log'].sudo()
        rows = Log.read_group(
            domain=[('work_date', '=', today), ('is_active', '=', False),
                    ('is_manual', '=', False)],
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
                ('is_manual', '=', False),
            ], order='start_time asc', limit=1)
            last = Log.search([
                ('user_id', '=', uid),
                ('work_date', '=', today),
                ('is_manual', '=', False),
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
                # Draw and store the day BEFORE sending it. This path had no
                # _capture_snapshot at all, so a developer who logged task time
                # but never opened the board got a WhatsApp summary and no saved
                # snapshot — the only auto-close route still missing one after
                # the July fix, and the cause of both remaining gaps in the data
                # (2026-07-29 and 2026-07-31). Same order as _close_one_overdue.
                snap = new_s._capture_snapshot(payload)
                new_s._fire_daily_summary(payload, snapshot=snap)
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
            # Carried across at exactly the moment the row comes into existence,
            # like `note` above. Only meaningful for a meeting; the setter already
            # clears it for every other reason, so no filter is needed here.
            'meeting_with_user_ids': [(6, 0, self.nontask_meeting_with_ids.ids)],
        })
        _logger.info("non-task block closed: %s %s → %s (%s)",
                     self.user_id.login, self.nontask_started_at, end, self.nontask_reason)
        self.sudo().write({'nontask_started_at': False, 'nontask_reason': False,
                           'nontask_note': False,
                           'nontask_meeting_with_ids': [(5, 0, 0)]})
        return True

    def _set_nontask_reason(self, reason, note='', meeting_with_ids=None):
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
        # Attendees belong to a MEETING and nothing else, and they are rewritten on
        # every call rather than merged: switching Meeting → Break → Meeting must
        # not silently carry the first meeting's people into the second. Replacing
        # with an empty list for a non-meeting reason is what clears them.
        vals['nontask_meeting_with_ids'] = [
            (6, 0, list(meeting_with_ids or []) if reason == 'meeting' else [])
        ]
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

    # ------------------------------------------------------------------ #
    # Break / lunch / meeting over-run reminders                         #
    # ------------------------------------------------------------------ #
    # All of these go to the DEVELOPER and nobody else. The rule is stated on
    # kpi.nontask.block.reason and it holds here: telling an admin about someone's
    # lunch is the false alarm that makes the whole feed worth ignoring. Admins can
    # already SEE a long break live on /kpi_owner/live_tracking if they look — what
    # was missing is the person on the break being told while they can still act.

    def _open_nonproductive(self):
        """The one open break/lunch/meeting for this developer, or None.

        Returns (key, kind, start_at). There are two places an open interval can
        live and they are NOT interchangeable:

          * kpi.break.log with is_active=True — paused FROM a running task.
          * nontask_reason + nontask_started_at on this session — declared with no
            task running. The kpi.nontask.block row does not exist until the block
            CLOSES, so the open one is only ever readable here.

        Checking the break log first matches _daily_summary_payload, which sums
        both and treats a live break log as the more specific record.

        The key identifies the interval so the caller can tell "still the same
        break" from "a different one". switch_break SPLITS rather than relabels
        (see kpi_break_log.switch_break), so Break -> Meeting yields a new row and
        therefore a new key; start_break REUSES the open row, so re-entering the
        same break keeps its key and its count.
        """
        self.ensure_one()
        blog = self.env['kpi.break.log'].sudo().search([
            ('user_id', '=', self.user_id.id),
            ('is_active', '=', True),
        ], limit=1)
        if blog and blog.start_time:
            return 'blog:%s' % blog.id, blog.break_type, blog.start_time
        if self.nontask_started_at and self.nontask_reason:
            # The block has no id of its own yet, so the start instant is what
            # makes the key unique — _set_nontask_reason rewrites it when the
            # reason changes, which is exactly the reset we want.
            return ('blk:%s:%s' % (self.id, self.nontask_started_at),
                    self.nontask_reason, self.nontask_started_at)
        return None

    def _break_budget_seconds(self):
        """Break + lunch for the whole day, counting an OPEN one live.

        MUST agree with the break_secs + lunch_secs lines in
        _daily_summary_payload — if the developer is told they have used an hour,
        the End Workday summary has to say the same thing or the reminder reads as
        a bug. That method computes the identical two buckets through local
        closures (_log / _blk / _blog_secs) which cannot be called from out here,
        and it is a 200-line function that is not worth refactoring for this. So
        this is a deliberate second implementation of the same sum: change one,
        change the other.

        Meetings are excluded on purpose. A meeting is work you were called into,
        not break time, and counting it toward a break budget would punish people
        for being invited to things.
        """
        self.ensure_one()
        kinds = ('break', 'lunch')
        now = fields.Datetime.now()
        total = 0.0

        # Breaks taken FROM a task, anywhere in this developer's day.
        for b in self.env['kpi.break.log'].sudo().search([
            ('user_id', '=', self.user_id.id),
            ('work_date', '=', self.session_date),
            ('break_type', 'in', kinds),
        ]):
            if b.is_active and b.start_time:
                total += max(0.0, (now - b.start_time).total_seconds())
            else:
                total += b.duration_seconds or 0.0

        # Blocks declared with no task running. Closed rows only — the open one
        # lives on the session and is added after this.
        for bk in self.env['kpi.nontask.block'].sudo().search([
            ('user_id', '=', self.user_id.id),
            ('session_id.session_date', '=', self.session_date),
            ('reason', 'in', kinds),
        ]):
            total += bk.seconds or 0.0

        # ...and the still-open block, which has no row yet.
        if self.nontask_started_at and self.nontask_reason in kinds:
            total += max(0.0, (now - self.nontask_started_at).total_seconds())

        return total

    def _break_ctx(self, **extra):
        """Context for the over-run templates. Mirrors _idle_ctx."""
        self.ensure_one()
        u = self.user_id
        ctx = {'dev': u.name or u.login or '-'}
        ctx.update(extra)
        return ctx

    def _fire_break_alert(self, event, **ctx):
        """Send one over-run reminder to the developer.

        Same shape as _fire_idle_check, and for the same reason: extra_users, NOT
        the role matrix. _notify lives on kra.kpi and the anchor may be a task that
        belongs to somebody else entirely, so resolving 'developer' from it would
        send this person's lunch reminder to a stranger.
        """
        self.ensure_one()
        anchor = self._anchor_kpi()
        if not anchor:
            _logger.info("break alert %s: no kra.kpi to anchor _notify on", event)
            return False
        anchor._notify(event, extra_users=[self.user_id.id], **self._break_ctx(**ctx))
        return True

    def _clear_break_alerts(self, reason=''):
        """Forget every over-run reminder for this session.

        Called when the day ends or is reopened: a reverted day becomes live again
        underneath the developer, and it must not still be holding "we already told
        them" flags from the first time round.
        """
        self.ensure_one()
        vals = {}
        if self.break_alert_key:
            vals['break_alert_key'] = False
        if self.break_alert_count:
            vals['break_alert_count'] = 0
        if self.break_budget_alerted:
            vals['break_budget_alerted'] = False
        if self.overtime_alerted:
            vals['overtime_alerted'] = False
        if vals:
            _logger.info("break alerts cleared for %s (%s)", self.user_id.login, reason)
            self.sudo().write(vals)

    def _company_minutes(self, field_name):
        """A threshold in minutes off the company, 0 = OFF.

        `or default` is deliberately NOT used anywhere near these: 0 is a real,
        meaningful value here (the feature is switched off) and `or` would quietly
        switch it back on. Same trap res.company.admin_accept_minutes documents.
        """
        self.ensure_one()
        try:
            company = self.user_id.company_id or self.env.company
            return max(0, int(getattr(company, field_name, 0) or 0))
        except Exception:
            return 0

    def _check_open_interval_alert(self, now):
        """Reminder 1: the interval open RIGHT NOW has run long. True if sent."""
        self.ensure_one()
        open_interval = self._open_nonproductive()
        if not open_interval:
            # Nothing open -> drop the de-dup state so the next break starts clean.
            if self.break_alert_key or self.break_alert_count:
                self.sudo().write({'break_alert_key': False, 'break_alert_count': 0})
            return False

        key, kind, start_at = open_interval

        # A different interval than the one we last pinged about -> start over.
        # This is what makes Break -> Meeting restart at the meeting's threshold.
        count = self.break_alert_count
        if key != self.break_alert_key:
            count = 0
            self.sudo().write({'break_alert_key': key, 'break_alert_count': 0})

        rule = _BREAK_ALERT_RULES.get(kind)
        if not rule:
            return False
        field_name, repeats = rule
        limit_min = self._company_minutes(field_name)
        if not limit_min:
            return False

        # A multitasking developer can pause task A for a break while task B keeps
        # running. They are plainly still working, and telling them to get back to
        # work would be both wrong and annoying. Only applies to the break-log leg:
        # a non-task block by definition has no task running.
        if key.startswith('blog:') and self._has_running_task():
            return False

        elapsed = max(0.0, (now - start_at).total_seconds())
        cap = BREAK_ALERT_MAX if repeats else 1
        if count >= cap:
            return False
        # Repeating: due at limit, 2*limit, 3*limit... Once-only: due at limit.
        # Derived from elapsed rather than a stored due-timestamp, so there is no
        # second piece of state that can drift out of step with the interval.
        due_at = (count + 1) * limit_min * 60 if repeats else limit_min * 60
        if elapsed < due_at:
            return False

        event = _BREAK_ALERT_EVENTS.get(kind)
        if not event:
            return False
        if not self._fire_break_alert(
                event,
                elapsed=_format_elapsed_seconds(elapsed),
                limit=_format_elapsed_seconds(limit_min * 60)):
            return False
        self.sudo().write({'break_alert_key': key, 'break_alert_count': count + 1})
        return True

    def _check_break_budget_alert(self, now):
        """Reminder 2: break + lunch for the DAY has added up. True if sent."""
        self.ensure_one()
        if self.break_budget_alerted:
            return False
        limit_min = self._company_minutes('break_budget_minutes')
        if not limit_min:
            return False
        used = self._break_budget_seconds()
        if used < limit_min * 60:
            return False
        if not self._fire_break_alert(
                'break_budget_exceeded',
                elapsed=_format_elapsed_seconds(used),
                limit=_format_elapsed_seconds(limit_min * 60)):
            return False
        self.sudo().write({'break_budget_alerted': True})
        return True

    def _check_overtime_alert(self, now):
        """Reminder 3: the workday is still open past a normal day. True if sent.

        Not about breaks at all — it is here because the same sweep already has the
        open sessions in hand. It exists because _cron_close_overdue_workdays will
        eventually close the day FOR them and stamp auto_closed, silently rewriting
        their hours. Being told first is what makes that recoverable.
        """
        self.ensure_one()
        if self.overtime_alerted or self.is_paused:
            return False
        try:
            company = self.user_id.company_id or self.env.company
            hours = float(company.standard_workday_hours or 0.0)
        except (TypeError, ValueError, AttributeError):
            return False
        if hours <= 0:
            return False
        # Cheap gate before the expensive one. presence_seconds is a NON-stored
        # compute that runs a kpi.time.log search per session, and this sweep is
        # every minute for everyone currently at work. Presence can never exceed
        # the raw login->now clock (it only ever subtracts pauses), so if the raw
        # clock is still short of a full day, presence certainly is — and for most
        # of most days that is the answer, reached without touching the compute.
        if not self.login_at:
            return False
        if (now - self.login_at).total_seconds() < hours * 3600:
            return False
        # presence_seconds already subtracts paused time (see _compute_totals) —
        # recomputing the span here would count a frozen day as worked.
        if (self.presence_seconds or 0.0) < hours * 3600:
            return False
        if not self._fire_break_alert(
                'workday_overtime',
                elapsed=_format_elapsed_seconds(self.presence_seconds or 0.0),
                limit=_format_elapsed_seconds(hours * 3600)):
            return False
        self.sudo().write({'overtime_alerted': True})
        return True

    @api.model
    def _cron_check_long_breaks(self):
        """Three developer-only reminders, one sweep (data/kpi_break_alert_cron.xml).

        1. The break / lunch / meeting open RIGHT NOW has run past its limit.
        2. Break + lunch for the whole day has added up past the budget.
        3. The workday is still open past a normal day's presence.

        Nothing arms any of these: each check derives its own timing from the
        interval or total it is about, so no other code path has to remember to
        start a timer. The cron runs every MINUTE — unlike the idle sweep, the
        interval here is close to the real resolution, because a "30 minute"
        reminder that lands at 35 minutes is not a 30-minute reminder.

        Shaped like _cron_check_idle_developers: one search, per-record try/except
        so a single bad session cannot kill the run, counters returned.
        """
        now = fields.Datetime.now()
        interval = budget = overtime = 0

        for s in self.sudo().search([('state', '=', 'open')]):
            try:
                if s._check_open_interval_alert(now):
                    interval += 1
                if s._check_break_budget_alert(now):
                    budget += 1
                if s._check_overtime_alert(now):
                    overtime += 1
            except Exception as exc:
                _logger.warning("break alert sweep failed for session %s: %s", s.id, exc)

        return {'interval': interval, 'budget': budget, 'overtime': overtime}
