// AsyncStorage wrapper for the login flow: remembers the server URL + database
// (so the user re-enters only username/password later) and the logged-in
// session (so the app boots straight to Home across restarts).

import AsyncStorage from '@react-native-async-storage/async-storage';

const K_URL = 'odoo_server_url';
const K_DB = 'odoo_db_name';
const K_SESSION = 'odoo_session';
// The Odoo account that provisioned this device (7-tap device-setup). The app
// login is LOCKED to this account — only its mobile number may sign in here.
const K_SETUP_UID = 'odoo_setup_uid';
const K_SETUP_LOGIN = 'odoo_setup_login';
const K_SETUP_NAME = 'odoo_setup_name';

// --- Connection (URL + DB + the device-setup account) ----------------------

export async function saveConnection({ serverUrl, db, setupUid, setupLogin, setupName }) {
  try {
    const pairs = [
      [K_URL, serverUrl || ''],
      [K_DB, db || ''],
    ];
    // Only overwrite the setup account when provided (the device-setup flow).
    if (setupUid !== undefined) pairs.push([K_SETUP_UID, setupUid ? String(setupUid) : '']);
    if (setupLogin !== undefined) pairs.push([K_SETUP_LOGIN, setupLogin || '']);
    if (setupName !== undefined) pairs.push([K_SETUP_NAME, setupName || '']);
    await AsyncStorage.multiSet(pairs);
  } catch (_) {}
}

export async function getConnection() {
  try {
    const [[, url], [, db], [, sUid], [, sLogin], [, sName]] = await AsyncStorage.multiGet(
      [K_URL, K_DB, K_SETUP_UID, K_SETUP_LOGIN, K_SETUP_NAME]);
    return {
      serverUrl: url || '', db: db || '',
      setupUid: sUid ? (parseInt(sUid, 10) || null) : null,
      setupLogin: sLogin || '', setupName: sName || '',
    };
  } catch (_) {
    return { serverUrl: '', db: '', setupUid: null, setupLogin: '', setupName: '' };
  }
}

// --- Session (keep-logged-in) ---------------------------------------------

export async function saveSession(user) {
  try {
    await AsyncStorage.setItem(K_SESSION, JSON.stringify(user));
  } catch (_) {}
}

export async function getSession() {
  try {
    const raw = await AsyncStorage.getItem(K_SESSION);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export async function clearSession() {
  try {
    await AsyncStorage.removeItem(K_SESSION);
  } catch (_) {}
}

// --- Home Quick Actions customization (per user, this device) ---------------
// Stores the list of chosen quick-action dest keys (e.g. ['actionboard','owner']).
// Returns null when the user hasn't customized yet (caller then shows the default).

const K_QUICK = 'home_quick_actions';

export async function getQuickActions(uid) {
  try {
    const raw = await AsyncStorage.getItem(`${K_QUICK}:${uid ?? 'me'}`);
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) ? arr : null;
  } catch (_) {
    return null;
  }
}

export async function saveQuickActions(uid, keys) {
  try {
    await AsyncStorage.setItem(`${K_QUICK}:${uid ?? 'me'}`, JSON.stringify(keys || []));
  } catch (_) {}
}

// --- Profile photo (local only, per user) -----------------------------------
// Stored as a base64 data URI in AsyncStorage → lives only on this device and is
// wiped on uninstall / clear-data. Returns null when none is set.

const K_AVATAR = 'profile_avatar';

export async function getAvatar(uid) {
  try {
    return (await AsyncStorage.getItem(`${K_AVATAR}:${uid ?? 'me'}`)) || null;
  } catch (_) {
    return null;
  }
}

export async function saveAvatar(uid, dataUri) {
  try {
    await AsyncStorage.setItem(`${K_AVATAR}:${uid ?? 'me'}`, dataUri || '');
  } catch (_) {}
}

export async function clearAvatar(uid) {
  try {
    await AsyncStorage.removeItem(`${K_AVATAR}:${uid ?? 'me'}`);
  } catch (_) {}
}
