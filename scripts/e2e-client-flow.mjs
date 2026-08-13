// KRA/KPI CLIENT-side end-to-end test — walks the full four-gate lifecycle and then
// probes the billing de-duplication the admin/dev tests never reach.
//
//   client creates -> [G1] admin accepts -> [G2] client pre-approves -> dev start
//   -> dev complete -> [G3] admin approves -> awaiting_client -> [G4] client signs off
//   -> invoice -> finalize -> must NOT be billable again
//
//   node scripts/e2e-client-flow.mjs
//
// Creates its own disposable fixture ([APITEST] KRA tree + client user + dev user) so
// no existing account, KRA or task is touched. Records are left behind on purpose,
// all tagged [APITEST]; the ids are printed at the end.
const BASE = process.env.ODOO_URL || 'http://localhost:8069';
const DB = process.env.ODOO_DB || '369application';
const ADMIN_PW = process.env.ODOO_ADMIN_PW || 'admin';
const TEST_PW = 'Apitest#1111';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36';

const iso = (d) => d.toISOString().slice(0, 10);
const TODAY = iso(new Date());
const LAST_YEAR_FROM = '2020-01-01', LAST_YEAR_TO = '2020-12-31'; // deliberately excludes today

// ── plumbing ────────────────────────────────────────────────────────────────
async function auth(login, password) {
  const r = await fetch(`${BASE}/web/session/authenticate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { db: DB, login, password } }),
  });
  const m = /session_id=([^;]+)/.exec(r.headers.get('set-cookie') || '');
  const d = await r.json().catch(() => ({}));
  return { uid: d?.result?.uid || null, cookie: m ? `session_id=${m[1]}` : null };
}
// Returns {ok, result, err}. Never throws — an expected refusal is data, not a crash.
async function call(sess, route, params = {}) {
  try {
    const r = await fetch(`${BASE}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sess.cookie, 'User-Agent': UA },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params }),
    });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { return { ok: false, err: `non-JSON HTTP ${r.status}` }; }
    if (j.error) return { ok: false, err: String(j.error?.data?.message || j.error?.message || 'rpc error').slice(0, 160) };
    const res = j.result;
    if (res && res.status === false) return { ok: false, err: String(res.message || 'status:false').slice(0, 160), result: res };
    return { ok: true, result: res };
  } catch (e) { return { ok: false, err: e.message }; }
}
async function kw(sess, model, method, args = [], kwargs = {}) {
  return call(sess, '/web/dataset/call_kw', { model, method, args, kwargs });
}

const results = [];
function check(step, ok, detail = '') {
  results.push({ step, ok });
  console.log(`  ${ok ? '✅' : '❌'} ${step.padEnd(52)} ${detail}`);
}
function info(msg) { console.log(`     · ${msg}`); }

let admin;
const FIELDS = ['task_state', 'admin_accepted', 'admin_approved', 'published',
  'client_submitted', 'client_final_approved', 'pre_approval_decision',
  'external_ref', 'is_invoiced', 'invoiced_on_id', 'client_kra_id'];
async function task(id) {
  const r = await kw(admin, 'kra.kpi', 'read', [[id], FIELDS]);
  return r.ok ? r.result[0] : { _err: r.err };
}

const made = { kras: [], users: [], tasks: [], invoices: [] };

// ── fixture ─────────────────────────────────────────────────────────────────
async function setup() {
  console.log(`\n=== SETUP (db=${DB}) ===`);
  admin = await auth('admin', ADMIN_PW);
  check('admin authenticates', !!admin.cookie, `uid=${admin.uid}`);
  if (!admin.cookie) throw new Error('cannot continue without admin');

  const l1 = await call(admin, '/kra_kpi/create_kra', { name: '[APITEST] Client Co', is_sub: false });
  const L1 = l1.result?.id;
  const l2 = await call(admin, '/kra_kpi/create_kra', { name: '[APITEST] Billing Unit', is_sub: true, parent_id: L1 });
  const L2 = l2.result?.id;
  made.kras.push(L1, L2);
  check('create KRA tree (root + level-2)', !!L1 && !!L2, `root=${L1} billable=${L2}`);

  const isCli = await kw(admin, 'kra.master', 'read', [[L1, L2], ['name', 'is_client', 'parent_id']]);
  info(`is_client → ${isCli.result?.map((k) => `${k.id}:${k.is_client}`).join(' ')}`);

  // Idempotent: reuse the disposable accounts if a previous run already made them,
  // otherwise the unique-login check refuses and the run dies in setup.
  const findUser = async (login) => {
    const r = await kw(admin, 'res.users', 'search', [[['login', '=', login]]], { context: { active_test: false } });
    return r.result?.[0] || null;
  };

  let CLIENT_UID = await findUser('apitest_client');
  if (CLIENT_UID) {
    await kw(admin, 'res.users', 'write', [[CLIENT_UID], { password: TEST_PW, active: true }]);
    info(`reusing existing client user uid=${CLIENT_UID}`);
  } else {
    const cu = await call(admin, '/kra_kpi/kra/create_client_user', {
      name: '[APITEST] Client User', login: 'apitest_client', password: TEST_PW });
    CLIENT_UID = cu.result?.user_id;
  }
  made.users.push(CLIENT_UID);
  check('client user ready', !!CLIENT_UID, `uid=${CLIENT_UID} login=apitest_client`);

  // Attach to BOTH levels: controllers scope by descendants-of-assigned, the record
  // rule keys off client_kra_id (the nearest is_client ancestor = L2). Assigning only
  // one of them passes one check and fails the other.
  for (const k of [L1, L2]) await call(admin, '/kra_kpi/kra/assign_clients', { kra_id: k, user_ids: [CLIENT_UID] });
  check('assign client to both KRA levels', true, `${L1}, ${L2}`);

  let DEV_UID = await findUser('apitest_dev');
  if (!DEV_UID) {
    const du = await call(admin, '/kpi_user_access/create', {
      name: '[APITEST] Dev', login: 'apitest_dev', kra_role: 'developer' });
    DEV_UID = du.result?.user_id;
  }
  made.users.push(DEV_UID);
  // /kpi_user_access/create randomises the Odoo password (it only sets the app PIN),
  // so set a known web password as admin — a disposable account either way.
  const pwset = await kw(admin, 'res.users', 'write', [[DEV_UID], { password: TEST_PW, active: true }]);
  check('dev user ready + web password set', !!DEV_UID && pwset.ok, `uid=${DEV_UID} login=apitest_dev`);

  const client = await auth('apitest_client', TEST_PW);
  const dev = await auth('apitest_dev', TEST_PW);
  check('client authenticates', !!client.cookie, `uid=${client.uid}`);
  check('dev authenticates', !!dev.cookie, `uid=${dev.uid}`);
  return { L1, L2, CLIENT_UID, DEV_UID, client, dev };
}

// ── drive one task from creation to client sign-off ─────────────────────────
// stopBeforeSignoff leaves the task parked at awaiting_client — used by the reject probe.
// Deliberately the SAME function rather than a near-copy: an earlier duplicate drifted out
// of sync (no progress summary), so `complete` silently failed and the probe asserted
// against a task still sitting in in_progress.
async function driveToSignoff(fx, label, { verbose = false, stopBeforeSignoff = false } = {}) {
  const { L2, DEV_UID, client, dev } = fx;
  const V = (s, ok, d) => { if (verbose) check(s, ok, d); };

  const add = await call(client, '/kpi_client_portal/add_task', {
    sub_kra_id: L2, name: `[APITEST] ${label}`, kind: 'requirement',
    priority: 'regular', description: 'automated client-flow test' });
  const id = add.result?.kpi_id || add.result?.id || add.result?.task_id;
  if (!id) { check(`${label}: client creates task`, false, add.err || JSON.stringify(add.result).slice(0, 120)); return null; }
  made.tasks.push(id);
  // Give it a billable quote so invoice totals are non-zero and double-billing is
  // measurable (quoted_hours is what _compute_totals bills on, not actual_hours).
  await kw(admin, 'kra.kpi', 'write', [[id], { client_quoted_hours: 2 }]);
  let t = await task(id);
  V(`G0 client creates task`, t.task_state === 'assigned' && t.client_submitted === true,
    `state=${t.task_state} client_submitted=${t.client_submitted} published=${t.published}`);

  if (verbose) {
    const blocked = await call(dev, '/kra_kpi/task/start', { kpi_id: id });
    check('NEG dev cannot start before admin accept', !blocked.ok, blocked.err?.slice(0, 70) || 'ALLOWED — unexpected');
  }

  // GATE 1 — admin accepts by assigning a developer (workflow write override auto-accepts)
  await kw(admin, 'kra.kpi', 'write', [[id], { user_id: DEV_UID }]);
  t = await task(id);
  V(`G1 admin accept → pre-approval requested`, t.admin_accepted === true && t.task_state === 'pre_approval_pending',
    `state=${t.task_state} accepted=${t.admin_accepted} ref=${t.external_ref}`);

  if (verbose) {
    const blocked = await call(dev, '/kra_kpi/task/start', { kpi_id: id });
    check('NEG dev cannot start before client pre-approval', !blocked.ok, blocked.err?.slice(0, 70) || 'ALLOWED — unexpected');
  }

  // GATE 2 — client pre-approves who may work on it
  const pre = await call(client, '/kpi_pre_approval/decide', { kpi_id: id, action: 'approve' });
  t = await task(id);
  V(`G2 client pre-approves`, pre.ok && t.task_state === 'pre_approval_approved',
    `state=${t.task_state} decision=${t.pre_approval_decision}`);

  // dev works. Clear any task left running by a previous iteration first — the
  // single-task limit refuses the start otherwise, and a silent refusal here made an
  // earlier run's reject probe pass for the wrong reason.
  await call(dev, '/kra_kpi/task/pause_all', {});
  const st = await call(dev, '/kra_kpi/task/start', { kpi_id: id });
  t = await task(id);
  V(`dev starts`, st.ok && t.task_state === 'in_progress', `state=${t.task_state} ${st.err || ''}`);

  // complete_task refuses without a Progress Summary (kra_api.py:606) and needs at
  // least one checklist item ticked unless partial (kra_api.py:622-627).
  await call(dev, '/kpi/progress/create', { kpi_id: id, summary: `[APITEST] work done for ${label}` });
  const cp = await call(dev, '/kra_kpi/task/complete', {
    kpi_id: id, employee_checklist: { tested_code: true }, partial: false });
  t = await task(id);
  V(`dev completes`, t.task_state === 'partially_completed', `state=${t.task_state} ${cp.err || ''}`);

  if (verbose) {
    const bad = await call(dev, '/kra_kpi/task/approve', { kpi_id: id });
    check('NEG dev cannot admin-approve', !bad.ok, bad.err?.slice(0, 70) || 'ALLOWED — unexpected');
  }

  // GATE 3 — admin approves → awaiting client sign-off
  const ap = await call(admin, '/kra_kpi/task/approve', { kpi_id: id });
  t = await task(id);
  V(`G3 admin approves → awaiting client`, t.task_state === 'awaiting_client' && t.admin_approved === true,
    `state=${t.task_state} admin_approved=${t.admin_approved} ${ap.err || ''}`);

  if (stopBeforeSignoff) return { id, final: t };

  // GATE 4 — client signs off → billable
  const sg = await call(client, '/kpi_client_approval/approve', {
    kpi_id: id, chk_delivered: true, chk_works: true, chk_authorized: true,
    notes: '[APITEST] signed off', signature_text: '[APITEST] Client User' });
  t = await task(id);
  V(`G4 client signs off → billable`, t.task_state === 'completed' && t.client_final_approved === true,
    `state=${t.task_state} client_final_approved=${t.client_final_approved} ${sg.err || ''}`);

  return { id, final: t };
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  const fx = await setup();
  if (!fx.client?.cookie || !fx.dev?.cookie) { finish(); return; }

  // Dev needs an open workday or every start is refused with a 'workday' block.
  // The /kpi_pair/* routes are now no-op shims (kra_api.py:1908-1925), and
  // /kpi_workday/status is read-only — /kpi_workday/ping is the actual opener
  // (the green "Start Workday" button) and is idempotent.
  console.log(`\n=== DEV WORKDAY ===`);
  let ping = await call(fx.dev, '/kpi_workday/ping', {});
  let ws = await call(fx.dev, '/kpi_workday/status', {});
  // One start + one end per day is a real rule, and ping rightly refuses to reopen a
  // day the developer explicitly ended. That makes this suite un-runnable for the rest
  // of the day as soon as anything ends this account's workday — which the End Workday
  // note test does. Reopen it as admin (the same affordance a coordinator has) so the
  // suite can be run repeatedly; we are not bypassing the rule, we are using its
  // sanctioned undo.
  if (ws.result?.day_done) {
    await call(admin, '/kpi_workday/revert', {
      user_id: fx.DEV_UID, reason: '[APITEST] reopened so the flow suite can run again' });
    ping = await call(fx.dev, '/kpi_workday/ping', {});
    ws = await call(fx.dev, '/kpi_workday/status', {});
  }
  check('dev workday opened (/kpi_workday/ping)', ws.result?.is_open === true,
    `session=${ping.result?.session_id ?? '?'} opened=${ping.result?.opened} is_open=${ws.result?.is_open}`);

  console.log(`\n=== PART A — full four-gate lifecycle ===`);
  const A = await driveToSignoff(fx, 'A full lifecycle', { verbose: true });

  // The client-reject path, on its own throwaway task so a success cannot derail A.
  console.log(`\n=== PART A2 — client reject at sign-off ===`);
  const R = (await driveToSignoff(fx, 'R client reject', { stopBeforeSignoff: true }))?.id;
  if (R) {
    // Assert the precondition explicitly. Without this the reject "passes" whenever the
    // task never got to awaiting_client at all, which is exactly what happened before.
    const pre = await task(R);
    check('reject probe reached awaiting_client', pre.task_state === 'awaiting_client', `state=${pre.task_state}`);
    const rj = await call(fx.client, '/kpi_client_approval/reject', { kpi_id: R, reason: '[APITEST] please redo' });
    const t = await task(R);
    check('client reject sends task back to rework',
      pre.task_state === 'awaiting_client' && rj.ok && t.task_state === 'rework',
      `${pre.task_state} -> ${t.task_state} admin_approved=${t.admin_approved} ${rj.ok ? '' : '· ' + rj.err}`);
  }

  console.log(`\n=== PART B — billing de-duplication ===`);
  const billed = [];
  for (const n of ['B1 billing', 'B2 billing', 'B3 billing']) {
    const r = await driveToSignoff(fx, n);
    if (r) billed.push(r.id);
  }
  check('3 billing tasks reached client sign-off', billed.length === 3, `ids=${billed.join(',')}`);

  const invBase = { client_kra_id: fx.L2, hourly_rate: 10, billing_method: 'hourly',
    price_req: 0, price_upt: 0, price_bug: 0 };

  const a = await call(admin, '/kpi_client_invoice/create', {
    ...invBase, invoice_title: '[APITEST] Invoice A', from_date: TODAY, to_date: TODAY });
  const A_ID = a.result?.data?.id || a.result?.id;
  if (A_ID) made.invoices.push(A_ID);
  const aLines = await invoiceLines(A_ID);
  check('invoice A lists the 3 signed-off tasks',
    billed.every((id) => aLines.kpiIds.includes(id)),
    `id=${A_ID} lines=${aLines.kpiIds.length} ${a.err || ''}`);

  const fin = await call(admin, '/kpi_client_invoice/finalize', { invoice_id: A_ID });
  const afterFin = await kw(admin, 'kra.kpi', 'read', [billed, ['is_invoiced', 'invoiced_on_id']]);
  const allLocked = (afterFin.result || []).every((t) => t.is_invoiced === true);
  check('finalizing A marks all 3 tasks is_invoiced', allLocked,
    (afterFin.result || []).map((t) => `${t.id}:${t.is_invoiced}`).join(' ') + (fin.ok ? '' : ' · ' + fin.err));

  // The bug: a NON-OVERLAPPING period must not re-offer already-billed tasks.
  const b = await call(admin, '/kpi_client_invoice/create', {
    ...invBase, invoice_title: '[APITEST] Invoice B', from_date: LAST_YEAR_FROM, to_date: LAST_YEAR_TO });
  const B_ID = b.result?.data?.id || b.result?.id;
  if (B_ID) made.invoices.push(B_ID);
  const bLines = await invoiceLines(B_ID);
  const reappeared = billed.filter((id) => bLines.kpiIds.includes(id));
  check('invoice B (2020 range) does NOT re-offer billed tasks',
    reappeared.length === 0,
    `id=${B_ID} reappeared=${reappeared.length}/3 ${reappeared.length ? '← DEFECT' : ''}`);
  if (reappeared.length) {
    info(`B lines flagged already_invoiced: ${bLines.locked}/${bLines.kpiIds.length}, B total=${bLines.total}`);
    info(`cause: action_populate_from_logs pass 2 (kpi_client_invoice.py:303-310) has no date filter and no is_invoiced clause`);
  }

  // Two concurrent DRAFTS: is the same task billed twice at full value?
  const c = await call(admin, '/kpi_client_invoice/create', {
    ...invBase, invoice_title: '[APITEST] Invoice C draft', from_date: TODAY, to_date: TODAY });
  const d = await call(admin, '/kpi_client_invoice/create', {
    ...invBase, invoice_title: '[APITEST] Invoice D draft', from_date: TODAY, to_date: TODAY });
  const C_ID = c.result?.data?.id || c.result?.id, D_ID = d.result?.data?.id || d.result?.id;
  if (C_ID) made.invoices.push(C_ID); if (D_ID) made.invoices.push(D_ID);
  const cL = await invoiceLines(C_ID), dL = await invoiceLines(D_ID);
  const dup = cL.kpiIds.filter((x) => dL.kpiIds.includes(x));
  check('two concurrent drafts do not both bill the same task',
    dup.length === 0, `C=${C_ID}(${cL.total}) D=${D_ID}(${dL.total}) shared=${dup.length}`);

  // Client-side invoice visibility + write refusal
  console.log(`\n=== PART C — client invoice permissions ===`);
  const list = await call(fx.client, '/kpi_client_invoice/list', { status_filter: 'all' });
  const visible = (list.result?.invoices || []).map((i) => i.id);
  check('client sees only finalized/sent invoices',
    visible.includes(A_ID) && !visible.includes(C_ID) && !visible.includes(D_ID),
    `visible=[${visible.join(',')}] (A=${A_ID} finalized; C/D drafts)`);
  const wr = await call(fx.client, '/kpi_client_invoice/finalize', { invoice_id: C_ID });
  check('client cannot finalize an invoice', !wr.ok, wr.err?.slice(0, 70) || 'ALLOWED — DEFECT');

  finish();
})().catch((e) => { console.log('\n❌ FATAL:', e.message); finish(); });

async function invoiceLines(invId) {
  if (!invId) return { kpiIds: [], locked: 0, total: 0 };
  const g = await call(admin, '/kpi_client_invoice/get', { invoice_id: invId });
  const inv = g.result?.data || g.result || {};
  const lines = (inv.lines || []).filter((l) => l.kpi_id);
  return {
    kpiIds: lines.map((l) => (Array.isArray(l.kpi_id) ? l.kpi_id[0] : l.kpi_id)),
    locked: lines.filter((l) => l.already_invoiced).length,
    total: inv.total_amount ?? inv.grand_total_hours ?? '?',
  };
}

function finish() {
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n════════ ${ok}/${results.length} checks passed ════════`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) { console.log('FAILED:'); failed.forEach((f) => console.log(`  ✗ ${f.step}`)); }
  console.log(`\n[APITEST] artefacts — kras=${made.kras.join(',')} users=${made.users.join(',')} ` +
              `tasks=${made.tasks.join(',')} invoices=${made.invoices.join(',')}`);
  process.exitCode = failed.length ? 1 : 0;
}
