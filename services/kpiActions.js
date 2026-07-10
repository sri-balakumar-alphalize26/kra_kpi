// KPI Action Board data service. Mirrors the Odoo controller routes used by the
// board (kra_api.py). Returns the SAME task shape as /kra_kpi/tasks/get so the
// screen never changes when live. Falls back to mock data when no server is set.
//
// Task shape (from get_tasks map_rec):
//   { id, name, priority, task_state, user_id, user_name, estimate_display,
//     estimate_hours, estimate_minutes, timer_total_seconds, timer_start_datetime,
//     paused_reason, description, progress_count, is_self_created, admin_accepted, ... }

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
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

// Submit a progress summary. The server REQUIRES one before complete/partial.
export const createProgress = (kpiId, summary) =>
  action('/kpi/progress/create', { kpi_id: kpiId, summary: summary || '' });

// The 5 employee-checklist keys the server expects for a full Complete.
export const CHECKLIST_ITEMS = [
  { key: 'verify_github', label: 'Verified GitHub URL' },
  { key: 'deployed_task', label: 'Deployed the task' },
  { key: 'user_manual', label: 'User manual uploaded' },
  { key: 'documentation', label: 'Documentation submitted' },
  { key: 'tested_code', label: 'Manually tested the code' },
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

// Priorities for the New Task form.
export const PRIORITIES = [
  { code: 'regular', label: 'Regular' },
  { code: 'important', label: 'Important' },
  { code: 'urgent', label: 'Urgent' },
];

// ── Workday (Start / End) ────────────────────────────────────────────────────
export async function getWorkdayStatus() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, is_open: false, today_closed: false };
  const res = await jsonRpc(serverUrl, '/kpi_workday/status', {});
  log.info('workday status ←', { is_open: res?.is_open, today_closed: res?.today_closed });
  return res || { is_open: false };
}
export const startWorkday = () => action('/kpi_workday/ping', {});
export const endWorkday = (note = '') => action('/kpi_workday/end', { note });

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
