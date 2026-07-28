from odoo import http, api, fields
from odoo.exceptions import UserError, ValidationError
from odoo.http import request
from odoo.addons.kra_kpi_module.models.kpi_workflow import (
    NAME_PREFIX_FOR_DOC_TYPE,
    REF_PREFIX_FOR_DOC_TYPE,
)
import json
import logging
import base64
import mimetypes
import os
import pytz
import re

_logger = logging.getLogger(__name__)


def normalize_wa(number, dial, length):
    """Normalize a WhatsApp number to bare `<dial><local>` digits.

    Lenient (never rejects): strips non-digits, drops a leading trunk 0, and
    prefixes the dial code when the number is exactly `length` local digits.
    Numbers that already include the dial code (or don't match the expected
    length) are returned as digits-only, unchanged in structure. Matches how
    kpi_notify consumes bare-digit numbers.
    """
    if not number:
        return ''
    digits = re.sub(r'\D', '', str(number))
    if not digits:
        return ''
    dial = re.sub(r'\D', '', str(dial or '')) or '91'
    try:
        length = int(length) or 10
    except (TypeError, ValueError):
        length = 10
    # Already prefixed with the dial code at the expected total length.
    if digits.startswith(dial) and len(digits) == len(dial) + length:
        return digits
    # Leading trunk 0 + local length → replace 0 with dial code.
    if digits.startswith('0') and len(digits) == length + 1:
        return dial + digits[1:]
    # Plain local-length number → prefix the dial code.
    if len(digits) == length:
        return dial + digits
    # Anything else: leave the digits as-is (don't corrupt existing data).
    return digits


def _gate_keys(k):
    """Approval-gate state for one task, in the shape every board consumes.

    Shared by get_tasks' map_rec and _serialize_task so the two near-duplicate
    serializers cannot disagree about whether a task can start.

    can_start is the SERVER's own answer (kra.kpi._start_block), not something
    the caller re-derives from task_state. That re-derivation is what let the
    boards offer a Start button the server then refused, and hide one it would
    have allowed.

    The two deadlines are emitted as raw UTC to match the `server_now` value on
    the envelope — a countdown must compare like with like, so neither end is
    converted to the user's timezone.
    """
    fmt = '%Y-%m-%d %H:%M:%S'
    block = k._start_block()
    return {
        'can_start': not block,
        'start_block_reason': block[0] if block else '',
        'start_block_message': block[1] if block else '',
        'pre_approval_decision': k.pre_approval_decision or '',
        'pre_approval_auto_released': k.pre_approval_auto_released,
        'pre_approval_auto_released_at': (
            k.pre_approval_auto_released_at.strftime(fmt)
            if k.pre_approval_auto_released_at else ''),
        'pre_approval_held': k.pre_approval_held,
        # Deadline the client is counting down against (empty once the reminder
        # ladder is exhausted — the release clock below is the one that matters).
        'pre_approval_deadline_at': (
            k.pre_approval_deadline_at.strftime(fmt) if k.pre_approval_deadline_at else ''),
        'pre_approval_release_at': (
            k.pre_approval_release_at.strftime(fmt) if k.pre_approval_release_at else ''),
        'admin_accept_deadline_at': (
            k.admin_accept_deadline_at.strftime(fmt) if k.admin_accept_deadline_at else ''),
        'admin_accepted_auto': k.admin_accepted_auto,
    }


def convert_to_user_tz(datetime_obj, user=None):
    """
    Convert a UTC datetime to user's timezone.
    Odoo stores all Datetime fields in UTC in the database.
    """
    if not datetime_obj:
        return ''
    
    if user is None:
        user = request.env.user
    
    # Get user's timezone, default to Asia/Kolkata if not set
    user_tz = user.tz or 'Asia/Kolkata'
    
    try:
        # Ensure the datetime is timezone-aware (UTC)
        if datetime_obj.tzinfo is None:
            utc_dt = pytz.UTC.localize(datetime_obj)
        else:
            utc_dt = datetime_obj
        
        # Convert to user's timezone
        local_tz = pytz.timezone(user_tz)
        local_dt = utc_dt.astimezone(local_tz)
        
        # Return ISO format string that JavaScript can parse correctly
        return local_dt.strftime('%Y-%m-%d %H:%M:%S')
    except Exception as e:
        _logger.error(f"Timezone conversion error: {e}")
        return str(datetime_obj)


class KraKpiAPI(http.Controller):

    @http.route('/kra_kpi/get_users', type='json', auth='user')
    def get_users(self):
        users = request.env['res.users'].sudo().search([])
        return [{"id": u.id, "name": u.name} for u in users]
    
    @http.route('/kra_kpi/task/reassign', type='json', auth='user', methods=['POST'], csrf=False)
    def task_reassign(self, **params):
        """
        🆕 UPDATED: Reassign task with reason and history tracking
        """
        kpi_id = params.get('kpi_id')
        user_id = params.get('user_id')
        reason = params.get('reason', '').strip()

        # Validation
        if not kpi_id or not user_id:
            return {'status': False, 'message': 'kpi_id or user_id missing'}
        
        if not reason:
            return {'status': False, 'message': 'Reason for reassignment is required'}

        rec = request.env['kra.kpi'].sudo().browse(int(kpi_id))

        _logger.info(f"Reassigning task {kpi_id} to user {user_id}. Reason: {reason}")

        if not rec.exists():
            return {'status': False, 'message': 'Task not found'}

        # Call the updated reassign_task method with reason
        rec.reassign_task(user_id, reason)
        
        return {
            'status': True, 
            'message': 'Task reassigned successfully with history logged', 
            'id': rec.id,
            'new_state': rec.task_state,
            'new_assignee': rec.user_id.name if rec.user_id else '',
        }
    
    # 🆕 NEW: Get reassignment history for a KPI
    @http.route('/kra_kpi/reassignment_history', type='json', auth='user', methods=['POST'], csrf=False)
    def get_reassignment_history(self, **params):
        """Get reassignment history for a KPI task"""
        kpi_id = params.get('kpi_id')
        
        if not kpi_id:
            return {'status': False, 'message': 'kpi_id missing'}
        
        kpi = request.env['kra.kpi'].sudo().browse(int(kpi_id))
        
        if not kpi.exists():
            return {'status': False, 'message': 'KPI not found'}
        
        history_records = request.env['kpi.reassignment.history'].sudo().search([
            ('kpi_id', '=', int(kpi_id))
        ], order='reassignment_date desc')
        
        history_list = []
        for hist in history_records:
            history_list.append({
                'id': hist.id,
                'previous_assignee': hist.previous_assignee_name,
                'new_assignee': hist.new_assignee_name,
                'reassigned_by': hist.reassigned_by_name,
                'reassignment_date': convert_to_user_tz(hist.reassignment_date),
                'reason': hist.reassignment_reason,
                'previous_state': hist.previous_state,
                'time_spent': hist.time_spent_display,
                'was_paused': hist.was_paused,
                'pause_reason': hist.pause_reason or '',
            })
        
        return {
            'status': True,
            'history': history_list,
            'count': len(history_list),
            'text_log': kpi.reassignment_log or '',
        }

    # 🆕 NEW: GLOBAL reassignment history (admin-only) — powers the mobile app's
    # "Reassignment History" screen. The route above is per-task (needs kpi_id);
    # this one lists every reassignment across all tasks, newest first.
    @http.route('/kra_kpi/reassignment_history/all', type='json', auth='user', methods=['POST'], csrf=False)
    def get_reassignment_history_all(self, **params):
        """Admin-only global reassignment history list (Coordinator / Owner / System)."""
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        try:
            limit = int(params.get('limit') or 200)
        except (TypeError, ValueError):
            limit = 200
        # _order = "reassignment_date desc" on the model → newest first.
        recs = request.env['kpi.reassignment.history'].sudo().search([], limit=limit)
        history = []
        for h in recs:
            history.append({
                'id': h.id,
                'reassignment_date': convert_to_user_tz(h.reassignment_date),
                'kpi_id': h.kpi_id.id,
                'kpi_task': h.kpi_id.external_ref or h.kpi_id.name or '',
                'kpi_name': h.kpi_id.name or '',
                'previous_assignee': h.previous_assignee_name,
                'new_assignee': h.new_assignee_name,
                'reassigned_by': h.reassigned_by_name,
                'previous_state': h.previous_state,
                'time_spent': h.time_spent_display,
                'reason': h.reassignment_reason or '',
                'was_paused': h.was_paused,
                'pause_reason': h.pause_reason or '',
            })
        return {'status': True, 'history': history, 'count': len(history)}

    @http.route('/kra_kpi/get_kra_list', type='json', auth='user', methods=['POST'], csrf=False)
    def get_kra_list(self):
        kra_records = request.env['kra.master'].search([])

        def build_tree(kra_list):
            output = []
            for kra in kra_list:
                output.append({
                    "id": kra.id,
                    "name": kra.name,
                    "is_sub": kra.is_sub,
                    "is_client": bool(kra.is_client),
                    "parent_id": kra.parent_id.id if kra.parent_id else False,
                    "client_user_ids": [
                        {"id": u.id, "name": u.name or u.login, "login": u.login}
                        for u in kra.client_user_ids
                    ],
                    "children": build_tree(kra.child_ids),
                    "kpi_ids": [{
                        "id": kpi.id,
                        "name": kpi.name,
                        "estimate": f"{kpi.estimate_hours:02d}:{kpi.estimate_minutes:02d}",
                        "estimate_hours": kpi.estimate_hours,
                        "estimate_minutes": kpi.estimate_minutes,
                        "manual_count": len(kpi.user_manual_ids),  # ✅ ADD THIS
                    } for kpi in kra.kpi_ids],
                })
            return output

        parent_kras = kra_records.filtered(lambda r: not r.parent_id)

        return {
            "status": True,
            "tree": build_tree(parent_kras),
        }

    @http.route('/kra_kpi/create_kra', type='json', auth='user', methods=['POST'], csrf=False)
    def create_kra(self, **params):
        name = params.get("name")
        is_sub = params.get("is_sub")
        parent_id = params.get("parent_id")

        if not name:
            return {"status": False, "message": "Name is required"}

        kra_vals = {
            "name": name,
            "is_sub": is_sub,
        }

        if is_sub and parent_id:
            kra_vals["parent_id"] = int(parent_id)

        kra = request.env["kra.master"].create(kra_vals)

        return {
            "status": True,
            "message": "KRA Created",
            "id": kra.id,
        }

    @http.route('/kra_kpi/create_kpi', type='json', auth='user', methods=['POST'], csrf=False)
    def create_kpi(self, **params):

        if not params.get("kra_id"):
            return {"status": False, "message": "KRA ID missing"}

        kpi_vals = {
            "name": params.get("name"),
            "unit": params.get("unit"),
            "estimate": params.get("estimate") or 0,
            "kra_id": int(params.get("kra_id")),
            "priority": params.get("priority") or "regular",
            "task_state": "assigned",
            "points": params.get("points") or 0,
            "user_id": int(params["user_id"]) if params.get("user_id") else False,
            "user_group_id": int(params["user_group_id"]) if params.get("user_group_id") else False,
            "deadline": params.get("deadline") or False,
            "reminder_days": params.get("reminder_days") or 0,
            "reminder_hours": params.get("reminder_hours") or 0,
            "reminder_minutes": params.get("reminder_minutes") or 0,
            "next_kpi_id": int(params["next_kpi_id"]) if params.get("next_kpi_id") else False,
            "warehouse_id": int(params["warehouse_id"]) if params.get("warehouse_id") else False,
            "file_name": params.get("file_name"),
            "uploaded_file": params.get("uploaded_file"),
            "action_config_id": int(params["action_config_id"]) if params.get("action_config_id") else False,
            "description": params.get("description"),
            "checklist": params.get("checklist"),
            "guidelines": params.get("guidelines"),
            "is_mandatory": params.get("is_mandatory", False),
            "auto_assign": params.get("auto_assign", False),
            "auto_estimated": params.get("auto_estimated", False),
            "is_permanent": params.get("is_permanent", False),
            "service_kpi": params.get("service_kpi", False),
            "is_meeting": params.get("is_meeting", False),
            "is_manager_review_needed": params.get("is_manager_review_needed", False),
            "is_customer_review_needed": params.get("is_customer_review_needed", False),
            "related_links": params.get("related_links", "[]"),
        }

        kpi_vals["timer_total_seconds"] = 0
        kpi_vals["start_time"] = False
        kpi_vals["paused_reason"] = ""

        kpi = request.env["kra.kpi"].create(kpi_vals)

        return {
            "status": True,
            "message": "KPI Created",
            "id": kpi.id,
        }

    @http.route('/kra_kpi/task/start', type='json', auth='user', methods=['POST'], csrf=False)
    def task_start(self, **params):
        """Start the timer, or explain in plain words why it can't start.

        The guards in start_task raise ValidationError. Letting that escape
        turns into a JSON-RPC fault, which every client renders as a generic
        "Something went wrong" — hiding the one thing the developer needs to
        know (waiting on the admin, waiting on the client, or another task is
        already running). Catching it here is what makes those messages visible.
        """
        kpi_id = params.get('kpi_id')
        if not kpi_id:
            return {'status': False, 'message': 'kpi_id missing'}

        rec = request.env['kra.kpi'].sudo().browse(int(kpi_id))
        if not rec.exists():
            return {'status': False, 'message': 'Task not found'}
        try:
            rec.start_task()
        except (ValidationError, UserError) as exc:
            block = rec._start_block()
            return {'status': False,
                    'message': exc.args[0] if exc.args else 'Cannot start this task.',
                    # 'admin' / 'client' when a gate is the blocker; 'multitask'
                    # when the single-in-progress rule fired instead.
                    'reason': block[0] if block else 'multitask'}
        return {'status': True, 'message': 'Task started', 'id': rec.id,
                'new_state': rec.task_state}

    @http.route('/kra_kpi/task/pause', type='json', auth='user', methods=['POST'], csrf=False)
    def task_pause(self, **params):
        kpi_id = params.get('kpi_id')
        reason = params.get('reason') or ''
        reason_code = params.get('reason_code') or False
        if not kpi_id:
            return {'status': False, 'message': 'kpi_id missing'}

        rec = request.env['kra.kpi'].sudo().browse(int(kpi_id))
        rec.pause_task(reason, reason_code=reason_code)
        return {'status': True, 'message': 'Task paused', 'id': rec.id}

    @http.route('/kra_kpi/task/resume', type='json', auth='user', methods=['POST'], csrf=False)
    def task_resume(self, **params):
        """Resume the timer. Same error contract as /task/start — resume_task
        runs the identical guards, so it needs the identical handling."""
        kpi_id = params.get('kpi_id')
        if not kpi_id:
            return {'status': False, 'message': 'kpi_id missing'}

        rec = request.env['kra.kpi'].sudo().browse(int(kpi_id))
        if not rec.exists():
            return {'status': False, 'message': 'Task not found'}
        try:
            rec.resume_task()
        except (ValidationError, UserError) as exc:
            block = rec._start_block()
            return {'status': False,
                    'message': exc.args[0] if exc.args else 'Cannot resume this task.',
                    'reason': block[0] if block else 'multitask'}
        return {'status': True, 'message': 'Task resumed', 'id': rec.id,
                'new_state': rec.task_state}

    @http.route('/kra_kpi/task/resume_with_reason', type='json', auth='user', methods=['POST'], csrf=False)
    def task_resume_with_reason(self, **params):
        """Developer resumes a task that an admin sent back — records their
        response ("what I changed") and then resumes. Reason is required."""
        kpi_id = params.get('kpi_id')
        reason = (params.get('reason') or '').strip()
        if not kpi_id:
            return {'status': False, 'message': 'kpi_id missing'}
        if not reason:
            return {'status': False, 'message': 'Please say what you changed before resuming.'}
        rec = request.env['kra.kpi'].sudo().browse(int(kpi_id))
        if not rec.exists():
            return {'status': False, 'message': 'Task not found'}
        user = request.env.user
        # Only the assigned developer (or an admin) may respond & resume.
        if rec.user_id and rec.user_id.id != user.id and not self._is_kra_admin(user):
            return {'status': False, 'message': 'Only the assigned developer can resume this task.'}
        rec.write({
            'self_resume_note': reason,
            'self_resume_by': user.name,
            'self_needs_resume_reason': False,
        })
        # The developer has answered the send-back, so the task is waiting on an
        # admin again — restart the acceptance clock (force=True: the send-back
        # cleared it, and a revised task must not sit un-timed forever).
        rec._arm_admin_accept_deadline(force=True)
        try:
            rec.resume_task()
        except (ValidationError, UserError) as exc:
            return {'status': False,
                    'message': exc.args[0] if exc.args else 'Cannot resume this task.'}
        return {'status': True, 'message': 'Resumed', 'id': rec.id}

    @http.route('/kra_kpi/task/complete', type='json', auth='user', methods=['POST'], csrf=False)
    def task_complete(self, **params):
        kpi_id = params.get('kpi_id')
        employee_checklist = params.get('employee_checklist', {}) or {}
        is_partial = bool(params.get('partial'))

        if not kpi_id:
            return {'status': False, 'message': 'kpi_id missing'}

        rec = request.env['kra.kpi'].sudo().browse(int(kpi_id))
        if not rec.exists():
            return {'status': False, 'message': 'Task not found'}

        # 🆕 Part B guard — a task can only be completed after a Progress Summary
        # has been recorded. Keeps both "Complete" and "Partial Finish" honest and
        # always leaves the reviewer something to read.
        has_summary = request.env['kpi.progress'].sudo().search_count([('kpi_id', '=', rec.id)]) > 0
        if not has_summary:
            return {'status': False,
                    'message': 'Please submit a Progress Summary before completing this task.'}

        # A full "Complete" (not a Partial Finish) requires every checklist item.
        if not is_partial:
            required = ('verify_github', 'deployed_task', 'user_manual', 'documentation', 'tested_code')
            missing = [k for k in required if not employee_checklist.get(k)]
            if missing:
                return {'status': False,
                        'message': 'Please confirm all checklist items before completing '
                                   '(or use "Partial Finish" to send a summary only).'}

        rec.complete_task(employee_checklist)

        return {
            'status': True,
            'message': 'Task marked as completed',
            'id': rec.id,
            'new_state': rec.task_state,
        }

    @http.route('/kpi_action/heartbeat', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_action_heartbeat(self, **params):
        """Board heartbeat (~60s). Keeps the session 'alive' for the auto-away cron
        and tells the board if a task was auto-paused while the developer was gone."""
        return request.env['kpi.work.session'].sudo().touch_heartbeat(user=request.env.user)

    @http.route('/kpi_action/leave', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_action_leave(self, **params):
        """Awaited by the board on a confirmed Back navigation: immediately put
        the developer into 'away' (pause running task + un-pair + notify) BEFORE
        the page navigates, so the pause is guaranteed to commit. JSON so the
        board can `await rpc('/kpi_action/leave')`."""
        try:
            request.env['kpi.work.session'].sudo()._mark_leaving(request.env.user)
        except Exception as exc:
            _logger.warning("kpi_action/leave failed: %s", exc)
        return {'status': True}

    @http.route('/kpi_action/leave_beacon', type='http', auth='user', methods=['POST'], csrf=False)
    def kpi_action_leave_beacon(self, **params):
        """Fired via navigator.sendBeacon on a real tab close/reload (beforeunload),
        where an awaited rpc is impossible. Same effect as /kpi_action/leave.
        type='http' so sendBeacon (same-origin, sends the session cookie) works."""
        try:
            request.env['kpi.work.session'].sudo()._mark_leaving(request.env.user)
        except Exception as exc:
            _logger.warning("kpi_action/leave_beacon failed: %s", exc)
        return request.make_response('ok', headers=[('Content-Type', 'text/plain')])

    @http.route('/kpi_action/live_status', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_action_live_status(self, **params):
        """Live activity strip data: running task, active break, day anchors."""
        return request.env['kpi.work.session'].sudo().live_status(user=request.env.user)

    @http.route('/kra_kpi/tasks/get', type='json', auth='user', methods=['POST'], csrf=False)
    def get_tasks(self, **params):
        """Get tasks for KPI Action Board
        
        🆕 UPDATED: Now accepts 'my_tasks_only' parameter
        When my_tasks_only=True, admin/manager will only see their own assigned tasks
        """
        current_user = request.env.user
        my_tasks_only = params.get('my_tasks_only', False)
        
        is_manager_or_admin = (
            current_user.has_group('kra_kpi_module.group_kra_owner') or
            current_user.has_group('kra_kpi_module.group_kra_admin') or
            current_user.has_group('kra_kpi_module.group_kra_manager') or
            current_user.has_group('base.group_system')
        )
        
        # 🆕 UPDATED: If admin wants to see only their tasks, filter by current user
        if is_manager_or_admin and not my_tasks_only:
            domain = []  # Show all tasks
        else:
            domain = [('user_id', '=', current_user.id)]  # Show only user's tasks
        
        kpis = request.env['kra.kpi'].search(domain)

        # Per-developer time on each task (survives reassignment — kpi.time.log
        # rows are kept per user). One batched read_group for all listed tasks,
        # plus the live is_active segment folded into that user's total so the
        # currently-working developer's time is up to date.
        time_map = {}   # kpi_id -> {user_id: {'name', 'seconds'}}
        if kpis.ids:
            TimeLog = request.env['kpi.time.log'].sudo()
            for g in TimeLog.read_group(
                    [('kpi_id', 'in', kpis.ids), ('is_active', '=', False)],
                    ['duration_seconds:sum'], ['kpi_id', 'user_id'], lazy=False):
                kid = g['kpi_id'][0] if g.get('kpi_id') else False
                uid = g['user_id'][0] if g.get('user_id') else False
                if not kid or not uid:
                    continue
                time_map.setdefault(kid, {})[uid] = {
                    'name': g['user_id'][1], 'seconds': g.get('duration_seconds') or 0.0}
            now = fields.Datetime.now()
            for a in TimeLog.search([('kpi_id', 'in', kpis.ids), ('is_active', '=', True)]):
                if not (a.kpi_id and a.user_id and a.start_time):
                    continue
                d = time_map.setdefault(a.kpi_id.id, {}).setdefault(
                    a.user_id.id, {'name': a.user_id.name, 'seconds': 0.0})
                d['seconds'] += max(0.0, (now - a.start_time).total_seconds())

        def _fmt_dur(sec):
            sec = int(sec or 0)
            return f"{sec // 3600}h {(sec % 3600) // 60}m"

        def _time_by_user(k):
            rows = []
            for uid, info in (time_map.get(k.id) or {}).items():
                rows.append({
                    'user_id': uid,
                    'user_name': info['name'] or '',
                    'seconds': round(info['seconds'], 2),
                    'display': _fmt_dur(info['seconds']),
                    'is_current': bool(k.user_id and uid == k.user_id.id),
                })
            rows.sort(key=lambda r: r['seconds'], reverse=True)
            return rows

        def map_rec(k):
            # For in_progress tasks, include timer_start_datetime for real-time calculation
            timer_start_iso = None
            if k.task_state == 'in_progress' and k.timer_start_datetime:
                # Convert to ISO format string for JavaScript Date parsing
                timer_start_iso = k.timer_start_datetime.isoformat() + 'Z'  # Add Z for UTC
            
            return {
                'id': k.id,
                'name': k.name or "",
                'priority': k.priority or "regular",
                'task_state': k.task_state or "assigned",
                'user_id': (k.user_id.id if k.user_id else False),
                'user_name': (k.user_id.name if k.user_id else ""),
                'estimate_display': f"{k.estimate_hours:02d}:{k.estimate_minutes:02d}",
                'estimate_hours': k.estimate_hours or 0,
                'estimate_minutes': k.estimate_minutes or 0,
                'timer_total_seconds': k.timer_total_seconds or 0,
                'timer_start_datetime': timer_start_iso,  # For real-time timer calculation
                'paused_reason': k.paused_reason or "",
                'description': k.description or "",
                'progress_count': k.progress_count or 0,
                'completed_by_id': k.completed_by.id if k.completed_by else False,
                'completed_by_name': k.completed_by.name if k.completed_by else "",
                'completion_date': convert_to_user_tz(k.completion_date) if k.completion_date else "",
                'approved_by_id': k.approved_by.id if k.approved_by else False,
                'approved_by_name': k.approved_by.name if k.approved_by else "",
                'approval_date': convert_to_user_tz(k.approval_date) if k.approval_date else "",
                # Coordinator review-started timestamp (simplification — stamped on
                # first open of approve/reject modal while task is partially_completed).
                'coordinator_review_started_at': (
                    convert_to_user_tz(k.coordinator_review_started_at)
                    if k.coordinator_review_started_at else ""
                ),
                'coordinator_review_started_by_name': (
                    k.coordinator_review_started_by.name
                    if k.coordinator_review_started_by else ""
                ),
                # Reminder and deadline notification fields
                'deadline': str(k.deadline) if k.deadline else "",
                'reminder_days': k.reminder_days or 0,
                'reminder_hours': k.reminder_hours or 0,
                'reminder_minutes': k.reminder_minutes or 0,
                'last_reminder_shown': convert_to_user_tz(k.last_reminder_shown) if k.last_reminder_shown else "",
                'deadline_alert_shown': k.deadline_alert_shown or False,
                # Developer self-created / "Pending Review" lane
                'is_self_created': k.is_self_created,
                'admin_accepted': k.admin_accepted,
                'requested_by_id': k.requested_by_id.id if k.requested_by_id else False,
                'requested_by_name': k.requested_by_id.name if k.requested_by_id else "",
                'self_review_note': k.self_review_note or "",
                'self_review_by': k.self_review_by or "",
                'self_resume_note': k.self_resume_note or "",
                'self_resume_by': k.self_resume_by or "",
                'self_needs_resume_reason': k.self_needs_resume_reason,
                # Gate state. can_start comes straight from the server's own rule
                # (_start_block), so a board never has to re-derive "is this
                # startable?" from a hand-maintained list of states — which is
                # exactly how the UI drifted out of step with the server before.
                **_gate_keys(k),
                # Per-developer time (survives reassign); current holder flagged.
                'time_by_user': _time_by_user(k),
            }

        self_pending = kpis.filtered(lambda x: x.is_self_created and not x.admin_accepted)
        company = request.env.company
        return {
            'status': True,
            'tasks': [map_rec(x) for x in kpis],
            'is_admin': is_manager_or_admin,
            'current_user_id': current_user.id,  # 🆕 NEW: Include current user ID for rejection checks
            'self_pending_count': len(self_pending),  # Pending Review lane badge
            # Skew anchor for the countdown chips: clients must measure the two
            # deadlines against the SERVER's clock, not the device's.
            'server_now': fields.Datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'admin_accept_minutes': (company.admin_accept_minutes
                                     if company.admin_accept_minutes not in (None, False, '')
                                     else 5),
            'client_approval_minutes': company.client_approval_minutes or 5,
        }

    def _task_time_by_user(self, k):
        """Per-developer time rows for a single task (mirrors get_tasks' batched
        version, computed for one kpi)."""
        TimeLog = request.env['kpi.time.log'].sudo()
        time_map = {}
        for g in TimeLog.read_group(
                [('kpi_id', '=', k.id), ('is_active', '=', False)],
                ['duration_seconds:sum'], ['user_id'], lazy=False):
            uid = g['user_id'][0] if g.get('user_id') else False
            if not uid:
                continue
            time_map[uid] = {'name': g['user_id'][1], 'seconds': g.get('duration_seconds') or 0.0}
        now = fields.Datetime.now()
        for a in TimeLog.search([('kpi_id', '=', k.id), ('is_active', '=', True)]):
            if not (a.user_id and a.start_time):
                continue
            d = time_map.setdefault(a.user_id.id, {'name': a.user_id.name, 'seconds': 0.0})
            d['seconds'] += max(0.0, (now - a.start_time).total_seconds())
        rows = []
        for uid, info in time_map.items():
            sec = int(info['seconds'] or 0)
            rows.append({
                'user_id': uid,
                'user_name': info['name'] or '',
                'seconds': round(info['seconds'], 2),
                'display': f"{sec // 3600}h {(sec % 3600) // 60}m",
                'is_current': bool(k.user_id and uid == k.user_id.id),
            })
        rows.sort(key=lambda r: r['seconds'], reverse=True)
        return rows

    def _serialize_task(self, k):
        """Serialize one kra.kpi to the SAME shape /kra_kpi/tasks/get returns, so a
        single fetched task can be dropped straight into the mobile board."""
        timer_start_iso = None
        if k.task_state == 'in_progress' and k.timer_start_datetime:
            timer_start_iso = k.timer_start_datetime.isoformat() + 'Z'
        return {
            'id': k.id,
            'name': k.name or "",
            'priority': k.priority or "regular",
            'task_state': k.task_state or "assigned",
            'user_id': (k.user_id.id if k.user_id else False),
            'user_name': (k.user_id.name if k.user_id else ""),
            'estimate_display': f"{k.estimate_hours:02d}:{k.estimate_minutes:02d}",
            'estimate_hours': k.estimate_hours or 0,
            'estimate_minutes': k.estimate_minutes or 0,
            'timer_total_seconds': k.timer_total_seconds or 0,
            'timer_start_datetime': timer_start_iso,
            'paused_reason': k.paused_reason or "",
            'description': k.description or "",
            'progress_count': k.progress_count or 0,
            'completed_by_id': k.completed_by.id if k.completed_by else False,
            'completed_by_name': k.completed_by.name if k.completed_by else "",
            'completion_date': convert_to_user_tz(k.completion_date) if k.completion_date else "",
            'approved_by_id': k.approved_by.id if k.approved_by else False,
            'approved_by_name': k.approved_by.name if k.approved_by else "",
            'approval_date': convert_to_user_tz(k.approval_date) if k.approval_date else "",
            'coordinator_review_started_at': (
                convert_to_user_tz(k.coordinator_review_started_at)
                if k.coordinator_review_started_at else ""),
            'coordinator_review_started_by_name': (
                k.coordinator_review_started_by.name
                if k.coordinator_review_started_by else ""),
            'deadline': str(k.deadline) if k.deadline else "",
            'reminder_days': k.reminder_days or 0,
            'reminder_hours': k.reminder_hours or 0,
            'reminder_minutes': k.reminder_minutes or 0,
            'last_reminder_shown': convert_to_user_tz(k.last_reminder_shown) if k.last_reminder_shown else "",
            'deadline_alert_shown': k.deadline_alert_shown or False,
            'is_self_created': k.is_self_created,
            'admin_accepted': k.admin_accepted,
            'requested_by_id': k.requested_by_id.id if k.requested_by_id else False,
            'requested_by_name': k.requested_by_id.name if k.requested_by_id else "",
            'self_review_note': k.self_review_note or "",
            'self_review_by': k.self_review_by or "",
            'self_resume_note': k.self_resume_note or "",
            'self_resume_by': k.self_resume_by or "",
            'self_needs_resume_reason': k.self_needs_resume_reason,
            # Same gate keys as get_tasks — see _gate_keys.
            **_gate_keys(k),
            'time_by_user': self._task_time_by_user(k),
        }

    @http.route('/kra_kpi/task/get', type='json', auth='user', methods=['POST'], csrf=False)
    def get_single_task(self, **params):
        """Fetch ONE task by id — used when a notification points to a task that is
        not in the caller's scoped board list (reassigned away / completed). Allowed
        for admins, the task's assignee, or anyone who has a notification for it."""
        kpi_id = int(params.get('kpi_id') or 0)
        if not kpi_id:
            return {'status': False, 'message': 'kpi_id required'}
        user = request.env.user
        kpi = request.env['kra.kpi'].sudo().browse(kpi_id)
        if not kpi.exists():
            return {'status': False, 'message': 'Task not found'}
        is_admin = self._is_kra_admin(user)
        is_owner = bool(kpi.user_id and kpi.user_id.id == user.id)
        was_notified = request.env['kpi.notification'].sudo().search_count(
            [('user_id', '=', user.id), ('kpi_id', '=', kpi_id)]) > 0
        if not (is_admin or is_owner or was_notified):
            return {'status': False, 'message': 'Not authorized'}
        return {'status': True, 'task': self._serialize_task(kpi)}

    @http.route('/kra_kpi/task/details', type='json', auth='user', methods=['POST'], csrf=False)
    def get_task_details(self, **params):
        """Task meta + its uploads, for the app's KPI Details popup.

        One round-trip on purpose: the web detail pane (kpi_action.js) fans out to
        seven sequential calls, which is fine on a desk and miserable on a phone.
        The app already holds the meta in memory from /kra_kpi/tasks/get, so the
        payload it actually needs from here is `manuals` — the previous uploads a
        developer opens the popup to check — but the task is re-serialized too so
        the popup can refresh stale card data in the same trip.

        Access: _may_view_kpi_details — admin/coordinator any, developer own, client never.
        """
        kpi_id = int(params.get('kpi_id') or 0)
        if not kpi_id:
            return {'status': False, 'message': 'kpi_id required'}
        kpi = request.env['kra.kpi'].sudo().browse(kpi_id)
        if not kpi.exists():
            return {'status': False, 'message': 'Task not found'}
        denied = self._may_view_kpi_details(kpi)
        if denied:
            return {'status': False, 'message': denied}

        Env = request.env
        manuals = Env['kpi.user.manual'].sudo().search(
            [('kpi_id', '=', kpi_id)], order='upload_date desc')
        progress = Env['kpi.progress'].sudo().search(
            [('kpi_id', '=', kpi_id)], order='create_date desc')
        gh = Env['kpi.github.link'].sudo().search(
            [('kpi_id', '=', kpi_id)], order='create_date desc')
        hist = Env['kpi.reassignment.history'].sudo().search(
            [('kpi_id', '=', kpi_id)], order='reassignment_date desc')

        # Related links: progress-level + task-level, each classified by url.
        # Mirrors /task_documents/details so the two panes agree.
        categorize = Env['kpi.backup'].sudo()._categorize_link
        links = []
        for p in progress:
            try:
                for l in json.loads(p.related_links or '[]'):
                    links.append({
                        'url': l, 'kind': categorize(l),
                        'added_by': p.employee_name or '',
                        'added_date': convert_to_user_tz(p.create_date),
                        # Which update carried this link — lets the app's
                        # "View note" jump to it. False = task-level link.
                        'progress_id': p.id,
                    })
            except Exception:
                pass  # one bad row must not take out the whole detail payload
        try:
            for l in json.loads(kpi.related_links or '[]'):
                links.append({
                    'url': l, 'kind': categorize(l),
                    'added_by': 'Task Creator',
                    'added_date': convert_to_user_tz(kpi.create_date) if kpi.create_date else '',
                    'progress_id': False,
                })
        except Exception:
            pass

        user = request.env.user
        is_admin = self._is_kra_admin(user)
        is_assignee = bool(kpi.user_id and kpi.user_id.id == user.id)
        # Type derived from the name prefix — same rule as /kpi_action/details.
        nm, ref = (kpi.name or ''), (kpi.external_ref or '').upper()
        if nm.startswith('[Update]') or ref.startswith('UPD'):
            kind = 'update'
        elif nm.startswith('[Bug]') or ref.startswith('BUG'):
            kind = 'bug'
        else:
            kind = 'requirement'

        return {
            'status': True,
            'task': self._serialize_task(kpi),
            # Fields the board's task payload (map_rec) doesn't carry but the
            # detail view shows — kept in `meta` so map_rec stays untouched and
            # the board's list call doesn't get heavier for every task.
            'meta': {
                'external_ref': kpi.external_ref or '',
                'kind': kind,
                'kra': kpi.kra_id.name or '',
                'checklist': kpi.checklist or '',
                'guidelines': kpi.guidelines or '',
                'points': kpi.points or 0,
                'is_manager': is_admin,
                'is_assignee': is_assignee,
                # Mirrors the web's Complete panel gate (kpi_action.js): the state
                # must be workable AND you must be the assignee or a manager.
                'can_complete': (kpi.task_state in ('in_progress', 'paused', 'hold', 'rework')
                                 and (is_assignee or is_admin)),
            },
            'manuals': [{
                'id': m.id,
                'file_name': m.file_name or '',
                # `description` is the mandatory "reason" the uploader typed.
                'reason': m.description or '',
                'uploaded_by': m.uploader_name or '',
                'upload_date': convert_to_user_tz(m.upload_date),
                'related_links': m.related_links or '[]',
            } for m in manuals],
            'progress': [{
                'id': p.id,
                'summary': p.summary or '',
                'file_name': p.file_name or '',
                'has_file': bool(p.uploaded_file),
                'employee_name': p.employee_name or '',
                'create_date': convert_to_user_tz(p.create_date),
                'related_links': p.related_links or '[]',
            } for p in progress],
            'github': [{
                'id': g.id,
                'github_url': g.github_url or '',
                'branch_name': g.branch_name or '',
                'employee_name': g.employee_name or '',
                'create_date': convert_to_user_tz(g.create_date),
            } for g in gh],
            'reassignments': [{
                'id': h.id,
                'previous_assignee': h.previous_assignee_name or '',
                'new_assignee': h.new_assignee_name or '',
                'reassigned_by': h.reassigned_by_name or '',
                'reassignment_date': convert_to_user_tz(h.reassignment_date),
                'reason': h.reassignment_reason or '',
                'time_spent': h.time_spent_display or '',
            } for h in hist],
            # The web's "Attached Files" / "Documents" panes — both render the same
            # thing: the files carried by progress updates. One list here.
            'files': [{
                'id': p.id,
                'file_name': p.file_name or '',
                'uploaded_by': p.employee_name or '',
                'upload_date': convert_to_user_tz(p.create_date),
            } for p in progress if p.uploaded_file],
            # The web's "Drive & Links" pane. Links are stored as bare URL strings
            # with no type, so the ONLY way to group them is to read the url —
            # done via the module's existing classifier (kpi.backup._categorize_link:
            # Repository | Google Drive | YouTube | Cloud Storage | Email | Other),
            # reused rather than re-implemented so the app and web can't disagree.
            'links': links,
        }

    # ================================================================== #
    # In-app notifications feed (kpi.notification)                        #
    # ================================================================== #
    # Rows are written per-recipient by the _notify dispatcher, so a user's
    # feed is simply the rows addressed to them: admins/owner/coordinator get
    # rows for every assignment/upload event; a developer only gets rows for
    # their own tasks. Scoping is therefore just user_id == current user — no
    # role branching needed here.

    @http.route('/kpi_notifications/get', type='json', auth='user', methods=['POST'], csrf=False)
    def get_notifications(self, **params):
        """Return the caller's notification feed + unread count."""
        current_user = request.env.user
        limit = int(params.get('limit') or 50)
        offset = int(params.get('offset') or 0)
        only_unread = bool(params.get('only_unread'))

        Notif = request.env['kpi.notification'].sudo()
        base_domain = [('user_id', '=', current_user.id)]
        domain = base_domain + ([('is_read', '=', False)] if only_unread else [])

        recs = Notif.search(domain, limit=limit, offset=offset)
        unread_count = Notif.search_count(base_domain + [('is_read', '=', False)])
        _logger.info(
            "notifications/get user=%s(%s) returned=%s unread=%s only_unread=%s",
            current_user.login, current_user.id, len(recs), unread_count, only_unread,
        )

        def map_rec(n):
            kpi = n.kpi_id
            # WHO it's about + WHICH client. An admin/owner is a recipient on
            # nearly every event, so without these two the feed is a wall of
            # near-identical rows and they have to open each one to tell them
            # apart. Same rule the messages use: the nearest is_client ancestor,
            # falling back to the task's own KRA.
            client_kra = (kpi.client_kra_id or kpi.kra_id) if kpi else False
            # Invoice notifications borrow an arbitrary kra.kpi as the _notify anchor,
            # so its task / developer / client fields are UNRELATED to the invoice (they
            # may even belong to another client). The row taps through on invoice_id, so
            # never expose the anchor task's details for these rows — that would leak one
            # client's task name into another client's feed.
            is_invoice = bool(n.invoice_id)
            return {
                'id': n.id,
                'kpi_id': False if is_invoice else (kpi.id if kpi else False),
                'kpi_name': "" if is_invoice else (kpi.name if kpi else ""),
                'developer': "" if is_invoice else (kpi.user_id.name if kpi and kpi.user_id else ""),
                'client_name': "" if is_invoice else (client_kra.name if client_kra else ""),
                # Where a tap should go when the answer ISN'T a task. "X ended their
                # workday" opens that day's frozen summary image; without this the
                # row is untappable, because the app routes purely on kpi_id.
                'snapshot_id': n.snapshot_id.id if n.snapshot_id else False,
                # Same idea for the daily task report: a "daily report ready" row
                # opens that report's PDF, not a task.
                'report_id': n.report_id.id if n.report_id else False,
                # ...and for invoice notifications: the row opens the invoice.
                'invoice_id': n.invoice_id.id if n.invoice_id else False,
                'event': n.event or "",
                'title': n.title or "",
                'body': n.body or "",
                'role': n.role or "",
                'is_read': n.is_read,
                'created_at': convert_to_user_tz(n.create_date) if n.create_date else "",
            }

        return {
            'status': True,
            'items': [map_rec(n) for n in recs],
            'unread_count': unread_count,
            # The app shows the developer/client line only to admins — a developer
            # seeing their own name on every row is just noise.
            'is_admin': self._is_kra_admin(current_user),
        }

    @http.route('/kpi_notifications/mark_read', type='json', auth='user', methods=['POST'], csrf=False)
    def mark_notifications_read(self, **params):
        """Mark the caller's notifications read. Omit `ids` to mark all read."""
        current_user = request.env.user
        ids = params.get('ids')

        Notif = request.env['kpi.notification'].sudo()
        base_domain = [('user_id', '=', current_user.id)]
        domain = base_domain + [('is_read', '=', False)]
        if ids:
            # Restrict to the caller's own rows even if foreign ids are passed.
            domain = domain + [('id', 'in', [int(i) for i in ids])]

        recs = Notif.search(domain)
        if recs:
            recs.write({'is_read': True, 'read_at': fields.Datetime.now()})

        unread_count = Notif.search_count(base_domain + [('is_read', '=', False)])
        _logger.info(
            "notifications/mark_read user=%s(%s) marked=%s ids=%s unread_now=%s",
            current_user.login, current_user.id, len(recs),
            ('all' if not ids else ids), unread_count,
        )
        return {'status': True, 'unread_count': unread_count}

    @http.route('/kpi_notifications/unread_count', type='json', auth='user', methods=['POST'], csrf=False)
    def notifications_unread_count(self, **params):
        """Cheap badge poll — just the caller's unread count."""
        current_user = request.env.user
        unread_count = request.env['kpi.notification'].sudo().search_count([
            ('user_id', '=', current_user.id),
            ('is_read', '=', False),
        ])
        return {'status': True, 'unread_count': unread_count}

    # ================================================================== #
    # Mobile push tokens (kpi.push.token)                                 #
    # ================================================================== #
    @http.route('/kpi_push/register', type='json', auth='user', methods=['POST'], csrf=False)
    def register_push_token(self, **params):
        """Register (or refresh) the caller's Expo push token for this device."""
        current_user = request.env.user
        token = (params.get('token') or '').strip()
        if not token:
            return {'status': False, 'error': 'missing token'}
        platform = params.get('platform')
        device = params.get('device')
        request.env['kpi.push.token'].sudo().upsert(current_user, token, platform, device)
        _logger.info("push/register user=%s(%s) platform=%s token=%s...",
                     current_user.login, current_user.id, platform, token[:24])
        return {'status': True}

    @http.route('/kpi_push/unregister', type='json', auth='user', methods=['POST'], csrf=False)
    def unregister_push_token(self, **params):
        """Deactivate a token (called on logout so a shared device stops
        receiving the previous user's notifications)."""
        token = (params.get('token') or '').strip()
        if token:
            request.env['kpi.push.token'].sudo().deactivate(token)
            _logger.info("push/unregister token=%s...", token[:24])
        return {'status': True}

    # ================================================================== #
    # Mobile-app login (mobile# + app password) — "Login Management"       #
    # ================================================================== #
    def _find_app_user(self, mobile):
        """Find a res.users by their app login mobile number (digits-compared)."""
        digits = re.sub(r'\D', '', mobile or '')
        if not digits or len(digits) < 4:
            return request.env['res.users'].sudo().browse()
        # Match on the last 8+ digits to tolerate country-code differences.
        users = request.env['res.users'].sudo().search([('kpi_mobile_number', '!=', False)])
        for u in users:
            if re.sub(r'\D', '', u.kpi_mobile_number or '').endswith(digits[-8:]):
                return u
        return request.env['res.users'].sudo().browse()

    def _device_lock_owner(self, user, params):
        """Return the name of the Odoo account this device is LOCKED to when
        `user` (the number's owner) is a DIFFERENT account — else None.

        The device is bound to the Odoo user who did the 7-tap device-setup
        (its uid is stored on the device and sent as `setup_uid`). Only that
        person's mobile number may log in on this device; any other number is
        refused. When `setup_uid` is absent (device provisioned before this
        lock, or not yet re-set-up) the check is skipped."""
        try:
            setup_uid = int(params.get('setup_uid') or 0)
        except (TypeError, ValueError):
            setup_uid = 0
        if setup_uid and user and user.id != setup_uid:
            su = request.env['res.users'].sudo().browse(setup_uid)
            return (su.name or su.login or 'another account') if su.exists() else 'another account'
        return None

    @http.route('/kpi_app/config', type='json', auth='public', methods=['POST'], csrf=False)
    def app_config(self, **params):
        """Public: the country dial code + local mobile length the app's number
        fields should use, so the +code shown and the digit count allowed match
        what Odoo holds.

        Resolves the PERSON when the device says who it belongs to. The device is
        bound to one Odoo account by the 7-tap setup and sends that account's id as
        `setup_uid` (same value `/kpi_app/login_check` already uses), so the login
        screen can show an Oman user +968/8 while others stay +91/10 — even though
        nobody is signed in yet. Falls back to the company default when the device
        isn't set up yet or the id doesn't resolve.
        """
        setup_uid = int(params.get('setup_uid') or 0)
        if setup_uid:
            user = request.env['res.users'].sudo().browse(setup_uid).exists()
            if user:
                dial, length = user._kpi_user_mobile_cfg()
                return {'status': True, 'dial': dial or '91', 'mobile_length': length or 10}
        company = request.env.company or request.env['res.company'].sudo().search([], limit=1, order='id')
        dial, length = company.sudo()._kpi_mobile_cfg()
        return {'status': True, 'dial': dial or '91', 'mobile_length': length or 10}

    @http.route('/kpi_app/login_check', type='json', auth='public', methods=['POST'], csrf=False)
    def app_login_check(self, **params):
        """Mobile-first login: given a number, return its state so the app knows
        whether to ask for a password (ready), start onboarding/OTP (needs_setup),
        or show 'contact admin' (unknown/disabled)."""
        user = self._find_app_user(params.get('mobile'))
        if not user:
            return {'status': True, 'state': 'unknown'}
        locked_to = self._device_lock_owner(user, params)
        if locked_to:
            return {'status': True, 'state': 'wrong_device', 'name': locked_to}
        return {'status': True, 'state': user._app_login_state(), 'name': user.name}

    @http.route('/kpi_app/login', type='json', auth='public', methods=['POST'], csrf=False)
    def app_login(self, **params):
        """Verify mobile#+app-password, then trusted server-side login for the
        mapped Odoo user (no Odoo password needed). Blocks disabled users."""
        user = self._find_app_user(params.get('mobile'))
        pw = params.get('password') or ''
        # Specific messages so the user knows WHY it failed (per request):
        if not user:
            return {'status': False, 'error': "This number isn't registered. Contact your admin."}
        # Device is locked to the Odoo account that set it up — refuse any other number.
        locked_to = self._device_lock_owner(user, params)
        if locked_to:
            return {'status': False,
                    'error': f"This device is set up for {locked_to}. Contact your admin."}
        if not user.kpi_app_login_enabled:
            return {'status': False, 'error': "Your login is disabled. Contact your admin."}
        if not user._check_app_password(pw):
            return {'status': False, 'error': "Username & password don't match this number. Contact your admin."}
        # Trusted login: finalize the session as this user (mirrors Odoo's own
        # /web/session/authenticate finalize step, minus the password check we
        # already did ourselves).
        try:
            request.session['pre_login'] = user.login
            request.session['pre_uid'] = user.id
            request.session.finalize(request.env)
            request.session.db = request.db
            request._save_session(request.env)
        except Exception as exc:
            _logger.error("app_login finalize failed: %s", exc)
            return {'status': False, 'error': 'Login failed. Please try again.'}
        user.sudo().write({
            'kpi_last_app_login': fields.Datetime.now(),
            'kpi_last_device': (params.get('device') or '')[:120],
        })
        _logger.info("app_login ok user=%s(%s) device=%s", user.login, user.id, params.get('device'))
        return {'status': True, 'uid': user.id, 'name': user.name,
                'login': user.login, 'must_change': user.kpi_app_must_change_password}

    @http.route('/kpi_app/set_password', type='json', auth='user', methods=['POST'], csrf=False)
    def app_set_password(self, **params):
        """The logged-in user sets their own app password (first-login forced
        change). Replaces the hash → the old/default password stops working."""
        new = (params.get('new_password') or '').strip()
        if len(new) < 4:
            return {'status': False, 'error': 'Password must be at least 4 characters.'}
        if request.env.user.sudo()._check_app_password(new):
            return {'status': False, 'error': "You can't reuse your old password. Please choose a new one."}
        request.env.user.sudo()._set_app_password(new)
        return {'status': True}

    def _send_wa_otp(self, user, code):
        """Send the OTP code to the user's REGISTERED login number (the one the
        admin set in Login Management), from the scanned/linked WhatsApp session,
        using the (editable) company template."""
        company = request.env.company
        template = company.kpi_otp_template()
        try:
            minutes = request.env['kpi.app.otp'].sudo().ttl_minutes()
        except Exception:
            minutes = 5
        body = template.format(
            app=company.name or 'the app',
            name=user.name or 'there',
            code=code,
            minutes=minutes,
        )
        # Recipient = the number the admin registered for this user (the login
        # number). Normalize with THIS user's own country dial code (Oman +968,
        # India +91, …) so WhatsApp routes it — the stored login number is local
        # digits (e.g. 9999999999 → 919999999999). Falls back to the company
        # default when the user has no per-person country.
        dial, length = user._kpi_user_mobile_cfg()
        raw = (user.kpi_mobile_number or user.kpi_wa_number
               or (user.partner_id.mobile or user.partner_id.phone) or '')
        phone = normalize_wa(raw, dial, length)
        if not phone:
            return False
        session = request.env['whatsapp.session'].sudo().search([('status', '=', 'connected')], limit=1)
        if not session:
            _logger.warning("otp: no connected WhatsApp session")
            return False
        try:
            session.send_message(phone, body)
            _logger.info("otp sent to %s (user %s) via session %s", phone, user.login, session.id)
            return True
        except Exception as exc:
            _logger.warning("otp WhatsApp send failed: %s", exc)
            return False

    @http.route('/kpi_app/otp/request', type='json', auth='public', methods=['POST'], csrf=False)
    def app_otp_request(self, **params):
        """Send a password-reset OTP to the user's WhatsApp. Generic response
        (never reveals whether the number exists or the code)."""
        user = self._find_app_user(params.get('mobile'))
        if user and user.kpi_app_login_enabled:
            try:
                code = request.env['kpi.app.otp'].sudo().issue(user)
                sent = self._send_wa_otp(user, code)
                _logger.info("otp/request user=%s(%s) sent=%s", user.login, user.id, sent)
                return {'status': True, 'sent': bool(sent)}
            except Exception as exc:
                _logger.warning("otp/request failed: %s", exc)
        # Generic OK so we don't leak which numbers are registered.
        return {'status': True, 'sent': False}

    @http.route('/kpi_app/otp/verify', type='json', auth='public', methods=['POST'], csrf=False)
    def app_otp_verify(self, **params):
        """Verify the code + set the new password, then log the user in."""
        user = self._find_app_user(params.get('mobile'))
        new = (params.get('new_password') or '').strip()
        if not user or not user.kpi_app_login_enabled:
            return {'status': False, 'error': 'Invalid request.'}
        if len(new) < 4:
            return {'status': False, 'error': 'Password must be at least 4 characters.'}
        if user._check_app_password(new):
            return {'status': False, 'error': "You can't reuse your old password. Please choose a new one."}
        if not request.env['kpi.app.otp'].sudo().verify(user, params.get('code')):
            return {'status': False, 'error': 'Incorrect or expired code.'}
        user.sudo()._set_app_password(new)   # replaces hash → old password dead
        # Log them straight in (trusted) so they land in the app after reset.
        try:
            request.session['pre_login'] = user.login
            request.session['pre_uid'] = user.id
            request.session.finalize(request.env)
            request.session.db = request.db
            request._save_session(request.env)
            user.sudo().write({
                'kpi_last_app_login': fields.Datetime.now(),
                'kpi_last_device': (params.get('device') or '')[:120],
            })
        except Exception as exc:
            _logger.error("otp/verify finalize failed: %s", exc)
            # Password was still set; the app can just log in normally.
            return {'status': True, 'logged_in': False}
        return {'status': True, 'logged_in': True, 'uid': user.id,
                'name': user.name, 'login': user.login}

    # ================================================================== #
    # Login Management (Non-odoo) — admin manages app-login credentials    #
    # ================================================================== #
    @http.route('/kpi_user_access/get', type='json', auth='user', methods=['POST'], csrf=False)
    def user_access_get(self, **params):
        """Admin: list internal users' app-login state + the OTP sender number."""
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        users = request.env['res.users'].sudo().search(
            [('share', '=', False), ('active', '=', True)], order='name')
        # The WhatsApp server that sends the reset codes (latest session record).
        sess = request.env['whatsapp.session'].sudo().search([], limit=1, order='id desc')
        # Keep the session labelled for the OTP sender (rename in place, no reconnect).
        if sess and sess.name != 'Login Management WhatsApp OTP':
            try: sess.write({'name': 'Login Management WhatsApp OTP'})
            except Exception: pass
        from ..models.res_company_kpi import DEFAULT_OTP_TEMPLATE, COUNTRY_MOBILE_LENGTH
        dial, length = request.env.company._kpi_mobile_cfg()
        # Countries for the per-person dropdown — restricted to those whose local
        # length we KNOW (COUNTRY_MOBILE_LENGTH), so the dial code and digit cap
        # always come from the same country (never a mismatch).
        countries = request.env['res.country'].sudo().search(
            [('phone_code', '!=', 0), ('code', 'in', list(COUNTRY_MOBILE_LENGTH.keys()))], order='name')
        try:
            otp_minutes = request.env['kpi.app.otp'].sudo().ttl_minutes()
        except Exception:
            otp_minutes = 5
        user_rows = []
        for u in users:
            u_dial, u_len = u._kpi_user_mobile_cfg()
            user_rows.append({
                'id': u.id, 'name': u.name, 'login': u.login,
                'email': u.email or '',
                'active': u.active,
                'mobile': u.kpi_mobile_number or '',
                # Per-person country + resolved dial/length (empty country_id ->
                # the company default dial/length above still apply).
                'country_id': u.kpi_mobile_country_id.id if u.kpi_mobile_country_id else False,
                'dial': u_dial or dial or '',
                'mobile_length': u_len or length or 10,
                'enabled': u.kpi_app_login_enabled,
                'last_login': convert_to_user_tz(u.kpi_last_app_login) if u.kpi_last_app_login else '',
                'last_device': u.kpi_last_device or '',
                'has_password': bool(u.kpi_app_password_hash),
                'role': self._kra_role_of(u),
                'is_system': u.has_group('base.group_system'),
            })
        return {
            'status': True,
            'connected_number': (sess.phone_number or '') if sess else '',
            'wa_session_id': sess.id if sess else 0,
            'wa_state': sess.status if sess else 'none',
            'wa_phone': (sess.phone_number or '') if sess else '',
            'otp_template': request.env.company.kpi_otp_message_template or DEFAULT_OTP_TEMPLATE,
            'otp_default': DEFAULT_OTP_TEMPLATE,
            'dial': dial or '',
            'mobile_length': length or 10,
            'app_name': request.env.company.name or 'the app',
            'otp_minutes': otp_minutes,
            'countries': [
                {'id': co.id, 'name': co.name, 'code': co.code or '',
                 'phone_code': co.phone_code}
                for co in countries],
            'users': user_rows,
        }

    def _kra_role_of(self, user):
        """The user's app-role for the Login Management dropdown:
        'admin' (system / owner / coordinator) | 'client' | 'developer'."""
        if (user.has_group('base.group_system')
                or user.has_group('kra_kpi_module.group_kra_owner')
                or user.has_group('kra_kpi_module.group_kra_admin')):
            return 'admin'
        if user.has_group('kra_kpi_module.group_kra_client'):
            return 'client'
        return 'developer'

    @http.route('/kpi_user_access/set_mobile', type='json', auth='user', methods=['POST'], csrf=False)
    def user_access_set_mobile(self, **params):
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        uid = int(params.get('user_id'))
        mobile = re.sub(r'\D', '', params.get('mobile') or '') or False
        request.env['res.users'].sudo().browse(uid).kpi_mobile_number = mobile
        return {'status': True, 'mobile': mobile or ''}

    @http.route('/kpi_user_access/set_country', type='json', auth='user', methods=['POST'], csrf=False)
    def user_access_set_country(self, **params):
        """Set a PERSON's mobile country — the dial code (+968 Oman, +91 India, …)
        and local length that apply to BOTH their app-login mobile and their
        WhatsApp number. Empty country clears the override (back to the company
        default). Re-keys the stored WhatsApp number to the new dial so it stops
        routing to the old country. Shared by the Configuration screen (developer
        WhatsApp) and Login Management, since both act on res.users by id.
        Returns the resolved dial/length so the screen updates live."""
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        user = request.env['res.users'].sudo().browse(int(params.get('user_id') or 0))
        if not user.exists():
            return {'status': False, 'message': 'User not found'}
        old_dial, old_length = user._kpi_user_mobile_cfg()
        cid = params.get('country_id')
        user.kpi_mobile_country_id = int(cid) if cid else False
        # Auto-fill the local length from the country map (onchange doesn't run on
        # a bare write, so mirror it); 0 = derive/fall back to the company default.
        from ..models.res_company_kpi import COUNTRY_MOBILE_LENGTH
        code = user.kpi_mobile_country_id.code if user.kpi_mobile_country_id else None
        user.kpi_mobile_length = COUNTRY_MOBILE_LENGTH.get(code, 0) if code else 0
        dial, length = user._kpi_user_mobile_cfg()
        # The WhatsApp number is stored WITH its dial prefix. Recover the local
        # part using the OLD dial, then re-prefix the NEW one — but ONLY when the
        # local part still fits the new country's length. A 10-digit India number
        # cannot be expressed as an 8-digit Oman number, so rather than store a
        # dial-less / misrouting value we CLEAR it and the admin re-enters the
        # number in the new format.
        if user.kpi_wa_number:
            digits = re.sub(r'\D', '', user.kpi_wa_number)
            if old_dial and digits.startswith(old_dial) and len(digits) == len(old_dial) + old_length:
                local = digits[len(old_dial):]
            else:
                local = digits
            if len(local) == length:
                user.kpi_wa_number = normalize_wa(local, dial, length) or False
            else:
                user.kpi_wa_number = False
        return {'status': True,
                'country_id': user.kpi_mobile_country_id.id if user.kpi_mobile_country_id else False,
                'dial': dial, 'mobile_length': length,
                'wa_number': user.kpi_wa_number or ''}

    @http.route('/kpi_user_access/set_role', type='json', auth='user', methods=['POST'], csrf=False)
    def user_access_set_role(self, **params):
        """Set a user's KRA app-role by moving them between the role groups:
        'admin' → Owner (full access), 'developer' → Developer, 'client' → Client.
        Only the KRA role groups are touched; the base super-admin is never re-roled."""
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        user = request.env['res.users'].sudo().browse(int(params.get('user_id') or 0))
        if not user.exists():
            return {'status': False, 'message': 'User not found'}
        if user.has_group('base.group_system'):
            return {'status': False, 'message': "The Odoo administrator's role can't be changed here."}
        role = params.get('role')
        ref = request.env.ref
        target = {
            'admin':     'kra_kpi_module.group_kra_owner',
            'developer': 'kra_kpi_module.group_kra_developer',
            'client':    'kra_kpi_module.group_kra_client',
        }.get(role)
        if not target:
            return {'status': False, 'message': 'Invalid role'}
        # Clear every KRA role group, then add the chosen one (Odoo propagates its
        # implied groups: owner→coordinator→developer→internal-user, etc.).
        role_groups = (ref('kra_kpi_module.group_kra_owner')
                       | ref('kra_kpi_module.group_kra_admin')
                       | ref('kra_kpi_module.group_kra_developer')
                       | ref('kra_kpi_module.group_kra_client'))
        cmds = [(3, g.id) for g in role_groups] + [(4, ref(target).id)]
        user.sudo().write({'group_ids': cmds})   # Odoo 19: user-groups field is group_ids (was groups_id)
        return {'status': True, 'role': self._kra_role_of(user)}

    @http.route('/kpi_user_access/toggle_login', type='json', auth='user', methods=['POST'], csrf=False)
    def user_access_toggle(self, **params):
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        uid = int(params.get('user_id'))
        request.env['res.users'].sudo().browse(uid).kpi_app_login_enabled = bool(params.get('enabled'))
        return {'status': True}

    @http.route('/kpi_user_access/reset_password', type='json', auth='user', methods=['POST'], csrf=False)
    def user_access_reset_password(self, **params):
        """Reset a user's app password. Optional {password} sets a unique initial
        password; otherwise the default '1111'. Either way forces a change on next
        login (must_change=True)."""
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        user = request.env['res.users'].sudo().browse(int(params.get('user_id') or 0))
        if not user.exists():
            return {'status': False, 'message': 'User not found'}
        if user.has_group('base.group_system'):
            return {'status': False, 'message': "The Odoo administrator's password can't be reset here."}
        custom = (params.get('password') or '').strip()
        if custom:
            user.write({
                'kpi_app_password_hash': user._crypt_context().hash(custom),
                'kpi_app_must_change_password': True,
                'password': custom,   # keep the Odoo login password in sync (see _set_app_password)
            })
        else:
            user._seed_default_app_password()
        return {'status': True}

    @http.route('/kpi_user_access/create', type='json', auth='user', methods=['POST'], csrf=False)
    def user_access_create(self, **params):
        """Create a new internal user carrying ONLY a KRA/KPI role (User/Client/
        Admin). Odoo's normal Role / groups / companies are NOT exposed — the role
        picks one of the group_kra_* groups (its implieds propagate). Seeds the app
        password to 1111 (must-change) so the person logs in with mobile + 1111 on
        the non-Odoo app login."""
        import secrets
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        Users = request.env['res.users'].sudo()
        name = (params.get('name') or '').strip()
        login = (params.get('login') or '').strip()
        email = (params.get('email') or '').strip()
        role = params.get('kra_role') or params.get('role') or 'developer'
        mobile = re.sub(r'\D', '', params.get('mobile') or '') or False
        pw = (params.get('password') or '').strip()
        act = params.get('active')
        active = True if act is None else bool(act)
        if not name or not login:
            return {'status': False, 'message': 'Name and Login are required.'}
        if Users.with_context(active_test=False).search_count([('login', '=ilike', login)]):
            return {'status': False, 'message': 'That login is already taken.'}
        role_group = {
            'admin':     'kra_kpi_module.group_kra_owner',
            'developer': 'kra_kpi_module.group_kra_developer',
            'client':    'kra_kpi_module.group_kra_client',
        }.get(role, 'kra_kpi_module.group_kra_developer')
        ref = request.env.ref
        try:
            groups = [ref('base.group_user').id, ref(role_group).id]
            user = Users.create({
                'name': name,
                'login': login,
                'email': email or False,
                'active': active,
                # Random Odoo password — unused (they log in via the app PIN), but a
                # value keeps the account from being password-less.
                'password': str(secrets.randbelow(900000) + 100000),
                'notification_type': 'inbox',
                'tz': 'Asia/Kolkata',
                'group_ids': [(6, 0, groups)],
                'kpi_mobile_number': mobile,
            })
            if pw:
                user._set_app_password(pw)          # admin set a real PIN → usable as-is (no must-change)
            else:
                user._seed_default_app_password()   # 1111 + must-change (the red-1111 nag flow)
            return {'status': True, 'user_id': user.id, 'role': self._kra_role_of(user)}
        except Exception as e:
            import logging
            logging.getLogger(__name__).error("user_access_create: %s", e)
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_user_access/change_password', type='json', auth='user', methods=['POST'], csrf=False)
    def user_access_change_password(self, **params):
        """Admin sets a user's app-login PIN to a SPECIFIC new value (Odoo-style
        'Change Password'). Unlike reset_password (resets to 1111 + forces a change),
        this sets the given password and does NOT force a change — the user logs in
        with it directly."""
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        user = request.env['res.users'].sudo().browse(int(params.get('user_id') or 0))
        if not user.exists():
            return {'status': False, 'message': 'User not found'}
        if user.has_group('base.group_system'):
            return {'status': False, 'message': "The Odoo administrator's password can't be changed here."}
        pw = (params.get('password') or '').strip()
        if len(pw) < 4:
            return {'status': False, 'message': 'Password must be at least 4 characters.'}
        user._set_app_password(pw)
        return {'status': True}

    @http.route('/kpi_user_access/update', type='json', auth='user', methods=['POST'], csrf=False)
    def user_access_update(self, **params):
        """Update an existing user's identity fields: name / login / email / active.
        (KRA/KPI role → set_role; mobile → set_mobile; app-password → reset_password.)"""
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        user = request.env['res.users'].sudo().browse(int(params.get('user_id') or 0))
        if not user.exists():
            return {'status': False, 'message': 'User not found'}
        vals = {}
        if (params.get('name') or '').strip():
            vals['name'] = params['name'].strip()
        if 'login' in params:
            login = (params.get('login') or '').strip()
            if login and login.lower() != (user.login or '').lower():
                if request.env['res.users'].sudo().with_context(active_test=False).search_count(
                        [('login', '=ilike', login), ('id', '!=', user.id)]):
                    return {'status': False, 'message': 'That login is already taken.'}
                vals['login'] = login
        if 'email' in params:
            vals['email'] = (params.get('email') or '').strip() or False
        if 'active' in params:
            if user.has_group('base.group_system') and not bool(params.get('active')):
                return {'status': False, 'message': "The administrator can't be archived here."}
            vals['active'] = bool(params.get('active'))
        if vals:
            user.write(vals)
        return {'status': True, 'role': self._kra_role_of(user)}

    @http.route('/kpi_user_access/set_sender', type='json', auth='user', methods=['POST'], csrf=False)
    def user_access_set_sender(self, **params):
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        request.env.company.sudo().kpi_wa_sender_number = (params.get('number') or '').strip() or False
        return {'status': True}

    @http.route('/kpi_user_access/set_otp_message', type='json', auth='user', methods=['POST'], csrf=False)
    def user_access_set_otp_message(self, **params):
        """Save the editable OTP WhatsApp template (empty → falls back to default)."""
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        request.env.company.sudo().kpi_otp_message_template = (params.get('template') or '').strip() or False
        return {'status': True}

    # ================================================================== #
    # WhatsApp server (Neonize) — connect / status / delete from the       #
    # Login Management page. The connected session sends the reset codes.  #
    # ================================================================== #
    @http.route('/kpi_wa_server/connect', type='json', auth='user', methods=['POST'], csrf=False)
    def wa_server_connect(self, **params):
        """Start (or restart) the WhatsApp connection → a QR appears to scan.
        Reuses the single session record (the module allows one active session)."""
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        Session = request.env['whatsapp.session'].sudo()
        session = Session.search([], limit=1, order='id desc')
        wa_name = 'Login Management WhatsApp OTP'
        if not session:
            session = Session.create({'name': wa_name})
        try:
            session.action_connect()
        except Exception as exc:
            _logger.error("wa_server connect failed: %s", exc)
            return {'status': False, 'message': str(exc)}
        # Force the label AFTER connect — action_connect can reset name to "Default".
        if session.name != wa_name:
            session.sudo().write({'name': wa_name})
        return {'status': True, 'session_id': session.id, 'state': session.status}

    @http.route('/kpi_wa_server/status', type='json', auth='user', methods=['POST'], csrf=False)
    def wa_server_status(self, **params):
        """Poll the WhatsApp connection: state + QR (while scanning) + phone."""
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        Session = request.env['whatsapp.session'].sudo()
        sid = params.get('session_id')
        session = Session.browse(int(sid)) if sid else Session.search([], limit=1, order='id desc')
        if not session or not session.exists():
            return {'status': True, 'state': 'none'}
        qr = ''
        if session.status == 'waiting_qr' and session.qr_image:
            qr = session.qr_image.decode() if isinstance(session.qr_image, bytes) else session.qr_image
        return {
            'status': True,
            'session_id': session.id,
            'state': session.status,             # disconnected|waiting_qr|connected|error
            'phone_number': session.phone_number or '',
            'qr_image': qr or '',                # base64 PNG (no data: prefix)
            'error': session.error_message or '',
        }

    @http.route('/kpi_wa_server/delete', type='json', auth='user', methods=['POST'], csrf=False)
    def wa_server_delete(self, **params):
        """Fully delete the WhatsApp connection — here AND inside Neonize:
        log the device out of WhatsApp, stop the client, remove the Odoo record,
        and delete the on-disk session credentials file (which the module's own
        unlink() leaves behind)."""
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        Session = request.env['whatsapp.session'].sudo()
        sid = params.get('session_id')
        session = Session.browse(int(sid)) if sid else Session.search([], limit=1, order='id desc')
        if not session or not session.exists():
            return {'status': True}
        db_path = session.db_path
        # 1) Best-effort logout so WhatsApp also drops this linked device.
        try:
            from odoo.addons.whatsapp_neonize.models.whatsapp_session import _wa_clients
            client = _wa_clients.get(session.id)
            if client is not None:
                try:
                    client.logout()
                except Exception:
                    pass
        except Exception:
            pass
        # 2) Stop the live client + remove the Odoo record (unlink also stops it).
        try:
            session.unlink()
        except Exception as exc:
            _logger.error("wa_server delete unlink failed: %s", exc)
            return {'status': False, 'message': str(exc)}
        # 3) Delete the Neonize session file (+ SQLite side files) so the
        #    connection is truly gone from Neonize, not just from Odoo.
        if db_path:
            for p in (db_path, db_path + '-journal', db_path + '-wal', db_path + '-shm'):
                try:
                    if os.path.exists(p):
                        os.remove(p)
                except Exception:
                    pass
        return {'status': True}

    # ================================================================== #
    # Device pairing (kpi.pair) — app generates a PIN, web enters it       #
    # ================================================================== #
    @http.route('/kpi_pair/generate', type='json', auth='user', methods=['POST'], csrf=False)
    def pair_generate(self, **params):
        """App calls this to get a fresh, short-lived pairing PIN."""
        res = request.env['kpi.pair'].sudo().generate_for(request.env.user)
        _logger.info("pair/generate user=%s(%s) mode=%s done=%s",
                     request.env.user.login, request.env.user.id,
                     res.get('mode'), res.get('done'))
        # done=True → developer already ended today (one start + one end per day):
        # no PIN issued; the app shows the "ended for today" state.
        return {'status': True, 'expires_at': res.get('expires_at'),
                'pin': res.get('pin'), 'mode': res.get('mode'),
                'done': bool(res.get('done'))}

    @http.route('/kpi_pair/status', type='json', auth='user', methods=['POST'], csrf=False)
    def pair_status(self, **params):
        """App polls this to learn when the web has entered the PIN.

        `bypass_gate` = admins (system / owner / coordinator) open the board
        directly without pairing a device or entering a PIN. Clients and plain
        developers are NOT in this set, so they still go through the PIN gate."""
        user = request.env.user
        res = request.env['kpi.pair'].sudo().status_for(user)
        bypass = (user.has_group('base.group_system')
                  or user.has_group('kra_kpi_module.group_kra_owner')
                  or user.has_group('kra_kpi_module.group_kra_admin'))
        return {'status': True, 'state': res.get('state'),
                'paired': res.get('paired'), 'mode': res.get('mode'),
                'day_done': bool(res.get('day_done')),
                'bypass_gate': bypass}

    @http.route('/kpi_pair/verify', type='json', auth='user', methods=['POST'], csrf=False)
    def pair_verify(self, **params):
        """Web gate calls this. On a valid PIN → pair + open the workday.

        Blocks pairing from a MOBILE browser: work-timing must happen on a
        computer (where 'tab open' is a fair proxy). A phone User-Agent is
        rejected WITHOUT consuming the PIN, so a later attempt from the
        computer with the same PIN still works. (UA is spoofable by a technical
        user forcing desktop mode — this is a deterrent, not a hard lock.)"""
        try:
            ua = request.httprequest.user_agent.string if request.httprequest.user_agent else ''
        except Exception:
            ua = ''
        if self._is_mobile_ua(ua):
            _logger.info("pair/verify REJECTED (mobile UA) user=%s(%s)",
                         request.env.user.login, request.env.user.id)
            return {'status': True, 'ok': False, 'reason': 'mobile'}
        res = request.env['kpi.pair'].sudo().verify(request.env.user, params.get('pin'))
        _logger.info("pair/verify user=%s(%s) ok=%s",
                     request.env.user.login, request.env.user.id, res.get('ok'))
        return {'status': True, 'ok': bool(res.get('ok'))}

    def _is_mobile_ua(self, ua):
        """True if the User-Agent looks like a phone (NOT a desktop/tablet).
        iPad/tablets are treated as desktop (they can do real work)."""
        if not ua:
            return False
        u = ua.lower()
        if 'ipad' in u or 'tablet' in u:
            return False
        return bool(re.search(
            r'android.*mobile|iphone|ipod|windows phone|blackberry|opera mini|iemobile|mobile safari',
            u))

    # ================================================================== #
    # Developer self-created tasks — "Pending Review" lane                #
    # ================================================================== #
    def _is_kra_admin(self, user):
        """Coordinator / Owner / System — the roles allowed to accept/reject."""
        return (
            user.has_group('kra_kpi_module.group_kra_admin')
            or user.has_group('kra_kpi_module.group_kra_owner')
            or user.has_group('base.group_system')
        )

    @http.route('/kra_kpi/task/self_create', type='json', auth='user', methods=['POST'], csrf=False)
    def self_create_task(self, **params):
        """Developer self-creates a task from the KPI Action Board.

        It lands in the separate "Pending Review" lane
        (is_self_created=True, admin_accepted=False): assigned to the creator and
        immediately workable (timer runs), but kept OUT of the official flow
        (no client pre-approval) until an admin Accepts it.
        """
        user = request.env.user
        if not (user.has_group('kra_kpi_module.group_kra_developer')
                or user.has_group('base.group_system')):
            return {'status': False, 'message': 'Only developers can create their own tasks.'}

        name = (params.get('name') or '').strip()
        kra_id = params.get('kra_id')
        try:
            est_h = int(params.get('estimate_hours') or 0)
            est_m = int(params.get('estimate_minutes') or 0)
        except (TypeError, ValueError):
            est_h, est_m = 0, 0
        priority = params.get('priority') or 'regular'
        description = (params.get('description') or '').strip()

        if not name:
            return {'status': False, 'message': 'Task name is required.'}
        if not kra_id:
            return {'status': False, 'message': 'Please choose a project (KRA).'}
        kra = request.env['kra.master'].sudo().browse(int(kra_id))
        if not kra.exists():
            return {'status': False, 'message': 'Selected project not found.'}
        if (est_h * 60 + est_m) <= 0:
            return {'status': False, 'message': 'Estimate must be greater than zero.'}

        # Provisional ref — a "+ New Task" gets TASK-### until an admin accepts it
        # and picks the real type (REQ/UPT/BUG), which re-numbers it.
        task_ref_n = request.env['kra.kpi']._next_ref_for_prefix('TASK')
        rec = request.env['kra.kpi'].sudo().create({
            'name': name,
            'kra_id': int(kra_id),
            'estimate_hours': est_h,
            'estimate_minutes': est_m,
            'priority': priority,
            'description': description,
            'task_state': 'assigned',
            'published': True,
            'user_id': user.id,
            'is_self_created': True,
            'admin_accepted': False,
            'requested_by_id': user.id,
            'external_ref': 'TASK-%03d' % task_ref_n,
        })

        # Notify owner + coordinator that a task is waiting for review.
        try:
            rec._notify('self_task_submitted',
                        title=rec.name, dev=user.name, project=kra.name,
                        estimate=f"{est_h}h {est_m}m", priority=priority)
        except Exception as exc:
            _logger.warning("self_task_submitted notify failed: %s", exc)

        return {'status': True, 'id': rec.id, 'external_ref': rec.external_ref,
                'message': 'Task created in your Pending Review lane.'}

    @http.route(['/kra_kpi/task/admin_accept',
                 '/kra_kpi/task/accept_self_created'],
                type='json', auth='user', methods=['POST'], csrf=False)
    def accept_self_created(self, **params):
        """Admin accepts ANY task into the official flow.

        This is now the single gate every task passes through: nothing reaches
        the client until an admin has accepted it here.  The legacy
        /accept_self_created route is kept as an alias so the existing OWL
        screens keep working.

        Sets admin_accepted=True.  If the developer hasn't started it yet, fire
        the normal client pre-approval; if they've already started/worked it, we
        leave the work-state + timer untouched (accrued time carries over) and
        the client signs off later at completion.  Optionally corrects KRA/estimate.
        """
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Only a coordinator/owner can accept tasks.'}
        kpi_id = params.get('kpi_id')
        if not kpi_id:
            return {'status': False, 'message': 'kpi_id missing'}
        rec = request.env['kra.kpi'].sudo().browse(int(kpi_id))
        if not rec.exists():
            return {'status': False, 'message': 'Task not found'}
        # Applies to every task, not just self-created ones — admin acceptance
        # is now the mandatory first step of the workflow.
        if rec.admin_accepted:
            return {'status': False, 'message': 'This task is not awaiting acceptance.'}

        vals = {
            'admin_accepted': True,
            # A human decided — stamp who, and stop the auto-accept clock in the
            # same write so the cron cannot pick this row up in the gap between
            # here and the commit.
            'admin_accepted_auto': False,
            'admin_accepted_at': fields.Datetime.now(),
            'admin_accepted_by_id': user.id,
            'admin_accept_deadline_at': False,
        }
        # Admin categorizes the accepted task — re-number its provisional TASK-###
        # ref into the chosen sequence (REQ/UPT/BUG) and apply the name prefix.
        # Prefix tables are shared with _auto_admin_accept so the human and
        # automatic paths cannot drift.
        _REF_PREFIX = REF_PREFIX_FOR_DOC_TYPE
        _NAME_PREFIX = NAME_PREFIX_FOR_DOC_TYPE
        doc_type = params.get('doc_type') or 'requirement'
        prefix = _REF_PREFIX.get(doc_type, 'REQ')
        n = request.env['kra.kpi']._next_ref_for_prefix(prefix)
        vals['external_ref'] = '%s-%03d' % (prefix, n)
        base_name = re.sub(r'^\[(Update|Bug)\]\s*', '', rec.name or '', flags=re.IGNORECASE)
        vals['name'] = _NAME_PREFIX.get(doc_type, '') + base_name
        if params.get('kra_id'):
            vals['kra_id'] = int(params['kra_id'])
        if params.get('estimate_hours') not in (None, ''):
            try:
                vals['estimate_hours'] = int(params.get('estimate_hours') or 0)
            except (TypeError, ValueError):
                pass
        if params.get('estimate_minutes') not in (None, ''):
            try:
                vals['estimate_minutes'] = int(params.get('estimate_minutes') or 0)
            except (TypeError, ValueError):
                pass
        rec.write(vals)

        # Only fire the pre-work client approval if the dev hasn't started yet;
        # otherwise don't disturb the running timer / in-progress state.
        if rec.task_state in ('assigned', 'urgent', 'important', 'regular', 'queue_waiting'):
            try:
                rec.request_client_pre_approval()
            except Exception as exc:
                _logger.warning("accept pre-approval failed for %s: %s", rec.id, exc)

        try:
            rec._notify('self_task_accepted',
                        title=rec.name, project=(rec.kra_id.name if rec.kra_id else ''))
        except Exception as exc:
            _logger.warning("self_task_accepted notify failed: %s", exc)
        try:
            rec._log_action('self_task_accepted', source='web',
                            payload={'accepted_by': user.id})
        except Exception:
            pass
        return {'status': True, 'new_state': rec.task_state,
                'message': 'Task accepted into the main flow.'}

    @http.route('/kra_kpi/task/reject_self_created', type='json', auth='user', methods=['POST'], csrf=False)
    def reject_self_created(self, **params):
        """Admin sends a self-created task back to the developer (with a note) or
        discards it.  Bounced tasks stay in the Pending Review lane."""
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Only a coordinator/owner can reject tasks.'}
        kpi_id = params.get('kpi_id')
        note = (params.get('note') or '').strip()
        discard = bool(params.get('discard'))
        if not kpi_id:
            return {'status': False, 'message': 'kpi_id missing'}
        rec = request.env['kra.kpi'].sudo().browse(int(kpi_id))
        if not rec.exists():
            return {'status': False, 'message': 'Task not found'}
        if not rec.is_self_created or rec.admin_accepted:
            return {'status': False, 'message': 'This task is not awaiting acceptance.'}

        try:
            rec._notify('self_task_rejected', title=rec.name,
                        reason=(note or 'No reason given'))
        except Exception as exc:
            _logger.warning("self_task_rejected notify failed: %s", exc)
        try:
            rec._log_action('self_task_rejected', source='web',
                            payload={'rejected_by': user.id, 'note': note, 'discard': discard},
                            success=False)
        except Exception:
            pass

        if discard:
            # Clear the clock as well as archiving. The cron already filters on
            # active=True, but leaving a live deadline on a discarded row is a
            # trap for anyone who un-archives it later.
            rec.write({'active': False, 'admin_accept_deadline_at': False})
            return {'status': True, 'discarded': True, 'message': 'Task discarded.'}
        # A sent-back task shouldn't keep clocking time — if the dev is actively
        # working it, pause it: stop the clock (preserve the accrued total) and
        # close the DEVELOPER's time-log session (rec.user_id, not the admin).
        if rec.task_state == 'in_progress':
            if rec.timer_start_datetime:
                rec._add_elapsed(rec)
                try:
                    request.env['kpi.time.log'].sudo().stop_session(rec.id, rec.user_id.id)
                except Exception as exc:
                    _logger.warning("reject stop_session failed for %s: %s", rec.id, exc)
            rec.write({'task_state': 'paused', 'timer_start_datetime': False})
        # Bounce back: keep it in the Pending Review lane and show the note on the card.
        # Record who sent it back + flag that the dev must give a reason on Resume.
        rec.write({
            'self_review_note': note or 'Please revise',
            'self_review_by': user.name,
            'self_needs_resume_reason': True,
            # STOP the auto-accept clock. Silence is what auto-accept answers;
            # this admin did not stay silent, they said no. Without this the
            # cron would accept the very task they just sent back, minutes
            # later. Re-armed when the developer answers on Resume.
            'admin_accept_deadline_at': False,
        })
        return {'status': True, 'discarded': False,
                'message': 'Task sent back to the developer.'}

    # ================================================================== #
    # Multi-task permission admin (per developer)                        #
    # ================================================================== #
    @http.route('/kpi_multitask/list', type='json', auth='user', methods=['POST'], csrf=False)
    def multitask_list(self, **params):
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Not authorized'}
        devs = request.env.ref('kra_kpi_module.group_kra_developer').sudo().user_ids.filtered(
            lambda u: u.active and not u.share)
        rows = []
        for u in devs.sorted('name'):
            u_dial, u_len = u._kpi_user_mobile_cfg()
            rows.append({
                'id': u.id, 'name': u.name, 'login': u.login,
                'allow_multitask': u.kpi_allow_multitask,
                'wa_number': u.kpi_wa_number or '',
                # Per-person country + resolved dial/length for the WhatsApp field.
                'country_id': u.kpi_mobile_country_id.id if u.kpi_mobile_country_id else False,
                'dial': u_dial or '', 'mobile_length': u_len or 10,
            })
        return {'status': True, 'developers': rows}

    @http.route('/kpi_multitask/set', type='json', auth='user', methods=['POST'], csrf=False)
    def multitask_set(self, **params):
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Not authorized'}
        if not params.get('user_id'):
            return {'status': False, 'message': 'user_id missing'}
        request.env['res.users'].sudo().browse(int(params['user_id'])).kpi_allow_multitask = bool(params.get('allow'))
        return {'status': True}

    @http.route('/kpi_multitask/set_wa', type='json', auth='user', methods=['POST'], csrf=False)
    def multitask_set_wa(self, **params):
        """Set a developer's WhatsApp number (Configuration screen)."""
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Not authorized'}
        if not params.get('user_id'):
            return {'status': False, 'message': 'user_id missing'}
        dev = request.env['res.users'].sudo().browse(int(params['user_id']))
        # Normalize with the DEVELOPER's own country dial/length (falls back to
        # the company default when they have no per-person country).
        dial, length = dev._kpi_user_mobile_cfg()
        num = normalize_wa(params.get('wa_number') or '', dial, length) or False
        dev.kpi_wa_number = num
        return {'status': True, 'wa_number': num or '', 'dial': dial, 'mobile_length': length}

    # ---- Global config: Away-after-minutes + Urgent recipients (Configuration screen) ---- #
    @http.route('/kpi_config/get', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_config_get(self, **params):
        c = request.env.company
        dial, length = c._kpi_mobile_cfg()
        # Countries for the picker — restricted to those whose local length we
        # KNOW (COUNTRY_MOBILE_LENGTH), so the dial code and digit cap always come
        # from the same country (id, name, +code).
        from ..models.res_company_kpi import COUNTRY_MOBILE_LENGTH
        countries = request.env['res.country'].sudo().search(
            [('phone_code', '!=', 0), ('code', 'in', list(COUNTRY_MOBILE_LENGTH.keys()))], order='name')
        return {'status': True,
                'away_after_minutes': c.away_after_minutes,
                # Workflow gate timers — all editable in the app's Configuration,
                # nothing about these windows is hard-coded.  admin_accept can be
                # 0 (auto-accept off), so `or 5` would silently re-enable it.
                'admin_accept_minutes': (c.admin_accept_minutes
                                         if c.admin_accept_minutes not in (None, False, '')
                                         else 5),
                'client_approval_minutes': c.client_approval_minutes or 5,
                'queue_nudge_minutes': c.queue_nudge_minutes or 30,
                'urgent_nudge_minutes': c.urgent_nudge_minutes or 5,
                'standard_workday_hours': c.standard_workday_hours or 9.0,
                # Snapshot image retention + daily report schedule & retention.
                'snapshot_retention_number': c.kpi_snapshot_retention_number or 0,
                'snapshot_retention_unit': c.kpi_snapshot_retention_unit or 'months',
                'daily_report_enabled': c.kpi_daily_report_enabled,
                'daily_report_hour': c.kpi_daily_report_hour or 10.0,
                'daily_report_coverage': c.kpi_daily_report_coverage or 'yesterday',
                'report_retention_number': c.kpi_report_retention_number or 0,
                'report_retention_unit': c.kpi_report_retention_unit or 'months',
                'country_id': c.kpi_country_id.id if c.kpi_country_id else False,
                'country_dial_code': dial,
                'mobile_length': length,
                'countries': [
                    {'id': co.id, 'name': co.name, 'code': co.code or '',
                     'phone_code': co.phone_code}
                    for co in countries]}

    @http.route('/kpi_config/set_country', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_config_set_country(self, **params):
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Not authorized'}
        cid = params.get('country_id')
        c = request.env.company.sudo()
        c.kpi_country_id = int(cid) if cid else False
        # Auto-fill the local length from the country map (onchange doesn't run
        # on a bare write, so mirror its logic here).
        from ..models.res_company_kpi import COUNTRY_MOBILE_LENGTH
        code = c.kpi_country_id.code if c.kpi_country_id else None
        if code and code in COUNTRY_MOBILE_LENGTH:
            c.kpi_mobile_length = COUNTRY_MOBILE_LENGTH[code]
        dial, length = c._kpi_mobile_cfg()
        return {'status': True, 'dial': dial, 'mobile_length': length}

    @http.route('/kpi_config/set_away', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_config_set_away(self, **params):
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Not authorized'}
        request.env.company.sudo().away_after_minutes = max(1, int(params.get('minutes') or 5))
        return {'status': True}

    @http.route('/kpi_config/set_client_approval', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_config_set_client_approval(self, **params):
        """Minutes a client has to approve the assigned developer before the task
        is auto-RELEASED for work.  Release is not approval: the client can still
        object, and billing still needs their sign-off at completion."""
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Not authorized'}
        request.env.company.sudo().client_approval_minutes = max(1, int(params.get('minutes') or 5))
        return {'status': True}

    @http.route('/kpi_config/set_admin_accept', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_config_set_admin_accept(self, **params):
        """Minutes a new task waits for an admin to Accept it before auto-accepting.

        Clamped at 0, not 1 (unlike the client window): 0 is the documented kill
        switch that restores human-only acceptance, and it needs to be reachable
        from the Configuration screen without a code change.
        """
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Not authorized'}
        try:
            minutes = max(0, int(params.get('minutes') or 0))
        except (TypeError, ValueError):
            minutes = 5
        request.env.company.sudo().admin_accept_minutes = minutes
        return {'status': True, 'minutes': minutes}

    @http.route('/kpi_config/set_standard_hours', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_config_set_standard_hours(self, **params):
        """A normal working day, in hours. The End Workday summary compares it
        against PRESENCE: at/over reads green, under reads red."""
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Not authorized'}
        try:
            hours = float(params.get('hours') or 9.0)
        except (TypeError, ValueError):
            hours = 9.0
        # Clamped to a sane day: 0 would make every day green and >24 every day
        # red, and either makes the whole green/red signal meaningless.
        hours = max(0.5, min(24.0, hours))
        request.env.company.sudo().standard_workday_hours = hours
        return {'status': True, 'hours': hours}

    @http.route('/kpi_config/set_queue_nudge', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_config_set_queue_nudge(self, **params):
        """Minutes between admin re-nudges for an unread queued client task."""
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Not authorized'}
        request.env.company.sudo().queue_nudge_minutes = max(1, int(params.get('minutes') or 30))
        return {'status': True}

    @http.route('/kpi_config/set_urgent_nudge', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_config_set_urgent_nudge(self, **params):
        """Minutes between admin re-nudges while a 🚨 Urgent pause sits unread."""
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Not authorized'}
        request.env.company.sudo().urgent_nudge_minutes = max(1, int(params.get('minutes') or 5))
        return {'status': True}

    @http.route('/kpi_config/set_snapshot_retention', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_config_set_snapshot_retention(self, **params):
        """How long to keep workday snapshot IMAGES before the cleanup cron clears
        them. number 0 = keep forever; unit in days/months/years."""
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Not authorized'}
        try:
            number = max(0, int(params.get('number') or 0))
        except (TypeError, ValueError):
            number = 0
        unit = params.get('unit')
        if unit not in ('days', 'months', 'years'):
            unit = 'months'
        c = request.env.company.sudo()
        c.kpi_snapshot_retention_number = number
        c.kpi_snapshot_retention_unit = unit
        return {'status': True, 'number': number, 'unit': unit}

    @http.route('/kpi_config/set_report_retention', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_config_set_report_retention(self, **params):
        """How long to keep generated daily report PDFs before the cleanup cron
        deletes them. number 0 = keep forever; unit in days/months/years."""
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Not authorized'}
        try:
            number = max(0, int(params.get('number') or 0))
        except (TypeError, ValueError):
            number = 0
        unit = params.get('unit')
        if unit not in ('days', 'months', 'years'):
            unit = 'months'
        c = request.env.company.sudo()
        c.kpi_report_retention_number = number
        c.kpi_report_retention_unit = unit
        return {'status': True, 'number': number, 'unit': unit}

    @http.route('/kpi_config/set_daily_report', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_config_set_daily_report(self, **params):
        """Daily report schedule: on/off, IST send hour (0–24, 10.5 = 10:30), and
        which day it covers (yesterday/today)."""
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Not authorized'}
        c = request.env.company.sudo()
        if 'enabled' in params:
            c.kpi_daily_report_enabled = bool(params.get('enabled'))
        if params.get('hour') is not None:
            try:
                hour = float(params.get('hour'))
            except (TypeError, ValueError):
                hour = 10.0
            c.kpi_daily_report_hour = max(0.0, min(23.99, hour))
        coverage = params.get('coverage')
        if coverage in ('yesterday', 'today'):
            c.kpi_daily_report_coverage = coverage
        return {
            'status': True,
            'enabled': c.kpi_daily_report_enabled,
            'hour': c.kpi_daily_report_hour,
            'coverage': c.kpi_daily_report_coverage,
        }

    # NOTE: /kpi_config/set_urgent (ad-hoc Urgent-pause WhatsApp numbers) was
    # removed. Those numbers had no user account, so they became unreachable once
    # task WhatsApp was switched off; urgent_pause now notifies owner+coordinator
    # in the app and re-nudges until read.

    @http.route('/kra_kpi/get_kpi_detail', type='json', auth='user', methods=['POST'], csrf=False)
    def get_kpi_detail(self, **params):

        kpi_id = params.get("kpi_id")
        if not kpi_id:
            return {"status": False, "message": "kpi_id missing"}

        k = request.env["kra.kpi"].sudo().browse(int(kpi_id))
        if not k.exists():
            return {"status": False, "message": "KPI not found"}

        return {
            "status": True,
            "kpi": {
                "id": k.id,
                "name": k.name,
                "kra_name": k.kra_id.name if k.kra_id else "",
                "priority": k.priority or "",
                "estimate_display": f"{k.estimate_hours:02d}:{k.estimate_minutes:02d}",
                "estimate_hours": k.estimate_hours,
                "estimate_minutes": k.estimate_minutes,
                "points": k.points or 0,
                "user_name": k.user_id.name if k.user_id else "",
                "user_group_name": k.user_group_id.name if k.user_group_id else "",
                "deadline": str(k.deadline) if k.deadline else "",
                "reminder_days": k.reminder_days or 0,
                "reminder_hours": k.reminder_hours or 0,
                "reminder_minutes": k.reminder_minutes or 0,
                "next_kpi_name": k.next_kpi_id.name if k.next_kpi_id else "",
                "warehouse": k.warehouse_id.name if k.warehouse_id else "",
                "file_name": k.file_name or "",
                "actions": k.action_config_id.name if k.action_config_id else "", 
                "description": k.description or "",
                "checklist": k.checklist or "",
                "guidelines": k.guidelines or "",
                "is_mandatory": k.is_mandatory,
                "auto_assign": k.auto_assign,
                "auto_estimated": k.auto_estimated,
                "is_permanent": k.is_permanent,
                "service_kpi": k.service_kpi,
                "is_meeting": k.is_meeting,
                "is_manager_review_needed": k.is_manager_review_needed,
                "is_customer_review_needed": k.is_customer_review_needed,
                "file_content": k.uploaded_file if k.uploaded_file else None,
                "related_links": k.related_links or "[]",
                
            }
        }

    @http.route('/kra_kpi/delete_kra', type='json', auth='user', methods=['POST'], csrf=False)
    def delete_kra(self, **params):
        kra_id = params.get("kra_id")
        if not kra_id:
            return {"status": False, "message": "kra_id missing"}

        kra = request.env["kra.master"].sudo().browse(int(kra_id))
        if not kra.exists():
            return {"status": False, "message": "KRA not found"}

        kra.kpi_ids.unlink()
        kra.child_ids.unlink()
        kra.unlink()

        return {"status": True, "message": "KRA deleted"}

    @http.route('/kra_kpi/delete_kpi', type='json', auth='user', methods=['POST'], csrf=False)
    def delete_kpi(self, **params):
        kpi_id = params.get("kpi_id")
        if not kpi_id:
            return {"status": False, "message": "kpi_id missing"}

        kpi = request.env["kra.kpi"].sudo().browse(int(kpi_id))
        if not kpi.exists():
            return {"status": False, "message": "KPI not found"}

        kpi.unlink()
        return {"status": True, "message": "KPI deleted"}
    
    def _may_view_kpi_details(self, kpi):
        """Who may read a task's KPI details.

        Admin / coordinator / owner: any task.  Developer: only tasks they are on
        (effective_contributor_ids already unions user_id + contributors + role
        lists — see kpi.py:98).  Client: never — they file requests and approve
        developers, they do not read the internal task record.

        Returns None when allowed, else the refusal message.
        """
        user = request.env.user
        is_admin = self._is_kra_admin(user)
        if user.has_group('kra_kpi_module.group_kra_client') and not is_admin:
            return 'Not authorized'
        if is_admin:
            return None
        if user.id in kpi.sudo().effective_contributor_ids.ids:
            return None
        return 'Not authorized'

    @http.route('/kpi_action/details', type='json', auth='user')
    def get_kpi_action_details(self, id):
        kpi = request.env['kra.kpi'].sudo().browse(int(id))

        if not kpi.exists():
            return {"error": "KPI not found"}

        # sudo() above bypasses the record rules, so the id must be authorised
        # explicitly — otherwise any logged-in user can read any task by id.
        denied = self._may_view_kpi_details(kpi)
        if denied:
            return {"error": denied}

        # Derive type from name prefix (mirrors bulk-create + add_task logic)
        nm = kpi.name or ''
        ref = (kpi.external_ref or '').upper()
        if nm.startswith('[Update]') or ref.startswith('UPD'):
            kind = 'update'
        elif nm.startswith('[Bug]') or ref.startswith('BUG'):
            kind = 'bug'
        else:
            kind = 'requirement'

        user = request.env.user
        is_manager = (
            user.has_group('kra_kpi_module.group_kra_admin')
            or user.has_group('kra_kpi_module.group_kra_manager')
            or user.has_group('base.group_system')
        )

        # Project picker — sibling sub-KRAs under the same root client.
        # Walk up to root and enumerate descendants so user can move the task
        # to a different project under the same client.
        available_kras = []
        if kpi.kra_id:
            root = kpi.kra_id
            while root.parent_id:
                root = root.parent_id
            for kid in root._get_descendant_ids():
                k = request.env['kra.master'].sudo().browse(kid)
                if not k.exists() or k.id == root.id:
                    continue
                path = []
                cur = k
                while cur:
                    path.insert(0, cur.name or '')
                    cur = cur.parent_id
                available_kras.append({
                    'id': k.id, 'name': k.name or '',
                    'display': ' > '.join(path),
                })

        return {
            "id": kpi.id,
            "name": kpi.name or "",
            "kra": kpi.kra_id.name if kpi.kra_id else "",
            "kra_id": kpi.kra_id.id if kpi.kra_id else False,
            "type": kind,
            "external_ref": kpi.external_ref or "",
            "is_manager": is_manager,
            # 🆕 Part B: gate the in-detail "Complete This Task" panel
            "task_state": kpi.task_state or "",
            "is_assignee": bool(kpi.user_id and kpi.user_id.id == user.id),
            "available_kras": available_kras,
            "priority": kpi.priority or "",
            "estimate": f"{kpi.estimate_hours:02d}:{kpi.estimate_minutes:02d}",
            "points": kpi.points or 0,
            "assignee": kpi.user_id.name if kpi.user_id else "",
            "user_group": kpi.user_group_id.name if kpi.user_group_id else "",
            "deadline": str(kpi.deadline) if kpi.deadline else "",
            "reminder_days": kpi.reminder_days or 0,
            "next_kpi": kpi.next_kpi_id.name if kpi.next_kpi_id else "",
            "warehouse": kpi.warehouse_id.name if kpi.warehouse_id else "",
            "file_name": kpi.file_name or "",
            "file_url": kpi.uploaded_file and f"/web/content?model=kra.kpi&id={kpi.id}&field=uploaded_file&download=true&filename={kpi.file_name}" if kpi.file_name else False,
            "actions": kpi.action_config_id.name if kpi.action_config_id else "",
            "description": kpi.description or "",
            "checklist": kpi.checklist or "",
            "guidelines": kpi.guidelines or "",
            "is_mandatory": kpi.is_mandatory or False,
            "auto_estimated": kpi.auto_estimated or False,
            "service_kpi": kpi.service_kpi or False,
            "manager_review": kpi.is_manager_review_needed or False,
            "auto_assign": kpi.auto_assign or False,
            "is_permanent": kpi.is_permanent or False,
            "is_meeting": kpi.is_meeting or False,
            "customer_review": kpi.is_customer_review_needed or False,
            "related_links": kpi.related_links or "[]",
        }

    @http.route('/kpi_action/update_meta', type='json', auth='user', methods=['POST'], csrf=False)
    def update_kpi_meta(self, **params):
        """Manager-only: edit Name, Project (kra_id), and Type on an existing KPI.

        Changing Type strips the old [Bug]/[Update] prefix off the name and applies
        the new one. The external_ref's BUG/UPD/REQ pattern is also rewritten when
        it follows the same scheme.
        """
        try:
            user = request.env.user
            is_manager = (
                user.has_group('kra_kpi_module.group_kra_admin')
                or user.has_group('kra_kpi_module.group_kra_manager')
                or user.has_group('base.group_system')
            )
            if not is_manager:
                return {'status': False, 'message': 'Only managers can edit task metadata.'}

            kpi_id = int(params.get('id') or 0)
            if not kpi_id:
                return {'status': False, 'message': 'KPI id required.'}
            kpi = request.env['kra.kpi'].sudo().browse(kpi_id)
            if not kpi.exists():
                return {'status': False, 'message': 'Task not found.'}

            updates = {}

            new_name = (params.get('name') or '').strip()
            new_type = params.get('type')   # 'requirement' | 'update' | 'bug' | None
            new_kra_id = params.get('kra_id')

            # Start from the existing name with old prefix stripped, then re-prefix.
            base_name = new_name or (kpi.name or '')
            for prefix in ('[Update] ', '[Bug] '):
                if base_name.startswith(prefix):
                    base_name = base_name[len(prefix):]
                    break

            type_prefix = {'requirement': '', 'update': '[Update] ', 'bug': '[Bug] '}
            if new_type in type_prefix:
                updates['name'] = type_prefix[new_type] + base_name
            elif new_name:
                # Keep existing prefix when only name changed.
                old_prefix = ''
                for prefix in ('[Update] ', '[Bug] '):
                    if (kpi.name or '').startswith(prefix):
                        old_prefix = prefix
                        break
                updates['name'] = old_prefix + base_name

            # Rewrite external_ref's BUG-/UPD-/REQ- token when type changes the family.
            if new_type in type_prefix and kpi.external_ref:
                import re as _re
                token_map = {'requirement': 'REQ', 'update': 'UPD', 'bug': 'BUG'}
                target_token = token_map[new_type]
                ref_pattern = _re.compile(r'^(REQ|UPD|BUG)([-_]?\d+.*)$', _re.IGNORECASE)
                m = ref_pattern.match(kpi.external_ref.strip())
                if m:
                    updates['external_ref'] = target_token + m.group(2)

            if new_kra_id:
                kra_id = int(new_kra_id)
                kra = request.env['kra.master'].sudo().browse(kra_id)
                if not kra.exists():
                    return {'status': False, 'message': 'Project / sub-KRA not found.'}
                # Don't allow moving to a different root client (security)
                old_root = kpi.kra_id
                while old_root and old_root.parent_id:
                    old_root = old_root.parent_id
                new_root = kra
                while new_root.parent_id:
                    new_root = new_root.parent_id
                if old_root and new_root and old_root.id != new_root.id:
                    return {'status': False,
                            'message': 'Cannot move task to a different client. Choose a sub-project under the same client.'}
                updates['kra_id'] = kra_id

            if updates:
                kpi.write(updates)

            return {'status': True, 'updated': list(updates.keys()),
                    'name': kpi.name, 'kra_id': kpi.kra_id.id if kpi.kra_id else False}
        except Exception as e:
            _logger.error(f"update_kpi_meta failed: {str(e)}")
            return {'status': False, 'message': str(e)}

    # PROGRESS UPDATE ENDPOINTS
    @http.route('/kpi/progress/create', type='json', auth='user', methods=['POST'], csrf=False)
    def create_progress_update(self, **params):
        """Create a new progress update for a KPI task"""
        try:
            kpi_id = params.get('kpi_id')
            summary = params.get('summary')
            uploaded_file = params.get('uploaded_file')
            file_name = params.get('file_name')
            related_links = params.get('related_links')
            
            if not kpi_id or not summary:
                return {'status': False, 'message': 'KPI ID and summary are required'}
            
            kpi = request.env['kra.kpi'].browse(int(kpi_id))
            if not kpi.exists():
                return {'status': False, 'message': 'KPI not found'}
            
            progress = request.env['kpi.progress'].create({
                'kpi_id': int(kpi_id),
                'summary': summary,
                'uploaded_file': uploaded_file,
                'file_name': file_name,
                'related_links': related_links,  
                'user_id': request.env.user.id,
            })
            
            return {
                'status': True,
                'message': 'Progress update submitted successfully',
                'progress_id': progress.id,
                'create_date': convert_to_user_tz(progress.create_date),
            }
        except Exception as e:
            _logger.error(f"Error creating progress update: {str(e)}")
            return {'status': False, 'message': str(e)}
    
    @http.route('/kpi/progress/upload_file', type='http', auth='user', methods=['POST'], csrf=False)
    def upload_progress_file(self, **params):
        """Part F — multipart upload so the client can show real upload progress
        (base64-in-JSON can't). Creates a kpi.progress with the file + summary.
        NOTE: if Odoo sits behind nginx, client_max_body_size must be >= 50 MB or
        the proxy 413s before this handler runs."""
        MAX_UPLOAD_BYTES = 50 * 1024 * 1024
        try:
            kpi_id = params.get('kpi_id')
            summary = params.get('summary') or ''
            related_links = params.get('related_links') or '[]'
            f = request.httprequest.files.get('file')
            if not kpi_id:
                return request.make_json_response({'status': False, 'message': 'kpi_id missing'})
            if not f:
                return request.make_json_response({'status': False, 'message': 'No file received'})
            data = f.read()
            if len(data) > MAX_UPLOAD_BYTES:
                return request.make_json_response(
                    {'status': False, 'message': 'File exceeds the 50 MB limit.'})
            p = request.env['kpi.progress'].create({
                'kpi_id': int(kpi_id),
                'summary': summary,
                'uploaded_file': base64.b64encode(data),
                'file_name': f.filename,
                'related_links': related_links,
                'user_id': request.env.user.id,
            })
            return request.make_json_response({'status': True, 'id': p.id, 'file_name': f.filename})
        except Exception as e:
            _logger.error("upload_progress_file failed: %s", str(e))
            return request.make_json_response({'status': False, 'message': str(e)})

    @http.route('/kpi/progress/list', type='json', auth='user', methods=['POST'], csrf=False)
    def get_progress_updates(self, **params):
        """Get progress updates for a specific KPI"""
        try:
            kpi_id = params.get('kpi_id')
            if not kpi_id:
                return {'status': False, 'message': 'KPI ID is required'}
            
            domain = [('kpi_id', '=', int(kpi_id))]
            progress_list = request.env['kpi.progress'].search(domain, order='create_date desc')
            
            updates = []
            for progress in progress_list:
                updates.append({
                    'id': progress.id,
                    'summary': progress.summary,
                    'file_name': progress.file_name,
                    'has_file': bool(progress.uploaded_file),
                    'employee_name': progress.employee_name,
                    'create_date': convert_to_user_tz(progress.create_date),
                    'user_id': progress.user_id.id,
                    'related_links': progress.related_links or '[]',
                })
            
            return {
                'status': True,
                'updates': updates,
            }
        except Exception as e:
            _logger.error(f"Error fetching progress updates: {str(e)}")
            return {'status': False, 'message': str(e)}
    @http.route('/kpi/progress/file_b64', type='json', auth='user', methods=['POST'], csrf=False)
    def get_progress_file_b64(self, **params):
        """A progress file's bytes as base64, for the APP's View / Download.

        The /view and /download routes above are type='http': fine in a browser
        that carries the session cookie, useless to the app. React Native's image
        loader and any external browser handed such a URL send NO cookie, so they
        silently land on the login page instead of the file (the same trap that
        broke the client-ZIP download). Fetching over the authenticated JSON
        channel is the fix, exactly as /kpi_client_workspace/generate_zip_b64 does.

        Gated by the task's own rule: admin/coordinator any, developer own,
        client never — a file must not be readable where its task isn't.
        """
        pid = int(params.get('progress_id') or 0)
        if not pid:
            return {'status': False, 'message': 'progress_id required'}
        prog = request.env['kpi.progress'].sudo().browse(pid)
        if not prog.exists() or not prog.uploaded_file:
            return {'status': False, 'message': 'File not found'}
        denied = self._may_view_kpi_details(prog.kpi_id)
        if denied:
            return {'status': False, 'message': denied}

        file_name = prog.file_name or 'file'
        mime_type, _ = mimetypes.guess_type(file_name)
        if not mime_type:
            mime_type = 'application/octet-stream'
        data_b64 = prog.uploaded_file
        if isinstance(data_b64, bytes):
            data_b64 = data_b64.decode()
        return {
            'status': True,
            'file_name': file_name,
            'mimetype': mime_type,
            'data_b64': data_b64,
            # Decoded size, i.e. what actually lands on disk — base64 is ~+33%.
            'size': len(base64.b64decode(prog.uploaded_file)),
        }

    @http.route('/kpi/progress/view', type='http', auth='user', methods=['GET'])
    def view_progress_file(self, progress_id, **kwargs):
        """View a progress update file inline (for viewing in browser)"""
        try:
            progress = request.env['kpi.progress'].browse(int(progress_id))
            
            if not progress.exists() or not progress.uploaded_file:
                return request.not_found()
            
            file_content = base64.b64decode(progress.uploaded_file)
            file_name = progress.file_name or 'file'
            
            # Determine MIME type
            mime_type, _ = mimetypes.guess_type(file_name)
            if not mime_type:
                if file_name.lower().endswith('.pdf'):
                    mime_type = 'application/pdf'
                elif file_name.lower().endswith(('.png', '.jpg', '.jpeg')):
                    mime_type = 'image/jpeg'
                else:
                    mime_type = 'application/octet-stream'
            
            # Use 'inline' to view in browser
            headers = [
                ('Content-Type', mime_type),
                ('Content-Disposition', f'inline; filename="{file_name}"'),
                ('Content-Length', len(file_content)),
            ]
            
            return request.make_response(file_content, headers)
            
        except Exception as e:
            _logger.error(f"Error viewing progress file: {str(e)}")
            return request.not_found()
    @http.route('/kpi/progress/download', type='http', auth='user', methods=['GET'])
    def download_progress_file(self, progress_id, **kwargs):
        """Download a progress update file"""
        try:
            progress = request.env['kpi.progress'].browse(int(progress_id))
            if not progress.exists() or not progress.uploaded_file:
                return request.not_found()
            
            file_content = base64.b64decode(progress.uploaded_file)
            file_name = progress.file_name or 'download'
            
            headers = [
                ('Content-Type', 'application/octet-stream'),
                ('Content-Disposition', f'attachment; filename="{file_name}"'),
            ]
            
            return request.make_response(file_content, headers)
        except Exception as e:
            _logger.error(f"Error downloading file: {str(e)}")
            return request.not_found()

    # ============================================
    # 📚 UPDATED: Multiple User Manuals API
    # ============================================

    @http.route('/kpi/manual/upload', type='json', auth='user', methods=['POST'], csrf=False)
    def upload_user_manual(self, **params):
        """Upload a new user manual for a KPI task"""
        try:
            kpi_id = params.get('kpi_id')
            file_data = params.get('file_data')
            file_name = params.get('file_name')
            description = params.get('description', '')
            related_links = params.get('related_links', '[]')
            
            if not kpi_id or not file_data:
                return {'status': False, 'message': 'KPI ID and file are required'}
            
            kpi = request.env['kra.kpi'].browse(int(kpi_id))
            if not kpi.exists():
                return {'status': False, 'message': 'KPI not found'}
            
            manual = request.env['kpi.user.manual'].create({
                'kpi_id': int(kpi_id),
                'manual_file': file_data,
                'file_name': file_name,
                'description': description,
                'related_links': related_links,
                'uploaded_by': request.env.user.id,
                'upload_date': fields.Datetime.now(),
            })
            
            return {
                'status': True,
                'message': 'User manual uploaded successfully',
                'manual_id': manual.id,
            }
        except Exception as e:
            _logger.error(f"Error uploading user manual: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi/manual/list', type='json', auth='user', methods=['POST'], csrf=False)
    def list_user_manuals(self, **params):
        """Get all user manuals for a KPI"""
        try:
            kpi_id = params.get('kpi_id')
            if not kpi_id:
                return {'status': False, 'message': 'KPI ID is required'}
            
            manuals = request.env['kpi.user.manual'].search([
                ('kpi_id', '=', int(kpi_id))
            ], order='upload_date desc')
            
            manual_list = []
            for manual in manuals:
                manual_list.append({
                    'id': manual.id,
                    'file_name': manual.file_name,
                    'description': manual.description or '',
                    'related_links': manual.related_links or '[]',
                    'uploaded_by': manual.uploader_name,
                    'upload_date': convert_to_user_tz(manual.upload_date),
                })
            
            return {
                'status': True,
                'manuals': manual_list,
            }
        except Exception as e:
            _logger.error(f"Error listing user manuals: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi/manual/file_b64', type='json', auth='user', methods=['POST'], csrf=False)
    def get_manual_file_b64(self, **params):
        """A manual's bytes as base64, for the APP's View / Download.

        Same reasoning as /kpi/progress/file_b64: the /view and /download routes
        below are type='http' and depend on the session cookie, which the app's
        image loader and any external browser do NOT send — they'd land on the
        login page instead of the file. Gated by the task's own rule.
        """
        mid = int(params.get('manual_id') or 0)
        if not mid:
            return {'status': False, 'message': 'manual_id required'}
        man = request.env['kpi.user.manual'].sudo().browse(mid)
        if not man.exists() or not man.manual_file:
            return {'status': False, 'message': 'File not found'}
        denied = self._may_view_kpi_details(man.kpi_id)
        if denied:
            return {'status': False, 'message': denied}

        file_name = man.file_name or 'manual'
        mime_type, _ = mimetypes.guess_type(file_name)
        if not mime_type:
            mime_type = 'application/octet-stream'
        data_b64 = man.manual_file
        if isinstance(data_b64, bytes):
            data_b64 = data_b64.decode()
        return {
            'status': True,
            'file_name': file_name,
            'mimetype': mime_type,
            'data_b64': data_b64,
            'size': len(base64.b64decode(man.manual_file)),
        }

    @http.route('/kpi/manual/view/<int:manual_id>', type='http', auth='user', methods=['GET'])
    def view_user_manual(self, manual_id, **kwargs):
        """View user manual inline"""
        try:
            manual = request.env['kpi.user.manual'].sudo().browse(manual_id)
            if not manual.exists() or not manual.manual_file:
                return request.not_found()
            
            file_content = base64.b64decode(manual.manual_file)
            file_name = manual.file_name or 'manual.pdf'
            
            mime_type, _ = mimetypes.guess_type(file_name)
            if not mime_type:
                mime_type = 'application/octet-stream'
            
            headers = [
                ('Content-Type', mime_type),
                ('Content-Disposition', f'inline; filename="{file_name}"'),
            ]
            
            return request.make_response(file_content, headers)
        except Exception as e:
            _logger.error(f"Error viewing manual: {str(e)}")
            return request.not_found()

    @http.route('/kpi/manual/download/<int:manual_id>', type='http', auth='user', methods=['GET'])
    def download_user_manual(self, manual_id, **kwargs):
        """Download user manual"""
        try:
            manual = request.env['kpi.user.manual'].sudo().browse(manual_id)
            if not manual.exists() or not manual.manual_file:
                return request.not_found()
            
            file_content = base64.b64decode(manual.manual_file)
            file_name = manual.file_name or 'manual.pdf'
            
            headers = [
                ('Content-Type', 'application/octet-stream'),
                ('Content-Disposition', f'attachment; filename="{file_name}"'),
            ]
            
            return request.make_response(file_content, headers)
        except Exception as e:
            _logger.error(f"Error downloading manual: {str(e)}")
            return request.not_found()

    # ------------------------------------------------------------------ #
    # Daily employee task report (PDF) — admin view / download           #
    # ------------------------------------------------------------------ #
    @http.route('/kpi_daily_report/list', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_daily_report_list(self, **params):
        """Recent generated daily reports, newest first. Admins only."""
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        try:
            limit = int(params.get('limit') or 60)
        except (TypeError, ValueError):
            limit = 60
        reports = request.env['kpi.daily.report'].sudo().search([], limit=limit)
        rows = []
        for r in reports:
            rows.append({
                'id': r.id,
                'report_date': str(r.report_date) if r.report_date else '',
                'date_display': r.report_date.strftime('%d %b %Y') if r.report_date else '',
                'employee_count': r.employee_count,
                'task_count': r.task_count,
                'file_name': r.pdf_filename or ('daily-task-report-%s.pdf' % r.report_date),
                'has_file': bool(r.pdf_file),
                'generated_at': convert_to_user_tz(r.generated_at) if r.generated_at else '',
            })
        return {'status': True, 'reports': rows}

    @http.route('/kpi_daily_report/file_b64', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_daily_report_file_b64(self, **params):
        """A report's PDF bytes as base64, for the APP's View / Download.

        Same reasoning as /kpi/manual/file_b64: the type='http' download route
        below depends on the session cookie, which the app does NOT send. Admins only.
        """
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        rid = int(params.get('report_id') or 0)
        if not rid:
            return {'status': False, 'message': 'report_id required'}
        rep = request.env['kpi.daily.report'].sudo().browse(rid)
        if not rep.exists() or not rep.pdf_file:
            return {'status': False, 'message': 'File not found'}
        data_b64 = rep.pdf_file
        if isinstance(data_b64, bytes):
            data_b64 = data_b64.decode()
        file_name = rep.pdf_filename or ('daily-task-report-%s.pdf' % rep.report_date)
        return {
            'status': True,
            'file_name': file_name,
            'mimetype': 'application/pdf',
            'data_b64': data_b64,
            'size': len(base64.b64decode(rep.pdf_file)),
        }

    @http.route('/kpi_daily_report/download/<int:report_id>', type='http', auth='user', methods=['GET'])
    def kpi_daily_report_download(self, report_id, **kwargs):
        """Browser download of a report PDF (Odoo web backend). Admins only."""
        if not self._is_kra_admin(request.env.user):
            return request.not_found()
        try:
            rep = request.env['kpi.daily.report'].sudo().browse(report_id)
            if not rep.exists() or not rep.pdf_file:
                return request.not_found()
            file_content = base64.b64decode(rep.pdf_file)
            file_name = rep.pdf_filename or ('daily-task-report-%s.pdf' % rep.report_date)
            headers = [
                ('Content-Type', 'application/pdf'),
                ('Content-Disposition', f'attachment; filename="{file_name}"'),
            ]
            return request.make_response(file_content, headers)
        except Exception as e:
            _logger.error(f"Error downloading daily report: {str(e)}")
            return request.not_found()

    @http.route('/kpi_daily_report/view/<int:report_id>', type='http', auth='user', methods=['GET'])
    def kpi_daily_report_view(self, report_id, **kwargs):
        """View a report PDF inline in the browser (not a download). Admins only."""
        if not self._is_kra_admin(request.env.user):
            return request.not_found()
        try:
            rep = request.env['kpi.daily.report'].sudo().browse(report_id)
            if not rep.exists() or not rep.pdf_file:
                return request.not_found()
            file_content = base64.b64decode(rep.pdf_file)
            file_name = rep.pdf_filename or ('daily-task-report-%s.pdf' % rep.report_date)
            headers = [
                ('Content-Type', 'application/pdf'),
                ('Content-Disposition', f'inline; filename="{file_name}"'),
            ]
            return request.make_response(file_content, headers)
        except Exception as e:
            _logger.error(f"Error viewing daily report: {str(e)}")
            return request.not_found()

    @http.route('/kpi/manual/delete', type='json', auth='user', methods=['POST'], csrf=False)
    def delete_user_manual(self, **params):
        """Delete a user manual"""
        try:
            manual_id = params.get('manual_id')
            if not manual_id:
                return {'status': False, 'message': 'manual_id is required'}
            
            manual = request.env['kpi.user.manual'].browse(int(manual_id))
            if not manual.exists():
                return {'status': False, 'message': 'Manual not found'}
            
            manual.unlink()
            
            return {
                'status': True,
                'message': 'Manual deleted successfully',
            }
        except Exception as e:
            _logger.error(f"Error deleting manual: {str(e)}")
            return {'status': False, 'message': str(e)}
        
    @http.route('/kra_kpi/update_kra', type='json', auth='user', methods=['POST'], csrf=False)
    def update_kra(self, **params):
        """Update KRA name"""
        kra_id = params.get("kra_id")
        name = params.get("name", "").strip()
        
        if not kra_id:
            return {"status": False, "message": "kra_id missing"}
        
        if not name:
            return {"status": False, "message": "Name is required"}
        
        kra = request.env["kra.master"].sudo().browse(int(kra_id))
        
        if not kra.exists():
            return {"status": False, "message": "KRA not found"}
        
        # Check for duplicate names
        # If it's a main KRA (no parent)
        if not kra.parent_id:
            existing = request.env["kra.master"].sudo().search([
                ('name', '=ilike', name),
                ('parent_id', '=', False),
                ('id', '!=', int(kra_id))
            ], limit=1)
            if existing:
                return {"status": False, "message": f"A KRA with the name '{name}' already exists"}
        else:
            # If it's a sub-KRA, check under the same parent
            existing = request.env["kra.master"].sudo().search([
                ('name', '=ilike', name),
                ('parent_id', '=', kra.parent_id.id),
                ('id', '!=', int(kra_id))
            ], limit=1)
            if existing:
                return {"status": False, "message": f"A Sub-KRA with the name '{name}' already exists under this parent"}
        
        # Update the name
        kra.write({'name': name})
        
        return {
            "status": True,
            "message": "KRA name updated successfully",
            "id": kra.id,
            "new_name": kra.name
        }

    # ============================================
    # KRA -> Client assignment (per-client visibility)
    # ============================================
    @http.route('/kra_kpi/kra/get_client_users', type='json', auth='user',
                methods=['POST'], csrf=False)
    def get_client_users(self, **params):
        """Return active users in the KRA / KPI Client portal group.
        Used by the assign-clients picker on each KRA's pencil-edit area.
        """
        try:
            grp = request.env.ref('kra_kpi_module.group_kra_client',
                                  raise_if_not_found=False)
            if not grp:
                return {'status': True, 'users': []}
            users = grp.sudo().user_ids.filtered(
                lambda u: u.active and u.id > 1).sorted('name')
            return {
                'status': True,
                'users': [
                    {'id': u.id, 'login': u.login, 'name': u.name or u.login}
                    for u in users
                ],
            }
        except Exception as e:
            _logger.error(f"get_client_users: {e}")
            return {'status': False, 'message': str(e), 'users': []}

    @http.route('/kra_kpi/kra/create_client_user', type='json', auth='user',
                methods=['POST'], csrf=False)
    def create_client_user(self, **params):
        """Create a new client portal user without leaving the KRA / KPI Master.
        Used by the '+ New Client' button inside the Assign Clients modal.

        params:
          name      (required)  display name
          login     (required)  unique login (typically email-like)
          phone     (optional)  WhatsApp-routable phone (digits, no '+')
          password  (optional)  if empty a random 6-digit value is generated
        Returns:
          {status, user_id, name, login, phone, password, generated_password: bool}
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

            name  = (params.get('name')  or '').strip()
            login = (params.get('login') or '').strip()
            phone = (params.get('phone') or '').strip()
            password = (params.get('password') or '').strip()
            generated = False

            if not name or not login:
                return {'status': False, 'message': 'Name and login are required.'}
            # Login must be unique.
            existing = request.env['res.users'].sudo().with_context(active_test=False).search(
                [('login', '=', login)], limit=1)
            if existing:
                return {'status': False,
                        'message': f'Login "{login}" is already taken.'}

            if not password:
                import random
                password = f"{random.randint(0, 999999):06d}"
                generated = True
            elif len(password) < 4:
                return {'status': False,
                        'message': 'Password must be at least 4 characters.'}

            # Group references.
            base_user = request.env.ref('base.group_user')
            client_grp = request.env.ref(
                'kra_kpi_module.group_kra_client', raise_if_not_found=False)
            if not client_grp:
                return {'status': False,
                        'message': 'KRA / KPI Client group not found.'}
            new_user = request.env['res.users'].sudo().create({
                'name':              name,
                'login':             login,
                'password':          password,
                'active':            True,
                'notification_type': 'inbox',
                'tz':                'Asia/Kolkata',
                'group_ids':         [(6, 0, [base_user.id, client_grp.id])],
            })
            # Phone goes on the partner record (the res.users.phone is
            # related, but writing through the partner makes it explicit).
            if phone:
                new_user.partner_id.sudo().write({'phone': phone})
                # Try mobile field too if it exists.
                if 'mobile' in request.env['res.partner']._fields:
                    new_user.partner_id.sudo().write({'mobile': phone})

            return {
                'status':              True,
                'user_id':             new_user.id,
                'name':                new_user.name,
                'login':               new_user.login,
                'phone':               phone,
                'password':            password if generated else '',
                'generated_password':  generated,
                'message':             f'Client "{name}" created.',
            }
        except Exception as e:
            _logger.error(f"create_client_user: {e}")
            return {'status': False, 'message': str(e)}

    @http.route('/kra_kpi/kra/assign_clients', type='json', auth='user',
                methods=['POST'], csrf=False)
    def assign_kra_clients(self, **params):
        """Replace the kra.master.client_user_ids set with the supplied
        user_ids list.  Setting an empty list clears all assignments.

        Only Coordinator + Owner + System admins can use this.
        """
        try:
            user = request.env.user
            allowed = (
                user.has_group('kra_kpi_module.group_kra_admin')
                or user.has_group('kra_kpi_module.group_kra_owner')
                or user.has_group('base.group_system')
            )
            if not allowed:
                return {'status': False,
                        'message': 'Not authorized to assign clients.'}

            kra_id = int(params.get('kra_id') or 0)
            user_ids = params.get('user_ids') or []
            if not kra_id:
                return {'status': False, 'message': 'kra_id missing'}
            kra = request.env['kra.master'].sudo().browse(kra_id)
            if not kra.exists():
                return {'status': False, 'message': 'KRA not found'}
            clean_ids = []
            for u in user_ids:
                try:
                    clean_ids.append(int(u))
                except (TypeError, ValueError):
                    pass
            kra.write({'client_user_ids': [(6, 0, clean_ids)]})
            return {
                'status':  True,
                'message': f'{len(clean_ids)} client(s) assigned to "{kra.name}".',
                'kra_id':  kra.id,
                'client_user_ids': clean_ids,
            }
        except Exception as e:
            _logger.error(f"assign_kra_clients: {e}")
            return {'status': False, 'message': str(e)}

    # ============================================
    # Company branding (logo + name) for invoice PDFs
    # ============================================
    @http.route('/kra_kpi/company/get', type='json', auth='user',
                methods=['POST'], csrf=False)
    def get_company_branding(self, **params):
        """Return current company name + logo (base64) for the branding form."""
        try:
            c = request.env.company
            logo = c.logo
            b64 = ''
            if logo:
                b64 = logo.decode() if isinstance(logo, bytes) else logo
            return {
                'status':   True,
                'name':     c.name or '',
                'logo_b64': b64,
            }
        except Exception as e:
            _logger.error(f"get_company_branding: {e}")
            return {'status': False, 'message': str(e)}

    @http.route('/kra_kpi/company/save', type='json', auth='user',
                methods=['POST'], csrf=False)
    def save_company_branding(self, **params):
        """Update res.company.name + res.company.logo with what the user
        uploaded.  Authorized for system admin / KRA owner / coordinator.
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

            name     = (params.get('name')     or '').strip()
            logo_b64 = (params.get('logo_b64') or '').strip()

            if not name:
                return {'status': False, 'message': 'Company name is required.'}

            c = request.env.company.sudo()
            vals = {}
            if name != (c.name or ''):
                vals['name'] = name
            # logo: empty string means "clear it"; non-empty means write the b64.
            current_logo = c.logo
            current_b64  = (current_logo.decode() if isinstance(current_logo, bytes)
                            else (current_logo or ''))
            if logo_b64 != current_b64:
                vals['logo'] = logo_b64 or False
            if vals:
                c.write(vals)
                # Also update the linked partner so list views show the new
                # name consistently.  Skip silently if no partner is set
                # (unusual but possible on weird installs).
                if 'name' in vals and c.partner_id:
                    try:
                        c.partner_id.sudo().write({'name': name})
                    except Exception:
                        pass
            return {
                'status':  True,
                'message': 'Branding saved.',
                'name':    c.name,
            }
        except Exception as e:
            _logger.error(f"save_company_branding: {e}")
            return {'status': False, 'message': str(e)}

    # ============================================
    # 🆕 NEW: GitHub Links API
    # ============================================

    @http.route('/kpi/github/add', type='json', auth='user', methods=['POST'], csrf=False)
    def add_github_link(self, **params):
        """Add a GitHub repository link to a KPI task"""
        try:
            kpi_id = params.get('kpi_id')
            github_url = params.get('github_url', '').strip()
            branch_name = params.get('branch_name', '').strip()
            
            if not kpi_id:
                return {'status': False, 'message': 'KPI ID is required'}
            
            if not github_url:
                return {'status': False, 'message': 'GitHub URL is required'}
            
            if not branch_name:
                return {'status': False, 'message': 'Branch name is required'}
            
            # Validate GitHub URL
            if not github_url.startswith('http'):
                github_url = 'https://' + github_url
            
            if 'github.com' not in github_url.lower():
                return {'status': False, 'message': 'Only GitHub URLs are allowed'}
            
            # Check if KPI exists
            kpi = request.env['kra.kpi'].browse(int(kpi_id))
            if not kpi.exists():
                return {'status': False, 'message': 'KPI not found'}
            
            # Create GitHub link record
            github_link = request.env['kpi.github.link'].create({
                'kpi_id': int(kpi_id),
                'github_url': github_url,
                'branch_name': branch_name,
                'user_id': request.env.user.id,
            })
            
            return {
                'status': True,
                'message': 'GitHub link added successfully',
                'link_id': github_link.id,
            }
        except Exception as e:
            _logger.error(f"Error adding GitHub link: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi/github/list', type='json', auth='user', methods=['POST'], csrf=False)
    def list_github_links(self, **params):
        """Get all GitHub links for a KPI"""
        try:
            kpi_id = params.get('kpi_id')
            if not kpi_id:
                return {'status': False, 'message': 'KPI ID is required'}
            
            github_links = request.env['kpi.github.link'].search([
                ('kpi_id', '=', int(kpi_id))
            ], order='create_date desc')
            
            links_list = []
            for link in github_links:
                links_list.append({
                    'id': link.id,
                    'github_url': link.github_url,
                    'branch_name': link.branch_name,
                    'employee_name': link.employee_name,
                    'create_date': convert_to_user_tz(link.create_date),
                })
            
            return {
                'status': True,
                'links': links_list,
            }
        except Exception as e:
            _logger.error(f"Error listing GitHub links: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kpi/github/delete', type='json', auth='user', methods=['POST'], csrf=False)
    def delete_github_link(self, **params):
        """Delete a GitHub link"""
        try:
            link_id = params.get('link_id')
            if not link_id:
                return {'status': False, 'message': 'link_id is required'}
            
            link = request.env['kpi.github.link'].browse(int(link_id))
            if not link.exists():
                return {'status': False, 'message': 'GitHub link not found'}
            
            link.unlink()
            
            return {
                'status': True,
                'message': 'GitHub link deleted successfully',
            }
        except Exception as e:
            _logger.error(f"Error deleting GitHub link: {str(e)}")
            return {'status': False, 'message': str(e)}
    
    # Add these new routes to your kra_api.py file

    @http.route('/kra_kpi/task/approve', type='json', auth='user', methods=['POST'], csrf=False)
    def task_approve(self, **params):
        """Approve a partially completed task with checklist - Manager/HR only"""
        kpi_id = params.get('kpi_id')
        manager_checklist = params.get('manager_checklist', {})
        
        if not kpi_id:
            return {'status': False, 'message': 'kpi_id missing'}

        # Check permissions
        current_user = request.env.user
        is_manager_or_admin = (
            current_user.has_group('kra_kpi_module.group_kra_admin') or
            current_user.has_group('kra_kpi_module.group_kra_manager') or
            current_user.has_group('base.group_system')
        )

        if not is_manager_or_admin:
            return {
                'status': False,
                'message': 'You do not have permission to approve tasks.'
            }

        rec = request.env['kra.kpi'].sudo().browse(int(kpi_id))

        if not rec.exists():
            return {'status': False, 'message': 'Task not found'}

        if rec.task_state != 'partially_completed':
            return {'status': False, 'message': 'Only partially completed tasks can be approved'}
        
        rec.approve_task(manager_checklist)
        
        return {
            'status': True, 
            'message': 'Task approved successfully', 
            'id': rec.id,
            'new_state': rec.task_state,
        }

    @http.route('/kra_kpi/task/reject', type='json', auth='user', methods=['POST'], csrf=False)
    def task_reject(self, **params):
        """Reject a partially completed task - Manager/HR only"""
        kpi_id = params.get('kpi_id')
        rejection_reason = params.get('reason', '').strip()
        
        if not kpi_id:
            return {'status': False, 'message': 'kpi_id missing'}
        
        if not rejection_reason:
            return {'status': False, 'message': 'Rejection reason is required'}

        # Check if user has approval rights
        current_user = request.env.user
        is_manager_or_admin = (
            current_user.has_group('kra_kpi_module.group_kra_admin') or
            current_user.has_group('kra_kpi_module.group_kra_manager') or
            current_user.has_group('base.group_system')
        )

        if not is_manager_or_admin:
            return {
                'status': False,
                'message': 'You do not have permission to reject tasks. Only Coordinators / HR can reject.'
            }

        rec = request.env['kra.kpi'].sudo().browse(int(kpi_id))
        
        if not rec.exists():
            return {'status': False, 'message': 'Task not found'}
        
        if rec.task_state != 'partially_completed':
            return {'status': False, 'message': 'Only partially completed tasks can be rejected'}
        
        rec.reject_task(rejection_reason)
        
        return {
            'status': True, 
            'message': 'Task rejected and sent back to employee', 
            'id': rec.id,
            'new_state': rec.task_state,
        }
    @http.route('/kra_kpi/task/checklists', type='json', auth='user', methods=['POST'], csrf=False)
    def get_task_checklists(self, **params):
        """Get checklist status for a task"""
        kpi_id = params.get('kpi_id')
        
        if not kpi_id:
            return {'status': False, 'message': 'kpi_id missing'}
        
        rec = request.env['kra.kpi'].sudo().browse(int(kpi_id))
        
        if not rec.exists():
            return {'status': False, 'message': 'Task not found'}
        
        return {
            'status': True,
            'employee_checklist': {
                'verify_github': rec.employee_checklist_github,
                'deployed_task': rec.employee_checklist_deployed,
                'user_manual': rec.employee_checklist_manual,
                'documentation': rec.employee_checklist_docs,
                'tested_code': rec.employee_checklist_tested,
            },
            'manager_checklist': {
                'task_reviewed': rec.manager_checklist_reviewed,
                'manual_reviewed': rec.manager_checklist_manual_reviewed,
                'testing_completed': rec.manager_checklist_testing,
                'github_verified': rec.manager_checklist_github,
                'tested_successfully': rec.manager_checklist_tested_success,
                'docs_approved': rec.manager_checklist_docs_approved,
            }
        }
    # ============================================
    # ✅ NEW: TASK RELATED DOCUMENTS API
    # ============================================

    @http.route('/task_documents/list', type='json', auth='user', methods=['POST'], csrf=False)
    def get_task_documents_list(self, **params):
        """Get list of all KPI tasks with document counts"""
        try:
            # ✅ Get filter parameter
            assignee_id = params.get('assignee_id')
            
            # Build domain
            domain = []
            if assignee_id:
                domain.append(('user_id', '=', int(assignee_id)))
            
            # ✅ Get ALL KPI tasks (not just with documents)
            kpis = request.env['kra.kpi'].sudo().search(domain)
            
            tasks = []
            for kpi in kpis:
                # Count documents
                progress_files = request.env['kpi.progress'].search([
                    ('kpi_id', '=', kpi.id),
                    ('uploaded_file', '!=', False)
                ])
                
                github_links = request.env['kpi.github.link'].search([
                    ('kpi_id', '=', kpi.id)
                ])
                
                user_manuals = request.env['kpi.user.manual'].search([
                    ('kpi_id', '=', kpi.id)
                ])
                
                # Count links from progress updates
                progress_with_links = request.env['kpi.progress'].search([
                    ('kpi_id', '=', kpi.id),
                    ('related_links', '!=', False)
                ])
                
                # Links carry no type in storage (a bare JSON array of URL strings),
                # so "is this a Drive link?" can only be answered by reading the URL.
                # Reuses the module's existing classifier so the count here and the
                # grouping in /task_documents/details can never disagree.
                categorize = request.env['kpi.backup'].sudo()._categorize_link
                DRIVE_KINDS = ('Google Drive', 'Cloud Storage')

                link_count = 0
                drive_count = 0
                for prog in progress_with_links:
                    try:
                        links = json.loads(prog.related_links or '[]')
                        link_count += len(links)
                        drive_count += sum(1 for l in links if categorize(l) in DRIVE_KINDS)
                    except:
                        pass

                # Also count task-level related links
                try:
                    task_links = json.loads(kpi.related_links or '[]')
                    link_count += len(task_links)
                    drive_count += sum(1 for l in task_links if categorize(l) in DRIVE_KINDS)
                except:
                    pass

                doc_count = len(progress_files)
                github_count = len(github_links)
                manual_count = len(user_manuals)
                # The task's own attachments — always existed on the record, never
                # surfaced here, so tasks holding only a requirement doc looked empty.
                task_doc_count = sum(1 for f in (kpi.requirement_document,
                                                 kpi.updates_document,
                                                 kpi.signed_certificate) if f)
                
                # ✅ CHANGED: Include ALL tasks regardless of document count
                tasks.append({
                    'id': kpi.id,
                    'name': kpi.name,
                    'assignee': kpi.user_id.name if kpi.user_id else 'Unassigned',
                    'assignee_id': kpi.user_id.id if kpi.user_id else False,
                    'priority': kpi.priority or 'regular',
                    'doc_count': doc_count,
                    'link_count': link_count,
                    'github_count': github_count,
                    'manual_count': manual_count,
                    'drive_count': drive_count,
                    'task_doc_count': task_doc_count,
                    'has_attachments': (doc_count + link_count + github_count
                                        + manual_count + task_doc_count) > 0,
                })
            
            # ✅ Get unique assignees for filter dropdown
            all_assignees = request.env['kra.kpi'].sudo().search([]).mapped('user_id')
            assignees = [{'id': user.id, 'name': user.name} for user in all_assignees if user]
            # Sort by name
            assignees = sorted(assignees, key=lambda x: x['name'])
            
            return {
                'status': True,
                'tasks': tasks,
                'assignees': assignees,
            }
        except Exception as e:
            _logger.error(f"Error in get_task_documents_list: {str(e)}")
            return {
                'status': False,
                'message': str(e),
                'tasks': [],
                'assignees': [],
            }

    @http.route('/task_documents/details', type='json', auth='user', methods=['POST'], csrf=False)
    def get_task_documents_details(self, **params):
        """Get detailed documents for a specific task"""
        try:
            task_id = params.get('task_id')
            
            if not task_id:
                return {'status': False, 'message': 'task_id is required'}
            
            kpi = request.env['kra.kpi'].sudo().browse(int(task_id))
            
            if not kpi.exists():
                return {'status': False, 'message': 'Task not found'}
            
            # Get attached files from progress updates
            progress_with_files = request.env['kpi.progress'].sudo().search([
                ('kpi_id', '=', int(task_id)),
                ('uploaded_file', '!=', False)
            ], order='create_date desc')
            
            files = []
            for prog in progress_with_files:
                files.append({
                    'id': prog.id,
                    'file_name': prog.file_name,
                    'uploaded_by': prog.employee_name,
                    'upload_date': convert_to_user_tz(prog.create_date),
                    'view_url': f'/kpi/progress/view?progress_id={prog.id}',
                    'download_url': f'/kpi/progress/download?progress_id={prog.id}',
                })
            
            # Get related links.
            #
            # Links are stored as a plain JSON array of BARE URL STRINGS — there is
            # no type, label or per-link author anywhere in the model. So a Drive
            # link and any other link are indistinguishable in storage, and the only
            # way to group them is to read the URL. `kind` below does exactly that,
            # via the module's EXISTING classifier (kpi.backup._categorize_link →
            # 'Repository' | 'Google Drive' | 'YouTube' | 'Cloud Storage' | 'Email' |
            # 'Other'). Reused rather than re-implemented so the two can't drift;
            # it's a pure function of the url, so calling it on an empty recordset
            # is fine.
            categorize = request.env['kpi.backup'].sudo()._categorize_link
            links = []

            # From progress updates
            progress_with_links = request.env['kpi.progress'].sudo().search([
                ('kpi_id', '=', int(task_id)),
                ('related_links', '!=', False)
            ], order='create_date desc')

            for prog in progress_with_links:
                try:
                    link_list = json.loads(prog.related_links or '[]')
                    for link in link_list:
                        links.append({
                            'url': link,
                            'kind': categorize(link),
                            'added_by': prog.employee_name,
                            'added_date': convert_to_user_tz(prog.create_date),
                        })
                except:
                    pass

            # From task-level related links
            try:
                task_links = json.loads(kpi.related_links or '[]')
                for link in task_links:
                    links.append({
                        'url': link,
                        'kind': categorize(link),
                        'added_by': 'Task Creator',
                        'added_date': convert_to_user_tz(kpi.create_date) if kpi.create_date else '',
                    })
            except:
                pass
            
            # Get GitHub links
            github_records = request.env['kpi.github.link'].sudo().search([
                ('kpi_id', '=', int(task_id))
            ], order='create_date desc')
            
            github = []
            for git in github_records:
                github.append({
                    'id': git.id,
                    'github_url': git.github_url,
                    'branch_name': git.branch_name,
                    'uploaded_by': git.employee_name,
                    'upload_date': convert_to_user_tz(git.create_date),
                })
            
            # Get user manuals
            manual_records = request.env['kpi.user.manual'].sudo().search([
                ('kpi_id', '=', int(task_id))
            ], order='upload_date desc')
            
            manuals = []
            for manual in manual_records:
                manuals.append({
                    'id': manual.id,
                    'file_name': manual.file_name,
                    'description': manual.description or '',
                    'uploaded_by': manual.uploader_name,
                    'upload_date': convert_to_user_tz(manual.upload_date),
                    'view_url': f'/kpi/manual/view/{manual.id}',
                    'download_url': f'/kpi/manual/download/{manual.id}',
                })
            
            # The task's OWN documents. These are real attachments that have always
            # been on kra.kpi (requirement / updates / signed certificate) but no
            # route ever returned them, so the Documents screen — the one place you'd
            # look for a task's documents — couldn't show them at all.
            # Downloads reuse the existing /kpi_completion_cert/download_doc route,
            # which already serves all three doc_types.
            task_docs = []
            if kpi.requirement_document:
                task_docs.append({
                    'kind': 'Requirement',
                    'file_name': kpi.requirement_document_name or 'requirement',
                    'note': (('Version ' + kpi.requirement_version) if kpi.requirement_version else ''),
                    'download_url': f'/kpi_completion_cert/download_doc?kpi_id={kpi.id}&doc_type=requirement',
                })
            if kpi.updates_document:
                task_docs.append({
                    'kind': 'Updates & Errors',
                    'file_name': kpi.updates_document_name or 'updates',
                    'note': '',
                    'download_url': f'/kpi_completion_cert/download_doc?kpi_id={kpi.id}&doc_type=updates',
                })
            if kpi.signed_certificate:
                task_docs.append({
                    'kind': 'Signed Certificate',
                    'file_name': kpi.signed_certificate_name or 'signed_certificate.pdf',
                    'note': (('Signed ' + str(kpi.signed_certificate_date))
                             if kpi.signed_certificate_date else ''),
                    'download_url': f'/kpi_completion_cert/download_doc?kpi_id={kpi.id}&doc_type=signed',
                })

            return {
                'status': True,
                # Context for the detail header — without these the screen showed
                # only name/assignee/priority, which isn't enough to know WHICH task
                # you're looking at or what it's for.
                'task': {
                    'external_ref': kpi.external_ref or '',
                    'related_req_ref': kpi.related_req_ref or '',
                    'delivery_version': kpi.delivery_version or '',
                    'description': kpi.description or '',
                },
                'documents': {
                    'files': files,
                    'links': links,
                    'github': github,
                    'manuals': manuals,
                    'task_docs': task_docs,
                }
            }
        except Exception as e:
            _logger.error(f"Error in get_task_documents_details: {str(e)}")
            return {
                'status': False,
                'message': str(e),
                # Same shape as the success path — the UI reads these keys blindly.
                'task': {},
                'documents': {
                    'files': [],
                    'links': [],
                    'github': [],
                    'manuals': [],
                    'task_docs': [],
                }
            }

    @http.route('/kra_kpi/ai_digest', type='json', auth='user', methods=['POST'], csrf=False)
    def get_ai_digest_data(self, **params):
        """
        Get comprehensive KPI data for AI digest summary.
        This endpoint is called by n8n to fetch data for daily/weekly reports.
        
        Optional params:
        - period: 'today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month' (default: 'today')
        """
        try:
            from datetime import timedelta
            
            period = params.get('period', 'today')
            today = fields.Date.today()
            now = fields.Datetime.now()
            
            # Calculate date range based on period
            if period == 'today':
                start_date = today
                end_date = today
            elif period == 'yesterday':
                start_date = today - timedelta(days=1)
                end_date = today - timedelta(days=1)
            elif period == 'this_week':
                start_date = today - timedelta(days=today.weekday())
                end_date = today
            elif period == 'last_week':
                start_date = today - timedelta(days=today.weekday() + 7)
                end_date = today - timedelta(days=today.weekday() + 1)
            elif period == 'this_month':
                start_date = today.replace(day=1)
                end_date = today
            elif period == 'last_month':
                first_day_current_month = today.replace(day=1)
                last_day_last_month = first_day_current_month - timedelta(days=1)
                start_date = last_day_last_month.replace(day=1)
                end_date = last_day_last_month
            else:
                start_date = today
                end_date = today
            
            start_datetime = fields.Datetime.to_datetime(start_date)
            end_datetime = fields.Datetime.to_datetime(end_date).replace(hour=23, minute=59, second=59)
            
            KPI = request.env['kra.kpi'].sudo()
            
            # ==========================================
            # GET TASKS BASED ON PERIOD
            # ==========================================
            
            # For past periods (last_month, last_week), ONLY show completed tasks in that period
            if period in ['last_month', 'last_week']:
                completed_tasks = KPI.search([
                    ('task_state', '=', 'completed'),
                    ('write_date', '>=', start_datetime),
                    ('write_date', '<=', end_datetime),
                ])
                in_progress_tasks = KPI.browse([])  # Empty
                paused_tasks = KPI.browse([])  # Empty
                not_started_tasks = KPI.browse([])  # Empty
                pending_approval_tasks = KPI.browse([])  # Empty
                all_tasks = completed_tasks
            else:
                # For current periods (today, yesterday, this_week, this_month)
                # Show completed in period + ALL current active tasks
                
                # Completed tasks: ONLY those completed in the period
                completed_tasks = KPI.search([
                    ('task_state', '=', 'completed'),
                    ('write_date', '>=', start_datetime),
                    ('write_date', '<=', end_datetime),
                ])
                
                # In Progress tasks: ALL current in-progress tasks
                in_progress_tasks = KPI.search([
                    ('task_state', '=', 'in_progress'),
                ])
                
                # Paused tasks: ALL current paused tasks
                paused_tasks = KPI.search([
                    ('task_state', '=', 'paused'),
                ])
                
                # Not started tasks: ALL current not-started tasks
                not_started_tasks = KPI.search([
                    ('task_state', 'in', ['assigned', 'urgent', 'important', 'regular']),
                ])
                
                # Pending Approval tasks: ALL current pending approval tasks
                pending_approval_tasks = KPI.search([
                    ('task_state', '=', 'partially_completed'),
                ])
                
                # Combine all tasks (completed in period + all current active tasks)
                all_task_ids = set(completed_tasks.ids + in_progress_tasks.ids + paused_tasks.ids + not_started_tasks.ids + pending_approval_tasks.ids)
                all_tasks = KPI.browse(list(all_task_ids))
            
            # ==========================================
            # HELPER: Calculate task details
            # ==========================================
            def get_task_details(task):
                estimated_hours = (task.estimate_hours or 0) + ((task.estimate_minutes or 0) / 60.0)
                actual_hours = (task.timer_total_seconds or 0) / 3600.0
                
                # Calculate progress percentage
                progress_percent = 0
                if estimated_hours > 0:
                    progress_percent = min(round((actual_hours / estimated_hours) * 100, 1), 100)
                
                # Format actual hours as hours and minutes
                total_minutes = int((task.timer_total_seconds or 0) / 60)
                hours_display = total_minutes // 60
                mins_display = total_minutes % 60
                actual_hours_formatted = f"{hours_display}h {mins_display}m"
                
                # Performance calculation
                if task.task_state == 'completed' and estimated_hours > 0:
                    deviation_hours = estimated_hours - actual_hours
                    if actual_hours <= estimated_hours:
                        performance_status = "EXCELLENT"
                        time_saved = round(deviation_hours, 2)
                        extra_time = 0
                    else:
                        performance_status = "LOW"
                        time_saved = 0
                        extra_time = round(abs(deviation_hours), 2)
                else:
                    performance_status = None
                    time_saved = 0
                    extra_time = 0
                
                # Check if not started for more than 1 day (for urgent/important)
                days_not_started = 0
                if task.task_state in ['assigned', 'urgent', 'important', 'regular']:
                    if task.create_date:
                        days_not_started = (now - task.create_date).days
                
                # Check if paused for more than 2 days
                days_paused = 0
                if task.task_state == 'paused' and task.write_date:
                    days_paused = (now - task.write_date).days
                
                # Get completed by info for pending approval
                completed_by = ''
                completed_date = ''
                if task.task_state == 'partially_completed':
                    if hasattr(task, 'approved_by') and task.approved_by:
                        completed_by = task.approved_by.name
                    if hasattr(task, 'approval_date') and task.approval_date:
                        completed_date = convert_to_user_tz(task.approval_date)
                
                return {
                    'id': task.id,
                    'name': task.name,
                    'status': task.task_state,
                    'priority': task.priority or 'regular',
                    'estimated_hours': round(estimated_hours, 2),
                    'actual_hours': round(actual_hours, 2),
                    'actual_hours_formatted': actual_hours_formatted,
                    'progress_percent': progress_percent,
                    'performance_status': performance_status,
                    'time_saved': time_saved,
                    'extra_time': extra_time,
                    'days_not_started': days_not_started,
                    'days_paused': days_paused,
                    'paused_reason': task.paused_reason or '',
                    'deadline': str(task.deadline) if task.deadline else '',
                    'completed_by': completed_by,
                    'completed_date': completed_date,
                }
            
            # ==========================================
            # EMPLOYEE BREAKDOWN
            # ==========================================
            employees_data = {}
            
            for task in all_tasks:
                emp_name = task.user_id.name if task.user_id else 'Unassigned'
                emp_id = task.user_id.id if task.user_id else 0
                
                if emp_name not in employees_data:
                    employees_data[emp_name] = {
                        'id': emp_id,
                        'name': emp_name,
                        'tasks': [],
                        'completed_count': 0,
                        'in_progress_count': 0,
                        'paused_count': 0,
                        'not_started_count': 0,
                        'pending_approval_count': 0,
                        'total_estimated_hours': 0,
                        'total_actual_hours': 0,
                        'overall_performance': None,
                    }
                
                task_details = get_task_details(task)
                employees_data[emp_name]['tasks'].append(task_details)
                employees_data[emp_name]['total_estimated_hours'] += task_details['estimated_hours']
                employees_data[emp_name]['total_actual_hours'] += task_details['actual_hours']
                
                # Count by status
                if task.task_state == 'completed':
                    employees_data[emp_name]['completed_count'] += 1
                elif task.task_state == 'in_progress':
                    employees_data[emp_name]['in_progress_count'] += 1
                elif task.task_state == 'paused':
                    employees_data[emp_name]['paused_count'] += 1
                elif task.task_state == 'partially_completed':
                    employees_data[emp_name]['pending_approval_count'] += 1
                else:
                    employees_data[emp_name]['not_started_count'] += 1
            
            # Calculate overall performance for each employee
            for emp_name, emp_data in employees_data.items():
                if emp_data['completed_count'] > 0 and emp_data['total_estimated_hours'] > 0:
                    if emp_data['total_actual_hours'] <= emp_data['total_estimated_hours']:
                        emp_data['overall_performance'] = 'EXCELLENT'
                    else:
                        emp_data['overall_performance'] = 'LOW'
                elif emp_data['not_started_count'] > 0 and emp_data['completed_count'] == 0:
                    emp_data['overall_performance'] = 'NEEDS_TO_START'
                
                # Round the totals
                emp_data['total_estimated_hours'] = round(emp_data['total_estimated_hours'], 2)
                emp_data['total_actual_hours'] = round(emp_data['total_actual_hours'], 2)
            
            # ==========================================
            # ALERTS
            # ==========================================
            alerts = []
            
            # Alert 1: Urgent tasks not started for 1+ day
            for task in not_started_tasks:
                if task.priority == 'urgent':
                    task_details = get_task_details(task)
                    if task_details['days_not_started'] >= 1:
                        alerts.append({
                            'type': 'URGENT_NOT_STARTED',
                            'message': f"{task.name} (Urgent) not started for {task_details['days_not_started']} day(s)",
                            'employee': task.user_id.name if task.user_id else 'Unassigned',
                            'task_name': task.name,
                            'days': task_details['days_not_started'],
                        })
            
            # Alert 2: Important tasks not started
            for task in not_started_tasks:
                if task.priority == 'important':
                    alerts.append({
                        'type': 'IMPORTANT_NOT_STARTED',
                        'message': f"{task.name} (Important) not started",
                        'employee': task.user_id.name if task.user_id else 'Unassigned',
                        'task_name': task.name,
                        'days': get_task_details(task)['days_not_started'],
                    })
            
            # Alert 3: Tasks paused for more than 2 days
            for task in paused_tasks:
                task_details = get_task_details(task)
                if task_details['days_paused'] >= 2:
                    alerts.append({
                        'type': 'PAUSED_TOO_LONG',
                        'message': f"{task.name} paused for {task_details['days_paused']} days",
                        'employee': task.user_id.name if task.user_id else 'Unassigned',
                        'task_name': task.name,
                        'days': task_details['days_paused'],
                        'reason': task.paused_reason or 'No reason',
                    })
            
            # ==========================================
            # SUMMARY
            # ==========================================
            total_tasks = len(all_tasks)
            completed_count = len(completed_tasks)
            in_progress_count = len(in_progress_tasks)
            paused_count = len(paused_tasks)
            not_started_count = len(not_started_tasks)
            pending_approval_count = len(pending_approval_tasks)
            progress_percentage = round((completed_count / total_tasks * 100), 1) if total_tasks > 0 else 0
            
            # ==========================================
            # BUILD RESPONSE
            # ==========================================
            return {
                'status': True,
                'period': period,
                'date_range': {'start': str(start_date), 'end': str(end_date)},
                'summary': {
                    'total_tasks': total_tasks,
                    'completed': completed_count,
                    'in_progress': in_progress_count,
                    'paused': paused_count,
                    'not_started': not_started_count,
                    'pending_approval': pending_approval_count,
                    'progress_percentage': progress_percentage,
                },
                'employees': list(employees_data.values()),
                'alerts': alerts,
                'generated_at': str(now),
            }
            
        except Exception as e:
            _logger.error(f"Error generating AI digest data: {str(e)}")
            return {'status': False, 'message': str(e)}

    @http.route('/kra_kpi/ai_digest_public', type='http', auth='public', methods=['GET'], csrf=False)
    def get_ai_digest_data_public(self, **params):
        """
        Public HTTP endpoint for n8n (no authentication required).
        Usage: GET /kra_kpi/ai_digest_public?api_key=YOUR_KEY&period=today
        """
        try:
            api_key = params.get('api_key', '')
            valid_api_key = request.env['ir.config_parameter'].sudo().get_param('kra_kpi.ai_digest_api_key', 'your-secret-api-key-here')
            
            if api_key != valid_api_key:
                return request.make_response(
                    json.dumps({'status': False, 'message': 'Invalid API key'}),
                    headers=[('Content-Type', 'application/json')]
                )
            
            period = params.get('period', 'today')
            result = self.get_ai_digest_data(period=period)
            
            return request.make_response(
                json.dumps(result, default=str),
                headers=[('Content-Type', 'application/json')]
            )
            
        except Exception as e:
            _logger.error(f"Error in public AI digest endpoint: {str(e)}")
            return request.make_response(
                json.dumps({'status': False, 'message': str(e)}),
                headers=[('Content-Type', 'application/json')]
            )

    # =========================================================
    # REMINDER AND DEADLINE NOTIFICATION ENDPOINTS
    # =========================================================
    
    @http.route('/kra_kpi/update_reminder_shown', type='json', auth='user', methods=['POST'], csrf=False)
    def update_reminder_shown(self, **params):
        """Update the last_reminder_shown timestamp for a task"""
        kpi_id = params.get('kpi_id')
        if not kpi_id:
            return {'status': False, 'message': 'kpi_id missing'}
        
        kpi = request.env['kra.kpi'].sudo().browse(int(kpi_id))
        if not kpi.exists():
            return {'status': False, 'message': 'KPI not found'}
        
        kpi.write({'last_reminder_shown': fields.Datetime.now()})
        return {'status': True, 'message': 'Reminder timestamp updated'}

    @http.route('/kra_kpi/update_deadline_alert_shown', type='json', auth='user', methods=['POST'], csrf=False)
    def update_deadline_alert_shown(self, **params):
        """Mark the deadline alert as shown for a task (one-time alert)"""
        kpi_id = params.get('kpi_id')
        if not kpi_id:
            return {'status': False, 'message': 'kpi_id missing'}
        
        kpi = request.env['kra.kpi'].sudo().browse(int(kpi_id))
        if not kpi.exists():
            return {'status': False, 'message': 'KPI not found'}
        
        kpi.write({'deadline_alert_shown': True})
        return {'status': True, 'message': 'Deadline alert marked as shown'}
