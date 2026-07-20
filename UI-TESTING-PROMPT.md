# Prompt: build & run the full auto-touch (UI) test harness

Paste the section below into a fresh Claude Code session opened on this repo. It has
the full task, the app's real selectors, and the current status so the new session
can continue without re-discovering everything.

---

## Task
Build a Layer-3 **auto-touch UI test harness** that DRIVES the running app — auto-taps
buttons and asserts screens, end to end — and run it live on my connected device.

## Repo / app
- Repo root: `c:\Users\sriba\OneDrive\Desktop\KRA_KPI` (git working dir is `api\`, but
  the app + `package.json` are at the repo root).
- Android appId: `com.alphalize.krakpi`.

## Device + tooling status (already set up)
- Device connected & authorized over USB: **Samsung Galaxy Tab A (SM-T510)**, id
  `R52N410F5QE`. Verify with `C:\Users\sriba\platform-tools\adb.exe devices`.
- `maestro` installed (`C:\Users\sriba\.maestro\maestro\bin\maestro.bat`), `adb`, `eas`,
  Android Studio/Java. **No emulator/AVD** — this physical tablet is the device.
- The app `com.alphalize.krakpi` is **installed but is the PRE-FIX build** — the new
  workday states ("Continue Workday", "Workday ended for today") may NOT exist in it.
  To test today's fixes, first build+install a fresh one:
  `eas build -p android --profile preview` → `adb install <apk>`.
- **Playwright is NOT installed yet** — run `npm i -D playwright && npx playwright install chromium`.
- Layers 1 & 2 already exist and pass: `npm test` (jest-expo unit + component) and
  `npm run test:e2e` (`scripts/e2e-workday.mjs`, Odoo API). See `TESTING.md`.
- A starter smoke flow exists: `.maestro/00-smoke.yaml` (launch + screenshot, no creds).

## App has NO testIDs — use visible text / placeholders. Real selectors:
- **Login** (`screens/AppLoginScreen.js`, multi-step): mobile step title "Welcome back 👋",
  field placeholder "Mobile number", button "Continue"; password step title "Enter password",
  placeholder "Password", button "Log In".
- **Home** (`screens/HomeScreen.js`): anchors "Hello, <name>", "Your Tasks", "Quick Actions".
  Logout: bottom TabBar "Logout" tab → modal "Log out?" with "Cancel" / "Log Out".
  Read-only workday bar button: "Start Workday" / "Continue Workday" (hidden when day ended).
  Quick-action tile "KPI Action Board" opens the board.
- **PIN screen** (`screens/StartWorkingScreen.js`): titles "Start Working" / "Continue Working" /
  "Workday ended for today"; "Regenerate PIN"; "Not now — keep browsing"; header logout icon →
  a NATIVE OS Alert titled "Log out?" (Cancel / Log out). The 4-digit PIN renders as FOUR
  separate single-char `Text` cells (style `pinDigit`) — no whole-string node; read them from
  the view hierarchy (`maestro hierarchy`), don't assert the full string.
- **Board** (`screens/KpiActionBoard.js`): workday button "End Workday" / "Start Workday" /
  "Continue Workday" / "Workday ended for today"; read-only banner; start-prompt modal
  "⏱  Workday not started" with "Start Workday".
- **Web board pairing**: `services/pairing.js boardWebUrl()` =
  `${ODOO_URL}/odoo/action-kra_kpi_module.action_kpi_action_screen`. OWL gate
  (`odoo_modules/kra_kpi_module/static/src/components/kpi_pair_gate/kpi_pair_gate.js`):
  PIN `input[maxlength="4"]` (placeholder "••••"), auto-submits at 4 digits; submit button
  "Start Working" / "Continue Working"; container `div.o_kpi_pair_gate`; ended card
  "Workday ended for today". Odoo login is standard `/web/login` (`input[name="login"]`,
  `input[name="password"]`, submit "Log in").

## Build (per the approved plan in `.claude/plans/still-it-showing-start-joyful-sonnet.md`)
1. `.maestro/*.yaml` flows (appId above; creds via env `APP_MOBILE`, `APP_PASSWORD`):
   `01-login`, `02-logout-confirm`, `03-start-to-pin`, `04-end-workday`, `05-ended-blocks-restart`.
2. `scripts/read-pin.mjs` — dump `maestro hierarchy`, parse the four `pinDigit` cells → PIN.
3. `scripts/pair-web.mjs` — Playwright: log into `/web/login`, open the board URL, type the
   PIN into `input[maxlength="4"]` (auto-submits), assert the gate disappears.
4. `scripts/e2e-ui.mjs` + npm `test:ui` — check `adb devices`, run login → start-to-pin →
   read-pin → pair-web → assert board reached → end → ended-blocks-restart → logout-confirm;
   stream output; PASS/FAIL per step. Env: `APP_MOBILE`, `APP_PASSWORD`, `ODOO_URL`,
   `ODOO_DB`, `ODOO_WEB_LOGIN`, `ODOO_WEB_PASSWORD` (keep secrets in env, not the repo).
5. `UI-TESTING.md` — how to connect the device, env vars, `npm run test:ui`.
6. Optional: add a few `testID`s to login fields + workday button for robustness.

## First step in the new session
Run the smoke flow live to confirm the pipe works, then read the screenshot:
`maestro test .maestro/00-smoke.yaml` (it launches the app on the tablet and screenshots it).
Then build the flows above and run `npm run test:ui`.
```
````
