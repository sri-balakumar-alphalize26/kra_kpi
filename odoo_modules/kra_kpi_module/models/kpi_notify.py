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
    'workday_auto_closed',  # midnight cron closed a workday the dev left open
    # "X ended their workday" → admins. Tapping it opens that day's frozen summary
    # image. This is the ONLY channel it has: its WhatsApp template was removed,
    # and it never sent anyway (kpi_wa_task_notifications defaults False), so the
    # summary reached nobody at all before this.
    'daily_summary',
    # "The daily employee task report (PDF) is ready" → admins. Tapping it opens
    # the generated report (kpi.notification.report_id). App-only, like daily_summary.
    'daily_report',
    # Client invoices — app-only, tap opens the invoice (kpi.notification.invoice_id).
    # invoice_ready/invoice_paid → the client (via extra_users); invoice_client_paid
    # → admins ("client says they've paid — confirm it").
    'invoice_ready',
    'invoice_paid',
    'invoice_client_paid',
    'task_reassigned',  # tell the PREVIOUS assignee their task moved to someone else
    # In-app client approval: the client must see the request in the app (this used
    # to be WhatsApp-only, so nothing was ever persisted for it), and dev+admin must
    # see the outcome. Persisting also gives them an Expo push for free.
    'pre_approval_request',
    'pre_approval_decided',
    # A decision that lands AFTER the window closed (i.e. after auto-approve).
    # The engine records it without reverting state, so without this the dev +
    # admins would never learn a late reject happened.
    'pre_approval_decided_late',
    'client_task_queued',   # client submitted a task → admins (re-nudged while unread)
    # Client rejected the assigned developer → task is back in the queue needing
    # a new one. Carries the reason.
    'client_task_rejected',
    # Client paused their own approval countdown → tell the dev not to wait.
    'pre_approval_held',
    # The two auto-advance gates. Both are things that happened WITHOUT anyone
    # deciding, so the people who didn't act have to be told — that notification
    # is what preserves their power to re-categorise, reject or object after the
    # fact, and it is the paper trail for a task that moved on its own.
    'admin_accept_auto',            # nobody triaged it → accepted, sent to client
    'pre_approval_auto_released',   # client never replied → dev may start (team)
    'pre_approval_window_closed',   # ...the same event, told to the client
    # Stage 2: admin approved the dev's work → the CLIENT must sign off. Was
    # WhatsApp-only too, so clients got nothing in-app for it either.
    'internal_approved',
    # ── App-only migration (WhatsApp task messages are now OFF by default) ──
    # Everything below used to be WhatsApp-only. With kpi_wa_task_notifications
    # off, not persisting these would mean they reach NOBODY, so they move into
    # the feed. Deliberately EXCLUDED as routine noise: start / start_prep /
    # pause / resume / complete / daily_summary — their _notify() calls simply
    # become no-ops.
    #
    # workday_started was on that excluded list; the user has since asked for it
    # (attendance: "X started their workday"). It's fired already, with the right
    # recipients and ctx — it was only ever missing from this set.
    'workday_started',
    # A developer 10 min into their workday with nothing in progress — asked BEFORE
    # any admin is told, so a 9:31 meeting doesn't raise a false alarm.
    'dev_idle_check',
    # ...and the one case that IS the admin's problem: they have no work assigned.
    # Re-nudged while unread (see _cron_check_idle_developers).
    'dev_no_task',
    'internal_rejected',    # dev: your work was sent back → rework
    # Developer marked a task complete → admins (owner+coordinator) must review it
    # and Approve/Reject. Previously excluded as "routine noise" so the admin was
    # never told; now persisted so it reaches the Action Board owners in-app + push.
    'complete',
    'final_approved',       # client signed off → the task is done
    'self_task_accepted',   # dev: admin accepted the task you created
    'self_task_rejected',   # dev: admin sent your task back
    'partial_timeout',      # client stayed silent → prep auto-started
    'pre_approval_reminder',  # client: you still haven't approved
    'urgent_pause',         # 🚨 dev needs help — re-nudged until an admin reads it
}

# Short human labels for the in-app notification title (the body reuses the
# full WhatsApp message text).
_NOTIF_TITLES = {
    'task_created':        'New task added',
    'task_assigned':       'New task assigned',
    'reassigned':          'Task reassigned',
    'self_task_submitted': 'Task submitted for review',
    'task_auto_away':      'Task paused — you went away',
    'workday_auto_closed': 'Workday auto-closed',
    'task_reassigned':     'Task reassigned',
    'pre_approval_request': 'Approval needed',
    'pre_approval_decided': 'Approval decided',
    'pre_approval_decided_late': 'Late decision',
    'client_task_queued':   'New client task queued',
    'client_task_rejected': 'Task rejected — reassign',
    'pre_approval_held':    'Client held approval',
    'admin_accept_auto':          'Accepted automatically',
    'pre_approval_auto_released': 'No client reply — work may start',
    'pre_approval_window_closed': 'Approval window closed',
    'internal_approved':    'Your sign-off needed',
    'internal_rejected':    'Rework needed',
    'complete':             'Task ready for review',
    'final_approved':       'Client signed off',
    'self_task_accepted':   'Task accepted',
    'self_task_rejected':   'Task sent back',
    'partial_timeout':      "Client didn't respond",
    'pre_approval_reminder': 'Approval reminder',
    'urgent_pause':         '🚨 Urgent',
    'workday_started':      'Workday started',
    'daily_summary':        'Workday ended',
    'daily_report':         'Daily report ready',
    'invoice_ready':        'Invoice ready',
    'invoice_paid':         'Payment recorded',
    'invoice_client_paid':  'Client marked invoice paid',
    'dev_idle_check':       'Not started a task yet?',
    'dev_no_task':          '📭 Developer has no tasks',
}

# App-shaped bodies for the in-app feed. The WhatsApp templates below are full of
# wa.me tap-to-send links and `1-<token>` reply codes, which are meaningless (and
# ugly) inside the app — there the client just taps Approve/Reject in My Tasks.
# `_format_message` falls back to the WhatsApp body for events not listed here.
# NOTE: `client_task_queued` has NO WhatsApp template on purpose — it is in-app
# only, so `_notify` returns before the WhatsApp send (empty body).
_APP_TEMPLATES = {
    'pre_approval_request': (
        "A task needs your approval:\n"
        "📌 {title}\n"
        "👤 Developer: {dev}\n"
        "🏷 Project: {project}\n\n"
        "Open My Tasks to Approve or Reject.\n"
        "If we don't hear from you within {window_minutes} min the team may "
        "start work — that is not an approval, and nothing is billed until you "
        "sign off at the end. You can still object at any time."
    ),
    'pre_approval_decided': (
        "{decision_emoji} Client decision: {decision_caps}\n"
        "📌 {title}\n"
        "👤 Developer: {dev} • Project: {project}\n"
        "🗣 By: {decided_by} • {decided_at}\n"
        "💬 Reason: {feedback}"
    ),
    # Landed after the approval window — the engine stamps the decision but does
    # NOT revert the live state, so say that plainly or the team will wonder why
    # a "reject" changed nothing.
    'pre_approval_decided_late': (
        "{decision_emoji} Late client decision: {decision_caps}\n"
        "📌 {title}\n"
        "👤 Developer: {dev} • Project: {project}\n"
        "🗣 By: {decided_by} • {decided_at}\n"
        "This came in after the approval window — the task state was not changed."
    ),
    'client_task_queued': (
        "🆕 A client submitted a task — it needs a developer.\n"
        "📌 {title}\n"
        "👤 From: {created_by} • Client: {client_name}\n"
        "🏷 Project: {project}\n\n"
        "Open the Client Task Queue to assign a developer."
    ),
    # Client rejected WHO the task went to → it's back in the queue with no
    # developer. Lead with the reason: it's the only thing the admin needs.
    'client_task_rejected': (
        "❌ Client rejected the assignment — needs a new developer.\n"
        "📌 {title}\n"
        "💬 Reason: {feedback}\n"
        "👤 Was assigned to: {dev} • Project: {project}\n\n"
        "Open the Client Task Queue to reassign."
    ),
    # Client paused their own approval countdown — the dev must not sit waiting.
    'pre_approval_held': (
        "⏸ Client put approval on hold — it will NOT auto-release.\n"
        "📌 {title}\n"
        "👤 Developer: {dev} • Project: {project}\n\n"
        "The task waits for the client's decision."
    ),
    # Nobody triaged it within the window, so the system accepted it. Say that
    # plainly: the admins who didn't act need to know it moved, and that they
    # can still fix the category or reject it.
    'admin_accept_auto': (
        "⏱ Accepted automatically — no admin action within {window_minutes} min.\n"
        "📌 {title}\n"
        "👤 Developer: {dev} • Project: {project}\n\n"
        "It has gone to the client for approval. You can still re-categorise or "
        "reject it."
    ),
    # Two audiences, two messages. The TEAM is told they may start and that this
    # is emphatically not the client's approval...
    'pre_approval_auto_released': (
        "🔓 No client reply within {window_minutes} min — you can start work.\n"
        "📌 {title}\n"
        "👤 Developer: {dev} • Project: {project}\n\n"
        "This is NOT the client's approval. They can still object, and the task "
        "is not billable until they sign off at completion."
    ),
    # ...and the CLIENT is told we stopped waiting and their door is still open.
    'pre_approval_window_closed': (
        "⏳ We didn't hear back within {window_minutes} min, so the team has "
        "started work.\n"
        "📌 {title}\n"
        "👤 Developer: {dev} • Project: {project}\n\n"
        "You have not approved anything and nothing is billed yet. Open My Tasks "
        "to object or to approve."
    ),
    # Developer finished a task → admins must review it on the Action Board.
    'complete': (
        "✅ {dev} marked a task complete — please review.\n"
        "📌 {title}\n"
        "🏷 Project: {project}\n\n"
        "Open the Action Board to Approve or Reject."
    ),
    # Attendance, nothing more — deliberately no task count or warning wording:
    # "no tasks" has its own path (dev_no_task), so saying it here too would just
    # make the everyday message noisier.
    # PASSTHROUGH event → only ctx keys exist here ({dev}, {session_date},
    # {login_at}), never record fields.
    'workday_started': (
        "🌅 {dev} started their workday\n"
        "🕘 {login_at}"
    ),
    # Developer ended their workday — admins. TAPPING this opens that day's frozen
    # summary image (kpi.notification.snapshot_id), which is the whole reason it is
    # in-app and NOT WhatsApp: a text can't be tapped through to a picture. Its
    # _TEMPLATES (WhatsApp) entry was deliberately removed, so _notify no-ops the
    # WhatsApp leg on the empty body.
    # Emoji are fine here — only the PIL-drawn image strips them, never the feed.
    # PASSTHROUGH event → only ctx keys built by _fire_daily_summary exist here.
    'daily_summary': (
        "🌙 {dev} ended their workday — you can check the tasks done.\n"
        "🕘 {login_at} → {logout_at}\n"
        "⏱ Presence {presence} • Productive {productive}\n"
        "✅ Tasks worked: {task_count}\n"
        "{session_note}"
        "{auto_note}"
        "Tap to open the day's summary image."
    ),
    # The consolidated daily employee task report (PDF) has been generated →
    # admins. TAPPING opens the report (kpi.notification.report_id). App-only:
    # its _TEMPLATES (WhatsApp) entry is intentionally absent, so _notify no-ops
    # the WhatsApp leg on the empty body. PASSTHROUGH — only ctx keys exist here.
    'daily_report': (
        "📄 Daily task report ready — {date}\n"
        "👥 {employee_count} employee(s) • ✅ {task_count} task(s)\n"
        "Tap to open and download the report."
    ),
    # Client invoice events — PASSTHROUGH (only ctx keys: {name}). Tapping opens the
    # invoice (kpi.notification.invoice_id). App-only, no WhatsApp template.
    'invoice_ready': (
        "📄 Your invoice {name} is ready.\n"
        "Tap to view and download it."
    ),
    'invoice_paid': (
        "✅ Payment recorded for invoice {name}.\n"
        "Thank you — tap to view it."
    ),
    'invoice_client_paid': (
        "💰 The client marked invoice {name} as paid.\n"
        "Tap to review and confirm the payment."
    ),
    # Asked of the DEVELOPER, not an admin. The three answers map to
    # /kpi_workday/idle_reason.
    'dev_idle_check': (
        "You haven't started a task yet.\n"
        "In a meeting, on a break — or do you have no tasks assigned?\n\n"
        "Tap to tell us, so nobody has to chase you."
    ),
    # The admin's one actionable case.
    'dev_no_task': (
        "📭 {dev} has no tasks to work on.\n"
        "🕘 Workday started {login_at}\n\n"
        "Assign them something from the board."
    ),
    # Stage 2 — the work is done and needs the client's final sign-off.
    'internal_approved': (
        "✅ Work completed — your sign-off is needed:\n"
        "📌 {title}\n"
        "👤 Developer: {dev}\n"
        "🏷 Project: {project} • ⏱ {elapsed}\n\n"
        "Open My Tasks to review and sign off."
    ),

    # ── App-only migration ──────────────────────────────────────────────────
    # Everything below used to be WhatsApp-only. With task WhatsApp off these
    # are the ONLY copy the recipient ever sees, so they must read as plain
    # app messages (no wa.me links, no reply tokens).
    #
    # NOTE: 'internal_rejected' has no _TEMPLATES entry at all, so before this
    # it rendered an empty body and was silently never delivered on ANY channel.
    'internal_rejected': (
        "🔁 Your work was sent back — rework needed.\n"
        "📌 {title} ({ref})\n"
        "🏷 Project: {project}\n"
        "💬 Reason: {feedback}"
    ),
    'final_approved': (
        "🎉 The client signed off — task complete!\n"
        "📌 {title} ({ref})\n"
        "🏷 Project: {project}\n"
        "👤 Developer: {dev} • ⏱ {elapsed}\n"
        "✍️ Signed by: {decided_by}"
    ),
    # No live emitter since the 'prep work' state was retired in 19.0.2.3; kept
    # only so an old queued row still renders. New silence-timeouts fire
    # pre_approval_auto_released / pre_approval_window_closed instead.
    'partial_timeout': (
        "⌛ No client reply in time.\n"
        "📌 {title} ({ref})\n"
        "🏷 Project: {project} • 👤 {dev}\n\n"
        "Not billable until the client signs off."
    ),
    'pre_approval_reminder': (
        "⚠️ Reminder — this task still needs your approval.\n"
        "📌 {title}\n"
        "🏷 Project: {project} • Deadline: {deadline}\n"
        "👤 Waiting on you before {dev} is confirmed.\n\n"
        "Open My Tasks to Approve. If we don't hear back the team may start "
        "anyway — that is not an approval, and nothing is billed until you "
        "sign off at the end."
    ),
    # Lead with WHO — the admin's first question is always "who needs help?".
    'urgent_pause': (
        "🚨 {dev} needs help — task paused.\n"
        "📌 {title} ({ref})\n"
        "📝 {note}\n"
        "🏷 Project: {project}"
    ),

    # These four previously fell back to the raw WhatsApp body in the feed.
    'task_created': (
        "🆕 New task added\n"
        "📌 {title}\n"
        "🏷 {client} • {project}\n"
        "⚡ {priority} • Deadline: {deadline}\n"
        "👤 Added by: {created_by}"
    ),
    'task_assigned': (
        "📋 A task was assigned to you.\n"
        "📌 {title} ({ref})\n"
        "🏷 {client} • {project}\n"
        "⚡ {priority} • Deadline: {deadline} • Estimate: {estimate}"
    ),
    'reassigned': (
        "🔄 A task was reassigned to you.\n"
        "📌 {title} ({ref})\n"
        "🏷 Project: {project} • Estimate: {estimate}\n"
        "💬 Reason: {feedback}"
    ),

    # ── Passthrough events ──────────────────────────────────────────────────
    # These render with `ctx` ONLY (see _format_message + _PASSTHROUGH_EVENTS),
    # so they may use nothing but the keys their call site passes.
    'self_task_accepted': (          # ctx: title, project
        "✅ Your task was accepted — it's now official.\n"
        "📌 {title}\n"
        "🏷 Project: {project}"
    ),
    'self_task_rejected': (          # ctx: title, reason
        "🔁 Your task was sent back.\n"
        "📌 {title}\n"
        "💬 Reason: {reason}"
    ),
    'task_reassigned': (             # ctx: name, new_dev
        "↪ \"{name}\" is now assigned to {new_dev}.\n"
        "Contact your admin if you need details."
    ),
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
    # Workday auto-closed at midnight — reuse the daily-summary toggle.
    'workday_auto_closed':       'notify_daily_summary',
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
    # Auto-advance events reuse the toggle of the gate they belong to.
    'admin_accept_auto':          'notify_task_created',
    'pre_approval_auto_released': 'notify_pre_approval_request',
    'pre_approval_window_closed': 'notify_pre_approval_request',
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
    # Client submitted a task → it sits in the Client Task Queue until an admin
    # assigns a developer. Admins only; re-nudged every N min while unread
    # (see kra.kpi._cron_nudge_queued_tasks).
    'client_task_queued':        ('owner', 'coordinator'),
    # Client rejected the assignment → back in the queue, needs a new developer.
    'client_task_rejected':      ('owner', 'coordinator'),
    # Client paused their approval → the developer must know not to wait on it.
    'pre_approval_held':         ('owner', 'coordinator', 'developer'),
    # Auto-advance events. Owner + coordinator BECAUSE they are the ones who
    # didn't act: this is their accountability record and the thing that keeps
    # their after-the-fact powers meaningful. The developer is told because
    # their task just became official and its external_ref changed under them.
    'admin_accept_auto':         ('owner', 'coordinator', 'developer'),
    'pre_approval_auto_released': ('owner', 'coordinator', 'developer'),
    # Same moment, told to the other side — hence a separate event with its own
    # wording. One body cannot honestly say "you may start, this is not
    # approved" and "we stopped waiting, you can still object" at once.
    'pre_approval_window_closed': ('client',),
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
    # Daily employee task report (PDF) — owner + coordinator.
    'daily_report':              ('owner', 'coordinator'),
    # Invoice → client: recipients come purely via extra_users (the invoice's own
    # client_user_ids), so the role matrix is empty here.
    'invoice_ready':             (),
    'invoice_paid':              (),
    # Client → admins: "the client marked it paid, confirm it".
    'invoice_client_paid':       ('owner', 'coordinator'),
    # Workday-started — owner + coordinator hear "dev X started their day".
    'workday_started':           ('owner', 'coordinator'),
    # Asked of the DEVELOPER first — a 10-min silence is usually a meeting, not a
    # problem, and telling the admins about it would cry wolf.
    #
    # EMPTY on purpose, do not "fix" to ('developer',): _notify lives on kra.kpi and
    # the 'developer' role resolves to the ANCHOR TASK's assignee. An idle developer
    # may have no tasks at all, so the anchor is some unrelated task and the prompt
    # would land on the wrong person. The caller passes the real developer via
    # _notify(extra_users=[uid]) instead.
    'dev_idle_check':            (),
    # The one case that IS the admin's to fix. Re-nudged every 15 min while unread.
    'dev_no_task':               ('owner', 'coordinator'),
    # Workday auto-closed at midnight — tell the DEVELOPER (their phone).
    'workday_auto_closed':       ('developer',),
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
    # Urgent pause — owner + coordinator, IN-APP. Was ('owner', 'urgent_extra'):
    # `urgent_extra` is a list of bare phone numbers with no user account, so it
    # can only ever be reached over WhatsApp. With task WhatsApp off it could
    # never fire, so it is gone; admins are reachable in the app instead and get
    # re-nudged every few minutes until one of them reads it
    # (see kra.kpi._cron_nudge_urgent_pause).
    'urgent_pause':              ('owner', 'coordinator'),
    # No ROLE recipients on purpose: this event exists to tell the PREVIOUS
    # assignee their task moved, and they are passed explicitly via
    # `extra_users=[prev_uid]` from kpi_workflow.write(). The role matrix would
    # resolve `developer` to the NEW assignee, who already got `reassigned`.
    # Listed explicitly so it reads as deliberate rather than an omission.
    'task_reassigned':           (),
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
        "(No reply in {window_minutes} min and the team may start — that is not "
        "an approval, and nothing is billed until you sign off.)"
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
    # Sent to the PREVIOUS assignee when their task is moved to someone else.
    'task_reassigned': (
        'Task "{name}" is now assigned to {new_dev} — contact admin for details.'
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
    # NOTE: 'daily_summary' deliberately has NO WhatsApp template any more.
    # The end-of-day summary is in-app only (see _APP_TEMPLATES): the whole point
    # is that admins TAP it and land on the day's frozen image, which a WhatsApp
    # text can't do. _notify() no-ops the WhatsApp leg on an empty body, which is
    # the same trick client_task_queued uses.
    # (It reached nobody anyway: kpi_wa_task_notifications defaults False.)
    # Developer started workday — sent to owner + coordinator.
    'workday_started': (
        "🌅 Workday Started — {dev}\n"
        "Date: {session_date}\n"
        "Login: {login_at}\n"
        "(Daily summary will follow at logout.)"
    ),
    # Workday auto-closed at midnight (dev never pressed End Workday) — sent to the dev.
    'workday_auto_closed': (
        "🌙 Workday auto-closed — {dev}\n"
        "Date: {session_date}\n"
        "You didn't end your workday, so it was closed automatically at midnight "
        "and any running task was paused. Open the app to start a new workday."
    ),
}


# Events whose `ctx` already carries every placeholder for the template —
# bypass _format_message's per-record parameter assembly.  Used for non-
# kra.kpi-anchored events like daily_summary / workday_started.
_PASSTHROUGH_EVENTS = ('daily_summary', 'daily_report',
                       'invoice_ready', 'invoice_paid', 'invoice_client_paid',
                       'workday_started', 'workday_auto_closed',
                       'task_auto_away', 'self_task_submitted', 'self_task_accepted',
                       'self_task_rejected', 'task_reassigned',
                       # Both are about a DEVELOPER, not about the task they're
                       # anchored on. _notify lives on kra.kpi, and an idle dev may
                       # have no tasks — so the anchor is an unrelated record and
                       # {dev} built from it would name the WRONG person. Passthrough
                       # renders from ctx only, so the caller supplies the real dev.
                       'dev_idle_check', 'dev_no_task')


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
    def _notify(self, event, extra_users=None, **ctx):
        """Dispatch a notification for `event`. Never raises; logs failures.

        `extra_users` = optional list of res.users ids to ALSO notify in-app +
        push, beyond the role matrix (e.g. the PREVIOUS assignee on reassign,
        who the role-based resolver would never reach)."""
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
        # In-app variant (no wa.me links / reply tokens). Falls back to the
        # WhatsApp body for events without an app template. Some events are
        # app-only (no WhatsApp template at all) — they render here and the
        # WhatsApp leg below no-ops on the empty `body`.
        app_body = self._format_message(event, ctx, templates=_APP_TEMPLATES) or body

        # Persist a browsable in-app notification per recipient user for the
        # curated assignment/upload events. This runs BEFORE the WhatsApp toggle
        # / phone-recipient early-returns below on purpose: the app feed must be
        # populated even when the WhatsApp channel is muted (config toggle) OR no
        # recipient has a phone number. We resolve recipients via
        # `_notif_recipient_users` (keyed on user_id, phone-independent) rather
        # than the phone-deduped `recipients` list, so an admin/developer without
        # a phone still sees the notification. Scoping (admins → all events,
        # developer → own tasks) is inherited from the `_EVENT_RECIPIENTS` matrix.
        if app_body and event in _PERSIST_EVENTS:
            try:
                notif_recipients = self._notif_recipient_users(
                    _EVENT_RECIPIENTS.get(event, ()))
                # Explicit target users (e.g. the PREVIOUS assignee on reassign)
                # who the role matrix wouldn't reach. Feeds BOTH the in-app row
                # and the push below (both read notif_recipients).
                _seen_uids = {r.get('user_id') for r in notif_recipients}
                for _uid in (extra_users or []):
                    if _uid and _uid not in _seen_uids:
                        notif_recipients.append({'user_id': _uid, 'role': 'previous_assignee'})
                        _seen_uids.add(_uid)
                created = self.env['kpi.notification'].sudo().create_for_recipients(
                    self, event,
                    _NOTIF_TITLES.get(event, event.replace('_', ' ').title()),
                    app_body, notif_recipients,
                )
                # Some events point at something that ISN'T a task — "X ended their
                # workday" opens that day's frozen summary image. Threaded through
                # the context so no signature in this chain has to change for it.
                _snap_id = self.env.context.get('kpi_snapshot_id')
                if _snap_id and created:
                    created.sudo().write({'snapshot_id': _snap_id})
                # Same mechanism for the daily report PDF: tapping the row opens
                # the generated report (kpi.notification.report_id).
                _report_id = self.env.context.get('kpi_daily_report_id')
                if _report_id and created:
                    created.sudo().write({'report_id': _report_id})
                # Same mechanism for a client invoice: tapping the row opens the
                # invoice (kpi.notification.invoice_id).
                _invoice_id = self.env.context.get('kpi_invoice_id')
                if _invoice_id and created:
                    created.sudo().write({'invoice_id': _invoice_id})
                _logger.info(
                    "in-app notify persisted: kpi=%s event=%s recipients=%s rows=%s",
                    self.id, event, len(notif_recipients), len(created),
                )
                # Mobile push banner to the same recipients' registered devices.
                self._send_push(
                    event,
                    _NOTIF_TITLES.get(event, event.replace('_', ' ').title()),
                    app_body,
                    [r['user_id'] for r in notif_recipients if r.get('user_id')],
                )
            except Exception as exc:
                self._log_action(
                    'notification_failed',
                    payload={'event': event, 'error': f'persist: {exc}'},
                    success=False,
                )

        # --- WhatsApp + bus.bus channel (phone-gated, toggle-gated) ---------- #
        # MASTER SWITCH: task notifications are app-only by default. Everything
        # above (in-app feed + push) has already been delivered; this only skips
        # the WhatsApp/bus leg. Password-reset OTP does NOT come through here, so
        # it is unaffected. Flip whatsapp.config.kpi_wa_task_notifications on to
        # restore WhatsApp (the per-event notify_* toggles then apply as before).
        if not getattr(config, 'kpi_wa_task_notifications', False):
            return

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
            # All of them, always: approval happens in the app now, so there is no
            # sequential "one client at a time" mode any more (it used to skip
            # clients already pinged and take pending[:1], driven by a 30-min
            # escalation cron that has since been retired). First to answer decides.
            client_kra = getattr(self, 'client_kra_id', False) or self.kra_id
            if client_kra:
                for u in client_kra.client_user_ids:
                    p = u.partner_id
                    if p:
                        _add(getattr(p, 'mobile', None) or p.phone, partner_id=p.id, user_id=u.id, role='client')

        # NOTE: the 'urgent_extra' role (ad-hoc WhatsApp numbers from
        # res.company.kpi_urgent_recipients) is gone. Those numbers had no user
        # account, so they were unreachable once task WhatsApp was switched off.
        # urgent_pause now goes to owner + coordinator in the app instead.

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

        if 'client' in roles:
            # In-app approval: the client decides in the app, so — unlike the
            # WhatsApp path — we never narrow to "one client at a time" here.
            # For a client-submitted task the submitter is THE approver; otherwise
            # fall back to the client users on the nearest client KRA.
            if self.client_submitted and self.submitted_by_uid:
                _add(self.submitted_by_uid, 'client')
            else:
                client_kra = getattr(self, 'client_kra_id', False) or self.kra_id
                for u in (client_kra.client_user_ids or []):
                    _add(u, 'client')

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

            # Tap-target id rides in the context for non-task events (the same way
            # the in-app feed stamps snapshot_id / report_id): a "daily report ready"
            # push should open the report, not the anchor task.
            _push_data = {'kpi_id': self.id, 'event': event}
            _rep_id = self.env.context.get('kpi_daily_report_id')
            if _rep_id:
                _push_data['report_id'] = _rep_id
            _snap_id = self.env.context.get('kpi_snapshot_id')
            if _snap_id:
                _push_data['snapshot_id'] = _snap_id
            _inv_id = self.env.context.get('kpi_invoice_id')
            if _inv_id:
                _push_data['invoice_id'] = _inv_id
            messages = [{
                'to': tok,
                'title': title,
                'body': short_body,
                'data': _push_data,
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

    def _format_message(self, event, ctx, templates=None):
        """Build the text body for an event from a template dict.

        `templates` defaults to the WhatsApp `_TEMPLATES`; pass `_APP_TEMPLATES`
        to render the in-app variant (same placeholders, no wa.me links/tokens).
        Returns '' when the dict has no entry for the event.
        """
        self.ensure_one()
        tmpl = (templates or _TEMPLATES).get(event)
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
            # Auto-accept / auto-release windows. These MUST be present: a
            # template referencing a key that isn't here raises KeyError, gets
            # swallowed below, and ships the RAW template — braces and all — to
            # the user. Falls back to the live config so a caller that forgets
            # to pass window_minutes still renders a true number.
            'window_minutes': (ctx.get('window_minutes')
                               or self._client_approval_minutes()),
            'released_at':    ctx.get('released_at') or now_str,
            'accepted_at':    ctx.get('accepted_at') or now_str,
            'dev_number':  ((self.user_id.kpi_wa_number
                             or (self.user_id.partner_id.phone if self.user_id.partner_id else '')
                             or '—') if self.user_id else '—'),
        }
        try:
            return tmpl.format(**params)
        except KeyError as exc:
            _logger.warning("Notify template missing key for event %s: %s", event, exc)
            return tmpl
