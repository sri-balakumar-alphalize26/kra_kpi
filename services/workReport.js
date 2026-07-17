// Work Report — completed tasks over a period (task-wise / client-wise), admin.
// Wraps /kpi_reports/period_work/* in controllers/kpi_reports_api.py.
// The PDF is rendered SERVER-SIDE (reportlab) and returned as base64, so the app
// opens/downloads it the same way as the daily report. Mock-safe with no server.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('WorkReport');

// Billable-client dropdown for the optional single-client filter.
export async function fetchWorkReportClients() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, clients: [], isMock: true };
  const res = await jsonRpc(serverUrl, '/kpi_reports/period_work/clients', {});
  return res || { status: false, clients: [] };
}

// The report itself. params: { from_date, to_date, group_by:'task'|'client', client_kra_id }
export async function fetchWorkReport(params) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, group_by: params?.group_by || 'task', tasks: [], clients: [], total_tasks: 0, total_hours_display: '0h', isMock: true };
  const res = await jsonRpc(serverUrl, '/kpi_reports/period_work/generate', params || {});
  log.info('work report ←', { status: res?.status, total: res?.total_tasks });
  return res || { status: false };
}

// The branded PDF (base64). 60s timeout — a big period is a few hundred KB.
export async function fetchWorkReportPdf(params) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: false, message: 'No server' };
  const res = await jsonRpc(serverUrl, '/kpi_reports/period_work/pdf', params || {}, 60000);
  return res || { status: false };
}
