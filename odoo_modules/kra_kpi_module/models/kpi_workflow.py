"""Advanced Workflow MVP — token plumbing, client pre-approval methods, cron.

This file extends `kra.kpi` (via `_inherit`) with the methods that drive the
new client pre-approval flow described in Section 2 of the spec:

  1. request_client_pre_approval() — issues a single-use signed token and
     puts the task into 'pre_approval_pending' with a reminder + release clock.
  2. record_client_pre_decision(...) — idempotent decision recorder, called
     by the public web controller and (later) the WhatsApp inbound parser.
  3. _cron_pre_approval_timeout() — reminds the client.  The old auto-release
     (_sweep_pre_approval_release) is retired since 19.0.8.6: the client must
     actively approve.
  4. _cron_admin_accept_timeout() — retired no-op since 19.0.8.6; nothing is
     accepted automatically (the approval chain reminds instead).
  5. _log_action(...) — thin helper that writes to kpi.action.log.

The notification dispatcher (`_notify`) lives in models/kpi_notify.py and is
called from here.  This file deliberately does not import it directly so the
two pieces can be tested independently.
"""

import hashlib
import hmac
import json
import logging
import re
import secrets
import uuid
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import UserError, ValidationError
from odoo.tools.sql import column_exists

from .kpi_wa_activity import SWITCH_NOTE, WA_PAUSED_ALL, WA_SWITCHED_FROM, WA_SWITCHED_TO

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
    def _client_approvers(self):
        """The client users who would be asked to approve this task.

        Mirrors how models/kpi_notify.py resolves the 'client' role, so the
        question "is there anyone to ask?" is answered by the same rule that
        decides who actually gets asked. Divergence here would mean waiting on a
        notification that was never sent to anybody.
        """
        self.ensure_one()
        # sudo: this is an existence check, and whether a developer is allowed to
        # READ the client portal users must not decide whether their task waits
        # for an approval. Nothing here is returned to a user.
        rec = self.sudo()
        if rec.client_submitted and rec.submitted_by_uid:
            return rec.submitted_by_uid
        client_kra = getattr(rec, 'client_kra_id', False) or rec.kra_id
        # _effective_client_users, not client_user_ids: the task resolves to the
        # level-2 KRA while the portal user hangs off the level-1 root, so reading
        # the field directly found nobody and closed finished work as unbillable.
        return client_kra._effective_client_users() if client_kra else self.env['res.users'].sudo()

    def _release_without_client(self, reason='KRA has no client users linked'):
        """No client is linked to this KRA → nothing to wait for, so don't wait.
        Also used for a task the client raised themselves (see
        request_client_pre_approval): the admin's accept is enough.

        A KRA with no client_user_ids has nobody who could ever answer. Putting
        the task into 'pre_approval_pending' anyway sent the developer to the
        back of a client_approval_minutes queue for an approval that could not
        arrive, and then "released" it for the client's silence — silence from
        a client who does not exist.

        Lands in the SAME state the timeout release uses, for the same reason
        given there: every board, lane map and the mobile app already treat
        'pre_approval_approved' as startable, and a new state value would read as
        unknown and make Start vanish rather than appear.

        Records it as auto-released, NOT approved, and writes no decision, no
        decided-by and no source — exactly like _sweep_pre_approval_release. The
        distinction is carried by pre_approval_auto_released_after_min = 0 (no
        window was ever waited out) and by the log event below.
        """
        self.ensure_one()
        now = fields.Datetime.now()
        self.sudo().write({
            'task_state':                'pre_approval_approved',
            'pre_approval_auto_released': True,
            'pre_approval_auto_released_at': now,
            'pre_approval_auto_released_after_min': 0,
            'pre_approval_deadline_at':  False,
            'pre_approval_release_at':   False,
        })
        self._log_action(
            'pre_approval_skipped_no_client', source='system',
            payload={'reason': reason,
                     'kra': (self.kra_id.name if self.kra_id else '')})

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
            # Nobody to ask → nothing to wait for. Checked BEFORE the token and
            # the clocks are issued, so the task never enters
            # 'pre_approval_pending' at all: no reminder ladder chasing an empty
            # recipient list, and no release cron work for a row that was never
            # really pending.
            if not rec._client_approvers():
                rec._release_without_client()
                continue
            # The client raised it themselves (portal, WhatsApp form, app):
            # they asked for this work, so once the admin accepts it and gives
            # it a developer it may start -- no second wait for their approval.
            # Only tasks the TEAM creates for a client (KPI Action ▸ New Task)
            # still ask the client to approve.
            if rec.client_submitted:
                rec._release_without_client(reason='raised by the client; admin accepted')
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
                # First nudge lands at the reminder gap.  No release clock any
                # more (19.0.8.6): the client must actively approve.
                'pre_approval_deadline_at':  now + timedelta(minutes=rec._pre_approval_reminder_gap()),
                'pre_approval_release_at':   False,
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
            # Clarify is a question, not an answer — so RE-ARM the reminders
            # rather than leaving them cleared above. The client gets a fresh
            # run of nudges to actually decide (no release clock: 19.0.8.6).
            vals['pre_approval_deadline_at'] = now + timedelta(
                minutes=self._pre_approval_reminder_gap())
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

        # The sign-off link has no timer while the task waits for the client: it
        # ends only when the client acts (or the review closes on its own).
        if (self.task_state != 'awaiting_client' and self.approval_token_expires
                and self.approval_token_expires < fields.Datetime.now()):
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
        # The question goes to this task's developer only (else the first
        # Approval Chain step) -- kpi_finish._client_question_to_team.
        to_dev = self._client_question_to_team(signer, note or 'Client asked for clarification before signing off.')
        return {
            'status': 'ok',
            'state': 'awaiting_client',
            'decision': 'clarify',
            'message': ('Your question was sent to the developer.' if to_dev
                        else 'Your question was sent to our team.'),
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
        # An ADMIN who creates a task has, by creating it, already made the
        # decision the admin gate exists to capture.  Making them wait out
        # admin_accept_minutes for their own approval — and leaving the task
        # unpublished and therefore invisible to its developer the whole time —
        # was pure dead time.  Accept it here instead, crediting the admin.
        #
        # Self-created rows are excluded on purpose: the "Pending Review" lane
        # exists precisely so a developer's own task is seen by someone else.
        #
        # kpi_no_admin_arm is honoured for the same reason _arm_admin_accept_deadline
        # honours it: a bulk restore/import must not re-run history, and accepting
        # here would also fire a pre-approval request at every client on the way in.
        if (not self.env.context.get('kpi_no_admin_arm')
                and self._user_is_kpi_admin()
                and _schema_ready(self.env.cr, 'admin_accept_deadline_at',
                                  'admin_accepted_auto')):
            for rec in records:
                # No user_id check on purpose. An admin who creates a task and
                # assigns the developer later has still made the acceptance
                # decision at creation; requiring a developer here left the row
                # un-accepted, so assigning one afterwards re-armed the gate and
                # the admin waited on themselves a second time.
                # _auto_admin_accept leaves a dev-less row unpublished and skips
                # the client request — correct: there is no developer for the
                # client to approve yet. write() fires that on assignment.
                if rec.admin_accepted or rec.is_self_created or not rec.active:
                    continue
                try:
                    rec._auto_admin_accept(by_user=self.env.user)
                except Exception as exc:
                    # A creation must never fail because the gate-skip did.
                    # The row simply waits for a human Accept.
                    _logger.warning("admin-created accept failed for %s: %s", rec.id, exc)
        # No accept clock any more (19.0.8.6): a task nobody triages waits for a
        # human. Client requests and a developer's own task climb the approval
        # chain instead (kpi_escalation.py), which reminds but never accepts.
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
        # Rows an ADMIN is assigning a developer to. Assigning the developer IS
        # the admin's triage decision — it is the whole content of the admin gate
        # — so the task must go straight on to the client, not sit out another
        # admin_accept_minutes waiting for the admin who just acted.
        #
        # This is the client-submitted path: client raises a task -> it lands in
        # the Client Task Queue with no developer -> admin assigns one -> client
        # is asked to approve that developer. The middle step used to insert a
        # five-minute wait for nobody.
        will_admin_accept_now = []
        if 'user_id' in vals and vals.get('user_id'):
            acting_admin = self._user_is_kpi_admin()
            for rec in self:
                if not rec.admin_accepted:
                    # Self-created rows are excluded: the "Pending Review" lane
                    # exists so a developer's own task gets an explicit human
                    # Accept, which reassigning it must not silently stand in for.
                    if acting_admin and not rec.is_self_created:
                        will_admin_accept_now.append(rec.id)
                    else:
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

        # Accept-on-assign runs FIRST: _auto_admin_accept publishes the row and
        # fires the client pre-approval itself, which is exactly the hand-off
        # this path owes the client. These ids are never in
        # will_request_pre_approval (that list requires admin_accepted to have
        # been true already), so the client is asked once, not twice.
        for rid in will_admin_accept_now:
            rec = self.browse(rid)
            try:
                rec._auto_admin_accept(by_user=self.env.user)
            except Exception as exc:
                # The row stays un-accepted and waits for a human Accept.
                _logger.warning("accept-on-assign failed for %s: %s", rid, exc)

        # will_arm_admin_accept is no longer armed (19.0.8.6): nothing is
        # accepted automatically; the row waits for a human decision.

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
            # The real door: 'app' from the phone, 'whatsapp' from the bot (no
            # web/app source on the context there), 'web' otherwise. Every event
            # used to be logged as 'web', whoever triggered it.
            src = self.env.context.get('kpi_action_source') or (
                'whatsapp' if self.env.context.get('kpi_wa_state_id')
                or self.env.context.get('kpi_finish_source') == 'whatsapp' else 'web')
            self._log_action(event, source=src if src in ('web', 'whatsapp') else 'web',
                             payload=dict(payload or {}, channel=src))
        except Exception:
            pass
        try:
            # Web / app only: the bot already said it in the group.
            self._wa_group_lifecycle(event, payload)
        except Exception as exc:
            _logger.warning("wa group line for %s on %s failed: %s", event, self.ids, exc)
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

    def _actor_workday_open(self):
        """Does the user acting right now have an OPEN workday session today?

        Admins are exempt, matching every other gate in this module: they act on
        other people's tasks and do not keep a developer's workday themselves.
        (The retired PIN gate exempted them for the same reason.)

        `kpi_workday_open` in the context short-circuits the lookup. The task
        board calls _start_block once per listed task, and without this that is
        one session query per row; the controller resolves it once and passes it
        down. The rule still lives here — the context only carries the answer.
        """
        cached = self.env.context.get('kpi_workday_open')
        if cached is not None:
            return bool(cached)
        try:
            Session = self.env['kpi.work.session'].sudo()
            base = [
                ('user_id', '=', self.env.user.id),
                ('session_date', '=', fields.Date.context_today(self)),
                ('state', '=', 'open'),
            ]
            # An admin need not open a workday at all — they are not logging
            # developer time against a session, so the absence of one cannot
            # block them. An admin who HAS opened one and then PAUSED it is a
            # different statement, and it is honoured: the blanket skip made
            # Pause Workday a no-op for exactly the people most likely to be
            # testing it, and Start stayed live on a frozen day.
            if self._user_is_kpi_admin():
                return not Session.search_count(base + [('is_paused', '=', True)])
            # is_paused counts as "not open": a paused workday means the
            # developer has stopped, so nothing may start inside it.
            return bool(Session.search_count(base + [('is_paused', '=', False)]))
        except Exception as exc:
            # Never let a lookup failure be the thing that stops someone working.
            _logger.warning("workday-open check failed for user %s: %s",
                            self.env.user.id, exc)
            return True

    def _actor_workday_paused(self):
        """Is the acting user's workday open but PAUSED?

        Only asked when _actor_workday_open() already said no, purely to choose
        the right message. Same context short-circuit as that method, so a board
        full of blocked tasks does not run one query per row.
        """
        cached = self.env.context.get('kpi_workday_paused')
        if cached is not None:
            return bool(cached)
        try:
            return bool(self.env['kpi.work.session'].sudo().search_count([
                ('user_id', '=', self.env.user.id),
                ('session_date', '=', fields.Date.context_today(self)),
                ('state', '=', 'open'),
                ('is_paused', '=', True),
            ]))
        except Exception:
            return False

    def _multitask_blocker(self):
        """The OTHER task already running for this task's assignee, or empty.

        Empty when the assignee may multitask, when nothing else is running, or
        when this task is the one running.

        `kpi_running_task_ids` in the context short-circuits the lookup, the same
        arrangement _actor_workday_open uses and for the same reason: the board
        calls _start_block once per listed task, and without it that is one query
        per row. The controller resolves the set once and passes it down. The
        fallback query stays, because _serialize_task and the direct
        _start_block() calls in the start/resume routes do not set that context.
        """
        self.ensure_one()
        if not self.user_id or self.user_id.kpi_allow_multitask:
            return self.env['kra.kpi']
        # Every assignee's running tasks, resolved ONCE per board load by
        # /kra_kpi/tasks/get. Without it an admin board (other people's rows) fell
        # through to the search below for every listed task: ~500 table scans on a
        # 500-task board. Same answer as the search -- the map holds exactly the
        # in_progress, active tasks per user.
        by_user = self.env.context.get('kpi_running_by_user')
        if by_user is not None:
            other_ids = [i for i in by_user.get(self.user_id.id, []) if i != self.id]
            return self.sudo().browse(other_ids[:1])
        cached = self.env.context.get('kpi_running_task_ids')
        # Only usable for the caller's OWN tasks: the cached set is what THEY
        # have running. An admin's board lists other people's rows, and reusing
        # their set there would gate a developer's task on the admin's timer.
        if cached is not None and self.user_id.id == self.env.user.id:
            other_ids = [i for i in cached if i != self.id]
            return self.sudo().browse(other_ids[:1])
        try:
            return self.sudo().search([
                ('user_id', '=', self.user_id.id),
                ('id', '!=', self.id),
                ('task_state', '=', 'in_progress'),
                ('active', '=', True),
            ], limit=1)
        except Exception:
            # Never let a lookup failure be the thing that stops someone working
            # — the same stance _actor_workday_open takes.
            return self.env['kra.kpi']

    def _start_block(self):
        """Why this task cannot start, or None if it can.

        THE rule.  _assert_startable raises from it, the task serializers ship
        it to the boards as can_start/start_block_reason, and the controllers
        turn it into a readable message — so the UI cannot drift from the server
        the way a hand-maintained list of startable states always does.

        Returns (reason_key, message) with reason_key in {'workday',
        'workday_paused', 'multitask', 'admin', 'client'}, or None when the task
        is free to start.

        The workflow is: admin accepts -> client approves -> developer works.
        Since 19.0.8.6 neither gate opens by itself: the admin gate climbs the
        approval chain (kpi_escalation.py) and the client must actively approve.
        Rows auto-released before then keep pre_approval_auto_released.

        Auto-release grants permission to WORK, never permission to BILL.  A
        released task has pre_approval_decision empty — the client never said
        yes — and invoicing keys off client_final_approved, which only a real
        stage-2 sign-off sets.  That separation is the whole point: before it
        existed, silence was recorded as consent and unapproved work was billed.
        """
        self.ensure_one()
        ref = self.external_ref or self.name or self.id
        # FIRST, before anything about approvals: is this developer working today?
        #
        # Nothing used to ask. The web board was only reachable through the PIN
        # gate, and pairing opened the workday as a side effect — so "you must
        # start your day before you can work" was enforced by a screen rather than
        # by a rule. Removing the PIN removed the enforcement with it, and a
        # developer could start a task on the web having never pressed Start
        # Workday: their time logged against no session, and Presence never
        # covering it.
        #
        # Here it applies to BOTH boards and to the API, and it ships to them as
        # can_start=False with this message, so neither has to re-derive it.
        if not self._actor_workday_open():
            # Paused and never-started are different problems with different
            # fixes, so they get different messages. Telling someone to "start
            # your workday" when they have one open but paused sends them
            # looking for a button that is showing Resume.
            if self._actor_workday_paused():
                return ('workday_paused',
                        "Your workday is paused. Resume it before working on "
                        "'%s'." % ref)
            return ('workday',
                    "Start your workday before working on '%s'. Your task time "
                    "has to land inside a workday session, or it is recorded "
                    "against nothing." % ref)
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
        # The single-task limit, answered BEFORE the resumable-states return
        # below. It has to sit here: a paused task IS resumable, and resuming one
        # while another runs is exactly what the limit forbids — checking after
        # the early return would leave Resume enabled and let the server refuse
        # it on the round-trip, which is the behaviour this whole gate exists to
        # avoid. Skipped for the task that is itself running, or a developer's
        # own in-progress card would gate itself.
        blocking = self._multitask_blocker()
        if blocking:
            return ('multitask', self._multitask_message(self.user_id, blocking))
        if self.task_state in self._RESUMABLE_STATES:
            return None         # already underway — resuming is fine
        if not self.admin_accepted:
            return ('admin',
                    "'%s' is waiting for approval. You can start once it is "
                    "approved." % ref)
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
                "'%s' is waiting for the client to approve who works on it. You "
                "can start once they approve." % ref)

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
                raise ValidationError(self._multitask_message(rec.user_id, other))

    @api.model
    def _multitask_message(self, assignee, other):
        """The single-task refusal, phrased for whoever is reading it.

        This was always third person — "Ravi already has task BUG-014 in
        progress" — which is the right sentence for an admin acting on Ravi's
        task and an odd one for Ravi, who is the person who sees it almost every
        time. Shared with _start_block so the pre-emptive gate label and the
        exception cannot drift into saying different things.
        """
        ref = other.external_ref or other.name
        if assignee.id == self.env.user.id:
            return (f"You already have {ref} in progress. "
                    "Pause it first, or use Switch to hand over to another task.")
        return (f"{assignee.name} already has task {ref} in progress. "
                "That task must be paused before another can start.")

    @api.model
    def pause_all_running(self, reason='', reason_code='break', meeting_with_ids=None):
        """Pause EVERY task the current user has running, with one shared reason.

        For "I'm stopping now" — lunch, a meeting, end of the day — when
        multitask means there is more than one timer to stop. Pausing them one at
        a time leaves the others accruing productive time for minutes nobody
        worked, and it is easy to forget the second one entirely.

        One reason for all of them on purpose. A developer stopping for different
        reasons at the same instant is not a real situation; when it is, the
        per-task Pause button is still there. (And "pause this one because I'm
        moving to another" is Switch, which keeps the others running.)

        PRESENCE IS NOT DOUBLE-COUNTED. kpi.break.log keeps one active break per
        user (see kpi_break_log.start_break), so the first pause opens the break
        and the rest join it. That is deliberate: a 20-minute lunch with two
        tasks open is 20 minutes away from the desk, not 40, and inflating it
        would break the Accounted + Other/Idle = Presence reconciliation.

        Each task still gets its OWN kpi.time.log interval closed with its own
        start/end/date by pause_task, plus an audit line here — so "which tasks
        stopped, and when" stays answerable per task.

        Returns a dict so a refusal renders as a message, not a traceback.
        """
        user = self.env.user
        Log = self.env['kpi.time.log'].sudo()
        running = [l.kpi_id for l in Log.search([('user_id', '=', user.id),
                                                 ('is_active', '=', True)])
                   if l.kpi_id and l.kpi_id.task_state == 'in_progress']
        if not running:
            return {'status': False, 'message': 'You have no running tasks to pause.'}

        reason = (reason or '').strip()
        code = reason_code or 'break'
        paused = []
        for rec in running:
            try:
                # Participants ride along on every task's pause, but only the
                # FIRST one opens a break (kpi.break.log keeps one active per
                # user), so the names land once — the same reason a 20-minute
                # lunch across two tasks is 20 minutes, not 40.
                rec.with_user(user).with_context(kpi_wa_quiet=True).pause_task(
                    reason=reason, reason_code=code, meeting_with_ids=meeting_with_ids)
                paused.append(rec.external_ref or rec.name or str(rec.id))
                try:
                    rec._log_action('paused_bulk', source='web',
                                    actor_user_id=user.id,
                                    payload={'reason_code': code, 'reason': reason,
                                             'of_total': len(running)})
                except Exception:
                    pass
            except Exception as exc:
                # One bad row must not strand the rest still running — that is the
                # very state this action exists to avoid.
                _logger.warning("pause-all failed for task %s: %s", rec.id, exc)
        if not paused:
            return {'status': False, 'message': 'Could not pause your running tasks.'}
        # One line for the lot, as the bot's ⏸️ All tasks says it.
        self._wa_say_in_group(WA_PAUSED_ALL % {
            'refs': ', '.join(paused), 'who': '',
            'why': self._wa_pause_why(reason, code)}, user=user)
        return {'status': True,
                'paused_count': len(paused),
                'message': 'Paused %s task%s.' % (len(paused), '' if len(paused) == 1 else 's')}

    def revert_from_client_signoff(self, reason=''):
        """Admin pulls a task back out of Awaiting Client Sign-off.

        The client stops seeing it and the developer gets it back, paused, with
        the reason on the card.

        CLEARING admin_approved IS THE POINT, not housekeeping. The client portal
        selects on TWO branches (controllers/kpi_reports_api.py):

            task_state = 'awaiting_client'
            OR (task_state = 'partially_completed' AND admin_approved = True)

        so moving the state alone does not hide anything — the task would simply
        reappear to the client through the second branch. Withdrawing the QA
        verdict is also the honest thing to record: the admin no longer stands
        behind it.

        Only from 'awaiting_client'. A completed, client-signed task is NOT
        revertable here: its signature is what invoicing is built on, and taking
        that back is a billing decision, not a workflow one.

        Returns a dict so a refusal renders as a message, not a traceback.
        """
        self.ensure_one()
        if self.task_state != 'awaiting_client':
            return {'status': False,
                    'message': "Only a task waiting for client sign-off can be "
                               "reverted (this one is '%s')." % (self.task_state or '—')}
        # Belt and braces. client_final_approved is False for anything in
        # awaiting_client, so this should be unreachable — but destroying the
        # basis of a raised invoice is bad enough to check rather than reason
        # about from two files away.
        if self.is_invoiced:
            return {'status': False,
                    'message': "This task is already on a finalized invoice and "
                               "cannot be reverted."}

        reason = (reason or '').strip()
        self.sudo().write({
            'reverted_from':   'awaiting_client',
            'reverted_at':     fields.Datetime.now(),
            'reverted_by_id':  self.env.user.id,
            'revert_reason':   reason,
            # Back to the developer, stopped. Mirrors reject_task: land in paused
            # with the timer cleared so nothing auto-runs on the next page load.
            'task_state':            'paused',
            'timer_start_datetime':  False,
            'paused_reason': ('↩ Reverted from client sign-off by %s%s'
                              % (self.env.user.name,
                                 (' — %s' % reason) if reason else '')),
            # Withdraw the QA verdict — see the docstring. This is what actually
            # takes it off the client's screen.
            'admin_approved':       False,
            'admin_approved_by':    False,
            'admin_approved_date':  False,
            # It is no longer an approved/closed task either.
            'approved_by':   False,
            'approval_date': False,
        })
        try:
            self._log_action('reverted_from_awaiting_client', source='web',
                             actor_user_id=self.env.user.id,
                             payload={'reason': reason})
        except Exception:
            pass
        # Tell the developer. They believed this was finished; without a message
        # it silently reappears in their lane with no explanation.
        try:
            self._notify('task_reverted',
                         admin=self.env.user.name,
                         reason=reason or 'No reason given')
        except Exception as exc:
            _logger.warning("task_reverted notify failed for %s: %s", self.id, exc)
        return {'status': True,
                'message': 'Reverted — sent back to %s.' % (self.user_id.name or 'the developer'),
                'new_state': self.task_state}

    # ------------------------------------------------------------------ #
    # Undo a mistaken Start (same day: the assignee's own, or any, admin) #
    # ------------------------------------------------------------------ #
    # States Undo works from. Anything further along (verification, client
    # sign-off, completed) has had more happen to it than a mis-tap, and hold /
    # rework were put there by someone else.
    _UNDO_START_STATES = ('in_progress', 'paused')

    def _snapshot_before_start(self):
        """Remember the task as it is before the FIRST Start / Resume of the day.

        Later starts the same day by the same person keep the first snapshot, so
        Undo goes back to how the day began however many times it was paused and
        resumed. Called after the gates (a refused start leaves nothing behind)
        and before super() (which clears paused_reason). Never raises: a failed
        snapshot only means Undo is not offered, and must not stop the start.
        """
        user = self.env.user
        today = fields.Date.context_today(user)
        now = fields.Datetime.now()
        for rec in self:
            if rec.task_state in ('completed', 'partially_completed', 'awaiting_client'):
                continue
            if rec.undo_start_date == today and rec.undo_start_user_id == user:
                continue
            try:
                rec.sudo().write({
                    'undo_start_date': today,
                    'undo_start_at': now,
                    'undo_start_user_id': user.id,
                    'undo_prev_state': rec.task_state or False,
                    'undo_prev_paused_reason': rec.paused_reason or False,
                    'undo_prev_pause_code': rec.pause_reason_code or False,
                    'undo_prev_needs_reason': bool(rec.self_needs_resume_reason),
                })
            except Exception as exc:
                _logger.warning("undo snapshot failed for %s: %s", rec.id, exc)

    def _can_undo_start_cheap(self, user, today, is_admin=False):
        """The board flag: no queries, so it is safe per row. The route re-checks
        everything (_undo_start_block) before touching anything.

        A developer: their own task, a start THEY made today. An admin: any
        task started today, by anyone — they have full control."""
        self.ensure_one()
        if not (self.task_state in self._UNDO_START_STATES
                and self.undo_start_user_id and self.undo_start_at
                and self.undo_start_date == today):
            return False
        if is_admin:
            return True
        return bool(self.user_id == user and self.undo_start_user_id == user)

    def _undo_start_block(self, user):
        """'' when the caller may undo today's start of this task, else why not.

        Whose time goes is always the STARTER's (undo_start_user_id) — the one
        who pressed Start — whether they are undoing it themselves or an admin
        is doing it for them."""
        self.ensure_one()
        if self.task_state not in self._UNDO_START_STATES:
            return "Only a task that is running or paused can have its start undone."
        starter = self.undo_start_user_id
        if not self._user_is_kpi_admin(user):
            # A developer takes back only their own start on their own task.
            if self.user_id != user:
                return "Only the assigned developer or an admin can undo starting this task."
            if starter != user:
                return "This task was not started by you today, so there is nothing to undo."
        if not (starter and self.undo_start_at
                and self.undo_start_date == fields.Date.context_today(starter)):
            return "This task was not started today, so there is nothing to undo."
        today = self.undo_start_date
        # An ended day is frozen into the End Workday snapshot image; taking time
        # out of it afterwards would make the picture lie.
        if self.env['kpi.work.session'].sudo()._day_done(starter):
            return ("Your workday has ended, so today's time can no longer be changed."
                    if starter == user else
                    "%s's workday has ended, so today's time can no longer be changed." % starter.name)
        Log = self.env['kpi.time.log'].sudo()
        if Log.search_count([('kpi_id', '=', self.id), ('user_id', '!=', starter.id),
                             ('start_time', '>=', self.undo_start_at)]):
            return "Someone else has logged time on this task since it was started."
        if not Log.search_count([('kpi_id', '=', self.id), ('user_id', '=', starter.id),
                                 ('work_date', '=', today),
                                 ('start_time', '>=', self.undo_start_at)]):
            return "No time was logged on this task today, so there is nothing to undo."
        return ''

    def _undo_keeps_line(self):
        """The line on the Undo-start confirmation that says what STAYS.

        Undo takes back time and status only; the updates, links, files,
        manuals and GitHub branches added since the start are real work and
        are kept. Saying so stops anyone thinking they are about to lose them.
        '' when nothing was added since the start.
        """
        self.ensure_one()
        rec = self.sudo()
        since, who = rec.undo_start_at, rec.undo_start_user_id
        if not since or not who:
            return ''
        prog = self.env['kpi.progress'].sudo().search([
            ('kpi_id', '=', rec.id), ('user_id', '=', who.id),
            ('create_date', '>=', since), ('from_client', '=', False)])
        links = 0
        for p in prog:
            try:
                links += len(json.loads(p.related_links or '[]') or [])
            except (ValueError, TypeError):
                pass
        Att = self.env['kpi.file.attachment'].sudo()
        files = len(prog.filtered('uploaded_file')) + (
            Att.search_count([('progress_id', 'in', prog.ids)]) if prog else 0)
        manuals = self.env['kpi.user.manual'].sudo().search_count([
            ('kpi_id', '=', rec.id), ('create_date', '>=', since)]) \
            if 'kpi.user.manual' in self.env else 0
        github = self.env['kpi.github.link'].sudo().search_count([
            ('kpi_id', '=', rec.id), ('create_date', '>=', since)]) \
            if 'kpi.github.link' in self.env else 0
        updates = len(prog.filtered(lambda p: (p.summary or '').strip()))

        def n(count, word):
            return '%d %s%s' % (count, word, '' if count == 1 else 's')
        parts = [n(c, w) for c, w in ((updates, 'update'), (links, 'link'), (files, 'file'),
                                      (manuals, 'manual'), (github, 'GitHub link')) if c]
        if not parts:
            return ''
        what = ', '.join(parts[:-1]) + (' and ' if len(parts) > 1 else '') + parts[-1]
        return _('Today\'s %s on this task are kept. Only the time and status are undone.') % what

    def undo_today_start(self):
        """Put the task back as it was before today's first Start / Resume, and
        remove the time logged on it since.

        The time rows are DELETED, not flagged: kpi.time.log is summed in dozens
        of places (productive time, the Workday Map, reports, invoices) and a
        "voided" flag missed by any one of them would quietly count the time
        anyway. Each deleted interval is kept in the audit row instead.

        Breaks and non-task blocks that the start closed are left closed; they
        record where the person was, not the task. Returns a dict so a refusal
        renders as a message, not a traceback.
        """
        self.ensure_one()
        # The rules are about who is ASKING (env.user); the reads are not. A caller
        # without read access to this task must get the refusal below, not an
        # access error — so read through sudo, which keeps env.user.
        user = self.env.user
        self = self.sudo()
        # A double tap must not subtract the same time twice.
        self.env.cr.execute('SELECT id FROM kra_kpi WHERE id = %s FOR UPDATE', (self.id,))
        self.invalidate_recordset()
        msg = self._undo_start_block(user)
        if msg:
            return {'status': False, 'message': msg}

        from odoo.tools import float_round
        from .kpi_work_session import IDLE_CHECK_MIN, _fmt_hms

        # The STARTER's time goes, whoever is asking (an admin may undo a
        # developer's start). The caller is recorded as the actor below.
        starter = self.undo_start_user_id
        today = self.undo_start_date
        Log = self.env['kpi.time.log'].sudo()
        logs = Log.search([('kpi_id', '=', self.id), ('user_id', '=', starter.id),
                           ('work_date', '=', today),
                           ('start_time', '>=', self.undo_start_at)])
        # Only CLOSED rows were ever added to the total. The running segment is
        # banked on pause, and it is being thrown away, not banked.
        banked = sum(l.duration_seconds or 0.0 for l in logs if not l.is_active)
        running_secs = 0.0
        if self.timer_start_datetime:
            running_secs = max(0.0, (fields.Datetime.now() - self.timer_start_datetime).total_seconds())
        removed = banked + running_secs
        audit = [{'id': l.id, 'start': str(l.start_time or ''), 'end': str(l.end_time or ''),
                  'seconds': l.duration_seconds or 0.0, 'active': bool(l.is_active)}
                 for l in logs]
        new_total = max(0.0, float_round((self.timer_total_seconds or 0.0) - banked,
                                         precision_digits=2))
        valid = dict(self._fields['task_state'].selection)
        prev = self.undo_prev_state if self.undo_prev_state in valid else (
            'paused' if new_total > 0 else 'assigned')
        # Undo lands on a stopped state; never "restore" into running.
        if prev == 'in_progress':
            prev = 'paused'
        code = self.undo_prev_pause_code
        if code and code not in dict(self._fields['pause_reason_code'].selection):
            code = False

        logs.unlink()
        self.sudo().write({
            'task_state': prev,
            'timer_start_datetime': False,
            'timer_total_seconds': new_total,
            'paused_reason': self.undo_prev_paused_reason or False,
            'pause_reason_code': code or False,
            'self_needs_resume_reason': bool(self.undo_prev_needs_reason),
            'undo_start_date': False,
            'undo_start_at': False,
            'undo_start_user_id': False,
            'undo_prev_state': False,
            'undo_prev_paused_reason': False,
            'undo_prev_pause_code': False,
            'undo_prev_needs_reason': False,
        })

        # start_task dropped the idle check. With nothing else running, re-arm it
        # so the "what are you doing?" prompt still comes.
        try:
            if not Log.search_count([('user_id', '=', starter.id), ('is_active', '=', True)]):
                sess = self.env['kpi.work.session'].sudo().search(
                    [('user_id', '=', starter.id), ('state', '=', 'open')], limit=1)
                if sess and not sess.idle_check_at:
                    sess.write({'idle_check_at': fields.Datetime.now() + timedelta(minutes=IDLE_CHECK_MIN),
                                'idle_check_count': 0})
        except Exception as exc:
            _logger.warning("undo start: idle re-arm failed for %s: %s", self.id, exc)

        # Accepted by an admin WHILE it ran: the accept route skips the client
        # pre-approval for a running task, so going back to a fresh state without
        # asking now would leave it waiting on nobody.
        if (prev in ('assigned', 'urgent', 'important', 'regular', 'queue_waiting')
                and self.is_self_created and self.admin_accepted and not self.approval_token):
            try:
                self.request_client_pre_approval()
            except Exception as exc:
                _logger.warning("undo start: pre-approval failed for %s: %s", self.id, exc)

        try:
            self._log_action('start_undone', source='web', actor_user_id=user.id,
                             payload={'restored_state': prev,
                                      'started_by': starter.id,
                                      'removed_seconds': removed,
                                      'day': str(today), 'logs': audit})
        except Exception:
            pass
        return {'status': True, 'id': self.id, 'new_state': self.task_state,
                'removed_seconds': removed,
                'message': 'Start undone: %s removed.' % _fmt_hms(removed)}

    def switch_to_task(self, from_kpi_id=None, note=''):
        """Swap ONE running task for this one. Anything else keeps running.

        `from_kpi_id` is the task being handed over. Pass it and only that task
        pauses — which is the whole point under multitask: working task 1 and
        task 2, switching task 1 to task 3 must leave task 2 running without a
        break in its timer. Omit it and every running task pauses, which is what
        the single-task case means by "switch".

        THE ORDER MATTERS, and it is why this is server-side rather than the board
        calling pause then start: the target is checked for startability BEFORE
        anything is paused. A task can be refused now — workday not open, admin
        hasn't accepted, client hasn't approved — and if we paused first and the
        start was then refused, the developer would be left with their old task
        stopped and nothing running. Strictly worse than where they began.

        The pause is recorded as 'priority_task' ("Another Priority Task"), which
        already exists and is precisely this situation. Without a reason the gap
        would land on the Workday Map as unexplained idle.

        Returns a dict rather than raising, so a refusal shows as a message
        instead of a traceback: {status, message, reason, from_ids, to_id}.
        """
        self.ensure_one()
        # 1. Can we even start the target? Refuse before touching anything.
        block = self._start_block()
        if block:
            return {'status': False, 'reason': block[0], 'message': block[1]}

        user = self.env.user
        Log = self.env['kpi.time.log'].sudo()
        # 2. Which timers to stop. Only ever this user's own running tasks — the
        #    from_kpi_id arrives from a client, so it is filtered against what
        #    they actually have running rather than trusted to name a task.
        running = [l.kpi_id for l in Log.search([('user_id', '=', user.id),
                                                 ('is_active', '=', True)])
                   if l.kpi_id and l.kpi_id.id != self.id
                   and l.kpi_id.task_state == 'in_progress']
        if from_kpi_id:
            running = [r for r in running if r.id == int(from_kpi_id)]
        # The pause and the start below are one switch: the WhatsApp group hears
        # ONE "🔀 switched from A to B" (said at the end), not a pause and a take.
        quiet = self.with_context(kpi_wa_quiet=True)
        for rec in running:
            rec.with_user(user).with_context(kpi_wa_quiet=True).pause_task(
                reason=note or SWITCH_NOTE,
                reason_code='priority_task')

        # 3. Start (or resume) the target. Both routes re-assert the gates.
        if self.task_state in ('paused', 'rework', 'partially_completed'):
            quiet.with_user(user).resume_task()
        else:
            quiet.with_user(user).start_task()

        self._log_action('task_switched', source='web',
                         actor_user_id=user.id,
                         payload={'from': [r.id for r in running], 'to': self.id,
                                  'note': note or ''})
        if running:
            self._wa_say_in_group(WA_SWITCHED_FROM % {
                'who': user.name or '', 'a': ', '.join(r._wa_ref() for r in running),
                'b': self._wa_ref()}, user=user)
        else:
            self._wa_say_in_group(WA_SWITCHED_TO % {
                'who': user.name or '', 'ref': self._wa_ref(), 'still': ''}, user=user)
        return {'status': True,
                'message': 'Switched to %s' % (self.external_ref or self.name),
                'from_ids': [r.id for r in running], 'to_id': self.id,
                'new_state': self.task_state}

    def start_task(self):
        # A developer may have at most ONE in_progress task at a time — unless
        # their kpi_allow_multitask flag is on (enforced in _check_single_task_limit).
        self._check_single_task_limit()
        # Client approval is mandatory before any work begins.  The old
        # 'start_prep' path (starting from pre_approval_partial) is gone: it
        # let developers work on tasks the client had never approved.
        self._assert_startable()
        prev = {rec.id: rec.task_state for rec in self}
        # After the gates, before anything moves: what Undo would put back.
        self._snapshot_before_start()
        result = super().start_task()
        # Starting work closes any open break/lunch — the same rule resume_task and
        # complete_task already applied. start_task did not, so pausing one task
        # and then STARTING a fresh one (which is what Switch does when the target
        # has never run) left the break open across the new task's interval. That
        # break then counted in `metered` while the task counted in `productive`,
        # putting `accounted` above `presence` — the same double-count as pausing
        # under multitask, reached by the other door.
        self.env['kpi.break.log'].stop_break(self.env.user.id)
        # ...and any open non-task block, for the same reason.
        self._end_nontask_for_work('task started')
        for rec in self:
            rec._wrap_lifecycle('start', prev_state=prev.get(rec.id))
        return result

    def pause_task(self, reason='', reason_code=False, at=None, meeting_with_ids=None):
        # `at` MUST be forwarded to super(), which is where the timer and the
        # kpi.time.log actually close. This override is the one MRO resolves, so
        # without the parameter here `_pause_running_task(at=eod)` raised
        # TypeError — and because that call site wraps itself in a broad
        # `except Exception: log a warning`, the midnight close would have gone on
        # to close the session while silently NOT pausing the task at all. Leaving
        # a task running past its own close is worse than the overrun this fix
        # exists to prevent, so the signatures have to stay in step.
        if reason_code:
            # Pass through to write so the field updates regardless of the original method
            self.sudo().write({'pause_reason_code': reason_code})
        result = super().pause_task(reason=reason, at=at)
        for rec in self:
            rec._wrap_lifecycle('pause', payload={'reason': reason, 'reason_code': reason_code or rec.pause_reason_code})
        # ANY reason (break/lunch/meeting/other/away/typed) starts a metered interval —
        # recorded ONLY in kpi.break.log, never in kpi.time.log, so it shows in Presence
        # but never in Productive time. The task it was paused FROM + the typed note are
        # kept so the live panel / summary can show "(from <task>)".
        # A break means AWAY FROM THE DESK, so it must not open while the
        # developer is still working on something else. Under multitask, pausing
        # task A while task B runs used to open one anyway — and because
        # kpi.break.log keeps a single active row per user, that break overlapped
        # B's productive interval and got counted twice: once in `productive`
        # (the union of task intervals) and again in `metered`. `accounted` then
        # exceeded `presence`, which is impossible, and other_idle floored to 0 and
        # hid it. Measured on real data: a 192s break inside a running task pushed
        # accounted 42s past presence.
        #
        # super() has already closed THIS task's log by now, so an is_active log
        # here means a genuinely different task is still running.
        still_working = bool(self.env['kpi.time.log'].sudo().search_count([
            ('user_id', '=', self.env.user.id), ('is_active', '=', True),
        ]))
        if reason_code and not still_working:
            # `at` matters here for the same reason as above. kpi.break.log's
            # work_date is computed from start_time, so an auto-close firing after
            # midnight would open this break stamped now() and file it against the
            # NEXT day — away time on a date with no session, missing from the day
            # it belongs to.
            self.env['kpi.break.log'].start_break(
                reason_code, self.env.user.id,
                source_task_id=self.id if len(self) == 1 else False,
                reason_note=reason or False,
                at=at,
                # Only meaningful for 'meeting'; ignored for every other code.
                meeting_with_ids=meeting_with_ids if reason_code == 'meeting' else None,
            )
        elif reason_code:
            # The reason is still recorded on the task (pause_reason_code above);
            # only the away-time interval is skipped, because there is none.
            # NOTE: meeting participants live on the break row, so a Meeting pause
            # taken while another task keeps running records the reason but not
            # who it was with — there is no away-interval to hang them on. That is
            # the correct reading (the developer is not away), but it is worth
            # knowing before wondering where the names went.
            _logger.info(
                "pause: not opening a '%s' break for %s — another task is still "
                "running, so this is not away-time", reason_code, self.env.user.login)
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
        because other_idle is max(0, presence - productive - metered - paused) the
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
        self._snapshot_before_start()
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

    MANUAL_REQUIRED_MSG = ('This is a Module / App task — add the user manual (a PDF, DOC or DOCX '
                           'file, or a link) before completing, or use Partial Finish to send a summary only.')

    def _manual_required_refusal(self):
        """A full Complete of a Module / App task needs a user manual: a file
        (never a photo from Upload Requirements) or a manual link. Other types
        never ask. Partial Finish never asks. Returns the message, or False."""
        self.ensure_one()
        rule = self._completion_rule('manual')
        return self.MANUAL_REQUIRED_MSG if (rule and rule['required'] and not rule['done']) else False

    # ------------------------------------------------------------------
    # What Complete needs, by task type. ONE list for the Odoo page, the web
    # app, the WhatsApp page and chat, and the old text commands:
    #   database task (new database / destroy / type Database): URL, database
    #     name, username, password -- summary optional, nothing else;
    #   bug fix: summary;  app: summary, app link, user manual, GitHub;
    #   module: summary, user manual, GitHub;  website: summary (+ website URL,
    #   optional);  other / EXE / update: summary.
    # Several types on one task: everything each asks for.
    def _is_db_task(self):
        self.ensure_one()
        return (self.request_category in ('new_database', 'db_disconnect')
                or 'database' in (self.deliverable_type or '').split(','))

    def _is_bug_task(self):
        self.ensure_one()
        return (self.name or '').startswith('[Bug]') or (self.external_ref or '').upper().startswith('BUG')

    def _completion_rules(self):
        """[{key, label, required, done}] for this task's Complete step."""
        self.ensure_one()
        me = self.sudo()
        rules = []

        # warn: not needed to complete, but every Complete screen warns when it
        # is missing (the user manual and the GitHub link, Oct 2026).
        def add(key, label, required, done, warn=False):
            rules.append({'key': key, 'label': label, 'required': bool(required), 'done': bool(done),
                          'warn': bool(warn)})

        has_summary = bool(self.env['kpi.progress'].sudo().search_count(
            [('kpi_id', '=', self.id), ('from_client', '=', False)]))
        if self._is_db_task():
            add('summary', _('Progress summary'), False, has_summary)
            add('db_url', _('URL'), True, me.provision_url)
            add('db_name', _('Database name'), True, me.provision_db_name)
            add('db_user', _('Username'), True, me.provision_username)
            add('db_password', _('Password'), True, me.provision_password)
            return rules
        add('summary', _('Progress summary'), True, has_summary)
        if self._is_bug_task():
            return rules
        types = set((self.deliverable_type or '').split(','))
        if 'app' in types:
            add('app_link', _('App link'), True, me.app_link)
        if types & {'module', 'app'}:
            add('manual', _('User manual'), False,
                me.user_manual_url or self.env['kpi.user.manual'].sudo().search_count(
                    [('kpi_id', '=', self.id), ('is_intake_media', '=', False)]), warn=True)
            add('github', _('GitHub link'), False,
                self.env['kpi.github.link'].sudo().search_count([('kpi_id', '=', self.id)]), warn=True)
        if 'website' in types:
            add('website_url', _('Website URL'), False, me.website_url)
        return rules

    def _completion_rule(self, key):
        return next((r for r in self._completion_rules() if r['key'] == key), None)

    def _completion_missing(self, skip=()):
        """Labels of what a full Complete still needs (required and not done)."""
        self.ensure_one()
        return [r['label'] for r in self._completion_rules()
                if r['required'] and not r['done'] and r['key'] not in skip]

    def _completion_warnings(self):
        """Labels of what is recommended but not added (user manual, GitHub
        link): Complete still goes through, the screens warn."""
        self.ensure_one()
        return [r['label'] for r in self._completion_rules() if r.get('warn') and not r['done']]

    def _completion_refusal(self, skip=()):
        """The message for a full Complete that is missing something, else False."""
        missing = self._completion_missing(skip=skip)
        if not missing:
            return False
        return _('Before completing %(ref)s, add: %(what)s. Or use Partial Finish to send a summary only.') % {
            'ref': self.external_ref or self.name, 'what': ', '.join(missing)}

    GITHUB_REQUIRED_MSG = ('This is a Module / App task — add the GitHub link (repository + branch) '
                           'before completing, or use Partial Finish to send a summary only.')

    def _github_required(self):
        """Module or App among the task's types: the code has to be on GitHub."""
        self.ensure_one()
        return bool({'module', 'app'} & set((self.deliverable_type or '').split(',')))

    def _github_required_refusal(self):
        """A full Complete of a Module / App task needs a GitHub link on it (one
        already added counts). A bug fix or any other type: optional. Partial
        Finish never asks. Returns the message to show, or False."""
        self.ensure_one()
        rule = self._completion_rule('github')
        return self.GITHUB_REQUIRED_MSG if (rule and rule['required'] and not rule['done']) else False

    def complete_task(self, employee_checklist=None):
        result = super().complete_task(employee_checklist=employee_checklist)
        # Completing also closes any open break/lunch.
        self.env['kpi.break.log'].stop_break(self.env.user.id)
        for rec in self:
            rec._wrap_lifecycle('complete')
            # Finished work: the admins get a private link to approve or send
            # it back (kpi_wa_admin_link.py). Never raises.
            if rec.task_state == 'partially_completed' and not rec.admin_approved:
                rec._wa_ask_admins('qa')
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
    # Admin delete — only a task nobody has worked on                     #
    # ------------------------------------------------------------------ #
    # States in which a task can still be considered "not started".  Anything
    # else (in_progress, paused, partially_completed, awaiting_client,
    # completed, hold) means work or a decision already happened.
    _DELETABLE_STATES = (
        'assigned', 'urgent', 'important', 'regular', 'queue_waiting',
        'pre_approval_pending', 'pre_approval_approved', 'pre_approval_partial',
        'rework',
    )

    def _may_admin_delete(self, logged_ids=None):
        """(ok, reason) — may an admin delete this task outright?

        Only when NOBODY has worked on it.  Deleting a task with recorded time
        destroys kpi.time.log rows, which are what every report, the daily
        summary and the invoice are built from — so the time check, not the
        state, is the real gate here.  The state list is the second guard for
        the cases where a decision (client sign-off, completion) exists without
        much time behind it.

        `logged_ids` is an optional pre-computed set of kpi ids that HAVE time
        logs.  The task board calls this once per listed task, and without it
        that is one COUNT query per row; pass the batch answer in and the rule
        still lives here, in one place, rather than being re-derived by callers.
        """
        self.ensure_one()
        if self.timer_start_datetime or self.timer_total_seconds:
            return False, "'%s' has already been started — its recorded time would be lost." % (
                self.external_ref or self.name or self.id)
        if logged_ids is not None:
            logged = 1 if self.id in logged_ids else 0
        else:
            logged = self.env['kpi.time.log'].sudo().search_count([('kpi_id', '=', self.id)])
        if logged:
            return False, "'%s' has recorded work against it — delete would destroy time logs." % (
                self.external_ref or self.name or self.id)
        if self.task_state not in self._DELETABLE_STATES:
            label = dict(self._fields['task_state'].selection).get(
                self.task_state, self.task_state)
            return False, "'%s' is '%s' — only a task that was never started can be deleted." % (
                self.external_ref or self.name or self.id, label)
        return True, ''

    # ------------------------------------------------------------------ #
    # Admin acceptance — arming, auto-accept, cron                        #
    # ------------------------------------------------------------------ #
    @api.model
    def _user_is_kpi_admin(self, user=None):
        """Coordinator / Owner / System — the roles that may accept a task.

        THE definition. The admin gate-skip on create and the delete guard must
        agree on who counts as an admin, and this triple was previously copied
        into half a dozen controllers where it could drift one at a time.
        controllers/kra_api.py._is_kra_admin delegates here.
        """
        user = user or self.env.user
        return (
            user.has_group('kra_kpi_module.group_kra_admin')
            or user.has_group('kra_kpi_module.group_kra_owner')
            or user.has_group('base.group_system')
        )

    def _arm_admin_accept_deadline(self, force=False):
        """Retired (19.0.8.6) — deliberately a no-op.

        This started a clock after which _cron_admin_accept_timeout accepted the
        task for nobody. Nothing is accepted automatically any more: a waiting
        task climbs the approval chain (kpi_escalation.py) and the last step is
        reminded until a person decides. Kept so a stray caller does not break.
        """
        return

    def _auto_admin_accept(self, by_user=None):
        """Accept a task, categorise it, and hand it to the client.

        Mirrors /kra_kpi/task/admin_accept minus the human: same categorisation,
        same re-numbering, same "don't disturb a running timer" guard.  The
        admin keeps every power they had — re-categorise, reject, send back —
        they just no longer hold up the developer by not looking.

        `by_user` is the admin who caused this acceptance, and it changes what
        the row MEANS:
          * None    — the acceptance window elapsed and nobody acted.  Recorded
                      as admin_accepted_auto with no decider, and the developer
                      is told the window ran out.
          * a user  — an admin created the task themselves, so the acceptance IS
                      their decision.  Making them wait on their own gate (and
                      then filing it as "nobody looked at this") was the bug.
        """
        self.ensure_one()
        auto = not by_user
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
            'admin_accepted_auto':      auto,
            'admin_accepted_at':        fields.Datetime.now(),
            # Empty ONLY on the timeout path — nobody decided, and that is the
            # point.  An admin-created task records the admin who created it.
            'admin_accepted_by_id':     by_user.id if by_user else False,
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
        # which needs admin_accepted to ALREADY be true — so a task armed at
        # assignment was never published. Do it here or it stays invisible to the
        # team while claiming to be accepted.
        #
        # This used to read `if self.client_submitted`, which made the hole
        # client-only: a task an ADMIN created and assigned was accepted (here or
        # by the cron) and STILL never published, and the employee record rule
        # (security/kpi_security_rules.xml) filters on published=True — so its own
        # developer could not see it at all, ever. Any accepted task that has a
        # developer belongs on that developer's board.
        if self.user_id and not self.published:
            vals['published'] = True
        self.sudo().write(vals)
        self._log_action('admin_accept_auto' if auto else 'admin_accept_on_create',
                         source='cron' if auto else 'web',
                         actor_user_id=by_user.id if by_user else None,
                         payload={'window_min': self._admin_accept_minutes(),
                                  'doc_type': doc_type, 'new_ref': self.external_ref})
        # Only ask the client if the developer hasn't already got going; a
        # running timer and its accrued time are never disturbed.
        if self.task_state in ('assigned', 'urgent', 'important', 'regular', 'queue_waiting'):
            try:
                self.request_client_pre_approval()
            except Exception as exc:
                _logger.warning("auto-accept pre-approval failed for %s: %s", self.id, exc)
        # Only the TIMEOUT path announces itself. On the admin-created path
        # nothing timed out — create() has already fired 'task_created' to the
        # developer, and telling them "no admin looked at this in time" about a
        # task an admin had just written would be plainly false.
        if not auto:
            return
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
        """Retired (19.0.8.6) — deliberately a no-op.

        This accepted tasks whose admin window elapsed. Nothing is accepted
        automatically any more: undecided tasks climb the approval chain
        (kpi_escalation._cron_escalate_tiers), which reminds but never accepts.

        Kept as a no-op (rather than deleted) because the cron record may still
        exist in a deployed DB and would error on a missing method. The cron in
        data/kpi_admin_accept_cron.xml is also deactivated.
        """
        return 0

    # ------------------------------------------------------------------ #
    # Cron — client approval reminders, then auto-RELEASE                 #
    # ------------------------------------------------------------------ #
    @api.model
    def _cron_pre_approval_timeout(self):
        """Chase the client.

        Reminders on pre_approval_deadline_at.  The hard release on
        pre_approval_release_at is retired (19.0.8.6) and always reports 0.

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
                # drops the row from this search; the task still waits for the
                # client to actually approve.
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
        """Retired (19.0.8.6) — deliberately a no-op.

        This released a task for work when the client stayed silent past their
        window. The client must now actively approve; silence keeps the task
        waiting (the reminder sweep above still chases them).
        Rows released before then keep pre_approval_auto_released.
        """
        return 0

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
            'pre_approval_release_at':  False,
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
