// Reads the 4-digit pairing PIN off the StartWorkingScreen. The PIN is rendered as
// FOUR separate single-char <Text> cells (style pinDigit) — there is no whole-string
// node — so we dump the live view hierarchy (`maestro hierarchy` → JSON), collect
// every leaf text node whose text is exactly one digit, group them into horizontal
// rows, and read the row of four left-to-right. Other text on that screen
// ("Regenerate in 9s") is a multi-char node, so it never matches a single digit.
//
//   node scripts/read-pin.mjs        → prints the PIN
//   import { readPin } from './read-pin.mjs'
import { execSync } from 'node:child_process';

const MAESTRO = process.env.MAESTRO_BIN || 'C:/Users/sriba/.maestro/maestro/bin/maestro.bat';
const ADB = process.env.ADB_BIN || 'C:/Users/sriba/platform-tools/adb.exe';

function hierarchy() {
  // Use execSync (runs via the shell) — on Windows execFileSync cannot spawn a .bat
  // directly (EINVAL). Quote the path in case it ever contains spaces.
  const out = execSync(`"${MAESTRO}" hierarchy`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // maestro prints a "Running on <device>" banner before the JSON — start at first '{'.
  const i = out.indexOf('{');
  if (i < 0) throw new Error('no JSON found in `maestro hierarchy` output');
  return JSON.parse(out.slice(i));
}

// bounds string "[x1,y1][x2,y2]" → center + left x
function parseBounds(b) {
  const m = /\[(\d+),(\d+)]\[(\d+),(\d+)]/.exec(b || '');
  if (!m) return null;
  const x1 = +m[1], y1 = +m[2], x2 = +m[3], y2 = +m[4];
  return { x: x1, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 };
}

function collectDigits(node, acc) {
  const a = node.attributes || {};
  const t = (a.text || '').trim();
  if (/^[0-9]$/.test(t)) {
    const b = parseBounds(a.bounds);
    if (b) acc.push({ d: t, ...b });
  }
  for (const c of node.children || []) collectDigits(c, acc);
  return acc;
}

// Portable synchronous sleep (read-pin is a plain sync helper, no async plumbing).
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

// Read the 4-digit PIN from an already-fetched hierarchy, or null if not a full PIN yet.
function pinFromHierarchy(root) {
  const digits = collectDigits(root, []);
  if (digits.length < 4) return null;
  // Group into rows by vertical center (tolerance), then pick the row of exactly 4.
  const TOL = 40;
  const rows = [];
  for (const dg of digits.slice().sort((a, b) => a.cy - b.cy)) {
    let row = rows.find((r) => Math.abs(r.cy - dg.cy) <= TOL);
    if (!row) { row = { cy: dg.cy, items: [] }; rows.push(row); }
    row.items.push(dg);
  }
  const row = rows.find((r) => r.items.length === 4);
  if (!row) return null;
  const pin = row.items.slice().sort((a, b) => a.x - b.x).slice(0, 4).map((d) => d.d).join('');
  return /^\d{4}$/.test(pin) ? pin : null;
}

// Find the on-screen center of the first node whose text contains `needle` (case-insensitive).
function findNodeCenter(node, needle) {
  const a = node.attributes || {};
  const t = (a.text || '').trim();
  if (t.toLowerCase().includes(needle.toLowerCase())) {
    const b = parseBounds(a.bounds);
    if (b) return { x: Math.round(b.cx), y: Math.round(b.cy) };
  }
  for (const c of node.children || []) { const r = findNodeCenter(c, needle); if (r) return r; }
  return null;
}

// Retry the read. Right after Start Workday the PIN can still be generating (dashes), and if
// the initial generate failed — e.g. Odoo was mid-restart — the app leaves the cells as
// dashes and will NOT retry on its own. So every few empty reads, tap the on-screen
// "Regenerate PIN" button (located from the live hierarchy, no hard-coded coords) to force a
// fresh generate, then keep polling until a full 4-digit PIN settles.
export function readPin({ retries = 24, delayMs = 2200 } = {}) {
  for (let i = 0; i < retries; i++) {
    let root = null;
    try { root = hierarchy(); } catch { root = null; }
    if (root) {
      const pin = pinFromHierarchy(root);
      if (pin) return pin;
      if (i > 0 && i % 4 === 0) {
        const c = findNodeCenter(root, 'Regenerate PIN');
        if (c) { try { execSync(`"${ADB}" shell input tap ${c.x} ${c.y}`); } catch {} }
      }
    }
    sleepSync(delayMs);
  }
  throw new Error('could not read a 4-digit PIN after retries — is the PIN screen showing / did the PIN generate?');
}

// Run directly → print the PIN (stdout only, so callers can capture it).
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/read-pin.mjs')) {
  try { process.stdout.write(readPin()); }
  catch (e) { console.error('read-pin failed:', e.message); process.exit(3); }
}
