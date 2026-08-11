// Admin Live Tracking — every developer's CURRENT activity + attendance.
// Wraps /kpi_owner/live_tracking (controllers/kpi_reports_api.py), which is gated
// server-side to Owner / Coordinator / System. Mock-safe with no server.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('LiveTracking');

// Offline demo shape — mirrors the route's payload so the screen renders without a
// server (matches services/loginManagement.js etc.).
const MOCK = {
  status: true, as_of: '', cutoff_display: '10:40',
  total: 3, present_count: 2, active_count: 1, absent_count: 1, late_count: 1,
  rows: [
    { user_id: 1, name: 'Ravi', attendance: 'present', arrival: '09:20', started: true, active: true, activity_kind: 'task', activity_label: 'Fix login bug', elapsed_seconds: 11040, elapsed_display: '3h 4min' },
    { user_id: 2, name: 'Salim', attendance: 'late', arrival: '12:00', started: true, active: false, activity_kind: 'break', activity_label: 'Break', elapsed_seconds: 900, elapsed_display: '15 min' },
    { user_id: 3, name: 'Meera', attendance: 'absent', arrival: '', started: false, active: false, activity_kind: 'offline', activity_label: '', elapsed_seconds: 0, elapsed_display: '' },
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
