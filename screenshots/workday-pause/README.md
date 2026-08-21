# workday-pause

First end-to-end test of the three app-visible fixes in `dd6bd06`, on tablet
`R52N410F5QE` (SM_T510, Expo Go over Metro), 21 Aug 2026 — run twice, once as
**Mitchell Admin** and once as a **developer**.

Run against **`sales_test`**, not the live database — deliberately: the flow starts,
pauses, resumes and ends workdays.

The **admin** run is the one that proves the fix. The bug was that
`_actor_workday_open()` opened with `if _user_is_kpi_admin(): return True`, skipping the
`is_paused` check entirely, so an admin-only run of the old code would have shown Start
still live on a frozen day. A developer was always blocked correctly — so the
**developer** run is a regression check on the branch beside it, which was rebuilt as
`base + [...]` in the same edit.

`sales_test` was upgraded `19.0.4.2 → 19.0.4.4` first. Confirmed on the stored
`latest_version`, not `installed_version` — the latter is a compute that reads the
manifest off disk and reports the new number before any upgrade has run.

Two layers, because they prove different halves:

| Layer | What it proves |
|---|---|
| `scripts/e2e-workday-pause.mjs` | the RULE — `can_start`, the refusal, the arithmetic |
| `.maestro/regression/45-workday-pause.yaml` | the SCREEN — what a person actually sees |
| `.maestro/regression/46-workday-pause-dev.yaml` | the same screen as a DEVELOPER, plus the one thing that differs |

Both layers were run **as an admin AND as a developer**. The script is role-aware:
exactly one assertion differs, and it is the one a refactor could most plausibly
invert.

## Layer 2, as an admin — `node scripts/e2e-workday-pause.mjs` → **15/15**

Drives the endpoints the app calls, in the order it calls them.

```
PASS  admin with no workday can still start        — task 4 can_start=true
PASS  THE FIX — can_start is false while paused    — can_start=false
PASS  THE FIX — reason is workday_paused           — start_block_reason="workday_paused"
PASS  no task anywhere is startable while paused   — 0 of 54 still startable
PASS  starting a task is refused while paused      — "Your workday is paused. Resume it
                                                      before working on 'att 2'."
PASS  Presence stopped at paused_at                — presence=0h 0m 9s vs
                                                      paused_at-login=0h 0m 9s drift=0.0s
PASS  can_start is true again after resume         — can_start=true
```

### As a developer — `ODOO_LOGIN=apitest_dev ... node scripts/e2e-workday-pause.mjs` → **16/16**

```
role: DEVELOPER  (kra_admin=false system=false)
PASS  ASYMMETRY -- developer with no workday cannot start
                                                   — 4 of 4 blocked
PASS  ASYMMETRY -- and the reason is the missing workday
                                                   — 4 of 4 report start_block_reason 'workday'
PASS  THE FIX — can_start is false while paused    — can_start=false
PASS  no task anywhere is startable while paused   — 0 of 4 still startable
PASS  starting a task is refused while paused      — "Your workday is paused. Resume it
                                                      before working on 'REQ-025'."
```

**The asymmetry, asserted from both sides.** With no workday open:

| Role | `can_start` |
|---|---|
| admin | **allowed** — `task 4 can_start=true` |
| developer | **blocked** — `4 of 4`, reason `workday` |

For a developer the domain in `_actor_workday_open()` is unchanged — it was only
rebuilt as `base + [...]` — so the developer run is a regression check. It matters
because if the admin rule had leaked to everyone, a developer could start a task with
no session and their time would log against nothing, which is the hole the workday
gate exists to close.

`0 of 54` matters: `can_start` is per row, so a gate that caught only some tasks would
still leave a live Start button somewhere on the board. And `admin with no workday can
still start` is the half of the rule that must **not** change — an admin is not logging
developer time against a session, so the absence of one cannot block them; only a pause
they opened themselves does.

## Layer 3 — `maestro test .maestro/regression/45-workday-pause.yaml` → all steps passed

| File | What it evidences |
|---|---|
| `45-01-workday-open.png` | day open and running, before any pause |
| `45-02-box-inline-and-pause-offered.png` | **fix 2** — `Presence (at work)` and `Accounted` inline beside Login and Productive; **fix 3 first half** — Pause IS offered while running |
| `45-03-paused-banner.png` | "Your workday is paused." after tapping Pause |
| `45-04-paused-blocks-start.png` | **fix 1** — "Tasks can't be started" |
| `45-05-pause-button-gone.png` | **fix 3** — the whole Pause strip absent; footer goes straight to Continue Working / Logout |
| `45-06-pause-button-back.png` | **fix 3 other half** — Pause returns after Resume |
| `46-01-dev-readonly-no-workday.png` | **the asymmetry** — a DEVELOPER with no workday is read-only: "Start your workday to work on tasks". An admin in the same state was not |
| `46-02-dev-pause-button-gone.png` | the same Pause-button removal, as a developer |
| `47-03-png-paused-tile.png` | the saved PNG with the amber paused tile actually drawn |

`45-05` is the one to look at. Five tiles on **one row** — `Login · Productive · Presence
(at work) 14m · Accounted 9m · Workday paused 9m` — with the new footnote under Presence
(`17:25–17:25 · 9m pa…`) and the corrected `outside Presence, not worked time`. The day
also reconciles on screen: Accounted 9m + Other/Idle 14m = 23m of clock, and Presence 14m
is that 23m minus the 9m pause.

## The assertNotVisible is not a false pass

Maestro **full-matches** its selector regex, so a bare substring silently never matches —
and on an `assertNotVisible` that means the check passes without testing anything. The
same regex `.*Coming back later today.*` asserts **visible** at `45-02` and again at
`45-06`, and **not visible** at `45-05`, all in one run. A selector that could not match
would have failed the two visible assertions first.

## Not covered here

- **Fix 4, the amber paused colour**, is web + PNG only. The app already used `#B45309`.
- **The per-card gate pill.** `gateLabel()` renders "Resume your workday to work on tasks"
  (`utils/taskGate.js:47`), but only on CARDS. The board opens in **list view**, whose rows
  are one-liners that navigate to KPI Details on tap, and the only route to card view is an
  icon-only toggle with no accessible text sitting at a Y that moves once the paused banner
  appears. Point-tapping it would have made the suite flaky to assert something the banner
  already states in words, and that Layer 2 proves exactly.
Both of these were open in the first pass and are now closed — see `47-*` above.

- The **web popup** was driven with Playwright (`chromium`, `sales_test`) and asserted:
  `Presence (at work)` present, `Coming back later today` **true** while running and
  **false** while paused, the `Workday paused` tile present, `#B45309` present. The board
  behind it also shows the per-card gate pill "Resume your workday to wo…", which is the
  assertion the app flow could not reach — the web board renders cards by default.
- The **PNG paused tile** now draws: pause, hold, resume banks the seconds, and ending the
  day redraws the image. Note snapshots are **one row per user per day and UPDATED in
  place**, not appended — reading "the newest id" gets whoever ended last, not you.

## Notes for next time

- **The Odoo asset minifier eats spaces at text-node boundaries**, and it is visible in
  the product. In the served `web.assets_web.min.js`:

  | source | served | renders |
  |---|---|---|
  | `outside Presence, not worked time` | `outside Presence,not worked time` | missing space after the comma |
  | `${data.standard_display} standard` | `${...}standard` | **"9hstandard"** |

  The `9h standard` one is **pre-existing** and predates this work, as is
  `Away time(inside Presence — ...`. Only the first is a label added here. Cosmetic, but
  it is in the End Workday popup where people read the day's verdict, and the fix
  (a non-breaking space, or moving the space inside the interpolation) is not something
  to do to one label while leaving the rest.
- The **idle prompt** ("Not on a task?") fires on the **web board too**, from the same
  `live_status` flag, and it is modal there as well — Escape does not close it, only its
  own snooze link does. Any browser automation against this board has to dismiss it
  before the first click, exactly as the Maestro flow does.
- The **idle prompt** ("Not on a task?") fires the moment the workday opens — `live_status`
  sets `idle_prompt` when nothing is running and no reason has been given — and it covers
  the whole screen, the End Workday modal included. It re-asks, so it can appear between
  any two steps; the flow dismisses it on sight via `snoozeIdle`, which records nothing.
  It stops once **paused**, because a paused day has already answered the question.
- The flow **leaves the day open, not ended**. Ending is one-way for the date and would
  force an admin revert (`/kpi_workday/revert`) before the flow could run again. It also
  self-normalises: if it starts on a paused day it resumes first, so it is re-runnable.
- **The script used to sabotage its own second run**, and it is worth knowing why. Its
  "clean slate" step ended any open workday so the no-workday assertion would be
  observable — but ending a day sets `day_done`, and one-start-one-end-per-day then
  refuses to reopen the date. `/kpi_workday/ping` quietly did nothing, every assertion
  after it ran against a closed day, and the one that expects Start to be *refused*
  instead **started a task and left it running** — an orphaned open `kpi.time.log`, the
  exact thing that later reads as work nobody did. It now ends *and* reverts
  (`/kpi_workday/revert`), refuses to continue rather than emit a cascade of failures
  tracing back to one unopenable day, and puts a wrongly-started task back if that
  assertion ever fails. A failing test must not also leave a mess.
- `maestro hierarchy` hung and left Maestro's on-device driver wedged on port 7001; the
  next run died with `Command failed (tcp:7001): closed`. `adb shell am force-stop
  dev.mobile.maestro` plus an `adb kill-server`/`start-server` cleared it.
- YAML **double** quotes reject `\(`, so the `Presence \(at work\)` selector has to be
  single-quoted.
