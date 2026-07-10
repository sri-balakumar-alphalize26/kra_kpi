from odoo import http
from odoo.http import request
import logging

_logger = logging.getLogger(__name__)


class KpiCleanupAPI(http.Controller):
    
    @http.route('/kpi_cleanup/preview', type='json', auth='user', methods=['POST'], csrf=False)
    def get_cleanup_preview(self, **params):
        """Get preview of records that will be deleted"""
        try:
            cleanup_id = params.get('cleanup_id')
            
            if not cleanup_id:
                return {'status': False, 'message': 'cleanup_id is required'}
            
            cleanup = request.env['kpi.data.cleanup'].browse(int(cleanup_id))
            
            if not cleanup.exists():
                return {'status': False, 'message': 'Cleanup record not found'}
            
            preview = cleanup.get_cleanup_preview()
            
            # Check backup status
            backup_warning = None
            if not cleanup.has_recent_backup and not cleanup.force_cleanup_without_backup:
                if cleanup.days_since_backup == 999:
                    backup_warning = "No backup exists! Creating a backup is mandatory."
                else:
                    backup_warning = f"Last backup was {cleanup.days_since_backup} days ago. Backup recommended!"
            
            return {
                'status': True,
                'preview': preview,
                'backup_warning': backup_warning,
                'has_recent_backup': cleanup.has_recent_backup,
                'days_since_backup': cleanup.days_since_backup,
                'last_backup_date': str(cleanup.last_backup_date) if cleanup.last_backup_date else None,
            }
        except Exception as e:
            _logger.error(f"Error getting cleanup preview: {str(e)}")
            return {
                'status': False,
                'message': str(e),
                'preview': {}
            }
    
    @http.route('/kpi_cleanup/backup_status', type='json', auth='user', methods=['POST'], csrf=False)
    def get_backup_status(self, **params):
        """Get current backup status"""
        try:
            last_backup = request.env['kpi.backup'].search([
                ('state', '=', 'completed')
            ], order='backup_date desc', limit=1)
            
            if last_backup:
                from datetime import datetime
                days_diff = (datetime.now() - last_backup.backup_date).days
                
                return {
                    'status': True,
                    'has_backup': True,
                    'last_backup_date': str(last_backup.backup_date),
                    'days_since_backup': days_diff,
                    'has_recent_backup': days_diff <= 7,
                    'backup_name': last_backup.name,
                }
            else:
                return {
                    'status': True,
                    'has_backup': False,
                    'last_backup_date': None,
                    'days_since_backup': 999,
                    'has_recent_backup': False,
                }
        except Exception as e:
            _logger.error(f"Error getting backup status: {str(e)}")
            return {
                'status': False,
                'message': str(e)
            }
    
    @http.route('/kpi_cleanup/execute', type='json', auth='user', methods=['POST'], csrf=False)
    def execute_cleanup(self, **params):
        """Execute cleanup with confirmation"""
        try:
            cleanup_id = params.get('cleanup_id')
            confirmed = params.get('confirmed', False)
            
            if not cleanup_id:
                return {'status': False, 'message': 'cleanup_id is required'}
            
            if not confirmed:
                return {'status': False, 'message': 'Cleanup must be confirmed'}
            
            cleanup = request.env['kpi.data.cleanup'].sudo().browse(int(cleanup_id))
            
            if not cleanup.exists():
                return {'status': False, 'message': 'Cleanup record not found'}
            
            # Execute cleanup
            result = cleanup.action_execute_cleanup()
            
            return {
                'status': True,
                'message': 'Cleanup completed successfully',
                'summary': cleanup._get_cleanup_summary(),
                'deleted_counts': {
                    'kras': cleanup.kras_deleted,
                    'kpis': cleanup.kpis_deleted,
                    'progress': cleanup.progress_deleted,
                    'manuals': cleanup.manuals_deleted,
                    'github': cleanup.github_deleted,
                    'reassignments': cleanup.reassignments_deleted,
                    'reports': cleanup.reports_deleted,
                }
            }
        except Exception as e:
            _logger.error(f"Error executing cleanup: {str(e)}")
            return {
                'status': False,
                'message': str(e)
            }
    
    @http.route('/kpi_cleanup/statistics', type='json', auth='user', methods=['POST'], csrf=False)
    def get_cleanup_statistics(self, **params):
        """Get overall statistics of data that can be cleaned"""
        try:
            stats = {
                'total_kras': request.env['kra.master'].search_count([]),
                'total_kpis': request.env['kra.kpi'].search_count([]),
                'total_progress': request.env['kpi.progress'].search_count([]),
                'total_manuals': request.env['kpi.user.manual'].search_count([]),
                'total_github': request.env['kpi.github.link'].search_count([]),
                'total_reassignments': request.env['kpi.reassignment.history'].search_count([]),
                'total_reports': request.env['kpi.employee.salary.config'].search_count([]),
            }
            
            # Breakdown by state
            stats['kpi_by_state'] = {}
            for state in ['assigned', 'in_progress', 'paused', 'partially_completed', 'completed', 'cancelled']:
                count = request.env['kra.kpi'].search_count([('task_state', '=', state)])
                stats['kpi_by_state'][state] = count
            
            return {
                'status': True,
                'statistics': stats
            }
        except Exception as e:
            _logger.error(f"Error getting cleanup statistics: {str(e)}")
            return {
                'status': False,
                'message': str(e),
                'statistics': {}
            }