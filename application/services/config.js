// Configuration screen data service — mirrors the Odoo web "Configuration"
// screen (kpi_configuration.js). Wraps the /kpi_config/* + /kpi_multitask/*
// routes in controllers/kra_api.py. Falls back to mock data with no server.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('Config');

// Load timers, urgent recipients, country/mobile format, and developers.
export async function fetchConfig() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    log.info('fetchConfig — no server, mock');
    return {
      isMock: true,
      queue_nudge_minutes: 30,
      urgent_nudge_minutes: 5,
      break_alert_minutes: 15,
      lunch_alert_minutes: 30,
      meeting_alert_minutes: 30,
      break_budget_minutes: 60,
      standard_workday_hours: 9,
      snapshot_retention_number: 3,
      snapshot_retention_unit: 'months',
      daily_report_enabled: true,
      daily_report_hour: 10.0,
      daily_report_coverage: 'yesterday',
      report_retention_number: 3,
      report_retention_unit: 'months',
      country_id: false,
      country_dial_code: '91',
      mobile_length: 10,
      countries: [
        { id: 104, name: 'India', code: 'IN', phone_code: 91 },
        { id: 165, name: 'Oman', code: 'OM', phone_code: 968 },
      ],
      developers: [
        { id: 3, name: 'Dev One', login: 'dev1', allow_multitask: false, wa_number: '' },
      ],
      // Where workday/task updates are posted. The destination is chosen on the
      // web; the app shows it so the group editor can say which group a test
      // message would land in.
      wa_group_jid: '',
      wa_group_name: '',
    };
  }
  const cfg = await jsonRpc(serverUrl, '/kpi_config/get', {});
  const devs = await jsonRpc(serverUrl, '/kpi_multitask/list', {});
  return {
    isMock: false,
    queue_nudge_minutes: cfg?.queue_nudge_minutes ?? 30,
    urgent_nudge_minutes: cfg?.urgent_nudge_minutes ?? 5,
    // Break / lunch / meeting over-run reminders. `??` not `||` -- 0 means the
    // reminder is switched OFF, and `||` would read that as unset and show the
    // default instead, so the screen would lie about the current setting.
    break_alert_minutes: cfg?.break_alert_minutes ?? 15,
    lunch_alert_minutes: cfg?.lunch_alert_minutes ?? 30,
    meeting_alert_minutes: cfg?.meeting_alert_minutes ?? 30,
    break_budget_minutes: cfg?.break_budget_minutes ?? 60,
    standard_workday_hours: Number(cfg?.standard_workday_hours) || 9,
    // Daily task report schedule + snapshot/report retention (0 = keep forever).
    snapshot_retention_number: Number(cfg?.snapshot_retention_number ?? 3),
    snapshot_retention_unit: cfg?.snapshot_retention_unit || 'months',
    daily_report_enabled: cfg?.daily_report_enabled !== false,
    daily_report_hour: Number(cfg?.daily_report_hour ?? 10),
    daily_report_coverage: cfg?.daily_report_coverage || 'yesterday',
    report_retention_number: Number(cfg?.report_retention_number ?? 3),
    report_retention_unit: cfg?.report_retention_unit || 'months',
    country_id: cfg?.country_id || false,
    country_dial_code: String(cfg?.country_dial_code || '91'),
    mobile_length: Number(cfg?.mobile_length) || 10,
    countries: cfg?.countries || [],
    developers: (devs?.developers) || [],
    wa_group_jid: cfg?.wa_group_jid || '',
    wa_group_name: cfg?.wa_group_name || '',
    // Attendance in the app. Both keys come from kra_kpi_attendance_bridge, not
    // kra_kpi_module: a server without the bridge never sends them, so
    // `=== true` reads "missing" as "not available" and the Configuration
    // screen leaves the card out entirely.
    attendance_available: cfg?.attendance_available === true,
    attendance_in_app: cfg?.attendance_in_app === true,
  };
}

// The floating Attendance button on Home, company-wide. Served by the
// attendance bridge; returns { status:false } on a server without it.
export async function setAttendanceInApp(enabled) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, attendance_in_app: !!enabled };
  return jsonRpc(serverUrl, '/kpi_config/set_attendance_in_app', { enabled: !!enabled });
}

// setAdminAccept / setClientApproval retired (module 19.0.8.6): nothing is
// accepted or released automatically, so those windows are no longer set.

// Minutes between admin re-nudges for an unread queued client task.
export async function setQueueNudge(minutes) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true };
  return jsonRpc(serverUrl, '/kpi_config/set_queue_nudge', { minutes });
}

// Minutes between admin re-nudges while a 🚨 Urgent pause sits unread.
// (Replaces setUrgent(recipients): the old "extra WhatsApp numbers" had no user
// account, so they became unreachable once task WhatsApp was switched off.
// Urgent now notifies owner + coordinators in the app and repeats until read.)
export async function setUrgentNudge(minutes) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true };
  return jsonRpc(serverUrl, '/kpi_config/set_urgent_nudge', { minutes });
}

// Thresholds for the developer-only break / lunch / meeting over-run reminders.
// Takes a partial object -- only the keys you pass are written, so editing one
// field cannot reset the other three. 0 switches that reminder off, which is why
// the server clamps with max(0, ...) rather than max(1, ...).
export async function setBreakAlerts(values) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true };
  return jsonRpc(serverUrl, '/kpi_config/set_break_alerts', values || {});
}

// A normal working day, in hours. The End Workday summary compares it against
// PRESENCE (time at work, pauses already deducted): at/over reads green, under
// reads red.
export async function setStandardHours(hours) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, hours };
  return jsonRpc(serverUrl, '/kpi_config/set_standard_hours', { hours });
}

export async function setCountry(country_id) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, dial: '91', mobile_length: 10 };
  return jsonRpc(serverUrl, '/kpi_config/set_country', { country_id });
}

export async function setMultitask(user_id, allow) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true };
  return jsonRpc(serverUrl, '/kpi_multitask/set', { user_id, allow });
}

export async function setDevWa(user_id, wa_number) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, wa_number };
  return jsonRpc(serverUrl, '/kpi_multitask/set_wa', { user_id, wa_number });
}

// Set a person's OWN country (dial + local length) for their WhatsApp/login
// number — Oman +968 / 8 digits, India +91 / 10, etc. Shared with Login
// Management (/kpi_user_access/set_country). Empty country_id clears the override
// (back to the company default). Returns { dial, mobile_length, country_id,
// wa_number } — wa_number may be cleared if the old number can't fit the new length.
export async function setUserCountry(user_id, country_id) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, dial: '91', mobile_length: 10, country_id: country_id || false, wa_number: '' };
  return jsonRpc(serverUrl, '/kpi_user_access/set_country', { user_id, country_id: country_id || false });
}

// How long to keep workday snapshot IMAGES before the cleanup cron clears them.
// number 0 = keep forever; unit ∈ days/months/years.
export async function setSnapshotRetention({ number, unit }) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, number, unit };
  return jsonRpc(serverUrl, '/kpi_config/set_snapshot_retention', { number, unit });
}

// How long to keep generated daily report PDFs. number 0 = keep forever.
export async function setReportRetention({ number, unit }) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, number, unit };
  return jsonRpc(serverUrl, '/kpi_config/set_report_retention', { number, unit });
}

// Daily report schedule: on/off, IST send hour (float, 10.5 = 10:30), coverage
// ('yesterday'/'today'). All fields optional/partial.
export async function setDailyReport({ enabled, hour, coverage }) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, enabled, hour, coverage };
  return jsonRpc(serverUrl, '/kpi_config/set_daily_report', { enabled, hour, coverage });
}
