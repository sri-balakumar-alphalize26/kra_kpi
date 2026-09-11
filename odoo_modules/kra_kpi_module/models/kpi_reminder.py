import logging

import pytz
from dateutil.relativedelta import relativedelta

from odoo import api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

# Wall-clock repeat steps. Deliberately relativedelta and not timedelta: the
# reminder must hold the same WALL-CLOCK time across a DST change, and a
# timedelta of 24h would drift the alarm by an hour twice a year.
_REPEAT_STEP = {
    'daily': relativedelta(days=1),
    'weekly': relativedelta(weeks=1),
}


class KpiReminder(models.Model):
    """A reminder that is NOT attached to a task: a name, a date, a time.

    The row lives here; the ring happens on the device. That split is the whole
    design constraint — a row is not an alarm, so anything created or edited on
    the web has to reach a phone BEFORE its time or nothing rings. The app half
    (a push when the row is WRITTEN, not when it is due, so the device can arm an
    offline AlarmManager trigger) is deliberately not built yet; this model is
    the half it will read from.
    """

    _name = "kpi.reminder"
    _description = "Standalone Reminder"
    # Explicit, and not an afterthought: kra.kpi shipped with no _order, Odoo fell
    # back to id ASC, and every board lane read oldest-at-top until someone
    # complained. Soonest-first is the only useful order for a list of alarms.
    _order = "next_trigger asc, id desc"

    name = fields.Char(
        string="Reminder",
        required=True,
        help="What the reminder says when it rings.",
    )
    user_id = fields.Many2one(
        'res.users',
        string="Owner",
        required=True,
        default=lambda self: self.env.user,
        ondelete='cascade',
        index=True,
        help="Whose reminder this is. A reminder is personal — the record rule "
             "scopes the list to its owner.",
    )

    # Wall-clock, stored as the user means it, NOT as UTC. A daily repeat has to
    # keep ringing at 09:00 local across a DST change, which is only possible if
    # the stored intent is "09:00" rather than an instant that happened to be
    # 09:00 once. next_trigger below is the derived UTC instant.
    remind_date = fields.Date(
        string="Date",
        required=True,
        default=fields.Date.context_today,
    )
    remind_time = fields.Float(
        string="Time",
        required=True,
        default=9.0,
        help="Wall-clock time of day in the owner's timezone, as a float "
             "(9.5 = 09:30).",
    )

    # NOT called `active`. That name is Odoo's archive flag: an active=False
    # record is filtered out of every list and every search() by default, so
    # switching a reminder off would make it VANISH rather than show as off —
    # the exact opposite of what an alarm toggle should do.
    enabled = fields.Boolean(
        string="Enabled",
        default=True,
        help="Off means it will not ring. The reminder stays in the list.",
    )

    repeat = fields.Selection(
        [('none', 'Once'), ('daily', 'Daily'), ('weekly', 'Weekly')],
        string="Repeat",
        default='none',
        required=True,
    )

    # OPTIONAL, and one field rather than two, because a client IS a KRA here:
    # kra.master with is_client=True, sitting at the top of a tree of sub-KRAs.
    # Offering "client" and "KRA" as separate pickers would be two dropdowns onto
    # the same table, and would have to police the case where they disagree.
    #
    # ondelete='set null', not cascade: retiring a client must not silently delete
    # somebody's reminder to call them.
    kra_id = fields.Many2one(
        'kra.master',
        string="Client / KRA",
        ondelete='set null',
        index=True,
        help="Optional. Tie this reminder to a client or to any KRA under one.",
    )
    # Which client the chosen KRA belongs to, derived rather than asked for.
    # kra.master has no display path — a sub-KRA shows as a bare "User manual",
    # which is ambiguous when three clients each have one — so the list needs this
    # column to be readable. Same walk kra.kpi._compute_client_kra does.
    client_kra_id = fields.Many2one(
        'kra.master',
        string="Client",
        compute='_compute_client_kra',
        store=True,
        help="Nearest ancestor of the chosen KRA with is_client set.",
    )

    # The one field the app will arm an alarm from: a real UTC instant.
    next_trigger = fields.Datetime(
        string="Next Ring (UTC)",
        compute='_compute_next_trigger',
        store=True,
        help="Derived from date + time in the owner's timezone. Stored so the "
             "list can order by it and so a push can query what is due.",
    )

    completion_ids = fields.One2many(
        'kpi.reminder.completion', 'reminder_id', string="History",
    )
    completion_count = fields.Integer(
        compute='_compute_completion_count', string="Times Completed",
    )

    def _tz(self):
        """The owner's timezone, falling back the way kpi_time_log does."""
        self.ensure_one()
        name = (self.user_id.tz if self.user_id else None) \
            or self.env.user.tz or 'Asia/Kolkata'
        try:
            return pytz.timezone(name)
        except Exception:
            return pytz.timezone('Asia/Kolkata')

    @api.depends('remind_date', 'remind_time', 'user_id', 'user_id.tz')
    def _compute_next_trigger(self):
        for rec in self:
            if not rec.remind_date:
                rec.next_trigger = False
                continue
            hours = int(rec.remind_time or 0.0)
            minutes = int(round(((rec.remind_time or 0.0) - hours) * 60))
            # A 59.6-minute rounding can land on 60; roll it rather than raise.
            if minutes >= 60:
                hours, minutes = hours + 1, 0
            if hours >= 24:
                hours = 23
                minutes = 59
            naive = fields.Datetime.to_datetime(rec.remind_date).replace(
                hour=hours, minute=minutes, second=0, microsecond=0)
            tz = rec._tz()
            try:
                # is_dst=None would raise on the ambiguous hour; False picks the
                # later offset, which is the conventional choice and never fails.
                local = tz.localize(naive, is_dst=False)
            except Exception:
                rec.next_trigger = naive
                continue
            rec.next_trigger = local.astimezone(pytz.UTC).replace(tzinfo=None)

    @api.depends('kra_id', 'kra_id.parent_id', 'kra_id.is_client')
    def _compute_client_kra(self):
        """Walk up the KRA hierarchy to the nearest is_client=True ancestor.

        Deliberately the same walk as kra.kpi._compute_client_kra rather than a
        second interpretation of what "the client" means — the two must agree, or
        a reminder would file under a different client than the tasks beside it.
        A KRA that is itself the client resolves to itself, which is why the test
        is at the top of the loop.
        """
        Kra = self.env['kra.master']
        for rec in self:
            cur = rec.kra_id
            found = Kra
            while cur:
                if cur.is_client:
                    found = cur
                    break
                cur = cur.parent_id
            rec.client_kra_id = found

    @api.depends('completion_ids')
    def _compute_completion_count(self):
        # read_group rather than len(rec.completion_ids): one query for the whole
        # list instead of one per row.
        counts = {}
        if self.ids:
            for g in self.env['kpi.reminder.completion'].read_group(
                    [('reminder_id', 'in', self.ids)],
                    ['reminder_id'], ['reminder_id'], lazy=False):
                if g.get('reminder_id'):
                    counts[g['reminder_id'][0]] = g.get('__count', 0)
        for rec in self:
            rec.completion_count = counts.get(rec.id, 0)

    def action_complete(self):
        """Tick the reminder: log history, then advance a repeating one.

        The repeat arithmetic lives HERE and only here. Written once in Python
        and once in JS it becomes two implementations that will disagree, and the
        disagreement surfaces as an alarm an hour early months later. The server
        advances the row and returns it; the app arms whatever comes back.
        """
        Completion = self.env['kpi.reminder.completion']
        for rec in self:
            # Snapshot name and time onto the completion row. A history that
            # reads "(deleted)" is not a history, and reminder_id is set null on
            # delete precisely so the row can outlive its reminder.
            Completion.create({
                'reminder_id': rec.id,
                'name_snapshot': rec.name or '',
                'time_snapshot': rec.next_trigger or fields.Datetime.now(),
                'completed_by': self.env.user.id,
                'completed_at': fields.Datetime.now(),
            })
            step = _REPEAT_STEP.get(rec.repeat)
            if step:
                # Advance the DATE and leave remind_time alone, so the wall-clock
                # time is preserved and _compute_next_trigger re-derives the UTC
                # instant against whatever offset is in force that day.
                rec.remind_date = rec.remind_date + step
            else:
                # A one-shot is done. Switch it off rather than delete it — the
                # user may want to see that it happened, and the history row
                # points at it.
                rec.enabled = False
        return True

    def action_view_history(self):
        """History is reached from INSIDE the reminder, not a second menu line."""
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': f"History — {self.name}",
            'res_model': 'kpi.reminder.completion',
            'view_mode': 'list,form',
            'domain': [('reminder_id', '=', self.id)],
            'context': {'default_reminder_id': self.id},
        }


class KpiReminderCompletion(models.Model):
    """One tick of one reminder.

    A separate model rather than a `state` field or a `done_at` on the reminder,
    because those cannot hold history: tick a daily reminder five days running
    and a single done_at remembers only the last tick.
    """

    _name = "kpi.reminder.completion"
    _description = "Reminder Completion"
    _order = "completed_at desc, id desc"

    # set null, not cascade: history that disappears with its reminder is not
    # history. The snapshots below are what keep the row readable afterwards.
    reminder_id = fields.Many2one(
        'kpi.reminder', string="Reminder", ondelete='set null', index=True,
    )
    name_snapshot = fields.Char(string="Reminder", required=True)
    time_snapshot = fields.Datetime(string="Was Due")
    completed_by = fields.Many2one('res.users', string="Completed By")
    completed_at = fields.Datetime(
        string="Completed At", default=fields.Datetime.now,
    )
