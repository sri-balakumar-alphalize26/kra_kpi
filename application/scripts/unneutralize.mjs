// Undo Odoo's neutralization for THIS project's automation only.
//
// A restored/duplicated database gets neutralized: a red banner, and every cron
// switched off (base/data/neutralize.sql + web/data/neutralize.sql). Odoo ships
// no way back. This re-enables the kra_kpi_module + whatsapp_neonize crons and
// clears the banner, and deliberately leaves Odoo's own mail crons and the dummy
// mail server alone — this module notifies over WhatsApp + Expo push only.
//
// Goes through the ORM, not raw SQL: writing ir_ui_view.active in SQL leaves
// Odoo's view cache stale, so the banner survives until a restart.
//
//   node scripts/unneutralize.mjs [db] [login] [password]
const BASE = 'http://localhost:8069';
const [DB = '369application', LOGIN = 'admin', PASSWORD = 'admin'] = process.argv.slice(2);

// Retired by name — re-enabling it is not wanted.
const SKIP_CRONS = [/RETIRED/i];
const APP_MODULES = ['kra_kpi_module', 'whatsapp_neonize'];

async function auth() {
  const r = await fetch(`${BASE}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { db: DB, login: LOGIN, password: PASSWORD } }),
  });
  const d = await r.json().catch(() => ({}));
  if (!d?.result?.uid) throw new Error(`auth failed: ${JSON.stringify(d?.error?.data?.message || d?.error || d).slice(0, 200)}`);
  return /session_id=([^;]+)/.exec(r.headers.get('set-cookie') || '')?.[0];
}

async function kw(cookie, model, method, args = [], kwargs = {}) {
  const r = await fetch(`${BASE}/web/dataset/call_kw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { model, method, args, kwargs } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error?.data?.message || j.error));
  return j.result;
}

const cookie = await auth();
console.log(`connected to ${DB}\n`);

// 1. Clear the neutralization flag. Also lifts the guard in ir.cron.toggle(),
//    which silently refuses to re-enable crons while a database is neutralized.
const flagIds = await kw(cookie, 'ir.config_parameter', 'search', [[['key', '=', 'database.is_neutralized']]]);
if (flagIds.length) {
  await kw(cookie, 'ir.config_parameter', 'unlink', [flagIds]);
  console.log('✔ cleared database.is_neutralized');
} else {
  console.log('· database.is_neutralized already absent');
}

// 2. Hide the banner / ribbon views (separately activated by web + website neutralize.sql).
for (const key of ['web.neutralize_banner', 'website.neutralize_ribbon']) {
  const ids = await kw(cookie, 'ir.ui.view', 'search', [[['key', '=', key], ['active', '=', true]]], { context: { active_test: false } });
  if (ids.length) {
    await kw(cookie, 'ir.ui.view', 'write', [ids, { active: false }]);
    console.log(`✔ deactivated ${key}`);
  } else {
    console.log(`· ${key} not active`);
  }
}

// 3. Find this project's crons by OWNING MODULE — precise and reproducible,
//    unlike matching on cron names.
const xmlids = await kw(cookie, 'ir.model.data', 'search_read',
  [[['model', '=', 'ir.cron'], ['module', 'in', APP_MODULES]], ['res_id', 'module']]);
const appCronIds = xmlids.map((d) => d.res_id);
const crons = await kw(cookie, 'ir.cron', 'search_read',
  [[['id', 'in', appCronIds]], ['id', 'cron_name', 'active', 'nextcall']],
  { context: { active_test: false } });

const skipped = crons.filter((c) => SKIP_CRONS.some((re) => re.test(c.cron_name)));
const target = crons.filter((c) => !skipped.includes(c));

console.log(`\nfound ${crons.length} app crons (${target.length} to enable, ${skipped.length} skipped)\n`);

// 4. Enable, staggering nextcall — every one of these is overdue, and firing 17
//    at once would stampede a max_cron_threads=2 server. They reschedule onto
//    their own intervals after the first run.
let n = 0;
for (const c of target.sort((a, b) => a.id - b.id)) {
  const when = new Date(Date.now() + ++n * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  await kw(cookie, 'ir.cron', 'write', [[c.id], { active: true, nextcall: when }]);
  console.log(`  ${c.active ? '=' : '✔'} [${String(c.id).padStart(2)}] ${c.cron_name}  → first run ${when} UTC`);
}
for (const c of skipped) console.log(`  ✗ [${String(c.id).padStart(2)}] ${c.cron_name}  (skipped)`);

// 5. Report what was intentionally left off.
const stillOff = await kw(cookie, 'ir.cron', 'search_read',
  [[['active', '=', false]], ['cron_name']], { context: { active_test: false } });
const active = await kw(cookie, 'ir.cron', 'search_count', [[['active', '=', true]]]);
console.log(`\nactive crons now: ${active}   still disabled: ${stillOff.length}`);
console.log('left disabled on purpose (Odoo stock, no SMTP configured):');
for (const c of stillOff) console.log(`  · ${c.cron_name}`);
console.log('\nHard-reload the browser (Ctrl+Shift+R) — the PWA service worker caches the page shell.');
