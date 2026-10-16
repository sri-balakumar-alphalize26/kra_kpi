/* Tiny prefixed console logger, the shape the mobile services import
   (createLogger(name).info/warn/error + redact). Quiet in production. */
const ON = process.env.NODE_ENV !== "production";

export function createLogger(name) {
  const p = `[${name}]`;
  return {
    info: (...a) => { if (ON) console.log(p, ...a); },
    warn: (...a) => { if (ON) console.warn(p, ...a); },
    error: (...a) => console.error(p, ...a),
    redact: (obj) => {
      if (!obj || typeof obj !== "object") return obj;
      const out = { ...obj };
      for (const k of Object.keys(out)) if (/password|token|secret|otp|code/i.test(k)) out[k] = "***";
      return out;
    },
  };
}
