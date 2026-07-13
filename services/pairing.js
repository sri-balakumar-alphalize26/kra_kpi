// Pairing service — the app generates a PIN; the developer enters it on the
// web KPI Action Board to start working (pairs devices + opens the workday).
// The app then polls pairingStatus() until the web confirms. Wraps the
// /kpi_pair/* routes (controllers/kra_api.py). Mirrors services/notifications.js.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('Pairing');

// Generate a fresh PIN for this session. Returns { pin, expires_at, isMock }.
export async function generatePin() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    log.info('generatePin — no server, mock');
    // Mock: a stable demo PIN + a 10-min expiry from a fixed base (no Date.now
    // dependency needed here; the screen ticks its own countdown).
    return { pin: '1234', expires_at: null, isMock: true };
  }
  const res = await jsonRpc(serverUrl, '/kpi_pair/generate', {});
  log.info('generatePin ←', { hasPin: !!res?.pin, expires_at: res?.expires_at });
  return { pin: res?.pin || '', expires_at: res?.expires_at || null, isMock: false };
}

// Poll pairing state. Returns { state, paired, isMock }.
export async function pairingStatus() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { state: 'pending', paired: false, isMock: true };
  const res = await jsonRpc(serverUrl, '/kpi_pair/status', {});
  return { state: res?.state || 'none', paired: !!res?.paired, isMock: false };
}

// The web deep-link that opens the KPI Action Board (where the PIN is entered).
export async function boardWebUrl() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return '';
  const base = serverUrl.replace(/\/+$/, '');
  return `${base}/odoo/action-kra_kpi_module.action_kpi_action_screen`;
}
