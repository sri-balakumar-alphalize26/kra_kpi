// Invoice payment flow, revisions, and what happens to tasks afterwards.
//
//   node scripts/e2e-invoice-payments.mjs
//
// Builds its own [APITEST] tree, client user link, signed-off task and invoice. An
// earlier attempt reused a real invoice and every assertion collapsed the moment
// someone marked it paid in the browser — a test that reads live records is a test
// that fails for reasons that have nothing to do with the code.
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
  if (j.error) return { ok: false, err: String(j.error?.data?.message || '').slice(0, 130) };
  if (j.result && j.result.status === false) return { ok: false, err: String(j.result.message || '').slice(0, 130), result: j.result };
  return { ok: true, result: j.result };
}
const kw = (s, model, method, args = [], kwargs = {}) =>
  call(s, '/web/dataset/call_kw', { model, method, args, kwargs });

const out = [];
const check = (s, ok, d = '') => { out.push({ s, ok }); console.log(`  ${ok ? '✅' : '❌'} ${s.padEnd(54)} ${d}`); };

(async () => {
  const admin = await auth('admin', 'admin');
  const client = await auth('apitest_client', TEST_PW);
  const dev = await auth('apitest_dev', TEST_PW);

  const L1 = (await call(admin, '/kra_kpi/create_kra', { name: '[APITEST] Pay Co', is_sub: false })).result?.id;
  const L2 = (await call(admin, '/kra_kpi/create_kra', { name: '[APITEST] Pay Unit', is_sub: true, parent_id: L1 })).result?.id;
  for (const k of [L1, L2]) await call(admin, '/kra_kpi/kra/assign_clients', { kra_id: k, user_ids: [client.uid] });
  await call(dev, '/kpi_workday/ping', {});
  console.log(`\n=== fixture: kra ${L1}/${L2} ===`);

  // One signed-off task, so the invoice has something real on it.
  const taskId = (await call(client, '/kpi_client_portal/add_task', {
    sub_kra_id: L2, name: '[APITEST] payment probe', kind: 'requirement',
    priority: 'regular', description: 'payment flow' })).result?.kpi_id;
  await kw(admin, 'kra.kpi', 'write', [[taskId], { client_quoted_hours: 2, user_id: dev.uid }]);
  await call(client, '/kpi_pre_approval/decide', { kpi_id: taskId, action: 'approve' });
  await call(dev, '/kra_kpi/task/pause_all', {});
  await call(dev, '/kra_kpi/task/start', { kpi_id: taskId });
  await call(dev, '/kpi/progress/create', { kpi_id: taskId, summary: '[APITEST] done' });
  await call(dev, '/kra_kpi/task/complete', { kpi_id: taskId, employee_checklist: { tested_code: true }, partial: false });
  await call(admin, '/kra_kpi/task/approve', { kpi_id: taskId });

  console.log('\n=== A — signed-off work leaves the dev board ===');
  const beforeBoard = (await call(dev, '/kra_kpi/tasks/get', {})).result?.tasks || [];
  check('task is on the dev board while awaiting client',
    beforeBoard.some((t) => t.id === taskId), `board=${beforeBoard.length}`);

  await call(client, '/kpi_client_approval/approve', {
    kpi_id: taskId, chk_delivered: true, chk_works: true, chk_authorized: true,
    notes: '', signature_text: '[APITEST] Client User' });

  const afterBoard = (await call(dev, '/kra_kpi/tasks/get', {})).result?.tasks || [];
  check('gone from the dev board once signed off',
    !afterBoard.some((t) => t.id === taskId), `board=${afterBoard.length}`);
  const adminBoard = (await call(admin, '/kra_kpi/tasks/get', {})).result?.tasks || [];
  check('admin still sees it', adminBoard.some((t) => t.id === taskId));
  // The hours must survive: a developer has to be able to prove what they finished.
  const wr = await call(dev, '/kpi_reports/my_workday', { from_date: TODAY, to_date: TODAY });
  check('still counted in the developer\'s own workday report', wr.ok, wr.ok ? '' : wr.err);

  console.log('\n=== B — invoice, revise, pay ===');
  const inv = (await call(admin, '/kpi_client_invoice/create', {
    client_kra_id: L1, from_date: TODAY, to_date: TODAY,
    invoice_title: '[APITEST] payments', billing_method: 'hourly', hourly_rate: 20 })).result;
  const ID = inv?.data?.id || inv?.id;
  check('invoice created with the signed-off task', !!ID, `id=${ID}`);
  await call(admin, '/kpi_client_invoice/finalize', { invoice_id: ID });

  check('revise refused with no reason',
    !(await call(admin, '/kpi_client_invoice/revise', { invoice_id: ID, reason: '' })).ok);
  const rev = await call(admin, '/kpi_client_invoice/revise', { invoice_id: ID, reason: 'Agreed discount' });
  check('revise a finalized invoice', rev.ok && rev.result?.data?.state === 'draft',
    rev.ok ? `state=${rev.result.data.state} count=${rev.result.data.revision_count}` : rev.err);
  await call(admin, '/kpi_client_invoice/finalize', { invoice_id: ID });
  const reMark = (await call(admin, '/kpi_client_invoice/get', { invoice_id: ID })).result?.data || {};
  check('revised marker survives re-finalize', !!reMark.revised_on, `"${reMark.revision_reason || ''}"`);

  // Sent must be off limits — the client already has that document.
  await call(admin, '/kpi_client_invoice/send', { invoice_id: ID });
  check('revise refused once SENT',
    !(await call(admin, '/kpi_client_invoice/revise', { invoice_id: ID, reason: 'too late' })).ok);

  console.log('\n=== C — client claims, admin confirms ===');
  // A missing method is ACCEPTED and recorded as Other, on purpose: app builds
  // already on people's phones predate the field, and refusing would kill the Paid
  // button on every one of them until the fleet updates. A payment that cannot be
  // recorded is worse than one recorded as "Other". A WRONG method is still refused.
  const noMethod = await call(client, '/kpi_client_invoice/client_mark_paid', { invoice_id: ID });
  const nmRead = (await kw(admin, 'kpi.client.invoice', 'read', [[ID], ['client_paid_method']])).result[0];
  check('claim with no method → recorded as Other (old app builds)',
    noMethod.ok && nmRead.client_paid_method === 'other', `method=${nmRead.client_paid_method}`);
  check('claim with an INVALID method is refused',
    !(await call(client, '/kpi_client_invoice/client_mark_paid', { invoice_id: ID, method: 'crypto' })).ok);

  const claim = await call(client, '/kpi_client_invoice/client_mark_paid', {
    invoice_id: ID, method: 'bank_transfer', note: 'ref 4417' });
  check('client claims paid', claim.ok, claim.ok ? '' : claim.err);
  const afterClaim = (await kw(admin, 'kpi.client.invoice', 'read',
    [[ID], ['payment_status', 'client_paid_claim']])).result[0];
  check('payment_status is STILL unpaid after a claim',
    afterClaim.payment_status === 'unpaid' && afterClaim.client_paid_claim === true,
    `status=${afterClaim.payment_status} claim=${afterClaim.client_paid_claim}`);

  const paid = await call(admin, '/kpi_client_invoice/mark_paid', {
    invoice_id: ID, paid: true, method: 'bank_transfer', note: 'INTERNAL short by 5, wrote off' });
  check('admin confirms with a method', paid.ok, paid.ok ? '' : paid.err);
  const paidRead = (await kw(admin, 'kpi.client.invoice', 'read', [[ID], ['payment_method']])).result[0];
  check('the admin\'s stated method is what got stored',
    paidRead.payment_method === 'bank_transfer', `method=${paidRead.payment_method}`);

  console.log('\n=== D — the client must not read internal notes ===');
  const cv = (await call(client, '/kpi_client_invoice/get', { invoice_id: ID })).result?.data || {};
  check('admin payment_notes absent from the CLIENT payload', !('payment_notes' in cv));
  check('admin payment_method absent from the CLIENT payload', !('payment_method' in cv));
  check('client still sees their OWN stated method',
    cv.client_paid_method === 'bank_transfer', cv.client_paid_method_label || '');
  check('client sees their own note', (cv.client_paid_notes || '').includes('4417'));
  const av = (await call(admin, '/kpi_client_invoice/get', { invoice_id: ID })).result?.data || {};
  check('admin DOES see the internal note', (av.payment_notes || '').includes('INTERNAL'));

  console.log('\n=== E — paid work is filed away, reversibly ===');
  const arch = (await kw(admin, 'kra.kpi', 'read', [[taskId], ['active']], { context: { active_test: false } })).result[0];
  check('task archived once the invoice is paid', arch.active === false, `active=${arch.active}`);
  await call(admin, '/kpi_client_invoice/mark_paid', { invoice_id: ID, paid: false, note: 'reverting' });
  const back = (await kw(admin, 'kra.kpi', 'read', [[taskId], ['active']], { context: { active_test: false } })).result[0];
  check('un-paying brings it back', back.active === true, `active=${back.active}`);

  const ok = out.filter((o) => o.ok).length;
  console.log(`\n════════ ${ok}/${out.length} checks passed ════════`);
  const bad = out.filter((o) => !o.ok);
  if (bad.length) { console.log('FAILED:'); bad.forEach((b) => console.log('  ✗ ' + b.s)); }
  console.log(`\n[APITEST] kras=${L1},${L2} task=${taskId} invoice=${ID}`);
  process.exitCode = bad.length ? 1 : 0;
})();
