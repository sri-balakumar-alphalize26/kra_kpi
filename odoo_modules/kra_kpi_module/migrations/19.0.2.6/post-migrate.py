# -*- coding: utf-8 -*-
"""Repair break rows whose end_time predates their start_time.

A break log with a negative duration is not a display glitch. `duration_seconds`
is stored, and it is summed into the day's metered time, which feeds Accounted
and the presence residual (`other_idle = presence - productive - metered -
paused`). One inverted row therefore makes time appear out of nowhere in totals
that are supposed to reconcile to the clock — and it does so silently, on a
screen whose whole purpose is to be checkable against a wristwatch.

`stop_break()` has guarded its own path since the pause-workday fix (it clamps a
caller's `at` to the break's start), and `_compute_duration` now floors the value
at zero as well. Neither helps rows already on disk: `duration_seconds` is
`store=True`, so a bad value written before those guards existed stays written
until something recomputes it. This does that recompute.

DELIBERATELY NOT A BULK FIX. A negative duration is unambiguously invalid, so
repairing a couple of rows is safe. A large number of them would mean something
is actively producing them, and quietly rewriting the evidence would destroy the
only trace of the real bug. So: always log what was found; repair only if the
count is small, and otherwise report and stop.
"""
import logging

_logger = logging.getLogger(__name__)

# Above this many bad rows, assume a live cause rather than historical debris
# and leave the data alone for a human to look at.
_REPAIR_LIMIT = 5


def migrate(cr, version):
    if not version:
        return      # fresh install: no history to repair

    # break_type, NOT kind. Raw SQL gets no ORM validation, so a wrong column
    # name here is not caught until the upgrade is already running — and it takes
    # the whole upgrade down with the schema part-changed. Verified against
    # information_schema: this table has break_type.
    cr.execute("""
        SELECT id, user_id, break_type, start_time, end_time, duration_seconds
          FROM kpi_break_log
         WHERE duration_seconds < 0
            OR (end_time IS NOT NULL AND end_time < start_time)
         ORDER BY id
    """)
    rows = cr.fetchall()
    if not rows:
        _logger.info("19.0.2.6: no break rows with an inverted time pair — nothing to repair")
        return

    for r in rows:
        _logger.warning(
            "19.0.2.6: inverted break row id=%s user_id=%s break_type=%s "
            "start=%s end=%s duration=%ss", r[0], r[1], r[2], r[3], r[4], r[5])

    if len(rows) > _REPAIR_LIMIT:
        _logger.error(
            "19.0.2.6: %s break rows have inverted time pairs — more than the %s "
            "expected as historical debris. NOT repairing: this many suggests "
            "something is still writing them, and the rows are the evidence. "
            "Investigate the write path, then repair deliberately.",
            len(rows), _REPAIR_LIMIT)
        return

    # Collapse the interval to zero length rather than inventing an end: we know
    # the pair is wrong but not which side of it, and start_time is the one the
    # developer's own action produced. This is exactly what stop_break() does
    # when it catches a stale `at`.
    cr.execute("""
        UPDATE kpi_break_log
           SET end_time = start_time,
               duration_seconds = 0.0
         WHERE duration_seconds < 0
            OR (end_time IS NOT NULL AND end_time < start_time)
    """)
    _logger.info(
        "19.0.2.6: repaired %s inverted break row(s) — end_time set to start_time, "
        "duration zeroed. Totals built on these rows will now reconcile.",
        cr.rowcount)
