/* Settings services (ports of kraKpi.js, config.js, users.js,
   loginManagement.js, companyBranding.js, waGroup.js). */
import { rpc, read, callKw, assertOk, invalidate } from "@/lib/api";

/* ---- KRA / KPI master ---- */
export const fetchKraTree = () => callKw("kra.master", "get_kra_tree").then((r) => r || []);
/* A root KRA (a client) can be created with its portal users ticked, as Odoo's
   Create KRA form does: kra.master.create_kra takes client_user_ids (ignored
   for a sub-KRA). Answers the new id; a duplicate name raises (ApiError). */
export const createKra = ({ name, parentId, clientUserIds }) => {
  const ids = parentId ? [] : (clientUserIds || []).map(Number).filter(Boolean);
  if (ids.length) {
    return callKw("kra.master", "create_kra", [{ name: (name || "").trim(), is_sub: false, parent_id: false, client_user_ids: ids }]).then((id) => ({ status: true, id }));
  }
  return rpc("/kra_kpi/create_kra", { name: (name || "").trim(), is_sub: !!parentId, parent_id: parentId ? Number(parentId) : false });
};
export const updateKra = (kraId, name) => rpc("/kra_kpi/update_kra", { kra_id: Number(kraId), name: (name || "").trim() });
export const deleteKra = (kraId) => rpc("/kra_kpi/delete_kra", { kra_id: Number(kraId) });
/* kra.kpi.create_kpi (sudo, honours the estimate), as the mobile app does —
   /kra_kpi/create_kpi creates without sudo and drops the estimate.
   The full form of Odoo's Create KPI screen (kpi_create.js save()): assignee,
   deliverable type(s), deadline, reminder, description, checklist, guidelines,
   points and the flags. `docType` (requirement | update | bug) also mints the
   REQ / UPT / BUG ref on the server; blank leaves the task without one. */
export const KPI_FLAGS = [
  ["is_mandatory", "Mandatory"], ["auto_assign", "Auto assign"], ["auto_estimated", "Auto estimated"], ["is_permanent", "Permanent"],
  ["service_kpi", "Service KPI"], ["is_meeting", "Meeting"], ["is_manager_review_needed", "Manager review needed"], ["is_customer_review_needed", "Customer review needed"],
];
export const createKpi = (t) => {
  const v = {
    name: (t.name || "").trim(), kra_id: Number(t.kraId), estimate_hours: Number(t.estimateHours) || 0, estimate_minutes: Number(t.estimateMinutes) || 0, priority: t.priority || "regular",
    user_id: t.userId ? Number(t.userId) : false, deliverable_type: Array.isArray(t.deliverable) ? t.deliverable.join(",") : t.deliverable || "", deliverable_other: t.deliverableOther || "",
    deadline: t.deadline || false, reminder_days: Number(t.reminderDays) || 0, reminder_hours: Number(t.reminderHours) || 0, reminder_minutes: Number(t.reminderMinutes) || 0,
    description: t.description || "", checklist: t.checklist || "", guidelines: t.guidelines || "", points: Number(t.points) || 0,
  };
  for (const [k] of KPI_FLAGS) v[k] = !!t.flags?.[k];
  if (t.docType) v.doc_type = t.docType;
  /* The rest of Odoo's form: user group, action, next KPI, warehouse, a file and related links. */
  v.user_group_id = t.userGroupId ? Number(t.userGroupId) : false;
  v.action_config_id = t.actionConfigId ? Number(t.actionConfigId) : false;
  v.next_kpi_id = t.nextKpiId ? Number(t.nextKpiId) : false;
  v.warehouse_id = t.warehouseId ? Number(t.warehouseId) : false;
  v.file_name = t.fileName || "";
  v.uploaded_file = t.uploadedFile || false;
  v.related_links = JSON.stringify(t.relatedLinks || []);
  return callKw("kra.kpi", "create_kpi", [v]);
};
/* Odoo's KPI Details screen. → { status, kpi: {name, kra_name, …, file_content, related_links} } */
export const fetchKpiDetail = (kpiId) => rpc("/kra_kpi/get_kpi_detail", { kpi_id: Number(kpiId) });
/* The pick lists behind those fields, read the way kpi_create.js reads them. */
const pickList = (model, domain = []) => callKw(model, "search_read", [domain], { fields: ["id", "name"], order: "name" }).catch(() => []);
export const fetchUserGroups = () => pickList("res.groups");
export const fetchActionConfigs = () => pickList("kpi.config.screen");
export const fetchKpiPickList = () => pickList("kra.kpi");
export const fetchWarehouses = () => pickList("kra.warehouse");
/* Odoo's "+" quick-create dialogs next to each pick list. Each answers the new id. */
const newId = (r) => (Array.isArray(r) ? r[0] : r);
export const quickCreateUserGroup = (name) => callKw("res.groups", "create", [[{ name: name.trim() }]]).then(newId);
export const quickCreateEmployee = ({ name, email, login }) => callKw("res.users", "create", [[{ name: name.trim(), login: login.trim(), email: email.trim() }]]).then(newId);
export const quickCreateAction = ({ name, url }) => callKw("kpi.config.screen", "create", [[{ name: name.trim(), url: url.trim(), active: true }]]).then(newId);
export const quickCreateWarehouse = ({ name, countryCode, phone, address, company, transaction }) =>
  callKw("kra.warehouse", "create", [[{ name: name.trim(), phone: phone?.trim() ? `${(countryCode || "").trim()} ${phone.trim()}`.trim() : "", address: address || "", company: company || "", transaction_number: transaction || "" }]]).then(newId);
export const addChecklistLibraryItem = (name) => callKw("kpi.checklist.master", "create", [[{ name: name.trim() }]]).then(newId);
export const addGuidelineLibraryItem = (name) => callKw("kpi.guideline.master", "create", [[{ name: name.trim() }]]).then(newId);
/* Odoo's checklist / guideline libraries (kpi_create.js): picked items are written into the text as "1. …". */
export const fetchChecklistLibrary = () => callKw("kpi.checklist.master", "search_read", [[]], { fields: ["id", "name"], order: "sequence, name" }).catch(() => []);
export const fetchGuidelineLibrary = () => callKw("kpi.guideline.master", "search_read", [[]], { fields: ["id", "name"], order: "sequence, name" }).catch(() => []);
/* The manuals on a KPI (the tree's manual badge opens one, as kra_node.js does). */
export const listKpiManuals = (kpiId) => rpc("/kpi/manual/list", { kpi_id: Number(kpiId) }).then((r) => (r?.status ? r.manuals || [] : []));
export const renameKpi = (kpiId, name) => callKw("kra.kpi", "write", [[Number(kpiId)], { name: (name || "").trim() }]);
export const deleteKpi = (kpiId) => rpc("/kra_kpi/delete_kpi", { kpi_id: Number(kpiId) });
export const fetchClientUsers = () => rpc("/kra_kpi/kra/get_client_users", {}).then((r) => r?.users || r?.clients || []);
export const assignKraClients = (kraId, userIds) => rpc("/kra_kpi/kra/assign_clients", { kra_id: Number(kraId), user_ids: (userIds || []).map(Number) });
/* A client portal login. Empty password → a 6-digit one is generated and
   returned once ({password, generated_password}). */
export const createClientUser = ({ name, login, phone, password }) => rpc("/kra_kpi/kra/create_client_user", { name: (name || "").trim(), login: (login || "").trim(), phone: (phone || "").replace(/[^\d]/g, ""), password: password || "" });

/* ---- configuration ---- */
export const CONFIG_PATH = "/kpi_config/get";
export const MULTITASK_PATH = "/kpi_multitask/list";
export const fetchConfig = () => read(CONFIG_PATH, {}, { ttl: 10000 });
export const fetchDevelopers = () => read(MULTITASK_PATH, {}, { ttl: 10000 }).then((r) => r?.developers || []);
export const cfgSet = {
  /* adminAccept / clientApproval retired (module 19.0.8.6): nothing is accepted or
     released automatically, so those windows are no longer set from here. */
  queueNudge: (minutes) => rpc("/kpi_config/set_queue_nudge", { minutes }),
  urgentNudge: (minutes) => rpc("/kpi_config/set_urgent_nudge", { minutes }),
  /* WhatsApp number(s), comma-separated, that get each End Workday's "What did you work on today?". */
  ceoNumbers: (numbers) => rpc("/kpi_config/set_ceo_numbers", { numbers: numbers || "" }),
  breakAlerts: (values) => rpc("/kpi_config/set_break_alerts", values || {}),
  standardHours: (hours) => rpc("/kpi_config/set_standard_hours", { hours }),
  country: (country_id) => rpc("/kpi_config/set_country", { country_id }),
  attendanceInApp: (enabled) => rpc("/kpi_config/set_attendance_in_app", { enabled: !!enabled }),
  snapshotRetention: (number, unit) => rpc("/kpi_config/set_snapshot_retention", { number, unit }),
  reportRetention: (number, unit) => rpc("/kpi_config/set_report_retention", { number, unit }),
  /* unit: days | months | years; 0 = keep forever. */
  downloadRetention: (number, unit) => rpc("/kpi_config/set_download_retention", { number, unit }),
  dailyReport: ({ enabled, hour, coverage }) => rpc("/kpi_config/set_daily_report", { enabled, hour, coverage }),  multitask: (user_id, allow) => rpc("/kpi_multitask/set", { user_id, allow }),
  devWa: (user_id, wa_number) => rpc("/kpi_multitask/set_wa", { user_id, wa_number }),
};
export const invalidateConfig = () => { invalidate("/kpi_config"); invalidate("/kpi_multitask"); };

/* 📹 Meetings (controllers/kpi_meeting_page.py): every meeting timing.
   get → { status, meet_record_all, meet_rec_pause_min, meet_ask_after_min,
   meet_reply_sec, meet_gone_min, meet_bot_alone_min, meet_rec_max_h,
   meet_record_keep_days }; set takes any of those keys and answers the same. */
/* 🏁 Finish & client review (controllers/kpi_finish_api.py): days the client has to
   check finished work (1-60), and whether an admin checks it first. Answers the
   saved {review_days, skip_admin}. */
export const finish = {
  get: () => rpc("/kpi_config/finish/get", {}),
  set: (vals) => rpc("/kpi_config/finish/set", vals || {}),
};

export const meetings = {
  get: () => rpc("/kpi_config/meeting_get", {}),
  set: (vals) => rpc("/kpi_config/meeting_set", vals || {}),
};

/* ---- 🧾 Billing (controllers/kpi_billing_api.py): the price list a bill is
   made from at Full Complete, and who hears about each bill. Admins only;
   the routes answer {status:false} for anyone else. */
export const billing = {
  config: () => rpc("/kpi_billing/config", {}),
  saveRate: (r) => rpc("/kpi_billing/rate/save", {
    id: r.id || null, client_id: r.client_id ? Number(r.client_id) : null, work_type: r.work_type, method: r.method,
    amount: r.amount, currency_id: r.currency_id ? Number(r.currency_id) : null,
    date_from: r.date_from, date_to: r.date_to || null, note: r.note || "",
  }),
  deleteRate: (id) => rpc("/kpi_billing/rate/delete", { id }),
  setNumbers: (numbers) => rpc("/kpi_billing/set_numbers", { numbers: numbers || "" }),
  /* Per client: the WhatsApp group its invoices go to, and the Send invoices switch. */
  clientInvoice: (clientId, vals) => rpc("/kpi_billing/client_invoice_set", { client_id: clientId, ...vals }),
};

/* ---- WhatsApp group report events ---- */
export const fetchGroupEvents = () => rpc("/kpi_wa_group/events", {});
export const setGroupEvent = ({ event, enabled, template }) => { const p = { event }; if (enabled != null) p.enabled = enabled; if (template != null) p.template = template; return rpc("/kpi_wa_group/set_event", p); };
export const testGroupEvent = (event, confirmJid) => rpc("/kpi_wa_group/test_event", { event, confirm_jid: confirmJid });
/* The group itself: captured + joined groups, choose one, label one, test it.
   A test must echo back the selected jid (confirm_jid) or the server refuses. */
export const WA_GROUPS_PATH = "/kpi_wa_group/list";
export const fetchWaGroups = () => rpc(WA_GROUPS_PATH, {}, { timeout: 45000 });
export const selectWaGroup = (jid, name) => rpc("/kpi_wa_group/select", { jid: jid || "", name: name || "" });
/* Join by invite link and use it in one step (Odoo Configuration › Advanced). → { status, jid, message } */
export const joinWaGroup = (link) => rpc("/kpi_wa_group/join", { link: (link || "").trim(), select: true, name: "" }, { timeout: 45000 });
export const renameWaGroup = (jid, name) => rpc("/kpi_wa_group/rename", { jid, name: (name || "").trim() });
export const testWaGroup = (confirmJid) => rpc("/kpi_wa_group/test", { confirm_jid: confirmJid }, { timeout: 45000 });

/* ---- users + login management (same /kpi_user_access/get) ---- */
export const ACCESS_PATH = "/kpi_user_access/get";
export const fetchAccess = () => read(ACCESS_PATH, {}, { ttl: 10000 });
export const ROLES = [{ code: "admin", label: "Admin" }, { code: "coordinator", label: "Coordinator" }, { code: "developer", label: "Developer" }, { code: "client", label: "Client" }];
export const createUser = ({ name, login, email, kra_role, mobile, active = true, password }) => rpc("/kpi_user_access/create", { name, login, email, kra_role, mobile, active, password });
export const updateUser = (userId, { name, login, email, active }) => rpc("/kpi_user_access/update", { user_id: userId, name, login, email, active });
export const setUserRole = (userId, role) => rpc("/kpi_user_access/set_role", { user_id: userId, role });
export const setUserMobile = (userId, mobile) => rpc("/kpi_user_access/set_mobile", { user_id: userId, mobile });
export const setUserCountry = (userId, countryId) => rpc("/kpi_user_access/set_country", { user_id: userId, country_id: countryId || false });
export const changePassword = (userId, password) => rpc("/kpi_user_access/change_password", { user_id: userId, password });
export const resetPassword = (userId) => rpc("/kpi_user_access/reset_password", { user_id: userId });
export const toggleLogin = (userId, enabled) => rpc("/kpi_user_access/toggle_login", { user_id: userId, enabled: !!enabled });
export const setOtpMessage = (template) => rpc("/kpi_user_access/set_otp_message", { template });
export const waConnect = () => rpc("/kpi_wa_server/connect", {}, { timeout: 60000 });
export const waStatus = (sessionId) => rpc("/kpi_wa_server/status", { session_id: sessionId });
export const waDelete = (sessionId) => rpc("/kpi_wa_server/delete", { session_id: sessionId });
export const invalidateAccess = () => invalidate("/kpi_user_access");

/* ---- WhatsApp connect (whatsapp_neonize's whatsapp.session form, via call_kw) ----
   Odoo's Setup › WhatsApp Connect opens this model's own form: Connect / Send
   message / Disconnect (keeps the record and its message history) / Refresh
   status, plus the message log. Odoo's ACLs decide (the WhatsApp user / manager
   groups); a refusal arrives as a thrown ApiError. */
export const WA_SESSION_FIELDS = ["name", "status", "phone_number", "auto_reconnect", "message_count", "error_message", "qr_last_update"];
export const listWaSessions = () => callKw("whatsapp.session", "search_read", [[]], { fields: WA_SESSION_FIELDS, order: "id desc" });
export const readWaQr = (id) => callKw("whatsapp.session", "read", [[Number(id)], ["qr_image", "status"]]).then((r) => r?.[0] || null);
export const waSessionConnect = (id) => callKw("whatsapp.session", "action_connect", [[Number(id)]]);
export const waSessionDisconnect = (id) => callKw("whatsapp.session", "action_disconnect", [[Number(id)]]);
export const waSessionRefresh = (id) => callKw("whatsapp.session", "action_refresh_status", [[Number(id)]]);
/* send_message(phone, message): the number with country code; logs a whatsapp.message row. */
export const waSessionSend = (id, phone, message) => callKw("whatsapp.session", "send_message", [[Number(id)], String(phone || ""), String(message || "")]);
export const listWaMessages = (sessionId, limit = 200) => callKw("whatsapp.message", "search_read", [[["session_id", "=", Number(sessionId)]]], { fields: ["create_date", "direction", "phone", "partner_id", "message", "status"], order: "create_date desc, id desc", limit });

/* ---- branding ---- */
export const BRAND_PATH = "/kra_kpi/company/get";
export const saveBranding = ({ name, logo_b64 }) => rpc("/kra_kpi/company/save", { name, logo_b64 }, { timeout: 60000 });

export { assertOk };
