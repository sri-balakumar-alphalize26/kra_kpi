"""Advanced Workflow MVP — token plumbing, client pre-approval methods, cron.

This file extends `kra.kpi` (via `_inherit`) with the methods that drive the
new client pre-approval flow described in Section 2 of the spec:

  1. request_client_pre_approval() — issues a single-use signed token and
     puts the task into 'pre_approval_pending' with a reminder + release clock.
  2. record_client_pre_decision(...) — idempotent decision recorder, called
     by the public web controller and (later) the WhatsApp inbound parser.
  3. _cron_pre_approval_timeout() — reminds the client, then AUTO-RELEASES the
     task for work once the window elapses.  Release is not approval: see
     _sweep_pre_approval_release.
  4. _cron_admin_accept_timeout() — auto-accepts a task no admin triaged, so an
     un-actioned queue cannot block a developer indefinitely.
  5. _log_action(...) — thin helper that writes to kpi.action.log.

The notification dispatcher (`_notify`) lives in models/kpi_notify.py and is
called from here.  This file deliberately does not import it directly so the
two pieces can be tested independently.
"""

import hashlib
import hmac
import logging
import re
import secrets
import uuid
from datetime import timedelta

from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError
from odoo.tools.sql import column_exists

_logger = logging.getLogger(__name__)


# Window during which a client may decide on a pre-approval before the cron
# auto-RELEASES the task for work.  Fallback for res.company.client_approval_minutes.
PRE_APPROVAL_TIMEOUT_MIN = 5

# Window during which an admin may Accept a task before the cron accepts it for
# them.  Fallback for res.company.admin_accept_minutes.
ADMIN_ACCEPT_TIMEOUT_MIN = 5

# Total token life — must outlive the approval window so a client who replies
# after the auto-release still gets a valid page (the decision is then recorded
# late, and record_client_pre_decision applies or stamps it as appropriate).
# 72h rather than 24h so a long client_approval_minutes cannot outrun the token;
# the release also pushes this forward, belt and braces.
APPROVAL_TOKEN_TTL_HOURS = 72

# Per-tick ceilings for the two auto-advance crons.  A backlog (or a mistimed
# upgrade) then drains at N rows/minute instead of firing all at once — which
# would re-number every provisional TASK-### and notify every client at the same
# instant.  The migration staggers deadlines too; this is the backstop.
ADMIN_ACCEPT_BATCH_MAX = 25
AUTO_RELEASE_BATCH_MAX = 25

# Ref/name prefixes applied when a task is categorised on acceptance.  Shared by
# the human endpoint (/kra_kpi/task/admin_accept) and _auto_admin_accept so the
# two paths cannot drift.
REF_PREFIX_FOR_DOC_TYPE = {'requirement': 'REQ', 'update': 'UPT', 'bug': 'BUG'}
NAME_PREFIX_FOR_DOC_TYPE = {'requirement': '', 'update': '[Update] ', 'bug': '[Bug] '}


def _schema_ready(cr, *columns):
    """True once this release's columns exist on kra_kpi.

    Deploying is two steps — the .py files land (and are imported on the next
    restart) BEFORE the module upgrade creates their columns.  In that window a
    cron written against the new schema raises UndefinedColumn, and because Odoo
    runs a batch of due jobs on one cursor, that error aborts the transaction and
    every OTHER job in the batch dies with InFailedSqlTransaction — a change to
    the approval crons takes down auto-away, nudges and idle checks with it.

    So the new crons check first and skip quietly.  The tick after the upgrade
    behaves normally; nothing is lost, because these sweeps are driven by stored
    deadlines rather than by having run on any particular minute.
    """
    return all(column_exists(cr, 'kra_kpi', c) for c in columns)

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
            # A developer is MANDATORY: this approval asks the client to sign off
            # on WHO the task went to, so with nobody assigned there is nothing to
            # approve (the client would see "Assigned to Unassigned").  create()
            # calls this in bulk for brand-new tasks that may have no developer
            # yet, so SKIP rather than raise — raising would abort the whole batch.
            # Callers that need to tell a human pre-check themselves (e.g.
            # /kpi_pending_queue/publish returns "Assign a developer before
            # publishing this task.").
            if not rec.user_id:
                rec._log_action(
                    'pre_approval_skipped_no_dev',
                    source='system',
                    payload={'reason': 'no developer assigned'},
                )
                continue
            token = rec._generate_approval_token()
            now = fields.Datetime.now()
            window = rec._client_approval_minutes()
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
                # First nudge lands at the reminder gap; the hard release lands
                # at the full window.  See the field comments in kpi.py.
                'pre_approval_deadline_at':  now + timedelta(minutes=rec._pre_approval_reminder_gap()),
                'pre_approval_release_at':   now + timedelta(minutes=window),
                'pre_approval_reminder_count': 0,
                # A fresh request supersedes any previous release or hold.
                'pre_approval_auto_released': False,
                'pre_approval_auto_released_at': False,
                'pre_approval_auto_released_after_min': 0,
                'pre_approval_held':         False,
                'task_state':                'pre_approval_pending',
            })
            rec._log_action(
                'pre_approval_requested',
                source='web' if self.env.user.id and self.env.user.id != 1 else 'system',
                payload={'token_prefix': token[:8]},
            )
            # Notification is fire-and-forget: never block this RPC on a WA send.
            try:
                rec._notify('pre_approval_request', window_minutes=window)
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
            # An AUTO-RELEASED task sits here with no decision and an unused
            # token, so a client answering afterwards must still be able to move
            # it — otherwise a "reject" would be filed as merely late and the
            # developer could legally start a task the client just refused.
            # Genuinely approved rows never reach this line: their
            # approval_token_used=True trips the terminal guard above.
            'pre_approval_approved',
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
            # A real answer stops both clocks.  pre_approval_auto_released is
            # deliberately NOT reset: "released at T1, client answered at T2" is
            # what happened, and the record should keep saying so.
            'pre_approval_deadline_at':  False,
            'pre_approval_release_at':   False,
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
            # Token stays live so the client can come back; extend the TTL.
            vals['approval_token_expires'] = now + timedelta(hours=APPROVAL_TOKEN_TTL_HOURS)
            vals['approval_token_used']    = False
            # Clarify is a question, not an answer — so RE-ARM both clocks
            # rather than leaving them cleared above. Stopping them would let a
            # single "what do you mean?" block the developer indefinitely, which
            # is precisely the deadlock this release removes. The client gets a
            # fresh full window to actually decide.
            vals['pre_approval_deadline_at'] = now + timedelta(
                minutes=self._pre_approval_reminder_gap())
            vals['pre_approval_release_at'] = now + timedelta(
                minutes=self._client_approval_minutes())
            vals['pre_approval_reminder_count'] = 0
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
                'client_final_approved':     True,
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

            # DELIBERATELY NOT asking the client here.  The order is
            # ADMIN accepts  →  THEN the client is asked to approve.
            # Client pre-approval is fired exclusively by the admin-accept
            # endpoint (/kra_kpi/task/admin_accept in controllers/kra_api.py).
            # Firing it on create() asked the client before any admin had seen
            # the task, which is the reverse of the intended workflow.
        # ...but the admin gate is time-boxed, so start its clock now.  Without
        # this a task nobody triages blocks its developer forever and never even
        # reaches the client.
        records._arm_admin_accept_deadline()
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
        # A task with no developer is never armed for auto-accept: there is
        # nothing for the client to approve (they are asked to approve WHO does
        # the work), and request_client_pre_approval skips dev-less rows anyway.
        # Client-portal tasks are created exactly like that, so their clock
        # starts here — the moment a coordinator assigns someone.
        will_arm_admin_accept = []
        if 'user_id' in vals and vals.get('user_id'):
            for rec in self:
                if not rec.admin_accepted:
                    will_arm_admin_accept.append(rec.id)
                if not rec.user_id:
                    will_notify_assigned.append(rec.id)
                    # 'rework' included so that a task the CLIENT rejected (which
                    # clears the developer and returns it to the queue, keeping
                    # task_state='rework') asks the client again when the admin
                    # assigns a DIFFERENT developer. Without it the reassignment
                    # would silently never re-request approval.
                    # Only once an admin has accepted the task: assigning a
                    # developer must never leapfrog the admin gate.
                    if (rec.task_state in ('assigned', 'queue_waiting', 'rework')
                            and rec.admin_accepted):
                        will_request_pre_approval.append(rec.id)

        # When a coordinator assigns a developer, automatically publish the
        # task so it leaves the Client Task Queue.  Skip if caller already set
        # published explicitly so we don't override an intentional unpublish.
        if will_request_pre_approval and 'published' not in vals:
            vals = dict(vals, published=True)

        result = super().write(vals)

        if will_arm_admin_accept:
            self.browse(will_arm_admin_accept)._arm_admin_accept_deadline()

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

    # States that mean work is already legitimately underway, so Start/Resume
    # is just picking it back up rather than beginning unapproved work.
    _RESUMABLE_STATES = ('in_progress', 'paused', 'rework', 'partially_completed')

    def _start_block(self):
        """Why this task cannot start, or None if it can.

        THE rule.  _assert_startable raises from it, the task serializers ship
        it to the boards as can_start/start_block_reason, and the controllers
        turn it into a readable message — so the UI cannot drift from the server
        the way a hand-maintained list of startable states always does.

        Returns (reason_key, message) with reason_key in {'admin', 'client'},
        or None when the task is free to start.

        The workflow is: admin accepts -> client approves -> developer works.
        Neither gate blocks forever: an unactioned task auto-accepts after
        res.company.admin_accept_minutes, and a silent client auto-releases it
        after res.company.client_approval_minutes.

        Auto-release grants permission to WORK, never permission to BILL.  A
        released task has pre_approval_decision empty — the client never said
        yes — and invoicing keys off client_final_approved, which only a real
        stage-2 sign-off sets.  That separation is the whole point: before it
        existed, silence was recorded as consent and unapproved work was billed.
        """
        self.ensure_one()
        ref = self.external_ref or self.name or self.id
        # A client "no" on work that has never actually run blocks it, whatever
        # the state says.  This check comes FIRST because a pre-approval reject
        # lands the task in 'rework', which is a resumable state — 'rework' means
        # two different things (admin sent finished work back vs. client refused
        # the assignment) and only the first is legitimately resumable.  Without
        # this, rejecting an unstarted task would leave Start enabled, which is
        # the exact hole this guard exists to close.
        if (self.pre_approval_decision == 'reject'
                and not self.timer_total_seconds
                and not self.timer_start_datetime):
            return ('client',
                    "'%s': the client rejected this before any work started. It "
                    "needs to be re-assigned or re-approved first." % ref)
        if self.task_state in self._RESUMABLE_STATES:
            return None         # already underway — resuming is fine
        if not self.admin_accepted:
            return ('admin',
                    "'%s' has not been accepted by an admin yet. It accepts "
                    "automatically if nobody acts; you can start once it does."
                    % ref)
        # Order matters: an explicit client "no" must beat an earlier
        # auto-release.  A client who objects after the window closed still
        # stops a task that has not actually started.
        if self.pre_approval_decision == 'approve':
            return None
        if self.pre_approval_decision in ('reject', 'hold', 'clarify'):
            label = dict(self._fields['pre_approval_decision'].selection).get(
                self.pre_approval_decision, self.pre_approval_decision)
            return ('client',
                    "'%s': the client answered '%s'. Work cannot start until "
                    "that is resolved." % (ref, label))
        if self.pre_approval_auto_released:
            return None         # window elapsed — released for work, NOT approved
        return ('client',
                "'%s' is waiting for the client to approve who works on it. It "
                "releases automatically if they don't reply." % ref)

    def _assert_startable(self):
        """Raise unless the task may start/resume.  Thin wrapper over _start_block."""
        for rec in self:
            block = rec._start_block()
            if block:
                raise ValidationError(block[1])

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
        # Client approval is mandatory before any work begins.  The old
        # 'start_prep' path (starting from pre_approval_partial) is gone: it
        # let developers work on tasks the client had never approved.
        self._assert_startable()
        prev = {rec.id: rec.task_state for rec in self}
        result = super().start_task()
        self._end_nontask_for_work('task started')
        for rec in self:
            rec._wrap_lifecycle('start', prev_state=prev.get(rec.id))
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
        # 🚨 Urgent pause — tell owner + coordinator IN-APP (bell + push), naming
        # the developer, and arm the re-nudge so it keeps reminding them every few
        # minutes until one of them actually reads it.
        if reason_code == 'urgent':
            for rec in self:
                try:
                    rec._notify('urgent_pause', note=reason)
                    rec.sudo().write({'urgent_nudge_count': 0})
                    rec._schedule_urgent_nudge()
                except Exception as exc:
                    _logger.warning("urgent_pause notify failed for task %s: %s", rec.id, exc)
        return result

    def _end_nontask_for_work(self, why):
        """A task is now running → close any open Meeting/Break/Lunch/No-tasks
        block and stop chasing the developer. They are plainly working.

        Closed at `now`, the same instant the timer was stamped: the block ends
        exactly where the task begins — no overlap, no gap.

        Shared by start_task AND resume_task. It used to be inline in start_task
        only, and resume_task never got a copy — so declaring a Meeting and then
        RESUMING a paused task left the meeting running alongside the work. The
        same minutes were then counted twice (meeting_seconds AND productive), and
        because other_idle is max(0, presence - productive - metered) the
        contradiction was silently floored to zero instead of showing up. End
        Workday froze that into the image. One helper, two callers, no drift.

        Never raises: bookkeeping must not stop someone getting to work.
        """
        try:
            Session = self.env['kpi.work.session'].sudo()
            sess = Session.search([('user_id', '=', self.env.user.id),
                                   ('state', '=', 'open')], limit=1)
            if sess:
                sess._close_nontask_block(at=fields.Datetime.now())
                sess._stop_idle_tracking(why)
        except Exception as exc:
            _logger.warning("closing non-task block on %s failed: %s", why, exc)

    def resume_task(self):
        # Same single-in-progress rule applies to Resume (closes the gap where a
        # dev could get two running tasks by resuming a paused one).
        self._check_single_task_limit()
        # Resuming a genuinely-underway task is allowed; resuming something the
        # client never approved is not (see _assert_startable).
        self._assert_startable()
        result = super().resume_task()
        # Returning from a pause closes any open break/lunch for this user.
        self.env['kpi.break.log'].stop_break(self.env.user.id)
        # ...and any open non-task block. Resuming is starting work, so the same
        # rule must apply — without this the block ran alongside the task and the
        # time was double-counted.
        self._end_nontask_for_work('task resumed')
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
                    # Stage 1 is over — its clocks and its auto-release must not
                    # bleed into stage 2.  A stale release_at on an
                    # awaiting_client row would be a landmine if the task ever
                    # bounced back to 'rework'.
                    'pre_approval_deadline_at': False,
                    'pre_approval_release_at':  False,
                    'pre_approval_auto_released': False,
                    'pre_approval_auto_released_at': False,
                    'pre_approval_auto_released_after_min': 0,
                    'pre_approval_held':       False,
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
    # Admin acceptance — arming, auto-accept, cron                        #
    # ------------------------------------------------------------------ #
    def _arm_admin_accept_deadline(self, force=False):
        """Start the admin acceptance clock on rows that need one.

        ONE invariant, applied from create()/write() rather than sprinkled
        across the four create routes: a task is armed when it is un-accepted,
        active, and has a developer.  Every controller that creates a task
        inherits it automatically, and the dev-less client-portal rows arm
        themselves the moment somebody is assigned.

        Never restarts a clock that is already ticking (an unrelated write must
        not buy the task another full window) unless force=True, which is what
        the send-back reply path wants.
        """
        if self.env.context.get('kpi_no_admin_arm'):
            return              # bulk restore/import — do not arm history
        # create()/write() run this, so an un-upgraded schema must not make task
        # creation itself fail — see _schema_ready.
        if not _schema_ready(self.env.cr, 'admin_accept_deadline_at'):
            return
        for rec in self:
            if rec.admin_accepted or not rec.active or not rec.user_id:
                continue
            if rec.admin_accept_deadline_at and not force:
                continue
            mins = rec._admin_accept_minutes()
            if not mins:
                continue        # 0 = auto-accept disabled; wait for a human
            deadline = fields.Datetime.now() + timedelta(minutes=mins)
            rec.sudo().write({'admin_accept_deadline_at': deadline})
            try:
                rec._log_action('admin_accept_armed', source='system',
                                payload={'window_min': mins, 'deadline_at': str(deadline)})
            except Exception:
                pass

    def _auto_admin_accept(self):
        """Accept a task nobody triaged, then hand it to the client.

        Mirrors /kra_kpi/task/admin_accept minus the human: same categorisation,
        same re-numbering, same "don't disturb a running timer" guard.  The
        admin keeps every power they had — re-categorise, reject, send back —
        they just no longer hold up the developer by not looking.
        """
        self.ensure_one()
        # The name is the only signal we have about type without a human, and
        # the bulk-import paths already encode it there.
        name = self.name or ''
        if re.match(r'^\[Update\]', name, flags=re.IGNORECASE):
            doc_type = 'update'
        elif re.match(r'^\[Bug\]', name, flags=re.IGNORECASE):
            doc_type = 'bug'
        else:
            doc_type = 'requirement'
        prefix = REF_PREFIX_FOR_DOC_TYPE.get(doc_type, 'REQ')
        base_name = re.sub(r'^\[(Update|Bug)\]\s*', '', name, flags=re.IGNORECASE)
        vals = {
            'admin_accepted':           True,
            'admin_accepted_auto':      True,
            'admin_accepted_at':        fields.Datetime.now(),
            'admin_accepted_by_id':     False,   # nobody decided — that is the point
            'admin_accept_deadline_at': False,
            'name': NAME_PREFIX_FOR_DOC_TYPE.get(doc_type, '') + base_name,
        }
        # Re-number ONLY a provisional ref. The human accept always re-numbers
        # because a human is choosing the type; here nobody chose, so churning a
        # ref a client may already have quoted would be damage done by a timeout
        # rather than by a decision. TASK-### is the placeholder self_create
        # mints, and a missing ref obviously needs one.
        current_ref = (self.external_ref or '').strip().upper()
        if not current_ref or current_ref.startswith('TASK-'):
            vals['external_ref'] = '%s-%03d' % (prefix, self._next_ref_for_prefix(prefix))
        # write()'s auto-publish only fires alongside a pre-approval request,
        # which needs admin_accepted to ALREADY be true — so a client-submitted
        # task armed at assignment was never published. Do it here or it stays
        # invisible to the team while claiming to be accepted.
        if self.client_submitted and not self.published:
            vals['published'] = True
        self.sudo().write(vals)
        self._log_action('admin_accept_auto', source='cron',
                         payload={'window_min': self._admin_accept_minutes(),
                                  'doc_type': doc_type, 'new_ref': self.external_ref})
        # Only ask the client if the developer hasn't already got going; a
        # running timer and its accrued time are never disturbed.
        if self.task_state in ('assigned', 'urgent', 'important', 'regular', 'queue_waiting'):
            try:
                self.request_client_pre_approval()
            except Exception as exc:
                _logger.warning("auto-accept pre-approval failed for %s: %s", self.id, exc)
        try:
            self._notify('admin_accept_auto',
                         window_minutes=self._admin_accept_minutes())
        except Exception as exc:
            try:
                self._log_action('notification_failed',
                                 payload={'event': 'admin_accept_auto', 'error': str(exc)},
                                 success=False)
            except Exception:
                pass

    @api.model
    def _cron_admin_accept_timeout(self):
        """Accept tasks whose admin window elapsed.

        Deliberately a SEPARATE cron record from _cron_pre_approval_timeout:
        each ir.cron runs in its own transaction, so one poisoned row here
        cannot roll back the client-release sweep (or vice versa), and ops can
        disable either gate on its own during a rollout.
        """
        if not _schema_ready(self.env.cr, 'admin_accept_deadline_at',
                             'admin_accepted_auto'):
            _logger.warning(
                "kra_kpi: admin-accept cron skipped — 19.0.2.4 columns are not in "
                "the database yet. Upgrade the module (-u kra_kpi_module).")
            return 0
        now = fields.Datetime.now()
        due = self.sudo().search([
            ('admin_accepted', '=', False),
            # Load-bearing: reject_self_created ARCHIVES a discarded task while
            # leaving admin_accepted False.  Without this filter every discarded
            # task would auto-accept, take a fresh REQ-### ref and ping a client.
            ('active', '=', True),
            ('user_id', '!=', False),
            ('admin_accept_deadline_at', '!=', False),
            ('admin_accept_deadline_at', '<=', now),
            ('task_state', 'not in', ('completed', 'awaiting_client')),
        ], order='admin_accept_deadline_at asc', limit=ADMIN_ACCEPT_BATCH_MAX)
        accepted = 0
        for rec in due:
            # Same lock discipline as the release sweep: an admin clicking
            # Accept in this same second must not produce two tokens and two
            # client notifications.
            self.env.cr.execute(
                'SELECT id FROM kra_kpi WHERE id = %s FOR UPDATE', (rec.id,))
            rec.invalidate_recordset(['admin_accepted', 'admin_accept_deadline_at'])
            if rec.admin_accepted or not rec.admin_accept_deadline_at:
                continue        # a human got there first
            try:
                rec._auto_admin_accept()
                accepted += 1
            except Exception as exc:
                _logger.warning("auto admin-accept failed for task %s: %s", rec.id, exc)
        return accepted

    # ------------------------------------------------------------------ #
    # Cron — client approval reminders, then auto-RELEASE                 #
    # ------------------------------------------------------------------ #
    @api.model
    def _cron_pre_approval_timeout(self):
        """Chase the client, then stop blocking the developer.

        Two sweeps over two independent clocks (see the field comments in
        kpi.py): reminders on pre_approval_deadline_at, and the hard release on
        pre_approval_release_at.

        On the history here — this method once auto-APPROVED a silent client's
        task, stamping "Auto-approved (no response)", and flipped others to a
        'pre_approval_partial' prep state.  Both let work be BILLED without the
        client ever consenting, which is the bug this module was reported for,
        and 19.0.2.3 reversed every such record.

        Auto-release is not that.  It writes no decision, no decided-by, no
        source and does not burn the token: the record keeps saying the client
        never answered, they can still object, and the invoice still waits for a
        real stage-2 sign-off.  What changes is only that the developer stops
        being blocked by someone else's silence.
        """
        if not _schema_ready(self.env.cr, 'pre_approval_release_at',
                             'pre_approval_auto_released'):
            _logger.warning(
                "kra_kpi: pre-approval cron skipped — 19.0.2.4 columns are not in "
                "the database yet. Upgrade the module (-u kra_kpi_module).")
            return {'reminded': 0, 'released': 0, 'skipped': 'schema'}
        now = fields.Datetime.now()
        return {
            'reminded': self._sweep_pre_approval_reminders(now),
            'released': self._sweep_pre_approval_release(now),
        }

    @api.model
    def _sweep_pre_approval_reminders(self, now):
        """Re-notify clients sitting on a pending approval.  Writes no decision."""
        overdue = self.sudo().search([
            ('task_state', '=', 'pre_approval_pending'),
            ('active', '=', True),
            ('user_id', '!=', False),
            ('pre_approval_deadline_at', '!=', False),
            ('pre_approval_deadline_at', '<=', now),
        ])
        sent = 0
        for rec in overdue:
            # This cron ticks every minute, but pre_approval_deadline_at is
            # pushed forward after each reminder so a given task is chased at
            # most once per gap, and PRE_APPROVAL_REMINDER_MAX times in total.
            if rec.pre_approval_reminder_count >= self.PRE_APPROVAL_REMINDER_MAX:
                # Stop CHASING — not stop waiting.  Clearing the reminder clock
                # drops the row from this search; pre_approval_release_at is
                # untouched and still decides when work may start.
                rec.sudo().write({'pre_approval_deadline_at': False})
                rec._log_action(
                    'pre_approval_reminder_exhausted',
                    source='cron',
                    payload={'sent': rec.pre_approval_reminder_count},
                )
                continue
            try:
                rec._notify('pre_approval_reminder',
                            feedback='Still awaiting the client decision')
                sent += 1
            except Exception as exc:
                try:
                    rec._log_action(
                        'notification_failed',
                        payload={'event': 'pre_approval_reminder', 'error': str(exc)},
                        success=False,
                    )
                except Exception:
                    pass
            rec.sudo().write({
                'pre_approval_reminder_count': rec.pre_approval_reminder_count + 1,
                'pre_approval_deadline_at': (
                    now + timedelta(minutes=rec._pre_approval_reminder_gap())),
            })
        return sent

    @api.model
    def _sweep_pre_approval_release(self, now):
        """The client stayed silent past their window → let the developer work.

        Lands the task in 'pre_approval_approved' so every existing consumer
        (boards, mobile app, lane maps) treats it as startable with no changes.
        The distinction between "client approved" and "nobody answered" lives in
        pre_approval_auto_released and the audit log, NOT in the state — a new
        state value would read as unknown to every client of this API and make
        the Start button vanish rather than appear.
        """
        due = self.sudo().search([
            ('task_state', '=', 'pre_approval_pending'),
            ('active', '=', True),
            ('user_id', '!=', False),
            ('pre_approval_held', '=', False),
            ('pre_approval_release_at', '!=', False),
            ('pre_approval_release_at', '<=', now),
        ], order='pre_approval_release_at asc', limit=AUTO_RELEASE_BATCH_MAX)
        released = 0
        for rec in due:
            # Same row lock record_client_pre_decision takes.  Without it a
            # client's Approve landing microseconds earlier could be overwritten
            # by this write, turning a genuine consent into "no reply".
            self.env.cr.execute(
                'SELECT id FROM kra_kpi WHERE id = %s FOR UPDATE', (rec.id,))
            rec.invalidate_recordset(
                ['task_state', 'pre_approval_decision', 'pre_approval_held',
                 'pre_approval_release_at'])
            if (rec.task_state != 'pre_approval_pending'
                    or rec.pre_approval_decision
                    or rec.pre_approval_held):
                rec._log_action(
                    'pre_approval_release_skipped', source='cron',
                    payload={'state': rec.task_state,
                             'decision': rec.pre_approval_decision or '',
                             'held': rec.pre_approval_held})
                continue

            window = rec._client_approval_minutes()
            # DELIBERATELY NOT WRITTEN, now or ever, by this method:
            #   pre_approval_decision, pre_approval_decided_at,
            #   pre_approval_decided_by_name, pre_approval_decided_by_partner_id,
            #   pre_approval_source, approval_token_used, client_final_approved.
            # Writing any of them would record the client's silence as their
            # consent.  That is the defect 19.0.2.3 exists to undo; the string
            # 'Auto-approved (no response)' must never reappear in this module.
            rec.sudo().write({
                'task_state':                'pre_approval_approved',
                'pre_approval_auto_released': True,
                'pre_approval_auto_released_at': now,
                'pre_approval_auto_released_after_min': window,
                'pre_approval_deadline_at':  False,
                'pre_approval_release_at':   False,
                # Keep the client's door open: they may still object, and the
                # token page is one of the ways they do it.
                'approval_token_expires':    now + timedelta(hours=APPROVAL_TOKEN_TTL_HOURS),
            })
            rec._log_action(
                'pre_approval_auto_released', source='cron',
                payload={'window_min': window,
                         'reminders_sent': rec.pre_approval_reminder_count})
            released += 1
            # Two audiences, two messages: the team is told "you may start, and
            # this is NOT approved"; the client is told "we stopped waiting, you
            # can still object".  One body cannot say both honestly.
            for event in ('pre_approval_auto_released', 'pre_approval_window_closed'):
                try:
                    rec._notify(event, window_minutes=window)
                except Exception as exc:
                    try:
                        rec._log_action(
                            'notification_failed',
                            payload={'event': event, 'error': str(exc)},
                            success=False)
                    except Exception:
                        pass
        return released

    # ------------------------------------------------------------------ #
    # Cron — RETIRED: 30-min sequential client escalation                 #
    # ------------------------------------------------------------------ #
    @api.model
    def _cron_escalate_pre_approval(self):
        """Retired — deliberately a no-op.

        This drove the old WhatsApp design where each pre_approval_request went
        to ONE client and was re-fired every 30 min to chase the next one.
        Approval now happens in the app: ALL client users are notified at once
        and the first to answer decides, so there is nobody left to escalate to.

        Kept as a no-op (rather than deleted) because the cron record may still
        exist in a deployed DB and would error on a missing method. The cron in
        data/kpi_pre_approval_escalate_cron.xml is also deactivated.

        _cron_pre_approval_timeout (reminders + auto-release, both derived from
        res.company.client_approval_minutes) is now the only pre-approval timer.
        """
        return 0

    # ------------------------------------------------------------------ #
    # Client Task Queue — re-nudge admins while the notification is unread #
    # ------------------------------------------------------------------ #
    # Cap the client approval reminders the same way (see the timeout cron).
    PRE_APPROVAL_REMINDER_MAX = 5

    # Cap the repeats so a task nobody ever opens can't nudge forever.
    QUEUE_NUDGE_MAX = 5

    def _queue_nudge_minutes(self):
        """Configurable gap between admin re-nudges (res.company)."""
        try:
            return max(1, int(self.env.company.queue_nudge_minutes or 30))
        except Exception:
            return 30

    # Same cap for the 🚨 Urgent re-nudge — an urgent nobody opens must not
    # nudge forever either.
    URGENT_NUDGE_MAX = 5

    def _urgent_nudge_minutes(self):
        """Configurable gap between 🚨 Urgent re-nudges (res.company)."""
        try:
            return max(1, int(self.env.company.urgent_nudge_minutes or 5))
        except Exception:
            return 5

    def _client_approval_minutes(self):
        """Configurable client approval window; falls back to the module default."""
        try:
            return max(1, int(self.env.company.client_approval_minutes
                              or PRE_APPROVAL_TIMEOUT_MIN))
        except Exception:
            return PRE_APPROVAL_TIMEOUT_MIN

    def _pre_approval_reminder_gap(self):
        """Gap between client reminders — DERIVED, so there is no third setting.

        The reminders spread evenly across the approval window rather than each
        one costing a further full window: a 60-minute window with 5 reminders
        nudges every 10 minutes and releases at 60, which is what the setting's
        label promises.  Re-arming with the full window instead would make the
        real wait window x (MAX + 1).
        """
        return max(1, self._client_approval_minutes() // (self.PRE_APPROVAL_REMINDER_MAX + 1))

    def _admin_accept_minutes(self):
        """Configurable admin acceptance window.  0 disables auto-accept."""
        try:
            value = self.env.company.admin_accept_minutes
            # Distinguish "explicitly 0" (feature off) from unset/garbage.
            if value in (None, False, ''):
                return ADMIN_ACCEPT_TIMEOUT_MIN
            return max(0, int(value))
        except Exception:
            return ADMIN_ACCEPT_TIMEOUT_MIN

    # ------------------------------------------------------------------ #
    # Client pre-approval — hold / resume / reject-to-queue (in-app)      #
    # ------------------------------------------------------------------ #
    def _hold_pre_approval(self):
        """Client pressed Hold: stop both clocks, decide later.

        Implemented by CLEARING the two datetimes, because each cron sweep
        requires its own field to be set.  BOTH must go: clearing only the
        reminder would silently stop the nagging while the task still
        auto-released behind the client's back — the exact opposite of Hold.

        Deliberately does NOT use the engine's 'hold' action: that marks
        approval_token_used=True, and the terminal guard in
        record_client_pre_decision would then answer 'already_decided' to any
        later Approve — the client would be locked out of their own task
        forever. Here task_state stays 'pre_approval_pending' and the token
        stays unused, so Approve/Reject keep working normally.

        A client who holds and then never returns blocks the task indefinitely.
        That is what Hold means; the developer's escape is for an admin to
        re-request pre-approval, which re-arms both clocks.
        """
        self.ensure_one()
        self.sudo().write({
            'pre_approval_deadline_at': False,
            'pre_approval_release_at':  False,
            'pre_approval_held':        True,
        })
        self._log_action('pre_approval_held', source='web')
        try:
            self._notify('pre_approval_held')   # dev + admins: don't wait on this
        except Exception as exc:
            self._log_action('notification_failed',
                             payload={'event': 'pre_approval_held', 'error': str(exc)},
                             success=False)

    def _resume_pre_approval(self):
        """Client pressed Resume: re-arm both countdowns from now.

        The reminder ladder restarts too — they asked for the clock back, so
        they get the full run of nudges, not whatever was left of the old one.
        """
        self.ensure_one()
        now = fields.Datetime.now()
        self.sudo().write({
            'pre_approval_deadline_at': now + timedelta(minutes=self._pre_approval_reminder_gap()),
            'pre_approval_release_at':  now + timedelta(minutes=self._client_approval_minutes()),
            'pre_approval_reminder_count': 0,
            'pre_approval_held': False,
        })
        self._log_action('pre_approval_resumed', source='web')

    def _return_to_queue_after_reject(self):
        """Client rejected WHO the task went to → back to the Client Task Queue.

        Clears the developer and unpublishes so the task reappears in the queue
        (domain: published=False + client_submitted) and the nudge cron (which
        also requires user_id=False) can chase the admins. task_state stays
        'rework' — set by the engine — so the client sees "Changes Requested";
        the write() override re-fires pre-approval when the NEXT developer is
        assigned ('rework' is in its trigger tuple for exactly this reason).

        Called from /kpi_pre_approval/decide AFTER record_client_pre_decision so
        pre_approval_feedback is already stamped — the notification body reads it.
        """
        self.ensure_one()
        # Notify BEFORE clearing user_id: the body names the developer being
        # rejected via {dev}, which reads self.user_id — clear it first and the
        # message would say "Unassigned", i.e. exactly the wrong thing.
        #
        # feedback MUST be passed explicitly: _format_message resolves {feedback}
        # from ctx ONLY, never from the pre_approval_feedback field — omit it and
        # the reason silently renders as the "—" placeholder, which defeats the
        # point of making the reason mandatory.
        try:
            self._notify('client_task_rejected',
                         feedback=self.pre_approval_feedback or '')
        except Exception as exc:
            self._log_action('notification_failed',
                             payload={'event': 'client_task_rejected', 'error': str(exc)},
                             success=False)
        self.sudo().write({'user_id': False, 'published': False})
        self._schedule_queue_nudge()

    def _schedule_queue_nudge(self):
        """Arm the next admin nudge for a queued client task."""
        self.ensure_one()
        self.sudo().write({
            'queue_nudge_next_at': (fields.Datetime.now()
                                    + timedelta(minutes=self._queue_nudge_minutes())),
        })

    def _clear_queue_nudge(self):
        """Disarm nudging (admin saw it, or a developer got assigned)."""
        self.sudo().write({'queue_nudge_next_at': False})

    @api.model
    def _cron_nudge_queued_tasks(self):
        """Re-notify admins about client tasks still sitting in the queue.

        Only nudges while the admins' `client_task_queued` notification is still
        UNREAD — once any admin opens it, the task is 'seen' and nudging stops
        (per the user's rule: unread → nudge again every N min; read → stop).
        Also stops once a developer is assigned/published, or after
        QUEUE_NUDGE_MAX repeats.

        Wiring: data/kpi_queue_nudge_cron.xml (every 5 minutes). The N-minute gap
        lives on res.company.queue_nudge_minutes.
        """
        now = fields.Datetime.now()
        candidates = self.sudo().search([
            ('client_submitted', '=', True),
            ('published', '=', False),
            ('user_id', '=', False),          # still needs a developer
            ('active', '=', True),
            ('queue_nudge_next_at', '!=', False),
            ('queue_nudge_next_at', '<=', now),
        ])
        nudged = 0
        for rec in candidates:
            try:
                # "Seen" == an admin read the in-app notification for this task.
                unread = self.env['kpi.notification'].sudo().search_count([
                    ('kpi_id', '=', rec.id),
                    ('event', '=', 'client_task_queued'),
                    ('is_read', '=', False),
                ])
                if not unread or rec.queue_nudge_count >= self.QUEUE_NUDGE_MAX:
                    rec._clear_queue_nudge()
                    continue
                rec._notify('client_task_queued')
                rec.sudo().write({
                    'queue_nudge_count': rec.queue_nudge_count + 1,
                    'queue_nudge_next_at': now + timedelta(minutes=rec._queue_nudge_minutes()),
                })
                rec._log_action(
                    'client_task_queue_nudge',
                    source='cron',
                    payload={'nudge': rec.queue_nudge_count, 'unread': unread},
                )
                nudged += 1
            except Exception as exc:
                rec._log_action(
                    'notification_failed',
                    payload={'event': 'client_task_queued_nudge', 'error': str(exc)},
                    success=False,
                )
        return nudged

    # ------------------------------------------------------------------ #
    # 🚨 Urgent pause — re-nudge admins while the notification is unread   #
    # ------------------------------------------------------------------ #
    def _schedule_urgent_nudge(self):
        """Arm the next admin nudge for an urgent-paused task."""
        self.ensure_one()
        self.sudo().write({
            'urgent_nudge_next_at': (fields.Datetime.now()
                                     + timedelta(minutes=self._urgent_nudge_minutes())),
        })

    def _clear_urgent_nudge(self):
        """Disarm nudging (an admin saw it, or the task moved on)."""
        self.sudo().write({'urgent_nudge_next_at': False})

    @api.model
    def _cron_nudge_urgent_pause(self):
        """Re-notify admins while a 🚨 Urgent pause is still unread.

        Mirrors _cron_nudge_queued_tasks exactly: nudge every N minutes while the
        admins' `urgent_pause` notification is UNREAD; the moment any admin opens
        it, stop. Also stops as soon as the task leaves the urgent pause (the dev
        resumed / completed it) or after URGENT_NUDGE_MAX repeats.

        Wiring: data/kpi_urgent_nudge_cron.xml (every minute — the N-minute gap
        lives on res.company.urgent_nudge_minutes, default 5, not in the cron).
        """
        now = fields.Datetime.now()
        candidates = self.sudo().search([
            ('active', '=', True),
            ('urgent_nudge_next_at', '!=', False),
            ('urgent_nudge_next_at', '<=', now),
        ])
        nudged = 0
        for rec in candidates:
            try:
                # The dev resumed / finished → no longer urgent, stop nudging.
                if rec.task_state != 'paused' or rec.pause_reason_code != 'urgent':
                    rec._clear_urgent_nudge()
                    continue
                # "Seen" == an admin read the in-app notification for this task.
                unread = self.env['kpi.notification'].sudo().search_count([
                    ('kpi_id', '=', rec.id),
                    ('event', '=', 'urgent_pause'),
                    ('is_read', '=', False),
                ])
                if not unread or rec.urgent_nudge_count >= self.URGENT_NUDGE_MAX:
                    rec._clear_urgent_nudge()
                    continue
                rec._notify('urgent_pause', note=(rec.paused_reason or ''))
                rec.sudo().write({
                    'urgent_nudge_count': rec.urgent_nudge_count + 1,
                    'urgent_nudge_next_at': now + timedelta(minutes=rec._urgent_nudge_minutes()),
                })
                rec._log_action(
                    'urgent_pause_nudge',
                    source='cron',
                    payload={'nudge': rec.urgent_nudge_count, 'unread': unread},
                )
                nudged += 1
            except Exception as exc:
                rec._log_action(
                    'notification_failed',
                    payload={'event': 'urgent_pause_nudge', 'error': str(exc)},
                    success=False,
                )
        return nudged
