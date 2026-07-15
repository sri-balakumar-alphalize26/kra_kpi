// CLIENT TASK QUEUE (admin) — client-submitted tasks that are NOT yet visible to
// the team (published=False, client_submitted=True). The admin fills in the
// missing details (ref, estimate, developer) and publishes each one, which fires
// the client pre-approval. Wraps /kpi_pending_queue/* in kpi_reports_api.py.
//
// NOTE on gating: /kpi_pending_queue/list has NO server-side admin guard (it
// sudo-searches for any logged-in user), while update/publish/delete DO enforce
// group_kra_admin | base.group_system. So the screen must gate itself — see
// ClientTaskQueue.js.
import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('PendingQueue');
// The list route builds per-task "Linked Req" options with a search per row, so
// a big queue can outrun the default 10s window.
const LONG = 45000;

async function server() {
  const { serverUrl } = await getConnection();
  return serverUrl || '';
}

// The queue. Each row already carries its own `req_options` for the Linked Req
// dropdown, so no extra lookup is needed.
// Row: { id, name, kind, client_name, project_name, project_id, external_ref,
//        related_req_ref, priority, description, estimate_hours,
//        estimate_minutes, user_id, user_name, submitted_by, submitted_login,
//        received_at, req_options:[{ref,label}], rejected, reject_reason,
//        rejected_by, rejected_at }
// `received_at` / `rejected_at` arrive pre-formatted 'YYYY-MM-DD HH:MM' — render
// them as-is, do NOT parse.
export async function fetchQueue() {
  const base = await server();
  if (!base) return { isMock: true, queue: [] };
  log.info('fetchQueue → /kpi_pending_queue/list');
  const res = await jsonRpc(base, '/kpi_pending_queue/list', {}, LONG);
  if (!res || res.status === false) {
    log.error('fetchQueue ✗', res?.message);
    throw new Error(res?.message || 'Could not load the client task queue');
  }
  log.info('fetchQueue ←', { count: (res.queue || []).length });
  return { isMock: false, queue: res.queue || [] };
}

// Save one queued task. Only the keys passed are written server-side.
export async function saveQueueTask(t) {
  const base = await server();
  if (!base) return { status: true };
  const payload = {
    kpi_id: t.id,
    name: t.name || '',
    description: t.description || '',
    external_ref: t.external_ref || '',
    related_req_ref: t.related_req_ref || '',
    priority: t.priority || 'regular',
    estimate_hours: Number(t.estimate_hours) || 0,
    estimate_minutes: Number(t.estimate_minutes) || 0,
    user_id: t.user_id ? Number(t.user_id) : false,
  };
  log.info('saveQueueTask → /kpi_pending_queue/update', { kpi_id: payload.kpi_id, user_id: payload.user_id });
  const res = await jsonRpc(base, '/kpi_pending_queue/update', payload, LONG);
  if (!res || res.status === false) {
    log.error('saveQueueTask ✗', res?.message);
    throw new Error(res?.message || 'Could not save the task');
  }
  return res;
}

// Publish → releases the task to the team AND asks the client to approve the
// assigned developer. Returns the RAW response on purpose: the server answers
// {status:false, message:'Assign a developer before publishing this task.'} when
// no developer is set — that's a message to show the admin, not an exception.
// {status:true} with an "Already published" message is also a normal outcome.
export async function publishQueueTask(kpiId) {
  const base = await server();
  if (!base) return { status: true, message: 'Published (offline demo)' };
  log.info('publishQueueTask → /kpi_pending_queue/publish', { kpi_id: kpiId });
  const res = await jsonRpc(base, '/kpi_pending_queue/publish', { kpi_id: kpiId }, LONG);
  log.info('publishQueueTask ←', { status: res?.status, message: res?.message });
  return res || { status: false, message: 'No response from the server' };
}

// Discard — a PERMANENT delete server-side (unlink, not archive). The caller must
// confirm first.
export async function discardQueueTask(kpiId, reason) {
  const base = await server();
  if (!base) return { status: true };
  log.info('discardQueueTask → /kpi_pending_queue/delete', { kpi_id: kpiId });
  const res = await jsonRpc(base, '/kpi_pending_queue/delete', { kpi_id: kpiId, reason: reason || '' }, LONG);
  if (!res || res.status === false) {
    log.error('discardQueueTask ✗', res?.message);
    throw new Error(res?.message || 'Could not discard the task');
  }
  return res;
}
