// Focused probes for the two billing defects the main flow test could not isolate,
// plus the missing state guard on the client sign-off route.
//
//   node scripts/e2e-billing-dedup.mjs
//
// Uses its own fresh [APITEST] KRA tree so no already-finalized invoice can mask the
// result (that masking is exactly what confounded the first attempt).
const BASE = process.env.ODOO_URL || 'http://localhost:8069';
const DB = process.env.ODOO_DB || '369application';
const TEST_PW = 'Apitest#1111';
const TODAY = new Date().toISOString().slice(0, 10);

async function auth(login, password) {
  const r = await fetch(`${BASE}/web/session/authenticate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { db: DB, login, password } }) });
  const m = /session_id=([^;]+)/.exec(r.headers.get('set-cookie') || '');
  const d = await r.json().catch(() => ({}));
  return { uid: d?.result?.uid || null, cookie: m ? `session_id=${m[1]}` : null };
}
async function call(s, route, params = {}) {
  const r = await fetch(`${BASE}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: s.cookie },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params }) });
  const j = await r.json().catch(() => ({}));
  if (j.error) return { ok: false, err: String(j.error?.data?.message || '').slice(0, 140) };
  if (j.result && j.result.status === false) return { ok: false, err: String(j.result.message || '').slice(0, 140), result: j.result };
  return { ok: true, result: j.result };
}
const kw = (s, model, method, args = [], kwargs = {}) =>
  call(s, '/web/dataset/call_kw', { model, method, args, kwargs });

const out = [];
const check = (s, ok, d = '') => { out.push({ s, ok }); console.log(`  ${ok ? '✅' : '❌'} ${s.padEnd(56)} ${d}`); };

(async () => {
  const admin = await auth('admin', 'admin');
  const client = await auth('apitest_client', TEST_PW);
  const dev = await auth('apitest_dev', TEST_PW);
  const devUid = dev.uid;

  // fresh tree so no prior finalized invoice locks anything
  const L1 = (await call(admin, '/kra_kpi/create_kra', { name: '[APITEST] Dedup Co', is_sub: false })).result?.id;
  const L2 = (await call(admin, '/kra_kpi/create_kra', { name: '[APITEST] Dedup Unit', is_sub: true, parent_id: L1 })).result?.id;
  for (const k of [L1, L2]) await call(admin, '/kra_kpi/kra/assign_clients', { kra_id: k, user_ids: [client.uid] });
  await call(dev, '/kpi_workday/ping', {});
  console.log(`\n=== fixture: kra ${L1}/${L2} ===`);

  async function signedOffTask(label) {
    const id = (await call(client, '/kpi_client_portal/add_task', {
      sub_kra_id: L2, name: `[APITEST] ${label}`, kind: 'requirement', priority: 'regular', description: 'dedup probe' })).result?.kpi_id;
    await kw(admin, 'kra.kpi', 'write', [[id], { client_quoted_hours: 3 }]);
    await kw(admin, 'kra.kpi', 'write', [[id], { user_id: devUid }]);
    await call(client, '/kpi_pre_approval/decide', { kpi_id: id, action: 'approve' });
    // Release whatever the previous iteration left running, or the single-task limit
    // refuses this start and the task reaches sign-off with no time logs at all.
    await call(dev, '/kra_kpi/task/pause_all', {});
    const st = await call(dev, '/kra_kpi/task/start', { kpi_id: id });
    await call(dev, '/kpi/progress/create', { kpi_id: id, summary: '[APITEST] done' });
    await call(dev, '/kra_kpi/task/complete', { kpi_id: id, employee_checklist: { tested_code: true }, partial: false });
    await call(admin, '/kra_kpi/task/approve', { kpi_id: id });
    await call(client, '/kpi_client_approval/approve', { kpi_id: id, chk_delivered: true, chk_works: true,
      chk_authorized: true, notes: 'ok', signature_text: '[APITEST]' });
    return { id, started: st.ok, startErr: st.err };
  }

  const t1 = await signedOffTask('D1'), t2 = await signedOffTask('D2');
  const ids = [t1.id, t2.id];
  const st = await kw(admin, 'kra.kpi', 'read', [ids, ['task_state', 'client_final_approved', 'client_quoted']]);
  check('2 fresh tasks signed off, quoted 3h each',
    (st.result || []).every((t) => t.task_state === 'completed' && t.client_final_approved),
    `ids=${ids.join(',')} quoted=${(st.result || []).map((t) => t.client_quoted).join('/')}`);
  if (!t1.started || !t2.started) console.log(`     · note: dev start refused → ${t1.startErr || t2.startErr}`);

  const base = { client_kra_id: L2, hourly_rate: 10, billing_method: 'hourly', price_req: 0, price_upt: 0, price_bug: 0,
    from_date: TODAY, to_date: TODAY };
  const C = (await call(admin, '/kpi_client_invoice/create', { ...base, invoice_title: '[APITEST] Draft C' })).result;
  const D = (await call(admin, '/kpi_client_invoice/create', { ...base, invoice_title: '[APITEST] Draft D' })).result;
  const cid = C?.data?.id || C?.id, did = D?.data?.id || D?.id;
  const tot = await kw(admin, 'kpi.client.invoice', 'read', [[cid, did], ['name', 'state', 'total_amount', 'grand_total_hours']]);
  const [c, d] = tot.result || [];
  // C should carry the work; D must come back empty because C already holds those tasks.
  // Before the fix both read 60.00 — the same 6h billed twice.
  check('second concurrent draft does not re-bill the same tasks',
    (c?.total_amount > 0) && (d?.total_amount === 0),
    `C=${cid}:${c?.total_amount} D=${did}:${d?.total_amount}`);

  // Missing state guard on the client sign-off route.
  const early = (await call(client, '/kpi_client_portal/add_task', {
    sub_kra_id: L2, name: '[APITEST] E state-guard', kind: 'requirement', priority: 'regular', description: 'guard probe' })).result?.kpi_id;
  const before = (await kw(admin, 'kra.kpi', 'read', [[early], ['task_state']])).result[0].task_state;
  const sg = await call(client, '/kpi_client_approval/approve', { kpi_id: early, chk_delivered: true,
    chk_works: true, chk_authorized: true, notes: 'x', signature_text: '[APITEST]' });
  const after = (await kw(admin, 'kra.kpi', 'read', [[early], ['task_state', 'client_final_approved']])).result[0];
  check('client sign-off is refused unless task is awaiting_client',
    after.task_state !== 'completed',
    `${before} -> ${after.task_state} client_final_approved=${after.client_final_approved} ${sg.ok ? '' : '· ' + sg.err}`);

  // ── Regression: client user linked to the ROOT only ──────────────────────
  // This is the production shape, and the reason the parent-lookup bug survived:
  // every fixture above links the client to BOTH levels. A task resolves to the
  // level-2 KRA, so reading client_user_ids there found nobody and admin approval
  // closed the task as 'completed' with client_final_approved false — finished
  // work that could never be invoiced. 42 live tasks were stuck that way.
  const R1 = (await call(admin, '/kra_kpi/create_kra', { name: '[APITEST] RootOnly Co', is_sub: false })).result?.id;
  const R2 = (await call(admin, '/kra_kpi/create_kra', { name: '[APITEST] RootOnly Unit', is_sub: true, parent_id: R1 })).result?.id;
  await call(admin, '/kra_kpi/kra/assign_clients', { kra_id: R1, user_ids: [client.uid] });  // L1 ONLY — not L2
  const rid = (await call(client, '/kpi_client_portal/add_task', {
    sub_kra_id: R2, name: '[APITEST] RootOnly approver', kind: 'requirement',
    priority: 'regular', description: 'parent-lookup probe' })).result?.kpi_id;
  await kw(admin, 'kra.kpi', 'write', [[rid], { user_id: devUid }]);
  await call(client, '/kpi_pre_approval/decide', { kpi_id: rid, action: 'approve' });
  await call(dev, '/kra_kpi/task/pause_all', {});
  await call(dev, '/kra_kpi/task/start', { kpi_id: rid });
  await call(dev, '/kpi/progress/create', { kpi_id: rid, summary: '[APITEST] done' });
  await call(dev, '/kra_kpi/task/complete', { kpi_id: rid, employee_checklist: { tested_code: true }, partial: false });
  await call(admin, '/kra_kpi/task/approve', { kpi_id: rid });
  const rs = (await kw(admin, 'kra.kpi', 'read', [[rid], ['task_state', 'client_final_approved']])).result[0];
  check('client on ROOT only is still asked to sign off',
    rs.task_state === 'awaiting_client' && !rs.client_final_approved,
    `state=${rs.task_state} (pre-fix: completed) signed=${rs.client_final_approved}`);

  console.log(`\n[APITEST] kras=${L1},${L2},${R1},${R2} tasks=${ids.join(',')},${early},${rid} invoices=${cid},${did}`);
  const ok = out.filter((r) => r.ok).length;
  console.log(`════════ ${ok}/${out.length} ════════`);
})().catch((e) => console.log('FATAL', e.message));
