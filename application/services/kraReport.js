// KRA Report — the task-wise report the Odoo web screen renders
// (static/src/components/kpi_kra_report/kpi_kra_report.js), wrapping
// /kpi_reports/kra/* in controllers/kpi_reports_api.py.
//
// Unlike workReport.js, NOTHING here is rendered server-side. The web builds its
// PDF, Excel and ZIP in the browser with jsPDF/ExcelJS/JSZip and the app does the
// same on the device (utils/kraExport.js) — there is no /kra/pdf route to call.
// So these three wrappers only ever fetch DATA.
//
// Mock-safe with no server, like every other service here.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('KraReport');

// Everything the four filter pickers need, in one call.
//
// The error path returns the same four keys as EMPTY LISTS (not an error), which
// is why this can be destructured unguarded — unlike fetchKraReport below.
export async function fetchKraFilters() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    return { status: true, kras: [], employees: [], task_types: [], task_states: [], isMock: true };
  }
  const res = await jsonRpc(serverUrl, '/kpi_reports/kra/get_filters', {});
  log.info('filters ←', {
    kras: res?.kras?.length, employees: res?.employees?.length,
    types: res?.task_types?.length, states: res?.task_states?.length,
  });
  return res || { status: false, kras: [], employees: [], task_types: [], task_states: [] };
}

// The report. params:
//   { from_date, to_date, employee_ids[], kra_ids[], excluded_kra_ids[],
//     task_types[], task_states[] }
//
// On failure the route omits `data`, `summary` and `filters` ENTIRELY rather than
// sending them empty, so the caller must check status before reaching for them —
// hence the defaulted shape below rather than a bare passthrough.
//
// 60s: the route runs get_report_data() twice (once for the rows, once inside
// get_kra_summary) and issues one time-log query per task, so a wide date range
// is genuinely slow rather than merely large.
export async function fetchKraReport(params) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    return { status: true, data: [], summary: [], filters: {}, isMock: true };
  }
  const res = await jsonRpc(serverUrl, '/kpi_reports/kra/generate', params || {}, 60000);
  log.info('report ←', { status: res?.status, rows: res?.data?.length });
  if (!res?.status) return { status: false, message: res?.message || 'Could not generate the report.' };
  return { status: true, data: res.data || [], summary: res.summary || [], filters: res.filters || {} };
}

// What the screen needs to know about the caller on load: whether the edit
// affordances apply, and the working view to restore.
//
// `saved_state` is a JSON STRING on res.users, and the Odoo web screen writes the
// same field — so whatever comes back may have been written by the browser.
export async function fetchKraContext() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, is_admin: false, saved_state: '' };
  try {
    const res = await jsonRpc(serverUrl, '/kpi_reports/kra/context', {});
    if (!res?.status) return { status: false, is_admin: false, saved_state: '' };
    return { status: true, is_admin: !!res.is_admin, user_id: res.user_id, saved_state: res.saved_state || '' };
  } catch (e) {
    // A failed restore must never stop the screen loading — the user just gets
    // the blank report they used to get every time.
    log.warn('context failed', e?.message);
    return { status: false, is_admin: false, saved_state: '' };
  }
}

// ── Download history ───────────────────────────────────────────────────────
// Reports downloaded from the WEB are recorded server-side, with a retention
// setting in Configuration deciding how long they are kept. That history existed
// only in the browser, so an admin on a phone could not see — let alone re-fetch
// — a report a colleague had produced.
//
// A mirror of what the WEB saved, deliberately — the app builds its own documents
// on the device and never posts them back, so this lists the browser's copies
// rather than pretending to be a complete record of every download ever made. The
// screen says so rather than leaving someone to wonder why their own is missing.
//
// "Read-only" is the wrong word for it, and used to be the one written here. The
// app now takes part in this history in all three directions: it records what it
// builds (saveBuiltDownload), fetches copies back (fetchStoredDownload) and can
// delete one before its retention window expires (deleteStoredDownload).
//
// The earlier wording said the app "never writes" to it, which described the code
// accurately but presented it as the design. It was not — the save route simply
// had never been wired up, so a report exported from the phone vanished while the
// same one from the browser was kept.
export async function fetchDownloadHistory(limit = 50) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, downloads: [] };
  const res = await jsonRpc(serverUrl, '/kpi_reports/kra/download_list', { limit });
  if (!res || res.status === false) {
    // "Not authorized" below the report's own admin gate — the route's words,
    // not a guess of ours.
    return { status: false, message: res?.message || 'Could not load the history.', downloads: [] };
  }
  return { status: true, downloads: res.downloads || [] };
}

// One stored download's bytes, base64. JSON rather than a URL for the same
// reason every other file fetch here is: a browser handed a URL sends no session
// cookie and lands on the login page instead of the file.
export async function fetchStoredDownload(id) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: false, message: 'No server connection' };
  return jsonRpc(serverUrl, '/kpi_reports/kra/download_file', { id: Number(id) }, 60000);
}

// Keep a copy of a report this DEVICE just built, so it joins the same history.
//
// Until this existed the app read from and deleted from that history without ever
// writing to it: a report exported from the browser was kept, the identical report
// exported from the phone vanished the moment the file was saved. The documents are
// built on the device (utils/kraExport.js) and never otherwise reach the server, so
// this route is the only way the copy can exist at all.
//
// Best-effort, in the route's own words — "the user already has their download, so a
// failure here must be reported without pretending the download itself failed". It
// therefore swallows everything: the file is on the phone either way, and the route
// is admin-gated, so a non-admin's perfectly good export must not raise a scary
// "Not authorized" over the top of it.
export async function saveBuiltDownload({ data_b64, filename, kind, from_date, to_date, row_count, filters_json }) {
  try {
    const { serverUrl } = await getConnection();
    if (!serverUrl) return { status: false };
    return await jsonRpc(serverUrl, '/kpi_reports/kra/download_save', {
      data_b64: data_b64 || '',
      filename: filename || 'report',
      kind: kind || 'zip',
      from_date: from_date || false,
      to_date: to_date || false,
      row_count: row_count || 0,
      filters_json: filters_json || '',
    }, 60000);
  } catch (e) {
    log.info('download_save skipped', e?.message);
    return { status: false };
  }
}

// Remove one before its retention window runs out.
export async function deleteStoredDownload(id) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: false };
  return jsonRpc(serverUrl, '/kpi_reports/kra/download_delete', { id: Number(id) });
}

// Store the working view. Passing an empty string is how it gets cleared.
export async function saveKraState(state) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true };
  try {
    return await jsonRpc(serverUrl, '/kpi_reports/kra/state_set', { state: state || '' });
  } catch (e) {
    // Fire-and-forget: losing a saved view is a nuisance, not a failure worth
    // interrupting anybody over.
    log.warn('state_set failed', e?.message);
    return { status: false };
  }
}

// How many tasks each filter option would return, for the counts beside every
// checkbox. Each facet is counted with ITS OWN selection skipped, so a count
// answers "what would ticking this give me" rather than "what is selected now".
//
// Two shapes to be careful of: the four values are MAPS, not lists, and they come
// back spread at the top level alongside `status`. Over JSON-RPC their integer
// keys arrive as strings ("42"), so look them up with String(id).
export async function fetchKraFilterCounts(params) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, kras: {}, employees: {}, task_types: {}, task_states: {} };
  try {
    const res = await jsonRpc(serverUrl, '/kpi_reports/kra/filter_counts', params || {});
    if (!res?.status) return { status: false, kras: {}, employees: {}, task_types: {}, task_states: {} };
    return {
      status: true,
      kras: res.kras || {},
      employees: res.employees || {},
      task_types: res.task_types || {},
      task_states: res.task_states || {},
    };
  } catch (e) {
    // Counts are a convenience on top of the filters — losing them must never
    // take the screen down with them.
    log.warn('filter counts failed', e?.message);
    return { status: false, kras: {}, employees: {}, task_types: {}, task_states: {} };
  }
}
