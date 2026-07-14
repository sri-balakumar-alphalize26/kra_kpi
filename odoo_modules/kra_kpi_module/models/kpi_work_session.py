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

_logger = logging.getLogger(__name__)


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
    # Open / fetch today's session — idempotent                          #
    # ------------------------------------------------------------------ #
    @api.model
    def _get_or_open_today(self, user=None):
        """Return the currently OPEN session for (user, today), or create one.

        Multiple sessions per day are now allowed (so a developer can restart
        their workday after an accidental End Workday).  The invariant we
        keep: at most ONE 'open' session per user per day.  Closed sessions
        from earlier today are left intact and their time still counts in
        the day-wide summary.
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
        # Take a row-exclusive lock to dodge double-create on parallel tab loads.
        self.env.cr.execute("LOCK TABLE kpi_work_session IN ROW EXCLUSIVE MODE")
        existing_open = self.sudo().search([
            ('user_id',      '=', user.id),
            ('session_date', '=', today),
            ('state',        '=', 'open'),
        ], limit=1)
        if existing_open:
            return existing_open
        new_sess = self.sudo().create({
            'user_id':      user.id,
            'session_date': today,
            'login_at':     fields.Datetime.now(),
            'state':        'open',
            'last_heartbeat': fields.Datetime.now(),
        })
        # Fire the workday_started WhatsApp to owner + coordinator.
        try:
            new_sess._fire_workday_started()
        except Exception as exc:
            _logger.warning("workday_started notification failed: %s", exc)
        return new_sess

    def _fire_workday_started(self):
        """Fire the 'workday_started' WhatsApp to owner + coordinator."""
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

        return {
            'status': True,
            'workday_open': bool(sess),
            'active_task': active_task,
            'active_break': active_break,
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
        # Close any open break/lunch so it doesn't keep running past logout.
        self.env['kpi.break.log'].stop_break(self.user_id.id)
        # Un-pair the device: the workday is over → the web board falls back to the
        # PIN gate and the phone app to the Start Working screen. mode='start' since
        # the workday is now closed (the next pairing is a fresh start, not resume).
        try:
            self.env['kpi.pair'].sudo()._unpair(self.user_id, mode='start')
        except Exception as exc:
            _logger.warning("end_day un-pair failed for session %s: %s", self.id, exc)
        payload = self._daily_summary_payload(full_day=True)
        self._fire_daily_summary(payload)
        return payload

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
        break_secs   = sum(b.duration_seconds for b in blogs if b.break_type == 'break')
        lunch_secs   = sum(b.duration_seconds for b in blogs if b.break_type == 'lunch')
        meeting_secs = sum(b.duration_seconds for b in blogs if b.break_type == 'meeting')
        away_secs    = sum(b.duration_seconds for b in blogs if b.break_type == 'away')
        # 'other' + 'leave' + 'urgent' + anything unexpected roll up under "Other".
        other_secs   = sum(b.duration_seconds for b in blogs
                           if b.break_type in ('other', 'leave', 'urgent'))
        metered = break_secs + lunch_secs + meeting_secs + away_secs + other_secs
        # Residual idle = presence not covered by productive work OR any metered reason.
        other_idle = max(0.0, presence - productive - metered)

        _type_labels = {'break': 'Break', 'lunch': 'Lunch', 'meeting': 'Meeting',
                        'other': 'Other', 'away': 'Away', 'leave': 'Leave', 'urgent': 'Urgent'}
        away_events = []
        _seq = {}
        for b in blogs:
            _seq[b.break_type] = _seq.get(b.break_type, 0) + 1
            label = _type_labels.get(b.break_type, 'Other')
            away_events.append({
                'label': label + ' ' + str(_seq[b.break_type]),
                'type': b.break_type,
                'start': _to_user_tz_str(b.start_time, self.user_id, fmt='%H:%M'),
                'end': _to_user_tz_str(b.end_time, self.user_id, fmt='%H:%M') if b.end_time else '(open)',
                'duration_display': _fmt_hms(b.duration_seconds),
                'from': b.source_task_id.name if b.source_task_id else '',
                'note': b.reason_note or '',
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
            'task_count':         len(tasks),
            'tasks':              tasks,
            'auto_closed':        any(sessions.mapped('auto_closed')),
            'allow_multitask':    self.user_id.kpi_allow_multitask,
            'break_seconds':      float(break_secs),
            'lunch_seconds':      float(lunch_secs),
            'meeting_seconds':    float(meeting_secs),
            'other_seconds':      float(other_secs),
            'away_seconds':       float(away_secs),
            'other_idle_seconds': float(other_idle),
            'break_display':      _fmt_hms(break_secs),
            'lunch_display':      _fmt_hms(lunch_secs),
            'meeting_display':    _fmt_hms(meeting_secs),
            'other_display':      _fmt_hms(other_secs),
            'away_display':       _fmt_hms(away_secs),
            'other_idle_display': _fmt_hms(other_idle),
            'away_events':        away_events,
            'note':               self.note or '',
        }

    def _fire_daily_summary(self, payload):
        """Dispatch the 'daily_summary' WA via the existing _notify pipeline.

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
            try:
                payload = s._daily_summary_payload()
                s._fire_daily_summary(payload)
            except Exception as exc:
                _logger.warning("overdue-close summary failed for session %s: %s", s.id, exc)
            # Tell the developer we auto-closed the workday they left open.
            try:
                s._fire_workday_auto_closed()
            except Exception as exc:
                _logger.warning("overdue-close notify failed for session %s: %s", s.id, exc)
        return len(stragglers)

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
