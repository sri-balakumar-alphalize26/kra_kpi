// Admin-only "Reassignment History" data service — the GLOBAL list of every KPI
// task reassignment (newest first). Calls /kra_kpi/reassignment_history/all,
// which is admin-guarded server-side (_is_kra_admin: Coordinator/Owner/System).
// Mirrors the clientPortal.js service shape.
import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('ReassignHistory');
const LONG = 30000; // a large history list can be heavier than the 10s default

// Returns { authorized, history: [{ id, reassignment_date, kpi_task, kpi_name,
//   previous_assignee, new_assignee, reassigned_by, previous_state, time_spent,
//   reason, was_paused, pause_reason }] }. authorized=false when the caller
// isn't an admin (the route returns {status:false, message:'Not authorized'}).
export async function getReassignmentHistory(limit = 200) {
  const { serverUrl, db } = await getConnection();
  if (!serverUrl) return { authorized: true, history: [] }; // offline demo → empty
  const res = await jsonRpc(serverUrl, '/kra_kpi/reassignment_history/all', { limit }, LONG, db);
  if (!res || res.status === false) {
    const msg = res?.message || 'Could not load reassignment history';
    if (/not authorized/i.test(msg)) { log.warn('history: not authorized'); return { authorized: false, history: [] }; }
    log.error('history ✗', msg);
    throw new Error(msg);
  }
  log.info('history ←', { count: (res.history || []).length });
  return { authorized: true, history: res.history || [] };
}
