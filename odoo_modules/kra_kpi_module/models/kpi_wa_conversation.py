"""kpi.wa.conversation — per-phone state machine for inbound WhatsApp commands.

A conversation tracks where a sender is in a multi-step flow.  When the
inbound parser receives a message, it looks up (or creates) the conversation
for the sender phone and routes to the matching step handler.

Flow for "Create New Task" (the MVP):

    idle  ─► "hi"/"menu"/"new"     ──►  step='menu'      (bot sends menu)
    menu  ─► "1"/"2"/"3"           ──►  step='ask_title' (records action_type)
            "4"                    ──►  fires "Show pending pre-approvals"
                                        and resets to idle
    ask_title  ─► <any text>       ──►  step='ask_project'  (records title)
    ask_project ─► "<n>"           ──►  step='done'  (creates kra.kpi)
    done  ─► (any)                 ──►  resets to idle

A conversation auto-expires after CONVERSATION_TTL_MIN minutes of
inactivity; the same partial-timeout cron we already have prunes stale rows.
"""

from datetime import timedelta

from odoo import api, fields, models


CONVERSATION_TTL_MIN = 10


class KpiWaConversation(models.Model):
    _name = 'kpi.wa.conversation'
    _description = 'Inbound WhatsApp Conversation State'
    _order = 'last_activity desc'

    phone = fields.Char(string='Phone', required=True, index=True)
    step = fields.Selection([
        ('idle',                  'Idle'),
        ('menu',                  'Main Menu'),
        # Task creation flow
        ('ask_title',             'Waiting for title'),
        ('ask_project',           'Waiting for project choice'),
        # Coordinator: assign dev + estimate flow
        ('coord_pick_queue_task', 'Coord: pick queue task'),
        ('coord_pick_developer',  'Coord: pick developer'),
        ('coord_ask_hours',       'Coord: ask estimate hours'),
        # Developer / coordinator: pick a task to act on
        ('pick_task_for_action',  'Pick task to act on'),
        ('ask_pause_reason',      'Pick pause reason'),
        ('done',                  'Done'),
    ], default='idle', required=True)

    # Resolved sender role at conversation start
    actor_user_id    = fields.Many2one('res.users', string='Sender user')
    actor_partner_id = fields.Many2one('res.partner', string='Sender partner')
    actor_role       = fields.Selection([
        ('client',      'Client'),
        ('coordinator', 'Coordinator'),
        ('owner',       'Owner'),
        ('developer',   'Developer'),
        ('unknown',     'Unknown'),
    ], default='unknown')

    # Collected fields during the flow
    action_type      = fields.Selection([
        ('requirement', 'Requirement'),
        ('update',      'Update'),
        ('bug',         'Bug'),
    ])
    task_title       = fields.Char()
    project_kra_id   = fields.Many2one('kra.master')

    # Cached list of available projects for the sender at "ask_project" time,
    # so option numbers stay stable even if the KRA list changes mid-flow.
    project_choices_csv = fields.Char(
        help='Comma-separated kra.master ids in display order',
    )

    # Sub-flow caches: chosen target task / target developer / typed hours.
    target_kpi_id   = fields.Many2one('kra.kpi')
    target_user_id  = fields.Many2one('res.users')
    target_hours    = fields.Float()
    # Generic cached list of choice ids (kpi or user) for the current step.
    task_choices_csv = fields.Char()
    user_choices_csv = fields.Char()
    # What action the user is mid-flow on (so a pick_task_for_action knows
    # whether to start/pause/complete/approve/reject the picked task).
    pending_action  = fields.Char()

    last_activity    = fields.Datetime(default=fields.Datetime.now, required=True)
    created_kpi_id   = fields.Many2one('kra.kpi')

    @api.model
    def get_or_create(self, phone):
        """Return the live conversation for `phone` (creating an idle one if none)."""
        if not phone:
            return self.browse()
        rec = self.sudo().search([('phone', '=', phone)], limit=1)
        if not rec:
            rec = self.sudo().create({'phone': phone, 'step': 'idle'})
        elif self._is_stale(rec):
            # Reset stale rows so the user gets a fresh menu.
            rec.sudo().write({
                'step': 'idle',
                'action_type': False,
                'task_title': False,
                'project_kra_id': False,
                'project_choices_csv': False,
                'last_activity': fields.Datetime.now(),
            })
        return rec

    @api.model
    def _is_stale(self, rec):
        if not rec.last_activity:
            return True
        cutoff = fields.Datetime.now() - timedelta(minutes=CONVERSATION_TTL_MIN)
        return rec.last_activity < cutoff

    def touch(self):
        """Bump last_activity so the conversation doesn't expire mid-flow."""
        self.sudo().write({'last_activity': fields.Datetime.now()})

    def reset(self):
        """Clear all conversation state, back to idle."""
        self.sudo().write({
            'step':                'idle',
            'action_type':         False,
            'task_title':          False,
            'project_kra_id':      False,
            'project_choices_csv': False,
            'target_kpi_id':       False,
            'target_user_id':      False,
            'target_hours':        False,
            'task_choices_csv':    False,
            'user_choices_csv':    False,
            'pending_action':      False,
            'last_activity':       fields.Datetime.now(),
        })

    @api.model
    def _cron_prune_stale(self):
        """Hourly: delete idle conversations older than 1 day to keep the table small."""
        cutoff = fields.Datetime.now() - timedelta(days=1)
        stale = self.sudo().search([
            ('step', '=', 'idle'),
            ('last_activity', '<', cutoff),
        ])
        n = len(stale)
        stale.unlink()
        return n
