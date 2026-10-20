"use client";
/* The Odoo Setup / Settings menus that had no web screen, each one the
   generic RecordScreen with Odoo's own list columns, form fields and buttons
   (from the module's views/*.xml). A page passes only the screen's name:
   the configs hold functions, which cannot cross from a server page. */
import RecordScreen from "./RecordScreen";

const DB_WIZARD = (mode, title, text) => ({
  model: "kpi.client.db.action", apply: "action_apply", title,
  text: () => text,
  fields: [{ name: "note", label: "Reason / note", required: true }, { name: "tell_client", label: "Tell the client on WhatsApp", type: "boolean" }],
  defaults: { tell_client: mode !== "reject" ? false : true },
});

const CLIENT_DB = {
  model: "kpi.client.db", noun: "database", archive: true, create: true, del: true, order: "client_kra_id, db_name",
  list: ["db_name", "label", "client_kra_id", "server_id", "state", "disconnect_state", "term_id", "expires_on", "days_left", "task_count", "source"],
  form: [
    { section: "Database" }, "db_name", "label", "server_id", "state", "source", "last_fetch_at",
    { section: "Client" }, "client_kra_id", "kra_id", "task_count", "first_seen_at", "disconnected_at",
    { section: "Term" }, "track_term", "term_id", "activated_on", "expires_on", "days_left",
    { section: "Disconnect request" }, "disconnect_state", "disconnect_requested_by_name", "disconnect_requested_by_number", "disconnect_requested_at", "disconnect_reason_id", "disconnect_request_kpi_id", "disconnected_by_id", "disconnect_reason_text", "disconnect_note",
    { section: "Notes" }, "notes",
  ],
  actions: [
    { method: "action_activate", label: "Mark Live", show: (r) => r.state !== "live", done: "Marked live." },
    { method: "action_open_suspend", label: "Suspend", list: true, show: (r) => r.state === "live", wizard: DB_WIZARD("suspend", "Suspend database", "It stops being offered to the client; nothing is deleted."), done: "Suspended." },
    { method: "action_open_disconnect", label: "Disconnect", danger: true, list: true, show: (r) => r.state !== "disconnected", wizard: DB_WIZARD("disconnect", "Disconnect database", "The database is marked disconnected."), done: "Disconnected." },
    { method: "action_open_reject", label: "Refuse Request", show: (r) => r.disconnect_state === "requested", wizard: DB_WIZARD("reject", "Refuse the request", "The client's disconnect request is refused."), done: "Request refused." },
    { method: "action_reactivate", label: "Reactivate", list: true, show: (r) => r.state === "suspended" || r.state === "disconnected", done: "Reactivated." },
    { method: "action_build_kra", label: "Build KRA Tree", show: (r) => !r.kra_id, done: "KRA tree built." },
  ],
};

export const SCREENS = {
  servers: {
    title: "Servers", meta: "The Odoo servers your clients' databases live on", model: "kpi.server", noun: "server",
    archive: true, create: true, del: true, order: "sequence, name", secret: ["pg_password"],
    list: ["name", "label", "fetch_method", "url", "host", "db_count", "fetch_enabled", "last_fetch_at"],
    form: [{ section: "Server" }, "name", "label", "sequence", "db_count", "last_fetch_at", "last_fetch_error",
      { section: "Fetching databases" }, "fetch_method", "fetch_enabled", "url", "url_verify_ssl",
      { section: "PostgreSQL (fetch method: postgres)" }, "host", "port", "pg_maintenance_db", "pg_user", "pg_password", "pg_sslmode",
      { section: "Notes" }, "notes"],
    actions: [
      { method: "action_test_connection", label: "Test Connection", list: true },
      { method: "action_fetch_databases", label: "Fetch Databases", done: "Databases fetched." },
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
    actions: [{ method: "action_sync_members", label: "Sync Members", list: true, done: "Members synced." }],
    children: { model: "kpi.wa.group.member", field: "group_id", label: "Members", order: "wa_name", list: ["wa_name", "phone", "member_kind", "user_id", "manual_client_kra_id", "is_admin", "last_synced"], empty: "No members yet — press Sync Members." },
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
    children: { model: "kpi.ai.chat.message", field: "chat_id", label: "Messages", order: "id", list: ["role", "text"], pre: ["text"] },
  },
};

export default function SetupScreen({ name, embedded = false }) {
  const config = SCREENS[name];
  if (!config) return null;
  return <RecordScreen config={config} embedded={embedded} />;
}
