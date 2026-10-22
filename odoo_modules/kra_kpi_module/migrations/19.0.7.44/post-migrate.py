"""Work-started messages only for work that starts from now on.

19.0.7.44 tells the client's group the first time a developer starts their
request (kpi_client_updates.py). Tasks that were already started before the
upgrade are marked as told, so a later restart does not announce old work.
"""
import logging

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    if not version:
        return
    cr.execute("""
        UPDATE kra_kpi SET client_started_told_at = now() AT TIME ZONE 'UTC'
         WHERE client_started_told_at IS NULL
           AND (task_state NOT IN ('assigned', 'queue_waiting', 'pre_approval_pending',
                                   'pre_approval_approved', 'pre_approval_partial', 'rework')
                OR EXISTS (SELECT 1 FROM kpi_time_log l WHERE l.kpi_id = kra_kpi.id))
    """)
    _logger.info("kra_kpi 19.0.7.44: %d started task(s) marked as already told", cr.rowcount)
