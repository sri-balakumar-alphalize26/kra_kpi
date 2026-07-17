from odoo import api, models, fields


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
                                   ('away', 'Away (auto)'), ('leave', 'Leave'),
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
    reason_note = fields.Char(string='Reason Note')

    # Codes we recognise; anything else is filed under 'other' so no reason is lost.
    _KNOWN_TYPES = ('break', 'lunch', 'meeting', 'other', 'away', 'leave', 'urgent')

    @api.depends('start_time')
    def _compute_work_date(self):
        for rec in self:
            rec.work_date = rec.start_time.date() if rec.start_time else False

    @api.depends('start_time', 'end_time')
    def _compute_duration(self):
        for rec in self:
            if rec.start_time and rec.end_time:
                rec.duration_seconds = (rec.end_time - rec.start_time).total_seconds()
            else:
                rec.duration_seconds = 0.0

    @api.model
    def start_break(self, break_type, user_id=None, source_task_id=None, reason_note=None):
        """Start a non-productive interval (break/lunch/meeting/other/away/leave)
        for the user. Reuse an active one if present (one active per user). Unknown
        codes are filed under 'other' so no reason is ever lost."""
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
                vals['reason_note'] = reason_note
            if vals:
                active.write(vals)
            return active.id
        rec = self.create({
            'user_id': user_id,
            'break_type': btype,
            'start_time': fields.Datetime.now(),
            'is_active': True,
            'source_task_id': source_task_id or False,
            'reason_note': reason_note or False,
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
            active.write({'end_time': at or fields.Datetime.now(), 'is_active': False})
            return {'break_id': active.id, 'duration_seconds': active.duration_seconds}
        return {'break_id': False, 'duration_seconds': 0}
