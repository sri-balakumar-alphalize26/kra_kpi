# today-lane

Mobile **🕒 Today** lane, tested on tablet `R52N410F5QE` as developer **Sri Balakumar**
against live `369application`, 18 Aug 2026. First device test of the lane — it shipped in
`cee7678` verified only by jest and a parse.

The day was the ideal setup: yesterday had 8 task-days of logs, today had none, so the
midnight rollover the session doc called *"untested — it is the whole feature"* could finally
be observed.

| File | What it evidences |
|---|---|
| `01-list-today-empty-after-midnight.png` | Lane renders **first**, indigo. But **`Today 1`** when the DB had zero rows for today — the bug below |
| `02-today-holds-yesterdays-open-timer.png` | The one task: "Advertisement module and app", **paused**, yet in Today |
| `03-today-card-absurd-figure.png` | **`Today 18h 4m 51s`** at 12:12 — the proof |
| `04-AFTER-today-empty.png` | After the fix: Today lane **gone**, `Showing 28 of 28` |
| `05-workday-started.png` | Workday started; Today still correctly absent |
| `06-paused-expanded.png`, `07-row-actions.png` | Paused 10; card has **no Today row** when `today_seconds` is 0 |
| `08-resumed-today-appears.png` | Resume → **`Today 1`** + **`In Progress 1`** (same task, dual membership), Paused 10→9, **`28 of 28` unchanged** |
| `09-today-dual-membership.png` | Today holds the task with a `Live` badge |
| `10-expand-isolation.png` | **`Today 0h 2m 29s`**; the Today copy expanded while the In Progress copy stays collapsed |
| `11-pause-prompt.png`, `12-AFTER-paused-stays-in-today.png` | Paused (Break) → task **stays in Today** and returns to Paused 10. `Today 0h 4m 18s` |

## The bug this found

`today_seconds` summed closed segments with `work_date = today`, then added **every** log with
`is_active = true` — with **no date filter**. A timer left running from a previous day therefore
counted as today's work, forever.

`sribalakumar` had log 1201 on task 58, `work_date 2026-08-17`, never closed. At 12:12 on the
18th the lane showed it reading `18h 4m 51s` — literally `now(UTC) − start_time(UTC)`
(`2026-08-17 12:36` → `2026-08-18 06:42` = 18h 6m).

This defeated the feature's central claim, that the lane empties itself at midnight because
`work_date` stops matching. It stops matching for *closed* rows; the open one skipped the date
entirely — so the lane kept exactly the task nobody had touched.

Fixed in `kra_api.py` by adding `('work_date', '=', today)` to the active-log search in **both**
serializers (board route and single-task route, which must agree or a refreshed card rejoins the
lane it was just dropped from). `work_date` is stored and indexed on the row already.

## End-to-end match

After resume → pause, `kpi_time_log` row **1202**: `kpi_id 43`, `work_date 2026-08-18`,
`is_active f`, `duration_seconds 258`. The card read **`Today 0h 4m 18s`** = 258s. Database,
route and UI agree.

## Still open

- **`karthickm` log 857 is orphaned since 2026-08-12** — `is_active = true`, six days unclosed.
  The fix keeps it out of their Today lane, but the row itself is still wrong and nothing here
  closed it. `sribalakumar`'s equivalent (1201) did get closed during this session.
- Both orphans imply pause/switch or workday auto-close can leave a segment open. The 17 Aug
  notification read "Workday auto-closed — Sri Balakumar" while the timer stayed active, so
  auto-close is the likely path. Not investigated.
- Cards show "(currently working)" for paused tasks — `time_by_user.is_current` looks unrelated
  to `task_state`. Pre-existing, seen on several cards here, not chased.
