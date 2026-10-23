from odoo import http, api, fields
from odoo.exceptions import UserError, ValidationError
from odoo.http import request
from odoo.addons.kra_kpi_module.models.kpi_workflow import (
    NAME_PREFIX_FOR_DOC_TYPE,
    REF_PREFIX_FOR_DOC_TYPE,
)
# Module / App / EXE. One cleaner for every create path, so each refuses a bad
# value with the same words.
from odoo.addons.kra_kpi_module.models.kpi import clean_deliverable, deliverable_type_label
# One line on a Workday Map chip, not a paragraph. Imported rather than redefined
# so the pause note, the non-task note and the idle note all share one number —
# the same way kpi_reports_api.py imports it.
from odoo.addons.kra_kpi_module.models.kpi_nontask_block import NOTE_MAX
# Imported rather than reimplemented so the READ path caps an unclosed segment at
# exactly the instant the self-heal would have written into it
# (kpi_work_session._get_or_open_today). Two spellings of "end of that day" would
# drift apart, and this one already handles the IST offset correctly.
from odoo.addons.kra_kpi_module.models.kpi_work_session import _local_day_end_utc
import json
import logging
import base64
import hmac
import mimetypes
import os
import pytz
import re

_logger = logging.getLogger(__name__)


def _guess_mime(file_name, stored=''):
    """The file's real type, so a browser can show it."""
    if stored and stored != 'application/octet-stream':
        return stored
    mime, _enc = mimetypes.guess_type(file_name or '')
    if mime:
        return mime
    low = (file_name or '').lower()
    for ext, m in (('.webm', 'video/webm'), ('.m4a', 'audio/mp4'), ('.ogg', 'audio/ogg'),
                   ('.opus', 'audio/ogg'), ('.heic', 'image/heic'), ('.mov', 'video/quicktime')):
        if low.endswith(ext):
            return m
    return 'application/octet-stream'


def serve_file(content, file_name, mime=None, inline=False):
    """A file response that can be viewed in the browser (inline) or saved.

    Honours HTTP Range so a video or voice note can be scrubbed / seeked
    without downloading the whole thing first: phones (Safari especially)
    refuse to play a <video> whose server ignores Range.
    """
    name = (file_name or 'file').replace('"', "'").replace('\r', ' ').replace('\n', ' ')
    mime = mime or _guess_mime(name)
    disp = '%s; filename="%s"' % ('inline' if inline else 'attachment', name)
    size = len(content)
    headers = [('Content-Type', mime if inline else (mime or 'application/octet-stream')),
               ('Content-Disposition', disp), ('Accept-Ranges', 'bytes'),
               ('Cache-Control', 'private, max-age=300')]
    rng = request.httprequest.headers.get('Range', '')
    m = re.match(r'bytes=(\d*)-(\d*)$', rng.strip()) if rng else None
    if m and size and (m.group(1) or m.group(2)):
        if m.group(1):
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else size - 1
        else:                                   # "bytes=-500": the last 500 bytes
            start = max(0, size - int(m.group(2)))
            end = size - 1
        end = min(end, size - 1)
        if start > end or start >= size:
            return request.make_response(b'', headers + [('Content-Range', 'bytes */%d' % size)], status=416)
        part = content[start:end + 1]
        return request.make_response(part, headers + [
            ('Content-Range', 'bytes %d-%d/%d' % (start, end, size)),
            ('Content-Length', str(len(part)))], status=206)
    return request.make_response(content, headers + [('Content-Length', str(size))])


def _log_day_end_utc(log):
    """The instant an unclosed kpi.time.log stops being allowed to accrue.

    A running segment is normally read as `now - start_time`, which is right while
    it really is running. It stops being right the moment the segment is an
    ORPHAN — never closed, because stale rows are only healed when that developer
    next opens a workday, and one who stops logging in never triggers that. Read
    live, such a row reports days of work nobody did.

    Capping at the end of the log's own local day matches what the self-heal
    writes when it eventually runs, so the number does not jump when it does.
    """
    day = log.work_date or (log.start_time.date() if log.start_time else None)
    if not day:
        return log.start_time
    return _local_day_end_utc(day, log.user_id)


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


def _github_key(url):
    """A GitHub URL reduced to what identifies the repo, so the same link typed
    two ways compares equal: no scheme, no www., no trailing / or .git, lower case.
    Mirrored in kpi_action.js (_githubKey) for the warning while pasting."""
    u = (url or '').strip().lower()
    u = re.sub(r'^https?://', '', u)
    u = re.sub(r'^www\.', '', u)
    u = u.rstrip('/')
    if u.endswith('.git'):
        u = u[:-4]
    return u.rstrip('/')


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
        """People a task can actually be ASSIGNED to — developers and admins.

        This was `search([])`: every res.users row in the database. That put
        clients in the Reassign picker (they don't do the work — they request it
        and approve it), along with portal accounts and OdooBot. Assigning a task
        to a client would leave it with an assignee who cannot open the board.

        Filtered by kpi_role, the module's own role vocabulary
        (res.users._compute_kpi_role), so this agrees with what Login Management
        shows and with the role the developer/client gates test elsewhere.
        `share` excludes portal accounts and uid 1 is OdooBot — neither is a person
        who works tasks.
        """
        users = request.env['res.users'].sudo().search([
            ('active', '=', True),
            ('share', '=', False),
            ('id', '!=', 1),
        ])
        assignable = users.filtered(lambda u: u.kpi_role != 'client')
        return [{"id": u.id, "name": u.name} for u in assignable.sorted('name')]

    @http.route('/kra_kpi/get_people', type='json', auth='user')
    def get_people(self):
        """EVERYONE a meeting can be with — developers, admins AND clients.

        Deliberately not /kra_kpi/get_users: that one answers "who can a task be
        ASSIGNED to", which excludes clients because a client cannot work a task.
        You can absolutely be in a meeting with one, so this is a different
        question and gets its own route rather than a flag that would make the
        assignment picker one careless argument away from offering clients.

        kpi_role is a non-stored compute, so it is resolved in Python — the same
        reason get_users filters after searching rather than in the domain.
        """
        users = request.env['res.users'].sudo().search([
            ('active', '=', True),
            ('share', '=', False),
            ('id', '!=', 1),                       # OdooBot is not in meetings
        ])
        me = request.env.user.id
        # The pickers know admin | developer | client; a coordinator is staff
        # with admin rights, so it is listed as admin.
        return [{'id': u.id, 'name': u.name,
                 'role': 'admin' if u.kpi_role == 'coordinator' else (u.kpi_role or 'developer')}
                for u in users.sorted('name') if u.id != me]
    
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
        refused = self._task_actor_or_refuse(rec)
        if refused:
            return refused

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
    def get_kra_list(self, **params):
        # with_tasks=False skips every task under every KRA. The New Task popup only
        # needs project names for a dropdown, and on a 500-task board shipping
        # every task (plus a manual count per task) just to fill it was slow.
        # Default stays True so every existing caller is unchanged.
        with_tasks = params.get('with_tasks', True) is not False
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
                        "manual_count": len(kpi.user_manual_ids.filtered(lambda m: not m.is_intake_media)),
                    } for kpi in kra.kpi_ids] if with_tasks else [],
                })
            return output

        parent_kras = kra_records.filtered(lambda r: not r.parent_id)

        return {
            "status": True,
            "tree": build_tree(parent_kras),
        }

    @http.route('/kra_kpi/create_kra', type='json', auth='user', methods=['POST'], csrf=False)
    def create_kra(self, **params):
        # The KRA tree is admin-managed; this route checked nothing, so any
        # signed-in user could add KRAs by calling it by hand.
        if not self._is_kra_admin(request.env.user):
            return {"status": False, "message": "Admin only."}
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

        # Through create_kra, not create(). This route called create() directly and
        # so accepted duplicates in silence, while the model method and the rename
        # route both refuse them — the same tree could end up with two identically
        # named siblings depending only on which door the request came through.
        #
        # create_kra raises ValidationError; this route's callers expect
        # {status: False, message}, so the refusal is translated rather than
        # escaping as a 500.
        try:
            # Returns the id, not the record.
            kra_id = request.env["kra.master"].create_kra(kra_vals)
        except ValidationError as e:
            return {"status": False, "message": str(e.args[0] if e.args else e)}

        return {
            "status": True,
            "message": "KRA Created",
            "id": kra_id,
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
        dv, err = clean_deliverable(params.get("deliverable_type"), params.get("deliverable_other"))
        if err:
            return {"status": False, "message": err}
        if dv["deliverable_type"]:
            kpi_vals.update(dv)

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
        refused = self._task_actor_or_refuse(rec)
        if refused:
            return refused
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

    @http.route('/kra_kpi/task/undo_start_info', type='json', auth='user', methods=['POST'], csrf=False)
    def task_undo_start_info(self, kpi_id=None, **params):
        """For the Undo-start confirmation: what is KEPT (today's updates,
        links, files...). Read-only."""
        rec = request.env['kra.kpi'].sudo().browse(int(kpi_id or 0)).exists()
        if not rec:
            return {'status': False, 'keeps': ''}
        return {'status': True, 'keeps': rec._undo_keeps_line()}

    @http.route('/kra_kpi/task/undo_start', type='json', auth='user', methods=['POST'], csrf=False)
    def task_undo_start(self, **params):
        """Take back a Start made by mistake: the task goes back to how it was
        before today's first Start / Resume and today's time on it is removed.
        The assignee may undo their own start; an admin may undo any. Every rule lives in kra.kpi.undo_today_start; this carries
        the answer. with_user so env.user is the CALLER (the rules are about
        who is asking) while the writes inside still go through sudo().
        """
        kpi_id = params.get('kpi_id')
        if not kpi_id:
            return {'status': False, 'message': 'kpi_id missing'}
        rec = request.env['kra.kpi'].sudo().browse(int(kpi_id))
        if not rec.exists():
            return {'status': False, 'message': 'Task not found'}
        try:
            return rec.with_user(request.env.user).undo_today_start()
        except (ValidationError, UserError) as exc:
            return {'status': False,
                    'message': exc.args[0] if exc.args else 'Cannot undo this start.'}

    def _clean_meeting_ids(self, reason_code, raw):
        """Validate meeting participants for a pause. Shared by /task/pause and
        /task/pause_all so the two cannot disagree about what is acceptable.

        Returns a list of user ids, None when the code is not 'meeting' (or no
        one was picked), or False when the payload is malformed — a bare list is
        falsy when empty, so callers must test `is False`, not truthiness.
        """
        if reason_code != 'meeting':
            return None
        try:
            wanted = [int(i) for i in (raw or [])]
        except (TypeError, ValueError):
            return False
        if not wanted:
            return None
        # Real, active, internal users only — a hand-rolled payload must not be
        # able to attach arbitrary ids to a break row.
        return request.env['res.users'].sudo().search([
            ('id', 'in', wanted), ('active', '=', True), ('id', '!=', 1),
        ]).ids

    @http.route('/kra_kpi/task/pause_all', type='json', auth='user', methods=['POST'], csrf=False)
    def task_pause_all(self, **params):
        """Pause every task the caller has running, with one shared reason.

        Scoped to the CALLER's own running tasks by the model method — there is no
        task id in the payload, so this cannot be aimed at anyone else's timers.
        """
        reason_code = params.get('reason_code') or 'break'
        meeting_with_ids = self._clean_meeting_ids(reason_code, params.get('meeting_with_ids'))
        if meeting_with_ids is False:
            return {'status': False, 'message': 'Invalid meeting participants.'}
        return request.env['kra.kpi'].sudo().with_user(request.env.user).pause_all_running(
            reason=(params.get('reason') or '').strip()[:NOTE_MAX],
            reason_code=reason_code,
            meeting_with_ids=meeting_with_ids)

    @http.route('/kra_kpi/task/revert_signoff', type='json', auth='user', methods=['POST'], csrf=False)
    def task_revert_signoff(self, **params):
        """Admin pulls a task back out of Awaiting Client Sign-off.

        Admin-only: this takes work off a client's desk and withdraws a QA
        verdict. The rule itself lives in kra.kpi.revert_from_client_signoff.
        """
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Only a coordinator/owner can revert a task.'}
        if not params.get('kpi_id'):
            return {'status': False, 'message': 'kpi_id missing'}
        rec = request.env['kra.kpi'].sudo().browse(int(params['kpi_id']))
        if not rec.exists():
            return {'status': False, 'message': 'Task not found'}
        try:
            return rec.revert_from_client_signoff(reason=(params.get('reason') or '').strip())
        except (ValidationError, UserError) as exc:
            return {'status': False,
                    'message': exc.args[0] if exc.args else 'Cannot revert this task.'}

    @http.route('/kra_kpi/task/switch', type='json', auth='user', methods=['POST'], csrf=False)
    def task_switch(self, **params):
        """Move to the next task in one action: stop what's running, start this.

        Deliberately ONE endpoint rather than the board calling pause then start.
        Two calls can half-apply — the pause commits, the start is refused by a
        gate, and the developer is left stopped with nothing running. Here the
        target is validated first and the whole thing is one transaction.

        The rule lives in kra.kpi.switch_to_task; this just carries the result.
        """
        kpi_id = params.get('kpi_id')
        if not kpi_id:
            return {'status': False, 'message': 'kpi_id missing'}
        rec = request.env['kra.kpi'].browse(int(kpi_id))
        if not rec.exists():
            return {'status': False, 'message': 'Task not found'}
        try:
            # from_kpi_id = the task being handed over. Sent by the per-card
            # Switch button so that, under multitask, the OTHER running task
            # carries on untouched. Absent → every running task pauses.
            return rec.switch_to_task(
                from_kpi_id=params.get('from_kpi_id') or None,
                note=(params.get('note') or '').strip())
        except (ValidationError, UserError) as exc:
            # A gate raised on start/resume — report it, don't 500 the board.
            return {'status': False,
                    'message': exc.args[0] if exc.args else 'Cannot switch to this task.'}

    @http.route('/kra_kpi/task/pause', type='json', auth='user', methods=['POST'], csrf=False)
    def task_pause(self, **params):
        kpi_id = params.get('kpi_id')
        # Clamped here, not just in the two UIs. Both clients cap the box at 60,
        # but a cap in a client is a courtesy — this text is rendered on the task
        # card and inside a Workday Map chip, and a pasted paragraph reaching the
        # column would break both. The sibling pause_all route already stripped;
        # this one did not even do that.
        reason = (params.get('reason') or '').strip()[:NOTE_MAX]
        reason_code = params.get('reason_code') or False
        if not kpi_id:
            return {'status': False, 'message': 'kpi_id missing'}
        # An unknown code would raise on write to the Selection field, surfacing
        # as an opaque 500 rather than a refusal.
        if reason_code and reason_code not in dict(
                request.env['kra.kpi']._fields['pause_reason_code'].selection):
            return {'status': False, 'message': 'Unknown pause reason.'}

        meeting_with_ids = self._clean_meeting_ids(reason_code, params.get('meeting_with_ids'))
        if meeting_with_ids is False:
            return {'status': False, 'message': 'Invalid meeting participants.'}

        rec = request.env['kra.kpi'].sudo().browse(int(kpi_id))
        if not rec.exists():
            return {'status': False, 'message': 'Task not found'}
        refused = self._task_actor_or_refuse(rec)
        if refused:
            return refused
        rec.pause_task(reason, reason_code=reason_code, meeting_with_ids=meeting_with_ids)
        return {'status': True, 'message': 'Task paused', 'id': rec.id}

    @http.route('/kra_kpi/break/switch', type='json', auth='user', methods=['POST'], csrf=False)
    def break_switch(self, **params):
        """Change the reason on an OPEN break without resuming the task.

        Paused for a break, then a meeting is called: the only way through used to be
        resume-then-pause-again, which puts a fake sliver of work time on the task and
        makes you re-answer a question you already answered. This is the same
        one-click switch the no-task strip already has (/kpi_workday/idle_reason),
        for the case where the break came from pausing a task.

        The paused task's own reason is rewritten too, so the card badge and the
        Workday Map agree about what is happening right now.
        """
        reason = (params.get('reason') or '').strip()[:NOTE_MAX]
        reason_code = params.get('reason_code') or ''
        if not reason_code:
            return {'status': False, 'message': 'reason_code missing'}
        if reason_code not in dict(
                request.env['kra.kpi']._fields['pause_reason_code'].selection):
            return {'status': False, 'message': 'Unknown pause reason.'}

        meeting_with_ids = self._clean_meeting_ids(reason_code, params.get('meeting_with_ids'))
        if meeting_with_ids is False:
            return {'status': False, 'message': 'Invalid meeting participants.'}

        user = request.env.user
        # Also keeps the paused task's reason in step (shared with WhatsApp).
        res = request.env['kpi.break.log'].sudo().switch_open_break(
            reason_code, user_id=user.id, reason_note=reason,
            meeting_with_ids=meeting_with_ids)
        if res is False:
            return {'status': False, 'message': 'No break is running.'}
        return {'status': True, 'switched_from': res.get('switched_from') or '',
                'break_id': res.get('break_id')}

    # Deliberately a BLOCK-list of the two finished states rather than an allow-list of
    # the live ones. An allow-list has to be kept in step with the state vocabulary, and
    # the first version of this already missed pre_approval_pending — refusing to extend
    # a task that had not even started, with a message saying it was finished. Anything
    # still in flight is extendable; only work the client has taken delivery of is not.
    ESTIMATE_LOCKED_STATES = ('awaiting_client', 'completed')

    @http.route('/kra_kpi/task/add_time', type='json', auth='user', methods=['POST'], csrf=False)
    def task_add_time(self, **params):
        """Extend a task's estimate, with a required reason.

        The estimate was write-once at creation, so a task that overran read as
        permanently over and nobody could correct it without going into the Odoo
        backend. This ADDS to the estimate rather than replacing it, and records why.

        The reason is stored on the task, not only in the audit log — the whole point
        is that it shows on the card, where the overrun is visible.
        """
        try:
            kpi_id = int(params.get('kpi_id') or 0)
            add_h = int(params.get('hours') or 0)
            add_m = int(params.get('minutes') or 0)
            reason = (params.get('reason') or '').strip()

            rec = request.env['kra.kpi'].sudo().browse(kpi_id)
            if not kpi_id or not rec.exists():
                return {'status': False, 'message': 'Task not found.'}

            user = request.env.user
            is_admin = (user.has_group('kra_kpi_module.group_kra_owner')
                        or user.has_group('kra_kpi_module.group_kra_admin')
                        or user.has_group('kra_kpi_module.group_kra_manager')
                        or user.has_group('base.group_system'))
            # The person doing the work can extend their own estimate; everyone else
            # needs a management role. Checked here, not only by hiding the button.
            is_owner = (rec.user_id.id == user.id) or (user.id in rec.contributor_ids.ids)
            if not (is_admin or is_owner):
                return {'status': False,
                        'message': "You can only add time to your own tasks."}

            if rec.task_state in self.ESTIMATE_LOCKED_STATES:
                return {'status': False,
                        'message': "This task is with the client — its estimate is what "
                                   "they signed off against and can't be changed now."}
            if add_h < 0 or add_m < 0 or (add_h == 0 and add_m == 0):
                return {'status': False, 'message': 'Add more than 0 minutes.'}
            if not reason:
                return {'status': False,
                        'message': 'Give a reason — it is shown on the task card.'}

            before = f"{rec.estimate_hours:02d}:{rec.estimate_minutes:02d}"
            total_m = (rec.estimate_hours * 60 + rec.estimate_minutes) + (add_h * 60 + add_m)
            rec.write({
                'estimate_hours': total_m // 60,
                'estimate_minutes': total_m % 60,
                'estimate_extend_reason': reason[:255],
                'estimate_extension_count': (rec.estimate_extension_count or 0) + 1,
                'estimate_extended_by_id': user.id,
                'estimate_extended_at': fields.Datetime.now(),
            })
            after = f"{rec.estimate_hours:02d}:{rec.estimate_minutes:02d}"

            # The log keeps the history the card cannot: every earlier reason, and the
            # original estimate, stay recoverable after a second extension overwrites
            # the field above.
            request.env['kpi.action.log'].sudo().create({
                'kpi_id': rec.id,
                'event': 'estimate_extended',
                'source': 'web',
                'actor_user_id': user.id,
                'actor_label': user.name or user.login or '',
                'payload_json': json.dumps({
                    'from': before, 'to': after,
                    'added_hours': add_h, 'added_minutes': add_m,
                    'reason': reason,
                }),
            })
            _logger.info("kpi %s estimate %s → %s by %s: %s",
                         rec.id, before, after, user.login, reason)
            return {'status': True, 'id': rec.id,
                    'estimate_display': after,
                    'estimate_hours': rec.estimate_hours,
                    'estimate_minutes': rec.estimate_minutes,
                    'estimate_extend_reason': rec.estimate_extend_reason or '',
                    'estimate_extension_count': rec.estimate_extension_count or 0,
                    'message': f'Estimate extended from {before} to {after}.'}
        except Exception as e:
            _logger.error("task_add_time: %s", e)
            return {'status': False, 'message': str(e)}

    @http.route('/kra_kpi/task/prev_day_time', type='json', auth='user', methods=['POST'], csrf=False)
    def task_prev_day_time(self, **params):
        """Yesterday's recorded time on a task, for the Reduce dialog. Admin only."""
        try:
            if not self._is_kra_admin(request.env.user):
                return {'status': False, 'message': 'Admin only.'}
            rec = request.env['kra.kpi'].sudo().browse(int(params.get('kpi_id') or 0))
            if not rec.exists():
                return {'status': False, 'message': 'Task not found.'}
            return rec.with_user(request.env.user).sudo().prev_day_time_info()
        except Exception as e:
            _logger.error("task_prev_day_time: %s", e)
            return {'status': False, 'message': str(e)}

    @http.route('/kra_kpi/task/reduce_prev_day', type='json', auth='user', methods=['POST'], csrf=False)
    def task_reduce_prev_day(self, **params):
        """Take forgotten time off YESTERDAY only, decrease only, with a reason.
        Every rule lives in kra.kpi.action_reduce_prev_day; this only resolves the
        task and passes the admin through as the acting user."""
        try:
            rec = request.env['kra.kpi'].sudo().browse(int(params.get('kpi_id') or 0))
            if not rec.exists():
                return {'status': False, 'message': 'Task not found.'}
            minutes = int(params.get('hours') or 0) * 60 + int(params.get('minutes') or 0)
            return rec.with_user(request.env.user).sudo().action_reduce_prev_day(
                minutes, params.get('reason_code') or '', params.get('reason_text') or '')
        except UserError as e:
            return {'status': False, 'message': str(e.args[0] if e.args else e)}
        except Exception as e:
            _logger.error("task_reduce_prev_day: %s", e)
            return {'status': False, 'message': str(e)}

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
        # Before the write below clears self_needs_resume_reason: Undo must be
        # able to put the send-back flag back. resume_task keeps this snapshot.
        rec._snapshot_before_start()
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
        refused = self._task_actor_or_refuse(rec)
        if refused:
            return refused

        # 🆕 Part B guard — a task can only be completed after a Progress Summary
        # has been recorded. Keeps both "Complete" and "Partial Finish" honest and
        # always leaves the reviewer something to read.
        # The client's own attachments don't count: the summary is the team's.
        Progress = request.env['kpi.progress'].sudo()
        has_summary = Progress.search_count(
            [('kpi_id', '=', rec.id), ('from_client', '=', False)]) > 0
        if not has_summary:
            # Say plainly why, when the only "update" is the client's attachment.
            if Progress.search_count([('kpi_id', '=', rec.id), ('from_client', '=', True)]):
                return {'status': False,
                        'message': "The client's files don't count as your summary — add your own "
                                   "progress update (what you did), then complete."}
            return {'status': False,
                    'message': 'Please submit a Progress Summary before completing this task.'}

        # A full "Complete" needs AT LEAST ONE checklist item confirmed.
        #
        # It used to demand all five. Not every task has anything to deploy or
        # document separately, so people either ticked boxes that weren't true
        # or escaped through Partial Finish — and the stored flags are exactly
        # what the manager reviews, so a checklist you must lie to is worse than
        # none. Each box is still saved separately, so "deployed but not
        # documented" stays visible to the approver.
        #
        # Kept as a server check and not left to the button: the board is not the
        # only caller, and 'no boxes at all' is what Partial Finish is for.
        if not is_partial:
            required = ('verify_github', 'deployed_task', 'user_manual', 'documentation', 'tested_code')
            if not any(employee_checklist.get(k) for k in required):
                return {'status': False,
                        'message': 'Confirm at least one checklist item before completing '
                                   '(or use "Partial Finish" to send a summary only).'}
            # The manual box above stays a statement, but a full Complete now also
            # needs a real manual on the task (one already uploaded counts).
            # Partial Finish is the way through for work without one.
            refused = rec._manual_required_refusal()
            if refused:
                return {'status': False, 'message': refused, 'manual_required': True}
            refused = rec._github_required_refusal()
            if refused:
                return {'status': False, 'message': refused, 'github_required': True}

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

    # /kpi_action/leave and /kpi_action/leave_beacon are gone. They stamped
    # 'leaving' so the device would be un-paired and the running task paused a
    # few seconds after the board tab closed. Closing a tab is not evidence that
    # someone stopped working, and with auto-pause off there is nothing for them
    # to trigger. The mobile app never called either one.

    @http.route('/kpi_action/live_status', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_action_live_status(self, **params):
        """Live activity strip data: running task, active break, day anchors."""
        return request.env['kpi.work.session'].sudo().live_status(user=request.env.user)

    # How many settled tasks the Paid lane will carry. An archive lane only ever
    # grows, and the board re-fetches it on every refresh.
    PAID_LANE_LIMIT = 200

    @http.route('/kra_kpi/tasks/paid', type='json', auth='user', methods=['POST'], csrf=False)
    def get_paid_tasks(self, **params):
        """Settled work, for the admin-only Paid lane on the KPI Action board.

        Marking an invoice paid archives its tasks, so they leave every board and
        search — correct for the developer, but it left the admin with no record of
        what had been billed and closed. This is that record: read-only, name plus
        who did it, what it took and what was estimated.

        Keyed on the invoice being paid rather than on `active = False`. Those two
        coincide today, but archiving is a general flag and anything archived for
        another reason later would otherwise appear here as though it had been paid.
        """
        user = request.env.user
        if not (user.has_group('kra_kpi_module.group_kra_owner')
                or user.has_group('kra_kpi_module.group_kra_admin')
                or user.has_group('kra_kpi_module.group_kra_manager')
                or user.has_group('base.group_system')):
            return {'status': False, 'message': 'Not authorized.', 'tasks': []}
        try:
            lines = request.env['kpi.client.invoice.line'].sudo().search([
                ('kpi_id', '!=', False),
                ('invoice_id.payment_status', '=', 'paid'),
            ])
            # Newest payment first, and one entry per task — a task billed on a
            # revised-and-reissued invoice can appear on more than one line.
            seen, ordered = set(), []
            for line in lines.sorted(
                    key=lambda l: (l.invoice_id.payment_date or l.invoice_id.write_date),
                    reverse=True):
                if line.kpi_id.id in seen:
                    continue
                seen.add(line.kpi_id.id)
                ordered.append(line)
            truncated = len(ordered) > self.PAID_LANE_LIMIT
            ordered = ordered[:self.PAID_LANE_LIMIT]

            tasks = []
            for line in ordered:
                # Archived by action_mark_paid — a plain browse would read blanks.
                k = line.kpi_id.with_context(active_test=False)
                inv = line.invoice_id
                client_kra = k.client_kra_id or k.kra_id
                # What this task actually settled for, the same way the invoice detail
                # works it out: a per-task invoice prices each line, an hourly one
                # multiplies its hours by the rate. Rate 0 is a time-only invoice, so
                # there is no amount to show rather than a misleading 0.00.
                if inv.billing_method == 'per_task':
                    amount = round(line.unit_price or 0.0, 2)
                elif inv.hourly_rate:
                    hours = line.actual_hours or line.quoted_hours or 0.0
                    amount = round(hours * inv.hourly_rate, 2)
                else:
                    amount = 0.0
                cur = inv.currency_id
                tasks.append({
                    'amount': amount,
                    'currency': (cur.symbol or cur.name or '') if cur else '',
                    # When the client said they paid. action_mark_paid clears the claim
                    # FLAG but not this date, so it survives confirmation.
                    'client_paid_on': (convert_to_user_tz(inv.client_paid_claim_date)
                                       if inv.client_paid_claim_date else ''),
                    'id': k.id,
                    'name': k.name or '',
                    'external_ref': k.external_ref or '',
                    'user_name': k.user_id.name if k.user_id else '',
                    'client_name': client_kra.name if client_kra else '',
                    # Same field names the board's own serializer uses, so the card
                    # markup and formatTime work without a second time format.
                    'timer_total_seconds': k.timer_total_seconds or 0,
                    'estimate_display': f"{k.estimate_hours:02d}:{k.estimate_minutes:02d}",
                    'estimate_hours': k.estimate_hours or 0,
                    'estimate_minutes': k.estimate_minutes or 0,
                    'invoice_name': inv.name or '',
                    'paid_on': convert_to_user_tz(inv.payment_date) if inv.payment_date else '',
                })
            return {'status': True, 'tasks': tasks, 'truncated': truncated,
                    'limit': self.PAID_LANE_LIMIT}
        except Exception as e:
            _logger.error("get_paid_tasks: %s", e)
            return {'status': False, 'message': str(e), 'tasks': []}

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

        # Once the client has signed a task off it is finished business — it is not
        # something the developer can act on, and left in place it grows a Completed
        # lane that never stops growing. Drop it from the BOARD for developers; admins
        # keep seeing everything, because they still have to invoice it.
        #
        # Board only, deliberately. The task stays in the developer's Work Report, My
        # Workday and hours totals — they must be able to see and prove what they
        # finished. That is also why this is a query filter here rather than `published`
        # or a record rule: either of those would hide the task from their own reports
        # too, which is a different and much worse change.
        if not is_manager_or_admin:
            domain += ['!', '&', ('task_state', '=', 'completed'),
                       ('client_final_approved', '=', True)]

        kpis = request.env['kra.kpi'].search(domain)

        # Resolve "is this developer's workday open?" ONCE for the whole board and
        # carry it in the context. _start_block asks it per task (it is the first
        # thing that decides can_start), and without this that is one session
        # query per row. The rule itself stays in kra.kpi._actor_workday_open.
        _sess = request.env['kpi.work.session'].sudo().search([
            ('user_id', '=', current_user.id),
            ('session_date', '=', fields.Date.context_today(request.env.user)),
            ('state', '=', 'open'),
        ], limit=1)
        # Paused counts as not-open for starting work; the separate flag only
        # picks which message the card shows ("Start" vs "Resume" your day).
        _wd_paused = bool(_sess and _sess.is_paused)
        # An admin with NO workday may still work; an admin who paused one may
        # not. This mirrors the same split in kra.kpi._actor_workday_open, and
        # the two have to agree — this context value short-circuits that
        # method, so a disagreement means the board and the server render
        # different answers for the same button.
        #
        # The lookup now runs for admins too. It is one indexed search with
        # limit=1 per board load, which is what it already cost everybody else.
        _wd_open = (not _wd_paused) if is_manager_or_admin \
            else (bool(_sess) and not _wd_paused)
        # Same trick for the single-task limit: resolve the caller's running
        # tasks once instead of one search per row in _multitask_blocker. Only
        # meaningful for the caller's own rows, which is what that helper checks
        # before trusting this.
        _running_ids = request.env['kra.kpi'].sudo().search([
            ('user_id', '=', current_user.id),
            ('task_state', '=', 'in_progress'),
            ('active', '=', True),
        ]).ids
        # Running tasks for EVERY assignee in one query (see _multitask_blocker):
        # an admin's board is mostly other people's rows, which the caller-only
        # set above cannot answer, so each row used to run its own search.
        _running_by_user = {}
        for _r in request.env['kra.kpi'].sudo().search_read(
                [('task_state', '=', 'in_progress'), ('active', '=', True),
                 ('user_id', '!=', False)], ['user_id']):
            _running_by_user.setdefault(_r['user_id'][0], []).append(_r['id'])
        kpis = kpis.with_context(kpi_workday_open=_wd_open,
                                 kpi_workday_paused=_wd_paused,
                                 kpi_running_task_ids=_running_ids,
                                 kpi_running_by_user=_running_by_user)

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
                # Bounded at the end of the segment's OWN day. A log that was never
                # closed keeps accruing `now - start_time` for as long as it stays
                # open, so one orphan adds days of imaginary work to a developer's
                # total on that task — and orphans do exist: they are only healed
                # when that user next opens a workday (_get_or_open_today), so
                # somebody who stops logging in leaves one open indefinitely.
                # The same cap the self-heal writes, applied on read.
                d['seconds'] += max(0.0, (min(now, _log_day_end_utc(a)) - a.start_time)
                                    .total_seconds())

        # Seconds each listed task got TODAY, for the caller. Drives the board's
        # "Today" lane: start task 1, pause, task 2, pause, task 3 — then going
        # back to task 1 meant finding it among a hundred-odd paused tasks, where
        # one paused ten minutes ago looks exactly like one paused three weeks
        # ago. Nothing in this payload could tell them apart: timer_start_datetime
        # is cleared on pause, and timer_total_seconds is a lifetime figure.
        #
        # work_date, not create_date or a UTC day: kpi.time.log computes it in the
        # DEVELOPER's timezone precisely so 01:00 IST files under today rather
        # than yesterday (see kpi_time_log._compute_work_date). That also makes
        # the midnight reset free — the date simply stops matching and the lane
        # empties itself, with no cron and nothing to clean up.
        #
        # Scoped to the caller because "did I work on this today" is a personal
        # question: an admin looking at the board should not see a lane filled by
        # somebody else's day.
        today_map = {}   # kpi_id -> seconds logged today by this user
        if kpis.ids:
            TimeLog = request.env['kpi.time.log'].sudo()
            today = fields.Date.context_today(request.env.user)
            for g in TimeLog.read_group(
                    [('kpi_id', 'in', kpis.ids),
                     ('user_id', '=', request.env.user.id),
                     ('work_date', '=', today),
                     # Back-filled work was not done today, whatever its date.
                     ('is_manual', '=', False)],
                    ['duration_seconds:sum'], ['kpi_id'], lazy=False):
                kid = g['kpi_id'][0] if g.get('kpi_id') else False
                if kid:
                    today_map[kid] = g.get('duration_seconds') or 0.0
            # The running segment has duration_seconds 0 until it is closed, so a
            # task started today and still going would otherwise report 0 and be
            # missing from its own lane.
            #
            # work_date HERE TOO, and it is not optional: without it every log
            # that was never closed counted as today's work forever. A timer left
            # running yesterday lunchtime put its task in Today the next morning
            # reading "18h 4m" — now minus a start_time from the previous day —
            # so the lane that is supposed to empty itself at midnight instead
            # kept the one task nobody had touched. The date filter is the whole
            # midnight mechanism; the open segment must obey it like every closed
            # one, and work_date is stored on this row already.
            now = fields.Datetime.now()
            for a in TimeLog.search([('kpi_id', 'in', kpis.ids),
                                     ('user_id', '=', request.env.user.id),
                                     ('work_date', '=', today),
                                     ('is_active', '=', True)]):
                if not (a.kpi_id and a.start_time):
                    continue
                today_map[a.kpi_id.id] = (today_map.get(a.kpi_id.id) or 0.0) \
                    + max(0.0, (now - a.start_time).total_seconds())

        # When each listed task was last worked on, by ANYONE. This is the field
        # the lanes sort by, and without it every lane reads oldest-at-top:
        # kra.kpi declares no _order, so Odoo falls back to id ASC.
        #
        # Sorting by id DESC does NOT fix that, which is the trap here. id is
        # still CREATION order, and the complaint is precisely a task created
        # long ago and worked yesterday - it stays at the bottom either way.
        # Only activity answers it, and nothing already in this payload carries
        # activity: timer_start_datetime is cleared on pause, timer_total_seconds
        # is a lifetime figure, and today_seconds is 0 for anything older than
        # today, which is the reported case exactly.
        #
        # BOTH aggregates, and end_time is not optional. Worked A 09:00-17:00 and
        # B 10:00-10:30: max(start_time) alone ranks A as older, when A is in
        # fact the one touched last. An open segment has no end_time yet, so
        # start_time is the fallback there and a running task sorts to the top.
        #
        # Deliberately NOT scoped the way today_map above is. That block filters
        # to the caller and to today because "did I work on this today" is a
        # personal question. "When was this task last touched" is a property of
        # the task, so an admin's board orders by the whole team's activity.
        def _as_dt(val):
            # read_group's datetime aggregate comes back as a datetime on some
            # versions and a formatted string on others; normalise both.
            if not val:
                return None
            if isinstance(val, str):
                try:
                    return fields.Datetime.from_string(val)
                except (ValueError, TypeError):
                    return None
            return val

        last_activity_map = {}   # kpi_id -> ISO8601 'Z' of the last log touch
        if kpis.ids:
            for g in request.env['kpi.time.log'].sudo().read_group(
                    [('kpi_id', 'in', kpis.ids)],
                    ['start_time:max', 'end_time:max'], ['kpi_id'], lazy=False):
                kid = g['kpi_id'][0] if g.get('kpi_id') else False
                if not kid:
                    continue
                # max() on datetimes, not on the formatted strings: isoformat()
                # drops microseconds when they are zero, so a lexicographic
                # compare would rank '...:00Z' below '...:00.5Z'.
                stamps = [d for d in (_as_dt(g.get('start_time')),
                                      _as_dt(g.get('end_time'))) if d]
                if stamps:
                    last_activity_map[kid] = max(stamps).isoformat() + 'Z'

        # Which listed tasks have ANY time log — one query for the whole board,
        # fed to _may_admin_delete so the delete rule doesn't cost a COUNT per
        # row. Only needed for admins; nobody else is offered the button.
        logged_ids = set()
        if is_manager_or_admin and kpis.ids:
            logged_ids = {
                r['kpi_id'][0]
                for r in request.env['kpi.time.log'].sudo().read_group(
                    [('kpi_id', 'in', kpis.ids)], ['kpi_id'], ['kpi_id'], lazy=False)
                if r.get('kpi_id')
            }

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

        # For the Undo-start flag: one "today" and one state-label map for every row.
        _undo_me = request.env.user
        _undo_today = fields.Date.context_today(_undo_me)
        _undo_admin = self._is_kra_admin(_undo_me)
        _state_labels = dict(request.env['kra.kpi']._fields['task_state'].selection)
        # Yesterday's time per task, for the admin's "Reduce yesterday" button --
        # one grouped query for the whole board, and only for an admin.
        prev_day_map = (request.env['kra.kpi'].prev_day_seconds_map(kpis.ids)
                        if _undo_admin and kpis.ids else {})

        def map_rec(k):
            # For in_progress tasks, include timer_start_datetime for real-time calculation
            timer_start_iso = None
            if k.task_state == 'in_progress' and k.timer_start_datetime:
                # Convert to ISO format string for JavaScript Date parsing
                timer_start_iso = k.timer_start_datetime.isoformat() + 'Z'  # Add Z for UTC
            
            # Who the work is FOR. client_kra_id is the stored nearest is_client
            # ancestor, so this is a plain m2o read — no extra query per row. Falls
            # back to the task's own KRA the same way the notification serializer
            # does (see _client_kra usage below), so a task outside a client tree
            # still names something rather than showing blank.
            client_kra = k.client_kra_id or k.kra_id
            return {
                'id': k.id,
                'name': k.name or "",
                # The board cards had no way to tell WHICH client a task belonged to —
                # with several clients in flight the lanes were just a wall of titles.
                # One field here feeds the web lane cards and the whole mobile board.
                'client_name': client_kra.name if client_kra else "",
                'project_name': k.kra_id.name if k.kra_id else "",
                # REQ-014 / BUG-001 / UPT-007 — how people actually refer to a
                # task out loud. The app renders it in five places (the Switch
                # picker and its sort order, the Revert dialog title, the admin
                # delete confirmation) and it was never in this payload, so all
                # five silently fell back to blank or to the long name. Cheap to
                # send, and a confirmation that cannot name what it is about to
                # delete is worse than no confirmation.
                'external_ref': k.external_ref or "",
                'priority': k.priority or "regular",
                # What the developer asked for when they raised it themselves.
                # Shown to the admin on Accept so they set the real priority
                # against it, instead of deciding blind.
                'requested_priority': k.requested_priority or '',
                'requested_doc_type': k.requested_doc_type or '',
                'deliverable_type': k.deliverable_type or '',
                'deliverable_other': k.deliverable_other or '',
                'deliverable_label': deliverable_type_label(k.deliverable_type, k.deliverable_other),
                'github_required': k._github_required(),
                'reverted_from': k.reverted_from or '',
                'revert_reason': k.revert_reason or '',
                **k._finish_payload(),
                'task_state': k.task_state or "assigned",
                'user_id': (k.user_id.id if k.user_id else False),
                'user_name': (k.user_id.name if k.user_id else ""),
                'estimate_display': f"{k.estimate_hours:02d}:{k.estimate_minutes:02d}",
                'estimate_hours': k.estimate_hours or 0,
                'estimate_minutes': k.estimate_minutes or 0,
                # Why the estimate grew, carried to the card so the overrun explains
                # itself instead of sending someone to the audit log.
                'estimate_extend_reason': k.estimate_extend_reason or '',
                'estimate_extension_count': k.estimate_extension_count or 0,
                # "Declined N×" badge, the parent REQ a bug / update sits under,
                # and New-DB / Destroy (call notes, 19.0.7.44).
                'decline_count': k.decline_count or 0,
                'parent_ref': k.related_req_ref or '',
                'legacy_req_link': bool(getattr(k, 'legacy_req_link', False)), 'legacy_status': getattr(k, 'legacy_status', '') or '',
                'parent_kpi_id': k.related_req_kpi_id.id or False,
                'request_category': k.request_category or 'standard',
                'estimate_extended_by_name': (k.estimate_extended_by_id.name
                                              if k.estimate_extended_by_id else ''),
                'timer_total_seconds': k.timer_total_seconds or 0,
                # Seconds THIS user logged against this task today, in their own
                # timezone. 0 means "not touched today" — which is the whole
                # question the board could not previously answer, because
                # timer_total_seconds is a lifetime figure and
                # timer_start_datetime is cleared the moment a task is paused.
                'today_seconds': round(today_map.get(k.id) or 0.0, 2),
                # Undo a mistaken Start: offered only to the person who started it
                # today, while it is running or paused. The route re-checks every
                # rule; this only decides whether the button shows.
                # An admin sees it on any task started today; a developer only on
                # their own, and only once they have time on it today.
                'can_undo_start': bool((_undo_admin or (today_map.get(k.id) or 0) > 0)
                                       and k._can_undo_start_cheap(_undo_me, _undo_today, _undo_admin)),
                'undo_start_by': k.undo_start_user_id.name if k.undo_start_user_id else '',
                'undo_start_prev_state': k.undo_prev_state or '',
                'undo_start_prev_state_label': _state_labels.get(k.undo_prev_state, '')
                                               if k.undo_prev_state else '',
                # When this task was last touched by anyone, so the lanes can
                # sort by activity instead of by id. False for a task that has
                # never been worked on; those sort last.
                'last_activity': last_activity_map.get(k.id) or False,
                # When the task was created. The board turns a never-started card
                # red, and this is what lets that red EXPIRE after a day instead
                # of shouting forever. Raw UTC, so it can be compared against the
                # server_now in this same response rather than the device clock —
                # a phone or PC with a wrong clock must not decide a card's colour.
                'create_date': k.create_date.isoformat() + 'Z' if k.create_date else False,
                'timer_start_datetime': timer_start_iso,  # For real-time timer calculation
                'paused_reason': k.paused_reason or "",
                # Survives the resume (resume_task never clears it), which is what
                # lets the card say "40m after lunch" rather than just the lifetime
                # total once work picks back up.
                'pause_reason_code': k.pause_reason_code or "",
                'description': k.description or "",
                'progress_count': k.progress_count or 0,
                'dev_progress_count': k.dev_progress_count or 0,
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
                # Same principle as can_start: the server owns the rule and ships
                # the answer, so the board never re-derives "is this deletable?"
                # from a hand-maintained list of states.
                'can_admin_delete': (
                    is_manager_or_admin and k._may_admin_delete(logged_ids)[0]),
                # Seconds on this task YESTERDAY; >0 shows the admin's
                # "Reduce yesterday" button (kpi_time_adjust.py has the rules).
                'prev_day_seconds': prev_day_map.get(k.id, 0.0),
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
        # Same today_seconds map_rec emits, for one task. A card refreshed through
        # this path (a notification tap, a post-action refetch) is dropped straight
        # into the board's list, so if this omitted the field that card would fall
        # out of the Today lane the moment it was touched — the one moment it most
        # belongs there. Per-task query, but this route serializes a single record.
        _today_secs = 0.0
        _tl = request.env['kpi.time.log'].sudo()
        for _g in _tl.read_group(
                [('kpi_id', '=', k.id),
                 ('user_id', '=', request.env.user.id),
                 ('work_date', '=', fields.Date.context_today(request.env.user)),
                 ('is_manual', '=', False)],
                ['duration_seconds:sum'], ['kpi_id'], lazy=False):
            _today_secs += _g.get('duration_seconds') or 0.0
        # Same work_date filter as the board route — the two serializers must
        # agree, or a card refreshed through this path would rejoin the Today
        # lane it was just correctly dropped from.
        _now = fields.Datetime.now()
        for _a in _tl.search([('kpi_id', '=', k.id),
                              ('user_id', '=', request.env.user.id),
                              ('work_date', '=', fields.Date.context_today(request.env.user)),
                              ('is_active', '=', True)]):
            if _a.start_time:
                _today_secs += max(0.0, (_now - _a.start_time).total_seconds())
        # Same last_activity the board route emits, for one task, and for the
        # same reason the today_seconds block above exists: a card refreshed
        # through this path is dropped straight back into the board's list, so
        # omitting the field would send the task it was just used on to the
        # BOTTOM of its lane — the exact complaint this field was added to fix.
        # Unscoped like the board route: last activity is a property of the
        # task, not of the caller.
        _last_activity = False
        _stamps = []
        for _g in _tl.read_group(
                [('kpi_id', '=', k.id)],
                ['start_time:max', 'end_time:max'], ['kpi_id'], lazy=False):
            for _v in (_g.get('start_time'), _g.get('end_time')):
                if not _v:
                    continue
                if isinstance(_v, str):
                    try:
                        _v = fields.Datetime.from_string(_v)
                    except (ValueError, TypeError):
                        continue
                _stamps.append(_v)
        if _stamps:
            _last_activity = max(_stamps).isoformat() + 'Z'
        client_kra = k.client_kra_id or k.kra_id
        return {
            'id': k.id,
            'name': k.name or "",
            # Same as get_tasks' map_rec — the two serializers must agree, or a
            # task opened on its own (from a notification, or the detail pane)
            # renders differently from the same task on the board.
            'client_name': client_kra.name if client_kra else "",
            'project_name': k.kra_id.name if k.kra_id else "",
            'external_ref': k.external_ref or "",
            'priority': k.priority or "regular",
            'requested_priority': k.requested_priority or '',
            'requested_doc_type': k.requested_doc_type or '',
            'deliverable_type': k.deliverable_type or '',
            'deliverable_other': k.deliverable_other or '',
            'deliverable_label': deliverable_type_label(k.deliverable_type, k.deliverable_other),
            'github_required': k._github_required(),
            'reverted_from': k.reverted_from or '',
            'revert_reason': k.revert_reason or '',
            **k._finish_payload(),
            'task_state': k.task_state or "assigned",
            'user_id': (k.user_id.id if k.user_id else False),
            'user_name': (k.user_id.name if k.user_id else ""),
            'estimate_display': f"{k.estimate_hours:02d}:{k.estimate_minutes:02d}",
            'estimate_hours': k.estimate_hours or 0,
            'estimate_minutes': k.estimate_minutes or 0,
            # Why the estimate grew, carried with the number it grew to. Without
            # these the app can extend an estimate but never show that it was
            # extended — which is the half that stops an overrun being argued
            # about later. /kra_kpi/tasks/get already sends them; this is the
            # serializer /kra_kpi/task/details uses.
            'estimate_extend_reason': k.estimate_extend_reason or '',
            'estimate_extension_count': k.estimate_extension_count or 0,
            'decline_count': k.decline_count or 0,
            # Signed off by the client: why its details can't change ('' = editable).
            'details_locked': k._details_locked_for(request.env.user),
            'parent_ref': k.related_req_ref or '',
            'legacy_req_link': bool(getattr(k, 'legacy_req_link', False)), 'legacy_status': getattr(k, 'legacy_status', '') or '',
            'parent_kpi_id': k.related_req_kpi_id.id or False,
            'request_category': k.request_category or 'standard',
            'timer_total_seconds': k.timer_total_seconds or 0,
            'today_seconds': round(_today_secs, 2),
            # Same Undo-start keys map_rec sends, so a refetched card keeps its button.
            'can_undo_start': bool(
                (self._is_kra_admin(request.env.user) or _today_secs > 0)
                and k._can_undo_start_cheap(request.env.user,
                                            fields.Date.context_today(request.env.user),
                                            self._is_kra_admin(request.env.user))),
            'undo_start_by': k.undo_start_user_id.name if k.undo_start_user_id else '',
            'undo_start_prev_state': k.undo_prev_state or '',
            'undo_start_prev_state_label': dict(k._fields['task_state'].selection).get(
                k.undo_prev_state, '') if k.undo_prev_state else '',
            'last_activity': _last_activity,
            # Same create_date the board route emits. Without it a card refreshed
            # through this path loses the age the red is judged by, so a new task
            # would go blue the moment anyone touched it.
            'create_date': k.create_date.isoformat() + 'Z' if k.create_date else False,
            'timer_start_datetime': timer_start_iso,
            'paused_reason': k.paused_reason or "",
            'pause_reason_code': k.pause_reason_code or "",
            'description': k.description or "",
            'progress_count': k.progress_count or 0,
            'dev_progress_count': k.dev_progress_count or 0,
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
            # And the same delete answer. Without it a task opened on its own —
            # from a notification, or the details pane — served a payload with no
            # can_admin_delete, so the app read it as False and the Delete button
            # simply wasn't there on a task the board offered it for. Called
            # without a logged_ids set because this serializes ONE record, so
            # there is no batch to amortise.
            'can_admin_delete': (self._is_kra_admin(request.env.user)
                                 and k._may_admin_delete()[0]),
            'prev_day_seconds': (k.prev_day_seconds_map([k.id]).get(k.id, 0.0)
                                 if self._is_kra_admin(request.env.user) else 0.0),
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
        # Anyone actually ON the task, not just the primary assignee.
        #
        # This used to be `kpi.user_id.id == user.id`, which is what made the
        # Complete panel come and go: a developer added as a CONTRIBUTOR does the
        # work and logs time like anyone else, but was not the primary, so the
        # panel simply never rendered for them and the button looked missing.
        # effective_contributor_ids is the module's own union of assignee +
        # contributors + role lists (kpi.py) — the same set that decides who may
        # start a timer, so the person who can work a task can now finish it.
        is_assignee = bool(user.id in kpi.sudo().effective_contributor_ids.ids)
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
            # The estimate's whole chain and the task's audit trail, the same two
            # the web detail pane gets from /kpi_action/details. The card can only
            # ever carry the LATEST reason — the field is overwritten on each
            # extension — so without these the app could show that an estimate had
            # grown three times but not what the first two reasons were, or who.
            # Both are already computed here; only this route was not asking.
            'estimate_history': self._estimate_history(kpi),
            **self._activity_log(kpi),
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
                # Every document on the entry, not just the first. file_name above
                # still describes the FIRST one and is left alone, so a client that
                # reads only that keeps working.
                'files': self._entry_files_payload(
                    m, 'manual_file', '/kpi/manual/download/',
                    has_primary=bool(m.file_name)),
            } for m in manuals],
            'progress': [{
                'id': p.id,
                'summary': p.summary or '',
                'file_name': p.file_name or '',
                # Walrus, so the Binary is read ONCE. uploaded_file is
                # attachment-backed: every bool() of it pulls the whole file off
                # the filestore, and this dict needs the answer twice (here and for
                # has_primary below). _entry_files_payload's own docstring warns
                # about exactly this — a task with fifty attachments was fetching
                # every one of them twice to answer a yes/no question.
                'has_file': (has_primary := bool(p.uploaded_file)),
                'employee_name': p.employee_name or '',
                'create_date': convert_to_user_tz(p.create_date),
                # When it was last changed (/kpi/progress/update, or a file removed),
                # so the history can say "Modified <time>" under the original time.
                'edited_at': convert_to_user_tz(p.edited_at) if p.edited_at else '',
                'related_links': p.related_links or '[]',
                # Whether THIS user may edit or delete the entry. The app reads its
                # progress history from here, not from /kpi/progress/list, so
                # without this the edit and delete controls have nothing to gate on
                # and would have to re-derive a rule the server already owns.
                'can_edit': self._may_edit_progress(p),
                # Attached by the client when raising the task: shown in its own
                # "From the client" section, not in the team's history.
                'from_client': bool(p.from_client),
                # The whole set of files, where has_file/file_name above describe
                # only the first. Same reason as can_edit: this route, not
                # /kpi/progress/list, is where the app reads its history from.
                'files': self._entry_files_payload(
                    p, 'uploaded_file', '/kpi/progress/download?progress_id=',
                    has_primary=has_primary),
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
                'from_client': bool(p.from_client),
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
            # Same reasoning for every event that is about a DEVELOPER or a DAY
            # rather than a task: "workday started", the idle check and the
            # no-task nudge all anchor on an arbitrary task (some on the newest
            # task in the whole database), and the app routes purely on kpi_id —
            # so tapping one opened a random unrelated task, with that task's name
            # and client shown on the row as though they belonged to the message.
            from ..models.kpi_notify import _NON_TASK_EVENTS
            is_invoice = bool(n.invoice_id)
            anchor_only = is_invoice or (n.event in _NON_TASK_EVENTS)
            return {
                'id': n.id,
                'kpi_id': False if anchor_only else (kpi.id if kpi else False),
                'kpi_name': "" if anchor_only else (kpi.name if kpi else ""),
                'developer': "" if anchor_only else (kpi.user_id.name if kpi and kpi.user_id else ""),
                'client_name': "" if anchor_only else (client_kra.name if client_kra else ""),
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
        # The EAS projectId this token was minted under. Sent by app builds that
        # know it; absent from older builds, which land in the '' group and are
        # kept apart from every known project rather than guessed at.
        project_id = (params.get('project_id') or '').strip() or None
        request.env['kpi.push.token'].sudo().upsert(
            current_user, token, platform, device, project_id)
        _logger.info("push/register user=%s(%s) platform=%s project=%s token=%s...",
                     current_user.login, current_user.id, platform,
                     project_id or '(unknown)', token[:24])
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
    @staticmethod
    def _mobile_key(number):
        """The digits a mobile number is compared by: its LOCAL part (the last
        10 digits, or all of them when shorter — an Oman number has 8). A stored
        country code therefore never matters, and neither does one the user typed."""
        digits = re.sub(r'\D', '', number or '')
        return digits[-10:] if len(digits) >= 10 else digits

    @classmethod
    def _mobile_same(cls, a, b):
        """Do two numbers denote the same phone? Equal local parts, or one a tail
        of the other where both are at least a full short number long."""
        ka, kb = cls._mobile_key(a), cls._mobile_key(b)
        if not ka or not kb:
            return False
        return ka == kb or (len(ka) >= 8 and len(kb) >= 8 and (ka.endswith(kb) or kb.endswith(ka)))

    def _find_app_user(self, mobile):
        """Find a res.users by their app login mobile number (digits-compared).

        Compared on the whole local part the app collected, not — as before —
        on the last 8 digits, which two Indian numbers can share. And when two
        accounts still match, NEITHER is returned: signing one person into the
        other's account on search order is the worse outcome by far, and the
        admin is told in the log which digits collide."""
        digits = re.sub(r'\D', '', mobile or '')
        if not digits or len(digits) < 4:
            return request.env['res.users'].sudo().browse()
        users = request.env['res.users'].sudo().search([('kpi_mobile_number', '!=', False)])
        hits = [u for u in users if self._mobile_same(u.kpi_mobile_number, digits)]
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            _logger.warning("app login: %d users share the mobile ending ...%s — refusing until fixed in Login Management",
                            len(hits), digits[-4:])
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
        # Five wrong passwords lock the number for a quarter hour (res.users).
        # This route is public and the passwords are short; without a cap they
        # are a few thousand requests from being found.
        if user._app_login_locked():
            return {'status': False, 'error': "Too many wrong attempts. Please try again in a few minutes."}
        if not user._check_app_password(pw):
            user._app_login_failed()
            return {'status': False, 'error': "Username & password don't match this number. Contact your admin."}
        user._app_login_succeeded()
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
                if not code:
                    # Over the request throttle (kpi.app.otp). The same generic
                    # answer, so the route still reveals nothing — but no message
                    # goes out and no fresh code exists to be guessed.
                    _logger.warning("otp/request throttled user=%s(%s)", user.login, user.id)
                    return {'status': True, 'sent': False}
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
        # The device is locked to the account that set it up, exactly as for
        # /kpi_app/login. A reset was the one door that did not check, so a
        # locked device could still be signed into another account through it.
        if self._device_lock_owner(user, params):
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
        # Archived users too: /kpi_user_access/update can set active back to True,
        # but an archived user never appeared in this list, so there was nothing
        # to click to re-enable them. Each row already carries 'active'.
        # id 1 (__system__ / OdooBot) is archived by design and must stay hidden
        # now that active_test is off; share=False still keeps portal users out.
        users = request.env['res.users'].sudo().with_context(active_test=False).search(
            [('share', '=', False), ('id', '!=', 1)], order='name')
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
        'admin' (system / owner) | 'coordinator' | 'client' | 'developer'.

        Coordinator is its own entry so it can be assigned here: a client's
        Manager must be one, and coordinators approve, reject and assign on
        WhatsApp. The session role (res.users.kpi_role) still treats them as
        admin for the app screens."""
        if (user.has_group('base.group_system')
                or user.has_group('kra_kpi_module.group_kra_owner')):
            return 'admin'
        if user.has_group('kra_kpi_module.group_kra_admin'):
            return 'coordinator'
        if user.has_group('kra_kpi_module.group_kra_client'):
            return 'client'
        return 'developer'

    @http.route('/kpi_user_access/set_mobile', type='json', auth='user', methods=['POST'], csrf=False)
    def user_access_set_mobile(self, **params):
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        uid = int(params.get('user_id'))
        mobile = re.sub(r'\D', '', params.get('mobile') or '') or False
        if mobile:
            mobile, problem = self._valid_mobile_for(request.env['res.users'].sudo().browse(uid), mobile)
            if problem:
                return {'status': False, 'message': problem}
            # One number, one account. A duplicate is how a login on search
            # order signs one person into another's account (_find_app_user now
            # refuses a collision; this stops it being created).
            others = request.env['res.users'].sudo().search([
                ('kpi_mobile_number', '!=', False), ('id', '!=', uid)])
            clash = next((u for u in others if self._mobile_same(u.kpi_mobile_number, mobile)), None)
            if clash:
                return {'status': False,
                        'message': f"That number is already the app login of {clash.name or clash.login}."}
        request.env['res.users'].sudo().browse(uid).kpi_mobile_number = mobile
        return {'status': True, 'mobile': mobile or ''}

    # Plain-words rules for the countries this install deals with; any other
    # country gets "e.g. <example>" from the same library.
    _MOBILE_RULES = {
        'IN': "10 digits starting with 6, 7, 8 or 9",
        'OM': "8 digits starting with 7 or 9",
    }

    @classmethod
    def _valid_mobile_for(cls, user, digits):
        """-> (national_digits, None) or (digits, problem message).

        Google's libphonenumber (the `phonenumbers` package Odoo ships) decides,
        for the user's own country (Login Management) or the company's: a real
        mobile number of that country, not just the right count of digits. A
        number typed with its country code in front is accepted and stored
        without it, as the other numbers are."""
        try:
            import phonenumbers
            from phonenumbers import PhoneNumberType as T
        except ImportError:
            return digits, None   # library missing: keep the old behaviour
        dial, _length = user._kpi_user_mobile_cfg()
        region = phonenumbers.region_code_for_country_code(int(dial or 91)) or 'IN'
        candidates = [digits]
        if digits.startswith(str(dial)) and len(digits) > len(str(dial)):
            candidates.append('+' + digits)
        for cand in candidates:
            try:
                num = phonenumbers.parse(cand, region)
            except phonenumbers.NumberParseException:
                continue
            if (num.country_code == int(dial or 91) and phonenumbers.is_valid_number(num)
                    and phonenumbers.number_type(num) in (T.MOBILE, T.FIXED_LINE_OR_MOBILE)):
                return str(num.national_number), None
        country = user.env['res.country'].sudo().search([('code', '=', region)], limit=1)
        name = country.name or region
        rule = cls._MOBILE_RULES.get(region)
        if not rule:
            ex = phonenumbers.example_number_for_type(region, T.MOBILE)
            rule = f"e.g. {ex.national_number}" if ex else "a mobile number of that country"
        return digits, f"Not a valid {name} mobile number (+{dial}): {rule}."

    @http.route('/kpi_user_access/set_country', type='json', auth='user', methods=['POST'], csrf=False)
    def user_access_set_country(self, **params):
        """Set a PERSON's mobile country — the dial code (+968 Oman, +91 India, …)
        and local length that apply to BOTH their app-login mobile and their
        WhatsApp number. Empty country clears the override (back to the company
        default). CLEARS both stored numbers, because digits issued under the old
        dial code do not belong to the new country. Shared by the Configuration
        screen (developer WhatsApp) and Login Management, since both act on
        res.users by id. Returns the resolved dial/length so the screen updates
        live, plus `cleared` naming which numbers were wiped so the screen can
        tell the admin what to re-enter."""
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        user = request.env['res.users'].sudo().browse(int(params.get('user_id') or 0))
        if not user.exists():
            return {'status': False, 'message': 'User not found'}
        cid = params.get('country_id')
        user.kpi_mobile_country_id = int(cid) if cid else False
        # Auto-fill the local length from the country map (onchange doesn't run on
        # a bare write, so mirror it); 0 = derive/fall back to the company default.
        from ..models.res_company_kpi import COUNTRY_MOBILE_LENGTH
        code = user.kpi_mobile_country_id.code if user.kpi_mobile_country_id else None
        user.kpi_mobile_length = COUNTRY_MOBILE_LENGTH.get(code, 0) if code else 0
        dial, length = user._kpi_user_mobile_cfg()
        # Both stored numbers were issued under the OLD dial code, so neither
        # survives the move. Re-keying was tried and is wrong: the old test only
        # compared LENGTHS, so India -> US (both 10 digits) silently re-labelled
        # an Indian number as American and mis-routed its OTPs. A number belongs
        # to the country that issued it, so whenever one is present we clear it
        # and the admin types the new one — both screens pop up saying so.
        cleared = []
        if user.kpi_wa_number:
            user.kpi_wa_number = False
            cleared.append('whatsapp')
        if user.kpi_mobile_number:
            user.kpi_mobile_number = False
            cleared.append('mobile')
        return {'status': True,
                'country_id': user.kpi_mobile_country_id.id if user.kpi_mobile_country_id else False,
                'dial': dial, 'mobile_length': length,
                'wa_number': '', 'mobile': '', 'cleared': cleared}

    @http.route('/kpi_user_access/set_role', type='json', auth='user', methods=['POST'], csrf=False)
    def user_access_set_role(self, **params):
        """Set a user's KRA app-role by moving them between the role groups:
        'admin' → Owner (full access), 'coordinator' → Coordinator,
        'developer' → Developer, 'client' → Client.
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
            'admin':       'kra_kpi_module.group_kra_owner',
            'coordinator': 'kra_kpi_module.group_kra_admin',
            'developer':   'kra_kpi_module.group_kra_developer',
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
        """Reset a user's APP PIN (mobile + PIN login). Optional {password} sets a
        unique initial PIN; otherwise the default '1111'. Either way forces a
        change on next app login (must_change=True).

        Does NOT touch the user's Odoo login password — that is a separate
        credential, changed under Settings -> Users -> Security.
        """
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        user = request.env['res.users'].sudo().browse(int(params.get('user_id') or 0))
        if not user.exists():
            return {'status': False, 'message': 'User not found'}
        # An Odoo system administrator's access may only be reset by another Odoo
        # system administrator. Without this, holding the KRA/KPI admin role would
        # be enough to reset the superuser's credentials and take the instance —
        # every database, every module, not just this one.
        #
        # It used to refuse for ANY system admin, including the one making the
        # request, so a system admin could not even reset their own.
        if (user.has_group('base.group_system')
                and not request.env.user.has_group('base.group_system')):
            return {'status': False,
                    'message': "Only an Odoo system administrator can reset another "
                               "administrator's access."}
        custom = (params.get('password') or '').strip()
        if custom:
            user.write({
                'kpi_app_password_hash': user._crypt_context().hash(custom),
                'kpi_app_must_change_password': True,
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
            'admin':       'kra_kpi_module.group_kra_owner',
            'coordinator': 'kra_kpi_module.group_kra_admin',
            'developer':   'kra_kpi_module.group_kra_developer',
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
        # 1) Log the device out of WhatsApp on the Evolution server.
        try:
            session.action_disconnect()
        except Exception as exc:
            _logger.warning("wa_server delete: logout failed: %s", exc)

        # 2) DO NOT unlink a session that carries history.
        #
        #    whatsapp.message.session_id is required + ondelete='cascade', so
        #    session.unlink() silently deletes EVERY message ever sent or
        #    received on it. This route used to do exactly that, from an admin
        #    button, with no warning -- on this database that is thousands of
        #    rows including the group corpus. whatsapp.session.unlink() now
        #    refuses outright when message_count is non-zero; here we reset the
        #    row instead so the button still "clears the connection".
        #
        #    The old step 3 (deleting the neonize .db credential file) is gone:
        #    Evolution holds the session server-side, and db_path is deprecated.
        try:
            if session.message_count:
                session.write({
                    'status': 'disconnected',
                    'qr_image': False,
                    'pairing_code': False,
                    'instance_id': False,
                    'error_message': 'Disconnected from the WhatsApp admin screen.',
                })
                return {'status': True, 'kept_messages': session.message_count}
            session.unlink()
        except Exception as exc:
            _logger.error("wa_server delete failed: %s", exc)
            return {'status': False, 'message': str(exc)}
        return {'status': True}

    # ================================================================== #
    # Device pairing — RETIRED. These three routes are COMPATIBILITY       #
    # SHIMS for the mobile app, not live features.                         #
    # ------------------------------------------------------------------ #
    # The PIN gate is gone: a developer opens the board and presses Start
    # Workday. But installed copies of the Expo app still poll these routes and
    # will sit on their PIN screen forever if they 404 or report "not paired".
    # So they stay, and they answer "there is nothing to pair".
    #
    # DO NOT delete them as dead code — nothing in this repo calls them, and
    # that is exactly what makes them look deletable. They are the contract with
    # an app build that is already on people's phones. They can go once every
    # installed app has been updated past the PIN screen.
    #
    # `day_done` is still answered truthfully so the app keeps showing
    # "Workday ended for today" correctly — that rule did not go away.
    # ================================================================== #
    @http.route('/kpi_pair/generate', type='json', auth='user', methods=['POST'], csrf=False)
    def pair_generate(self, **params):
        """Shim: no PIN is issued any more. See the block comment above."""
        done = request.env['kpi.work.session'].sudo()._day_done(request.env.user)
        return {'status': True, 'expires_at': False, 'pin': False,
                'mode': 'start', 'done': bool(done)}

    @http.route('/kpi_pair/status', type='json', auth='user', methods=['POST'], csrf=False)
    def pair_status(self, **params):
        """Shim: always 'paired', so the app never shows the PIN screen."""
        done = request.env['kpi.work.session'].sudo()._day_done(request.env.user)
        return {'status': True, 'state': 'paired', 'paired': True,
                'mode': 'start', 'day_done': bool(done), 'bypass_gate': True}

    @http.route('/kpi_pair/verify', type='json', auth='user', methods=['POST'], csrf=False)
    def pair_verify(self, **params):
        """Shim: accepts anything. Nothing is paired and no PIN is consumed."""
        return {'status': True, 'ok': True}

    # ================================================================== #
    # Developer self-created tasks — "Pending Review" lane                #
    # ================================================================== #
    def _is_kra_admin(self, user):
        """Coordinator / Owner / System — the roles allowed to accept/reject.

        Delegates to kra.kpi._user_is_kpi_admin so the controllers, the admin
        gate-skip on create and the delete guard can never disagree about who
        counts as an admin.
        """
        return request.env['kra.kpi'].sudo()._user_is_kpi_admin(user)

    def _task_actor_or_refuse(self, rec):
        """None when the caller may act on this task — its assignee, or an admin
        — else the refusal payload to return.

        The task action routes (start / pause / complete / reassign) ran under
        sudo() with no check at all, so any signed-in user could pause, complete
        or hand over anybody's task by id and corrupt their time logs with it.
        Same rule as resume_with_reason, which always had the check. An
        unassigned task stays open to anyone, as before.
        """
        user = request.env.user
        if rec.user_id and rec.user_id.id != user.id and not self._is_kra_admin(user):
            return {'status': False, 'message': 'Only the assigned developer can do this.'}
        return None

    @http.route('/kra_kpi/task/self_create', type='json', auth='user', methods=['POST'], csrf=False)
    def self_create_task(self, **params):
        """Developer self-creates a task from the KPI Action Board.

        It lands in the separate "Pending Review" lane
        (is_self_created=True, admin_accepted=False): assigned to the creator and
        immediately workable (timer runs), but kept OUT of the official flow
        (no client pre-approval) until an admin Accepts it.

        The rules and the record live in kra.kpi.self_create_task
        (models/kpi_self_create.py), shared with WhatsApp's "Create my own task".
        """
        return request.env['kra.kpi'].self_create_task(params)

    @http.route('/kra_kpi/task/admin_create_done', type='json', auth='user', methods=['POST'], csrf=False)
    def admin_create_done_task(self, **params):
        """Admin records work ALREADY DONE as a finished task awaiting approval.

        The app's "Add Done Task" button. The normal path — New Task, accept,
        start, complete — needs a running timer and the developer's own workday,
        neither of which exists for work that happened off-system. So this
        creates the task straight into `partially_completed` (the board's
        Pending Approvals lane) with its worked time, in one transaction.

        What it deliberately does NOT do:
          * call start_task / complete_task — they act on the CALLER's session
            and breaks, run the start gates, and would credit the admin;
          * set admin_approved — approving is still a separate, human step, and
            the client portal only shows admin-approved work;
          * count the time as presence — the log is is_manual, so attendance,
            live productive time and the Workday map ignore it, while the KRA /
            employee / invoice reports include it on `work_date`.
        """
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Only admins can add a finished task.'}

        # Developer: the caller unless another was picked. Same rules as
        # self_create and /kra_kpi/get_users, which fills the picker.
        developer = user
        if params.get('user_id'):
            try:
                candidate = request.env['res.users'].sudo().browse(int(params['user_id']))
            except (TypeError, ValueError):
                candidate = request.env['res.users']
            if (not candidate.exists() or not candidate.active
                    or candidate.share or candidate.id == 1
                    or candidate.kpi_role == 'client'):
                return {'status': False, 'message': 'Please choose a valid developer.'}
            developer = candidate

        name = (params.get('name') or '').strip()
        if not name:
            return {'status': False, 'message': 'Task name is required.'}
        kra_id = params.get('kra_id')
        if not kra_id:
            return {'status': False, 'message': 'Please choose a project (KRA).'}
        try:
            kra = request.env['kra.master'].sudo().browse(int(kra_id))
        except (TypeError, ValueError):
            kra = request.env['kra.master']
        if not kra.exists():
            return {'status': False, 'message': 'Selected project not found.'}

        try:
            worked = int(float(params.get('worked_seconds') or 0))
            est_h = int(params.get('estimate_hours') or 0)
            est_m = int(params.get('estimate_minutes') or 0)
        except (TypeError, ValueError):
            return {'status': False, 'message': 'Time worked and estimate must be numbers.'}
        if worked <= 0:
            return {'status': False, 'message': 'Enter the time worked.'}
        if est_h < 0 or not 0 <= est_m <= 59:
            return {'status': False, 'message': 'Estimate minutes must be between 0 and 59.'}
        # The app derives the estimate from the time worked and always lands
        # above it; this is the guard for any other caller.
        if est_h * 3600 + est_m * 60 <= worked:
            return {'status': False, 'message': 'Estimate must be more than the time worked.'}

        dv, deliverable_err = clean_deliverable(params.get('deliverable_type'), params.get('deliverable_other'))
        if deliverable_err:
            return {'status': False, 'message': deliverable_err}
        if not dv['deliverable_type']:
            return {'status': False, 'message': 'Choose the type: Module, App, EXE or Other.'}

        priority = params.get('priority') or 'regular'
        if priority not in ('regular', 'important', 'urgent'):
            priority = 'regular'

        # The day the work is filed under, in the DEVELOPER's calendar — the same
        # one kpi.time.log.work_date is computed in.
        today = fields.Date.context_today(request.env['kra.kpi'].with_user(developer))
        work_date = today
        if params.get('work_date'):
            try:
                work_date = fields.Date.to_date(params['work_date'])
            except (TypeError, ValueError):
                return {'status': False, 'message': 'Work date is not a valid date.'}
            if not work_date:
                work_date = today
        if work_date > today:
            return {'status': False, 'message': 'Work date cannot be in the future.'}

        Kpi = request.env['kra.kpi'].sudo()
        now = fields.Datetime.now()
        # Already accepted, so create() neither auto-accepts it (which would ask
        # the client for pre-approval) nor arms the admin-accept clock.
        rec = Kpi.create({
            'name': name,
            'kra_id': kra.id,
            'user_id': developer.id,
            'estimate_hours': est_h,
            'estimate_minutes': est_m,
            'priority': priority,
            'deliverable_type': dv['deliverable_type'],
            'deliverable_other': dv['deliverable_other'],
            'description': (params.get('description') or '').strip(),
            'external_ref': 'REQ-%03d' % Kpi._next_ref_for_prefix('REQ'),
            'requested_by_id': user.id,
            'published': True,
            'admin_accepted': True,
            'admin_accepted_at': now,
            'admin_accepted_by_id': user.id,
            'task_state': 'partially_completed',
            'completed_by': developer.id,
            'completion_date': now,
        })
        Kpi.log_manual_time(rec.id, worked, developer.id, fields.Date.to_string(work_date),
                            is_manual=True)

        try:
            rec._log_action('admin_created_done', source='web', payload={
                'developer_id': developer.id,
                'worked_seconds': worked,
                'work_date': fields.Date.to_string(work_date),
            })
        except Exception as exc:
            _logger.warning("admin_created_done audit failed for %s: %s", rec.id, exc)
        # Tell the reviewers it is waiting, exactly as a developer's Complete does.
        try:
            rec._notify('complete', prev_state=False)
        except Exception as exc:
            _logger.warning("admin_created_done notify failed for %s: %s", rec.id, exc)

        return {'status': True, 'id': rec.id, 'external_ref': rec.external_ref,
                'message': 'Added to Pending Approvals.'}

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
        # Module / App / EXE: kept as the developer set it unless the admin sends
        # a correction.
        dv, deliverable_err = clean_deliverable(params.get('deliverable_type'), params.get('deliverable_other'))
        if deliverable_err:
            return {'status': False, 'message': deliverable_err}

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
        if dv['deliverable_type']:
            vals.update(dv)
        # Admin categorizes the accepted task — re-number its provisional TASK-###
        # ref into the chosen sequence (REQ/UPT/BUG) and apply the name prefix.
        # Prefix tables are shared with _auto_admin_accept so the human and
        # automatic paths cannot drift.
        _REF_PREFIX = REF_PREFIX_FOR_DOC_TYPE
        _NAME_PREFIX = NAME_PREFIX_FOR_DOC_TYPE
        doc_type = params.get('doc_type') or 'requirement'
        prefix = _REF_PREFIX.get(doc_type, 'REQ')
        # A bug / update the client raised under a requirement (BUG001-REQ-012)
        # keeps its ref while it stays that type: it is numbered per requirement.
        cur_ref = (rec.external_ref or '').strip().upper()
        if not re.match(r'^%s\d+-' % prefix, cur_ref):
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
        # The admin sets the REAL priority here, having seen what the developer
        # asked for (requested_priority, shipped to both boards). Optional: leave
        # it out and the developer's choice stands. requested_priority is never
        # written — it is the record of the request, not a second live value.
        _prio = params.get('priority')
        if _prio in ('urgent', 'important', 'regular'):
            vals['priority'] = _prio
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
        """RETIRED as an editor: the WhatsApp number now always equals the login
        mobile (res.users._kpi_sync_wa_number), which is changed in Login
        Management only. Kept so older app builds get a clear answer instead
        of a 404."""
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Not authorized'}
        return {'status': False,
                'message': 'The WhatsApp number follows the login mobile. Change it in Login Management.'}

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
                # Who gets each End Workday's "What did you work on today?".
                'ceo_wa_numbers': c.kpi_ceo_wa_numbers or '',
                'queue_nudge_minutes': c.queue_nudge_minutes or 30,
                'urgent_nudge_minutes': c.urgent_nudge_minutes or 5,
                'standard_workday_hours': c.standard_workday_hours or 9.0,
                # Break / lunch / meeting over-run reminders (developer only).
                # 0 = OFF for each, so `or <default>` must NOT be used here:
                # it would read a deliberate 0 as unset and switch the
                # reminder back on behind the admin's back.
                'break_alert_minutes': (c.break_alert_minutes
                                        if c.break_alert_minutes not in (None, False, '')
                                        else 15),
                'lunch_alert_minutes': (c.lunch_alert_minutes
                                        if c.lunch_alert_minutes not in (None, False, '')
                                        else 30),
                'meeting_alert_minutes': (c.meeting_alert_minutes
                                          if c.meeting_alert_minutes not in (None, False, '')
                                          else 30),
                'break_budget_minutes': (c.break_budget_minutes
                                         if c.break_budget_minutes not in (None, False, '')
                                         else 60),
                # Snapshot image retention + daily report schedule & retention.
                'snapshot_retention_number': c.kpi_snapshot_retention_number or 0,
                'snapshot_retention_unit': c.kpi_snapshot_retention_unit or 'months',
                'daily_report_enabled': c.kpi_daily_report_enabled,
                'daily_report_hour': c.kpi_daily_report_hour or 10.0,
                'daily_report_coverage': c.kpi_daily_report_coverage or 'yesterday',
                'report_retention_number': c.kpi_report_retention_number or 0,
                'report_retention_unit': c.kpi_report_retention_unit or 'months',
                'download_retention_number': c.kpi_download_retention_number or 0,
                'download_retention_unit': c.kpi_download_retention_unit or 'days',
                'country_id': c.kpi_country_id.id if c.kpi_country_id else False,
                'country_dial_code': dial,
                'mobile_length': length,
                # Where workday start/end reports are posted. Read here rather than
                # from /kpi_wa_group/list so the screen can show the current setting
                # with the gateway offline — you must be able to see and change the
                # destination without the phone being connected.
                'wa_group_jid': c.kpi_wa_group_jid or '',
                'wa_group_name': c.kpi_wa_group_name or '',
                'countries': [
                    {'id': co.id, 'name': co.name, 'code': co.code or '',
                     'phone_code': co.phone_code}
                    for co in countries]}

    # ---- 369 AI Assistant keys (Configuration > 369 AI Assistant) ---- #
    # Stored as the ir.config_parameter keys kpi.ai already reads, so the
    # assistant, meetings and WhatsApp intake all pick a key up at once. A key
    # is write-only: these routes say whether one is saved, never what it is.
    def _ai_config(self):
        from ..models.kpi_ai import PROVIDERS, KEY_PARAM, MODEL_PARAM, DEFAULT_MODEL
        p = request.env['ir.config_parameter'].sudo()
        return {'status': True, 'providers': [{
            'provider': pr,
            'key_set': bool(p.get_param(KEY_PARAM[pr], '')),
            'model': p.get_param(MODEL_PARAM[pr], '') or '',
            'default_model': DEFAULT_MODEL[pr],
        } for pr in PROVIDERS]}

    @http.route('/kpi_config/ai_get', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_config_ai_get(self, **params):
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        return self._ai_config()

    @http.route('/kpi_config/set_ai', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_config_set_ai(self, provider=None, key=None, model=None, **params):
        """key: None leaves it, '' clears it, text saves it. model: None leaves
        it, '' goes back to the default, text overrides it."""
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        from ..models.kpi_ai import PROVIDERS, KEY_PARAM, MODEL_PARAM
        if provider not in PROVIDERS:
            return {'status': False, 'message': 'Unknown AI provider.'}
        p = request.env['ir.config_parameter'].sudo()
        if key is not None:
            key = str(key).strip()
            if len(key) > 400 or any(ch.isspace() for ch in key):
                return {'status': False, 'message': 'That does not look like an API key.'}
            p.set_param(KEY_PARAM[provider], key or False)   # False deletes the parameter
        if model is not None:
            model = str(model).strip()
            if len(model) > 100:
                return {'status': False, 'message': 'The model name is too long.'}
            p.set_param(MODEL_PARAM[provider], model or False)
        return self._ai_config()

    @http.route('/kpi_config/test_ai', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_config_test_ai(self, provider=None, **params):
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        from ..models.kpi_ai import PROVIDERS
        if provider not in PROVIDERS:
            return {'status': False, 'message': 'Unknown AI provider.'}
        return request.env['kpi.ai'].test_provider(provider)

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
        """RETIRED — idle auto-pause is off and there is nothing to configure.

        Kept as a no-op rather than deleted: an installed copy of the mobile app
        may still POST here, and a 404 would surface as a failed save on a screen
        that otherwise worked. Answers success and changes nothing.

        The old body did `max(1, minutes or 5)`, which is also why 0 could never
        switch the feature off from this screen.
        """
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
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

    @http.route('/kpi_config/set_ceo_numbers', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_config_set_ceo_numbers(self, numbers='', **params):
        """The WhatsApp number(s) each End Workday's day note is sent to.
        Comma-separated; each is cleaned the way every other number here is
        (the company's dial code is added to a bare local number)."""
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Not authorized'}
        c = request.env.company.sudo()
        dial, length = c._kpi_mobile_cfg()
        out = []
        for raw in re.split(r'[,;\s]+', str(numbers or '')):
            n = normalize_wa(raw.strip(), dial, length)
            if not n:
                continue
            if len(n) < 8 or len(n) > 15:
                return {'status': False, 'message': '%s does not look like a WhatsApp number.' % raw.strip()}
            if n not in out:
                out.append(n)
        c.kpi_ceo_wa_numbers = ','.join(out) or False
        return {'status': True, 'numbers': ','.join(out)}

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

    @http.route('/kpi_config/set_break_alerts', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_config_set_break_alerts(self, **params):
        """Thresholds for the developer-only break / lunch / meeting reminders.

        Each is minutes, and 0 is a REAL value meaning "switch this one off" --
        hence max(0, ...) rather than the max(1, ...) the nudge routes above use,
        and hence only the keys actually sent are written. A screen that edits one
        field must not reset the other three to their defaults just by omitting
        them.
        """
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Not authorized'}
        fields_map = ('break_alert_minutes', 'lunch_alert_minutes',
                      'meeting_alert_minutes', 'break_budget_minutes')
        vals = {}
        for name in fields_map:
            if name not in params or params.get(name) in (None, ''):
                continue
            try:
                vals[name] = max(0, int(params.get(name)))
            except (TypeError, ValueError):
                continue
        if vals:
            request.env.company.sudo().write(vals)
        return {'status': True, 'values': vals}

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

    @http.route('/kra_kpi/kpi/name_matches', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_name_matches(self, **params):
        """Tasks already using this name under this KRA. A hint, never a refusal —
        see kra.kpi.create_kpi.

        AUTHORISATION: find_name_matches searches under sudo() and returns
        task names, references, states and assignee names. With no check,
        any signed-in user -- a client portal user included -- could walk
        kra_id values and read other clients' task lists out of a route
        meant to prevent a duplicate name on a form only staff ever open.

        Staff only, therefore. group_kra_developer is the floor of the
        hierarchy (system -> owner -> coordinator -> developer), so every
        member of the team passes and a client does not. A client gets the
        same empty answer the hint already returns when it fails, so nothing
        breaks for them.
        """
        if not request.env.user.has_group(
                'kra_kpi_module.group_kra_developer'):
            return {'status': True, 'matches': []}
        try:
            matches = request.env['kra.kpi'].find_name_matches(
                params.get('name') or '', params.get('kra_id'))
            return {'status': True, 'matches': matches}
        except Exception as e:
            # A failed hint must never stop someone creating a task.
            _logger.warning("kpi_name_matches failed: %s", e)
            return {'status': True, 'matches': []}

    @http.route('/kpi_config/set_download_retention', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_config_set_download_retention(self, **params):
        """How long to keep stored KRA report downloads before the cleanup cron
        deletes them. number 0 = keep forever; unit in days/months/years.

        The Configuration screen offers 7/30/45/60/90 days as presets, but they
        arrive here as the same number+unit pair a Custom value does — the presets
        are a convenience over these two fields, not a separate setting."""
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Not authorized'}
        try:
            number = max(0, int(params.get('number') or 0))
        except (TypeError, ValueError):
            number = 0
        unit = params.get('unit')
        if unit not in ('days', 'months', 'years'):
            unit = 'days'
        c = request.env.company.sudo()
        c.kpi_download_retention_number = number
        c.kpi_download_retention_unit = unit
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
            "estimate_history": self._estimate_history(k),
            **self._activity_log(k),
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
        # This route had NO authorisation check while unlinking through sudo():
        # any authenticated account — a developer, or a client portal user —
        # could post a kra_id and destroy an entire client, every task under it,
        # every child KRA and all their kpi.time.log rows. auth='user' is
        # authentication, not authorisation, and sudo() bypasses the read-only
        # ACL on kra.master that would otherwise have stopped it.
        if not self._is_kra_admin(request.env.user):
            return {"status": False, "message": "Not authorized"}
        kra_id = params.get("kra_id")
        if not kra_id:
            return {"status": False, "message": "kra_id missing"}

        kra = request.env["kra.master"].sudo().browse(int(kra_id))
        if not kra.exists():
            return {"status": False, "message": "KRA not found"}

        # Recorded work is not the admin's to discard by deleting its project.
        # Same rule the per-task delete uses (kra.kpi._may_admin_delete), applied
        # to the whole subtree: one task with time on it blocks the delete, and
        # the message names it so the admin can go and look.
        Kpi = request.env['kra.kpi'].sudo()
        subtree_ids = kra._get_descendant_ids()
        tasks = Kpi.search([('kra_id', 'in', subtree_ids)]) if subtree_ids else Kpi
        worked = tasks.filtered(
            lambda t: t.timer_start_datetime or t.timer_total_seconds)
        if not worked and tasks:
            # kra.kpi has no reverse link to its time logs, so ask the log side.
            logged = request.env['kpi.time.log'].sudo().search(
                [('kpi_id', 'in', tasks.ids)], limit=1)
            worked = logged.kpi_id
        if worked:
            first = worked[0]
            return {"status": False,
                    "message": "'%s' has tasks with recorded work (e.g. %s). "
                               "Delete would destroy their time logs."
                               % (kra.name or kra_id,
                                  first.external_ref or first.name or first.id)}

        kra.kpi_ids.unlink()
        kra.child_ids.unlink()
        kra.unlink()

        return {"status": True, "message": "KRA deleted"}

    @http.route('/kra_kpi/delete_kpi', type='json', auth='user', methods=['POST'], csrf=False)
    def delete_kpi(self, **params):
        # This route used to sudo()-unlink any id for ANY logged-in user — a
        # developer could delete another team's completed task, time logs and
        # all. auth='user' is authentication, not authorisation.
        if not self._is_kra_admin(request.env.user):
            return {"status": False, "message": "Not authorized"}
        kpi_id = params.get("kpi_id")
        if not kpi_id:
            return {"status": False, "message": "kpi_id missing"}

        kpi = request.env["kra.kpi"].sudo().browse(int(kpi_id))
        if not kpi.exists():
            return {"status": False, "message": "KPI not found"}

        kpi.unlink()
        return {"status": True, "message": "KPI deleted"}

    @http.route('/kra_kpi/task/admin_delete', type='json', auth='user', methods=['POST'], csrf=False)
    def admin_delete_task(self, **params):
        """Admin deletes a task that was never started.

        Distinct from /kpi_pending_queue/delete, which only ever handled
        UNPUBLISHED rows sitting in the Client Task Queue. Once a task is
        assigned to a developer it is published, so that route could not touch
        it and there was no way to remove a task raised by mistake.

        The rule itself lives in kra.kpi._may_admin_delete so the board's
        can_admin_delete flag and this endpoint cannot drift apart.
        """
        user = request.env.user
        if not self._is_kra_admin(user):
            return {'status': False, 'message': 'Not authorized'}
        if not params.get('kpi_id'):
            return {'status': False, 'message': 'kpi_id missing'}
        kpi = request.env['kra.kpi'].sudo().browse(int(params['kpi_id']))
        if not kpi.exists():
            return {'status': False, 'message': 'Task not found'}
        ok, reason = kpi._may_admin_delete()
        if not ok:
            return {'status': False, 'message': reason}

        name = kpi.name or ''
        ref = kpi.external_ref or ''
        note = (params.get('reason') or '').strip()
        # Tell the people who were waiting on it BEFORE it disappears: the
        # developer it was published to, and the client who submitted it.
        # kpi_id is deliberately False on these rows — kpi.notification.kpi_id
        # is ondelete='cascade', so a notification pointing at this task would
        # be deleted along with it and nobody would ever see it. Detached also
        # means it isn't tappable, which is correct: the task is gone.
        Notif = request.env['kpi.notification'].sudo()
        targets = []
        if kpi.published and kpi.user_id:
            targets.append((kpi.user_id.id, 'developer'))
        if kpi.client_submitted and kpi.submitted_by_uid:
            targets.append((kpi.submitted_by_uid.id, 'client'))
        body = "🗑 Task removed by an admin.\n📌 %s %s\n" % (ref, name)
        if note:
            body += "💬 Reason: %s\n" % note
        for uid, role in targets:
            try:
                Notif.create({
                    'user_id': uid, 'kpi_id': False, 'event': 'task_deleted',
                    'role': role, 'title': 'Task removed', 'body': body,
                })
                # Push is an HTTP call, not a DB row, so it survives the unlink.
                kpi._send_push('task_deleted', 'Task removed', body, [uid])
            except Exception as exc:
                _logger.warning("admin_delete notify failed for kpi %s user %s: %s",
                                kpi.id, uid, exc)
        kpi.unlink()
        return {'status': True, 'message': 'Task deleted'}
    
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

    # How many audit entries the detail pane carries. A task worked over months
    # accumulates hundreds. The list lives in a scrollable popup rather than inline
    # now, so it can hold far more without pushing the pane around — each row is a
    # short dict, so 200 is still a small payload.
    ACTIVITY_LIMIT = 200

    def _estimate_history(self, kpi):
        """The estimate's chain: what it started at, then each extension.

        The card can only carry the latest reason, so the whole story lives here. The
        ORIGINAL estimate is the first entry's "from" — which is exactly why the
        extension route records from/to rather than only the delta.
        """
        out = []
        entries = request.env['kpi.action.log'].sudo().search(
            [('kpi_id', '=', kpi.id), ('event', '=', 'estimate_extended')], order='id asc')
        for n, e in enumerate(entries, start=1):
            try:
                p = json.loads(e.payload_json or '{}')
            except (ValueError, TypeError):
                p = {}
            if n == 1:
                out.append({'seq': 0, 'kind': 'original',
                            'value': p.get('from') or '00:00',
                            'reason': '', 'actor': '', 'at': ''})
            out.append({
                'seq': n, 'kind': 'extension',
                'value': '+%02d:%02d' % (p.get('added_hours') or 0, p.get('added_minutes') or 0),
                'running_total': p.get('to') or '',
                'reason': p.get('reason') or '',
                'actor': e.actor_label or (e.actor_user_id.name if e.actor_user_id else ''),
                'at': convert_to_user_tz(e.create_date) if e.create_date else '',
            })
        return out

    # Which events each log kind covers. The detail pane offers these as a dropdown
    # so a rename is not buried under hundreds of pause rows. Filtering happens HERE
    # and not in the browser: ACTIVITY_LIMIT slices the payload before the client
    # sees it, so filtering a mixed slice would silently drop older pause entries.
    ACTIVITY_KINDS = {
        'pause':   ['pause', 'resume', 'start_undone'],
        'heading': ['meta_updated', 'priority_changed'],
        # Every change to a task's time: estimate extended, yesterday reduced.
        'time':    ['estimate_extended', 'time_reduced'],
    }

    # Events whose raw key does not read well once underscores are stripped.
    ACTIVITY_LABELS = {
        'meta_updated': 'Renamed',
        'priority_changed': 'Priority changed',
        'start_undone': 'Start undone',
        'time_reduced': "Yesterday's time reduced",
        # 💬 Chat with the client (models/kpi_chat.py)
        'client_chat_message': 'Client message (Discuss)',
        'client_chat_reply': 'Reply to the client',
        'client_chat_forwarded': 'Client question sent to the developer',
        'client_chat_edited': 'Chat message edited',
        'client_chat_deleted': 'Chat message deleted',
    }

    def _activity_log(self, kpi, kind='all'):
        """Everything that happened to this task, newest first.

        A reader for the audit trail already being written on every start, pause,
        switch and extension — not new tracking. Capped, and the true total is returned
        alongside so the UI can say it is showing a slice rather than implying the task
        only ever had 50 events.

        `kind` narrows to one log ('pause', 'heading'); 'all' keeps every event.
        The cap applies per kind, so each log gets its own full window.
        """
        Log = request.env['kpi.action.log'].sudo()
        domain = [('kpi_id', '=', kpi.id)]
        events = self.ACTIVITY_KINDS.get(kind)
        if events:
            domain.append(('event', 'in', events))
        rows = Log.search(domain, order='id desc', limit=self.ACTIVITY_LIMIT)
        return {
            'activity_kind': kind,
            'activity_total': Log.search_count(domain),
            'activity_limit': self.ACTIVITY_LIMIT,
            'activity_log': [{
                'id': e.id,
                'event': e.event or '',
                'label': (self.ACTIVITY_LABELS.get(e.event)
                          or (e.event or '').replace('_', ' ').strip().capitalize()),
                'actor': e.actor_label or (e.actor_user_id.name if e.actor_user_id else ''),
                'at': convert_to_user_tz(e.create_date) if e.create_date else '',
                'detail': (e.payload_json or '')[:400],
                'success': e.success,
            } for e in rows],
        }

    @http.route('/kpi_action/activity', type='json', auth='user', methods=['POST'], csrf=False)
    def get_kpi_activity(self, **params):
        """One log at a time for the detail pane's log dropdown.

        The detail payload already ships the 'all' log, so this is only hit when the
        reader picks a specific kind — and it re-runs the search rather than filtering
        the slice the pane already has, which is the whole point (see ACTIVITY_KINDS).
        """
        try:
            kpi_id = int(params.get('kpi_id') or 0)
            if not kpi_id:
                return {'status': False, 'message': 'KPI id required.'}
            kpi = request.env['kra.kpi'].sudo().browse(kpi_id)
            if not kpi.exists():
                return {'status': False, 'message': 'Task not found.'}
            denied = self._may_view_kpi_details(kpi)
            if denied:
                return {'status': False, 'message': denied}
            kind = params.get('kind') or 'all'
            if kind != 'all' and kind not in self.ACTIVITY_KINDS:
                kind = 'all'
            payload = self._activity_log(kpi, kind=kind)
            payload['status'] = True
            return payload
        except Exception as e:
            _logger.error("get_kpi_activity failed: %s", e)
            return {'status': False, 'message': str(e)}

    # ------------------------------------------------------------------
    # 💬 Chat with the client (models/kpi_chat.py): the KPI details window
    # on Odoo, the web task panel (and the app later). Same check as the
    # details themselves.
    # ------------------------------------------------------------------
    def _chat_kpi(self, params):
        kpi_id = int(params.get('kpi_id') or 0)
        kpi = request.env['kra.kpi'].sudo().with_context(active_test=False).browse(kpi_id).exists() if kpi_id else None
        if not kpi:
            return None, 'Task not found.'
        denied = self._may_view_kpi_details(kpi)
        if denied and kpi.is_chat_general and self._general_chat_ok(kpi):
            denied = None
        if denied:
            return None, denied
        return kpi, None

    def _general_chat_ok(self, kpi):
        """A client's general questions (the hidden GEN task, no developer on
        it): admins, plus whoever its open question was put to — the
        developer picked to reply, or someone the Approval Chain asked."""
        user = request.env.user
        if self._is_kra_admin(user):
            return True
        doubts = request.env['kpi.doubt'].sudo().search([('kpi_id', '=', kpi.id), ('kind', '=', 'client_msg')])
        return user in (doubts.mapped('assigned_dev_id') | doubts.mapped('esc_asked_ids')
                        | doubts.mapped('manager_user_id'))

    @http.route('/kpi_action/chat/general_list', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_chat_general_list(self, **params):
        """💬 General questions: one row per client chat (the hidden GEN tasks)
        this person may open, the waiting ones first."""
        try:
            Kpi = request.env['kra.kpi'].sudo().with_context(active_test=False)
            Msg = request.env['kpi.chat.message'].sudo()
            rows = []
            for kpi in Kpi.search([('is_chat_general', '=', True)]):
                if not self._general_chat_ok(kpi):
                    continue
                last = Msg.search([('kpi_id', '=', kpi.id), ('deleted_at', '=', False)], order='id desc', limit=1)
                if not last:
                    continue
                said = last.body or ('📎 ' + ', '.join(last.file_ids.mapped('file_name')))
                rows.append({'kpi_id': kpi.id, 'ref': kpi._chat_ref(), 'code': kpi.external_ref or '',
                             'client': kpi.client_kra_id.name or kpi.kra_id.name or '',
                             'last': ' '.join((said or '').split())[:120], 'last_side': last.side,
                             'last_who': (last.author_user_id.name if last.side == 'team' else last.author_name) or '',
                             'at': fields.Datetime.to_string(last.create_date),
                             'waiting': kpi.chat_waiting()})
            # Waiting chats first, then the latest.
            rows.sort(key=lambda r: r['at'], reverse=True)
            rows.sort(key=lambda r: r['waiting'] == 0)
            return {'status': True, 'rows': rows, 'waiting': sum(1 for r in rows if r['waiting'])}
        except Exception as e:
            _logger.warning("kpi_chat_general_list failed: %s", e)
            return {'status': False, 'message': str(e)}

    # Events that already show as their own History items (chat, progress …),
    # so the Activity filter lists only what is not anywhere else.
    _HISTORY_SKIP_EVENTS = ('client_chat_message', 'client_chat_reply', 'client_chat_forwarded',
                            'client_chat_edited', 'client_chat_deleted')

    @http.route('/kpi_action/history', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_action_history(self, **params):
        """KPI Details › History: everything on one task in one list -- client
        chat, questions to the manager, progress, meetings, GitHub, manuals and
        the activity trail. Times are UTC ('YYYY-MM-DD HH:MM:SS'); the page
        groups them by day in the viewer's time zone."""
        try:
            kpi = request.env['kra.kpi'].sudo().with_context(active_test=False).browse(
                int(params.get('kpi_id') or 0)).exists()
            if not kpi:
                return {'status': False, 'message': 'Task not found.'}
            denied = self._may_view_kpi_details(kpi)
            if denied and not (kpi.is_chat_general and self._general_chat_ok(kpi)):
                return {'status': False, 'message': denied}
            env = request.env
            stamp = fields.Datetime.to_string
            out = []

            def add(kind, at, title, body='', who='', badge='', key=''):
                if at:
                    out.append({'kind': kind, 'at': stamp(at), 'title': title or '', 'body': (body or '')[:600],
                                'who': who or '', 'badge': badge or '', 'key': key})

            # Client chat: one item per talk (a back-and-forth), grouped exactly as
            # Client Talks › Discussions groups it (kpi_talks_api.talks_thread).
            from .kpi_talks_api import KpiTalksApi
            thread = KpiTalksApi().talks_thread(kpi_id=kpi.id)
            if thread.get('status'):
                sent = {r['id']: r['create_date'] for r in env['kpi.chat.message'].sudo().search_read(
                    [('kpi_id', '=', kpi.id)], ['create_date'])}
                for day in thread.get('days') or []:
                    for s in day.get('sessions') or []:
                        msgs = s.get('messages') or []
                        last = max((sent[x['id']] for x in msgs if sent.get(x['id'])), default=None)
                        if not last:
                            continue
                        status = s.get('status')
                        badge = ('● waiting' if status == 'waiting' else
                                 ('✓ answered' + (' by %s' % s['by'] if s.get('by') else '')) if status == 'answered'
                                 else '')
                        span = s['start'] if s.get('end') == s.get('start') else '%s – %s' % (s['start'], s['end'])
                        out.append({'kind': 'talk', 'at': stamp(last), 'title': 'Talk %d · %s' % (s['n'], span),
                                    'body': '', 'who': '', 'badge': badge, 'count': len(msgs), 'messages': msgs,
                                    'key': 't%s-%d' % (day.get('date'), s['n'])})
            for d in env['kpi.doubt'].sudo().search([('kpi_id', '=', kpi.id), ('kind', '!=', 'client_msg')],
                                                    order='id desc', limit=100):
                label = dict(d._fields['kind'].selection).get(d.kind, d.kind)
                body = d.question or ''
                if d.answer:
                    body += '\n→ %s: %s' % (d.answered_by_id.name or 'Answer', d.answer)
                add('question', d.create_date, label, body,
                    who=d.raised_by_id.name or d.raised_by_name or '',
                    badge=dict(d._fields['state'].selection).get(d.state, d.state), key='d%d' % d.id)
            for p in env['kpi.progress'].sudo().search([('kpi_id', '=', kpi.id)], order='id desc', limit=200):
                add('progress', p.create_date, 'Progress update' + (' · from the client' if p.from_client else ''),
                    p.summary, who=p.employee_name or '', badge='file' if p.uploaded_file else '', key='p%d' % p.id)
            for mt in env['kpi.meeting'].sudo().search([('kpi_id', '=', kpi.id)], order='id desc', limit=50):
                state = dict(mt._fields['state'].selection).get(mt.state, mt.state)
                bits = [x for x in (
                    ('%d min' % mt.actual_minutes) if mt.actual_minutes else '',
                    mt.participant_summary or '', (mt.summary or '')[:300]) if x]
                if not (mt.ended_at or mt.opened_at):
                    # Not held yet: listed on the day it was booked, saying when it is planned.
                    bits = [x for x in ('Planned: %s' % (mt.local_when or mt.requested_text or 'time not set'),) if x]
                add('meeting', mt.ended_at or mt.opened_at or mt.create_date,
                    'Meeting · %s' % (mt.name or ''), ' · '.join(bits[:2]) + (('\n' + bits[2]) if len(bits) > 2 else ''),
                    who=mt.organizer_id.name or '', badge=state, key='m%d' % mt.id)
            for g in env['kpi.github.link'].sudo().search([('kpi_id', '=', kpi.id)], order='id desc', limit=50):
                add('code', g.create_date, 'GitHub branch linked',
                    '%s · %s' % (g.github_url or '', (g.branch_name or '').strip()), who=g.employee_name or '',
                    key='g%d' % g.id)
            for u in env['kpi.user.manual'].sudo().search([('kpi_id', '=', kpi.id)], order='id desc', limit=50):
                add('document', u.upload_date or u.create_date, 'Manual uploaded',
                    ' · '.join(x for x in (u.file_name or '', u.description or '') if x),
                    who=u.uploader_name or '', key='u%d' % u.id)
            Log = env['kpi.action.log'].sudo()
            for e in Log.search([('kpi_id', '=', kpi.id), ('event', 'not in', self._HISTORY_SKIP_EVENTS)],
                                order='id desc', limit=150):
                add('activity', e.create_date,
                    self.ACTIVITY_LABELS.get(e.event) or (e.event or '').replace('_', ' ').strip().capitalize(),
                    who=e.actor_label or (e.actor_user_id.name if e.actor_user_id else ''), key='a%d' % e.id)
            out.sort(key=lambda r: r['at'], reverse=True)
            return {'status': True, 'items': out}
        except Exception as e:
            _logger.warning("kpi_action_history failed: %s", e)
            return {'status': False, 'message': str(e)}

    def _chat_payload(self, kpi):
        Report = request.env['kpi.wa.group.report'].sudo()
        user = request.env.user
        locked = kpi._details_locked_for(user)
        return {'status': True,
                'messages': kpi.chat_rows(viewer=user, admin=self._is_kra_admin(user)),
                'waiting': kpi.chat_waiting(),
                'can_send': bool(Report._group_for_kpi(kpi)),
                'locked': locked,
                'can_act': not locked,
                'ref': kpi.external_ref or kpi._chat_ref(),
                'client': kpi.client_kra_id.name or kpi.kra_id.name or ''}

    @http.route('/kpi_action/chat/act', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_chat_act(self, **params):
        """Long-press on a bubble: react / edit / delete (models/kpi_chat.py chat_act)."""
        try:
            kpi, err = self._chat_kpi(params)
            if err:
                return {'status': False, 'message': err}
            user = request.env.user
            locked = kpi._details_locked_for(user)
            if locked:
                return {'status': False, 'message': locked}
            kpi.chat_act(params.get('msg_id'), params.get('action') or '', 'u:%d' % user.id,
                         emoji=params.get('emoji'), text=params.get('text'),
                         admin=self._is_kra_admin(user))
            return self._chat_payload(kpi)
        except Exception as e:
            _logger.warning("kpi_chat_act failed: %s", e)
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_action/chat', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_chat_list(self, **params):
        try:
            kpi, err = self._chat_kpi(params)
            if err:
                return {'status': False, 'message': err}
            # mark_seen: the chat window is open and on screen (not the
            # count-only poll behind the 💬 button): the client's messages
            # become seen -- blue ✓✓ on their page.
            # active: also touched in the last minute = the team is online.
            if params.get('mark_seen'):
                kpi.chat_mark_seen('team', active=bool(params.get('active')))
            return self._chat_payload(kpi)
        except Exception as e:
            _logger.error("kpi_chat_list failed: %s", e)
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_action/chat/send', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_chat_send(self, **params):
        try:
            kpi, err = self._chat_kpi(params)
            if err:
                return {'status': False, 'message': err}
            locked = kpi._details_locked_for(request.env.user)
            if locked:
                return {'status': False, 'message': locked}
            source = params.get('source') if params.get('source') in ('odoo', 'web') else 'odoo'
            kpi.chat_post_team(params.get('text') or '', request.env.user, source=source,
                               reply_to=params.get('reply_to'))
            return self._chat_payload(kpi)
        except Exception as e:
            _logger.warning("kpi_chat_send failed: %s", e)
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_action/chat/send_files', type='http', auth='user', methods=['POST'], csrf=False)
    def kpi_chat_send_files(self, **params):
        """💬 📎 photos / videos / audio: multipart, field `files`, optional `text`."""
        from .kpi_client_chat import chat_upload_files
        try:
            kpi, err = self._chat_kpi(params)
            if err:
                return request.make_json_response({'status': False, 'message': err})
            locked = kpi._details_locked_for(request.env.user)
            if locked:
                return request.make_json_response({'status': False, 'message': locked})
            source = params.get('source') if params.get('source') in ('odoo', 'web') else 'odoo'
            kpi.chat_post_team(params.get('text') or '', request.env.user, source=source,
                               files=chat_upload_files(), reply_to=params.get('reply_to'))
            return request.make_json_response(self._chat_payload(kpi))
        except Exception as e:
            _logger.warning("kpi_chat_send_files failed: %s", e)
            return request.make_json_response({'status': False, 'message': str(e)})

    @http.route('/kpi_action/chat/retry', type='json', auth='user', methods=['POST'], csrf=False)
    def kpi_chat_retry(self, **params):
        """⚠ on a bubble: the WhatsApp note failed; send it again."""
        try:
            kpi, err = self._chat_kpi(params)
            if err:
                return {'status': False, 'message': err}
            kpi.chat_retry(params.get('message_id'))
            return self._chat_payload(kpi)
        except Exception as e:
            _logger.warning("kpi_chat_retry failed: %s", e)
            return {'status': False, 'message': str(e)}

    @http.route('/kpi/chat/file/<int:att_id>', type='http', auth='user', methods=['GET'], csrf=False)
    def kpi_chat_file(self, att_id, **kw):
        """One 📎 chat file, for anyone who may open that task's chat."""
        from .kpi_client_chat import _team_user_ok, chat_file_response
        att = request.env['kpi.file.attachment'].sudo().browse(att_id).exists()
        kpi = att.chat_message_id.kpi_id if att else None
        if not kpi:
            return request.not_found()
        if self._may_view_kpi_details(kpi) and not _team_user_ok(request.env.user):
            return request.not_found()
        return chat_file_response(kpi, att_id)

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

        # Project picker — EVERY KRA, grouped by client.
        #
        # It used to list only the descendants of this task's own root client, minus
        # the root itself. Two things were wrong with that: a task filed under the
        # wrong client could not be corrected here at all, and a task with no kra_id
        # got an empty dropdown — while the save route's guard, which only fires when
        # the task already HAS a root, happily let that same task go anywhere.
        #
        # Moving a task between clients is still the dangerous one, so it is not
        # silent: the save route asks for confirmation naming both clients (see
        # update_kpi_meta). Listing it and gating it beats hiding it.
        available_kras = []
        for k in request.env['kra.master'].sudo().search([]):
            path = []
            cur = k
            while cur:
                path.insert(0, cur.name or '')
                cur = cur.parent_id
            root = k
            while root.parent_id:
                root = root.parent_id
            available_kras.append({
                'id': k.id, 'name': k.name or '',
                'display': ' > '.join(path),
                # Drives the <optgroup> headings, and lets the client warn about a
                # client-crossing pick before it posts.
                'root_id': root.id,
                'root_name': root.name or '',
            })
        # Client, then path — so each group reads as a tree rather than id order.
        available_kras.sort(key=lambda a: (a['root_name'].lower(), a['display'].lower()))

        return {
            "id": kpi.id,
            "name": kpi.name or "",
            "kra": kpi.kra_id.name if kpi.kra_id else "",
            "kra_id": kpi.kra_id.id if kpi.kra_id else False,
            "type": kind,
            "deliverable_type": kpi.deliverable_type or "",
            "deliverable_other": kpi.deliverable_other or "",
            "deliverable_label": deliverable_type_label(kpi.deliverable_type, kpi.deliverable_other),
            "github_required": kpi._github_required(),
            "external_ref": kpi.external_ref or "",
            "is_manager": is_manager,
            # 🆕 Part B: gate the in-detail "Complete This Task" panel
            "task_state": kpi.task_state or "",
            # Progress updates, manuals, files and GitHub links are added only once
            # the task has been started, i.e. it has left the Regular / Important /
            # Urgent lanes. Everything else (assigned, rework, hold, pre-approval…)
            # sits in those lanes and must be started first — for everyone, admins
            # included. Rework counts as not started: it is picked up again by Start.
            "has_started": kpi.task_state in ('in_progress', 'paused', 'partially_completed',
                                              'awaiting_client', 'completed'),
            "is_assignee": bool(kpi.user_id and kpi.user_id.id == user.id),
            # Signed off by the client: why nothing more can be added ("" = can).
            "details_locked": kpi._details_locked_for(user),
            "available_kras": available_kras,
            "priority": kpi.priority or "",
            "estimate": f"{kpi.estimate_hours:02d}:{kpi.estimate_minutes:02d}",
            # How the estimate got here, and everything that has happened to the task.
            # Built by the shared helpers so the two detail routes cannot drift apart —
            # get_kpi_detail serves the same data and this is the one the web opens.
            "estimate_history": self._estimate_history(kpi),
            **self._activity_log(kpi),
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

            # Captured before the write so the audit row can say what it changed FROM.
            old_name = kpi.name or ''
            old_kra = kpi.kra_id.display_name if kpi.kra_id else ''

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
                # Crossing to another client is allowed, but never silently: it moves
                # one client's work into another client's project, and a mis-click in
                # a long dropdown looks identical to a deliberate move. This used to
                # be a flat refusal, which meant a task filed under the wrong client
                # could not be corrected here at all.
                #
                # The flag has to be sent explicitly, so any caller that does not know
                # about this gate still gets the old refusing behaviour rather than
                # moving tasks by accident.
                if old_root and new_root and old_root.id != new_root.id:
                    if not params.get('confirm_client_move'):
                        return {
                            'status': False,
                            'needs_confirm': True,
                            'from_client': old_root.name or '',
                            'to_client': new_root.name or '',
                            'message': 'This moves the task from "%s" to "%s".' % (
                                old_root.name or '', new_root.name or ''),
                        }
                updates['kra_id'] = kra_id

            if updates:
                kpi.write(updates)
                # A rename used to leave no trace at all — not in Activity, not
                # anywhere. Record it on the same audit trail every other lifecycle
                # event already writes to, so the detail pane's heading log has
                # something to read.
                request.env['kpi.action.log'].log(
                    kpi.id, 'meta_updated', source='web',
                    actor_user_id=user.id,
                    payload={
                        'name_from': old_name,
                        'name_to': kpi.name or '',
                        'kra_from': old_kra,
                        'kra_to': kpi.kra_id.display_name if kpi.kra_id else '',
                        'fields': list(updates.keys()),
                    },
                )

            return {'status': True, 'updated': list(updates.keys()),
                    'name': kpi.name, 'kra_id': kpi.kra_id.id if kpi.kra_id else False}
        except Exception as e:
            _logger.error(f"update_kpi_meta failed: {str(e)}")
            return {'status': False, 'message': str(e)}

    # The three to-do lanes. The board files a not-yet-started task by its
    # PRIORITY (laneForTask in the app, the same rule in kpi_action.js), whatever
    # its task_state — usually 'assigned', 'rework' or a pre_approval_* value.
    # Reassign is the one place task_state is set to the priority itself.
    PRIORITY_LANES = ('urgent', 'important', 'regular')
    # States with a lane of their own, where priority does not decide the lane.
    STATE_LANES = ('in_progress', 'paused', 'partially_completed',
                   'awaiting_client', 'completed')

    @http.route('/kpi_action/set_priority', type='json', auth='user', methods=['POST'], csrf=False)
    def set_kpi_priority(self, **params):
        """Manager-only: change a task's priority (the web board's lane drag).

        params: kpi_id, priority ('regular' | 'important' | 'urgent').

        Only `priority` is written, so the task's lifecycle never changes. A task
        still to be started moves to the new priority's lane, because that is how
        the board files it; `lane_moved` says so. In progress, paused, waiting on
        approval or the client, or done, it stays in its own lane. The one extra
        write is task_state, and only when it holds a priority value (left there
        by a reassign): it follows, so the two never disagree.
        """
        try:
            user = request.env.user
            is_manager = (
                user.has_group('kra_kpi_module.group_kra_admin')
                or user.has_group('kra_kpi_module.group_kra_manager')
                or user.has_group('base.group_system')
            )
            if not is_manager:
                return {'status': False, 'message': 'Only managers can change priority.'}

            try:
                kpi_id = int(params.get('kpi_id') or 0)
            except (TypeError, ValueError):
                kpi_id = 0
            if not kpi_id:
                return {'status': False, 'message': 'KPI id required.'}
            new = params.get('priority')
            if new not in self.PRIORITY_LANES:
                return {'status': False, 'message': 'Priority must be regular, important or urgent.'}
            kpi = request.env['kra.kpi'].sudo().browse(kpi_id)
            if not kpi.exists():
                return {'status': False, 'message': 'Task not found.'}

            old = kpi.priority or 'regular'
            if old == new:
                return {'status': True, 'changed': False, 'priority': new,
                        'previous_priority': old, 'task_state': kpi.task_state or '',
                        'lane_moved': False}

            state = kpi.task_state or ''
            vals = {'priority': new}
            if state in self.PRIORITY_LANES:
                vals['task_state'] = new
            # Same rule as the board: a self-created task awaiting Accept sits in
            # Pending Review, and the state lanes ignore priority.
            lane_moved = (state not in self.STATE_LANES
                          and not (kpi.is_self_created and not kpi.admin_accepted))
            kpi.write(vals)
            request.env['kpi.action.log'].log(
                kpi.id, 'priority_changed', source='web',
                actor_user_id=user.id,
                payload={'from': old, 'to': new, 'lane_moved': lane_moved,
                         'task_state': kpi.task_state or ''},
            )
            return {'status': True, 'changed': True, 'priority': new,
                    'previous_priority': old, 'task_state': kpi.task_state or '',
                    'lane_moved': lane_moved}
        except Exception as e:
            _logger.error(f"set_kpi_priority failed: {str(e)}")
            return {'status': False, 'message': str(e)}

    # PROGRESS UPDATE ENDPOINTS
    def _locked(self, kpi):
        """'' or why this task's details can no longer be changed (signed off by
        the client; admins excepted). kra.kpi._details_locked_for."""
        if not kpi:
            return ''
        return kpi.sudo()._details_locked_for(request.env.user)

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
            if self._locked(kpi):
                return {'status': False, 'message': self._locked(kpi)}
            
            progress = request.env['kpi.progress'].create({
                'kpi_id': int(kpi_id),
                'summary': summary,
                'uploaded_file': uploaded_file,
                'file_name': file_name,
                'related_links': related_links,
                'user_id': request.env.user.id,
            })

            # Multi-file callers send `files: [{file_data, file_name}, ...]`. The
            # scalar uploaded_file/file_name above still carries a single-file
            # caller (the mobile app), so both shapes work on the same route.
            extra_files = self._collect_upload_files(params, 'files', None, None)
            if extra_files:
                self._store_entry_files(progress, 'uploaded_file', extra_files)

            return {
                'status': True,
                'message': 'Progress update submitted successfully',
                'progress_id': progress.id,
                'file_count': len(extra_files) or (1 if uploaded_file else 0),
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
            # getlist, not get: the form now allows several files on one update.
            # A single-file post still lands here as a one-item list, so older
            # callers are unaffected.
            uploads = request.httprequest.files.getlist('file')
            if not kpi_id:
                return request.make_json_response({'status': False, 'message': 'kpi_id missing'})
            locked = self._locked(request.env['kra.kpi'].sudo().browse(int(kpi_id)).exists())
            if locked:
                return request.make_json_response({'status': False, 'message': locked})
            if not uploads:
                return request.make_json_response({'status': False, 'message': 'No file received'})
            files = []
            for f in uploads:
                data = f.read()
                # Per file, not per request: the cap exists because one screen
                # recording can be enormous, and summing them would refuse three
                # perfectly ordinary screenshots.
                if len(data) > MAX_UPLOAD_BYTES:
                    return request.make_json_response(
                        {'status': False,
                         'message': f'"{f.filename}" exceeds the 50 MB limit.'})
                files.append((f.filename, data))
            p = request.env['kpi.progress'].create({
                'kpi_id': int(kpi_id),
                'summary': summary,
                'related_links': related_links,
                'user_id': request.env.user.id,
            })
            self._store_entry_files(p, 'uploaded_file', files)
            return request.make_json_response({'status': True, 'id': p.id,
                                               'file_name': files[0][0],
                                               'file_count': len(files)})
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
                # Read the blob-presence ONCE — uploaded_file is attachment-backed,
                # so each test pulls the whole file off disk.
                has_file = bool(progress.uploaded_file)
                updates.append({
                    'id': progress.id,
                    'summary': progress.summary,
                    # file_name / has_file describe the entry's FIRST file and are
                    # kept for the app and anything else already reading them;
                    # `files` is the whole set.
                    'file_name': progress.file_name,
                    'has_file': has_file,
                    'files': self._entry_files_payload(
                        progress, 'uploaded_file', '/kpi/progress/download?progress_id=',
                        has_primary=has_file),
                    'employee_name': progress.employee_name,
                    'create_date': convert_to_user_tz(progress.create_date),
                    # '' until someone edits it (the board shows "Edited <time>").
                    'edited_at': convert_to_user_tz(progress.edited_at),
                    'user_id': progress.user_id.id,
                    'related_links': progress.related_links or '[]',
                    # Drives whether the row offers Edit / a delete checkbox. The
                    # server re-checks on every write and delete regardless — this
                    # only stops offering an action that would be refused.
                    'can_edit': self._may_edit_progress(progress),
                    # The client's own attachment (own "From the client" section).
                    'from_client': bool(progress.sudo().from_client),
                })

            return {
                'status': True,
                'updates': updates,
            }
        except Exception as e:
            _logger.error(f"Error fetching progress updates: {str(e)}")
            return {'status': False, 'message': str(e)}

    def _may_edit_progress(self, progress):
        """Own entry, or a manager/admin.

        Mirrors the record rules (progress_employee_own_rule is own-rows,
        progress_manager_all_rule is everything) so the UI and the ORM agree about
        who may touch what.
        """
        user = request.env.user
        if self._is_kra_admin(user):
            return True
        if user.has_group('kra_kpi_module.group_kra_manager') or user.has_group('base.group_system'):
            return True
        return progress.user_id.id == user.id

    @http.route('/kpi/progress/update', type='json', auth='user', methods=['POST'], csrf=False)
    def update_progress_update(self, **params):
        """Edit an existing progress entry.

        There was create and read and nothing else, so a mistyped progress note was
        permanent — the entry stood as written and the only way out was a manager
        deleting it, which they also could not do from the app.

        Takes the same fields the create form collects. Only keys actually present
        are written, so a caller sending just `summary` cannot blank the links.
        """
        try:
            progress_id = int(params.get('progress_id') or 0)
            if not progress_id:
                return {'status': False, 'message': 'progress_id is required'}
            progress = request.env['kpi.progress'].sudo().browse(progress_id)
            if not progress.exists():
                return {'status': False, 'message': 'Progress update not found'}
            if not self._may_edit_progress(progress):
                return {'status': False, 'message': 'Not authorized to edit this update.'}
            if self._locked(progress.kpi_id):
                return {'status': False, 'message': self._locked(progress.kpi_id)}

            vals = {}
            if 'summary' in params:
                summary = (params.get('summary') or '').strip()
                # summary is required on the model; an empty write would raise a
                # bare integrity error rather than say what was wrong.
                if not summary:
                    return {'status': False, 'message': 'Summary cannot be empty.'}
                vals['summary'] = summary
            if 'related_links' in params:
                vals['related_links'] = params.get('related_links') or '[]'
            # "Edited <time>" only for a real change: Save on an untouched form
            # must not mark the update as edited.
            changed = any((progress[k] or '') != (v or '') for k, v in vals.items())
            if vals:
                progress.write(vals)
            # Done AFTER the write, and through the promotion helper rather than by
            # blanking the fields: this used to set uploaded_file/file_name to False
            # and leave the kpi.file.attachment rows behind, so the entry went on
            # showing files the modal had just said were removed — and had no primary
            # left for the app or the /view, /download and file_b64 routes, all of
            # which read only the scalar field.
            if params.get('clear_file'):
                self._promote_next_file(progress, 'uploaded_file')
                changed = True
            if changed:
                progress.sudo().write({'edited_at': fields.Datetime.now()})
            return {'status': True, 'message': 'Progress update saved', 'id': progress.id}
        except Exception as e:
            _logger.error("update_progress_update failed: %s", str(e))
            return {'status': False, 'message': str(e)}

    @http.route('/kpi/task/files_index', type='json', auth='user', methods=['POST'], csrf=False)
    def task_files_index(self, **params):
        """Every file NAME on a task, whoever uploaded it, for the "already on
        this task" popup.

        /kpi/progress/list runs under the caller's record rules, and a developer
        only sees their OWN progress updates ("Employee: Own Progress Updates"),
        so a file the admin had put on the same task was invisible to them and a
        same-named upload went through with no warning. This answers the one
        question the popup asks — is that name taken, by whom, when — and nothing
        more: names and times, never the bytes, and only to someone who may view
        the task. can_edit says whether the caller may Replace that file.
        """
        try:
            kpi = request.env['kra.kpi'].sudo().browse(int(params.get('kpi_id') or 0))
            if not kpi.exists():
                return {'status': False, 'message': 'Task not found'}
            denied = self._may_view_kpi_details(kpi)
            if denied:
                return {'status': False, 'message': denied}
            out = []
            for p in request.env['kpi.progress'].sudo().search([('kpi_id', '=', kpi.id)]):
                can = bool(self._may_edit_progress(p))
                # file_name is written alongside uploaded_file, so it answers "has a
                # file" without pulling every blob off disk.
                for f in self._entry_files_payload(p, 'uploaded_file', '/kpi/progress/download?progress_id=',
                                                   has_primary=bool(p.file_name)):
                    out.append({'kind': 'progress', 'entry_id': p.id, 'attachment_id': f['id'],
                                'file_name': f['file_name'], 'uploaded_at': f['uploaded_at'],
                                'who': p.employee_name or '', 'can_edit': can})
            for m in request.env['kpi.user.manual'].sudo().search([('kpi_id', '=', kpi.id)]):
                can = bool(self._may_edit_manual(m))
                for f in self._entry_files_payload(m, 'manual_file', '/kpi/manual/download/',
                                                   has_primary=bool(m.file_name)):
                    out.append({'kind': 'manual', 'entry_id': m.id, 'attachment_id': f['id'],
                                'file_name': f['file_name'], 'uploaded_at': f['uploaded_at'],
                                'who': m.uploader_name or '', 'can_edit': can})
            return {'status': True, 'files': out}
        except Exception as e:
            _logger.error("task_files_index failed: %s", str(e))
            return {'status': False, 'message': str(e)}

    @http.route('/kpi/file/remove', type='json', auth='user', methods=['POST'], csrf=False)
    def remove_entry_file(self, **params):
        """Remove ONE file from a progress update or a manual: the board's
        "Replace" when a same-named file is uploaded to the task again.

        params: kind ('progress' | 'manual'), entry_id, attachment_id (0 = the
        entry's own file). Same permission as editing the entry, so only its
        uploader or an admin can replace it. A progress update keeps its note
        when its last file goes; a manual with no document left is deleted, as an
        empty manual entry has nothing to show.
        """
        try:
            kind = params.get('kind')
            entry_id = int(params.get('entry_id') or 0)
            att_id = int(params.get('attachment_id') or 0)
            if kind == 'progress':
                entry, field = request.env['kpi.progress'].sudo().browse(entry_id), 'uploaded_file'
                if not entry.exists():
                    return {'status': False, 'message': 'Update not found'}
                if not self._may_edit_progress(entry):
                    return {'status': False, 'message': 'Only the uploader or an admin can replace this file.'}
            elif kind == 'manual':
                entry, field = request.env['kpi.user.manual'].sudo().browse(entry_id), 'manual_file'
                if not entry.exists():
                    return {'status': False, 'message': 'Manual not found'}
                if not self._may_edit_manual(entry):
                    return {'status': False, 'message': 'Only the uploader or an admin can replace this file.'}
            else:
                return {'status': False, 'message': 'Unknown kind'}

            if att_id:
                att = request.env['kpi.file.attachment'].sudo().browse(att_id)
                parent, _pf = self._attachment_parent(att) if att.exists() else (None, None)
                if not parent or parent != entry:
                    return {'status': False, 'message': 'File not found on this entry'}
                att.unlink()
                left = True
            else:
                left = self._promote_next_file(entry, field)
            if not left and kind == 'manual' and not request.env['kpi.file.attachment'].sudo().search_count(
                    [('manual_id', '=', entry.id)]):
                entry.unlink()
            elif kind == 'progress':
                entry.write({'edited_at': fields.Datetime.now()})
            return {'status': True}
        except Exception as e:
            _logger.error("remove_entry_file failed: %s", str(e))
            return {'status': False, 'message': str(e)}

    @http.route('/kpi/progress/delete', type='json', auth='user', methods=['POST'], csrf=False)
    def delete_progress_update(self, **params):
        """Remove one progress entry (own, or any as a manager)."""
        try:
            progress_id = int(params.get('progress_id') or 0)
            if not progress_id:
                return {'status': False, 'message': 'progress_id is required'}
            progress = request.env['kpi.progress'].sudo().browse(progress_id)
            if not progress.exists():
                return {'status': False, 'message': 'Progress update not found'}
            if not self._may_edit_progress(progress):
                return {'status': False, 'message': 'Not authorized to delete this update.'}
            if self._locked(progress.kpi_id):
                return {'status': False, 'message': self._locked(progress.kpi_id)}
            progress.unlink()
            return {'status': True, 'message': 'Progress update deleted'}
        except Exception as e:
            _logger.error("delete_progress_update failed: %s", str(e))
            return {'status': False, 'message': str(e)}

    @http.route('/kpi/progress/delete_bulk', type='json', auth='user', methods=['POST'], csrf=False)
    def delete_progress_updates(self, **params):
        """Select-all / delete-selected for Progress History.

        Deletes what the caller is allowed to and REPORTS what it refused rather
        than failing the whole batch: a manager clearing a task's history and a
        developer clearing their own rows out of the same list is the normal case,
        and silently dropping the request because one row belonged to someone else
        would be worse than doing the part that is permitted.
        """
        try:
            raw_ids = params.get('progress_ids') or []
            ids = [int(i) for i in raw_ids if str(i).strip().isdigit()]
            if not ids:
                return {'status': False, 'message': 'No entries selected.'}
            records = request.env['kpi.progress'].sudo().browse(ids).exists()
            allowed = records.filtered(lambda p: self._may_edit_progress(p) and not self._locked(p.kpi_id))
            refused = len(records) - len(allowed)
            deleted = len(allowed)
            if allowed:
                allowed.unlink()
            return {'status': True, 'deleted': deleted, 'refused': refused,
                    'missing': len(ids) - len(records)}
        except Exception as e:
            _logger.error("delete_progress_updates failed: %s", str(e))
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
        # An entry can now hold more than one file: the first lives on the entry's
        # own Binary field, the 2nd..Nth are kpi.file.attachment rows, and
        # attachment_id asks for one of those. The app cannot use the
        # /kpi/attachment/download route that serves them on the web — it is
        # type='http', and per the note above an app request carries no session
        # cookie — so the extra files need the same authenticated JSON door the
        # first one already has.
        att_id = int(params.get('attachment_id') or 0)
        if att_id:
            att = request.env['kpi.file.attachment'].sudo().browse(att_id)
            if not att.exists() or not att.file:
                return {'status': False, 'message': 'File not found'}
            parent, _pf = self._attachment_parent(att)
            if not parent:
                return {'status': False, 'message': 'File not found'}
            # Gated on the parent TASK exactly as the primary file is — an
            # attachment must not be readable where its task is not.
            denied = self._may_view_kpi_details(parent.kpi_id)
            if denied:
                return {'status': False, 'message': denied}
            file_name = att.file_name or 'file'
            mime_type = (att.mimetype or mimetypes.guess_type(file_name)[0]
                         or 'application/octet-stream')
            data_b64 = att.file
            if isinstance(data_b64, bytes):
                data_b64 = data_b64.decode()
            return {
                'status': True,
                'file_name': file_name,
                'mimetype': mime_type,
                'data_b64': data_b64,
                'size': len(base64.b64decode(att.file)),
            }

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
            # sudo + the task's own rule, exactly as /kpi/progress/file_b64:
            # admin/coordinator any task, developer only tasks they are on,
            # client never; the uploader may always read their own. Without sudo
            # the progress record rules hid every
            # row but the caller's own, so an admin got 404 on a teammate's file.
            progress = request.env['kpi.progress'].sudo().browse(int(progress_id))
            if not progress.exists() or not progress.uploaded_file:
                return request.not_found()
            if (progress.user_id.id != request.env.uid
                    and self._may_view_kpi_details(progress.kpi_id)):
                return request.not_found()
            
            return serve_file(base64.b64decode(progress.uploaded_file),
                              progress.file_name or 'file', inline=True)
            
        except Exception as e:
            _logger.error(f"Error viewing progress file: {str(e)}")
            return request.not_found()
    @http.route('/kpi/progress/download', type='http', auth='user', methods=['GET'])
    def download_progress_file(self, progress_id, **kwargs):
        """Download a progress update file"""
        try:
            # sudo + the task's own rule, exactly as /kpi/progress/file_b64:
            # admin/coordinator any task, developer only tasks they are on,
            # client never; the uploader may always read their own. Without sudo
            # the progress record rules hid every
            # row but the caller's own, so an admin got 404 on a teammate's file.
            progress = request.env['kpi.progress'].sudo().browse(int(progress_id))
            if not progress.exists() or not progress.uploaded_file:
                return request.not_found()
            if (progress.user_id.id != request.env.uid
                    and self._may_view_kpi_details(progress.kpi_id)):
                return request.not_found()
            
            # ?inline=1: show it in the browser (the View popup) instead of saving.
            return serve_file(base64.b64decode(progress.uploaded_file),
                              progress.file_name or 'download',
                              inline=kwargs.get('inline') in ('1', 'true'))
        except Exception as e:
            _logger.error(f"Error downloading file: {str(e)}")
            return request.not_found()

    # ============================================
    # Multi-file attachments on one entry
    # ============================================
    # Progress notes and task manuals were one-file-per-row, so attaching three
    # screenshots to a single note meant writing the same note three times. These
    # helpers put N files on ONE entry.
    #
    # The split is deliberate: the FIRST file stays on the parent's own Binary
    # field, the rest become kpi.file.attachment rows. Every existing reader — the
    # /view and /download routes, the file_b64 routes, and the mobile app, which is
    # not being changed — reads those scalar fields, so old entries and old clients
    # keep working untouched.

    @staticmethod
    def _collect_upload_files(params, files_key, single_data_key, single_name_key):
        """Normalise a JSON payload's file(s) into [(name, raw_bytes)].

        Accepts the new `files: [{file_data, file_name}, ...]` list AND the original
        scalar pair, so callers that predate multi-upload (the app) are unaffected.
        """
        out = []
        for entry in (params.get(files_key) or []):
            if not isinstance(entry, dict):
                continue
            data_b64 = entry.get('file_data') or entry.get('data') or ''
            name = entry.get('file_name') or entry.get('name') or 'file'
            if not data_b64:
                continue
            try:
                out.append((name, base64.b64decode(data_b64)))
            except Exception:
                continue
        if not out and single_data_key and params.get(single_data_key):
            try:
                out.append((params.get(single_name_key) or 'file',
                            base64.b64decode(params.get(single_data_key))))
            except Exception:
                pass
        return out

    def _store_entry_files(self, record, primary_field, files):
        """Write [(name, raw_bytes)] onto one entry.

        files[0] goes on `primary_field` (+ file_name) so the entry still reads
        correctly to everything that knows nothing about kpi.file.attachment;
        files[1:] become attachment rows in pick order.
        """
        if not files:
            return 0
        first_name, first_data = files[0]
        record.sudo().write({
            primary_field: base64.b64encode(first_data),
            'file_name': first_name,
            'file_at': fields.Datetime.now(),
        })
        if len(files) == 1:
            return 1
        link = 'progress_id' if record._name == 'kpi.progress' else 'manual_id'
        Att = request.env['kpi.file.attachment'].sudo()
        seq = 10
        for name, data in files[1:]:
            seq += 10
            Att.create({
                link: record.id,
                'file': base64.b64encode(data),
                'file_name': name,
                'sequence': seq,
            })
        return len(files)

    def _promote_next_file(self, record, primary_field):
        """Move the entry's next attachment onto its own Binary field.

        Needed whenever the PRIMARY file goes away. The entry's first file lives on
        `primary_field` and everything that is not this web UI — the mobile app and
        the /view, /download and file_b64 routes — reads only that field. So an
        entry left holding kpi.file.attachment rows with an empty primary is not a
        smaller entry, it is a broken one: the web shows files that every other
        client reports as absent.

        Returns True when a file was promoted, False when the entry is now empty.
        """
        link = 'progress_id' if record._name == 'kpi.progress' else 'manual_id'
        nxt = request.env['kpi.file.attachment'].sudo().search(
            [(link, '=', record.id)], order='sequence, id', limit=1)
        if not nxt:
            record.sudo().write({primary_field: False, 'file_name': False, 'file_at': False})
            return False
        # The promoted file keeps its own saved time, not the entry's.
        record.sudo().write({primary_field: nxt.file, 'file_name': nxt.file_name,
                             'file_at': nxt.create_date})
        nxt.unlink()
        return True

    def _attachment_parent(self, att):
        """The entry an attachment hangs off, as (record, primary_field)."""
        if att.progress_id:
            return att.progress_id, 'uploaded_file'
        if att.manual_id:
            return att.manual_id, 'manual_file'
        return None, None

    def _entry_files_payload(self, record, primary_field, download_route, has_primary=None):
        """Every file on an entry as [{id, file_name, url, uploaded_at}].

        The parent's own file is id 0 — it is served by the entry's existing
        download route, not by an attachment id. uploaded_at is each file's own
        saved time, in the viewer's timezone: file_at for the parent's file
        (falling back to when the entry was made, for rows older than file_at),
        the attachment row's create_date for the rest.

        `has_primary` lets a caller that has already tested the field pass the
        answer in. Binary fields are attachment-backed, so reading one pulls the
        whole file just to ask whether it is there — twice per row, in a list of
        fifty updates, for nothing.
        """
        out = []
        if has_primary is None:
            has_primary = bool(record[primary_field])
        if has_primary:
            made = record.upload_date if record._name == 'kpi.user.manual' else record.create_date
            out.append({
                'id': 0,
                'file_name': record.file_name or 'download',
                'url': '%s%s' % (download_route, record.id),
                'uploaded_at': convert_to_user_tz(record.file_at or made),
            })
        link = 'progress_id' if record._name == 'kpi.progress' else 'manual_id'
        extras = request.env['kpi.file.attachment'].sudo().search(
            [(link, '=', record.id)], order='sequence, id')
        for att in extras:
            out.append({
                'id': att.id,
                'file_name': att.file_name or 'download',
                'url': '/kpi/attachment/download?attachment_id=%s' % att.id,
                'uploaded_at': convert_to_user_tz(att.create_date),
            })
        return out

    @http.route('/kpi/attachment/download', type='http', auth='user', methods=['GET'])
    def download_entry_attachment(self, attachment_id, **kwargs):
        """Download one of an entry's extra files.

        The entry's FIRST file keeps its existing per-entry route; this serves the
        2nd..Nth, which have no entry id of their own to be addressed by.

        Gated on the parent TASK's visibility, not merely on being logged in. Without
        that check this route handed any authenticated user any attachment they could
        guess an id for — the sequential-integer id makes that trivial — while its
        sibling /kpi/progress/file_b64 has always gated on the same rule.
        404 rather than a refusal, so it does not confirm which ids exist.
        """
        try:
            att = request.env['kpi.file.attachment'].sudo().browse(int(attachment_id))
            if not att.exists() or not att.file:
                return request.not_found()
            parent, _primary = self._attachment_parent(att)
            if not parent or not parent.exists():
                return request.not_found()
            if self._may_view_kpi_details(parent.kpi_id):
                return request.not_found()
            # ?inline=1: show it in the browser (the View popup) instead of saving.
            return serve_file(base64.b64decode(att.file), att.file_name or 'download',
                              _guess_mime(att.file_name, att.mimetype or ''),
                              inline=kwargs.get('inline') in ('1', 'true'))
        except Exception as e:
            _logger.error("download_entry_attachment failed: %s", str(e))
            return request.not_found()

    # ============================================
    # 📚 UPDATED: Multiple User Manuals API
    # ============================================

    # Documents only, matching the "Supported: PDF, DOC, DOCX" the form promises.
    # The <input accept="..."> attribute is a filter, not a rule — a file dragged
    # in or posted directly bypasses it entirely.
    _MANUAL_EXTENSIONS = ('.pdf', '.doc', '.docx')
    # Manuals are documents. The 50 MB progress cap exists for screen recordings;
    # nothing here needs it, and the JSON route below carries the file as base64,
    # which inflates it by a third on the wire.
    _MANUAL_MAX_BYTES = 25 * 1024 * 1024

    def _check_manual_upload(self, kpi_id, file_name, size_bytes):
        """Shared gate for both manual-upload routes.

        Returns (kpi, None) when the upload may proceed, else (None, message).
        Both routes call this so the multipart and JSON paths cannot drift into
        accepting different files.
        """
        if not kpi_id:
            return None, 'KPI ID is required'
        try:
            kpi = request.env['kra.kpi'].sudo().browse(int(kpi_id))
        except (TypeError, ValueError):
            return None, 'KPI ID is invalid'
        if not kpi.exists():
            return None, 'KPI not found'
        # This route wrote to any task id it was handed, with no check that the
        # caller had anything to do with it. Same rule the detail view uses.
        denied = self._may_view_kpi_details(kpi)
        if denied:
            return None, denied
        name = (file_name or '').strip()
        if not name:
            return None, 'A file name is required'
        if not name.lower().endswith(self._MANUAL_EXTENSIONS):
            return None, 'Only PDF, DOC and DOCX files can be uploaded as a manual.'
        if size_bytes > self._MANUAL_MAX_BYTES:
            return None, 'File exceeds the %d MB limit.' % (self._MANUAL_MAX_BYTES // (1024 * 1024))
        if not size_bytes:
            return None, 'The file is empty.'
        return kpi, None

    @http.route('/kpi/manual/upload', type='json', auth='user', methods=['POST'], csrf=False)
    def upload_user_manual(self, **params):
        """Upload a new user manual for a KPI task (base64-in-JSON).

        Kept for the mobile app, which posts base64. The web uses the multipart
        route below so it can report real progress and get a clean 413.
        """
        try:
            kpi_id = params.get('kpi_id')
            file_data = params.get('file_data')
            file_name = params.get('file_name')
            description = params.get('description', '')
            related_links = params.get('related_links', '[]')
            if kpi_id:
                locked = self._locked(request.env['kra.kpi'].sudo().browse(int(kpi_id)).exists())
                if locked:
                    return {'status': False, 'message': locked}

            # Accepts the new `files: [{file_data, file_name}, ...]` list as well as
            # the original scalar pair, so the mobile app's single-file posts keep
            # working on the same route.
            files = self._collect_upload_files(params, 'files', 'file_data', 'file_name')
            if not files:
                return {'status': False, 'message': 'A file is required'}
            # The scalar path used to decode with validate=True to prove the base64
            # was intact — a truncated read was stored happily and then 404'd on
            # view. _collect_upload_files drops anything that will not decode, so
            # an empty result here means exactly that.
            if file_data and len(files) == 1 and not files[0][1]:
                return {'status': False, 'message': 'The file could not be read. Please pick it again.'}

            # Validated per file: the extension and size rules are about a file,
            # not about a request, and one bad file should name itself.
            kpi = None
            for name, raw in files:
                kpi, err = self._check_manual_upload(kpi_id, name, len(raw))
                if err:
                    return {'status': False, 'message': err}

            manual = request.env['kpi.user.manual'].create({
                'kpi_id': kpi.id,
                'description': description,
                'related_links': related_links,
                'uploaded_by': request.env.user.id,
                'upload_date': fields.Datetime.now(),
            })
            self._store_entry_files(manual, 'manual_file', files)

            return {
                'status': True,
                'message': 'User manual uploaded successfully',
                'manual_id': manual.id,
                'file_count': len(files),
            }
        except Exception as e:
            _logger.error(f"Error uploading user manual: {str(e)}")
            return {'status': False, 'message': str(e)}

    # Upload Requirements / Updates / Bug Reports: "Add photos / video". Each
    # file hangs off the task just created, with the reason it was attached.
    # It used to go through /kpi/manual/upload, which takes PDF / DOC / DOCX
    # only, so every photo was refused. Stored as a kpi.user.manual flagged
    # is_intake_media (the queue screens read them from there) and never
    # counted as the task's user manual.
    _INTAKE_MEDIA_MAX_VIDEO = 10 * 1024 * 1024

    @http.route('/kpi_requirements/attach_media', type='json', auth='user', methods=['POST'], csrf=False)
    def attach_intake_media(self, **params):
        try:
            from ..models.kpi_chat import chat_file_kind, CHAT_FILE_MAX_BYTES
            kpi_id = params.get('kpi_id')
            description = (params.get('description') or '').strip()
            if not description:
                return {'status': False, 'message': 'Say why you are attaching this.'}
            try:
                kpi = request.env['kra.kpi'].sudo().with_context(active_test=False).browse(int(kpi_id or 0)).exists()
            except (TypeError, ValueError):
                kpi = None
            if not kpi:
                return {'status': False, 'message': 'KPI not found'}
            user = request.env.user
            # The person who just created it (admin, coordinator or the client
            # filing it), or an admin later.
            if not (self._is_kra_admin(user) or kpi.submitted_by_uid == user or kpi.create_uid == user):
                return {'status': False, 'message': 'Not authorized'}
            files = self._collect_upload_files(params, 'files', 'file_data', 'file_name')
            if not files or not files[0][1]:
                return {'status': False, 'message': 'The file could not be read. Please pick it again.'}
            for name, raw in files:
                kind = chat_file_kind(name)
                if kind not in ('image', 'video'):
                    return {'status': False, 'message': '"%s": only a photo or a video can be attached here.' % (name or 'File')}
                limit = self._INTAKE_MEDIA_MAX_VIDEO if kind == 'video' else CHAT_FILE_MAX_BYTES
                if len(raw) > limit:
                    return {'status': False, 'message': '"%s" is too big (max %d MB).' % (name or 'File', limit // (1024 * 1024))}
            media = request.env['kpi.user.manual'].sudo().create({
                'kpi_id': kpi.id,
                'description': description,
                'related_links': '[]',
                'uploaded_by': user.id,
                'upload_date': fields.Datetime.now(),
                'is_intake_media': True,
            })
            self._store_entry_files(media, 'manual_file', files)
            return {'status': True, 'message': 'Attached', 'manual_id': media.id}
        except Exception as e:
            _logger.error("attach_intake_media: %s", e)
            return {'status': False, 'message': str(e)}

    @http.route('/kpi/manual/upload_file', type='http', auth='user', methods=['POST'], csrf=False)
    def upload_user_manual_file(self, **params):
        """Multipart twin of /kpi/manual/upload.

        The manual form used to post base64 inside a JSON-RPC call: no progress
        events, a third more bytes on the wire, and a proxy 413 that surfaced as
        a bare "Failed to upload user manual". This mirrors
        /kpi/progress/upload_file, which has always done it properly.
        """
        try:
            kpi_id = params.get('kpi_id')
            description = params.get('description') or ''
            related_links = params.get('related_links') or '[]'
            # getlist, not get — one manual entry can carry several documents now.
            uploads = request.httprequest.files.getlist('file')
            if not uploads:
                return request.make_json_response({'status': False, 'message': 'No file received'})

            files = []
            kpi = None
            for f in uploads:
                data = f.read()
                # Per file: the extension and size rules describe a file, and a
                # refusal should name which one was wrong.
                kpi, err = self._check_manual_upload(kpi_id, f.filename, len(data))
                if err:
                    return request.make_json_response({'status': False, 'message': err})
                if self._locked(kpi):
                    return request.make_json_response({'status': False, 'message': self._locked(kpi)})
                files.append((f.filename, data))

            manual = request.env['kpi.user.manual'].create({
                'kpi_id': kpi.id,
                'description': description,
                'related_links': related_links,
                'uploaded_by': request.env.user.id,
                'upload_date': fields.Datetime.now(),
            })
            self._store_entry_files(manual, 'manual_file', files)
            return request.make_json_response({
                'status': True,
                'message': 'User manual uploaded successfully',
                'manual_id': manual.id,
                'file_count': len(files),
            })
        except Exception as e:
            _logger.error("upload_user_manual_file failed: %s", str(e))
            return request.make_json_response({'status': False, 'message': str(e)})

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
                    # file_name is the entry's first file, kept for existing readers;
                    # `files` is every document on the entry.
                    'file_name': manual.file_name,
                    # file_name stands in for "has a file" so this list does not pull
                    # every manual's bytes off disk just to decide whether to list
                    # it — every writer of manual_file sets file_name alongside it.
                    'files': self._entry_files_payload(
                        manual, 'manual_file', '/kpi/manual/download/',
                        has_primary=bool(manual.file_name)),
                    # Whether to offer Delete at all — the button used to render for
                    # everyone and the route then refused them.
                    'can_edit': self._may_edit_manual(manual),
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
        # A manual can hold more than one document: the first lives on the entry's
        # own Binary field, the 2nd..Nth are kpi.file.attachment rows.
        # `attachment_id` asks for one of those. Same branch as the sibling
        # /kpi/progress/file_b64, and for the same reason — the web serves these
        # over /kpi/attachment/download, which is type='http' and useless to an app
        # request carrying no session cookie.
        att_id = int(params.get('attachment_id') or 0)
        if att_id:
            att = request.env['kpi.file.attachment'].sudo().browse(att_id)
            if not att.exists() or not att.file:
                return {'status': False, 'message': 'File not found'}
            parent, _pf = self._attachment_parent(att)
            if not parent:
                return {'status': False, 'message': 'File not found'}
            # Gated on the parent TASK exactly as the primary file is.
            denied = self._may_view_kpi_details(parent.kpi_id)
            if denied:
                return {'status': False, 'message': denied}
            file_name = att.file_name or 'manual'
            mime_type = (att.mimetype or mimetypes.guess_type(file_name)[0]
                         or 'application/octet-stream')
            data_b64 = att.file
            if isinstance(data_b64, bytes):
                data_b64 = data_b64.decode()
            return {
                'status': True,
                'file_name': file_name,
                'mimetype': mime_type,
                'data_b64': data_b64,
                'size': len(base64.b64decode(att.file)),
            }

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
            
            return serve_file(base64.b64decode(manual.manual_file),
                              manual.file_name or 'manual.pdf', inline=True)
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

    def _may_edit_manual(self, manual):
        """Own upload, or an admin. Mirrors _may_edit_progress for the manual side."""
        user = request.env.user
        if self._is_kra_admin(user):
            return True
        return bool(manual.uploaded_by and manual.uploaded_by.id == user.id)

    @http.route('/kpi/manual/delete', type='json', auth='user', methods=['POST'], csrf=False)
    def delete_user_manual(self, **params):
        """Delete a user manual — its uploader, or an admin.

        The route originally had no role check at all, and ir.model.access.csv
        grants base.group_user full CRUD on kpi.user.manual INCLUDING unlink, so
        any employee could delete any manual; it was then locked to admins only.
        That over-corrected: the person who had just uploaded the wrong document
        could not remove it either, and had to find an admin to undo their own
        mistake. Own uploads are now theirs to delete; everything else still needs
        an admin. The ACL stays as-is — this route remains the gate.
        """
        try:
            manual_id = params.get('manual_id')
            if not manual_id:
                return {'status': False, 'message': 'manual_id is required'}

            manual = request.env['kpi.user.manual'].sudo().browse(int(manual_id))
            if not manual.exists():
                return {'status': False, 'message': 'Manual not found'}
            if not self._may_edit_manual(manual):
                return {'status': False, 'message': 'Not authorized'}
            if self._locked(manual.kpi_id):
                return {'status': False, 'message': self._locked(manual.kpi_id)}

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
        # Renames run under sudo() below, so the role check has to live here.
        if not self._is_kra_admin(request.env.user):
            return {"status": False, "message": "Admin only."}
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
            locked = self._locked(request.env['kra.kpi'].sudo().browse(int(kpi_id)).exists())
            if locked:
                return {'status': False, 'message': locked}

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

            # The same repo + branch twice on one task is a duplicate, however it
            # was typed (http/https, www., trailing / or .git, case). The Odoo board
            # warns while pasting; this is the rule for every client, the web and
            # the phone included. Another branch of the same repo is allowed.
            repo, branch = _github_key(github_url), branch_name.strip().lower()
            for old in request.env['kpi.github.link'].sudo().search([('kpi_id', '=', kpi.id)]):
                if _github_key(old.github_url) == repo and (old.branch_name or '').strip().lower() == branch:
                    return {
                        'status': False, 'duplicate': True,
                        'message': 'This GitHub link is already on the task: added by %s on %s (branch %s).' % (
                            old.employee_name or (old.user_id.name or 'someone'),
                            convert_to_user_tz(old.create_date), old.branch_name or ''),
                    }

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
            if self._locked(link.sudo().kpi_id):
                return {'status': False, 'message': self._locked(link.sudo().kpi_id)}

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
        """Tasks + their document counts, SCOPED to what the caller may see.

        Admin / coordinator / owner: every task. Everyone else: only tasks they
        are actually on — effective_contributor_ids unions the assignee with the
        contributor and role lists, the same rule _may_view_kpi_details applies
        to a single task.

        This used to be `sudo().search([])` — every task belonging to everybody,
        for any logged-in user. The sudo() is what did the damage: it bypassed the
        employee record rule that already scopes kra.kpi to your own published
        tasks, so a developer opening Task Related Documents saw the whole
        company's task list, assignee names included.
        """
        try:
            user = request.env.user
            is_admin = self._is_kra_admin(user)
            # ✅ Get filter parameter
            assignee_id = params.get('assignee_id')

            # Build domain
            domain = []
            if assignee_id:
                domain.append(('user_id', '=', int(assignee_id)))
            if not is_admin:
                # A client has no business in the internal task list at all —
                # same stance _may_view_kpi_details takes.
                if user.has_group('kra_kpi_module.group_kra_client'):
                    return {'status': True, 'tasks': [], 'assignees': []}
                # This read `('effective_contributor_ids', 'in', [user.id])`, and
                # that field is a NON-STORED compute (kpi.py:135) with no search=
                # method. Odoo raised "Cannot convert ... to SQL because it is not
                # stored", the bare except below turned it into
                # {'status': False, 'tasks': []}, and the component only assigns
                # state when status is true — so every developer got the ordinary
                # "no tasks match your filters" empty screen with no error, while
                # admins (who skip this branch entirely) saw everything and had no
                # reason to suspect it.
                #
                # Expanded to the STORED fields _compute_effective_contributors
                # unions, which is the same set expressed in a searchable way.
                domain += ['|', '|', '|', '|', '|',
                           ('user_id', '=', user.id),
                           ('contributor_ids', 'in', [user.id]),
                           ('developer_ids', 'in', [user.id]),
                           ('tester_ids', 'in', [user.id]),
                           ('coordinator_ids', 'in', [user.id]),
                           ('lead_ids', 'in', [user.id])]

            kpis = request.env['kra.kpi'].sudo().search(domain)

            # sudo() on the counts below is deliberate and load-bearing:
            # progress_employee_own_rule restricts kpi.progress to your OWN rows,
            # so without it a task whose files a COLLEAGUE attached reported "No
            # Attachments" — while /task_documents/details, which is sudo'd,
            # then listed them. The list and the detail actively disagreed.
            Progress = request.env['kpi.progress'].sudo()
            Github = request.env['kpi.github.link'].sudo()
            Manual = request.env['kpi.user.manual'].sudo()

            tasks = []
            for kpi in kpis:
                # Count documents
                progress_files = Progress.search([
                    ('kpi_id', '=', kpi.id),
                    ('uploaded_file', '!=', False)
                ])

                github_links = Github.search([
                    ('kpi_id', '=', kpi.id)
                ])

                user_manuals = Manual.search([
                    ('kpi_id', '=', kpi.id)
                ])

                # Count links from progress updates
                progress_with_links = Progress.search([
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
                    # The clients render this as the row's ref chip and search on
                    # it; it was never in this payload, so the chip was blank on
                    # every row and that arm of the search could never match.
                    'external_ref': kpi.external_ref or '',
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
            
            # Assignee filter options. Built from the tasks ACTUALLY RETURNED, not
            # from sudo().search([]) — that listed every assignee in the company to
            # every developer, which is the same leak the scoping above exists to
            # close, just via the dropdown instead of the list.
            seen = {}
            for kpi in kpis:
                if kpi.user_id:
                    seen[kpi.user_id.id] = kpi.user_id.name
            assignees = sorted(({'id': k, 'name': v} for k, v in seen.items()),
                               key=lambda x: (x['name'] or '').lower())

            return {
                'status': True,
                'tasks': tasks,
                'assignees': assignees,
            }
        except Exception as e:
            # Log the traceback, not just str(e). A bare message here is what let
            # the non-stored-field ValueError above hide for so long: the screen
            # rendered its ordinary empty state and the log line said nothing
            # about where it came from.
            _logger.exception("Error in get_task_documents_list: %s", e)
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
            # Scope check, not just existence: this browses by id under sudo(), so
            # without it any logged-in user could read any task's files, links and
            # manuals by guessing an id — the list being filtered is no protection
            # when the detail route answers for anything.
            _denied = self._may_view_kpi_details(kpi)
            if _denied:
                return {'status': False, 'message': _denied}

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
                    'from_client': bool(prog.from_client),
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
                    'legacy_req_link': bool(getattr(kpi, 'legacy_req_link', False)), 'legacy_status': getattr(kpi, 'legacy_status', '') or '',
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
        # Every employee's tasks, hours and pause reasons, read under sudo(): an
        # admin's view, so an admin's route. It had no check, so any signed-in
        # client could pull the whole team's day.
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
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
            # Completed in the period = approved in it (approval_date, set when the
            # task reaches completed); older rows without one fall back to
            # write_date. The same rule as the Dashboard
            # (/kra_kpi/dashboard/overview), so the assistant and the cards agree:
            # write_date alone moved a task into "today" whenever anyone touched it.
            completed_domain = [
                ('task_state', '=', 'completed'),
                '|', '&', ('approval_date', '>=', start_datetime), ('approval_date', '<=', end_datetime),
                '&', '&', ('approval_date', '=', False),
                ('write_date', '>=', start_datetime), ('write_date', '<=', end_datetime),
            ]
            
            # ==========================================
            # GET TASKS BASED ON PERIOD
            # ==========================================
            
            # For past periods (last_month, last_week), ONLY show completed tasks in that period
            if period in ['last_month', 'last_week']:
                completed_tasks = KPI.search(completed_domain)
                in_progress_tasks = KPI.browse([])  # Empty
                paused_tasks = KPI.browse([])  # Empty
                not_started_tasks = KPI.browse([])  # Empty
                pending_approval_tasks = KPI.browse([])  # Empty
                all_tasks = completed_tasks
            else:
                # For current periods (today, yesterday, this_week, this_month)
                # Show completed in period + ALL current active tasks
                
                # Completed tasks: ONLY those completed in the period
                completed_tasks = KPI.search(completed_domain)
                
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
                    'ref': task.external_ref or '',
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
            api_key = str(params.get('api_key', '') or '')
            valid_api_key = request.env['ir.config_parameter'].sudo().get_param('kra_kpi.ai_digest_api_key') or ''

            # Refused outright until an admin SETS kra_kpi.ai_digest_api_key in
            # System Parameters. The old fallback was a placeholder that shipped
            # in this source, so anyone who had read it could pull every
            # employee's tasks, hours and pause reasons with no login at all.
            # compare_digest: a plain != leaks, byte by byte, how much matched.
            key_ok = bool(valid_api_key) and valid_api_key != 'your-secret-api-key-here' and \
                hmac.compare_digest(api_key.encode('utf-8'), valid_api_key.encode('utf-8'))
            if not key_ok:
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

    _ASSISTANT_PERIODS = ('today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month')

    @http.route('/kra_kpi/ai_assistant/ask', type='json', auth='user', methods=['POST'], csrf=False)
    def ai_assistant_ask(self, question='', period='today', context=None, chat_id=None, **kw):
        """369 AI Assistant on the web Owner Dashboard.

        Answers a typed question about the team's work from the same data as
        /kra_kpi/ai_digest: the period named in the question wins over the
        dashboard's period chip. Rule-based (kpi.ai.assistant); an AI only adds
        a summary paragraph when a key is configured. Admin-only, like the digest.

        Returns {status, title, blocks, suggestions, context, intent, ai, source,
        period, date_range}.
        """
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        question = (question or '').strip()
        if not question:
            return {'status': False, 'message': 'Type a question first.'}
        if len(question) > 1000:
            return {'status': False, 'message': 'Please keep the question under 1000 characters.'}
        try:
            from odoo.addons.kra_kpi_module.models.kpi_ai_assistant_engine import detect_period
            period = detect_period(question) or (period if period in self._ASSISTANT_PERIODS else 'today')
            digest = self.get_ai_digest_data(period=period)
            if not digest.get('status'):
                return {'status': False, 'message': digest.get('message') or 'Could not load the data.'}
            Assistant = request.env['kpi.ai.assistant']
            # The chat so far, so the AI can follow up ("and last week?", "only him").
            history = Assistant.history_of(self._ai_chat(chat_id)) if chat_id else []
            res = Assistant.answer(
                question, digest, period, context if isinstance(context, dict) else {}, history=history)
            res.update({'status': True, 'period': period, 'date_range': digest.get('date_range'),
                        'generated_at': digest.get('generated_at')})
            res['chat_id'] = self._ai_chat_save(chat_id, question, period, res)
            return res
        except Exception as e:
            _logger.exception('AI assistant failed for %r', question)
            return {'status': False, 'message': 'The assistant hit an error: %s' % e}

    def _ai_chat(self, chat_id):
        """The caller's own saved chat, or an empty recordset."""
        try:
            cid = int(chat_id or 0)
        except (TypeError, ValueError):
            cid = 0
        Chat = request.env['kpi.ai.chat'].sudo()
        return Chat.search([('id', '=', cid), ('user_id', '=', request.env.user.id)], limit=1) if cid else Chat

    def _ai_chat_save(self, chat_id, question, period, res):
        """Append the question and its answer to the caller's chat (a new one
        when there is none). Saving must never cost the user the answer."""
        try:
            chat = self._ai_chat(chat_id)
            if not chat:
                chat = request.env['kpi.ai.chat'].sudo().create({
                    'name': question[:80], 'user_id': request.env.user.id})
            payload = {k: v for k, v in res.items() if k not in ('status', 'chat_id')}
            request.env['kpi.ai.chat.message'].sudo().create([
                {'chat_id': chat.id, 'role': 'user', 'text': question},
                {'chat_id': chat.id, 'role': 'bot',
                 # an AI answer has no title: its first words stand in for it
                 'text': res.get('title') or next((b.get('text') or '' for b in res.get('blocks') or []
                                                    if b.get('type') == 'text'), '')[:120],
                 'payload_json': json.dumps(payload, default=str)},
            ])
            chat.write({'period': period, 'context_json': json.dumps(res.get('context') or {}, default=str)})
            return chat.id
        except Exception:
            _logger.exception('AI assistant: could not save the chat')
            return chat_id or False

    @http.route('/kra_kpi/ai_assistant/export', type='json', auth='user', methods=['POST'], csrf=False)
    def ai_assistant_export(self, question='', period='today', context=None, **kw):
        """The same answer as /ai_assistant/ask with EVERY table row (the drawer
        shows 50), for a PDF / Word download. Not saved to the chat."""
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        question = (question or '').strip()[:1000]
        if not question:
            return {'status': False, 'message': 'Nothing to export.'}
        try:
            from odoo.addons.kra_kpi_module.models.kpi_ai_assistant_engine import detect_period
            period = detect_period(question) or (period if period in self._ASSISTANT_PERIODS else 'today')
            digest = self.get_ai_digest_data(period=period)
            if not digest.get('status'):
                return {'status': False, 'message': digest.get('message') or 'Could not load the data.'}
            res = request.env['kpi.ai.assistant'].answer(
                question, digest, period, context if isinstance(context, dict) else {}, max_rows=2000)
            res.update({'status': True, 'period': period, 'date_range': digest.get('date_range'),
                        'generated_at': digest.get('generated_at')})
            return res
        except Exception as e:
            _logger.exception('AI assistant export failed for %r', question)
            return {'status': False, 'message': 'Could not prepare the download: %s' % e}

    @http.route('/kra_kpi/ai_assistant/find_tasks', type='json', auth='user', methods=['POST'], csrf=False)
    def ai_assistant_find_tasks(self, query='', limit=8, **kw):
        """The assistant's "Find a task" search: tasks by name or reference
        (recently updated ones for an empty query) -> [{id, ref, name, person, status}]."""
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        rows = request.env['kpi.ai.assistant']._find_tasks(str(query or '')[:100], limit=max(1, min(int(limit or 8), 20)))
        return {'status': True, 'tasks': [{k: r[k] for k in ('id', 'ref', 'name', 'person', 'status')} for r in rows]}

    @http.route('/kra_kpi/ai_assistant/chats', type='json', auth='user', methods=['POST'], csrf=False)
    def ai_assistant_chats(self, limit=50, **kw):
        """The caller's saved chats, newest first: [{id, title, period, updated, count}]."""
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        chats = request.env['kpi.ai.chat'].sudo().search(
            [('user_id', '=', request.env.user.id)], limit=max(1, min(int(limit or 50), 200)))
        return {'status': True, 'chats': [c._as_dict() for c in chats]}

    @http.route('/kra_kpi/ai_assistant/chat', type='json', auth='user', methods=['POST'], csrf=False)
    def ai_assistant_chat(self, chat_id=None, **kw):
        """One saved chat with its messages and follow-up context."""
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        chat = self._ai_chat(chat_id)
        if not chat:
            return {'status': False, 'message': 'That chat no longer exists.'}
        return dict(chat._as_dict(with_messages=True), status=True)

    @http.route('/kra_kpi/ai_assistant/chat_delete', type='json', auth='user', methods=['POST'], csrf=False)
    def ai_assistant_chat_delete(self, chat_id=None, **kw):
        if not self._is_kra_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        chat = self._ai_chat(chat_id)
        if chat:
            chat.unlink()
        return {'status': True}

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
