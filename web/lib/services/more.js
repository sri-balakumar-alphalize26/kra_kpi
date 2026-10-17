/* Ports of the mobile services for the developer tools:
   notifications, task documents, my workday, workday snapshots, user manual,
   reminders. Same routes and params as the app. */
import { useEffect, useState } from "react";
import { rpc, read, callKw, assertOk } from "@/lib/api";

/* ---- notifications (/kpi_notifications/*) ---- */
export const NOTIF_PATH = "/kpi_notifications/get";
export async function fetchNotifications({ limit = 50, offset = 0, onlyUnread = false, fresh = false } = {}) {
  const res = await read(NOTIF_PATH, { limit, offset, only_unread: onlyUnread }, { fresh, ttl: 10000 });
  return { items: res?.items || [], unreadCount: res?.unread_count || 0, isAdmin: !!res?.is_admin };
}
export async function markRead(ids) {
  const res = await rpc("/kpi_notifications/mark_read", ids && ids.length ? { ids } : {});
  return { unreadCount: res?.unread_count || 0 };
}

/* Icon + colour per event (the app's EVENT_ICON), on our icon set. */
export const EVENT_META = {
  urgent_pause: ["warn", "#DC2626"],
  client_task_queued: ["inbox", "#D97706"], internal_approved: ["check", "#D97706"], pre_approval_request: ["clock", "#D97706"],
  pre_approval_reminder: ["bell", "#D97706"], partial_timeout: ["clock", "#D97706"], complete: ["check", "#D97706"],
  dev_no_task: ["user", "#D97706"], invoice_client_paid: ["cash", "#D97706"],
  internal_rejected: ["swap", "#EA580C"], client_task_rejected: ["x", "#EA580C"], self_task_rejected: ["x", "#EA580C"], task_reverted: ["swap", "#EA580C"],
  final_approved: ["check", "#16A34A"], self_task_accepted: ["check", "#16A34A"], invoice_paid: ["cash", "#16A34A"],
  pre_approval_decided: ["flag", "#7C3AED"], pre_approval_decided_late: ["clock", "#7C3AED"], pre_approval_held: ["pause", "#7C3AED"],
  admin_accept_auto: ["check", "#7C3AED"], pre_approval_auto_released: ["check", "#7C3AED"], pre_approval_window_closed: ["x", "#7C3AED"], reassigned: ["swap", "#7C3AED"],
  task_created: ["plus", "#2563EB"], task_assigned: ["inbox", "#1E40AF"], task_reassigned: ["swap", "#64748B"], self_task_submitted: ["inbox", "#0891B2"], invoice_ready: ["cash", "#2563EB"],
  workday_auto_closed: ["clock", "#64748B"], workday_started: ["play", "#64748B"], workday_reverted: ["cal", "#64748B"], dev_idle_check: ["clock", "#64748B"],
  daily_report: ["doc", "#4338CA"], daily_summary: ["doc", "#4338CA"],
  admin_nudge: ["flag", "#DC2626"],
};
export function eventMeta(ev) { return EVENT_META[ev] || ["bell", "#6B7280"]; }

/* Where a notification goes when clicked (the app's routeTo* in App.js). */
export function notificationHref(n, role) {
  if (n.invoice_id) return role === "client" ? `/portal/invoices/${n.invoice_id}` : `/reports/invoices/${n.invoice_id}`;
  if (n.report_id) return `/reports/daily?open=${n.report_id}`;
  if (n.snapshot_id) return `/reports/snapshots?focus=${n.snapshot_id}`;
  if (n.kpi_id) return role === "client" ? `/portal/requests?focus=${n.kpi_id}` : `/board?task=${n.kpi_id}`;
  return null;
}

/* ---- task documents (/task_documents/*) ---- */
export const DOCS_PATH = "/task_documents/list";
export const fetchTaskDocuments = (assigneeId) => read(DOCS_PATH, assigneeId ? { assignee_id: assigneeId } : {});
export const fetchTaskDocumentDetails = (taskId) => rpc("/task_documents/details", { task_id: taskId });

/* ---- my workday (/kpi_reports/my_workday) ---- */
export const WORKDAY_REPORT_PATH = "/kpi_reports/my_workday";
export function fetchMyWorkday(fromDate, toDate) {
  const params = {};
  if (fromDate) params.from_date = fromDate;
  if (toDate) params.to_date = toDate;
  return read(WORKDAY_REPORT_PATH, params, { ttl: 30000 });
}

/* ---- workday snapshots (/kpi_workday_snapshot/*) ---- */
export const fetchSnapshots = (limitDays = 30) => read("/kpi_workday_snapshot/list", { limit_days: limitDays }, { ttl: 60000 });
export const fetchMySnapshots = (limitDays = 30) => read("/kpi_workday_snapshot/my_list", { limit_days: limitDays }, { ttl: 60000 });
export const fetchSnapshotImage = (id) => rpc("/kpi_workday_snapshot/image_b64", { snapshot_id: id });
export const fetchMySnapshotImage = (id) => rpc("/kpi_workday_snapshot/my_image_b64", { snapshot_id: id });
export function snapshotDataUrl(res) {
  /* Odoo's image_b64 / my_image_b64 return { data_b64, mimetype, file_name }. */
  const b64 = res?.data_b64 || "";
  return b64 ? `data:${res.mimetype || "image/png"};base64,${b64}` : "";
}

/* ---- user manual (app.user.manual via ORM) ---- */
const MANUAL = "app.user.manual";
export async function fetchManualBundle() {
  try {
    const res = await callKw(MANUAL, "app_bundle", []);
    return { status: true, canEdit: !!res?.can_edit, role: res?.role || "developer", manuals: Array.isArray(res?.manuals) ? res.manuals : [] };
  } catch (e) {
    return { status: false, notInstalled: true, message: e?.message || "Unavailable" };
  }
}
export async function fetchManualData(id) {
  const res = await callKw(MANUAL, "get_manual", [Number(id)]);
  if (!res) return { status: false, message: "Not available" };
  return { status: true, id: res.id, name: res.name, filename: res.filename, data: res.data };
}
export async function saveManual({ id, name, filename, base64, role, sequence }) {
  const vals = {};
  if (name != null) vals.name = name;
  if (role != null) vals.role = role;
  if (sequence != null) vals.sequence = sequence;
  if (base64) { vals.pdf_file = base64; vals.pdf_filename = filename || (name ? `${name}.pdf` : "manual.pdf"); }
  else if (filename != null) vals.pdf_filename = filename;
  if (id) { await callKw(MANUAL, "write", [[Number(id)], vals]); return { status: true, id: Number(id) }; }
  const newId = await callKw(MANUAL, "create", [vals]);
  return { status: true, id: newId };
}
export async function deleteManual(id) { await callKw(MANUAL, "unlink", [[Number(id)]]); return { status: true }; }

/* ---- reminders (kpi.reminder via ORM) ---- */
const REM = "kpi.reminder";
const REM_FIELDS = ["name", "remind_date", "remind_time", "enabled", "repeat", "next_trigger", "kra_id", "client_kra_id", "completion_count"];
export const REPEATS = [["none", "Once"], ["daily", "Daily"], ["weekly", "Weekly"]];
export async function fetchReminders() {
  try {
    const rows = await callKw(REM, "search_read", [[], REM_FIELDS], { order: "next_trigger asc, id desc" });
    return { status: true, reminders: Array.isArray(rows) ? rows : [] };
  } catch (e) {
    return { status: false, notInstalled: true, message: e?.message || "Unavailable" };
  }
}
export async function saveReminder({ id, name, remind_date, remind_time, enabled, repeat, kra_id }) {
  const vals = {};
  if (name != null) vals.name = name;
  if (remind_date != null) vals.remind_date = remind_date;
  if (remind_time != null) vals.remind_time = remind_time;
  if (enabled != null) vals.enabled = !!enabled;
  if (repeat != null) vals.repeat = repeat;
  if (kra_id !== undefined) vals.kra_id = kra_id ? Number(kra_id) : false;
  if (id) { await callKw(REM, "write", [[Number(id)], vals]); return { status: true, id: Number(id) }; }
  const newId = await callKw(REM, "create", [vals]);
  return { status: true, id: newId };
}
export const completeReminder = (id) => callKw(REM, "action_complete", [[Number(id)]]).then(() => ({ status: true }));
export const deleteReminder = (id) => callKw(REM, "unlink", [[Number(id)]]).then(() => ({ status: true }));
/* kpi.reminder.completion rows: name_snapshot, time_snapshot (Odoo's "Was Due"),
   completed_by, completed_at, reminder_id. With reminderId: that reminder's own
   history (the domain of Odoo's action_view_history); without: every completion. */
export async function fetchReminderHistory(limit = 100, reminderId = null) {
  try {
    const domain = reminderId ? [["reminder_id", "=", Number(reminderId)]] : [];
    const rows = await callKw("kpi.reminder.completion", "search_read", [domain, ["name_snapshot", "time_snapshot", "completed_by", "completed_at", "reminder_id"]], { order: "completed_at desc, id desc", limit });
    return { status: true, rows: Array.isArray(rows) ? rows : [] };
  } catch (e) { return { status: false, rows: [], message: e?.message || "Unavailable" }; }
}
/* 14.5 → "14:30" and back. */
export const floatToTime = (f) => { const h = Math.floor(f || 0), m = Math.round(((f || 0) - h) * 60); return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`; };
export const timeToFloat = (s) => { const [h, m] = String(s || "0:0").split(":").map(Number); return (h || 0) + (m || 0) / 60; };

/* ---- profile ---- */
export const setAppPassword = (newPassword) => rpc("/kpi_app/set_password", { new_password: newPassword });
/* Profile photo, stored on the user in Odoo. image_1920 is in res.users
   SELF_WRITEABLE_FIELDS (Odoo 19), so any user may set their own; Odoo derives
   avatar_128 from it, which /web/image serves through our proxy.
   Odoo gives every internal user without a photo a generated initials SVG
   (_avatar_generate_svg). That is not a photo: it counts as none, so our own
   coloured initials show instead. */
const isGeneratedAvatar = (b64) => /^(PD94|PHN2Zy)/.test(b64 || ""); /* "<?xml" / "<svg" */
export async function fetchMyPhoto(uid) {
  try {
    const rows = await callKw("res.users", "read", [[Number(uid)], ["image_128", "write_date"]]);
    const r = Array.isArray(rows) ? rows[0] : null;
    return { has: !!r?.image_128 && !isGeneratedAvatar(r.image_128), version: r?.write_date || "" };
  } catch (e) { return { has: false, version: "", error: e }; }
}
export const myPhotoUrl = (uid, version) => `/web/image/res.users/${uid}/avatar_128${version ? `?unique=${encodeURIComponent(version)}` : ""}`;
/* b64: raw base64 (no data: prefix), or false to remove the photo. */
export const saveMyPhoto = (uid, b64) => callKw("res.users", "write", [[Number(uid)], { image_1920: b64 || false }]);
/* Fired after a save / remove, so every avatar of "me" (top bar, Profile) reloads. */
export const PHOTO_EVENT = "kpi:photo";
/* My photo's URL, or null for initials. Follows PHOTO_EVENT. */
export function useMyPhoto(uid) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    if (!uid) return undefined;
    let live = true;
    const load = () => fetchMyPhoto(uid).then((p) => { if (live) setSrc(p.has ? myPhotoUrl(uid, p.version) : null); });
    load();
    window.addEventListener(PHOTO_EVENT, load);
    return () => { live = false; window.removeEventListener(PHOTO_EVENT, load); };
  }, [uid]);
  return src;
}
export const fetchAttendanceMine = () => read("/kpi_attendance/mine", {}, { ttl: 60000 }).catch(() => ({ status: false, notInstalled: true }));

export { assertOk };
