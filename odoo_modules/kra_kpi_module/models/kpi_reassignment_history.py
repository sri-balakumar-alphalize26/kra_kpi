from odoo import api, models, fields


class KpiReassignmentHistory(models.Model):
    _name = "kpi.reassignment.history"
    _description = "KPI Reassignment History"
    _order = "reassignment_date desc"

    kpi_id = fields.Many2one('kra.kpi', string='KPI Task', required=True, ondelete='cascade')
    
    # Previous assignment details
    previous_assignee_id = fields.Many2one('res.users', string='Previous Assignee', required=True)
    previous_assignee_name = fields.Char(string='Previous Assignee Name', required=True)
    
    # New assignment details
    new_assignee_id = fields.Many2one('res.users', string='New Assignee', required=True)
    new_assignee_name = fields.Char(string='New Assignee Name', required=True)
    
    # Reassignment metadata
    reassigned_by_id = fields.Many2one('res.users', string='Reassigned By', required=True)
    reassigned_by_name = fields.Char(string='Reassigned By Name', required=True)
    reassignment_date = fields.Datetime(string='Reassignment Date', required=True, default=fields.Datetime.now)
    reassignment_reason = fields.Text(string='Reason for Reassignment', required=True)
    
    # Task state at reassignment
    previous_state = fields.Selection([
        ('assigned',                'Assigned'),
        ('urgent',                  'Urgent'),
        ('important',               'Important'),
        ('regular',                 'Regular'),
        ('queue_waiting',           'Queued'),
        ('pre_approval_pending',    'Pre-Approval Pending'),
        ('pre_approval_approved',   'Pre-Approval Approved'),
        ('pre_approval_partial',    'Partially Approved (Prep Only)'),
        ('in_progress',             'In Progress'),
        ('paused',                  'Paused'),
        ('hold',                    'On Hold'),
        ('rework',                  'Rework Required'),
        ('partially_completed',     'Verification Pending'),
        ('awaiting_client',         'Awaiting Client Sign-off'),
        ('completed',               'Completed'),
    ], string='Previous Task State', required=True)
    
    # Time spent by previous assignee
    time_spent_seconds = fields.Float(string='Time Spent (seconds)', default=0.0)
    time_spent_display = fields.Char(string='Time Spent', compute='_compute_time_display')
    
    # Pause information if applicable
    was_paused = fields.Boolean(string='Was Paused', default=False)
    pause_reason = fields.Text(string='Pause Reason')
    
    @api.depends('time_spent_seconds')
    def _compute_time_display(self):
        """Format time spent in HH:MM:SS"""
        for rec in self:
            if rec.time_spent_seconds:
                hours = int(rec.time_spent_seconds // 3600)
                minutes = int((rec.time_spent_seconds % 3600) // 60)
                seconds = int(rec.time_spent_seconds % 60)
                rec.time_spent_display = f"{hours:02d}h {minutes:02d}m {seconds:02d}s"
            else:
                rec.time_spent_display = "0h 00m 00s"