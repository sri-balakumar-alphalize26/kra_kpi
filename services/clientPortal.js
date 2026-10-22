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

// The signed completion certificate as base64, ready to write to a file. The app
// cannot use the http download route (it does not send the session cookie), which is
// why this JSON sibling exists — the same reason the invoice PDF has one.
export async function fetchCertificatePdf(kpiId) {
  const { serverUrl, db } = await getConnection();
  if (!serverUrl) return { status: false, message: 'No server connection' };
  try {
    return (await jsonRpc(serverUrl, '/kpi_completion_cert/pdf_b64', { kpi_id: kpiId }, 60000, db))
      || { status: false };
  } catch (e) {
    return { status: false, message: e?.message || 'Could not fetch the certificate' };
  }
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

// Remove the saved signature. There is no delete route: the upload route treats
// an empty file_data as the delete, and the server resolves '' to False.
//
// Unlike the lookup this DOES report failure, because the caller is a person who
// just asked for something to be removed. Quietly answering "no signature" when
// it is still stored would be a lie they only discover at the next sign-off.
// Removing it is safe: sign-off falls back to the typed name.
export async function removeClientSignature() {
  const { serverUrl, db } = await getConnection();
  if (!serverUrl) return { status: false, message: 'Not connected to a server.' };
  const res = await jsonRpc(
    serverUrl, '/kpi_client_portal/upload_signature',
    { file_data: '', file_name: '' }, undefined, db);
  log.info('signature removed', { has: !!res?.has_signature });
  // Trust the server's own answer about what is stored now, rather than assuming
  // the write did what was asked.
  return { status: !!res?.status, hasSignature: !!res?.has_signature, message: res?.message || '' };
}

// Raise ONE task as the client — used for a Bug / Update "from the old system",
// the one case the bulk upload route cannot take: there is no requirement to
// pick, and a voice note / photo / video has to travel WITH the task so the
// server can count it (models/kpi_legacy.py legacy_input_problem). The bulk
// route only sees the typed fields.
//
// `attachments: [{ name, data_b64, mimetype }]` (25 MB in total). Voice notes
// must be named "Voice note 1 (0m07s).m4a" — the server reads the length back
// from the name. Returns { status, kpi_id, name, ref } or { status:false, message }.
export async function addClientTask({
  subKraId, kind, name, description, priority, attachments,
  legacyOn, legacyRef, legacyName, legacyNote, parentId,
}) {
  const { serverUrl, db } = await getConnection();
  if (!serverUrl) return { status: false, message: 'Not connected to a server.' };
  const payload = {
    sub_kra_id: subKraId,
    kind: kind || 'bug',
    name: name || '',
    description: description || '',
    priority: priority || 'regular',
    attachments: attachments || [],
    ...(legacyOn
      ? { legacy_on: true, legacy_ref: legacyRef || '', legacy_name: legacyName || '', legacy_note: legacyNote || '' }
      : { parent_id: parentId || false }),
  };
  log.info('add_task →', {
    sub_kra_id: subKraId, kind: payload.kind, legacy_on: !!legacyOn,
    files: payload.attachments.length,
    bytesB64: payload.attachments.reduce((n, a) => n + (a.data_b64 || '').length, 0),
  });
  // 60s: the files ride in the JSON body as base64.
  const res = await jsonRpc(serverUrl, '/kpi_client_portal/add_task', payload, 60000, db);
  if (!res || res.status === false) {
    log.warn('add_task ✗', res?.message);
    return { status: false, message: res?.message || 'Could not send the task' };
  }
  log.info('add_task ←', { kpi_id: res.kpi_id, ref: res.ref });
  return res;
}

// The client's requirements a Bug / Update can be about, newest first —
// [{ id, ref, name, date, db, old }]. `old` marks an Old DB placeholder.
export async function getParentTasks(subKraId) {
  const { serverUrl, db } = await getConnection();
  if (!serverUrl) return { tasks: [] };
  const res = await jsonRpc(serverUrl, '/kpi_client_portal/parent_tasks',
    subKraId ? { sub_kra_id: subKraId } : {}, undefined, db);
  if (!res || res.status === false) throw new Error(res?.message || 'Could not load your requirements');
  log.info('parent_tasks ←', { count: (res.tasks || []).length });
  return { tasks: res.tasks || [] };
}
