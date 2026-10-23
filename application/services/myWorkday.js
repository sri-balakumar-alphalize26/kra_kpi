// My Workday — a developer's OWN daily workday report (presence, productive hours, tasks).
// Wraps /kpi_reports/my_workday, which is HARD-SCOPED server-side to the logged-in user,
// so this only ever returns the current user's own days. Mock-safe with no server.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('MyWorkday');

// Returns { status, user_name, from_date, to_date, days:[{date, presence_display,
// productive_display, session_count, task_count, tasks:[{ref,name,hours_display}]}] }.
export async function fetchMyWorkday(fromDate, toDate) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    log.info('fetchMyWorkday — no server, mock');
    return { status: true, days: [], isMock: true };
  }
  const params = {};
  if (fromDate) params.from_date = fromDate;
  if (toDate) params.to_date = toDate;
  const res = await jsonRpc(serverUrl, '/kpi_reports/my_workday', params);
  log.info('my workday ←', { days: res?.days?.length ?? 0, status: res?.status });
  return res || { status: false, days: [] };
}
