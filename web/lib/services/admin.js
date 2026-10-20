/* Ports of the mobile admin services: live tracking, employee tracker,
   owner dashboard, client task queue, pre-approvals, uploads/intake,
   attendance, client files. Same routes and params as the app. */
import { rpc, read, href, assertOk } from "@/lib/api";

/* ---- live tracking ---- */
export const LIVE_TRACKING_PATH = "/kpi_owner/live_tracking";
export const fetchLiveTracking = () => read(LIVE_TRACKING_PATH, {}, { ttl: 5000 });
export const revertWorkday = (userId, reason) => rpc("/kpi_workday/revert", { user_id: userId, reason: reason || "" }, { timeout: 45000 });
/* NEW on 19.0.5.7: ping a developer. Rate-limited 10 min per person. */
export const nudgeUser = (userId, note) => rpc("/kpi_owner/nudge_user", { user_id: userId, note: (note || "").slice(0, 300) });
/* One person's day (the End Workday summary payload + sessions, first_login,
   late, missing_progress). Never opens a session; a day without one answers
   {started:false}. `date` YYYY-MM-DD, default today; a future day is refused. */
export const EMPLOYEE_DAY_PATH = "/kpi_owner/employee_day";
export const employeeDayParams = (userId, date) => (date ? { user_id: Number(userId), date } : { user_id: Number(userId) });

/* ---- action log (kpi.action.log; owner / coordinator / system) ---- */
export const ACTION_LOG_PATH = "/kpi_owner/action_log";
export const actionLogParams = ({ userId, kpiId, fromDate, toDate, limit = 500 } = {}) => {
  const p = { limit };
  if (userId) p.user_id = Number(userId);
  if (kpiId) p.kpi_id = Number(kpiId);
  if (fromDate && toDate && fromDate === toDate) p.date = fromDate;
  else { if (fromDate) p.from_date = fromDate; if (toDate) p.to_date = toDate; }
  return p;
};

/* ---- task approval status (started with / without the client's approval) ---- */
export const TASK_APPROVAL_PATH = "/kpi_task_approval/list";
export const fetchAvailableClients = () => rpc("/kpi_task_approval/get_available_clients", {}).then((r) => assertOk(r, "Could not load clients.").clients || []);
export const setTaskKraClients = (kpiId, userIds) => rpc("/kpi_task_approval/set_kra_clients", { kpi_id: Number(kpiId), client_user_ids: (userIds || []).map(Number) });
export const resendTaskApproval = (kpiId) => rpc("/kpi_task_approval/resend", { kpi_id: Number(kpiId) }, { timeout: 45000 });
/* Re-fire the pre-approval for a task in pre_approval_pending / _partial. */
export const resendPreApproval = (kpiId) => rpc("/kpi_pending_queue/resend_pre_approval", { kpi_id: Number(kpiId) }, { timeout: 45000 });

/* ---- completion certificates ---- */
export const CERT_LIST_PATH = "/kpi_completion_cert/list";
export const certListParams = ({ clientKraId, fromDate, toDate, state = "completed" } = {}) => {
  const p = { state };
  if (clientKraId) p.client_kra_id = Number(clientKraId);
  if (fromDate) p.from_date = fromDate;
  if (toDate) p.to_date = toDate;
  return p;
};
export const fetchCertData = (kpiId) => rpc("/kpi_completion_cert/pdf_data", { kpi_id: Number(kpiId) }, { timeout: 60000 }).then((r) => assertOk(r, "Could not load the certificate.").data);
export const fetchSignedCertB64 = (kpiId) => rpc("/kpi_completion_cert/pdf_b64", { kpi_id: Number(kpiId) }, { timeout: 60000 }).then((r) => assertOk(r, "No certificate for this task."));
export const setDeliveryVersion = (kpiId, version) => rpc("/kpi_completion_cert/set_version", { kpi_id: Number(kpiId), delivery_version: version || "" });
export const setRequirementVersion = (kpiId, version) => rpc("/kpi_completion_cert/upload_doc", { kpi_id: Number(kpiId), doc_type: "requirement", requirement_version: version || "" });
/* doc_type 'requirement' | 'updates'. An empty fileData clears the document. */
export const uploadCertDoc = (kpiId, docType, { fileData, fileName }) => rpc("/kpi_completion_cert/upload_doc", { kpi_id: Number(kpiId), doc_type: docType, file_data: fileData || "", file_name: fileName || "" }, { timeout: 120000 });
export const uploadSignedCert = (kpiId, { fileData, fileName, signedDate }) => rpc("/kpi_completion_cert/upload_signed", { kpi_id: Number(kpiId), file_data: fileData || "", file_name: fileName || "", signed_date: signedDate || false }, { timeout: 120000 });
export const setCertRoles = (kpiId, roles) => rpc("/kpi_completion_cert/set_roles", { kpi_id: Number(kpiId), ...roles });
export const createTaskFromDoc = (t) => rpc("/kpi_completion_cert/create_task_from_doc", {
  client_kra_id: Number(t.clientKraId), sub_kra_id: Number(t.subKraId), task_name: (t.taskName || "").trim(), requirement_version: t.requirementVersion || "",
  estimate_hours: Number(t.estimateHours) || 0, estimate_minutes: Number(t.estimateMinutes) || 0, primary_user_id: t.primaryUserId ? Number(t.primaryUserId) : false,
  deliverable_type: t.deliverableType || "", file_data: t.fileData || "", file_name: t.fileName || "",
}, { timeout: 120000 });
/* type='http' GET: doc_type 'requirement' | 'updates' | 'signed'. */
export const certDocHref = (kpiId, docType) => href(`/kpi_completion_cert/download_doc?kpi_id=${Number(kpiId)}&doc_type=${encodeURIComponent(docType)}`);

/* ---- project completion check ---- */
export const PROJECT_COMPLETION_PATH = "/kpi_project/completion_status";

/* ---- employee tracker ---- */
export const TIME_FRAMES = [{ key: "daily", label: "Daily" }, { key: "weekly", label: "Weekly" }, { key: "monthly", label: "Monthly" }];
export const fetchTrackerEmployees = () => read("/kpi_reports/employee/get_employees", {}, { ttl: 300000 }).then((r) => r?.employees || []);
export const SUMMARY_PATH = "/kpi_reports/developer_summary";
export const summaryParams = ({ timeFrame = "daily", userId = null, fromDate = null, toDate = null } = {}) =>
  ({ time_frame: timeFrame, user_id: userId || null, from_date: fromDate || null, to_date: toDate || null });

/* ---- owner dashboard ---- */
export const CERTIFIED_PATH = "/kpi_owner/certified_by_client";
export const fetchCertifiedByClient = () => read(CERTIFIED_PATH, {}, { ttl: 30000, timeout: 60000 });
export const fetchClientCertifiedTasks = (clientKraId) => rpc("/kpi_owner/client_certified_tasks", { client_kra_id: Number(clientKraId) }, { timeout: 60000 });
export const createInvoice = ({ clientKraId, subKraIds = [], fromDate, toDate }) =>
  rpc("/kpi_client_invoice/create", { client_kra_id: Number(clientKraId), from_date: fromDate || "2000-01-01", to_date: toDate || "2099-12-31", filter_sub_kra_ids: (subKraIds || []).map(Number) }, { timeout: 60000 });

/* ---- Dashboard (the CEO's page): every count beside Live Tracking and
   Client Billing in one read — completed per day, task pipeline, approvals by
   age, paused, clients, billing, meetings, reminders, documents, WhatsApp,
   hours and per-person task counts. NEW on 19.0.6.9. ---- */
export const DASHBOARD_PATH = "/kra_kpi/dashboard/overview";

/* ---- client task queue ---- */
export const QUEUE_PATH = "/kpi_pending_queue/list";
export const fetchQueue = () => read(QUEUE_PATH, {}, { ttl: 10000, timeout: 45000 });
export const saveQueueTask = (t) => rpc("/kpi_pending_queue/update", {
  kpi_id: t.id, name: t.name || "", description: t.description || "", external_ref: t.external_ref || "", related_req_ref: t.related_req_ref || "",
  priority: t.priority || "regular", estimate_hours: Number(t.estimate_hours) || 0, estimate_minutes: Number(t.estimate_minutes) || 0,
  user_id: t.user_id ? Number(t.user_id) : false, deliverable_type: t.deliverable_type || "",
}, { timeout: 45000 });
export const publishQueueTask = (kpiId) => rpc("/kpi_pending_queue/publish", { kpi_id: kpiId }, { timeout: 45000 });
export const discardQueueTask = (kpiId, reason) => rpc("/kpi_pending_queue/delete", { kpi_id: kpiId, reason: reason || "" }, { timeout: 45000 });
/* Decline (archive, reason kept) or re-type (new REQ / UPT / BUG ref, back in
   the queue) a client submission. The client is told in their WhatsApp group;
   `warning` in the answer means no group is linked, so nobody was told.
   mode 'decline' | 'reclassify'; reasons depend on the mode. */
export const fetchDeclineReasons = (mode) => rpc("/kpi_pending_queue/decline_reasons", { mode }).then((r) => assertOk(r, "Could not load the reasons.").reasons || []);
export const declineQueueTask = (kpiId, { mode, reasonId, reasonText, docType }) => rpc("/kpi_pending_queue/decline", {
  kpi_id: Number(kpiId), mode: mode || "decline", reason_id: reasonId ? Number(reasonId) : false, reason_text: reasonText || "", doc_type: docType || false,
}, { timeout: 45000 });

/* ---- client sign-off (client approves the finished work) ----
   The pre-approval list/decide routes (/kpi_pre_approval/*) are the client's
   own and refuse admins: see lib/services/portal.js. Admins follow
   pre-approvals through /kpi_task_approval/* (Settings › Pre-approvals). */
export const submitClientSignoff = (kpiId, { signatureText, notes } = {}) =>
  rpc("/kpi_client_approval/approve", { kpi_id: kpiId, signature_text: (signatureText || "").trim(), chk_delivered: true, chk_works: true, chk_authorized: true, notes: notes || "" });
export const submitClientRejection = (kpiId, reason) => rpc("/kpi_client_approval/reject", { kpi_id: kpiId, reason: (reason || "").trim() });

/* ---- uploads / intake (/kpi_requirements/*) ---- */
export const REF_PREFIX = { requirement: "REQ", update: "UPT", bug: "BUG" };
export const DOC_TYPES = [{ key: "requirement", label: "Requirements" }, { key: "update", label: "Updates" }, { key: "bug", label: "Bug reports" }];
export const getClients = () => read("/kpi_client_invoice/get_filters", {}, { ttl: 60000 }).then((r) => r?.clients || []);
export const getSubKras = (clientKraId) => read("/kpi_completion_cert/get_sub_kras", { client_kra_id: clientKraId }, { ttl: 60000 }).then((r) => r?.kras || []);
/* People a task can be assigned to (developers and admins; never clients,
   portal accounts or OdooBot). /kra_kpi/get_users answers a bare list
   [{id, name}]; {users} is accepted too. */
export const getIntakeUsers = () => read("/kra_kpi/get_users", {}, { ttl: 300000 }).then((r) => (Array.isArray(r) ? r : r?.users || []));
export const peekNextRef = (docType) => rpc("/kpi_requirements/peek_next_ref", { doc_type: docType }).then((r) => (r?.status === false ? { prefix: REF_PREFIX[docType] || "REQ", next_number: 1 } : r));
/* 369 AI Assistant (Dashboard): a question about the team's work, answered from
   live data by rules on the server; with an AI key the AI also answers what the
   rules don't know and reads the chat so far (chat_id). `context` is the
   previous answer's filters, for follow-ups like "and last week?". The wait
   covers the AI providers being tried in turn (the proxy allows 100 s). */
export const askAssistant = ({ question, period, context, chatId }) =>
  rpc("/kra_kpi/ai_assistant/ask", { question: String(question || "").slice(0, 1000), period, context: context || {}, chat_id: chatId || null }, { timeout: 105000 });
/* The same answer with every table row (the drawer shows 50), for a PDF / Word
   download. Not saved to the chat. */
export const exportAssistantAnswer = ({ question, period, context }) =>
  rpc("/kra_kpi/ai_assistant/export", { question: String(question || "").slice(0, 1000), period, context: context || {} }, { timeout: 105000 })
    .then((r) => assertOk(r, "Could not prepare the download."));
/* "Find a task" in the assistant: tasks by name or reference, any state
   (recently updated ones for an empty query). */
export const findAssistantTasks = (query) => rpc("/kra_kpi/ai_assistant/find_tasks", { query: String(query || "").slice(0, 100), limit: 8 }).then((r) => assertOk(r, "Could not search tasks.").tasks || []);
/* Saved chats (one per conversation, the caller's own): list, open, delete. */
export const listAssistantChats = () => rpc("/kra_kpi/ai_assistant/chats", { limit: 100 }).then((r) => assertOk(r, "Could not load your chats.").chats || []);
export const getAssistantChat = (chatId) => rpc("/kra_kpi/ai_assistant/chat", { chat_id: Number(chatId) }).then((r) => assertOk(r, "Could not open that chat."));
export const deleteAssistantChat = (chatId) => rpc("/kra_kpi/ai_assistant/chat_delete", { chat_id: Number(chatId) }).then((r) => assertOk(r, "Could not delete that chat."));
export const suggestTasks = (text, docType) => rpc("/kpi_requirements/suggest_tasks", { text: String(text || "").slice(0, 16000), doc_type: docType }, { timeout: 90000 });
export const parseFile = ({ fileData, fileName, docType }) => rpc("/kpi_requirements/parse_file", { file_data: fileData, file_name: fileName, doc_type: docType }, { timeout: 60000 });
/* `deliverableType` is the batch default: a row left blank takes it on the server.
   The answer carries kpi_ids in the order of `tasks`. */
export const createBulkTasks = ({ subKraId, docType, tasks, fileData, fileName, requirementVersion, deliverableType }) =>
  rpc("/kpi_requirements/create_bulk_tasks", { sub_kra_id: subKraId, doc_type: docType, tasks, deliverable_type: deliverableType || "", file_data: fileData || "", file_name: fileName || "", requirement_version: requirementVersion || "" }, { timeout: 90000 });
export const buildTaskRow = (row) => ({
  name: (row.name || "").trim(), external_ref: row.external_ref || "", related_req_ref: row.related_req_ref || "", description: row.description || "",
  estimate_hours: Number(row.estimate_hours) || 0, estimate_minutes: Number(row.estimate_minutes) || 0, priority: row.priority || "regular",
  primary_user_id: row.primary_user_id ? Number(row.primary_user_id) : false, deliverable_type: row.deliverable_type || "",
});
/* The blank XLSX template and the client-files ZIP are type='http' GETs: plain links through the proxy. */
const TEMPLATE_NAME = { requirement: "requirement", update: "update", bug: "bug_report" };
export const templateHref = (docType) => href(`/kpi_completion_cert/template/${TEMPLATE_NAME[docType] || "requirement"}`);
export const clientZipHref = (q) => href(`/kpi_client_workspace/generate_zip?${new URLSearchParams(Object.fromEntries(Object.entries(q).filter(([, v]) => v != null && v !== ""))).toString()}`);

/* ---- attendance (separate bridge module; may be absent) ---- */
export const fetchAttendanceStatus = () => read("/kpi_attendance/status", {}, { ttl: 30000 });
export const fetchMyAttendance = (days = 30) => read("/kpi_attendance/mine", { days }, { ttl: 60000 });
export const fetchTeamAttendance = (dateStr) => read("/kpi_attendance/team", dateStr ? { date: dateStr } : {}, { ttl: 30000 });

/* ---- file → base64 ---- */
export const fileToBase64 = (file) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1] || ""); fr.onerror = rej; fr.readAsDataURL(file); });
export const humanSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);

export { assertOk };
