// Admin Users management — list / create / edit users carrying a KRA/KPI role
// ONLY (User / Client / Admin). Wraps /kpi_user_access/* (admin-gated server-side).
// Role + mobile + password reuse the existing Login Management routes; create/update
// are the new identity routes. Mock-safe with no server.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('Users');

const MOCK_USERS = [
  { id: 2, name: 'Mitchell Admin', login: 'admin', email: 'admin@demo.local', active: true, role: 'admin', mobile: '', is_system: true },
  { id: 7, name: 'Dev One', login: 'user', email: '', active: true, role: 'developer', mobile: '9876543210', is_system: false },
  { id: 8, name: 'Client One', login: 'user1', email: 'user1@demo.local', active: true, role: 'client', mobile: '', is_system: false },
];

// Reuses /kpi_user_access/get — returns { users:[{id,name,login,email,active,role,mobile,...}] }.
export async function fetchUsers() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) { log.info('fetchUsers — no server, mock'); return { status: true, isMock: true, users: MOCK_USERS }; }
  const res = await jsonRpc(serverUrl, '/kpi_user_access/get', {});
  log.info('users ←', { count: res?.users?.length ?? 0, status: res?.status });
  return res || { status: false, users: [] };
}

// Create a user with a KRA/KPI role only. If `password` is given it becomes their
// app PIN (usable as-is); if blank the server seeds 1111 (must-change red-nag flow).
export async function createUser({ name, login, email, kra_role, mobile, active, password }) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, user_id: 999 };
  return jsonRpc(serverUrl, '/kpi_user_access/create', { name, login, email, kra_role, mobile, active, password });
}

// Odoo-style "Change Password": set a specific new app PIN (no forced change).
export async function changePassword(userId, password) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true };
  return jsonRpc(serverUrl, '/kpi_user_access/change_password', { user_id: userId, password });
}

// Update identity fields (name/login/email/active).
export async function updateUser(userId, { name, login, email, active }) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true };
  return jsonRpc(serverUrl, '/kpi_user_access/update', { user_id: userId, name, login, email, active });
}

// KRA/KPI role — reuse the Login Management setter (moves the group_kra_* groups).
export async function setUserRole(userId, role) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, role };
  return jsonRpc(serverUrl, '/kpi_user_access/set_role', { user_id: userId, role });
}

export async function setUserMobile(userId, mobile) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, mobile };
  return jsonRpc(serverUrl, '/kpi_user_access/set_mobile', { user_id: userId, mobile });
}

// Reset app PIN back to 1111 (forces a change on next login).
export async function resetUserPassword(userId) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true };
  return jsonRpc(serverUrl, '/kpi_user_access/reset_password', { user_id: userId });
}
