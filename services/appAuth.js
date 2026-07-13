// Mobile-app auth service — mobile# + password login against the Odoo module's
// /kpi_app/* routes. Separate from the Odoo device-setup login (ConnectScreen).
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('AppAuth');

function deviceName() {
  return Device.deviceName || Device.modelName || Platform.OS || 'device';
}

// Country/mobile format from the Odoo Configuration screen, so every number
// field in the app shows the same +dial code and allows the same digit count.
export async function getMobileConfig() {
  const { serverUrl, db } = await getConnection();
  if (!serverUrl) return { dial: '91', length: 10 };
  try {
    const res = await jsonRpc(serverUrl, '/kpi_app/config', {}, undefined, db);
    return { dial: res?.dial || '91', length: res?.mobile_length || 10 };
  } catch (e) {
    log.warn('getMobileConfig failed', e?.message);
    return { dial: '91', length: 10 };
  }
}

// Check a mobile number's state → 'unknown' | 'needs_setup' | 'ready' | 'disabled'.
export async function loginCheck(mobile) {
  const { serverUrl, db } = await getConnection();
  if (!serverUrl) return { state: 'unknown' };
  const res = await jsonRpc(serverUrl, '/kpi_app/login_check', { mobile }, undefined, db);
  log.info('loginCheck ←', { state: res?.state });
  return { state: res?.state || 'unknown', name: res?.name };
}

// Verify mobile# + password → trusted server-side login. Returns the user object
// (to persist) + must_change flag, or { ok:false, error }.
export async function appLogin(mobile, password) {
  const { serverUrl, db } = await getConnection();
  if (!serverUrl) return { ok: false, error: 'Device not set up.' };
  const res = await jsonRpc(serverUrl, '/kpi_app/login', {
    mobile, password, device: deviceName(),
  }, undefined, db);
  if (!res?.status) return { ok: false, error: res?.error || 'Login failed.' };
  return {
    ok: true,
    mustChange: !!res.must_change,
    user: { name: res.name, username: res.login, uid: res.uid, db, serverUrl },
  };
}

// Request a WhatsApp OTP for password reset / onboarding. Generic response.
export async function requestOtp(mobile) {
  const { serverUrl, db } = await getConnection();
  if (!serverUrl) return { ok: false };
  const res = await jsonRpc(serverUrl, '/kpi_app/otp/request', { mobile }, undefined, db);
  return { ok: !!res?.status, sent: !!res?.sent };
}

// Verify OTP + set the new password → logs in. Returns the user or an error.
export async function verifyOtp(mobile, code, newPassword) {
  const { serverUrl, db } = await getConnection();
  if (!serverUrl) return { ok: false, error: 'Device not set up.' };
  const res = await jsonRpc(serverUrl, '/kpi_app/otp/verify', {
    mobile, code, new_password: newPassword, device: deviceName(),
  }, undefined, db);
  if (!res?.status) return { ok: false, error: res?.error || 'Could not verify.' };
  return {
    ok: true,
    user: { name: res.name, username: res.login, uid: res.uid, db, serverUrl },
  };
}

// Logged-in user sets their own (new) app password — first-login forced change.
export async function setAppPassword(newPassword) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { ok: false, error: 'Device not set up.' };
  const res = await jsonRpc(serverUrl, '/kpi_app/set_password', { new_password: newPassword });
  return { ok: !!res?.status, error: res?.error };
}
