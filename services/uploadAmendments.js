// Data service for the "Upload Updates & Amendments" screen (Odoo
// kra_kpi_module). Mirrors the OWL component kpi_requirements_upload.js: same
// routes, same params, same doc_type contract. Falls back to mock data when no
// Odoo server is configured so the screen is reviewable in Expo offline.
//
// doc_type is 'requirement' | 'update' | 'bug'. This screen is the "Updates"
// mode, so it defaults to 'update', but the service is doc_type-agnostic.

import { getConnection } from '../api/session';
import { jsonRpc, normalizeUrl } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('UploadSvc');

// AI suggestions and bulk writes can exceed the default 10s window.
const LONG_TIMEOUT = 45000;

// Server-side ref prefixes (peek_next_ref returns the authoritative values;
// these are only used for the offline mock).
export const REF_PREFIX = { requirement: 'REQ', update: 'UPT', bug: 'BUG' };

// doc_type → template_name in the /template/<name> download URL.
export const TEMPLATE_NAME = { requirement: 'requirement', update: 'update', bug: 'bug_report' };

export const PRIORITIES = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'important', label: 'Important' },
  { value: 'regular', label: 'Regular' },
];

async function server() {
  const { serverUrl } = await getConnection();
  return serverUrl || '';
}

// ---- Mock data (offline) --------------------------------------------------

const MOCK_CLIENTS = [
  { id: 1, name: 'Goldenspoon', parent_name: '', project_quoted_hours: 120 },
  { id: 2, name: 'Acme Corp', parent_name: '', project_quoted_hours: 80 },
];
const MOCK_SUBKRAS = {
  1: [
    { id: 11, name: 'Website Revamp', display: 'Goldenspoon > Website Revamp' },
    { id: 12, name: 'Mobile App', display: 'Goldenspoon > Mobile App' },
  ],
  2: [{ id: 21, name: 'ERP Rollout', display: 'Acme Corp > ERP Rollout' }],
};
const MOCK_USERS = [
  { id: 2, name: 'Admin', login: 'admin' },
  { id: 7, name: 'Priya Dev', login: 'priya' },
  { id: 8, name: 'Ravi Kumar', login: 'ravi' },
];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Load-time reads ------------------------------------------------------

// { is_client_only } — decides whether the Developer picker shows (clients set
// their own Hours/Min/Priority, but never assign a developer).
export async function getUserInfo() {
  const base = await server();
  if (!base) { log.info('getUserInfo: no server → mock (is_client_only=false)'); return { isMock: true, is_client_only: false }; }
  log.info('getUserInfo → /kpi_user/info');
  const res = await jsonRpc(base, '/kpi_user/info', {});
  if (!res || res.status === false) { log.error('getUserInfo ✗ bad response', res); throw new Error('Could not load user info'); }
  log.info('getUserInfo ←', { is_client_only: res.is_client_only, name: res.name, login: res.login });
  return { isMock: false, ...res };
}

// Client (Root KRA) list.
export async function getClients() {
  const base = await server();
  if (!base) { log.info('getClients: no server → mock'); await delay(250); return { isMock: true, clients: MOCK_CLIENTS }; }
  log.info('getClients → /kpi_client_invoice/get_filters');
  const res = await jsonRpc(base, '/kpi_client_invoice/get_filters', {});
  if (!res || res.status === false) { log.error('getClients ✗ bad response', res); throw new Error('Could not load clients'); }
  log.info('getClients ←', { count: (res.clients || []).length });
  return { isMock: false, clients: res.clients || [] };
}

// Project / Sub-KRA list for a chosen client (all descendants, breadcrumbed).
export async function getSubKras(clientKraId) {
  const base = await server();
  if (!base) { log.info('getSubKras: no server → mock', { clientKraId }); await delay(200); return { isMock: true, kras: MOCK_SUBKRAS[clientKraId] || [] }; }
  log.info('getSubKras → /kpi_completion_cert/get_sub_kras', { client_kra_id: clientKraId });
  const res = await jsonRpc(base, '/kpi_completion_cert/get_sub_kras', { client_kra_id: clientKraId });
  if (!res || res.status === false) { log.error('getSubKras ✗ bad response', res); throw new Error('Could not load projects'); }
  log.info('getSubKras ←', { clientKraId, count: (res.kras || []).length });
  return { isMock: false, kras: res.kras || [] };
}

// Developer list (internal users).
export async function getUsers() {
  const base = await server();
  if (!base) { log.info('getUsers: no server → mock'); await delay(150); return { isMock: true, users: MOCK_USERS }; }
  log.info('getUsers → /kpi_completion_cert/get_users');
  const res = await jsonRpc(base, '/kpi_completion_cert/get_users', {});
  if (!res || res.status === false) { log.error('getUsers ✗ bad response', res); throw new Error('Could not load developers'); }
  log.info('getUsers ←', { count: (res.users || []).length });
  return { isMock: false, users: res.users || [] };
}

// Preview of the next ref id ({ prefix, next_number }).
export async function peekNextRef(docType) {
  const base = await server();
  if (!base) { log.info('peekNextRef: no server → mock', { docType }); return { isMock: true, prefix: REF_PREFIX[docType] || 'REQ', next_number: 1 }; }
  log.info('peekNextRef → /kpi_requirements/peek_next_ref', { doc_type: docType });
  const res = await jsonRpc(base, '/kpi_requirements/peek_next_ref', { doc_type: docType });
  if (!res || res.status === false) { log.warn('peekNextRef ✗ falling back to default prefix', res); return { isMock: false, prefix: REF_PREFIX[docType] || 'REQ', next_number: 1 }; }
  log.info('peekNextRef ←', { prefix: res.prefix, next_number: res.next_number });
  return { isMock: false, prefix: res.prefix, next_number: res.next_number };
}

// ---- Actions --------------------------------------------------------------

// AI task suggestions from pasted text → { source, tasks: [string], message? }.
export async function suggestTasks(text, docType) {
  const base = await server();
  const textLen = String(text || '').length;
  if (!base) {
    log.info('suggestTasks: no server → offline heuristic', { docType, textLen });
    await delay(500);
    const tasks = String(text || '')
      .split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 3).slice(0, 20);
    log.info('suggestTasks ← (heuristic)', { count: tasks.length });
    return { isMock: true, source: 'heuristic', tasks, message: 'Offline heuristic (no server)' };
  }
  log.info('suggestTasks → /kpi_requirements/suggest_tasks', { doc_type: docType, textLen });
  const res = await jsonRpc(
    base, '/kpi_requirements/suggest_tasks',
    { text: String(text || '').slice(0, 16000), doc_type: docType },
    LONG_TIMEOUT
  );
  if (!res || res.status === false) { log.error('suggestTasks ✗', res?.message, res); throw new Error(res?.message || 'Suggestion failed'); }
  log.info('suggestTasks ←', { source: res.source, count: (res.tasks || []).length });
  return { isMock: false, source: res.source, tasks: res.tasks || [], message: res.message };
}

// Server-side XLSX/CSV parse → { tasks: [{name, external_ref, related_req_ref}], source, matched_column }.
export async function parseFile({ fileData, fileName, docType }) {
  const base = await server();
  const bytesB64 = (fileData || '').length;
  if (!base) {
    log.info('parseFile: no server → mock', { fileName, docType, bytesB64 });
    await delay(300);
    return { isMock: true, tasks: [{ name: `Imported from ${fileName}`, external_ref: '', related_req_ref: '' }], source: 'mock', matched_column: null };
  }
  log.info('parseFile → /kpi_requirements/parse_file', { file_name: fileName, doc_type: docType, bytesB64 });
  const res = await jsonRpc(
    base, '/kpi_requirements/parse_file',
    { file_data: fileData, file_name: fileName, doc_type: docType },
    LONG_TIMEOUT
  );
  if (!res || res.status === false) { log.error('parseFile ✗', res?.message, res); throw new Error(res?.message || 'Could not parse file'); }
  log.info('parseFile ←', { source: res.source, matched_column: res.matched_column, count: (res.tasks || []).length });
  return { isMock: false, tasks: res.tasks || [], source: res.source, matched_column: res.matched_column };
}

// Bulk-create. `tasks` rows must already be in server shape (see buildTaskRow).
// Returns { created_count, kpi_ids }.
export async function createBulkTasks({ subKraId, docType, tasks, fileData, fileName, requirementVersion }) {
  const base = await server();
  const payload = {
    sub_kra_id: subKraId,
    doc_type: docType,
    tasks,
    file_data: fileData || '',
    file_name: fileName || '',
    requirement_version: requirementVersion || '',
  };
  // Log the payload shape without dumping the base64 blob or full task text.
  log.info('createBulkTasks payload', {
    sub_kra_id: subKraId,
    doc_type: docType,
    task_count: tasks.length,
    has_file: !!fileData,
    file_name: fileName || '',
    fileBytesB64: (fileData || '').length,
    requirement_version: requirementVersion || '',
    sample_row: tasks[0] ? { ...tasks[0], name: (tasks[0].name || '').slice(0, 40) } : null,
  });
  if (!base) {
    log.info('createBulkTasks: no server → mock', { count: tasks.length });
    await delay(500);
    return { isMock: true, created_count: tasks.length, kpi_ids: tasks.map((_, i) => 1000 + i) };
  }
  log.info('createBulkTasks → /kpi_requirements/create_bulk_tasks');
  const res = await jsonRpc(base, '/kpi_requirements/create_bulk_tasks', payload, LONG_TIMEOUT);
  if (!res || res.status === false) { log.error('createBulkTasks ✗', res?.message, res); throw new Error(res?.message || 'Task creation failed'); }
  log.info('createBulkTasks ←', { created_count: res.created_count, kpi_ids_count: (res.kpi_ids || []).length });
  return { isMock: false, created_count: res.created_count || 0, kpi_ids: res.kpi_ids || [] };
}

// Build the exact server-side row shape from a UI row + defaults.
export function buildTaskRow(row) {
  return {
    name: (row.name || '').trim(),
    external_ref: row.external_ref || '',
    related_req_ref: row.related_req_ref || '',
    description: row.description || '',
    estimate_hours: Number(row.estimate_hours) || 0,
    estimate_minutes: Number(row.estimate_minutes) || 0,
    priority: row.priority || 'regular',
    primary_user_id: row.primary_user_id ? Number(row.primary_user_id) : false,
  };
}

// ---- Task attachments (photos / video + reason) ----------------------------
// Files go to kpi.user.manual via the EXISTING /kpi/manual/* routes — one row per
// file, unlimited per task, and its `description` is the client's reason. The web
// "Task Related Documents" viewer already renders these, which is how the
// developer sees them.

// Hard cap for video. Deliberately far below the module's 50 MB multipart guard:
// this route is base64-in-JSON, which inflates the file ~+33% and is held in
// memory ~3x (RN string -> axios body -> Odoo decode), and LONG_TIMEOUT is a
// 45s TOTAL deadline. 10 MB (~30-60s of phone video) stays safely inside both.
// For anything bigger, clone the multipart /kpi/progress/upload_file instead of
// raising this.
export const MAX_VIDEO_BYTES = 10 * 1024 * 1024;
// Images are compressed before we get here; this is just a sanity backstop.
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

// "8.4 MB" / "412 KB" — shown on the chip and while uploading.
export function humanSize(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

// Attach ONE file to a task. `onProgress(sent, total)` drives the live %.
// `links` — optional related links, stored as the JSON array the web writes.
export async function uploadManual(kpiId, { fileData, fileName, reason, links }, onProgress) {
  const base = await server();
  if (!base) return { status: true };
  log.info('uploadManual → /kpi/manual/upload', { kpi_id: kpiId, fileName, bytesB64: (fileData || '').length, links: (links || []).length });
  const res = await jsonRpc(
    base, '/kpi/manual/upload',
    {
      kpi_id: kpiId,
      file_data: fileData,
      file_name: fileName,
      description: reason || '',   // the client's reason for this file
      related_links: JSON.stringify(links || []),
    },
    LONG_TIMEOUT,
    null,
    onProgress,
  );
  if (!res || res.status === false) {
    log.error('uploadManual ✗', res?.message);
    throw new Error(res?.message || `Could not upload ${fileName}`);
  }
  log.info('uploadManual ←', { kpi_id: kpiId, fileName });
  return res;
}

// Absolute URL for the "Download Blank Template" link (type='http' GET route).
export async function templateUrl(docType) {
  const base = await server();
  if (!base) return '';
  const name = TEMPLATE_NAME[docType] || 'requirement';
  return `${normalizeUrl(base)}/kpi_completion_cert/template/${name}`;
}

// Admin "Generate Client Files" → the ZIP (3 XLSX) as base64.
//
// NOTE: we deliberately do NOT open the web's type='http' GET
// (/kpi_client_workspace/generate_zip) in a browser: an external browser has its
// own cookie jar, so it loses the app's Odoo session and Odoo redirects it to the
// login page instead of downloading. This calls the JSON sibling route over the
// same authenticated channel every other app call uses.
// Returns { filename, data_b64, size }.
export async function generateClientFilesZip({ clientKraId, projectKraId, version, includeData }) {
  const base = await server();
  if (!base) throw new Error('Connect to a server to generate files');
  if (!clientKraId) throw new Error('Please select a client');
  const payload = {
    client_kra_id: clientKraId,
    project_kra_id: projectKraId || false,
    version: version || 'v1.0',
    include_data: includeData ? '1' : '0',
  };
  log.info('generateClientFilesZip → /kpi_client_workspace/generate_zip_b64', payload);
  const res = await jsonRpc(base, '/kpi_client_workspace/generate_zip_b64', payload, LONG_TIMEOUT);
  if (!res || res.status === false) {
    log.error('generateClientFilesZip ✗', res?.message);
    throw new Error(res?.message || 'Could not generate the ZIP');
  }
  log.info('generateClientFilesZip ←', { filename: res.filename, size: res.size });
  return { filename: res.filename || 'client_files.zip', data_b64: res.data_b64 || '', size: res.size || 0 };
}
