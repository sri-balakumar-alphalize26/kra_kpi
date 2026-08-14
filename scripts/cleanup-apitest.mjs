// Remove the [APITEST] fixtures the e2e suites created.
//
//   node scripts/cleanup-apitest.mjs          # dry run — prints what it WOULD remove
//   node scripts/cleanup-apitest.mjs --yes    # actually removes it
//
// The suites used to build a fresh client tree on every run and never clean up, so
// the Create Invoice client dropdown filled with dozens of identical
// "[APITEST] Client Co" rows and buried the real clients.
//
// The one way a fixture could have entangled real work is an invoice line pointing at
// a task that is NOT a fixture. If that is found anywhere, this aborts rather than
// guessing — deleting an invoice that bills real work would free those tasks to be
// billed a second time.
const BASE = process.env.ODOO_URL || 'http://localhost:8069';
const DB = process.env.ODOO_DB || '369application';
const LOGIN = process.env.ODOO_LOGIN || 'admin';
const PASSWORD = process.env.ODOO_PASSWORD || 'admin';
const APPLY = process.argv.includes('--yes');
const TAG = '[APITEST]';

async function auth() {
  const r = await fetch(`${BASE}/web/session/authenticate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call',
      params: { db: DB, login: LOGIN, password: PASSWORD } }) });
  const m = /session_id=([^;]+)/.exec(r.headers.get('set-cookie') || '');
  const d = await r.json().catch(() => ({}));
  if (!d?.result?.uid) throw new Error('login failed');
  return `session_id=${m[1]}`;
}
async function kw(cookie, model, method, args = [], kwargs = {}) {
  const r = await fetch(`${BASE}/web/dataset/call_kw`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call',
      params: { model, method, args, kwargs } }) });
  const j = await r.json();
  if (j.error) throw new Error(String(j.error?.data?.message || j.error.message).slice(0, 200));
  return j.result;
}

(async () => {
  const cookie = await auth();
  // active_test:false throughout — marking an invoice paid archives its tasks, and the
  // fixtures include paid ones. A plain search would leave those behind.
  const ctx = { context: { active_test: false } };

  const kras = await kw(cookie, 'kra.master', 'search_read',
    [[['name', 'like', TAG]], ['id', 'name']], ctx);
  const tasks = await kw(cookie, 'kra.kpi', 'search_read',
    [[['name', 'like', TAG]], ['id', 'name']], ctx);
  const kraIds = kras.map((k) => k.id);
  const taskIds = new Set(tasks.map((t) => t.id));

  // An invoice counts as a fixture if its title is tagged OR it was raised against a
  // fixture client. Title alone would miss any raised before the title convention.
  const invoices = await kw(cookie, 'kpi.client.invoice', 'search_read',
    [['|', ['invoice_title', 'like', TAG], ['client_kra_id', 'in', kraIds]],
      ['id', 'name', 'invoice_title', 'payment_status']], ctx);
  const invIds = invoices.map((i) => i.id);

  // The safety check: does any of those invoices bill a task that is NOT a fixture?
  const strayLines = invIds.length ? await kw(cookie, 'kpi.client.invoice.line', 'search_read',
    [[['invoice_id', 'in', invIds], ['kpi_id', '!=', false]], ['id', 'kpi_id', 'invoice_id']], ctx) : [];
  const stray = strayLines.filter((l) => l.kpi_id && !taskIds.has(l.kpi_id[0]));

  console.log(`\n  ${kras.length} KRA(s), ${tasks.length} task(s), ${invoices.length} invoice(s) tagged ${TAG}`);
  console.log(`  root clients among them: ${kras.filter((k) => /Client Co|Pay Co|SignNote Co|Dedup/.test(k.name)).length}`);

  if (stray.length) {
    console.log(`\n  ABORT — ${stray.length} invoice line(s) bill work that is NOT a fixture:`);
    for (const l of stray.slice(0, 10)) {
      console.log(`    invoice ${l.invoice_id[1]} bills "${l.kpi_id[1]}"`);
    }
    console.log('  Deleting these invoices would free real tasks to be billed twice. Nothing removed.');
    process.exitCode = 1;
    return;
  }
  console.log('  safety check: no fixture invoice bills real work ✅');

  if (!APPLY) {
    console.log('\n  DRY RUN — nothing removed. Re-run with --yes to apply.\n');
    return;
  }

  // Order matters: lines and invoices first, then tasks, then the KRA tree. Deleting a
  // KRA first would orphan or cascade in ways that are harder to reason about.
  if (invIds.length) {
    await kw(cookie, 'kpi.client.invoice', 'unlink', [invIds], ctx);
    console.log(`  removed ${invIds.length} invoice(s)`);
  }
  if (taskIds.size) {
    await kw(cookie, 'kra.kpi', 'unlink', [[...taskIds]], ctx);
    console.log(`  removed ${taskIds.size} task(s)`);
  }
  if (kraIds.length) {
    // Children before parents, or the parent delete trips on its own descendants.
    const byDepth = kras.slice().sort((a, b) => b.id - a.id).map((k) => k.id);
    await kw(cookie, 'kra.master', 'unlink', [byDepth], ctx);
    console.log(`  removed ${kraIds.length} KRA(s)`);
  }

  const leftK = await kw(cookie, 'kra.master', 'search_count', [[['name', 'like', TAG]]], ctx);
  const leftT = await kw(cookie, 'kra.kpi', 'search_count', [[['name', 'like', TAG]]], ctx);
  const roots = await kw(cookie, 'kra.master', 'search_count', [[['parent_id', '=', false]]], ctx);
  console.log(`\n  remaining ${TAG}: ${leftK} KRA(s), ${leftT} task(s)`);
  console.log(`  root clients now in the dropdown: ${roots}\n`);
})();
