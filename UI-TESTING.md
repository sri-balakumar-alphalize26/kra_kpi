# UI Testing — Layer 3 (auto-touch, on the real tablet)

`npm run test:ui` taps through the app **on the connected Android tablet** and asserts
the workday screens end-to-end. **Maestro** drives the Android app; **Playwright** drives
the Odoo **web board** (to type the pairing PIN, since a workday only opens once the PIN
from the phone is accepted on the web).

This is the top layer. The others (keep them green too):
- `npm test` — jest-expo unit tests (11).
- `npm run test:e2e` — backend workday state-machine over the real Odoo API (no UI).

## What it does (A → Z)
1. `adb` — an authorized device is present.
2. **01-login** — mobile + password → Home (`Your Tasks`).
3. **03-start-to-pin** — tap **Start / Continue Workday** on the Home read-only bar → the PIN screen.
4. **read-pin** — read the 4-digit PIN off the screen (four single-char `pinDigit` cells) via `maestro hierarchy`.
5. **pair-web** — Playwright logs into Odoo, opens the board, types the PIN into the OWL gate (auto-submits) → the phone's workday opens and it leaves the PIN screen.
6. **04-end-workday** — wait for the board (`End Workday`), tap it → summary modal → **Logout & Send Summary** → **Workday ended for today**.
7. **05-ended-blocks-restart** — the day cannot be restarted (one start + one end per day); no `Start Workday` reappears.
8. **02-logout-confirm** — the bottom TabBar **Logout** shows a **Log out?** confirm dialog.

## Prerequisites
- **Dev build installed on the tablet** + **Metro running** so the tablet runs your
  current working-tree JS (see the dev-build steps below). The app has **no testIDs**, so
  the flows target visible **text / placeholders**.
- **Tablet connected & authorized:** `C:\Users\sriba\platform-tools\adb.exe devices` shows
  your device as `device`. USB mode should be **File Transfer (MTP)** — *not* USB
  tethering (that can block Metro).
- **Playwright** (installed once): `npm i -D playwright && npx playwright install chromium`.

## Dev build + Metro (one-time per native change)
```bash
npx expo install expo-dev-client
eas build -p android --profile development     # cloud APK, includes uncommitted changes
# install the resulting APK:
eas build:run -p android --latest              # or: adb install -r <downloaded.apk>
npx expo start --dev-client                     # open the app on the tablet → loads your JS
```
JS changes then reload from Metro — no rebuild needed. (Native changes, e.g. the app icon,
need a new build.)

## Credentials — env only, never in the repo
Set these before running (a **QA developer** account — the run starts *and ends* the
workday):

| Var | What |
|-----|------|
| `APP_MOBILE` | app login mobile number |
| `APP_PASSWORD` | app login password |
| `ODOO_URL` | e.g. `https://your-odoo.example.com` |
| `ODOO_DB` | Odoo database (optional if single-db) |
| `ODOO_WEB_LOGIN` | Odoo web login |
| `ODOO_WEB_PASSWORD` | Odoo web password |

Windows `cmd`:
```bat
set APP_MOBILE=8807...&& set APP_PASSWORD=...&& set ODOO_URL=https://...&& set ODOO_DB=...&& set ODOO_WEB_LOGIN=...&& set ODOO_WEB_PASSWORD=...&& npm run test:ui
```
PowerShell:
```powershell
$env:APP_MOBILE="8807..."; $env:APP_PASSWORD="..."; $env:ODOO_URL="https://..."; $env:ODOO_DB="..."; $env:ODOO_WEB_LOGIN="..."; $env:ODOO_WEB_PASSWORD="..."; npm run test:ui
```

## Run
```bash
npm run test:ui        # streams PASS/FAIL per step; exit 0 = all passed
```
Handy while debugging:
```bash
maestro test .maestro/00-smoke.yaml          # launch + screenshot (no creds)
maestro test .maestro/01-login.yaml -e APP_MOBILE=.. -e APP_PASSWORD=..
node scripts/read-pin.mjs                     # print the PIN currently on screen
PAIR_HEADFUL=1 node scripts/pair-web.mjs 1234 # watch the browser pair
```

## Files
- `.maestro/00-smoke.yaml` … `05-ended-blocks-restart.yaml` — the Android flows.
- `scripts/read-pin.mjs` — read the 4-digit PIN from the live hierarchy.
- `scripts/pair-web.mjs` — Playwright: Odoo login → board → type PIN → assert gate gone.
- `scripts/e2e-ui.mjs` — the orchestrator (`npm run test:ui`).

## Notes
- **Mutates data:** it starts and ends the QA developer's workday; the one-per-day rule
  then blocks a restart until tomorrow (the run asserts that). Re-run tomorrow, or reset
  the day for that account.
- Selectors are visible text (no testIDs). If the UI copy changes, update the matching
  `.maestro/*.yaml` line.
