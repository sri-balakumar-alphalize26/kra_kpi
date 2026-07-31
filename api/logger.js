// Tiny tagged logger for debugging the login / Odoo flow.
// Usage: const log = createLogger('Login'); log.info('step', {...});
//
// info() is development-only, so a release build stays quiet during normal
// operation.  warn() and error() ALWAYS emit, in every build.
//
// The split exists because gating all three on __DEV__ made release builds
// silent about their own failures: services/push.js reports every dead end
// through log.warn ('push permission not granted', 'no Expo push token
// returned', 'registerForPushAsync failed'), then returns null, and the caller
// in App.js ignores null.  A device that never registered for push therefore
// looked exactly like a healthy one, on-screen AND in logcat — diagnosing it
// meant reading Android's own FCM plumbing to infer what the app already knew.
// Routine chatter is not worth shipping; a swallowed failure is.

const DEV = typeof __DEV__ === 'undefined' ? true : __DEV__;

// Keys whose values must never be printed in full.
const SECRET_KEYS = ['password', 'pw', 'pass', 'session_id', 'token'];

// Shallow-clone an object, masking secret fields so passwords never hit the log.
export function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const k of Object.keys(obj)) {
    if (SECRET_KEYS.includes(k)) {
      const v = obj[k];
      out[k] = v ? '***' + String(v).length + 'chars***' : v;
    } else {
      out[k] = obj[k];
    }
  }
  return out;
}

export function createLogger(tag) {
  const prefix = `[${tag}]`;
  return {
    info: (...a) => { if (DEV) console.log(prefix, ...a); },
    warn: (...a) => console.warn(prefix, ...a),
    error: (...a) => console.error(prefix, ...a),
    redact,
  };
}
