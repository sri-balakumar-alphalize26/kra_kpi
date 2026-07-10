from odoo import models, fields, api
from datetime import datetime, timedelta
from dateutil.relativedelta import relativedelta
import logging

_logger = logging.getLogger(__name__)


class KpiEmployeeReport(models.TransientModel):
    """
    KRA Employee Report - Comprehensive employee task tracking report
    Shows detailed daily breakdown of tasks, progress, and performance
    """
    _name = 'kpi.employee.report'
    _description = 'KRA Employee Report'

    # Filter Fields
    from_date = fields.Date(string='From Date', required=True, default=fields.Date.today)
    to_date = fields.Date(string='To Date', required=True, default=fields.Date.today)
    employee_ids = fields.Many2many(
        'res.users',
        'kpi_employee_report_user_rel',
        'report_id',
        'user_id',
        string='Employees'
    )
    time_frame = fields.Selection([
        ('today', 'Today'),
        ('yesterday', 'Yesterday'),
        ('last_week', 'Last Week'),
        ('last_month', 'Last Month'),
        ('last_year', 'Last Year'),
    ], string='Time Frame')

    @api.onchange('time_frame')
    def _onchange_time_frame(self):
        """Auto-populate dates based on selected time frame"""
        if not self.time_frame:
            return

        today = fields.Date.today()

        if self.time_frame == 'today':
            self.from_date = today
            self.to_date = today

        elif self.time_frame == 'yesterday':
            yesterday = today - timedelta(days=1)
            self.from_date = yesterday
            self.to_date = yesterday

        elif self.time_frame == 'last_week':
            # Last week: Monday to Sunday of previous week
            days_since_monday = today.weekday()
            last_monday = today - timedelta(days=days_since_monday + 7)
            last_sunday = last_monday + timedelta(days=6)
            self.from_date = last_monday
            self.to_date = last_sunday

        elif self.time_frame == 'last_month':
            first_day_last_month = (today.replace(day=1) - timedelta(days=1)).replace(day=1)
            last_day_last_month = today.replace(day=1) - timedelta(days=1)
            self.from_date = first_day_last_month
            self.to_date = last_day_last_month

        elif self.time_frame == 'last_year':
            self.from_date = today.replace(year=today.year - 1, month=1, day=1)
            self.to_date = today.replace(year=today.year - 1, month=12, day=31)

    def _format_hours_to_display(self, total_hours):
        """
        Convert decimal hours to readable format (Xh Ym)
        """
        if not total_hours or total_hours <= 0:
            return '0h 0m'

        hours = int(total_hours)
        minutes = int((total_hours - hours) * 60)
        return f"{hours}h {minutes}m"

    def _format_seconds_to_display(self, total_seconds):
        """
        Convert seconds to readable format (Xh Ym)
        """
        if not total_seconds or total_seconds <= 0:
            return '0h 0m'

        total_hours = total_seconds / 3600.0
        hours = int(total_hours)
        minutes = int((total_hours - hours) * 60)
        return f"{hours}h {minutes}m"

    def _calculate_performance(self, estimated_hours, actual_hours):
        """
        Calculate performance based on estimated vs actual hours
        Performance = Estimated Hours - Actual Hours
        Positive = Task completed faster (Good)
        Negative = Task took longer (Needs Improvement)
        """
        if not estimated_hours:
            return {
                'value': 0,
                'display': 'N/A',
                'status': 'neutral',
                'percentage': 0,
            }

        difference = estimated_hours - actual_hours
        percentage = ((estimated_hours - actual_hours) / estimated_hours * 100) if estimated_hours > 0 else 0

        if difference >= 0:
            status = 'good'  # Completed within or faster than estimate
        else:
            status = 'needs_improvement'  # Took longer than estimate

        return {
            'value': round(difference, 2),
            'display': self._format_hours_to_display(abs(difference)),
            'status': status,
            'percentage': round(percentage, 2),
            'is_positive': difference >= 0,
        }

    def _get_daily_progress_data(self, kpi_id, from_date, to_date):
        """
        Get date-wise breakdown of progress for a specific KPI task
        Returns progress summary and time spent for each date in the range
        Now uses kpi.time.log for accurate daily hours tracking
        """
        daily_data = []

        # Convert dates to datetime for comparison
        from_datetime = fields.Datetime.to_datetime(from_date)
        to_datetime = fields.Datetime.to_datetime(to_date).replace(hour=23, minute=59, second=59)

        # Get daily hours from time log
        time_log_data = self.env['kpi.time.log'].get_daily_hours(kpi_id, from_date, to_date)
        time_by_date = {d['date']: d for d in time_log_data}

        # Get all progress entries for this KPI within date range
        progress_records = self.env['kpi.progress'].search([
            ('kpi_id', '=', kpi_id),
            ('create_date', '>=', from_datetime),
            ('create_date', '<=', to_datetime),
        ], order='create_date asc')

        # Group progress by date
        progress_by_date = {}
        for progress in progress_records:
            progress_date = progress.create_date.date()
            date_str = progress_date.strftime('%Y-%m-%d')

            if date_str not in progress_by_date:
                # Get time data from time log if available
                time_data = time_by_date.get(date_str, {})
                
                progress_by_date[date_str] = {
                    'date': date_str,
                    'date_display': progress_date.strftime('%d %b %Y'),
                    'day_name': progress_date.strftime('%A'),
                    'summaries': [],
                    'total_entries': 0,
                    'total_time_seconds': time_data.get('total_seconds', 0),
                    'total_time_display': time_data.get('total_display', '0h 0m'),
                }

            progress_by_date[date_str]['summaries'].append({
                'id': progress.id,
                'time': progress.create_date.strftime('%H:%M:%S'),
                'summary': progress.summary or '',
                'has_attachment': bool(progress.uploaded_file),
                'file_name': progress.file_name or '',
            })
            progress_by_date[date_str]['total_entries'] += 1

        # Also add dates that have time logged but no progress entries
        for date_str, time_data in time_by_date.items():
            if date_str not in progress_by_date:
                work_date = time_data['work_date']
                progress_by_date[date_str] = {
                    'date': date_str,
                    'date_display': work_date.strftime('%d %b %Y'),
                    'day_name': work_date.strftime('%A'),
                    'summaries': [],
                    'total_entries': 0,
                    'total_time_seconds': time_data.get('total_seconds', 0),
                    'total_time_display': time_data.get('total_display', '0h 0m'),
                }

        # Convert to list sorted by date
        for date_str in sorted(progress_by_date.keys()):
            daily_data.append(progress_by_date[date_str])

        return daily_data

    def _get_started_date(self, kpi):
        """
        Get the actual started date for a task
        Priority:
        1. First time log entry (when Start was clicked)
        2. First progress entry date
        3. None if neither exists
        """
        # Try to get from time log first (most accurate)
        first_time_log = self.env['kpi.time.log'].search([
            ('kpi_id', '=', kpi.id)
        ], order='start_time asc', limit=1)
        
        if first_time_log:
            return first_time_log.start_time.date()
        
        # Fallback to first progress entry
        first_progress = self.env['kpi.progress'].search([
            ('kpi_id', '=', kpi.id)
        ], order='create_date asc', limit=1)
        
        if first_progress:
            return first_progress.create_date.date()
        
        return None

    def get_report_data(self):
        """
        Generate the main report data
        Returns employee-wise task details with daily breakdown
        """
        self.ensure_one()

        # Build domain for KPI tasks
        domain = [('user_id', '!=', False)]

        # Filter by employees if specified
        if self.employee_ids:
            domain.append(('user_id', 'in', self.employee_ids.ids))

        # Date filtering - tasks that were worked on during the date range
        # We consider:
        # 1. Tasks created in the date range
        # 2. Tasks with progress updates in the date range
        # 3. Tasks with deadline in the date range

        from_datetime = fields.Datetime.to_datetime(self.from_date)
        to_datetime = fields.Datetime.to_datetime(self.to_date).replace(hour=23, minute=59, second=59)

        # Get all KPIs that have activity in the date range
        kpi_tasks = self.env['kra.kpi'].search(domain, order='user_id, kra_id, id')

        # Filter tasks that have relevant activity in date range
        relevant_kpi_ids = set()

        for kpi in kpi_tasks:
            # Check if task was created in date range
            if kpi.create_date and from_datetime <= kpi.create_date <= to_datetime:
                relevant_kpi_ids.add(kpi.id)
                continue

            # Check if task has progress in date range
            progress_count = self.env['kpi.progress'].search_count([
                ('kpi_id', '=', kpi.id),
                ('create_date', '>=', from_datetime),
                ('create_date', '<=', to_datetime),
            ])
            if progress_count > 0:
                relevant_kpi_ids.add(kpi.id)
                continue

            # Check if task has time logs in date range
            time_log_count = self.env['kpi.time.log'].search_count([
                ('kpi_id', '=', kpi.id),
                ('work_date', '>=', self.from_date),
                ('work_date', '<=', self.to_date),
            ])
            if time_log_count > 0:
                relevant_kpi_ids.add(kpi.id)
                continue

            # Check if task is currently running (timer active) - means being worked on today
            if kpi.timer_start_datetime:
                # Task is currently in progress with active timer
                relevant_kpi_ids.add(kpi.id)
                continue

            # Check if task has any work done (timer_total_seconds > 0) and is in progress/paused state
            # This catches tasks that were worked on but may not have time logs yet
            if kpi.timer_total_seconds and kpi.timer_total_seconds > 0:
                if kpi.task_state in ['in_progress', 'paused']:
                    relevant_kpi_ids.add(kpi.id)
                    continue

            # Check if deadline is in date range
            if kpi.deadline and self.from_date <= kpi.deadline <= self.to_date:
                relevant_kpi_ids.add(kpi.id)

        # Get the relevant KPIs
        kpi_tasks = self.env['kra.kpi'].browse(list(relevant_kpi_ids)).sorted(
            key=lambda k: (k.user_id.name or '', k.kra_id.name or '', k.id)
        )

        # Group by employee
        employee_data = {}

        for kpi in kpi_tasks:
            emp = kpi.user_id
            emp_id = emp.id

            if emp_id not in employee_data:
                employee_data[emp_id] = {
                    'employee_id': emp_id,
                    'employee_name': emp.name,
                    'employee_email': emp.email or '',
                    'tasks': [],
                    'total_tasks': 0,
                    'total_estimated_hours': 0,
                    'total_actual_hours': 0,
                    'completed_tasks': 0,
                    'in_progress_tasks': 0,
                    'pending_tasks': 0,
                }

            # Calculate estimated hours
            estimated_hours = (kpi.estimate_hours or 0) + ((kpi.estimate_minutes or 0) / 60.0)

            # Calculate actual hours from timer
            actual_hours = (kpi.timer_total_seconds or 0) / 3600.0

            # Get task start date (from time log or first progress)
            task_started_date = self._get_started_date(kpi)

            # Calculate performance
            performance = self._calculate_performance(estimated_hours, actual_hours)

            # Get daily progress breakdown
            daily_progress = self._get_daily_progress_data(kpi.id, self.from_date, self.to_date)

            # Build task data
            task_data = {
                'id': kpi.id,
                'name': kpi.name,
                'kra_id': kpi.kra_id.id if kpi.kra_id else False,
                'kra_name': kpi.kra_id.name if kpi.kra_id else '',
                'parent_kra_name': kpi.kra_id.parent_id.name if kpi.kra_id and kpi.kra_id.parent_id else '',
                'assigned_date': kpi.create_date.strftime('%Y-%m-%d %H:%M') if kpi.create_date else '',
                'assigned_date_display': kpi.create_date.strftime('%d %b %Y') if kpi.create_date else '',
                'started_date': task_started_date.strftime('%Y-%m-%d') if task_started_date else '',
                'started_date_display': task_started_date.strftime('%d %b %Y') if task_started_date else 'Not Started',
                'deadline': str(kpi.deadline) if kpi.deadline else '',
                'deadline_display': kpi.deadline.strftime('%d %b %Y') if kpi.deadline else 'No Deadline',
                'priority': kpi.priority or 'regular',
                'task_state': kpi.task_state or 'assigned',
                'task_state_display': dict(kpi._fields['task_state'].selection).get(kpi.task_state, kpi.task_state),

                # Time fields
                'estimated_hours': round(estimated_hours, 2),
                'estimated_hours_display': self._format_hours_to_display(estimated_hours),
                'actual_hours': round(actual_hours, 2),
                'actual_hours_display': self._format_hours_to_display(actual_hours),
                'actual_seconds': kpi.timer_total_seconds or 0,

                # Performance
                'performance': performance,

                # Daily breakdown
                'daily_progress': daily_progress,
                'total_progress_entries': sum(d['total_entries'] for d in daily_progress),

                # Completion info
                'completed_by': kpi.completed_by.name if kpi.completed_by else '',
                'completion_date': kpi.completion_date.strftime('%d %b %Y %H:%M') if kpi.completion_date else '',
                'approved_by': kpi.approved_by.name if kpi.approved_by else '',
                'approval_date': kpi.approval_date.strftime('%d %b %Y %H:%M') if kpi.approval_date else '',

                # Additional info
                'description': kpi.description or '',
                'paused_reason': kpi.paused_reason or '',
            }

            employee_data[emp_id]['tasks'].append(task_data)
            employee_data[emp_id]['total_tasks'] += 1
            employee_data[emp_id]['total_estimated_hours'] += estimated_hours
            employee_data[emp_id]['total_actual_hours'] += actual_hours

            # Count by status
            if kpi.task_state == 'completed':
                employee_data[emp_id]['completed_tasks'] += 1
            elif kpi.task_state == 'in_progress':
                employee_data[emp_id]['in_progress_tasks'] += 1
            else:
                employee_data[emp_id]['pending_tasks'] += 1

        # Format the result
        result = []
        for emp_id, data in employee_data.items():
            # Calculate overall performance for employee
            overall_performance = self._calculate_performance(
                data['total_estimated_hours'],
                data['total_actual_hours']
            )

            result.append({
                'employee_id': data['employee_id'],
                'employee_name': data['employee_name'],
                'employee_email': data['employee_email'],
                'tasks': data['tasks'],
                'total_tasks': data['total_tasks'],
                'completed_tasks': data['completed_tasks'],
                'in_progress_tasks': data['in_progress_tasks'],
                'pending_tasks': data['pending_tasks'],
                'total_estimated_hours': round(data['total_estimated_hours'], 2),
                'total_estimated_hours_display': self._format_hours_to_display(data['total_estimated_hours']),
                'total_actual_hours': round(data['total_actual_hours'], 2),
                'total_actual_hours_display': self._format_hours_to_display(data['total_actual_hours']),
                'overall_performance': overall_performance,
            })

        return result

    def get_all_employees(self):
        """Get all employees who have KPI tasks assigned"""
        employees = self.env['kra.kpi'].search([
            ('user_id', '!=', False)
        ]).mapped('user_id')

        return [{
            'id': emp.id,
            'name': emp.name,
        } for emp in employees.sorted(key=lambda e: e.name)]

    def get_pdf_report_data(self):
        """
        Get formatted data for PDF generation
        Includes all necessary fields formatted for PDF output
        """
        report_data = self.get_report_data()

        # Add report metadata
        return {
            'report_title': 'KRA Employee Report',
            'generated_on': fields.Datetime.now().strftime('%d %b %Y %H:%M:%S'),
            'from_date': self.from_date.strftime('%d %b %Y') if self.from_date else '',
            'to_date': self.to_date.strftime('%d %b %Y') if self.to_date else '',
            'filters': {
                'employees': ', '.join(self.employee_ids.mapped('name')) if self.employee_ids else 'All Employees',
                'time_frame': dict(self._fields['time_frame'].selection).get(self.time_frame, 'Custom') if self.time_frame else 'Custom',
            },
            'employees': report_data,
            'total_employees': len(report_data),
            'grand_total_tasks': sum(e['total_tasks'] for e in report_data),
            'grand_total_estimated': sum(e['total_estimated_hours'] for e in report_data),
            'grand_total_actual': sum(e['total_actual_hours'] for e in report_data),
        }
