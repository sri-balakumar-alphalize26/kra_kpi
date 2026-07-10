from odoo import models, fields, api
from datetime import datetime, timedelta
from dateutil.relativedelta import relativedelta


# ============================================================
#                     KPI UNIT REPORT
# ============================================================
class KpiUnitReport(models.TransientModel):
    _name = 'kpi.unit.report'
    _description = 'KPI Unit Report'

    from_date = fields.Date(string='From Date', required=True, default=fields.Date.today)
    to_date = fields.Date(string='To Date', required=True, default=fields.Date.today)
    employee_id = fields.Many2one('res.users', string='Employee Name')
    time_frame = fields.Selection([
        ('last_month', 'Last Month'),
        ('yesterday', 'Yesterday'),
        ('last_year', 'Last Year')
    ], string='Time Frame')

    @api.onchange('time_frame')
    def _onchange_time_frame(self):
        """Auto-populate dates based on selected time frame"""
        if not self.time_frame:
            return
        
        today = fields.Date.today()

        if self.time_frame == 'yesterday':
            self.from_date = today - timedelta(days=1)
            self.to_date = today - timedelta(days=1)

        elif self.time_frame == 'last_month':
            first_day_last_month = (today.replace(day=1) - timedelta(days=1)).replace(day=1)
            last_day_last_month = today.replace(day=1) - timedelta(days=1)
            self.from_date = first_day_last_month
            self.to_date = last_day_last_month

        elif self.time_frame == 'last_year':
            self.from_date = today.replace(year=today.year - 1, month=1, day=1)
            self.to_date = today.replace(year=today.year - 1, month=12, day=31)

    def action_generate_report(self):
        """Open generated KPI Unit Report"""
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': 'KPI Unit Report Results',
            'res_model': 'kpi.unit.report',
            'view_mode': 'form',
            'res_id': self.id,
            'views': [(self.env.ref('kra_kpi_module.view_kpi_unit_report_result').id, 'form')],
            'target': 'current',
        }

    def _format_time_to_dhm(self, total_hours):
        """
        Convert decimal hours to Days, Hours, Minutes format
        Example: 26.5 hours = 3 days, 2 hours, 30 minutes (assuming 8-hour workday)
        """
        if not total_hours or total_hours <= 0:
            return {'days': 0, 'hours': 0, 'minutes': 0, 'display': '0d 0h 0m'}
        
        # Calculate days (8 hours per day)
        days = int(total_hours // 8)
        remaining_hours = total_hours % 8
        
        # Calculate hours and minutes
        hours = int(remaining_hours)
        minutes = int((remaining_hours - hours) * 60)
        
        display = f"{days}d {hours}h {minutes}m"
        
        return {
            'days': days,
            'hours': hours,
            'minutes': minutes,
            'display': display,
            'total_hours': total_hours
        }

    def get_report_data(self):
        """Aggregate unit data for employees - FIXED DOMAIN LOGIC"""
        self.ensure_one()

        # BUILD DOMAIN - CRITICAL FIX
        domain = [('user_id', '!=', False)]  # Only tasks with assignees
        
        # Add employee filter if specified
        if self.employee_id:
            domain.append(('user_id', '=', self.employee_id.id))
        
        # CHANGED: Use create_date OR deadline for date filtering
        # This ensures we catch tasks even if deadline is not set
        if self.from_date and self.to_date:
            domain.append('|')
            domain.append('&')
            domain.append(('deadline', '>=', self.from_date))
            domain.append(('deadline', '<=', self.to_date))
            domain.append('&')
            domain.append(('create_date', '>=', fields.Datetime.to_datetime(self.from_date)))
            domain.append(('create_date', '<=', fields.Datetime.to_datetime(self.to_date)))
        elif self.from_date:
            domain.append('|')
            domain.append(('deadline', '>=', self.from_date))
            domain.append(('create_date', '>=', fields.Datetime.to_datetime(self.from_date)))
        elif self.to_date:
            domain.append('|')
            domain.append(('deadline', '<=', self.to_date))
            domain.append(('create_date', '<=', fields.Datetime.to_datetime(self.to_date)))

        # Search for tasks
        kpi_tasks = self.env['kra.kpi'].search(domain, order='user_id, id')
        
        # DEBUG: Log the query
        import logging
        _logger = logging.getLogger(__name__)
        _logger.info(f"KPI Unit Report Domain: {domain}")
        _logger.info(f"Found {len(kpi_tasks)} tasks")

        employee_data = {}
        for kpi in kpi_tasks:
            emp = kpi.user_id
            emp_id = emp.id

            if emp_id not in employee_data:
                employee_data[emp_id] = {
                    'employee_id': emp_id,
                    'employee_name': emp.name,
                    'tasks': [],
                    'no_of_tasks': 0,
                    'estimate_total_hours': 0,
                    'estimate_unit': 0,
                    'unit_total': 0,
                    'duration_hours': 0,
                }

            # Calculate duration in hours from seconds
            duration_hours = (kpi.timer_total_seconds or 0) / 3600.0
            
            # Get estimate in hours (from estimate_hours and estimate_minutes)
            estimate_hours = (kpi.estimate_hours or 0) + ((kpi.estimate_minutes or 0) / 60.0)

            employee_data[emp_id]['tasks'].append({
                'id': kpi.id,
                'seq_no': kpi.id,
                'name': kpi.name,
                'estimated_hrs': estimate_hours,
                'hrs_spent': duration_hours,
                'estimated_unit': estimate_hours,
                'unit_spent': kpi.points or 0,
                'kra_name': kpi.kra_id.name if kpi.kra_id else '',
                'priority': kpi.priority or '',
                'task_state': kpi.task_state or '',
            })

            # INCREMENT task count - THIS IS THE KEY FIX
            employee_data[emp_id]['no_of_tasks'] += 1
            
            # Add to totals
            employee_data[emp_id]['estimate_total_hours'] += estimate_hours
            employee_data[emp_id]['estimate_unit'] += estimate_hours
            employee_data[emp_id]['unit_total'] += (kpi.points or 0)
            employee_data[emp_id]['duration_hours'] += duration_hours

        # Format the time fields to Day/Hour/Minute format
        result = []
        for emp_id, data in employee_data.items():
            # Format estimate total
            estimate_formatted = self._format_time_to_dhm(data['estimate_total_hours'])
            duration_formatted = self._format_time_to_dhm(data['duration_hours'])
            
            result.append({
                'employee_id': data['employee_id'],
                'employee_name': data['employee_name'],
                'tasks': data['tasks'],
                'no_of_tasks': data['no_of_tasks'],
                
                # Formatted time displays
                'estimate_total_display': estimate_formatted['display'],
                'duration_display': duration_formatted['display'],
                
                # Raw values for calculations/sorting
                'estimate_total_hours': data['estimate_total_hours'],
                'duration_hours': data['duration_hours'],
                
                # Other fields
                'estimate_unit': data['estimate_unit'],
                'unit_total': data['unit_total'],
            })

        return result


# ============================================================
#        Employee Salary Storage Model (Persistent)
# ============================================================
# kpi_reports.py - UPDATE the KpiEmployeeSalaryConfig model

# Update KpiEmployeeSalaryConfig model
class KpiEmployeeSalaryConfig(models.Model):
    _name = 'kpi.employee.salary.config'
    _description = 'Employee Salary Configuration (Persistent)'

    employee_id = fields.Many2one('res.users', string='Employee', required=True, index=True)
    salary = fields.Float(string='Monthly Salary', required=True, default=0.0)
    
    # NEW: Working Days field (manual entry)
    working_days = fields.Integer(
        string='Working Days', 
        default=25,
        help="Number of working days in the reporting period (e.g., 25 days for a month)"
    )
    # NEW: Attendance Hours Per Day field (manual entry)
    attendance_hours_per_day = fields.Float(
        string='Attendance Hours/Day',
        default=8.0,
        help="Number of working hours per day (e.g., 8 hours)"
    )
    # COMPUTED FIELDS - Auto-calculated from working_days
    available_hours = fields.Float(
        string='Available Hours',
        compute='_compute_available_hours',
        store=True,
        help="Working Days × 8 hours"
    )
    
    available_units = fields.Float(
        string='Available Units',
        compute='_compute_available_units',
        store=True,
        help="Available Hours × 100 (1 unit = 0.01 hours)"
    )
    
    unit_cost = fields.Float(
        string='Unit Cost',
        compute='_compute_unit_cost',
        store=True,
        help="Salary / Available Units"
    )
    
    last_updated = fields.Datetime(string='Last Updated', default=fields.Datetime.now)
    
    _sql_constraints = [
        ('employee_unique', 'unique(employee_id)', 'Employee salary configuration already exists!')
    ]
    
    # COMPUTATION METHODS
    @api.depends('working_days', 'attendance_hours_per_day')
    def _compute_available_hours(self):
        for record in self:
            record.available_hours = record.working_days * record.attendance_hours_per_day
    
    @api.depends('available_hours')
    def _compute_available_units(self):
        for record in self:
            record.available_units = record.available_hours * 100
    
    @api.depends('salary', 'available_units')
    def _compute_unit_cost(self):
        for record in self:
            record.unit_cost = record.salary / record.available_units if record.available_units > 0 else 0


# ============================================================
#               KPI PERFORMANCE REPORT - FIXED
# ============================================================
class KpiPerformanceReport(models.TransientModel):
    _name = 'kpi.performance.report'
    _description = 'KPI Performance Report'

    from_date = fields.Date(string='From Date', required=True, default=fields.Date.today)
    to_date = fields.Date(string='To Date', required=True, default=fields.Date.today)
    employee_id = fields.Many2one('res.users', string='Employee Name')
    time_frame = fields.Selection([
        ('last_month', 'Last Month'),
        ('yesterday', 'Yesterday'),
        ('last_year', 'Last Year')
    ], string='Time Frame')
    
    # New fields for manual input
    employee_salary_ids = fields.One2many('kpi.performance.employee.salary', 'report_id', string='Employee Salaries')

    @api.onchange('time_frame')
    def _onchange_time_frame(self):
        """Auto-populate dates from the selected time frame"""
        if not self.time_frame:
            return

        today = fields.Date.today()

        if self.time_frame == 'yesterday':
            self.from_date = today - timedelta(days=1)
            self.to_date = today - timedelta(days=1)

        elif self.time_frame == 'last_month':
            first_day_last_month = (today.replace(day=1) - timedelta(days=1)).replace(day=1)
            last_day_last_month = today.replace(day=1) - timedelta(days=1)
            self.from_date = first_day_last_month
            self.to_date = last_day_last_month

        elif self.time_frame == 'last_year':
            self.from_date = today.replace(year=today.year - 1, month=1, day=1)
            self.to_date = today.replace(year=today.year - 1, month=12, day=31)

    def _calculate_working_days(self, from_date, to_date):
        wd = 0
        d = from_date
        while d <= to_date:
            if d.weekday() < 5:
                wd += 1
            d += timedelta(days=1)
        return wd

    def _format_time_to_dhm(self, total_hours):
        """Convert decimal hours to Days, Hours, Minutes format"""
        if not total_hours or total_hours <= 0:
            return {'days': 0, 'hours': 0, 'minutes': 0, 'display': '0d 0h 0m'}
        
        days = int(total_hours // 8)
        remaining_hours = total_hours % 8
        hours = int(remaining_hours)
        minutes = int((remaining_hours - hours) * 60)
        
        display = f"{days}d {hours}h {minutes}m"
        
        return {
            'days': days,
            'hours': hours,
            'minutes': minutes,
            'display': display,
            'total_hours': total_hours
        }

    def action_generate_report(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': 'KPI Performance Report Results',
            'res_model': 'kpi.performance.report',
            'view_mode': 'form',
            'res_id': self.id,
            'views': [(self.env.ref('kra_kpi_module.view_kpi_performance_report_result').id, 'form')],
            'target': 'current',
        }

    def get_report_data(self):
        """Generate KPI Performance Report with FIXED percentage calculations"""
        self.ensure_one()

        # Build domain
        domain = [('user_id', '!=', False)]
        
        if self.employee_id:
            domain.append(('user_id', '=', self.employee_id.id))
        
        # Use create_date OR deadline
        if self.from_date and self.to_date:
            domain.append('|')
            domain.append('&')
            domain.append(('deadline', '>=', self.from_date))
            domain.append(('deadline', '<=', self.to_date))
            domain.append('&')
            domain.append(('create_date', '>=', fields.Datetime.to_datetime(self.from_date)))
            domain.append(('create_date', '<=', fields.Datetime.to_datetime(self.to_date)))
        elif self.from_date:
            domain.append('|')
            domain.append(('deadline', '>=', self.from_date))
            domain.append(('create_date', '>=', fields.Datetime.to_datetime(self.from_date)))
        elif self.to_date:
            domain.append('|')
            domain.append(('deadline', '<=', self.to_date))
            domain.append(('create_date', '<=', fields.Datetime.to_datetime(self.to_date)))

        kpi_tasks = self.env['kra.kpi'].search(domain)

        # Get employee salary data
        salary_map = {}
        for sal_line in self.employee_salary_ids:
            salary_map[sal_line.employee_id.id] = {
                'salary': sal_line.salary,
                'attendance': sal_line.attendance_days
            }

        employee_data = {}
        for kpi in kpi_tasks:
            emp = kpi.user_id
            emp_id = emp.id

            if emp_id not in employee_data:
                dept = ''
                if hasattr(emp, 'employee_id') and emp.employee_id:
                    dept = emp.employee_id.department_id.name or ''

                employee_data[emp_id] = {
                    'employee_id': emp_id,
                    'employee_name': emp.name,
                    'department': dept,
                    'total_actual_minutes': 0,
                }

            # Convert actual time from seconds to minutes
            actual_minutes = (kpi.timer_total_seconds or 0) / 60.0
            employee_data[emp_id]['total_actual_minutes'] += actual_minutes

        result = []
        for emp_id, data in employee_data.items():
            # Get salary and attendance from manual input
            salary_info = salary_map.get(emp_id, {'salary': 0, 'attendance': 0})
            salary = salary_info['salary']
            attendance = salary_info['attendance']
            
            # Calculate total actual time in hours
            total_actual_hours = data['total_actual_minutes'] / 60.0
            
            # Calculate Unit: total minutes × (100/60) = total minutes × 1.6666
            unit = data['total_actual_minutes'] * (100.0 / 60.0)
            
            # Calculate Available Hours: attendance × 8
            available_hrs = attendance * 8
            
            # Calculate Available Units: available_hrs × 100
            available_units = available_hrs * 100
            
            # FIXED CALCULATIONS:
            # Unit Cost = salary / available_units (NOT unit!)
            unit_cost = salary / available_units if available_units > 0 else 0
            
            # Productivity Unit = unit × unit_cost
            productivity_unit = unit * unit_cost
            
            # Productivity Cost = productivity_unit (same value, kept for clarity)
            productivity_cost = productivity_unit
            
            # Productivity Cost % = (unit / available_units) × 100
            # This gives percentage of available time actually used
            productivity_cost_pct = (unit / available_units * 100) if available_units > 0 else 0
            
            # Performance Deviation = productivity_cost_pct - 100
            # Positive means overperformance, negative means underperformance
            performance_deviation = productivity_cost_pct - 100
            
            # Determine remarks based on productivity cost %
            if productivity_cost_pct >= 90:
                remark = 'Exceptional'
                remark_class = 'text-success'
            elif productivity_cost_pct >= 75:
                remark = 'Good'
                remark_class = 'text-info'
            else:
                remark = 'Below Target'
                remark_class = 'text-danger'

            # Format actual time
            act_formatted = self._format_time_to_dhm(total_actual_hours)

            result.append({
                'employee_id': emp_id,
                'employee_name': data['employee_name'],
                'department': data.get('department', ''),
                'salary': round(salary, 2),
                'unit': round(unit, 2),
                'attendance_days': attendance,
                'unit_cost': round(unit_cost, 4),  # More decimal places for accuracy
                'available_hrs': round(available_hrs, 2),
                'available_units': round(available_units, 2),
                'productivity_unit': round(productivity_unit, 2),
                'productivity_cost': round(productivity_cost, 2),
                'productivity_cost_pct': round(productivity_cost_pct, 2),
                'performance_deviation': round(performance_deviation, 2),
                'total_actual_display': act_formatted['display'],
                'total_actual_hours': total_actual_hours,
                'remarks': remark,
                'remarks_class': remark_class,
            })

        return result


# ============================================================
#        Employee Salary Input Model (Transient)
# ============================================================
class KpiPerformanceEmployeeSalary(models.TransientModel):
    _name = 'kpi.performance.employee.salary'
    _description = 'Employee Salary for Performance Report'

    report_id = fields.Many2one('kpi.performance.report', string='Report', required=True, ondelete='cascade')
    employee_id = fields.Many2one('res.users', string='Employee', required=True)
    salary = fields.Float(string='Salary', required=True, default=0.0)
    attendance_days = fields.Integer(string='Attendance Days', required=True, default=0)
    
# ============================================================
#               KPI ATTENTION REPORT - FIXED
# ============================================================
class KpiAttentionReport(models.TransientModel):
    _name = 'kpi.attention.report'
    _description = 'KPI Attention Report - Paused Tasks'

    employee_id = fields.Many2one('res.users', string='Employee Name')
    from_date = fields.Date(string='From Date')
    to_date = fields.Date(string='To Date')

    def action_generate_report(self):
        """Open generated KPI Attention Report"""
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': 'KPI Attention Report Results',
            'res_model': 'kpi.attention.report',
            'view_mode': 'form',
            'res_id': self.id,
            'target': 'current',
        }

    def get_report_data(self):
        """Get all paused KPI tasks requiring managerial attention - FIXED"""
        self.ensure_one()

        # Build domain for paused tasks
        domain = [
            ('task_state', '=', 'paused'),  # Only paused tasks
            ('paused_reason', '!=', False),  # Must have a reason
        ]
        
        # Add employee filter if specified
        if self.employee_id:
            domain.append(('user_id', '=', self.employee_id.id))
        
        # FIXED: Use write_date instead of non-existent paused_time field
        # write_date updates when task state changes, so it's a good proxy
        if self.from_date:
            domain.append(('write_date', '>=', fields.Datetime.to_datetime(self.from_date)))
        
        if self.to_date:
            # Add one day to include the entire end date
            end_datetime = fields.Datetime.to_datetime(self.to_date)
            end_datetime = end_datetime.replace(hour=23, minute=59, second=59)
            domain.append(('write_date', '<=', end_datetime))

        # Search for paused KPI tasks
        paused_kpis = self.env['kra.kpi'].search(domain, order='write_date desc')

        # Build result list
        result = []
        for kpi in paused_kpis:
            # FIXED: Use write_date as proxy for when task was paused
            paused_datetime = kpi.write_date
            
            # Format date and time
            paused_date = paused_datetime.strftime('%Y-%m-%d') if paused_datetime else ''
            paused_time = paused_datetime.strftime('%H:%M:%S') if paused_datetime else ''
            
            result.append({
                'id': kpi.id,
                'seq_no': kpi.id,  # Using KPI ID as sequence number
                'name': kpi.name,
                'kra_name': kpi.kra_id.name if kpi.kra_id else '',
                'employee_id': kpi.user_id.id if kpi.user_id else False,
                'employee_name': kpi.user_id.name if kpi.user_id else 'Unassigned',
                'paused_date': paused_date,
                'paused_time': paused_time,
                'paused_datetime': paused_datetime.isoformat() if paused_datetime else '',
                'paused_reason': kpi.paused_reason or 'No reason provided',
                'priority': kpi.priority or 'regular',
                'deadline': str(kpi.deadline) if kpi.deadline else '',
            })

        return result


