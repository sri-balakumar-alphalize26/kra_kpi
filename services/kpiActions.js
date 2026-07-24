// KPI Action Board data service. Mirrors the Odoo controller routes used by the
// board (kra_api.py). Returns the SAME task shape as /kra_kpi/tasks/get so the
// screen never changes when live. Falls back to mock data when no server is set.
//
// Task shape (from get_tasks map_rec):
//   { id, name, priority, task_state, user_id, user_name, estimate_display,
//     estimate_hours, estimate_minutes, timer_total_seconds, timer_start_datetime,
//     paused_reason, description, progress_count, is_self_created, admin_accepted, ... }

import { getConnection } from '../api/session';
import { jsonRpc, httpUpload } from '../api/odooApi';
import { createLogger } from '../api/logger';
import { getKraTree } from './kraKpi';

const log = createLogger('ActionBoard');

// Flatten the KRA tree into a picker list: [{ id, display }] with "A › B › C" paths.
export async function fetchProjects() {
  const { tree } = await getKraTree();
  const out = [];
  const walk = (nodes, prefix) => {
    for (const n of nodes || []) {
      const path = prefix ? `${prefix} › ${n.name}` : n.name;
      out.push({ id: n.id, display: path });
      walk(n.child_ids, path);
    }
  };
  walk(tree, '');
  return out;
}

// Two-step Client → Project source for "+ New Task": clients (is_client roots),
// each with its flattened descendant projects [{id, display}]. Cleaner than the
// flat fetchProjects (which mixed clients + every sub-level in one list).
export async function fetchClientTree() {
  const { tree } = await getKraTree();
  const clients = [];
  const collect = (node) => {
    const projects = [];
    const walk = (nodes, prefix) => {
      for (const n of nodes || []) {
        const path = prefix ? `${prefix} › ${n.name}` : n.name;
        projects.push({ id: n.id, display: path });
        walk(n.child_ids, path);
      }
    };
    walk(node.child_ids, '');
    // Fall back to the client root itself when it has no sub-projects.
    if (projects.length === 0) projects.push({ id: node.id, display: node.name });
    return projects;
  };
  for (const root of tree || []) {
    if (root.is_client) clients.push({ id: root.id, name: root.name, projects: collect(root) });
  }
  return clients;
}

// ── Lane model — mirrors the Odoo board columns in the screenshot ────────────
// A task lands in exactly one lane. Priority lanes (Regular/Important/Urgent)
// only hold tasks that are still in a "to-do" state (assigned/queued/etc.).
export const LANES = [
  { key: 'pending_review', label: 'Pending Review', color: '#7C3AED' },
  { key: 'regular',        label: 'Regular',        color: '#2563EB' },
  { key: 'important',      label: 'Important',      color: '#7C3AED' },
  { key: 'urgent',         label: 'Urgent',         color: '#D97706' },
  { key: 'in_progress',    label: 'In Progress',    color: '#DB6E1E' },
  { key: 'paused',         label: 'Paused',         color: '#E8842B' },
  { key: 'approvals',      label: 'Pending Approvals', color: '#CA8A04' },
  { key: 'awaiting_client',label: 'Awaiting Client', color: '#0891B2' },
  { key: 'completed',      label: 'Completed',      color: '#16A34A' },
];

// Decide which lane a task belongs to. Matches the OWL board's grouping.
export function laneForTask(t) {
  if (t.is_self_created && !t.admin_accepted) return 'pending_review';
  switch (t.task_state) {
    case 'in_progress': return 'in_progress';
    case 'paused':
    case 'hold':
    case 'rework': return 'paused';
    case 'partially_completed': return 'approvals';
    case 'awaiting_client': return 'awaiting_client';
    case 'completed': return 'completed';
    default: break; // fall through to priority-based to-do lanes
  }
  // Still to be started → bucket by priority.
  if (t.priority === 'urgent' || t.task_state === 'urgent') return 'urgent';
  if (t.priority === 'important' || t.task_state === 'important') return 'important';
  return 'regular';
}

export function groupIntoLanes(tasks) {
  const buckets = {};
  for (const l of LANES) buckets[l.key] = [];
  for (const t of tasks) {
    const key = laneForTask(t);
    (buckets[key] || buckets.regular).push(t);
  }
  return buckets;
}

// ── Mock data (no server) ────────────────────────────────────────────────────
const MOCK_TASKS = [
  { id: 1, name: '[Update] KRA KPI', priority: 'regular', task_state: 'assigned',
    user_id: 3, user_name: 'user', estimate_display: '00:00', timer_total_seconds: 0,
    timer_start_datetime: null, paused_reason: '', progress_count: 0,
    is_self_created: false, admin_accepted: true },
  { id: 2, name: 'Login page requirement', priority: 'regular', task_state: 'assigned',
    user_id: 0, user_name: '', estimate_display: '01:00', timer_total_seconds: 0,
    timer_start_datetime: null, paused_reason: '', progress_count: 0,
    is_self_created: false, admin_accepted: true },
  { id: 3, name: 'Attendance', priority: 'regular', task_state: 'paused',
    user_id: 3, user_name: 'user', estimate_display: '01:00', timer_total_seconds: 11360,
    timer_start_datetime: null, paused_reason: 'Break', progress_count: 1,
    is_self_created: false, admin_accepted: true },
  { id: 4, name: 'att 2', priority: 'regular', task_state: 'paused',
    user_id: 3, user_name: 'user', estimate_display: '01:00', timer_total_seconds: 6192,
    timer_start_datetime: null, paused_reason: 'Lunch', progress_count: 0,
    is_self_created: false, admin_accepted: true },
];

function mockEnvelope() {
  return {
    status: true,
    tasks: MOCK_TASKS,
    is_admin: true,
    current_user_id: 3,
    self_pending_count: 0,
    isMock: true,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

// Fetch the board. Returns { tasks, isAdmin, currentUserId, selfPendingCount, isMock }.
export async function fetchTasks({ myTasksOnly = false } = {}) {
  const { serverUrl } = await getConnection();
  if (serverUrl) {
    const res = await jsonRpc(serverUrl, '/kra_kpi/tasks/get', { my_tasks_only: myTasksOnly });
    const tasks = res?.tasks || [];
    log.info('fetchTasks ←', { count: tasks.length, isAdmin: !!res?.is_admin, myTasksOnly });
    return {
      tasks,
      isAdmin: !!res?.is_admin,
      currentUserId: res?.current_user_id,
      selfPendingCount: res?.self_pending_count || 0,
      isMock: false,
    };
  }
  log.info('fetchTasks — no server, using mock');
  await new Promise((r) => setTimeout(r, 400));
  const env = mockEnvelope();
  return {
    tasks: env.tasks, isAdmin: env.is_admin, currentUserId: env.current_user_id,
    selfPendingCount: env.self_pending_count, isMock: true,
  };
}

// Fetch ONE task by id — for opening a notification whose task isn't in the
// board's scoped list (reassigned away / completed). Returns the task or null.
export async function fetchTaskById(kpiId) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return null;
  try {
    const res = await jsonRpc(serverUrl, '/kra_kpi/task/get', { kpi_id: kpiId });
    return res?.status ? (res.task || null) : null;
  } catch (e) {
    log.warn('fetchTaskById failed', e?.message);
    return null;
  }
}

// Everything the KPI Details screen renders, in ONE round-trip (the web pane
// makes seven): the task, `meta` (the fields map_rec doesn't carry — ref, KRA,
// type, checklist, guidelines, and the is_manager/is_assignee/can_complete
// flags), plus its manuals, progress updates, GitHub links and reassignments.
//
// Unlike the other fetchers this one surfaces WHY it failed: the route is
// access-gated (admin and coordinator see any task, a developer only their own,
// a client none), so "not authorized" is a real answer the screen must show
// rather than a silently empty page.
export async function fetchTaskDetails(kpiId) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { ok: false, message: 'No server connection' };
  try {
    const res = await jsonRpc(serverUrl, '/kra_kpi/task/details', { kpi_id: kpiId });
    if (!res?.status) return { ok: false, message: res?.message || 'Could not load details' };
    return {
      ok: true,
      task: res.task || null,
      meta: res.meta || {},
      manuals: res.manuals || [],
      progress: res.progress || [],
      github: res.github || [],
      reassignments: res.reassignments || [],
      files: res.files || [],
      links: res.links || [],
    };
  } catch (e) {
    log.warn('fetchTaskDetails failed', e?.message);
    return { ok: false, message: 'Could not load details' };
  }
}

// ── Pending Review: admin decides on a DEVELOPER-created task ──────────────
// A developer can create their own task and work it immediately, but it stays
// out of the official flow (is_self_created && !admin_accepted → the "Pending
// Review" lane) until an admin accepts it. Both routes are admin-gated server
// side and refuse anything not awaiting acceptance.

// Accept into the official flow. `docType` ('requirement'|'update'|'bug')
// re-numbers the provisional TASK-### ref into the real REQ/UPT/BUG sequence and
// applies the name prefix, so the admin is really CATEGORISING it. The server
// then fires client pre-approval only if the dev hasn't started — a running
// timer and its accrued time are never disturbed.
export async function acceptSelfCreated(kpiId, docType = 'requirement') {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true };
  const res = await jsonRpc(serverUrl, '/kra_kpi/task/accept_self_created', {
    kpi_id: kpiId, doc_type: docType,
  });
  if (!res || res.status === false) throw new Error(res?.message || 'Could not accept the task');
  log.info('acceptSelfCreated ←', { kpiId, docType });
  return res;
}

// Send it back to the developer with a note (stays in Pending Review), or
// discard it outright. The note reaches the dev as a `self_task_rejected`
// notification and shows on their card.
export async function rejectSelfCreated(kpiId, note, discard = false) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true };
  const res = await jsonRpc(serverUrl, '/kra_kpi/task/reject_self_created', {
    kpi_id: kpiId, note: note || '', discard: !!discard,
  });
  if (!res || res.status === false) throw new Error(res?.message || 'Could not send the task back');
  log.info('rejectSelfCreated ←', { kpiId, discard });
  return res;
}

// Fetch users for the reassign picker (/kra_kpi/get_users).
export async function fetchUsers() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return [{ id: 3, name: 'user' }, { id: 2, name: 'Mitchell Admin' }];
  const res = await jsonRpc(serverUrl, '/kra_kpi/get_users', {});
  return res?.users || res || [];
}

async function action(path, params) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    log.info('action (mock, not sent)', path, params);
    return { status: true, message: 'Mock — not sent to a server' };
  }
  log.info('action →', path, params);
  // Lifecycle actions fire server-side notifications / break-log writes that can
  // take longer than the default 10s — give them a 30s window so they don't
  // spuriously fail with "Network Error" (a timeout abort).
  const res = await jsonRpc(serverUrl, path, params, 30000);
  log.info('action ←', path, { status: res?.status, message: res?.message, new_state: res?.new_state });
  return res;
}

export const startTask   = (kpiId) => action('/kra_kpi/task/start', { kpi_id: kpiId });
export const resumeTask  = (kpiId) => action('/kra_kpi/task/resume', { kpi_id: kpiId });
export const pauseTask   = (kpiId, reason, reasonCode) =>
  action('/kra_kpi/task/pause', { kpi_id: kpiId, reason: reason || '', reason_code: reasonCode || false });
export const reassignTask = (kpiId, userId, reason) =>
  action('/kra_kpi/task/reassign', { kpi_id: kpiId, user_id: userId, reason: reason || '' });
export const completeTask = (kpiId, employeeChecklist = {}, partial = false) =>
  action('/kra_kpi/task/complete', { kpi_id: kpiId, employee_checklist: employeeChecklist, partial });
// Admin reviews a developer-completed task (task_state === 'partially_completed').
// Approve carries the manager QA checklist; reject sends it back to the SAME dev.
export const approveTask = (kpiId, managerChecklist = {}) =>
  action('/kra_kpi/task/approve', { kpi_id: kpiId, manager_checklist: managerChecklist });
export const rejectTask = (kpiId, reason) =>
  action('/kra_kpi/task/reject', { kpi_id: kpiId, reason: reason || '' });
// Read the developer's + manager's checklist state for a task (shown read-only in the admin Approve modal).
export const getTaskChecklists = (kpiId) =>
  action('/kra_kpi/task/checklists', { kpi_id: kpiId });

// Submit a progress summary. The server REQUIRES one before complete/partial.
export const createProgress = (kpiId, summary) =>
  action('/kpi/progress/create', { kpi_id: kpiId, summary: summary || '' });

// ── KPI Details view: the same writes the web detail pane offers ───────────
// Routes all pre-exist in kra_api.py; these are just the app's door into them.

// Server's own cap on /kpi/progress/upload_file. Check it before sending so a
// too-big file is refused instantly instead of after a long doomed upload.
export const MAX_PROGRESS_BYTES = 50 * 1024 * 1024;

// Progress update, with an optional attachment and related links.
//
// Two paths, mirroring exactly what the web detail pane does:
//   file    -> multipart POST /kpi/progress/upload_file  (50 MB, streams the file)
//   no file -> JSON  POST /kpi/progress/create           ("unchanged path")
// Do NOT push a file through /kpi/progress/create: it's the small-payload route,
// and base64 inflates the body ~33% while holding the whole file in memory.
export async function submitProgressUpdate(kpiId, { summary, links, file }, onProgress) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, message: 'Mock — not sent to a server' };

  if (file?.uri) {
    if (file.size && file.size > MAX_PROGRESS_BYTES) {
      return { status: false, message: 'That file is over the 50 MB limit. Add a Drive or GitHub link instead.' };
    }
    const fd = new FormData();
    fd.append('kpi_id', String(kpiId));
    fd.append('summary', summary || '');
    fd.append('related_links', JSON.stringify(links || []));
    fd.append('file', {
      uri: file.uri,
      name: file.name || 'file',
      type: file.mimeType || 'application/octet-stream',
    });
    return await httpUpload(serverUrl, '/kpi/progress/upload_file', fd, 180000, onProgress);
  }

  // NOTE the `null` in the db slot — jsonRpc is (url, path, params, timeout, db,
  // onProgress). Passing onProgress here as `db` sets an X-Odoo-Database header,
  // which Odoo rejects outright (403) when a session cookie is also present.
  return await jsonRpc(serverUrl, '/kpi/progress/create', {
    kpi_id: kpiId,
    summary: summary || '',
    related_links: JSON.stringify(links || []),
  }, 45000, null, null);
}

// A progress file's bytes, for View / Download. Base64 over the authenticated
// JSON channel — an <Image> or external browser pointed at /kpi/progress/view
// sends no session cookie and lands on the login page instead of the file.
export async function fetchProgressFile(progressId) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: false, message: 'No server connection' };
  try {
    // 60s: a 50 MB file is ~67 MB of base64 coming back.
    const res = await jsonRpc(serverUrl, '/kpi/progress/file_b64', { progress_id: progressId }, 60000);
    return res || { status: false, message: 'Empty response' };
  } catch (e) {
    log.warn('fetchProgressFile failed', e?.message);
    return { status: false, message: 'Could not fetch the file' };
  }
}

// Same, for a user-manual file.
export async function fetchManualFile(manualId) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: false, message: 'No server connection' };
  try {
    const res = await jsonRpc(serverUrl, '/kpi/manual/file_b64', { manual_id: manualId }, 60000);
    return res || { status: false, message: 'Empty response' };
  } catch (e) {
    log.warn('fetchManualFile failed', e?.message);
    return { status: false, message: 'Could not fetch the file' };
  }
}

// The server rejects non-github.com URLs and requires a branch — surface its
// message rather than inventing our own client-side copy of that rule.
export const addGithubLink = (kpiId, githubUrl, branchName) =>
  action('/kpi/github/add', { kpi_id: kpiId, github_url: githubUrl || '', branch_name: branchName || '' });

export const deleteGithubLink = (linkId) =>
  action('/kpi/github/delete', { link_id: linkId });

export const deleteManual = (manualId) =>
  action('/kpi/manual/delete', { manual_id: manualId });

// The 5 employee-checklist keys the server expects for a full Complete.
export const CHECKLIST_ITEMS = [
  { key: 'verify_github', label: 'Verified GitHub URL' },
  { key: 'deployed_task', label: 'Deployed the task' },
  { key: 'user_manual', label: 'User manual uploaded' },
  { key: 'documentation', label: 'Documentation submitted' },
  { key: 'tested_code', label: 'Manually tested the code' },
];

// The manager/admin QA-checklist keys the server expects on Approve
// (map to approve_task's manager_checklist_* fields).
export const MGR_CHECKLIST_ITEMS = [
  { key: 'task_reviewed', label: 'Task reviewed' },
  { key: 'github_verified', label: 'GitHub verified' },
  { key: 'testing_completed', label: 'Testing completed' },
  { key: 'tested_successfully', label: 'Tested successfully' },
  { key: 'manual_reviewed', label: 'User manual reviewed' },
  { key: 'docs_approved', label: 'Documentation approved' },
];

// Pause reason codes shown in the picker (subset of the model's selection).
// `quick` marks the ones surfaced as emoji quick-pick buttons (like the web).
export const PAUSE_REASONS = [
  { code: 'break', label: 'Break', emoji: '☕', quick: true },
  { code: 'lunch', label: 'Lunch', emoji: '🍽', quick: true },
  { code: 'meeting', label: 'Meeting', emoji: '👥', quick: true },
  { code: 'priority_task', label: 'Another Priority Task' },
  { code: 'awaiting_approval', label: 'Waiting for Approval' },
  { code: 'technical_issue', label: 'Technical Issue' },
  { code: 'leave', label: 'Leave' },
  { code: 'other', label: 'Other', emoji: '✍', quick: true },
  { code: 'urgent', label: 'Urgent', emoji: '🚨', quick: true },
];

// Why a client rejected the developer assigned to their task. Same shape as
// PAUSE_REASONS above: `quick` renders as a one-tap button, so the common case
// ("give it to someone else") needs no typing. 'other' reveals a note box and
// REQUIRES text — the admin can't act on a blank reason.
// Not stored as its own field: the chosen label (or the typed text for 'other')
// is sent as `feedback` and lands in the existing kra.kpi.pre_approval_feedback.
export const REJECT_REASONS = [
  { code: 'different_dev', label: 'Want a different developer', emoji: '🔁', quick: true },
  { code: 'wrong_details', label: 'Task details are wrong', emoji: '📝', quick: true },
  { code: 'not_needed', label: 'Not needed anymore', emoji: '🚫', quick: true },
  { code: 'other', label: 'Other', emoji: '✍', quick: true },
];

// Priorities for the New Task form.
export const PRIORITIES = [
  { code: 'regular', label: 'Regular' },
  { code: 'important', label: 'Important' },
  { code: 'urgent', label: 'Urgent' },
];

// ── Workday (Start / End) ────────────────────────────────────────────────────
export async function getWorkdayStatus() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, is_open: false, today_closed: false, day_done: false };
  const res = await jsonRpc(serverUrl, '/kpi_workday/status', {});
  // day_done = developer ENDED today themselves → block restart (one start + one
  // end per day). today_closed kept for older servers that predate day_done.
  log.info('workday status ←', { is_open: res?.is_open, today_closed: res?.today_closed, day_done: res?.day_done });
  return res || { is_open: false, day_done: false };
}
export const startWorkday = () => action('/kpi_workday/ping', {});
export const endWorkday = (note = '') => action('/kpi_workday/end', { note });

// ── Not on a task: Meeting / Break / No tasks ────────────────────────────────
// Why this exists: a 9:30 start with a 9:31 meeting must not look like idling.
// ALL THREE are recorded on the Workday Map so the time is accounted for; they
// differ only in who gets told. Only "no tasks" reaches admins, because only that
// one is theirs to fix.
// Mirrors NONTASK_REASONS in models/kpi_nontask_block.py — keep them in step.
// Lunch is its own reason, not a Break: it has its own Away bucket, colour and Map
// label, so folding it into Break left the Lunch box reading 0m for anyone who ate
// without a task running.
export const IDLE_REASONS = [
  { code: 'meeting',  label: 'In a meeting',  emoji: '👥', note: 'Recorded on your Workday Map. Admins are not notified.' },
  { code: 'break',    label: 'On a break',    emoji: '☕', note: 'Recorded on your Workday Map. Admins are not notified.' },
  { code: 'lunch',    label: 'Lunch',         emoji: '🍽', note: 'Recorded on your Workday Map. Admins are not notified.' },
  { code: 'no_tasks', label: 'I have no tasks', emoji: '📭', note: 'Recorded on your Workday Map, and your admins are told right away so they can assign you work.' },
];
// The note is drawn inside a Workday Map chip (and frozen into the saved End
// Workday image), so it has to stay short. The server clamps to the same number —
// this cap is a courtesy, not the guarantee.
export const IDLE_NOTE_MAX = 60;
export const setIdleReason = (reason, note = '') =>
  action('/kpi_workday/idle_reason', { reason, note: (note || '').trim().slice(0, IDLE_NOTE_MAX) });
// Ends the block. `ask_again` comes back true when nothing is running, so the
// app re-opens the popup instead of making them wait for the next 10-min check.
export const endNonTask = () => action('/kpi_workday/end_nontask', {});

// Live activity strip: running task + active break + presence/productive anchors.
export async function getLiveStatus() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, workday_open: false, active_task: false, active_break: false };
  return jsonRpc(serverUrl, '/kpi_action/live_status', {});
}

// Today's session summary payload, used by the End Workday popup.
export async function getTodaySummary() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    return {
      status: true, login_at: '—', productive_display: '0m', presence_display: '0m',
      break_display: '0m', lunch_display: '0m', meeting_display: '0m',
      other_display: '0m', away_display: '0m', other_idle_display: '0m',
      away_events: [], tasks: [], dev: 'user',
    };
  }
  return jsonRpc(serverUrl, '/kpi_workday/today_summary', {});
}

// ── Self-create a task ("New Task") ──────────────────────────────────────────
export const selfCreateTask = ({ name, kraId, estimateHours, estimateMinutes, priority, description }) =>
  action('/kra_kpi/task/self_create', {
    name: name || '',
    kra_id: kraId,
    estimate_hours: estimateHours || 0,
    estimate_minutes: estimateMinutes || 0,
    priority: priority || 'regular',
    description: description || '',
  });
