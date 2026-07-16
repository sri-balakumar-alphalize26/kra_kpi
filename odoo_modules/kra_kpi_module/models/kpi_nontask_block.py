# Non-task time: a Meeting or Break the developer had while NO task was running.
#
# Why this model exists: a developer could only give a reason (Meeting/Break) by
# PAUSING a running task. With no task started — the 09:30 workday / 09:31 meeting
# case — there is nothing to pause, so that time was invisible and looked exactly
# like sitting idle. These rows are what let the Workday Map say "Meeting" instead
# of showing an unexplained hole.
#
# Deliberately SEPARATE from kpi.time.log: that model feeds task timers and
# timer_total_seconds. A meeting is not work on a task, and putting it there would
# corrupt actual-vs-estimate, the completion certificate and anything billable.
# Wall-clock presence (kpi.work.session.presence_seconds) already counts it.

from odoo import api, fields, models

# The note is rendered inside a Workday Map chip, so it has to stay short or it
# wrecks the row it is meant to explain — and the Map is also what gets frozen
# into the saved End Workday image. Enforced BOTH client-side (maxLength) and
# here, because a client cap is a courtesy, not a guarantee.
NOTE_MAX = 60

# The ONE list of non-task reasons. The selection below, kpi.work.session's mirror
# field, _set_nontask_reason's guard and the /kpi_workday/idle_reason route all read
# THIS — they used to hardcode their own copies, so adding a reason meant finding
# every list or the new one was silently rejected at the door.
NONTASK_REASONS = [
    ('meeting', 'Meeting'),
    ('break', 'Break'),
    # Lunch is its own reason, not a Break: it already has its own Away bucket,
    # colour and Map label everywhere else, so folding it into Break left the Lunch
    # box reading 0m for anyone who ate without a task running.
    ('lunch', 'Lunch'),
    # Recorded like the others ON PURPOSE: a developer with nothing assigned would
    # otherwise show as unexplained idle — indistinguishable from slacking, which is
    # both untrue and unfair to them. This is the only one admins hear about.
    ('no_tasks', 'No tasks'),
]
NONTASK_REASON_CODES = tuple(c for c, _ in NONTASK_REASONS)


class KpiNonTaskBlock(models.Model):
    _name = 'kpi.nontask.block'
    _description = 'Non-task time (meeting / break with no task running)'
    _order = 'start_at desc'

    session_id = fields.Many2one(
        'kpi.work.session', string='Workday Session',
        required=True, index=True, ondelete='cascade',
    )
    user_id = fields.Many2one(
        'res.users', string='Developer',
        required=True, index=True, ondelete='cascade',
    )
    reason = fields.Selection(
        NONTASK_REASONS, string='Reason', required=True,
        help="Why no task was running. Admins are told about 'no_tasks' only; "
             "meeting / break / lunch stay silent — telling admins about a meeting "
             "is the false alarm that makes the whole feed worth ignoring.",
    )
    note = fields.Char(
        string='Note', size=NOTE_MAX,
        help='Optional free text the developer typed. Shown under the block on the '
             'Workday Map, so it is deliberately short.',
    )
    start_at = fields.Datetime(string='Start', required=True)
    end_at = fields.Datetime(
        string='End',
        help='Stamped when a task starts (at the same instant the timer begins, so '
             'the block and the task never overlap), when End is tapped, or at End Workday.',
    )
    seconds = fields.Float(
        string='Duration (s)', compute='_compute_seconds', store=True,
        help='Shown in the Workday Map. NEVER added to task time.',
    )
    seq = fields.Integer(
        string='Nth Today', default=0, copy=False, index=True,
        help='Which one this is today for this developer and reason: the first '
             'meeting is 1, a later meeting between tasks is 2, and breaks are '
             'numbered separately. Assigned on create and never recomputed, so a '
             'block keeps the number it was given even if an earlier one is '
             'deleted.',
    )
    display_label = fields.Char(
        string='Label', compute='_compute_display_label',
        help='"Meeting 2" — what the Workday Map and the board pill show.',
    )

    @api.depends('start_at', 'end_at')
    def _compute_seconds(self):
        for rec in self:
            if rec.start_at and rec.end_at:
                rec.seconds = max(0.0, (rec.end_at - rec.start_at).total_seconds())
            else:
                rec.seconds = 0.0

    @api.depends('reason', 'seq')
    def _compute_display_label(self):
        labels = dict(self._fields['reason'].selection)
        for rec in self:
            base = labels.get(rec.reason, rec.reason or '')
            rec.display_label = ('%s %s' % (base, rec.seq)) if rec.seq else base

    @api.model
    def _next_seq(self, user_id, reason, session_date):
        """Nth block of this reason for this developer TODAY (1-based).

        Counts by DAY, not by session: a developer who ends and restarts their
        workday is still having their second meeting of the day, not a new first.
        Shared with kpi.work.session.live_status so the running pill and the saved
        row can never disagree on the number.
        """
        prior = self.sudo().search_count([
            ('user_id', '=', user_id),
            ('reason', '=', reason),
            ('session_id.session_date', '=', session_date),
        ])
        return prior + 1

    @api.model_create_multi
    def create(self, vals_list):
        # Numbered here rather than in the caller so EVERY creator gets it.
        for vals in vals_list:
            if vals.get('seq'):
                continue
            sess = self.env['kpi.work.session'].sudo().browse(vals.get('session_id'))
            if not sess.exists() or not vals.get('user_id') or not vals.get('reason'):
                continue
            vals['seq'] = self._next_seq(
                vals['user_id'], vals['reason'], sess.session_date)
        return super().create(vals_list)
