# -*- coding: utf-8 -*-
"""Bring existing KRA/KPI data into line with the enforced approval workflow.

Before this upgrade the module let work start and be billed without the client
ever consenting:

  * `_cron_pre_approval_timeout` auto-approved a task after ~5 minutes of client
    silence, stamping "Auto-approved (no response)".
  * Tasks that timed out un-submitted were flipped to 'pre_approval_partial',
    a "prep work" state a developer could start from.
  * `start_task` had no approval gate at all.

Those fake approvals are now reversed and any work running without a genuine
client decision is paused, so the live data matches the rules the code now
enforces.  Tasks the client really did sign off are left untouched.

Every affected task is logged so the offenders can be reviewed.
"""
import logging

from odoo import SUPERUSER_ID, api, fields

_logger = logging.getLogger(__name__)

AUTO_MARK = 'Auto-approved (no response)'


def _refs(recs):
    return ', '.join((r.external_ref or r.name or str(r.id)) for r in recs) or '(none)'


def migrate(cr, version):
    if not version:
        return

    env = api.Environment(cr, SUPERUSER_ID, {})
    Kpi = env['kra.kpi'].with_context(active_test=False)

    _logger.info("=" * 72)
    _logger.info("kra_kpi_module: enforcing approval workflow on existing data")
    _logger.info("=" * 72)

    # ------------------------------------------------------------------ #
    # 1. Pre-existing tasks keep their admin acceptance.                  #
    #    The column default flipped True -> False, which only affects NEW #
    #    rows, but fill any NULLs so nothing is retroactively blocked.    #
    #    Self-created tasks still awaiting review keep admin_accepted=0.  #
    # ------------------------------------------------------------------ #
    cr.execute("UPDATE kra_kpi SET admin_accepted = TRUE WHERE admin_accepted IS NULL")
    _logger.info("1. admin_accepted backfilled on %s row(s) that were NULL", cr.rowcount)

    # ------------------------------------------------------------------ #
    # 2. Backfill the new billable flag for genuine historical sign-offs. #
    #    client_final_approved is a NEW column (all False), so without    #
    #    this every past completed task would silently become unbillable. #
    #    signed_certificate is an attachment field, so this must go       #
    #    through the ORM rather than SQL.                                 #
    # ------------------------------------------------------------------ #
    completed = Kpi.search([('task_state', '=', 'completed')])
    signed = completed.filtered(
        lambda r: bool(r.signed_certificate or r.client_signature_text)
    )
    if signed:
        signed.write({'client_final_approved': True})
    _logger.info("2. client_final_approved set on %s/%s completed task(s) with a real "
                 "client signature", len(signed), len(completed))
    unsigned = completed - signed
    if unsigned:
        _logger.warning("2b. %s completed task(s) have NO client signature and are now "
                        "NOT billable: %s", len(unsigned), _refs(unsigned))

    # ------------------------------------------------------------------ #
    # 3. Reverse the cron's fake approvals.                               #
    # ------------------------------------------------------------------ #
    faked = Kpi.search([
        ('pre_approval_decided_by_name', '=', AUTO_MARK),
        ('task_state', 'not in', ('completed', 'awaiting_client')),
    ])
    if faked:
        faked.write({
            'pre_approval_decision': False,
            'pre_approval_decided_at': False,
            'pre_approval_decided_by_name': False,
            'pre_approval_decided_by_partner_id': False,
            'pre_approval_source': False,
            'approval_token_used': False,
            'task_state': 'pre_approval_pending',
        })
    _logger.warning("3. reversed %s auto-approval(s) the client never made: %s",
                    len(faked), _refs(faked))

    # A completed/awaiting_client task built on a fake approval is NOT reset
    # (the work is done and may be signed) but it is reported.
    faked_done = Kpi.search([
        ('pre_approval_decided_by_name', '=', AUTO_MARK),
        ('task_state', 'in', ('completed', 'awaiting_client')),
    ])
    if faked_done:
        _logger.warning("3b. %s task(s) reached completion off an auto-approval — left "
                        "as-is, REVIEW THESE: %s", len(faked_done), _refs(faked_done))

    # ------------------------------------------------------------------ #
    # 4. The 'prep work' state is retired — send those back to pending.   #
    # ------------------------------------------------------------------ #
    partial = Kpi.search([('task_state', '=', 'pre_approval_partial')])
    if partial:
        partial.write({'task_state': 'pre_approval_pending'})
    _logger.warning("4. %s task(s) moved from pre_approval_partial back to "
                    "pre_approval_pending: %s", len(partial), _refs(partial))

    # ------------------------------------------------------------------ #
    # 5. Stop work running without a genuine client approval.             #
    #    Paused (not reverted) so accrued time is preserved.              #
    # ------------------------------------------------------------------ #
    running = Kpi.search([
        ('task_state', '=', 'in_progress'),
        '|', ('pre_approval_decision', '!=', 'approve'),
             ('admin_accepted', '=', False),
    ])
    for rec in running:
        # Bank the elapsed time and close the open time log, exactly as
        # pause_task would, without firing notifications mid-upgrade.
        try:
            if rec.timer_start_datetime:
                rec._add_elapsed(rec)
                env['kpi.time.log'].stop_session(rec.id, rec.user_id.id or SUPERUSER_ID)
        except Exception as exc:          # never let bookkeeping abort an upgrade
            _logger.warning("   could not close time log for task %s: %s", rec.id, exc)
        rec.write({
            'task_state': 'paused',
            'timer_start_datetime': False,
            'paused_reason': 'Paused by upgrade: started without client approval.',
            'pause_reason_code': 'awaiting_approval',
        })
    _logger.warning("5. paused %s in-progress task(s) that had no client approval: %s",
                    len(running), _refs(running))

    _logger.info("=" * 72)
    _logger.info("kra_kpi_module: workflow migration complete")
    _logger.info("=" * 72)
