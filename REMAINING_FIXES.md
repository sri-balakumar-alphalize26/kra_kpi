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
- [ ] Upgrade the Odoo module, then with a developer session confirm via JSON-RPC that
      `/kpi_owner/certified_by_client`, `/kpi_pending_queue/list` and `/kra_kpi/task/reassign` on
      someone else's task are refused; six wrong OTP codes burn the code; `as_of` is `HH:MM`.
- [ ] New APK (`eas build --profile preview` or `gradlew assembleRelease`), then on device: login
      pictures animate per step; widgets render, resize to 4x2, Pause/Resume works, stale marker
      appears after the app is closed (set the threshold to 1 min to test), logout clears them,
      tapping a person opens Live Tracking on them.

---

## Remaining

### Phase 3 — app correctness bugs
- [ ] **Alarm Stop treats a reminder as a task** — `App.js` `stopAlarmAndClose` (~line 297):
      branch on `a.task.kind === 'reminder'` → `setReminderSnooze(id, null, uid)` + `routeToReminders()`;
      today it calls `session.removeReminder(id)` and `routeToTask(id)` with a reminder id.
- [ ] **Today refresh never starts** — `screens/HomeScreen.js` (~line 1030): the effect lists
      `cardGroup` as a dependency but the state is declared after it; move the `cardTaskId` /
      `cardGroup` `useState` lines above the effect.
- [ ] **Per-task reminders are per device and survive logout** — `api/session.js` `K_REMINDERS`
      keyed by uid (migrate the old key on first read); in `logout()` cancel every task alarm and
      every snooze; `services/reminderAlarm.js` `clearReminderAlarms` must also cancel
      `snoozes[id].notifId`, and cancel a snooze whenever its id leaves the wanted set.
- [ ] **Role gate treats a server error as "unlocked"** — `App.js` (~line 468-503): treat
      `info.status === false` from `/kpi_user/info` as a failure; do not cache the role.
- [ ] **Push for a non-task event opened a random task** — server side done; app side
      `App.js` (~line 587): check `snapshot_id` (→ snapshots) before `routeToTask`.
- [ ] **Home break-card Resume skips the send-back check** — `screens/HomeScreen.js`
      `resumeFromCard`: if the task has `self_needs_resume_reason`, open the board instead.
- [ ] **Stale responses overwrite newer ones** — request-sequence ref in
      `KpiActionBoard.js` `load` (~line 1615), `ClientInvoices.js` (202-210, 502),
      `EmployeeTracker.js` (46-65), `LiveTracking.js` `load` (226-253). `GenerateClientFiles`
      already does this with `subReq` — copy that pattern.
- [ ] **Concurrent reminder syncs arm duplicate alarms** — `services/reminderAlarm.js`:
      serialise syncs through a module promise chain; fixed notifee ids `rem-<uid>-<id>`; store the
      `wanted` kind separately from the kind that fired (fixes the churn from commit dac9c11).
- [ ] **Whole app shows over the lock screen** — `plugins/withAlarmLockScreen.js` sets
      `showWhenLocked` / `turnScreenOn` on `MainActivity`. Remove them; add
      `Function("setLockScreenVisible")` to `modules/expo-task-widget-bridge/.../TaskWidgetBridgeModule.kt`
      (`currentActivity.setShowWhenLocked / setTurnScreenOn`, API 27+); `AlarmScreen` sets true on
      mount, false on unmount. Alarm behaviour stays exactly as now.
- [ ] **Alarm channel never gets the chosen sound** — `services/alarm.js` (~170-176) passes a
      `content://` URI where expo-notifications expects a bundled file name. Create the channel with
      `notifee.createChannel({ sound })`; keep the read-back check.
- [ ] **Removing a task row re-targets its attachments** — `screens/UploadAmendments.js`
      (234, 407, 536-538): attachments reference `rowIndex`; give rows stable ids.
- [ ] **Large file → base64 with no size guard** — `UploadAmendments.js` (276-285) and
      `UserManual.js` (131-138): check the picker's `size` first, as `KpiTaskDetail.onPickManual` does.
- [ ] **Invoice open failure spins forever** — `screens/ClientInvoices.js` (214-222, 637):
      on failure return to the list or show an error state with Retry.
- [ ] **Reset flow traps or half-logs-in** — `screens/AppLoginScreen.js` (~195-206): message
      when `sent:false`; `services/appAuth.js` (79-90): `logged_in:false` → back to the password
      step, never saved as a session.

### Phase 4 — low-impact fixes
- [ ] **Expired Odoo session never detected** — `api/odooApi.js` `jsonRpc` (~208-211): keep
      `code` / `data.name` on errors; on code 100 / `SessionExpiredException` call a registered
      `onSessionExpired` hook (App.js clears the session and shows login with "Your session expired"),
      guarded to fire once.
- [ ] **Logout never destroys the server session** — POST `/web/session/destroy` after
      `unregisterPush`, before `clearSession`.
- [ ] `screens/KpiTaskDetail.js` (136-145): RN's `URL` never throws and appends `/`; validate
      with a regex, store the trimmed original.
- [ ] `screens/KpiActionBoard.js` (~642): reminder bell compares device time with `serverNow()`;
      compare with `Date.now()` consistently.
- [ ] `services/kpiActions.js` `fetchTaskById` (345-355): let network errors throw; the board
      shows "couldn't reach the server" with retry instead of "task removed".
- [ ] `LoginManagementScreen.js` (301-307, 212-247) and `UsersScreen.js` (129-132): honour
      `status === false` (the new duplicate-number refusal from `set_mobile` needs this) and revert
      optimistic changes. Delete the unused `ForgotPasswordScreen.js` stub.

### Phase 5 — new features (all additive)
Session & login
- [ ] "Sign in again" prompt on an expired session (uses the Phase 4 hook).
- [ ] Logout modals in `HomeScreen.js`: when tasks are running, show "N task(s) still running"
      with **Pause all & log out** (opens the existing PauseReasonDialog with `{ taskId: null, count }`
      and a `thenLogout` flag).

Reminders & alarms
- [ ] Verify boot restore: notifee and expo-notifications ship boot receivers — confirm in their
      manifests under `node_modules`; if either does not restore, document that the foreground sync
      in App.js re-arms on next launch.
- [ ] Repeats: on notifee `DELIVERED` for a repeating reminder (background handler in
      `services/nativeWiring.js`), schedule the next occurrence via `reminderAlarm`.
- [ ] `AlarmScreen` **Done** button → `completeReminder(id)` then `stopAlarm`.
- [ ] Reminders editor: KRA/client picker (tree from `fetchClientTree`) writing `kra_id` to `saveReminder`.

Notifications & board
- [ ] `HomeScreen.js` (~933-944): `addNotificationReceivedListener` → refetch the bell count while Home is mounted.
- [ ] `NotificationsScreen.js`: "Action needed" counts only unread + unhandled; "Load more" paging
      (server `offset` if `/kpi_notify/list` supports it, else client-side windowing).
- [ ] `KpiActionBoard.js`: persist view mode + filters per uid (`board_prefs:<uid>` in `api/session.js`), restore on mount.
- [ ] `ClientTaskQueue.js`: discard dialog takes a reason → `discardQueueTask(kpiId, reason)`.

### Build hygiene (behaviour-neutral)
- [ ] Monochrome notification icon in the `expo-notifications` plugin config (`assets/android-icon-monochrome.png` exists).
- [ ] `android.blockedPermissions` for `SYSTEM_ALERT_WINDOW` and external storage; `allowBackup=false`;
      `SCHEDULE_EXACT_ALARM` with `maxSdkVersion=32` beside `USE_EXACT_ALARM`.
- [ ] `ensureAlarmPermission`: check `canUseFullScreenIntent` / exact-alarm status on Android 14+ and deep-link to the setting.
- [ ] `.gitignore` `modules/**/android/build/` and `git rm --cached` the tracked build output.
- [ ] Deferred on purpose (would change the connect flow): `https://` default and a restrictive `network_security_config`.

---

## How to verify each phase
1. `npx jest --testPathIgnorePatterns worktrees` — all suites green (the `attendance.render` test is
   timing-sensitive under full load; it passes alone).
2. `npx expo prebuild --platform android --no-install`, then `git checkout -- package.json`
   (prebuild rewrites the `android`/`ios` scripts).
3. Build and install; walk the device checks listed under **Still to verify**.
4. Server: upgrade the module; set `kra_kpi.ai_digest_api_key`; run the JSON-RPC refusals above.
