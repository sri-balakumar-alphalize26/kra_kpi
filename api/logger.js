// Tiny tagged logger for debugging the login / Odoo flow.
// Logs only in development (__DEV__) so production builds stay silent.
// Usage: const log = createLogger('Login'); log.info('step', {...});

const ENABLED = typeof __DEV__ === 'undefined' ? true : __DEV__;

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
  const emit = (fn, args) => { if (ENABLED) fn(prefix, ...args); };
  return {
    info: (...a) => emit(console.log, a),
    warn: (...a) => emit(console.warn, a),
    error: (...a) => emit(console.error, a),
    redact,
  };
}
