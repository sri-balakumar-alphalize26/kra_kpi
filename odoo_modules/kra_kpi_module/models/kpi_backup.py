from odoo import models, fields, api
from odoo.exceptions import UserError
import json
import base64
import logging
from datetime import datetime
import zipfile
import io

_logger = logging.getLogger(__name__)


class KpiBackup(models.Model):
    _name = 'kpi.backup'
    _description = 'KPI Backup and Restore'
    _order = 'create_date desc'

    name = fields.Char(string='Backup Name', required=True)
    backup_date = fields.Datetime(string='Backup Date', default=fields.Datetime.now, readonly=True)
    backup_type = fields.Selection([
        ('full', 'Full Backup'),
        ('incremental', 'Incremental Backup'),
        ('selective', 'Selective Backup')
    ], string='Backup Type', default='full', required=True)
    # Track last backup for incremental
    last_full_backup_id = fields.Many2one('kpi.backup', string='Last Full Backup', readonly=True)
    last_full_backup_date = fields.Datetime(string='Last Full Backup Date', readonly=True)
    reference_date = fields.Datetime(string='Reference Date for Incremental', help="For incremental backups, only records modified after this date are included")
    
    backup_file = fields.Binary(string='Backup File', attachment=True)
    backup_filename = fields.Char(string='Filename')
    backup_size = fields.Float(string='Size (MB)', compute='_compute_backup_size', store=True)
    
    # Backup options
    include_kra = fields.Boolean(string='Include KRAs', default=True)
    include_kpi = fields.Boolean(string='Include KPIs', default=True)
    include_progress = fields.Boolean(string='Include Progress Updates', default=True)
    include_manuals = fields.Boolean(string='Include User Manuals', default=True)
    include_github = fields.Boolean(string='Include GitHub Links', default=True)
    include_reassignments = fields.Boolean(string='Include Reassignment History', default=True)
    include_reports = fields.Boolean(string='Include Reports Config', default=True)
    include_attachments = fields.Boolean(string='Include All Attachments', default=True)
    
    # Backup statistics
    kra_count = fields.Integer(string='KRAs Backed Up', readonly=True)
    kpi_count = fields.Integer(string='KPIs Backed Up', readonly=True)
    attachment_count = fields.Integer(string='Attachments Backed Up', readonly=True)
    links_count = fields.Integer(string='Links Backed Up', readonly=True)
    
    # Restore tracking
    is_restored = fields.Boolean(string='Is Restored', default=False, readonly=True)
    restored_date = fields.Datetime(string='Restored Date', readonly=True)
    restored_by = fields.Many2one('res.users', string='Restored By', readonly=True)
    
    notes = fields.Text(string='Notes')
    state = fields.Selection([
        ('draft', 'Draft'),
        ('in_progress', 'In Progress'),
        ('completed', 'Completed'),
        ('failed', 'Failed')
    ], string='Status', default='draft', readonly=True)
    
    error_log = fields.Text(string='Error Log', readonly=True)

    @api.depends('backup_file')
    def _compute_backup_size(self):
        for record in self:
            if record.backup_file:
                # Calculate size in MB
                size_bytes = len(base64.b64decode(record.backup_file))
                record.backup_size = size_bytes / (1024 * 1024)
            else:
                record.backup_size = 0.0

    @api.onchange('backup_type')
    def _onchange_backup_type(self):
        """Set reference date when incremental is selected"""
        if self.backup_type == 'incremental':
            # Find the last completed full or incremental backup
            last_backup = self.search([
                ('state', '=', 'completed'),
                ('backup_type', 'in', ['full', 'incremental'])
            ], order='backup_date desc', limit=1)
            
            if last_backup:
                self.reference_date = last_backup.backup_date
                self.last_full_backup_id = last_backup.last_full_backup_id or last_backup
                self.last_full_backup_date = self.last_full_backup_id.backup_date if self.last_full_backup_id else last_backup.backup_date
            else:
                # No previous backup found, force full backup
                self.backup_type = 'full'
                return {
                    'warning': {
                        'title': 'No Previous Backup Found',
                        'message': 'Incremental backup requires a previous full backup. Changed to Full Backup.'
                    }
                } 
    def _get_incremental_domain(self, base_domain=None):
        """Get domain for incremental backup"""
        if base_domain is None:
            base_domain = []
        
        if self.backup_type == 'incremental' and self.reference_date:
            # Add date filter for incremental
            date_domain = [
                '|',
                ('create_date', '>', self.reference_date),
                ('write_date', '>', self.reference_date)
            ]
            return base_domain + date_domain
        
        return base_domain          

    def action_create_backup(self):
        """Create a comprehensive backup of KPI data"""
        self.ensure_one()
        
        try:
            # For incremental backup, ensure reference_date is set
            if self.backup_type == 'incremental':
                if not self.reference_date:
                    # Auto-set reference date from last backup
                    last_backup = self.search([
                        ('state', '=', 'completed'),
                        ('backup_type', 'in', ['full', 'incremental']),
                        ('id', '!=', self.id)
                    ], order='backup_date desc', limit=1)
                    
                    if last_backup:
                        self.reference_date = last_backup.backup_date
                        if not self.last_full_backup_id:
                            self.last_full_backup_id = last_backup.last_full_backup_id or last_backup
                            self.last_full_backup_date = self.last_full_backup_id.backup_date if self.last_full_backup_id else last_backup.backup_date
                    else:
                        # No previous backup exists, force to full backup
                        self.backup_type = 'full'
                        return {
                            'type': 'ir.actions.client',
                            'tag': 'display_notification',
                            'params': {
                                'title': 'Changed to Full Backup',
                                'message': 'No previous backup found. Creating a full backup instead.',
                                'type': 'warning',
                                'sticky': True,
                            }
                        }
                
                # Still no reference date after auto-setting? Error
                if not self.reference_date:
                    raise UserError("Unable to determine reference date for incremental backup. Please create a full backup first.")
            
            self.write({'state': 'in_progress'})
            self.env.cr.commit()
            
            backup_data = {
                'metadata': {
                    'backup_name': self.name,
                    'backup_date': str(self.backup_date),
                    'backup_type': self.backup_type,
                    'reference_date': str(self.reference_date) if self.reference_date else None,
                    'is_incremental': self.backup_type == 'incremental',
                    'last_full_backup_date': str(self.last_full_backup_date) if self.last_full_backup_date else None,
                    'odoo_version': '19.0',
                    'module_version': '1.0'
                },
                'data': {},
                'links': {
                    'related_links': [],
                    'github_links': []
                }
            }
            
            # Backup KRAs
            if self.include_kra:
                backup_data['data']['kras'] = self._backup_kras()
            
            # Backup KPIs
            if self.include_kpi:
                backup_data['data']['kpis'] = self._backup_kpis()
            
            # Backup Progress Updates
            if self.include_progress:
                backup_data['data']['progress_updates'] = self._backup_progress()
            
            # Backup User Manuals
            if self.include_manuals:
                backup_data['data']['manuals'] = self._backup_manuals()
            
            # Backup GitHub Links
            if self.include_github:
                backup_data['data']['github_links'] = self._backup_github()
            
            # Backup Reassignment History
            if self.include_reassignments:
                backup_data['data']['reassignments'] = self._backup_reassignments()
            
            # Backup Reports Configuration
            if self.include_reports:
                backup_data['data']['reports'] = self._backup_reports()

            # Extract and catalog all links
            self._extract_all_links(backup_data)
            
            # Create ZIP file with all data
            zip_buffer = io.BytesIO()
            with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
                # Add JSON data
                json_data = json.dumps(backup_data, indent=2, default=str)
                zip_file.writestr('backup_data.json', json_data)
                
                # Add readable links catalog
                links_catalog = self._generate_links_catalog(backup_data['links'])
                zip_file.writestr('links_catalog.txt', links_catalog)
                
                # Add CSV of all links
                links_csv = self._generate_links_csv(backup_data['links'])
                zip_file.writestr('links_catalog.csv', links_csv)
                
                # Add README
                readme = self._generate_readme(backup_data)
                zip_file.writestr('README.txt', readme)
                
                # Add attachments if selected
                if self.include_attachments:
                    self._add_attachments_to_zip(zip_file, backup_data)
            
            # Save backup file
            zip_content = zip_buffer.getvalue()
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            backup_type_prefix = 'FULL' if self.backup_type == 'full' else 'INCR'
            filename = f"KPI_Backup_{backup_type_prefix}_{timestamp}.zip"
            
            # Update record
            vals = {
                'backup_file': base64.b64encode(zip_content),
                'backup_filename': filename,
                'state': 'completed'
            }
            
            # For full backup, set as reference for future incremental backups
            if self.backup_type == 'full':
                vals['last_full_backup_id'] = self.id
                vals['last_full_backup_date'] = self.backup_date
            
            self.write(vals)
            
            _logger.info(f"Backup created successfully: {filename}")
            
            # Show success message with stats
            message = f'Backup created successfully: {filename}\n'
            if self.backup_type == 'incremental':
                message += f'Changes since: {self.reference_date.strftime("%Y-%m-%d %H:%M")}\n'
            message += f'KRAs: {self.kra_count}, KPIs: {self.kpi_count}, Links: {self.links_count}, Attachments: {self.attachment_count}'
            
            return {
                'type': 'ir.actions.client',
                'tag': 'display_notification',
                'params': {
                    'title': 'Backup Created',
                    'message': message,
                    'type': 'success',
                    'sticky': False,
                }
            }
            
        except Exception as e:
            error_msg = f"Backup failed: {str(e)}"
            _logger.error(error_msg)
            self.write({
                'state': 'failed',
                'error_log': error_msg
            })
            raise UserError(error_msg)

    def _backup_kras(self):
        """Backup KRA records"""
        domain = self._get_incremental_domain()
        kras = self.env['kra.master'].search(domain)
        self.kra_count = len(kras)
        
        kra_data = []
        for kra in kras:
            kra_data.append({
                'id': kra.id,
                'name': kra.name,
                'is_sub': kra.is_sub,
                'parent_id': kra.parent_id.id if kra.parent_id else None,
                'parent_name': kra.parent_id.name if kra.parent_id else None,
                'sequence': kra.sequence,
                'active': kra.active,
                'create_date': str(kra.create_date),
                'write_date': str(kra.write_date)
            })
        
        return kra_data

    def _backup_kpis(self):
        """Backup KPI records"""
        domain = self._get_incremental_domain()
        kpis = self.env['kra.kpi'].search(domain)
        self.kpi_count = len(kpis)
        
        kpi_data = []
        for kpi in kpis:
            kpi_data.append({
                'id': kpi.id,
                'name': kpi.name,
                'kra_id': kpi.kra_id.id if kpi.kra_id else None,
                'kra_name': kpi.kra_id.name if kpi.kra_id else None,
                'estimate_hours': kpi.estimate_hours,
                'estimate_minutes': kpi.estimate_minutes,
                'priority': kpi.priority,
                'user_id': kpi.user_id.id if kpi.user_id else None,
                'user_name': kpi.user_id.name if kpi.user_id else None,
                'user_group_id': kpi.user_group_id.id if kpi.user_group_id else None,
                'points': kpi.points,
                'deadline': str(kpi.deadline) if kpi.deadline else None,
                'reminder_days': kpi.reminder_days,
                'description': kpi.description,
                'checklist': kpi.checklist,
                'guidelines': kpi.guidelines,
                'related_links': kpi.related_links,
                'task_state': kpi.task_state,
                'timer_total_seconds': kpi.timer_total_seconds,
                'is_mandatory': kpi.is_mandatory,
                'auto_assign': kpi.auto_assign,
                'auto_estimated': kpi.auto_estimated,
                'is_permanent': kpi.is_permanent,
                'service_kpi': kpi.service_kpi,
                'is_meeting': kpi.is_meeting,
                'is_manager_review_needed': kpi.is_manager_review_needed,
                'is_customer_review_needed': kpi.is_customer_review_needed,
                'file_name': kpi.file_name,
                'has_file': bool(kpi.uploaded_file),
                'reassignment_log': kpi.reassignment_log,
                # Checklist fields
                'employee_checklist_github': kpi.employee_checklist_github,
                'employee_checklist_deployed': kpi.employee_checklist_deployed,
                'employee_checklist_manual': kpi.employee_checklist_manual,
                'employee_checklist_docs': kpi.employee_checklist_docs,
                'employee_checklist_tested': kpi.employee_checklist_tested,
                'manager_checklist_reviewed': kpi.manager_checklist_reviewed,
                'manager_checklist_manual_reviewed': kpi.manager_checklist_manual_reviewed,
                'manager_checklist_testing': kpi.manager_checklist_testing,
                'manager_checklist_github': kpi.manager_checklist_github,
                'manager_checklist_tested_success': kpi.manager_checklist_tested_success,
                'manager_checklist_docs_approved': kpi.manager_checklist_docs_approved,
                'create_date': str(kpi.create_date),
                'write_date': str(kpi.write_date)
            })
        
        return kpi_data

    def _backup_progress(self):
        """Backup progress updates"""
        domain = self._get_incremental_domain()
        progress_records = self.env['kpi.progress'].search(domain)
        
        progress_data = []
        for progress in progress_records:
            progress_data.append({
                'id': progress.id,
                'kpi_id': progress.kpi_id.id,
                'kpi_name': progress.kpi_id.name,
                'user_id': progress.user_id.id,
                'user_name': progress.user_id.name,
                'summary': progress.summary,
                'file_name': progress.file_name,
                'has_file': bool(progress.uploaded_file),
                'related_links': progress.related_links,
                'create_date': str(progress.create_date),
                'write_date': str(progress.write_date)
            })
        
        return progress_data

    def _backup_manuals(self):
        """Backup user manuals"""
        domain = self._get_incremental_domain()
        manuals = self.env['kpi.user.manual'].search(domain)
        
        manual_data = []
        for manual in manuals:
            manual_data.append({
                'id': manual.id,
                'kpi_id': manual.kpi_id.id,
                'kpi_name': manual.kpi_id.name,
                'file_name': manual.file_name,
                'description': manual.description,
                'related_links': manual.related_links,
                'uploaded_by': manual.uploaded_by.id,
                'uploader_name': manual.uploader_name,
                'upload_date': str(manual.upload_date),
                'has_file': bool(manual.manual_file),
                'create_date': str(manual.create_date),
                'write_date': str(manual.write_date)
            })
        
        return manual_data

    def _backup_github(self):
        """Backup GitHub links"""
        domain = self._get_incremental_domain()
        github_links = self.env['kpi.github.link'].search(domain)
        
        github_data = []
        for link in github_links:
            github_data.append({
                'id': link.id,
                'kpi_id': link.kpi_id.id,
                'kpi_name': link.kpi_id.name,
                'github_url': link.github_url,
                'branch_name': link.branch_name,
                'user_id': link.user_id.id,
                'employee_name': link.employee_name,
                'create_date': str(link.create_date),
                'write_date': str(link.write_date)
            })
        
        return github_data

    def _backup_reassignments(self):
        """Backup reassignment history"""
        domain = self._get_incremental_domain()
        reassignments = self.env['kpi.reassignment.history'].search(domain)
        
        reassignment_data = []
        for reassignment in reassignments:
            reassignment_data.append({
                'id': reassignment.id,
                'kpi_id': reassignment.kpi_id.id,
                'previous_assignee_id': reassignment.previous_assignee_id.id,
                'previous_assignee_name': reassignment.previous_assignee_name,
                'new_assignee_id': reassignment.new_assignee_id.id,
                'new_assignee_name': reassignment.new_assignee_name,
                'reassigned_by_id': reassignment.reassigned_by_id.id,
                'reassigned_by_name': reassignment.reassigned_by_name,
                'reassignment_date': str(reassignment.reassignment_date),
                'reassignment_reason': reassignment.reassignment_reason,
                'previous_state': reassignment.previous_state,
                'time_spent_seconds': reassignment.time_spent_seconds,
                'was_paused': reassignment.was_paused,
                'pause_reason': reassignment.pause_reason,
                'create_date': str(reassignment.create_date)
            })
        
        return reassignment_data

    def _backup_reports(self):
        """Backup report configurations"""
        salary_configs = self.env['kpi.employee.salary.config'].search([])
        
        report_data = {
            'salary_configs': []
        }
        
        for config in salary_configs:
            report_data['salary_configs'].append({
                'employee_id': config.employee_id.id,
                'employee_name': config.employee_id.name,
                'salary': config.salary,
                'working_days': config.working_days,
                'attendance_hours_per_day': config.attendance_hours_per_day,
                'last_updated': str(config.last_updated)
            })
        
        return report_data
    
    def _extract_all_links(self, backup_data):
        """Extract all links from the backup data into organized structure"""
        links_data = backup_data['links']
        link_count = 0
        
        # Extract from KPIs
        for kpi in backup_data.get('data', {}).get('kpis', []):
            if kpi.get('related_links'):
                for link in kpi['related_links'].split('\n'):
                    link = link.strip()
                    if link:
                        links_data['related_links'].append({
                            'url': link,
                            'source': 'KPI',
                            'source_id': kpi['id'],
                            'source_name': kpi['name'],
                            'type': self._categorize_link(link)
                        })
                        link_count += 1
        
        # Extract from Progress Updates
        for progress in backup_data.get('data', {}).get('progress_updates', []):
            if progress.get('related_links'):
                for link in progress['related_links'].split('\n'):
                    link = link.strip()
                    if link:
                        links_data['related_links'].append({
                            'url': link,
                            'source': 'Progress Update',
                            'source_id': progress['id'],
                            'kpi_name': progress['kpi_name'],
                            'user_name': progress['user_name'],
                            'type': self._categorize_link(link)
                        })
                        link_count += 1
        
        # Extract from User Manuals
        for manual in backup_data.get('data', {}).get('manuals', []):
            if manual.get('related_links'):
                for link in manual['related_links'].split('\n'):
                    link = link.strip()
                    if link:
                        links_data['related_links'].append({
                            'url': link,
                            'source': 'User Manual',
                            'source_id': manual['id'],
                            'kpi_name': manual['kpi_name'],
                            'type': self._categorize_link(link)
                        })
                        link_count += 1
        
        # Extract GitHub Links
        for github in backup_data.get('data', {}).get('github_links', []):
            if github.get('github_url'):
                links_data['github_links'].append({
                    'url': github['github_url'],
                    'branch': github.get('branch_name', 'N/A'),
                    'kpi_name': github['kpi_name'],
                    'employee_name': github['employee_name'],
                    'create_date': github['create_date']
                })
                link_count += 1
        
        self.links_count = link_count

    def _categorize_link(self, url):
        """Categorize link type based on URL"""
        url_lower = url.lower()
        if 'github.com' in url_lower or 'gitlab.com' in url_lower:
            return 'Repository'
        elif 'drive.google.com' in url_lower or 'docs.google.com' in url_lower:
            return 'Google Drive'
        elif 'youtube.com' in url_lower or 'youtu.be' in url_lower:
            return 'YouTube'
        elif 'dropbox.com' in url_lower or 'onedrive.com' in url_lower:
            return 'Cloud Storage'
        elif url_lower.startswith('mailto:'):
            return 'Email'
        else:
            return 'Other'

    def _generate_links_catalog(self, links_data):
        """Generate a readable text catalog of all links"""
        catalog = []
        catalog.append("=" * 80)
        catalog.append("KPI BACKUP - LINKS CATALOG")
        catalog.append("=" * 80)
        catalog.append("")
        
        # GitHub Links
        if links_data['github_links']:
            catalog.append("GITHUB REPOSITORY LINKS")
            catalog.append("-" * 80)
            for idx, link in enumerate(links_data['github_links'], 1):
                catalog.append(f"{idx}. {link['url']}")
                catalog.append(f"   Branch: {link['branch']}")
                catalog.append(f"   KPI: {link['kpi_name']}")
                catalog.append(f"   Employee: {link['employee_name']}")
                catalog.append(f"   Date: {link['create_date']}")
                catalog.append("")
        
        # Related Links by Type
        if links_data['related_links']:
            # Group by type
            by_type = {}
            for link in links_data['related_links']:
                link_type = link['type']
                if link_type not in by_type:
                    by_type[link_type] = []
                by_type[link_type].append(link)
            
            for link_type, type_links in by_type.items():
                catalog.append(f"{link_type.upper()} LINKS")
                catalog.append("-" * 80)
                for idx, link in enumerate(type_links, 1):
                    catalog.append(f"{idx}. {link['url']}")
                    catalog.append(f"   Source: {link['source']}")
                    if 'source_name' in link:
                        catalog.append(f"   Related to: {link['source_name']}")
                    elif 'kpi_name' in link:
                        catalog.append(f"   KPI: {link['kpi_name']}")
                    if 'user_name' in link:
                        catalog.append(f"   User: {link['user_name']}")
                    catalog.append("")
        
        catalog.append("=" * 80)
        catalog.append(f"Total Links: {len(links_data['github_links']) + len(links_data['related_links'])}")
        catalog.append("=" * 80)
        
        return "\n".join(catalog)

    def _generate_links_csv(self, links_data):
        """Generate CSV file with all links"""
        import csv
        from io import StringIO
        
        output = StringIO()
        writer = csv.writer(output)
        
        # Header
        writer.writerow(['Type', 'URL', 'Source', 'Related To', 'User/Employee', 'Branch', 'Date'])
        
        # GitHub links
        for link in links_data['github_links']:
            writer.writerow([
                'GitHub',
                link['url'],
                'GitHub Link',
                link['kpi_name'],
                link['employee_name'],
                link['branch'],
                link['create_date']
            ])
        
        # Other links
        for link in links_data['related_links']:
            writer.writerow([
                link['type'],
                link['url'],
                link['source'],
                link.get('source_name') or link.get('kpi_name', ''),
                link.get('user_name', ''),
                '',
                ''
            ])
        
        return output.getvalue()

    def _generate_readme(self, backup_data):
        """Generate README file for the backup"""
        metadata = backup_data['metadata']
        
        readme = []
        readme.append("=" * 80)
        readme.append("KPI BACKUP - README")
        readme.append("=" * 80)
        readme.append("")
        readme.append(f"Backup Name: {metadata['backup_name']}")
        readme.append(f"Backup Date: {metadata['backup_date']}")
        readme.append(f"Backup Type: {metadata['backup_type'].upper()}")
        readme.append("")
        
        if metadata.get('is_incremental'):
            readme.append("INCREMENTAL BACKUP INFORMATION:")
            readme.append(f"  Reference Date: {metadata['reference_date']}")
            readme.append(f"  Last Full Backup: {metadata['last_full_backup_date']}")
            readme.append("  Note: This backup only contains records modified after the reference date.")
            readme.append("")
        
        readme.append("CONTENTS:")
        readme.append("-" * 80)
        readme.append("1. backup_data.json - Complete backup data in JSON format")
        readme.append("2. links_catalog.txt - Human-readable catalog of all links")
        readme.append("3. links_catalog.csv - Spreadsheet of all links")
        readme.append("4. README.txt - This file")
        readme.append("")
        
        if self.include_attachments:
            readme.append("5. kpi_files/ - Folder containing KPI attached files")
            readme.append("6. progress_files/ - Folder containing progress update files")
            readme.append("7. manual_files/ - Folder containing user manual files")
            readme.append("")
        
        readme.append("STATISTICS:")
        readme.append("-" * 80)
        readme.append(f"KRAs: {self.kra_count}")
        readme.append(f"KPIs: {self.kpi_count}")
        readme.append(f"Attachments: {self.attachment_count}")
        readme.append(f"Links: {self.links_count}")
        readme.append("")
        
        readme.append("HOW TO VIEW LINKS:")
        readme.append("-" * 80)
        readme.append("1. Open links_catalog.txt for a readable list organized by type")
        readme.append("2. Open links_catalog.csv in Excel/Sheets for filtering and sorting")
        readme.append("3. Search backup_data.json for specific link details")
        readme.append("")
        
        readme.append("RESTORATION:")
        readme.append("-" * 80)
        readme.append("To restore this backup:")
        readme.append("1. Upload the .zip file in Odoo")
        readme.append("2. Go to KPI Backup & Restore menu")
        readme.append("3. Select this backup record")
        readme.append("4. Click 'Restore Backup' button")
        readme.append("")
        
        if metadata.get('is_incremental'):
            readme.append("IMPORTANT: Incremental backups should be restored in order,")
            readme.append("starting from the last full backup.")
            readme.append("")
        
        readme.append("=" * 80)
        
        return "\n".join(readme)

    def _add_attachments_to_zip(self, zip_file, backup_data):
        """Add all binary attachments to ZIP"""
        attachment_count = 0
        
        # KPI uploaded files
        if self.include_kpi:
            kpis = self.env['kra.kpi'].search([('uploaded_file', '!=', False)])
            for kpi in kpis:
                try:
                    file_data = base64.b64decode(kpi.uploaded_file)
                    filename = f"kpi_files/{kpi.id}_{kpi.file_name or 'file'}"
                    zip_file.writestr(filename, file_data)
                    attachment_count += 1
                except Exception as e:
                    _logger.error(f"Error adding KPI file {kpi.id}: {str(e)}")
        
        # Progress update files
        if self.include_progress:
            progress_records = self.env['kpi.progress'].search([('uploaded_file', '!=', False)])
            for progress in progress_records:
                try:
                    file_data = base64.b64decode(progress.uploaded_file)
                    filename = f"progress_files/{progress.id}_{progress.file_name or 'file'}"
                    zip_file.writestr(filename, file_data)
                    attachment_count += 1
                except Exception as e:
                    _logger.error(f"Error adding progress file {progress.id}: {str(e)}")
        
        # User manual files
        if self.include_manuals:
            manuals = self.env['kpi.user.manual'].search([('manual_file', '!=', False)])
            for manual in manuals:
                try:
                    file_data = base64.b64decode(manual.manual_file)
                    filename = f"manual_files/{manual.id}_{manual.file_name or 'manual.pdf'}"
                    zip_file.writestr(filename, file_data)
                    attachment_count += 1
                except Exception as e:
                    _logger.error(f"Error adding manual file {manual.id}: {str(e)}")
        
        self.attachment_count = attachment_count

    def action_restore_backup(self):
        """Restore backup data"""
        self.ensure_one()
        
        if not self.backup_file:
            raise UserError("No backup file found to restore!")
        
        try:
            # Extract ZIP file
            zip_content = base64.b64decode(self.backup_file)
            zip_buffer = io.BytesIO(zip_content)
            
            with zipfile.ZipFile(zip_buffer, 'r') as zip_file:
                # Read JSON data
                json_content = zip_file.read('backup_data.json').decode('utf-8')
                backup_data = json.loads(json_content)
                
                # Restore data
                self._restore_data(backup_data, zip_file)
            
            self.write({
                'is_restored': True,
                'restored_date': fields.Datetime.now(),
                'restored_by': self.env.user.id
            })
            
            return {
                'type': 'ir.actions.client',
                'tag': 'display_notification',
                'params': {
                    'title': 'Restore Completed',
                    'message': 'Backup restored successfully!',
                    'type': 'success',
                    'sticky': False,
                }
            }
            
        except Exception as e:
            error_msg = f"Restore failed: {str(e)}"
            _logger.error(error_msg)
            raise UserError(error_msg)

    def _restore_data(self, backup_data, zip_file):
        """Restore all data from backup"""
        
        # Create mapping for old IDs to new IDs
        id_mapping = {
            'kra': {},
            'kpi': {},
            'user': {}
        }
        
        # Restore KRAs first (they're referenced by KPIs)
        if 'kras' in backup_data.get('data', {}):
            self._restore_kras(backup_data['data']['kras'], id_mapping)
        
        # Restore KPIs
        if 'kpis' in backup_data.get('data', {}):
            self._restore_kpis(backup_data['data']['kpis'], id_mapping, zip_file)
        
        # Restore Progress Updates
        if 'progress_updates' in backup_data.get('data', {}):
            self._restore_progress(backup_data['data']['progress_updates'], id_mapping, zip_file)
        
        # Restore User Manuals
        if 'manuals' in backup_data.get('data', {}):
            self._restore_manuals(backup_data['data']['manuals'], id_mapping, zip_file)
        
        # Restore GitHub Links
        if 'github_links' in backup_data.get('data', {}):
            self._restore_github(backup_data['data']['github_links'], id_mapping)
        
        # Restore Reassignments
        if 'reassignments' in backup_data.get('data', {}):
            self._restore_reassignments(backup_data['data']['reassignments'], id_mapping)
        
        # Restore Reports Config
        if 'reports' in backup_data.get('data', {}):
            self._restore_reports(backup_data['data']['reports'])

    def _restore_kras(self, kra_data, id_mapping):
        """Restore KRA records"""
        # Sort to create parents before children
        kra_data_sorted = sorted(kra_data, key=lambda x: (x['is_sub'], x.get('parent_id') or 0))
        
        for kra_info in kra_data_sorted:
            vals = {
                'name': kra_info['name'],
                'is_sub': kra_info['is_sub'],
                'sequence': kra_info.get('sequence', 10),
                'active': kra_info.get('active', True)
            }
            
            # Map parent ID if exists
            if kra_info.get('parent_id') and kra_info['parent_id'] in id_mapping['kra']:
                vals['parent_id'] = id_mapping['kra'][kra_info['parent_id']]
            
            new_kra = self.env['kra.master'].create(vals)
            id_mapping['kra'][kra_info['id']] = new_kra.id

    def _restore_kpis(self, kpi_data, id_mapping, zip_file):
        """Restore KPI records"""
        for kpi_info in kpi_data:
            vals = {
                'name': kpi_info['name'],
                'kra_id': id_mapping['kra'].get(kpi_info['kra_id']),
                'estimate_hours': kpi_info.get('estimate_hours', 0),
                'estimate_minutes': kpi_info.get('estimate_minutes', 0),
                'priority': kpi_info.get('priority', 'regular'),
                'points': kpi_info.get('points', 0),
                'deadline': kpi_info.get('deadline'),
                'reminder_days': kpi_info.get('reminder_days', 0),
                'description': kpi_info.get('description'),
                'checklist': kpi_info.get('checklist'),
                'guidelines': kpi_info.get('guidelines'),
                'related_links': kpi_info.get('related_links'),
                'task_state': kpi_info.get('task_state', 'assigned'),
                'timer_total_seconds': kpi_info.get('timer_total_seconds', 0),
                'is_mandatory': kpi_info.get('is_mandatory', False),
                'auto_assign': kpi_info.get('auto_assign', False),
                'auto_estimated': kpi_info.get('auto_estimated', False),
                'is_permanent': kpi_info.get('is_permanent', False),
                'service_kpi': kpi_info.get('service_kpi', False),
                'is_meeting': kpi_info.get('is_meeting', False),
                'is_manager_review_needed': kpi_info.get('is_manager_review_needed', False),
                'is_customer_review_needed': kpi_info.get('is_customer_review_needed', False),
                'file_name': kpi_info.get('file_name'),
                'reassignment_log': kpi_info.get('reassignment_log'),
            }
            
            # Find user by name if exists
            if kpi_info.get('user_name'):
                user = self.env['res.users'].search([('name', '=', kpi_info['user_name'])], limit=1)
                if user:
                    vals['user_id'] = user.id
            
            # Restore file if exists
            if kpi_info.get('has_file') and kpi_info.get('file_name'):
                try:
                    file_path = f"kpi_files/{kpi_info['id']}_{kpi_info['file_name']}"
                    file_content = zip_file.read(file_path)
                    vals['uploaded_file'] = base64.b64encode(file_content)
                except:
                    pass
            
            new_kpi = self.env['kra.kpi'].create(vals)
            id_mapping['kpi'][kpi_info['id']] = new_kpi.id

    def _restore_progress(self, progress_data, id_mapping, zip_file):
        """Restore progress updates"""
        for progress_info in progress_data:
            if progress_info['kpi_id'] not in id_mapping['kpi']:
                continue
            
            vals = {
                'kpi_id': id_mapping['kpi'][progress_info['kpi_id']],
                'summary': progress_info['summary'],
                'file_name': progress_info.get('file_name'),
                'related_links': progress_info.get('related_links')
            }
            
            # Find user
            if progress_info.get('user_name'):
                user = self.env['res.users'].search([('name', '=', progress_info['user_name'])], limit=1)
                if user:
                    vals['user_id'] = user.id
            
            # Restore file
            if progress_info.get('has_file') and progress_info.get('file_name'):
                try:
                    file_path = f"progress_files/{progress_info['id']}_{progress_info['file_name']}"
                    file_content = zip_file.read(file_path)
                    vals['uploaded_file'] = base64.b64encode(file_content)
                except:
                    pass
            
            self.env['kpi.progress'].create(vals)

    def _restore_manuals(self, manual_data, id_mapping, zip_file):
        """Restore user manuals"""
        for manual_info in manual_data:
            if manual_info['kpi_id'] not in id_mapping['kpi']:
                continue
            
            vals = {
                'kpi_id': id_mapping['kpi'][manual_info['kpi_id']],
                'file_name': manual_info.get('file_name'),
                'description': manual_info.get('description'),
                'related_links': manual_info.get('related_links')
            }
            
            # Find user
            if manual_info.get('uploader_name'):
                user = self.env['res.users'].search([('name', '=', manual_info['uploader_name'])], limit=1)
                if user:
                    vals['uploaded_by'] = user.id
            
            # Restore file
            if manual_info.get('has_file') and manual_info.get('file_name'):
                try:
                    file_path = f"manual_files/{manual_info['id']}_{manual_info['file_name']}"
                    file_content = zip_file.read(file_path)
                    vals['manual_file'] = base64.b64encode(file_content)
                except:
                    pass
            
            self.env['kpi.user.manual'].create(vals)

    def _restore_github(self, github_data, id_mapping):
        """Restore GitHub links"""
        for github_info in github_data:
            if github_info['kpi_id'] not in id_mapping['kpi']:
                continue
            
            vals = {
                'kpi_id': id_mapping['kpi'][github_info['kpi_id']],
                'github_url': github_info['github_url'],
                'branch_name': github_info['branch_name']
            }
            
            # Find user
            if github_info.get('employee_name'):
                user = self.env['res.users'].search([('name', '=', github_info['employee_name'])], limit=1)
                if user:
                    vals['user_id'] = user.id
            
            self.env['kpi.github.link'].create(vals)

    def _restore_reassignments(self, reassignment_data, id_mapping):
        """Restore reassignment history"""
        for reassign_info in reassignment_data:
            if reassign_info['kpi_id'] not in id_mapping['kpi']:
                continue
            
            # Find users by name
            prev_user = self.env['res.users'].search([('name', '=', reassign_info['previous_assignee_name'])], limit=1)
            new_user = self.env['res.users'].search([('name', '=', reassign_info['new_assignee_name'])], limit=1)
            by_user = self.env['res.users'].search([('name', '=', reassign_info['reassigned_by_name'])], limit=1)
            
            if not (prev_user and new_user and by_user):
                continue
            
            vals = {
                'kpi_id': id_mapping['kpi'][reassign_info['kpi_id']],
                'previous_assignee_id': prev_user.id,
                'previous_assignee_name': reassign_info['previous_assignee_name'],
                'new_assignee_id': new_user.id,
                'new_assignee_name': reassign_info['new_assignee_name'],
                'reassigned_by_id': by_user.id,
                'reassigned_by_name': reassign_info['reassigned_by_name'],
                'reassignment_date': reassign_info['reassignment_date'],
                'reassignment_reason': reassign_info['reassignment_reason'],
                'previous_state': reassign_info['previous_state'],
                'time_spent_seconds': reassign_info.get('time_spent_seconds', 0),
                'was_paused': reassign_info.get('was_paused', False),
                'pause_reason': reassign_info.get('pause_reason')
            }
            
            self.env['kpi.reassignment.history'].create(vals)

    def _restore_reports(self, report_data):
        """Restore report configurations"""
        if 'salary_configs' in report_data:
            for config_info in report_data['salary_configs']:
                # Find employee
                employee = self.env['res.users'].search([('name', '=', config_info['employee_name'])], limit=1)
                if not employee:
                    continue
                
                # Check if config already exists
                existing = self.env['kpi.employee.salary.config'].search([('employee_id', '=', employee.id)])
                
                vals = {
                    'employee_id': employee.id,
                    'salary': config_info['salary'],
                    'working_days': config_info.get('working_days', 25),
                    'attendance_hours_per_day': config_info.get('attendance_hours_per_day', 8.0)
                }
                
                if existing:
                    existing.write(vals)
                else:
                    self.env['kpi.employee.salary.config'].create(vals)

    def action_download_backup(self):
        """Download backup file"""
        self.ensure_one()
        
        if not self.backup_file:
            raise UserError("No backup file available to download!")
        
        return {
            'type': 'ir.actions.act_url',
            'url': f'/web/content/{self._name}/{self.id}/backup_file/{self.backup_filename}',
            'target': 'self',
        }

    @api.model
    def create_auto_backup(self):
        """Scheduled automatic backup"""
        backup = self.create({
            'name': f'Auto Backup - {datetime.now().strftime("%Y-%m-%d")}',
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