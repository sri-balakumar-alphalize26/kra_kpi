// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — Backend API end-to-end test for PAUSE WORKDAY as an ADMIN.
//
// Drives the REAL Odoo JSON-RPC endpoints the app calls, in the order the app
// calls them, and asserts the rule that 19.0.4.4 changed:
//
//   A paused workday blocks Start FOR ADMINS TOO.
//
// _actor_workday_open() used to open with `if _user_is_kpi_admin(): return True`,
// which skipped the is_paused check entirely, so Pause Workday did nothing for an
// admin and Start stayed live on a frozen day. A developer was always blocked
// correctly — so this test is only meaningful run as an ADMIN.
//
// The other half of the rule has to hold as well and is asserted here too: an
// admin with NO open session may still start. They are not logging developer time
// against a session, so the absence of one cannot block them; only a pause they
// opened themselves does.
//
// There is no UI and no device. The app is a pure renderer of this: /kra_kpi/
// tasks/get ships can_start + start_block_reason per task (kra_api.py:96-97) and
// the Start button is `blocked={task.can_start === false}` (KpiActionBoard.js:378,
// :568-569) with a second refusal in the handler (:2218). The app holds no
// opinion of its own, so what this asserts is exactly what the UI will do.
//
//   node scripts/e2e-workday-pause.mjs
//
// Config via env, with test-safe defaults:
//   ODOO_URL   (default http://localhost:8069)
//   ODOO_DB    (default sales_test  ← NOT the live db, on purpose)
//   ODOO_LOGIN / ODOO_PASSWORD  (default admin/admin)
//
// ⚠️  MUTATES workday state for ODOO_LOGIN on ODOO_DB: starts, pauses, resumes and
//     ENDS their day. Point it at a test database. It refuses to run against
//     369application unless ALLOW_LIVE=1, because ending a real person's workday
//     is one-way for the date.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = (process.env.ODOO_URL || 'http://localhost:8069').replace(/\/+$/, '');
const DB = process.env.ODOO_DB || 'sales_test';
const LOGIN = process.env.ODOO_LOGIN || 'admin';
const PASSWORD = process.env.ODOO_PASSWORD || 'admin';

if (DB === '369application' && process.env.ALLOW_LIVE !== '1') {
  console.error('Refusing to run against 369application. This ends a workday, which is '
              + 'one-way for the date. Set ALLOW_LIVE=1 if you really mean it.');
  process.exit(2);
}

let cookie = '';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function rpc(path, params = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params }),
    signal: AbortSignal.timeout(120000),
  });
  const set = res.headers.get('set-cookie');
  if (set) {
    const sid = set.split(',').map((c) => c.trim().split(';')[0]).find((c) => c.startsWith('session_id='));
    if (sid) cookie = sid;
  }
  const data = await res.json().catch(() => ({}));
  if (data.error) throw new Error(data.error.data?.message || data.error.message || 'rpc error');
  return data.result;
}

// call_kw, for reading the database back. The standing rule in this repo is to
// verify against the DB rather than against a route's own success flag.
async function kw(model, method, args = [], kwargs = {}) {
  const r = await rpc('/web/dataset/call_kw', { model, method, args, kwargs });
  return r;
}

const hms = (s) => {
  s = Math.round(s || 0);
  return `${(s / 3600) | 0}h ${((s % 3600) / 60) | 0}m ${s % 60}s`;
};

// The board ships every task; pick one the server says is startable, so the
// before/after comparison is about the PAUSE and not about some unrelated gate
// (client rejection, multitask, admin acceptance) on a task picked at random.
function pickStartable(tasks) {
  return (tasks || []).find((t) => t.can_start === true);
}
function findTask(tasks, id) {
  return (tasks || []).find((t) => t.id === id);
}

(async () => {
  console.log(`\n=== pause-workday e2e — ${LOGIN}@${DB} ===\n`);

  const auth = await rpc('/web/session/authenticate', { db: DB, login: LOGIN, password: PASSWORD });
  check('authenticate', !!auth?.uid, `uid=${auth?.uid}`);
  if (!auth?.uid) throw new Error('auth failed');
  const UID = auth.uid;

  // The test is only meaningful as an admin — a developer was always blocked
  // correctly, so running this as one would prove nothing and pass anyway.
  const isAdmin = await kw('res.users', 'has_group', [[UID], 'kra_kpi_module.group_kra_admin'])
    .catch(() => null);
  const isSystem = await kw('res.users', 'has_group', [[UID], 'base.group_system']).catch(() => null);
  check('actor is an admin (else this proves nothing)', !!(isAdmin || isSystem),
        `kra_admin=${isAdmin} system=${isSystem}`);

  // ── 0. Clean slate: no open session ───────────────────────────────────────
  const s0 = await rpc('/kpi_workday/status', {});
  if (s0?.is_open) {
    console.log('   (a workday was already open — ending it so the test starts clean)');
    await rpc('/kpi_workday/end', { note: '' });
  }

  // ── 1. Admin with NO open session may still start ─────────────────────────
  // The half of the rule that must NOT change. Asserted before opening a day,
  // while that state is genuinely observable.
  const t0 = await rpc('/kra_kpi/tasks/get', { my_tasks_only: false });
  const free = pickStartable(t0?.tasks);
  check('admin with no workday can still start', !!free,
        free ? `task ${free.id} can_start=true` : 'NO startable task — admin is being blocked without a session');

  // ── 2. Open the workday ───────────────────────────────────────────────────
  await rpc('/kpi_workday/ping', {});
  const s1 = await rpc('/kpi_workday/status', {});
  check('workday open', s1?.is_open === true, `is_open=${s1?.is_open}`);

  const t1 = await rpc('/kra_kpi/tasks/get', { my_tasks_only: false });
  const target = pickStartable(t1?.tasks);
  check('a startable task exists while open', !!target, target ? `task ${target.id} "${target.name}"` : '');
  if (!target) throw new Error('no startable task to test against');

  // ── 3. Pause ──────────────────────────────────────────────────────────────
  const p = await rpc('/kpi_workday/pause', { note: 'e2e pause test' });
  check('pause accepted', p?.status === true, p?.message || '');

  // Read it back from the DB rather than trusting the route's own flag.
  const sess = await kw('kpi.work.session', 'search_read',
    [[['user_id', '=', UID], ['state', '=', 'open']],
     ['id', 'is_paused', 'paused_at', 'login_at', 'presence_seconds']], { limit: 1 });
  const row = sess?.[0];
  check('db says the session is paused', row?.is_paused === true,
        `session ${row?.id} paused_at=${row?.paused_at}`);

  // ── 4. THE FIX: can_start must now be false, with the right reason ────────
  const t2 = await rpc('/kra_kpi/tasks/get', { my_tasks_only: false });
  const paused = findTask(t2?.tasks, target.id);
  check('THE FIX — can_start is false while paused', paused?.can_start === false,
        `can_start=${paused?.can_start}`);
  check('THE FIX — reason is workday_paused', paused?.start_block_reason === 'workday_paused',
        `start_block_reason="${paused?.start_block_reason}"`);

  // Not one task — EVERY task. can_start is per-row, so a gate that only caught
  // some of them would still leave a live Start button on the board.
  const anyStartable = (t2?.tasks || []).filter((t) => t.can_start === true);
  check('no task anywhere is startable while paused', anyStartable.length === 0,
        `${anyStartable.length} of ${t2?.tasks?.length} still startable`);

  // ── 5. And the server actually refuses the action ─────────────────────────
  // can_start drives the button; this is the door behind it.
  let refused = false, refusal = '';
  try {
    const r = await rpc('/kra_kpi/task/start', { kpi_id: target.id });
    refused = r?.status === false;
    refusal = r?.message || JSON.stringify(r);
  } catch (e) {
    refused = true;                      // a ValidationError is also a refusal
    refusal = e.message;
  }
  check('starting a task is refused while paused', refused, refusal.slice(0, 120));
  check('the refusal names the pause', /pause/i.test(refusal), refusal.slice(0, 120));

  // ── 6. Presence stops at the pause (19.0.4.3) ─────────────────────────────
  const sess2 = await kw('kpi.work.session', 'search_read',
    [[['id', '=', row.id]], ['login_at', 'paused_at', 'presence_seconds']], {});
  const r2 = sess2?.[0];
  const predicted = (Date.parse(r2.paused_at + 'Z') - Date.parse(r2.login_at + 'Z')) / 1000;
  const drift = Math.abs((r2.presence_seconds || 0) - predicted);
  check('Presence stopped at paused_at', drift < 90,
        `presence=${hms(r2.presence_seconds)} vs paused_at-login=${hms(predicted)} drift=${drift.toFixed(1)}s`);

  // ── 7. Resume puts it back ────────────────────────────────────────────────
  const rz = await rpc('/kpi_workday/resume', {});
  check('resume accepted', rz?.status === true, rz?.message || '');

  const t3 = await rpc('/kra_kpi/tasks/get', { my_tasks_only: false });
  const back = findTask(t3?.tasks, target.id);
  check('can_start is true again after resume', back?.can_start === true, `can_start=${back?.can_start}`);

  // ── 8. Leave the day closed ───────────────────────────────────────────────
  await rpc('/kpi_workday/end', { note: 'e2e pause test — automated' });
  const s9 = await rpc('/kpi_workday/status', {});
  check('workday ended (clean exit)', s9?.is_open === false, `is_open=${s9?.is_open}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILED:');
    failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? '  — ' + f.detail : '')));
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.log('\nFATAL ' + e.message); process.exit(1); });
