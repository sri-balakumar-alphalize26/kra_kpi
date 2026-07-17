// Login Management data service — mirrors the Odoo web "Login Management" screen
// (kpi_user_access.js). Wraps the /kpi_user_access/* + /kpi_wa_server/* routes in
// controllers/kra_api.py. All routes are admin-gated server-side. Falls back to
// mock data with no server.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('LoginMgmt');

const MOCK = {
  status: true,
  dial: '91', mobile_length: 10, app_name: 'the app', otp_minutes: 5,
  otp_template: 'Hi {name} 👋\n\n🔒 *{app}* — Password Reset\n\nYour one-time code is: *{code}*\nIt expires in {minutes} minutes.',
  otp_default: 'Hi {name} 👋\n\n🔒 *{app}* — Password Reset\n\nYour one-time code is: *{code}*\nIt expires in {minutes} minutes.',
  wa_session_id: 0, wa_state: 'none', wa_phone: '',
  countries: [
    { id: 104, name: 'India', code: 'IN', phone_code: 91 },
    { id: 165, name: 'Oman', code: 'OM', phone_code: 968 },
  ],
  users: [
    { id: 2, name: 'Mitchell Admin', login: 'admin', mobile: '', enabled: true, last_login: '', last_device: '', role: 'admin', is_system: true, country_id: false, dial: '91', mobile_length: 10 },
    { id: 3, name: 'Dev One', login: 'user', mobile: '9876543210', enabled: true, last_login: '2026-07-13 10:00', last_device: 'Pixel', role: 'developer', is_system: false, country_id: false, dial: '91', mobile_length: 10 },
  ],
};

// Full screen payload: users + WhatsApp + OTP config + dial/length.
export async function getAccess() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) { log.info('getAccess — no server, mock'); return { ...MOCK, isMock: true }; }
  const res = await jsonRpc(serverUrl, '/kpi_user_access/get', {});
  log.info('getAccess ←', { users: res?.users?.length, wa_state: res?.wa_state });
  return { ...res, isMock: false };
}

export async function setMobile(userId, mobile) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, mobile };
  return jsonRpc(serverUrl, '/kpi_user_access/set_mobile', { user_id: userId, mobile });
}

// Set this person's OWN country (dial + local length) — Oman +968 / 8 digits,
// India +91 / 10, etc. Empty countryId clears the override (company default).
// Returns { dial, mobile_length, country_id, wa_number }.
export async function setUserCountry(userId, countryId) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, dial: '91', mobile_length: 10, country_id: countryId || false, wa_number: '' };
  return jsonRpc(serverUrl, '/kpi_user_access/set_country', { user_id: userId, country_id: countryId || false });
}

export async function setRole(userId, role) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, role };
  return jsonRpc(serverUrl, '/kpi_user_access/set_role', { user_id: userId, role });
}

export async function toggleLogin(userId, enabled) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true };
  return jsonRpc(serverUrl, '/kpi_user_access/toggle_login', { user_id: userId, enabled });
}

export async function resetPassword(userId) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true };
  return jsonRpc(serverUrl, '/kpi_user_access/reset_password', { user_id: userId });
}

export async function setOtpMessage(template) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true };
  return jsonRpc(serverUrl, '/kpi_user_access/set_otp_message', { template });
}

// ── WhatsApp reset-code sender (Neonize session) ─────────────────────────────
export async function waConnect() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, session_id: 1, state: 'waiting_qr' };
  return jsonRpc(serverUrl, '/kpi_wa_server/connect', {});
}

export async function waStatus(sessionId) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, state: 'waiting_qr', phone_number: '', qr_image: '', error: '' };
  return jsonRpc(serverUrl, '/kpi_wa_server/status', { session_id: sessionId });
}

export async function waDelete(sessionId) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true };
  return jsonRpc(serverUrl, '/kpi_wa_server/delete', { session_id: sessionId });
}
