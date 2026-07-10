from odoo import api, models, fields
from odoo.exceptions import ValidationError
from datetime import datetime


class KpiTimeLog(models.Model):
    """
    KPI Time Log - Tracks individual work sessions for each task
    Each time an employee starts and pauses a task, a log entry is created
    This allows tracking of how many hours were worked on each specific date
    """
    _name = "kpi.time.log"
    _description = "KPI Time Log - Daily Work Sessions"
    _order = "start_time desc"

    kpi_id = fields.Many2one(
        'kra.kpi',
        string='Task',
        required=True,
        ondelete='cascade',
        index=True
    )
    
    user_id = fields.Many2one(
        'res.users',
        string='Employee',
        required=True,
        default=lambda self: self.env.user,
        index=True
    )
    
    start_time = fields.Datetime(
        string='Start Time',
        required=True,
        default=fields.Datetime.now
    )
    
    end_time = fields.Datetime(
        string='End Time'
    )
    
    duration_seconds = fields.Float(
        string='Duration (seconds)',
        compute='_compute_duration',
        store=True
    )
    
    duration_display = fields.Char(
        string='Duration',
        compute='_compute_duration_display'
    )
    
    # Store date separately for easy grouping/filtering
    work_date = fields.Date(
        string='Work Date',
        compute='_compute_work_date',
        store=True,
        index=True
    )
    
    # Session state
    is_active = fields.Boolean(
        string='Is Active Session',
        default=True,
        help='True if this session is currently running (not yet paused/stopped)'
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

    @api.depends('start_time')
    def _compute_work_date(self):
        """Extract date from start_time for grouping"""
        for rec in self:
            if rec.start_time:
                rec.work_date = rec.start_time.date()
            else:
                rec.work_date = False

    @api.depends('start_time', 'end_time')
    def _compute_duration(self):
        """Calculate duration in seconds"""
        for rec in self:
            if rec.start_time and rec.end_time:
                delta = rec.end_time - rec.start_time
                rec.duration_seconds = delta.total_seconds()
            else:
                rec.duration_seconds = 0

    def _compute_duration_display(self):
        """Format duration as Xh Ym"""
        for rec in self:
            if rec.duration_seconds:
                hours = int(rec.duration_seconds // 3600)
                minutes = int((rec.duration_seconds % 3600) // 60)
                rec.duration_display = f"{hours}h {minutes}m"
            else:
                rec.duration_display = "0h 0m"

    @api.model
    def start_session(self, kpi_id, user_id=None):
        """
        Start a new work session for a task
        Called when employee clicks 'Start Task'
        """
        if not user_id:
            user_id = self.env.user.id

        # Authorization gate: only the KPI's effective contributors (or admins) may start a session.
        kpi = self.env['kra.kpi'].browse(kpi_id)
        if not kpi.exists():
            raise ValidationError("Task not found.")
        is_admin = (
            self.env.user.has_group('kra_kpi_module.group_kra_admin')
            or self.env.user.has_group('base.group_system')
        )
        if not is_admin and user_id not in kpi.effective_contributor_ids.ids:
            raise ValidationError(
                "You are not a contributor on this task. Ask an admin to add you to Contributors."
            )

        # Check if there's already an active session for this task/user
        active_session = self.search([
            ('kpi_id', '=', kpi_id),
            ('user_id', '=', user_id),
            ('is_active', '=', True)
        ], limit=1)
        
        if active_session:
            # Session already running, return it
            return active_session.id
        
        # Create new session
        session = self.create({
            'kpi_id': kpi_id,
            'user_id': user_id,
            'start_time': fields.Datetime.now(),
            'is_active': True,
        })
        
        return session.id

    @api.model
    def stop_session(self, kpi_id, user_id=None):
        """
        Stop the active work session for a task
        Called when employee clicks 'Pause Task' or 'Complete Task'
        """
        if not user_id:
            user_id = self.env.user.id
        
        # Find active session
        active_session = self.search([
            ('kpi_id', '=', kpi_id),
            ('user_id', '=', user_id),
            ('is_active', '=', True)
        ], limit=1)
        
        if active_session:
            active_session.write({
                'end_time': fields.Datetime.now(),
                'is_active': False,
            })
            return {
                'session_id': active_session.id,
                'duration_seconds': active_session.duration_seconds,
            }
        
        return {'session_id': False, 'duration_seconds': 0}

    @api.model
    def get_daily_hours(self, kpi_id, from_date=None, to_date=None):
        """
        Get total hours worked per day for a specific task
        Returns list of {date, total_seconds, display} grouped by date
        """
        domain = [
            ('kpi_id', '=', kpi_id),
            ('is_active', '=', False),  # Only completed sessions
        ]
        
        if from_date:
            domain.append(('work_date', '>=', from_date))
        if to_date:
            domain.append(('work_date', '<=', to_date))
        
        sessions = self.search(domain, order='work_date asc')
        
        # Group by date
        daily_data = {}
        for session in sessions:
            date_str = str(session.work_date)
            if date_str not in daily_data:
                daily_data[date_str] = {
                    'date': date_str,
                    'work_date': session.work_date,
                    'total_seconds': 0,
                    'sessions': [],
                }
            daily_data[date_str]['total_seconds'] += session.duration_seconds
            daily_data[date_str]['sessions'].append({
                'id': session.id,
                'start_time': session.start_time.strftime('%H:%M:%S'),
                'end_time': session.end_time.strftime('%H:%M:%S') if session.end_time else '',
                'duration_seconds': session.duration_seconds,
            })
        
        # Format display
        result = []
        for date_str in sorted(daily_data.keys()):
            data = daily_data[date_str]
            hours = int(data['total_seconds'] // 3600)
            minutes = int((data['total_seconds'] % 3600) // 60)
            data['total_display'] = f"{hours}h {minutes}m"
            data['date_display'] = data['work_date'].strftime('%d %b %Y')
            data['day_name'] = data['work_date'].strftime('%A')
            result.append(data)
        
        return result

    @api.model
    def get_employee_daily_hours(self, user_id, from_date=None, to_date=None):
        """
        Get total hours worked per day for a specific employee across all tasks
        """
        domain = [
            ('user_id', '=', user_id),
            ('is_active', '=', False),
        ]
        
        if from_date:
            domain.append(('work_date', '>=', from_date))
        if to_date:
            domain.append(('work_date', '<=', to_date))
        
        sessions = self.search(domain, order='work_date asc, kpi_id')
        
        # Group by date and task
        daily_data = {}
        for session in sessions:
            date_str = str(session.work_date)
            if date_str not in daily_data:
                daily_data[date_str] = {
                    'date': date_str,
                    'work_date': session.work_date,
                    'total_seconds': 0,
                    'tasks': {},
                }
            
            daily_data[date_str]['total_seconds'] += session.duration_seconds
            
            # Group by task within date
            task_id = session.kpi_id.id
            if task_id not in daily_data[date_str]['tasks']:
                daily_data[date_str]['tasks'][task_id] = {
                    'task_id': task_id,
                    'task_name': session.kpi_name,
                    'total_seconds': 0,
                }
            daily_data[date_str]['tasks'][task_id]['total_seconds'] += session.duration_seconds
        
        # Format result
        result = []
        for date_str in sorted(daily_data.keys()):
            data = daily_data[date_str]
            hours = int(data['total_seconds'] // 3600)
            minutes = int((data['total_seconds'] % 3600) // 60)
            
            task_list = []
            for task_data in data['tasks'].values():
                t_hours = int(task_data['total_seconds'] // 3600)
                t_minutes = int((task_data['total_seconds'] % 3600) // 60)
                task_data['display'] = f"{t_hours}h {t_minutes}m"
                task_list.append(task_data)
            
            result.append({
                'date': date_str,
                'date_display': data['work_date'].strftime('%d %b %Y'),
                'day_name': data['work_date'].strftime('%A'),
                'total_seconds': data['total_seconds'],
                'total_display': f"{hours}h {minutes}m",
                'tasks': task_list,
            })
        
        return result
