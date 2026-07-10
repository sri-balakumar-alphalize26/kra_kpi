from odoo import models, fields, api
from odoo.exceptions import UserError, ValidationError
import logging
from datetime import datetime, timedelta

_logger = logging.getLogger(__name__)


class KpiDataCleanup(models.Model):
    _name = 'kpi.data.cleanup'
    _description = 'KPI Data Cleanup Wizard'
    _order = 'create_date desc'

    name = fields.Char(string='Cleanup Name', required=True, default='Data Cleanup')
    cleanup_date = fields.Datetime(string='Cleanup Date', default=fields.Datetime.now, readonly=True)
    cleanup_type = fields.Selection([
        ('clean_all', 'Clean All Data'),
        ('selective', 'Selective Cleanup'),
        ('old_data', 'Clean Old Data Only')
    ], string='Cleanup Type', default='selective', required=True)
    
    # Selective cleanup options
    clean_kras = fields.Boolean(string='Delete KRAs', default=False)
    clean_kpis = fields.Boolean(string='Delete KPIs', default=False)
    clean_progress = fields.Boolean(string='Delete Progress Updates', default=False)
    clean_manuals = fields.Boolean(string='Delete User Manuals', default=False)
    clean_github = fields.Boolean(string='Delete GitHub Links', default=False)
    clean_reassignments = fields.Boolean(string='Delete Reassignment History', default=False)
    clean_reports = fields.Boolean(string='Delete Report Configs', default=False)
    
    # Old data cleanup
    days_old = fields.Integer(string='Delete Data Older Than (Days)', default=90)
    only_completed = fields.Boolean(string='Only Completed/Cancelled Tasks', default=True)
    
    # Backup safety
    create_backup_before = fields.Boolean(string='Create Backup Before Cleanup', default=True)
    force_cleanup_without_backup = fields.Boolean(string='Force Cleanup Without Recent Backup', default=False)
    last_backup_date = fields.Datetime(string='Last Backup Date', compute='_compute_last_backup')
    days_since_backup = fields.Integer(string='Days Since Last Backup', compute='_compute_last_backup')
    has_recent_backup = fields.Boolean(string='Has Recent Backup', compute='_compute_last_backup')
    
    # Cleanup results
    state = fields.Selection([
        ('draft', 'Draft'),
        ('in_progress', 'In Progress'),
        ('completed', 'Completed'),
        ('failed', 'Failed')
    ], string='Status', default='draft', readonly=True)
    
    kras_deleted = fields.Integer(string='KRAs Deleted', readonly=True, default=0)
    kpis_deleted = fields.Integer(string='KPIs Deleted', readonly=True, default=0)
    progress_deleted = fields.Integer(string='Progress Updates Deleted', readonly=True, default=0)
    manuals_deleted = fields.Integer(string='Manuals Deleted', readonly=True, default=0)
    github_deleted = fields.Integer(string='GitHub Links Deleted', readonly=True, default=0)
    reassignments_deleted = fields.Integer(string='Reassignments Deleted', readonly=True, default=0)
    reports_deleted = fields.Integer(string='Report Configs Deleted', readonly=True, default=0)
    
    executed_by = fields.Many2one('res.users', string='Executed By', readonly=True)
    backup_created_id = fields.Many2one('kpi.backup', string='Backup Created', readonly=True)
    notes = fields.Text(string='Notes')
    error_log = fields.Text(string='Error Log', readonly=True)

    @api.depends('cleanup_type')
    def _compute_last_backup(self):
        """Check for last backup"""
        for record in self:
            last_backup = self.env['kpi.backup'].search([
                ('state', '=', 'completed')
            ], order='backup_date desc', limit=1)
            
            if last_backup:
                record.last_backup_date = last_backup.backup_date
                days_diff = (fields.Datetime.now() - last_backup.backup_date).days
                record.days_since_backup = days_diff
                record.has_recent_backup = days_diff <= 7
            else:
                record.last_backup_date = False
                record.days_since_backup = 999
                record.has_recent_backup = False

    @api.onchange('cleanup_type')
    def _onchange_cleanup_type(self):
        """Set defaults based on cleanup type"""
        if self.cleanup_type == 'clean_all':
            self.clean_kras = True
            self.clean_kpis = True
            self.clean_progress = True
            self.clean_manuals = True
            self.clean_github = True
            self.clean_reassignments = True
            self.clean_reports = True
        elif self.cleanup_type == 'old_data':
            self.clean_kras = False
            self.clean_kpis = True
            self.clean_progress = True
            self.clean_manuals = False
            self.clean_github = False
            self.clean_reassignments = True
            self.clean_reports = False

    def _validate_cleanup_safety(self):
        """Validate if cleanup is safe to proceed"""
        self.ensure_one()
        
        # Check for recent backup
        if not self.has_recent_backup and not self.force_cleanup_without_backup:
            if self.days_since_backup == 999:
                raise UserError(
                    "No backup found! Creating a backup before cleanup is highly recommended.\n\n"
                    "Please either:\n"
                    "1. Create a backup first (recommended), or\n"
                    "2. Check 'Force Cleanup Without Recent Backup' to proceed anyway (not recommended)"
                )
            else:
                raise UserError(
                    f"Last backup was {self.days_since_backup} days ago! "
                    "A recent backup is recommended before cleanup.\n\n"
                    "Please either:\n"
                    "1. Create a new backup first (recommended), or\n"
                    "2. Check 'Force Cleanup Without Recent Backup' to proceed anyway (not recommended)"
                )
        
        # Validate cleanup selections
        if self.cleanup_type == 'selective':
            if not any([
                self.clean_kras, self.clean_kpis, self.clean_progress,
                self.clean_manuals, self.clean_github, self.clean_reassignments,
                self.clean_reports
            ]):
                raise ValidationError("Please select at least one item to clean for selective cleanup")
        
        if self.cleanup_type == 'old_data':
            if self.days_old <= 0:
                raise ValidationError("Days must be greater than 0 for old data cleanup")

    def get_cleanup_preview(self):
        """Get count of records that will be deleted"""
        self.ensure_one()
        
        preview = {
            'kras': 0,
            'kpis': 0,
            'progress': 0,
            'manuals': 0,
            'github': 0,
            'reassignments': 0,
            'reports': 0,
        }
        
        if self.cleanup_type == 'old_data':
            cutoff_date = fields.Datetime.now() - timedelta(days=self.days_old)
            
            if self.clean_kpis:
                domain = [('create_date', '<', cutoff_date)]
                if self.only_completed:
                    domain.append(('task_state', 'in', ['completed', 'cancelled']))
                preview['kpis'] = self.env['kra.kpi'].search_count(domain)
            
            if self.clean_progress:
                preview['progress'] = self.env['kpi.progress'].search_count([
                    ('create_date', '<', cutoff_date)
                ])
            
            if self.clean_reassignments:
                preview['reassignments'] = self.env['kpi.reassignment.history'].search_count([
                    ('reassignment_date', '<', cutoff_date)
                ])
        else:
            # Clean all or selective
            if self.clean_kras:
                preview['kras'] = self.env['kra.master'].search_count([])
            
            if self.clean_kpis:
                preview['kpis'] = self.env['kra.kpi'].search_count([])
            
            if self.clean_progress:
                preview['progress'] = self.env['kpi.progress'].search_count([])
            
            if self.clean_manuals:
                preview['manuals'] = self.env['kpi.user.manual'].search_count([])
            
            if self.clean_github:
                preview['github'] = self.env['kpi.github.link'].search_count([])
            
            if self.clean_reassignments:
                preview['reassignments'] = self.env['kpi.reassignment.history'].search_count([])
            
            if self.clean_reports:
                preview['reports'] = self.env['kpi.employee.salary.config'].search_count([])
        
        return preview

    def action_execute_cleanup(self):
        """Execute the cleanup operation"""
        self.ensure_one()
        
        try:
            # Validate safety
            self._validate_cleanup_safety()
            
            # Create backup if requested
            if self.create_backup_before:
                backup = self._create_pre_cleanup_backup()
                self.backup_created_id = backup.id
            
            # Update state
            self.write({
                'state': 'in_progress',
                'executed_by': self.env.user.id
            })
            self.env.cr.commit()
            
            # Execute cleanup based on type (WITH SUDO to bypass security)
            if self.cleanup_type == 'old_data':
                self._cleanup_old_data()
            else:
                self._cleanup_selected_data()
            
            # Mark as completed
            self.write({'state': 'completed'})
            
            _logger.info(f"Cleanup completed successfully: {self.name}")
            
            return {
                'type': 'ir.actions.client',
                'tag': 'display_notification',
                'params': {
                    'title': 'Cleanup Completed',
                    'message': self._get_cleanup_summary(),
                    'type': 'success',
                    'sticky': True,
                }
            }
            
        except Exception as e:
            error_msg = f"Cleanup failed: {str(e)}"
            _logger.error(error_msg)
            self.write({
                'state': 'failed',
                'error_log': error_msg
            })
            raise UserError(error_msg)

    def _create_pre_cleanup_backup(self):
        """Create backup before cleanup"""
        backup = self.env['kpi.backup'].create({
            'name': f'Pre-Cleanup Backup - {datetime.now().strftime("%Y-%m-%d %H:%M")}',
            'backup_type': 'full',
            'include_kra': True,
            'include_kpi': True,
            'include_progress': True,
            'include_manuals': True,
            'include_github': True,
            'include_reassignments': True,
            'include_reports': True,
            'include_attachments': True,
        })
        
        backup.action_create_backup()
        return backup

    def _cleanup_old_data(self):
        """Clean up old data based on date - WITH SUDO"""
        cutoff_date = fields.Datetime.now() - timedelta(days=self.days_old)
        
        # Clean old KPIs (WITH SUDO)
        if self.clean_kpis:
            domain = [('create_date', '<', cutoff_date)]
            if self.only_completed:
                domain.append(('task_state', 'in', ['completed', 'cancelled']))
            
            old_kpis = self.env['kra.kpi'].sudo().search(domain)
            self.kpis_deleted = len(old_kpis)
            old_kpis.unlink()
        
        # Clean old progress updates (WITH SUDO)
        if self.clean_progress:
            old_progress = self.env['kpi.progress'].sudo().search([
                ('create_date', '<', cutoff_date)
            ])
            self.progress_deleted = len(old_progress)
            old_progress.unlink()
        
        # Clean old reassignments (WITH SUDO)
        if self.clean_reassignments:
            old_reassignments = self.env['kpi.reassignment.history'].sudo().search([
                ('reassignment_date', '<', cutoff_date)
            ])
            self.reassignments_deleted = len(old_reassignments)
            old_reassignments.unlink()

    def _cleanup_selected_data(self):
        """Clean up selected data types - WITH SUDO"""
        
        # Clean GitHub Links first (foreign key to KPI) - WITH SUDO
        if self.clean_github:
            github_links = self.env['kpi.github.link'].sudo().search([])
            self.github_deleted = len(github_links)
            github_links.unlink()
        
        # Clean User Manuals (foreign key to KPI) - WITH SUDO
        if self.clean_manuals:
            manuals = self.env['kpi.user.manual'].sudo().search([])
            self.manuals_deleted = len(manuals)
            manuals.unlink()
        
        # Clean Progress Updates (foreign key to KPI) - WITH SUDO
        if self.clean_progress:
            progress = self.env['kpi.progress'].sudo().search([])
            self.progress_deleted = len(progress)
            progress.unlink()
        
        # Clean Reassignment History (foreign key to KPI) - WITH SUDO
        if self.clean_reassignments:
            reassignments = self.env['kpi.reassignment.history'].sudo().search([])
            self.reassignments_deleted = len(reassignments)
            reassignments.unlink()
        
        # Clean KPIs (foreign key to KRA) - WITH SUDO
        if self.clean_kpis:
            kpis = self.env['kra.kpi'].sudo().search([])
            self.kpis_deleted = len(kpis)
            kpis.unlink()
        
        # Clean KRAs (must be last due to hierarchy) - WITH SUDO
        if self.clean_kras:
            kras = self.env['kra.master'].sudo().search([])
            self.kras_deleted = len(kras)
            kras.unlink()
        
        # Clean Report Configs - WITH SUDO
        if self.clean_reports:
            reports = self.env['kpi.employee.salary.config'].sudo().search([])
            self.reports_deleted = len(reports)
            reports.unlink()

    def _get_cleanup_summary(self):
        """Generate cleanup summary message"""
        summary = f"Cleanup completed successfully!\n\n"
        
        if self.kras_deleted > 0:
            summary += f"✓ KRAs deleted: {self.kras_deleted}\n"
        if self.kpis_deleted > 0:
            summary += f"✓ KPIs deleted: {self.kpis_deleted}\n"
        if self.progress_deleted > 0:
            summary += f"✓ Progress updates deleted: {self.progress_deleted}\n"
        if self.manuals_deleted > 0:
            summary += f"✓ User manuals deleted: {self.manuals_deleted}\n"
        if self.github_deleted > 0:
            summary += f"✓ GitHub links deleted: {self.github_deleted}\n"
        if self.reassignments_deleted > 0:
            summary += f"✓ Reassignments deleted: {self.reassignments_deleted}\n"
        if self.reports_deleted > 0:
            summary += f"✓ Report configs deleted: {self.reports_deleted}\n"
        
        if self.backup_created_id:
            summary += f"\n✓ Backup created: {self.backup_created_id.name}"
        
        return summary