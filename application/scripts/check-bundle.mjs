// Syntax-check the web client's built JS bundle. Catches errors that only exist
// AFTER Odoo concatenates the assets — e.g. a stray backtick in a comment inside
// an OWL `xml` tagged template, which ends the literal and kills the whole bundle.
// A broken bundle means no JS runs at all: every page renders blank.
//   node scripts/check-bundle.mjs [db] [login] [password]
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:8069';
const [DB = 'sales_test', LOGIN = 'admin', PASSWORD = 'admin'] = process.argv.slice(2);

const res = await fetch(`${BASE}/web/session/authenticate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { db: DB, login: LOGIN, password: PASSWORD } }),
});
const auth = await res.json().catch(() => ({}));
if (!auth?.result?.uid) {
  console.log(`❌ auth failed on ${DB}:`, JSON.stringify(auth?.error?.data?.message || auth?.error || auth).slice(0, 300));
  process.exit(2);
}
const cookie = /session_id=([^;]+)/.exec(res.headers.get('set-cookie') || '')?.[0];

// The bundle hash changes whenever an asset file changes, so read the URL the
// freshly rendered page actually references rather than guessing it.
const html = await (await fetch(`${BASE}/odoo`, { headers: { Cookie: cookie } })).text();
const url = [...new Set([...html.matchAll(/\/web\/assets\/[^"']*?web\.assets_web\.min\.js/g)].map((m) => m[0]))][0];
if (!url) { console.log('❌ no web.assets_web.min.js reference in /odoo html'); process.exit(3); }

const bundle = await fetch(BASE + url, { headers: { Cookie: cookie } });
if (!bundle.ok) { console.log(`❌ ${url} → HTTP ${bundle.status}`); process.exit(3); }
const bytes = Buffer.from(await bundle.arrayBuffer());
const out = join(tmpdir(), `odoo-bundle-${DB}.js`);
writeFileSync(out, bytes);

try {
  execFileSync(process.execPath, ['--check', out], { stdio: 'pipe' });
  console.log(`✅ ${DB}: ${url} (${bytes.length} bytes) parses cleanly`);
} catch (e) {
  console.log(`❌ ${DB}: ${url} has a SYNTAX ERROR — the web client will render blank\n`);
  console.log((e.stderr?.toString() || e.message).split('\n').slice(0, 12).join('\n'));
  process.exit(1);
}
