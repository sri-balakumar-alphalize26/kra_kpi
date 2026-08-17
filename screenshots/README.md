# Screenshots — 17 Aug 2026

Captured on the real tablet (`R52N410F5QE`, Samsung SM-T510, Android 11) running the
app through Expo Go + Metro against the **live `369application` database**, while bringing
the app up to the Odoo module. Not mockups — every figure in them is real data.

Files are named for what they show, and `-BEFORE` / `-AFTER` marks the two sides of a fix.

---

## client-invoices

Commit `0d46e00`.

| File | What it evidences |
|---|---|
| `01-list-before.png` | The list before any change — chips `All 165 · Draft 111 · … · Paid 7` |
| `02-new-invoice-form.png` | Create form. Note `Per Hour Rate (0 = time-only)` |
| `03-client-picker-identical-rows-BEFORE.png` | **The bug**: 14+ consecutive rows all reading `[APITEST] Client Co`, nothing to tell them apart |
| `04-nothing-ready-to-bill.png` | `Nothing is ready to bill for this client yet — all 4 task(s) are listed below with the reason.` |
| `05-hidden-tasks-with-reasons.png` | The `14a4d32` fix proven: one blue `paused`, three grey `already invoiced` — **none amber**, because none is actually with the client |
| `06-collapses-on-client-change.png` | Switching client collapses the hidden list and repopulates the filters |
| `07-payment-claimed-chip-AFTER.png` | New `Payment Claimed 1` chip; `DUE` now red so amber can mean claimed |
| `08-claimed-filter-finds-one.png` | It finds `INV/2026/0171` — an invoice **no payment filter could previously reach** |
| `09-claim-lock-revise-hidden.png` | `Payment claimed` badge, `Confirm payment` / `Not received`, and Revise/Reset replaced by the lock note |
| `10-revert-requires-reason.png` | `Revert INV/2026/0288 to Due` with `Reason *` and `The client is shown this on their invoice.` |
| `11-a-reason-is-required.png` | The guard firing — `Paid 7` unchanged, no server call |
| `12-paid-record-banner.png` | `Paid by Cheque … — recorded by Administrator` plus the internal note `cleared`, which had no reader anywhere before |
| `13`–`15` | Delete Draft, its confirm, and `INV/2026/0292 deleted. 0 task(s) are free to bill again.` |

## paid-work

`01-populated.png` — cards with `Spent` / `Estimated` / `Amount`, `INV/… · confirmed …`, and
`Client said they paid on …` present only where a claim exists.
`02-end-of-list.png` — 7 paid tasks, so the 200-row truncation bar cannot be exercised on this data.

## kpi-action-board

Commits `f107673`, `4ae1ffd`.

| File | What it evidences |
|---|---|
| `01-list-view-639-tasks.png` | `Showing 639 of 639 tasks` — the scale the perf work was about |
| `02-regular-lane-expanded.png` | Virtualised list, lane expands on tap |
| `03-reassign-clipped-BEFORE.png` | **The bug**: `Reassig` cut mid-word, gradient stopping short |
| `04-add-time-and-gradients.png` | `Add time` (purple) on a task with `Estimate 00:00`; **Partial Finish teal**, no longer sharing Delete's red |
| `05-lanes-closed-on-arrival-AFTER.png` | Seven headings and nothing mounted — the fast-load behaviour |
| `06-buttons-full-width-AFTER.png` | Start / Reassign / Delete filling completely |
| `07-appdialog-cant-start.png` | `AppDialog` replacing the OS alert |
| `08-new-task-inline-validation.png` | New Task already validated inline, which is why two converted alerts were unreachable |

## estimate-and-activity

Commits `684420f`, `d7738e6`.

`01-estimate-chain-and-activity-popup.png` — the headline result:

```
Estimate                                    05:30
00:00 — original
+02:00 → 02:00 · "Need extra time" — Administrator, 2026-08-14 13:43:18
+01:00 → 03:00 · "h"               — Administrator, 2026-08-14 14:26:08
+02:30 → 05:30 · "Extra needed"    — Administrator, 2026-08-17 14:58:45
```

with **Activity (4)** open on `2026-08-17`. Took two goes: deploying the controller was
necessary but not sufficient, because `fetchTaskDetails` allow-lists the response and was
discarding both new keys.

## end-workday

`01-note-blocked-logout-BEFORE.png` — **the bug behind "logout not working"**. The note box
holds the single word `Finished`, and below it in red:
`Please write a few words about what you did today, or leave it empty.`
A box labelled `(optional)` was compulsory the moment anything went into it, and the refusal
rendered far above the button that had been pressed. Fixed in `7d6005b` — nothing blocks now.

## workday-snapshots

Commit `a48406b`.

`01-range-pills-with-1-year.png` — the new `Last 1 year` pill (16 days · 79 snapshots).
`02-reopened-workday-block-AFTER.png` — `REOPENED WORKDAY — by Administrator`,
`on 2026-08-13 13:03:00`, reason `g`.

> **Not pictured: the End-of-day note block.** No snapshot in the database has a note — checked
> directly. It is built and unproven, and will appear the first time someone ends a workday
> with one.

## live-tracking

`01-network-error-blanked-board-BEFORE.png` — every count at zero with a
`network/http error` toast. `error` was set from the catch whether the call was a background
poll or not, and the render checks `error` before `rows`, so one flaky 15-second poll replaced
a full board with a Retry screen. Fixed in `7d6005b`.

## task-documents

`01-loading.png` — the screen mid-load. The substantive changes in `aae316e` (four corrected
field names, working file opening, the assignee filter) were confirmed in use rather than
captured here.
