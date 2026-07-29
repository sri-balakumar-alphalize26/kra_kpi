# KRA/KPI — session handover

Written at the end of a long working session so a fresh session can pick up
without re-deriving anything. Everything here was verified against the code or
the live database, not recalled.

---

## 1. Environment (verified)

| | |
|---|---|
| Odoo | `C:\Program Files\Odoo 19.0.20260119\` — service **`odoo-server-19.0`**, port **8069** |
| Live DB | **`369application`** (others exist: `sales_test`, `g9/g10/g11_test`, `grocery_shop`, `tool_managament`, `test`) |
| Addons | `C:\Program Files\Odoo 19.0.20260119\server\odoo\addons\kra_kpi_module` |
| Module version | **19.0.2.5**, installed |
| Postgres | `psql.exe` under `...\Odoo 19.0.20260119\PostgreSQL\bin\`, user `openpg`, password `openpgpwd` |
| App | Expo **SDK 54** (`expo ~54.0.36`), managed workflow, `expo-notifications ~0.32.17` |

> `AGENTS.md` says read the **v57** Expo docs, but the project is pinned to **54**.
> Work to what is installed unless told otherwise.

### Deploy (CMD as Administrator) — one line

```cmd
net stop odoo-server-19.0 & robocopy "c:\Projects\KRA_KPI\odoo_modules\kra_kpi_module" "C:\Program Files\Odoo 19.0.20260119\server\odoo\addons\kra_kpi_module" /MIR /XD __pycache__ /XF *.pyc & if errorlevel 8 (echo *** COPY FAILED - SKIPPING UPGRADE *** & net start odoo-server-19.0) else ("C:\Program Files\Odoo 19.0.20260119\python\python.exe" "C:\Program Files\Odoo 19.0.20260119\server\odoo-bin" -c "C:\Program Files\Odoo 19.0.20260119\server\odoo.conf" -d 369application -u kra_kpi_module --stop-after-init & net start odoo-server-19.0)
```

**Why it is built this way** — `robocopy /MIR` not `xcopy`: files were *deleted*
this session, and xcopy would leave them behind. `&` not `&&`: robocopy exits **1**
on a successful copy-with-changes, which `&&` reads as failure. `if errorlevel 8`
is the real failure threshold. Both branches restart the service, so Odoo is never
left down.

### Verifying / checking things

```bash
# tests (Windows jest-worker can fail to spawn; --maxWorkers=1 is reliable)
npx jest --silent --maxWorkers=1

# python syntax
py -c "import py_compile; py_compile.compile('<file>', doraise=True)"

# js syntax
node --check <file>
```

---

## 2. Git state

- `f5a611f` — PIN gate removed, idle auto-pause off *(committed)*
- `6e0912d` — lunch/break, admin approvals, multitask, timezone, delete routes *(committed)*
- **~28 files uncommitted** (+1993/−774) — everything after `f5a611f`

Suggested message for the uncommitted batch:

```
Add Pause Workday, Switch task, admin Revert, and task-type requests
```

---

## 3. Non-obvious things — read before changing related code

These cost real debugging time. Each is a trap that looks fine.

### The client portal has TWO query branches
`kpi_reports_api.py` (~:2314 and ~:4062):
```python
'|', ('task_state', '=', 'awaiting_client'),
     '&', ('task_state', '=', 'partially_completed'), ('admin_approved', '=', True)
```
Moving state alone does **not** hide a task from the client — **clearing
`admin_approved` is what hides it**. The Revert feature depends on this.

### Presence must never double-count
`Accounted + Other/Idle = Presence` is load-bearing. Consequences:
- `kpi.break.log` keeps **one active break per user** — a 20-min lunch with 3 tasks
  open is 20 min away, not 60. Do not write a break row per task.
- Pausing the workday **closes open breaks**, or the same minutes are booked as
  both paused and lunch.
- Productive is the **union** of task intervals (`_measure`), not a sum — two
  concurrent tasks for 2h is 2h of wall-clock, not 4h.

### Local date vs UTC date
`session_date` is `fields.Date.context_today()` (**local**);
`start_time` is naive **UTC**. Use `_local_day_start_utc` / `_local_day_end_utc`
in `kpi_work_session.py` for any day boundary. A naive
`datetime.combine(date, time(23,59,59))` stored as UTC is **5.5h late for IST** and
inflated presence on every cross-midnight close.

### OWL template handlers must be bound
`t-on-click="someMethod(x)"` calls it off the context — `this` is **undefined**
unless bound in `setup()`. `t-on-click="() => this.someMethod(x)"` works without
binding. Both conventions exist in `kpi_action.js`. A missed bind crashes at click
time and **no syntax check catches it**.

### Dropdown values must exist in `statusMapping`
`getFilteredTasks` maps a filter value to a **column key**; a value missing from the
map resolves to `undefined`, matches nothing, and silently returns an **empty
board**. `awaiting_client` was broken this way. Keep dropdown / `statusMapping` /
`filterStatusLabel` / lane keys in sync.

### `is_paused` is a flag, not a `state` value
`state = 'open'` is searched in a dozen places. Adding a `'paused'` state would
silently change all of them.

### Don't use bash heredocs to edit files with `\n` in strings
Mangles escapes into real newlines and breaks the file. Use the Edit tool or
line-based Python.

---

## 4. What changed, by area

### Workday lifecycle
- **PIN gate removed.** The board opens directly; the workday starts from the
  **Start Workday** button. `/kpi_pair/*` remain as **shims** answering "already
  paired" so installed phone apps don't stall — *do not delete them as dead code*.
- **Idle auto-pause + auto-close disabled** (`away_after_minutes = 0`,
  `workday_idle_close_minutes = 0`, both crons inactive via the `19.0.2.5`
  migration). Sleeping laptops and closed tabs no longer end anything.
- **Midnight close is the only automatic close left** and is deliberately kept.
- **Task actions are gated on an open, unpaused workday** —
  `kra.kpi._actor_workday_open()` → `_start_block()` → `can_start` on both boards.
  Admins are exempt.
- **Pause Workday** (new): freezes the day — tasks stop, breaks close, Presence
  stops — and is resumable the same date. Lives **inside the End Workday dialog**;
  **Resume** lives in the header. Fields `is_paused` / `paused_at` /
  `paused_seconds` on `kpi.work.session`.

### Tasks
- **Switch task** — per-card; `from_kpi_id` means only that task hands over, so
  the other timer keeps running under multitask. Validates the target *before*
  pausing anything.
- **Pause all (N)** — live strip, 2+ timers, one shared reason.
- **Admin Revert** — only from `awaiting_client` → `paused`, clears
  `admin_approved`, notifies the developer (`task_reverted`).
- **Multitask reporting** — per-interval solo/shared split, union-based Productive,
  **Accounted** total.
- **Complete** needs **one** checklist item (client *and* server); panel visibility
  uses `effective_contributor_ids`, not just the primary assignee.
- **`requested_priority` / `requested_doc_type`** — what the developer asked for is
  recorded; only the admin's choice on Accept is saved.
- **Estimate optional** on developer-created tasks.

### Security fixes
- `/kra_kpi/delete_kra` and `/kra_kpi/delete_kpi` had **no auth** while
  `sudo()`-unlinking. Guarded.
- `/kpi/manual/delete` guarded.
- `/task_documents/list` was `sudo().search([])` — every task for everyone. Now
  scoped to `effective_contributor_ids`. `/task_documents/details` had **no check
  at all**.
- App PIN and Odoo password **decoupled** (setting a 4-digit PIN used to become the
  Odoo login password). Reset guard: only a system admin may reset another system
  admin.

### App (Expo)
- PIN screen + `services/pairing.js` deleted; read-only now follows the **workday**.
- `KeyboardAvoidingView` fixed on 4 auth screens — it was `undefined` on Android
  (did nothing), and on `AppLoginScreen` it was also **nested too deep** to move
  anything.
- Two bottom-sheet modals centred; the other 53 already were.
- Pause/Resume Workday, multi-task strip, Accounted, solo/shared, admin delete.

---

## 5. Outstanding

1. **App parity**: Switch task (per-card) and admin Revert are **web only**.
2. **Push notifications** — *not fixed*. The app setup is correct
   (`projectId`, `google-services.json`, plugin, permission, channel,
   `shouldShowBanner`, `registerForPushAsync` called). What was fixed is that
   failures were **invisible**: `_handle_push_receipts` acted on
   `DeviceNotRegistered` only and `_send_push` logged success regardless. It now
   logs `push_failed` with the real Expo error. **Trigger a notification and read
   `kpi_action_log`** — `MismatchSenderId` / `InvalidCredentials` mean the EAS FCM
   V1 credentials don't match the build, which is fixed in the EAS account, not here.
   Also noticed: a push token registering against **`sales_test`**, not
   `369application` — check which server URL the phone points at.
3. **WhatsApp session** shows `waiting_qr` — needs re-scanning. Unrelated to code.
4. **Nothing has been tested end-to-end** against a running Odoo or a device.
   Verified: byte-compile, JS parse, XML parse, manifest paths, 7 unit tests.

---

## 6. Test first (highest risk)

1. **Workday gate** — a developer cannot Start a task before Start Workday; an
   **admin still can** without their own workday. Inverted logic here stops
   everyone working.
2. **Pause Workday** — Presence visibly **stops**; lunch chip disappears; Start is
   refused with *"Resume your workday"*; Resume restarts from now (not back-filled).
3. **Switch under multitask** — tasks 1+2 running, Switch on 1 → **task 2's timer
   never pauses**.
4. **Revert** — as admin revert from Awaiting Client, then **log in as the client**
   and confirm it is gone.
5. **Complete** — one tick enables *and* saves; panel appears for a **contributor**.
6. **Filter by Awaiting Client** — should list tasks (was returning an empty board).
7. **App**: read-only → Start unlocks → End re-locks; force-close/reopen after
   ending still shows "Workday ended for today".

---

## 7. Useful queries

```sql
-- workday state
SELECT u.login, s.state, s.is_paused, s.paused_seconds, s.last_heartbeat
FROM kpi_work_session s JOIN res_users u ON u.id = s.user_id
WHERE s.session_date = current_date;

-- crons (auto_away + close_idle should be inactive)
SELECT d.name, c.active FROM ir_model_data d JOIN ir_cron c ON c.id = d.res_id
WHERE d.module = 'kra_kpi_module' AND d.model = 'ir.cron' ORDER BY c.active, d.name;

-- push outcomes
SELECT event, success, payload FROM kpi_action_log
WHERE event IN ('push_sent','push_failed') ORDER BY id DESC LIMIT 10;
```

---

## 8. Working preferences observed

- Module first, then app — and **give the deploy command** with the change.
- Short, direct answers; the one-line CMD block matters.
- Confirm before building anything with real consequences (auth, billing,
  data-destroying) — several requirements reversed mid-design, so **check the
  intent before implementing**, not after.
