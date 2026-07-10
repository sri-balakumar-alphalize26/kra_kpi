"""Monkey-patch the whatsapp_neonize inbound dispatcher to also recognise KRA/KPI
client pre-approval replies.

The existing addon hard-codes a call to
``WhatsAppSession._process_credit_reply_instant`` from inside ``_on_message``.
That parser matches sale-order credit overrides shaped ``1-SOxxx`` / ``2-SOxxx``.

We wrap the staticmethod so it tries the credit parser FIRST (no behaviour
change for existing customers), and falls through to a KPI parser that
accepts the four colored-button equivalents:

  ``1[-<token-prefix>]`` → approve
  ``2[-<token-prefix>]`` → reject
  ``3[-<token-prefix>]`` → hold
  ``4[-<token-prefix>]`` → clarify

When the token is omitted the parser falls back to the most recent
``pre_approval_pending`` task linked to the sender phone — convenient for the
common one-task-at-a-time case but the explicit ``1-abc12345`` form is safer.

Confirmation is sent back as a plain WhatsApp text.  Everything else (state
change, audit log row, downstream notifications) is delegated to the existing
``record_client_pre_decision`` method on ``kra.kpi``.
"""

import logging
import re

from odoo import api

_logger = logging.getLogger(__name__)


# Patterns:
#   "1"             — bare digit (no token)
#   "1-abcdef1234"  — digit + token-prefix (6..32 hex chars)
_KPI_REPLY_PATTERN = re.compile(r'^\s*([1-4])\s*(?:-\s*([A-Fa-f0-9]{6,32}))?\s*$')

_ACTION_BY_CODE = {
    '1': 'approve',
    '2': 'reject',
    '3': 'hold',
    '4': 'clarify',
}

_ACTION_VERB = {
    'approve': 'APPROVED',
    'reject':  'REJECTED',
    'hold':    'PUT ON HOLD',
    'clarify': 'MARKED AS NEEDING CLARIFICATION',
}

# Bare token (no action code) — client typed/forwarded just the hex string.
# We reply with the 4 tap-to-send links so they can pick an action.
_BARE_TOKEN_PATTERN = re.compile(r'^\s*([A-Fa-f0-9]{6,32})\s*$')

# Client-only trigger words.  When a phone matching a portal/client user
# sends any of these, we reply with their list of pending pre-approvals.
# (Developers / coordinators / owners are STILL ignored — per simplification.)
_CLIENT_HI_TRIGGERS = ('hi', 'hello', 'menu', 'list', 'pending', 'approve', 'approvals', 'tasks')


def _bot_phone(env):
    """Return the digits-only phone of the connected WhatsApp session."""
    try:
        sess = env['whatsapp.session'].sudo().search(
            [('status', '=', 'connected')], limit=1)
        if sess and sess.phone_number:
            return re.sub(r'\D+', '', sess.phone_number)
    except Exception:
        pass
    return ''


def _build_tap_links(bot_phone, token_short):
    """Build 4 wa.me URLs for Approve / Reject / Hold / Clarify on this token."""
    if not bot_phone or not token_short:
        return None
    base = f'https://wa.me/{bot_phone}?text='
    return {
        'approve': f'{base}1-{token_short}',
        'reject':  f'{base}2-{token_short}',
        'hold':    f'{base}3-{token_short}',
        'clarify': f'{base}4-{token_short}',
    }


def _build_client_pending_list(env, partner, phone_clean):
    """Build a WA body listing this client's pending pre-approvals (pending +
    partial-approved-but-not-yet-decided), each with tap-to-send Approve /
    Reject / Clarify links. Returns the text body (or a friendly "no pending"
    note when the list is empty).
    """
    Kpi = env['kra.kpi'].sudo()
    candidates = Kpi.search([
        ('task_state',          'in', ('pre_approval_pending', 'pre_approval_partial')),
        ('approval_token_used', '=',  False),
        ('approval_token',      '!=', False),
    ], order='create_date desc')

    mine = []
    for k in candidates:
        client_kra = getattr(k, 'client_kra_id', False) or k.kra_id
        if not client_kra:
            continue
        if partner and partner.id in client_kra.client_user_ids.mapped('partner_id').ids:
            mine.append(k)

    if not mine:
        return ("✅ You have no pending pre-approvals right now.\n\n"
                "Anything new will arrive here as a fresh message with "
                "Approve / Reject / Clarify buttons.")

    bot_phone = _bot_phone(env)
    base = f'https://wa.me/{bot_phone}?text=' if bot_phone else ''
    state_label = {
        'pre_approval_pending': '⏳ Waiting your approval',
        'pre_approval_partial': '🟡 PARTIAL — developer started prep work in non-billable mode',
    }

    lines = [f"📋 You have {len(mine)} task(s) awaiting your approval:"]
    for k in mine[:10]:
        ref = k.external_ref or f"#{k.id}"
        token_short = (k.approval_token or '')[:8]
        lines.append('')
        lines.append(f"— {ref}: {(k.name or '')[:60]}")
        lines.append(f"  Project: {(k.kra_id.name or '')[:40]}")
        lines.append(f"  State: {state_label.get(k.task_state, k.task_state)}")
        if base and token_short:
            lines.append(f"  ✅ Approve → {base}1-{token_short}")
            lines.append(f"  ❌ Reject  → {base}2-{token_short}")
            lines.append(f"  💬 Clarify → {base}4-{token_short}")
        elif token_short:
            lines.append(f"  Reply 1-{token_short} to approve, 2-{token_short} to reject, "
                         f"4-{token_short} to clarify.")
    if len(mine) > 10:
        lines.append('')
        lines.append(f"...and {len(mine) - 10} more — open the web link from the original message "
                     "to see the full queue.")
    return "\n".join(lines)


def _process_client_hi(pool, uid, session_id, phone_clean, msg_text):
    """Client-only handler: 'hi' / 'menu' / 'pending' from a phone matching a
    known client portal user → reply with the pending-approvals list.
    Returns True if handled.  Non-client phones always return False so the
    chain keeps walking.
    """
    body = (msg_text or '').strip().lower()
    if body not in _CLIENT_HI_TRIGGERS:
        return False
    try:
        with pool.cursor() as cr:
            env = api.Environment(cr, uid, {})
            partner = _resolve_partner_by_phone(env, phone_clean)
            actor_user, role = _resolve_actor(env, partner, phone_clean)
            # Only CLIENT-role phones get the menu reply.  Other roles are
            # deliberately ignored under the simplified model.
            if role != 'client':
                return False
            text = _build_client_pending_list(env, partner, phone_clean)
            _send_reply(pool, uid, session_id, phone_clean, text)
            cr.commit()
            return True
    except Exception as exc:
        _logger.exception("Client hi handler failed: %s", exc)
        return False


def _process_bare_token_reply(pool, uid, session_id, phone_clean, msg_text):
    """If sender typed just a hex token, reply with the 4 quick-tap links.
    Returns True if handled, False otherwise.
    """
    body = (msg_text or '').strip()
    m = _BARE_TOKEN_PATTERN.match(body)
    if not m:
        return False
    token = m.group(1).lower()
    try:
        with pool.cursor() as cr:
            env = api.Environment(cr, uid, {})
            Kpi = env['kra.kpi'].sudo()
            kpi = Kpi.search([
                ('approval_token', '=ilike', token + '%'),
                ('approval_token_used', '=', False),
            ], limit=1)
            if not kpi:
                _send_reply(pool, uid, session_id, phone_clean,
                            "Sorry — that token doesn't match an open task. Please use the link from the original message.")
                return True
            links = _build_tap_links(_bot_phone(env), (kpi.approval_token or '')[:8])
            ref = kpi.external_ref or f"#{kpi.id}"
            if links:
                reply = (
                    f"Did you mean to act on {ref} — {kpi.name}?\n"
                    f"Tap one of these (opens this chat with the action pre-filled):\n"
                    f"✅ Approve → {links['approve']}\n"
                    f"❌ Reject  → {links['reject']}\n"
                    f"⏸ Hold    → {links['hold']}\n"
                    f"💬 Clarify → {links['clarify']}"
                )
            else:
                token_short = (kpi.approval_token or '')[:8]
                reply = (
                    f"Did you mean to act on {ref} — {kpi.name}?\n"
                    f"Reply 1-{token_short} to approve, "
                    f"2-{token_short} to reject, "
                    f"3-{token_short} to hold, "
                    f"4-{token_short} to clarify."
                )
            _send_reply(pool, uid, session_id, phone_clean, reply)
            cr.commit()
            return True
    except Exception as exc:
        _logger.exception("Bare-token handler failed: %s", exc)
        return False


def _resolve_partner_by_phone(env, phone_clean):
    """Find a res.partner by phone digits (loose ilike — strips formatting).

    Returns recordset (may be empty).  Used to attribute the WhatsApp reply
    to a known client portal user instead of an anonymous label.

    Odoo 19 dropped res.partner.mobile; we only search the `phone` column.
    """
    if not phone_clean:
        return env['res.partner']
    # Strip "+" / spaces / hyphens already done by neonize; do a final loose match.
    digits = re.sub(r'\D+', '', phone_clean)
    if not digits:
        return env['res.partner']
    domain = [('phone', 'ilike', digits)]
    # Some Odoo builds still ship a `mobile` field via account/CRM addons; include
    # it dynamically only when present so we don't crash on pure Community installs.
    if 'mobile' in env['res.partner']._fields:
        domain = ['|', ('phone', 'ilike', digits), ('mobile', 'ilike', digits)]
    return env['res.partner'].sudo().search(domain, limit=1)


def _find_kpi_for_reply(env, token_prefix, partner):
    """Resolve which task this reply targets.

    Priority:
      1. Token prefix supplied  → match approval_token ILIKE 'prefix%' AND not yet used.
         Includes both pre-approval (pre_approval_pending/partial) and final
         sign-off (awaiting_client) — the caller routes by state.
      2. No token + a known partner → most-recent task awaiting THIS partner,
         in either pre-approval or awaiting_client state.
    Returns kra.kpi recordset (limit 1) — empty if no match.
    """
    Kpi = env['kra.kpi'].sudo()
    if token_prefix:
        return Kpi.search([
            ('approval_token', '=ilike', token_prefix + '%'),
            ('approval_token_used', '=', False),
        ], limit=1, order='create_date desc')

    if not partner:
        return Kpi

    # Walk client_user_ids of every KRA and find tasks awaiting this client's
    # decision (either pre-approval or final sign-off).
    candidates = Kpi.search([
        ('task_state', 'in', ('pre_approval_pending', 'awaiting_client')),
        ('approval_token_used', '=', False),
    ], order='create_date desc', limit=20)
    for k in candidates:
        # client_kra_id walks up the tree to find the "is_client" KRA;
        # fall back to direct kra_id if the computed field is missing.
        client_kra = k.client_kra_id or k.kra_id
        if not client_kra:
            continue
        if partner.id in client_kra.client_user_ids.mapped('partner_id').ids:
            return k
    return Kpi


def _send_reply(pool, uid, session_id, phone_clean, text):
    """Send a short text confirmation back via the same session.  We import
    WhatsAppSession lazily to keep the monkey-patch self-contained.
    """
    try:
        from odoo.addons.whatsapp_neonize.models.whatsapp_session import WhatsAppSession
        WhatsAppSession._send_reply_bg(pool, uid, session_id, phone_clean, text)
    except Exception as exc:
        _logger.warning("KPI inbound reply send failed: %s", exc)


# ---------------------------------------------------------------------------- #
# Conversation handling — "hi" / menu / create-task flow.                       #
# ---------------------------------------------------------------------------- #

_TRIGGER_WORDS = ('hi', 'hello', 'menu', 'new', 'create', 'start', 'help')


# ---------------------------------------------------------------------------- #
# Text-command parser: start / pause / resume / complete / approve / reject     #
# REF                                                                            #
# ---------------------------------------------------------------------------- #

# Match commands like "start REQ-040", "pause REQ-040 break too long", "approve
# REQ-040", "reject REQ-040 needs more work".  Ref is required so we never
# act on the wrong task.
_ACTION_COMMAND_PATTERN = re.compile(
    r'^\s*(start|pause|resume|complete|done|finish|approve|reject)'
    r'(?:\s+([A-Za-z]{2,5}[-_]?\d+))'
    r'(?:\s+(.+))?$',
    re.IGNORECASE,
)


def _find_kpi_by_ref(env, ref_text):
    """Resolve a user-typed ref to a kra.kpi.  Accepts 'REQ-040', 'REQ040',
    'req 040', etc.  Returns recordset (limit 1) — empty if no match.
    """
    if not ref_text:
        return env['kra.kpi'].sudo().browse()
    normalized = re.sub(r'[\s_]+', '-', ref_text.strip().upper())
    # Try exact match first, then prefix match.
    Kpi = env['kra.kpi'].sudo()
    rec = Kpi.search([('external_ref', '=ilike', normalized)], limit=1)
    if rec:
        return rec
    # Fallback: search by 3-letter prefix + numeric suffix in any format.
    digits = re.findall(r'\d+', ref_text)
    letters = re.findall(r'[A-Za-z]+', ref_text)
    if not digits or not letters:
        return Kpi.browse()
    pat = '%s-%%' % letters[0].upper()
    candidates = Kpi.search([('external_ref', '=ilike', pat)])
    target_n = int(digits[0])
    for c in candidates:
        m = re.search(r'(\d+)$', c.external_ref or '')
        if m and int(m.group(1)) == target_n:
            return c
    return Kpi.browse()


def _process_kpi_action_command(pool, uid, session_id, phone_clean, msg_text):
    """Return True if `msg_text` is a recognised action command and was handled."""
    body = (msg_text or '').strip()
    if not body:
        return False
    match = _ACTION_COMMAND_PATTERN.match(body)
    if not match:
        return False

    action = match.group(1).lower()
    ref_text = match.group(2)
    extra = (match.group(3) or '').strip()

    # Normalize 'done' / 'finish' to 'complete'
    if action in ('done', 'finish'):
        action = 'complete'

    try:
        with pool.cursor() as cr:
            env = api.Environment(cr, uid, {})
            partner = _resolve_partner_by_phone(env, phone_clean)
            actor_user, role = _resolve_actor(env, partner, phone_clean)

            if not actor_user:
                _send_reply(pool, uid, session_id, phone_clean,
                            "Your number isn't linked to any user. Ask the coordinator to add you.")
                return True

            kpi = _find_kpi_by_ref(env, ref_text)
            if not kpi:
                _send_reply(pool, uid, session_id, phone_clean,
                            f"Task {ref_text} not found.")
                return True

            # Authorization + state guards per action.
            ref_label = kpi.external_ref or kpi.name or f"#{kpi.id}"

            if action in ('start', 'pause', 'resume', 'complete'):
                # Developer actions: only the assigned developer (or a contributor)
                # can act.  Coordinator can override to assist if needed.
                allowed_user_ids = set([kpi.user_id.id] if kpi.user_id else [])
                allowed_user_ids.update(kpi.contributor_ids.ids)
                if actor_user.id not in allowed_user_ids and role not in ('coordinator', 'owner'):
                    _send_reply(pool, uid, session_id, phone_clean,
                                f"You're not assigned to task {ref_label}.")
                    return True

                # Sudo call so client / portal users with limited write rights still apply
                kpi_act = kpi.sudo().with_user(actor_user)
                try:
                    if action == 'start':
                        if kpi.task_state == 'in_progress':
                            _send_reply(pool, uid, session_id, phone_clean,
                                        f"Task {ref_label} is already in progress.")
                            return True
                        if kpi.task_state in ('completed', 'partially_completed', 'awaiting_client'):
                            _send_reply(pool, uid, session_id, phone_clean,
                                        f"Task {ref_label} is in state '{kpi.task_state}' — can't start.")
                            return True
                        kpi_act.start_task()
                        cr.commit()
                        _send_reply(pool, uid, session_id, phone_clean,
                                    f"▶️ Task {ref_label} STARTED.")
                    elif action == 'pause':
                        if kpi.task_state != 'in_progress':
                            _send_reply(pool, uid, session_id, phone_clean,
                                        f"Task {ref_label} isn't running (state: {kpi.task_state}).")
                            return True
                        reason = extra or 'Paused via WhatsApp'
                        kpi_act.pause_task(reason=reason)
                        cr.commit()
                        _send_reply(pool, uid, session_id, phone_clean,
                                    f"⏸ Task {ref_label} PAUSED.\nReason: {reason}")
                    elif action == 'resume':
                        if kpi.task_state == 'in_progress':
                            _send_reply(pool, uid, session_id, phone_clean,
                                        f"Task {ref_label} is already running.")
                            return True
                        if kpi.task_state not in ('paused', 'hold'):
                            _send_reply(pool, uid, session_id, phone_clean,
                                        f"Task {ref_label} isn't paused (state: {kpi.task_state}).")
                            return True
                        kpi_act.resume_task()
                        cr.commit()
                        _send_reply(pool, uid, session_id, phone_clean,
                                    f"▶️ Task {ref_label} RESUMED.")
                    elif action == 'complete':
                        if kpi.task_state in ('completed', 'partially_completed', 'awaiting_client'):
                            _send_reply(pool, uid, session_id, phone_clean,
                                        f"Task {ref_label} already finished (state: {kpi.task_state}).")
                            return True
                        kpi_act.complete_task()
                        cr.commit()
                        _send_reply(pool, uid, session_id, phone_clean,
                                    f"✅ Task {ref_label} marked COMPLETE.\nCoordinator will review.")
                except Exception as exc:
                    _logger.exception("Action %s on %s failed: %s", action, ref_label, exc)
                    _send_reply(pool, uid, session_id, phone_clean,
                                f"Could not {action} task {ref_label}: {exc}")
                return True

            if action in ('approve', 'reject'):
                # Coordinator / owner approval of completed work.
                if role not in ('coordinator', 'owner'):
                    _send_reply(pool, uid, session_id, phone_clean,
                                f"Only Coordinator / Owner can {action} a task.")
                    return True
                if kpi.task_state != 'partially_completed':
                    _send_reply(pool, uid, session_id, phone_clean,
                                f"Task {ref_label} isn't pending review (state: {kpi.task_state}).")
                    return True
                try:
                    if action == 'approve':
                        kpi.sudo().with_user(actor_user).approve_task()
                        cr.commit()
                        _send_reply(pool, uid, session_id, phone_clean,
                                    f"✅ Task {ref_label} APPROVED.\nClient will be asked to sign off.")
                    else:
                        reason = extra or 'Needs rework — see coordinator'
                        kpi.sudo().with_user(actor_user).reject_task(rejection_reason=reason)
                        cr.commit()
                        _send_reply(pool, uid, session_id, phone_clean,
                                    f"❌ Task {ref_label} REJECTED.\nFeedback: {reason}\nDeveloper notified.")
                except Exception as exc:
                    _logger.exception("Action %s on %s failed: %s", action, ref_label, exc)
                    _send_reply(pool, uid, session_id, phone_clean,
                                f"Could not {action} task {ref_label}: {exc}")
                return True

        return False
    except Exception as exc:
        _logger.exception("Action command parser failed: %s", exc)
        _send_reply(pool, uid, session_id, phone_clean,
                    "Sorry — error processing your command. Try again or contact the team.")
        return True


def _conversation_active(pool, uid, phone_clean):
    """Return True if there's a non-idle, non-stale conversation for this phone."""
    if not phone_clean:
        return False
    try:
        with pool.cursor() as cr:
            env = api.Environment(cr, uid, {})
            conv = env['kpi.wa.conversation'].sudo().search([('phone', '=', phone_clean)], limit=1)
            if not conv:
                return False
            if conv.step in ('idle', 'done'):
                return False
            if env['kpi.wa.conversation']._is_stale(conv):
                return False
            return True
    except Exception:
        return False
_CANCEL_WORDS  = ('cancel', 'exit', 'stop', 'abort', 'quit')


def _resolve_actor(env, partner, phone_clean):
    """Determine who's sending. Returns (actor_user_id, role).

    Priority: client_user (a portal user linked to any KRA) > owner > coordinator > developer.
    """
    user = env['res.users'].sudo().browse()
    if partner:
        user = env['res.users'].sudo().search([('partner_id', '=', partner.id)], limit=1)
    # Phone-only fallback: look for any user whose partner phone matches.
    # (Odoo 19 dropped res.partner.mobile; phone only.)
    if not user and phone_clean:
        user_domain = [('partner_id.phone', 'ilike', phone_clean)]
        if 'mobile' in env['res.partner']._fields:
            user_domain = ['|',
                ('partner_id.phone', 'ilike', phone_clean),
                ('partner_id.mobile', 'ilike', phone_clean)]
        user = env['res.users'].sudo().search(user_domain, limit=1)
    if not user:
        return env['res.users'].sudo(), 'unknown'

    groups = ('group_kra_owner', 'group_kra_admin', 'group_kra_client', 'group_kra_developer')
    for g in groups:
        grp = env.ref(f'kra_kpi_module.{g}', raise_if_not_found=False)
        if grp and user.id in grp.user_ids.ids:
            role = {
                'group_kra_owner':     'owner',
                'group_kra_admin':     'coordinator',
                'group_kra_client':    'client',
                'group_kra_developer': 'developer',
            }[g]
            return user, role
    return user, 'unknown'


def _projects_for_actor(env, actor_user, role):
    """Return the list of kra.master records the actor is allowed to create tasks under.

    Coordinator/Owner → every level-2 (sub) KRA.
    Client            → only the sub-KRAs they're in client_user_ids of.
    """
    Kra = env['kra.master'].sudo()
    if role in ('coordinator', 'owner'):
        return Kra.search([
            ('parent_id', '!=', False),
            ('parent_id.parent_id', '=', False),
            ('active', '=', True),
        ], order='name')
    if role == 'client' and actor_user:
        return Kra.search([
            ('parent_id', '!=', False),
            ('parent_id.parent_id', '=', False),
            ('active', '=', True),
            ('client_user_ids', 'in', [actor_user.id]),
        ], order='name')
    return Kra.browse()


def _format_menu(actor_user, role):
    """Build the menu shown when a sender types 'hi'.

    Each role sees the operations relevant to them.  Numbers are stable per
    role so we can map menu pick → action deterministically.
    """
    name = actor_user.name if actor_user else 'there'

    if role == 'coordinator':
        return "\n".join([
            f"👋 Hi {name} (Coordinator),",
            "What do you want to do?",
            "  1 — Assign developer + estimate to a queued task",
            "  2 — Approve a completed task",
            "  3 — Reject a completed task",
            "  4 — Create a new task (REQ / UPT / BUG)",
            "  5 — Show my pending approvals",
            "",
            "Reply with the number, or 'cancel' to abort.",
        ])

    if role == 'owner':
        return "\n".join([
            f"👋 Hi {name} (Owner),",
            "What do you want to do?",
            "  1 — Daily status summary",
            "  2 — Tasks waiting client sign-off",
            "  3 — Tasks pending coordinator approval",
            "  4 — Create a new task",
            "",
            "Reply with the number, or 'cancel' to abort.",
        ])

    if role == 'developer':
        return "\n".join([
            f"👋 Hi {name} (Developer),",
            "What do you want to do?",
            "  1 — Show my active tasks",
            "  2 — Start a task",
            "  3 — Pause a running task",
            "  4 — Resume a paused task",
            "  5 — Complete a task",
            "  6 — Create a new task",
            "",
            "Reply with the number, or 'cancel' to abort.",
        ])

    # Default: client (or unknown — most permissive UX)
    return "\n".join([
        f"👋 Hi {name},",
        "What do you want to do?",
        "  1 — Create New Requirement (REQ)",
        "  2 — Submit Task Update (UPT)",
        "  3 — Report a Bug (BUG)",
        "  4 — Show my pending pre-approvals",
        "",
        "Reply with the number, or 'cancel' to abort.",
    ])


# ---------------------------------------------------------------------------- #
# Listing helpers used by the role-specific menu options                         #
# ---------------------------------------------------------------------------- #

def _list_client_queue(env):
    """Tasks waiting for a developer assignment (Client Task Queue)."""
    return env['kra.kpi'].sudo().search([
        ('published', '=', False),
        ('user_id', '=', False),
        ('active', '=', True),
    ], order='create_date desc', limit=20)


def _list_my_active_tasks(env, actor_user):
    """Tasks the developer is currently assigned to that aren't fully closed."""
    return env['kra.kpi'].sudo().search([
        ('user_id', '=', actor_user.id),
        ('task_state', 'in',
            ('assigned', 'urgent', 'important', 'regular',
             'pre_approval_approved', 'pre_approval_partial',
             'in_progress', 'paused', 'hold', 'rework')),
        ('active', '=', True),
    ], order='priority desc, id desc', limit=20)


def _list_my_pending_approvals_for_coord(env, actor_user):
    """Tasks awaiting THIS coordinator's QA approval (partially_completed)."""
    return env['kra.kpi'].sudo().search([
        ('task_state', '=', 'partially_completed'),
        ('active', '=', True),
    ], order='completion_date desc', limit=20)


def _format_task_picker(label, tasks):
    if not tasks:
        return f"{label}\n(No matching tasks.)"
    lines = [label, "Reply with the number, or 'cancel'."]
    for i, k in enumerate(tasks, start=1):
        ref = k.external_ref or f"#{k.id}"
        proj = k.kra_id.name if k.kra_id else ''
        lines.append(f"  {i}. [{ref}] {k.name}  ({proj} • {k.task_state})")
    return "\n".join(lines)


def _list_developers(env):
    """Return active res.users in the developer group, for the coord picker."""
    grp = env.ref('kra_kpi_module.group_kra_developer', raise_if_not_found=False)
    if not grp:
        return env['res.users'].sudo()
    return grp.sudo().user_ids.filtered(lambda u: u.active and u.id > 1).sorted('name')


def _format_developer_picker(devs):
    if not devs:
        return "No developers configured."
    lines = ["Pick a developer:", "Reply with the number, or 'cancel'."]
    for i, u in enumerate(devs, start=1):
        lines.append(f"  {i}. {u.name}  ({u.login})")
    return "\n".join(lines)


def _owner_status_summary(env):
    """One-shot status digest for the Owner menu."""
    Kpi = env['kra.kpi'].sudo()
    fmt = lambda s, dom: f"  {s:<28}: {Kpi.search_count(dom)}"
    return "\n".join([
        "📊 KRA / KPI status",
        fmt('In queue (unassigned)',          [('published','=',False), ('user_id','=',False)]),
        fmt('Awaiting client pre-approval',    [('task_state','=','pre_approval_pending')]),
        fmt('Pre-approved / ready to start',   [('task_state','=','pre_approval_approved')]),
        fmt('In progress',                     [('task_state','=','in_progress')]),
        fmt('Paused / on hold',                [('task_state','in',['paused','hold'])]),
        fmt('Pending coordinator approval',    [('task_state','=','partially_completed')]),
        fmt('Awaiting client sign-off',        [('task_state','=','awaiting_client')]),
        fmt('Completed',                       [('task_state','=','completed')]),
    ])


def _format_project_picker(projects):
    lines = ["Which project? Reply with the number:"]
    for i, kra in enumerate(projects, start=1):
        lines.append(f"  {i}. {kra.name}")
    lines.append("\nOr 'cancel' to abort.")
    return "\n".join(lines)


def _show_pending_pre_approvals(env, partner, phone_clean):
    """Build a text snippet listing tasks waiting for this phone's pre-approval."""
    Kpi = env['kra.kpi'].sudo()
    candidates = Kpi.search([
        ('task_state', '=', 'pre_approval_pending'),
        ('approval_token_used', '=', False),
    ], order='create_date desc')
    mine = []
    for k in candidates:
        client_kra = k.client_kra_id or k.kra_id
        if not client_kra:
            continue
        if partner and partner.id in client_kra.client_user_ids.mapped('partner_id').ids:
            mine.append(k)
    if not mine:
        return "✅ You have no pending pre-approvals right now."
    lines = ["📋 Your pending pre-approvals — reply with 1-/2-/3-/4-<prefix> to decide:"]
    for k in mine[:10]:
        token = (k.approval_token or '')[:8]
        lines.append(f"  • {k.external_ref or k.name}: {k.name}  (token: {token})")
    return "\n".join(lines)


def _create_task_from_conversation(env, conv):
    """Materialise a kra.kpi row from the conversation's collected fields.

    State stays 'assigned' with no user_id — the coordinator picks the dev
    via the web form, which triggers the existing pre-approval / lifecycle
    pipeline automatically (see kpi_workflow.write override).
    """
    name_prefix_map = {'requirement': '', 'update': '[Update] ', 'bug': '[Bug] '}
    prefix = name_prefix_map.get(conv.action_type, '')
    Kpi = env['kra.kpi'].sudo()

    # Re-derive the server-side ref counter (matches /kpi_requirements/create_bulk_tasks)
    ref_prefix_map = {'requirement': 'REQ', 'update': 'UPT', 'bug': 'BUG'}
    ref_prefix = ref_prefix_map.get(conv.action_type, 'REQ')
    import re as _re
    existing = Kpi.search([('external_ref', '=ilike', '%s-%%' % ref_prefix)]).mapped('external_ref')
    pat = _re.compile(r'^%s-(\d+)$' % _re.escape(ref_prefix), _re.IGNORECASE)
    max_n = 0
    for r in existing:
        m = pat.match((r or '').strip())
        if m:
            try:
                n = int(m.group(1))
                if n > max_n:
                    max_n = n
            except ValueError:
                continue
    ref = '%s-%03d' % (ref_prefix, max_n + 1)

    # Every WhatsApp-created task — regardless of role — lands UNPUBLISHED
    # in the Client Task Queue so the Coordinator can assign a developer +
    # set estimate hours before it goes live.
    vals = {
        'name':         (prefix + (conv.task_title or '')).strip()[:240],
        'kra_id':       conv.project_kra_id.id,
        'external_ref': ref,
        'task_state':   'assigned',
        'active':       True,
        'published':    False,
        'priority':     'regular',
        'submitted_by_uid': conv.actor_user_id.id if conv.actor_user_id else False,
    }
    return Kpi.create(vals)


def _start_create_task_flow(conv, action_type, pool, uid, session_id, phone_clean):
    """Common entry for menu options that lead to title → project."""
    conv.sudo().write({'action_type': action_type, 'step': 'ask_title'})
    conv.touch()
    _send_reply(pool, uid, session_id, phone_clean, "Type the task title (one line).")


def _start_pick_task_flow(env, conv, label, tasks, pending_action,
                          pool, uid, session_id, phone_clean):
    """Common entry for menu options that need the user to pick a task to act on."""
    if not tasks:
        conv.reset()
        _send_reply(pool, uid, session_id, phone_clean,
                    f"{label}\n(No matching tasks right now.)")
        return
    conv.sudo().write({
        'task_choices_csv': ','.join(str(k.id) for k in tasks),
        'pending_action':   pending_action,
        'step':             'pick_task_for_action',
    })
    conv.touch()
    _send_reply(pool, uid, session_id, phone_clean, _format_task_picker(label, tasks))


def _handle_menu_pick(env, conv, body, partner, actor_user, role,
                      pool, uid, session_id, phone_clean):
    """Return True if the menu pick was understood + handled."""
    if not body or not body[0].isdigit():
        return False

    if role == 'coordinator':
        if body == '1':                  # Assign developer to a queue task
            queue = _list_client_queue(env)
            if not queue:
                conv.reset()
                _send_reply(pool, uid, session_id, phone_clean,
                            "📭 Client Task Queue is empty — nothing to assign.")
                return True
            conv.sudo().write({
                'task_choices_csv': ','.join(str(k.id) for k in queue),
                'step':             'coord_pick_queue_task',
            })
            conv.touch()
            _send_reply(pool, uid, session_id, phone_clean,
                        _format_task_picker("📥 Client Task Queue:", queue))
            return True
        if body == '2':                  # Approve a completed task
            pending = _list_my_pending_approvals_for_coord(env, actor_user)
            _start_pick_task_flow(env, conv, "✅ Tasks pending approval:",
                                  pending, 'approve', pool, uid, session_id, phone_clean)
            return True
        if body == '3':                  # Reject a completed task
            pending = _list_my_pending_approvals_for_coord(env, actor_user)
            _start_pick_task_flow(env, conv, "❌ Reject which task?",
                                  pending, 'reject', pool, uid, session_id, phone_clean)
            return True
        if body == '4':                  # Create new task
            _start_create_task_flow(conv, 'requirement', pool, uid, session_id, phone_clean)
            return True
        if body == '5':                  # Show my pending approvals (listing)
            pending = _list_my_pending_approvals_for_coord(env, actor_user)
            conv.reset()
            _send_reply(pool, uid, session_id, phone_clean,
                        _format_task_picker("✅ Pending coordinator approvals:", pending))
            return True
        return False

    if role == 'owner':
        if body == '1':
            conv.reset()
            _send_reply(pool, uid, session_id, phone_clean, _owner_status_summary(env))
            return True
        if body == '2':
            tasks = env['kra.kpi'].sudo().search([('task_state', '=', 'awaiting_client')], limit=20)
            conv.reset()
            _send_reply(pool, uid, session_id, phone_clean,
                        _format_task_picker("⏳ Awaiting client sign-off:", tasks))
            return True
        if body == '3':
            tasks = env['kra.kpi'].sudo().search([('task_state', '=', 'partially_completed')], limit=20)
            conv.reset()
            _send_reply(pool, uid, session_id, phone_clean,
                        _format_task_picker("✅ Pending coordinator approval:", tasks))
            return True
        if body == '4':
            _start_create_task_flow(conv, 'requirement', pool, uid, session_id, phone_clean)
            return True
        return False

    if role == 'developer':
        if body == '1':                  # Show active tasks
            tasks = _list_my_active_tasks(env, actor_user)
            conv.reset()
            _send_reply(pool, uid, session_id, phone_clean,
                        _format_task_picker("📋 Your active tasks:", tasks))
            return True
        if body == '2':                  # Start a task
            tasks = _list_my_active_tasks(env, actor_user).filtered(
                lambda k: k.task_state in (
                    'assigned', 'urgent', 'important', 'regular',
                    'pre_approval_approved', 'pre_approval_partial',
                    'paused', 'hold', 'rework'))
            _start_pick_task_flow(env, conv, "▶️ Start which task?",
                                  tasks, 'start', pool, uid, session_id, phone_clean)
            return True
        if body == '3':                  # Pause
            tasks = _list_my_active_tasks(env, actor_user).filtered(
                lambda k: k.task_state == 'in_progress')
            _start_pick_task_flow(env, conv, "⏸ Pause which task?",
                                  tasks, 'pause', pool, uid, session_id, phone_clean)
            return True
        if body == '4':                  # Resume
            tasks = _list_my_active_tasks(env, actor_user).filtered(
                lambda k: k.task_state in ('paused', 'hold'))
            _start_pick_task_flow(env, conv, "▶️ Resume which task?",
                                  tasks, 'resume', pool, uid, session_id, phone_clean)
            return True
        if body == '5':                  # Complete
            tasks = _list_my_active_tasks(env, actor_user).filtered(
                lambda k: k.task_state in ('in_progress', 'paused'))
            _start_pick_task_flow(env, conv, "✅ Complete which task?",
                                  tasks, 'complete', pool, uid, session_id, phone_clean)
            return True
        if body == '6':                  # Create new task
            _start_create_task_flow(conv, 'requirement', pool, uid, session_id, phone_clean)
            return True
        return False

    # Default: client / unknown
    if body in ('1', '2', '3'):
        type_map = {'1': 'requirement', '2': 'update', '3': 'bug'}
        _start_create_task_flow(conv, type_map[body], pool, uid, session_id, phone_clean)
        return True
    if body == '4':
        text = _show_pending_pre_approvals(env, partner, phone_clean)
        conv.reset()
        _send_reply(pool, uid, session_id, phone_clean, text)
        return True
    return False


def _handle_conversation(pool, uid, session_id, phone_clean, msg_text):
    """Return True if the message was handled by the conversation flow."""
    body_raw = (msg_text or '').strip()
    if not body_raw:
        return False
    body = body_raw.lower()

    try:
        with pool.cursor() as cr:
            env = api.Environment(cr, uid, {})
            partner = _resolve_partner_by_phone(env, phone_clean)
            actor_user, role = _resolve_actor(env, partner, phone_clean)

            Conv = env['kpi.wa.conversation'].sudo()
            conv = Conv.get_or_create(phone_clean)

            # Universal cancel.
            if body in _CANCEL_WORDS:
                conv.reset()
                cr.commit()
                _send_reply(pool, uid, session_id, phone_clean,
                            "❎ Conversation cancelled. Reply 'hi' to start over.")
                return True

            # Trigger word starts (or restarts) the menu.
            if body in _TRIGGER_WORDS or conv.step == 'idle':
                conv.sudo().write({
                    'step': 'menu',
                    'actor_user_id': actor_user.id if actor_user else False,
                    'actor_partner_id': partner.id if partner else False,
                    'actor_role': role,
                })
                conv.touch()
                cr.commit()
                _send_reply(pool, uid, session_id, phone_clean, _format_menu(actor_user, role))
                return True

            # Menu choice — branches by role.
            if conv.step == 'menu':
                if _handle_menu_pick(env, conv, body, partner, actor_user, role,
                                     pool, uid, session_id, phone_clean):
                    cr.commit()
                    return True
                _send_reply(pool, uid, session_id, phone_clean,
                            "Please reply with the number from the menu (or 'cancel').")
                return True

            # ---- Coordinator: assign queue task → developer → hours ---- #
            if conv.step == 'coord_pick_queue_task':
                ids = [int(x) for x in (conv.task_choices_csv or '').split(',') if x]
                try:
                    idx = int(body)
                except ValueError:
                    _send_reply(pool, uid, session_id, phone_clean,
                                "Please reply with a number from the list.")
                    return True
                if idx < 1 or idx > len(ids):
                    _send_reply(pool, uid, session_id, phone_clean,
                                f"Number must be between 1 and {len(ids)}.")
                    return True
                target_kpi = env['kra.kpi'].sudo().browse(ids[idx - 1])
                devs = _list_developers(env)
                if not devs:
                    conv.reset()
                    cr.commit()
                    _send_reply(pool, uid, session_id, phone_clean,
                                "❌ No developers configured.")
                    return True
                conv.sudo().write({
                    'target_kpi_id':     target_kpi.id,
                    'user_choices_csv':  ','.join(str(u.id) for u in devs),
                    'step':              'coord_pick_developer',
                })
                conv.touch()
                cr.commit()
                _send_reply(pool, uid, session_id, phone_clean,
                            _format_developer_picker(devs))
                return True

            if conv.step == 'coord_pick_developer':
                uids = [int(x) for x in (conv.user_choices_csv or '').split(',') if x]
                try:
                    idx = int(body)
                except ValueError:
                    _send_reply(pool, uid, session_id, phone_clean,
                                "Please reply with the developer's number.")
                    return True
                if idx < 1 or idx > len(uids):
                    _send_reply(pool, uid, session_id, phone_clean,
                                f"Number must be between 1 and {len(uids)}.")
                    return True
                dev_user = env['res.users'].sudo().browse(uids[idx - 1])
                conv.sudo().write({
                    'target_user_id': dev_user.id,
                    'step':           'coord_ask_hours',
                })
                conv.touch()
                cr.commit()
                _send_reply(pool, uid, session_id, phone_clean,
                            f"Selected developer: {dev_user.name}\n"
                            "How many estimated hours? Reply with a number (e.g. 2 or 2.5).")
                return True

            if conv.step == 'coord_ask_hours':
                try:
                    hours_f = float(body.replace(',', '.'))
                    if hours_f < 0 or hours_f > 1000:
                        raise ValueError("out of range")
                except ValueError:
                    _send_reply(pool, uid, session_id, phone_clean,
                                "Please reply with a positive number (hours).")
                    return True
                h_int = int(hours_f)
                m_int = int(round((hours_f - h_int) * 60))
                if not conv.target_kpi_id or not conv.target_user_id:
                    conv.reset()
                    cr.commit()
                    _send_reply(pool, uid, session_id, phone_clean,
                                "Conversation state lost. Reply 'hi' to restart.")
                    return True
                kpi = conv.target_kpi_id
                dev = conv.target_user_id
                # write() override flips published=True + auto-triggers pre-approval
                kpi.sudo().write({
                    'user_id':          dev.id,
                    'estimate_hours':   h_int,
                    'estimate_minutes': m_int,
                })
                ref = kpi.external_ref or kpi.name or f"#{kpi.id}"
                conv.reset()
                cr.commit()
                _send_reply(
                    pool, uid, session_id, phone_clean,
                    f"✅ Assigned task {ref} to {dev.name}\n"
                    f"Estimate: {h_int}h {m_int}m\n"
                    "Client has been notified for pre-approval.",
                )
                return True

            # ---- Pick a task to act on (start/pause/resume/complete/approve/reject) ---- #
            if conv.step == 'pick_task_for_action':
                ids = [int(x) for x in (conv.task_choices_csv or '').split(',') if x]
                try:
                    idx = int(body)
                except ValueError:
                    _send_reply(pool, uid, session_id, phone_clean,
                                "Please reply with a task number.")
                    return True
                if idx < 1 or idx > len(ids):
                    _send_reply(pool, uid, session_id, phone_clean,
                                f"Number must be between 1 and {len(ids)}.")
                    return True
                kpi = env['kra.kpi'].sudo().browse(ids[idx - 1])
                action = conv.pending_action or 'start'
                ref_label = kpi.external_ref or kpi.name or f"#{kpi.id}"
                conv.reset()
                cr.commit()
                # Apply the action directly on the kpi record so we don't depend
                # on the command-regex matching a possibly-empty external_ref.
                try:
                    if action == 'start':
                        kpi.sudo().with_user(actor_user).start_task()
                        msg = f"▶️ Task {ref_label} STARTED."
                    elif action == 'pause':
                        kpi.sudo().with_user(actor_user).pause_task(reason='Paused via WhatsApp')
                        msg = f"⏸ Task {ref_label} PAUSED."
                    elif action == 'resume':
                        kpi.sudo().with_user(actor_user).resume_task()
                        msg = f"▶️ Task {ref_label} RESUMED."
                    elif action == 'complete':
                        kpi.sudo().with_user(actor_user).complete_task()
                        msg = f"✅ Task {ref_label} marked COMPLETE.\nCoordinator will review."
                    elif action == 'approve':
                        kpi.sudo().with_user(actor_user).approve_task()
                        msg = f"✅ Task {ref_label} APPROVED.\nClient will be asked to sign off."
                    elif action == 'reject':
                        kpi.sudo().with_user(actor_user).reject_task(rejection_reason='Rejected via WhatsApp')
                        msg = f"❌ Task {ref_label} REJECTED.\nDeveloper notified."
                    else:
                        msg = f"Unknown action '{action}'."
                    env.cr.commit()
                except Exception as exc:
                    _logger.exception("Action %s on %s failed: %s", action, ref_label, exc)
                    msg = f"Could not {action} task {ref_label}: {exc}"
                _send_reply(pool, uid, session_id, phone_clean, msg)
                return True

            # Title.
            if conv.step == 'ask_title':
                title = body_raw[:240]
                if not title:
                    _send_reply(pool, uid, session_id, phone_clean,
                                "Title can't be empty. Type the task title.")
                    return True
                conv.sudo().write({'task_title': title, 'step': 'ask_project'})
                projects = _projects_for_actor(env, actor_user, role)
                if not projects:
                    conv.reset()
                    cr.commit()
                    _send_reply(pool, uid, session_id, phone_clean,
                                "❌ No projects are linked to your account. Ask the coordinator to add you.")
                    return True
                conv.sudo().write({
                    'project_choices_csv': ','.join(str(p.id) for p in projects),
                })
                conv.touch()
                cr.commit()
                _send_reply(pool, uid, session_id, phone_clean, _format_project_picker(projects))
                return True

            # Project pick.
            if conv.step == 'ask_project':
                try:
                    idx = int(body)
                except ValueError:
                    _send_reply(pool, uid, session_id, phone_clean,
                                "Please reply with the project's number (or 'cancel').")
                    return True
                ids = [int(x) for x in (conv.project_choices_csv or '').split(',') if x]
                if idx < 1 or idx > len(ids):
                    _send_reply(pool, uid, session_id, phone_clean,
                                f"Number must be between 1 and {len(ids)}.")
                    return True
                project = env['kra.master'].sudo().browse(ids[idx - 1])
                conv.sudo().write({'project_kra_id': project.id})

                # Create the task. The kra.kpi create() override handles the
                # 'task_created' notification + audit row automatically.
                new_kpi = _create_task_from_conversation(env, conv)
                conv.sudo().write({'created_kpi_id': new_kpi.id, 'step': 'done'})
                conv.reset()  # idle so a follow-up 'hi' starts fresh
                cr.commit()
                _send_reply(
                    pool, uid, session_id, phone_clean,
                    f"✅ Task created.\n"
                    f"Ref: {new_kpi.external_ref}\n"
                    f"Title: {new_kpi.name}\n"
                    f"Project: {project.name}\n"
                    f"State: Assigned — coordinator will pick a developer.",
                )
                return True

        return False
    except Exception as exc:
        _logger.exception("Conversation handler failed: %s", exc)
        _send_reply(pool, uid, session_id, phone_clean,
                    "Sorry — something went wrong. Reply 'hi' to restart.")
        return True


def _process_kpi_reply_instant(pool, uid, session_id, phone_clean, msg_text):
    """Return True if `msg_text` was recognised as a KPI pre-approval reply
    AND handled (regardless of whether the action succeeded).  Returns False
    to let other chained parsers try.
    """
    body = (msg_text or '').strip()
    if not body:
        return False
    match = _KPI_REPLY_PATTERN.match(body)
    if not match:
        return False

    action_code = match.group(1)
    token_prefix = (match.group(2) or '').lower()
    action = _ACTION_BY_CODE[action_code]

    try:
        with pool.cursor() as cr:
            env = api.Environment(cr, uid, {})

            partner = _resolve_partner_by_phone(env, phone_clean)
            kpi = _find_kpi_for_reply(env, token_prefix, partner)

            if not kpi:
                # If user supplied an explicit hex-token prefix but it doesn't
                # match any live KPI, they may have meant a sale-order credit
                # reply — return False so the chain falls through to the
                # credit parser.  If no token at all, send the "no pending
                # task" reply since the bare action code is unambiguous.
                if token_prefix:
                    return False
                _send_reply(
                    pool, uid, session_id, phone_clean,
                    "Sorry — no pending task found for this reply. "
                    "Please use the link or contact the team.",
                )
                cr.commit()
                return True

            partner_name = (partner.name if partner else '') or phone_clean or 'WhatsApp client'
            # Route by state: pre-approval vs. final sign-off.  Final sign-off
            # only accepts approve / reject / clarify (no 'hold').
            if kpi.task_state == 'awaiting_client':
                if action == 'hold':
                    _send_reply(pool, uid, session_id, phone_clean,
                                f"Task {kpi.external_ref or kpi.name} is at final sign-off — "
                                "reply 1 to approve, 2 to reject, or 4 for clarification.")
                    cr.commit()
                    return True
                result = kpi.record_client_final_decision(
                    action=action,
                    partner_name=partner_name,
                    feedback='',
                    source='whatsapp',
                    ip=phone_clean,
                    user_agent='WhatsApp / neonize',
                    partner_id=partner.id if partner else None,
                )
            else:
                result = kpi.record_client_pre_decision(
                    action=action,
                    partner_name=partner_name,
                    feedback='',
                    source='whatsapp',
                    ip=phone_clean,
                    user_agent='WhatsApp / neonize',
                    partner_id=partner.id if partner else None,
                )
            cr.commit()

            status = (result or {}).get('status')
            ref = kpi.external_ref or kpi.name or f"#{kpi.id}"
            if status == 'ok':
                if (result or {}).get('decision') == 'approve' and (result or {}).get('state') == 'completed':
                    msg = (f"🎉 Task {ref} SIGNED OFF.\n"
                           f"Signed by: {partner_name}\n"
                           f"Invoice can now be generated.")
                else:
                    msg = f"✓ Task {ref} {_ACTION_VERB.get(action, 'updated')}."
            elif status == 'already_decided':
                prev = (result.get('decision') or '').upper()
                msg = f"Task {ref} is already {prev}. No change applied."
            elif status == 'expired':
                msg = f"Approval link for task {ref} has expired. Please request a new one."
            else:
                msg = f"Could not record decision for task {ref}: {result.get('message','unknown error')}"
            _send_reply(pool, uid, session_id, phone_clean, msg)
    except Exception as exc:
        _logger.exception("KPI inbound parser failed: %s", exc)
        _send_reply(
            pool, uid, session_id, phone_clean,
            "Sorry — an error occurred recording your reply. The team has been notified.",
        )

    return True


# ---------------------------------------------------------------------------- #
# Install the monkey-patch at module import time.                              #
# ---------------------------------------------------------------------------- #
try:
    from odoo.addons.whatsapp_neonize.models.whatsapp_session import WhatsAppSession  # noqa: I001

    if not getattr(WhatsAppSession, '_kpi_parser_installed', False):
        _original = WhatsAppSession._process_credit_reply_instant

        def _chained_credit_reply(pool, uid, session_id, phone_clean, msg_text):
            # -----------------------------------------------------------------
            # SIMPLIFIED MODEL (2026-06-12):
            # WhatsApp 2-way is CLIENT-ONLY now.  Steps (1)-(3) below
            # (action commands like `start REQ-040`, the role-aware
            # conversation menu, and the `hi`/`menu` trigger-word bootstrap)
            # are deliberately commented out — developers, coordinators and
            # owners drive everything from the web dashboard instead.  The
            # source for those handlers stays in this file so we can flip
            # them back on by uncommenting if needed.
            # -----------------------------------------------------------------

            # (1) Action command — DISABLED.
            # try:
            #     if _process_kpi_action_command(pool, uid, session_id, phone_clean, msg_text):
            #         return True
            # except Exception as exc:
            #     _logger.warning("Action command parser raised: %s", exc)

            # (2) Active conversation re-entry — DISABLED.
            # try:
            #     if _conversation_active(pool, uid, phone_clean):
            #         if _handle_conversation(pool, uid, session_id, phone_clean, msg_text):
            #             return True
            # except Exception as exc:
            #     _logger.warning("Conversation handler raised: %s", exc)

            # (3) Trigger word bootstrap — DISABLED.
            # try:
            #     _body = (msg_text or '').strip().lower()
            #     if _body in _TRIGGER_WORDS:
            #         if _handle_conversation(pool, uid, session_id, phone_clean, msg_text):
            #             return True
            # except Exception as exc:
            #     _logger.warning("Conversation trigger raised: %s", exc)

            # (3.5) Client-only 'hi'/'menu' → list of pending pre-approvals.
            #       Other roles fall through (handler resolves role and bails).
            try:
                if _process_client_hi(pool, uid, session_id, phone_clean, msg_text):
                    return True
            except Exception as exc:
                _logger.warning("Client hi handler raised: %s", exc)

            # (4) KPI pre-approval / final-sign-off reply (1-/2-/3-/4-<token>).
            #     MUST run BEFORE the credit parser — both match "1-XYZ" but the
            #     credit parser would otherwise hijack our hex tokens and reply
            #     "Order not found".  Returns False when no live token matches,
            #     so genuine sale-order replies fall through correctly.
            #     This is the entire late-approval path — DO NOT TOUCH.
            if _process_kpi_reply_instant(pool, uid, session_id, phone_clean, msg_text):
                return True

            # 5) Original credit parser (sale-order credit override).
            try:
                if _original(pool, uid, session_id, phone_clean, msg_text):
                    return True
            except Exception as exc:
                _logger.warning("Original credit parser raised: %s", exc)

            # 6) Bare token (no action prefix) — guide user with tap-to-send links.
            try:
                if _process_bare_token_reply(pool, uid, session_id, phone_clean, msg_text):
                    return True
            except Exception as exc:
                _logger.warning("Bare-token handler raised: %s", exc)
            return False

        WhatsAppSession._process_credit_reply_instant = staticmethod(_chained_credit_reply)
        WhatsAppSession._kpi_parser_installed = True
        _logger.info("KRA/KPI inbound reply parser installed on WhatsAppSession.")
except Exception as exc:
    # whatsapp_neonize might not be installed in some envs; log and skip.
    _logger.warning("Could not install KRA/KPI inbound parser: %s", exc)
