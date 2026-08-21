# workday-pause

First end-to-end test of the three app-visible fixes in `dd6bd06`, on tablet
`R52N410F5QE` (SM_T510, Expo Go over Metro) as **Mitchell Admin**, 21 Aug 2026.

Run against **`sales_test`**, not the live database — deliberately. The flow starts,
pauses, resumes and reopens a workday, and it has to run **as an admin**: the bug was that
`_actor_workday_open()` opened with `if _user_is_kpi_admin(): return True`, skipping the
`is_paused` check entirely. A developer was always blocked correctly, so running this as
one would have passed without testing anything.

`sales_test` was upgraded `19.0.4.2 → 19.0.4.4` first. Confirmed on the stored
`latest_version`, not `installed_version` — the latter is a compute that reads the
manifest off disk and reports the new number before any upgrade has run.

Two layers, because they prove different halves:

| Layer | What it proves |
|---|---|
| `scripts/e2e-workday-pause.mjs` | the RULE — `can_start`, the refusal, the arithmetic |
| `.maestro/regression/45-workday-pause.yaml` | the SCREEN — what a person actually sees |

## Layer 2 — `node scripts/e2e-workday-pause.mjs` → **16/16**

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
- **The developer branch on a device.** `apitest_dev` only exercises the path that already
  worked; Layer 2 covers it far more cheaply.

## Notes for next time

- The **idle prompt** ("Not on a task?") fires the moment the workday opens — `live_status`
  sets `idle_prompt` when nothing is running and no reason has been given — and it covers
  the whole screen, the End Workday modal included. It re-asks, so it can appear between
  any two steps; the flow dismisses it on sight via `snoozeIdle`, which records nothing.
  It stops once **paused**, because a paused day has already answered the question.
- The flow **leaves the day open, not ended**. Ending is one-way for the date and would
  force an admin revert (`/kpi_workday/revert`) before the flow could run again. It also
  self-normalises: if it starts on a paused day it resumes first, so it is re-runnable.
- `maestro hierarchy` hung and left Maestro's on-device driver wedged on port 7001; the
  next run died with `Command failed (tcp:7001): closed`. `adb shell am force-stop
  dev.mobile.maestro` plus an `adb kill-server`/`start-server` cleared it.
- YAML **double** quotes reject `\(`, so the `Presence \(at work\)` selector has to be
  single-quoted.
