# workday-snapshot

The saved End Workday image (`kpi.workday.snapshot`), 17 Oct 2026, on the live
`369application` database. Two changes:

1. **Saved / Reopened times in IST on every client.** `generated_at` and
   `reopened_at` are UTC. Odoo and the phone printed them verbatim, and the web
   app formatted them with the browser's clock. The list routes now also send
   `generated_at_display` / `reopened_at_display` (`17 Oct 2026, 01:10 AM IST`,
   in the viewer's tz, defaulting to IST), and all three print that string.
2. **The image's Workday Map in the End Workday popup's new look.** It's drawn by
   `_wt_build()` in `models/kpi_workday_snapshot.py`, a Python copy of
   `buildWorkdayTimeline` (`utils/workdayTimeline.js` and
   `kpi_workday_timeline/workday_timeline.js`). Change all three together.

| File | What it shows |
|---|---|
| `01-BEFORE-saved-time-in-utc.png` | the report: "Saved 2026-10-16 19:40:58", which is UTC for a 01:10 IST save |
| `02-BEFORE-old-map-16-oct.png` | the old map: one plain row per node, no scale, no transitions |
| `03-AFTER-new-map-16-oct.png` | **the same day redrawn**: same figures, new map with a to-scale bar, hour ticks, legend, rail, card, Reassigned pill and "Went on away" |
| `04-AFTER-visits-and-reassigned.png` | a task picked up six times: "2nd … 6th time today" and "Picked … up again" |
| `05-AFTER-busy-day-idle-hatching.png` | a 180-entry test day: hatched idle gaps on the bar, Completed / Switched pills |
| `06-AFTER-empty-day.png` | no tasks or breaks: "No activity recorded on this day." |

`02` and `03` are the before/after pair. Every tile is identical, and only the map
changed.

## Existing snapshots were redrawn

All 94 rows (25 Jul – 17 Oct 2026) were redrawn in the new look. The old PNGs are
backed up outside the repo in `C:\Projects\APK's\KRA_KPI_snapshot_backup_2026-10-17`,
one file per row as `<id>_<image_name>`.

- The **headline figures stay frozen**. Presence, Productive, Paused, standard
  hours, met_standard and task count come from the snapshot row, not from today's
  data. Only the map and task list are rebuilt from the session.
- **Only `image` was written.** `generated_at`, `note`, the reopen fields and the
  row id are untouched, so notification links still open the same record.

## Notes for next time

- `_clean()` strips U+2190–21FF and U+2300–27BF, which takes out → ↓ and ●
  as well as emoji. The map uses an en dash for ranges, draws the down chevron and
  the live ring as shapes, and says "Break to Lunch", not "Break → Lunch".
- `_clean()` also collapses repeated spaces, so a gap like `"  ·  57m"` comes out
  as `"· 57m"`. Leave gaps as pixel offsets, not spaces.
- The canvas is 8000px, up from 4000. A day that still won't fit ends the map with
  "… and N more entries", keeping room for the full task list. It doesn't cut off
  mid-card.
- `odoo-bin shell` runs the script, commits, then doesn't exit. Its output only
  appears on exit, so check the attachments' `write_date` (UTC, so compare against
  `now() at time zone 'UTC'`) rather than waiting for the print.
