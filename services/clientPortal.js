// Client-portal data service — the app's CLIENT role. Every route here is
// caller-scoped SERVER-SIDE (by kra.master.client_user_ids), so a client only
// ever sees / creates data under their own client. Used by the Client "My Tasks"
// screen and to auto-fill the read-only project on the Upload screens.
import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('ClientPortal');

// The client's own tasks + status totals (server scopes to the caller's client).
export async function getClientDashboard(state) {
  const { serverUrl, db } = await getConnection();
  if (!serverUrl) return { authorized: false, kpis: [], totals: {}, pending_approvals: [] };
  const res = await jsonRpc(serverUrl, '/kpi_client_portal/dashboard', { state: state || 'all' }, undefined, db);
  if (!res || res.status === false) throw new Error(res?.message || 'Could not load your tasks');
  log.info('dashboard ←', { authorized: res.authorized, count: (res.kpis || []).length });
  return {
    authorized: res.authorized !== false,
    message: res.message || '',
    kpis: res.kpis || [],
    totals: res.totals || {},
    by_type: res.by_type || {},
    pending_approvals: res.pending_approvals || [],
    clients: res.clients || [],
  };
}

// The client's own project(s) — [{ id, display }]. Used to auto-fill the upload
// project (read-only) for a client. `id` is exactly the sub_kra_id the create
// route wants.
export async function getClientProjects() {
  const { serverUrl, db } = await getConnection();
  if (!serverUrl) return { projects: [] };
  const res = await jsonRpc(serverUrl, '/kpi_client_portal/get_projects', {}, undefined, db);
  if (!res || res.status === false) throw new Error(res?.message || 'Could not load your project');
  log.info('projects ←', { count: (res.projects || []).length });
  return { projects: res.projects || [] };
}

// The client's saved signature image, if they uploaded one on the web portal.
// When it exists, sign-off needs no typed name — the server accepts the saved
// signature and stamps the account name (see _resolve_client_signature). The app
// had no idea this existed, so it demanded a typed name on every task even from
// clients who had already uploaded one.
//
// Never throws: a signature is an optional convenience, and failing to load it
// must not stop someone signing off. On any error we report "no signature",
// which falls back to the normal typed-name flow.
export async function getClientSignature() {
  try {
    const { serverUrl, db } = await getConnection();
    if (!serverUrl) return { hasSignature: false, imageB64: '' };
    const res = await jsonRpc(serverUrl, '/kpi_client_portal/get_signature_info', {}, undefined, db);
    if (!res || res.status === false) return { hasSignature: false, imageB64: '' };
    log.info('signature ←', { has: !!res.has_signature });
    return { hasSignature: !!res.has_signature, imageB64: res.image_b64 || '' };
  } catch (e) {
    log.info('signature lookup failed, falling back to typed name', e?.message);
    return { hasSignature: false, imageB64: '' };
  }
}
