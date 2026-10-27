"""No more 5-minute auto timers: approvals wait for a person.

* The admin auto-accept cron is switched off (its XML record is noupdate, so
  the file alone cannot do it on a deployed database).
* Every armed admin-accept deadline and client auto-release moment is
  cleared: nothing is accepted or released by itself any more. The client
  pre-approval cron stays on -- it still sends the reminders.
* A developer's own task still waiting for acceptance joins the approval
  chain. Only esc_due_at is set (to now, no tier yet), so the chain cron asks
  step 1 on its next tick; nothing is sent on WhatsApp from here.
"""
import logging

from odoo.tools.sql import column_exists, table_exists

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    if not version:
        return

    cr.execute("""
        UPDATE ir_cron SET active = FALSE
         WHERE active
           AND id IN (SELECT res_id FROM ir_model_data
                       WHERE module = 'kra_kpi_module'
                         AND name = 'ir_cron_kpi_admin_accept'
                         AND model = 'ir.cron')
    """)
    _logger.info("kra_kpi 19.0.8.6: admin auto-accept cron switched off (%d)", cr.rowcount)

    if column_exists(cr, 'kra_kpi', 'admin_accept_deadline_at'):
        cr.execute("UPDATE kra_kpi SET admin_accept_deadline_at = NULL "
                   "WHERE admin_accept_deadline_at IS NOT NULL")
        _logger.info("kra_kpi 19.0.8.6: %d admin accept deadline(s) cleared", cr.rowcount)
    if column_exists(cr, 'kra_kpi', 'pre_approval_release_at'):
        cr.execute("UPDATE kra_kpi SET pre_approval_release_at = NULL "
                   "WHERE pre_approval_release_at IS NOT NULL")
        _logger.info("kra_kpi 19.0.8.6: %d client auto-release moment(s) cleared", cr.rowcount)

    if not (column_exists(cr, 'kra_kpi', 'esc_due_at')
            and column_exists(cr, 'kra_kpi', 'esc_tier_id')
            and table_exists(cr, 'kpi_escalation_tier')):
        return
    cr.execute("SELECT 1 FROM kpi_escalation_tier WHERE active LIMIT 1")
    if not cr.fetchone():
        # No chain set up: the managers keep their links, as before.
        _logger.info("kra_kpi 19.0.8.6: no approval chain; pending own tasks left as they are")
        return
    cr.execute("""
        UPDATE kra_kpi
           SET esc_due_at = now() AT TIME ZONE 'UTC'
         WHERE active
           AND is_self_created
           AND COALESCE(admin_accepted, FALSE) IS NOT TRUE
           AND COALESCE(self_needs_resume_reason, FALSE) IS NOT TRUE
           AND esc_tier_id IS NULL
           AND esc_due_at IS NULL
    """)
    _logger.info("kra_kpi 19.0.8.6: %d pending own task(s) put on the approval chain", cr.rowcount)
