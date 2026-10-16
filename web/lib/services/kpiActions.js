/* KPI Action Board data service — a port of the mobile app's
   services/kpiActions.js onto the web proxy. Same route names, same params,
   same task shape (/kra_kpi/tasks/get map_rec), so the two boards agree.
   Mock mode and getConnection() are gone: the server is always configured. */
import { rpc, read, callKw, assertOk, upload } from "@/lib/api";
import { createLogger } from "@/lib/log";

const log = createLogger("ActionBoard");

/* ---- KRA tree (clients → projects) --------------------------------------- */
export async function getKraTree() {
  const result = await callKw("kra.master", "get_kra_tree");
  return { tree: result || [] };
}

/* Two-step Client → Project source for "+ Create": clients (is_client roots),
   each with its flattened descendant projects [{id, display}].
   Reads /kra_kpi/get_kra_list with with_tasks:false (children under
   `children`), cached 5 minutes. get_kra_tree serialised every task in the
   system just to fill two dropdowns (Odoo commit 649180c did the same). */
export async function fetchClientTree() {
  const res = await read("/kra_kpi/get_kra_list", { with_tasks: false }, { ttl: 5 * 60 * 1000 });
  const tree = res?.tree || [];
  const clients = [];
  const collect = (node) => {
    const projects = [];
    const walk = (nodes, prefix) => {
      for (const n of nodes || []) {
        const path = prefix ? `${prefix} › ${n.name}` : n.name;
        projects.push({ id: n.id, display: path });
        walk(n.children, path);
      }
    };
    walk(node.children, "");
    if (projects.length === 0) projects.push({ id: node.id, display: node.name });
    return projects;
  };
  for (const root of tree || []) {
    if (root.is_client) clients.push({ id: root.id, name: root.name, projects: collect(root) });
  }
  return clients;
}

/* ---- "Fresh" (red card) rule ---------------------------------------------- */
export const FRESH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/* 'YYYY-MM-DD HH:MM:SS' or ISO '...Z' (both UTC) → ms. */
export function parseServerTs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || "");
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}
export function isWithinFreshWindow(task, nowMs) {
  const created = parseServerTs(task && task.create_date);
  if (created == null) return true;
  return (nowMs - created) < FRESH_MAX_AGE_MS;
}

/* ---- search ----------------------------------------------------------------- */
export function normalizeRef(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
export function taskMatchesQuery(t, rawQuery) {
  const q = String(rawQuery || "").trim().toLowerCase();
  if (!q) return true;
  if ((t.name || "").toLowerCase().includes(q)) return true;
  if ((t.user_name || "").toLowerCase().includes(q)) return true;
  if ((t.client_name || "").toLowerCase().includes(q)) return true;
  const nq = normalizeRef(q);
  if (nq && normalizeRef(t.external_ref).includes(nq)) return true;
  return false;
}

/* ---- lanes ------------------------------------------------------------------ */
export const LANES = [
  { key: "today", label: "Today", color: "#4F46E5", tone: "review" },
  { key: "pending_review", label: "Pending review", color: "#7C3AED", tone: "review" },
  { key: "regular", label: "Regular", color: "#2563EB", tone: "todo" },
  { key: "important", label: "Important", color: "#7C3AED", tone: "paused" },
  { key: "urgent", label: "Urgent", color: "#D97706", tone: "danger" },
  { key: "in_progress", label: "In progress", color: "#DB6E1E", tone: "progress" },
  { key: "paused", label: "Paused", color: "#E8842B", tone: "paused" },
  { key: "approvals", label: "Pending approvals", color: "#CA8A04", tone: "review" },
  { key: "awaiting_client", label: "Awaiting client", color: "#0891B2", tone: "review" },
  { key: "completed", label: "Completed", color: "#16A34A", tone: "done" },
];
export const LANE_BY_KEY = Object.fromEntries(LANES.map((l) => [l.key, l]));
export const PRIORITY_LANES = ["regular", "important", "urgent"];

export const isTodayTask = (t) => (t.today_seconds || 0) > 0;

export const SINCE_RESUME_LABELS = {
  break: "after break", lunch: "after lunch", meeting: "after meeting", leave: "after leave",
  urgent: "after urgent work", priority_task: "after another task", technical_issue: "after a technical issue",
  awaiting_approval: "after approval", away: "after away",
};
export function sinceResume(t) {
  if (!t || t.task_state !== "in_progress" || !t.timer_start_datetime) return null;
  if (!((t.timer_total_seconds || 0) > 0)) return null;
  return { startIso: t.timer_start_datetime, label: SINCE_RESUME_LABELS[t.pause_reason_code] || "since resume" };
}

/* Which STATUS lane owns a task. Never 'today' (that is an extra membership). */
export function laneForTask(t) {
  if (t.is_self_created && !t.admin_accepted) return "pending_review";
  switch (t.task_state) {
    case "in_progress": return "in_progress";
    case "paused": return "paused";
    case "partially_completed": return "approvals";
    case "awaiting_client": return "awaiting_client";
    case "completed": return "completed";
    default: break;
  }
  if (t.priority === "urgent" || t.task_state === "urgent") return "urgent";
  if (t.priority === "important" || t.task_state === "important") return "important";
  return "regular";
}

/* Most recently worked first; never-worked last. */
export function byRecency(a, b) {
  const A = a.last_activity || "";
  const B = b.last_activity || "";
  if (A === B) return 0;
  if (!A) return 1;
  if (!B) return -1;
  return A < B ? 1 : -1;
}

export function groupIntoLanes(tasks) {
  const buckets = {};
  for (const l of LANES) buckets[l.key] = [];
  for (const t of tasks) {
    const key = laneForTask(t);
    (buckets[key] || buckets.regular).push(t);
    if (isTodayTask(t)) buckets.today.push(t);
  }
  for (const l of LANES) if (l.key !== "today") buckets[l.key].sort(byRecency);
  buckets.today.sort((a, b) => (b.today_seconds || 0) - (a.today_seconds || 0));
  return buckets;
}

/* ---- reads ------------------------------------------------------------------ */
export const TASKS_PATH = "/kra_kpi/tasks/get";

/* The board. Returns { tasks, isAdmin, currentUserId, selfPendingCount, serverNow }.
   Cached 15 s and shared (lib/api read) so the board, Your work and the panel
   draw from one answer. */
export async function fetchTasks({ myTasksOnly = false, fresh = false } = {}) {
  const res = await read(TASKS_PATH, { my_tasks_only: myTasksOnly }, { fresh });
  const tasks = res?.tasks || [];
  log.info("fetchTasks ←", { count: tasks.length, isAdmin: !!res?.is_admin, myTasksOnly });
  return {
    tasks, isAdmin: !!res?.is_admin, currentUserId: res?.current_user_id,
    selfPendingCount: res?.self_pending_count || 0, serverNow: res?.server_now || "",
    adminAcceptMinutes: res?.admin_accept_minutes, clientApprovalMinutes: res?.client_approval_minutes,
  };
}

export async function fetchTaskById(kpiId) {
  const res = await rpc("/kra_kpi/task/get", { kpi_id: kpiId });
  return res?.status ? (res.task || null) : null;
}

/* Everything the task panel renders, in one round-trip. Surfaces WHY it failed
   (the route is access-gated). The panel reads it fresh; the Start / Complete
   dialogs pass { fresh: false } to reuse the open panel's answer. */
export async function fetchTaskDetails(kpiId, { fresh = true, ttl = 60000 } = {}) {
  const res = await read("/kra_kpi/task/details", { kpi_id: kpiId }, { fresh, ttl });
  if (!res?.status) return { ok: false, message: res?.message || "Could not load details" };
  return {
    ok: true,
    task: res.task || null, meta: res.meta || {}, manuals: res.manuals || [], progress: res.progress || [],
    github: res.github || [], reassignments: res.reassignments || [], files: res.files || [], links: res.links || [],
    estimate_history: res.estimate_history || [], activity_log: res.activity_log || [],
    activity_total: res.activity_total || 0, activity_limit: res.activity_limit || 0,
  };
}

/* One log at a time: kind 'all' | 'pause' | 'heading'. The server filters before
   it caps (ACTIVITY_LIMIT), so a filtered view is never a slice of a slice. */
export async function fetchActivity(kpiId, kind = "all") {
  const res = await rpc("/kpi_action/activity", { kpi_id: kpiId, kind });
  if (!res?.status) return { status: false, message: res?.message || "Could not load the log" };
  return { status: true, activity_log: res.activity_log || [], activity_total: res.activity_total || 0, activity_limit: res.activity_limit || 0 };
}

/* The web detail route: the project picker (available_kras, every KRA with its
   client root) and the manager flag the heading editor needs. Param is `id`;
   failure is {error}, not {status:false}. */
export async function fetchActionDetails(kpiId) {
  const res = await rpc("/kpi_action/details", { id: kpiId });
  if (!res || res.error) throw new Error(res?.error || "Could not load the task.");
  return res;
}

export async function fetchUsers() {
  const res = await read("/kra_kpi/get_users", {}, { ttl: 5 * 60 * 1000 });
  return res?.users || res || [];
}
/* Everyone a meeting can be with — developers, admins AND clients. */
export async function fetchPeople() {
  const res = await read("/kra_kpi/get_people", {}, { ttl: 5 * 60 * 1000 });
  return Array.isArray(res) ? res : (res?.people || []);
}

/* ---- writes ----------------------------------------------------------------- */
/* Lifecycle actions fire server-side notifications that can take a while. The
   answer is {status, message, ...}; callers read `status` (assertOk throws). */
async function action(path, params) {
  log.info("action →", path, params);
  const res = await rpc(path, params, { timeout: 45000 });
  log.info("action ←", path, { status: res?.status, message: res?.message, new_state: res?.new_state });
  return res;
}
export { assertOk };

export const fetchPaidTasks = () => action("/kra_kpi/tasks/paid", {});

export const startTask = (kpiId) => action("/kra_kpi/task/start", { kpi_id: kpiId });
export const resumeTask = (kpiId) => action("/kra_kpi/task/resume", { kpi_id: kpiId });
export const resumeTaskWithReason = (kpiId, reason) => action("/kra_kpi/task/resume_with_reason", { kpi_id: kpiId, reason: (reason || "").trim() });
export const undoTaskStart = (kpiId) => action("/kra_kpi/task/undo_start", { kpi_id: kpiId });
export const addTaskTime = (kpiId, hours, minutes, reason) =>
  action("/kra_kpi/task/add_time", { kpi_id: kpiId, hours: hours || 0, minutes: minutes || 0, reason: reason || "" });
export const pauseTask = (kpiId, reason, reasonCode, meetingWithIds) =>
  action("/kra_kpi/task/pause", { kpi_id: kpiId, reason: reason || "", reason_code: reasonCode || false, meeting_with_ids: meetingWithIds || [] });
export const pauseAllTasks = (reason, reasonCode, meetingWithIds) =>
  action("/kra_kpi/task/pause_all", { reason: reason || "", reason_code: reasonCode || "break", meeting_with_ids: meetingWithIds || [] });
export const switchTask = (kpiId, fromKpiId, note) =>
  action("/kra_kpi/task/switch", { kpi_id: kpiId, from_kpi_id: fromKpiId || null, note: note || "" });
export const reassignTask = (kpiId, userId, reason) => action("/kra_kpi/task/reassign", { kpi_id: kpiId, user_id: userId, reason: reason || "" });
export const revertSignoff = (kpiId, reason) => action("/kra_kpi/task/revert_signoff", { kpi_id: kpiId, reason: reason || "" });
export const adminDeleteTask = (kpiId, reason) => action("/kra_kpi/task/admin_delete", { kpi_id: kpiId, reason: reason || "" });
export const completeTask = (kpiId, employeeChecklist = {}, partial = false) =>
  action("/kra_kpi/task/complete", { kpi_id: kpiId, employee_checklist: employeeChecklist, partial });
export const approveTask = (kpiId, managerChecklist = {}) => action("/kra_kpi/task/approve", { kpi_id: kpiId, manager_checklist: managerChecklist });
export const rejectTask = (kpiId, reason) => action("/kra_kpi/task/reject", { kpi_id: kpiId, reason: reason || "" });
export const getTaskChecklists = (kpiId) => action("/kra_kpi/task/checklists", { kpi_id: kpiId });
export const markReviewStarted = (kpiId) => rpc("/kpi_review/mark_started", { kpi_id: kpiId }).catch(() => ({ status: false }));
export const acceptSelfCreated = (kpiId, docType = "requirement", priority) =>
  action("/kra_kpi/task/accept_self_created", { kpi_id: kpiId, doc_type: docType, priority });
export const rejectSelfCreated = (kpiId, note, discard = false) =>
  action("/kra_kpi/task/reject_self_created", { kpi_id: kpiId, note: note || "", discard: !!discard });
export const switchBreak = (reasonCode, note = "", meetingWithIds = []) =>
  action("/kra_kpi/break/switch", { reason_code: reasonCode, reason: (note || "").trim().slice(0, 60), meeting_with_ids: reasonCode === "meeting" ? (meetingWithIds || []) : [] });

/* NEW on 19.0.5.7 (web only): admin moves a card between the priority lanes. */
export const setPriority = (kpiId, priority) => action("/kpi_action/set_priority", { kpi_id: kpiId, priority });

/* Progress updates. related_links is a JSON array of URL strings on the wire. */
export const MAX_PROGRESS_BYTES = 50 * 1024 * 1024; /* per file, the route's own cap */
export const createProgress = (kpiId, summary, links) =>
  action("/kpi/progress/create", { kpi_id: kpiId, summary: summary || "", ...(links ? { related_links: JSON.stringify(links) } : {}) });
/* With files: ONE multipart post (`file` repeated — the route reads getlist('file')),
   so an update cannot half-land. Without: the JSON create route. The upload route
   answers plain JSON {status, id, file_count}; assertOk is left to the caller. */
export async function submitProgress(kpiId, { summary, links, files } = {}, onProgress) {
  const picked = files || [];
  if (!picked.length) return createProgress(kpiId, summary, links || []);
  const big = picked.find((f) => f.size > MAX_PROGRESS_BYTES);
  if (big) return { status: false, message: `${big.name} is over the 50 MB limit. Add a Drive or GitHub link instead.` };
  if (picked.reduce((n, f) => n + f.size, 0) > MAX_PROGRESS_BYTES) return { status: false, message: "Those files come to over 50 MB together. Send them as two updates, or add a link." };
  const fd = new FormData();
  fd.append("kpi_id", String(kpiId));
  fd.append("summary", summary || "");
  fd.append("related_links", JSON.stringify(links || []));
  for (const f of picked) fd.append("file", f, f.name);
  log.info("progress upload →", { kpiId, files: picked.length });
  return upload("/kpi/progress/upload_file", fd, { timeout: 180000, onProgress });
}
/* Only keys present are written server-side; summary can't be blank. clearFile
   drops the entry's first file (the next one is promoted). */
export const updateProgress = (progressId, { summary, links, clearFile } = {}) =>
  action("/kpi/progress/update", { progress_id: progressId, summary: summary || "", related_links: JSON.stringify(links || []), clear_file: !!clearFile });
export const deleteProgress = (progressId) => action("/kpi/progress/delete", { progress_id: progressId });
/* Select-and-delete. The route deletes what the caller may and reports the rest:
   {status, deleted, refused, missing}. */
export const deleteProgressBulk = (ids) => action("/kpi/progress/delete_bulk", { progress_ids: ids || [] });

/* Per-task reassignment history with the fields task/details leaves out
   (previous_state, was_paused, pause_reason). */
export async function fetchReassignmentHistory(kpiId) {
  const res = await rpc("/kra_kpi/reassignment_history", { kpi_id: kpiId });
  assertOk(res, "Could not load the reassignment history.");
  return res.history || [];
}
/* related_links arrives as a JSON string ('[]' when empty). */
export function parseLinks(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  try { const v = JSON.parse(raw || "[]"); return Array.isArray(v) ? v.filter(Boolean) : []; } catch (_) { return []; }
}

/* User manuals: PDF / DOC / DOCX, 25 MB each (the route re-checks both). */
export const MANUAL_EXTENSIONS = [".pdf", ".doc", ".docx"];
export const MAX_MANUAL_BYTES = 25 * 1024 * 1024;
export async function uploadManual(kpiId, { files, description, links } = {}, onProgress) {
  const picked = files || [];
  if (!picked.length) return { status: false, message: "Pick a file." };
  const bad = picked.find((f) => !MANUAL_EXTENSIONS.some((x) => f.name.toLowerCase().endsWith(x)));
  if (bad) return { status: false, message: `${bad.name}: only PDF, DOC and DOCX files can be uploaded as a manual.` };
  const big = picked.find((f) => f.size > MAX_MANUAL_BYTES);
  if (big) return { status: false, message: `${big.name} is over the 25 MB limit.` };
  const fd = new FormData();
  fd.append("kpi_id", String(kpiId));
  for (const f of picked) fd.append("file", f, f.name);
  fd.append("description", description || "");
  fd.append("related_links", JSON.stringify(links || []));
  return upload("/kpi/manual/upload_file", fd, { timeout: 180000, onProgress });
}
/* The list route carries `can_edit` per manual; task details doesn't. */
export async function listManuals(kpiId) {
  const res = await rpc("/kpi/manual/list", { kpi_id: kpiId });
  return res?.status ? res.manuals || [] : [];
}
export const deleteManual = (manualId) => action("/kpi/manual/delete", { manual_id: manualId });

/* GitHub: the server requires a branch and a github.com URL. */
export const addGithubLink = (kpiId, githubUrl, branchName) => action("/kpi/github/add", { kpi_id: kpiId, github_url: githubUrl || "", branch_name: branchName || "" });
export const deleteGithubLink = (linkId) => action("/kpi/github/delete", { link_id: linkId });

/* Manager-only heading edit. Empty name / false type / false kra_id = unchanged.
   A move to another client answers {status:false, needs_confirm, from_client,
   to_client} until it is resent with confirmClientMove. */
export const TASK_TYPES = [{ code: "requirement", label: "Requirement" }, { code: "update", label: "Update" }, { code: "bug", label: "Bug" }];
export const updateTaskMeta = (kpiId, { name, type, kraId, confirmClientMove } = {}) =>
  action("/kpi_action/update_meta", { id: kpiId, name: name || "", type: type || false, kra_id: kraId || false, confirm_client_move: !!confirmClientMove });

/* Deadline / reminder alerts (the Odoo board's checkRemindersAndDeadlines). */
export const markReminderShown = (kpiId) => rpc("/kra_kpi/update_reminder_shown", { kpi_id: kpiId }).catch(() => ({ status: false }));
export const markDeadlineAlertShown = (kpiId) => rpc("/kra_kpi/update_deadline_alert_shown", { kpi_id: kpiId }).catch(() => ({ status: false }));
export function reminderIntervalMs(t) {
  return ((t.reminder_days || 0) * 86400 + (t.reminder_hours || 0) * 3600 + (t.reminder_minutes || 0) * 60) * 1000;
}
export function fmtReminder(t) {
  const p = [];
  if (t.reminder_days > 0) p.push(`${t.reminder_days}d`);
  if (t.reminder_hours > 0) p.push(`${t.reminder_hours}h`);
  if (t.reminder_minutes > 0) p.push(`${t.reminder_minutes}m`);
  return p.join(" ") || "0m";
}
/* deadline is a date 'YYYY-MM-DD'; compared with the user's local date. */
export const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const deadlinePassed = (t, nowMs = Date.now()) => !!t.deadline && t.task_state !== "completed" && localDay(nowMs) >= String(t.deadline).slice(0, 10);
/* last_reminder_shown is a wall-clock string in the user's zone (convert_to_user_tz),
   so it parses as local time; timer_start_datetime is UTC. */
export const parseLocalTs = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime() : null; };
/* ms → "16 Oct 2026, 14:30" in the viewer's zone ("" for null). */
export const fmtLocalDateTime = (ms) => (ms == null ? "" : new Date(ms).toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }));
/* Which alert is due for one task, for its assignee: 'deadline' | 'reminder' | null.
   Same rules as Odoo: running tasks only; the deadline once (deadline_alert_shown);
   the reminder every interval, counted from the last one shown or the timer start. */
export function alertDue(t, uid, nowMs = Date.now()) {
  if (!t || t.task_state !== "in_progress" || t.user_id !== uid) return null;
  if (!t.deadline_alert_shown && deadlinePassed(t, nowMs)) return "deadline";
  const every = reminderIntervalMs(t);
  if (every > 0) {
    const ref = parseLocalTs(t.last_reminder_shown) ?? parseServerTs(t.timer_start_datetime);
    if (ref != null && nowMs - ref >= every) return "reminder";
  }
  return null;
}

/* ---- constants (shared with the mobile app) ---------------------------------- */
export const CHECKLIST_ITEMS = [
  { key: "verify_github", label: "Verified GitHub URL" },
  { key: "deployed_task", label: "Deployed the task" },
  { key: "user_manual", label: "User manual uploaded" },
  { key: "documentation", label: "Documentation submitted" },
  { key: "tested_code", label: "Manually tested the code" },
];
export const MGR_CHECKLIST_ITEMS = [
  { key: "task_reviewed", label: "Task reviewed" },
  { key: "github_verified", label: "GitHub verified" },
  { key: "testing_completed", label: "Testing completed" },
  { key: "tested_successfully", label: "Tested successfully" },
  { key: "manual_reviewed", label: "User manual reviewed" },
  { key: "docs_approved", label: "Documentation approved" },
];
export const PAUSE_REASONS = [
  { code: "priority_task", label: "Moved to another task", emoji: "🔀", quick: true },
  { code: "break", label: "Break", emoji: "☕", quick: true },
  { code: "lunch", label: "Lunch", emoji: "🍽", quick: true },
  { code: "meeting", label: "Meeting", emoji: "👥", quick: true },
  { code: "day_end", label: "Day end", emoji: "🌙", quick: true },
  { code: "awaiting_approval", label: "Waiting for approval" },
  { code: "technical_issue", label: "Technical issue" },
  { code: "leave", label: "Leave" },
  { code: "other", label: "Other", emoji: "✍", quick: true },
  { code: "urgent", label: "Urgent", emoji: "🚨", quick: true },
];
export const BREAK_SWITCH_REASONS = [
  { code: "break", label: "Break", emoji: "☕" }, { code: "lunch", label: "Lunch", emoji: "🍽" }, { code: "meeting", label: "Meeting", emoji: "👥" },
];
export const REJECT_REASONS = [
  { code: "different_dev", label: "Want a different developer", emoji: "🔁", quick: true },
  { code: "wrong_details", label: "Task details are wrong", emoji: "📝", quick: true },
  { code: "not_needed", label: "Not needed anymore", emoji: "🚫", quick: true },
  { code: "other", label: "Other", emoji: "✍", quick: true },
];
export const PRIORITIES = [
  { code: "regular", label: "Regular" }, { code: "important", label: "Important" }, { code: "urgent", label: "Urgent" },
];
export const DELIVERABLES = [
  { code: "module", label: "Module" }, { code: "app", label: "App" }, { code: "exe", label: "EXE" },
];
export const IDLE_REASONS = [
  { code: "meeting", label: "In a meeting", emoji: "👥", note: "Recorded on your Workday Map. Admins are not notified." },
  { code: "break", label: "On a break", emoji: "☕", note: "Recorded on your Workday Map. Admins are not notified." },
  { code: "lunch", label: "Lunch", emoji: "🍽", note: "Recorded on your Workday Map. Admins are not notified." },
  { code: "no_tasks", label: "I have no tasks", emoji: "📭", note: "Recorded on your Workday Map, and your admins are told right away so they can assign you work." },
];
export const IDLE_NOTE_MAX = 60;
/* Odoo's PAUSE_NOTE_MAX: the pause note shows on the Workday Map, so it is short. */
export const PAUSE_NOTE_MAX = 60;
export const PAUSED_STATES = ["paused", "hold", "rework"];

/* The board's Status filter (Odoo's Status dropdown), keyed by OUR lane keys. */
export const STATUS_FILTERS = [
  { key: "pending_review", label: "Pending review" }, { key: "regular", label: "Regular" }, { key: "important", label: "Important" },
  { key: "urgent", label: "Urgent" }, { key: "in_progress", label: "In progress" }, { key: "paused", label: "Paused" },
  { key: "approvals", label: "Pending approvals" }, { key: "awaiting_client", label: "Awaiting client" }, { key: "completed", label: "Completed" },
];
export const priorityLabel = (p) => (PRIORITIES.find((x) => x.code === p)?.label || p || "Regular");
/* 'module,app' → "Module, App". */
export const deliverableLabel = (t) => String(t || "").split(",").filter(Boolean).map((c) => DELIVERABLES.find((d) => d.code === c)?.label || c).join(", ");

/* Pause-reason rules (utils/meetingPick.js). */
export const TEAM_MEETING_LABEL = "Team meeting";
export const baseNoteRequired = (code) => code === "other" || code === "urgent" || code === "meeting";
export const noteRequired = (code, team) => baseNoteRequired(code) && !(code === "meeting" && team);
export const pauseReasonText = (note, code, team, label, max = 200) =>
  String(note || "").trim().slice(0, max) || (code === "meeting" && team ? TEAM_MEETING_LABEL : label);
export const meetingIds = (code, team, picked) => (code === "meeting" && !team ? (picked || []) : []);

/* ---- workday ---------------------------------------------------------------- */
export const WORKDAY_PATH = "/kpi_workday/status";
export const LIVE_PATH = "/kpi_action/live_status";
export const getWorkdayStatus = () => read(WORKDAY_PATH, {}, { ttl: 5000 });
export const getLiveStatus = () => read(LIVE_PATH, {}, { ttl: 4000 });
export const getTodaySummary = () => rpc("/kpi_workday/today_summary", {});
export const sendHeartbeat = () => rpc("/kpi_action/heartbeat", {});
export const startWorkday = () => action("/kpi_workday/ping", {});
export const endWorkday = (note = "") => action("/kpi_workday/end", { note });
export const pauseWorkday = (note = "") => action("/kpi_workday/pause", { note });
export const resumeWorkday = () => action("/kpi_workday/resume", {});
export const setIdleReason = (reason, note = "", meetingWithIds = []) =>
  action("/kpi_workday/idle_reason", { reason, note: (note || "").trim().slice(0, IDLE_NOTE_MAX), meeting_with_ids: reason === "meeting" ? (meetingWithIds || []) : [] });
export const endNonTask = () => action("/kpi_workday/end_nontask", {});

/* ---- create ------------------------------------------------------------------ */
/* docType: what the creator thinks it is (requirement | update | bug). Stored as
   requested_doc_type and shown to the admin on Accept, who makes the final call. */
export const selfCreateTask = ({ name, kraId, estimateHours, estimateMinutes, priority, description, userId, deliverableType, docType }) =>
  action("/kra_kpi/task/self_create", {
    name: name || "", kra_id: kraId, estimate_hours: estimateHours || 0, estimate_minutes: estimateMinutes || 0,
    priority: priority || "regular", doc_type: docType || "requirement", description: description || "", user_id: userId || 0, deliverable_type: deliverableType || "",
  });
export const adminCreateDoneTask = ({ name, kraId, userId, workedSeconds, workDate, estimateHours, estimateMinutes, deliverableType, priority, description }) =>
  action("/kra_kpi/task/admin_create_done", {
    name: name || "", kra_id: kraId, user_id: userId || 0, worked_seconds: workedSeconds || 0, work_date: workDate || "",
    estimate_hours: estimateHours || 0, estimate_minutes: estimateMinutes || 0, deliverable_type: deliverableType || "",
    priority: priority || "regular", description: description || "",
  });
/* Odoo's _estimateFromWorked (Add Done Task): a random 20–40% over the time
   worked, on a quarter hour, at least +15 min and at most +2h (+3h when App is
   among the types). Seconds in, seconds out. */
export function estimateFromWorked(workedSeconds, deliverableTypes) {
  const quarter = 15 * 60;
  const maxExtra = (String(deliverableTypes || "").split(",").includes("app") ? 3 : 2) * 3600;
  const extra = Math.round(workedSeconds * (0.2 + Math.random() * 0.2) / quarter) * quarter;
  const est = workedSeconds + Math.min(Math.max(extra, quarter), maxExtra);
  return Math.ceil(est / quarter) * quarter;
}

/* Odoo only looks inside one KRA (find_name_matches(name, kra_id)); no kra_id → always []. */
export const findNameMatches = (name, kraId) => rpc("/kra_kpi/kpi/name_matches", { name: name || "", kra_id: kraId || false }).catch(() => ({ status: false }));

/* ---- small display helpers ---------------------------------------------------- */
export function estimateSeconds(t) { return ((t.estimate_hours || 0) * 3600) + ((t.estimate_minutes || 0) * 60); }
export function fmtHM(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (!h && !m) return s ? "<1m" : "0m";
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}
/* REQ-012 → "REQ"; TASK-014 → "TASK". */
export function refPrefix(ref) { return String(ref || "").split("-")[0].toUpperCase(); }
export const TYPE_TILE = { REQ: ["R", "#2563EB"], UPT: ["U", "#16A34A"], BUG: ["B", "#DC2626"], TASK: ["T", "#6B7280"] };
