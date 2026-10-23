// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — auto-touch UI end-to-end on the REAL tablet.
//   Maestro drives the Android app; Playwright drives the Odoo web board.
//
// Flow (A → Z):
//   adb device present
//   → 01 login (mobile + password → Home)
//   → 03 start → PIN screen
//   → read the 4-digit PIN off the screen (four pinDigit cells)
//   → pair on the web board (type the PIN → phone workday opens)
//   → 04 board reached + End Workday (confirm modal → Logout & Send Summary)
//   → 05 ended blocks restart (one start + one end per day)
//   → 02 logout shows a confirm dialog
//
//   npm run test:ui
//
// Env (NEVER commit): APP_MOBILE, APP_PASSWORD, ODOO_URL, ODOO_DB (optional),
//   ODOO_WEB_LOGIN, ODOO_WEB_PASSWORD.
//
// ⚠️ Mutates real data: it starts AND ends the test developer's workday (then the
//    one-per-day rule blocks a restart until tomorrow). Use a QA developer account.
// ─────────────────────────────────────────────────────────────────────────────
import { execSync, execFileSync, spawn } from 'node:child_process';
import { readPin } from './read-pin.mjs';

const MAESTRO = process.env.MAESTRO_BIN || 'C:/Users/sriba/.maestro/maestro/bin/maestro.bat';
const ADB = process.env.ADB_BIN || 'C:/Users/sriba/platform-tools/adb.exe';

const REQUIRED = ['APP_MOBILE', 'APP_PASSWORD', 'ODOO_URL', 'ODOO_WEB_LOGIN', 'ODOO_WEB_PASSWORD'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('Missing env: ' + missing.join(', '));
  console.error('Set them first, e.g.  set APP_MOBILE=... (see UI-TESTING.md)');
  process.exit(2);
}

const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
const results = [];

function maestro(flow, env = {}) {
  const parts = [q(MAESTRO), 'test'];
  for (const [k, v] of Object.entries(env)) parts.push('-e', q(`${k}=${v}`));
  parts.push(q(flow));
  execSync(parts.join(' '), { stdio: 'inherit' });
}

async function step(name, fn) {
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: (e && e.message) || String(e) });
    console.log(`FAIL  ${name} — ${(e && e.message) || e}`);
    throw e;
  }
}

(async () => {
  try {
    await step('adb — authorized device present', () => {
      const out = execFileSync(ADB, ['devices'], { encoding: 'utf8' });
      const rows = out.split('\n').slice(1).filter((l) => /\tdevice\b/.test(l));
      if (!rows.length) throw new Error('no authorized device (run: adb devices)');
      console.log('   ' + rows[0].trim());
    });

    // Grouped for speed: ONE Maestro launch (one ~30s JVM start) per phase instead
    // of one per flow. Phase A = login → Start Workday → PIN. Then read PIN + pair on
    // the web board. Phase B = board → End Workday → blocks-restart → logout-confirm.
    await step('A — login → Start Workday → PIN screen', () =>
      maestro('.maestro/10-phone-a.yaml', { APP_MOBILE: process.env.APP_MOBILE, APP_PASSWORD: process.env.APP_PASSWORD }));

    let pin;
    await step('read the 4-digit PIN off the screen', () => {
      pin = readPin();
      console.log('   PIN = ' + pin);
    });

    // Pair on the web board and HOLD the browser open — the phone un-pairs the moment
    // that tab closes, so pair-web must keep it alive while phase B ends the workday.
    let pairChild = null;
    await step('pair on the web board (type PIN → workday opens, held)', () =>
      new Promise((resolve, reject) => {
        const child = spawn('node', ['scripts/pair-web.mjs', pin],
          { env: { ...process.env, PAIR_HOLD: '220' }, stdio: ['pipe', 'pipe', 'inherit'] });
        let out = '', paired = false;
        child.stdout.on('data', (b) => {
          const s = String(b); process.stdout.write(s); out += s;
          if (!paired && /(^|\n)PAIRED\r?\n/.test(out)) { paired = true; pairChild = child; resolve(); }
        });
        child.on('exit', (code) => { if (!paired) reject(new Error(`pair-web exited (${code}) before pairing`)); });
        child.on('error', reject);
      }));

    await step('B — board → End Workday → blocks restart → logout confirm', () => {
      try { execFileSync(ADB, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { stdio: 'ignore' }); } catch {}
      try {
        maestro('.maestro/11-phone-b.yaml');
      } finally {
        // release the held browser (workday already ended → un-pair is moot)
        try { pairChild && pairChild.stdin.write('STOP\n'); } catch {}
        try { pairChild && setTimeout(() => pairChild.kill(), 8000); } catch {}
      }
    });
  } catch (_) {
    /* the failing step already printed FAIL; fall through to the summary */
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n════════ ${passed}/${results.length} steps passed ════════`);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.err ? ' — ' + r.err : ''}`);
  process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
})();
