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

    # 🆕 Part C: auto-away. The board POSTs a heartbeat ~every 60s; the auto-away
    # cron pauses the running task when this goes stale. awayed_task_id lets the
    # board offer a one-click Resume when the developer comes back.
    last_heartbeat = fields.Datetime(string='Last Heartbeat', index=True)
    leaving_at = fields.Datetime(
        string='Board Leaving At', readonly=True,
        help="Stamped when the board tab is closed/left (a beacon). If the board "
             "doesn't re-appear (heartbeat) within a few seconds, the device is "
             "un-paired so the app returns to the PIN screen. A refresh re-heartbeats "
             "and clears this → stays paired.")
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
            rec.productive_seconds = sum(logs.mapped('duration_seconds'))
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
                          'end_time': datetime.combine(lg.work_date, time(23, 59, 59))})
            for bk in self.env['kpi.break.log'].sudo().search([
                    ('user_id', '=', user.id), ('is_active', '=', True),
                    ('start_time', '<', datetime.combine(today, time(0, 0)))]):
                bk.write({'is_active': False,
                          'end_time': datetime.combine(bk.start_time.date(), time(23, 59, 59))})
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
        """Bump today's open session heartbeat. If the auto-away cron paused a task
        while the developer was gone, report it once (and clear the flag) so the
        board can offer a one-click Resume.

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
        if sess.leaving_at:
            vals['leaving_at'] = False   # board is present → cancel any pending leave
        sess.sudo().write(vals)
        # Tell the web board whether the device is still paired — if auto-away
        # un-paired it, the board falls back to the PIN gate.
        paired = self.env['kpi.pair'].sudo().is_paired(user)
        return {'status': True, 'was_away': was_away, 'paired': paired,
                'awayed_task_id': awayed_id, 'awayed_task_name': awayed_name}

    @api.model
    def _mark_leaving(self, user):
        """The board tab is leaving (close / Back / nav away). Stamp `leaving_at`
        so kpi.pair un-pairs the device in a few seconds → the app returns to the
        PIN screen. A page REFRESH reloads and heartbeats within that window,
        clearing the stamp so it stays paired. Never opens a session."""
        sess = self.sudo().search([
            ('user_id', '=', user.id),
            ('session_date', '=', fields.Date.context_today(self)),
            ('state', '=', 'open'),
        ], limit=1)
        if sess and not sess.leaving_at:
            sess.sudo().write({'leaving_at': fields.Datetime.now()})
        return {'status': True}

    @api.model
    def live_status(self, user=None):
        """Data for the live activity strip: the running task, the active break
        (with source task + start clock), and the day's presence/productive anchors.
        Datetime anchors are raw Odoo strings so the client ticks them the same way
        getDisplayTime() ticks a running task."""
        user = user or self.env.user
        Log = self.env['kpi.time.log'].sudo()
        Break = self.env['kpi.break.log'].sudo()

        active_log = Log.search([('user_id', '=', user.id), ('is_active', '=', True)], limit=1)
        task = active_log.kpi_id if active_log else False
        active_task = False
        if task:
            active_task = {
                'id': task.id,
                'name': task.name or '',
                # Same ISO+Z serialization the tasks payload uses so the client
                # ticks it identically to getDisplayTime (UTC-safe).
                'timer_start': (task.timer_start_datetime.isoformat() + 'Z') if task.timer_start_datetime else False,
                'timer_total_seconds': task.timer_total_seconds or 0.0,
                'task_state': task.task_state or '',
            }

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
        productive_base = sum(done_logs.mapped('duration_seconds'))

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
            'active_break': active_break,
            'nontask': nontask,
            'idle_prompt': idle_prompt,
            'idle_prompt_seq': idle_prompt_seq,
            'login_raw': login_raw,           # anchor for live Presence (now - login)
            'productive_base': productive_base,  # finished-log seconds; add running task live
        }

    @api.model
    def _cron_auto_away(self):
        """Pause the running task of any developer whose board heartbeat has gone
        stale (tab closed / idle) beyond company.away_after_minutes. The pause uses
        reason_code='away' → NON-productive time recorded in kpi.break.log, never
        kpi.time.log. Records the paused task on the session so the board can Resume."""
        now = fields.Datetime.now()
        today = fields.Date.context_today(self)
        try:
            minutes = max(1, int(self.env.company.away_after_minutes or 5))
        except Exception:
            minutes = 5
        cutoff = now - timedelta(minutes=minutes)
        stale = self.sudo().search([
            ('state', '=', 'open'),
            ('session_date', '=', today),
            ('last_heartbeat', '!=', False),
            ('last_heartbeat', '<', cutoff),
        ])
        for s in stale:
            try:
                self._away_now(s.user_id, source='cron')
            except Exception as exc:
                _logger.warning("auto-away failed for session %s: %s", s.id, exc)

    @api.model
    def _away_now(self, user, source='cron'):
        """Put `user` into 'away': pause their running task (non-productive),
        record it on the open session for one-click Resume, un-pair the device
        (→ PIN gate on web / PIN screen on app), and notify (→ app push).

        Shared by the auto-away cron AND the on-demand /kpi_action/leave route
        (fired when the developer closes/leaves the board). Idempotent — a no-op
        when there is no in-progress task. Never raises."""
        today = fields.Date.context_today(self)
        sess = self.sudo().search([
            ('user_id', '=', user.id),
            ('session_date', '=', today),
            ('state', '=', 'open'),
        ], limit=1)
        if not sess:
            return False
        Log = self.env['kpi.time.log'].sudo()
        active_log = Log.search([('user_id', '=', user.id), ('is_active', '=', True)], limit=1)
        task = active_log.kpi_id if active_log else False
        if not task or task.task_state != 'in_progress':
            # Still un-pair on an explicit leave so the device must re-pair, even
            # if nothing was actively running.
            if source != 'cron':
                try:
                    self.env['kpi.pair'].sudo()._unpair(user, mode='resume')
                except Exception:
                    pass
            return False
        task.with_user(user).pause_task(reason='Away (auto)', reason_code='away')
        sess.sudo().write({'awayed_task_id': task.id})
        # Un-pair: the developer "went away" → web board + app fall back to the
        # PIN gate; next pairing reads as 'resume' → "continue working".
        try:
            self.env['kpi.pair'].sudo()._unpair(user, mode='resume')
        except Exception:
            pass
        _logger.info("away(%s): paused task %s for user %s", source, task.id, user.id)
        # Notify the developer (WhatsApp + app push) that their task was paused.
        try:
            task.with_user(user)._notify(
                'task_auto_away',
                dev=user.name,
                ref=task.external_ref or task.name,
                name=task.name,
                time=fields.Datetime.now().strftime('%H:%M'),
            )
        except Exception:
            pass  # never let a notification failure break the flow
        return True

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
        try:
            self.env['kpi.pair'].sudo()._unpair(self.user_id, mode='start')
        except Exception as exc:
            _logger.warning("finalize cleanup: un-pair failed for session %s: %s", self.id, exc)

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
        tasks = []
        for gi, g in enumerate(ordered_groups):
            concurrent = len(g) >= 2
            for t in sorted(g, key=lambda d: d['duration_seconds'], reverse=True):
                t['group'] = gi
                t['concurrent'] = concurrent
                t['duration_display'] = _fmt_hms(t['duration_seconds'])
                for _k in ('_iv', '_start', 'intervals'):
                    t.pop(_k, None)
                tasks.append(t)

        # Aggregate totals across the bucketed sessions.
        productive = sum(sessions.mapped('productive_seconds'))
        presence   = sum(sessions.mapped('presence_seconds'))

        # 🆕 Include the CURRENTLY-RUNNING segment so "Productive" reflects live
        # work, not only closed segments — fixes "task time not getting calculated"
        # when a task is still in progress at End Workday. (_compute_totals counts
        # only is_active=False logs, so the open segment would otherwise be missing.)
        active_log = Log.search([
            ('user_id', '=', self.user_id.id),
            ('is_active', '=', True),
        ], limit=1)
        if active_log and active_log.start_time:
            running_secs = max(0.0, (fields.Datetime.now() - active_log.start_time).total_seconds())
            if running_secs > 0:
                productive += running_secs
                rk = active_log.kpi_id
                if rk:
                    segments.append({
                        'kpi_id': rk.id,
                        'ref':    rk.external_ref or f"#{rk.id}",
                        'name':   rk.name or '',
                        'start':  active_log.start_time,
                        'end':    None,
                        'active': True,
                    })
                    row = next((t for t in tasks if t['kpi_id'] == rk.id), None)
                    if row:
                        row['duration_seconds'] += running_secs
                        row['duration_display'] = _fmt_hms(row['duration_seconds'])
                    else:
                        tasks.append({
                            'kpi_id': rk.id,
                            'ref': rk.external_ref or f"#{rk.id}",
                            'name': rk.name or '',
                            'duration_seconds': running_secs,
                            'duration_display': _fmt_hms(running_secs),
                            'group': len(ordered_groups),
                            'concurrent': False,
                        })
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
        if payload['tasks']:
            task_lines = "\n".join(
                f"  {'⚡' if t.get('concurrent') else '•'} {t['ref']}  {t['name'][:48]}  —  {t['duration_display']}"
                for t in payload['tasks']
            )
        else:
            task_lines = "  (no task time logged)"
        multitask_note = ("⚡ Multi-task on — tasks marked ⚡ overlapped in time; "
                          "Productive may exceed Presence (expected).\n"
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
        """Pause this developer's in-progress task (if any), recorded as non-
        productive 'away' time. Used by the midnight auto-close so a task left
        running when the day rolls over is stopped."""
        self.ensure_one()
        Log = self.env['kpi.time.log'].sudo()
        active_log = Log.search([('user_id', '=', self.user_id.id), ('is_active', '=', True)], limit=1)
        task = active_log.kpi_id if active_log else False
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
            # logout_at = end of session_date (23:59:59) — caps presence growth.
            eod = datetime.combine(s.session_date, time(23, 59, 59))
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
        for s in idle:
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
        if idle:
            _logger.info("idle-close: auto-ended %s forgotten workday(s) (>%s min idle)", len(idle), minutes)
        return len(idle)

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
        """
        today = fields.Date.context_today(self)
        Session = self.sudo()

        # Part 1: close stragglers (shared with the frequent midnight cron).
        self._close_overdue()

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
            try:
                payload = new_s._daily_summary_payload()
                new_s._fire_daily_summary(payload)
            except Exception as exc:
                _logger.warning("auto_close retro-summary failed for user %s: %s", uid, exc)

        return len(stragglers)

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
