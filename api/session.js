// AsyncStorage wrapper for the login flow: remembers the server URL + database
// (so the user re-enters only username/password later) and the logged-in
// session (so the app boots straight to Home across restarts).

import AsyncStorage from '@react-native-async-storage/async-storage';

const K_URL = 'odoo_server_url';
const K_DB = 'odoo_db_name';
const K_SESSION = 'odoo_session';

// --- Connection (URL + DB) -------------------------------------------------

export async function saveConnection({ serverUrl, db }) {
  try {
    await AsyncStorage.multiSet([
      [K_URL, serverUrl || ''],
      [K_DB, db || ''],
    ]);
  } catch (_) {}
}

export async function getConnection() {
  try {
    const [[, url], [, db]] = await AsyncStorage.multiGet([K_URL, K_DB]);
    return { serverUrl: url || '', db: db || '' };
  } catch (_) {
    return { serverUrl: '', db: '' };
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
