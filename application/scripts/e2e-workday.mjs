// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — Backend API end-to-end test for the WORKDAY state machine.
//
// Drives the REAL Odoo JSON-RPC endpoints in sequence and asserts the one-start-
// one-end-per-day rule, exactly as the app would hit them. No UI, no device.
//
//   node scripts/e2e-workday.mjs
//
// Config via env (or a .env you export first):
//   ODOO_URL=https://your-odoo.example.com
//   ODOO_DB=your_db
//   ODOO_LOGIN=developer_login          (a DEVELOPER account — see warning)
//   ODOO_PASSWORD=...
//
// ⚠️  This MUTATES real data: it starts and ENDS the workday for ODOO_LOGIN, which
//     (by design) then blocks a restart until tomorrow. RUN IT WITH A TEST/QA
//     DEVELOPER ACCOUNT, not a real person mid-workday. It is safe to re-run: if
//     the day is already ended it detects that and asserts the "blocked" branch.
// ─────────────────────────────────────────────────────────────────────────────
import axios from 'axios';

const URL = process.env.ODOO_URL;
const DB = process.env.ODOO_DB;
const LOGIN = process.env.ODOO_LOGIN;
const PASSWORD = process.env.ODOO_PASSWORD;

if (!URL || !DB || !LOGIN || !PASSWORD) {
  console.error('Missing env. Set ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_PASSWORD.');
  process.exit(2);
}

const base = URL.replace(/\/+$/, '');
let cookie = '';           // Odoo session cookie, captured at auth
const results = [];        // { name, ok, detail }

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// Odoo type='json' routes speak JSON-RPC 2.0. Returns the `result` payload.
async function rpc(path, params = {}) {
  const res = await axios.post(
    `${base}${path}`,
    { jsonrpc: '2.0', method: 'call', params },
    { headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      validateStatus: () => true },
  );
  // Capture/refresh the session cookie (auth sets it).
  const setC = res.headers['set-cookie'];
  if (setC && setC.length) {
    const sid = setC.map((c) => c.split(';')[0]).find((c) => c.startsWith('session_id='));
    if (sid) cookie = sid;
  }
  if (res.data && res.data.error) {
    throw new Error(res.data.error.data?.message || res.data.error.message || 'rpc error');
  }
  return res.data ? res.data.result : undefined;
}

(async () => {
  try {
    // 1) Authenticate → session cookie.
    const auth = await rpc('/web/session/authenticate', { db: DB, login: LOGIN, password: PASSWORD });
    check('authenticate', !!auth && !!auth.uid, `uid=${auth?.uid}`);
    if (!auth?.uid) throw new Error('auth failed — check credentials/db');

    // 2) Read starting state.
    const s0 = await rpc('/kpi_workday/status', {});
    check('status reachable', s0 && s0.status === true, `is_open=${s0?.is_open} day_done=${s0?.day_done}`);

    if (s0?.day_done) {
      // Day already ended today → assert the BLOCKED branch only (safe, no mutation).
      const ping = await rpc('/kpi_workday/ping', {});
      check('ping blocked after end (day_done)', ping && ping.status === false && ping.day_done === true,
        `status=${ping?.status} day_done=${ping?.day_done}`);
      const gen = await rpc('/kpi_pair/generate', {});
      check('pair/generate returns done (no PIN)', gen && gen.done === true && !gen.pin,
        `done=${gen?.done} hasPin=${!!gen?.pin}`);
      return;
    }

    // 3) Ensure a workday is OPEN (start if needed).
    if (!s0?.is_open) {
      const ping = await rpc('/kpi_workday/ping', {});
      check('ping opens workday', ping && ping.status === true, `opened=${ping?.opened}`);
    } else {
      check('workday already open (reusing)', true);
    }
    const s1 = await rpc('/kpi_workday/status', {});
    check('status is_open after start', s1 && s1.is_open === true && s1.day_done === false,
      `is_open=${s1?.is_open} day_done=${s1?.day_done}`);

    // 4) End the workday.
    const end = await rpc('/kpi_workday/end', { note: 'e2e test end' });
    check('end workday ok', end && end.status !== false, `status=${end?.status}`);

    // 5) Assert one-per-day: ended, and restart is refused everywhere.
    const s2 = await rpc('/kpi_workday/status', {});
    check('status after end: closed + day_done', s2 && s2.is_open === false && s2.day_done === true,
      `is_open=${s2?.is_open} day_done=${s2?.day_done}`);

    const ping2 = await rpc('/kpi_workday/ping', {});
    check('ping refuses restart (day_done)', ping2 && ping2.status === false && ping2.day_done === true,
      `status=${ping2?.status} day_done=${ping2?.day_done}`);

    const gen2 = await rpc('/kpi_pair/generate', {});
    check('pair/generate returns done, no PIN', gen2 && gen2.done === true && !gen2.pin,
      `done=${gen2?.done} hasPin=${!!gen2?.pin}`);

    const st2 = await rpc('/kpi_pair/status', {});
    check('pair/status reports day_done', st2 && st2.day_done === true, `day_done=${st2?.day_done}`);
  } catch (e) {
    check('run completed without exception', false, e.message);
  } finally {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed.`);
    process.exit(failed.length ? 1 : 0);
  }
})();
