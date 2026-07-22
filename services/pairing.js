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
    return { pin: '1234', expires_at: null, mode: 'start', isMock: true };
  }
  const res = await jsonRpc(serverUrl, '/kpi_pair/generate', {});
  log.info('generatePin ←', { hasPin: !!res?.pin, expires_at: res?.expires_at, mode: res?.mode, done: res?.done });
  // `mode` = 'start' (no workday yet) | 'resume' (workday already open) → drives
  // the "Start Working" vs "Continue Working" copy on the PIN screen.
  // `done` = the developer already ENDED their workday today (one start + one end
  // per day) → no PIN issued; the screen shows the "ended for today" state.
  return { pin: res?.pin || '', expires_at: res?.expires_at || null, mode: res?.mode || 'start', done: !!res?.done, isMock: false };
}

// Poll pairing state. Returns { state, paired, isMock }.
export async function pairingStatus() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { state: 'pending', paired: false, mode: 'start', isMock: true };
  const res = await jsonRpc(serverUrl, '/kpi_pair/status', {});
  // Log the pairing decision — this drives the read-only gate (paired === workday
  // started). If paired is unexpectedly true, the server saw a live 'paired' row.
  // `mode` = 'resume' (workday still open, un-paired by tab-close/away) vs 'start'
  // (never started / ended) → drives whether the app jumps to the PIN screen.
  log.info('pairingStatus ←', { state: res?.state || 'none', paired: !!res?.paired, mode: res?.mode, day_done: res?.day_done });
  // `day_done` = the developer already ENDED their workday today → the app shows
  // "Workday ended for today" instead of routing to the PIN screen.
  return { state: res?.state || 'none', paired: !!res?.paired, mode: res?.mode || 'start', dayDone: !!res?.day_done, isMock: false };
}

// The web deep-link that opens the KPI Action Board (where the PIN is entered).
export async function boardWebUrl() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return '';
  const base = serverUrl.replace(/\/+$/, '');
  return `${base}/odoo/action-kra_kpi_module.action_kpi_action_screen`;
}
