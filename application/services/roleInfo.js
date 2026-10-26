// ROLE LOOKUP that survives a flaky network — shared by the admin-gated screens.
//
// Home and the Client Task Queue used to ask /kpi_user/info ONCE and, on any
// error, decide "developer" / "Admins only" for good: an admin whose phone was
// briefly offline at launch lost every admin tile until an app restart, and the
// queue told them "You're signed in as: User". The server's answer is now
// cached per uid in the same role state App.js's gate already keeps
// (session.getRoleState / saveRoleState, { kpiRole }), so a failed lookup
// reuses the last known role instead of guessing, and callers retry.
import { getConnection, getSession, getRoleState, saveRoleState } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('RoleInfo');

// Gaps between automatic retries after a failed lookup. Short first (a blip),
// then longer so a phone that is genuinely offline is not hammered.
export const ROLE_RETRY_MS = [3000, 8000, 20000, 60000];

async function resolveUid(uid) {
  if (uid != null) return uid;
  try { const u = await getSession(); return u?.uid ?? null; } catch (_) { return null; }
}

/** The last role the SERVER gave for this user, or '' when never resolved. */
export async function cachedKpiRole(uid) {
  const st = await getRoleState(await resolveUid(uid));
  return (st && st.kpiRole) || '';
}

/**
 * Ask the server who this is. Resolves to
 *   { info, kpiRole, fromServer: true }            — a real answer (cached for next time)
 *   { info: null, kpiRole: <cached>, fromServer: false, error } — unreachable / failed
 *   { info: { isMock: true }, kpiRole: 'admin', fromServer: false, offlineDemo: true } — no server
 * Never throws. kpiRole is 'admin' | 'client' | 'developer' | ''.
 * A coordinator already reports as 'admin' on this route (kpi_reports_api.py).
 */
export async function fetchRoleInfo(uid) {
  const id = await resolveUid(uid);
  try {
    const { serverUrl } = await getConnection();
    if (!serverUrl) return { info: { isMock: true }, kpiRole: 'admin', fromServer: false, offlineDemo: true };
    const info = await jsonRpc(serverUrl, '/kpi_user/info', {});
    // {status:false} is the route's own exception path — a failure, not a role.
    if (!info || info.status === false) throw new Error(info?.message || '/kpi_user/info failed');
    let kpiRole = info.kpi_role || '';
    if (!kpiRole) {
      // An older server without kpi_role: derive it from the flags.
      kpiRole = (info.is_system || info.is_owner || info.is_admin) ? 'admin'
        : info.is_client ? 'client' : 'developer';
    }
    if (kpiRole === 'user') kpiRole = 'developer';
    // Merge, so anything else App.js keeps in the role state survives.
    const prev = (await getRoleState(id)) || {};
    if (prev.kpiRole !== kpiRole) saveRoleState(id, { ...prev, kpiRole });
    return { info, kpiRole, fromServer: true };
  } catch (e) {
    const kpiRole = await cachedKpiRole(id);
    log.warn('role lookup failed, using cached role', { cached: kpiRole || '(none)', err: e?.message });
    return { info: null, kpiRole, fromServer: false, error: e };
  }
}
