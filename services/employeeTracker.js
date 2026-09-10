// EMPLOYEE TRACKER — the team-wide presence / productive report.
//
// Wraps /kpi_reports/developer_summary, the same route the Odoo web screen
// (kpi_developer_summary.js) calls, with the same four parameters.
//
// Why the app needed this at all: HomeScreen hides My Workday from admins with
// the reasoning "admins use the team-wide reports instead" — and on the phone
// there were none. An admin had no team report anywhere.
//
// Everything below is computed server-side and rendered verbatim. In particular
// the report folds RUNNING time logs into the totals live (a running log stores a
// duration of 0 until it stops), so the figures tick with the work instead of
// freezing until someone pauses — recomputing any of it here would only be a
// second opinion that drifts.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('EmployeeTracker');

export const TIME_FRAMES = [
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
];

// The people picker. Same route the web's own dropdown uses.
export async function fetchTrackerEmployees() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return [];
  try {
    const res = await jsonRpc(serverUrl, '/kpi_reports/employee/get_employees', {});
    return res?.employees || [];
  } catch (e) {
    log.warn('employee list failed', e?.message);
    return [];
  }
}

// `periods` is one row per (person, period) with its sessions and its per-task
// breakdown already attached — the drill-down needs no second call.
//
// Dates are optional: omit them and the server picks a window that suits the
// time frame (30 days / 12 weeks / 180 days), which is why they are sent as null
// rather than as today's date.
export async function fetchDeveloperSummary({ timeFrame = 'daily', userId = null, fromDate = null, toDate = null } = {}) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, periods: [], isMock: true };
  const params = {
    time_frame: timeFrame,
    user_id: userId || null,
    from_date: fromDate || null,
    to_date: toDate || null,
  };
  log.info('developer summary →', params);
  const res = await jsonRpc(serverUrl, '/kpi_reports/developer_summary', params, 60000);
  if (!res || res.status === false) {
    // The route answers "Not authorized." for anyone below Coordinator rather
    // than raising, so pass its own words through instead of inventing some.
    return { status: false, message: res?.message || 'Could not load the report.', periods: [] };
  }
  log.info('developer summary ←', { periods: (res.periods || []).length });
  return { status: true, periods: res.periods || [], timeFrame: res.time_frame, fromDate: res.from_date, toDate: res.to_date };
}
