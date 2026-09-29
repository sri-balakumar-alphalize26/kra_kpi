# KRA KPI — remaining fixes and features

Status as of 28 Sep 2026. Everything under **Done** is in the working tree, uncommitted.
Everything under **Remaining** comes from the approved plan (three code sweeps, findings
re-verified by reading the code). Rule for all of it: **do not change any existing flow** —
fixes keep the current screens, buttons, defaults and navigation; features are additive.

---

## Done (uncommitted)

- [x] **Widgets showed the launcher's error tile** — plain `<View>` in both widget layouts is
      not allowed by RemoteViews. Replaced with `<ImageView>`; `plugins/__tests__/widgetLayouts.test.js`
      now checks every tag against the allow-list and every `R.id` the Kotlin uses against the layout.
- [x] **Animated login pictures** — `assets/art/*.js` (three Storyset SVGs as strings),
      `components/AnimatedArt.js` (WebView), wired per step in `screens/AppLoginScreen.js`
      (mobile → Login, password → Secure login, OTP/new password → Forgot password). Old drawing
      stays as the fallback. New dependency: `react-native-webview` 13.15.0 → **rebuild required**.
- [x] **Widgets, phase 1** — `utils/taskWidgetState.js` (pure state shaper, clock-skew aware),
      `utils/widgetLink.js` (bounded deep-link parser), writers stamp `published_at` and re-touch
      every 5 min, Kotlin providers: stale marker ("Open the app to refresh" after 20 min),
      Pause/Resume button (opens Home with the action), 4x2 details block (Presence / Productive /
      away clocks, shown when dragged taller; default size unchanged), per-person row taps on Live
      Tracking (scrolls to and flashes the card). App.js routes the links; logout clears both widgets.
- [x] **Logout crash** — `App.js logout()` called two setters that no longer exist; removed, and
      every per-user state is now reset. Failed role lookups no longer disable the admin widget.
- [x] **Server security (Odoo module — needs a module upgrade on the server)**
  - OTP: attempts cap (5 wrong → burned), request throttle (3 per 15 min), device-lock check on
    verify, constant-time compare — `models/kpi_app_otp.py`, `controllers/kra_api.py`.
  - Login lockout: 5 wrong passwords → 15 min — `models/res_users_signature.py` (new fields
    `kpi_app_failed_logins`, `kpi_app_locked_until`), `controllers/kra_api.py`.
  - Mobile matching on the full local number, collisions refused; `set_mobile` refuses duplicates.
  - Task actions (start / pause / complete / reassign) require the assignee or an admin
    (`_task_actor_or_refuse`).
  - Owner billing routes, `/kra_kpi/ai_digest` and `/kpi_pending_queue/list` require an admin
    (`_is_owner_admin` in `kpi_reports_api.py`, `_is_kra_admin` in `kra_api.py`).
  - `/kra_kpi/ai_digest_public` refuses until `kra_kpi.ai_digest_api_key` is set in System
    Parameters (**operational: set the key or the n8n digest stops working**).
  - Live Tracking `as_of` is local `HH:MM` (`as_of_raw` kept); non-task pushes carry no `kpi_id`.
- [x] Tests: 298 pass (`npx jest --testPathIgnorePatterns worktrees`). New: `taskWidgetState`,
      `widgetLink`, `AnimatedArt` (+ noWebView), `appLogin.render`, extended `liveTrackingWidgetState`
      and `widgetLayouts`.

### Still to verify for the done items
- [x] `py -m py_compile` on the five edited Python files (`kra_api.py`, `kpi_reports_api.py`,
      `kpi_app_otp.py`, `res_users_signature.py`, `kpi_notify.py`) — all compile.
- [x] Kotlin compile of the generated providers: `cd android && ./gradlew :app:compileDebugKotlin`
      — finished clean.
- [x] Server fixes verified on the LOCAL Odoo 19 (`369application`, 28 Sep): the new columns
      exist; a developer's pause / start / reassign on someone else's task is refused; the owner
      billing routes, `/kra_kpi/ai_digest`, `/kpi_pending_queue/list` and Live Tracking refuse a
      developer; the placeholder digest key is refused; `as_of` is local `HH:MM`; five wrong PINs
      lock the number and the right PIN is refused until the lock clears; five wrong codes burn a
      live code (marked used, 5 attempts); the fourth code request in 15 min issues none;
      `set_mobile` refuses a number another account has. Run with a throwaway developer
      (`qa.sweep.test`, now deactivated).
      **How the local server was updated** (the addons path is the core folder, so the module is a
      COPY): copy the five edited files into
      `C:\Program Files\Odoo 19.0.20260119\server\odoo\addons\kra_kpi_module\`, run
      `odoo-bin -c odoo.conf -d 369application -u kra_kpi_module --stop-after-init --no-http`, and
      restart the `odoo-server-19.0` service. The RPC `button_immediate_upgrade` alone does NOT
      load edited Python on Windows (single process). Four files in that installed copy differ from
      the repo for reasons unrelated to this work (`data/kpi_download_cleanup_cron.xml`,
      `models/kpi_report_download.py`, two web components); they were left as they were.
      **Caveat seen while testing**: on a multi-database Odoo 19, the app's `/kpi_app/login` with
      the `X-Odoo-Database` header answers success but sets no session cookie (Odoo runs such
      requests sessionless). Pre-existing; irrelevant on a single-database server.
      Production still needs the module upgrade and the digest API key.
- [ ] New APK (`eas build --profile preview` or `gradlew assembleRelease`), then on device: login
      pictures animate per step; widgets render, resize to 4x2, Pause/Resume works, stale marker
      appears after the app is closed (set the threshold to 1 min to test), logout clears them,
      tapping a person opens Live Tracking on them.

---

## Remaining

### Phase 3 — app correctness bugs
- [x] **Alarm Stop treats a reminder as a task** — `App.js` `stopAlarmAndClose`: a reminder now
      clears its snooze and opens Reminders; a task path is unchanged.
- [x] **Today refresh never starts** — `screens/HomeScreen.js`: the `cardGroup` state now sits
      above the effect that depends on it.
- [x] **Per-task reminders are per device and survive logout** — `api/session.js` keys
      `kpi_reminders` by the signed-in user (`setReminderOwner`, old key migrated on first read);
      `logout()` cancels every task alarm (`clearTaskReminders`) and every snooze
      (`clearReminderAlarms`); the sync cancels a snooze whose reminder was deleted.
- [x] **Role gate treats a server error as "unlocked"** — `/kpi_user/info` answering
      `status:false` is now a failure and the role is not cached.
- [x] **Push for a non-task event opened a random task** — server drops `kpi_id`; the app
      routes `snapshot_id` to the snapshots screen (warm and cold start).
- [x] **Home break-card Resume skips the send-back check** — `resumeFromCard` looks the task
      up in the lanes and sends a sent-back self-created task to the board.
- [x] **Stale responses overwrite newer ones** — request-sequence guards in
      `KpiActionBoard.js` `load`, `ClientInvoices.js` `loadList`, `EmployeeTracker.js` `load`,
      `LiveTracking.js` `load`.
- [x] **Concurrent reminder syncs arm duplicate alarms** — syncs are queued one after another;
      the armed entry stores the `wanted` kind so a refused alarm no longer churns every sync.
      (Fixed notifee ids were not added: `scheduleTaskAlarm` generates its own and the queue
      already prevents the duplicate.)
- [x] **Whole app shows over the lock screen** — the manifest flags stay (a cold-start alarm
      still rings over the keyguard); the bridge module gained `setLockScreenVisible`, App.js
      turns it off at start and `AlarmScreen` turns it on while it shows. **Verify on a locked
      phone**: alarm still shows; Login Management does not.
- [ ] **Alarm channel never gets the chosen sound** — DEFERRED. `services/alarm.js` builds the
      channel through expo-notifications on purpose (notifee's channel has no `audioAttributes`,
      and usage ALARM is what keeps the ring on the alarm stream). Check on a device whether the
      chosen `content://` sound actually plays; if not, the fix needs a native channel helper
      that sets both the URI and the audio attributes, not a switch to notifee.
- [x] **Removing a task row re-targets its attachments** — rows carry a stable `rowId`;
      attachments point at it; deleting a row drops its attachments.
- [x] **Large file → base64 with no size guard** — 25 MB caps in `UploadAmendments.js`
      (Source Document) and `UserManual.js` (PDF), checked before the read.
- [x] **Invoice open failure spins forever** — `ClientInvoices.js` returns to the list with
      the error banner.
- [x] **Reset flow traps or half-logs-in** — `startOtp` says when the code could not be sent;
      `verifyOtp` reports `loggedIn:false` and the screen returns to the password step instead
      of saving a session with no uid.

### Phase 4 — low-impact fixes
- [x] **Expired Odoo session never detected** — `jsonRpc` keeps Odoo's `code` / name on the
      error and fires a once-per-expiry handler; App.js clears local state and shows the login
      screen with "Your session has expired. Please sign in again."
- [x] **Logout never destroys the server session** — `logout()` POSTs `/web/session/destroy`
      (skipped when the server itself reported the session gone).
- [x] `KpiTaskDetail.js` link validation by pattern; the trimmed original is stored.
- [x] `KpiActionBoard.js` reminder bell compares on the device clock.
- [x] `fetchTaskById` throws on network failure; the board says "Couldn't reach the server" and
      lets the same notification be tried again.
- [x] `LoginManagementScreen.js` template save/reset go through `guard()`; a refused country
      change reverts the row; `UsersScreen.js` reads the role and mobile results (the new
      duplicate-number refusal shows as an error). `ForgotPasswordScreen.js` removed.

### Phase 5 — new features (all additive)
Session & login
- [x] "Sign in again" on an expired session: the login screen opens with "Your session has
      expired. Please sign in again."
- [x] Logout dialogs (Home tab bar and Profile) say "N task(s) still running" and offer
      **Pause all & log out**, which pauses everything with the note "Logged out of the app"
      and then signs out. Plain Log Out is unchanged.

Reminders & alarms
- [x] Boot restore checked: expo-notifications restores banners on boot (its manifest has the
      boot receiver); notifee alarms are re-armed by the app's next foreground sync. Documented in
      `services/reminderAlarm.js` and `screens/Reminders.js`.
- [x] Repeats: an uncompleted daily / weekly reminder now rolls forward to its next occurrence on
      the device (`utils/reminderSchedule.js` `rollForward`, tested), so it keeps ringing until Done.
- [x] `AlarmScreen` **Done** button for reminders → marks it complete on the server (advances a
      repeat), silences it, clears the snooze, opens Reminders.
- [x] Reminders editor: "About (optional)" picker of client → project, saved as `kra_id`.

Notifications & board
- [x] Home bell badge re-counts when a push arrives while Home is open.
- [x] Notifications: "Action needed" badge counts unread action rows only; "Load older
      notifications" pages past the first 100 (server `offset`).
- [x] Action Board remembers the view (board / list) and the All / My toggle per user.
- [x] Client Task Queue: the discard dialog takes an optional reason, sent to the client.

### Build hygiene (behaviour-neutral)
- [x] Monochrome notification icon (`assets/android-icon-monochrome.png`, colour #1E40AF) in the
      `expo-notifications` plugin config — status-bar icon is no longer a white blob.
- [x] `android.blockedPermissions` (`SYSTEM_ALERT_WINDOW`, external storage), `allowBackup=false`,
      `SCHEDULE_EXACT_ALARM` capped at API 32 (`plugins/withAlarmLockScreen.js`). Verified in the
      generated manifest.
- [x] `ensureAlarmPermission` checks notifee's exact-alarm setting on Android 14+ and opens the
      system switch when it is off. (`canUseFullScreenIntent` has no notifee API; not added.)
- [x] `.gitignore` covers `modules/**/android/build/`; the tracked build output is removed from
      the index.
- [ ] Deferred on purpose (would change the connect flow): `https://` default and a restrictive `network_security_config`.

### Attendance (feature from the 369Attendance work, app side committed here)
- [x] App side: `screens/AttendanceScreen.js`, `services/attendance.js`, the Home bubble and the
      Configuration card are committed (commit "Show HR attendance in the app…"); unit and render
      tests pass.
- [x] Server side deployed LOCALLY (28 Sep): `kra_kpi_attendance_bridge` 19.0.3.0.0 from
      `C:\Projects\APK's\369Attendance\odoo_modules` copied into the Odoo addons folder, upgraded
      from the command line, service restarted. `/kpi_config/get` now returns
      `attendance_available` / `attendance_in_app`; `/kpi_attendance/status`, `/mine`, `/team`
      answer; the company switch toggles and was put back to OFF.
      Never leave a `.bak` folder inside the addons directory — Odoo 19 treats every folder there
      as a module and refuses to load with "Invalid module name".
- [ ] Production: upgrade `hr_attendance_369` + `kra_kpi_attendance_bridge` there too, then turn
      the switch on in Configuration → Attendance.
- [ ] On a device: the bubble appears for a user with an hr.employee record once the switch is
      on; Me and Team views load; `/kpi_attendance/team` refuses users without team rights (admin
      without an employee record got "Not authorized" locally — the bridge's rule, check it is
      the intended one).

### Still to verify on a device (needs the new APK)
- [ ] Locked phone: the alarm still rings over the lock screen; Login Management does not show.
- [ ] Logout with a running task → the dialog offers Pause all & log out; both paths work.
- [ ] Reminder alarm → Done marks it complete; a daily reminder rings again the next day without
      being completed.
- [ ] Notification status-bar icon is the monochrome logo; Load older notifications appends.

---

## How to verify each phase
1. `npx jest --testPathIgnorePatterns worktrees` — all suites green (the `attendance.render` test is
   timing-sensitive under full load; it passes alone).
2. `npx expo prebuild --platform android --no-install`, then `git checkout -- package.json`
   (prebuild rewrites the `android`/`ios` scripts).
3. Build and install; walk the device checks listed under **Still to verify**.
4. Server: upgrade the module; set `kra_kpi.ai_digest_api_key`; run the JSON-RPC refusals above.
