"""Notification dispatcher — single _notify() per kra.kpi event.

Responsibilities:
  * Read the per-event toggle from whatsapp.config; bail if disabled.
  * Resolve recipients per the role matrix (see plan, Section D).
  * Format the message body from a centralized template dict.
  * Send via env['whatsapp.session'].send_message(phone, text).
  * Push a bus.bus notification for any logged-in dashboard recipients.
  * Log every attempt (success or failure) to kpi.action.log.
"""

import json
import logging
import re

import pytz
import requests

from odoo import api, fields, models

# Expo push service endpoint. The app registers an Expo push token; we POST
# here and Expo relays to FCM (Android) / APNs (iOS).
_EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'


def _fmt_ist(dt, fmt='%d/%m %H:%M'):
    """Format a UTC datetime in IST (Asia/Kolkata) for WhatsApp display.
    All users on the system are on IST so we hard-pin the tz instead of
    pulling it per-recipient (which is meaningless for a single send body).
    """
    if not dt:
        return ''
    try:
        if dt.tzinfo is None:
            utc_dt = pytz.UTC.localize(dt)
        else:
            utc_dt = dt
        return utc_dt.astimezone(pytz.timezone('Asia/Kolkata')).strftime(fmt)
    except Exception:
        try:
            return dt.strftime(fmt)
        except Exception:
            return ''

_logger = logging.getLogger(__name__)


# Events that also get persisted as browsable in-app notifications
# (kpi.notification rows). Deliberately limited to assignment + upload/creation
# events — start/pause/complete/approval lifecycle noise is left out of the feed.
# `task_created` covers both single new tasks and the bulk requirement/update/bug
# uploads (each uploaded row is a kra.kpi.create → task_created).
_PERSIST_EVENTS = {
    'task_created',
    'task_assigned',
    'reassigned',
    'self_task_submitted',
    'task_auto_away',   # web went idle/asleep → task auto-paused → tell the dev's phone
}

# Short human labels for the in-app notification title (the body reuses the
# full WhatsApp message text).
_NOTIF_TITLES = {
    'task_created':        'New task added',
    'task_assigned':       'New task assigned',
    'reassigned':          'Task reassigned',
    'self_task_submitted': 'Task submitted for review',
    'task_auto_away':      'Task paused — you went away',
}


# Map event-name → whatsapp.config toggle field.
_EVENT_TO_TOGGLE = {
    'task_created':              'notify_task_created',
    'pre_approval_request':      'notify_pre_approval_request',
    'pre_approval_decided':      'notify_pre_approval_decided',
    'pre_approval_decided_late': 'notify_pre_approval_decided',  # reuse toggle
    'partial_timeout':           'notify_partial_timeout',
    'start':                     'notify_start',
    'start_prep':                'notify_start',
    'pause':                     'notify_pause',
    'resume':                    'notify_resume',
    'complete':                  'notify_complete',
    'internal_approved':         'notify_internal_approved',
    'internal_rejected':         'notify_internal_rejected',
    'final_approved':            'notify_internal_approved',
    # Reassignment reuses the task_created toggle since both events
    # signal "this task now needs a (new) developer's attention".
    'reassigned':                'notify_task_created',
    # Daily summary — end-of-day or cron-closed workday.
    'daily_summary':             'notify_daily_summary',
    # Workday-started — fires the first time the dev opens the dashboard each day.
    'workday_started':           'notify_workday_started',
    # Auto-away — mutable dev notice when the idle cron pauses their task.
    'task_auto_away':            'notify_task_auto_away',
    # Reminder to client when developer starts on a pre_approval_partial task.
    'pre_approval_reminder':     'notify_pre_approval_request',  # reuse pre-approval toggle
    # First-time developer assignment (after client already approved).
    'task_assigned':             'notify_task_created',           # reuse task_created toggle
    # Developer self-created "Pending Review" lane events (reuse existing toggles).
    'self_task_submitted':       'notify_task_created',
    'self_task_accepted':        'notify_internal_approved',
    'self_task_rejected':        'notify_internal_rejected',
}


# Role recipient matrix per event. Each event lists which roles get the message.
_EVENT_RECIPIENTS = {
    'task_created':              ('owner', 'coordinator'),
    # CLIENT ONLY (2026-06-12 simplification): owner+coord already got
    # `task_created` a moment before, and the `pre_approval_request` body is
    # client-shaped (tap-to-send wa.me buttons + cloudflare URL) so it's
    # noise for non-client recipients.
    'pre_approval_request':      ('client',),
    'pre_approval_decided':      ('owner', 'coordinator', 'developer'),
    # Late approval — owner is the primary recipient (they need to know the
    # decision came after the prep window).  Coord + dev also informed.
    'pre_approval_decided_late': ('owner', 'coordinator', 'developer'),
    'partial_timeout':           ('owner', 'coordinator', 'developer'),
    'start':                     ('owner', 'coordinator'),
    'start_prep':                ('owner', 'coordinator'),
    'pause':                     ('owner', 'coordinator'),
    'resume':                    ('owner', 'coordinator'),
    'complete':                  ('owner', 'coordinator'),
    # Coordinator approves the dev work → notify the CLIENT (they need to sign off next).
    # Per user directive: developer is NOT messaged at this step — only client + owner +
    # coordinator. The client message carries tap-to-send buttons for final sign-off.
    'internal_approved':         ('client', 'owner', 'coordinator'),
    'internal_rejected':         ('coordinator', 'developer'),
    # Client signed off → notify everyone (Section 7 + Section 9 trigger)
    'final_approved':            ('owner', 'coordinator', 'developer'),
    # Reassignment - new developer needs the WhatsApp ping; owner observes.
    'reassigned':                ('owner', 'coordinator', 'developer'),
    # Daily summary — owner + coordinator only.
    'daily_summary':             ('owner', 'coordinator'),
    # Workday-started — owner + coordinator hear "dev X started their day".
    'workday_started':           ('owner', 'coordinator'),
    # Pre-approval reminder — client only.
    'pre_approval_reminder':     ('client',),
    # First-time developer assignment — developer + owner + coordinator.
    'task_assigned':             ('developer', 'owner', 'coordinator'),
    # Developer self-created lane: submission → admins; accept/reject → the dev.
    'self_task_submitted':       ('owner', 'coordinator'),
    'self_task_accepted':        ('developer',),
    'self_task_rejected':        ('developer',),
    # Auto-away — tell the DEVELOPER their running task was paused while away.
    'task_auto_away':            ('developer',),
    # Urgent pause — owner + any configured extra numbers get the dev's note.
    'urgent_pause':              ('owner', 'urgent_extra'),
}


# Centralized message templates. {fields} are filled from `ctx` + the record.
_TEMPLATES = {
    'task_created': (
        "🆕 New Task Created\n"
        "{title}\n"
        "Client: {client} • Project: {project}\n"
        "Priority: {priority} • Deadline: {deadline}\n"
        "👤 Created by: {created_by}"
    ),
    'task_auto_away': (
        "⚠ {dev}, your task {ref} \"{name}\" was auto-paused (Away) at {time} — "
        "the KPI board was closed or idle. Open it to resume; your task time is NOT running."
    ),
    'urgent_pause': (
        "🚨 URGENT — {dev} flagged a blocker\n"
        "📌 {title} ({ref})\n"
        "📝 {note}\n"
        "📞 From: {dev} ({dev_number})\n"
        "The developer paused this task and needs attention now."
    ),
    # Developer self-created "Pending Review" lane (passthrough — ctx supplies keys).
    'self_task_submitted': (
        "🆕 Developer self-created a task — pending your review\n"
        "📌 {title}\n"
        "👤 By: {dev} • Project: {project}\n"
        "⏱ Estimate: {estimate} • Priority: {priority}\n"
        "Open the KPI board to Accept it into the main flow."
    ),
    'self_task_accepted': (
        "✅ Your task was accepted — it's now official\n"
        "📌 {title}\n"
        "Project: {project}\n"
        "It has entered the normal flow; keep going."
    ),
    'self_task_rejected': (
        "🔁 Your self-created task was sent back\n"
        "📌 {title}\n"
        "Reason: {reason}\n"
        "Open the KPI board to revise it."
    ),
    'pre_approval_request': (
        "👋 Hi {client_name},\n"
        "A new task needs your approval:\n"
        "📌 {title}\n"
        "🗓 Deadline: {deadline}\n"
        "👤 Created by: {created_by}\n\n"
        "TAP A BUTTON BELOW (opens this chat with the action pre-filled — just tap Send):\n"
        "✅ Approve  →  {tap_approve}\n"
        "❌ Reject   →  {tap_reject}\n"
        "⏸ Hold     →  {tap_hold}\n"
        "💬 Clarify  →  {tap_clarify}\n\n"
        "Or type it manually: 1-{token_short} / 2-{token_short} / 3-{token_short} / 4-{token_short}\n"
        "Or tap to review on web → {url}\n"
        "(Auto-prep starts in 5 min if no response.)"
    ),
    # Sent to client when developer presses Start on a pre_approval_partial task.
    # Token is still live (the cron only changed task_state, not the token), so
    # the same tap-to-send buttons + URL still work for late approval.
    'pre_approval_reminder': (
        "⚠️ Reminder — please approve task {ref}\n"
        "📌 {title}\n"
        "Project: {project} • Deadline: {deadline}\n"
        "👤 Developer: {dev} has started PREP work on this task in non-billable mode "
        "because we haven't received your approval yet.\n\n"
        "Please approve so the work can be billed as a full task:\n"
        "✅ Approve  →  {tap_approve}\n"
        "❌ Reject   →  {tap_reject}\n"
        "💬 Clarify  →  {tap_clarify}\n\n"
        "Or tap to review on web → {url}"
    ),
    'pre_approval_decided': (
        "{decision_emoji} Client {decision_caps} — start the task\n"
        "Ref: {ref}  •  Project: {project}\n"
        "Title: {title}\n"
        "Description: {description}\n"
        "Developer: {dev}  •  Estimate: {estimate}\n"
        "Approved by: {decided_by} via {source}\n"
        "At: {decided_at}\n"
        "Note: {feedback}\n"
        "Developer: open the web dashboard and press Start."
    ),
    # LATE approval (client decided AFTER the 5-min prep window).
    # Owner-emphasising wording so it's clear this isn't the on-time path.
    'pre_approval_decided_late': (
        "⏰ Late approval — client {decision_caps}\n"
        "Ref: {ref}  •  Project: {project}\n"
        "Title: {title}\n"
        "Description: {description}\n"
        "Developer: {dev}  •  Estimate: {estimate}\n"
        "Approved by: {decided_by} via {source}\n"
        "Approved at: {decided_at}  (after auto-partial)\n"
        "Note: {feedback}\n"
        "Work continues from current state — no rollback."
    ),
    'partial_timeout': (
        "⌛ No client reply in 5 min — auto partially approved\n"
        "Ref: {ref}  •  Project: {project}\n"
        "Title: {title}\n"
        "Description: {description}\n"
        "Developer: {dev}  •  Estimate: {estimate}\n"
        "Timed out at: {now}\n"
        "May start PREP only (not billable).\n"
        "Developer: open the web dashboard and press Start to begin prep."
    ),
    'start': (
        "▶️ Task Started — {title}\nRef: {ref}\nBy: {dev} • Project: {project}"
    ),
    'start_prep': "🟡 Prep Started — {title}\nRef: {ref}\nBy: {dev} (non-billable)",
    'pause':  (
        "⏸ Task Paused — {title}\nRef: {ref}\nBy: {dev}\nReason: {pause_reason}"
    ),
    'resume': "▶️ Task Resumed — {title}\nRef: {ref}\nBy: {dev}",
    'complete': (
        "✅ Task Completed — {title}\nRef: {ref}\n"
        "By: {dev} • Total time: {elapsed}\n"
        "Coordinator: open the web dashboard to review."
    ),
    'internal_approved':  (
        "✅ Coordinator approved — {title}\n"
        "Ref: {ref}  •  Project: {project}\n"
        "Developer: {dev}  •  Total time: {elapsed}\n"
        "\n"
        "🖋 CLIENT — please sign off so we can invoice this work.\n"
        "TAP A BUTTON BELOW (opens this chat with the action pre-filled — just tap Send):\n"
        "✅ Approve & Sign  →  {tap_approve}\n"
        "❌ Reject (rework) →  {tap_reject}\n"
        "💬 Clarify         →  {tap_clarify}\n"
        "\n"
        "Or type it manually: 1-{token_short} / 2-{token_short} / 4-{token_short}\n"
        "Or tap to review on web → {url}\n"
        "(The phone number that replies will be recorded as the approver.)"
    ),
    'internal_rejected':  "❌ Coordinator rejected — {title}\nFeedback: {feedback}",
    'final_approved': (
        "🎉 CLIENT APPROVED — {title}\n"
        "Project: {project} • Ref: {ref}\n"
        "Developer: {dev}\n"
        "Total time: {elapsed}\n"
        "Signed by: {decided_by}"
    ),
    'reassigned': (
        "🔄 Task REASSIGNED — {title}\n"
        "Ref: {ref}  •  Project: {project}\n"
        "Description: {description}\n"
        "New developer: {dev}  •  Estimate: {estimate}\n"
        "Reason: {feedback}\n"
        "New developer: open the web dashboard and press Start."
    ),
    # First-time developer assignment (after client has already approved).
    # Coordinator picked a dev for a task that had been sitting unassigned.
    'task_assigned': (
        "📋 Task ASSIGNED — {title}\n"
        "Ref: {ref}  •  Project: {project}\n"
        "Client: {client}  •  Priority: {priority}\n"
        "Deadline: {deadline}  •  Estimate: {estimate}\n"
        "Description: {description}\n"
        "Assigned to: {dev}\n"
        "Developer: open the web dashboard and press Start when you're ready."
    ),
    # Developer end-of-day summary — sent to owner + coordinator.
    'daily_summary': (
        "🗓 Daily Summary — {dev}\n"
        "Date: {session_date}\n"
        "{session_note}"
        "First login: {login_at}  •  Last logout: {logout_at}\n"
        "Productive: {productive}  •  Presence: {presence}\n"
        "{multitask_note}"
        "Tasks worked ({task_count}):\n"
        "{task_lines}\n"
        "{auto_note}"
    ),
    # Developer started workday — sent to owner + coordinator.
    'workday_started': (
        "🌅 Workday Started — {dev}\n"
        "Date: {session_date}\n"
        "Login: {login_at}\n"
        "(Daily summary will follow at logout.)"
    ),
}


# Events whose `ctx` already carries every placeholder for the template —
# bypass _format_message's per-record parameter assembly.  Used for non-
# kra.kpi-anchored events like daily_summary / workday_started.
_PASSTHROUGH_EVENTS = ('daily_summary', 'workday_started', 'task_auto_away',
                       'self_task_submitted', 'self_task_accepted', 'self_task_rejected')


_DECISION_EMOJI = {
    'approve': '✅', 'reject':  '❌', 'hold': '⏸', 'clarify': '💬',
}


def _norm_phone(phone):
    """Normalize a phone to digits only for dedup; return None if too short."""
    if not phone:
        return None
    digits = re.sub(r'\D+', '', phone)
    return digits if len(digits) >= 6 else None


def _format_elapsed_seconds(sec):
    sec = int(sec or 0)
    h, rem = divmod(sec, 3600)
    m = rem // 60
    if h and m:
        return f"{h}h {m}m"
    if h:
        return f"{h}h"
    return f"{m}m"


class KpiNotify(models.Model):
    _inherit = 'kra.kpi'

    # ------------------------------------------------------------------ #
    # Public entry point                                                 #
    # ------------------------------------------------------------------ #
    def _notify(self, event, **ctx):
        """Dispatch a notification for `event`. Never raises; logs failures."""
        self.ensure_one()
        try:
            config = self.env['whatsapp.config'].sudo().get_config()
        except Exception as exc:
            self._log_action(
                'notification_failed',
                payload={'event': event, 'error': f'no config: {exc}'},
                success=False,
            )
            return

        body = self._format_message(event, ctx)

        # Persist a browsable in-app notification per recipient user for the
        # curated assignment/upload events. This runs BEFORE the WhatsApp toggle
        # / phone-recipient early-returns below on purpose: the app feed must be
        # populated even when the WhatsApp channel is muted (config toggle) OR no
        # recipient has a phone number. We resolve recipients via
        # `_notif_recipient_users` (keyed on user_id, phone-independent) rather
        # than the phone-deduped `recipients` list, so an admin/developer without
        # a phone still sees the notification. Scoping (admins → all events,
        # developer → own tasks) is inherited from the `_EVENT_RECIPIENTS` matrix.
        if body and event in _PERSIST_EVENTS:
            try:
                notif_recipients = self._notif_recipient_users(
                    _EVENT_RECIPIENTS.get(event, ()))
                created = self.env['kpi.notification'].sudo().create_for_recipients(
                    self, event,
                    _NOTIF_TITLES.get(event, event.replace('_', ' ').title()),
                    body, notif_recipients,
                )
                _logger.info(
                    "in-app notify persisted: kpi=%s event=%s recipients=%s rows=%s",
                    self.id, event, len(notif_recipients), len(created),
                )
                # Mobile push banner to the same recipients' registered devices.
                self._send_push(
                    event,
                    _NOTIF_TITLES.get(event, event.replace('_', ' ').title()),
                    body,
                    [r['user_id'] for r in notif_recipients if r.get('user_id')],
                )
            except Exception as exc:
                self._log_action(
                    'notification_failed',
                    payload={'event': event, 'error': f'persist: {exc}'},
                    success=False,
                )

        # --- WhatsApp + bus.bus channel (phone-gated, toggle-gated) ---------- #
        toggle = _EVENT_TO_TOGGLE.get(event)
        if toggle and not getattr(config, toggle, True):
            # Event muted via whatsapp.config — skip the WhatsApp/bus send.
            return

        recipients = self._resolve_recipients(_EVENT_RECIPIENTS.get(event, ()), event=event)
        if not recipients:
            return

        if not body:
            return

        # Pick the first connected session and reuse for every send in this call.
        session = self.env['whatsapp.session'].sudo().search(
            [('status', '=', 'connected')], limit=1)

        for rcp in recipients:
            self._notify_one(event, rcp, body, session)

        # Sequential client escalation: after firing pre_approval_request, mark
        # the picked client as "already notified" and schedule the next-check
        # 30 min out so the escalation cron picks the next client if no reply.
        if event == 'pre_approval_request':
            from datetime import timedelta
            picked_user_ids = [
                r['user_id'] for r in recipients
                if r.get('role') == 'client' and r.get('user_id')
            ]
            if picked_user_ids:
                self.sudo().write({
                    'pre_approval_notified_user_ids': [(4, uid) for uid in picked_user_ids],
                    'pre_approval_next_check_at': fields.Datetime.now() + timedelta(minutes=30),
                })

    # ------------------------------------------------------------------ #
    # Helpers                                                            #
    # ------------------------------------------------------------------ #
    def _notify_one(self, event, recipient, body, session):
        """Send to one recipient via WhatsApp + bus.bus, with error capture.

        Resilient pipeline:
          1. Pre-check the neonize in-memory state (`_wa_status`).  If dead,
             queue the message for the retry cron and bail — don't even
             try the send (mirrors the POS pattern).
          2. If in-memory is alive, try the send.  On failure (caught zombie
             mid-burst), queue + log.
        Either way the message will be picked up by `kpi.notification.queue`
        cron within ~1 minute when the socket recovers.
        """
        phone = recipient.get('phone')
        partner_id = recipient.get('partner_id')
        user_id = recipient.get('user_id')
        role = recipient.get('role')

        if phone and session:
            # Cheap in-memory check that mirrors the POS approach.  If the
            # neonize socket isn't actually alive we skip the send attempt
            # entirely and queue for the cron.
            mem_alive = self._wa_socket_alive(session)
            if not mem_alive:
                self._queue_and_log(event, phone, role, body,
                                    error='in-memory socket not connected (queued)')
                return
            try:
                session.send_message(phone, body)
                self._log_action(
                    'notification_sent',
                    payload={'event': event, 'channel': 'whatsapp',
                             'phone': phone, 'role': role},
                )
            except Exception as exc:
                # Send failed on the wire — enqueue for cron retry.
                self._queue_and_log(event, phone, role, body, error=str(exc))

        # bus.bus toast (if recipient is a known logged-in user).
        if partner_id:
            try:
                self.env['bus.bus']._sendone(
                    self.env['res.partner'].sudo().browse(partner_id),
                    'kra_kpi_notification',
                    {'kpi_id': self.id, 'event': event, 'text': body, 'role': role},
                )
            except Exception as exc:
                # Bus delivery failure is non-fatal.
                _logger.debug("bus.bus send failed for kpi %s: %s", self.id, exc)

    def _wa_socket_alive(self, session):
        """Mirrors the POS check: read neonize's in-memory state to know if
        the socket is truly alive.  Falls back to True on error so we don't
        block sends when neonize internals change.
        """
        try:
            from odoo.addons.whatsapp_neonize.models.whatsapp_session import (
                _wa_status, _wa_clients,
            )
            mem_status = _wa_status.get(session.id, 'unknown')
            has_client = session.id in _wa_clients
            return mem_status == 'connected' and has_client
        except Exception:
            return True

    def _queue_and_log(self, event, phone, role, body, error=''):
        """Enqueue a failed/skipped send for the retry cron + log to audit."""
        try:
            self.env['kpi.notification.queue'].sudo().enqueue(
                kpi_id=self.id, event=event,
                phone=phone, role=role, body=body, error=error,
            )
        except Exception as exc:
            _logger.warning("notification_queue enqueue failed: %s", exc)
        try:
            self._log_action(
                'notification_failed',
                payload={'event': event, 'channel': 'whatsapp',
                         'phone': phone, 'role': role,
                         'error': error, 'queued_for_retry': True},
                success=False,
            )
        except Exception:
            pass

    def _resolve_recipients(self, roles, event=None):
        """Return a deduped list of {phone, partner_id, user_id, role} dicts.

        We exclude the connected WhatsApp session's own phone so the bot
        never tries to message itself (which always fails with the neonize
        client and just clutters the audit log).

        When `event == 'pre_approval_request'` the client list is reduced to
        only the NEXT non-notified client — the escalation cron walks the
        rest one-by-one at 30-min intervals (see _cron_escalate_pre_approval).
        """
        self.ensure_one()
        seen_phones = set()

        # Pre-load the bot's own phone(s) into seen_phones so they get filtered.
        for sess in self.env['whatsapp.session'].sudo().search(
                [('status', '=', 'connected')]):
            self_phone = _norm_phone(sess.phone_number)
            if self_phone:
                seen_phones.add(self_phone)

        out = []

        def _add(phone, partner_id=None, user_id=None, role=None):
            n = _norm_phone(phone)
            if not n or n in seen_phones:
                return
            seen_phones.add(n)
            out.append({
                'phone':      n,
                'partner_id': partner_id,
                'user_id':    user_id,
                'role':       role,
            })

        config = self.env['whatsapp.config'].sudo().get_config()

        if 'owner' in roles:
            # Owner numbers — both the config list AND group_kra_owner users.
            for own in (config.owner_number_ids or []):
                if own.active and own.phone:
                    _add(own.phone, role='owner')
            owner_grp = self.env.ref('kra_kpi_module.group_kra_owner', raise_if_not_found=False)
            if owner_grp:
                for u in owner_grp.user_ids:
                    p = u.partner_id
                    if p:
                        _add(getattr(p, 'mobile', None) or p.phone, partner_id=p.id, user_id=u.id, role='owner')

        if 'coordinator' in roles:
            coord_grp = self.env.ref('kra_kpi_module.group_kra_admin', raise_if_not_found=False)
            if coord_grp:
                for u in coord_grp.user_ids:
                    p = u.partner_id
                    if p:
                        _add(getattr(p, 'mobile', None) or p.phone, partner_id=p.id, user_id=u.id, role='coordinator')

        if 'developer' in roles:
            if self.user_id and self.user_id.partner_id:
                p = self.user_id.partner_id
                _add(getattr(p, 'mobile', None) or p.phone, partner_id=p.id, user_id=self.user_id.id, role='developer')
            for u in (self.contributor_ids or []):
                p = u.partner_id
                if p:
                    _add(getattr(p, 'mobile', None) or p.phone, partner_id=p.id, user_id=u.id, role='developer')

        if 'client' in roles:
            # Walk up to client_kra; gather portal users on that KRA.
            client_kra = getattr(self, 'client_kra_id', False) or self.kra_id
            if client_kra:
                client_users = client_kra.client_user_ids
                if event == 'pre_approval_request' and client_users:
                    # Sequential single-recipient mode: skip clients already
                    # pinged on this task, send to the first remaining one.
                    notified = set(self.pre_approval_notified_user_ids.ids)
                    pending = client_users.filtered(lambda u: u.id not in notified)
                    client_users = pending[:1]
                for u in client_users:
                    p = u.partner_id
                    if p:
                        _add(getattr(p, 'mobile', None) or p.phone, partner_id=p.id, user_id=u.id, role='client')

        # Ad-hoc numbers configured on the company for Urgent-pause escalation.
        if 'urgent_extra' in roles:
            nums = self.env.company.sudo().kpi_urgent_recipients or ''
            for raw in re.split(r'[,\n;]+', nums):
                raw = raw.strip()
                if raw:
                    _add(raw, role='urgent')

        return out

    def _notif_recipient_users(self, roles):
        """Resolve role names → [{user_id, role}] for the in-app feed.

        This deliberately mirrors the role→user mapping in `_resolve_recipients`
        but keys on `user_id` ONLY and does NOT require a phone number. The
        WhatsApp path drops recipients with no phone (and the bot's own number);
        the persistent notification feed must not — an admin/coordinator/developer
        without a phone still needs to see the notification in the app. Ad-hoc
        phone-only roles (urgent_extra) are intentionally excluded — they have no
        user account to show a feed to.
        """
        self.ensure_one()
        out = []
        seen = set()

        def _add(user, role):
            if user and user.id not in seen:
                seen.add(user.id)
                out.append({'user_id': user.id, 'role': role})

        if 'owner' in roles:
            grp = self.env.ref('kra_kpi_module.group_kra_owner', raise_if_not_found=False)
            if grp:
                for u in grp.user_ids:
                    _add(u, 'owner')

        if 'coordinator' in roles:
            grp = self.env.ref('kra_kpi_module.group_kra_admin', raise_if_not_found=False)
            if grp:
                for u in grp.user_ids:
                    _add(u, 'coordinator')

        if 'developer' in roles:
            _add(self.user_id, 'developer')
            for u in (self.contributor_ids or []):
                _add(u, 'developer')

        return out

    def _send_push(self, event, title, body, user_ids):
        """Send an Expo push banner to the recipients' registered devices.

        Best-effort: never raises (a push failure must not block the task
        write). Gated by the `kpi_push_enabled` config toggle. Deactivates any
        token Expo reports as DeviceNotRegistered.
        """
        try:
            config = self.env['whatsapp.config'].sudo().get_config()
            if not getattr(config, 'kpi_push_enabled', True):
                return
            tokens = self.env['kpi.push.token'].sudo().tokens_for_users(user_ids)
            if not tokens:
                return
            # First line of the body is the most banner-friendly summary; keep
            # the push body short.
            short = (body or '').strip().split('\n')
            short_body = next((ln for ln in short if ln.strip()), title)
            if len(short_body) > 160:
                short_body = short_body[:157] + '...'

            messages = [{
                'to': tok,
                'title': title,
                'body': short_body,
                'data': {'kpi_id': self.id, 'event': event},
                'sound': 'default',
                'channelId': 'default',
            } for tok in tokens]

            # Expo accepts up to 100 messages per request.
            for i in range(0, len(messages), 100):
                batch = messages[i:i + 100]
                resp = requests.post(
                    _EXPO_PUSH_URL,
                    data=json.dumps(batch),
                    headers={
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                    },
                    timeout=10,
                )
                self._handle_push_receipts(batch, resp)

            self._log_action('push_sent', payload={
                'event': event, 'channel': 'expo', 'devices': len(tokens)})
        except Exception as exc:
            try:
                self._log_action('push_failed',
                                 payload={'event': event, 'error': str(exc)},
                                 success=False)
            except Exception:
                pass

    def _handle_push_receipts(self, batch, resp):
        """Deactivate tokens Expo reports as DeviceNotRegistered."""
        try:
            data = resp.json().get('data') or []
        except Exception:
            return
        for msg, ticket in zip(batch, data):
            if isinstance(ticket, dict) and ticket.get('status') == 'error':
                err = (ticket.get('details') or {}).get('error')
                if err == 'DeviceNotRegistered':
                    self.env['kpi.push.token'].sudo().deactivate(msg.get('to'))

    def _format_message(self, event, ctx):
        """Build the WhatsApp text body for an event from the template dict."""
        self.ensure_one()
        tmpl = _TEMPLATES.get(event)
        if not tmpl:
            return ''
        # Passthrough events (daily_summary etc.) — ctx is the source of truth.
        # We don't need per-record placeholders; render directly.
        if event in _PASSTHROUGH_EVENTS:
            try:
                return tmpl.format(**ctx)
            except KeyError as exc:
                _logger.warning("Passthrough template missing key for %s: %s", event, exc)
                return tmpl
        kra = self.kra_id
        project_name = (kra.name if kra else '') or ''
        client_kra = getattr(self, 'client_kra_id', False) or kra
        client_name = (client_kra.name if client_kra else '') or ''
        dev_name = (self.user_id.name if self.user_id else 'Unassigned')
        decision = (ctx.get('decision') or '').lower()
        # Format a short, single-line description; cap at 200 chars so messages
        # stay readable in WhatsApp.
        desc_raw = (self.description or '').strip().replace('\r', '').replace('\n', ' ')
        if len(desc_raw) > 200:
            desc_raw = desc_raw[:197] + '...'
        desc = desc_raw or '—'

        # Human-friendly estimate ("2h 30m" or "—" if none set).
        if self.estimate_hours or self.estimate_minutes:
            estimate = f"{self.estimate_hours or 0}h {self.estimate_minutes or 0}m"
        else:
            estimate = '—'

        # Timestamps — UTC stored, IST display (Asia/Kolkata).
        now_dt = fields.Datetime.now()
        now_str = _fmt_ist(now_dt)
        if self.pre_approval_decided_at:
            decided_at = _fmt_ist(self.pre_approval_decided_at)
        else:
            decided_at = now_str

        # Build wa.me tap-to-send URLs.  Tapping any of these on a phone opens
        # the bot's WhatsApp chat with the action message pre-typed; user just
        # hits Send — 2 taps total, no need to type the long token.
        bot_phone = ''
        try:
            sess = self.env['whatsapp.session'].sudo().search(
                [('status', '=', 'connected')], limit=1)
            if sess and sess.phone_number:
                bot_phone = re.sub(r'\D+', '', sess.phone_number)
        except Exception:
            pass
        token_short = (self.approval_token or '')[:8]
        if bot_phone and token_short:
            base = f'https://wa.me/{bot_phone}?text='
            tap_approve = base + f'1-{token_short}'
            tap_reject  = base + f'2-{token_short}'
            tap_hold    = base + f'3-{token_short}'
            tap_clarify = base + f'4-{token_short}'
        else:
            tap_approve = tap_reject = tap_hold = tap_clarify = '(link unavailable)'

        params = {
            'title':       self.name or f'Task #{self.id}',
            'ref':         self.external_ref or f'#{self.id}',
            'tap_approve': tap_approve,
            'tap_reject':  tap_reject,
            'tap_hold':    tap_hold,
            'tap_clarify': tap_clarify,
            'project':     project_name,
            'client':      client_name,
            'client_name': client_name or 'there',
            'priority':    (self.priority or 'regular').title(),
            'deadline':    str(self.deadline) if self.deadline else 'not set',
            'dev':         dev_name,
            'estimate':    estimate,
            'description': desc,
            'now':         now_str,
            'decided_at':  decided_at,
            'elapsed':     _format_elapsed_seconds(self.timer_total_seconds),
            'pause_reason': (
                dict(self._fields['pause_reason_code'].selection).get(self.pause_reason_code, '—')
                if self.pause_reason_code else (self.paused_reason or '—')
            ),
            'url':         self._build_approval_url() if hasattr(self, '_build_approval_url') else '',
            'token_short': (self.approval_token or '')[:8],
            'decision':        decision or '—',
            'decision_caps':   (decision or '—').upper(),
            'decision_emoji':  _DECISION_EMOJI.get(decision, '•'),
            'decided_by':      ctx.get('decided_by') or '—',
            'source':          ctx.get('source') or 'web',
            'feedback':        (ctx.get('feedback') or '').strip() or '—',
            'created_by':      (ctx.get('created_by')
                                or (self.create_uid.name if self.create_uid else '')
                                or 'system'),
            # Urgent-pause / auto-away identity + note.
            'note':        (ctx.get('note') or '').strip() or '—',
            'dev_number':  ((self.user_id.kpi_wa_number
                             or (self.user_id.partner_id.phone if self.user_id.partner_id else '')
                             or '—') if self.user_id else '—'),
        }
        try:
            return tmpl.format(**params)
        except KeyError as exc:
            _logger.warning("Notify template missing key for event %s: %s", event, exc)
            return tmpl
