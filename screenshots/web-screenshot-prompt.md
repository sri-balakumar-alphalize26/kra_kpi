# Prompt — screenshot the Odoo web client

Copy the fenced block below into a fresh session and fill in the `<angle brackets>`.

It works against **any** Odoo, in any project — nothing in the prompt is specific to this
repo. Copying this one file into another module is the whole install.

It exists because getting one screenshot here cost about half an hour, and none of it was
the screenshot: one run captured **Discuss** instead of the target screen, one died on a
click that was silently intercepted, and one served a **stale asset bundle** that read
exactly like the code fix having failed. None of that is visible in the error messages.

---

```
Take a screenshot of the Odoo web client and save it to <output path>.

Screen I want: <describe it — e.g. "the Sales order form for SO0042", or
                "my module's board with the settings dialog open">

Environment:
- Odoo runs at <http://localhost:8069>
- Database: <db name>          (if the server hosts a live one too, DO NOT touch it)
- Login: <user> / <password>

Setup: check whether `playwright` is in this project's node_modules. If it is not,
  npm i -D playwright && npx playwright install chromium
If you write the script outside the project directory, resolve playwright FROM the
project or ESM will not find it:
    import { createRequire } from 'module';
    const require = createRequire('<project path>/package.json');
    const { chromium } = require('playwright');

Four things that will waste your time if you don't know them:

1. DATABASE SELECTOR. If the server has several databases and odoo.conf has no
   db_name, a bare /web/login redirects to the selector and your login fill will
   fail with "element is not visible". Go to /web/login?db=<db> instead, and
   waitForSelector('input[name="login"]', {state:'visible'}) before filling.

2. WRONG ACTION = WRONG SCREEN, SILENTLY. Client actions are reached at
   /odoo/action-<module>.<xmlid>. A wrong xmlid does NOT error — Odoo falls back
   to the default app and you screenshot that instead, which looks like a
   successful run. Grep the module's views/*.xml for the ir.actions.client (or
   ir.actions.act_window) record and use its real id. Assert something unique to
   the target screen is visible before capturing.

3. MODALS EAT CLICKS. If the app shows a dialog — an onboarding prompt, a
   "nothing is running" nag, a wizard — it intercepts every click and Playwright
   reports "<div class='modal'> intercepts pointer events" rather than a miss.
   Escape does not always close it; some are dismissed only by their own button
   or link. Find that control and dismiss any open modal before each click, and
   re-check, because some re-fire on a timer.

4. STALE ASSET BUNDLES. If you edited anything under static/src first: the
   bundle does NOT reliably rebuild on a file change, and the bundle URL hash can
   stay identical while the content is stale — so you will screenshot the OLD
   code and conclude your change failed. Force it by deleting the ir.attachment
   rows named like 'web.assets' (they regenerate on the next request), then
   re-fetch and grep the served bundle for your change before believing it.

Set application state over JSON-RPC (/web/dataset/call_kw, or the module's own
routes) rather than by clicking through the UI. The browser only has to prove
what RENDERS; driving state through it is slow and flaky.

Show me the screenshot when it's done.
```

---

## Using it

- **Trap 4 only matters if you edited web assets in that session.** For a plain "show me
  screen X", skip it.
- If the server also hosts a production database, say so in the prompt. Anything that
  mutates state — and "end the workday" style actions especially — can be one-way.
- Ask for a **before/after pair** when you are proving a visual change. That is what makes
  a screenshot evidence rather than decoration.

## Appendix — the values for this project

| | |
|---|---|
| Odoo | `http://localhost:8069` |
| Databases | `369application` (**live — do not mutate**), `sales_test`, `test`, `SPA`, `grocery_shop`, `tool_managament` |
| Login | `admin` / `admin` on `sales_test` |
| Project path | `c:/Projects/KRA_KPI` — Playwright already installed |
| KPI board action | `kra_kpi_module.action_kpi_action_screen` |
| The modal (trap 3) | the idle prompt "Not on a task?" — dismiss with its **"I have a task — let me start it"** link (`snoozeIdle`; records nothing). Escape will not close it. |
| Workday state | `/kpi_workday/ping`, `/pause`, `/resume`, `/revert` |

**The mobile app is a different toolchain.** `adb exec-out screencap -p > out.png` for a
still; Maestro (`.maestro/regression/`) when it has to be driven. The tablet is
`R52N410F5QE` over USB, running through Metro in Expo Go — so flows target
`host.exp.exponent`, **not** `com.alphalize.krakpi`, which is not installed on it.

## Worked example

`workday-pause/47-03-png-paused-tile.png` came from exactly this prompt.

Its value was as one of a **before/after pair**: the two web captures either side of the
asset-minifier fix showed `9hstandard` becoming `9h standard`, which is what proved the
fix had actually reached the browser. Those two have since been deleted — the pair is the
part worth copying, not the files.
