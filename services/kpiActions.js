// KPI Action Board data service. Mirrors the Odoo controller routes used by the
// board (kra_api.py). Returns the SAME task shape as /kra_kpi/tasks/get so the
// screen never changes when live. Falls back to mock data when no server is set.
//
// Task shape (from get_tasks map_rec):
//   { id, name, priority, task_state, user_id, user_name, estimate_display,
//     estimate_hours, estimate_minutes, timer_total_seconds, timer_start_datetime,
//     today_seconds, paused_reason, description, progress_count, is_self_created,
//     admin_accepted, ... }

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
// A task lands in exactly one STATUS lane. Priority lanes (Regular/Important/
// Urgent) only hold tasks that are still in a "to-do" state (assigned/queued/
// etc.). `today` is the one exception and is not a status — see below.
export const LANES = [
  // First on purpose, and not a workflow state. The problem it solves is finding
  // something again: start task 1, pause, task 2, pause, task 3 — then going back
  // to task 1 meant hunting through every paused task, where one paused ten
  // minutes ago looks identical to one paused three weeks ago. A lane you have to
  // scroll to would not have fixed that.
  //
  // Indigo matches `.kpi-today .kpi-header` in the module's kra_style.scss, and
  // sits deliberately outside the warm ramp the status lanes use: Today is a view
  // onto the others, not another bucket work moves through.
  { key: 'today',          label: '🕒 Today',      color: '#4F46E5' },
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

// Did THIS user log time against this task today? `today_seconds` comes from the
// server (kra_api.py map_rec), counting kpi.time.log rows whose `work_date` is
// today in the DEVELOPER's timezone — which is why 01:00 IST files under today,
// and why the lane empties itself at midnight with no cron and nothing to reset:
// the date simply stops matching. An older server sends no field at all, which
// reads as "not today" and leaves the board exactly as it was.
export const isTodayTask = (t) => (t.today_seconds || 0) > 0;

// The second clock on a running card: how long since the task was picked back
// up, and what it was picked back up FROM. Mirrors sinceResume on the web board.
//
// Nothing new comes from the server for this. `timer_start_datetime` is the
// CURRENT run's start and `timer_total_seconds` is everything banked before it,
// so banked time plus a live start means the task was RESUMED rather than
// started — and the elapsed figure restarts from that resume. That is the number
// someone coming back to a task actually wants; the total keeps climbing across
// the whole task and answers a different question.
export const SINCE_RESUME_LABELS = {
  break: 'after break',
  lunch: 'after lunch',
  meeting: 'after meeting',
  leave: 'after leave',
  urgent: 'after urgent work',
  priority_task: 'after another task',
  technical_issue: 'after a technical issue',
  awaiting_approval: 'after approval',
  away: 'after away',
};

// Returns { label, startIso } for a resumed running task, else null. Deliberately
// returns the ANCHOR rather than a second count: the screen already ticks its own
// clock off timer_start_datetime (liveSeconds/secsSince), and a number computed
// here would be stale the moment it was rendered.
export function sinceResume(t) {
  if (!t || t.task_state !== 'in_progress' || !t.timer_start_datetime) return null;
  // No banked time means this is the first start, not a resume — there is
  // nothing for it to be "since".
  if (!((t.timer_total_seconds || 0) > 0)) return null;
  return {
    startIso: t.timer_start_datetime,
    // An older server sends no pause_reason_code; a task resumed from a reason we
    // have no wording for still deserves the clock, just without the story.
    label: SINCE_RESUME_LABELS[t.pause_reason_code] || 'since resume',
  };
}

// Decide which STATUS lane a task belongs to. Matches the OWL board's grouping.
//
// Deliberately never returns 'today'. Today is an additional membership, not an
// alternative one, and this function answers "which lane OWNS this task" — the
// question the status filter, the notification scroll-to and the Home stat cards
// all ask. Adding a `today` branch here would empty the status lane the task
// really lives in and send notification focus to the wrong column; use
// isTodayTask for Today instead.
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

    // ADDITIONAL membership, not an alternative one — the push above has already
    // happened and is left alone. A task worked today appears here AND in its
    // real status lane, because this lane is a shortcut for picking work back up,
    // not a new home for it: nothing moves, and the Paused count stays true.
    if (isTodayTask(t)) buckets.today.push(t);
  }
  // Most time today first: someone coming back to the board is looking for what
  // they were last deep in, not whatever happens to sort first.
  buckets.today.sort((a, b) => (b.today_seconds || 0) - (a.today_seconds || 0));
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
  // These two carry today_seconds so the sample board shows a populated Today
  // lane rather than an empty first column — and they are deliberately out of
  // source order (att 2 logged less overall but more today), so the demo also
  // shows that the lane sorts by today's time and not by the list it came from.
  { id: 3, name: 'Attendance', priority: 'regular', task_state: 'paused',
    user_id: 3, user_name: 'user', estimate_display: '01:00', timer_total_seconds: 11360,
    timer_start_datetime: null, paused_reason: 'Break', progress_count: 1,
    today_seconds: 1500, is_self_created: false, admin_accepted: true },
  { id: 4, name: 'att 2', priority: 'regular', task_state: 'paused',
    user_id: 3, user_name: 'user', estimate_display: '01:00', timer_total_seconds: 6192,
    timer_start_datetime: null, paused_reason: 'Lunch', progress_count: 0,
    today_seconds: 4200, is_self_created: false, admin_accepted: true },
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
      // The estimate's chain and the task's audit trail. This mapping is an
      // allow-list, so a field the route starts sending is invisible to the screen
      // until it is named here — which is exactly what happened to these two.
      // Defaulted, so an older server that does not send them degrades to the
      // single latest-reason line rather than throwing.
      estimate_history: res.estimate_history || [],
      activity_log: res.activity_log || [],
      activity_total: res.activity_total || 0,
      activity_limit: res.activity_limit || 0,
    };
  } catch (e) {
    log.warn('fetchTaskDetails failed', e?.message);
    return { ok: false, message: 'Could not load details' };
  }
}

// One KIND of activity at a time, for the Logs picker on the details screen.
//
// 'all' is NOT fetched: /kra_kpi/task/details already carries the full log, so
// asking again would be a second round-trip for bytes we hold. The two narrower
// kinds do go to the server, because each fetches its own 200-row window and a
// pause log sliced out of the "all" window would silently lose the older rows.
export async function fetchActivity(kpiId, kind = 'pause') {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, activity_log: [], activity_total: 0 };
  try {
    const res = await jsonRpc(serverUrl, '/kpi_action/activity', { kpi_id: kpiId, kind });
    if (!res?.status) return { status: false, message: res?.message || 'Could not load the log' };
    return {
      status: true,
      activity_log: res.activity_log || [],
      activity_total: res.activity_total || 0,
    };
  } catch (e) {
    log.warn('fetchActivity failed', e?.message);
    return { status: false, message: 'Could not load the log' };
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
// `priority` is the admin's decision, made against the developer's request
// (task.requested_priority). Omit it and the developer's choice stands.
export async function acceptSelfCreated(kpiId, docType = 'requirement', priority) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true };
  const res = await jsonRpc(serverUrl, '/kra_kpi/task/accept_self_created', {
    kpi_id: kpiId, doc_type: docType, priority,
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

// Settled work — the admin-only record of what was billed and closed.
//
// Marking an invoice paid ARCHIVES its tasks, so they leave every board and
// search. Correct for the developer, but it left the admin with no way to see
// what had been paid for. Read-only, newest payment first, capped server-side at
// 200 with a `truncated` flag the caller must surface rather than silently cut.
export const fetchPaidTasks = () => action('/kra_kpi/tasks/paid', {});

export const startTask   = (kpiId) => action('/kra_kpi/task/start', { kpi_id: kpiId });
export const resumeTask  = (kpiId) => action('/kra_kpi/task/resume', { kpi_id: kpiId });
// Extend a task's estimate. ADDS to it rather than replacing it, and the reason
// is required because it is shown on the card next to the overrun — an estimate
// that grew for no stated reason is worse than one that was simply wrong.
// The server refuses once the client owns the number, and lets a developer
// extend their own task without a management role.
export const addTaskTime = (kpiId, hours, minutes, reason) =>
  action('/kra_kpi/task/add_time', {
    kpi_id: kpiId,
    hours: hours || 0,
    minutes: minutes || 0,
    reason: reason || '',
  });
// meetingWithIds is only meaningful for reason_code 'meeting' — the route
// ignores it otherwise, and validates the ids against real active users.
export const pauseTask   = (kpiId, reason, reasonCode, meetingWithIds) =>
  action('/kra_kpi/task/pause', {
    kpi_id: kpiId,
    reason: reason || '',
    reason_code: reasonCode || false,
    meeting_with_ids: meetingWithIds || [],
  });

// Everyone a meeting can be with — developers, admins AND clients. Deliberately
// not getUsers(), which answers "who can a task be assigned to" and therefore
// excludes clients.
export const fetchPeople = async () => {
  const res = await action('/kra_kpi/get_people', {});
  // action() returns a {status, message} stub with no server configured, and the
  // real route returns a bare array — so anything non-array means mock mode.
  if (Array.isArray(res)) return res;
  return [
    { id: 101, name: 'Ravi Kumar', role: 'developer' },
    { id: 102, name: 'Priya N', role: 'developer' },
    { id: 103, name: 'Mitchell', role: 'admin' },
    { id: 104, name: 'Acme Corp (client)', role: 'client' },
  ];
};
export const reassignTask = (kpiId, userId, reason) =>
  action('/kra_kpi/task/reassign', { kpi_id: kpiId, user_id: userId, reason: reason || '' });

// "I'm moving on to the next thing" — stop one task and start another in ONE
// call. Deliberately not pause-then-start from here: two calls can half-apply,
// leaving the developer stopped with nothing running when the start is refused.
// The server validates the target BEFORE it pauses anything (kra.kpi.switch_to_task).
//
// fromKpiId names the task being handed over. Pass it and ONLY that task pauses —
// which is the whole point under multitask: switching task 1 to task 3 must leave
// task 2's timer ticking. Omit it and every running task pauses.
export const switchTask = (kpiId, fromKpiId, note) =>
  action('/kra_kpi/task/switch', {
    kpi_id: kpiId, from_kpi_id: fromKpiId || null, note: note || '',
  });

// Stop EVERY running timer at once with one shared reason. No task id in the
// payload — the model scopes it to the caller's own running tasks, so it cannot
// be aimed at anyone else. Presence is not double-counted: kpi.break.log keeps
// one active break per user, so a 20-min lunch with two tasks open is 20 minutes.
// meetingWithIds only matters for reason_code 'meeting'; the route ignores it
// otherwise. One break row is opened however many timers stop, so the names are
// recorded once.
export const pauseAllTasks = (reason, reasonCode, meetingWithIds) =>
  action('/kra_kpi/task/pause_all', {
    reason: reason || '', reason_code: reasonCode || 'break',
    meeting_with_ids: meetingWithIds || [],
  });

// Admin pulls a task back out of Awaiting Client Sign-off. Clearing
// admin_approved is what actually takes it off the client's screen — the portal
// selects on two branches, so moving the state alone would leave it visible.
// That rule lives on the server; this only carries the reason, which is required.
export const revertSignoff = (kpiId, reason) =>
  action('/kra_kpi/task/revert_signoff', { kpi_id: kpiId, reason: reason || '' });
// Admin deletes a task NOBODY has worked on. The server owns the rule
// (kra.kpi._may_admin_delete) and ships its answer per task as can_admin_delete —
// never re-derive it here, or the button will offer what the route refuses.
export const adminDeleteTask = (kpiId, reason) =>
  action('/kra_kpi/task/admin_delete', { kpi_id: kpiId, reason: reason || '' });
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

// Progress update, with optional attachments and related links.
//
// Two paths, mirroring exactly what the web detail pane does:
//   files   -> multipart POST /kpi/progress/upload_file  (50 MB each, streamed)
//   none    -> JSON  POST /kpi/progress/create           ("unchanged path")
// Do NOT push a file through /kpi/progress/create: it's the small-payload route,
// and base64 inflates the body ~33% while holding the whole file in memory.
//
// `files` is an ARRAY. An entry keeps its first file on its own Binary field and
// the rest as kpi.file.attachment rows, but that split is the server's business —
// from here it is one update carrying N files, sent as ONE request so it cannot
// half-succeed and leave an entry holding some of what was picked.
export async function submitProgressUpdate(kpiId, { summary, links, files }, onProgress) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, message: 'Mock — not sent to a server' };

  const picked = (files || []).filter((f) => f?.uri);
  if (picked.length) {
    // Both caps matter, and they fail for different reasons. The server refuses
    // any SINGLE file over 50 MB; a set where each file passes can still be a
    // multi-hundred-MB request that dies slowly on a phone connection, so the
    // total is checked too. Refusing here costs nothing — refusing after a
    // ten-minute upload costs the whole upload.
    const tooBig = picked.find((f) => f.size && f.size > MAX_PROGRESS_BYTES);
    if (tooBig) {
      return { status: false, message: `${tooBig.name} is over the 50 MB limit. Add a Drive or GitHub link instead.` };
    }
    const total = picked.reduce((n, f) => n + (f.size || 0), 0);
    if (total > MAX_PROGRESS_BYTES) {
      return { status: false, message: 'Those files come to over 50 MB together. Send them as two updates, or add a Drive or GitHub link.' };
    }
    const fd = new FormData();
    fd.append('kpi_id', String(kpiId));
    fd.append('summary', summary || '');
    fd.append('related_links', JSON.stringify(links || []));
    // The SAME key once per file — that is what files.getlist('file') reads on
    // the route. Numbered keys (file0, file1) would arrive as separate fields
    // and the route would see only the last one.
    for (const f of picked) {
      fd.append('file', {
        uri: f.uri,
        name: f.name || 'file',
        type: f.mimeType || 'application/octet-stream',
      });
    }
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

// Edit an entry already submitted. `clearFile` drops the entry's own attachment;
// it is separate from summary/links because "leave the file alone" and "remove
// the file" are different intents and an absent field cannot express the second.
// Server-gated by kpi.progress own-row rules — never re-derive who may edit here,
// read `can_edit` off the row the route sent.
export const updateProgress = (progressId, { summary, links, clearFile } = {}) =>
  action('/kpi/progress/update', {
    progress_id: progressId,
    summary: summary || '',
    related_links: JSON.stringify(links || []),
    clear_file: !!clearFile,
  });

export const deleteProgress = (progressId) =>
  action('/kpi/progress/delete', { progress_id: progressId });

// Bulk delete answers per id rather than failing the batch: the route returns
// `deleted` / `refused` / `missing`, so a selection that spans someone else's
// entry still removes your own instead of refusing the lot.
export const deleteProgressBulk = (progressIds) =>
  action('/kpi/progress/delete_bulk', { progress_ids: progressIds || [] });

// A progress file's bytes, for View / Download. Base64 over the authenticated
// JSON channel — an <Image> or external browser pointed at /kpi/progress/view
// sends no session cookie and lands on the login page instead of the file.
// `attachmentId` addresses one of the entry's EXTRA files (the 2nd..Nth); the
// entry's own first file is still addressed by progress_id. The web serves the
// extras over /kpi/attachment/download, which is no use here — that route is
// type='http' and an app request carries no session cookie, so it would land on
// the login page. Same authenticated JSON door, one more id.
export async function fetchProgressFile(progressId, attachmentId = 0) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: false, message: 'No server connection' };
  try {
    // 60s: a 50 MB file is ~67 MB of base64 coming back.
    const res = await jsonRpc(serverUrl, '/kpi/progress/file_b64',
      attachmentId ? { attachment_id: attachmentId } : { progress_id: progressId }, 60000);
    return res || { status: false, message: 'Empty response' };
  } catch (e) {
    log.warn('fetchProgressFile failed', e?.message);
    return { status: false, message: 'Could not fetch the file' };
  }
}

// Same, for a user-manual file — including its extras.
//
// `attachmentId` addresses one of the 2nd..Nth documents on a manual; the manual's
// own first file is still addressed by manual_id. Mirrors fetchProgressFile: the
// web serves the extras over /kpi/attachment/download, which is type='http' and so
// lands an app request on the login page.
export async function fetchManualFile(manualId, attachmentId = 0) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: false, message: 'No server connection' };
  try {
    const res = await jsonRpc(serverUrl, '/kpi/manual/file_b64',
      attachmentId ? { attachment_id: attachmentId } : { manual_id: manualId }, 60000);
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

// Manager-only: rename a task, retype it, or move it to another KRA.
//
// Changing the type is not just a label — the server strips the old [Bug]/[Update]
// prefix off the name, applies the new one, and rewrites the REQ/UPD/BUG token in
// the external_ref to match. So the name that comes back may differ from the one
// sent, which is why the caller reloads rather than trusting its own input.
//
// `confirmClientMove` is a deliberate second step. Moving a task to a KRA under a
// DIFFERENT client root is refused with { needs_confirm: true, from_client, to_client }
// until it is passed, because a mis-tap in a long project list looks exactly like a
// deliberate move — and it would put one client's work in another client's project.
export const updateTaskMeta = (kpiId, { name, type, kraId, confirmClientMove } = {}) =>
  action('/kpi_action/update_meta', {
    id: kpiId,
    name: name || '',
    type: type || false,
    kra_id: kraId || false,
    confirm_client_move: !!confirmClientMove,
  });

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
  // Stopping for the day. A quick chip because it is used at a predictable
  // moment every single day, and filing it as Break or Lunch was untrue and
  // polluted those buckets. It ONLY labels the pause — the workday stays open
  // until End Workday, which is a separate and irreversible decision.
  { code: 'day_end', label: 'Day End', emoji: '🌙', quick: true },
  { code: 'priority_task', label: 'Another Priority Task' },
  { code: 'awaiting_approval', label: 'Waiting for Approval' },
  { code: 'technical_issue', label: 'Technical Issue' },
  { code: 'leave', label: 'Leave' },
  { code: 'other', label: 'Other', emoji: '✍', quick: true },
  { code: 'urgent', label: 'Urgent', emoji: '🚨', quick: true },
];

// One-tap reason change on a break that is ALREADY open. The three that a break
// realistically turns into — a break becomes a meeting, lunch runs into a
// meeting — and nothing else: switching to 'other' or 'urgent' needs a note, so
// those stay in the full pause picker where there is a box to type it in.
//
// Deliberately not resume-then-pause. That is two calls that can half-apply, and
// it also banks a spurious run of task time between them; switch_break closes one
// break and opens the next at the SAME instant, so the day stays whole.
export const BREAK_SWITCH_REASONS = [
  { code: 'break', label: 'Break', emoji: '☕' },
  { code: 'lunch', label: 'Lunch', emoji: '🍽' },
  { code: 'meeting', label: 'Meeting', emoji: '👥' },
];

// No task id: the route scopes to the caller's own open break, so it cannot be
// aimed at anyone else. Switching to the reason already in force is a no-op
// server-side, not an error.
export const switchBreak = (reasonCode) =>
  action('/kra_kpi/break/switch', { reason_code: reasonCode });

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
// Freeze the whole day without ending it — tasks stop, Presence stops, and it can
// be resumed the SAME date. End Workday cannot be undone (one start + one end),
// which is why pausing is a separate action.
export const pauseWorkday = (note = '') => action('/kpi_workday/pause', { note });
export const resumeWorkday = () => action('/kpi_workday/resume', {});

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
  // active_tasks = EVERY running timer (multitask); active_task is the first of
  // them, kept so an older server that doesn't send the list still renders.
  if (!serverUrl) return { status: true, workday_open: false, active_task: false, active_tasks: [], active_break: false };
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
// userId is ADMIN-ONLY — the route validates it and forces a non-admin caller to
// themselves, so sending it from a developer changes nothing.
export const selfCreateTask = ({ name, kraId, estimateHours, estimateMinutes, priority, description, userId }) =>
  action('/kra_kpi/task/self_create', {
    name: name || '',
    kra_id: kraId,
    estimate_hours: estimateHours || 0,
    estimate_minutes: estimateMinutes || 0,
    priority: priority || 'regular',
    description: description || '',
    user_id: userId || 0,
  });
