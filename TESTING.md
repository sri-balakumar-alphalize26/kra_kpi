# Automated tests

Layered so regressions get caught without a device. Layers 1 + 2 are the
day-to-day safety net; Layer 3 (on-device UI) is optional and documented at the
bottom.

## Layer 1 — Logic + component tests (Jest). No device, runs anywhere.

```bash
npm test           # run once
npm run test:watch # re-run on change
```

What it covers:
- **`utils/__tests__/workdayState.test.js`** — the whole Start / Continue / End /
  "Workday ended for today" decision matrix (the logic behind the button label +
  action on the board and Home bar). Pure function, 8 cases.
- **`screens/__tests__/StartWorkingScreen.test.js`** — renders the REAL PIN screen
  and asserts it shows "Start Working" / "Continue Working" / "Workday ended for
  today" (and hides the PIN when the day is done), driven by a mocked server.

Setup lives in `package.json` (`"jest"` block, preset `jest-expo`), `babel.config.js`
(standard Expo preset), and `jest.setup.js` (mocks the native-only bits — safe-area,
vector icons, SVG — so screens render in Node).

Add a component test by dropping a file in `screens/__tests__/*.test.js`; mock the
service module the screen calls and assert on visible text. Keep the pure decision
logic in small helpers like `utils/workdayState.js` so it can be unit-tested without
rendering anything.

## Layer 2 — Backend API end-to-end (Odoo). No device; needs a reachable server.

Drives the real `/kpi_pair/*` and `/kpi_workday/*` endpoints in sequence and asserts
the **one-start-one-end-per-day** rule (start → end → restart blocked → PIN refused).

```bash
# PowerShell
$env:ODOO_URL="https://your-odoo"; $env:ODOO_DB="your_db"; `
$env:ODOO_LOGIN="qa_developer"; $env:ODOO_PASSWORD="..."; `
npm run test:e2e

# bash
ODOO_URL=https://your-odoo ODOO_DB=your_db ODOO_LOGIN=qa_developer ODOO_PASSWORD=... npm run test:e2e
```

⚠️ It **starts and ends the workday** for `ODOO_LOGIN`, which then blocks a restart
until tomorrow. **Use a QA/test developer account**, not a real person mid-workday.
Safe to re-run: if the day is already ended it verifies only the "blocked" branch.

Script: [`scripts/e2e-workday.mjs`](scripts/e2e-workday.mjs).

## Layer 3 — On-device UI (Maestro) — optional, not set up yet

`maestro` is already installed on this machine, but there's **no emulator/AVD** and
no device was connected, so it isn't wired up. To use it later:

1. Connect a phone with **USB debugging** (or set up an Android AVD) → `adb devices`
   shows it, and install a fresh build (`eas build -p android --profile preview`).
2. Add flows under `.maestro/*.yaml` (`appId: com.alphalize.krakpi`) — e.g. login,
   logout-confirm, read-only banner, reaching the PIN screen.
3. `maestro test .maestro/`.

Note: the full workday flow needs the **web board** too (the PIN is typed on a
computer), so a complete on-device run also needs a Playwright script driving Odoo
web to enter the PIN. Layers 1 + 2 already cover that logic without it.
