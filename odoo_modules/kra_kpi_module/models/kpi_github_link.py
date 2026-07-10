from odoo import api, models, fields


class KpiGithubLink(models.Model):
    _name = "kpi.github.link"
    _description = "KPI GitHub Repository Links"
    _order = "create_date desc"

    kpi_id = fields.Many2one(
        'kra.kpi',
        string='KPI Task',
        required=True,
        ondelete='cascade'
    )
    
    progress_id = fields.Many2one(
        'kpi.progress',
        string='Progress Update',
        ondelete='cascade',
        help='Link to specific progress update if added during progress submission'
    )
    
    github_url = fields.Char(
        string='GitHub URL',
        required=True,
        help='GitHub repository URL'
    )
    
    branch_name = fields.Text(
        string='Branch Name',
        required=True,
        help='Git branch name or description'
    )
    
    user_id = fields.Many2one(
        'res.users',
        string='Employee',
        required=True,
        default=lambda self: self.env.user,
        readonly=True
    )
    
    create_date = fields.Datetime(
        string='Uploaded On',
        readonly=True
    )
    
    # Related fields for easy access
    employee_name = fields.Char(
        related='user_id.name',
        string='Employee Name',
        store=True
    )
    
    kpi_name = fields.Char(
        related='kpi_id.name',
        string='Task Name',
        store=True
    )