"""Partial Complete -> client check -> Full Complete (kpi_finish.py).

* Tasks the client already signed off stay billable: they count as fully
  complete on their sign-off date.
* Tasks with the client right now get a fresh client-review window from
  today, so the upgrade does not close anything on the spot.
"""
import logging

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    if not version:
        return
    cr.execute("""
        UPDATE kra_kpi
           SET full_complete_at = COALESCE(client_signed_datetime, approval_date, completion_date, write_date),
               review_close_reason = 'client'
         WHERE task_state = 'completed' AND client_final_approved
           AND full_complete_at IS NULL
    """)
    _logger.info("kra_kpi 19.0.7.48: %d signed-off task(s) marked fully complete", cr.rowcount)
    cr.execute("""
        SELECT COALESCE(NULLIF(value, '')::int, 3) FROM ir_config_parameter
         WHERE key = 'kra_kpi.client_review_days'
    """)
    row = cr.fetchone()
    days = max(1, row[0]) if row else 3
    cr.execute("""
        UPDATE kra_kpi
           SET review_started_at = COALESCE(admin_approved_date, completion_date, now() AT TIME ZONE 'UTC'),
               review_due_at = (now() AT TIME ZONE 'UTC') + make_interval(days => %s)
         WHERE task_state = 'awaiting_client' AND review_due_at IS NULL
    """, (days,))
    _logger.info("kra_kpi 19.0.7.48: %d task(s) with the client got a %d-day review", cr.rowcount, days)
