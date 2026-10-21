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
    # When the file now on uploaded_file was saved. Not create_date: the first
    # file can be removed later and the next one promoted into its place, and
    # each file shows its own saved time. Empty on older rows → create_date.
    file_at = fields.Datetime(string='File Saved On', readonly=True, copy=False)
    # Set by /kpi/progress/update only — "Edited <time>" on the update. Not
    # write_date, which also moves on internal writes nobody would call an edit.
    edited_at = fields.Datetime(string='Edited On', readonly=True, copy=False)
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

    # Files the CLIENT attached when raising the task (WhatsApp client form or
    # the client portal). They are shown in their own "From the client" section
    # and never count as the developer's progress summary at Complete.
    # Computed, not set by the two create sites, so every path (and every row
    # saved before this field existed) is marked the same way.
    from_client = fields.Boolean(
        string='From the client', compute='_compute_from_client', store=True, index=True)

    CLIENT_PORTAL_SUMMARY = 'Attached by the client when submitting this task.'

    @api.depends('summary', 'user_id', 'kpi_id.client_submitted', 'kpi_id.submitted_by_uid')
    def _compute_from_client(self):
        client_group = self.env.ref('kra_kpi_module.group_kra_client', raise_if_not_found=False)
        for rec in self:
            text = (rec.summary or '').strip()
            if text == self.CLIENT_PORTAL_SUMMARY or (
                    text.startswith('Attached by ') and text.endswith(' on the WhatsApp form.')):
                rec.from_client = True
                continue
            u = rec.user_id
            if not u or any(u.has_group(g) for g in (
                    'kra_kpi_module.group_kra_owner', 'kra_kpi_module.group_kra_admin',
                    'kra_kpi_module.group_kra_developer', 'base.group_system')):
                # Staff (developers included) never count as the client, even if
                # they once filed a task on a client's behalf.
                rec.from_client = False
                continue
            rec.from_client = bool(
                (client_group and client_group in u.all_group_ids)
                or (rec.kpi_id.client_submitted and rec.kpi_id.submitted_by_uid == u))
    
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