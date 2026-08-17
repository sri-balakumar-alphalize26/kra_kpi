// Admin Live Tracking — every developer's CURRENT activity + attendance.
// Wraps /kpi_owner/live_tracking (controllers/kpi_reports_api.py), which is gated
// server-side to Owner / Coordinator / System. Mock-safe with no server.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('LiveTracking');

// Offline demo shape — mirrors the route's payload so the screen renders without a
// server (matches services/loginManagement.js etc.).
// The mock had drifted well behind the route: no active_tasks, no
// active_task_count, no activity_note, no reopened_reason, no day_done. So the
// three things the screen exists to show — multi-tasking, why someone is away,
// and the Reopen button — could never appear in demo mode, and anyone judging
// the screen from a disconnected device would conclude they were missing.
const MOCK = {
  status: true, as_of: '09:41', cutoff_display: '10:40',
  total: 4, present_count: 3, active_count: 2, absent_count: 1, late_count: 1,
  rows: [
    // Multi-tasking: two timers at once, which is what active_tasks is for.
    { user_id: 1, name: 'Ravi', attendance: 'present', arrival: '09:20', started: true, active: true,
      activity_kind: 'task', activity_label: 'Fix login bug', elapsed_seconds: 11040, elapsed_display: '3h 4min',
      active_task_count: 2,
      active_tasks: [
        { id: 101, name: 'Fix login bug', elapsed_seconds: 11040, elapsed_display: '3h 4min' },
        { id: 102, name: 'Invoice PDF spacing', elapsed_seconds: 2400, elapsed_display: '40 min' },
      ] },
    // Away, with the note that decides whether anyone needs to chase it.
    { user_id: 2, name: 'Salim', attendance: 'late', arrival: '12:00', started: true, active: false,
      activity_kind: 'break', activity_label: 'Break', elapsed_seconds: 900, elapsed_display: '15 min',
      activity_note: 'Dentist — back by 2. Ping me if the client calls about the invoice run.' },
    // Ended their day and had it reopened: exercises both the amber note and the
    // Reopen button, which are otherwise unreachable offline.
    { user_id: 4, name: 'Priya', attendance: 'present', arrival: '09:05', started: true, active: false,
      activity_kind: 'idle', activity_label: '', elapsed_seconds: 0, elapsed_display: '',
      day_done: true, reopened_by: 'Administrator', reopened_reason: 'Timesheet was missing the Friday deploy.' },
    { user_id: 3, name: 'Meera', attendance: 'absent', arrival: '', started: false, active: false,
      activity_kind: 'offline', activity_label: '', elapsed_seconds: 0, elapsed_display: '' },
  ],
};

// Returns { status, as_of, cutoff_display, total, present_count, active_count,
// absent_count, late_count, rows:[{user_id, name, attendance, arrival, started,
// active, activity_kind, activity_label, elapsed_seconds, elapsed_display}] }.
export async function fetchLiveTracking() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    log.info('fetchLiveTracking — no server, mock');
    return { ...MOCK, isMock: true };
  }
  const res = await jsonRpc(serverUrl, '/kpi_owner/live_tracking', {});
  log.info('live tracking ←', { rows: res?.rows?.length ?? 0, status: res?.status });
  return res || { status: false, rows: [] };
}

// Reopen a developer's workday after they explicitly ended it. Admin-only, and
// the server enforces that plus "today only" plus a non-empty reason — the
// developer is told in the admin's own words, so there is nothing useful to send
// without one. Mirrors the web's Live Tracking button.
export async function revertWorkday(userId, reason) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    log.info('revertWorkday — no server, mock');
    return { status: false, message: 'No server is configured — nothing was reopened.' };
  }
  const res = await jsonRpc(serverUrl, '/kpi_workday/revert',
    { user_id: userId, reason: reason || '' });
  log.info('revertWorkday ←', { user_id: userId, status: res?.status, message: res?.message });
  return res || { status: false, message: 'Could not reopen that workday.' };
}
