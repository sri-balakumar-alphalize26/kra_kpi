"use client";
/* The Odoo Setup / Settings menus that had no web screen, each one the
   generic RecordScreen with Odoo's own list columns, form fields and buttons
   (from the module's views/*.xml). A page passes only the screen's name:
   the configs hold functions, which cannot cross from a server page. */
import RecordScreen from "./RecordScreen";

/* The status wizard (kpi.client.db.action). Odoo hides "Tell the client" when
   refusing a request: refusing always tells them. */
const DB_WIZARD = (mode, title, text) => ({
  model: "kpi.client.db.action", apply: "action_apply", title,
  text: () => text,
  fields: [{ name: "note", label: "Why. The client is shown this, so write it for them.", required: true },
    ...(mode === "reject" ? [] : [{ name: "tell_client", label: "Tell the client on WhatsApp", type: "boolean" }])],
  defaults: mode === "reject" ? {} : { tell_client: false },
});
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

/* "See the tasks": every ticket raised against a database, stopped or not
   (kpi.client.db.action_view_tasks). A row opens the task on the board. */
const TASK_STATES = { assigned: "Assigned", urgent: "Urgent", important: "Important", regular: "Regular", queue_waiting: "Queued",
  pre_approval_pending: "Pre-Approval Pending", pre_approval_approved: "Pre-Approval Approved", pre_approval_partial: "Partially Approved",
  in_progress: "In Progress", paused: "Paused", hold: "On Hold", rework: "Rework Required", partially_completed: "Verification Pending",
  awaiting_client: "Awaiting Client Sign-off", completed: "Completed" };
const TASK_RECORDS = {
  fields: ["external_ref", "name", "user_id", "task_state", "active"],
  columns: [
    { key: "external_ref", label: "Ref", render: (t) => t.external_ref || `#${t.id}` },
    { key: "name", label: "Task", render: (t) => <>{t.name}{t.active === false ? <span className="mini"> · archived</span> : null}</> },
    { key: "user_id", label: "Assignee" },
    { key: "task_state", label: "Status", render: (t) => TASK_STATES[t.task_state] || t.task_state || "—" },
  ],
  href: (t) => `/board?task=${t.id}`,
};

const CLIENT_DB = {
  model: "kpi.client.db", noun: "database", archive: true, create: true, del: true, order: "client_kra_id, db_name",
  list: ["db_name", "label", "client_kra_id", "server_id", "state", "disconnect_state", "term_id", "expires_on", "days_left", "task_count", "source"],
  form: [
    { section: "Database" }, "db_name", "label", "server_id", "state", "source", "last_fetch_at",
    { section: "Client" }, "client_kra_id", "kra_id", "task_count", "first_seen_at", "disconnected_at",
    { section: "Term" }, "track_term", "term_id", "activated_on", "expires_on", "days_left",
    { section: "Disconnect request", hideIf: (r) => !r.disconnect_state || r.disconnect_state === "none" }, "disconnect_state", "disconnect_requested_by_name", "disconnect_requested_by_number", "disconnect_requested_at", "disconnect_reason_id", "disconnect_request_kpi_id", "disconnected_by_id", "disconnect_reason_text", "disconnect_note",
    { section: "Notes" }, "notes",
  ],
  /* Odoo's search view: db name, client, server; its filters (one group per
     separator) and group-bys. Tick rows for Suspend / Disconnect / Reactivate. */
  search: ["db_name", "client_kra_id", "server_id"],
  filters: [
    { key: "suspended", group: "state", label: "Suspended", domain: [["state", "=", "suspended"]] },
    { key: "disconnected", group: "state", label: "Disconnected", domain: [["state", "=", "disconnected"]] },
    { key: "expiring", group: "term", label: "Expiring in 30 days", domain: () => [["track_term", "=", true], ["expires_on", "!=", false], ["expires_on", ">=", inDays(0)], ["expires_on", "<=", inDays(30)]] },
    { key: "expired", group: "term", label: "Expired", domain: () => [["track_term", "=", true], ["expires_on", "!=", false], ["expires_on", "<", inDays(0)]] },
    { key: "unassigned", group: "who", label: "No client yet", domain: [["client_kra_id", "=", false]] },
    { key: "fetched", group: "who", label: "Found on a server", domain: [["source", "=", "fetched"]] },
  ],
  groupBy: [{ key: "client", label: "Client", field: "client_kra_id" }, { key: "server", label: "Server", field: "server_id" }, { key: "state", label: "Status", field: "state" }, { key: "term", label: "Term", field: "term_id" }],
  bulk: true,
  /* Database name: the databases the picked server lists (kpi.server.databases_for_pick). */
  suggest: { db_name: { dep: "server_id", model: "kpi.server", method: "databases_for_pick" } },
  /* The form's rules: Term only when tracked, the "Disconnect request" block only when there is one. */
  hideIf: {
    term_id: (r) => !r.track_term, expires_on: (r) => !r.track_term, days_left: (r) => !r.track_term,
    last_fetch_at: (r) => r.source !== "fetched", disconnected_at: (r) => r.state !== "disconnected",
    ...Object.fromEntries(["disconnect_state", "disconnect_requested_by_name", "disconnect_requested_by_number", "disconnect_requested_at", "disconnect_reason_id", "disconnect_request_kpi_id", "disconnected_by_id", "disconnect_reason_text", "disconnect_note"].map((f) => [f, (r) => !r.disconnect_state || r.disconnect_state === "none"])),
  },
  requiredIf: { term_id: (r) => !!r.track_term },
  alerts: [
    { show: (r) => !!r.id && !r.client_kra_id, tone: "warn", text: <>No client is set, so <b>nobody is offered this database</b> in any WhatsApp menu. Set the client below to make it selectable.</> },
    { show: (r) => r.state === "disconnected", tone: "danger", text: <><b>This database is stopped.</b> No new task can be raised against it from anywhere — WhatsApp, the web or the app. Work logged before it stopped is untouched and still invoiceable.</> },
    { show: (r) => r.disconnect_state === "requested", tone: "warn", text: <><b>The client has asked for this to be switched off.</b> It is still live. Use <b>Disconnect</b> to action it or <b>Refuse Request</b> to decline, with a reason either way.</> },
    { show: (r) => !r.track_term, tone: "info", text: <><b>No term is being tracked.</b> That is the normal case: the database simply exists and is live, with no expiry date and no reminders. Tick <b>Track term</b> only where a weekly / monthly / yearly arrangement is real.</> },
  ],
  actions: [
    { method: "action_activate", label: "Mark Live", show: (r) => r.state !== "live", done: "Marked live." },
    { method: "action_open_suspend", label: "Suspend", list: true, bulk: true, show: (r) => r.state === "live", wizard: DB_WIZARD("suspend", "Suspend database", "It stops being offered to the client; nothing is deleted."), done: "Suspended." },
    { method: "action_open_disconnect", label: "Disconnect", danger: true, list: true, bulk: true, show: (r) => r.state !== "disconnected", wizard: DB_WIZARD("disconnect", "Disconnect database", "This switches the database off in our records and tells the client, naming the database, who asked and when. It does not touch the server - dropping the actual database is still a deliberate act by whoever has access to it."), done: "Disconnected." },
    { method: "action_open_reject", label: "Refuse Request", show: (r) => r.disconnect_state === "requested", wizard: DB_WIZARD("reject", "Refuse the request", "The client's disconnect request is refused."), done: "Request refused." },
    { method: "action_reactivate", label: "Reactivate", list: true, bulk: true, show: (r) => r.state === "suspended", done: "Reactivated." },
    { method: "action_build_kra", label: "Build KRA Tree", show: (r) => !r.kra_id, done: "KRA tree built." },
    { method: "action_view_tasks", label: "See the tasks", show: (r) => r.task_count > 0, records: TASK_RECORDS },
  ],
};

export const SCREENS = {
  servers: {
    title: "Servers", meta: "The Odoo servers your clients' databases live on", model: "kpi.server", noun: "server",
    archive: true, create: true, del: true, order: "sequence, name", secret: ["pg_password"],
    list: ["name", "label", "fetch_method", "url", "host", "db_count", "fetch_enabled", "last_fetch_at"],
    form: [{ section: "Server" }, "name", "label", "sequence", "db_count", "last_fetch_at", "last_fetch_error",
      { section: "Fetching databases" }, "fetch_method", "fetch_enabled", "url", "url_verify_ssl", "db_preview",
      { section: "PostgreSQL (fetch method: postgres)" }, "host", "port", "pg_maintenance_db", "pg_user", "pg_password", "pg_sslmode",
      { section: "Notes" }, "notes"],
    actions: [
      { method: "action_test_connection", label: "Test Connection", list: true },
      { method: "action_fetch_databases", label: "🔄 Refresh list", done: "Database list read." },
    ],
  },
  "decline-reasons": {
    title: "Decline Reasons", meta: "Why a client request is declined or re-classified", model: "kpi.decline.reason", noun: "reason",
    archive: true, create: true, del: true, order: "sequence, name",
    list: ["sequence", "name", "mode", "target_doc_type", "code"],
    form: ["name", "mode", "target_doc_type", "code", "sequence", "client_message"],
  },
  "install-packages": {
    title: "Install Packages", meta: "Ready-made install bundles offered on WhatsApp", model: "kpi.install.preset", noun: "package",
    archive: true, create: true, del: true, order: "sequence, name",
    list: ["sequence", "emoji", "name", "contents", "needs_detail", "code"],
    form: ["name", "emoji", "sequence", "code", "needs_detail", "contents"],
  },
  databases: {
    ...CLIENT_DB, title: "Databases", meta: "Every client database: live, suspended or disconnected",
    tabs: [{ key: "all", label: "All" }, { key: "live", label: "Live", domain: [["state", "=", "live"]] }, { key: "pending", label: "Pending", domain: [["state", "=", "pending"]] }, { key: "requested", label: "Disconnect requested", domain: [["disconnect_state", "=", "requested"]] }],
  },
  "live-databases": {
    ...CLIENT_DB, title: "Live Databases", crumb: "Clients", meta: "Client databases in use now", domain: [["state", "=", "live"]],
  },
  "db-terms": {
    title: "Database Terms", meta: "How long a database runs before it expires", model: "kpi.db.term", noun: "term",
    archive: true, create: true, del: true, order: "sequence, name",
    list: ["sequence", "name", "months", "days", "is_perpetual", "length_display"],
    form: ["name", "is_perpetual", "months", "days", "length_display", "sequence", "notes"],
  },
  "approval-chain": {
    title: "Approval Chain", meta: "Who decides a new client request, in order, and for how long", model: "kpi.escalation.tier", noun: "tier",
    archive: true, create: true, del: true, order: "sequence, id",
    intro: "A new client request, or a task a developer creates for themselves, goes to the first tier. If nobody there decides within its minutes, the next tier is asked, and so on. After the last tier it keeps waiting and the last tier is reminded every 30 minutes. Nothing is accepted automatically.",
    list: ["sequence", "name", "minutes", "use_task_manager", "user_ids"],
    form: ["name", "sequence", "minutes", "use_task_manager", "user_ids"],
  },
  "disconnect-reasons": {
    title: "Disconnect Reasons", meta: "Reasons a client gives for disconnecting a database", model: "kpi.db.disconnect.reason", noun: "reason",
    archive: true, create: true, del: true, order: "sequence, name",
    list: ["sequence", "emoji", "name", "needs_detail", "code"],
    form: ["name", "emoji", "sequence", "code", "needs_detail"],
  },
  "wa-groups": {
    title: "WhatsApp Groups", meta: "Groups the WhatsApp number is in — link each to a client", model: "kpi.wa.group", noun: "group",
    onOpen: "action_open_groups", archive: true, order: "last_seen desc",
    intro: "Groups are imported from WhatsApp each time this opens. Tick “Internal team group” for your own staff group; set a Client to turn a group into that client's request channel.",
    list: ["name", "is_staff_group", "kra_id", "intake_enabled", "member_count", "client_member_count", "sub_client_count", "last_sender", "message_count", "last_seen"],
    form: [{ section: "Group" }, "name", "is_staff_group", "kra_id", "intake_enabled", "active", "jid",
      { section: "Activity" }, "member_count", "client_member_count", "sub_client_count", "message_count", "last_seen", "last_sender", "members_synced_at"],
    lockOnEdit: ["jid"],
    /* Odoo's search and filters, and the form's locks: a group is EITHER a
       client's or ours, and bot replies wait for a client (or "ours"). */
    search: ["name", "jid", "kra_id"],
    filters: [
      { key: "unassigned", group: "client", label: "No Client Set", domain: [["kra_id", "=", false]] },
      { key: "assigned", group: "client", label: "Linked To A Client", domain: [["kra_id", "!=", false]] },
    ],
    groupBy: [{ key: "client", label: "Client", field: "kra_id" }],
    readonlyIf: { is_staff_group: (r) => !!r.kra_id, kra_id: (r) => !!r.is_staff_group, intake_enabled: (r) => !r.kra_id && !r.is_staff_group },
    hideIf: { sub_client_count: (r) => !!r.is_staff_group, client_member_count: (r) => !!r.is_staff_group },
    alerts: [
      { show: (r) => !!r.is_staff_group, tone: "info", text: <>This is your own team&apos;s group. The bot posts the developer menu and internal warnings here, and never anything a client should see. <b>Do not put a client in it.</b></> },
      { show: (r) => !r.kra_id && !r.is_staff_group, tone: "warn", text: <>Set a Client before enabling bot replies — or tick <b>Our Internal Team Group</b> above if this one is yours.</> },
    ],
    actions: [{ method: "action_sync_members", label: "Sync Members", list: true, done: "Members synced." }],
    children: [
      { model: "kpi.wa.group.member", field: "group_id", label: "Members", order: "wa_name",
        list: ["wa_name", "phone", "member_kind", "manual_client_kra_id", "partner_id", "user_id", "is_admin"],
        labels: { wa_name: "WhatsApp Name", member_kind: "Role", manual_client_kra_id: "Client (set here)", partner_id: "Contact", user_id: "Odoo User", is_admin: "Group Admin" },
        edit: { manual_client_kra_id: "kra.master" },
        note: <><b>Role</b> is worked out automatically from each member&apos;s Odoo user. If somebody is plainly the client but shows as <i>Not in Odoo</i>, set <b>Client (set here)</b> on their row — that is kept when you Sync Members again.</>,
        empty: "No members yet — press Sync Members." },
      { model: "kra.master", ids: "sub_client_ids", label: "Sub-clients", list: ["name", "is_client", "active"], labels: { is_client: "Is Client" },
        hideIf: (r) => !!r.is_staff_group, empty: "This client has no sub-clients yet. Add them as child records on the client itself, then they will appear here." },
      { model: "res.users", ids: "client_user_ids", label: "Client Users", list: ["name", "login"], empty: "None." },
    ],
  },
  "wa-database": {
    title: "WhatsApp Database", meta: "Which Odoo database the WhatsApp service is attached to", model: "kpi.wa.database",
    system: true, readonly: true, onOpen: "action_open", order: "name",
    list: ["name", "ready", "is_served", "state_label", "connected_session", "schema_kind", "module_state", "session_count", "last_message_at", "blocked_reason"],
    form: ["name", "is_odoo", "schema_kind", "connected_session", "ready", "state_label", "is_served", "module_state", "session_count", "last_message_at", "blocked_reason"],
    actions: [{ method: "action_take_over", label: "Give WhatsApp to this one", danger: true, list: true, show: (r) => r.ready && !r.is_served,
      confirm: "WhatsApp moves to this database and Odoo RESTARTS for everybody. Continue?" }],
  },
  "wa-sessions": {
    title: "WhatsApp sessions", model: "whatsapp.session", noun: "session", create: true, del: true, order: "id",
    secret: ["instance_token"],
    list: ["name", "phone_number", "instance_name", "country_name", "auto_reconnect", "status", "last_webhook_at", "message_count"],
    form: [{ section: "Session" }, "status", "message_count", "name", "phone_number", "country_name", "auto_reconnect",
      { section: "Server (Evolution API)" }, "base_url", "instance_name", "instance_id", "instance_token", "send_delay_ms",
      { section: "Incoming messages (webhook)" }, "webhook_url", "webhook_ok", "webhook_checked_at", "last_webhook_at", "last_state_check", "webhook_actual", "error_message"],
    actions: [
      { method: "action_refresh_status", label: "Refresh Status", list: true },
      { method: "action_register_webhook", label: "Fix Incoming Messages", done: "Webhook registered." },
      { method: "action_resolve_pending_lids", label: "Resolve LIDs" },
      { method: "action_capture_phone", label: "Capture Phone" },
    ],
  },
  "ai-chats": {
    title: "AI Assistant Chats", crumb: "Settings", meta: "Every conversation with the 369 AI Assistant", model: "kpi.ai.chat",
    readonly: true, del: true, order: "write_date desc",
    list: ["name", "user_id", "question_count", "period", "create_date", "write_date"],
    form: ["name", "user_id", "question_count", "create_date", "write_date"],
    formWidth: 760,
    /* Odoo's search (chat, user, words in any question or answer) and filters. */
    search: ["name", "user_id", "message_ids.text"],
    filters: [
      { key: "mine", label: "My chats", domain: ({ uid }) => [["user_id", "=", uid]] },
      { key: "today", label: "Today", domain: () => [["write_date", ">=", `${inDays(0)} 00:00:00`]] },
    ],
    groupBy: [{ key: "user", label: "User", field: "user_id" }],
    /* Tap a bot message for its full answer (answer_html), as Odoo's message form does. */
    children: { model: "kpi.ai.chat.message", field: "chat_id", label: "Conversation", order: "id", list: ["role", "text", "create_date"],
      labels: { role: "Who", text: "Question / answer title", create_date: "Time" }, pre: ["text"], expand: "answer_html" },
  },
};

export default function SetupScreen({ name, embedded = false }) {
  const config = SCREENS[name];
  if (!config) return null;
  return <RecordScreen config={config} embedded={embedded} />;
}
