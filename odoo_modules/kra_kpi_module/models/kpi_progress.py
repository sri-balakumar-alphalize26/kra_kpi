from odoo import api, models, fields


class KpiProgress(models.Model):
    _name = "kpi.progress"
    _description = "KPI Task Progress Updates"
    _order = "create_date desc"

    kpi_id = fields.Many2one(
        'kra.kpi',
        string='KPI Task',
        required=True,
        ondelete='cascade'
    )
    
    user_id = fields.Many2one(
        'res.users',
        string='Employee',
        required=True,
        default=lambda self: self.env.user,
        readonly=True
    )
    
    summary = fields.Text(
        string='Progress Summary',
        required=True,
        help='Brief description of work done and progress made'
    )
    
    # NEW: Time spent on this progress entry (in seconds)
    time_spent_seconds = fields.Float(
        string='Time Spent (seconds)',
        default=0.0,
        help='Time spent on this task during this progress update session'
    )
    
    # Computed field for display
    time_spent_display = fields.Char(
        string='Time Spent',
        compute='_compute_time_spent_display',
        store=False
    )
    
    uploaded_file = fields.Binary(
        string='Attachment',
        help='Upload supporting documents, screenshots, or files'
    )
    
    file_name = fields.Char(
        string='File Name'
    )
    # 🆕 NEW: Related Links field
    related_links = fields.Text(
        string='Related Links',
        help='Store links as JSON array'
    )
    
    create_date = fields.Datetime(
        string='Submitted On',
        readonly=True
    )
    
    # Related fields for easy access
    kpi_name = fields.Char(
        related='kpi_id.name',
        string='Task Name',
        store=True
    )
    
    employee_name = fields.Char(
        related='user_id.name',
        string='Employee Name',
        store=True
    )
    
    @api.depends('time_spent_seconds')
    def _compute_time_spent_display(self):
        for rec in self:
            if rec.time_spent_seconds:
                hours = int(rec.time_spent_seconds // 3600)
                minutes = int((rec.time_spent_seconds % 3600) // 60)
                rec.time_spent_display = f"{hours}h {minutes}m"
            else:
                rec.time_spent_display = "0h 0m"
    
    @api.model
    def create_progress_update(self, vals):
        """Create a new progress update entry"""
        if isinstance(vals, (list, tuple)) and vals:
            vals = vals[0]
        
        rec_vals = {
            'kpi_id': vals.get('kpi_id'),
            'summary': vals.get('summary'),
            'uploaded_file': vals.get('uploaded_file'),
            'file_name': vals.get('file_name'),
            'user_id': self.env.user.id,
            'time_spent_seconds': vals.get('time_spent_seconds', 0.0),
        }
        
        progress = self.create(rec_vals)
        return {
            'id': progress.id,
            'create_date': str(progress.create_date),
        }