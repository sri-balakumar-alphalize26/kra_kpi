"""Advanced Workflow MVP — token plumbing, client pre-approval methods, cron.

This file extends `kra.kpi` (via `_inherit`) with the methods that drive the
new client pre-approval flow described in Section 2 of the spec:

  1. request_client_pre_approval() — issues a single-use signed token and
     puts the task into 'pre_approval_pending' with a 5-min deadline.
  2. record_client_pre_decision(...) — idempotent decision recorder, called
     by the public web controller and (later) the WhatsApp inbound parser.
  3. _cron_pre_approval_timeout() — flips overdue rows to
     'pre_approval_partial' (developer may do prep work only).
  4. _log_action(...) — thin helper that writes to kpi.action.log.

The notification dispatcher (`_notify`) lives in models/kpi_notify.py and is
called from here.  This file deliberately does not import it directly so the
two pieces can be tested independently.
"""

import hashlib
import hmac
import logging
import secrets
import uuid
from datetime import timedelta

from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError

_logger = logging.getLogger(__name__)


# Window during which a client may decide on a pre-approval before the cron
# auto-flips the row to "Partially Approved (Prep Only)".
PRE_APPROVAL_TIMEOUT_MIN = 5

# Total token life — must outlive the timeout window so a client who replies
# 6 minutes later still gets a valid page (state will be partial by then but
# the controller logic accepts a late decision and upgrades state).
APPROVAL_TOKEN_TTL_HOURS = 24

# Valid actions the client may take.  Mirrors the four colored buttons.
_PRE_APPROVAL_ACTIONS = ('approve', 'reject', 'hold', 'clarify')

# State transitions per decision.
_PRE_APPROVAL_STATE_FOR_ACTION = {
    'approve':  'pre_approval_approved',
    'reject':   'rework',
    'hold':     'hold',
    'clarify':  'pre_approval_pending',   # token stays live; client expected to clarify
}


class KpiWorkflow(models.Model):
    _inherit = 'kra.kpi'

    # ------------------------------------------------------------------ #
    # Audit helper                                                        #
    # ------------------------------------------------------------------ #
    def _log_action(self, event, source='system', actor_user_id=None,
                    actor_partner_id=None, actor_label=None,
                    device_ip=None, user_agent=None, payload=None,
                    success=True):
        """Append one row to kpi.action.log for this task.

        Wrapping kpi.action.log.log() so callers don't import the model
        directly and so we can fill in sensible defaults (current user
        when available).
        """
        self.ensure_one()
        if actor_user_id is None and self.env.user and self.env.user.id != 1:
            actor_user_id = self.env.user.id
        self.env['kpi.action.log'].log(
            kpi_id=self.id,
            event=event,
            source=source,
            actor_user_id=actor_user_id,
            actor_partner_id=actor_partner_id,
            actor_label=actor_label,
            device_ip=device_ip,
            user_agent=user_agent,
            payload=payload,
            success=success,
        )

    # ------------------------------------------------------------------ #
    # Token generation                                                   #
    # ------------------------------------------------------------------ #
    def _generate_approval_token(self):
        """Return a fresh 32-char hex token derived from the whatsapp.config
        secret + this kpi.id + a uuid4 + current timestamp.  Caller is
        responsible for writing the result + an expiry to the row.
        """
        self.ensure_one()
        config = self.env['whatsapp.config'].sudo().get_config()
        secret = config.get_kpi_token_secret().encode('utf-8')
        payload = f'{self.id}:{uuid.uuid4()}:{fields.Datetime.now().isoformat()}'
        digest = hmac.new(secret, payload.encode('utf-8'), hashlib.sha256).hexdigest()
        return digest[:32]

    def _build_approval_url(self):
        """Return the full https://host/kpi/wa/<token> URL for this task."""
        self.ensure_one()
        if not self.approval_token:
            return ''
        base = self.env['whatsapp.config'].sudo().get_config().get_kpi_public_base_url()
        return f'{base}/kpi/wa/{self.approval_token}'

    # ------------------------------------------------------------------ #
    # Client pre-approval — entry point                                  #
    # ------------------------------------------------------------------ #
    def request_client_pre_approval(self):
        """Move the task into 'pre_approval_pending' and seed a token.

        Idempotent: re-calling on a row that already has a live token
        regenerates a fresh token + deadline.  Re-calling on a row whose
        state is past pre-approval (in_progress, completed, …) is a no-op
        with a UserError so the caller knows.
        """
        for rec in self:
            if rec.task_state in ('completed', 'awaiting_client'):
                raise UserError(
                    "Cannot request pre-approval: task '%s' is already in "
                    "state '%s'." % (rec.name or rec.id, rec.task_state)
                )
            token = rec._generate_approval_token()
            now = fields.Datetime.now()
            rec.write({
                'approval_token':            token,
                'approval_token_expires':    now + timedelta(hours=APPROVAL_TOKEN_TTL_HOURS),
                'approval_token_used':       False,
                'pre_approval_decision':     False,
                'pre_approval_decided_at':   False,
                'pre_approval_decided_by_name': False,
                'pre_approval_decided_by_partner_id': False,
                'pre_approval_source':       False,
                'pre_approval_feedback':     False,
                'pre_approval_deadline_at':  now + timedelta(minutes=PRE_APPROVAL_TIMEOUT_MIN),
                'task_state':                'pre_approval_pending',
            })
            rec._log_action(
                'pre_approval_requested',
                source='web' if self.env.user.id and self.env.user.id != 1 else 'system',
                payload={'token_prefix': token[:8]},
            )
            # Notification is fire-and-forget: never block this RPC on a WA send.
            try:
                rec._notify('pre_approval_request')
            except Exception as exc:
                rec._log_action(
                    'notification_failed',
                    payload={'event': 'pre_approval_request', 'error': str(exc)},
                    success=False,
                )
        return True

    # ------------------------------------------------------------------ #
    # Client pre-approval — decision recorder                            #
    # ------------------------------------------------------------------ #
    def record_client_pre_decision(self, action, partner_name='',
                                   feedback='', source='web',
                                   ip=None, user_agent=None,
                                   partner_id=None):
        """Apply a client decision atomically.  Called from:
          * /kpi/wa/<token>/decide controller (source='web')
          * neonize inbound command handler   (source='whatsapp')

        Returns a dict {status, message, state} so the caller can render
        the right confirmation / already-decided / expired page.

        Idempotency:
          * Re-entry with the SAME action returns success with the existing
            state (so a double-click on Approve doesn't 500).
          * Re-entry with a DIFFERENT action after a terminal decision
            returns status='already_decided' and does NOT change state.
        """
        self.ensure_one()
        if action not in _PRE_APPROVAL_ACTIONS:
            return {'status': 'invalid', 'message': 'Unknown action.'}

        # Lock the row so two concurrent clicks (web + whatsapp) can't both win.
        self.env.cr.execute(
            'SELECT id FROM kra_kpi WHERE id = %s FOR UPDATE',
            (self.id,),
        )
        self.invalidate_recordset(['approval_token_used', 'approval_token_expires',
                                   'pre_approval_decision', 'task_state'])

        if self.approval_token_expires and self.approval_token_expires < fields.Datetime.now():
            return {'status': 'expired', 'message': 'Approval link expired.'}

        # If already decided with a TERMINAL action, reject any new action
        # except a repeat of the same one.
        if self.approval_token_used and self.pre_approval_decision != 'clarify':
            if self.pre_approval_decision == action:
                return {
                    'status': 'ok',
                    'state': self.task_state,
                    'decision': self.pre_approval_decision,
                    'message': 'Decision already recorded.',
                }
            return {
                'status': 'already_decided',
                'state': self.task_state,
                'decision': self.pre_approval_decision,
                'message': 'This task has already been decided.',
            }

        # Apply the decision.  If the task is still in a pre-approval state
        # we move it to the new lifecycle state.  If the developer has already
        # progressed past pre-approval (prep mode, in_progress, etc.), we
        # record the decision retroactively WITHOUT reverting the live state —
        # the work continues from wherever the developer left it.
        PRE_APPROVAL_STATES = (
            'assigned', 'queue_waiting',
            'pre_approval_pending', 'pre_approval_partial',
            'urgent', 'important', 'regular',  # legacy priority-states
        )
        new_state = _PRE_APPROVAL_STATE_FOR_ACTION[action]
        now = fields.Datetime.now()
        vals = {
            'pre_approval_decision':     action,
            'pre_approval_decided_at':   now,
            'pre_approval_decided_by_name': (partner_name or '').strip()[:120] or False,
            'pre_approval_source':       source if source in ('web', 'whatsapp') else 'web',
            'pre_approval_feedback':     (feedback or '').strip() or False,
        }
        if self.task_state in PRE_APPROVAL_STATES:
            vals['task_state'] = new_state
            late = False
        else:
            # Late decision — keep current state, just stamp the approval/decision
            late = True
        if partner_id:
            vals['pre_approval_decided_by_partner_id'] = partner_id
        if action == 'clarify':
            # Token stays live so the client can come back; extend TTL by 24h.
            vals['approval_token_expires'] = now + timedelta(hours=APPROVAL_TOKEN_TTL_HOURS)
            vals['approval_token_used']    = False
        else:
            vals['approval_token_used']    = True

        self.sudo().write(vals)
        event_name = 'pre_approval_decided_late' if late else 'pre_approval_decided'
        self._log_action(
            event_name,
            source=source,
            actor_partner_id=partner_id or None,
            actor_label=partner_name or None,
            device_ip=ip,
            user_agent=user_agent,
            payload={'action': action, 'feedback': feedback or '',
                     'live_state': self.task_state, 'late': late},
        )
        try:
            self._notify(event_name, decision=action,
                         feedback=feedback, decided_by=partner_name,
                         source=source)
        except Exception as exc:
            self._log_action(
                'notification_failed',
                payload={'event': event_name, 'error': str(exc)},
                success=False,
            )

        return {
            'status': 'ok',
            'state': self.task_state,
            'decision': action,
            'message': 'Late approval recorded — work continues.' if late else 'Decision recorded.',
            'late': late,
        }

    # ------------------------------------------------------------------ #
    # Client FINAL sign-off — recorded after coordinator approval        #
    # ------------------------------------------------------------------ #
    def record_client_final_decision(self, action, partner_name='',
                                     feedback='', source='web',
                                     ip=None, user_agent=None,
                                     partner_id=None):
        """Apply the client's FINAL sign-off decision after the coordinator
        has approved the dev work (task_state='awaiting_client').

        Mirrors record_client_pre_decision() but for the second-stage handoff:
          * 'approve'  → state='completed' + signature receipt written;
                         fires 'final_approved'.
          * 'reject'   → state moves back via reject_task(reason); fires
                         'internal_rejected'.
          * 'clarify'  → keeps state='awaiting_client', stamps the feedback,
                         pings the coordinator.

        Returns the same {status, state, decision, message} contract as
        record_client_pre_decision so the controller can reuse its renderers.
        """
        self.ensure_one()
        if action not in ('approve', 'reject', 'clarify'):
            return {'status': 'invalid', 'message': 'Unknown action.'}

        # Lock the row so two concurrent clicks (web + whatsapp) can't both win.
        self.env.cr.execute(
            'SELECT id FROM kra_kpi WHERE id = %s FOR UPDATE',
            (self.id,),
        )
        self.invalidate_recordset(['approval_token_used', 'approval_token_expires',
                                   'pre_approval_decision', 'task_state'])

        if self.approval_token_expires and self.approval_token_expires < fields.Datetime.now():
            return {'status': 'expired', 'message': 'Sign-off link expired.'}

        # Final sign-off only valid while task is awaiting the client.
        if self.task_state != 'awaiting_client':
            if self.task_state == 'completed':
                return {
                    'status': 'already_decided',
                    'state': self.task_state,
                    'decision': 'approve',
                    'message': 'Task is already signed off as completed.',
                }
            return {
                'status': 'invalid',
                'state': self.task_state,
                'message': f"Task is in state '{self.task_state}' — not awaiting client sign-off.",
            }

        # If a previous final decision has already burned the token (someone hit
        # Approve once, then taps Reject) — bounce.
        if self.approval_token_used:
            return {
                'status': 'already_decided',
                'state': self.task_state,
                'decision': self.pre_approval_decision or 'approve',
                'message': 'This sign-off link has already been used.',
            }

        now = fields.Datetime.now()
        signer = (partner_name or '').strip()[:120] or (ip or 'WhatsApp client')
        note = (feedback or '').strip()

        if action == 'approve':
            # Build a minimal digital approval receipt (mirrors
            # /kpi_client_approval/approve in controllers/kpi_reports_api.py
            # so the audit shape matches the web-portal path).
            import base64 as _b64
            receipt = (
                f"DIGITAL APPROVAL RECEIPT\n"
                f"========================\n"
                f"Task:      {self.name}\n"
                f"Ref:       {self.external_ref or ''}\n"
                f"Signed by: {signer}\n"
                f"Source:    {source} (ip/phone: {ip or '-'})\n"
                f"Signed at: {now}\n"
                f"Notes:     {note}\n"
            ).encode('utf-8')
            vals = {
                'task_state':                'completed',
                'client_signature_text':     signer,
                'client_signed_datetime':    now,
                'client_approval_notes':     note,
                'client_chk_delivered':      True,
                'client_chk_works':          True,
                'client_chk_authorized':     True,
                'signed_certificate':        _b64.b64encode(receipt).decode(),
                'signed_certificate_name':   f'digital_approval_{self.id}.txt',
                'signed_certificate_date':   fields.Date.today(),
                'admin_approved':            True,
                'approval_date':             now,
                'pre_approval_decision':     'approve',
                'pre_approval_decided_at':   now,
                'pre_approval_decided_by_name': signer,
                'pre_approval_source':       source if source in ('web', 'whatsapp') else 'web',
                'pre_approval_feedback':     note or False,
                'approval_token_used':       True,
            }
            if partner_id:
                vals['pre_approval_decided_by_partner_id'] = partner_id
            self.sudo().write(vals)
            self._log_action(
                'final_approved',
                source=source,
                actor_partner_id=partner_id or None,
                actor_label=signer,
                device_ip=ip,
                user_agent=user_agent,
                payload={'action': 'approve', 'notes': note},
            )
            try:
                self._notify('final_approved',
                             decision='approve',
                             decided_by=signer,
                             feedback=note,
                             source=source)
            except Exception as exc:
                self._log_action(
                    'notification_failed',
                    payload={'event': 'final_approved', 'error': str(exc)},
                    success=False,
                )
            return {
                'status': 'ok',
                'state': 'completed',
                'decision': 'approve',
                'message': 'Signed off — invoice can now be generated.',
            }

        if action == 'reject':
            # Burn the token so the link can't be reused.
            self.sudo().write({
                'approval_token_used':       True,
                'pre_approval_decision':     'reject',
                'pre_approval_decided_at':   now,
                'pre_approval_decided_by_name': signer,
                'pre_approval_source':       source if source in ('web', 'whatsapp') else 'web',
                'pre_approval_feedback':     note or False,
            })
            if partner_id:
                self.sudo().write({'pre_approval_decided_by_partner_id': partner_id})
            # Reuse the existing internal-reject path so coordinator sees this
            # under the same kanban column as a normal rework request.
            # reject_task() requires partially_completed; coordinator already
            # ran approve_task so we have to walk it back manually.
            self.sudo().write({
                'task_state':       'rework',
                'paused_reason':    f"🔴 CLIENT REJECTED — {note}" if note else "🔴 CLIENT REJECTED — see notes",
                'admin_approved':   False,
            })
            self._log_action(
                'internal_rejected',
                source=source,
                actor_partner_id=partner_id or None,
                actor_label=signer,
                device_ip=ip,
                user_agent=user_agent,
                payload={'action': 'reject', 'feedback': note, 'stage': 'client_final'},
            )
            try:
                self._notify('internal_rejected',
                             decision='reject',
                             decided_by=signer,
                             feedback=note,
                             source=source)
            except Exception as exc:
                self._log_action(
                    'notification_failed',
                    payload={'event': 'internal_rejected', 'error': str(exc)},
                    success=False,
                )
            return {
                'status': 'ok',
                'state': 'rework',
                'decision': 'reject',
                'message': 'Rejection recorded — coordinator notified.',
            }

        # action == 'clarify'  → keep state, extend token, send feedback.
        self.sudo().write({
            'approval_token_expires':    now + timedelta(hours=APPROVAL_TOKEN_TTL_HOURS),
            'pre_approval_decision':     'clarify',
            'pre_approval_decided_at':   now,
            'pre_approval_decided_by_name': signer,
            'pre_approval_source':       source if source in ('web', 'whatsapp') else 'web',
            'pre_approval_feedback':     note or False,
        })
        if partner_id:
            self.sudo().write({'pre_approval_decided_by_partner_id': partner_id})
        self._log_action(
            'pre_approval_decided',
            source=source,
            actor_partner_id=partner_id or None,
            actor_label=signer,
            device_ip=ip,
            user_agent=user_agent,
            payload={'action': 'clarify', 'feedback': note, 'stage': 'client_final'},
        )
        try:
            self._notify('internal_rejected',
                         decision='clarify',
                         decided_by=signer,
                         feedback=note or 'Client requested clarification before signing off.',
                         source=source)
        except Exception:
            pass
        return {
            'status': 'ok',
            'state': 'awaiting_client',
            'decision': 'clarify',
            'message': 'Clarification request sent — coordinator will reach out.',
        }

    # ------------------------------------------------------------------ #
    # Create / write overrides — auto-notify + auto-trigger pre-approval #
    # ------------------------------------------------------------------ #
    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        for rec in records:
            try:
                rec._log_action(
                    'task_created',
                    source='web',
                    payload={
                        'name': rec.name,
                        'kra_id': rec.kra_id.id if rec.kra_id else None,
                        'user_id': rec.user_id.id if rec.user_id else None,
                        'estimate_hours': rec.estimate_hours,
                        'estimate_minutes': rec.estimate_minutes,
                    },
                )
                # Self-created "Pending Review" lane tasks send their own
                # `self_task_submitted` ping instead of the generic one.
                if not (rec.is_self_created and not rec.admin_accepted):
                    rec._notify('task_created')
            except Exception as exc:
                # Never let a notification failure block task creation
                try:
                    rec._log_action(
                        'notification_failed',
                        payload={'event': 'task_created', 'error': str(exc)},
                        success=False,
                    )
                except Exception:
                    pass

            # Always trigger client pre-approval on creation so the client
            # gets the Approve / Reject / Hold / Clarify buttons at the same
            # time the owner gets the task_created notification.  Whether the
            # developer is assigned yet or not, the approval question goes
            # to the client first; the coordinator can pick the dev later.
            if rec.task_state in ('assigned',) and not (rec.is_self_created and not rec.admin_accepted):
                try:
                    rec.request_client_pre_approval()
                except Exception as exc:
                    try:
                        rec._log_action(
                            'notification_failed',
                            payload={'event': 'auto_pre_approval_on_create', 'error': str(exc)},
                            success=False,
                        )
                    except Exception:
                        pass
        return records

    def write(self, vals):
        # Snapshot which rows are about to GAIN a developer assignment so we can
        # auto-trigger the pre-approval flow after super().write() commits and
        # publish them out of the Client Task Queue.
        will_request_pre_approval = []
        # Also remember every row that's about to receive its FIRST developer
        # assignment (regardless of state) so we can fire `task_assigned` to
        # the developer + owner + coordinator afterwards.
        will_notify_assigned = []
        if 'user_id' in vals and vals.get('user_id'):
            for rec in self:
                if not rec.user_id:
                    will_notify_assigned.append(rec.id)
                    if rec.task_state in ('assigned', 'queue_waiting'):
                        will_request_pre_approval.append(rec.id)

        # When a coordinator assigns a developer, automatically publish the
        # task so it leaves the Client Task Queue.  Skip if caller already set
        # published explicitly so we don't override an intentional unpublish.
        if will_request_pre_approval and 'published' not in vals:
            vals = dict(vals, published=True)

        result = super().write(vals)

        for rid in will_request_pre_approval:
            rec = self.browse(rid)
            try:
                rec.request_client_pre_approval()
            except Exception as exc:
                try:
                    rec._log_action(
                        'notification_failed',
                        payload={'event': 'auto_pre_approval_on_assign', 'error': str(exc)},
                        success=False,
                    )
                except Exception:
                    pass

        # Fire `task_assigned` whenever a task first gets a developer.
        # We deliberately do this AFTER the pre-approval trigger above so the
        # client's approval-request goes out first.  The two messages are
        # complementary: client gets the approve/reject buttons, developer
        # gets the "here's what's on your plate" summary.
        for rid in will_notify_assigned:
            rec = self.browse(rid)
            try:
                rec._log_action('task_assigned', source='web',
                                payload={'user_id': rec.user_id.id if rec.user_id else None})
                rec._notify('task_assigned')
            except Exception as exc:
                try:
                    rec._log_action(
                        'notification_failed',
                        payload={'event': 'task_assigned', 'error': str(exc)},
                        success=False,
                    )
                except Exception:
                    pass
        return result

    # ------------------------------------------------------------------ #
    # Lifecycle hooks — wrap the existing start/pause/resume/complete/   #
    # approve/reject methods with audit + notification calls.            #
    # ------------------------------------------------------------------ #
    def _wrap_lifecycle(self, event, prev_state=None, payload=None):
        """Common helper called after a lifecycle method's super() returns."""
        try:
            self._log_action(event, source='web', payload=payload)
        except Exception:
            pass
        try:
            self._notify(event, prev_state=prev_state, **(payload or {}))
        except Exception as exc:
            try:
                self._log_action(
                    'notification_failed',
                    payload={'event': event, 'error': str(exc)},
                    success=False,
                )
            except Exception:
                pass

    def _check_single_task_limit(self):
        """Block a 2nd concurrent in_progress task unless the assignee is allowed multitask."""
        for rec in self:
            if not rec.user_id or rec.user_id.kpi_allow_multitask:
                continue
            other = self.sudo().search([
                ('user_id', '=', rec.user_id.id),
                ('id', '!=', rec.id),
                ('task_state', '=', 'in_progress'),
                ('active', '=', True),
            ], limit=1)
            if other:
                raise ValidationError(
                    f"{rec.user_id.name} already has task "
                    f"{other.external_ref or other.name} in progress. "
                    "Pause that task first before starting a new one."
                )

    def start_task(self):
        # A developer may have at most ONE in_progress task at a time — unless
        # their kpi_allow_multitask flag is on (enforced in _check_single_task_limit).
        self._check_single_task_limit()
        prev = {rec.id: rec.task_state for rec in self}
        result = super().start_task()
        for rec in self:
            prev_state = prev.get(rec.id)
            event = 'start_prep' if prev_state == 'pre_approval_partial' else 'start'
            rec._wrap_lifecycle(event, prev_state=prev_state)
            # If we just started on a PARTIAL-approved task, also remind the
            # client to approve so the work can be billed.  Token is still
            # live (the 5-min cron only changed state; approval_token_used
            # stays False), so the tap-to-send buttons keep working.
            if prev_state == 'pre_approval_partial' and not rec.approval_token_used:
                try:
                    rec._log_action('pre_approval_reminder',
                                    source='web',
                                    payload={'fired_on': 'start_prep'})
                    rec._notify('pre_approval_reminder')
                except Exception as exc:
                    try:
                        rec._log_action('notification_failed',
                                        payload={'event': 'pre_approval_reminder',
                                                 'error': str(exc)},
                                        success=False)
                    except Exception:
                        pass
        return result

    def pause_task(self, reason='', reason_code=False):
        if reason_code:
            # Pass through to write so the field updates regardless of the original method
            self.sudo().write({'pause_reason_code': reason_code})
        result = super().pause_task(reason=reason)
        for rec in self:
            rec._wrap_lifecycle('pause', payload={'reason': reason, 'reason_code': reason_code or rec.pause_reason_code})
        # ANY reason (break/lunch/meeting/other/away/typed) starts a metered interval —
        # recorded ONLY in kpi.break.log, never in kpi.time.log, so it shows in Presence
        # but never in Productive time. The task it was paused FROM + the typed note are
        # kept so the live panel / summary can show "(from <task>)".
        if reason_code:
            self.env['kpi.break.log'].start_break(
                reason_code, self.env.user.id,
                source_task_id=self.id if len(self) == 1 else False,
                reason_note=reason or False,
            )
        # 🚨 Urgent pause — escalate the developer's note to owner + configured numbers.
        if reason_code == 'urgent':
            for rec in self:
                try:
                    rec._notify('urgent_pause', note=reason)
                except Exception as exc:
                    _logger.warning("urgent_pause notify failed for task %s: %s", rec.id, exc)
        return result

    def resume_task(self):
        # Same single-in-progress rule applies to Resume (closes the gap where a
        # dev could get two running tasks by resuming a paused one).
        self._check_single_task_limit()
        result = super().resume_task()
        # Returning from a pause closes any open break/lunch for this user.
        self.env['kpi.break.log'].stop_break(self.env.user.id)
        for rec in self:
            rec._wrap_lifecycle('resume')
        return result

    def complete_task(self, employee_checklist=None):
        result = super().complete_task(employee_checklist=employee_checklist)
        # Completing also closes any open break/lunch.
        self.env['kpi.break.log'].stop_break(self.env.user.id)
        for rec in self:
            rec._wrap_lifecycle('complete')
        return result

    def approve_task(self, manager_checklist=None):
        result = super().approve_task(manager_checklist=manager_checklist)
        for rec in self:
            event = 'final_approved' if rec.task_state == 'completed' else 'internal_approved'
            # When coordinator approval lands the task in 'awaiting_client',
            # mint a FRESH single-use token so the client's WhatsApp tap-to-send
            # buttons and the /kpi/wa/<token> page work for final sign-off too.
            if rec.task_state == 'awaiting_client':
                token = rec._generate_approval_token()
                now = fields.Datetime.now()
                rec.sudo().write({
                    'approval_token':          token,
                    'approval_token_expires':  now + timedelta(hours=APPROVAL_TOKEN_TTL_HOURS),
                    'approval_token_used':     False,
                    'pre_approval_decision':   False,
                    'pre_approval_decided_at': False,
                    'pre_approval_decided_by_name':       False,
                    'pre_approval_decided_by_partner_id': False,
                    'pre_approval_source':     False,
                    'pre_approval_feedback':   False,
                })
            rec._wrap_lifecycle(event)
        return result

    def reject_task(self, rejection_reason=''):
        result = super().reject_task(rejection_reason=rejection_reason)
        for rec in self:
            rec._wrap_lifecycle('internal_rejected', payload={'reason': rejection_reason})
        return result

    def reassign_task(self, user_id, reason):
        prev = {rec.id: (rec.user_id.id, rec.user_id.name if rec.user_id else 'Unassigned')
                for rec in self}
        result = super().reassign_task(user_id, reason)
        for rec in self:
            prev_uid, prev_name = prev.get(rec.id, (False, 'Unassigned'))
            new_name = rec.user_id.name if rec.user_id else 'Unknown'
            rec._wrap_lifecycle('reassigned', payload={
                'reason':           reason,
                'previous_user_id': prev_uid,
                'previous_user':    prev_name,
                'new_user':         new_name,
            })
            # Tell the PREVIOUS assignee their task moved to someone else
            # (in-app notification + push). Skip a self-reassign/reset (prev==new)
            # and the was-Unassigned case.
            if prev_uid and prev_uid != (rec.user_id.id if rec.user_id else False):
                try:
                    rec._notify('task_reassigned', extra_users=[prev_uid],
                                name=rec.name, new_dev=new_name)
                except Exception:
                    pass
        return result

    # ------------------------------------------------------------------ #
    # Cron — 5-min auto-flip to partial                                  #
    # ------------------------------------------------------------------ #
    @api.model
    def _cron_pre_approval_timeout(self):
        """Flip rows past their pre-approval deadline to 'pre_approval_partial'.

        Runs every minute (see data/kpi_partial_timeout_cron.xml).
        Idempotent: only acts on rows still in 'pre_approval_pending'.
        """
        now = fields.Datetime.now()
        overdue = self.sudo().search([
            ('task_state', '=', 'pre_approval_pending'),
            ('pre_approval_deadline_at', '!=', False),
            ('pre_approval_deadline_at', '<=', now),
        ])
        for rec in overdue:
            rec.task_state = 'pre_approval_partial'
            rec._log_action(
                'partial_timeout',
                source='cron',
                payload={'deadline_at': rec.pre_approval_deadline_at and rec.pre_approval_deadline_at.isoformat()},
            )
            try:
                rec._notify('partial_timeout')
            except Exception as exc:
                rec._log_action(
                    'notification_failed',
                    payload={'event': 'partial_timeout', 'error': str(exc)},
                    success=False,
                )
        return len(overdue)

    # ------------------------------------------------------------------ #
    # Cron — 30-min sequential client escalation                         #
    # ------------------------------------------------------------------ #
    @api.model
    def _cron_escalate_pre_approval(self):
        """Sequential client pre-approval escalation.

        Each ping of pre_approval_request only goes to ONE client (see
        kpi_notify._resolve_recipients).  After 30 min with no decision, this
        cron re-fires pre_approval_request, which picks the next non-notified
        client on the KRA.  When all clients are exhausted it becomes a no-op.

        Wiring: data/kpi_pre_approval_escalate_cron.xml (every 5 minutes).
        """
        now = fields.Datetime.now()
        # Escalate as long as the client hasn't decided (token still valid)
        # and the task isn't terminal.  Even tasks already in_progress can
        # still receive pre-approval — dev may have started in prep mode
        # while the client decision is still pending.
        candidates = self.sudo().search([
            ('approval_token_used', '=', False),
            ('task_state', 'not in', ('pre_approval_approved', 'completed')),
            ('pre_approval_next_check_at', '!=', False),
            ('pre_approval_next_check_at', '<=', now),
        ])
        escalated = 0
        for rec in candidates:
            try:
                rec._notify('pre_approval_request')
                rec._log_action(
                    'pre_approval_escalated',
                    source='cron',
                    payload={
                        'notified_so_far': rec.pre_approval_notified_user_ids.mapped('login'),
                    },
                )
                escalated += 1
            except Exception as exc:
                rec._log_action(
                    'notification_failed',
                    payload={'event': 'pre_approval_request_escalate', 'error': str(exc)},
                    success=False,
                )
        return escalated
