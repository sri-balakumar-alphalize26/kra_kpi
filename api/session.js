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

const K_ROLE = 'kpi_role_state';
const K_QUICK = 'home_quick_actions';

// Last KNOWN role + pairing state, per uid. The role gate asks the server for
// these; with no network that request throws and the gate would fall back to
// "not locked" — so a developer who ended their workday would wrongly get a
// fully-unlocked board offline. Caching lets us reuse the server's last answer
// instead of guessing, and it self-corrects on the next successful request.
// Keyed by uid so two accounts on one device can't inherit each other's state.
export async function getRoleState(uid) {
  try {
    const raw = await AsyncStorage.getItem(`${K_ROLE}:${uid ?? 'me'}`);
    const o = raw ? JSON.parse(raw) : null;
    return (o && typeof o === 'object') ? o : null;   // { kpiRole, paired }
  } catch (_) {
    return null;
  }
}

export async function saveRoleState(uid, state) {
  try {
    await AsyncStorage.setItem(`${K_ROLE}:${uid ?? 'me'}`, JSON.stringify(state || {}));
  } catch (_) { /* best-effort cache — never block the gate */ }
}

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

// --- Side-menu order (drag-to-reorder in the drawer) ------------------------
// The user's own ordering of the drawer items, as dest keys. null = never
// reordered → the caller falls back to the natural role order. Stored per user
// and per device, exactly like the quick actions above.

const K_MENU = 'home_menu_order';

export async function getMenuOrder(uid) {
  try {
    const raw = await AsyncStorage.getItem(`${K_MENU}:${uid ?? 'me'}`);
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) ? arr : null;
  } catch (_) {
    return null;
  }
}

export async function saveMenuOrder(uid, keys) {
  try {
    await AsyncStorage.setItem(`${K_MENU}:${uid ?? 'me'}`, JSON.stringify(keys || []));
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

// ── Per-task reminder alarms ──────────────────────────────────────────────
// One map { [taskId]: { notifId, whenIso } } so the board can read every card's
// state in a single call. Local-only (this device), wiped on uninstall/clear-data.

const K_REMINDERS = 'kpi_reminders';

export async function getReminders() {
  try {
    const raw = await AsyncStorage.getItem(K_REMINDERS);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch (_) {
    return {};
  }
}

export async function setReminder(taskId, entry) {
  try {
    const map = await getReminders();
    map[String(taskId)] = entry;   // { notifId, whenIso }
    await AsyncStorage.setItem(K_REMINDERS, JSON.stringify(map));
  } catch (_) {}
}

export async function removeReminder(taskId) {
  try {
    const map = await getReminders();
    if (map[String(taskId)] !== undefined) {
      delete map[String(taskId)];
      await AsyncStorage.setItem(K_REMINDERS, JSON.stringify(map));
    }
  } catch (_) {}
}

// ── Custom "quick timer" presets for the reminder picker ───────────────────
// A user-editable list of durations (in MINUTES) shown as chips in the Remind-me
// popup. Local-only. Returns null when the user hasn't customised them yet, so the
// board can fall back to its built-in defaults.

const K_REMINDER_PRESETS = 'kpi_reminder_presets';

export async function getReminderPresets() {
  try {
    const raw = await AsyncStorage.getItem(K_REMINDER_PRESETS);
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) ? arr : null;
  } catch (_) {
    return null;
  }
}

export async function setReminderPresets(mins) {
  try {
    await AsyncStorage.setItem(K_REMINDER_PRESETS, JSON.stringify(mins || []));
  } catch (_) {}
}

// ── Chosen alarm sound (device system ringtone) ────────────────────────────
// One global { uri, title } picked from the phone's ringtone picker. uri is a
// content:// string (or null = Silent). Returns null when never set → "default".

const K_ALARM_SOUND = 'kpi_alarm_sound';

export async function getAlarmSound() {
  try {
    const raw = await AsyncStorage.getItem(K_ALARM_SOUND);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export async function setAlarmSound(sound) {
  try {
    if (sound === null) await AsyncStorage.removeItem(K_ALARM_SOUND);
    else await AsyncStorage.setItem(K_ALARM_SOUND, JSON.stringify(sound));
  } catch (_) {}
}

// Global alarm behaviour: how long it rings before auto-stopping (ringMins; 0 =
// until the user taps Stop) and the snooze length (snoozeMins). Merged over
// defaults so a partial save can't drop a field.
const K_ALARM_SETTINGS = 'kpi_alarm_settings';
const ALARM_DEFAULTS = { ringMins: 5, snoozeMins: 5 };

export async function getAlarmSettings() {
  try {
    const raw = await AsyncStorage.getItem(K_ALARM_SETTINGS);
    const saved = raw ? JSON.parse(raw) : null;
    return { ...ALARM_DEFAULTS, ...(saved || {}) };
  } catch (_) {
    return { ...ALARM_DEFAULTS };
  }
}

export async function setAlarmSettings(partial) {
  try {
    const cur = await getAlarmSettings();
    await AsyncStorage.setItem(K_ALARM_SETTINGS, JSON.stringify({ ...cur, ...(partial || {}) }));
  } catch (_) {}
}
