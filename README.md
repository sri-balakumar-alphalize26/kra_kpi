# KRA KPI

> Workday and task tracking for service teams — staff run their day against KRA/KPI targets,
> admins configure and assign, and clients file requirements and settle invoices, all from one
> Odoo-backed app.

KRA KPI is an [Expo](https://expo.dev) React Native app for the
[`kra_kpi_module`](odoo_modules/kra_kpi_module/) Odoo 19 module that ships beside it. A developer
starts a workday, works a board of KPI tasks with pause reasons and completion checklists, and
ends the day with a summary and a map of where the time went. An administrator sets the timers,
manages logins and assigns clients. A client uploads requirements, watches tasks progress and
pays invoices.

The server behind it does a lot on its own — the module registers fourteen cron jobs covering
workday rollover, idle checks, auto-away, pre-approval escalation, queue nudges, snapshot cleanup
and the daily report.

## The three roles

The app presents a different home screen per role, and ships a separate manual for each.

**Staff / developer** — connect and sign in, home with a live strip, the KPI Action Board, task
cards with pause reasons and a completion checklist, remind-me alarms, end-of-workday summary,
a workday map, My Workday, personal snapshots, notifications and profile.

**Administrator** — admin home, company branding, configuration for timers and developers, user
management, login management, the KRA/KPI master, client assignment, the client task queue,
requirement uploads, generated client files and reassignment history.

**Client** — client home, destination and bulk source import, task rows, create-all-tasks,
requests, invoices, notifications and profile.

## Features

**Workday** — start and end a day, pause with a reason, idle and auto-away handling by server
cron, workday notes, snapshots, and a map of the day.

**Tasks** — the KPI Action Board, task detail with checklists, task documents, pre-approval and
escalation, a client task queue, reassignment with a full history, and paid-work tracking.

**Reporting** — daily reports, work reports, owner dashboard, KRA/KPI dashboard and live
tracking of who is active right now.

**Client portal** — bulk import of requirements, task creation in one action, requests, and
client invoices with payment state.

**Platform** — Firebase push notifications that land in the tray with the app closed, alarms via
`notifee`, an in-app user manual served from Odoo, company branding, and Google Meet links posted
into chat by trigger word.

## Tech stack

| | |
|---|---|
| Framework | Expo SDK ~54, React Native 0.81.5, React 19.1 |
| Navigation | Hand-rolled — [App.js](App.js) switches screens directly, with [components/ScreenTransition.js](components/ScreenTransition.js). No navigation library. |
| Networking | axios against Odoo JSON-RPC — [api/odooApi.js](api/odooApi.js), [api/session.js](api/session.js) |
| Push | expo-notifications + FCM, plus `@notifee/react-native` for alarms |
| Media | expo-camera, expo-image-picker, expo-document-picker, expo-image-manipulator |
| Graphics | react-native-svg, expo-blur |
| Testing | Jest, plus end-to-end scripts in [scripts/](scripts/) |

`notifee` is a native module, so it is loaded **defensively** in `App.js` — a static import would
throw at launch in a build without the native side. Until it is available the alarm wiring no-ops
and the app runs normally on the notification reminder alone.

## Odoo backend

All four modules are in [odoo_modules/](odoo_modules/) and target **Odoo 19**.

| Module | Purpose |
|---|---|
| `kra_kpi_module` | KRA/KPI Master with a custom OWL UI — the core. Depends on `base`, `web`, `whatsapp_neonize`. Currently v19.0.4.4. |
| `whatsapp_neonize` | QR-based WhatsApp messaging inside Odoo using Neonize (pure Python) — carries approvals and nudges |
| `app_user_manual_369` | Role-based mobile app user-manual PDFs stored in the database |
| `chats_369` | Company WhatsApp-style chat for the mobile app; optional, shared with the 369Chats app |

A packaged build of the core module is kept at the repo root as
`kra_kpi_module_19.0.2.5.zip`.

## Getting started

**Prerequisites** — Node.js 18+, npm, and a reachable Odoo 19 server with the modules above
installed. `google-services.json` must be present for an Android build that uses push.

```bash
npm install
npx expo start
```

The first screen asks for the Odoo server and database; sign-in follows, and a remembered session
boots straight to Home after the splash.

Push notifications and alarms need a **development build**, not Expo Go — `notifee` and the FCM
native side are not in the Go client:

```bash
npx expo run:android
```

## Testing

```bash
npm test              # Jest unit tests
npm run test:e2e      # scripts/e2e-workday.mjs
npm run test:ui       # scripts/e2e-ui.mjs
npm run check:bundle  # scripts/check-bundle.mjs
```

[scripts/](scripts/) also holds targeted end-to-end runs — billing dedup, the client flow,
invoice payments, workday pause, auto-close — plus API smoke and functional probes and a
`deploy-upgrade.mjs` helper. Several of these talk to a live server; read the file before running
one.

## Building

Profiles are in [eas.json](eas.json). All three produce an APK on internal distribution:

```bash
eas build --profile development   # dev client
eas build --profile preview
eas build --profile production    # autoIncrement, remote version source
```

Current release: **v1.1.0**, Android package `com.alphalize.krakpi`.

Push credentials are stored per EAS project. If the project id changes, re-upload the FCM key
with `eas credentials` — [FIREBASE_PUSH_SETUP.md](FIREBASE_PUSH_SETUP.md) walks through the whole
setup from scratch.

## Project structure

```
App.js            app shell and the screen state machine
screens/          31 screens — Splash, Connect, Login, AppLogin, SignUp, Home,
                  KraKpiDashboard, KpiActionBoard, KpiTaskDetail, MyWorkday,
                  WorkdaySnapshots, WorkReport, DailyReports, OwnerDashboard,
                  LiveTracking, ClientTasks, ClientTaskQueue, ClientInvoices,
                  GenerateClientFiles, UploadAmendments, TaskDocuments,
                  ReassignmentHistory, PaidWork, Users, LoginManagement,
                  Configuration, CompanyBranding, Notifications, Alarm, UserManual
services/         26 domain modules — kraKpi, kpiActions, myWorkday, workReport,
                  clientPortal, clientInvoices, liveTracking, push, alarm,
                  reminders, preApproval, pendingQueue, reassignmentHistory, ...
api/              odooApi.js, session.js, logger.js
components/       AppDialog, CameraCaptureModal, DurationTimePicker, KraNode,
                  GradientButton, ReorderableMenu, ScreenTransition, TabBar, ...
scripts/          e2e and API scripts, manual build, deploy helper
documents/        role manuals plus a screenshot set per role
odoo_modules/     the Odoo modules this app depends on
android/          native project
```

## Documentation

- [documents/](documents/) — `kra-kpi-admin-manual.docx`, `kra-kpi-user-manual.docx` and
  `kra-kpi-client-manual.docx`, with a captioned screenshot set per role under
  `documents/screenshots/`.
- [FIREBASE_PUSH_SETUP.md](FIREBASE_PUSH_SETUP.md) — how FCM push was set up and how to redo it
  if the EAS project changes.
- [GOOGLE_MEET_SETUP.md](GOOGLE_MEET_SETUP.md) — configuring the host Google account that backs
  automatic Meet links.
- [SESSION_2026-08-17.md](SESSION_2026-08-17.md) — engineering notes, verified against the running
  server, including what is built but still unproven.
- [AGENTS.md](AGENTS.md) — a standing reminder to read the versioned Expo docs before writing code.
