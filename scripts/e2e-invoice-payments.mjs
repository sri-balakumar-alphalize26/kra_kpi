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


// Reuse a fixture tree instead of creating a fresh one every run. The suites used to
// build a new client per execution, which is how the Create Invoice dropdown ended up
// with 71 identical "[APITEST] Client Co" rows burying the real clients. Tasks and
// invoices are still made fresh each run — those are the things under test.
// Drop invoices this suite left behind last time. The fixture tree is reused now, and
// a draft covering the same client and period blocks a new one ("Draft INV/... already
// covers this client and period") — so without this the second run of the day fails on
// its own leftovers rather than on the code under test.
async function clearFixtureInvoices(session, kraIds) {
  const found = await call(session, '/web/dataset/call_kw', {
    model: 'kpi.client.invoice', method: 'search',
    args: [[['client_kra_id', 'in', kraIds]]],
    kwargs: { context: { active_test: false } },
  });
  const ids = found.result || [];
  if (ids.length) {
    await call(session, '/web/dataset/call_kw', {
      model: 'kpi.client.invoice', method: 'unlink', args: [ids],
      kwargs: { context: { active_test: false } },
    });
  }
  return ids.length;
}

async function fixtureKra(session, name, { parent_id = null } = {}) {
  const found = await call(session, '/web/dataset/call_kw', {
    model: 'kra.master', method: 'search_read',
    args: [[['name', '=', name]], ['id']],
    kwargs: { limit: 1, context: { active_test: false } },
  });
  const hit = (found.result || found.r || [])[0];
  if (hit && hit.id) return hit.id;
  const made = await call(session, '/kra_kpi/create_kra',
    parent_id ? { name, is_sub: true, parent_id } : { name, is_sub: false });
  return (made.result || made.r || {}).id;
}

const out = [];
const check = (s, ok, d = '') => { out.push({ s, ok }); console.log(`  ${ok ? '✅' : '❌'} ${s.padEnd(54)} ${d}`); };

(async () => {
  const admin = await auth('admin', 'admin');
  const client = await auth('apitest_client', TEST_PW);
  const dev = await auth('apitest_dev', TEST_PW);

  const L1 = await fixtureKra(admin, '[APITEST] Pay Co');
  const L2 = await fixtureKra(admin, '[APITEST] Pay Unit', { parent_id: L1 });
  for (const k of [L1, L2]) await call(admin, '/kra_kpi/kra/assign_clients', { kra_id: k, user_ids: [client.uid] });
  await call(dev, '/kpi_workday/ping', {});
  const wiped = await clearFixtureInvoices(admin, [L1, L2]);
  console.log(`
=== fixture: kra ${L1}/${L2} (cleared ${wiped} old invoice(s)) ===`);

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

  console.log('\n=== F — a claim parks the invoice in its own tab and freezes the figure ===');
  // A second task and invoice, kept FINALIZED (never sent) — section B's invoice is
  // already sent, and revise is refused for sent anyway, so it could not tell us
  // whether the claim itself did the blocking.
  const task2 = (await call(client, '/kpi_client_portal/add_task', {
    sub_kra_id: L2, name: '[APITEST] claim probe', kind: 'requirement',
    priority: 'regular', description: 'claim tab' })).result?.kpi_id;
  await kw(admin, 'kra.kpi', 'write', [[task2], { client_quoted_hours: 2, user_id: dev.uid }]);
  await call(client, '/kpi_pre_approval/decide', { kpi_id: task2, action: 'approve' });
  await call(dev, '/kra_kpi/task/pause_all', {});
  await call(dev, '/kra_kpi/task/start', { kpi_id: task2 });
  await call(dev, '/kpi/progress/create', { kpi_id: task2, summary: '[APITEST] done' });
  await call(dev, '/kra_kpi/task/complete', { kpi_id: task2, employee_checklist: { tested_code: true }, partial: false });
  await call(admin, '/kra_kpi/task/approve', { kpi_id: task2 });
  await call(client, '/kpi_client_approval/approve', {
    kpi_id: task2, chk_delivered: true, chk_works: true, chk_authorized: true,
    notes: '', signature_text: '[APITEST] Client User' });

  const inv2 = (await call(admin, '/kpi_client_invoice/create', {
    client_kra_id: L1, from_date: TODAY, to_date: TODAY,
    invoice_title: '[APITEST] claim tab', billing_method: 'hourly', hourly_rate: 10 })).result;
  const ID2 = inv2?.data?.id || inv2?.id;
  await call(admin, '/kpi_client_invoice/finalize', { invoice_id: ID2 });

  const listAs = async (f) => (await call(admin, '/kpi_client_invoice/list', { status_filter: f })).result || {};
  const dueBefore = await listAs('due');
  check('finalized + unpaid starts life under Due',
    (dueBefore.invoices || []).some((i) => i.id === ID2), `due=${dueBefore.counts?.due}`);

  const c2 = await call(client, '/kpi_client_invoice/client_mark_paid', {
    invoice_id: ID2, method: 'cheque', note: 'cheque 991' });
  check('client claims paid', c2.ok, c2.ok ? '' : c2.err);

  const dueAfter = await listAs('due');
  const claimed = await listAs('claimed');
  check('claim moves it OUT of Due', !(dueAfter.invoices || []).some((i) => i.id === ID2),
    `due ${dueBefore.counts?.due} → ${dueAfter.counts?.due}`);
  check('and INTO Payment Claimed', (claimed.invoices || []).some((i) => i.id === ID2),
    `claimed=${claimed.counts?.claimed}`);
  check('Due count fell by exactly one',
    (dueAfter.counts?.due ?? -1) === (dueBefore.counts?.due ?? -2) - 1);
  const stillUnpaid = (await kw(admin, 'kpi.client.invoice', 'read', [[ID2], ['payment_status']])).result[0];
  check('a claim does not pay the invoice', stillUnpaid.payment_status === 'unpaid',
    `status=${stillUnpaid.payment_status}`);

  // The figure must not move while the client believes they have paid it.
  check('revise REFUSED while the claim is open',
    !(await call(admin, '/kpi_client_invoice/revise', { invoice_id: ID2, reason: 'trim it' })).ok);
  check('reset-to-draft refused too (same escape hatch)',
    !(await kw(admin, 'kpi.client.invoice', 'action_reset_draft', [[ID2]])).ok);

  const cleared = await call(admin, '/kpi_client_invoice/clear_paid_claim', { invoice_id: ID2 });
  check('admin clears the claim (money never arrived)', cleared.ok, cleared.ok ? '' : cleared.err);
  const dueBack = await listAs('due');
  check('back under Due once cleared', (dueBack.invoices || []).some((i) => i.id === ID2),
    `due=${dueBack.counts?.due}`);
  check('and out of Payment Claimed',
    !((await listAs('claimed')).invoices || []).some((i) => i.id === ID2));
  const revNow = await call(admin, '/kpi_client_invoice/revise', { invoice_id: ID2, reason: 'trim it' });
  check('revise works again after the claim is cleared', revNow.ok, revNow.ok ? '' : revNow.err);

  // Re-finalize, claim again, and this time confirm it for real.
  await call(admin, '/kpi_client_invoice/finalize', { invoice_id: ID2 });
  await call(client, '/kpi_client_invoice/client_mark_paid', { invoice_id: ID2, method: 'cheque' });
  await call(admin, '/kpi_client_invoice/mark_paid', {
    invoice_id: ID2, paid: true, method: 'cheque', note: 'cleared' });
  const paidList = await listAs('paid');
  check('confirming moves it to Paid', (paidList.invoices || []).some((i) => i.id === ID2));
  check('and empties it out of Payment Claimed',
    !((await listAs('claimed')).invoices || []).some((i) => i.id === ID2));

  console.log('\n=== G — the PDF says which state it is in, to both sides ===');
  // A saved or forwarded invoice carried no clue whether it had been settled: the same
  // file read identically before and after payment.
  const pdfName = async (who, id) => ((await call(who, '/kpi_client_invoice/pdf', { invoice_id: id })).result || {}).file_name || '';
  const inv3 = (await call(admin, '/kpi_client_invoice/create', {
    client_kra_id: L1, from_date: TODAY, to_date: TODAY,
    invoice_title: '[APITEST] pdf states', billing_method: 'hourly', hourly_rate: 10 })).result;
  const ID3 = inv3?.data?.id || inv3?.id;
  // Notes are saved DRAFT-ONLY by design (you write them before committing the figure),
  // so they have to go on now — after finalize the route refuses and the check below
  // would be testing nothing.
  const NOTE = 'First paragraph for the client.\n\nSecond paragraph, after a blank line.';
  await call(admin, '/kpi_client_invoice/save_notes', { invoice_id: ID3, notes: NOTE });
  await call(admin, '/kpi_client_invoice/finalize', { invoice_id: ID3 });
  check('unpaid → _UNPAID.pdf', (await pdfName(admin, ID3)).endsWith('_UNPAID.pdf'), await pdfName(admin, ID3));

  await call(client, '/kpi_client_invoice/client_mark_paid', { invoice_id: ID3, method: 'cash' });
  const claimedAdmin = await pdfName(admin, ID3);
  const claimedClient = await pdfName(client, ID3);
  check('claimed → _CLAIMED.pdf for the admin', claimedAdmin.endsWith('_CLAIMED.pdf'), claimedAdmin);
  // The client downloads their OWN invoice — the case that matters, and the one an
  // earlier check got wrong by using a client who did not own the invoice.
  check('claimed → _CLAIMED.pdf for the CLIENT', claimedClient.endsWith('_CLAIMED.pdf'),
    claimedClient || 'client got nothing');

  // The WEB PDF button does not use the route above — it fetches pdf_data and builds the
  // document in the browser with jsPDF. That builder computes its own PAID/CLAIMED/UNPAID
  // label, so the route passing tells us nothing about it. Assert the payload the browser
  // reads instead: if these fields are right, the label is right.
  const pdfData = async (who, id) => (((await call(who, '/kpi_client_invoice/pdf_data', { invoice_id: id })).result || {}).data || {}).invoice || {};
  const dClaim = await pdfData(admin, ID3);
  check('pdf_data carries the claim flag the web PDF reads',
    dClaim.client_paid_claim === true && dClaim.payment_status === 'unpaid',
    `claim=${dClaim.client_paid_claim} status=${dClaim.payment_status}`);
  const dClaimClient = await pdfData(client, ID3);
  check('…and the client gets the same two fields',
    dClaimClient.client_paid_claim === true && dClaimClient.payment_status === 'unpaid',
    `claim=${dClaimClient.client_paid_claim} status=${dClaimClient.payment_status}`);

  await call(admin, '/kpi_client_invoice/mark_paid', { invoice_id: ID3, paid: true, method: 'cash', note: 'ok' });
  check('paid → _PAID.pdf', (await pdfName(admin, ID3)).endsWith('_PAID.pdf'), await pdfName(admin, ID3));
  const dPaid = await pdfData(admin, ID3);
  check('pdf_data reads paid once confirmed, claim cleared',
    dPaid.payment_status === 'paid' && !dPaid.client_paid_claim,
    `claim=${dPaid.client_paid_claim} status=${dPaid.payment_status}`);

  console.log('\n=== H — Overall Notes reach the client as text, not markup ===');
  // Saved above while the invoice was still a draft. The field is Html, so Odoo wraps
  // what was typed in <p>…</p>; the client used to read those tags literally.
  const cSee = (await call(client, '/kpi_client_invoice/get', { invoice_id: ID3 })).result?.data || {};
  check('client sees no HTML tags in the notes', !/<[a-z/][^>]*>/i.test(cSee.notes || ''),
    JSON.stringify(cSee.notes || '').slice(0, 60));
  check('and the paragraph break survives', (cSee.notes || '').includes('\n'),
    JSON.stringify(cSee.notes || '').slice(0, 60));

  const ok = out.filter((o) => o.ok).length;
  console.log(`\n════════ ${ok}/${out.length} checks passed ════════`);
  const bad = out.filter((o) => !o.ok);
  if (bad.length) { console.log('FAILED:'); bad.forEach((b) => console.log('  ✗ ' + b.s)); }
  console.log(`\n[APITEST] kras=${L1},${L2} task=${taskId} invoice=${ID}`);
  process.exitCode = bad.length ? 1 : 0;
})();
