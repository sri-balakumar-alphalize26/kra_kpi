from odoo import http, api, fields
from odoo.http import request
import json
import logging
import base64
import mimetypes
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
        kpi_id = params.get('kpi_id')
        if not kpi_id:
            return {'status': False, 'message': 'kpi_id missing'}

        rec = request.env['kra.kpi'].sudo().browse(int(kpi_id))
        rec.start_task()
        return {'status': True, 'message': 'Task started', 'id': rec.id}

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
        kpi_id = params.get('kpi_id')
        if not kpi_id:
            return {'status': False, 'message': 'kpi_id missing'}

        rec = request.env['kra.kpi'].sudo().browse(int(kpi_id))
        rec.resume_task()
        return {'status': True, 'message': 'Task resumed', 'id': rec.id}

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
        rec.resume_task()
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
            request.env['kpi.work.session'].sudo()._away_now(request.env.user, source='leave')
        except Exception as exc:
            _logger.warning("kpi_action/leave failed: %s", exc)
        return {'status': True}

    @http.route('/kpi_action/leave_beacon', type='http', auth='user', methods=['POST'], csrf=False)
    def kpi_action_leave_beacon(self, **params):
        """Fired via navigator.sendBeacon on a real tab close/reload (beforeunload),
        where an awaited rpc is impossible. Same effect as /kpi_action/leave.
        type='http' so sendBeacon (same-origin, sends the session cookie) works."""
        try:
            request.env['kpi.work.session'].sudo()._away_now(request.env.user, source='leave')
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
            current_user.has_group('kra_kpi_module.group_kra_manager') or 
            current_user.has_group('base.group_system')
        )
        
        # 🆕 UPDATED: If admin wants to see only their tasks, filter by current user
        if is_manager_or_admin and not my_tasks_only:
            domain = []  # Show all tasks
        else:
            domain = [('user_id', '=', current_user.id)]  # Show only user's tasks
        
        kpis = request.env['kra.kpi'].search(domain)
        
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
            }
        
        self_pending = kpis.filtered(lambda x: x.is_self_created and not x.admin_accepted)
        return {
            'status': True,
            'tasks': [map_rec(x) for x in kpis],
            'is_admin': is_manager_or_admin,
            'current_user_id': current_user.id,  # 🆕 NEW: Include current user ID for rejection checks
            'self_pending_count': len(self_pending),  # Pending Review lane badge
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
            return {
                'id': n.id,
                'kpi_id': n.kpi_id.id if n.kpi_id else False,
                'kpi_name': n.kpi_id.name if n.kpi_id else "",
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
    # Device pairing (kpi.pair) — app generates a PIN, web enters it       #
    # ================================================================== #
    @http.route('/kpi_pair/generate', type='json', auth='user', methods=['POST'], csrf=False)
    def pair_generate(self, **params):
        """App calls this to get a fresh, short-lived pairing PIN."""
        res = request.env['kpi.pair'].sudo().generate_for(request.env.user)
        _logger.info("pair/generate user=%s(%s) mode=%s",
                     request.env.user.login, request.env.user.id, res.get('mode'))
        return {'status': True, 'expires_at': res.get('expires_at'),
                'pin': res.get('pin'), 'mode': res.get('mode')}

    @http.route('/kpi_pair/status', type='json', auth='user', methods=['POST'], csrf=False)
    def pair_status(self, **params):
        """App polls this to learn when the web has entered the PIN."""
        res = request.env['kpi.pair'].sudo().status_for(request.env.user)
        return {'status': True, 'state': res.get('state'),
                'paired': res.get('paired'), 'mode': res.get('mode')}

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
        })

        # Notify owner + coordinator that a task is waiting for review.
        try:
            rec._notify('self_task_submitted',
                        title=rec.name, dev=user.name, project=kra.name,
                        estimate=f"{est_h}h {est_m}m", priority=priority)
        except Exception as exc:
            _logger.warning("self_task_submitted notify failed: %s", exc)

        return {'status': True, 'id': rec.id,
                'message': 'Task created in your Pending Review lane.'}

    @http.route('/kra_kpi/task/accept_self_created', type='json', auth='user', methods=['POST'], csrf=False)
    def accept_self_created(self, **params):
        """Admin accepts a self-created task into the official flow.

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
        if not rec.is_self_created or rec.admin_accepted:
            return {'status': False, 'message': 'This task is not awaiting acceptance.'}

        vals = {'admin_accepted': True}
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
            rec.write({'active': False})
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
        return {'status': True, 'developers': [
            {'id': u.id, 'name': u.name, 'login': u.login,
             'allow_multitask': u.kpi_allow_multitask,
             'wa_number': u.kpi_wa_number or ''}
            for u in devs.sorted('name')]}

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
        dial, length = request.env.company._kpi_mobile_cfg()
        num = normalize_wa(params.get('wa_number') or '', dial, length) or False
        request.env['res.users'].sudo().browse(int(params['user_id'])).kpi_wa_number = num
        return {'status': True, 'wa_number': num or ''}

    # ---- Global config: Away-after-minutes + Urgent recipients (Configuration screen) ---- #
    @http.route('/kpi_config/get', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_config_get(self, **params):
        c = request.env.company
        dial, length = c._kpi_mobile_cfg()
        # Countries that have a dial code, for the picker (id, name, +code).
        countries = request.env['res.country'].sudo().search(
            [('phone_code', '!=', 0)], order='name')
        return {'status': True,
                'away_after_minutes': c.away_after_minutes,
                'urgent_recipients': c.kpi_urgent_recipients or '',
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

    @http.route('/kpi_config/set_urgent', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_config_set_urgent(self, **params):
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Not authorized'}
        # Normalize each comma-separated entry to <dial><local> digits.
        dial, length = request.env.company._kpi_mobile_cfg()
        raw = (params.get('recipients') or '').strip()
        parts = [normalize_wa(p, dial, length) for p in re.split(r'[,\n;]+', raw) if p.strip()]
        cleaned = ', '.join([p for p in parts if p])
        request.env.company.sudo().kpi_urgent_recipients = cleaned or False
        return {'status': True, 'recipients': cleaned}

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
    
    @http.route('/kpi_action/details', type='json', auth='user')
    def get_kpi_action_details(self, id):
        kpi = request.env['kra.kpi'].sudo().browse(int(id))

        if not kpi.exists():
            return {"error": "KPI not found"}

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
                
                link_count = 0
                for prog in progress_with_links:
                    try:
                        links = json.loads(prog.related_links or '[]')
                        link_count += len(links)
                    except:
                        pass
                
                # Also count task-level related links
                try:
                    task_links = json.loads(kpi.related_links or '[]')
                    link_count += len(task_links)
                except:
                    pass
                
                doc_count = len(progress_files)
                github_count = len(github_links)
                manual_count = len(user_manuals)
                
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
                    'has_attachments': (doc_count + link_count + github_count + manual_count) > 0,
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
            
            # Get related links
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
            
            return {
                'status': True,
                'documents': {
                    'files': files,
                    'links': links,
                    'github': github,
                    'manuals': manuals,
                }
            }
        except Exception as e:
            _logger.error(f"Error in get_task_documents_details: {str(e)}")
            return {
                'status': False,
                'message': str(e),
                'documents': {
                    'files': [],
                    'links': [],
                    'github': [],
                    'manuals': [],
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
