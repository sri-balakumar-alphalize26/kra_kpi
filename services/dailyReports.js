// Daily Task Reports — the generated per-day PDF reports, for admins.
// Wraps /kpi_daily_report/* in controllers/kra_api.py.
// Mock-safe with no server, like the other services here.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('DailyReports');

// The list: [{id, report_date, date_display, employee_count, task_count,
//             file_name, has_file, generated_at}]. Newest first. No PDF bytes here
// — a report's PDF is fetched only when the admin taps View/Download.
export async function fetchDailyReports(limit = 60) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    log.info('fetchDailyReports — no server, mock');
    return { status: true, reports: [], isMock: true };
  }
  const res = await jsonRpc(serverUrl, '/kpi_daily_report/list', { limit });
  log.info('daily reports ←', { count: res?.reports?.length ?? 0, status: res?.status });
  return res || { status: false, reports: [] };
}

// ONE report's PDF, base64.
//
// This MUST go over the authenticated JSON channel — React Native cannot send the
// Odoo session cookie to the type='http' /download or /view routes (they'd land on
// the login page). Same trap documented on /kpi/progress/file_b64 and the snapshot
// image route. 60s timeout: PDFs (logo + watermark) are a few hundred KB of base64.
export async function fetchDailyReportFile(reportId) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: false, message: 'No server' };
  const res = await jsonRpc(serverUrl, '/kpi_daily_report/file_b64', { report_id: reportId }, 60000);
  log.info('daily report file ←', { id: reportId, status: res?.status, name: res?.file_name });
  return res || { status: false };
}
