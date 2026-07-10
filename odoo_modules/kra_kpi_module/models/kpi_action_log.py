"""kpi.action.log — audit trail for the Advanced Workflow MVP.

Every lifecycle event (start, pause, resume, complete, internal_approved,
pre_approval_requested, pre_approval_decided, partial_timeout, notification
attempts) writes one row here.  Channel (web vs whatsapp vs cron) + actor +
device + payload are all captured for the security/audit story in Section 12
of the workflow spec.

This is deliberately separate from kpi.reassignment.history (which stays
focused on assignee changes) and from kpi.progress (manual progress notes).
"""

from odoo import api, fields, models


class KpiActionLog(models.Model):
    _name = 'kpi.action.log'
    _description = 'KPI Action Log (Advanced Workflow Audit)'
    _order = 'create_date desc, id desc'

    kpi_id = fields.Many2one(
        'kra.kpi',
        string='Task',
        required=True,
        ondelete='cascade',
        index=True,
    )

    # Free-text event key.  Examples used by the notification dispatcher:
    #   task_created, pre_approval_requested, pre_approval_decided,
    #   partial_timeout, start, start_prep, pause, resume, complete,
    #   internal_approved, internal_rejected, set_hold, set_rework,
    #   notification_sent, notification_failed
    event = fields.Char(string='Event', required=True, index=True)

    source = fields.Selection([
        ('web',      'Web Dashboard'),
        ('whatsapp', 'WhatsApp'),
        ('system',   'System / ORM'),
        ('cron',     'Scheduled Job'),
    ], string='Source Channel', required=True, default='system')

    actor_user_id = fields.Many2one('res.users', string='Actor (User)')
    actor_partner_id = fields.Many2one('res.partner', string='Actor (Partner)')
    # actor_label is for cases where the action came from a public approval
    # page (no logged-in user): we capture the typed name + the partner is
    # matched by phone where possible.
    actor_label = fields.Char(string='Actor Label')

    device_ip = fields.Char(string='Device IP')
    user_agent = fields.Char(string='User Agent')

    # JSON-encoded extra context (e.g. {"reason_code": "technical_issue",
    # "note": "...", "recipients": ["+919...", "+919..."], "error": "..."}).
    payload_json = fields.Text(string='Payload (JSON)')

    success = fields.Boolean(string='Success', default=True)

    @api.model
    def log(self, kpi_id, event, source='system', actor_user_id=None,
            actor_partner_id=None, actor_label=None, device_ip=None,
            user_agent=None, payload=None, success=True):
        """Convenience constructor — callers don't have to import json."""
        import json
        vals = {
            'kpi_id': kpi_id,
            'event': event,
            'source': source,
            'success': success,
        }
        if actor_user_id:
            vals['actor_user_id'] = actor_user_id
        if actor_partner_id:
            vals['actor_partner_id'] = actor_partner_id
        if actor_label:
            vals['actor_label'] = actor_label
        if device_ip:
            vals['device_ip'] = device_ip
        if user_agent:
            vals['user_agent'] = user_agent
        if payload is not None:
            try:
                vals['payload_json'] = json.dumps(payload, default=str)
            except (TypeError, ValueError):
                vals['payload_json'] = str(payload)
        return self.sudo().create(vals)
