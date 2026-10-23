// Drives the Odoo WEB board to pair the phone. The phone (StartWorkingScreen) shows
// a 4-digit PIN; entering it on the web board's OWL pairing gate opens the workday.
// This script: logs into Odoo, opens the board URL, types the PIN into the gate's
// input[maxlength="4"] (which AUTO-submits at 4 digits), and asserts the gate
// (div.o_kpi_pair_gate) disappears == board loaded == pairing accepted.
//
//   node scripts/pair-web.mjs <PIN>
//
// Env (never commit): ODOO_URL, ODOO_DB (optional), ODOO_WEB_LOGIN, ODOO_WEB_PASSWORD.
// Set PAIR_HEADFUL=1 to watch the browser.
import { chromium } from 'playwright';

const PIN = (process.argv[2] || process.env.PIN || '').trim();
const URL = (process.env.ODOO_URL || '').replace(/\/+$/, '');
const DB = process.env.ODOO_DB || '';
const LOGIN = process.env.ODOO_WEB_LOGIN || '';
const PASSWORD = process.env.ODOO_WEB_PASSWORD || '';

if (!/^\d{4}$/.test(PIN)) { console.error('pair-web: need a 4-digit PIN as argv[1]'); process.exit(2); }
if (!URL || !LOGIN || !PASSWORD) { console.error('pair-web: set ODOO_URL, ODOO_WEB_LOGIN, ODOO_WEB_PASSWORD'); process.exit(2); }

const BOARD = `${URL}/odoo/action-kra_kpi_module.action_kpi_action_screen`;

(async () => {
  const browser = await chromium.launch({ headless: !process.env.PAIR_HEADFUL });
  const page = await (await browser.newContext()).newPage();
  try {
    // 1) Odoo login (/web/login: input[name=login], input[name=password], "Log in")
    await page.goto(`${URL}/web/login${DB ? `?db=${encodeURIComponent(DB)}` : ''}`, { waitUntil: 'domcontentloaded' });
    const dbSel = page.locator('select[name="db"]');
    if (DB && (await dbSel.count())) { await dbSel.selectOption(DB).catch(() => {}); }
    await page.fill('input[name="login"]', LOGIN);
    await page.fill('input[name="password"]', PASSWORD);
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      page.click('button[type="submit"]'),
    ]);
    if (await page.locator('.alert-danger, .o_login_auth .text-danger').count()) {
      throw new Error('Odoo login rejected — check ODOO_WEB_LOGIN / ODOO_WEB_PASSWORD / ODOO_DB');
    }
    console.log('pair-web: logged into Odoo');

    // 2) Open the KRA/KPI board → the OWL pairing gate renders
    await page.goto(BOARD, { waitUntil: 'domcontentloaded' });
    const gate = page.locator('div.o_kpi_pair_gate');
    await gate.waitFor({ state: 'visible', timeout: 30000 });
    console.log('pair-web: pairing gate visible');

    if (await page.locator('div.o_kpi_pair_gate', { hasText: 'Workday ended for today' }).count()) {
      throw new Error('web gate shows "Workday ended for today" — reset the test day first');
    }

    // 3) Type the PIN — the input auto-submits at 4 digits
    const input = page.locator('div.o_kpi_pair_gate input[maxlength="4"]');
    await input.waitFor({ state: 'visible', timeout: 15000 });
    await input.click();
    await input.type(PIN, { delay: 120 });
    console.log(`pair-web: typed PIN ${PIN}`);

    // 4) Gate should go away (board loaded) → pairing succeeded
    await gate.waitFor({ state: 'hidden', timeout: 20000 }).catch(async () => {
      await gate.waitFor({ state: 'detached', timeout: 5000 });
    });
    console.log('pair-web: PASS — gate gone, board loaded, phone paired + workday open');

    // 5) HOLD (PAIR_HOLD=<secs>) — the phone un-pairs the instant this web tab closes
    //    (server un-pairs on tab-close, mode='resume'), which would drop the phone out
    //    of the paired board before it can End Workday. So keep the tab OPEN and active
    //    (the board's own heartbeat runs while the page is alive) until the orchestrator
    //    writes "STOP" on stdin or the hold window elapses. "PAIRED" is the machine
    //    marker telling the orchestrator the phone is paired and it may start phase B.
    const holdSecs = parseInt(process.env.PAIR_HOLD || '0', 10);
    if (holdSecs > 0) {
      console.log('PAIRED');
      let stop = false;
      try {
        process.stdin.resume();
        process.stdin.on('data', (b) => { if (String(b).includes('STOP')) stop = true; });
      } catch {}
      const until = Date.now() + holdSecs * 1000;
      while (!stop && Date.now() < until) {
        try { await page.evaluate(() => document.hasFocus()); } catch {}   // keep the tab live
        await new Promise((r) => setTimeout(r, 2000));
      }
      console.log('pair-web: hold released — closing browser');
    }
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error('pair-web: FAIL —', e.message);
    try { await page.screenshot({ path: 'pair-web-fail.png', fullPage: true }); console.error('   saved pair-web-fail.png'); } catch {}
    await browser.close();
    process.exit(1);
  }
})();
