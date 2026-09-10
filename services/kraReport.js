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
