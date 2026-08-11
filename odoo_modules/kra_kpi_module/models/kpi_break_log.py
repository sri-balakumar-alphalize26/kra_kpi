import pytz

from odoo import api, models, fields

# One line on a Workday Map chip. Shared with the pause note and the non-task
# note so all three agree — reason_note had NO cap at all, so a direct ORM write
# or a future caller could store a paragraph the renderers then had to truncate.
from .kpi_nontask_block import NOTE_MAX


class KpiBreakLog(models.Model):
    """Break / Lunch log — mirrors kpi.time.log's start/stop/duration but records
    NON-productive time only. Rows go ONLY here, never in kpi.time.log, so break/
    lunch time appears in Presence but NEVER in Productive/task time."""
    _name = "kpi.break.log"
    _description = "KPI Break / Lunch Log"
    _order = "start_time desc"

    user_id = fields.Many2one('res.users', string='Employee', required=True,
                              default=lambda self: self.env.user, index=True)
    break_type = fields.Selection([('break', 'Break'), ('lunch', 'Lunch'),
                                   ('meeting', 'Meeting'), ('other', 'Other'),
                                   # 'away' is no longer idle auto-detection (retired) — it is
                                   # now time a task was stopped by the SYSTEM: Pause Workday
                                   # and the midnight close both pause with reason_code='away'.
                                   ('away', 'Away (system)'), ('leave', 'Leave'),
                                   ('urgent', 'Urgent')],
                                  string='Type', required=True, default='break')
    start_time = fields.Datetime(string='Start Time', required=True, default=fields.Datetime.now)
    end_time = fields.Datetime(string='End Time')
    duration_seconds = fields.Float(string='Duration (seconds)', compute='_compute_duration', store=True)
    work_date = fields.Date(string='Work Date', compute='_compute_work_date', store=True, index=True)
    is_active = fields.Boolean(string='Is Active', default=True)
    # The task the developer paused FROM (shown in brackets on the live panel /
    # End-Workday list). reason_note carries the free-typed text for 'Other'.
    source_task_id = fields.Many2one('kra.kpi', string='Paused From Task', index=True, ondelete='set null')
    reason_note = fields.Char(string='Reason Note', size=NOTE_MAX)

    # Who a MEETING was with. Kept as a real relation rather than folded into
    # reason_note because that field is capped at NOTE_MAX and a couple of names
    # would eat the whole budget the reason itself needs — "Meeting with Priya
    # and Arun" would leave nothing to say what the meeting was about.
    # Applies to break_type == 'meeting'; empty everywhere else.
    meeting_with_user_ids = fields.Many2many(
        'res.users', 'kpi_break_log_meeting_user_rel', 'break_id', 'user_id',
        string='Meeting With')
    # Denormalised for display. The timeline, the away list and the PIL-drawn
    # snapshot all read one string; recomputing a name list in each of them is
    # how they would drift apart.
    meeting_with_display = fields.Char(
        string='Meeting With (names)', compute='_compute_meeting_with_display', store=True)

    @api.depends('meeting_with_user_ids')
    def _compute_meeting_with_display(self):
        for rec in self:
            names = rec.meeting_with_user_ids.mapped('name')
            rec.meeting_with_display = ', '.join(n for n in names if n) or False

    # Codes we recognise; anything else is filed under 'other' so no reason is lost.
    _KNOWN_TYPES = ('break', 'lunch', 'meeting', 'other', 'away', 'leave', 'urgent')

    @api.depends('start_time', 'user_id')
    def _compute_work_date(self):
        """Local (developer tz) date, matching kpi.time.log._compute_work_date
        and kpi.work.session.session_date. start_time is naive-UTC, so `.date()`
        filed a break taken in the small hours under the previous day while its
        session said today — and the daily summary joins the two."""
        for rec in self:
            if not rec.start_time:
                rec.work_date = False
                continue
            tz_name = (rec.user_id.tz if rec.user_id else None) or self.env.user.tz or 'Asia/Kolkata'
            try:
                rec.work_date = pytz.UTC.localize(rec.start_time).astimezone(
                    pytz.timezone(tz_name)).date()
            except Exception:
                rec.work_date = rec.start_time.date()

    @api.depends('start_time', 'end_time')
    def _compute_duration(self):
        for rec in self:
            if rec.start_time and rec.end_time:
                # Floored at zero. stop_break() already refuses an `at` that
                # predates the start, but it only guards the one path it owns —
                # a direct write(), a cron auto-close or an import can still
                # invert the pair, and a negative duration does not stay local:
                # it flows into Accounted and the presence residual, where it
                # shows up as time appearing from nowhere. At least one row in
                # production (-354s) got in this way before the stop_break guard
                # existed. A clamp here cannot fix bad timestamps, but it stops
                # them corrupting every total computed downstream.
                rec.duration_seconds = max(
                    0.0, (rec.end_time - rec.start_time).total_seconds())
            else:
                rec.duration_seconds = 0.0

    @api.model
    def start_break(self, break_type, user_id=None, source_task_id=None, reason_note=None,
                    at=None, meeting_with_ids=None):
        """Start a non-productive interval (break/lunch/meeting/other/away/leave)
        for the user. Reuse an active one if present (one active per user). Unknown
        codes are filed under 'other' so no reason is ever lost.

        `at` sets the start (default = now), mirroring stop_break's `at` cap. The
        auto-closes need it: work_date is computed FROM start_time, so a cron
        firing after midnight would stamp now() and file the break against the
        next day — away time on a date with no session, absent from the day it
        actually belongs to."""
        if not user_id:
            user_id = self.env.user.id
        btype = break_type if break_type in self._KNOWN_TYPES else 'other'
        active = self.search([('user_id', '=', user_id), ('is_active', '=', True)], limit=1)
        if active:
            vals = {}
            if btype and active.break_type != btype:
                vals['break_type'] = btype
            if source_task_id and not active.source_task_id:
                vals['source_task_id'] = source_task_id
            if reason_note and not active.reason_note:
                vals['reason_note'] = (reason_note or '')[:NOTE_MAX]
            # Only ever ADDS names, never clears them — same rule the two fields
            # above follow, so re-entering an already-open break cannot quietly
            # empty who it was with.
            if meeting_with_ids and not active.meeting_with_user_ids:
                vals['meeting_with_user_ids'] = [(6, 0, list(meeting_with_ids))]
            if vals:
                active.write(vals)
            return active.id
        rec = self.create({
            'user_id': user_id,
            'break_type': btype,
            'start_time': at or fields.Datetime.now(),
            'is_active': True,
            'source_task_id': source_task_id or False,
            'reason_note': (reason_note or '')[:NOTE_MAX] or False,
            'meeting_with_user_ids': [(6, 0, list(meeting_with_ids or []))],
        })
        return rec.id

    @api.model
    def stop_break(self, user_id=None, at=None):
        """Close the user's active break/lunch (if any).

        `at` caps the end time (default = now). The midnight auto-close passes the
        session's day-end (23:59:59) so a break that crossed midnight isn't inflated
        to a full extra day."""
        if not user_id:
            user_id = self.env.user.id
        active = self.search([('user_id', '=', user_id), ('is_active', '=', True)], limit=1)
        if active:
            end = at or fields.Datetime.now()
            # A caller's `at` must never predate the break's own start, or this
            # writes a negative duration that then poisons every total built on
            # it. Callers capture a timestamp and do work before getting here, so
            # a stale `at` is an easy mistake to make (action_pause_workday made
            # exactly it). Cheaper to refuse it once here than to find a negative
            # Accounted total later and trace it back to a break row.
            if end < active.start_time:
                end = active.start_time
            active.write({'end_time': end, 'is_active': False})
            return {'break_id': active.id, 'duration_seconds': active.duration_seconds}
        return {'break_id': False, 'duration_seconds': 0}
