/* Reports + invoices services (ports of kraReport.js, workReport.js,
   dailyReports.js, reassignmentHistory.js, clientInvoices.js). */
import { rpc, read, href, callKw, assertOk, invalidate } from "@/lib/api";

/* ---- downloads: base64 → file ---- */
export function downloadB64(b64, fileName, mimetype = "application/octet-stream") {
  const bytes = atob(b64); const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([arr], { type: mimetype }));
  const a = document.createElement("a"); a.href = url; a.download = fileName || "download"; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function downloadText(text, fileName, mimetype = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob(["﻿" + text], { type: mimetype }));
  const a = document.createElement("a"); a.href = url; a.download = fileName; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export const csv = (rows, cols) => [cols.map((c) => c.label).join(","), ...rows.map((r) => cols.map((c) => { const v = typeof c.get === "function" ? c.get(r) : r[c.key]; const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(","))].join("\n");

/* ---- KRA report ---- */
export const KRA_FILTERS_PATH = "/kpi_reports/kra/get_filters";
export const fetchKraFilters = () => read(KRA_FILTERS_PATH, {}, { ttl: 60000 });
/* Id filters travel as real lists (the server's _id_list drops "1,2" as junk);
   types/states as lists too, which _csv_param joins. */
export const kraParams = ({ from, to, employees = [], kras = [], excludedKras = [], types = [], states = [] }) => ({
  /* time_frame: false — "custom" is not one of kpi.kra.report's selection values. */
  from_date: from, to_date: to, time_frame: false,
  employee_ids: employees.map(Number), kra_ids: kras.map(Number), excluded_kra_ids: excludedKras.map(Number),
  task_types: [...types], task_states: [...states],
});
export const generateKraReport = (params) => rpc("/kpi_reports/kra/generate", params, { timeout: 90000 });
export const kraFilterCounts = (params) => rpc("/kpi_reports/kra/filter_counts", params).catch(() => null);
export const fetchKraDownloads = (limit = 50) => rpc("/kpi_reports/kra/download_list", { limit });
export const fetchKraDownload = (id) => rpc("/kpi_reports/kra/download_file", { id: Number(id) }, { timeout: 60000 });
export const saveKraDownload = (p) => rpc("/kpi_reports/kra/download_save", p, { timeout: 60000 });
export const deleteKraDownload = (id) => rpc("/kpi_reports/kra/download_delete", { id: Number(id) });
/* { is_admin, user_id, saved_state } — saved_state is the JSON string state_set stored. */
export const fetchKraContext = () => rpc("/kpi_reports/kra/context", {}).catch(() => null);
export const setKraState = (state) => rpc("/kpi_reports/kra/state_set", { state: state || "" }).catch(() => null);
/* KRA report "New Task": the duplicate-name hint, the ORM create the Create KPI
   screen uses, and the back-filled worked time (log_manual_time writes both the
   task's timer and a time log, so the row shows its hours and its date). */
export const kpiNameMatches = (name, kraId) => rpc("/kra_kpi/kpi/name_matches", { name: name || "", kra_id: Number(kraId) }).then((r) => r?.matches || []).catch(() => []);
export const createKpiOrm = (vals) => callKw("kra.kpi", "create_kpi", [vals]);
export const logManualTime = (kpiId, seconds, userId) => callKw("kra.kpi", "log_manual_time", [Number(kpiId), Number(seconds) || 0, userId ? Number(userId) : false, false]);
/* Rename a person everywhere (res.users name). Admin-only on the server. */
export const renameUser = (userId, name) => rpc("/kpi_user_access/update", { user_id: Number(userId), name: (name || "").trim() });
/* download_file answers {filename, kind, data_b64} with no mimetype. */
export const kraDownloadMime = (fileName = "") => (/\.pdf$/i.test(fileName) ? "application/pdf" : /\.zip$/i.test(fileName) ? "application/zip" : /\.csv$/i.test(fileName) ? "text/csv" : /\.xlsx$/i.test(fileName) ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/octet-stream");
/* UTF-8 text (with BOM, as downloadText writes it) → base64, for download_save. */
export const textToB64 = (text) => { const bytes = new TextEncoder().encode("\uFEFF" + text); let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); };

/* ---- staff list (the OWL report screens read res.users with share=False) ---- */
export const fetchStaff = () => callKw("res.users", "search_read", [[["share", "=", false]], ["id", "name"]], { order: "name" }).then((r) => (Array.isArray(r) ? r : []));

/* ---- unit report ---- */
export const generateUnitReport = ({ from, to, employeeId }) => rpc("/kpi_reports/unit/generate", { from_date: from, to_date: to, employee_id: employeeId ? Number(employeeId) : null, time_frame: null }, { timeout: 90000 });
export const fetchUnitEmployeeTasks = ({ employeeId, from, to }) => rpc("/kpi_reports/unit/employee_tasks", { employee_id: Number(employeeId), from_date: from, to_date: to });

/* ---- performance report (reads the Employee Salary Master) ---- */
export const generatePerformance = ({ from, to, employeeId }) => rpc("/kpi_reports/performance/generate_direct", { from_date: from, to_date: to, employee_id: employeeId ? Number(employeeId) : null }, { timeout: 90000 });
export const fetchPerformanceDetail = ({ employeeId, from, to }) => rpc("/kpi_reports/performance/employee_detail", { employee_id: Number(employeeId), from_date: from, to_date: to });

/* Employee Salary Master: kpi.employee.salary.config, one row per user
   (unique). available_hours / available_units / unit_cost are computed+stored. */
const SAL = "kpi.employee.salary.config";
const SAL_FIELDS = ["employee_id", "salary", "working_days", "attendance_hours_per_day", "available_hours", "available_units", "unit_cost", "last_updated"];
export const fetchSalaryConfigs = () => callKw(SAL, "search_read", [[], SAL_FIELDS], { order: "employee_id" }).then((r) => (Array.isArray(r) ? r : []));
export async function saveSalaryConfig({ id, employee_id, salary, working_days, attendance_hours_per_day }) {
  const vals = { salary: Number(salary) || 0, working_days: parseInt(working_days, 10) || 0, attendance_hours_per_day: Number(attendance_hours_per_day) || 0, last_updated: new Date().toISOString().slice(0, 19).replace("T", " ") };
  if (id) { await callKw(SAL, "write", [[Number(id)], vals]); return Number(id); }
  return callKw(SAL, "create", [{ ...vals, employee_id: Number(employee_id) }]);
}
export const deleteSalaryConfig = (id) => callKw(SAL, "unlink", [[Number(id)]]);

/* ---- attention report (paused tasks that carry a reason) ---- */
export const generateAttention = ({ from, to, employeeId }) => rpc("/kpi_reports/attention/generate", { employee_id: employeeId ? Number(employeeId) : null, from_date: from || null, to_date: to || null }, { timeout: 90000 });

/* ---- KRA employee report ---- */
/* time_frame must be one of kpi.employee.report's selection values, or empty. */
export const EMP_TIME_FRAMES = ["today", "yesterday", "last_week", "last_month", "last_year"];
const empParams = ({ from, to, employeeId, timeFrame }) => ({ from_date: from, to_date: to, employee_ids: employeeId ? [Number(employeeId)] : [], time_frame: EMP_TIME_FRAMES.includes(timeFrame) ? timeFrame : null });
export const fetchEmployeeReportEmployees = () => read("/kpi_reports/employee/get_employees", {}, { ttl: 60000 }).then((r) => r?.employees || []);
export const generateEmployeeReport = (p) => rpc("/kpi_reports/employee/generate", empParams(p), { timeout: 90000 });
export const employeeReportPdfData = (p) => rpc("/kpi_reports/employee/pdf_data", empParams(p), { timeout: 90000 });
export const fetchEmployeeTaskDetails = ({ taskId, from, to }) => rpc("/kpi_reports/employee/task_details", { task_id: Number(taskId), from_date: from, to_date: to });

/* Date presets the OWL report screens offer (local dates, not UTC). */
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/* Local YYYY-MM-DD (toISOString would shift to the UTC date). */
export const ymd = iso;
export function presetRange(key) {
  const t = new Date();
  if (key === "today") return [iso(t), iso(t)];
  if (key === "yesterday") { const y = new Date(t); y.setDate(t.getDate() - 1); return [iso(y), iso(y)]; }
  if (key === "last_week") { const dow = t.getDay(); const diff = dow === 0 ? 6 : dow - 1; const mon = new Date(t); mon.setDate(t.getDate() - diff - 7); const sun = new Date(mon); sun.setDate(mon.getDate() + 6); return [iso(mon), iso(sun)]; }
  if (key === "this_month") return [iso(new Date(t.getFullYear(), t.getMonth(), 1)), iso(t)];
  if (key === "last_month") return [iso(new Date(t.getFullYear(), t.getMonth() - 1, 1)), iso(new Date(t.getFullYear(), t.getMonth(), 0))];
  if (key === "last_year") return [iso(new Date(t.getFullYear() - 1, 0, 1)), iso(new Date(t.getFullYear() - 1, 11, 31))];
  return null;
}
/* 26.5 → "3d 2h 30m" (8-hour days), as the unit report prints its totals. */
export const dhm = (hours) => { const mins = Math.round((hours || 0) * 60); const d = Math.floor(mins / 480), h = Math.floor((mins % 480) / 60), m = mins % 60; return `${d}d ${h}h ${m}m`; };
export const hmFromHours = (hours) => { const mins = Math.round((hours || 0) * 60); return `${Math.floor(mins / 60)}h ${mins % 60}m`; };

/* ---- work report ---- */
export const fetchWorkReportClients = () => read("/kpi_reports/period_work/clients", {}, { ttl: 60000 }).then((r) => r?.clients || []);
export const WORK_PATH = "/kpi_reports/period_work/generate";
export const workReportPdf = (params) => rpc("/kpi_reports/period_work/pdf", params, { timeout: 90000 });

/* ---- daily reports ---- */
export const DAILY_PATH = "/kpi_daily_report/list";
export const dailyViewHref = (id) => href(`/kpi_daily_report/view/${id}`);
export const dailyDownloadHref = (id) => href(`/kpi_daily_report/download/${id}`);
/* The form view's "Generate Yesterday's Report" (kpi.daily.report.action_generate_now).
   It raises a UserError when nobody worked yesterday; call_kw turns that into an error. */
export const generateDailyNow = () => callKw("kpi.daily.report", "action_generate_now", [[]], {}).then(() => invalidate(DAILY_PATH));

/* ---- reassignment history ---- */
export const REASSIGN_PATH = "/kra_kpi/reassignment_history/all";

/* ---- invoices (admin) ---- */
export const INV_LIST = "/kpi_client_invoice/list";
export const fetchInvoice = (id) => rpc("/kpi_client_invoice/get", { invoice_id: Number(id) }).then((r) => (r?.status ? r.data : null));
export const fetchInvoiceFilters = () => read("/kpi_client_invoice/get_filters", {}, { ttl: 60000 });
export const fetchCurrencies = () => read("/kpi_client_invoice/get_currencies", {}, { ttl: 300000 }).then((r) => r?.currencies || []);
export const fetchSubKrasForClient = (clientKraId) => rpc("/kpi_client_invoice/get_sub_kras_for_client", { client_kra_id: Number(clientKraId) }).then((r) => r?.sub_kras || []);
/* { users:[{id,name}], kpis:[{id,name,kra_name,billable,not_billable_reason,not_billable_code,task_type}] } */
export const fetchClientUsersAndKpis = (clientKraId, subKraIds = []) => rpc("/kpi_client_invoice/get_client_users_and_kpis", { client_kra_id: Number(clientKraId), sub_kra_ids: subKraIds.map(Number) });
export const createInvoice = (p) => rpc("/kpi_client_invoice/create", p, { timeout: 60000 });
export const saveInvoiceHeader = (p) => rpc("/kpi_client_invoice/save_header", p);
export const saveInvoiceLine = (p) => rpc("/kpi_client_invoice/save_line", p);
export const addAdjustment = (p) => rpc("/kpi_client_invoice/add_adjustment", p);
export const removeInvoiceLine = (lineId) => rpc("/kpi_client_invoice/remove_line", { line_id: Number(lineId) });
export const saveInvoiceNotes = (id, notes) => rpc("/kpi_client_invoice/save_notes", { invoice_id: Number(id), notes });
export const finalizeInvoice = (id) => rpc("/kpi_client_invoice/finalize", { invoice_id: Number(id) });
export const sendInvoice = (id) => rpc("/kpi_client_invoice/send", { invoice_id: Number(id) }, { timeout: 60000 });
export const resetInvoiceDraft = (id) => rpc("/kpi_client_invoice/reset_draft", { invoice_id: Number(id) });
export const reviseInvoice = (id, reason) => rpc("/kpi_client_invoice/revise", { invoice_id: Number(id), reason });
export const deleteInvoice = (id) => rpc("/kpi_client_invoice/delete", { invoice_id: Number(id) });
export const markInvoicePaid = (id, paid, note, method) => rpc("/kpi_client_invoice/mark_paid", { invoice_id: Number(id), paid, note: note || "", method: method || "" });
export const clearPaidClaim = (id) => rpc("/kpi_client_invoice/clear_paid_claim", { invoice_id: Number(id) });
/* Fallback for servers whose /get does not carry the currency yet: read the
   field directly → {id, name} | null. */
export const fetchInvoiceCurrency = (id) => callKw("kpi.client.invoice", "read", [[Number(id)], ["currency_id"]]).then((r) => { const c = Array.isArray(r) ? r[0]?.currency_id : null; return Array.isArray(c) ? { id: c[0], name: c[1] } : null; }).catch(() => null);
/* Server-built PDF (reportlab), record-rule scoped so a client gets only their own. */
export const invoicePdf = (id) => rpc("/kpi_client_invoice/pdf", { invoice_id: Number(id) }, { timeout: 90000 });
export async function downloadInvoicePdf(id) {
  const r = assertOk(await invoicePdf(id), "Could not build the PDF.");
  downloadB64(r.data_b64, r.file_name || `Invoice_${id}.pdf`, r.mimetype || "application/pdf");
  return r;
}
export const invoicePdfData = (id) => rpc("/kpi_client_invoice/pdf_data", { invoice_id: Number(id) }, { timeout: 60000 });
export const invalidateInvoices = () => invalidate("/kpi_client_invoice");
/* /create's empty_reasons arrive only in its own answer; the detail page reads them
   back from sessionStorage under this key. */
export const invoiceEmptyKey = (id) => `kpi-invoice-empty-${id}`;
export const PAYMENT_METHODS = [["bank_transfer", "Bank transfer"], ["cash", "Cash"], ["cheque", "Cheque"], ["card", "Card"], ["other", "Other"]];
export const money = (n, sym = "₹") => `${sym} ${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
/* The invoice's currency symbol, when the server sends it (currency_symbol on
   list rows and /get); "" when it does not, so callers can fall back. */
export const invSymbol = (inv, fallback = "₹") => inv?.currency_symbol || fallback;
/* The invoice's currency as {id, name} from the serialized payload, accepting
   an id, an [id, name] pair or an {id, name} object; null when absent. */
export const invCurrency = (inv) => {
  const c = inv?.currency_id;
  if (Array.isArray(c) && c[0]) return { id: c[0], name: c[1] || inv.currency_name || "" };
  if (c && typeof c === "object" && c.id) return { id: c.id, name: c.name || inv.currency_name || "" };
  if (typeof c === "number" && c) return { id: c, name: inv.currency_name || "" };
  return null;
};
/* A line's rate and amount, as _compute_totals bills them: per_task lines carry
   a flat unit_price; hourly lines are quoted_hours × the invoice's hourly_rate
   (their unit_price stays 0). */
export const lineRate = (l, inv) => (inv?.billing_method === "per_task" ? Number(l?.unit_price) || 0 : Number(inv?.hourly_rate) || 0);
export const lineAmount = (l, inv) => (inv?.billing_method === "per_task" ? Number(l?.unit_price) || 0 : (Number(l?.quoted_hours) || 0) * (Number(inv?.hourly_rate) || 0));
export const invTone = (inv) => (inv.payment_status === "paid" ? "done" : inv.client_paid_claim ? "review" : inv.state === "sent" ? "progress" : inv.state === "finalized" ? "progress" : "todo");
export const invLabel = (inv) => (inv.payment_status === "paid" ? "Paid" : inv.client_paid_claim ? "Claimed paid" : inv.state === "sent" ? "Sent" : inv.state === "finalized" ? "Finalized" : inv.state === "draft" ? "Draft" : inv.state);

export { assertOk };
