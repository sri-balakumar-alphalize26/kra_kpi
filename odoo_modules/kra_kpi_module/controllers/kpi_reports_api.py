from odoo import http, fields
from odoo.exceptions import ConcurrencyError
from odoo.http import request

# Timestamps shown to a user must be in THEIR timezone, and kra_api already owns
# that conversion. Imported rather than re-implemented so the two controllers
# cannot drift into formatting the same value differently.
from .kra_api import convert_to_user_tz
from datetime import timedelta
import json
import re

# Idle-check timings live with the model that owns them (kpi.work.session) so the
# cron and these routes can never drift apart on the numbers.
from ..models.kpi_work_session import IDLE_CHECK_MIN, NO_TASK_NUDGE_MIN, _fmt_hms, _to_user_tz_str
from ..models.kpi_nontask_block import NOTE_MAX, NONTASK_REASON_CODES
from ..models.kpi_client_invoice import PAYMENT_METHODS
from ..models.kpi import clean_deliverable, deliverable_type_label, ref_type

# End-of-day summary note. Distinct from NOTE_MAX above, which caps the short one-line
# reason on a pause/break — this one holds a whole day's write-up (a real one runs ~400
# characters over a dozen lines). Mirrors NOTE_MAX in utils/workdayNote.js; keep the two
# in step. A sanity bound only: the column is TEXT and this route never rejects.
WORKDAY_NOTE_MAX = 2000

# How a snapshot's saved / reopened moment reads on every client: Odoo, the web app
# and the phone all print this string as-is, so they agree. The raw UTC value beside
# it was printed verbatim before, which put a 01:10 IST save at "19:40" the day before.
SNAPSHOT_TS_FMT = '%d %b %Y, %I:%M %p %Z'


def _snapshot_ts(dt):
    return _to_user_tz_str(dt, request.env.user, SNAPSHOT_TS_FMT) if dt else ''


def _parse_task_array(text):
    """Try to extract a JSON array of strings from an LLM response. Falls back to
    line-splitting if the model produced free text.

    Accepts shapes:
      ["task a", "task b"]
      {"tasks": ["task a", ...]}   (Groq json_object mode, OpenAI-style)
      {"items": ["task a", ...]}   (other models that pick different keys)
      {"<anything>": [list of strings]}
    """
    if not text:
        return []

    def _from_value(val):
        if isinstance(val, list):
            return [str(x).strip() for x in val if str(x).strip()][:50]
        if isinstance(val, dict):
            # Prefer well-known keys first
            for key in ('tasks', 'items', 'results', 'task_names', 'data'):
                if isinstance(val.get(key), list):
                    return [str(x).strip() for x in val[key] if str(x).strip()][:50]
            # Otherwise: first list-of-strings value we find
            for v in val.values():
                if isinstance(v, list) and v and all(isinstance(x, str) for x in v):
                    return [x.strip() for x in v if x.strip()][:50]
        return None

    # First attempt: parse as JSON directly
    try:
        got = _from_value(json.loads(text))
        if got is not None:
            return got
    except Exception:
        pass
    # Second attempt: find a JSON array inside the text
    m = re.search(r'\[(?:[^\[\]]|\n)*\]', text, re.DOTALL)
    if m:
        try:
            got = _from_value(json.loads(m.group(0)))
            if got is not None:
                return got
        except Exception:
            pass
    # Third attempt: split lines, strip bullets/numbers
    out = []
    for line in text.splitlines():
        s = line.strip().lstrip('-*•').strip()
        s = re.sub(r'^\d+[\.\)]\s*', '', s)
        s = s.strip('"\' ')
        if 5 <= len(s) <= 200:
            out.append(s)
    return out[:50]


class KpiReportsAPI(http.Controller):

    def _is_owner_admin(self):
        """Owner / Coordinator / System — the people the admin screens are for.

        One definition for every route that reads the whole team under sudo():
        Live Tracking always checked this inline; the Owner Dashboard's billing
        routes and the Client Task Queue list checked nothing, and the app only
        hid their tiles — so any signed-in client could call them by hand.
        """
        user = request.env.user
        return (
            user.has_group('kra_kpi_module.group_kra_admin')
            or user.has_group('kra_kpi_module.group_kra_owner')
            or user.has_group('base.group_system'))
    
    @http.route('/kpi_reports/unit/generate', type='json', auth='user', methods=['POST'], csrf=False)
    def generate_unit_report(self, **params):
        """Generate KPI Unit Report data"""
        try:
            from_date = params.get('from_date')
            to_date = params.get('to_date')
            employee_id = params.get('employee_id')
            time_frame = params.get('time_frame')
            
            report = request.env['kpi.unit.report'].create({
                'from_date': from_date,
                'to_date': to_date,
                'employee_id': int(employee_id) if employee_id else False,
                'time_frame': time_frame or False,
            })
            
            report_data = report.get_report_data()
            
            return {
                'status': True,
                'report_id': report.id,
                'data': report_data,
            }
        except Exception as e:
            return {
                'status': False,
                'message': str(e),
            }
    
    @http.route('/kpi_reports/unit/employee_tasks', type='json', auth='user', methods=['POST'], csrf=False)
    def get_employee_tasks(self, **params):
        """Get detailed task breakdown for an employee"""
        if not self._is_owner_admin():
            return {'status': False, 'message': 'Admin only.'}
        try:
            employee_id = params.get('employee_id')
            from_date = params.get('from_date')
            to_date = params.get('to_date')
            
            if not employee_id:
                return {'status': False, 'message': 'employee_id is required'}
            
            domain = [('user_id', '=', int(employee_id))]
            
            if from_date and to_date:
                domain.append('|')
                domain.append('&')
                domain.append(('deadline', '>=', from_date))
                domain.append(('deadline', '<=', to_date))
                domain.append('&')
                domain.append(('create_date', '>=', from_date + ' 00:00:00'))
                domain.append(('create_date', '<=', to_date + ' 23:59:59'))
            elif from_date:
                domain.append('|')
                domain.append(('deadline', '>=', from_date))
                domain.append(('create_date', '>=', from_date + ' 00:00:00'))
            elif to_date:
                domain.append('|')
                domain.append(('deadline', '<=', to_date))
                domain.append(('create_date', '<=', to_date + ' 23:59:59'))
            
            tasks = request.env['kra.kpi'].sudo().search(domain, order='id')
            
            task_list = []
            for task in tasks:
                estimate_hrs = (task.estimate_hours or 0) + ((task.estimate_minutes or 0) / 60.0)
                hrs_spent = (task.timer_total_seconds or 0) / 3600.0
                
                task_list.append({
                    'id': task.id,
                    'seq_no': task.id,
                    'name': task.name,
                    'estimated_hrs': estimate_hrs,
                    'hrs_spent': (task.timer_total_seconds or 0) / 3600.0,
                    'estimated_unit': estimate_hrs,
                    'unit_spent': hrs_spent * 100,
                    'kra_name': task.kra_id.name if task.kra_id else '',
                    'priority': task.priority or '',
                    'task_state': task.task_state or '',
                })
            
            return {
                'status': True,
                'tasks': task_list,
                'employee_name': request.env['res.users'].browse(int(employee_id)).name,
            }
        except Exception as e:
            import logging
            _logger = logging.getLogger(__name__)
            _logger.error(f"Error in get_employee_tasks: {str(e)}")
            return {
                'status': False,
                'message': str(e),
            }
    
    @http.route('/kpi_reports/performance/get_employees', type='json', auth='user', methods=['POST'], csrf=False)
    def get_employees_with_tasks(self, **params):
        """Get list of employees who have tasks in the date range with saved salary data"""
        try:
            from_date = params.get('from_date')
            to_date = params.get('to_date')
            employee_id = params.get('employee_id')
            
            domain = [('user_id', '!=', False)]
            
            if employee_id:
                domain.append(('user_id', '=', int(employee_id)))
            
            if from_date and to_date:
                domain.append('|')
                domain.append('&')
                domain.append(('deadline', '>=', from_date))
                domain.append(('deadline', '<=', to_date))
                domain.append('&')
                domain.append(('create_date', '>=', from_date + ' 00:00:00'))
                domain.append(('create_date', '<=', to_date + ' 23:59:59'))
            elif from_date:
                domain.append('|')
                domain.append(('deadline', '>=', from_date))
                domain.append(('create_date', '>=', from_date + ' 00:00:00'))
            elif to_date:
                domain.append('|')
                domain.append(('deadline', '<=', to_date))
                domain.append(('create_date', '<=', to_date + ' 23:59:59'))
            
            kpi_tasks = request.env['kra.kpi'].search(domain)
            employee_ids = kpi_tasks.mapped('user_id')
            
            employees = []
            for emp in employee_ids:
                saved_salary_config = request.env['kpi.employee.salary.config'].search([
                    ('employee_id', '=', emp.id)
                ], limit=1)
                
                employees.append({
                    'id': emp.id,
                    'name': emp.name,
                    'saved_salary': saved_salary_config.salary if saved_salary_config else 0
                })
            
            return {
                'status': True,
                'employees': employees
            }
        except Exception as e:
            import logging
            _logger = logging.getLogger(__name__)
            _logger.error(f"Error in get_employees_with_tasks: {str(e)}")
            return {
                'status': False,
                'message': str(e),
                'employees': []
            }
    
    @http.route('/kpi_reports/performance/generate', type='json', auth='user', methods=['POST'], csrf=False)
    def generate_performance_report(self, **params):
        """Generate KPI Performance Report data with salary inputs"""
        try:
            from_date = params.get('from_date')
            to_date = params.get('to_date')
            employee_id = params.get('employee_id')
            time_frame = params.get('time_frame')
            employee_salary_data = params.get('employee_salary_data', [])
            
            report = request.env['kpi.performance.report'].create({
                'from_date': from_date,
                'to_date': to_date,
                'employee_id': int(employee_id) if employee_id else False,
                'time_frame': time_frame or False,
            })
            
            for emp_data in employee_salary_data:
                request.env['kpi.performance.employee.salary'].create({
                    'report_id': report.id,
                    'employee_id': emp_data['employee_id'],
                    'salary': emp_data['salary'],
                    'attendance_days': emp_data['attendance_days']
                })
                
                salary_config = request.env['kpi.employee.salary.config'].search([
                    ('employee_id', '=', emp_data['employee_id'])
                ], limit=1)
                
                if salary_config:
                    salary_config.write({
                        'salary': emp_data['salary'],
                        'attendance_days': emp_data['attendance_days'],
                        'last_updated': request.env.cr.now()
                    })
                else:
                    request.env['kpi.employee.salary.config'].create({
                        'employee_id': emp_data['employee_id'],
                        'salary': emp_data['salary'],
                        'attendance_days': emp_data['attendance_days']
                    })
            
            report_data = report.get_report_data()
            
            return {
                'status': True,
                'report_id': report.id,
                'data': report_data,
            }
        except Exception as e:
            import logging
            _logger = logging.getLogger(__name__)
            _logger.error(f"Error in generate_performance_report: {str(e)}")
            return {
                'status': False,
                'message': str(e),
            }
    
    @http.route('/kpi_reports/performance/generate_direct', type='json', auth='user', methods=['POST'], csrf=False)
    def generate_performance_report_direct(self, **params):
        """Generate KPI Performance Report directly from Employee Salary Master"""
        try:
            from_date = params.get('from_date')
            to_date = params.get('to_date')
            employee_id = params.get('employee_id')
            
            domain = [('user_id', '!=', False)]
            
            if employee_id:
                domain.append(('user_id', '=', int(employee_id)))
            
            if from_date and to_date:
                domain.append('|')
                domain.append('&')
                domain.append(('deadline', '>=', from_date))
                domain.append(('deadline', '<=', to_date))
                domain.append('&')
                domain.append(('create_date', '>=', from_date + ' 00:00:00'))
                domain.append(('create_date', '<=', to_date + ' 23:59:59'))
            elif from_date:
                domain.append('|')
                domain.append(('deadline', '>=', from_date))
                domain.append(('create_date', '>=', from_date + ' 00:00:00'))
            elif to_date:
                domain.append('|')
                domain.append(('deadline', '<=', to_date))
                domain.append(('create_date', '<=', to_date + ' 23:59:59'))
            
            kpi_tasks = request.env['kra.kpi'].search(domain)
            
            employee_ids = kpi_tasks.mapped('user_id')
            
            reassignment_domain = [('previous_assignee_id', '!=', False)]
            
            if from_date:
                reassignment_domain.append(('reassignment_date', '>=', from_date + ' 00:00:00'))
            if to_date:
                reassignment_domain.append(('reassignment_date', '<=', to_date + ' 23:59:59'))
            
            if employee_id:
                reassignment_domain.append(('previous_assignee_id', '=', int(employee_id)))
            
            reassignment_records = request.env['kpi.reassignment.history'].search(reassignment_domain)
            reassignment_employee_ids = reassignment_records.mapped('previous_assignee_id')
            
            all_employee_ids = employee_ids | reassignment_employee_ids
            
            salary_configs = request.env['kpi.employee.salary.config'].search([
                ('employee_id', 'in', all_employee_ids.ids)
            ])
            
            salary_map = {
                config.employee_id.id: {
                    'salary': config.salary,
                    'working_days': config.working_days,
                    'available_hours': config.available_hours,
                    'available_units': config.available_units,
                    'unit_cost': config.unit_cost
                }
                for config in salary_configs
            }
            
            missing_employees = []
            
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
                        'total_estimated_hours': 0,
                        'total_actual_hours': 0,
                    }
                
                estimate_hrs = (kpi.estimate_hours or 0) + ((kpi.estimate_minutes or 0) / 60.0)
                actual_hrs = (kpi.timer_total_seconds or 0) / 3600.0
                
                employee_data[emp_id]['total_estimated_hours'] += estimate_hrs
                employee_data[emp_id]['total_actual_hours'] += actual_hrs
            
            for reassignment in reassignment_records:
                prev_emp_id = reassignment.previous_assignee_id.id
                
                if prev_emp_id not in employee_data:
                    emp = reassignment.previous_assignee_id
                    dept = ''
                    if hasattr(emp, 'employee_id') and emp.employee_id:
                        dept = emp.employee_id.department_id.name or ''
                    
                    employee_data[prev_emp_id] = {
                        'employee_id': prev_emp_id,
                        'employee_name': emp.name,
                        'department': dept,
                        'total_estimated_hours': 0,
                        'total_actual_hours': 0,
                    }
                
                reassignment_hours = (reassignment.time_spent_seconds or 0) / 3600.0
                employee_data[prev_emp_id]['total_actual_hours'] += reassignment_hours
                
                kpi_task = reassignment.kpi_id
                if kpi_task:
                    estimate_hrs = (kpi_task.estimate_hours or 0) + ((kpi_task.estimate_minutes or 0) / 60.0)
                    employee_data[prev_emp_id]['total_estimated_hours'] += estimate_hrs
            
            result = []
            for emp_id, data in employee_data.items():
                salary_info = salary_map.get(emp_id)
                
                if not salary_info or salary_info['salary'] <= 0 or salary_info['working_days'] <= 0:
                    missing_employees.append({
                        'id': emp_id,
                        'name': data['employee_name']
                    })
                    continue
                
                salary = salary_info['salary']
                working_days = salary_info['working_days']
                available_hours = salary_info['available_hours']
                available_units = salary_info['available_units']
                unit_cost = salary_info['unit_cost']
                
                estimated_hrs = data['total_estimated_hours']
                actual_hrs = data['total_actual_hours']
                
                estimated_minutes = round(estimated_hrs * 60)
                actual_minutes = round(actual_hrs * 60)
                
                estimated_hrs_rounded = estimated_minutes / 60.0
                actual_hrs_rounded = actual_minutes / 60.0
                
                estimated_units = estimated_hrs_rounded * 100
                productivity_units = actual_hrs_rounded * 100
                performance_deviation = estimated_units - productivity_units
                productivity_cost = productivity_units * unit_cost
                productivity_cost_pct = (actual_hrs_rounded / available_hours * 100) if available_hours > 0 else 0

                # ✅ FIX: Set deviation to 0 for not started tasks
                if estimated_hrs_rounded == 0 and actual_hrs_rounded == 0:
                    remark = 'No Tasks Assigned'
                    remark_class = 'text-warning'
                    performance_deviation = 0  # ✅ Force deviation to 0
                elif estimated_hrs_rounded > 0 and actual_hrs_rounded == 0:
                    remark = 'Not Started'
                    remark_class = 'text-primary'
                    performance_deviation = 0  # ✅ Force deviation to 0 for not started
                else:
                    if performance_deviation > 0:
                        remark = 'Excellent Performance'
                        remark_class = 'text-success'
                    else:
                        remark = 'Low Performance'
                        remark_class = 'text-danger'
                
                result.append({
                    'employee_id': emp_id,
                    'employee_name': data['employee_name'],
                    'department': data.get('department', ''),
                    'salary': round(salary, 2),
                    'working_days': working_days,
                    'estimated_hours': round(estimated_hrs_rounded, 2),
                    'estimated_units': round(estimated_units, 2),
                    'actual_hours': round(actual_hrs_rounded, 2),
                    'productivity_units': round(productivity_units, 2),
                    'performance_deviation': round(performance_deviation, 2),
                    'available_hours': round(available_hours, 2),
                    'available_units': round(available_units, 2),
                    'unit_cost': round(unit_cost, 4),
                    'productivity_cost': round(productivity_cost, 2),
                    'productivity_cost_pct': round(productivity_cost_pct, 2),
                    'remarks': remark,
                    'remarks_class': remark_class,
                })
            
            return {
                'status': True,
                'data': result,
                'missing_employees': missing_employees
            }
        except Exception as e:
            import logging
            _logger = logging.getLogger(__name__)
            _logger.error(f"Error in generate_performance_report_direct: {str(e)}")
            return {
                'status': False,
                'message': str(e),
                'data': [],
                'missing_employees': []
            }
    
    # ============================================================
    #  ✅ NEW: Individual Employee Performance Detail Endpoint
    # ============================================================
    @http.route('/kpi_reports/performance/employee_detail', type='json', auth='user', methods=['POST'], csrf=False)
    def get_employee_performance_detail(self, **params):
        """Get task-level performance breakdown for a specific employee"""
        if not self._is_owner_admin():
            return {'status': False, 'message': 'Admin only.'}
        try:
            employee_id = params.get('employee_id')
            from_date = params.get('from_date')
            to_date = params.get('to_date')
            
            if not employee_id:
                return {'status': False, 'message': 'employee_id is required'}
            
            emp_id = int(employee_id)
            employee = request.env['res.users'].sudo().browse(emp_id)
            
            if not employee.exists():
                return {'status': False, 'message': 'Employee not found'}
            
            # Build domain for current tasks
            current_tasks_domain = [('user_id', '=', emp_id)]
            
            if from_date and to_date:
                current_tasks_domain.append('|')
                current_tasks_domain.append('&')
                current_tasks_domain.append(('deadline', '>=', from_date))
                current_tasks_domain.append(('deadline', '<=', to_date))
                current_tasks_domain.append('&')
                current_tasks_domain.append(('create_date', '>=', from_date + ' 00:00:00'))
                current_tasks_domain.append(('create_date', '<=', to_date + ' 23:59:59'))
            elif from_date:
                current_tasks_domain.append('|')
                current_tasks_domain.append(('deadline', '>=', from_date))
                current_tasks_domain.append(('create_date', '>=', from_date + ' 00:00:00'))
            elif to_date:
                current_tasks_domain.append('|')
                current_tasks_domain.append(('deadline', '<=', to_date))
                current_tasks_domain.append(('create_date', '<=', to_date + ' 23:59:59'))
            
            # Get current tasks
            current_tasks = request.env['kra.kpi'].sudo().search(current_tasks_domain)
            
            # Build domain for reassignment history
            reassignment_domain = [('previous_assignee_id', '=', emp_id)]
            
            if from_date:
                reassignment_domain.append(('reassignment_date', '>=', from_date + ' 00:00:00'))
            if to_date:
                reassignment_domain.append(('reassignment_date', '<=', to_date + ' 23:59:59'))
            
            # Get reassignment history
            reassignment_records = request.env['kpi.reassignment.history'].sudo().search(reassignment_domain)
            
            # Process tasks
            task_details = []
            
            # Process current tasks
            for task in current_tasks:
                estimate_hrs = (task.estimate_hours or 0) + ((task.estimate_minutes or 0) / 60.0)
                actual_hrs = (task.timer_total_seconds or 0) / 3600.0
                
                # Apply same calculation logic as main report
                estimated_minutes = round(estimate_hrs * 60)
                actual_minutes = round(actual_hrs * 60)
                
                estimated_hrs_rounded = estimated_minutes / 60.0
                actual_hrs_rounded = actual_minutes / 60.0
                
                estimated_units = estimated_hrs_rounded * 100
                productivity_units = actual_hrs_rounded * 100
                performance_deviation = estimated_units - productivity_units

                # ✅ FIX: Set deviation to 0 for not started tasks
                if actual_hrs_rounded == 0 and estimated_hrs_rounded > 0:
                    # Task not started - set deviation to 0
                    performance_deviation = 0
                    display_status = 'not_started'
                else:
                    display_status = task.task_state or 'not_started'
                
                task_details.append({
                    'task_id': task.id,
                    'task_name': task.name,
                    'status': task.task_state or 'not_started',
                    'estimated_hrs': round(estimated_hrs_rounded, 2),
                    'estimated_units': round(estimated_units, 2),
                    'actual_hrs': round(actual_hrs_rounded, 2),
                    'productivity_units': round(productivity_units, 2),
                    'performance_deviation': round(performance_deviation, 2),
                    'kra_name': task.kra_id.name if task.kra_id else '',
                    'priority': task.priority or 'regular',
                    'assignment_type': 'Current Assignee',
                })
            
            # Process reassigned tasks
            for reassignment in reassignment_records:
                task = reassignment.kpi_id
                if not task:
                    continue
                
                estimate_hrs = (task.estimate_hours or 0) + ((task.estimate_minutes or 0) / 60.0)
                
                # Actual hours from reassignment history (time spent by previous assignee)
                actual_hrs = (reassignment.time_spent_seconds or 0) / 3600.0
                
                # Apply same calculation logic
                estimated_minutes = round(estimate_hrs * 60)
                actual_minutes = round(actual_hrs * 60)
                
                estimated_hrs_rounded = estimated_minutes / 60.0
                actual_hrs_rounded = actual_minutes / 60.0
                
                estimated_units = estimated_hrs_rounded * 100
                productivity_units = actual_hrs_rounded * 100
                performance_deviation = estimated_units - productivity_units

                if actual_hrs_rounded == 0 and estimated_hrs_rounded > 0:
                    performance_deviation = 0
                
                task_details.append({
                    'task_id': task.id,
                    'task_name': task.name,
                    'status': 'reassigned',
                    'estimated_hrs': round(estimated_hrs_rounded, 2),
                    'estimated_units': round(estimated_units, 2),
                    'actual_hrs': round(actual_hrs_rounded, 2),
                    'productivity_units': round(productivity_units, 2),
                    'performance_deviation': round(performance_deviation, 2),
                    'kra_name': task.kra_id.name if task.kra_id else '',
                    'priority': task.priority or 'regular',
                    'assignment_type': 'Previous Assignee (Reassigned)',
                })
            
            return {
                'status': True,
                'employee_name': employee.name,
                'tasks': task_details,
                'total_tasks': len(task_details)
            }
            
        except Exception as e:
            import logging
            _logger = logging.getLogger(__name__)
            _logger.error(f"Error in get_employee_performance_detail: {str(e)}")
            return {
                'status': False,
                'message': str(e),
                'tasks': []
            }
        
    @http.route('/kpi_reports/task/details', type='json', auth='user', methods=['POST'], csrf=False)
    def get_task_details(self, **params):
        """Get detailed information about a specific KPI task.

        AUTHORISATION: this route reads any task by id under sudo() and
        returns its description, checklist, guidelines, estimate and
        assignee. It had no check of any kind, so any signed-in user --
        a client portal user included -- could walk the ids and read every
        task on the system, including other clients' work.

        The rule is the same one the screens around it use: the admin
        screens this serves are for coordinator/owner/system, and a
        developer may read a task that is their own.
        """
        try:
            task_id = params.get('task_id')

            if not task_id:
                return {'status': False, 'message': 'task_id is required'}

            task = request.env['kra.kpi'].sudo().browse(int(task_id))

            if not task.exists():
                return {'status': False, 'message': 'Task not found'}

            if not (self._is_owner_admin()
                    or (task.user_id and task.user_id.id == request.env.uid)):
                return {'status': False, 'message': 'Not authorized.'}

            estimate = (task.estimate_hours or 0) + ((task.estimate_minutes or 0) / 60.0)
            
            return {
                'status': True,
                'task': {
                    'id': task.id,
                    'name': task.name,
                    'kra_name': task.kra_id.name if task.kra_id else '',
                    'priority': task.priority or '',
                    'estimate': estimate,
                    'points': task.points or 0,
                    'assignee': task.user_id.name if task.user_id else '',
                    'user_group': task.user_group_id.name if task.user_group_id else '',
                    'deadline': str(task.deadline) if task.deadline else '',
                    'reminder_days': task.reminder_days or 0,
                    'description': task.description or '',
                    'checklist': task.checklist or '',
                    'guidelines': task.guidelines or '',
                    'task_state': task.task_state or '',
                    'timer_total_seconds': task.timer_total_seconds or 0,
                    'paused_reason': task.paused_reason or '',
                }
            }
        except Exception as e:
            return {
                'status': False,
                'message': str(e),
            }
    
    @http.route('/kpi_reports/attention/generate', type='json', auth='user', methods=['POST'], csrf=False)
    def generate_attention_report(self, **params):
        """Generate KPI Attention Report data for paused tasks"""
        try:
            employee_id = params.get('employee_id')
            from_date = params.get('from_date')
            to_date = params.get('to_date')
            
            report = request.env['kpi.attention.report'].create({
                'employee_id': int(employee_id) if employee_id else False,
                'from_date': from_date or False,
                'to_date': to_date or False,
            })
            
            report_data = report.get_report_data()
            
            return {
                'status': True,
                'report_id': report.id,
                'data': report_data,
            }
        except Exception as e:
            import logging
            _logger = logging.getLogger(__name__)
            _logger.error(f"Error in generate_attention_report: {str(e)}")
            return {
                'status': False,
                'message': str(e),
            }
    
    # ============================================================
    #                     KRA REPORT APIs
    # ============================================================
    
    @staticmethod
    def _id_list(raw):
        """Coerce a posted id list into ints, dropping blanks/junk."""
        if not raw:
            return []
        if not isinstance(raw, (list, tuple)):
            raw = [raw]
        ids = []
        for value in raw:
            try:
                as_int = int(value)
            except (TypeError, ValueError):
                continue
            if as_int:
                ids.append(as_int)
        return ids

    @staticmethod
    def _csv_param(raw):
        """Join a posted list of plain string values into the model's CSV form."""
        if not raw:
            return ''
        if not isinstance(raw, (list, tuple)):
            raw = [raw]
        return ','.join(str(v).strip() for v in raw if str(v).strip())

    def _report_from_params(self, params):
        """Build the transient report record from a posted filter payload.

        Shared by /kra/generate, /kra/summary and /kra/filter_counts so the
        payload is parsed in exactly one place — three copies is how a new
        filter ends up silently ignored by one of the routes.
        """
        employee_id = params.get('employee_id')
        kra_id = params.get('kra_id')
        return request.env['kpi.kra.report'].create({
            'from_date': params.get('from_date'),
            'to_date': params.get('to_date'),
            'employee_id': int(employee_id) if employee_id else False,
            'employee_ids': [(6, 0, self._id_list(params.get('employee_ids')))],
            'kra_id': int(kra_id) if kra_id else False,
            'kra_ids': [(6, 0, self._id_list(params.get('kra_ids')))],
            'excluded_kra_ids': [(6, 0, self._id_list(params.get('excluded_kra_ids')))],
            'task_types': self._csv_param(params.get('task_types')),
            'task_states': self._csv_param(params.get('task_states')),
            'time_frame': params.get('time_frame') or False,
        })

    @staticmethod
    def _employee_label(report):
        """'Ravi, Karthick' / 'All Employees', for the header lines."""
        users = report.employee_ids or report.employee_id
        return ', '.join(users.mapped('name')) if users else 'All Employees'

    @staticmethod
    def _state_label(report):
        """Readable state names rather than raw codes, e.g. 'Verification Pending'."""
        codes = report._split_csv(report.task_states)
        if not codes:
            return 'All States'
        labels = dict(request.env['kra.kpi']._fields['task_state'].selection)
        return ', '.join(labels.get(code, code) for code in codes)

    @http.route('/kpi_reports/kra/get_filters', type='json', auth='user', methods=['POST'], csrf=False)
    def get_kra_report_filters(self, **params):
        """Get filter options (KRAs and Employees) for KRA Report"""
        try:
            kra_report = request.env['kpi.kra.report']
            
            kras = kra_report.get_all_kras_for_filter()
            employees = kra_report.get_all_employees_for_filter()
            task_types = kra_report.get_all_task_types_for_filter()
            task_states = kra_report.get_all_task_states_for_filter()

            return {
                'status': True,
                'kras': kras,
                'employees': employees,
                'task_types': task_types,
                'task_states': task_states,
            }
        except Exception as e:
            import logging
            _logger = logging.getLogger(__name__)
            _logger.error(f"Error in get_kra_report_filters: {str(e)}")
            return {
                'status': False,
                'message': str(e),
                'kras': [],
                'employees': [],
                'task_types': [],
                'task_states': [],
            }
    
    @http.route('/kpi_reports/kra/generate', type='json', auth='user', methods=['POST'], csrf=False)
    def generate_kra_report(self, **params):
        """Generate KRA Report with hierarchical structure"""
        try:
            from_date = params.get('from_date')
            to_date = params.get('to_date')
            task_types = self._csv_param(params.get('task_types'))

            report = self._report_from_params(params)

            report_data = report.get_report_data()
            summary_data = report.get_kra_summary()
            
            return {
                'status': True,
                'report_id': report.id,
                'data': report_data,
                'summary': summary_data,
                'filters': {
                    'from_date': from_date,
                    'to_date': to_date,
                    'employee_name': self._employee_label(report),
                    'kra_name': report._kra_filter_label(),
                    'task_type_name': task_types.replace(',', ', ') if task_types else 'All Types',
                    'task_state_name': self._state_label(report),
                }
            }
        except Exception as e:
            import logging
            _logger = logging.getLogger(__name__)
            _logger.error(f"Error in generate_kra_report: {str(e)}")
            return {
                'status': False,
                'message': str(e),
            }
    
    @http.route('/kpi_reports/kra/summary', type='json', auth='user', methods=['POST'], csrf=False)
    def get_kra_report_summary(self, **params):
        """Get KRA Report summary grouped by KRA hierarchy"""
        try:
            report = self._report_from_params(params)
            summary_data = report.get_kra_summary()
            
            return {
                'status': True,
                'summary': summary_data,
            }
        except Exception as e:
            import logging
            _logger = logging.getLogger(__name__)
            _logger.error(f"Error in get_kra_report_summary: {str(e)}")
            return {
                'status': False,
                'message': str(e),
            }

    @http.route('/kpi_reports/kra/filter_counts', type='json', auth='user', methods=['POST'], csrf=False)
    def get_kra_filter_counts(self, **params):
        """Per-option counts for the filter dropdowns, scoped to the other filters."""
        try:
            report = self._report_from_params(params)
            return dict(report.get_filter_counts(), status=True)
        except Exception as e:
            import logging
            _logger = logging.getLogger(__name__)
            _logger.error(f"Error in get_kra_filter_counts: {str(e)}")
            return {
                'status': False,
                'message': str(e),
                'kras': {}, 'employees': {}, 'task_types': {}, 'task_states': {},
            }

    # ------------------------------------------------------------------ #
    #  KRA Report: admin gate, saved view, and download history           #
    # ------------------------------------------------------------------ #

    def _kra_report_admin_ok(self):
        """Who may edit the KRA Report rather than only read it.

        The screen is reachable by managers, but adding tasks, renaming people and
        storing downloads are admin actions — same triple every other admin screen
        in this file uses."""
        user = request.env.user
        return (user.has_group('kra_kpi_module.group_kra_admin')
                or user.has_group('kra_kpi_module.group_kra_owner')
                or user.has_group('base.group_system'))

    @http.route('/kpi_reports/kra/context', type='json', auth='user', methods=['POST'], csrf=False)
    def kra_report_context(self, **params):
        """What the screen needs to know about the caller on load: whether the
        edit affordances appear, and the saved view to restore."""
        user = request.env.user
        return {
            'status': True,
            'is_admin': self._kra_report_admin_ok(),
            'user_id': user.id,
            'saved_state': user.sudo().kpi_kra_report_state or '',
        }

    @http.route('/kpi_reports/kra/state_set', type='json', auth='user', methods=['POST'], csrf=False)
    def kra_report_state_set(self, **params):
        """Store (or clear) this user's KRA Report working view.

        Per user, not per company: this is unsaved work — trimmed rows, report-only
        renames, report-only tasks — and it belongs to whoever was building it.
        Passing an empty state is how the screen's Clear button wipes it."""
        user = request.env.user
        state = params.get('state')
        # Written with sudo because a plain employee may not write their own
        # res.users row, and this is their own preference data either way.
        user.sudo().kpi_kra_report_state = state if state else False
        return {'status': True}

    @http.route('/kpi_reports/kra/download_save', type='json', auth='user', methods=['POST'], csrf=False)
    def kra_report_download_save(self, **params):
        """Keep a copy of a report the browser just handed the user.

        The PDF/Excel/ZIP are built client-side and never reach the server, so this
        is the only way the file can exist afterwards. Deliberately best-effort:
        the user already has their download, so a failure here must be reported
        without pretending the download itself failed."""
        if not self._kra_report_admin_ok():
            return {'status': False, 'message': 'Not authorized'}
        try:
            rec_id = request.env['kpi.report.download'].sudo().record_download({
                'data_b64': params.get('data_b64') or '',
                'filename': params.get('filename') or 'report',
                'kind': params.get('kind') or 'zip',
                'from_date': params.get('from_date') or False,
                'to_date': params.get('to_date') or False,
                'row_count': params.get('row_count') or 0,
                'filters_json': params.get('filters_json') or '',
            })
            if not rec_id:
                return {'status': False, 'message': 'The file could not be stored.'}
            return {'status': True, 'id': rec_id}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error("download_save failed: %s", e)
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_reports/kra/download_list', type='json', auth='user', methods=['POST'], csrf=False)
    def kra_report_download_list(self, **params):
        """Past downloads, newest first. Never returns the blobs — the list would
        be tens of megabytes; download_file fetches one on demand."""
        if not self._kra_report_admin_ok():
            return {'status': False, 'message': 'Not authorized', 'downloads': []}
        try:
            limit = min(int(params.get('limit') or 50), 200)
        except (TypeError, ValueError):
            limit = 50
        rows = request.env['kpi.report.download'].sudo().search([], limit=limit)
        return {'status': True, 'downloads': [{
            'id': r.id,
            'filename': r.filename or 'report',
            'kind': r.kind or 'zip',
            'file_size': r.file_size or 0,
            'row_count': r.row_count or 0,
            'from_date': str(r.from_date) if r.from_date else '',
            'to_date': str(r.to_date) if r.to_date else '',
            'user_name': r.user_id.name or '',
            'generated_at': convert_to_user_tz(r.generated_at) if r.generated_at else '',
        } for r in rows]}

    @http.route('/kpi_reports/kra/download_file', type='json', auth='user', methods=['POST'], csrf=False)
    def kra_report_download_file(self, **params):
        """One stored download's bytes, base64. JSON rather than an http route for
        the same reason /kpi/progress/file_b64 is: an external browser handed a URL
        sends no session cookie and lands on the login page instead of the file."""
        if not self._kra_report_admin_ok():
            return {'status': False, 'message': 'Not authorized'}
        try:
            rec = request.env['kpi.report.download'].sudo().browse(int(params.get('id') or 0))
        except (TypeError, ValueError):
            return {'status': False, 'message': 'Bad id'}
        if not rec.exists() or not rec.file:
            return {'status': False, 'message': 'File not found'}
        data = rec.file
        if isinstance(data, bytes):
            data = data.decode()
        return {'status': True, 'filename': rec.filename or 'report',
                'kind': rec.kind or 'zip', 'data_b64': data}

    @http.route('/kpi_reports/kra/download_delete', type='json', auth='user', methods=['POST'], csrf=False)
    def kra_report_download_delete(self, **params):
        """Remove one stored download before its retention runs out."""
        if not self._kra_report_admin_ok():
            return {'status': False, 'message': 'Not authorized'}
        try:
            rec = request.env['kpi.report.download'].sudo().browse(int(params.get('id') or 0))
        except (TypeError, ValueError):
            return {'status': False, 'message': 'Bad id'}
        if not rec.exists():
            return {'status': False, 'message': 'Not found'}
        rec.unlink()
        return {'status': True}

    # ============================================================
    #              KRA EMPLOYEE REPORT APIs
    # ============================================================
    
    @http.route('/kpi_reports/employee/get_employees', type='json', auth='user', methods=['POST'], csrf=False)
    def get_employees_for_employee_report(self, **params):
        """Get list of all employees who have KPI tasks assigned"""
        try:
            report = request.env['kpi.employee.report']
            employees = report.get_all_employees()
            
            return {
                'status': True,
                'employees': employees,
            }
        except Exception as e:
            import logging
            _logger = logging.getLogger(__name__)
            _logger.error(f"Error in get_employees_for_employee_report: {str(e)}")
            return {
                'status': False,
                'message': str(e),
                'employees': [],
            }
    
    @http.route('/kpi_reports/employee/generate', type='json', auth='user', methods=['POST'], csrf=False)
    def generate_employee_report(self, **params):
        """Generate KRA Employee Report with detailed task breakdown"""
        try:
            from_date = params.get('from_date')
            to_date = params.get('to_date')
            employee_ids = params.get('employee_ids', [])
            time_frame = params.get('time_frame')
            
            # Create report record
            report_vals = {
                'from_date': from_date,
                'to_date': to_date,
                'time_frame': time_frame or False,
            }
            
            report = request.env['kpi.employee.report'].create(report_vals)
            
            # Set employee_ids if provided
            if employee_ids:
                employee_ids_int = [int(eid) for eid in employee_ids if eid]
                report.write({'employee_ids': [(6, 0, employee_ids_int)]})
            
            # Generate report data
            report_data = report.get_report_data()
            
            return {
                'status': True,
                'report_id': report.id,
                'data': report_data,
                'filters': {
                    'from_date': from_date,
                    'to_date': to_date,
                    'employees': ', '.join(report.employee_ids.mapped('name')) if report.employee_ids else 'All Employees',
                    'time_frame': time_frame or 'Custom',
                }
            }
        except Exception as e:
            import logging
            _logger = logging.getLogger(__name__)
            _logger.error(f"Error in generate_employee_report: {str(e)}")
            return {
                'status': False,
                'message': str(e),
            }
    
    @http.route('/kpi_reports/employee/pdf_data', type='json', auth='user', methods=['POST'], csrf=False)
    def get_employee_report_pdf_data(self, **params):
        """Get formatted data for PDF generation of KRA Employee Report"""
        try:
            from_date = params.get('from_date')
            to_date = params.get('to_date')
            employee_ids = params.get('employee_ids', [])
            time_frame = params.get('time_frame')
            
            # Create report record
            report_vals = {
                'from_date': from_date,
                'to_date': to_date,
                'time_frame': time_frame or False,
            }
            
            report = request.env['kpi.employee.report'].create(report_vals)
            
            # Set employee_ids if provided
            if employee_ids:
                employee_ids_int = [int(eid) for eid in employee_ids if eid]
                report.write({'employee_ids': [(6, 0, employee_ids_int)]})
            
            # Get PDF formatted data
            pdf_data = report.get_pdf_report_data()
            
            return {
                'status': True,
                'pdf_data': pdf_data,
            }
        except Exception as e:
            import logging
            _logger = logging.getLogger(__name__)
            _logger.error(f"Error in get_employee_report_pdf_data: {str(e)}")
            return {
                'status': False,
                'message': str(e),
            }
    
    @http.route('/kpi_reports/employee/task_details', type='json', auth='user', methods=['POST'], csrf=False)
    def get_employee_task_details(self, **params):
        """Get detailed information about a specific task including all progress entries"""
        if not self._is_owner_admin():
            return {'status': False, 'message': 'Admin only.'}
        try:
            task_id = params.get('task_id')
            from_date = params.get('from_date')
            to_date = params.get('to_date')
            
            if not task_id:
                return {'status': False, 'message': 'task_id is required'}
            
            task = request.env['kra.kpi'].sudo().browse(int(task_id))
            
            if not task.exists():
                return {'status': False, 'message': 'Task not found'}
            
            # Get all progress entries
            progress_domain = [('kpi_id', '=', task.id)]
            
            if from_date and to_date:
                progress_domain.extend([
                    ('create_date', '>=', from_date + ' 00:00:00'),
                    ('create_date', '<=', to_date + ' 23:59:59'),
                ])
            
            progress_records = request.env['kpi.progress'].search(
                progress_domain, order='create_date asc'
            )
            
            progress_list = []
            for prog in progress_records:
                progress_list.append({
                    'id': prog.id,
                    'date': prog.create_date.strftime('%Y-%m-%d'),
                    'date_display': prog.create_date.strftime('%d %b %Y'),
                    'time': prog.create_date.strftime('%H:%M:%S'),
                    'summary': prog.summary or '',
                    'has_attachment': bool(prog.uploaded_file),
                    'file_name': prog.file_name or '',
                })
            
            # Calculate times
            estimated_hours = (task.estimate_hours or 0) + ((task.estimate_minutes or 0) / 60.0)
            actual_hours = (task.timer_total_seconds or 0) / 3600.0
            
            return {
                'status': True,
                'task': {
                    'id': task.id,
                    'name': task.name,
                    'kra_name': task.kra_id.name if task.kra_id else '',
                    'employee_name': task.user_id.name if task.user_id else '',
                    'assigned_date': task.create_date.strftime('%d %b %Y %H:%M') if task.create_date else '',
                    'deadline': task.deadline.strftime('%d %b %Y') if task.deadline else '',
                    'priority': task.priority or 'regular',
                    'task_state': task.task_state or '',
                    'description': task.description or '',
                    'estimated_hours': estimated_hours,
                    'actual_hours': actual_hours,
                    'timer_total_seconds': task.timer_total_seconds or 0,
                    'paused_reason': task.paused_reason or '',
                    'completed_by': task.completed_by.name if task.completed_by else '',
                    'completion_date': task.completion_date.strftime('%d %b %Y %H:%M') if task.completion_date else '',
                    'approved_by': task.approved_by.name if task.approved_by else '',
                    'approval_date': task.approval_date.strftime('%d %b %Y %H:%M') if task.approval_date else '',
                },
                'progress_entries': progress_list,
                'total_entries': len(progress_list),
            }
        except Exception as e:
            import logging
            _logger = logging.getLogger(__name__)
            _logger.error(f"Error in get_employee_task_details: {str(e)}")
            return {
                'status': False,
                'message': str(e),
            }

    # ============================================================
    #                CLIENT INVOICE APIs
    # ============================================================

    @http.route('/kpi_client_invoice/get_currencies', type='json', auth='user', methods=['POST'], csrf=False)
    def get_currencies(self, **params):
        """Return the 3 invoice currencies (INR / OMR / USD).
        We hard-restrict the picker to the operator's mandated set + activate
        any of the 3 that's currently archived in the DB (so OMR works even
        on stock installs where it ships inactive).
        """
        try:
            wanted = ['INR', 'OMR', 'USD']
            Cur = request.env['res.currency'].sudo()
            currencies = Cur.with_context(active_test=False).search([('name', 'in', wanted)])
            # Activate any of the 3 that's currently flagged inactive.
            inactive = currencies.filtered(lambda c: not c.active)
            if inactive:
                inactive.write({'active': True})
            # Preserve INR -> OMR -> USD ordering.
            by_name = {c.name: c for c in currencies}
            ordered = [by_name[w] for w in wanted if w in by_name]
            return {
                'status': True,
                'currencies': [
                    {'id': c.id, 'name': c.name, 'symbol': c.symbol or '', 'position': c.position or 'after'}
                    for c in ordered
                ],
            }
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"get_currencies: {str(e)}")
            return {'status': False, 'message': str(e), 'currencies': []}

    @http.route('/kpi_client_invoice/get_filters', type='json', auth='user', methods=['POST'], csrf=False)
    def get_client_invoice_filters(self, **params):
        """Return list of billable client KRAs for the filter dropdown.

        We list every level-2 KRA structurally (parent exists, grandparent
        does not) rather than relying on the stored ``is_client`` flag, which
        can drift out of sync if a record is created via raw SQL or if
        ``parent_id`` is set after creation.  This way, any newly added child
        of a root KRA shows up here automatically with no manual fix-up.
        """
        try:
            # Root-level only. _compute_is_client flags BOTH the root and the level-2
            # child, so listing every is_client KRA showed each client twice — the
            # picker read "Nexgennpos" and "Nexgennpos > Nexgennpos", with no way to
            # tell them apart. Invoicing a root already covers its whole subtree via
            # _get_descendant_ids(), so nothing is lost; level-2 nodes are projects and
            # belong in the Sub-KRA filter, which is where they now appear.
            clients = request.env['kra.master'].search(
                [('is_client', '=', True),
                 ('active', '=', True),
                 ('parent_id', '=', False)],
                order='sequence, name'
            )
            # A client-only user gets THEIR clients, not everyone's. This route was
            # returning every billable client in the database to anyone logged in —
            # a list of who else you work for, readable straight from the browser
            # console. The portal no longer calls it, but hiding the caller is not
            # the same as scoping the data.
            if self._is_current_user_client_only():
                mine = set()
                for k in self._resolve_client_kras_for_user():
                    mine.update(k._get_descendant_ids())
                clients = clients.filtered(lambda c: c.id in mine)

            # Per-client tallies, so the dropdown can group into "ready to bill",
            # "nothing left" and "no tasks yet" instead of listing 90 identical-looking
            # names. Counted with the SAME billability helper the task picker uses, so
            # the two can never tell you different things about the same client.
            #
            # Two grouped reads for the whole list rather than a query per client: this
            # dropdown is built on every page load.
            all_ids = []
            subtree = {}
            for c in clients:
                ids = c._get_descendant_ids()
                subtree[c.id] = ids
                all_ids.extend(ids)
            tasks = request.env['kra.kpi'].search([('kra_id', 'in', list(set(all_ids)))])
            billed = set(request.env['kpi.client.invoice.line'].sudo().search([
                ('kpi_id', 'in', tasks.ids),
            ]).mapped('kpi_id').ids)
            by_kra = {}
            for t in tasks:
                by_kra.setdefault(t.kra_id.id, []).append(t)

            rows = []
            for c in clients:
                total = billable = invoiced = 0
                for kra_id in subtree[c.id]:
                    for t in by_kra.get(kra_id, ()):
                        total += 1
                        ok, _why, code = self._invoice_billability(t, billed)
                        if ok:
                            billable += 1
                        elif code == 'invoiced':
                            invoiced += 1
                rows.append({
                    'id': c.id,
                    'name': c.name,
                    'parent_name': c.parent_id.name or '',
                    'project_quoted_hours': round(c.client_quoted or 0.0, 2),
                    # False → nobody can sign this client's work off, so an invoice
                    # for them can only ever be empty. Flagged in the dropdown so
                    # it is visible BEFORE picking, not after creating.
                    'has_client_user': bool(c._effective_client_users()),
                    'task_count': total,
                    'billable_count': billable,
                    'invoiced_count': invoiced,
                })
            return {'status': True, 'clients': rows}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"get_client_invoice_filters: {str(e)}")
            return {'status': False, 'message': str(e), 'clients': []}

    @staticmethod
    def _default_invoice_title(client_kra, from_date, to_date):
        """'supermarket — Aug 2026' for a blank title.

        The all-unbilled preset sends a 2000..2099 window, which would read as
        "Jan 2000 – Dec 2099" — nonsense on an invoice — so it gets its own wording.
        """
        from datetime import date as _date
        name = (client_kra.name or 'Client').strip()

        def _parse(v):
            try:
                return fields.Date.to_date(v)
            except Exception:
                return None

        d1, d2 = _parse(from_date), _parse(to_date)
        if not d1 or not d2:
            return name
        if d1.year <= 2000 or d2.year >= 2099:
            return f"{name} — all unbilled"
        if d1 == d2:
            return f"{name} — {d1.strftime('%d %b %Y')}"
        # A whole calendar month is the common case and reads best unqualified.
        if (d1.year, d1.month) == (d2.year, d2.month):
            last = (_date(d2.year + (d2.month // 12), (d2.month % 12) + 1, 1)
                    - timedelta(days=1))
            if d1.day == 1 and d2 >= last:
                return f"{name} — {d1.strftime('%b %Y')}"
            return f"{name} — {d1.strftime('%d')}–{d2.strftime('%d %b %Y')}"
        return f"{name} — {d1.strftime('%d %b')} – {d2.strftime('%d %b %Y')}"

    @http.route('/kpi_client_invoice/create', type='json', auth='user', methods=['POST'], csrf=False)
    def create_client_invoice(self, **params):
        """Create a new invoice and auto-populate its KPI lines from time logs."""
        try:
            # The client decides whose signed-off work is billed and who receives
            # the invoice, so it is mandatory. Checked here as well as in the UI:
            # a missing one otherwise surfaced as a raw KeyError / int('') /
            # "Expected singleton" further down.
            raw_client = params.get('client_kra_id')
            client_kra_id = int(raw_client) if str(raw_client or '').strip().isdigit() else 0
            client_kra = request.env['kra.master'].browse(client_kra_id)
            if not client_kra_id or not client_kra.exists():
                return {'status': False,
                        'message': 'Choose a client before creating the invoice.'}
            if not params.get('from_date') or not params.get('to_date'):
                return {'status': False,
                        'message': 'Choose the period this invoice covers.'}
            vals = {
                'client_kra_id': client_kra_id,
                'from_date': params['from_date'],
                'to_date': params['to_date'],
            }
            user_ids = params.get('filter_user_ids') or []
            kpi_ids = params.get('filter_kpi_ids') or []
            sub_kra_ids = params.get('filter_sub_kra_ids') or []
            if user_ids:
                vals['filter_user_ids'] = [(6, 0, [int(u) for u in user_ids])]
            if kpi_ids:
                vals['filter_kpi_ids'] = [(6, 0, [int(k) for k in kpi_ids])]
            if sub_kra_ids:
                vals['filter_sub_kra_ids'] = [(6, 0, [int(s) for s in sub_kra_ids])]
            # Optional task-type filter — list of prefixes like ['REQ', 'UPT'].
            task_types = params.get('task_types') or []
            if task_types:
                clean = [t.strip().upper() for t in task_types
                         if isinstance(t, str) and t.strip()]
                if clean:
                    vals['filter_task_types'] = ','.join(clean)
            # Optional one-shot fields the UI already passes for new invoices.
            if params.get('invoice_title'):
                vals['invoice_title'] = params['invoice_title']
            else:
                # Left blank, an invoice is identifiable only by its sequence number, so
                # a list of them reads as a column of INV/2026/xxxx. Named here rather
                # than in the OWL form so the app gets the same default.
                vals['invoice_title'] = self._default_invoice_title(
                    client_kra, params['from_date'], params['to_date'])
            if params.get('hourly_rate') is not None:
                try:
                    vals['hourly_rate'] = float(params['hourly_rate'])
                except (TypeError, ValueError):
                    pass
            if params.get('currency_id'):
                vals['currency_id'] = int(params['currency_id'])
            # Per-task billing: set the method + the three type prices BEFORE populate,
            # so action_populate_from_logs seeds each line's unit_price by task type.
            if params.get('billing_method') in ('hourly', 'per_task'):
                vals['billing_method'] = params['billing_method']
            for pk in ('price_req', 'price_upt', 'price_bug'):
                if params.get(pk) is not None:
                    try:
                        vals[pk] = float(params[pk])
                    except (TypeError, ValueError):
                        pass
            # An invoice for a client nobody can sign work off for can only ever be
            # empty. Guarded on BOTH conditions on purpose: approve_task() records an
            # offline client signature without needing a portal user, so a client with
            # no linked user can still have genuinely billable work.
            client = request.env['kra.master'].browse(vals['client_kra_id'])
            if not client._effective_client_users():
                signed = request.env['kra.kpi'].sudo().search_count([
                    ('kra_id', 'in', client._get_descendant_ids()),
                    ('active', '=', True),
                    ('client_final_approved', '=', True),
                ])
                if not signed:
                    return {'status': False, 'message':
                            "%s has no client user assigned, so nobody can sign work off and "
                            "this invoice could only ever be empty. Assign a client user to "
                            "this KRA (or its parent) first." % (client.name or 'This client')}

            # Duplicate guard. A double-click used to create two or three identical
            # drafts, and because populate skips tasks already on another invoice
            # line, the extras then held those tasks back from every later invoice.
            # Server-side as well as in the UI, because a disabled button cannot stop
            # a repeated RPC from the app or a retry.
            dup = request.env['kpi.client.invoice'].search([
                ('client_kra_id', '=', vals['client_kra_id']),
                ('from_date', '=', vals['from_date']),
                ('to_date', '=', vals['to_date']),
                ('invoice_title', '=', vals.get('invoice_title') or False),
                ('state', '=', 'draft'),
            ], limit=1)
            if dup:
                return {'status': False, 'message':
                        "Draft %s already covers this client and period. Open or delete it "
                        "instead of creating another — duplicate drafts hold the same tasks "
                        "and make later invoices come back empty." % (dup.name or '')}

            inv = request.env['kpi.client.invoice'].create(vals)
            populate = inv.action_populate_from_logs()
            data = inv._serialize_for_ui()
            # Why nothing was billable, so the UI can say so instead of "No lines yet."
            data['empty_reasons'] = populate.get('empty_reasons') or []
            return {'status': True, 'invoice_id': inv.id, 'data': data}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"create_client_invoice: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_invoice/get_sub_kras_for_client', type='json', auth='user', methods=['POST'], csrf=False)
    def list_sub_kras_for_invoice(self, **params):
        """For a chosen client KRA, return its direct child KRAs (project-level sub-KRAs).

        Distinct from get_sub_kras_for_client (which returns all descendants, used by
        the completion-cert picker). Here we want only the immediate level-2 projects
        because that is the granularity the Owner invoices at.
        """
        try:
            client = request.env['kra.master'].browse(int(params['client_kra_id']))
            if not client.exists():
                return {'status': False, 'message': 'Client KRA not found.', 'sub_kras': []}
            subs = request.env['kra.master'].search(
                [('parent_id', '=', client.id), ('active', '=', True)],
                order='sequence, name'
            )
            return {
                'status': True,
                'sub_kras': [{'id': s.id, 'name': s.name or ''} for s in subs],
            }
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"list_sub_kras_for_invoice: {str(e)}")
            return {'status': False, 'message': str(e), 'sub_kras': []}

    # Why a task cannot be invoiced, in the words an admin would use. Every
    # non-billable state used to collapse into the single string "awaiting
    # sign-off", so an admin who HAD signed everything off still saw a wall of
    # "awaiting sign-off" against work that was merely unstarted, and could not
    # tell what was genuinely waiting on the client.
    #
    # The code is the coarse grouping the UI colours by:
    #   'signoff'  — really is the client's move (amber)
    #   'progress' — the team is still working on it (blue)
    #   'invoiced' — settled, already on an invoice (grey)
    _BILL_BLOCK_BY_STATE = {
        'partially_completed': ('awaiting admin check', 'progress'),
        'in_progress': ('in progress', 'progress'),
        'paused': ('paused', 'progress'),
        'hold': ('on hold', 'progress'),
        'rework': ('rework needed', 'progress'),
        'pre_approval_pending': ('awaiting client approval', 'progress'),
    }

    def _invoice_billability(self, kpi, billed_ids):
        """(billable, reason, code) for one task in the invoice builder's picker.

        billed_ids is checked FIRST: a billed task is by definition signed off,
        so it must never be described as awaiting anything.
        """
        if kpi.id in billed_ids:
            return False, 'already invoiced', 'invoiced'
        if kpi.task_state == 'completed' and kpi.client_final_approved:
            return True, '', ''
        if kpi.task_state in ('awaiting_client', 'completed'):
            # 'completed' without the signature is a legacy row — the signature
            # is what makes work billable, so it still waits on the client.
            return False, 'awaiting sign-off', 'signoff'
        reason, code = self._BILL_BLOCK_BY_STATE.get(
            kpi.task_state, ('not started', 'progress'))
        return False, reason, code

    @http.route('/kpi_client_invoice/get_client_users_and_kpis', type='json', auth='user', methods=['POST'], csrf=False)
    def get_client_users_and_kpis(self, **params):
        """For a chosen client KRA, return the developers + KPIs to populate filter dropdowns.

        Optional 'sub_kra_ids' narrows the search to KPIs under those sub-KRAs only.
        """
        try:
            client = request.env['kra.master'].browse(int(params['client_kra_id']))
            if not client.exists():
                return {'status': False, 'message': 'Client KRA not found.'}
            kra_ids = client._get_descendant_ids()
            sub_kra_ids = params.get('sub_kra_ids') or []
            if sub_kra_ids:
                sub_set = set()
                subs = request.env['kra.master'].browse([int(s) for s in sub_kra_ids])
                for sub in subs:
                    sub_set.update(sub._get_descendant_ids())
                kra_ids = list(sub_set & set(kra_ids))
            kpis = request.env['kra.kpi'].search([('kra_id', 'in', kra_ids)], order='name')
            user_set = set()
            for k in kpis:
                if k.user_id:
                    user_set.add((k.user_id.id, k.user_id.name or k.user_id.login or ''))
                for c in k.contributor_ids:
                    user_set.add((c.id, c.name or c.login or ''))
            # Also include anyone who has time-logs against these KPIs (might be ex-contributors)
            logs = request.env['kpi.time.log'].search([('kpi_id', 'in', kpis.ids)])
            for l in logs:
                if l.user_id:
                    user_set.add((l.user_id.id, l.user_id.name or l.user_id.login or ''))
            users = sorted([{'id': uid, 'name': name} for uid, name in user_set], key=lambda u: u['name'])
            # Mark what can actually be billed. This list showed every task regardless
            # of state, so an admin saw their work sitting right there and then got an
            # empty invoice — which is what made the result feel arbitrary.
            billed_ids = set(request.env['kpi.client.invoice.line'].sudo().search([
                ('kpi_id', 'in', kpis.ids),
            ]).mapped('kpi_id').ids)
            kpi_list = []
            for k in kpis:
                billable, why, code = self._invoice_billability(k, billed_ids)
                kpi_list.append({
                    'id': k.id, 'name': k.name, 'kra_name': k.kra_id.name or '',
                    'billable': billable,
                    'not_billable_reason': why,
                    'not_billable_code': code,
                    # Task type, as the invoice itself understands it: the prefix of
                    # external_ref (REQ-004 → REQ). _populate filters on exactly this,
                    # so the picker needs it to show the same set the invoice will bill.
                    # Empty for a task with no reference.
                    'task_type': ref_type(k.external_ref),
                })
            return {'status': True, 'users': users, 'kpis': kpi_list}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"get_client_users_and_kpis: {str(e)}")
            return {'status': False, 'message': str(e), 'users': [], 'kpis': []}

    @http.route('/kpi_client_invoice/get', type='json', auth='user', methods=['POST'], csrf=False)
    def get_client_invoice(self, **params):
        """Return a single invoice's full serialized form for the detail screen.

        A client gets the redacted form. The admin's payment note carries internal
        remarks and must be withheld HERE — hiding it in the OWL template would leave it
        sitting in the JSON response, which a client can read straight from the browser.
        """
        try:
            inv = request.env['kpi.client.invoice'].browse(int(params['invoice_id']))
            if not inv.exists():
                return {'status': False, 'message': 'Invoice not found.'}
            return {'status': True,
                    'data': inv._serialize_for_ui(for_client=self._is_current_user_client_only())}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"get_client_invoice: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_invoice/list', type='json', auth='user', methods=['POST'], csrf=False)
    def list_client_invoices(self, **params):
        """List invoices. Optional filters:
          - client_kra_id: only invoices for one client
          - status_filter: 'all' (default) | 'draft' | 'finalized' | 'sent'
                           | 'due' | 'claimed' | 'paid'

        Money moves Due → Claimed → Paid, and an invoice sits in exactly one of
        them. 'due' therefore excludes claims: once the client says they have paid,
        it is no longer merely owed, it is waiting on the admin to confirm — and
        leaving it in both buckets is how the one invoice that needs attention
        stays buried among the ones that don't.
              'due'     → finalized/sent, unpaid, no client claim outstanding
              'claimed' → client says paid, admin has not confirmed yet
              'paid'    → payment_status = 'paid'
        """
        try:
            # Decided once, not per row: it drives the payload strip below and
            # a client's list can be long.
            is_client_only = self._is_current_user_client_only()
            domain = []
            if params.get('client_kra_id'):
                # Match the whole subtree, not just the exact node. The picker now
                # offers root clients only, but existing invoices were raised against
                # level-2 KRAs — an exact match would hide every one of them.
                picked = request.env['kra.master'].browse(int(params['client_kra_id']))
                domain.append(('client_kra_id', 'in', picked._get_descendant_ids()))

            status = (params.get('status_filter') or 'all').lower()
            if status == 'draft':
                domain.append(('state', '=', 'draft'))
            elif status == 'finalized':
                domain.append(('state', '=', 'finalized'))
            elif status == 'sent':
                domain.append(('state', '=', 'sent'))
            elif status == 'due':
                domain += [('state', 'in', ('finalized', 'sent')),
                           ('payment_status', '=', 'unpaid'),
                           ('client_paid_claim', '=', False)]
            elif status == 'claimed':
                domain += [('client_paid_claim', '=', True),
                           ('payment_status', '=', 'unpaid')]
            elif status == 'paid':
                domain.append(('payment_status', '=', 'paid'))
            # 'all' → no extra filter

            invs = request.env['kpi.client.invoice'].search(domain, order='invoice_date desc, id desc')
            # Compute summary counts (used by the filter-chip badges).
            counts = {
                'all':       request.env['kpi.client.invoice'].search_count([]),
                'draft':     request.env['kpi.client.invoice'].search_count([('state','=','draft')]),
                'finalized': request.env['kpi.client.invoice'].search_count([('state','=','finalized')]),
                'sent':      request.env['kpi.client.invoice'].search_count([('state','=','sent')]),
                'due':       request.env['kpi.client.invoice'].search_count(
                                  [('state','in',('finalized','sent')),
                                   ('payment_status','=','unpaid'),
                                   ('client_paid_claim','=',False)]),
                'claimed':   request.env['kpi.client.invoice'].search_count(
                                  [('client_paid_claim','=',True),
                                   ('payment_status','=','unpaid')]),
                'paid':      request.env['kpi.client.invoice'].search_count([('payment_status','=','paid')]),
            }
            return {
                'status': True,
                # for_client here too, not only on the detail route: the list is
                # the payload a client actually receives most often, and it was
                # carrying paid_by_name and payment_date for every invoice.
                'invoices': [i._serialize_for_list(for_client=is_client_only)
                             for i in invs],
                'counts':   counts,
            }
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"list_client_invoices: {str(e)}")
            return {'status': False, 'message': str(e), 'invoices': []}

    @http.route('/kpi_client_invoice/mark_paid', type='json', auth='user', methods=['POST'], csrf=False)
    def mark_invoice_paid(self, **params):
        """Mark an invoice paid (or revert paid → unpaid).  Authorized for
        owner / coordinator / system.

        params:
          invoice_id  (required)
          paid        (bool, default True)
          note        (optional)
        """
        try:
            user = request.env.user
            allowed = (
                user.has_group('base.group_system')
                or user.has_group('kra_kpi_module.group_kra_owner')
                or user.has_group('kra_kpi_module.group_kra_admin')
            )
            if not allowed:
                return {'status': False, 'message': 'Not authorized.'}

            inv = request.env['kpi.client.invoice'].browse(int(params['invoice_id']))
            if not inv.exists():
                return {'status': False, 'message': 'Invoice not found.'}
            note = (params.get('note') or '').strip()
            paid = params.get('paid', True)
            if paid:
                inv.action_mark_paid(note=note, method=(params.get('method') or '').strip())
            else:
                inv.action_mark_unpaid(note=note)
            return {'status': True, 'data': inv._serialize_for_ui()}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"mark_invoice_paid: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_invoice/delete', type='json', auth='user', methods=['POST'], csrf=False)
    def delete_client_invoice(self, **params):
        """Delete a DRAFT invoice. Same authorization as mark_paid.

        There was previously no way to delete an invoice at all, only remove_line.
        A mis-clicked draft therefore lived forever — and because populate excludes
        tasks already sitting on any other invoice line (drafts included), a
        forgotten draft silently held its tasks back from every future invoice.

        Draft only, deliberately: a finalized or sent invoice is a record the client
        has already seen, so it stays auditable. Lines cascade on delete
        (invoice_id ondelete='cascade'), which frees the held tasks.
        """
        try:
            user = request.env.user
            allowed = (
                user.has_group('base.group_system')
                or user.has_group('kra_kpi_module.group_kra_owner')
                or user.has_group('kra_kpi_module.group_kra_admin')
            )
            if not allowed:
                return {'status': False, 'message': 'Not authorized.'}

            inv = request.env['kpi.client.invoice'].browse(int(params['invoice_id']))
            if not inv.exists():
                return {'status': False, 'message': 'Invoice not found.'}
            if inv.state != 'draft':
                return {'status': False, 'message':
                        "%s is %s — only draft invoices can be deleted. Reset it to draft "
                        "first if it genuinely needs removing." % (inv.name or 'This invoice', inv.state)}
            if inv.payment_status == 'paid':
                return {'status': False, 'message':
                        "%s is marked paid and cannot be deleted." % (inv.name or 'This invoice')}
            name = inv.name or ''
            freed = len(inv.line_ids.filtered(lambda l: l.kpi_id))
            inv.unlink()
            return {'status': True, 'name': name, 'freed_tasks': freed}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"delete_client_invoice: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_invoice/save_line', type='json', auth='user', methods=['POST'], csrf=False)
    def save_invoice_line(self, **params):
        """Update editable fields on an invoice line. Allowed only when invoice is in draft."""
        try:
            line = request.env['kpi.client.invoice.line'].browse(int(params['line_id']))
            if not line.exists():
                return {'status': False, 'message': 'Line not found.'}
            line.invoice_id._guard_draft()
            # Already-billed (locked) lines are read-only — the UI disables them, and this
            # blocks a crafted request from editing them (which would take effect if the
            # owning invoice were ever reset to draft).
            if line.invoice_id._is_locked_line(line):
                return {'status': False, 'message': 'This task is already billed on another invoice and cannot be edited here.'}
            updates = {}
            for k in ('description', 'notes'):
                if k in params:
                    updates[k] = params[k]
            if 'quoted_hours' in params:
                updates['quoted_hours'] = float(params['quoted_hours'] or 0.0)
            if 'unit_price' in params:
                updates['unit_price'] = float(params['unit_price'] or 0.0)
            if updates:
                line.write(updates)
            return {'status': True, 'data': line._serialize()}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"save_invoice_line: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_invoice/add_adjustment', type='json', auth='user', methods=['POST'], csrf=False)
    def add_invoice_adjustment(self, **params):
        """Append an adjustment line (positive or negative hours)."""
        try:
            inv = request.env['kpi.client.invoice'].browse(int(params['invoice_id']))
            if not inv.exists():
                return {'status': False, 'message': 'Invoice not found.'}
            inv._guard_draft()
            max_seq = max(inv.line_ids.mapped('sequence') or [0]) + 10
            line = request.env['kpi.client.invoice.line'].create({
                'invoice_id': inv.id,
                'sequence': max_seq,
                'line_type': 'adjustment',
                'description': params.get('description') or 'Adjustment',
                'quoted_hours': float(params.get('quoted_hours') or 0.0),
                'notes': params.get('notes') or '',
            })
            return {'status': True, 'line_id': line.id, 'data': line._serialize()}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"add_invoice_adjustment: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_invoice/remove_line', type='json', auth='user', methods=['POST'], csrf=False)
    def remove_invoice_line(self, **params):
        """Delete an invoice line (admin only; only when invoice is in draft)."""
        try:
            line = request.env['kpi.client.invoice.line'].browse(int(params['line_id']))
            if not line.exists():
                return {'status': False, 'message': 'Line not found.'}
            line.invoice_id._guard_draft()
            line.unlink()
            return {'status': True}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"remove_invoice_line: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_invoice/save_header', type='json', auth='user', methods=['POST'], csrf=False)
    def save_invoice_header(self, **params):
        """Update editable header fields (invoice_title, hourly_rate). Draft only."""
        try:
            inv = request.env['kpi.client.invoice'].browse(int(params['invoice_id']))
            if not inv.exists():
                return {'status': False, 'message': 'Invoice not found.'}
            inv._guard_draft()
            updates = {}
            if 'invoice_title' in params:
                updates['invoice_title'] = params['invoice_title'] or ''
            if 'hourly_rate' in params:
                updates['hourly_rate'] = float(params['hourly_rate'] or 0.0)
            if 'currency_id' in params:
                updates['currency_id'] = int(params['currency_id']) if params['currency_id'] else False
            if 'billing_method' in params and params['billing_method'] in ('hourly', 'per_task'):
                updates['billing_method'] = params['billing_method']
            price_touched = False
            for pk in ('price_req', 'price_upt', 'price_bug'):
                if pk in params:
                    updates[pk] = float(params[pk] or 0.0)
                    price_touched = True
            if updates:
                inv.write(updates)
            # Re-price every KPI line by its type when the method or any type price
            # changed — "change REQ price → all REQ tasks update".
            if price_touched or 'billing_method' in updates:
                inv._apply_type_prices()
            return {'status': True, 'data': inv._serialize_for_ui()}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"save_invoice_header: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_invoice/pdf_data', type='json', auth='user', methods=['POST'], csrf=False)
    def get_invoice_pdf_data(self, **params):
        """Return data for client-side PDF generation."""
        try:
            inv = request.env['kpi.client.invoice'].browse(int(params['invoice_id']))
            if not inv.exists():
                return {'status': False, 'message': 'Invoice not found.'}
            return {'status': True, 'data': inv.get_pdf_data()}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"get_invoice_pdf_data: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_invoice/pdf', type='json', auth='user', methods=['POST'], csrf=False)
    def get_invoice_pdf(self, **params):
        """Server-side branded invoice PDF (base64) for the mobile app, which can't
        run the web's jsPDF. Reuses get_pdf_data() (record-rule scoped, so a client
        can only render their own invoice) and renders it with reportlab in the same
        branded style as the daily/work reports."""
        try:
            inv = request.env['kpi.client.invoice'].browse(int(params.get('invoice_id') or 0))
            if not inv.exists():
                return {'status': False, 'message': 'Invoice not found.'}
            data = inv.get_pdf_data()
            pdf_bytes = self._build_invoice_pdf(data)
        except Exception as e:
            import logging, traceback
            logging.getLogger(__name__).error(f"get_invoice_pdf: {e}\n{traceback.format_exc()}")
            return {'status': False, 'message': str(e)}
        import base64
        name = (data.get('invoice', {}).get('name') or str(inv.id)).replace('/', '_')
        # State in the filename too: these get saved to a folder and emailed on, where
        # the only thing visible is the name.
        state_tag = ('PAID' if inv.payment_status == 'paid'
                     else 'CLAIMED' if inv.client_paid_claim
                     else 'UNPAID')
        return {
            'status': True,
            'file_name': 'Invoice_%s_%s.pdf' % (name, state_tag),
            'mimetype': 'application/pdf',
            'data_b64': base64.b64encode(pdf_bytes).decode(),
        }

    def _build_certificate_pdf(self, data):
        """Render a completion certificate to PDF bytes — same house style as the
        invoice and the work report: A4, 48pt margins, Times, #38385C header band,
        and the faint centred logo watermark at 8% opacity.

        Deliberately a SIGN-OFF RECORD, not an effort report. get_completion_certificate_data
        also returns per-contributor hours and a role breakdown; none of it is printed.
        This document goes to the client, and how long each developer spent is internal —
        putting it in front of them invites an argument about time rather than settling
        that the work was accepted.

        Replaces a plain-text receipt that downloaded as digital_approval_<id>.txt.
        """
        import base64
        import io
        from xml.sax.saxutils import escape as _esc
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.lib.utils import ImageReader
        from reportlab.platypus import (
            SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Image, HRFlowable,
        )

        k = data.get('kpi', {}) or {}

        brand = colors.HexColor('#38385C')
        zebra = colors.HexColor('#F7F7FB')
        grid = colors.HexColor('#E1E1E1')
        rule = colors.HexColor('#BEBEBE')
        ink = colors.black
        muted = colors.HexColor('#64748B')

        logo_bytes = None
        if data.get('company_logo_b64'):
            try:
                logo_bytes = base64.b64decode(data['company_logo_b64'])
            except Exception:
                logo_bytes = None
        logo_reader = None
        logo_ratio = 1.0
        if logo_bytes:
            try:
                logo_reader = ImageReader(io.BytesIO(logo_bytes))
                iw, ih = logo_reader.getSize()
                if iw and ih:
                    logo_ratio = float(iw) / float(ih)
            except Exception:
                logo_reader = None

        styles = getSampleStyleSheet()
        s_company = ParagraphStyle('co', parent=styles['Normal'], fontName='Times-Bold', fontSize=22, alignment=2, textColor=ink, leading=24)
        s_doctype = ParagraphStyle('dt', parent=styles['Normal'], fontName='Times-Roman', fontSize=12, alignment=2, textColor=muted, leading=16)
        s_title = ParagraphStyle('ti', parent=styles['Normal'], fontName='Times-Bold', fontSize=18, alignment=1, textColor=brand, leading=22, spaceBefore=6, spaceAfter=10)
        s_meta = ParagraphStyle('me', parent=styles['Normal'], fontName='Times-Roman', fontSize=10, textColor=ink, leading=15)
        s_lbl = ParagraphStyle('lb', parent=styles['Normal'], fontName='Times-Bold', fontSize=10, textColor=muted, leading=14)
        cell = ParagraphStyle('c', parent=styles['Normal'], fontName='Times-Roman', fontSize=9, textColor=ink, leading=12)
        s_body = ParagraphStyle('bd', parent=styles['Normal'], fontName='Times-Roman', fontSize=10, textColor=ink, leading=15, spaceBefore=6)

        PW, PH = A4
        MARGIN = 48
        content_w = PW - 2 * MARGIN

        def _watermark(canvas, doc_):
            if not logo_reader:
                return
            canvas.saveState()
            wm_w = PW * 0.55
            wm_h = wm_w / (logo_ratio or 1.0)
            if wm_h > PH * 0.5:
                wm_h = PH * 0.5
                wm_w = wm_h * (logo_ratio or 1.0)
            try:
                canvas.setFillAlpha(0.08)
                canvas.setStrokeAlpha(0.08)
            except Exception:
                pass
            try:
                canvas.drawImage(logo_reader, (PW - wm_w) / 2.0, (PH - wm_h) / 2.0,
                                 wm_w, wm_h, mask='auto', preserveAspectRatio=True)
            except Exception:
                pass
            canvas.restoreState()

        buf = io.BytesIO()
        doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN,
                                topMargin=MARGIN, bottomMargin=MARGIN, title='Completion Certificate')
        story = []

        right_cell = [Paragraph(_esc(data.get('company_name') or ''), s_company),
                      Paragraph('COMPLETION CERTIFICATE', s_doctype)]
        if logo_reader:
            h = 56
            w = min(h * logo_ratio, 150)
            left_cell = Image(io.BytesIO(logo_bytes), width=w, height=h)
            left_cell.hAlign = 'LEFT'
        else:
            left_cell = Paragraph('', cell)
        header = Table([[left_cell, right_cell]], colWidths=[content_w * 0.45, content_w * 0.55])
        header.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
            ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ]))
        story.append(header)
        story.append(Spacer(1, 6))
        story.append(HRFlowable(width='100%', thickness=0.8, color=rule, spaceBefore=0, spaceAfter=8))
        story.append(Paragraph('Certificate of Completion', s_title))

        rows = [
            ['Reference', k.get('external_ref') or '—'],
            ['Task', Paragraph(_esc(k.get('name') or ''), cell)],
            ['Client', _esc(data.get('client_name') or '—')],
            ['Project', _esc(data.get('project_name') or '—')],
        ]
        if k.get('delivery_version'):
            rows.append(['Version', k.get('delivery_version')])
        rows += [
            ['Completed on', k.get('completion_date') or '—'],
            ['Signed off by', _esc(k.get('client_signature_text') or '—')],
            ['Signed on', k.get('client_signed_datetime') or '—'],
        ]
        tbl = Table(rows, colWidths=[34 * mm, content_w - (34 * mm)])
        tbl.setStyle(TableStyle([
            ('FONTNAME', (0, 0), (-1, -1), 'Times-Roman'),
            ('FONTNAME', (0, 0), (0, -1), 'Times-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 9),
            ('TEXTCOLOR', (0, 0), (0, -1), muted),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('ROWBACKGROUNDS', (0, 0), (-1, -1), [colors.white, zebra]),
            ('GRID', (0, 0), (-1, -1), 0.5, grid),
            ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
            ('LEFTPADDING', (0, 0), (-1, -1), 6), ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ]))
        story.append(tbl)
        story.append(Spacer(1, 12))

        # The three confirmations are what the client actually agreed to — the whole
        # point of the document, so they are printed as statements, not a tick count.
        story.append(Paragraph('The client confirmed:', s_lbl))
        for ok, text in ((k.get('client_chk_delivered'), 'The work was delivered to me.'),
                         (k.get('client_chk_works'), 'I have checked it and it works.'),
                         (k.get('client_chk_authorized'), 'I am authorised to approve this.')):
            story.append(Paragraph(('%s %s' % ('&#10003;' if ok else '&#10007;', _esc(text))), s_body))

        if k.get('client_approval_notes'):
            story.append(Spacer(1, 8))
            story.append(Paragraph('Client notes:', s_lbl))
            story.append(Paragraph(_esc(k.get('client_approval_notes')), s_body))

        story.append(Spacer(1, 14))
        story.append(Paragraph(
            'This certifies that the task above was completed by %s and accepted by %s '
            'on %s. This is a digital record of that acceptance; no wet signature is '
            'required.' % (
                _esc(data.get('company_name') or 'the provider'),
                _esc(k.get('client_signature_text') or data.get('client_name') or 'the client'),
                k.get('client_signed_datetime') or '—'), s_body))

        doc.build(story, onFirstPage=_watermark, onLaterPages=_watermark)
        return buf.getvalue()

    def _build_invoice_pdf(self, data):
        """Render a client invoice to PDF bytes with reportlab (Times, #38385C
        header, zebra rows, faint logo watermark) — matching the other PDFs."""
        import base64
        import io
        from xml.sax.saxutils import escape as _esc
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.lib.utils import ImageReader
        from reportlab.platypus import (
            SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Image, HRFlowable,
        )

        inv = data.get('invoice', {}) or {}
        cur = data.get('currency', {}) or {}
        cur_name = cur.get('name') or ''

        brand = colors.HexColor('#38385C')
        zebra = colors.HexColor('#F7F7FB')
        grid = colors.HexColor('#E1E1E1')
        rule = colors.HexColor('#BEBEBE')
        ink = colors.black
        muted = colors.HexColor('#64748B')

        def _money(amt):
            try:
                dp = int(cur.get('decimal_places', 2))
            except Exception:
                dp = 2
            s = f"{float(amt or 0):,.{dp}f}"
            return f"{cur_name} {s}".strip()

        logo_bytes = None
        if data.get('company_logo_b64'):
            try:
                logo_bytes = base64.b64decode(data['company_logo_b64'])
            except Exception:
                logo_bytes = None
        logo_reader = None
        logo_ratio = 1.0
        if logo_bytes:
            try:
                logo_reader = ImageReader(io.BytesIO(logo_bytes))
                iw, ih = logo_reader.getSize()
                if iw and ih:
                    logo_ratio = float(iw) / float(ih)
            except Exception:
                logo_reader = None

        styles = getSampleStyleSheet()
        s_company = ParagraphStyle('co', parent=styles['Normal'], fontName='Times-Bold', fontSize=22, alignment=2, textColor=ink, leading=24)
        s_doctype = ParagraphStyle('dt', parent=styles['Normal'], fontName='Times-Roman', fontSize=12, alignment=2, textColor=muted, leading=16)
        s_meta = ParagraphStyle('me', parent=styles['Normal'], fontName='Times-Roman', fontSize=10, textColor=ink, leading=15)
        s_lbl = ParagraphStyle('lb', parent=styles['Normal'], fontName='Times-Bold', fontSize=10, textColor=muted, leading=14)
        cell = ParagraphStyle('c', parent=styles['Normal'], fontName='Times-Roman', fontSize=9, textColor=ink, leading=11)
        s_tot = ParagraphStyle('t', parent=styles['Normal'], fontName='Times-Bold', fontSize=12, alignment=2, textColor=ink, leading=16)

        PW, PH = A4
        MARGIN = 48
        content_w = PW - 2 * MARGIN

        def _watermark(canvas, doc_):
            if not logo_reader:
                return
            canvas.saveState()
            wm_w = PW * 0.55
            wm_h = wm_w / (logo_ratio or 1.0)
            if wm_h > PH * 0.5:
                wm_h = PH * 0.5
                wm_w = wm_h * (logo_ratio or 1.0)
            try:
                canvas.setFillAlpha(0.08)
                canvas.setStrokeAlpha(0.08)
            except Exception:
                pass
            try:
                canvas.drawImage(logo_reader, (PW - wm_w) / 2.0, (PH - wm_h) / 2.0, wm_w, wm_h, mask='auto', preserveAspectRatio=True)
            except Exception:
                pass
            canvas.restoreState()

        buf = io.BytesIO()
        doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN, topMargin=MARGIN, bottomMargin=MARGIN, title='Invoice')
        story = []

        # Payment state on the document itself. A printed or forwarded copy carried no
        # clue whether it had been settled, so the same PDF read identically before and
        # after payment. Same three colours the screens use for the same three states.
        #
        # NOTE: this invoice has TWO renderers — this one (reportlab, used by the mobile
        # app via /kpi_client_invoice/pdf) and the jsPDF builder in kpi_client_invoice.js
        # behind the web PDF button. Change the wording or the states here and change
        # them there too; they drifted apart once already.
        _inv = data.get('invoice', {}) or {}
        if _inv.get('payment_status') == 'paid':
            _stamp, _stamp_col = 'PAID', colors.HexColor('#15803D')
        elif _inv.get('client_paid_claim'):
            _stamp, _stamp_col = 'PAYMENT CLAIMED', colors.HexColor('#B45309')
        else:
            _stamp, _stamp_col = 'UNPAID', colors.HexColor('#B91C1C')
        s_stamp = ParagraphStyle('st', parent=styles['Normal'], fontName='Times-Bold',
                                 fontSize=13, alignment=2, textColor=_stamp_col, leading=17)

        right_cell = [Paragraph(_esc(data.get('company_name') or ''), s_company),
                      Paragraph('INVOICE', s_doctype),
                      Paragraph(_stamp, s_stamp)]
        if logo_reader:
            h = 56
            w = min(h * logo_ratio, 150)
            left_cell = Image(io.BytesIO(logo_bytes), width=w, height=h)
            left_cell.hAlign = 'LEFT'
        else:
            left_cell = Paragraph('', cell)
        header = Table([[left_cell, right_cell]], colWidths=[content_w * 0.45, content_w * 0.55])
        header.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
            ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ]))
        story.append(header)
        story.append(Spacer(1, 6))
        story.append(HRFlowable(width='100%', thickness=0.8, color=rule, spaceBefore=0, spaceAfter=8))

        pay = (inv.get('payment_status') or '').upper()
        story.append(Paragraph('Invoice #: <b>%s</b>%s' % (
            _esc(inv.get('name') or ''),
            ('   —   %s' % pay) if pay else ''), s_meta))
        if inv.get('invoice_title'):
            story.append(Paragraph('<b>%s</b>' % _esc(inv.get('invoice_title')), s_meta))
        story.append(Paragraph('Date: %s   •   Period: %s to %s' % (
            inv.get('invoice_date') or '', inv.get('from_date') or '', inv.get('to_date') or ''), s_meta))
        if cur_name:
            story.append(Paragraph('Currency: %s' % cur_name, s_meta))
        story.append(Spacer(1, 8))
        story.append(Paragraph('Bill To:', s_lbl))
        story.append(Paragraph('<b>%s</b>' % _esc(data.get('bill_to_name') or ''), s_meta))
        if data.get('project_name'):
            story.append(Paragraph('Project: %s' % _esc(data.get('project_name')), s_meta))
        story.append(Spacer(1, 12))

        billing = inv.get('billing_method') or 'hourly'
        has_amount = bool(data.get('has_amount'))
        rate = float(inv.get('hourly_rate') or 0)
        lines = [l for l in (inv.get('lines') or [])]

        if billing == 'per_task':
            head = ['Description', 'Type'] + (['Price'] if has_amount else [])
            rows = []
            for l in lines:
                row = [Paragraph(_esc(l.get('description')), cell), (l.get('task_kind') or l.get('line_type') or '').upper()]
                if has_amount:
                    row.append(_money(l.get('unit_price')))
                rows.append(row)
            colw = [content_w - (26 * mm) - (34 * mm if has_amount else 0), 26 * mm] + ([34 * mm] if has_amount else [])
        else:
            head = ['Description', 'Hours'] + (['Rate', 'Amount'] if has_amount else [])
            rows = []
            for l in lines:
                qh = float(l.get('quoted_hours') or 0)
                row = [Paragraph(_esc(l.get('description')), cell), f"{qh:g}"]
                if has_amount:
                    row.append(_money(rate))
                    row.append(_money(qh * rate))
                rows.append(row)
            colw = ([content_w - (22 * mm) - (34 * mm) - (34 * mm), 22 * mm, 34 * mm, 34 * mm]
                    if has_amount else [content_w - (26 * mm), 26 * mm])

        tbl = Table([head] + rows, colWidths=colw, repeatRows=1)
        tbl.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), brand),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('FONTNAME', (0, 0), (-1, -1), 'Times-Roman'),
            ('FONTNAME', (0, 0), (-1, 0), 'Times-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 9),
            ('ALIGN', (1, 0), (-1, -1), 'RIGHT'),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, zebra]),
            ('GRID', (0, 0), (-1, -1), 0.5, grid),
            ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
            ('LEFTPADDING', (0, 0), (-1, -1), 6), ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ]))
        story.append(tbl)
        story.append(Spacer(1, 10))

        if billing == 'hourly':
            story.append(Paragraph('Total Hours: %g' % float(inv.get('grand_total_hours') or 0), s_tot))
        if has_amount:
            story.append(Paragraph('Total Amount: %s' % _money(inv.get('total_amount')), s_tot))

        doc.build(story, onFirstPage=_watermark, onLaterPages=_watermark)
        return buf.getvalue()

    @http.route('/kpi_client_invoice/save_notes', type='json', auth='user', methods=['POST'], csrf=False)
    def save_invoice_notes(self, **params):
        """Update the invoice's overall notes (Html). Draft only."""
        try:
            inv = request.env['kpi.client.invoice'].browse(int(params['invoice_id']))
            if not inv.exists():
                return {'status': False, 'message': 'Invoice not found.'}
            inv._guard_draft()
            inv.notes = params.get('notes') or ''
            return {'status': True}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"save_invoice_notes: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_invoice/finalize', type='json', auth='user', methods=['POST'], csrf=False)
    def finalize_client_invoice(self, **params):
        try:
            inv = request.env['kpi.client.invoice'].browse(int(params['invoice_id']))
            if not inv.exists():
                return {'status': False, 'message': 'Invoice not found.'}
            inv.action_finalize()
            return {'status': True, 'data': inv._serialize_for_ui()}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"finalize_client_invoice: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_invoice/send', type='json', auth='user', methods=['POST'], csrf=False)
    def send_client_invoice(self, **params):
        try:
            inv = request.env['kpi.client.invoice'].browse(int(params['invoice_id']))
            if not inv.exists():
                return {'status': False, 'message': 'Invoice not found.'}
            inv.action_send()
            return {'status': True, 'data': inv._serialize_for_ui()}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"send_client_invoice: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_invoice/client_mark_paid', type='json', auth='user', methods=['POST'], csrf=False)
    def client_mark_invoice_paid(self, **params):
        """Client-only: flag that they've paid this invoice → notifies admins to
        confirm. Does NOT set payment_status (only an admin's Mark Paid does).
        Clients have READ-ONLY access (record rule blocks write), so we act via
        sudo() guarded by an explicit ownership check on client_user_ids."""
        try:
            inv = request.env['kpi.client.invoice'].sudo().browse(int(params.get('invoice_id') or 0))
            if not inv.exists():
                return {'status': False, 'message': 'Invoice not found.'}
            # Ownership: the caller must be one of this client's linked users.
            # Parent fallback matters here: on a level-2 invoice the client user sits
            # on the root, so a legitimate client was told "Not authorized" for their
            # own invoice.
            if request.env.user not in inv.client_kra_id._effective_client_users():
                return {'status': False, 'message': 'Not authorized for this invoice.'}
            if inv.state not in ('finalized', 'sent'):
                return {'status': False, 'message': 'This invoice is not ready yet.'}
            if inv.payment_status == 'paid':
                return {'status': False, 'message': 'This invoice is already marked paid.'}
            # How they paid. The UIs make it a required choice, but app builds already
            # in the field predate the field and send nothing — refusing here would kill
            # the Paid button on every phone until the fleet updates. An unknown method
            # is recorded as Other; a claim we can't record at all is worse than one
            # that says "Other". An explicitly WRONG value is still rejected.
            method = (params.get('method') or '').strip() or 'other'
            if method not in dict(PAYMENT_METHODS):
                return {'status': False, 'message': 'Choose how you paid this invoice.'}
            inv.write({
                'client_paid_claim': True,
                'client_paid_claim_date': fields.Datetime.now(),
                'client_paid_method': method,
                'client_paid_notes': (params.get('note') or '').strip()[:1000] or False,
            })
            # Ask the admins to confirm (recipients resolve from the role matrix).
            inv._fire_invoice_notification('invoice_client_paid')
            return {'status': True, 'data': inv._serialize_for_ui(for_client=True)}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"client_mark_invoice_paid: {str(e)}")
            return {'status': False, 'message': str(e)}

    # ============================================================
    #              COMPLETION CERTIFICATE APIs
    # ============================================================

    @http.route('/kpi_completion_cert/list', type='json', auth='user', methods=['POST'], csrf=False)
    def list_kpis_for_certificate(self, **params):
        """List KPIs eligible for a Completion Certificate.

        Filters (all optional):
          client_kra_id, project_kra_id, from_date, to_date, state
          By default returns only state='completed' KPIs.
        """
        try:
            domain = []
            state = params.get('state') or 'completed'
            if state and state != 'all':
                domain.append(('task_state', '=', state))
            if params.get('client_kra_id'):
                client = request.env['kra.master'].browse(int(params['client_kra_id']))
                if client.exists():
                    kra_ids = client._get_descendant_ids()
                    domain.append(('kra_id', 'in', kra_ids))
            if params.get('project_kra_id'):
                project = request.env['kra.master'].browse(int(params['project_kra_id']))
                if project.exists():
                    kra_ids = project._get_descendant_ids()
                    domain.append(('kra_id', 'in', kra_ids))
            from_date = params.get('from_date')
            to_date = params.get('to_date')
            if from_date:
                domain.append(('completion_date', '>=', from_date + ' 00:00:00'))
            if to_date:
                domain.append(('completion_date', '<=', to_date + ' 23:59:59'))

            kpis = request.env['kra.kpi'].search(domain, order='completion_date desc, id desc')
            result = []
            for k in kpis:
                # Root + project (immediate sub-KRA)
                root = k.kra_id
                while root and root.parent_id:
                    root = root.parent_id
                project = k.kra_id if k.kra_id != root else False
                result.append({
                    'id': k.id,
                    'name': k.name or '',
                    'client_name': root.name if root else '',
                    'project_name': (project.name if project else ''),
                    'task_state': k.task_state or '',
                    'priority': k.priority or '',
                    'delivery_version': k.delivery_version or '',
                    'requirement_version': k.requirement_version or '',
                    'requirement_document_name': k.requirement_document_name or '',
                    'has_requirement_document': bool(k.requirement_document),
                    'updates_document_name': k.updates_document_name or '',
                    'has_updates_document': bool(k.updates_document),
                    'has_signed_certificate': bool(k.signed_certificate),
                    'signed_certificate_name': k.signed_certificate_name or '',
                    'signed_certificate_date': str(k.signed_certificate_date) if k.signed_certificate_date else '',
                    'developer_ids': k.developer_ids.ids,
                    'tester_ids': k.tester_ids.ids,
                    'coordinator_ids': k.coordinator_ids.ids,
                    'lead_ids': k.lead_ids.ids,
                    'actual_hours': round((k.timer_total_seconds or 0) / 3600.0, 2),
                    'primary_assignee': k.user_id.name if k.user_id else '',
                    'completion_date': k.completion_date.strftime('%Y-%m-%d') if k.completion_date else '',
                })
            return {'status': True, 'kpis': result}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"list_kpis_for_certificate: {str(e)}")
            return {'status': False, 'message': str(e), 'kpis': []}

    @http.route('/kpi_completion_cert/pdf_data', type='json', auth='user', methods=['POST'], csrf=False)
    def get_certificate_pdf_data(self, **params):
        """Return data for the completion certificate PDF (one KPI)."""
        try:
            kpi = request.env['kra.kpi'].browse(int(params['kpi_id']))
            if not kpi.exists():
                return {'status': False, 'message': 'KPI not found.'}
            return {'status': True, 'data': kpi.get_completion_certificate_data()}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"get_certificate_pdf_data: {str(e)}")
            return {'status': False, 'message': str(e)}

    # ============================================================
    #            ADMIN — CLIENT TASK QUEUE (pre-publish review)
    # ============================================================

    @http.route('/kpi_pending_queue/list', type='json', auth='user', methods=['POST'], csrf=False)
    def list_pending_queue(self, **params):
        """Admin view: the Client Task Queue — unpublished tasks awaiting a developer.

        Lists every client submission (client_submitted=True), plus any unpublished
        task that still has NO developer — which is what admin intake
        (/kpi_requirements/create_bulk_tasks) creates when no developer is picked.
        Those used to be listed nowhere: unpublished, so hidden from every board,
        and not client_submitted, so hidden from here too. They are matched on
        user_id=False rather than by flagging them client_submitted, because that
        flag also makes the submitter THE pre-approval approver and arms the
        auto-approve and queue-nudge paths, which must stay client-only. The
        WhatsApp queue (_list_client_queue) already uses the same unassigned rule.
        """
        # Every client's unpublished submissions, read under sudo(). The
        # update / publish / delete routes of this queue check the role; this
        # one did not, so any signed-in client could read the others' queue.
        if not self._is_owner_admin():
            return {'status': False, 'message': 'Not authorized.'}
        try:
            kpis = request.env['kra.kpi'].sudo().search(
                [('published', '=', False), ('active', '=', True),
                 '|', ('client_submitted', '=', True), ('user_id', '=', False)],
                order='create_date desc')
            result = []
            req_cache = {}

            def _req_options_for(root_kra, current_ref):
                """Existing REQ-xxx tasks in this client's subtree — for the Linked Req dropdown."""
                if not root_kra:
                    opts = []
                else:
                    if root_kra.id not in req_cache:
                        desc_ids = root_kra._get_descendant_ids()
                        reqs = request.env['kra.kpi'].sudo().search([
                            ('kra_id', 'in', desc_ids),
                            ('external_ref', 'ilike', 'REQ%'),
                            ('active', '=', True),
                        ], order='external_ref')
                        req_cache[root_kra.id] = [
                            {'ref': r.external_ref, 'name': r.name or ''}
                            for r in reqs if r.external_ref]
                    opts = list(req_cache[root_kra.id])
                cur = (current_ref or '').strip()
                if cur and not any(o['ref'] == cur for o in opts):
                    # keep an unknown existing value selectable so we never drop data
                    opts = [{'ref': cur, 'name': '(current — not a known REQ)'}] + opts
                return [{'ref': o['ref'],
                         'label': o['ref'] + (' — ' + o['name'][:34] if o['name'] else '')}
                        for o in opts]

            for k in kpis:
                root = k.kra_id
                while root and root.parent_id:
                    root = root.parent_id
                project = k.kra_id if k.kra_id != root else False
                nm = k.name or ''
                ref = (k.external_ref or '').upper()
                if nm.startswith('[Update]') or ref.startswith(('UPT', 'UPD')):
                    kind = 'update'
                elif nm.startswith('[Bug]') or ref.startswith('BUG'):
                    kind = 'bug'
                else:
                    kind = 'requirement'
                result.append({
                    'id': k.id,
                    'name': k.name or '',
                    'kind': kind,
                    'client_name': root.name if root else '',
                    'project_name': project.name if project else '',
                    'project_id': project.id if project else (root.id if root else False),
                    'external_ref': k.external_ref or '',
                    'related_req_ref': k.related_req_ref or '',
                    'priority': k.priority or 'regular',
                    'deliverable_type': k.deliverable_type or '',
                    'deliverable_other': k.deliverable_other or '',
                    'deliverable_label': deliverable_type_label(k.deliverable_type, k.deliverable_other),
                    'description': k.description or '',
                    'estimate_hours': k.estimate_hours or 0,
                    'estimate_minutes': k.estimate_minutes or 0,
                    'user_id': k.user_id.id if k.user_id else False,
                    'user_name': k.user_id.name if k.user_id else '',
                    'submitted_by': k.submitted_by_uid.name if k.submitted_by_uid else (
                        k.create_uid.name if k.create_uid else 'Unknown'),
                    'submitted_login': k.submitted_by_uid.login if k.submitted_by_uid else (
                        k.create_uid.login if k.create_uid else ''),
                    'received_at': k.create_date.strftime('%Y-%m-%d %H:%M') if k.create_date else '',
                    'req_options': _req_options_for(root, k.related_req_ref),
                    # Came BACK to the queue because the client rejected the
                    # developer we assigned. Without this the card looks identical
                    # to a fresh submission and the admin can't see why it returned.
                    # 'rework' + decision 'reject' is exactly the state
                    # _return_to_queue_after_reject leaves behind.
                    # (The previous developer isn't shown: that flow clears user_id
                    # by design — the notification names them, the card can't.)
                    'rejected': (k.task_state == 'rework'
                                 and k.pre_approval_decision == 'reject'),
                    'reject_reason': k.pre_approval_feedback or '',
                    'rejected_by': k.pre_approval_decided_by_name or '',
                    'rejected_at': (k.pre_approval_decided_at.strftime('%Y-%m-%d %H:%M')
                                    if k.pre_approval_decided_at else ''),
                    # Photos / video the submitter attached, each with their reason
                    # (kpi.user.manual.description). Metadata only — never the file
                    # bytes, or a queue with videos in it would be unusable.
                    'attachments': [{
                        'id': m.id,
                        'file_name': m.file_name or 'file',
                        'reason': m.description or '',
                    } for m in k.user_manual_ids],
                })
            return {'status': True, 'queue': result}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"list_pending_queue: {str(e)}")
            return {'status': False, 'message': str(e), 'queue': []}

    @http.route('/kpi_pending_queue/update', type='json', auth='user', methods=['POST'], csrf=False)
    def update_pending_kpi(self, **params):
        """Admin updates editable fields on a pending KPI before publishing."""
        try:
            if not (request.env.user.has_group('kra_kpi_module.group_kra_admin')
                    or request.env.user.has_group('base.group_system')):
                return {'status': False, 'message': 'Admin only.'}
            kpi = request.env['kra.kpi'].sudo().browse(int(params['kpi_id']))
            if not kpi.exists() or kpi.published:
                return {'status': False, 'message': 'Pending task not found.'}
            updates = {}
            for fld in ('name', 'description', 'external_ref', 'related_req_ref', 'priority'):
                if fld in params:
                    updates[fld] = params[fld] or ''
            if 'estimate_hours' in params:
                updates['estimate_hours'] = int(params['estimate_hours'] or 0)
            if 'estimate_minutes' in params:
                updates['estimate_minutes'] = int(params['estimate_minutes'] or 0)
            if 'user_id' in params:
                updates['user_id'] = int(params['user_id']) if params['user_id'] else False
            if 'deliverable_type' in params:
                dv, err = clean_deliverable(params['deliverable_type'], params.get('deliverable_other'))
                if err:
                    return {'status': False, 'message': err}
                updates.update(dv)
            if updates:
                kpi.write(updates)
            return {'status': True}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"update_pending_kpi: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_pending_queue/publish', type='json', auth='user', methods=['POST'], csrf=False)
    def publish_pending_kpi(self, **params):
        """Admin publishes a pending KPI — sets published=True so it becomes visible to devs.

        Idempotent: if the row was already auto-published by a write override
        (e.g. because the coordinator just assigned a developer, which fires the
        pre-approval pipeline and flips published=True), we still return success.
        """
        try:
            if not (request.env.user.has_group('kra_kpi_module.group_kra_admin')
                    or request.env.user.has_group('base.group_system')):
                return {'status': False, 'message': 'Admin only.'}
            kpi = request.env['kra.kpi'].sudo().browse(int(params['kpi_id']))
            if not kpi.exists():
                return {'status': False, 'message': 'Task not found.'}
            # A developer is MANDATORY before publishing: the client's pre-approval
            # asks them to sign off on WHO the task went to, so there has to be a
            # developer to name.
            if not kpi.user_id:
                return {'status': False,
                        'message': 'Assign a developer before publishing this task.'}
            if kpi.published:
                # Already published — either by an earlier publish OR by the
                # write() override after a developer assignment.  Treat as a
                # no-op success so the UI doesn't show a confusing error.
                msg = (f'Already published: {kpi.name}'
                       + (' — client pre-approval triggered.'
                          if kpi.task_state == 'pre_approval_pending' else ''))
                return {'status': True, 'message': msg}
            kpi.write({'published': True})
            # Ask the client to approve the assignment.  The client decides in
            # their own time — silence is never treated as consent.  The write()
            # override only fires this when a developer is NEWLY assigned, so a
            # task that ALREADY had a developer would otherwise be published
            # without ever asking the client.
            #
            # admin_accepted is required: publishing must not leapfrog the admin
            # gate, which is the first step of the workflow.
            msg = f'Published: {kpi.name}'
            if kpi.task_state in ('assigned', 'queue_waiting') and not kpi.admin_accepted:
                # Say WHEN, not just that it is waiting — acceptance now happens
                # by itself, so "waiting for admin acceptance" alone would read
                # as "go find an admin" when in fact nobody needs to do anything.
                msg += ' — the client is asked once the task is accepted'
                if kpi.admin_accept_deadline_at:
                    msg += (' (automatically by %s if no admin acts)'
                            % kpi.admin_accept_deadline_at.strftime('%H:%M'))
                msg += '.'
            elif kpi.task_state in ('assigned', 'queue_waiting'):
                try:
                    kpi.request_client_pre_approval()
                    msg += ' — client pre-approval requested.'
                except Exception as exc:
                    import logging
                    logging.getLogger(__name__).warning(
                        "publish_pending_kpi: pre-approval request failed for %s: %s",
                        kpi.id, exc)
            return {'status': True, 'message': msg}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"publish_pending_kpi: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_task_approval/list', type='json', auth='user', methods=['POST'], csrf=False)
    def task_approval_list(self, **params):
        """Return active tasks split into two groups:
          - approved_started   : client approved (token_used=True) AND task_state
                                 is in_progress / paused / partially_completed / awaiting_client / completed
          - unapproved_started : client hasn't approved yet (token_used=False)
                                 AND task_state IS a "started" state (in_progress / paused / partially_completed / awaiting_client)

        The second list is what the admin acts on — each row gets a manual
        "Send Approval Request" button that re-fires pre_approval_request.
        """
        try:
            if not (request.env.user.has_group('kra_kpi_module.group_kra_admin')
                    or request.env.user.has_group('kra_kpi_module.group_kra_owner')
                    or request.env.user.has_group('base.group_system')):
                return {'status': False, 'message': 'Admin / Owner only.'}
            started_states = ('in_progress', 'paused', 'partially_completed', 'awaiting_client')
            Kpi = request.env['kra.kpi'].sudo()

            approved = Kpi.search([
                ('active', '=', True),
                ('task_state', 'in', started_states + ('completed',)),
                ('approval_token_used', '=', True),
            ], order='write_date desc', limit=200)

            unapproved = Kpi.search([
                ('active', '=', True),
                ('task_state', 'in', started_states),
                ('approval_token_used', '=', False),
            ], order='write_date desc', limit=200)

            def _serialize(kpi):
                client_kra = getattr(kpi, 'client_kra_id', False) or kpi.kra_id
                clients = client_kra._effective_client_users() if client_kra else False
                notified = kpi.pre_approval_notified_user_ids
                pending = clients.filtered(lambda u: u.id not in notified.ids) if clients else False
                current_client = notified[-1:] if notified else (clients[:1] if clients else False)
                next_client = pending[:1] if pending else False
                return {
                    'id':                kpi.id,
                    'external_ref':      kpi.external_ref or '',
                    'name':              kpi.name or '',
                    'task_state':        kpi.task_state,
                    'kra_name':          kpi.kra_id.name if kpi.kra_id else '',
                    'client_name':       client_kra.name if client_kra else '',
                    'developer':         kpi.user_id.name if kpi.user_id else '(unassigned)',
                    'current_client':    (current_client[0].name if current_client else ''),
                    'current_client_login': (current_client[0].login if current_client else ''),
                    'next_client':       (next_client[0].name if next_client else ''),
                    'notified_count':    len(notified),
                    'total_clients':     len(clients) if clients else 0,
                    'next_check_at':     kpi.pre_approval_next_check_at and kpi.pre_approval_next_check_at.isoformat() or '',
                    'approval_token_used': kpi.approval_token_used,
                    'approval_date':     kpi.approval_date and kpi.approval_date.isoformat() or '',
                    'decided_by':        kpi.pre_approval_decided_by_name or '',
                }

            return {
                'status': True,
                'approved_started':   [_serialize(k) for k in approved],
                'unapproved_started': [_serialize(k) for k in unapproved],
            }
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"task_approval_list: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_task_approval/get_available_clients', type='json', auth='user', methods=['POST'], csrf=False)
    def task_approval_get_available_clients(self, **params):
        """List every user in group_kra_client so admin can pick who to
        assign to a KRA that currently has no client set."""
        try:
            if not (request.env.user.has_group('kra_kpi_module.group_kra_admin')
                    or request.env.user.has_group('kra_kpi_module.group_kra_owner')
                    or request.env.user.has_group('base.group_system')):
                return {'status': False, 'message': 'Admin / Owner only.'}
            grp = request.env.ref('kra_kpi_module.group_kra_client', raise_if_not_found=False)
            users = grp.user_ids if grp else request.env['res.users']
            out = []
            for u in users.sorted('name'):
                p = u.partner_id
                out.append({
                    'id':    u.id,
                    'name':  u.name,
                    'login': u.login,
                    'phone': (p and (getattr(p, 'mobile', None) or p.phone) or ''),
                })
            return {'status': True, 'clients': out}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"task_approval_get_available_clients: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_task_approval/set_kra_clients', type='json', auth='user', methods=['POST'], csrf=False)
    def task_approval_set_kra_clients(self, **params):
        """Assign a set of client users to the KRA that owns this KPI so the
        pre_approval_request can resolve to real recipients.  Also clears the
        task's notified state so the next send starts from client #1."""
        try:
            if not (request.env.user.has_group('kra_kpi_module.group_kra_admin')
                    or request.env.user.has_group('kra_kpi_module.group_kra_owner')
                    or request.env.user.has_group('base.group_system')):
                return {'status': False, 'message': 'Admin / Owner only.'}
            kpi = request.env['kra.kpi'].sudo().browse(int(params['kpi_id']))
            if not kpi.exists():
                return {'status': False, 'message': 'Task not found.'}
            client_kra = getattr(kpi, 'client_kra_id', False) or kpi.kra_id
            if not client_kra:
                return {'status': False, 'message': 'Task has no KRA.'}
            user_ids = [int(x) for x in (params.get('client_user_ids') or [])]
            if not user_ids:
                return {'status': False, 'message': 'Pick at least one client.'}
            client_kra.sudo().write({
                'client_user_ids': [(6, 0, user_ids)],
            })
            # Reset the task's escalation state so next send starts from client #1.
            kpi.sudo().write({
                'pre_approval_notified_user_ids': [(5, 0, 0)],
                'pre_approval_next_check_at': False,
            })
            kpi._log_action('kra_clients_assigned', source='web',
                            actor_user_id=request.env.user.id,
                            payload={'kra_id': client_kra.id,
                                     'client_user_ids': user_ids})
            return {'status': True,
                    'message': f'Assigned {len(user_ids)} client(s) to {client_kra.name}.'}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"task_approval_set_kra_clients: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_task_approval/resend', type='json', auth='user', methods=['POST'], csrf=False)
    def task_approval_resend(self, **params):
        """Admin manually fires pre_approval_request on a task where the dev
        has already started but the client hasn't decided yet.  Advances the
        sequential escalation to the next non-notified client (or wraps back
        to the first if all clients have been tried).
        """
        try:
            if not (request.env.user.has_group('kra_kpi_module.group_kra_admin')
                    or request.env.user.has_group('kra_kpi_module.group_kra_owner')
                    or request.env.user.has_group('base.group_system')):
                return {'status': False, 'message': 'Admin / Owner only.'}
            kpi = request.env['kra.kpi'].sudo().browse(int(params['kpi_id']))
            if not kpi.exists():
                return {'status': False, 'message': 'Task not found.'}
            if kpi.approval_token_used:
                return {'status': False, 'message': 'Token already used (client has decided).'}
            client_kra = getattr(kpi, 'client_kra_id', False) or kpi.kra_id
            clients = client_kra._effective_client_users() if client_kra else False
            if not clients:
                return {'status': False,
                        'message': 'No client users on this KRA — cannot send.'}
            wrap_flag = params.get('wrap_around', True)
            notified_ids = set(kpi.pre_approval_notified_user_ids.ids)
            pending = clients.filtered(lambda u: u.id not in notified_ids)
            if not pending and wrap_flag:
                # All clients exhausted — wrap: clear notified so next _notify picks
                # client #1 again.  Admin-initiated resend restarts the cycle.
                kpi.write({
                    'pre_approval_notified_user_ids': [(5, 0, 0)],
                    'pre_approval_next_check_at': False,
                })
            target_before = kpi.pre_approval_notified_user_ids
            try:
                kpi._notify('pre_approval_request')
            except Exception as exc:
                kpi._log_action(
                    'notification_failed', success=False,
                    payload={'event': 'pre_approval_request_manual_resend', 'error': str(exc)})
                return {'status': False, 'message': f'Notify raised: {exc}'}
            target_after = kpi.pre_approval_notified_user_ids
            picked = (target_after - target_before)
            picked_name = picked[0].name if picked else (target_after and target_after[-1].name or '?')
            kpi._log_action('pre_approval_manual_resend', source='web',
                            actor_user_id=request.env.user.id,
                            payload={'to': picked_name,
                                     'task_state': kpi.task_state,
                                     'notified_count': len(target_after)})
            return {'status': True,
                    'message': f'Sent to {picked_name}.',
                    'picked': picked_name}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"task_approval_resend: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_pending_queue/resend_pre_approval', type='json', auth='user', methods=['POST'], csrf=False)
    def resend_pre_approval(self, **params):
        """Re-fire the pre-approval notification for a task that's already in
        `pre_approval_pending` state.  Useful when the original WhatsApp send
        failed (e.g. session was reconnecting) and we want to retry without
        having to re-assign the developer.
        """
        try:
            if not (request.env.user.has_group('kra_kpi_module.group_kra_admin')
                    or request.env.user.has_group('base.group_system')):
                return {'status': False, 'message': 'Admin only.'}
            kpi = request.env['kra.kpi'].sudo().browse(int(params['kpi_id']))
            if not kpi.exists():
                return {'status': False, 'message': 'Task not found.'}
            # Allow resend on either pending OR partial state.  In partial state
            # we fire BOTH events so the client gets another chance to approve
            # AND the developer/owner get the prep-mode reminder.
            if kpi.task_state == 'pre_approval_pending':
                events = ['pre_approval_request']
            elif kpi.task_state == 'pre_approval_partial':
                events = ['pre_approval_request', 'partial_timeout']
            else:
                return {'status': False,
                        'message': f'Task is in state {kpi.task_state} — '
                                   'resend only available for pre_approval_pending / pre_approval_partial.'}
            if kpi.approval_token_used:
                return {'status': False, 'message': 'Token already used (client has decided).'}
            # Admin-triggered resend restarts sequential client escalation from
            # the first client.  Clear the notified set + next-check so the
            # next pre_approval_request picks client #1 again.
            kpi.sudo().write({
                'pre_approval_notified_user_ids': [(5, 0, 0)],
                'pre_approval_next_check_at': False,
            })
            kpi._log_action('pre_approval_resent', source='web',
                            actor_user_id=request.env.user.id,
                            payload={'events': events, 'state': kpi.task_state})
            for event in events:
                try:
                    kpi._notify(event)
                except Exception as exc:
                    kpi._log_action(
                        'notification_failed', success=False,
                        payload={'event': f'{event}_resend', 'error': str(exc)})
            return {'status': True,
                    'message': f'Re-sent ({", ".join(events)}) for {kpi.name}.'}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"resend_pre_approval: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_pending_queue/delete', type='json', auth='user', methods=['POST'], csrf=False)
    def delete_pending_kpi(self, **params):
        """Admin discards a pending KPI (rejected submission)."""
        try:
            if not (request.env.user.has_group('kra_kpi_module.group_kra_admin')
                    or request.env.user.has_group('base.group_system')):
                return {'status': False, 'message': 'Admin only.'}
            kpi = request.env['kra.kpi'].sudo().browse(int(params['kpi_id']))
            if not kpi.exists() or kpi.published:
                return {'status': False, 'message': 'Pending task not found (or already published).'}
            # Tell the client their submission was dropped — otherwise it just
            # silently disappears from their list with no explanation.
            #
            # The row is created with kpi_id=False ON PURPOSE: kpi.notification.kpi_id
            # is ondelete='cascade', so a notification pointing at this task would be
            # deleted along with it by the unlink() below and the client would never
            # see it. Detached also means it isn't tappable — correct, since the task
            # is gone. Never blocks the discard.
            try:
                if kpi.client_submitted and kpi.submitted_by_uid:
                    reason = (params.get('reason') or '').strip()
                    body = ("🗑 Your submitted task was not taken forward.\n"
                            "📌 %s\n" % (kpi.name or ''))
                    if reason:
                        body += "💬 Reason: %s\n" % reason
                    body += "Contact your coordinator if you think this is a mistake."
                    request.env['kpi.notification'].sudo().create({
                        'user_id': kpi.submitted_by_uid.id,
                        'kpi_id': False,
                        'event': 'client_task_discarded',
                        'role': 'client',
                        'title': 'Task discarded',
                        'body': body,
                    })
                    # Push is an HTTP call, not a DB row, so it survives the unlink.
                    kpi._send_push('client_task_discarded', 'Task discarded', body,
                                   [kpi.submitted_by_uid.id])
            except Exception as exc:
                import logging
                logging.getLogger(__name__).warning(
                    "discard notify failed for kpi %s: %s", kpi.id, exc)
            kpi.unlink()
            return {'status': True}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"delete_pending_kpi: {str(e)}")
            return {'status': False, 'message': str(e)}

    # ============================================================
    #            CLIENT PORTAL — DASHBOARD + ADD TASK
    # ============================================================

    def _resolve_client_kras_for_user(self):
        """Return the recordset of root KRAs the current user has client-portal access to."""
        return request.env['kra.master'].sudo().search([
            ('client_user_ids', 'in', [request.env.user.id]),
        ])

    def _is_current_user_client_only(self):
        """True if the current user is a Client (no admin/system rights)."""
        user = request.env.user
        if user.has_group('kra_kpi_module.group_kra_admin') or user.has_group('base.group_system'):
            return False
        return user.has_group('kra_kpi_module.group_kra_client')

    @http.route('/kpi_client_portal/dashboard', type='json', auth='user', methods=['POST'], csrf=False)
    def client_portal_dashboard(self, **params):
        """Return a dashboard payload for the logged-in client user:
          - their client KRAs + projects
          - all KPIs (with status filter)
          - pending approvals (partially_completed) — call-out
          - completed KPIs with signed cert (downloadable cert)
          - finalized invoices count
        """
        try:
            user = request.env.user
            client_kras = self._resolve_client_kras_for_user()
            if not client_kras:
                return {
                    'status': True,
                    'authorized': False,
                    'message': 'Your user is not linked to any client. Please contact your admin.',
                    'clients': [], 'kpis': [], 'pending_approvals': [], 'totals': {},
                }
            kra_ids = set()
            for k in client_kras:
                kra_ids.update(k._get_descendant_ids())
            kra_ids = list(kra_ids)

            state_filter = params.get('state') or ''
            # Only show the client tasks an admin has ACCEPTED into the official flow.
            # A freshly-created / self-created task (admin_accepted=False) must not
            # reach the client until an admin accepts it — matches the workflow rule.
            domain = [('kra_id', 'in', kra_ids), ('active', '=', True), ('admin_accepted', '=', True)]
            if state_filter and state_filter != 'all':
                domain.append(('task_state', '=', state_filter))

            kpis = request.env['kra.kpi'].sudo().search(domain, order='create_date desc, id desc')

            def _kpi_summary(k):
                root = k.kra_id
                while root and root.parent_id:
                    root = root.parent_id
                project = k.kra_id if k.kra_id != root else False
                kind = 'requirement'
                nm = k.name or ''
                ref = (k.external_ref or '').upper()
                if nm.startswith('[Update]') or ref.startswith(('UPT', 'UPD')):
                    kind = 'update'
                elif nm.startswith('[Bug]') or ref.startswith('BUG'):
                    kind = 'bug'
                return {
                    'id': k.id,
                    'name': k.name or '',
                    # What was actually asked for. The client could previously only
                    # see a description inside the pre-approval / completion modals,
                    # so their own task list showed a bare title and nothing else.
                    'description': k.description or '',
                    'kind': kind,
                    'external_ref': k.external_ref or '',
                    'related_req_ref': k.related_req_ref or '',
                    'client_name': root.name if root else '',
                    'project_id': project.id if project else (k.kra_id.id if k.kra_id else 0),
                    'project_name': project.name if project else '',
                    'task_state': k.task_state or '',
                    'priority': k.priority or '',
                    'delivery_version': k.delivery_version or '',
                    'estimate_hours': round(((k.estimate_hours or 0) + (k.estimate_minutes or 0) / 60.0), 2),
                    'actual_hours': round((k.timer_total_seconds or 0) / 3600.0, 2),
                    'deadline': str(k.deadline) if k.deadline else '',
                    'completion_date': k.completion_date.strftime('%Y-%m-%d') if k.completion_date else '',
                    'has_signed_certificate': bool(k.signed_certificate),
                    'client_signed': bool(k.client_signature_text),
                    'primary_assignee_id': k.user_id.id if k.user_id else 0,
                    'primary_assignee': k.user_id.name if k.user_id else '',
                }

            all_summaries = [_kpi_summary(k) for k in kpis]

            # Pending approvals: tasks that admin has QA-approved (state='awaiting_client').
            # Also include legacy 'partially_completed' rows where admin_approved=True (back-compat).
            pending_kpis = request.env['kra.kpi'].sudo().search([
                ('kra_id', 'in', kra_ids),
                ('active', '=', True),
                '|',
                ('task_state', '=', 'awaiting_client'),
                '&', ('task_state', '=', 'partially_completed'), ('admin_approved', '=', True),
            ], order='completion_date desc')
            pending = [_kpi_summary(k) for k in pending_kpis]

            # Totals (across all admin-accepted tasks — un-accepted ones are hidden
            # from the client everywhere, same as the list above).
            all_active = request.env['kra.kpi'].sudo().search(
                [('kra_id', 'in', kra_ids), ('active', '=', True), ('admin_accepted', '=', True)])

            def _kind_of(k):
                nm = k.name or ''
                ref = (k.external_ref or '').upper()
                if nm.startswith('[Update]') or ref.startswith(('UPT', 'UPD')):
                    return 'update'
                if nm.startswith('[Bug]') or ref.startswith('BUG'):
                    return 'bug'
                return 'requirement'

            totals = {
                'all': len(all_active),
                'assigned': len(all_active.filtered(lambda k: k.task_state == 'assigned')),
                'in_progress': len(all_active.filtered(lambda k: k.task_state == 'in_progress')),
                'paused': len(all_active.filtered(lambda k: k.task_state == 'paused')),
                'partially_completed': len(all_active.filtered(lambda k: k.task_state == 'partially_completed')),
                'completed': len(all_active.filtered(lambda k: k.task_state == 'completed')),
            }

            # Per-type breakdown (req/update/bug × open/done) + time totals
            by_type = {
                'requirement': {'total': 0, 'done': 0, 'open': 0, 'hours': 0.0},
                'update':      {'total': 0, 'done': 0, 'open': 0, 'hours': 0.0},
                'bug':         {'total': 0, 'done': 0, 'open': 0, 'hours': 0.0},
            }
            for k in all_active:
                kind = _kind_of(k)
                bucket = by_type[kind]
                bucket['total'] += 1
                if k.task_state == 'completed':
                    bucket['done'] += 1
                else:
                    bucket['open'] += 1
                bucket['hours'] += (k.timer_total_seconds or 0) / 3600.0
            for kind in by_type:
                by_type[kind]['hours'] = round(by_type[kind]['hours'], 2)

            # Invoices
            invs = request.env['kpi.client.invoice'].sudo().search([
                ('client_kra_id', 'in', client_kras.ids),
                ('state', 'in', ['finalized', 'sent']),
            ])
            invoice_count = len(invs)

            return {
                'status': True,
                'authorized': True,
                'clients': [{'id': c.id, 'name': c.name} for c in client_kras],
                'kpis': all_summaries,
                'pending_approvals': pending,
                'totals': totals,
                'by_type': by_type,
                'invoice_count': invoice_count,
                'state_filter': state_filter or 'all',
            }
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"client_portal_dashboard: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_portal/get_projects', type='json', auth='user', methods=['POST'], csrf=False)
    def client_portal_get_projects(self, **params):
        """List projects (sub-KRAs) under the client user's KRAs — used by 'New Task' form."""
        try:
            user_kras = self._resolve_client_kras_for_user()
            kra_ids = set()
            for k in user_kras:
                kra_ids.update(k._get_descendant_ids())
            kras = request.env['kra.master'].sudo().browse(list(kra_ids))
            result = []
            for k in kras:
                path = []
                cur = k
                while cur:
                    path.insert(0, cur.name)
                    cur = cur.parent_id
                result.append({'id': k.id, 'display': ' > '.join(path)})
            result.sort(key=lambda d: d['display'])
            return {'status': True, 'projects': result}
        except Exception as e:
            return {'status': False, 'message': str(e), 'projects': []}

    # Total decoded size of the files a client may attach to one new task.
    CLIENT_TASK_FILES_MAX_BYTES = 25 * 1024 * 1024

    def _client_task_files(self, raw):
        """Validate add_task's `attachments` → ([(name, bytes, mimetype)], error).

        Each entry is {name, data_b64, mimetype}; file_name / file_data are
        accepted too, the keys the other upload routes use. A data: URL prefix is
        stripped. The 25 MB cap is on the decoded total, not per file.
        """
        import base64
        import binascii
        if not raw:
            return [], None
        if not isinstance(raw, list):
            return [], 'Attachments must be a list.'
        out, total = [], 0
        for entry in raw:
            if not isinstance(entry, dict):
                return [], 'Each attachment needs a name and data.'
            name = (entry.get('name') or entry.get('file_name') or '').strip()
            data_b64 = entry.get('data_b64') or entry.get('file_data') or ''
            if not name or not data_b64:
                return [], 'Each attachment needs a name and data.'
            if isinstance(data_b64, str) and data_b64.startswith('data:') and ',' in data_b64:
                data_b64 = data_b64.split(',', 1)[1]
            try:
                data = base64.b64decode(data_b64, validate=True)
            except (binascii.Error, ValueError, TypeError):
                return [], '"%s" could not be read.' % name
            total += len(data)
            if total > self.CLIENT_TASK_FILES_MAX_BYTES:
                return [], 'Attachments are over the %d MB limit.' % (
                    self.CLIENT_TASK_FILES_MAX_BYTES // (1024 * 1024))
            out.append((name[:255], data, (entry.get('mimetype') or '').strip()[:128]))
        return out, None

    def _attach_client_files(self, kpi, files):
        """Store the client's files on the new task as one progress entry.

        The same storage as a progress upload — first file on the entry itself,
        the rest as kpi.file.attachment rows — so they show wherever a task's
        files already show, with the client as the author.
        """
        import base64
        name, data, mime = files[0]
        progress = request.env['kpi.progress'].sudo().create({
            'kpi_id': kpi.id,
            'user_id': request.env.user.id,
            'summary': 'Attached by the client when submitting this task.',
            'uploaded_file': base64.b64encode(data),
            'file_name': name,
        })
        Att = request.env['kpi.file.attachment'].sudo()
        for seq, (name, data, mime) in enumerate(files[1:], start=2):
            Att.create({
                'progress_id': progress.id,
                'file': base64.b64encode(data),
                'file_name': name,
                'mimetype': mime or False,
                'sequence': seq * 10,
            })
        return progress

    @http.route('/kpi_client_portal/parent_tasks', type='json', auth='user', methods=['POST'], csrf=False)
    def client_portal_parent_tasks(self, sub_kra_id=None, **kw):
        """The requirements a Bug / Update can be about: the client's REQ tasks,
        newest first. With sub_kra_id, only that project's."""
        try:
            allowed_ids = set()
            for k in self._resolve_client_kras_for_user():
                allowed_ids.update(k._get_descendant_ids())
            if sub_kra_id:
                sub = int(sub_kra_id)
                if sub not in allowed_ids:
                    return {'status': False, 'message': 'You are not authorized for this project.'}
                ids = list(request.env['kra.master'].sudo().browse(sub)._get_descendant_ids())
            else:
                ids = list(allowed_ids)
            rows = request.env['kra.kpi'].sudo().search([
                ('kra_id', 'in', ids), ('external_ref', '=ilike', 'REQ-%')],
                order='create_date desc', limit=300)
            return {'status': True, 'tasks': [{
                'id': k.id, 'ref': k.external_ref or '', 'name': k.name or '',
                'date': k.create_date.strftime('%d-%m-%Y') if k.create_date else '',
                'db': k.client_db_id.db_name or '',
            } for k in rows]}
        except Exception as e:
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_portal/add_task', type='json', auth='user', methods=['POST'], csrf=False)
    def client_portal_add_task(self, **params):
        """Allow a client portal user to self-submit a new task under one of their projects.
        Created in 'assigned' state without a user_id — admin will pick that up and reassign.

        Optional: needed_by ('YYYY-MM-DD', today or later) lands on the task's
        `deadline`; attachments ([{name, data_b64, mimetype}], 25 MB in total)
        are stored as a progress entry by the client (see _attach_client_files).
        """
        try:
            sub_kra_id = int(params.get('sub_kra_id') or 0)
            if not sub_kra_id:
                return {'status': False, 'message': 'Please pick a project.'}
            sub_kra = request.env['kra.master'].sudo().browse(sub_kra_id)
            if not sub_kra.exists():
                return {'status': False, 'message': 'Project not found.'}
            # Verify the user is linked to a KRA that contains this sub_kra
            user_kras = self._resolve_client_kras_for_user()
            allowed_ids = set()
            for k in user_kras:
                allowed_ids.update(k._get_descendant_ids())
            if sub_kra_id not in allowed_ids:
                return {'status': False, 'message': 'You are not authorized for this project.'}
            kind = params.get('kind') or 'requirement'
            name_prefix = {'requirement': '', 'update': '[Update] ', 'bug': '[Bug] '}.get(kind, '')
            raw_name = (params.get('name') or '').strip()
            if not raw_name:
                return {'status': False, 'message': 'Task name required.'}
            # Bug / Update: always about ONE of the client's requirements, and
            # numbered under it (BUG001-REQ-012), like the WhatsApp form.
            parent = None
            if kind in ('bug', 'update'):
                try:
                    parent = request.env['kra.kpi'].sudo().browse(
                        int(params.get('parent_id') or 0)).exists()
                except (TypeError, ValueError):
                    parent = None
                if (not parent or parent.kra_id.id not in allowed_ids
                        or not (parent.external_ref or '').upper().startswith('REQ-')):
                    return {'status': False, 'message': 'Pick the task this bug or update is about.'}
                dv, err = {'deliverable_type': parent.deliverable_type or False,
                           'deliverable_other': parent.deliverable_other or False}, None
            else:
                dv, err = clean_deliverable(params.get('deliverable_type'), params.get('deliverable_other'))
            if err:
                return {'status': False, 'message': err}
            needed_by = False
            if params.get('needed_by'):
                try:
                    needed_by = fields.Date.to_date(params['needed_by'])
                except (TypeError, ValueError):
                    return {'status': False, 'message': 'Needed-by date is not a valid date.'}
                if needed_by and needed_by < fields.Date.context_today(request.env.user):
                    return {'status': False, 'message': 'Needed-by date cannot be in the past.'}
            files, err = self._client_task_files(params.get('attachments'))
            if err:
                return {'status': False, 'message': err}
            vals = {
                'name': name_prefix + raw_name,
                'kra_id': sub_kra_id,
                'task_state': 'assigned',
                'priority': params.get('priority') or 'regular',
                'description': params.get('description') or '',
                'external_ref': params.get('external_ref') or '',
                'related_req_ref': params.get('related_req_ref') or '',
                'active': True,
                # Client-submitted tasks land in admin's pending queue, unpublished.
                'published': False,
                'submitted_by_uid': request.env.user.id,
                # This route is the client portal — always a client submission.
                'client_submitted': True,
            }
            if dv['deliverable_type']:
                vals.update(dv)
            if needed_by:
                vals['deadline'] = needed_by
            if parent:
                from ..models.kpi_workflow import REF_PREFIX_FOR_DOC_TYPE
                prefix = REF_PREFIX_FOR_DOC_TYPE[kind]
                Kpi = request.env['kra.kpi'].sudo()
                vals.update({
                    'kra_id': parent.kra_id.id,
                    'external_ref': '%s%03d-%s' % (
                        prefix, Kpi._next_child_number(prefix, parent.external_ref),
                        parent.external_ref),
                    'related_req_ref': parent.external_ref,
                    'client_db_id': parent.client_db_id.id or False,
                })
            kpi = request.env['kra.kpi'].sudo().create(vals)
            if files:
                self._attach_client_files(kpi, files)
            # Tell the admins a client task is queued (re-nudged while unread).
            try:
                kpi._notify('client_task_queued', attachments_line=(
                    '\n📎 %d file%s: %s' % (len(files), '' if len(files) == 1 else 's',
                                           ', '.join(f[0] for f in files))
                    if files else ''))
                kpi._schedule_queue_nudge()
                # And the private decision links (approval chain), sent after
                # the commit in the background: WhatsApp sends are slow.
                kpi._after_commit_in_background('_wa_ask_admins')
            except Exception as exc:
                import logging
                logging.getLogger(__name__).warning(
                    "client_task_queued notify failed for kpi %s: %s", kpi.id, exc)
            return {'status': True, 'kpi_id': kpi.id, 'name': kpi.name,
                    'needed_by': fields.Date.to_string(needed_by) if needed_by else '',
                    'attachment_count': len(files)}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"client_portal_add_task: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_portal/download_cert', type='http', auth='user')
    def client_portal_download_cert(self, kpi_id=None, **kw):
        """Stream the signed certificate file (if any) for a KPI in the client's scope."""
        import base64
        try:
            if not kpi_id:
                return request.not_found()
            kpi = request.env['kra.kpi'].sudo().browse(int(kpi_id))
            if not kpi.exists() or not kpi.signed_certificate:
                return request.not_found()
            # Check the user has portal access to this KPI's client KRA
            user_kras = self._resolve_client_kras_for_user()
            kra_ids = set()
            for k in user_kras:
                kra_ids.update(k._get_descendant_ids())
            if kpi.kra_id.id not in kra_ids:
                return request.not_found()
            data = base64.b64decode(kpi.signed_certificate)
            fname = kpi.signed_certificate_name or f'signed_cert_{kpi.id}.pdf'
            data, fname, mime = self._certificate_payload(kpi, data, fname)
            return request.make_response(data, headers=[
                ('Content-Type', mime),
                ('Content-Disposition', f'attachment; filename="{fname}"'),
            ])
        except Exception:
            return request.not_found()

    def _certificate_payload(self, kpi, blob, fname):
        """(bytes, filename, mimetype) for a stored certificate.

        A PDF or an image is served untouched — that is either an admin-uploaded scan
        or a certificate generated at sign-off, and it is the artifact the client
        actually signed. Rewriting it would be rewriting evidence.

        The legacy plain-text receipt is re-rendered as a branded PDF on the fly. That
        turns every certificate issued before this change into a proper document with
        no migration and without overwriting a single stored row. If rendering fails
        for any reason, the original text is served rather than nothing.
        """
        low = (fname or '').lower()
        if low.endswith(('.pdf', '.png', '.jpg', '.jpeg')):
            mime = 'application/pdf' if low.endswith('.pdf') else 'image/png'
            return blob, fname, mime
        try:
            pdf = self._build_certificate_pdf(kpi.get_completion_certificate_data())
            return pdf, f'completion_certificate_{kpi.id}.pdf', 'application/pdf'
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning(
                "certificate render failed for kpi %s, serving the stored receipt: %s", kpi.id, e)
            return blob, fname, 'text/plain'

    # ============================================================
    #            CURRENT USER — ROLE FLAGS
    # ============================================================

    @http.route('/kpi_user/info', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_user_info(self, **params):
        """Return the current user's role flags so the OWL UI can adapt
        (e.g. hide developer/time fields from client-only users)."""
        try:
            user = request.env.user
            is_system = user.has_group('base.group_system')
            is_owner = user.has_group('kra_kpi_module.group_kra_owner')
            is_admin = user.has_group('kra_kpi_module.group_kra_admin')
            is_developer = user.has_group('kra_kpi_module.group_kra_developer')
            is_client = user.has_group('kra_kpi_module.group_kra_client')
            # "client-only" = client and NOT admin (since admin implies dev, owner implies admin)
            is_client_only = is_client and not (is_admin or is_system or is_owner)
            return {
                'status': True,
                'user_id': user.id,
                'name': user.name or '',
                'login': user.login or '',
                'is_system': is_system,
                'is_owner': is_owner,
                'is_admin': is_admin,
                'is_developer': is_developer,
                'allow_multitask': user.kpi_allow_multitask,
                'is_client': is_client,
                'is_client_only': is_client_only,
                # THE KRA/KPI role — 'admin' | 'client' | 'developer' — the single
                # value shown in Login Management's role dropdown
                # (res.users.kpi_role / _compute_kpi_role). Prefer this over the
                # boolean flags above: one field, same answer everywhere, and it
                # can't drift the way a hand-rolled combination of flags can.
                # NB: the selection's third value is 'developer' (shown as "User"
                # in the UI) — not 'user'.
                # A coordinator reports as 'admin' here: the apps gate every
                # admin screen on kpi_role == 'admin', and a coordinator has
                # always had those screens. 'coordinator' is a Login
                # Management / user-form distinction only.
                'kpi_role': ('admin' if user.kpi_role == 'coordinator'
                             else user.kpi_role or 'developer'),
                # True while the app password is still the default 1111 (admin reset
                # / freshly created) — drives the red "change your password" nag on
                # Profile until they set their own via Forgot Password.
                'must_change': bool(user.kpi_app_must_change_password),
            }
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"kpi_user_info: {str(e)}")
            return {'status': False, 'message': str(e)}

    # ============================================================
    #            OWNER DASHBOARD — CLIENT-WISE BILLABLE
    # ============================================================

    @http.route('/kpi_owner/certified_by_client', type='json', auth='user', methods=['POST'], csrf=False)
    def owner_certified_by_client(self, **params):
        """Return per-client summary of signed-off (completed) tasks: count + hours + last
        invoice. Used by the Owner Dashboard to decide what to invoice next."""
        # Every client's name, hours and last invoice: the Owner Dashboard's
        # view, so the owner's route. The app only HID the tile from others.
        if not self._is_owner_admin():
            return {'status': False, 'message': 'Not authorized.'}
        try:
            Kra = request.env['kra.master'].sudo()
            Kpi = request.env['kra.kpi'].sudo()
            Inv = request.env['kpi.client.invoice'].sudo()

            # Root-level only. is_client is true at BOTH level 1 and level 2, so this
            # used to render every client twice — 45 rows for ~22 clients, the same
            # client showing two different certified counts because each row counted a
            # different subtree. Counting from the root covers all of it (_descendants
            # below walks down), so one row per client is both simpler and correct.
            client_kras = Kra.search(
                [('is_client', '=', True),
                 ('active', '=', True),
                 ('parent_id', '=', False)],
                order='name')

            in_progress_states = ['assigned', 'in_progress', 'paused',
                                  'partially_completed', 'urgent', 'important', 'regular']

            def _descendants(root_id):
                ids = [root_id]
                frontier = [root_id]
                while frontier:
                    children = Kra.search([('parent_id', 'in', frontier)]).ids
                    if not children:
                        break
                    ids.extend(children)
                    frontier = children
                return ids

            def _bucket_counts(kra_ids):
                completed = Kpi.search([
                    ('kra_id', 'in', kra_ids), ('active', '=', True),
                    ('task_state', '=', 'completed'),
                ], order='completion_date desc')
                awaiting = Kpi.search([
                    ('kra_id', 'in', kra_ids), ('active', '=', True),
                    ('task_state', '=', 'awaiting_client'),
                ])
                in_progress = Kpi.search([
                    ('kra_id', 'in', kra_ids), ('active', '=', True),
                    ('task_state', 'in', in_progress_states),
                ])
                total_hours = sum((completed.mapped('timer_total_seconds')) or [0]) / 3600.0
                quoted_hours = sum((completed.mapped('client_quoted')) or [0])
                return {
                    'completed_count': len(completed),
                    'awaiting_client_count': len(awaiting),
                    'in_progress_count': len(in_progress),
                    'total_actual_hours': round(total_hours, 2),
                    'total_quoted_hours': round(quoted_hours, 2),
                }

            result = []
            for client in client_kras:
                kra_ids = _descendants(client.id)
                counts = _bucket_counts(kra_ids)

                # Per-project breakdown: direct children of the client KRA (the "projects").
                projects = []
                direct_children = Kra.search(
                    [('parent_id', '=', client.id), ('active', '=', True)],
                    order='sequence, name',
                )
                for proj in direct_children:
                    proj_ids = _descendants(proj.id)
                    proj_counts = _bucket_counts(proj_ids)
                    projects.append({
                        'project_id': proj.id,
                        'project_name': proj.name or '',
                        **proj_counts,
                    })

                # Most recent invoice for this client
                last_inv = Inv.search([('client_kra_id', '=', client.id)],
                                       order='invoice_date desc, id desc', limit=1)
                # Open invoice (draft) for this client
                open_inv = Inv.search([('client_kra_id', '=', client.id),
                                       ('state', '=', 'draft')], limit=1)

                result.append({
                    'client_id': client.id,
                    'client_name': client.name or '',
                    'parent_name': client.parent_id.name or '',
                    'currency_id': client.currency_id.id if client.currency_id else False,
                    'currency_name': client.currency_id.name if client.currency_id else '',
                    **counts,
                    'projects': projects,
                    'last_invoice_name': last_inv.name if last_inv else '',
                    'last_invoice_date': str(last_inv.invoice_date) if last_inv and last_inv.invoice_date else '',
                    'last_invoice_state': last_inv.state if last_inv else '',
                    'open_invoice_id': open_inv.id if open_inv else False,
                })
            return {'status': True, 'clients': result}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"owner_certified_by_client: {str(e)}")
            return {'status': False, 'message': str(e), 'clients': []}

    @http.route('/kpi_owner/payment_term', type='json', auth='user', methods=['POST'], csrf=False)
    def owner_payment_term(self, **params):
        """Read or set the invoice payment term in days (kra_kpi.payment_term_days,
        default 15): the Dashboard's billing tile shows "due on" = the oldest
        unpaid invoice's date + this. Pass `days` to set it."""
        if not self._is_owner_admin():
            return {'status': False, 'message': 'Not authorized.'}
        P = request.env['ir.config_parameter'].sudo()
        if params.get('days') is not None:
            try:
                days = int(params.get('days'))
            except (TypeError, ValueError):
                return {'status': False, 'message': 'Enter a number of days.'}
            if not 0 <= days <= 365:
                return {'status': False, 'message': 'Between 0 and 365 days.'}
            P.set_param('kra_kpi.payment_term_days', str(days))
        try:
            days = int(P.get_param('kra_kpi.payment_term_days', 15))
        except (TypeError, ValueError):
            days = 15
        return {'status': True, 'days': days}

    def _client_scope(self, params):
        """The client (with every project under it) and the period that both
        Client-details routes work on. None when the client does not exist.
        No dates = "Auto": this month to date. Days are the admin's local days;
        lo/hi are their naive-UTC bounds, hi exclusive."""
        import pytz
        from datetime import datetime as _dt, time as _time, timedelta as _td
        user = request.env.user
        Kra = request.env['kra.master'].sudo()
        client = Kra.browse(int(params.get('client_kra_id') or 0)).exists()
        if not client:
            return None
        tz = pytz.timezone(user.tz or 'Asia/Kolkata')
        today = fields.Date.context_today(user)
        auto = not (params.get('from_date') and params.get('to_date'))
        if auto:
            d_from, d_to = today.replace(day=1), today
        else:
            d_from = fields.Date.from_string(params['from_date'])
            d_to = fields.Date.from_string(params['to_date'])
            if d_to < d_from:
                d_from, d_to = d_to, d_from

        def utc_start(d):
            return tz.localize(_dt.combine(d, _time.min)).astimezone(pytz.UTC).replace(tzinfo=None)
        ids, frontier = [client.id], [client.id]
        while frontier:
            frontier = Kra.search([('parent_id', 'in', frontier)]).ids
            ids.extend(frontier)
        return {'client': client, 'ids': ids, 'lo': utc_start(d_from), 'hi': utc_start(d_to + _td(days=1)),
                'from': d_from, 'to': d_to, 'auto': auto, 'today': today, 'tz': tz}

    @staticmethod
    def _client_domains(ids, lo, hi):
        """What each Client-details tile counts — one definition, so the number
        on a tile and the list in its popup can never disagree."""
        sub = [('kra_id', 'in', ids)]
        return {
            'open': sub + [('task_state', '!=', 'completed')],
            'new': sub + [('published', '=', False), '|', ('client_submitted', '=', True), ('user_id', '=', False)],
            'in_progress': sub + [('task_state', 'in', ('in_progress', 'paused'))],
            'waiting': sub + [('task_state', '=', 'awaiting_client')],
            'certified': sub + [('client_final_approved', '=', True),
                                ('client_signed_datetime', '>=', lo), ('client_signed_datetime', '<', hi)],
        }

    @http.route('/kpi_owner/client_summary_items', type='json', auth='user', methods=['POST'], csrf=False)
    def owner_client_summary_items(self, **params):
        """The rows behind one Client-details tile, for its popup.

        params: client_kra_id, kind (open | in_progress | waiting | certified |
        hours | billing), from_date / to_date as /kpi_owner/client_summary.
        Tasks: ref, name, project, assignee, state, deadline, dates. Hours: time
        logged in the period per task and person. Billing: the client's invoices.
        """
        if not self._is_owner_admin():
            return {'status': False, 'message': 'Not authorized.'}
        try:
            kind = params.get('kind') or 'open'
            scope = self._client_scope(params)
            if not scope:
                return {'status': False, 'message': 'Client not found.'}
            ids, lo, hi, tz = scope['ids'], scope['lo'], scope['hi'], scope['tz']
            Kpi = request.env['kra.kpi'].sudo()
            state_label = dict(Kpi._fields['task_state'].selection)

            def local(dt, fmt='%d %b %Y'):
                import pytz
                return pytz.UTC.localize(dt).astimezone(tz).strftime(fmt) if dt else ''

            def task_row(t):
                return {'id': t.id, 'ref': t.external_ref or '', 'name': t.name or '',
                        'project': t.kra_id.name or '', 'assignee': t.user_id.name or '',
                        'assignee_id': t.user_id.id or False,
                        'state': t.task_state, 'state_label': state_label.get(t.task_state, t.task_state or ''),
                        'deadline': str(t.deadline) if t.deadline else '',
                        'created': local(t.create_date),
                        'signed': local(t.client_signed_datetime) if t.client_signed_datetime else '',
                        'is_new': bool(not t.published and (t.client_submitted or not t.user_id)),
                        'quoted_h': round(t.client_quoted or 0, 1)}

            if kind in ('open', 'in_progress', 'waiting', 'certified'):
                D = self._client_domains(ids, lo, hi)
                order = 'client_signed_datetime desc' if kind == 'certified' else 'create_date desc'
                tasks = Kpi.search(D[kind], order=order, limit=300)
                return {'status': True, 'kind': kind, 'rows': [task_row(t) for t in tasks]}

            if kind == 'hours':
                now = fields.Datetime.now()
                per = {}
                for lg in request.env['kpi.time.log'].sudo().search(
                        [('kpi_id.kra_id', 'in', ids), ('start_time', '>=', lo), ('start_time', '<', hi)]):
                    secs = max(0, (now - lg.start_time).total_seconds()) if (lg.is_active and lg.start_time) else (lg.duration_seconds or 0)
                    key = (lg.kpi_id.id, lg.user_id.id)
                    r = per.setdefault(key, {'task': lg.kpi_id, 'user': lg.user_id, 'secs': 0.0})
                    r['secs'] += secs
                rows = [{'id': v['task'].id, 'ref': v['task'].external_ref or '', 'name': v['task'].name or '',
                         'project': v['task'].kra_id.name or '', 'person': v['user'].name or '',
                         'person_id': v['user'].id or False,
                         'hours': round(v['secs'] / 3600.0, 2), 'quoted_h': round(v['task'].client_quoted or 0, 1)}
                        for v in per.values()]
                rows.sort(key=lambda r: -r['hours'])
                return {'status': True, 'kind': kind, 'rows': rows}

            if kind == 'billing':
                Inv = request.env['kpi.client.invoice'].sudo()
                rows = [{'id': i.id, 'name': i.name or '', 'date': str(i.invoice_date) if i.invoice_date else '',
                         'state': i.state, 'payment_status': i.payment_status,
                         'amount': round(i.total_amount or 0, 2),
                         'currency': (i.currency_id.symbol or i.currency_id.name) if i.currency_id else ''}
                        for i in Inv.search([('client_kra_id', 'in', ids)], order='invoice_date desc, id desc', limit=100)]
                return {'status': True, 'kind': kind, 'rows': rows}

            return {'status': False, 'message': 'Unknown list.'}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error("owner_client_summary_items: %s", e)
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_owner/client_summary', type='json', auth='user', methods=['POST'], csrf=False)
    def owner_client_summary(self, **params):
        """The Dashboard's "Client details" box: one client (and every project
        under it) for a period.

        params: client_kra_id; from_date / to_date ('YYYY-MM-DD', local days,
        to_date inclusive). Without dates it is "Auto": this month to date.

        Snapshot counts (open, in progress, waiting sign-off, new) are as of
        now — a period does not change what is open today. Period counts are
        certified (signed off by the client in the period) and hours (time
        logged in the period against the quote of the tasks worked on).
        Billing: the latest invoice, and what is still unpaid. Invoices carry
        no due date, so it is the oldest unpaid invoice's date plus the payment
        term (ir.config_parameter kra_kpi.payment_term_days, default 15).
        """
        import pytz
        from datetime import datetime as _dt, time as _time, timedelta as _td
        if not self._is_owner_admin():
            return {'status': False, 'message': 'Not authorized.'}
        try:
            scope = self._client_scope(params)
            if not scope:
                return {'status': False, 'message': 'Client not found.'}
            client, ids, lo, hi, d_from, d_to, auto, today = (
                scope['client'], scope['ids'], scope['lo'], scope['hi'],
                scope['from'], scope['to'], scope['auto'], scope['today'])
            Kpi = request.env['kra.kpi'].sudo().with_context(active_test=True)
            Log = request.env['kpi.time.log'].sudo()
            Inv = request.env['kpi.client.invoice'].sudo()
            D = self._client_domains(ids, lo, hi)

            open_count = Kpi.search_count(D['open'])
            new_count = Kpi.search_count(D['new'])
            in_progress = Kpi.search_count(D['in_progress'])
            waiting = Kpi.search_count(D['waiting'])
            certified = Kpi.search_count(D['certified'])

            logs = Log.search([('kpi_id.kra_id', 'in', ids),
                               ('start_time', '>=', lo), ('start_time', '<', hi)])
            used_secs = 0.0
            now = fields.Datetime.now()
            for lg in logs:
                if lg.is_active and lg.start_time:
                    used_secs += max(0, (now - lg.start_time).total_seconds())
                else:
                    used_secs += lg.duration_seconds or 0
            worked = logs.mapped('kpi_id')
            quoted = sum(worked.mapped('client_quoted') or [0])

            last = Inv.search([('client_kra_id', 'in', ids)], order='invoice_date desc, id desc', limit=1)
            unpaid = Inv.search([('client_kra_id', 'in', ids), ('state', 'in', ('finalized', 'sent')),
                                 ('payment_status', '=', 'unpaid')], order='invoice_date asc, id asc')
            try:
                term = max(0, int(request.env['ir.config_parameter'].sudo().get_param('kra_kpi.payment_term_days', 15)))
            except (TypeError, ValueError):
                term = 15
            due_date = (unpaid[0].invoice_date + _td(days=term)) if unpaid and unpaid[0].invoice_date else False
            cur = (last.currency_id or client.currency_id) if last else client.currency_id

            initials = ''.join(w[0] for w in (client.name or '?').split()[:2]).upper()
            return {
                'status': True,
                'client': {'id': client.id, 'name': client.name or '', 'initials': initials},
                'period': {'auto': auto, 'from': str(d_from), 'to': str(d_to)},
                'open': open_count,
                'new_need_estimate': new_count,
                'in_progress': in_progress,
                'waiting_signoff': waiting,
                'certified': certified,
                'hours_used': round(used_secs / 3600.0, 1),
                'hours_quoted': round(quoted, 1),
                'last_invoice': {
                    'name': last.name, 'state': last.state, 'payment_status': last.payment_status,
                    'date': str(last.invoice_date) if last.invoice_date else '',
                } if last else None,
                'amount_due': round(sum(unpaid.mapped('total_amount') or [0]), 2),
                'unpaid_count': len(unpaid),
                'due_date': str(due_date) if due_date else '',
                'overdue': bool(due_date and due_date < today),
                'currency': {'name': cur.name, 'symbol': cur.symbol} if cur else None,
                'payment_term_days': term,
            }
        except Exception as e:
            import logging
            logging.getLogger(__name__).error("owner_client_summary: %s", e)
            return {'status': False, 'message': str(e)}

    @http.route('/kra_kpi/dashboard/overview', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_dashboard_overview(self, **params):
        """The Dashboard page (web /dashboard): every count its right side shows
        that Live Tracking (/kpi_owner/live_tracking: presence, what each person is
        doing now) and Client Billing (/kpi_owner/certified_by_client: per-client
        hours and invoices) don't already return. Counts only, plus the next few
        meetings. Task states are bucketed like the 369 AI Assistant's digest, so
        the cards and the assistant's answers agree. Each area is read on its own:
        one that fails (e.g. WhatsApp not installed) comes back None and the rest
        still loads. Owner / Coordinator / System only."""
        if not self._is_owner_admin():
            return {'status': False, 'message': 'Not authorized.'}
        import logging
        import pytz
        from datetime import datetime as _dt, time as _time
        _log = logging.getLogger(__name__)
        env = request.env
        user = env.user
        Kpi = env['kra.kpi'].sudo()
        tz = pytz.timezone(user.tz or 'Asia/Kolkata')
        now = fields.Datetime.now()
        today = fields.Date.context_today(user)
        week_from = today - timedelta(days=6)  # "this week" = the last 7 days, today included

        def utc_start(d):
            """Local midnight of day `d` as naive UTC, to compare with stored datetimes."""
            return tz.localize(_dt.combine(d, _time.min)).astimezone(pytz.UTC).replace(tzinfo=None)

        def local(dt):
            return pytz.UTC.localize(dt).astimezone(tz) if dt else None

        def safe(name, fn):
            try:
                return fn()
            except Exception as e:
                _log.warning("kpi_dashboard_overview: %s failed: %s", name, e)
                return None

        out = {'status': True, 'today': str(today), 'as_of': _to_user_tz_str(now, user, '%H:%M')}

        # ---- tasks completed per local day, last 28 days ----
        # approval_date is set when a task reaches `completed`; older rows without
        # it fall back to write_date (what the assistant's digest uses).
        def completed():
            d0 = today - timedelta(days=27)
            since = utc_start(d0)
            rows = Kpi.search_read([
                ('task_state', '=', 'completed'),
                '|', ('approval_date', '>=', since),
                '&', ('approval_date', '=', False), ('write_date', '>=', since),
            ], ['approval_date', 'write_date', 'user_id'])
            per_day = {d0 + timedelta(days=i): 0 for i in range(28)}
            by_user = {}
            for r in rows:
                day = local(r['approval_date'] or r['write_date']).date()
                if day not in per_day:
                    continue
                per_day[day] += 1
                if day >= week_from and r['user_id']:
                    by_user[r['user_id'][0]] = by_user.get(r['user_id'][0], 0) + 1
            days = [{'date': str(d), 'count': per_day[d]} for d in sorted(per_day)]

            def done_between(a, b):
                lo, hi = utc_start(a), utc_start(b)
                return Kpi.search_count([
                    ('task_state', '=', 'completed'),
                    '|', '&', ('approval_date', '>=', lo), ('approval_date', '<', hi),
                    '&', '&', ('approval_date', '=', False), ('write_date', '>=', lo), ('write_date', '<', hi)])
            month_start = today.replace(day=1)
            prev_start = (month_start - timedelta(days=1)).replace(day=1)
            return {
                'days': days,
                'today': days[-1]['count'],
                'week': sum(d['count'] for d in days[-7:]),
                'prev_week': sum(d['count'] for d in days[-14:-7]),
                'month': done_between(month_start, today + timedelta(days=1)),
                'prev_month': done_between(prev_start, month_start),
                'by_user': by_user,
            }
        done = safe('completed', completed) or {}
        done_by_user = done.pop('by_user', {}) if done else {}
        out['completed'] = done or None

        # ---- where every task stands, overall and per person ----
        BUCKET = {
            'assigned': 'not_started', 'urgent': 'not_started', 'important': 'not_started',
            'regular': 'not_started', 'pre_approval_approved': 'not_started',
            'in_progress': 'running', 'paused': 'paused',
            'hold': 'on_hold', 'rework': 'on_hold',
            'partially_completed': 'pending_approval', 'awaiting_client': 'awaiting_client',
        }

        def pipeline():
            totals = dict.fromkeys(('not_started', 'running', 'paused', 'on_hold',
                                    'pending_approval', 'awaiting_client'), 0)
            people = {}
            for uid, state, count in Kpi._read_group(
                    [('task_state', 'in', list(BUCKET))], ['user_id', 'task_state'], ['__count']):
                b = BUCKET[state]
                totals[b] += count
                if uid:
                    p = people.setdefault(uid.id, dict.fromkeys(totals, 0))
                    p[b] += count
            month_start = utc_start(today.replace(day=1))
            totals['completed_month'] = Kpi.search_count([
                ('task_state', '=', 'completed'),
                '|', ('approval_date', '>=', month_start),
                '&', ('approval_date', '=', False), ('write_date', '>=', month_start)])
            # Open work per person: estimated hours vs time spent so far.
            for uid, est, secs in Kpi._read_group(
                    [('task_state', 'in', list(BUCKET)), ('user_id', '!=', False)],
                    ['user_id'], ['estimate:sum', 'timer_total_seconds:sum']):
                p = people.setdefault(uid.id, dict.fromkeys(totals, 0))
                p['est_hours'] = round(est or 0, 1)
                p['spent_hours'] = round((secs or 0) / 3600.0, 1)
            return totals, people
        pipe = safe('pipeline', pipeline)
        out['pipeline'] = pipe[0] if pipe else None
        people = pipe[1] if pipe else {}

        # ---- finished work waiting for the admin's OK, by age ----
        def approvals():
            tasks = Kpi.search([('task_state', '=', 'partially_completed'), ('admin_approved', '=', False)])
            ages = [0, 0, 0, 0, 0]  # today, 1, 2, 3, 4+ days
            oldest = None
            for t in tasks:
                since = t.completion_date or t.write_date
                days = max(0, (today - local(since).date()).days) if since else 0
                ages[min(days, 4)] += 1
                if since and (oldest is None or since < oldest[0]):
                    oldest = (since, t, days)
            return {
                'count': len(tasks), 'by_age': ages,
                'oldest_days': oldest[2] if oldest else 0,
                'oldest_ref': (oldest[1].external_ref or oldest[1].name or '') if oldest else '',
            }
        out['approvals'] = safe('approvals', approvals)

        # ---- paused work: how long, and with whom ----
        def paused():
            rows = Kpi.search_read([('task_state', '=', 'paused')], ['write_date', 'user_id'])
            old = sum(1 for r in rows if r['write_date'] and (now - r['write_date']).days >= 2)
            per = {}
            for r in rows:
                if r['user_id']:
                    per[r['user_id'][1]] = per.get(r['user_id'][1], 0) + 1
            top = max(per.items(), key=lambda kv: kv[1]) if per else ('', 0)
            return {'count': len(rows), 'two_days': old, 'top_person': top[0], 'top_count': top[1]}
        out['paused'] = safe('paused', paused)

        # ---- clients ----
        def clients():
            return {
                'signoff_waiting': Kpi.search_count([('task_state', '=', 'awaiting_client')]),
                'certified': Kpi.search_count([('client_final_approved', '=', True)]),
                # Client Task Queue: submitted by a client (or unassigned) and not published yet.
                'queue': Kpi.search_count([('published', '=', False), '|',
                                           ('client_submitted', '=', True), ('user_id', '=', False)]),
                # Estimate sent, the client hasn't answered.
                'pre_approvals': Kpi.search_count([('user_id', '!=', False), ('task_state', 'in',
                                                   ('pre_approval_pending', 'pre_approval_partial'))]),
                'certificates_week': Kpi.search_count([('client_final_approved', '=', True),
                                                       ('client_signed_datetime', '>=', utc_start(week_from))]),
            }
        out['clients'] = safe('clients', clients)

        # ---- billing: this month's invoices and what is unpaid, per currency ----
        def billing():
            Inv = env['kpi.client.invoice'].sudo()
            month_start = today.replace(day=1)
            next_month = (month_start + timedelta(days=32)).replace(day=1)

            # Most invoices carry no currency of their own: they are in the
            # company's (INR), so they show "₹80", not a bare "80".
            company_cur = env.company.currency_id

            def by_currency(domain):
                merged = {}
                for cur, count, total in Inv._read_group(domain, ['currency_id'], ['__count', 'total_amount:sum']):
                    cur = cur or company_cur
                    row = merged.setdefault(cur.id, {'currency': cur.name or '', 'symbol': cur.symbol or '', 'count': 0, 'amount': 0.0})
                    row['count'] += count
                    row['amount'] = round(row['amount'] + (total or 0), 2)
                return list(merged.values())
            issued = [('state', 'in', ('finalized', 'sent'))]
            prev_start = (month_start - timedelta(days=1)).replace(day=1)
            unpaid_rows = []
            for inv in Inv.search(issued + [('payment_status', '=', 'unpaid')], order='invoice_date asc, id asc', limit=6):
                unpaid_rows.append({
                    'id': inv.id, 'name': inv.name or '', 'client': inv.client_kra_id.name or '',
                    'amount': round(inv.total_amount or 0, 2), 'symbol': (inv.currency_id or company_cur).symbol or '',
                    'date': str(inv.invoice_date) if inv.invoice_date else '',
                    'days': (today - inv.invoice_date).days if inv.invoice_date else 0,
                })
            return {
                'month': by_currency(issued + [('invoice_date', '>=', month_start), ('invoice_date', '<', next_month)]),
                'prev_month': by_currency(issued + [('invoice_date', '>=', prev_start), ('invoice_date', '<', month_start)]),
                'unpaid': by_currency(issued + [('payment_status', '=', 'unpaid')]),
                'unpaid_rows': unpaid_rows,
            }
        out['billing'] = safe('billing', billing)

        # ---- deadlines: overdue, due in the next 7 days, urgent not started ----
        NOT_STARTED = ('assigned', 'urgent', 'important', 'regular', 'pre_approval_approved')

        def task_row(t, **extra):
            return {'id': t.id, 'ref': t.external_ref or '', 'name': t.name or '',
                    'person': t.user_id.name if t.user_id else 'Unassigned', **extra}

        def deadlines():
            open_dom = [('task_state', 'not in', ('completed', 'awaiting_client')), ('deadline', '!=', False)]
            late = Kpi.search(open_dom + [('deadline', '<', today)], order='deadline asc, id asc')
            soon = Kpi.search(open_dom + [('deadline', '>=', today), ('deadline', '<=', today + timedelta(days=6))],
                              order='deadline asc, id asc')
            urgent = Kpi.search([('priority', '=', 'urgent'), ('task_state', 'in', NOT_STARTED)],
                                order='create_date asc, id asc')
            return {
                'overdue': {'count': len(late), 'rows': [task_row(t, days=(today - t.deadline).days) for t in late[:5]]},
                'due_week': {'count': len(soon), 'rows': [task_row(t, due=str(t.deadline)) for t in soon[:5]]},
                'urgent': {'count': len(urgent), 'rows': [task_row(t, days=(now - t.create_date).days if t.create_date else 0)
                                                          for t in urgent[:5]]},
            }
        out['deadlines'] = safe('deadlines', deadlines)

        # ---- waiting on clients: newest queue requests, estimates awaiting a reply ----
        def waiting_on_clients():
            queue = Kpi.search([('published', '=', False), '|', ('client_submitted', '=', True), ('user_id', '=', False)],
                               order='create_date desc, id desc', limit=4)
            pre = Kpi.search([('user_id', '!=', False), ('task_state', 'in', ('pre_approval_pending', 'pre_approval_partial'))],
                             order='pre_approval_deadline_at asc, id asc', limit=5)
            return {
                'queue': [{'id': t.id, 'ref': t.external_ref or '', 'name': t.name or '', 'client': t.client_kra_id.name or '',
                           'date': str(local(t.create_date).date()) if t.create_date else ''} for t in queue],
                'pre_approvals': [{'id': t.id, 'ref': t.external_ref or '', 'name': t.name or '', 'client': t.client_kra_id.name or '',
                                   'reply_by': str(local(t.pre_approval_deadline_at).date()) if t.pre_approval_deadline_at else '',
                                   'overdue': bool(t.pre_approval_deadline_at and t.pre_approval_deadline_at < now)} for t in pre],
            }
        out['waiting_on_clients'] = safe('waiting_on_clients', waiting_on_clients)

        # ---- developers' questions to a manager with no answer yet (the sidebar badge) ----
        out['doubts_open'] = safe('doubts', lambda: env['kpi.doubt'].sudo().search_count([('state', '=', 'open')]))

        # ---- meetings: today's count and the next few ----
        def meetings():
            M = env['kpi.meeting'].sudo()
            open_states = ('requested', 'confirmed', 'live')
            start = utc_start(today)
            today_count = M.search_count([('scheduled_start', '>=', start),
                                          ('scheduled_start', '<', utc_start(today + timedelta(days=1))),
                                          ('state', 'in', open_states)])
            rows = []
            for m in M.search([('scheduled_start', '>=', start), ('state', 'in', open_states)],
                              order='scheduled_start asc', limit=4):
                at = local(m.scheduled_start)
                rows.append({
                    'id': m.id, 'name': m.name or '', 'state': m.state,
                    'date': str(at.date()), 'time': at.strftime('%I:%M %p').lstrip('0'),
                    'people': [u.name for u in (m.organizer_id | m.attendee_user_ids)][:3],
                })
            return {'today': today_count, 'upcoming': rows}
        out['meetings'] = safe('meetings', meetings)

        # ---- reminders due today, documents and certificates this week ----
        out['reminders_today'] = safe('reminders', lambda: env['kpi.reminder'].sudo().search_count([
            ('enabled', '=', True), ('next_trigger', '>=', utc_start(today)),
            ('next_trigger', '<', utc_start(today + timedelta(days=1)))]))

        def documents():
            since = utc_start(week_from)
            return (env['kpi.progress'].sudo().search_count([('uploaded_file', '!=', False), ('create_date', '>=', since)])
                    + env['kpi.file.attachment'].sudo().search_count([('create_date', '>=', since)]))
        out['documents_week'] = safe('documents', documents)

        # ---- WhatsApp (separate module, may be absent) ----
        def whatsapp():
            connected = None
            if 'whatsapp.session' in env:
                connected = bool(env['whatsapp.session'].sudo().search_count([('status', '=', 'connected')], limit=1))
            groups = env['kpi.wa.group'].sudo().search_count([
                ('active', '=', True), ('is_staff_group', '=', False), ('kra_id', '!=', False)])
            return {'connected': connected, 'client_groups': groups}
        out['whatsapp'] = safe('whatsapp', whatsapp)

        # ---- hours: today live from the open sessions, earlier days from snapshots ----
        def hours():
            Session = env['kpi.work.session'].sudo()
            per = {}
            prod_today = pres_today = 0.0
            for s in Session.search([('session_date', '=', today)]):
                if not s.user_id:
                    continue
                prod_today += s.productive_seconds or 0
                pres_today += s.presence_seconds or 0
                per[s.user_id.id] = per.get(s.user_id.id, 0) + (s.productive_seconds or 0)
            snaps = env['kpi.workday.snapshot'].sudo().search_read(
                [('session_date', '>=', week_from), ('session_date', '<', today)],
                ['user_id', 'productive_seconds', 'presence_seconds'])
            week = dict(per)
            for r in snaps:
                if r['user_id']:
                    week[r['user_id'][0]] = week.get(r['user_id'][0], 0) + (r['productive_seconds'] or 0)
            return {
                'today_productive': round(prod_today), 'today_presence': round(pres_today),
                'week_productive': round(prod_today + sum(r['productive_seconds'] or 0 for r in snaps)),
                'week_presence': round(pres_today + sum(r['presence_seconds'] or 0 for r in snaps)),
            }, per, week
        hrs = safe('hours', hours)
        out['hours'] = hrs[0] if hrs else None
        today_secs = hrs[1] if hrs else {}
        week_secs = hrs[2] if hrs else {}

        # ---- per person (merged with Live Tracking's rows by user_id on the page) ----
        uids = set(people) | set(done_by_user) | set(today_secs) | set(week_secs)
        out['people'] = [{
            'productive_week': round(week_secs.get(uid, 0)),
            'user_id': uid,
            'running': people.get(uid, {}).get('running', 0),
            'paused': people.get(uid, {}).get('paused', 0) + people.get(uid, {}).get('on_hold', 0),
            'todo': people.get(uid, {}).get('not_started', 0),
            'approval': people.get(uid, {}).get('pending_approval', 0),
            'done_week': done_by_user.get(uid, 0),
            'productive_today': round(today_secs.get(uid, 0)),
            'est_hours': people.get(uid, {}).get('est_hours', 0),
            'spent_hours': people.get(uid, {}).get('spent_hours', 0),
        } for uid in sorted(uids)]
        return out

    @http.route('/kpi_owner/client_certified_tasks', type='json', auth='user', methods=['POST'], csrf=False)
    def owner_client_certified_tasks(self, **params):
        """List the actual signed-off tasks for one client (drill-down from the dashboard)."""
        if not self._is_owner_admin():
            return {'status': False, 'message': 'Not authorized.'}
        try:
            client_id = int(params['client_kra_id'])
            Kra = request.env['kra.master'].sudo()
            client = Kra.browse(client_id)
            if not client.exists():
                return {'status': False, 'message': 'Client not found'}
            kra_ids = [client.id]
            frontier = [client.id]
            while frontier:
                children = Kra.search([('parent_id', 'in', frontier)]).ids
                if not children:
                    break
                kra_ids.extend(children)
                frontier = children
            kpis = request.env['kra.kpi'].sudo().search([
                ('kra_id', 'in', kra_ids), ('active', '=', True),
                ('task_state', '=', 'completed'),
            ], order='completion_date desc')
            rows = [{
                'id': k.id,
                'name': k.name,
                'external_ref': k.external_ref or '',
                'priority': k.priority or '',
                'actual_hours': round((k.timer_total_seconds or 0) / 3600.0, 2),
                'quoted_hours': round(k.client_quoted or 0.0, 2),
                'primary_assignee': k.user_id.name if k.user_id else '',
                'client_signed_by': k.client_signature_text or '',
                'completion_date': k.completion_date.strftime('%Y-%m-%d') if k.completion_date else '',
                'signed_date': str(k.signed_certificate_date) if k.signed_certificate_date else '',
            } for k in kpis]
            return {'status': True, 'client_name': client.name, 'tasks': rows}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"owner_client_certified_tasks: {str(e)}")
            return {'status': False, 'message': str(e), 'tasks': []}

    # ============================================================
    #         WHATSAPP GROUP REPORTING
    # ============================================================

    # Invite-link discovery is refused in Python rather than attempted. Every
    # neonize call in that family — get_joined_groups, get_group_info_from_link,
    # join_group_with_link — fails on this gateway build with an access violation
    # inside the Go binary. That is a process kill, not a Python exception, so no
    # try/except can contain it and the whole Odoo server goes down with it. The
    # capture flow needs none of them.
    _WA_LINK_UNAVAILABLE = (
        "Invite links do not work on this WhatsApp gateway. Instead: add this "
        "WhatsApp number to the group from your phone, send any message in the "
        "group, then press Refresh — the group appears in the list above.")

    def _wa_is_admin(self):
        """These routes join groups and change where the team's workday reports
        are published, so they are admin-only."""
        user = request.env.user
        return (user.has_group('kra_kpi_module.group_kra_owner')
                or user.has_group('kra_kpi_module.group_kra_admin')
                or user.has_group('base.group_system'))

    def _wa_admin_or_refuse(self):
        """(session, error) for the routes that genuinely talk to WhatsApp.

        Kept separate from picking a group: choosing or clearing the destination is
        pure configuration and must work with the gateway down, or you cannot set
        anything up until the phone happens to be connected.
        """
        if not self._wa_is_admin():
            return None, 'Not authorized.'
        session = request.env['whatsapp.session'].sudo().search(
            [('status', '=', 'connected')], limit=1)
        if not session:
            return None, 'No connected WhatsApp session. Connect the gateway first.'
        return session, None

    @http.route('/kpi_wa_group/list', type='json', auth='user', methods=['POST'], csrf=False)
    def wa_group_list(self, **params):
        """Every group this number has joined, merged with what we have captured.

        Two sources, deliberately:

        * `kpi.wa.group` — groups we have seen a message from. Always readable,
          works with the phone offline, and carries the admin's own label.
        * the gateway's own joined-groups list — real WhatsApp names and member
          counts, which is what actually makes a group identifiable.

        The gateway half is best-effort. It was removed entirely while neonize
        0.4.1 was installed, where get_joined_groups() died inside the Go binary
        with an access violation — a process kill no Python `except` can contain,
        on a route that runs on every press of Refresh. neonize 0.4.3 fixed it
        (verified out-of-process against this exact session: 61 groups returned
        with names). It stays wrapped and optional so an offline phone, or a
        regression, degrades to the captured list instead of an error.
        """
        if not self._wa_is_admin():
            return {'status': False, 'message': 'Not authorized.', 'groups': []}
        try:
            company = request.env.company
            rows = {}
            # A row created before labels existed has name == jid, because that was
            # the old default. That is not a name, and treating it as one would let
            # the very rows the naming guard exists for sail straight through it.
            for g in request.env['kpi.wa.group'].sudo().search([], limit=200):
                label = '' if (g.name or '') == g.jid else (g.name or '')
                rows[g.jid] = {
                    'jid': g.jid, 'name': label, 'named': bool(label),
                    'messages': g.message_count,
                    'last_sender': g.last_sender or '',
                    'last_seen': fields.Datetime.to_string(g.last_seen) if g.last_seen else '',
                    'seen': True, 'joined': False, 'members': 0,
                    # One group belongs to ONE client; that client's children are
                    # its sub-clients. Surfaced here so the settings screen can
                    # show and change the link without a second round trip.
                    'id': g.id,
                    'kra_id': g.kra_id.id or False,
                    'client_name': g.kra_id.name or '',
                    'sub_client_count': g.sub_client_count,
                    'sub_clients': [
                        {'id': c.id, 'name': c.name}
                        for c in g.kra_id.child_ids[:50]
                    ] if g.kra_id else [],
                }
            session = request.env['whatsapp.session'].sudo().search(
                [('status', '=', 'connected')], limit=1)
            if session:
                try:
                    for g in session.wa_list_groups():
                        row = rows.setdefault(g['jid'], {
                            'jid': g['jid'], 'name': '', 'named': False, 'messages': 0,
                            'last_sender': '', 'last_seen': '', 'seen': False,
                        })
                        # The admin's own label wins: they set it precisely because
                        # they wanted this group called something they recognise.
                        row['name'] = row.get('name') or g.get('name') or ''
                        row['named'] = bool(row['name'])
                        row['members'] = g.get('size') or 0
                        row['joined'] = True
                except Exception as exc:
                    import logging
                    logging.getLogger(__name__).info(
                        "gateway group list unavailable, using captured rows: %s", exc)
            # Named first, then biggest — an unnamed group cannot be selected, so
            # it belongs at the bottom rather than buried among the usable ones.
            groups = sorted(rows.values(),
                            key=lambda r: (not r['named'], -(r.get('members') or 0),
                                           (r['name'] or '').lower()))
            return {'status': True,
                    'groups': groups,
                    'selected_jid': company.kpi_wa_group_jid or '',
                    'selected_name': company.kpi_wa_group_name or ''}
        except Exception as e:
            # Imported locally, matching the rest of this file — `logging` is not
            # imported at module scope here.
            import logging
            logging.getLogger(__name__).error("wa_group_list: %s", e)
            return {'status': False,
                    'message': 'Could not read the group list: %s' % str(e)[:120],
                    'groups': []}

    @http.route('/kpi_wa_group/peek', type='json', auth='user', methods=['POST'], csrf=False)
    def wa_group_peek(self, **params):
        """Read an invite link WITHOUT joining, so the group can be confirmed first.

        Joining is visible — everyone in the group sees the number appear — so it
        is not something to do silently on paste.
        """
        if not self._wa_is_admin():
            return {'status': False, 'message': 'Not authorized.'}
        # NOT wired to the gateway. wa_peek_invite calls get_group_info_from_link,
        # which fails on this neonize build with an access violation inside the Go
        # binary — that is a process kill, not an exception, so no try/except here
        # can contain it. Refusing in Python is strictly better than a 50/50 chance
        # of taking Odoo down, and the capture route below always works.
        return {"status": False, "message": self._WA_LINK_UNAVAILABLE}

    @http.route('/kpi_wa_group/join', type='json', auth='user', methods=['POST'], csrf=False)
    def wa_group_join(self, **params):
        """Disabled: join-by-link crashes this gateway build. See wa_group_peek."""
        if not self._wa_is_admin():
            return {'status': False, 'message': 'Not authorized.'}
        # join_group_with_link is in the same crashing family as the lookups. It is
        # also no longer needed: a group announces its own id the moment anyone
        # posts in it, which is the flow the card now teaches.
        return {"status": False, "message": self._WA_LINK_UNAVAILABLE}

    @http.route('/kpi_wa_group/select', type='json', auth='user', methods=['POST'], csrf=False)
    def wa_group_select(self, **params):
        """Set (or clear, with an empty jid) the group workday reports go to.

        Admin rights only — deliberately NOT a connected gateway. This is
        configuration, and requiring the phone to be online to change a setting
        means you can never set it up while it is offline.
        """
        if not self._wa_is_admin():
            return {'status': False, 'message': 'Not authorized.'}
        jid = (params.get('jid') or '').strip()
        if jid and not jid.endswith('@g.us'):
            return {'status': False, 'message': 'That is not a group id.'}
        request.env.company.sudo().write({
            'kpi_wa_group_jid': jid or False,
            'kpi_wa_group_name': (params.get('name') or '') if jid else False,
        })
        return {'status': True, 'jid': jid, 'name': params.get('name') or ''}

    @http.route('/kpi_wa_group/rename', type='json', auth='user', methods=['POST'], csrf=False)
    def wa_group_rename(self, **params):
        """Label a captured group so a human can tell which one it is.

        No gateway call at all — which is the point. WhatsApp will not give us the
        real group name on this build, and an unlabelled row is just an opaque id
        that reads the same whether it is the dev group or a client's.
        """
        if not self._wa_is_admin():
            return {'status': False, 'message': 'Not authorized.'}
        jid = (params.get('jid') or '').strip()
        rec = request.env['kpi.wa.group'].sudo().search([('jid', '=', jid)], limit=1)
        if not rec:
            return {'status': False, 'message': 'Unknown group.'}
        rec.rename(params.get('name') or '')
        # Keep the label shown on the "Reporting to …" banner in step with the
        # picker when the renamed group is the one currently selected.
        company = request.env.company
        if (company.kpi_wa_group_jid or '') == jid:
            company.sudo().kpi_wa_group_name = rec.name or ''
        return {'status': True, 'jid': jid, 'name': rec.name or ''}

    @http.route('/kpi_pending_queue/decline_reasons', type='json', auth='user',
                methods=['POST'], csrf=False)
    def pending_queue_decline_reasons(self, **params):
        """The reason picker. `mode` is 'decline' or 'reclassify'."""
        if not self._is_owner_admin():
            return {'status': False, 'message': 'Not authorized.', 'reasons': []}
        mode = params.get('mode') or 'decline'
        return {'status': True,
                'reasons': request.env['kpi.decline.reason'].options_for(mode)}

    @http.route('/kpi_pending_queue/decline', type='json', auth='user',
                methods=['POST'], csrf=False)
    def pending_queue_decline(self, **params):
        """Decline or re-type a queued client submission, WITH a reason.

        This is the alternative to /kpi_pending_queue/delete, which unlinks the
        record -- destroying the client's media and the audit trail -- and
        stores the reason nowhere. Here the row is archived, the reason is
        kept, and the client is told in their own WhatsApp group.

        params: kpi_id, mode ('decline'|'reclassify'), reason_id, reason_text,
                doc_type (required for reclassify unless the reason carries one)
        """
        if not self._is_owner_admin():
            return {'status': False, 'message': 'Not authorized.'}
        try:
            kpi_id = int(params.get('kpi_id') or 0)
        except (TypeError, ValueError):
            return {'status': False, 'message': 'Bad task id.'}
        kpi = request.env['kra.kpi'].sudo().browse(kpi_id)
        if not kpi.exists():
            return {'status': False, 'message': 'Task not found.'}
        try:
            res = kpi.action_decline(
                mode=params.get('mode') or 'decline',
                reason_id=params.get('reason_id'),
                reason_text=params.get('reason_text') or '',
                doc_type=params.get('doc_type') or None,
            )
        except Exception as exc:
            return {'status': False, 'message': str(exc)}
        if not res.get('posted_to_group'):
            res['warning'] = (
                "Saved, but the client was not told: no WhatsApp group is "
                "linked to this client. Set one under Setup > WhatsApp Groups.")
        return res

    @http.route('/kpi_wa_group/set_client', type='json', auth='user', methods=['POST'], csrf=False)
    def wa_group_set_client(self, **params):
        """Link a WhatsApp group to a client.

        ONE group -> ONE client. The client's own child KRAs are its
        sub-clients (shops / branches), so anything raised in this group is
        scoped to that client's subtree. Without the link a group has no scope,
        and a reference typed in one reseller's group could resolve onto a
        different reseller's record.

        Pass kra_id = 0/false to clear the link.
        """
        if not self._wa_is_admin():
            return {'status': False, 'message': 'Not authorized.'}
        jid = (params.get('jid') or '').strip()
        rec = request.env['kpi.wa.group'].sudo().search([('jid', '=', jid)], limit=1)
        if not rec:
            return {'status': False, 'message': 'Unknown group.'}
        kra_id = params.get('kra_id')
        if kra_id:
            kra = request.env['kra.master'].sudo().browse(int(kra_id))
            if not kra.exists() or not kra.active:
                return {'status': False, 'message': 'Client not found.'}
            if not kra.is_client:
                return {'status': False,
                        'message': "'%s' is not marked as a client." % kra.name}
        res = rec.set_client(kra_id or False)
        if res.get('status'):
            res['jid'] = jid
        return res

    @http.route('/kpi_wa_group/clients', type='json', auth='user', methods=['POST'], csrf=False)
    def wa_group_clients(self, **params):
        """Clients selectable as a group's owner, each with its sub-client count.

        Only `is_client` rows are offered -- the same rule the field's domain
        uses -- so the picker and the model cannot disagree.
        """
        if not self._wa_is_admin():
            return {'status': False, 'message': 'Not authorized.', 'clients': []}
        kras = request.env['kra.master'].sudo().search(
            [('is_client', '=', True), ('active', '=', True)], order='name')
        return {'status': True, 'clients': [{
            'id': k.id,
            'name': k.name,
            'parent_name': k.parent_id.name or '',
            'sub_client_count': len(k.child_ids),
        } for k in kras]}

    @http.route('/kpi_wa_group/events', type='json', auth='user', methods=['POST'], csrf=False)
    def wa_group_events(self, **params):
        """Every reportable event: switch, wording, default wording and preview.

        Returns the effective wording AND the default, like /kpi_user_access/get
        does for the OTP message — that is what lets "Reset to default" and the
        live preview work without a second round-trip, and it keeps the default
        defined in exactly one place.
        """
        if not self._wa_is_admin():
            return {'status': False, 'message': 'Not authorized.', 'events': []}
        from ..models.kpi_wa_group_event import WA_GROUP_EVENTS_BY_KEY, PREVIEW_SAMPLES
        rows = request.env['kpi.wa.group.event'].sudo()._rows(request.env.company)
        out = []
        for row in rows:
            spec = WA_GROUP_EVENTS_BY_KEY.get(row.event, {})
            out.append({
                'event': row.event,
                'label': spec.get('label', row.event),
                'help': spec.get('help', ''),
                'enabled': row.enabled,
                'template': row.effective_template(),
                'default': spec.get('default', ''),
                'tokens': spec.get('tokens', []),
            })
        return {'status': True, 'events': out, 'samples': PREVIEW_SAMPLES}

    @http.route('/kpi_wa_group/set_event', type='json', auth='user', methods=['POST'], csrf=False)
    def wa_group_set_event(self, **params):
        """Save one event's switch and/or wording.

        Both keys optional and the persisted values echoed back, matching
        /kpi_config/set_daily_report. An empty template stores '' so the built-in
        default takes over again — the same "empty means default" convention as
        the OTP template, which is what makes Reset a one-liner.
        """
        if not self._wa_is_admin():
            return {'status': False, 'message': 'Not authorized.'}
        row = request.env['kpi.wa.group.event'].sudo()._row(params.get('event') or '')
        if not row:
            return {'status': False, 'message': 'Unknown event.'}
        if 'enabled' in params:
            row.enabled = bool(params.get('enabled'))
        if 'template' in params:
            row.template = (params.get('template') or '').strip() or False
        return {'status': True, 'event': row.event, 'enabled': row.enabled,
                'template': row.effective_template()}

    @http.route('/kpi_wa_group/test_event', type='json', auth='user', methods=['POST'], csrf=False)
    def wa_group_test_event(self, **params):
        """Post one event's wording to the group, filled with sample values.

        Works whether the event is switched on or off — checking the wording
        before turning something on is the whole point of a test button; the
        switch governs real traffic.
        """
        if not self._wa_is_admin():
            return {'status': False, 'message': 'Not authorized.'}
        jid = (request.env.company.kpi_wa_group_jid or '').strip()
        if not jid:
            return {'status': False, 'message': 'No group selected yet.'}
        # Same guard as /kpi_wa_group/test: the caller must name the destination
        # it is about to post to. This is a one-click send, once per event, into
        # a group that is only identified by an opaque id — exactly where that
        # check has to hold.
        if (params.get('confirm_jid') or '').strip() != jid:
            return {'status': False, 'needs_confirm': True, 'jid': jid,
                    'message': 'Confirm the destination before sending a test message.'}
        row = request.env['kpi.wa.group.event'].sudo()._row(params.get('event') or '')
        if not row:
            return {'status': False, 'message': 'Unknown event.'}
        from ..models.kpi_wa_group_event import PREVIEW_SAMPLES
        Event = request.env['kpi.wa.group.event'].sudo()
        body = Event.render(row.effective_template(), PREVIEW_SAMPLES)
        if not (body or '').strip():
            return {'status': False, 'message': 'That message is empty — nothing to send.'}
        # Marked as a test. An unannounced "✅ Task completed" for a task nobody
        # touched is worse than no test at all.
        body = "🧪 _Test message — no real activity._\n\n" + body
        try:
            ok = request.env['kpi.wa.group.report'].sudo()._post(body)
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning("wa_group_test_event: %s", exc)
            return {'status': False, 'message': str(exc)[:160] or exc.__class__.__name__}
        return {'status': bool(ok),
                'message': ('Test message dispatched. This gateway cannot confirm '
                            'delivery — open the group and check it arrived.') if ok
                           else 'The gateway refused the send — check the log.'}

    @http.route('/kpi_wa_group/test', type='json', auth='user', methods=['POST'], csrf=False)
    def wa_group_test(self, **params):
        """Post a test line to the configured group.

        The only way to prove the whole chain — JID, membership, and the @g.us
        send path — without waiting for someone to start their workday.
        """
        if not self._wa_is_admin():
            return {'status': False, 'message': 'Not authorized.'}
        # Config first, gateway second. "No group selected" is the actionable
        # message and needs no phone; checking the session first made both
        # failures report the same thing.
        jid = (request.env.company.kpi_wa_group_jid or '').strip()
        if not jid:
            return {'status': False, 'message': 'No group selected yet.'}
        # The caller must echo back the exact destination it is about to post to.
        # Enforced HERE rather than only in a dialog, because the damage this
        # prevents is real: a test message went into a live client group because
        # the destination was an opaque id nobody had confirmed. A client that
        # cannot name the group it is posting to does not get to post.
        confirm = (params.get('confirm_jid') or '').strip()
        if confirm != jid:
            return {'status': False, 'needs_confirm': True, 'jid': jid,
                    'message': 'Confirm the destination before sending a test message.'}
        session, err = self._wa_admin_or_refuse()
        if err:
            return {'status': False, 'message': err}
        # A refused group send returns False, but the send can also RAISE before it
        # gets that far: this route picks the session on the database `status`
        # column, while send_message looks the live client up in a per-process dict.
        # When those disagree — the usual case being a row left reading "connected"
        # after a restart — the user got a raw JSON-RPC error instead of the
        # friendly answer this handler exists to give.
        try:
            ok = session.send_message(
                jid, "✅ KRA/KPI is connected to this group.\n"
                     "Workday start and end reports will appear here.")
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning("wa_group_test send failed: %s", exc)
            # The gateway's own wording is the actionable part (usually "not
            # connected — scan the QR"). The class name is only a fallback for
            # failures from deeper inside neonize that carry no message at all.
            return {'status': False,
                    'message': str(exc)[:160] or exc.__class__.__name__}
        # Never claim delivery. This gateway cannot return a receipt (the send
        # succeeds but the reply does not parse), so "Sent." would be asserting
        # something we do not know — and the whole reason a test exists is that the
        # destination is an opaque id nobody can verify from inside Odoo.
        return {'status': bool(ok),
                'message': ('Message dispatched to %s. This gateway cannot confirm '
                            'delivery — open that group and check it arrived.' % jid)
                           if ok else
                           'The gateway refused the send — check the log.'}

    # ============================================================
    #         CLIENT PORTAL — SAVED SIGNATURE IMAGE
    # ============================================================

    @http.route('/kpi_client_portal/upload_signature', type='json', auth='user', methods=['POST'], csrf=False)
    def upload_user_signature(self, **params):
        """Upload the current user's saved signature image (used for sign-off auto-fill).

        Doubles as the delete: posting an empty file_data clears the image, which is
        what the portal's Remove button does. No separate route — the write below
        already resolves '' to False.
        """
        try:
            user = request.env.user
            updates = {}
            if 'file_data' in params:
                updates['kpi_signature_image'] = params['file_data'] or False
                updates['kpi_signature_image_name'] = params.get('file_name') or ''
            if updates:
                user.sudo().write(updates)
            return {
                'status': True,
                'has_signature': bool(user.kpi_signature_image),
                'file_name': user.kpi_signature_image_name or '',
            }
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"upload_user_signature: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_portal/get_signature_info', type='json', auth='user', methods=['POST'], csrf=False)
    def get_user_signature_info(self, **params):
        """Return info + base64 of the current user's saved signature image."""
        try:
            user = request.env.user
            raw = user.kpi_signature_image
            b64 = raw.decode() if isinstance(raw, bytes) else (raw or '')
            return {
                'status': True,
                'has_signature': bool(raw),
                'file_name': user.kpi_signature_image_name or '',
                'image_b64': b64,
                'user_name': user.name or user.login or '',
            }
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"get_user_signature_info: {str(e)}")
            return {'status': False, 'message': str(e), 'has_signature': False, 'image_b64': ''}

    # ============================================================
    #            DEVELOPER WORKDAY SESSIONS
    # ============================================================

    @http.route('/kpi_workday/status', type='json', auth='user', methods=['POST'], csrf=False)
    def workday_status(self, **params):
        """Read-only: does the current user have an OPEN session for today?
        Used by OWL onMounted to decide whether to show the green
        'Start Workday' button or the red 'End Workday' one.
        Returns: {status, is_open: bool, session_id, login_at, today_closed: bool}
        """
        try:
            user = request.env.user
            Session = request.env['kpi.work.session'].sudo()
            today = fields.Date.context_today(request.env.user)
            # Prefer the OPEN session so is_open stays correct even when a closed
            # (e.g. auto-closed, then restarted) session from earlier today exists.
            open_row = Session.search([
                ('user_id', '=', user.id),
                ('session_date', '=', today),
                ('state', '=', 'open'),
            ], limit=1)
            row = open_row or Session.search([
                ('user_id', '=', user.id),
                ('session_date', '=', today),
            ], limit=1)
            # day_done = developer ENDED today themselves → block restart (one
            # start + one end per day). today_closed kept for older clients.
            day_done = Session._day_done(user)
            return {
                'status':       True,
                'is_open':      bool(open_row),
                'today_closed': bool(row and row.state == 'closed' and not open_row),
                'day_done':     day_done,
                # Paused = open but frozen. The board needs both: is_open drives
                # Start vs End, is_paused drives Pause vs Resume and the banner.
                'is_paused':    bool(open_row and open_row.is_paused),
                'session_id':   row.id if row else False,
                'login_at':     fields.Datetime.to_string(row.login_at) if row and row.login_at else '',
                # If this day was reopened, who did it and why — but only while it is
                # still live. Once the developer has ended the day again (day_done),
                # the reopen has played out and the banner would just be stale text
                # about something already dealt with. The snapshot keeps its own frozen
                # copy, so nothing is lost by dropping it here.
                #
                # Read across today's sessions rather than the latest one: the reverted
                # session is the closed row, and after restarting the open row is a
                # different record entirely.
                'reopened_reason': '' if day_done else next(
                    (s.revert_reason or '' for s in Session.search([
                        ('user_id', '=', user.id), ('session_date', '=', today),
                    ]) if s.reverted and s.revert_reason), ''),
                'reopened_by': '' if day_done else next(
                    (s.reverted_by_id.name or '' for s in Session.search([
                        ('user_id', '=', user.id), ('session_date', '=', today),
                    ]) if s.reverted and s.reverted_by_id), ''),
            }
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"workday_status: {e}")
            return {'status': False, 'message': str(e), 'is_open': False}

    @http.route('/kpi_workday/ping', type='json', auth='user', methods=['POST'], csrf=False)
    def workday_ping(self, **params):
        """Open today's workday session for the current user if absent.
        Idempotent. Called from the green 'Start Workday' button when the
        developer explicitly clicks to start their day.
        Returns: {status, session_id, login_at, opened: bool}
        """
        try:
            user = request.env.user
            Session = request.env['kpi.work.session'].sudo()
            # One start + one end per day: don't reopen a workday already ended
            # today by the developer. (Auto-closed days can still restart.)
            if Session._day_done(user):
                return {'status': False, 'day_done': True,
                        'message': 'Workday already ended for today'}
            existed = Session.search([
                ('user_id', '=', user.id),
                ('session_date', '=', fields.Date.context_today(request.env.user)),
                ('state', '=', 'open'),
            ], limit=1)
            sess = Session._get_or_open_today(user=user)
            if sess.state == 'closed':
                # Defensive: the choke-point guard handed back a closed session
                # (day done) — never report it as an opened workday.
                return {'status': False, 'day_done': True,
                        'message': 'Workday already ended for today'}
            return {
                'status':     True,
                'session_id': sess.id,
                'login_at':   fields.Datetime.to_string(sess.login_at),
                'opened':     not bool(existed),
            }
        except ConcurrencyError:
            raise  # a parallel Start opened the session first: Odoo retries this
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"workday_ping: {e}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_workday/today_summary', type='json', auth='user', methods=['POST'], csrf=False)
    def workday_today_summary(self, **params):
        """Return today's payload (login time, totals, per-task array, Workday Map)
        for the current user. Used to render the End Workday modal.
        Auto-opens the session if missing so the modal works first time too.

        full_day=True to match action_end_day, which is what actually gets sent and
        saved. Without it this preview took login_at from the CURRENT session only
        while still pulling the whole day's breaks — so after a restart the Map
        showed earlier breaks BEFORE "Started workday", and the preview disagreed
        with the record. Same call, same day, same story.
        """
        try:
            user = request.env.user
            Session = request.env['kpi.work.session'].sudo()
            sess = Session._get_or_open_today(user=user)
            # Force re-compute so live presence reflects "now".
            sess.invalidate_recordset(['productive_seconds', 'presence_seconds',
                                       'task_count'])
            payload = sess._daily_summary_payload(full_day=True)
            payload['status'] = True
            # Does ending the day post to a WhatsApp group, and is the note part
            # of it? The End Workday dialog asks for that note, so it has to be
            # able to say where it goes. Reported as a fact about the current
            # configuration, never assumed — if no group is set, or the event is
            # switched off, the app must not claim otherwise.
            try:
                Event = request.env['kpi.wa.group.event'].sudo()
                payload['wa_group_name'] = (
                    request.env.company.kpi_wa_group_name
                    or request.env.company.kpi_wa_group_jid or '')
                payload['wa_group_end_posts'] = bool(
                    (request.env.company.kpi_wa_group_jid or '').strip()
                    and Event.is_enabled('workday_end'))
            except Exception:
                payload['wa_group_name'] = ''
                payload['wa_group_end_posts'] = False
            # Which of today's tasks have no progress note yet. Carried on THIS
            # payload rather than fetched separately because the End Workday modal
            # already waits on this call — the check costs nothing extra.
            #
            # REQUIRED: /kpi_workday/end refuses while any of these has no summary.
            try:
                payload['missing_progress'] = Session._tasks_missing_progress_today(user=user)
            except Exception as exc:
                # A broken warning must not stop someone ending their day.
                import logging
                logging.getLogger(__name__).warning("missing_progress failed: %s", exc)
                payload['missing_progress'] = []
            # "What did you work on today?" -- filled from today's task summaries
            # (task in bold, what was written under it), not typed.
            try:
                ids = [t.get('kpi_id') for t in (payload.get('tasks') or []) if t.get('kpi_id')]
                blocks = Session._today_work_blocks(user, ids)
                payload['work_blocks'] = [{'head': h, 'lines': lines} for h, lines in blocks]
                payload['work_note'] = Session._today_work_note(blocks)
            except Exception:
                payload['work_blocks'], payload['work_note'] = [], ''
            return payload
        except ConcurrencyError:
            raise  # see workday_ping
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"workday_today_summary: {e}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_workday/idle_reason', type='json', auth='user', methods=['POST'], csrf=False)
    def workday_idle_reason(self, **params):
        """The developer says why nothing is running: meeting | break | no_tasks.

        Reached two ways — the 10-min prompt, or the board's status button (so a
        09:31 meeting can be declared at 09:31 rather than waiting to be asked).

        ALL THREE open a non-task block, so the time lands on the Workday Map
        instead of silently becoming "unexplained idle". They differ only in who
        gets told:
          meeting/break → admins hear NOTHING. A meeting is not a problem, and
                          telling them would be the false alarm that makes the
                          whole feed worth ignoring.
          no_tasks      → admins told straight away; that one IS theirs to fix.

        `no_tasks` records time TOO (it used to record nothing): a developer with
        nothing assigned would otherwise look identical to one who is slacking —
        untrue, and unfair to them.

        `note` is optional free text, clamped to NOTE_MAX here because a client
        maxLength is a courtesy, not a guarantee, and this text has to fit in a
        Workday Map chip.
        """
        try:
            reason = (params.get('reason') or '').strip().lower()
            if reason not in NONTASK_REASON_CODES:
                return {'status': False, 'message': 'Invalid reason.'}
            note = (params.get('note') or '').strip()[:NOTE_MAX]
            # Who the meeting is with. Validated on the MODEL rather than here,
            # because the task-pause twin of this check lives on a different
            # controller class that this route cannot reach — see
            # kpi.nontask.block.clean_meeting_user_ids. Returns False (not an
            # empty list) for a malformed payload, hence the `is False` test.
            meeting_with_ids = request.env['kpi.nontask.block'].sudo().clean_meeting_user_ids(
                reason, params.get('meeting_with_ids'))
            if meeting_with_ids is False:
                return {'status': False, 'message': 'Invalid meeting participants.'}
            user = request.env.user
            sess = request.env['kpi.work.session'].sudo()._get_or_open_today(user=user)

            # All the switching/idempotency rules live on the model so they can be
            # probed from an Odoo shell — a controller-side copy could only be tested
            # by re-implementing it, which tests the copy and not the code.
            res = sess._set_nontask_reason(reason, note=note, meeting_with_ids=meeting_with_ids)

            return {'status': True, 'reason': reason, 'note': note,
                    'admins_notified': res['admins_notified'],
                    # What this tap ENDED, so the client can say "Meeting saved".
                    'switched_from': res['switched_from'],
                    'started_at': (sess.nontask_started_at.strftime('%Y-%m-%d %H:%M:%S')
                                   if sess.nontask_started_at else '')}
        except ConcurrencyError:
            raise  # see workday_ping
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"workday_idle_reason: {e}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_workday/end_nontask', type='json', auth='user', methods=['POST'], csrf=False)
    def workday_end_nontask(self, **params):
        """Close the open Meeting/Break block ([End] on the board pill).

        Starting a task closes it automatically (see kra.kpi.start_task); this is
        for the case a task ISN'T started next — e.g. the meeting ends and they
        still have nothing to work on. `ask_again` tells the app to re-open the
        same popup, so 'I have no tasks' is one tap rather than a 10-min wait.
        """
        try:
            user = request.env.user
            sess = request.env['kpi.work.session'].sudo()._get_or_open_today(user=user)
            closed = sess._close_nontask_block()
            return {'status': True, 'closed': closed,
                    'ask_again': not sess._has_running_task()}
        except ConcurrencyError:
            raise  # see workday_ping
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"workday_end_nontask: {e}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_workday/pause', type='json', auth='user', methods=['POST'], csrf=False)
    def workday_pause(self, **params):
        """Freeze today's workday: stop running tasks, stop accruing Presence.

        Scoped to the caller's own session — no id in the payload, so it cannot
        be aimed at anybody else's day.
        """
        try:
            sess = request.env['kpi.work.session'].sudo().search([
                ('user_id', '=', request.env.user.id),
                ('session_date', '=', fields.Date.context_today(request.env.user)),
                ('state', '=', 'open'),
            ], limit=1)
            if not sess:
                return {'status': False, 'message': 'You have no open workday to pause.'}
            return sess.action_pause_workday(note=(params.get('note') or '').strip())
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"workday_pause: {e}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_workday/resume', type='json', auth='user', methods=['POST'], csrf=False)
    def workday_resume(self, **params):
        """Un-freeze today's workday. Presence counts again from now."""
        try:
            sess = request.env['kpi.work.session'].sudo().search([
                ('user_id', '=', request.env.user.id),
                ('session_date', '=', fields.Date.context_today(request.env.user)),
                ('state', '=', 'open'),
            ], limit=1)
            if not sess:
                return {'status': False, 'message': 'You have no open workday to resume.'}
            return sess.action_resume_workday()
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"workday_resume: {e}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_workday/end', type='json', auth='user', methods=['POST'], csrf=False)
    def workday_end(self, **params):
        """Close today's session, fire the WhatsApp summary, return the payload.
        Idempotent: if already closed, returns the existing payload.
        """
        try:
            user = request.env.user
            Session = request.env['kpi.work.session'].sudo()
            sess = Session._get_or_open_today(user=user)
            # Clamp only. This route must NEVER refuse to end a workday over the note:
            # ending the day is one-way, and a stale app plus a strict server would leave
            # someone unable to close their own day. The "say something real" rule lives
            # in the clients (utils/workdayNote.js and the End Workday dialog), where a
            # failed check can be corrected. Here we only stop an unbounded write —
            # kpi_work_session.note is TEXT, so this is a sanity bound, not a limit
            # anyone types up against.
            note = (params.get('note') or '').strip()[:WORKDAY_NOTE_MAX]
            # A summary for every task worked today is REQUIRED before the day
            # ends (web, Odoo board, app and WhatsApp all ask for it; this is the
            # rule they share). Only for a day still open -- re-ending a closed
            # one stays idempotent -- and the midnight auto-close does not come
            # through here, so a forgotten day is still closed.
            if sess.state == 'open':
                missing = Session._tasks_missing_progress_today(user=user)
                if missing:
                    return {
                        'status': False, 'missing_progress': missing,
                        'message': 'Add a summary for each task you worked on today — the day ends '
                                   'only after that: %s' % ', '.join(
                                       m.get('external_ref') or m.get('name') or '' for m in missing),
                    }
            # The day's note is made from today's task summaries (what the End
            # Workday box shows); a typed note is only used if there are none.
            try:
                d = sess._daily_summary_payload(full_day=True)
                ids = [t.get('kpi_id') for t in (d.get('tasks') or []) if t.get('kpi_id')]
                auto = Session._today_work_note(Session._today_work_blocks(user, ids))
            except Exception:
                auto = ''
            payload = sess.action_end_day(note=(auto or note)[:WORKDAY_NOTE_MAX])
            payload['status'] = True
            return payload
        except ConcurrencyError:
            raise  # see workday_ping
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"workday_end: {e}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_workday/revert', type='json', auth='user', methods=['POST'], csrf=False)
    def workday_revert(self, **params):
        """Admin reopens a workday that was explicitly ended today.

        params: user_id (optional — defaults to the caller), reason (optional).
        The model method owns every rule, including the admin check; this only
        resolves which session is meant.
        """
        try:
            Session = request.env['kpi.work.session'].sudo()
            try:
                target_uid = int(params.get('user_id') or request.env.user.id)
            except (TypeError, ValueError):
                return {'status': False, 'message': 'Invalid developer.'}
            # _ended_session_today is the same helper that decides "day done", so
            # revert can only ever undo exactly what that reports — the two can't
            # disagree about which session is the one that ended the day.
            sess = Session._ended_session_today(
                user=request.env['res.users'].sudo().browse(target_uid))
            if not sess:
                return {'status': False,
                        'message': 'No ended workday to reopen for today.'}
            return sess.action_revert_day(reason=params.get('reason') or '')
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"workday_revert: {e}")
            return {'status': False, 'message': str(e)}

    # ------------------------------------------------------------------ #
    # Workday Snapshots — the frozen End-Workday images, for admins       #
    # ------------------------------------------------------------------ #
    def _snapshot_admin_ok(self):
        """Admin/coordinator/owner/system only. The same triple the other admin
        screens use. Snapshots are a record of someone's day — a developer must
        not be able to read a colleague's."""
        user = request.env.user
        return (user.has_group('kra_kpi_module.group_kra_admin')
                or user.has_group('kra_kpi_module.group_kra_owner')
                or user.has_group('base.group_system'))

    @http.route('/kpi_workday_snapshot/list', type='json', auth='user', methods=['POST'], csrf=False)
    def workday_snapshot_list(self, **params):
        """Snapshots grouped date -> developers, for the admin screen's
        date ▸ developer ▸ image tree.

        Deliberately carries NO image bytes: the tree can hold weeks of days and a
        base64 PNG per row would be megabytes of JSON for pictures nobody has
        opened yet. The client pulls one image only when a row is expanded.

        params: limit_days (default 30) — how many recent days to return.
        """
        try:
            if not self._snapshot_admin_ok():
                return {'status': False, 'message': 'Not authorized.'}
            limit_days = max(1, min(365, int(params.get('limit_days') or 30)))
            Snap = request.env['kpi.workday.snapshot'].sudo()
            rows = Snap.search([], order='session_date desc, id desc')

            days, seen = [], {}
            for r in rows:
                key = str(r.session_date)
                if key not in seen:
                    if len(days) >= limit_days:
                        continue
                    seen[key] = {'date': key, 'label': r.session_date.strftime('%d %b %Y'),
                                 'devs': []}
                    days.append(seen[key])
                seen[key]['devs'].append({
                    'snapshot_id': r.id,
                    'user_id': r.user_id.id,
                    'name': r.user_id.name or r.user_id.login or '—',
                    'presence_display': _fmt_hms(r.presence_seconds or 0),
                    'productive_display': _fmt_hms(r.productive_seconds or 0),
                    'standard_hours': r.standard_hours or 0.0,
                    # Frozen on the row, NOT recomputed: the standard may change
                    # later, and this day was judged against the rule of its time.
                    'met_standard': bool(r.met_standard),
                    'task_count': r.task_count or 0,
                    # What they wrote when they ended the day. The numbers say how long
                    # the day was; only this says what it was spent on.
                    'note': r.note or '',
                    # Why an admin reopened this day, if they did.
                    'reopen_reason': r.reopen_reason or '',
                    'reopened_by': r.reopened_by_id.name or '',
                    'reopened_at': (fields.Datetime.to_string(r.reopened_at)
                                    if r.reopened_at else ''),
                    'reopened_at_display': _snapshot_ts(r.reopened_at),
                    'image_name': r.image_name or 'workday.png',
                    'generated_at': (fields.Datetime.to_string(r.generated_at)
                                     if r.generated_at else ''),
                    'generated_at_display': _snapshot_ts(r.generated_at),
                })
            return {'status': True, 'days': days}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"workday_snapshot_list: {e}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_workday_snapshot/image_b64', type='json', auth='user', methods=['POST'], csrf=False)
    def workday_snapshot_image_b64(self, **params):
        """One snapshot's PNG as base64 — the APP's path.

        The app CANNOT use /web/image or any type='http' URL: React Native's image
        loader sends no session cookie, so it silently lands on the login page and
        renders nothing (the same trap documented on /kpi/progress/file_b64). The
        web board uses /web/image directly and doesn't need this.
        """
        try:
            if not self._snapshot_admin_ok():
                return {'status': False, 'message': 'Not authorized.'}
            sid = int(params.get('snapshot_id') or 0)
            rec = request.env['kpi.workday.snapshot'].sudo().browse(sid)
            if not rec.exists() or not rec.image:
                return {'status': False, 'message': 'Snapshot not found.'}
            data = rec.image
            if isinstance(data, bytes):
                data = data.decode()
            return {'status': True, 'data_b64': data, 'mimetype': 'image/png',
                    'file_name': rec.image_name or 'workday.png',
                    'dev': rec.user_id.name or '', 'date': str(rec.session_date),
                    'presence_display': _fmt_hms(rec.presence_seconds or 0),
                    'met_standard': bool(rec.met_standard)}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"workday_snapshot_image_b64: {e}")
            return {'status': False, 'message': str(e)}

    # ------------------------------------------------------------------ #
    # My Snapshots — the CURRENT user's OWN End-Workday images (self only) #
    # ------------------------------------------------------------------ #
    @http.route('/kpi_workday_snapshot/my_list', type='json', auth='user', methods=['POST'], csrf=False)
    def my_workday_snapshot_list(self, **params):
        """The logged-in user's OWN workday snapshots — no admin gate.

        HARD-SCOPED to request.env.user: the domain is fixed to this user's id and
        NO user_id is ever read from params, so a developer can only ever see their
        own days. Same shape as /kpi_workday_snapshot/list (date ▸ [details] ▸ image)
        so the app screen is reused unchanged.
        """
        try:
            uid = request.env.user.id
            limit_days = max(1, min(365, int(params.get('limit_days') or 30)))
            Snap = request.env['kpi.workday.snapshot'].sudo()
            rows = Snap.search([('user_id', '=', uid)], order='session_date desc, id desc')
            name = request.env.user.name or request.env.user.login or 'You'
            days, seen = [], {}
            for r in rows:
                key = str(r.session_date)
                if key not in seen:
                    if len(days) >= limit_days:
                        continue
                    seen[key] = {'date': key, 'label': r.session_date.strftime('%d %b %Y'),
                                 'devs': []}
                    days.append(seen[key])
                seen[key]['devs'].append({
                    'snapshot_id': r.id,
                    'user_id': r.user_id.id,
                    'name': name,
                    'presence_display': _fmt_hms(r.presence_seconds or 0),
                    'productive_display': _fmt_hms(r.productive_seconds or 0),
                    'standard_hours': r.standard_hours or 0.0,
                    'met_standard': bool(r.met_standard),
                    'task_count': r.task_count or 0,
                    # What they wrote when they ended the day. The numbers say how long
                    # the day was; only this says what it was spent on.
                    'note': r.note or '',
                    # Why an admin reopened this day, if they did.
                    'reopen_reason': r.reopen_reason or '',
                    'reopened_by': r.reopened_by_id.name or '',
                    'reopened_at': (fields.Datetime.to_string(r.reopened_at)
                                    if r.reopened_at else ''),
                    'reopened_at_display': _snapshot_ts(r.reopened_at),
                    'image_name': r.image_name or 'workday.png',
                    'generated_at': (fields.Datetime.to_string(r.generated_at)
                                     if r.generated_at else ''),
                    'generated_at_display': _snapshot_ts(r.generated_at),
                })
            return {'status': True, 'days': days}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"my_workday_snapshot_list: {e}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_workday_snapshot/my_image_b64', type='json', auth='user', methods=['POST'], csrf=False)
    def my_workday_snapshot_image_b64(self, **params):
        """One of the CURRENT user's OWN snapshot images. Ownership is verified
        server-side (rec.user_id must equal the caller) so a developer can never
        pull a colleague's image by guessing an id."""
        try:
            sid = int(params.get('snapshot_id') or 0)
            rec = request.env['kpi.workday.snapshot'].sudo().browse(sid)
            if not rec.exists() or rec.user_id.id != request.env.user.id or not rec.image:
                return {'status': False, 'message': 'Snapshot not found.'}
            data = rec.image
            if isinstance(data, bytes):
                data = data.decode()
            return {'status': True, 'data_b64': data, 'mimetype': 'image/png',
                    'file_name': rec.image_name or 'workday.png',
                    'dev': rec.user_id.name or '', 'date': str(rec.session_date),
                    'presence_display': _fmt_hms(rec.presence_seconds or 0),
                    'met_standard': bool(rec.met_standard)}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"my_workday_snapshot_image_b64: {e}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_reports/developer_summary', type='json', auth='user', methods=['POST'], csrf=False)
    def developer_summary_report(self, **params):
        """Daily / weekly / monthly per-developer report (coord+owner only).

        params:
          time_frame: 'daily' | 'weekly' | 'monthly'  (default 'daily')
          user_id:    optional — filter to one developer
          from_date / to_date: optional ISO dates (defaults derived from time_frame)
        Returns:
          {status, time_frame, periods:[{period_key, label, productive_seconds,
                                          presence_seconds, task_count, sessions:[...],
                                          tasks:[{ref,name,duration_seconds,duration_display}]}]}
        """
        try:
            user = request.env.user
            allowed = (
                user.has_group('kra_kpi_module.group_kra_admin')
                or user.has_group('kra_kpi_module.group_kra_owner')
                or user.has_group('base.group_system')
            )
            if not allowed:
                return {'status': False, 'message': 'Not authorized.'}

            import datetime as _dt
            time_frame = (params.get('time_frame') or 'daily').lower()
            if time_frame not in ('daily', 'weekly', 'monthly'):
                time_frame = 'daily'
            today = fields.Date.context_today(user)
            defaults = {
                'daily':   today - _dt.timedelta(days=30),
                'weekly':  today - _dt.timedelta(weeks=12),
                'monthly': today - _dt.timedelta(days=180),
            }
            from_date = params.get('from_date')
            to_date   = params.get('to_date')
            from_date = fields.Date.from_string(from_date) if from_date else defaults[time_frame]
            to_date   = fields.Date.from_string(to_date) if to_date else today
            uid_filter = int(params.get('user_id')) if params.get('user_id') else None

            Session = request.env['kpi.work.session'].sudo()
            Log     = request.env['kpi.time.log'].sudo()
            dom_sess = [
                ('session_date', '>=', from_date),
                ('session_date', '<=', to_date),
            ]
            if uid_filter:
                dom_sess.append(('user_id', '=', uid_filter))
            sessions = Session.search(dom_sess, order='session_date asc, login_at asc')

            # Bucket sessions by (user, period_key).
            def _period_key(d):
                if time_frame == 'daily':
                    return (d.isoformat(),    d.strftime('%a %d %b %Y'))
                if time_frame == 'weekly':
                    iso = d.isocalendar()
                    return (f"{iso[0]}-W{iso[1]:02d}", f"Week {iso[1]} of {iso[0]}")
                # monthly
                return (d.strftime('%Y-%m'), d.strftime('%B %Y'))

            from collections import defaultdict
            bucket = defaultdict(lambda: {
                'productive_seconds': 0.0, 'presence_seconds': 0.0,
                'paused_seconds': 0.0,
                'task_count': 0, 'sessions': [], 'tasks': {}, 'user_name': '',
            })
            for s in sessions:
                key, label = _period_key(s.session_date)
                slot_id = (s.user_id.id, key)
                slot = bucket[slot_id]
                # Presence is time at work, so a week with 15h of deliberate
                # pauses has already had those 15h taken off it. Paused is carried
                # alongside anyway: it is what reconstructs the raw clock
                # (presence + paused) for anyone reconciling against rostered
                # hours, and it is what explains a short week.
                s_paused = s._paused_total()
                slot['productive_seconds'] += float(s.productive_seconds or 0.0)
                slot['presence_seconds']   += float(s.presence_seconds or 0.0)
                slot['paused_seconds']     += s_paused
                slot['user_name']           = s.user_id.name or s.user_id.login or '—'
                slot['label']               = label
                slot['period_key']          = key
                slot['user_id']             = s.user_id.id
                slot['sessions'].append({
                    'session_id':         s.id,
                    'session_date':       str(s.session_date),
                    'login_at':           fields.Datetime.to_string(s.login_at),
                    'logout_at':          fields.Datetime.to_string(s.logout_at) if s.logout_at else '',
                    'productive_seconds': float(s.productive_seconds or 0.0),
                    'presence_seconds':   float(s.presence_seconds or 0.0),
                    'paused_seconds':     s_paused,
                    'task_count':         int(s.task_count or 0),
                    'auto_closed':        bool(s.auto_closed),
                })

            # Per-period per-task drill-down (uses kpi.time.log directly so we
            # don't depend on session row existence — e.g. for legacy logs).
            dom_log = [
                ('work_date', '>=', from_date),
                ('work_date', '<=', to_date),
                ('is_active', '=', False),
            ]
            if uid_filter:
                dom_log.append(('user_id', '=', uid_filter))
            for log in Log.search(dom_log):
                key, _ = _period_key(log.work_date)
                slot_id = (log.user_id.id, key)
                slot = bucket[slot_id]
                if not slot.get('label'):
                    # Log without a session row (legacy) — synthesise.
                    slot['user_name']  = log.user_id.name or log.user_id.login or '—'
                    slot['label']      = _period_key(log.work_date)[1]
                    slot['period_key'] = key
                    slot['user_id']    = log.user_id.id
                k = log.kpi_id
                if not k:
                    continue
                tkey = k.id
                if tkey not in slot['tasks']:
                    slot['tasks'][tkey] = {
                        'kpi_id':           k.id,
                        'ref':              k.external_ref or f"#{k.id}",
                        'name':             k.name or '',
                        'duration_seconds': 0.0,
                    }
                slot['tasks'][tkey]['duration_seconds'] += float(log.duration_seconds or 0.0)

            # Running (is_active=True) logs carry a STORED duration of 0 — end_time
            # is unset — so their time is invisible to both the session
            # productive_seconds and the finished-log drill-down above. Add it live
            # (now - start_time) so the rolling total ticks WITH the running task
            # instead of freezing until the developer pauses, and the task shows
            # its real elapsed time rather than 0s. Active logs are at most ~one per
            # logged-in developer, so the unbounded search is cheap.
            now = fields.Datetime.now()
            dom_active = [('is_active', '=', True)]
            if uid_filter:
                dom_active.append(('user_id', '=', uid_filter))
            for log in Log.search(dom_active):
                wd = log.work_date
                if not log.start_time or not wd or wd < from_date or wd > to_date:
                    continue
                live_secs = max(0.0, (now - log.start_time).total_seconds())
                key, _ = _period_key(wd)
                slot_id = (log.user_id.id, key)
                slot = bucket[slot_id]
                if not slot.get('label'):
                    slot['user_name']  = log.user_id.name or log.user_id.login or '—'
                    slot['label']      = _period_key(wd)[1]
                    slot['period_key'] = key
                    slot['user_id']    = log.user_id.id
                slot['productive_seconds'] += live_secs
                k = log.kpi_id
                if not k:
                    continue
                tkey = k.id
                if tkey not in slot['tasks']:
                    slot['tasks'][tkey] = {
                        'kpi_id':           k.id,
                        'ref':              k.external_ref or f"#{k.id}",
                        'name':             k.name or '',
                        'duration_seconds': 0.0,
                        'running':          False,
                    }
                slot['tasks'][tkey]['duration_seconds'] += live_secs
                slot['tasks'][tkey]['running'] = True

            # Flatten + sort.
            def _fmt(secs):
                s = int(secs or 0)
                h, rem = divmod(s, 3600)
                m = rem // 60
                if h and m:
                    return f"{h}h {m}m"
                if h:
                    return f"{h}h"
                return f"{m}m"

            periods = []
            for (uid, key), slot in bucket.items():
                tasks = []
                for t in sorted(slot['tasks'].values(),
                                key=lambda x: -x['duration_seconds']):
                    tasks.append({**t,
                                  'duration_display': _fmt(t['duration_seconds'])})
                periods.append({
                    'period_key':          slot.get('period_key', key),
                    'label':               slot.get('label', key),
                    'user_id':             uid,
                    'user_name':           slot.get('user_name', ''),
                    'productive_seconds':  slot['productive_seconds'],
                    'presence_seconds':    slot['presence_seconds'],
                    'paused_seconds':      slot['paused_seconds'],
                    'productive_display':  _fmt(slot['productive_seconds']),
                    'presence_display':    _fmt(slot['presence_seconds']),
                    'paused_display':      _fmt(slot['paused_seconds']),
                    'task_count':          len(tasks),
                    'sessions':            slot['sessions'],
                    'tasks':               tasks,
                })
            # Sort by user then period_key desc (most recent first).
            periods.sort(key=lambda p: (p['user_name'], p['period_key']), reverse=False)
            return {
                'status':     True,
                'time_frame': time_frame,
                'from_date':  str(from_date),
                'to_date':    str(to_date),
                'periods':    periods,
            }
        except Exception as e:
            import logging, traceback
            logging.getLogger(__name__).error(f"developer_summary_report: {e}\n{traceback.format_exc()}")
            return {'status': False, 'message': str(e)}

    # ============================================================
    #     EMPLOYEE TRACKER — live board + granular action log
    # ============================================================

    @http.route('/kpi_owner/live_board', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_owner_live_board(self, **params):
        """Live 'who is working on what right now' board for the Admin Dashboard.

        Iterates today's OPEN work sessions (people who started their workday),
        joins the active time-log (is_active=True) to get each developer's current
        task + live elapsed, and marks the row ACTIVE vs present-but-idle by
        last_heartbeat freshness (company.away_after_minutes — the same signal the
        auto-away cron uses). Owner / Coordinator / System only, matching the
        Employee Tracker report gate.
        """
        user = request.env.user
        allowed = (
            user.has_group('kra_kpi_module.group_kra_admin')
            or user.has_group('kra_kpi_module.group_kra_owner')
            or user.has_group('base.group_system')
        )
        if not allowed:
            return {'status': False, 'message': 'Not authorized.'}
        try:
            Session = request.env['kpi.work.session'].sudo()
            Log = request.env['kpi.time.log'].sudo()
            now = fields.Datetime.now()
            today = fields.Date.context_today(user)
            try:
                away_min = max(1, int(request.env.company.away_after_minutes or 5))
            except Exception:
                away_min = 5
            stale_cutoff = now - timedelta(minutes=away_min)

            open_sessions = Session.search([
                ('session_date', '=', today),
                ('state', '=', 'open'),
            ], order='login_at asc')

            rows = []
            for s in open_sessions:
                u = s.user_id
                active_log = Log.search([
                    ('user_id', '=', u.id),
                    ('is_active', '=', True),
                ], limit=1)
                task = active_log.kpi_id if active_log else False
                hb = s.last_heartbeat
                is_active_now = bool(hb and hb >= stale_cutoff)  # heartbeat fresh = at the desk
                elapsed = 0
                if active_log and active_log.start_time:
                    elapsed = max(0, int((now - active_log.start_time).total_seconds()))
                rows.append({
                    'user_id':         u.id,
                    'user_name':       u.name or u.login or '—',
                    'login_raw':       (s.login_at.isoformat() + 'Z') if s.login_at else False,
                    'active':          is_active_now,
                    'on_task':         bool(task),
                    'task_id':         task.id if task else False,
                    'task_ref':        (task.external_ref or f"#{task.id}") if task else '',
                    'task_name':       task.name if task else '',
                    'task_state':      task.task_state if task else '',
                    # ISO+Z so the client ticks it with the same helper it uses for a
                    # running task (see live_status) and stays in sync with the server clock.
                    'task_start_raw':  (active_log.start_time.isoformat() + 'Z') if (active_log and active_log.start_time) else False,
                    'elapsed_seconds': elapsed,
                    'elapsed_display': _fmt_hms(elapsed),
                })
            return {
                'status':             True,
                'as_of':              fields.Datetime.to_string(now),
                'away_after_minutes': away_min,
                'present_count':      len(rows),
                'active_count':       sum(1 for r in rows if r['active']),
                'on_task_count':      sum(1 for r in rows if r['on_task']),
                'rows':               rows,
            }
        except Exception as e:
            import logging, traceback
            logging.getLogger(__name__).error(f"kpi_owner_live_board: {e}\n{traceback.format_exc()}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_owner/live_tracking', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_owner_live_tracking(self, **params):
        """Admin LIVE TRACKING: every developer's current activity + attendance.

        For the full developer roster (owners/coordinators/system excluded — they
        imply the developer group), returns per person what they are doing RIGHT
        NOW — running task + live elapsed / active break / lunch / meeting / idle /
        offline — and today's attendance (present / late-with-arrival / absent /
        pending), judged against a configurable local cutoff
        (company.attendance_cutoff_hour, default 10:40). Owner / Coordinator /
        System only.
        """
        import pytz
        from datetime import datetime as _dt, time as _time, timedelta as _td
        user = request.env.user
        if not self._is_owner_admin():
            return {'status': False, 'message': 'Not authorized.'}
        try:
            Session = request.env['kpi.work.session'].sudo()
            Log = request.env['kpi.time.log'].sudo()
            Break = request.env['kpi.break.log'].sudo()
            now = fields.Datetime.now()
            today = fields.Date.context_today(user)
            try:
                away_min = max(1, int(request.env.company.away_after_minutes or 5))
            except Exception:
                away_min = 5
            stale_cutoff = now - _td(minutes=away_min)

            # Local attendance cutoff (default 10:40 IST) -> naive-UTC for a direct
            # compare against the naive-UTC login_at.
            tz = pytz.timezone(user.tz or 'Asia/Kolkata')
            try:
                cut = float(request.env.company.attendance_cutoff_hour or 10.667)
            except Exception:
                cut = 10.667
            ch = int(cut)
            cm = int(round((cut - ch) * 60))
            if cm >= 60:
                ch, cm = ch + 1, 0
            ch = min(max(ch, 0), 23)
            cm = min(max(cm, 0), 59)
            cutoff_local = tz.localize(_dt.combine(today, _time(ch, cm)))
            cutoff_utc = cutoff_local.astimezone(pytz.UTC).replace(tzinfo=None)
            past_cutoff = now > cutoff_utc

            break_sel = dict(Break._fields['break_type'].selection)
            nontask_sel = dict(Session._fields['nontask_reason'].selection)

            # Roster = pure developers only. owner->admin->developer implies down, so
            # exclude the admin tiers + system to keep admins out of the roster.
            devs = request.env.ref('kra_kpi_module.group_kra_developer').sudo().user_ids.filtered(
                lambda u: u.active and not u.share and u.kpi_app_login_enabled
                and not u.has_group('kra_kpi_module.group_kra_admin')
                and not u.has_group('base.group_system'))
            # ...plus admins who clock in themselves. Leaving every admin out hid an
            # admin who had started their workday entirely, while a day's attendance
            # was being read off this screen. Only those with a workday in the last
            # 30 days: an admin who never uses the workday must not show as Absent
            # every single day.
            recent = Session.search([
                ('session_date', '>=', today - _td(days=30)),
                ('user_id', 'not in', devs.ids),
            ]).mapped('user_id')
            devs |= recent.filtered(lambda u: u.active and not u.share and u.id != 1)

            ROLE_LABEL = {'developer': 'Developer', 'coordinator': 'Coordinator',
                          'admin': 'Admin', 'client': 'Client'}
            Kpi = request.env['kra.kpi'].sudo()
            # Up to three of a person's tasks for their card, most pressing
            # first: running, paused, to do, waiting approval, then done this week.
            RANK = {'in_progress': (0, 'running'), 'paused': (1, 'paused'),
                    'rework': (2, 'todo'), 'hold': (2, 'todo'), 'assigned': (2, 'todo'),
                    'urgent': (2, 'todo'), 'important': (2, 'todo'), 'regular': (2, 'todo'),
                    'pre_approval_approved': (2, 'todo'),
                    'partially_completed': (3, 'approval'), 'awaiting_client': (3, 'approval')}
            week_from_utc = tz.localize(_dt.combine(today - _td(days=today.weekday()), _time.min)) \
                .astimezone(pytz.UTC).replace(tzinfo=None)

            code_sel = dict(Kpi._fields['pause_reason_code'].selection or [])
            TimeLog = request.env['kpi.time.log'].sudo()

            def _pause_info(t):
                """Why and when a paused task stopped -- what the task card in
                the app shows. The typed reason wins over the picked code; the
                time is the end of the task's last timer interval."""
                reason = (t.paused_reason or '').strip() or code_sel.get(t.pause_reason_code, '')
                last = TimeLog.search([('kpi_id', '=', t.id), ('end_time', '!=', False)],
                                      order='end_time desc', limit=1)
                at = pytz.UTC.localize(last.end_time).astimezone(tz).strftime('%H:%M') if last else ''
                return {'reason': reason, 'at': at}

            def _top_tasks(u):
                rows_ = Kpi.search([('user_id', '=', u.id), ('task_state', 'in', list(RANK))],
                                   order='write_date desc', limit=30)
                picked = sorted(rows_, key=lambda t: RANK[t.task_state][0])[:3]
                out = [dict({'id': t.id, 'ref': t.external_ref or '', 'name': t.name or '',
                             'state': RANK[t.task_state][1]},
                            **(_pause_info(t) if t.task_state == 'paused' else {}))
                       for t in picked]
                if len(out) < 3:
                    done = Kpi.search([('user_id', '=', u.id), ('task_state', '=', 'completed'),
                                       ('write_date', '>=', week_from_utc)],
                                      order='write_date desc', limit=3 - len(out))
                    out += [{'id': t.id, 'ref': t.external_ref or '', 'name': t.name or '', 'state': 'done'}
                            for t in done]
                return out

            rows = []
            for u in devs.sorted(lambda x: (x.name or x.login or '').lower()):
                sessions = Session.search(
                    [('user_id', '=', u.id), ('session_date', '=', today)], order='login_at asc')
                logins = [s.login_at for s in sessions if s.login_at]
                first_login = min(logins) if logins else False
                open_sess = sessions.filtered(lambda s: s.state == 'open')[:1]

                # ---- attendance ----
                if first_login:
                    attendance = 'late' if first_login > cutoff_utc else 'present'
                    arrival = pytz.UTC.localize(first_login).astimezone(tz).strftime('%H:%M')
                else:
                    attendance = 'absent' if past_cutoff else 'pending'
                    arrival = ''

                # ---- current activity (only meaningful with an open session) ----
                activity_kind, activity_label, elapsed, active_flag = 'offline', '', 0, False
                # What the developer typed when they said why they were away. Both the
                # break log and the non-task block have carried a note all along and
                # neither was ever shown — so Live Tracking could say "Lunch" but not
                # "Lunch — back by 2, dentist", which is the half an admin actually
                # wants before deciding whether to chase someone.
                activity_note = ''
                active_tasks = []
                paused_task, break_start = None, ''
                if open_sess:
                    s = open_sess
                    active_flag = bool(s.last_heartbeat and s.last_heartbeat >= stale_cutoff)
                    # A developer with kpi_allow_multitask can have several timers
                    # running at once. This searched limit=1 with no order, so it
                    # picked one of them arbitrarily and the rest were invisible to
                    # whoever was watching the board — the whole point of which is
                    # seeing what people are actually doing. Ordered and unbounded
                    # now, shaped like kra.kpi.work.session.live_status so both
                    # live views agree: `active_tasks` is the full list, and the
                    # scalar fields stay the first task for older app builds.
                    active_logs = Log.search([('user_id', '=', u.id), ('is_active', '=', True)],
                                             order='start_time asc')
                    brk = Break.search([('user_id', '=', u.id), ('is_active', '=', True)], limit=1)
                    running_logs = [l for l in active_logs if l.kpi_id]
                    if running_logs:
                        for lg in running_logs:
                            t = lg.kpi_id
                            secs = max(0, int((now - lg.start_time).total_seconds())) if lg.start_time else 0
                            active_tasks.append({
                                'id': t.id,
                                'name': t.name or (t.external_ref or ("#%s" % t.id)),
                                'elapsed_seconds': secs,
                                'elapsed_display': _fmt_hms(secs) if secs else '',
                                # The Dashboard's employee card: "Working on REQ-068
                                # · 1h 20m / Started 2:10 PM".
                                'ref': t.external_ref or '',
                                'start': pytz.UTC.localize(lg.start_time).astimezone(tz).strftime('%H:%M') if lg.start_time else '',
                            })
                        activity_kind = 'task'
                        activity_label = active_tasks[0]['name']
                        elapsed = active_tasks[0]['elapsed_seconds']
                    elif brk:
                        bt = brk.break_type
                        activity_kind = bt if bt in ('break', 'lunch', 'meeting') else 'break'
                        activity_label = break_sel.get(bt, bt)
                        activity_note = (brk.reason_note or '').strip()
                        if brk.start_time:
                            elapsed = max(0, int((now - brk.start_time).total_seconds()))
                            break_start = pytz.UTC.localize(brk.start_time).astimezone(tz).strftime('%H:%M')
                        # "Paused REQ-148 at 3:18 PM": the task the break stopped.
                        if brk.source_task_id:
                            paused_task = dict({'id': brk.source_task_id.id,
                                                'ref': brk.source_task_id.external_ref or '',
                                                'name': brk.source_task_id.name or ''},
                                               **_pause_info(brk.source_task_id))
                    elif s.nontask_started_at:
                        r = s.nontask_reason or 'no_tasks'
                        activity_kind = r if r in ('break', 'lunch', 'meeting', 'no_tasks') else 'no_tasks'
                        activity_label = nontask_sel.get(r, r)
                        activity_note = (s.nontask_note or '').strip()
                        elapsed = max(0, int((now - s.nontask_started_at).total_seconds()))
                    else:
                        activity_kind, activity_label = 'idle', 'Idle'
                        # Idle right after pausing a task: say which one and why,
                        # the same as the break case above.
                        last_paused = Kpi.search([('user_id', '=', u.id), ('task_state', '=', 'paused')],
                                                 order='write_date desc', limit=1)
                        if last_paused:
                            paused_task = dict({'id': last_paused.id,
                                                'ref': last_paused.external_ref or '',
                                                'name': last_paused.name or ''},
                                               **_pause_info(last_paused))

                rows.append({
                    'user_id': u.id,
                    'name': u.name or u.login or '—',
                    'attendance': attendance,          # present | late | absent | pending
                    'arrival': arrival,                # local "12:00"
                    'started': bool(open_sess),        # workday currently open
                    # Explicitly ended today and so unable to restart — the same
                    # rule as kpi.work.session._ended_session_today (no open
                    # session + a closed one that the cron did NOT auto-close),
                    # restated over the sessions already fetched above rather
                    # than re-querying per developer on a 15s poll.
                    # Must match kpi.work.session._ended_session_today exactly, including
                    # the reverted exclusion — otherwise a reopened day still reads as
                    # "ended" here and offers a Reopen button for something already
                    # reopened, while the developer's own board correctly shows Start.
                    'day_done': bool(not open_sess and sessions.filtered(
                        lambda s: s.state == 'closed' and not s.auto_closed and not s.reverted)),
                    # If someone reopened this day, say so and why — on the same screen
                    # the Reopen button lives on. Otherwise the only record is the
                    # snapshot, which does not get rewritten until the day is ended
                    # again, so the reason was invisible during exactly the window
                    # between reopening and re-closing.
                    #
                    # Cleared once the day is ended again: by then the reopen has
                    # played out, and a row still announcing it reads as if something
                    # is outstanding. The snapshot keeps the permanent copy.
                    'reopened_reason': '' if (not open_sess and sessions.filtered(
                        lambda s: s.state == 'closed' and not s.auto_closed and not s.reverted
                    )) else next((s.revert_reason or '' for s in sessions
                                  if s.reverted and s.revert_reason), ''),
                    'reopened_by': '' if (not open_sess and sessions.filtered(
                        lambda s: s.state == 'closed' and not s.auto_closed and not s.reverted
                    )) else next((s.reverted_by_id.name or '' for s in sessions
                                  if s.reverted and s.reverted_by_id), ''),
                    'active': active_flag,             # heartbeat fresh (at desk)
                    'activity_kind': activity_kind,    # task|break|lunch|meeting|no_tasks|idle|offline
                    'activity_label': activity_label,  # e.g. "abc" — first task when multitasking
                    # Free text the developer gave with a break / lunch / meeting /
                    # "no tasks". Empty when they are on a task or gave no reason.
                    'activity_note': activity_note,
                    'elapsed_seconds': elapsed,
                    'elapsed_display': _fmt_hms(elapsed) if elapsed else '',
                    # Every running timer, oldest first. Empty unless activity_kind
                    # is 'task'. Clients that only know the scalars above still
                    # render exactly as before.
                    'active_tasks': active_tasks,
                    'active_task_count': len(active_tasks),
                    # Dashboard employee cards (older screens ignore these).
                    'paused_task': paused_task,
                    'break_start': break_start,
                    'role': ROLE_LABEL.get(u.kpi_role or 'developer', 'Developer'),
                    'top_tasks': _top_tasks(u),
                })

            return {
                'status': True,
                # Local wall clock, like cutoff_display. This was the bare UTC
                # datetime, which the screen and the widget showed as it came:
                # an IST admin read "as of 05:10" at 10:40, and the widget header
                # carried a full date and time. The raw value stays beside it.
                'as_of': _to_user_tz_str(now, user, '%H:%M'),
                'as_of_raw': fields.Datetime.to_string(now),
                'cutoff_display': cutoff_local.strftime('%H:%M'),
                'total': len(rows),
                'present_count': sum(1 for r in rows if r['attendance'] in ('present', 'late')),
                'active_count': sum(1 for r in rows if r['active']),
                'absent_count': sum(1 for r in rows if r['attendance'] == 'absent'),
                'late_count': sum(1 for r in rows if r['attendance'] == 'late'),
                'rows': rows,
            }
        except Exception as e:
            import logging, traceback
            logging.getLogger(__name__).error(f"kpi_owner_live_tracking: {e}\n{traceback.format_exc()}")
            return {'status': False, 'message': str(e)}

    # One nudge per developer per this many minutes, whoever sends it.
    NUDGE_COOLDOWN_MIN = 10

    @http.route('/kpi_owner/nudge_user', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_owner_nudge_user(self, **params):
        """Admin pings one developer from Live Tracking.

        params: user_id (required), note (optional, the admin's own words).

        Sent as the 'admin_nudge' event: in-app feed + push to that developer
        only. It has no WhatsApp template, so the WhatsApp leg stays silent like
        the other developer prompts. The wording depends on whether their
        workday is open: "start your workday" to someone who has not begun,
        "checking in" to someone who has.

        The rate limit reads the developer's last admin_nudge notification row,
        so there is no extra state to keep: a second nudge inside
        NUDGE_COOLDOWN_MIN is refused with how long ago the last one went.
        """
        import logging
        try:
            user = request.env.user
            if not self._is_owner_admin():
                return {'status': False, 'message': 'Not authorized.'}
            try:
                uid = int(params.get('user_id') or 0)
            except (TypeError, ValueError):
                uid = 0
            target = request.env['res.users'].sudo().browse(uid)
            if (not uid or not target.exists() or not target.active or target.share
                    or target.id == 1 or target.kpi_role == 'client'):
                return {'status': False, 'message': 'Please choose a valid developer.'}
            if target.id == user.id:
                return {'status': False, 'message': "You can't nudge yourself."}

            now = fields.Datetime.now()
            last = request.env['kpi.notification'].sudo().search(
                [('event', '=', 'admin_nudge'), ('user_id', '=', target.id)],
                order='create_date desc', limit=1)
            if last and last.create_date > now - timedelta(minutes=self.NUDGE_COOLDOWN_MIN):
                ago = max(1, int((now - last.create_date).total_seconds() // 60))
                wait = int((last.create_date + timedelta(minutes=self.NUDGE_COOLDOWN_MIN)
                            - now).total_seconds())
                return {'status': False, 'message': 'Nudged %d min ago.' % ago,
                        'retry_after_seconds': max(1, wait)}

            workday_open = bool(request.env['kpi.work.session'].sudo().search_count(
                [('user_id', '=', target.id), ('state', '=', 'open')]))
            admin_name = user.name or 'Your admin'
            message = ('%s is checking in on you.' % admin_name if workday_open
                       else '%s asks you to start your workday.' % admin_name)
            note = (params.get('note') or '').strip()[:300]

            # _notify lives on kra.kpi: hang it off any task. admin_nudge is a
            # non-task, passthrough event, so the anchor is never shown or used
            # to pick the recipient — extra_users carries the developer.
            Kpi = request.env['kra.kpi'].sudo()
            anchor = (Kpi.search([('user_id', '=', target.id)], order='id desc', limit=1)
                      or Kpi.search([], order='id desc', limit=1))
            if not anchor:
                return {'status': False, 'message': 'No task exists to send the nudge through.'}
            anchor._notify(
                'admin_nudge', extra_users=[target.id],
                admin=admin_name, message=message,
                note_line=('\n“%s”' % note) if note else '',
            )
            return {'status': True, 'user_id': target.id, 'workday_open': workday_open,
                    'message': 'Nudged %s.' % (target.name or 'them')}
        except Exception as e:
            logging.getLogger(__name__).error(f"kpi_owner_nudge_user: {e}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_owner/employee_profile', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_owner_employee_profile(self, **params):
        """The Dashboard's employee popup, everything that is not "one day"
        (that is /kpi_owner/employee_day): who they are and how to reach them,
        their whole open workload, what they finished, questions they are
        waiting on, today's meetings and the last 30 days of attendance.

        params: user_id. Owner / Coordinator / System only. Read-only.
        Attendance uses the same rule as Live Tracking: the first start of the
        day against company.attendance_cutoff_hour (default 10:40), Sundays off.
        """
        import pytz
        from datetime import datetime as _dt, time as _time, timedelta as _td
        if not self._is_owner_admin():
            return {'status': False, 'message': 'Not authorized.'}
        try:
            uid = int(params.get('user_id') or 0)
        except (TypeError, ValueError):
            uid = 0
        u = request.env['res.users'].sudo().browse(uid).exists()
        if not u:
            return {'status': False, 'message': 'Employee not found.'}
        try:
            me = request.env.user
            tz = pytz.timezone(me.tz or 'Asia/Kolkata')
            today = fields.Date.context_today(me)
            now = fields.Datetime.now()

            def utc_start(d):
                return tz.localize(_dt.combine(d, _time.min)).astimezone(pytz.UTC).replace(tzinfo=None)

            def local(dt, fmt='%H:%M'):
                return pytz.UTC.localize(dt).astimezone(tz).strftime(fmt) if dt else ''

            # ---- who they are ----
            dial, _len = u._kpi_user_mobile_cfg()
            roles = {'developer': 'Developer', 'coordinator': 'Coordinator', 'admin': 'Admin', 'client': 'Client'}
            contact = {
                'name': u.name or u.login,
                'login': u.login,
                'role': roles.get(u.kpi_role or 'developer', 'Developer'),
                'mobile': u.kpi_mobile_number or '',
                'dial': dial or '',
                'country': (u.kpi_mobile_country_id.name if u.kpi_mobile_country_id
                            else request.env.company.kpi_country_id.name or ''),
                'whatsapp': u._kpi_wa_target() or '',
                'app_login_enabled': bool(u.kpi_app_login_enabled),
                'last_app_login': local(u.kpi_last_app_login, '%d %b %Y, %H:%M') if u.kpi_last_app_login else '',
                'last_device': u.kpi_last_device or '',
                'allow_multitask': bool(u.kpi_allow_multitask),
                # Whether the app PIN is still the default — a flag only. The
                # value itself never leaves the server.
                'pin_is_default': bool(u.kpi_app_must_change_password),
            }

            # ---- workload ----
            Kpi = request.env['kra.kpi'].sudo()
            BUCKET = {'in_progress': 'running', 'paused': 'paused', 'hold': 'hold', 'rework': 'todo',
                      'assigned': 'todo', 'urgent': 'todo', 'important': 'todo', 'regular': 'todo',
                      'queue_waiting': 'todo', 'pre_approval_pending': 'todo', 'pre_approval_approved': 'todo',
                      'pre_approval_partial': 'todo', 'partially_completed': 'approval',
                      'awaiting_client': 'approval'}
            ORDER = {'running': 0, 'paused': 1, 'todo': 2, 'hold': 3, 'approval': 4}
            week_end = today + _td(days=6 - today.weekday())
            open_tasks = Kpi.search([('user_id', '=', u.id), ('task_state', 'in', list(BUCKET))])
            rows = []
            for t in open_tasks:
                b = BUCKET[t.task_state]
                rows.append({
                    'id': t.id, 'ref': t.external_ref or '', 'name': t.name or '',
                    'client': t.client_kra_id.name or '', 'state': b,
                    'state_label': dict(Kpi._fields['task_state'].selection).get(t.task_state, t.task_state),
                    'deadline': str(t.deadline) if t.deadline else '',
                    'overdue': bool(t.deadline and t.deadline < today and b != 'approval'),
                    'due_week': bool(t.deadline and today <= t.deadline <= week_end),
                    'estimate_h': round(t.estimate or 0, 1),
                    'spent_h': round((t.timer_total_seconds or 0) / 3600.0, 1),
                })
            rows.sort(key=lambda r: (ORDER[r['state']], r['deadline'] or '9999', r['id']))

            def done_since(d):
                lo = utc_start(d)
                return Kpi.search_count([
                    ('user_id', '=', u.id), ('task_state', '=', 'completed'),
                    '|', ('approval_date', '>=', lo),
                    '&', ('approval_date', '=', False), ('write_date', '>=', lo)])
            counts = {s: sum(1 for r in rows if r['state'] == s) for s in ORDER}
            workload = {
                'tasks': rows,
                'counts': counts,
                'open': len(rows),
                'overdue': sum(1 for r in rows if r['overdue']),
                'due_week': sum(1 for r in rows if r['due_week']),
                'est_total': round(sum(r['estimate_h'] for r in rows), 1),
                'spent_total': round(sum(r['spent_h'] for r in rows), 1),
                'done_today': done_since(today),
                'done_week': done_since(today - _td(days=today.weekday())),
                'done_month': done_since(today.replace(day=1)),
            }

            # ---- questions they are waiting on ----
            questions = []
            if 'kpi.doubt' in request.env:
                for q in request.env['kpi.doubt'].sudo().search(
                        [('raised_by_id', '=', u.id), ('state', '=', 'open')], order='create_date desc', limit=20):
                    questions.append({
                        'id': q.id, 'ref': q.kpi_id.external_ref or '', 'task': q.kpi_id.name or '',
                        'question': (q.question or '')[:240],
                        'days': max(0, (now - q.create_date).days) if q.create_date else 0,
                    })

            # ---- today's meetings ----
            meetings = []
            if 'kpi.meeting' in request.env:
                Meet = request.env['kpi.meeting'].sudo()
                for m in Meet.search(['|', ('organizer_id', '=', u.id), ('attendee_user_ids', 'in', u.id),
                                      ('scheduled_start', '>=', utc_start(today)),
                                      ('scheduled_start', '<', utc_start(today + _td(days=1)))],
                                     order='scheduled_start asc'):
                    meetings.append({'id': m.id, 'time': local(m.scheduled_start), 'name': m.name or '',
                                     'state': dict(Meet._fields['state'].selection).get(m.state, m.state),
                                     'join_url': m.join_url or ''})

            # ---- attendance, last 30 days ----
            try:
                cut = float(request.env.company.attendance_cutoff_hour or 10.667)
            except Exception:
                cut = 10.667
            ch, cm = int(cut), int(round((cut - int(cut)) * 60))
            if cm >= 60:
                ch, cm = ch + 1, 0
            first = {}
            Session = request.env['kpi.work.session'].sudo()
            for s in Session.search([('user_id', '=', u.id), ('session_date', '>=', today - _td(days=29)),
                                     ('login_at', '!=', False)]):
                d = s.session_date
                if d not in first or s.login_at < first[d]:
                    first[d] = s.login_at
            # Only WORKING days can be absent: the company's working week (its
            # resource calendar, Mon–Fri when there is none), minus company
            # holidays (global calendar leaves), and only from the day the
            # person joined (their user was created — there is no HR module).
            # A day they did work still counts, weekend or not.
            cal = request.env.company.resource_calendar_id
            workdays = set(int(a.dayofweek) for a in cal.attendance_ids) if cal else set()
            workdays = workdays or {0, 1, 2, 3, 4}
            holidays = set()
            if 'resource.calendar.leaves' in request.env:
                span_lo = utc_start(today - _td(days=29))
                for lv in request.env['resource.calendar.leaves'].sudo().search(
                        [('resource_id', '=', False), ('date_to', '>=', span_lo),
                         '|', ('calendar_id', '=', False), ('calendar_id', '=', cal.id if cal else False)]):
                    a = pytz.UTC.localize(lv.date_from).astimezone(tz).date()
                    b = pytz.UTC.localize(lv.date_to).astimezone(tz).date()
                    while a <= b:
                        holidays.add(a)
                        a += _td(days=1)
            joined = pytz.UTC.localize(u.create_date).astimezone(tz).date() if u.create_date else None

            days = []
            for i in range(29, -1, -1):
                d = today - _td(days=i)
                cutoff = tz.localize(_dt.combine(d, _time(min(ch, 23), min(cm, 59)))).astimezone(pytz.UTC).replace(tzinfo=None)
                fl = first.get(d)
                if fl:
                    status = 'late' if fl > cutoff else 'on_time'
                elif joined and d < joined:
                    status = 'before_join'
                elif d in holidays:
                    status = 'holiday'
                elif d.weekday() not in workdays:
                    status = 'off'
                elif d == today and now <= cutoff:
                    status = 'pending'
                else:
                    status = 'absent'
                days.append({'date': str(d), 'status': status, 'first_login': local(fl) if fl else ''})
            att = {s: sum(1 for x in days if x['status'] == s)
                   for s in ('on_time', 'late', 'absent', 'off', 'holiday', 'before_join')}
            att['working_days'] = att['on_time'] + att['late'] + att['absent']

            return {'status': True, 'user_id': u.id, 'contact': contact, 'workload': workload,
                    'questions': questions, 'meetings_today': meetings,
                    'attendance': {'days': days, 'totals': att, 'joined': str(joined) if joined else '',
                                   'cutoff': '%02d:%02d' % (min(ch, 23), min(cm, 59))}}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error("kpi_owner_employee_profile: %s", e)
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_owner/employee_day', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_owner_employee_day(self, **params):
        """One developer's day for an admin: what Live Tracking opens on a tap.

        params: user_id (required), date ('YYYY-MM-DD', optional — default today).

        The same payload the End Workday summary is built from
        (_daily_summary_payload, full day), so the admin reads exactly what the
        developer reads — totals, away time, the Workday Map, tasks — but live,
        at any hour, not only once the day is ended.

        Unlike /kpi_workday/today_summary this never OPENS a session: that route
        is the developer looking at their own day, and opening one is right for
        them. Here it would start someone else's workday just because an admin
        looked. A day with no session answers started: False.

        "Today" is the admin's calendar day, the same one Live Tracking uses, so
        the two screens always talk about the same day.
        """
        import logging
        try:
            if not self._is_owner_admin():
                return {'status': False, 'message': 'Not authorized.'}
            try:
                uid = int(params.get('user_id') or 0)
            except (TypeError, ValueError):
                uid = 0
            target = request.env['res.users'].sudo().browse(uid)
            if not uid or not target.exists():
                return {'status': False, 'message': 'Developer not found.'}

            today = fields.Date.context_today(request.env.user)
            day = today
            if params.get('date'):
                try:
                    day = fields.Date.to_date(params['date']) or today
                except (TypeError, ValueError):
                    return {'status': False, 'message': 'Date is not valid.'}
            if day > today:
                return {'status': False, 'message': 'That day has not happened yet.'}

            Session = request.env['kpi.work.session'].sudo()
            sess = Session.search([('user_id', '=', target.id), ('session_date', '=', day)],
                                  order='login_at desc, id desc', limit=1)
            if not sess:
                return {'status': True, 'started': False, 'user_id': target.id,
                        'dev': target.name or '', 'session_date': fields.Date.to_string(day)}

            # Live presence must reflect "now", as on the developer's own screen.
            sess.invalidate_recordset(['productive_seconds', 'presence_seconds', 'task_count'])
            payload = sess._daily_summary_payload(full_day=True)
            payload.update({'status': True, 'started': True, 'user_id': target.id,
                            'is_today': day == today})
            # Every start and end of the day, oldest first: the first start is
            # what attendance is judged on, and a restart or a reopen later in
            # the day shows here instead of being guessed at.
            all_sess = Session.search([('user_id', '=', target.id), ('session_date', '=', day)],
                                      order='login_at asc, id asc')
            now = fields.Datetime.now()

            def _hm(dt):
                return _to_user_tz_str(dt, target, fmt='%H:%M') if dt else ''

            sessions = []
            for i, ss in enumerate(all_sess, start=1):
                end = ss.logout_at or (now if ss.state == 'open' else False)
                secs = max(0, int((end - ss.login_at).total_seconds())) if (end and ss.login_at) else 0
                sessions.append({
                    'n': i,
                    'login': _hm(ss.login_at),
                    'logout': _hm(ss.logout_at),
                    'open': ss.state == 'open',
                    'auto_closed': bool(ss.auto_closed),
                    'duration_display': _fmt_hms(secs) if secs else '0m',
                    'reopened': bool(ss.reverted),
                    'reopened_at': _hm(ss.reverted_at),
                    'reopened_by': ss.reverted_by_id.name if ss.reverted_by_id else '',
                    'reopen_reason': (ss.revert_reason or '').strip(),
                })
            payload['sessions'] = sessions
            # Arrival = the FIRST start of the day, judged against the same cutoff
            # Live Tracking uses. A later restart or reopen never changes it.
            first = all_sess[:1].login_at if all_sess else False
            payload['first_login'] = _hm(first)
            try:
                cut = float(request.env.company.attendance_cutoff_hour or 10.667)
            except Exception:
                cut = 10.667
            local_first = _to_user_tz_str(first, target, fmt='%H:%M') if first else ''
            if local_first:
                h, m = (int(x) for x in local_first.split(':'))
                payload['late'] = (h + m / 60.0) > cut + 1e-6
            else:
                payload['late'] = False

            # The "no progress note yet" warning is about today's work only.
            payload['missing_progress'] = []
            if day == today:
                try:
                    payload['missing_progress'] = Session._tasks_missing_progress_today(user=target)
                except Exception as exc:
                    logging.getLogger(__name__).warning("employee_day missing_progress: %s", exc)
            return payload
        except Exception as e:
            logging.getLogger(__name__).error(f"kpi_owner_employee_day: {e}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_owner/action_log', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_owner_action_log(self, **params):
        """Granular lifecycle log for the Employee Tracker's 'expand arrow'.

        Reads kpi.action.log — the per-task audit trail (start / pause / resume /
        complete / approve / pre-approval / notifications) written everywhere by
        _log_action but, until now, read by NO route. Filter by task (kpi_id),
        actor (user_id), and/or a day / date-range on the event time. Owner /
        Coordinator / System only (matches the model ACL).
        """
        user = request.env.user
        allowed = (
            user.has_group('kra_kpi_module.group_kra_admin')
            or user.has_group('kra_kpi_module.group_kra_owner')
            or user.has_group('base.group_system')
        )
        if not allowed:
            return {'status': False, 'message': 'Not authorized.'}
        try:
            Log = request.env['kpi.action.log'].sudo()
            domain = []
            if params.get('kpi_id'):
                domain.append(('kpi_id', '=', int(params['kpi_id'])))
            if params.get('user_id'):
                domain.append(('actor_user_id', '=', int(params['user_id'])))
            # Event-time window. 'date' = a single day; else optional from/to.
            day = params.get('date')
            if day:
                domain += [('create_date', '>=', day + ' 00:00:00'),
                           ('create_date', '<=', day + ' 23:59:59')]
            else:
                if params.get('from_date'):
                    domain.append(('create_date', '>=', params['from_date'] + ' 00:00:00'))
                if params.get('to_date'):
                    domain.append(('create_date', '<=', params['to_date'] + ' 23:59:59'))
            try:
                limit = min(max(1, int(params.get('limit') or 500)), 2000)
            except (TypeError, ValueError):
                limit = 500
            src_labels = dict(Log._fields['source'].selection)
            entries = Log.search(domain, order='create_date desc, id desc', limit=limit)
            rows = []
            for e in entries:
                payload = {}
                if e.payload_json:
                    try:
                        payload = json.loads(e.payload_json)
                    except (ValueError, TypeError):
                        payload = {'raw': e.payload_json}
                rows.append({
                    'id':            e.id,
                    'kpi_id':        e.kpi_id.id if e.kpi_id else False,
                    'task_ref':      (e.kpi_id.external_ref or f"#{e.kpi_id.id}") if e.kpi_id else '',
                    'task_name':     e.kpi_id.name if e.kpi_id else '',
                    'event':         e.event or '',
                    'source':        e.source or '',
                    'source_label':  src_labels.get(e.source, e.source or ''),
                    'actor':         (e.actor_user_id.name if e.actor_user_id else (e.actor_label or '')),
                    'actor_user_id': e.actor_user_id.id if e.actor_user_id else False,
                    # Raw UTC + ISO+Z; the client localises with the same helper it uses elsewhere.
                    'when':          fields.Datetime.to_string(e.create_date),
                    'when_raw':      (e.create_date.isoformat() + 'Z') if e.create_date else False,
                    'success':       bool(e.success),
                    'device_ip':     e.device_ip or '',
                    'payload':       payload,
                })
            return {'status': True, 'count': len(rows), 'entries': rows}
        except Exception as e:
            import logging, traceback
            logging.getLogger(__name__).error(f"kpi_owner_action_log: {e}\n{traceback.format_exc()}")
            return {'status': False, 'message': str(e)}

    # ============================================================
    #     WORK REPORT — completed tasks over a period (task/client)
    # ============================================================

    @http.route('/kpi_reports/period_work/generate', type='json', auth='user', methods=['POST'], csrf=False)
    def period_work_report(self, **params):
        """Completed-tasks report over a period, viewable task-wise or client-wise.

        params:
          from_date / to_date : ISO dates (default = current month → today)
          group_by            : 'task' (flat list) | 'client' (grouped)
          client_kra_id       : optional — restrict to one client (to send them their report)
        Returns each COMPLETED task (task_state='completed', completion_date in range) with
        its client/project/assignee, completion date, and hours from kpi.time.log in range.
        """
        user = request.env.user
        allowed = (
            user.has_group('kra_kpi_module.group_kra_manager')
            or user.has_group('kra_kpi_module.group_kra_admin')
            or user.has_group('kra_kpi_module.group_kra_owner')
            or user.has_group('base.group_system')
        )
        if not allowed:
            return {'status': False, 'message': 'Not authorized.'}
        try:
            today = fields.Date.context_today(user)
            from_date = fields.Date.from_string(params.get('from_date')) if params.get('from_date') else today.replace(day=1)
            to_date = fields.Date.from_string(params.get('to_date')) if params.get('to_date') else today
            group_by = (params.get('group_by') or 'task').lower()
            if group_by not in ('task', 'client'):
                group_by = 'task'

            # The picked dates are the user's LOCAL calendar days. completion_date and
            # time-log start_time are stored naive-UTC, so convert the local
            # midnight..midnight window to UTC bounds — otherwise tasks completed near
            # local midnight land in the wrong day/period.
            import pytz
            from datetime import datetime as _dtcls, time as _tcls
            tz = pytz.timezone(user.tz or 'Asia/Kolkata')
            start_s = fields.Datetime.to_string(
                tz.localize(_dtcls.combine(from_date, _tcls.min)).astimezone(pytz.UTC).replace(tzinfo=None))
            end_s = fields.Datetime.to_string(
                tz.localize(_dtcls.combine(to_date, _tcls.max)).astimezone(pytz.UTC).replace(tzinfo=None))

            Kpi = request.env['kra.kpi'].sudo()
            Log = request.env['kpi.time.log'].sudo()

            domain = [
                ('task_state', '=', 'completed'),
                ('completion_date', '>=', start_s),
                ('completion_date', '<=', end_s),
            ]
            if params.get('client_kra_id'):
                domain.append(('client_kra_id', '=', int(params['client_kra_id'])))
            tasks = Kpi.search(domain, order='completion_date desc')

            def _fmt_h(secs):
                s = int(secs or 0)
                h, rem = divmod(s, 3600)
                m = rem // 60
                return (f"{h}h {m}m" if h else f"{m}m") if (h or m) else "0h"

            rows = []
            for t in tasks:
                logs = Log.search([
                    ('kpi_id', '=', t.id),
                    ('is_active', '=', False),
                    ('start_time', '>=', start_s),
                    ('start_time', '<=', end_s),
                ])
                secs = sum(logs.mapped('duration_seconds'))
                rows.append({
                    'task_id':         t.id,
                    'ref':             t.external_ref or f"#{t.id}",
                    'name':            t.name or '',
                    'client_id':       t.client_kra_id.id if t.client_kra_id else False,
                    'client_name':     t.client_kra_id.name if t.client_kra_id else '—',
                    'project_name':    t.kra_id.name if t.kra_id else '',
                    'assignee':        t.user_id.name if t.user_id else '',
                    'completion_date': str(t.completion_date.date()) if t.completion_date else '',
                    'priority':        t.priority or '',
                    'hours_seconds':   secs,
                    'hours_display':   _fmt_h(secs),
                })

            # Brand header/watermark: the Company Branding logo (skip Odoo's default
            # placeholder), else the bundled brand logo — same source as the invoice PDF.
            company = request.env.company
            logo_b64 = ''
            if company.logo and not company.uses_default_logo:
                raw = company.logo
                logo_b64 = raw.decode() if isinstance(raw, bytes) else raw
            if not logo_b64:
                try:
                    import base64
                    from odoo.tools import file_open
                    with file_open('kra_kpi_module/static/src/img/alphalize_logo.png', 'rb') as f:
                        logo_b64 = base64.b64encode(f.read()).decode()
                except Exception:
                    logo_b64 = ''

            total_secs = sum(r['hours_seconds'] for r in rows)
            base = {
                'status':             True,
                'group_by':           group_by,
                'from_date':          str(from_date),
                'to_date':            str(to_date),
                'total_tasks':        len(rows),
                'total_hours_display': _fmt_h(total_secs),
                'company_name':       request.env.company.name or '',
                'company_logo_b64':   logo_b64,
            }

            if group_by == 'client':
                from collections import defaultdict
                buckets = defaultdict(lambda: {'client_name': '', 'client_id': False, 'tasks': [], 'total_seconds': 0.0})
                for r in rows:
                    b = buckets[r['client_id']]
                    b['client_name'] = r['client_name']
                    b['client_id'] = r['client_id']
                    b['tasks'].append(r)
                    b['total_seconds'] += r['hours_seconds']
                clients = []
                for b in buckets.values():
                    clients.append({
                        'client_id':     b['client_id'],
                        'client_name':   b['client_name'],
                        'task_count':    len(b['tasks']),
                        'total_seconds': b['total_seconds'],
                        'total_display': _fmt_h(b['total_seconds']),
                        'tasks':         b['tasks'],
                    })
                clients.sort(key=lambda c: (c['client_name'] or '').lower())
                base['clients'] = clients
                return base

            base['tasks'] = rows
            return base
        except Exception as e:
            import logging, traceback
            logging.getLogger(__name__).error(f"period_work_report: {e}\n{traceback.format_exc()}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_reports/period_work/clients', type='json', auth='user', methods=['POST'], csrf=False)
    def period_work_clients(self, **params):
        """Client dropdown for the Work Report (is_client KRAs)."""
        user = request.env.user
        allowed = (
            user.has_group('kra_kpi_module.group_kra_manager')
            or user.has_group('kra_kpi_module.group_kra_admin')
            or user.has_group('kra_kpi_module.group_kra_owner')
            or user.has_group('base.group_system')
        )
        if not allowed:
            return {'status': False, 'message': 'Not authorized.'}
        try:
            clients = request.env['kra.master'].sudo().search(
                [('is_client', '=', True), ('active', '=', True)], order='name')
            return {'status': True, 'clients': [
                {'id': c.id, 'name': (c.parent_id.name + ' > ' + c.name) if c.parent_id else c.name}
                for c in clients
            ]}
        except Exception as e:
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_reports/period_work/pdf', type='json', auth='user', methods=['POST'], csrf=False)
    def period_work_pdf(self, **params):
        """Server-side branded PDF of the Work Report (for the mobile app, which
        can't run the web's jsPDF). Reuses period_work_report for the data + access
        gate, then renders it with reportlab in the same style as the daily report."""
        data = self.period_work_report(**params)
        if not data.get('status'):
            return data   # not authorized / error — pass straight through
        try:
            pdf_bytes = self._build_work_report_pdf(data)
        except Exception as e:
            import logging, traceback
            logging.getLogger(__name__).error(f"period_work_pdf: {e}\n{traceback.format_exc()}")
            return {'status': False, 'message': str(e)}
        import base64
        return {
            'status': True,
            'file_name': 'Work_Report_%s_to_%s.pdf' % (data.get('from_date'), data.get('to_date')),
            'mimetype': 'application/pdf',
            'data_b64': base64.b64encode(pdf_bytes).decode(),
        }

    def _build_work_report_pdf(self, data):
        """Render the Work Report payload to PDF bytes with reportlab — Times fonts,
        #38385C table headers, zebra rows, a faint centred logo watermark, mirroring
        the daily task report / invoice PDFs. Branding logo comes in the payload."""
        import base64
        import io
        from xml.sax.saxutils import escape as _esc
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.lib.utils import ImageReader
        from reportlab.platypus import (
            SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Image, HRFlowable,
        )

        brand = colors.HexColor('#38385C')
        zebra = colors.HexColor('#F7F7FB')
        grid = colors.HexColor('#E1E1E1')
        rule = colors.HexColor('#BEBEBE')
        ink = colors.black
        muted = colors.HexColor('#64748B')

        logo_bytes = None
        if data.get('company_logo_b64'):
            try:
                logo_bytes = base64.b64decode(data['company_logo_b64'])
            except Exception:
                logo_bytes = None
        logo_reader = None
        logo_ratio = 1.0
        if logo_bytes:
            try:
                logo_reader = ImageReader(io.BytesIO(logo_bytes))
                iw, ih = logo_reader.getSize()
                if iw and ih:
                    logo_ratio = float(iw) / float(ih)
            except Exception:
                logo_reader = None

        styles = getSampleStyleSheet()
        s_company = ParagraphStyle('co', parent=styles['Normal'], fontName='Times-Bold', fontSize=22, alignment=2, textColor=ink, leading=24)
        s_doctype = ParagraphStyle('dt', parent=styles['Normal'], fontName='Times-Roman', fontSize=12, alignment=2, textColor=muted, leading=16)
        s_meta = ParagraphStyle('me', parent=styles['Normal'], fontName='Times-Roman', fontSize=10, textColor=muted, leading=14)
        s_sect = ParagraphStyle('se', parent=styles['Normal'], fontName='Times-Bold', fontSize=13, textColor=brand, leading=16, spaceBefore=8, spaceAfter=4)
        cell = ParagraphStyle('c', parent=styles['Normal'], fontName='Times-Roman', fontSize=9, textColor=ink, leading=11)

        PW, PH = A4
        MARGIN = 48
        content_w = PW - 2 * MARGIN

        def _watermark(canvas, doc_):
            if not logo_reader:
                return
            canvas.saveState()
            wm_w = PW * 0.55
            wm_h = wm_w / (logo_ratio or 1.0)
            if wm_h > PH * 0.5:
                wm_h = PH * 0.5
                wm_w = wm_h * (logo_ratio or 1.0)
            x = (PW - wm_w) / 2.0
            y = (PH - wm_h) / 2.0
            try:
                canvas.setFillAlpha(0.08)
                canvas.setStrokeAlpha(0.08)
            except Exception:
                pass
            try:
                canvas.drawImage(logo_reader, x, y, wm_w, wm_h, mask='auto', preserveAspectRatio=True)
            except Exception:
                pass
            canvas.restoreState()

        buf = io.BytesIO()
        doc = SimpleDocTemplate(
            buf, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN,
            topMargin=MARGIN, bottomMargin=MARGIN, title='Work Report',
        )
        story = []

        right_cell = [Paragraph(_esc(data.get('company_name') or ''), s_company),
                      Paragraph('Work Report', s_doctype)]
        if logo_reader:
            h = 56
            w = min(h * logo_ratio, 150)
            left_cell = Image(io.BytesIO(logo_bytes), width=w, height=h)
            left_cell.hAlign = 'LEFT'
        else:
            left_cell = Paragraph('', cell)
        header = Table([[left_cell, right_cell]], colWidths=[content_w * 0.45, content_w * 0.55])
        header.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
            ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ]))
        story.append(header)
        story.append(Spacer(1, 6))
        story.append(HRFlowable(width='100%', thickness=0.8, color=rule, spaceBefore=0, spaceAfter=8))
        story.append(Paragraph('Period: %s to %s' % (data.get('from_date'), data.get('to_date')), s_meta))
        story.append(Paragraph('Completed tasks: %s • Total hours: %s' % (
            data.get('total_tasks', 0), data.get('total_hours_display', '0h')), s_meta))
        story.append(Spacer(1, 10))

        def _hcell(txt):
            return txt

        def _tbl(head, rows, colw):
            t = Table([head] + rows, colWidths=colw, repeatRows=1)
            t.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), brand),
                ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
                ('FONTNAME', (0, 0), (-1, -1), 'Times-Roman'),
                ('FONTNAME', (0, 0), (-1, 0), 'Times-Bold'),
                ('FONTSIZE', (0, 0), (-1, -1), 9),
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, zebra]),
                ('GRID', (0, 0), (-1, -1), 0.5, grid),
                ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
                ('LEFTPADDING', (0, 0), (-1, -1), 5), ('RIGHTPADDING', (0, 0), (-1, -1), 5),
            ]))
            return t

        if data.get('group_by') == 'client':
            clients = data.get('clients') or []
            if not clients:
                story.append(Paragraph('No completed tasks in this period.', s_meta))
            for c in clients:
                story.append(Paragraph('%s — %s task(s), %s' % (
                    _esc(c.get('client_name') or '—'), c.get('task_count', 0),
                    c.get('total_display', '0h')), s_sect))
                head = ['Ref', 'Task', 'Project', 'Assignee', 'Completed', 'Hours']
                rows = [[
                    Paragraph(_esc(t.get('ref')), cell), Paragraph(_esc(t.get('name')), cell),
                    Paragraph(_esc(t.get('project_name')), cell), Paragraph(_esc(t.get('assignee')), cell),
                    t.get('completion_date', ''), t.get('hours_display', ''),
                ] for t in c.get('tasks', [])]
                story.append(_tbl(head, rows, [24 * mm, 44 * mm, 34 * mm, 30 * mm, 22 * mm, 18 * mm]))
                story.append(Spacer(1, 6))
        else:
            rows_data = data.get('tasks') or []
            if not rows_data:
                story.append(Paragraph('No completed tasks in this period.', s_meta))
            else:
                head = ['Ref', 'Task', 'Client', 'Project', 'Assignee', 'Completed', 'Hours']
                rows = [[
                    Paragraph(_esc(t.get('ref')), cell), Paragraph(_esc(t.get('name')), cell),
                    Paragraph(_esc(t.get('client_name')), cell), Paragraph(_esc(t.get('project_name')), cell),
                    Paragraph(_esc(t.get('assignee')), cell),
                    t.get('completion_date', ''), t.get('hours_display', ''),
                ] for t in rows_data]
                story.append(_tbl(head, rows, [20 * mm, 38 * mm, 26 * mm, 26 * mm, 26 * mm, 20 * mm, 16 * mm]))

        doc.build(story, onFirstPage=_watermark, onLaterPages=_watermark)
        return buf.getvalue()

    @http.route('/kpi_reports/my_workday', type='json', auth='user', methods=['POST'], csrf=False)
    def my_workday_report(self, **params):
        """A developer's OWN workday report for the mobile app. HARD-SCOPED to the
        logged-in user (request.env.user) — it NEVER reads a user_id from the client,
        so a developer can only ever see their own days, never a colleague's. No admin
        gate. Returns per-day presence, productive hours, and the tasks they worked on.
        Params: from_date / to_date (default = last 30 days)."""
        user = request.env.user
        try:
            import datetime as _dt
            from collections import defaultdict
            today = fields.Date.context_today(user)
            from_date = fields.Date.from_string(params.get('from_date')) if params.get('from_date') else (today - _dt.timedelta(days=30))
            to_date = fields.Date.from_string(params.get('to_date')) if params.get('to_date') else today

            uid = user.id  # HARD-SCOPED — deliberately NOT from params
            Session = request.env['kpi.work.session'].sudo()
            Log = request.env['kpi.time.log'].sudo()

            days = defaultdict(lambda: {'presence': 0.0, 'productive': 0.0, 'paused': 0.0,
                                        'tasks': {}, 'sessions': 0,
                                        'first_login': None, 'last_logout': None,
                                        'open': False})
            for s in Session.search([('user_id', '=', uid),
                                     ('session_date', '>=', from_date),
                                     ('session_date', '<=', to_date)]):
                d = str(s.session_date)
                days[d]['presence'] += float(s.presence_seconds or 0.0)
                days[d]['productive'] += float(s.productive_seconds or 0.0)
                # Presence EXCLUDES paused time (it stops while the day is
                # frozen), so a day the developer froze for hours reads SHORT
                # here. Carried alongside so they can see why, instead of
                # doubting the figure.
                days[d]['paused'] += s._paused_total()
                days[d]['sessions'] += 1
                # Day bounds for started_at / ended_at: first login, last logout.
                # An open session means the day has no end yet.
                if s.login_at and (days[d]['first_login'] is None
                                   or s.login_at < days[d]['first_login']):
                    days[d]['first_login'] = s.login_at
                if s.state == 'open' or not s.logout_at:
                    days[d]['open'] = True
                elif days[d]['last_logout'] is None or s.logout_at > days[d]['last_logout']:
                    days[d]['last_logout'] = s.logout_at

            for log in Log.search([('user_id', '=', uid), ('is_active', '=', False),
                                   ('work_date', '>=', from_date), ('work_date', '<=', to_date)]):
                k = log.kpi_id
                if not k:
                    continue
                slot = days[str(log.work_date)]['tasks'].setdefault(
                    k.id, {'ref': k.external_ref or f"#{k.id}", 'name': k.name or '', 'secs': 0.0})
                slot['secs'] += float(log.duration_seconds or 0.0)

            def _fmt(secs):
                s = int(secs or 0)
                h, rem = divmod(s, 3600)
                m = rem // 60
                return (f"{h}h {m}m" if h else f"{m}m") if (h or m) else "0h"

            result = []
            for d in sorted(days.keys(), reverse=True):
                info = days[d]
                tasks = sorted(info['tasks'].values(), key=lambda x: -x['secs'])
                result.append({
                    'date': d,
                    # Raw seconds next to the display strings, so a client can
                    # total or chart them without parsing "3h 20m".
                    'presence': float(info['presence']),
                    'productive': float(info['productive']),
                    # HH:MM in the user's timezone. ended_at stays empty while
                    # any session of the day is still open.
                    'started_at': _to_user_tz_str(info['first_login'], user, '%H:%M') if info['first_login'] else '',
                    'ended_at': (_to_user_tz_str(info['last_logout'], user, '%H:%M')
                                 if info['last_logout'] and not info['open'] else ''),
                    'presence_display': _fmt(info['presence']),
                    'productive_display': _fmt(info['productive']),
                    'paused_seconds': info['paused'],
                    'paused_display': _fmt(info['paused']),
                    'session_count': info['sessions'],
                    'task_count': len(tasks),
                    'tasks': [{'ref': t['ref'], 'name': t['name'], 'hours_display': _fmt(t['secs'])} for t in tasks],
                })
            return {'status': True, 'user_name': user.name or user.login or '',
                    'from_date': str(from_date), 'to_date': str(to_date), 'days': result}
        except Exception as e:
            import logging, traceback
            logging.getLogger(__name__).error(f"my_workday_report: {e}\n{traceback.format_exc()}")
            return {'status': False, 'message': str(e)}

    # ============================================================
    #            COORDINATOR REVIEW — first-open timestamp
    # ============================================================

    @http.route('/kpi_review/mark_started', type='json', auth='user', methods=['POST'], csrf=False)
    def mark_review_started(self, **params):
        """Stamp coordinator_review_started_at the first time a coordinator
        opens a `partially_completed` task card. Idempotent — repeat calls on
        the same record are no-ops. Caller must be in group_kra_admin or
        group_kra_owner (Coordinator/Owner). Returns:
            {status, already_started: bool, started_at: str|None, by: str|None}
        """
        try:
            kpi_id = int(params.get('kpi_id') or 0)
            if not kpi_id:
                return {'status': False, 'message': 'kpi_id is required.'}
            user = request.env.user
            allowed = (
                user.has_group('kra_kpi_module.group_kra_admin')
                or user.has_group('kra_kpi_module.group_kra_owner')
                or user.has_group('base.group_system')
            )
            if not allowed:
                return {'status': False, 'message': 'Not authorized to mark review started.'}

            kpi = request.env['kra.kpi'].sudo().browse(kpi_id)
            if not kpi.exists():
                return {'status': False, 'message': 'Task not found.'}
            # Lock the row so two concurrent clicks can't double-stamp.
            request.env.cr.execute(
                'SELECT id FROM kra_kpi WHERE id = %s FOR UPDATE',
                (kpi.id,),
            )
            kpi.invalidate_recordset(['coordinator_review_started_at',
                                      'coordinator_review_started_by'])

            if kpi.coordinator_review_started_at:
                return {
                    'status': True,
                    'already_started': True,
                    'started_at': fields.Datetime.to_string(kpi.coordinator_review_started_at),
                    'by': kpi.coordinator_review_started_by.name or '',
                }
            # Only stamp while the task is in the right state.
            if kpi.task_state != 'partially_completed':
                return {
                    'status': True,
                    'already_started': False,
                    'started_at': None,
                    'by': None,
                    'message': f"Task state is '{kpi.task_state}' — review timestamp not applicable.",
                }
            now = fields.Datetime.now()
            kpi.write({
                'coordinator_review_started_at': now,
                'coordinator_review_started_by': user.id,
            })
            try:
                kpi._log_action(
                    'review_started',
                    source='web',
                    actor_user_id=user.id,
                    payload={'task_state': kpi.task_state},
                )
            except Exception as exc:
                import logging
                logging.getLogger(__name__).warning(f"review_started audit log failed: {exc}")
            return {
                'status': True,
                'already_started': False,
                'started_at': fields.Datetime.to_string(now),
                'by': user.name or '',
            }
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"mark_review_started: {str(e)}")
            return {'status': False, 'message': str(e)}

    # ============================================================
    #            CLIENT PORTAL — DIGITAL APPROVAL
    # ============================================================

    @http.route('/kpi_client_approval/list', type='json', auth='user', methods=['POST'], csrf=False)
    def list_client_pending_approvals(self, **params):
        """List KPIs awaiting the current client user's approval.

        Filters: only tasks in 'partially_completed' state under client-KRAs the
        current user is linked to (via client_user_ids on the KRA).
        """
        try:
            user = request.env.user
            client_kras = request.env['kra.master'].sudo().search([
                ('client_user_ids', 'in', [user.id]),
            ])
            if not client_kras:
                return {'status': True, 'kpis': [], 'message': 'You are not linked to any client KRA yet.'}
            # Walk all descendants of those client KRAs
            kra_ids = set()
            for k in client_kras:
                kra_ids.update(k._get_descendant_ids())
            kpis = request.env['kra.kpi'].sudo().search([
                ('kra_id', 'in', list(kra_ids)),
                '|',
                ('task_state', '=', 'awaiting_client'),
                '&', ('task_state', '=', 'partially_completed'), ('admin_approved', '=', True),
            ], order='completion_date desc')
            result = []
            for k in kpis:
                root = k.kra_id
                while root and root.parent_id:
                    root = root.parent_id
                project = k.kra_id if k.kra_id != root else False
                result.append({
                    'id': k.id,
                    'name': k.name or '',
                    'external_ref': k.external_ref or '',
                    'client_name': root.name if root else '',
                    'project_name': project.name if project else '',
                    'priority': k.priority or '',
                    'delivery_version': k.delivery_version or '',
                    'actual_hours': round((k.timer_total_seconds or 0) / 3600.0, 2),
                    'primary_assignee': k.user_id.name if k.user_id else '',
                    'completion_date': k.completion_date.strftime('%Y-%m-%d %H:%M') if k.completion_date else '',
                })
            return {'status': True, 'kpis': result}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"list_client_pending_approvals: {str(e)}")
            return {'status': False, 'message': str(e), 'kpis': []}

    def _is_client_authorized_for_kpi(self, kpi):
        """True if the current user is linked (via client_user_ids) to ANY ancestor KRA of this KPI."""
        user = request.env.user
        cur = kpi.kra_id
        while cur:
            if user.id in cur.client_user_ids.ids:
                return True
            cur = cur.parent_id
        return False

    # ================================================================== #
    # STAGE-1 pre-approval, IN-APP.  The client approves the developer    #
    # the admin assigned, from the app — no WhatsApp link, no token.      #
    # The decision engine (record_client_pre_decision) is reused as-is;   #
    # these routes are just an authenticated JSON door into it, next to   #
    # the existing token/WhatsApp door (controllers/kpi_wa_approval.py).  #
    # ================================================================== #
    def _pre_approval_authorized(self, kpi):
        """Client may decide if they submitted it, or are a client on its KRA tree."""
        if kpi.client_submitted and kpi.submitted_by_uid.id == request.env.user.id:
            return True
        return self._is_client_authorized_for_kpi(kpi)

    @http.route('/kpi_pre_approval/list', type='json', auth='user', methods=['POST'], csrf=False)
    def list_pre_approvals(self, **params):
        """Tasks awaiting THIS client's approval (app 'Approval needed' section)."""
        try:
            kpis = request.env['kra.kpi'].sudo().search([
                ('active', '=', True),
                # A developer is mandatory — approving "Unassigned" is meaningless.
                # Also hides rows created before request_client_pre_approval()
                # started skipping dev-less tasks, with no data migration.
                ('user_id', '!=', False),
                '|',
                ('task_state', 'in', ('pre_approval_pending', 'pre_approval_partial')),
                # AUTO-RELEASED but still undecided. Without this arm the card
                # disappears the instant the window closes and the client has no
                # way left to object — which would make "you can still object"
                # a lie. The work is unfinished, so their answer still matters.
                '&', '&',
                ('pre_approval_auto_released', '=', True),
                ('pre_approval_decision', '=', False),
                ('task_state', 'not in', ('completed', 'awaiting_client')),
            ], order='pre_approval_deadline_at asc, id desc')
            out = []
            for k in kpis:
                if not self._pre_approval_authorized(k):
                    continue
                root = k.kra_id
                while root and root.parent_id:
                    root = root.parent_id
                project = k.kra_id if k.kra_id != root else False
                nm = k.name or ''
                ref = (k.external_ref or '').upper()
                if nm.startswith('[Update]') or ref.startswith(('UPT', 'UPD')):
                    kind = 'update'
                elif nm.startswith('[Bug]') or ref.startswith('BUG'):
                    kind = 'bug'
                else:
                    kind = 'requirement'
                out.append({
                    'id': k.id,
                    'name': nm,
                    'kind': kind,
                    'external_ref': k.external_ref or '',
                    'description': k.description or '',
                    'client_name': root.name if root else '',
                    'project_name': project.name if project else '',
                    'priority': k.priority or '',
                    'task_state': k.task_state or '',
                    # Who the admin assigned — the thing being approved.
                    'developer': k.user_id.name if k.user_id else '',
                    # Drives the app's countdown. The RELEASE clock, not the
                    # reminder clock: the reminder deadline is cleared once the
                    # nudges run out, which would freeze the countdown at 0
                    # while the task was in fact still waiting.
                    'deadline_at': (k.pre_approval_release_at.strftime('%Y-%m-%d %H:%M:%S')
                                    if k.pre_approval_release_at
                                    else (k.pre_approval_deadline_at.strftime('%Y-%m-%d %H:%M:%S')
                                          if k.pre_approval_deadline_at else '')),
                    'server_now': fields.Datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                    # Whether this task will ACTUALLY auto-release, decided here so
                    # the app never has to re-derive the rule (and never promises
                    # something that can't happen). Mirrors the cron domain in
                    # _sweep_pre_approval_release exactly. A held task has no
                    # release clock → False.
                    'auto_releases': bool(k.task_state == 'pre_approval_pending'
                                          and not k.pre_approval_held
                                          and k.pre_approval_release_at),
                    # Legacy key, kept so an older mobile build keeps rendering
                    # its countdown. Same value; the name is the lie we are
                    # retiring — releasing is not approving.
                    'auto_approves': bool(k.task_state == 'pre_approval_pending'
                                          and not k.pre_approval_held
                                          and k.pre_approval_release_at),
                    # Already released: the window closed, work may have started,
                    # and this client still hasn't answered. The app shows these
                    # as "started without your reply — you can still object".
                    'auto_released': bool(k.pre_approval_auto_released),
                    'released_at': (k.pre_approval_auto_released_at.strftime('%Y-%m-%d %H:%M:%S')
                                    if k.pre_approval_auto_released_at else ''),
                    'held': bool(k.pre_approval_held),
                })
            return {'status': True, 'kpis': out}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"list_pre_approvals: {str(e)}")
            return {'status': False, 'message': str(e), 'kpis': []}

    @http.route('/kpi_pre_approval/decide', type='json', auth='user', methods=['POST'], csrf=False)
    def decide_pre_approval(self, **params):
        """Client approves/rejects the assigned developer, in-app.

        Delegates to the existing engine so the app decision gets the same
        row-locking, idempotency, late-decision handling and audit trail as the
        WhatsApp path. `source` must be 'web' — the field only allows web|whatsapp.
        """
        try:
            action = (params.get('action') or '').strip().lower()
            if action not in ('approve', 'reject', 'hold', 'resume'):
                return {'status': False, 'message': 'Invalid action.'}
            kpi = request.env['kra.kpi'].sudo().browse(int(params.get('kpi_id') or 0))
            if not kpi.exists():
                return {'status': False, 'message': 'Task not found.'}
            if not self._pre_approval_authorized(kpi):
                return {'status': False, 'message': 'Not authorized for this task.'}
            feedback = (params.get('feedback') or '').strip()

            # Hold / Resume are NOT decisions — they only stop/start the
            # auto-release clock, so they bypass record_client_pre_decision
            # (whose 'hold' action would mark the token used and lock the client
            # out of ever approving). See _hold_pre_approval.
            if action in ('hold', 'resume'):
                if action == 'hold':
                    kpi._hold_pre_approval()
                else:
                    kpi._resume_pre_approval()
                auto = bool(kpi.task_state == 'pre_approval_pending'
                            and not kpi.pre_approval_held
                            and kpi.pre_approval_release_at)
                return {'status': True,
                        'state': kpi.task_state,
                        'held': bool(kpi.pre_approval_held),
                        'auto_releases': auto,
                        'auto_approves': auto,     # legacy key — see the list route
                        'deadline_at': (kpi.pre_approval_release_at.strftime('%Y-%m-%d %H:%M:%S')
                                        if kpi.pre_approval_release_at else ''),
                        'server_now': fields.Datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                        'message': ('Held — the team will not start.' if action == 'hold'
                                    else 'Resumed.')}

            # A reject must say why — the admin needs it to act. Enforced here
            # and not only in the UI: never trust the client.
            if action == 'reject' and not feedback:
                return {'status': False, 'message': 'Please tell us what to change.'}

            user = request.env.user
            res = kpi.record_client_pre_decision(
                action,
                partner_name=user.name or '',
                feedback=feedback,
                source='web',
                partner_id=user.partner_id.id if user.partner_id else None,
            )
            # Reject → hand the task back to the queue so an admin can assign a
            # different developer (which re-fires a fresh client approval).
            # AFTER the engine call: it's what stamps pre_approval_feedback, which
            # the notification body reads. Only for client-submitted tasks — the
            # WhatsApp/legacy flow keeps its existing park-in-rework behaviour.
            if (action == 'reject' and kpi.client_submitted
                    and res.get('status') != 'already_decided' and not res.get('late')):
                kpi._return_to_queue_after_reject()
            # The engine returns a string code ('ok' / 'already_decided' /
            # 'expired' / 'invalid'). Spreading **res after a bool let that
            # string win, so 'expired' reached the app as a truthy status and
            # was shown as success. status is the boolean; the raw code moves
            # to 'code'.
            res = dict(res or {})
            code = res.pop('status', None)
            return {**res, 'status': code == 'ok', 'code': code,
                    'message': res.get('message') or ''}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"decide_pre_approval: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_approval/get', type='json', auth='user', methods=['POST'], csrf=False)
    def get_client_approval_detail(self, **params):
        """Return full detail for one KPI the client is reviewing."""
        try:
            kpi = request.env['kra.kpi'].sudo().browse(int(params['kpi_id']))
            if not kpi.exists():
                return {'status': False, 'message': 'Task not found.'}
            if not self._is_client_authorized_for_kpi(kpi):
                return {'status': False, 'message': 'You are not authorized to review this task.'}
            data = kpi.get_completion_certificate_data()
            data['kpi']['client_chk_delivered'] = kpi.client_chk_delivered
            data['kpi']['client_chk_works'] = kpi.client_chk_works
            data['kpi']['client_chk_authorized'] = kpi.client_chk_authorized
            data['kpi']['client_approval_notes'] = kpi.client_approval_notes or ''
            data['kpi']['client_signature_text'] = kpi.client_signature_text or ''
            return {'status': True, 'data': data}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"get_client_approval_detail: {str(e)}")
            return {'status': False, 'message': str(e)}

    def _resolve_client_signature(self, params):
        """(signature, error) for the current client user.

        Shared by the single and bulk sign-off routes so the "no signature, no
        sign-off" rule cannot drift between them.
        """
        user = request.env.user
        signature = (params.get('signature_text') or '').strip()
        if not signature and not bool(user.kpi_signature_image):
            return None, ('Please upload a signature image (Completions menu) '
                          'or type your name.')
        if not signature:
            # Fall back to the user's display name when only the saved image is used.
            signature = user.name or user.login or 'Client'
        return signature, None

    def _apply_client_signoff(self, kpi, signature, notes, chk_delivered, chk_works, chk_authorized):
        """Sign ONE task off as the client. Returns (ok, message).

        Every guard lives in here rather than in the callers, so the bulk route
        cannot bypass one by looping. This body writes `client_final_approved`,
        the flag the invoice domain filters on — if the single and bulk paths ever
        diverged, the result would be a billing-correctness bug, not a cosmetic one.
        """
        if not kpi.exists():
            return False, 'Task not found.'
        if not self._is_client_authorized_for_kpi(kpi):
            return False, 'You are not authorized to approve this task.'
        # Stage-2 sign-off is only meaningful once the admin has QA-approved the work.
        # Without this the route wrote the terminal fields from ANY state, so a client
        # could create a task and immediately mark it completed + billable — skipping
        # admin accept, client pre-approval and every minute of developer work.
        # 'partially_completed' + admin_approved is the legacy shape that predates
        # 'awaiting_client'; it is still offered by the pending list, so it is accepted
        # here too. Keep the two in step — the app renders a Sign-off button for
        # whatever /kpi_client_portal/dashboard returns in pending_approvals.
        if not (kpi.task_state == 'awaiting_client'
                or (kpi.task_state == 'partially_completed' and kpi.admin_approved)):
            return False, ("This task is not awaiting your sign-off yet. "
                           "It has to be completed by the team and approved by an "
                           "admin first.")

        user = request.env.user
        now = fields.Datetime.now()
        today = fields.Date.today()

        # Minimal plaintext digital-approval receipt — stored as the signed_certificate
        # so the approve_task() gate is satisfied. Admin can still view/download this.
        import base64 as _b64
        receipt = (
            f"DIGITAL APPROVAL RECEIPT\n"
            f"========================\n"
            f"Task:      {kpi.name}\n"
            f"Ref:       {kpi.external_ref or ''}\n"
            f"Signed by: {signature}  (user login: {user.login}, id={user.id})\n"
            f"Signed at: {now}\n"
            f"Checklist: delivered={chk_delivered}, works={chk_works}, authorized={chk_authorized}\n"
            f"Notes:     {notes}\n"
        ).encode('utf-8')
        # Stage 2: client digital sign-off. Records signature, generates a receipt,
        # and moves the task to 'completed'.
        kpi.write({
            'client_signature_text': signature,
            'client_signed_datetime': now,
            'client_approval_notes': notes,
            'client_chk_delivered': chk_delivered,
            'client_chk_works': chk_works,
            'client_chk_authorized': chk_authorized,
            'signed_certificate': _b64.b64encode(receipt).decode(),
            'signed_certificate_name': f'digital_approval_{kpi.id}.txt',
            'signed_certificate_date': today,
            # Final state transition — client sign-off closes the task
            'task_state': 'completed',
            'approved_by': user.id,
            'approval_date': now,
            # If admin hadn't run QA-approve yet, mark it now (client signed = effective approval)
            'admin_approved': True,
            # The client's signature IS the billable event — without this the task
            # looks fully approved but can never be invoiced, because the invoice
            # domain filters on client_final_approved (kpi_client_invoice.py:228).
            # Matches the app path (kpi_workflow.py) and approve_task() (kpi.py).
            'client_final_approved': True,
        })
        # Audit + notify owner / coordinator / developer that the client signed off.
        try:
            kpi._log_action(
                'final_approved',
                source='web',
                actor_user_id=user.id,
                actor_label=signature,
                payload={'kpi_id': kpi.id, 'notes': notes},
            )
            kpi._notify('final_approved', decided_by=signature, feedback=notes, source='web')
        except Exception as nx:
            try:
                kpi._log_action(
                    'notification_failed',
                    payload={'event': 'final_approved', 'error': str(nx)},
                    success=False,
                )
            except Exception:
                pass
        return True, 'Approved successfully.'

    @http.route('/kpi_client_approval/approve_bulk', type='json', auth='user', methods=['POST'], csrf=False)
    def submit_client_approval_bulk(self, **params):
        """Sign several tasks off in one action.

        Clients had to open a dialog and tick three boxes per task; with 40 pending
        that is 40 dialogs, which is why 92 tasks sat unsigned for over 60 days.

        Each task is authorized and state-checked individually inside
        _apply_client_signoff — a task cannot ride in on a valid neighbour. Partial
        success is normal, not an error: the rest sign and the caller is told which
        ones did not and why.
        """
        try:
            ids = [int(i) for i in (params.get('kpi_ids') or [])]
            if not ids:
                return {'status': False, 'message': 'No tasks selected.'}
            chk_delivered = bool(params.get('chk_delivered'))
            chk_works = bool(params.get('chk_works'))
            chk_authorized = bool(params.get('chk_authorized'))
            if not (chk_delivered and chk_works and chk_authorized):
                return {'status': False,
                        'message': 'Please tick all three confirmation checkboxes before signing.'}
            signature, err = self._resolve_client_signature(params)
            if err:
                return {'status': False, 'message': err}
            notes = params.get('notes') or ''

            approved, skipped = [], []
            for kpi in request.env['kra.kpi'].sudo().browse(ids):
                ok, msg = self._apply_client_signoff(
                    kpi, signature, notes, chk_delivered, chk_works, chk_authorized)
                if ok:
                    approved.append(kpi.id)
                else:
                    skipped.append({'id': kpi.id, 'name': kpi.name or '', 'reason': msg})
            return {'status': True, 'approved': approved, 'skipped': skipped,
                    'message': 'Signed off %s task(s).' % len(approved)}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"submit_client_approval_bulk: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_approval/approve', type='json', auth='user', methods=['POST'], csrf=False)
    def submit_client_approval(self, **params):
        """Client submits digital approval. Auto-generates a signed cert record and approves the task."""
        try:
            kpi = request.env['kra.kpi'].sudo().browse(int(params['kpi_id']))
            chk_delivered = bool(params.get('chk_delivered'))
            chk_works = bool(params.get('chk_works'))
            chk_authorized = bool(params.get('chk_authorized'))
            if not (chk_delivered and chk_works and chk_authorized):
                return {'status': False, 'message': 'Please tick all three confirmation checkboxes before signing.'}
            signature, err = self._resolve_client_signature(params)
            if err:
                return {'status': False, 'message': err}
            notes = params.get('notes') or ''
            ok, msg = self._apply_client_signoff(
                kpi, signature, notes, chk_delivered, chk_works, chk_authorized)
            if not ok:
                return {'status': False, 'message': msg}
            return {'status': True, 'message': msg, 'kpi_id': kpi.id}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"submit_client_approval: {str(e)}")
            return {'status': False, 'message': str(e)}


    @http.route('/kpi_client_approval/reject', type='json', auth='user', methods=['POST'], csrf=False)
    def submit_client_rejection(self, **params):
        """Client rejects with a reason — task walks back to 'rework' for the dev."""
        try:
            kpi = request.env['kra.kpi'].sudo().browse(int(params['kpi_id']))
            if not kpi.exists():
                return {'status': False, 'message': 'Task not found.'}
            if not self._is_client_authorized_for_kpi(kpi):
                return {'status': False, 'message': 'You are not authorized.'}
            reason = (params.get('reason') or '').strip() or 'Client requested changes.'
            # This used to call kpi.reject_task(reason), which raises unless the task is
            # 'partially_completed'. By sign-off time the coordinator has already run
            # approve_task, so the task is 'awaiting_client' and the call ALWAYS raised —
            # swallowed by the except below, so the client got a silent no-op and the task
            # sat in the queue forever. record_client_final_decision is the stage-2 path
            # (the same one WhatsApp uses); it walks the state back to 'rework' itself.
            res = kpi.record_client_final_decision(
                'reject',
                partner_name=request.env.user.name or '',
                feedback=reason,
                source='web',
                partner_id=request.env.user.partner_id.id or None,
            ) or {}
            # That method returns a STRING status ('ok' | 'invalid' | 'expired' |
            # 'already_decided'). Both OWL callers test `if (!r.status)`, and every one of
            # those strings is truthy in JS — returning it raw would show the success
            # alert on a failed rejection. Collapse it to a boolean here.
            ok = res.get('status') == 'ok'
            return {'status': ok,
                    'message': res.get('message') or ('' if ok else 'Could not record your rejection.'),
                    'state': res.get('state') or kpi.task_state}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"submit_client_rejection: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_completion_cert/set_version', type='json', auth='user', methods=['POST'], csrf=False)
    def set_kpi_delivery_version(self, **params):
        """Quick endpoint to set delivery_version on a KPI (e.g. before generating cert)."""
        if not self._is_owner_admin():
            return {'status': False, 'message': 'Admin only.'}
        try:
            kpi = request.env['kra.kpi'].browse(int(params['kpi_id']))
            if not kpi.exists():
                return {'status': False, 'message': 'KPI not found.'}
            kpi.delivery_version = params.get('delivery_version') or ''
            return {'status': True}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"set_kpi_delivery_version: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_completion_cert/upload_doc', type='json', auth='user', methods=['POST'], csrf=False)
    def upload_kpi_doc(self, **params):
        """Upload (or clear) a doc on the KPI. doc_type = 'requirement' or 'updates'."""
        if not self._is_owner_admin():
            return {'status': False, 'message': 'Admin only.'}
        try:
            kpi = request.env['kra.kpi'].browse(int(params['kpi_id']))
            if not kpi.exists():
                return {'status': False, 'message': 'KPI not found.'}
            doc_type = params.get('doc_type') or 'requirement'
            updates = {}
            if doc_type == 'requirement':
                if 'file_data' in params:
                    updates['requirement_document'] = params['file_data'] or False
                    updates['requirement_document_name'] = params.get('file_name') or ''
                if 'requirement_version' in params:
                    updates['requirement_version'] = params['requirement_version'] or ''
            elif doc_type == 'updates':
                if 'file_data' in params:
                    updates['updates_document'] = params['file_data'] or False
                    updates['updates_document_name'] = params.get('file_name') or ''
            else:
                return {'status': False, 'message': f'Unknown doc_type: {doc_type}'}
            if updates:
                kpi.write(updates)
            return {
                'status': True,
                'requirement_document_name': kpi.requirement_document_name or '',
                'requirement_version': kpi.requirement_version or '',
                'has_requirement_document': bool(kpi.requirement_document),
                'updates_document_name': kpi.updates_document_name or '',
                'has_updates_document': bool(kpi.updates_document),
            }
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"upload_kpi_doc: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_completion_cert/upload_signed', type='json', auth='user', methods=['POST'], csrf=False)
    def upload_signed_cert(self, **params):
        """Upload the client-signed completion certificate PDF onto a KPI."""
        if not self._is_owner_admin():
            return {'status': False, 'message': 'Admin only.'}
        try:
            kpi = request.env['kra.kpi'].browse(int(params['kpi_id']))
            if not kpi.exists():
                return {'status': False, 'message': 'KPI not found.'}
            updates = {}
            if 'file_data' in params:
                updates['signed_certificate'] = params['file_data'] or False
                updates['signed_certificate_name'] = params.get('file_name') or ''
            if 'signed_date' in params:
                updates['signed_certificate_date'] = params['signed_date'] or False
            if updates:
                kpi.write(updates)
            return {
                'status': True,
                'has_signed_certificate': bool(kpi.signed_certificate),
                'signed_certificate_name': kpi.signed_certificate_name or '',
                'signed_certificate_date': str(kpi.signed_certificate_date) if kpi.signed_certificate_date else '',
            }
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"upload_signed_cert: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_completion_cert/set_roles', type='json', auth='user', methods=['POST'], csrf=False)
    def set_kpi_roles(self, **params):
        """Set the 4 role lists on a KPI. Each role param is a list of user ids (or []).
        Pass only the role lists you want to change; omitted roles are left untouched."""
        if not self._is_owner_admin():
            return {'status': False, 'message': 'Admin only.'}
        try:
            kpi = request.env['kra.kpi'].browse(int(params['kpi_id']))
            if not kpi.exists():
                return {'status': False, 'message': 'KPI not found.'}
            updates = {}
            for role_field in ('developer_ids', 'tester_ids', 'coordinator_ids', 'lead_ids'):
                if role_field in params:
                    ids = [int(u) for u in (params[role_field] or [])]
                    updates[role_field] = [(6, 0, ids)]
            if updates:
                kpi.write(updates)
            return {
                'status': True,
                'developer_ids': kpi.developer_ids.ids,
                'tester_ids': kpi.tester_ids.ids,
                'coordinator_ids': kpi.coordinator_ids.ids,
                'lead_ids': kpi.lead_ids.ids,
            }
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"set_kpi_roles: {str(e)}")
            return {'status': False, 'message': str(e)}

    # ============================================================
    #     REQUIREMENTS / UPDATES / BUG-REPORT BULK UPLOAD APIs
    # ============================================================

    # Mapping from doc_type to the external_ref prefix.  Used by both
    # /kpi_requirements/peek_next_ref (UI preview) and the bulk-create endpoint
    # so the client / admin / manager all share the same global sequence.
    _DOC_TYPE_REF_PREFIX = {
        'requirement': 'REQ',
        'update':      'UPT',
        'bug':         'BUG',
    }

    def _next_ref_number_for_prefix(self, prefix):
        """Return the next integer N such that '<PREFIX>-<NNN>' doesn't yet
        exist in kra_kpi.external_ref.  Case-insensitive match on the prefix,
        any zero-padding allowed (REQ-1, REQ-001, REQ-0001 are all considered).
        """
        # One counter for every path. This copy did not check
        # previous_external_ref, so a bulk upload could reissue a reference that
        # re-typing had retired -- two pieces of work answering to "REQ-328".
        return request.env['kra.kpi'].sudo()._next_ref_for_prefix(prefix)

    @http.route('/kpi_requirements/peek_next_ref', type='json', auth='user', methods=['POST'], csrf=False)
    def peek_next_ref(self, **params):
        """Return the next external_ref number that bulk-create would assign for
        the given doc_type.  The UI uses this so it can preview row refs as the
        user adds rows.  Final refs are still assigned at create-time so two
        users opening the page at once don't collide.
        """
        try:
            doc_type = params.get('doc_type') or 'requirement'
            prefix = self._DOC_TYPE_REF_PREFIX.get(doc_type, 'REQ')
            n = self._next_ref_number_for_prefix(prefix)
            return {'status': True, 'prefix': prefix, 'next_number': n}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error('peek_next_ref: %s' % str(e))
            return {'status': False, 'message': str(e), 'prefix': 'REQ', 'next_number': 1}

    @http.route('/kpi_requirements/create_bulk_tasks', type='json', auth='user', methods=['POST'], csrf=False)
    def create_bulk_tasks_from_doc(self, **params):
        """Create multiple KPIs at once from a single uploaded document.

        params:
          sub_kra_id (required) — the project KRA under which tasks are created
          doc_type ('requirement' | 'update' | 'bug') — affects doc storage slot + name prefix
          file_data, file_name (optional) — shared source document attached to every created KPI
          requirement_version (optional) — applied as requirement_version on all created KPIs

          tasks (preferred) — list of dicts, each with per-task config:
            { name, estimate_hours, estimate_minutes, primary_user_id, priority }

          Legacy fallback if `tasks` is missing:
            task_names + flat estimate_hours/estimate_minutes/primary_user_id/priority
        """
        try:
            sub_kra_id = int(params['sub_kra_id'])
            sub_kra = request.env['kra.master'].sudo().browse(sub_kra_id)
            if not sub_kra.exists():
                return {'status': False, 'message': 'Sub-KRA / project not found.'}
            is_client = self._is_current_user_client_only()
            if is_client:
                # Verify the sub-KRA is one this client user is linked to (or a descendant)
                allowed_ids = set()
                for k in self._resolve_client_kras_for_user():
                    allowed_ids.update(k._get_descendant_ids())
                if sub_kra_id not in allowed_ids:
                    return {'status': False, 'message': 'You are not authorized for this project.'}
            doc_type = params.get('doc_type') or 'requirement'
            name_prefix_map = {'requirement': '', 'update': '[Update] ', 'bug': '[Bug] '}
            name_prefix = name_prefix_map.get(doc_type, '')
            file_data = params.get('file_data') or ''
            file_name = params.get('file_name') or ''
            requirement_version = params.get('requirement_version') or ''

            # Build a unified list of task dicts whether the caller passed `tasks` or legacy `task_names`.
            tasks_in = params.get('tasks') or []
            if not tasks_in:
                names = [n.strip() for n in (params.get('task_names') or []) if n and n.strip()]
                flat_hours = int(params.get('estimate_hours') or 0)
                flat_min = int(params.get('estimate_minutes') or 0)
                flat_user = int(params['primary_user_id']) if params.get('primary_user_id') else False
                flat_prio = params.get('priority') or 'regular'
                tasks_in = [{
                    'name': n, 'estimate_hours': flat_hours, 'estimate_minutes': flat_min,
                    'primary_user_id': flat_user, 'priority': flat_prio,
                } for n in names]

            if not tasks_in:
                return {'status': False, 'message': 'No tasks provided.'}

            # Module / App / EXE, per row, falling back to one default for the
            # whole upload. Checked for EVERY row before any is created: the loop
            # below creates as it goes, so a bad row 5 found mid-loop would leave
            # rows 1-4 behind.
            default_deliverable, err = clean_deliverable(params.get('deliverable_type'),
                                                         params.get('deliverable_other'))
            if err:
                return {'status': False, 'message': err}
            row_deliverable = {}
            for i, t in enumerate(tasks_in):
                if not (t.get('name') or '').strip():
                    continue
                dv, err = clean_deliverable(t.get('deliverable_type'), t.get('deliverable_other'))
                if err:
                    return {'status': False,
                            'message': '%s (task %d: %s)' % (err, i + 1, (t.get('name') or '').strip())}
                row_deliverable[i] = dv if dv['deliverable_type'] else default_deliverable

            # is_client was already computed above (used for authorization).
            # Clients use sudo() to bypass ACL on kra.kpi.create (mirroring
            # /kpi_client_portal/add_task) since their portal group lacks CRUD on kra.kpi.
            kpi_model = request.env['kra.kpi'].sudo() if is_client else request.env['kra.kpi']

            # Server-controlled external_ref assignment.  The UI shows previewed
            # refs (REQ-076 etc.) but the actual value at insert time always
            # comes from this counter so concurrent uploads don't collide.
            ref_prefix = self._DOC_TYPE_REF_PREFIX.get(doc_type, 'REQ')
            ref_counter = self._next_ref_number_for_prefix(ref_prefix)

            created_ids = []
            for i, t in enumerate(tasks_in):
                raw_name = (t.get('name') or '').strip()
                if not raw_name:
                    continue
                vals = {
                    'name': name_prefix + raw_name,
                    'kra_id': sub_kra_id,
                    'estimate_hours': int(t.get('estimate_hours') or 0),
                    'estimate_minutes': int(t.get('estimate_minutes') or 0),
                    'priority': t.get('priority') or 'regular',
                    'task_state': 'assigned',
                    'active': True,
                    # Every submission (client OR coordinator OR owner) lands in
                    # the Client Task Queue first — coordinator assigns developer
                    # + estimate, which auto-fires the pre-approval pipeline.
                    # An admin row with no developer is listed there through the
                    # queue's user_id=False match (see list_pending_queue).
                    'published': False,
                    'submitted_by_uid': request.env.user.id,
                    # Marks the client-only queue + auto-approve path.
                    'client_submitted': bool(is_client),
                }
                if (row_deliverable.get(i) or {}).get('deliverable_type'):
                    vals.update(row_deliverable[i])
                # Clients can't pre-assign developers — only admin/manager can.
                if not is_client:
                    pu = t.get('primary_user_id')
                    if pu:
                        vals['user_id'] = int(pu)
                # Always overwrite external_ref with the server-side auto value
                # so client / admin / manager share one global sequence and
                # nobody can fork the numbering by typing their own.
                vals['external_ref'] = '%s-%03d' % (ref_prefix, ref_counter)
                ref_counter += 1
                if t.get('related_req_ref'):
                    vals['related_req_ref'] = t['related_req_ref']
                # The client's reason / detail for this task. This was silently
                # dropped before, which is why the Client Task Queue's Description
                # box was always empty for uploaded tasks even though it renders it.
                # (Mirrors /kpi_completion_cert/create_task_from_doc.)
                if t.get('description'):
                    vals['description'] = t['description']
                if file_data:
                    if doc_type == 'update':
                        vals['updates_document'] = file_data
                        vals['updates_document_name'] = file_name
                    else:
                        vals['requirement_document'] = file_data
                        vals['requirement_document_name'] = file_name
                if requirement_version:
                    vals['requirement_version'] = requirement_version
                kpi = kpi_model.create(vals)
                created_ids.append(kpi.id)
                # Client submission → tell the admins it's sitting in the queue
                # needing a developer. Re-nudged while unread by
                # kra.kpi._cron_nudge_queued_tasks. Never raises.
                if is_client:
                    try:
                        kpi._notify('client_task_queued')
                        kpi._schedule_queue_nudge()
                    except Exception as exc:
                        import logging
                        logging.getLogger(__name__).warning(
                            "client_task_queued notify failed for kpi %s: %s", kpi.id, exc)

            return {'status': True, 'created_count': len(created_ids), 'kpi_ids': created_ids}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"create_bulk_tasks_from_doc: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_project/completion_status', type='json', auth='user', methods=['POST'], csrf=False)
    def get_project_completion_status(self, **params):
        """Return a hierarchical breakdown of all KPIs under a project (sub-KRA),
        grouped into Requirements / Updates / Bugs, showing completion progress.

        params: project_kra_id (required)
        """
        try:
            project_kra_id = int(params.get('project_kra_id') or 0)
            if not project_kra_id:
                return {'status': False, 'message': 'project_kra_id is required.'}
            project = request.env['kra.master'].browse(project_kra_id)
            if not project.exists():
                return {'status': False, 'message': 'Project KRA not found.'}

            kra_ids = project._get_descendant_ids()
            kpis = request.env['kra.kpi'].search([('kra_id', 'in', kra_ids), ('active', '=', True)])

            def _classify(kpi):
                """Return 'requirement' | 'update' | 'bug' based on name prefix or external_ref prefix."""
                nm = (kpi.name or '')
                if nm.startswith('[Update]'):
                    return 'update'
                if nm.startswith('[Bug]'):
                    return 'bug'
                ref = (kpi.external_ref or '').upper()
                if ref.startswith(('UPT', 'UPD')):
                    return 'update'
                if ref.startswith('BUG'):
                    return 'bug'
                return 'requirement'

            def _serialize(k):
                est_hours = (k.estimate_hours or 0) + (k.estimate_minutes or 0) / 60.0
                actual_hours = (k.timer_total_seconds or 0) / 3600.0
                return {
                    'id': k.id,
                    'name': k.name,
                    'external_ref': k.external_ref or '',
                    'related_req_ref': k.related_req_ref or '',
                    'task_state': k.task_state or '',
                    'priority': k.priority or '',
                    'primary_assignee': k.user_id.name if k.user_id else '',
                    'estimate_hours': round(est_hours, 2),
                    'actual_hours': round(actual_hours, 2),
                    'has_signed_cert': bool(k.signed_certificate),
                    'deadline': str(k.deadline) if k.deadline else '',
                    'completion_date': k.completion_date.strftime('%Y-%m-%d') if k.completion_date else '',
                }

            # Bucketize
            requirements = {}   # external_ref -> {req: dict, updates: [], bugs: []}
            orphan_updates = []
            orphan_bugs = []
            for k in kpis:
                kind = _classify(k)
                ser = _serialize(k)
                if kind == 'requirement':
                    key = ser['external_ref'] or f'KPI-{k.id}'
                    bucket = requirements.setdefault(key, {'req': ser, 'updates': [], 'bugs': []})
                    bucket['req'] = ser  # in case multiple matches, last wins
                elif kind == 'update':
                    parent = (ser['related_req_ref'] or '').strip()
                    if parent and parent in requirements:
                        requirements[parent]['updates'].append(ser)
                    elif parent:
                        # Parent listed but not yet in dict — record and post-process
                        bucket = requirements.setdefault(parent, {'req': None, 'updates': [], 'bugs': []})
                        bucket['updates'].append(ser)
                    else:
                        orphan_updates.append(ser)
                elif kind == 'bug':
                    parent = (ser['related_req_ref'] or '').strip()
                    if parent and parent in requirements:
                        requirements[parent]['bugs'].append(ser)
                    elif parent:
                        bucket = requirements.setdefault(parent, {'req': None, 'updates': [], 'bugs': []})
                        bucket['bugs'].append(ser)
                    else:
                        orphan_bugs.append(ser)

            # Totals
            def _is_done(s):
                return s.get('task_state') == 'completed'

            total_req = len(requirements)
            done_req = sum(1 for v in requirements.values() if v['req'] and _is_done(v['req']))
            all_updates = []
            all_bugs = []
            for v in requirements.values():
                all_updates.extend(v['updates'])
                all_bugs.extend(v['bugs'])
            all_updates.extend(orphan_updates)
            all_bugs.extend(orphan_bugs)
            total_upd = len(all_updates)
            done_upd = sum(1 for u in all_updates if _is_done(u))
            total_bug = len(all_bugs)
            done_bug = sum(1 for b in all_bugs if _is_done(b))

            project_complete = (
                total_req + total_upd + total_bug > 0
                and done_req == total_req
                and done_upd == total_upd
                and done_bug == total_bug
            )

            return {
                'status': True,
                'project': {'id': project.id, 'name': project.name or ''},
                'requirements': [
                    {'ref': k, 'req': v['req'], 'updates': v['updates'], 'bugs': v['bugs']}
                    for k, v in sorted(requirements.items())
                ],
                'orphan_updates': orphan_updates,
                'orphan_bugs': orphan_bugs,
                'totals': {
                    'requirements_total': total_req,
                    'requirements_done': done_req,
                    'updates_total': total_upd,
                    'updates_done': done_upd,
                    'bugs_total': total_bug,
                    'bugs_done': done_bug,
                    'project_complete': project_complete,
                },
            }
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"get_project_completion_status: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_requirements/parse_file', type='json', auth='user', methods=['POST'], csrf=False)
    def parse_file_for_tasks(self, **params):
        """Parse an uploaded XLSX or CSV file and return a list of task names.

        params:
          file_data (base64 string, required)
          file_name (str, required) — used to detect extension
          doc_type ('requirement' | 'update' | 'bug') — hints which column heuristics to prefer
        Returns: {status, tasks: [...], source: 'xlsx' | 'csv', columns: [...]}
        """
        import base64
        try:
            file_data = params.get('file_data')
            file_name = (params.get('file_name') or '').lower()
            doc_type = params.get('doc_type') or 'requirement'
            if not file_data or not file_name:
                return {'status': False, 'message': 'Both file_data and file_name are required.'}
            raw = base64.b64decode(file_data)

            # Preferred column-name patterns by doc type.
            # NOTE: we ALSO honor an explicit "(task name)" suffix on the column header — this is
            # our convention for marking which column the import should treat as the task title.
            preferred_by_type = {
                'requirement': ['description', 'requirement', 'feature', 'title', 'summary', 'task', 'name'],
                'update': ['description of change', 'change', 'description', 'amendment', 'task', 'title', 'name', 'update'],
                'bug': ['description', 'bug', 'issue', 'title', 'summary', 'name'],
            }
            preferred = preferred_by_type.get(doc_type, preferred_by_type['requirement'])

            def _pick_column(headers):
                """Return index of best-match column. First check for an explicit
                '(task name)' suffix in any header, then fall back to keyword preferences."""
                norm = [(h or '').strip().lower() for h in headers]
                for i, h in enumerate(norm):
                    if '(task name)' in h or '(taskname)' in h:
                        return i, headers[i]
                for pat in preferred:
                    for i, h in enumerate(norm):
                        if pat in h:
                            return i, headers[i]
                return 0, (headers[0] if headers else '')

            def _find_marker_column(headers, marker):
                """Find the first column whose header contains the marker (e.g. '(id)', '(linked req)')."""
                norm = [(h or '').strip().lower() for h in headers]
                for i, h in enumerate(norm):
                    if marker in h:
                        return i
                return None

            tasks = []
            columns_seen = []

            def _row_to_task(row, col_idx, id_idx, linked_idx, module_idx):
                """Extract (name, external_ref, related_req_ref) from a row.
                Returns None if the row is empty/placeholder."""
                if col_idx >= len(row):
                    return None
                val = row[col_idx]
                if val is None:
                    return None
                val_str = str(val).strip()
                if (not val_str
                        or val_str.lower().startswith('(describe')
                        or len(val_str) > 250 or len(val_str) < 3):
                    return None
                if doc_type == 'bug' and module_idx is not None and module_idx < len(row):
                    mod = row[module_idx]
                    if mod:
                        val_str = f"{str(mod).strip()}: {val_str}"
                ext_ref = ''
                if id_idx is not None and id_idx < len(row) and row[id_idx]:
                    ext_ref = str(row[id_idx]).strip()
                linked = ''
                if linked_idx is not None and linked_idx < len(row) and row[linked_idx]:
                    linked = str(row[linked_idx]).strip()
                return {'name': val_str, 'external_ref': ext_ref, 'related_req_ref': linked}

            if file_name.endswith('.csv') or file_name.endswith('.txt'):
                import csv
                from io import StringIO
                try:
                    text = raw.decode('utf-8-sig')
                except UnicodeDecodeError:
                    text = raw.decode('latin-1')
                reader = csv.reader(StringIO(text))
                rows = list(reader)
                if not rows:
                    return {'status': True, 'tasks': [], 'source': 'csv', 'columns': []}
                headers = rows[0]
                columns_seen = list(headers)
                col_idx, col_name = _pick_column(headers)
                id_idx = _find_marker_column(headers, '(id)')
                linked_idx = _find_marker_column(headers, '(linked req)')
                module_idx = None
                if doc_type == 'bug':
                    for i, h in enumerate(headers):
                        if 'module' in (h or '').lower() or 'screen' in (h or '').lower():
                            module_idx = i; break
                header_is_data = not any(pat in (h or '').lower() for h in headers for pat in preferred)
                data_rows = rows if header_is_data else rows[1:]
                for r in data_rows:
                    t = _row_to_task(r, col_idx, id_idx, linked_idx, module_idx)
                    if t:
                        tasks.append(t)
                return {'status': True, 'tasks': tasks[:200], 'source': 'csv',
                        'columns': columns_seen, 'matched_column': col_name}

            if file_name.endswith('.xlsx') or file_name.endswith('.xls'):
                try:
                    import openpyxl
                    from io import BytesIO
                except Exception:
                    return {'status': False, 'message': 'openpyxl not available on this Odoo install.'}
                wb = openpyxl.load_workbook(BytesIO(raw), read_only=True, data_only=True)
                ws = wb.active
                rows_iter = list(ws.iter_rows(values_only=True))
                if not rows_iter:
                    return {'status': True, 'tasks': [], 'source': 'xlsx', 'columns': []}
                header_idx = 0
                for i, r in enumerate(rows_iter):
                    non_empty = [c for c in r if c not in (None, '')]
                    if len(non_empty) >= 2:
                        if all(isinstance(c, str) and len(c) <= 60 for c in non_empty):
                            header_idx = i
                            break
                headers = [str(c) if c is not None else '' for c in rows_iter[header_idx]]
                columns_seen = headers
                col_idx, col_name = _pick_column(headers)
                id_idx = _find_marker_column(headers, '(id)')
                linked_idx = _find_marker_column(headers, '(linked req)')
                module_idx = None
                if doc_type == 'bug':
                    for i, h in enumerate(headers):
                        if 'module' in h.lower() or 'screen' in h.lower():
                            module_idx = i; break
                for r in rows_iter[header_idx + 1:]:
                    t = _row_to_task(r, col_idx, id_idx, linked_idx, module_idx)
                    if t:
                        tasks.append(t)
                return {'status': True, 'tasks': tasks[:200], 'source': 'xlsx',
                        'columns': columns_seen, 'matched_column': col_name}

            return {'status': False,
                    'message': f'Unsupported file type: {file_name}. Use .csv, .xlsx, or .xls.',
                    'tasks': []}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"parse_file_for_tasks: {str(e)}")
            return {'status': False, 'message': str(e), 'tasks': []}

    @http.route('/kpi_requirements/suggest_tasks', type='json', auth='user', methods=['POST'], csrf=False)
    def suggest_tasks_from_text(self, **params):
        """Use Anthropic Claude (or a fallback heuristic) to suggest task names from pasted text.

        params:
          text (required) — pasted document text
          doc_type ('requirement' | 'update' | 'bug') — affects the system prompt
        Returns: {status, tasks: [str, ...], source: 'ai' | 'heuristic', message: str}
        """
        try:
            text = (params.get('text') or '').strip()
            doc_type = params.get('doc_type') or 'requirement'
            if not text:
                return {'status': False, 'message': 'No text provided.', 'tasks': []}

            # Cap input length to keep API costs bounded
            if len(text) > 16000:
                text = text[:16000]

            ICP = request.env['ir.config_parameter'].sudo()
            api_key = ICP.get_param('kra_kpi.anthropic_api_key')
            # FREE alternative: Google Gemini Flash (free tier — 15 req/min, 1500/day).
            # Grab a key from https://aistudio.google.com/apikey and save it via:
            #   ir.config_parameter `kra_kpi.gemini_api_key` = <your-key>
            gemini_key = ICP.get_param('kra_kpi.gemini_api_key')
            # FREE alternative #2: Groq (free tier, very fast Llama 3 inference).
            # Get a key from https://console.groq.com/keys and save as:
            #   ir.config_parameter `kra_kpi.groq_api_key` = <your-key>
            groq_key = ICP.get_param('kra_kpi.groq_api_key')

            prompts = {
                'requirement': (
                    "You are helping a software project manager extract atomic, implementable task names "
                    "from a client's REQUIREMENT document. Each task should be 3-12 words. "
                    "Return ONLY a JSON array of strings, no prose."
                ),
                'update': (
                    "You are extracting AMENDMENT/UPDATE task names from a client's update document. "
                    "Focus on the new/changed items. Each task 3-12 words. "
                    "Return ONLY a JSON array of strings, no prose."
                ),
                'bug': (
                    "You are extracting BUG-FIX task names from a bug report. One task per bug. "
                    "Each task 3-12 words, start with 'Fix: '. "
                    "Return ONLY a JSON array of strings, no prose."
                ),
            }
            system_prompt = prompts.get(doc_type, prompts['requirement'])

            import json as _json
            import urllib.request
            import logging as _logging
            _log = _logging.getLogger(__name__)
            # Groq (and some Gemini endpoints) sit behind Cloudflare, which
            # 403s the default `Python-urllib/x.y` user-agent as a suspected
            # bot.  A plain Mozilla UA gets through cleanly.
            _UA = 'Mozilla/5.0 (Odoo KRA-KPI Module)'

            # ---------- FREE: Google Gemini Flash ----------
            if gemini_key:
                try:
                    body = _json.dumps({
                        'system_instruction': {'parts': [{'text': system_prompt}]},
                        'contents': [{'role': 'user', 'parts': [{'text': text}]}],
                        'generationConfig': {
                            'temperature': 0.2,
                            'maxOutputTokens': 1024,
                            'responseMimeType': 'application/json',
                        },
                    }).encode('utf-8')
                    url = ('https://generativelanguage.googleapis.com/v1beta/models/'
                           'gemini-2.0-flash:generateContent?key=' + gemini_key)
                    req = urllib.request.Request(
                        url, data=body, method='POST',
                        headers={'content-type': 'application/json', 'User-Agent': _UA},
                    )
                    with urllib.request.urlopen(req, timeout=30) as resp:
                        raw = resp.read().decode('utf-8')
                        rb = _json.loads(raw)
                        candidates = rb.get('candidates') or []
                        text_out = ''
                        for c in candidates:
                            parts = (c.get('content') or {}).get('parts') or []
                            for p in parts:
                                text_out += p.get('text', '')
                        tasks = _parse_task_array(text_out)
                        if tasks:
                            return {'status': True, 'source': 'ai-gemini', 'tasks': tasks}
                except Exception as ai_err:
                    _log.warning(f"suggest_tasks Gemini error: {ai_err}")

            # ---------- FREE: Groq (Llama 3.3 70B) ----------
            if groq_key:
                try:
                    body = _json.dumps({
                        'model': 'llama-3.3-70b-versatile',
                        'messages': [
                            {'role': 'system', 'content': system_prompt},
                            {'role': 'user',   'content': text},
                        ],
                        'temperature': 0.2,
                        'max_tokens': 1024,
                        'response_format': {'type': 'json_object'},
                    }).encode('utf-8')
                    req = urllib.request.Request(
                        'https://api.groq.com/openai/v1/chat/completions',
                        data=body, method='POST',
                        headers={
                            'Authorization': f'Bearer {groq_key}',
                            'content-type': 'application/json',
                            'User-Agent': _UA,
                        },
                    )
                    with urllib.request.urlopen(req, timeout=30) as resp:
                        raw = resp.read().decode('utf-8')
                        rb = _json.loads(raw)
                        choices = rb.get('choices') or []
                        text_out = ''
                        for c in choices:
                            msg = c.get('message') or {}
                            text_out += msg.get('content', '')
                        tasks = _parse_task_array(text_out)
                        if tasks:
                            return {'status': True, 'source': 'ai-groq', 'tasks': tasks}
                except Exception as ai_err:
                    _log.warning(f"suggest_tasks Groq error: {ai_err}")

            # ---------- PAID: Anthropic Claude (only if key set) ----------
            if api_key:
                req_body = _json.dumps({
                    'model': 'claude-haiku-4-5-20251001',
                    'max_tokens': 1024,
                    'system': system_prompt,
                    'messages': [{'role': 'user', 'content': text}],
                }).encode('utf-8')
                req = urllib.request.Request(
                    'https://api.anthropic.com/v1/messages',
                    data=req_body,
                    method='POST',
                    headers={
                        'x-api-key': api_key,
                        'anthropic-version': '2023-06-01',
                        'content-type': 'application/json',
                        'User-Agent': _UA,
                    },
                )
                try:
                    with urllib.request.urlopen(req, timeout=30) as resp:
                        raw = resp.read().decode('utf-8')
                        body = _json.loads(raw)
                        content_blocks = body.get('content') or []
                        text_out = ''
                        for b in content_blocks:
                            if b.get('type') == 'text':
                                text_out += b.get('text', '')
                        tasks = _parse_task_array(text_out)
                        if tasks:
                            return {'status': True, 'source': 'ai-claude', 'tasks': tasks}
                except Exception as ai_err:
                    _log.warning(f"suggest_tasks Claude error: {ai_err}")

            # Heuristic fallback: split lines, dedupe, drop very short or numbered-only lines.
            import re
            candidates = []
            for line in text.splitlines():
                s = line.strip()
                if not s:
                    continue
                # Strip leading numbers, bullets
                s = re.sub(r'^[\-\*•\d\.\)\s]+', '', s).strip()
                if len(s) < 5 or len(s) > 200:
                    continue
                candidates.append(s)
            # Dedupe while preserving order
            seen = set()
            tasks = []
            for c in candidates:
                if c.lower() in seen:
                    continue
                seen.add(c.lower())
                tasks.append(c)
                if len(tasks) >= 30:
                    break

            any_key = bool(api_key or gemini_key or groq_key)
            return {
                'status': True,
                'source': 'heuristic-fallback' if any_key else 'heuristic',
                'tasks': tasks,
                'message': ('AI providers failed — used heuristic fallback. See server log.'
                            if any_key else
                            'AI not configured (set ir.config_parameter kra_kpi.groq_api_key '
                            'or kra_kpi.gemini_api_key or kra_kpi.anthropic_api_key).'),
            }
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"suggest_tasks_from_text: {str(e)}")
            return {'status': False, 'message': str(e), 'tasks': []}

    @http.route('/kpi_completion_cert/create_task_from_doc', type='json', auth='user', methods=['POST'], csrf=False)
    def create_task_from_doc(self, **params):
        """Create a new KPI from an uploaded requirement document.
        Required: client_kra_id, sub_kra_id, task_name. Optional: file_data, file_name,
        requirement_version, estimate_hours, estimate_minutes, primary_user_id."""
        try:
            sub_kra_id = int(params.get('sub_kra_id') or params.get('client_kra_id'))
            sub_kra = request.env['kra.master'].browse(sub_kra_id)
            if not sub_kra.exists():
                return {'status': False, 'message': 'Sub-KRA / project not found.'}
            vals = {
                'name': params.get('task_name') or 'New Task',
                'kra_id': sub_kra_id,
                'estimate_hours': int(params.get('estimate_hours') or 0),
                'estimate_minutes': int(params.get('estimate_minutes') or 0),
                'priority': 'regular',
                'task_state': 'assigned',
                'active': True,
            }
            if params.get('primary_user_id'):
                vals['user_id'] = int(params['primary_user_id'])
            if params.get('requirement_version'):
                vals['requirement_version'] = params['requirement_version']
            if params.get('file_data'):
                vals['requirement_document'] = params['file_data']
                vals['requirement_document_name'] = params.get('file_name') or 'requirement'
            if params.get('description'):
                vals['description'] = params['description']
            dv, err = clean_deliverable(params.get('deliverable_type'), params.get('deliverable_other'))
            if err:
                return {'status': False, 'message': err}
            if dv['deliverable_type']:
                vals.update(dv)
            kpi = request.env['kra.kpi'].create(vals)
            return {'status': True, 'kpi_id': kpi.id, 'name': kpi.name}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"create_task_from_doc: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_completion_cert/get_sub_kras', type='json', auth='user', methods=['POST'], csrf=False)
    def get_sub_kras_for_client(self, **params):
        """For a chosen client root KRA, return descendant KRAs to populate the project dropdown."""
        try:
            client = request.env['kra.master'].browse(int(params['client_kra_id']))
            if not client.exists():
                return {'status': False, 'kras': []}
            kra_ids = client._get_descendant_ids()
            kras = request.env['kra.master'].browse(kra_ids)
            result = []
            for k in kras:
                # Build a path like "Nexgenn > Oman Photo House"
                path = []
                cur = k
                while cur:
                    path.insert(0, cur.name)
                    cur = cur.parent_id
                result.append({'id': k.id, 'name': k.name, 'display': ' > '.join(path)})
            return {'status': True, 'kras': result}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"get_sub_kras_for_client: {str(e)}")
            return {'status': False, 'message': str(e), 'kras': []}

    @http.route('/kpi_completion_cert/get_users', type='json', auth='user', methods=['POST'], csrf=False)
    def get_internal_users_for_picker(self, **params):
        """Return active internal users for the role / assignee dropdowns."""
        try:
            users = request.env['res.users'].search(
                [('active', '=', True), ('share', '=', False)], order='name')
            return {
                'status': True,
                'users': [{'id': u.id, 'name': u.name or u.login or '', 'login': u.login or ''} for u in users],
            }
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"get_internal_users_for_picker: {str(e)}")
            return {'status': False, 'users': []}

    @http.route('/kpi_client_workspace/generate_zip', type='http', auth='user')
    def generate_client_workspace_zip(self, client_kra_id=None, project_kra_id=None,
                                       version='v1.0', include_data='0', **kw):
        """Generate a ZIP containing 3 XLSX files (Requirements / Updates / Bugs)
        pre-filled with the chosen client's name in the title row.

        If include_data='1', export existing KPIs under the selected project (or client) as rows.
        """
        import io, re, zipfile, base64
        try:
            try:
                import openpyxl
                from openpyxl.styles import Font, PatternFill, Alignment
                from openpyxl.utils import get_column_letter
            except Exception:
                return request.make_response(
                    b'openpyxl not available', headers=[('Content-Type', 'text/plain')])

            company_name = request.env.company.name or 'Service Provider'
            client_name = ''
            project_name = ''
            client_kra = None
            project_kra = None
            if client_kra_id:
                client_kra = request.env['kra.master'].browse(int(client_kra_id))
                if client_kra.exists():
                    client_name = client_kra.name or ''
            if project_kra_id:
                project_kra = request.env['kra.master'].browse(int(project_kra_id))
                if project_kra.exists():
                    project_name = project_kra.name or ''

            include = include_data == '1' or include_data is True

            # Pre-load existing KPI data if requested
            existing_by_kind = {'requirement': [], 'update': [], 'bug': []}
            if include and client_kra:
                scope_kra = project_kra or client_kra
                kra_ids = scope_kra._get_descendant_ids()
                kpis = request.env['kra.kpi'].search([('kra_id', 'in', kra_ids), ('active', '=', True)])
                for k in kpis:
                    nm = (k.name or '')
                    ref = (k.external_ref or '').upper()
                    if nm.startswith('[Update]') or ref.startswith(('UPT', 'UPD')):
                        kind = 'update'
                    elif nm.startswith('[Bug]') or ref.startswith('BUG'):
                        kind = 'bug'
                    else:
                        kind = 'requirement'
                    existing_by_kind[kind].append(k)

            # Build a workbook for each template
            def _build_workbook(kind):
                wb = openpyxl.Workbook()
                ws = wb.active
                if kind == 'requirement':
                    ws.title = 'Requirements'
                    title = f'Requirements — {client_name or company_name}'
                    if project_name:
                        title += f' / {project_name}'
                    if version:
                        title += f' ({version})'
                    headers = ['Req ID (ID)', 'Module / Feature', 'Description (Task Name)',
                               'Acceptance Criteria', 'Priority (Urgent/Important/Regular)',
                               'Expected Delivery', 'Notes']
                    widths = [12, 22, 40, 32, 24, 16, 25]
                    sample = ['REQ-001', 'POS Discount', '(describe the requirement)',
                              '', 'Important', '', '']
                    fill_color = '305496'
                elif kind == 'update':
                    ws.title = 'Updates'
                    title = f'Updates / Amendments — {client_name or company_name}'
                    if project_name:
                        title += f' / {project_name}'
                    if version:
                        title += f' ({version})'
                    headers = ['Update ID (ID)', 'Linked Req (Linked Req)',
                               'Description of Change (Task Name)',
                               'Reason for Change', 'Priority (Urgent/Important/Regular)',
                               'Requested Delivery', 'Notes']
                    widths = [14, 20, 40, 30, 24, 16, 25]
                    sample = ['UPT-001', 'REQ-001', '(describe the change)',
                              '', 'Regular', '', '']
                    fill_color = 'BF8F00'
                else:  # bug
                    ws.title = 'Bug Report'
                    title = f'Bug Report — {client_name or company_name}'
                    if project_name:
                        title += f' / {project_name}'
                    if version:
                        title += f' ({version})'
                    headers = ['Bug ID (ID)', 'Linked Req (Linked Req)',
                               'Module / Screen', 'Description (Task Name)',
                               'Steps to Reproduce', 'Expected Behavior', 'Actual Behavior',
                               'Severity (High/Med/Low)', 'Priority (Urgent/Important/Regular)',
                               'Status (Open/Fixed/Closed)', 'Reported By', 'Reported Date', 'Notes']
                    widths = [12, 18, 18, 35, 35, 25, 25, 20, 22, 20, 18, 14, 25]
                    sample = ['BUG-001', 'REQ-001', 'Login Screen', '(describe the bug)',
                              '', '', '', 'Medium', 'Regular', 'Open', '', '', '']
                    fill_color = 'C00000'

                n_cols = len(headers)

                # Title row
                ws.cell(row=1, column=1, value=title)
                ws.cell(row=1, column=1).font = Font(bold=True, size=14, color='FFFFFF')
                ws.cell(row=1, column=1).fill = PatternFill('solid', fgColor=fill_color)
                ws.cell(row=1, column=1).alignment = Alignment(horizontal='center', vertical='center')
                ws.merge_cells(start_row=1, end_row=1, start_column=1, end_column=n_cols)
                ws.row_dimensions[1].height = 26

                # Header row
                for col, h in enumerate(headers, start=1):
                    c = ws.cell(row=2, column=col, value=h)
                    c.font = Font(bold=True, color='FFFFFF')
                    c.fill = PatternFill('solid', fgColor='4F81BD')
                    c.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
                ws.row_dimensions[2].height = 32

                # Data rows
                row = 3
                if include and existing_by_kind.get(kind):
                    for k in existing_by_kind[kind]:
                        if kind == 'requirement':
                            data = [
                                k.external_ref or '',
                                '',  # Module/Feature — not currently a KPI field
                                k.name or '',
                                '',  # Acceptance Criteria
                                (k.priority or '').title(),
                                str(k.deadline) if k.deadline else '',
                                '',
                            ]
                        elif kind == 'update':
                            data = [
                                k.external_ref or '',
                                k.related_req_ref or '',
                                k.name.replace('[Update] ', '') if k.name else '',
                                '',
                                (k.priority or '').title(),
                                str(k.deadline) if k.deadline else '',
                                '',
                            ]
                        else:  # bug
                            # Try to split "Module: Description" back
                            raw = (k.name or '').replace('[Bug] ', '')
                            module = ''
                            desc = raw
                            if ': ' in raw:
                                module, desc = raw.split(': ', 1)
                            data = [
                                k.external_ref or '',
                                k.related_req_ref or '',
                                module,
                                desc,
                                '', '', '',
                                'Medium', (k.priority or '').title(),
                                'Fixed' if k.task_state == 'completed' else 'Open',
                                '', '', '',
                            ]
                        for col, val in enumerate(data, start=1):
                            ws.cell(row=row, column=col, value=val)
                        row += 1
                else:
                    # Sample placeholder row
                    for col, val in enumerate(sample, start=1):
                        c = ws.cell(row=row, column=col, value=val)
                        c.alignment = Alignment(wrap_text=True, vertical='top')

                # Column widths
                for i, w in enumerate(widths, start=1):
                    ws.column_dimensions[get_column_letter(i)].width = w
                ws.freeze_panes = 'A3'

                buf = io.BytesIO()
                wb.save(buf)
                return buf.getvalue()

            def _safe(s):
                return re.sub(r'[^A-Za-z0-9_-]+', '_', s or '').strip('_') or 'Client'

            client_safe = _safe(client_name or 'Client')
            ver_safe = _safe(version or 'v1')

            files_to_zip = [
                (f'{client_safe}_Requirements_{ver_safe}.xlsx', _build_workbook('requirement')),
                (f'{client_safe}_Updates_{ver_safe}.xlsx',      _build_workbook('update')),
                (f'{client_safe}_Bugs_{ver_safe}.xlsx',         _build_workbook('bug')),
            ]

            zip_buf = io.BytesIO()
            with zipfile.ZipFile(zip_buf, 'w', zipfile.ZIP_DEFLATED) as z:
                for name, data in files_to_zip:
                    z.writestr(name, data)

            zip_name = f'{client_safe}_DocumentSet_{ver_safe}.zip'
            return request.make_response(zip_buf.getvalue(), headers=[
                ('Content-Type', 'application/zip'),
                ('Content-Disposition', f'attachment; filename="{zip_name}"'),
            ])
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"generate_client_workspace_zip: {str(e)}")
            return request.make_response(
                b'Error generating workspace: ' + str(e).encode(),
                headers=[('Content-Type', 'text/plain')])

    # 🆕 JSON sibling of the ZIP route above — for the MOBILE APP.
    # The app can't use the type='http' GET: opening that URL in an external
    # browser loses the app's Odoo session cookie, so it lands on the login page
    # instead of downloading. This route rides the same authenticated JSON-RPC
    # channel every other app call already uses and returns the identical ZIP as
    # base64, which the app writes to a file and hands to the share/save sheet.
    @http.route('/kpi_client_workspace/generate_zip_b64', type='json', auth='user', methods=['POST'], csrf=False)
    def generate_client_workspace_zip_b64(self, **params):
        """Admin-only: the Generate-Client-Files ZIP, base64-encoded for the app."""
        import base64 as _b64
        user = request.env.user
        if not (user.has_group('kra_kpi_module.group_kra_admin')
                or user.has_group('kra_kpi_module.group_kra_owner')
                or user.has_group('base.group_system')):
            return {'status': False, 'message': 'Not authorized'}
        if not params.get('client_kra_id'):
            return {'status': False, 'message': 'Please select a client'}
        include = params.get('include_data')
        # Reuse the EXACT same builder as the web download — no duplicated logic.
        resp = self.generate_client_workspace_zip(
            client_kra_id=params.get('client_kra_id'),
            project_kra_id=params.get('project_kra_id') or None,
            version=params.get('version') or 'v1.0',
            include_data='1' if include in (True, 1, '1') else '0',
        )
        data = resp.data or b''
        ctype = (resp.headers.get('Content-Type') or '').lower()
        if 'zip' not in ctype:
            # The builder returned a text/plain error (e.g. openpyxl missing).
            msg = data[:200].decode('utf-8', 'ignore') or 'Could not generate the ZIP'
            return {'status': False, 'message': msg}
        disp = resp.headers.get('Content-Disposition') or ''
        m = re.search(r'filename="([^"]+)"', disp)
        return {
            'status': True,
            'filename': m.group(1) if m else 'client_files.zip',
            'data_b64': _b64.b64encode(data).decode('ascii'),
            'size': len(data),
        }

    @http.route('/kpi_completion_cert/template/<string:template_name>', type='http', auth='user')
    def download_template(self, template_name='requirement', **kw):
        """Serve dynamically-generated blank XLSX templates for the client to fill in.

        All three templates (requirement / update / bug_report) are XLSX so that the
        admin can re-import them via the same XLSX/CSV import flow on the upload screens.
        """
        try:
            company_name = request.env.company.name or 'Service Provider'
            try:
                import openpyxl
                from openpyxl.styles import Font, PatternFill, Alignment
                from openpyxl.utils import get_column_letter
                from io import BytesIO
            except Exception:
                return request.make_response(
                    b'openpyxl not available', headers=[('Content-Type', 'text/plain')])

            # ── Per-template config ──────────────────────────────────────────
            # IMPORTANT: the column tagged "(ID)" is read as the KPI's external_ref.
            # The column tagged "(Linked Req)" is read as related_req_ref (for updates/bugs only).
            configs = {
                'requirement': {
                    'sheet_title': 'Requirements',
                    'title': f'Requirements Template — {company_name}',
                    'headers': ['Req ID (ID)', 'Module / Feature', 'Description (Task Name)',
                                'Acceptance Criteria', 'Priority (Urgent/Important/Regular)',
                                'Expected Delivery', 'Notes'],
                    'widths':  [12,            22,                  40,
                                32,                   24,
                                16,                   25],
                    'sample':  ['REQ-001',     'POS Discount',     '(describe the requirement)',
                                '',                            'Important',
                                '',                            ''],
                    'filename': 'Requirements_Template.xlsx',
                },
                'update': {
                    'sheet_title': 'Updates',
                    'title': f'Requirements Update / Amendment — {company_name}',
                    'headers': ['Update ID (ID)', 'Linked Req (Linked Req)',
                                'Description of Change (Task Name)',
                                'Reason for Change', 'Priority (Urgent/Important/Regular)',
                                'Requested Delivery', 'Notes'],
                    'widths':  [14,               20,
                                40,
                                30,                  24,
                                16,                  25],
                    'sample':  ['UPT-001',        'REQ-001',
                                '(describe the change)',
                                '',                              'Regular',
                                '',                              ''],
                    'filename': 'Updates_Template.xlsx',
                },
                'bug_report': {
                    'sheet_title': 'Bug Report',
                    'title': f'Bug Report Template — {company_name}',
                    'headers': ['Bug ID (ID)', 'Linked Req (Linked Req)',
                                'Module / Screen', 'Description (Task Name)',
                                'Steps to Reproduce', 'Expected Behavior', 'Actual Behavior',
                                'Severity (High/Med/Low)', 'Priority (Urgent/Important/Regular)',
                                'Status (Open/Fixed/Closed)', 'Reported By', 'Reported Date', 'Notes'],
                    'widths':  [12,            18,
                                18,                  35,
                                35,                    25,                  25,
                                20,                          22,
                                20,                            18,            14,              25],
                    'sample':  ['BUG-001',     'REQ-001',
                                'Login Screen',      '(describe the bug)',
                                '',                    '',                  '',
                                'Medium',                    'Regular',
                                'Open',                       '',            '',              ''],
                    'filename': 'Bug_Report_Template.xlsx',
                },
            }
            cfg = configs.get(template_name)
            if not cfg:
                return request.make_response(
                    f'Unknown template: {template_name}'.encode(),
                    headers=[('Content-Type', 'text/plain')])

            wb = openpyxl.Workbook()
            ws = wb.active
            ws.title = cfg['sheet_title']
            n_cols = len(cfg['headers'])

            # Title row
            title_font = Font(bold=True, size=14, color='FFFFFF')
            title_fill = PatternFill('solid', fgColor='305496')
            ws.cell(row=1, column=1, value=cfg['title'])
            ws.cell(row=1, column=1).font = title_font
            ws.cell(row=1, column=1).fill = title_fill
            ws.cell(row=1, column=1).alignment = Alignment(horizontal='center', vertical='center')
            ws.merge_cells(start_row=1, end_row=1, start_column=1, end_column=n_cols)
            ws.row_dimensions[1].height = 26

            # Header row (row 2)
            hf = Font(bold=True, color='FFFFFF')
            fill = PatternFill('solid', fgColor='4F81BD')
            for col, h in enumerate(cfg['headers'], start=1):
                c = ws.cell(row=2, column=col, value=h)
                c.font = hf
                c.fill = fill
                c.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
            ws.row_dimensions[2].height = 32

            # Sample row (row 3)
            for col, v in enumerate(cfg['sample'], start=1):
                c = ws.cell(row=3, column=col, value=v)
                c.alignment = Alignment(wrap_text=True, vertical='top')

            # Column widths
            for i, w in enumerate(cfg['widths'], start=1):
                ws.column_dimensions[get_column_letter(i)].width = w

            # Freeze top 2 rows
            ws.freeze_panes = 'A3'

            buf = BytesIO()
            wb.save(buf)
            return request.make_response(buf.getvalue(), headers=[
                ('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
                ('Content-Disposition', f'attachment; filename="{cfg["filename"]}"'),
            ])
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"download_template: {str(e)}")
            return request.make_response(b'Error generating template: ' + str(e).encode(),
                headers=[('Content-Type', 'text/plain')])

    @http.route('/kpi_completion_cert/pdf_b64', type='json', auth='user', methods=['POST'], csrf=False)
    def completion_cert_pdf_b64(self, **params):
        """The certificate as base64, for the mobile app.

        The app cannot use the type='http' download routes — it does not send the
        session cookie — which is why the invoice and the daily report both have a
        JSON sibling. Same reason here: without this the app can say "certificate
        available" but has no way to hand it over.
        """
        try:
            kpi = request.env['kra.kpi'].sudo().browse(int(params.get('kpi_id') or 0))
            if not kpi.exists() or not kpi.signed_certificate:
                return {'status': False, 'message': 'No certificate for this task.'}
            if not self._is_client_authorized_for_kpi(kpi) and self._is_current_user_client_only():
                return {'status': False, 'message': 'Not authorized for this task.'}
            import base64 as _b
            blob = _b.b64decode(kpi.signed_certificate)
            fname = kpi.signed_certificate_name or f'signed_cert_{kpi.id}.pdf'
            data, fname, mime = self._certificate_payload(kpi, blob, fname)
            return {'status': True, 'file_name': fname, 'mimetype': mime,
                    'data_b64': _b.b64encode(data).decode()}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"completion_cert_pdf_b64: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_completion_cert/download_doc', type='http', auth='user')
    def download_kpi_doc(self, kpi_id=None, doc_type='requirement', **kw):
        """Stream the stored doc back as a file download. doc_type='requirement'|'updates'."""
        import base64
        try:
            if not kpi_id:
                return request.not_found()
            kpi = request.env['kra.kpi'].browse(int(kpi_id))
            if not kpi.exists():
                return request.not_found()
            # This route had NO access check beyond auth='user': any logged-in user
            # could pull any task's requirement doc or signed certificate by guessing
            # an id. A client is scoped to their own KRA tree, exactly as
            # /kpi_client_portal/download_cert already does; staff keep the broad
            # access they need to do the work. not_found rather than a message —
            # confirming a document exists is itself a leak.
            if self._is_current_user_client_only():
                allowed = set()
                for k in self._resolve_client_kras_for_user():
                    allowed.update(k._get_descendant_ids())
                if kpi.kra_id.id not in allowed:
                    return request.not_found()
            if doc_type == 'updates':
                blob = kpi.updates_document
                fname = kpi.updates_document_name or f'updates_{kpi.id}.bin'
            elif doc_type == 'signed':
                blob = kpi.signed_certificate
                fname = kpi.signed_certificate_name or f'signed_cert_{kpi.id}.pdf'
            else:
                blob = kpi.requirement_document
                fname = kpi.requirement_document_name or f'requirement_{kpi.id}.bin'
            if not blob:
                return request.not_found()
            data = base64.b64decode(blob)
            mime = 'application/octet-stream'
            if doc_type == 'signed':
                # Same treatment as the client portal: a legacy text receipt is
                # rendered into the branded PDF, an uploaded scan is served as-is.
                data, fname, mime = self._certificate_payload(kpi, data, fname)
            # ?inline=1: show it in the browser (the View popup) instead of saving.
            from .kra_api import serve_file, _guess_mime
            return serve_file(data, fname, _guess_mime(fname, mime or ''),
                              inline=kw.get('inline') in ('1', 'true'))
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"download_kpi_doc: {str(e)}")
            return request.not_found()

    @http.route('/kpi_client_invoice/reset_draft', type='json', auth='user', methods=['POST'], csrf=False)
    def reset_client_invoice_draft(self, **params):
        try:
            inv = request.env['kpi.client.invoice'].browse(int(params['invoice_id']))
            if not inv.exists():
                return {'status': False, 'message': 'Invoice not found.'}
            inv.action_reset_draft()
            return {'status': True, 'data': inv._serialize_for_ui()}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"reset_client_invoice_draft: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_invoice/revise', type='json', auth='user', methods=['POST'], csrf=False)
    def revise_client_invoice(self, **params):
        """Reopen a FINALIZED invoice to reduce it, recording who and why.

        Admin-only, and the model refuses anything that is sent or paid. Separate from
        reset_draft because this one is a deliberate, reasoned correction that the
        client will be told about — not a quiet un-finalize.
        """
        try:
            user = request.env.user
            allowed = (
                user.has_group('base.group_system')
                or user.has_group('kra_kpi_module.group_kra_owner')
                or user.has_group('kra_kpi_module.group_kra_admin')
            )
            if not allowed:
                return {'status': False, 'message': 'Not authorized.'}
            inv = request.env['kpi.client.invoice'].browse(int(params.get('invoice_id') or 0))
            if not inv.exists():
                return {'status': False, 'message': 'Invoice not found.'}
            inv.action_revise(reason=params.get('reason') or '')
            return {'status': True, 'data': inv._serialize_for_ui()}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"revise_client_invoice: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_client_invoice/clear_paid_claim', type='json', auth='user', methods=['POST'], csrf=False)
    def clear_client_paid_claim(self, **params):
        """Admin dismisses a client's payment claim that turned out to be wrong.

        Without this a mistaken tap sticks forever: the client can't claim twice (their
        button is gone once claimed) and only marking the invoice actually paid cleared
        the flag — which is precisely the thing you don't want to do to correct it.
        """
        try:
            user = request.env.user
            allowed = (
                user.has_group('base.group_system')
                or user.has_group('kra_kpi_module.group_kra_owner')
                or user.has_group('kra_kpi_module.group_kra_admin')
            )
            if not allowed:
                return {'status': False, 'message': 'Not authorized.'}
            inv = request.env['kpi.client.invoice'].browse(int(params.get('invoice_id') or 0))
            if not inv.exists():
                return {'status': False, 'message': 'Invoice not found.'}
            inv.write({
                'client_paid_claim': False,
                'client_paid_claim_date': False,
                'client_paid_method': False,
                'client_paid_notes': False,
            })
            return {'status': True, 'data': inv._serialize_for_ui()}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"clear_client_paid_claim: {str(e)}")
            return {'status': False, 'message': str(e)}