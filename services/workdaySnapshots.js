// Workday Snapshots — the frozen End-Workday summary images, for admins.
// Wraps /kpi_workday_snapshot/* in controllers/kpi_reports_api.py.
// Mock-safe with no server, like the other services here.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('Snapshots');

// The tree: [{date, label, devs:[{snapshot_id, name, presence_display, met_standard, ...}]}]
// Carries NO image bytes on purpose — weeks of days would be megabytes of JSON
// for pictures nobody has opened. One image is fetched only when a row expands.
export async function fetchSnapshots(limitDays = 30) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    log.info('fetchSnapshots — no server, mock');
    return { status: true, days: [], isMock: true };
  }
  const res = await jsonRpc(serverUrl, '/kpi_workday_snapshot/list', { limit_days: limitDays });
  log.info('snapshots ←', { days: res?.days?.length ?? 0, status: res?.status });
  return res || { status: false, days: [] };
}

// ONE image, base64.
//
// This MUST go over the authenticated JSON channel. React Native's <Image> loader
// sends no session cookie, so handing it an Odoo /web/image URL silently lands on
// the login page and renders nothing — the same trap already documented on
// /kpi/progress/file_b64. The web board can use /web/image directly; the app can't.
export async function fetchSnapshotImage(snapshotId) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: false, message: 'No server' };
  const res = await jsonRpc(serverUrl, '/kpi_workday_snapshot/image_b64', { snapshot_id: snapshotId });
  log.info('snapshot image ←', { id: snapshotId, status: res?.status, name: res?.file_name });
  return res || { status: false };
}

// ── My Snapshots — the current user's OWN days only ──────────────────────────
// Hard-scoped server-side to request.env.user (the route ignores any user_id), so
// a regular user only ever gets their own snapshot images.
export async function fetchMySnapshots(limitDays = 30) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    log.info('fetchMySnapshots — no server, mock');
    return { status: true, days: [], isMock: true };
  }
  const res = await jsonRpc(serverUrl, '/kpi_workday_snapshot/my_list', { limit_days: limitDays });
  log.info('my snapshots ←', { days: res?.days?.length ?? 0, status: res?.status });
  return res || { status: false, days: [] };
}

export async function fetchMySnapshotImage(snapshotId) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: false, message: 'No server' };
  const res = await jsonRpc(serverUrl, '/kpi_workday_snapshot/my_image_b64', { snapshot_id: snapshotId });
  log.info('my snapshot image ←', { id: snapshotId, status: res?.status, name: res?.file_name });
  return res || { status: false };
}
