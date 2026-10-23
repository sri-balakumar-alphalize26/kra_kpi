// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — Backend API end-to-end test for PAUSE WORKDAY. Role-aware: run it as
// an ADMIN to prove the fix, and as a DEVELOPER to prove the branch beside it did
// not regress.
//
// Drives the REAL Odoo JSON-RPC endpoints the app calls, in the order the app
// calls them, and asserts the rule that 19.0.4.4 changed:
//
//   A paused workday blocks Start FOR ADMINS TOO.
//
// _actor_workday_open() used to open with `if _user_is_kpi_admin(): return True`,
// which skipped the is_paused check entirely, so Pause Workday did nothing for an
// admin and Start stayed live on a frozen day. A developer was always blocked
// correctly, so the ADMIN run is the one that proves the fix.
//
// EXACTLY ONE assertion differs by role — the state with no workday open:
//
//   ADMIN     -> allowed. They log no developer time against a session, so the
//                absence of one cannot block them; only a pause they opened does.
//   DEVELOPER -> blocked, reason 'workday'. Their task time has to land inside a
//                session or it is recorded against nothing.
//
// That asymmetry is the thing a refactor could most plausibly invert, which is why
// it is asserted rather than assumed. Everything else about a pause is identical
// for both roles, so this is one script rather than two that could drift.
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

  // WHICH ROLE decides exactly one assertion below. Everything else about a pause
  // is identical for both, which is why this is one script rather than two that
  // could drift apart.
  const isAdmin = await kw('res.users', 'has_group', [[UID], 'kra_kpi_module.group_kra_admin'])
    .catch(() => null);
  const isSystem = await kw('res.users', 'has_group', [[UID], 'base.group_system']).catch(() => null);
  const ADMIN = !!(isAdmin || isSystem);
  console.log(`role: ${ADMIN ? 'ADMIN' : 'DEVELOPER'}  (kra_admin=${isAdmin} system=${isSystem})`);
  console.log('');

  // -- 0. Normalise to "no open session, and re-openable" ---------------------
  // The asymmetry below is only observable with NO open session, so a day already
  // open has to be closed first. But ending one sets day_done, and
  // one-start-one-end-per-day then REFUSES to reopen the date -- which is exactly
  // how the second run of this script went wrong: /kpi_workday/ping quietly did
  // nothing, every assertion after it ran against a closed day, and the one that
  // expects Start to be refused instead STARTED a task and left it running.
  //
  // So end it and then REVERT it. /kpi_workday/revert is the admin undo of an
  // explicit End Workday: it clears day_done and leaves the date re-openable.
  let s0 = await rpc('/kpi_workday/status', {});
  if (s0?.is_open) {
    console.log('   (a workday was open -- ending it so the asymmetry is observable)');
    await rpc('/kpi_workday/end', { note: '' });
    s0 = await rpc('/kpi_workday/status', {});
  }
  if (s0?.day_done) {
    try {
      await rpc('/kpi_workday/revert', { reason: 'e2e-workday-pause: reopening the date' });
      s0 = await rpc('/kpi_workday/status', {});
      console.log('   (reverted the ended day so it can be reopened)');
    } catch (e) {
      console.log('   (could not revert the ended day: ' + e.message + ')');
    }
  }
  // Refuse to continue rather than emit a cascade of failures that all trace back
  // to one unopenable day. A developer cannot revert, so this is the likely exit
  // on a repeat dev run within the same date.
  if (s0?.is_open || s0?.day_done) {
    console.error(`
Cannot run: need a date with no open session and not already `
                + `ended (is_open=${s0?.is_open} day_done=${s0?.day_done}). `
                + `Revert it as an admin, or run tomorrow.`);
    process.exit(2);
  }

  // -- 1. THE ASYMMETRY, with no open session ---------------------------------
  // The one assertion that differs by role, and the one a refactor of
  // _actor_workday_open() could most plausibly invert:
  //
  //   ADMIN     -> allowed. They log no developer time against a session, so the
  //                absence of one cannot block them. Only a pause they opened
  //                themselves does.
  //   DEVELOPER -> blocked, reason 'workday'. Their task time has to land inside
  //                a session or it is recorded against nothing, which is exactly
  //                the hole the workday gate exists to close.
  //
  // Asserted BEFORE opening a day, while that state is genuinely observable.
  const t0 = await rpc('/kra_kpi/tasks/get', { my_tasks_only: false });
  const free = pickStartable(t0?.tasks);
  if (ADMIN) {
    check('ASYMMETRY -- admin with no workday can still start', !!free,
          free ? `task ${free.id} can_start=true` : 'NO startable task -- admin is blocked without a session');
  } else {
    const all = t0?.tasks || [];
    const byWorkday = all.filter((t) => t.start_block_reason === 'workday');
    check('ASYMMETRY -- developer with no workday cannot start', !free && all.length > 0,
          `${all.filter((t) => t.can_start === false).length} of ${all.length} blocked`);
    check('ASYMMETRY -- and the reason is the missing workday', byWorkday.length > 0,
          `${byWorkday.length} of ${all.length} report start_block_reason 'workday'`);
  }

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
  // If it was NOT refused the task is now RUNNING, and leaving it that way
  // leaves an orphaned open kpi.time.log behind -- the exact thing that then
  // counts as work nobody did. A failing test must not also make a mess, so
  // put it back before reporting.
  if (!refused) {
    try {
      await rpc('/kra_kpi/task/pause',
        { kpi_id: target.id, reason: 'e2e cleanup -- start was not refused', reason_code: 'other', meeting_with_ids: [] });
      console.log('   (cleaned up: the task that should not have started was paused again)');
    } catch (e) { console.log('   (COULD NOT clean up the started task: ' + e.message + ')'); }
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
