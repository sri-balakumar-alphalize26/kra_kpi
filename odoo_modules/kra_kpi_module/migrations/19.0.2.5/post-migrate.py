# -*- coding: utf-8 -*-
"""Switch off idle auto-pause and auto-close on existing databases.

19.0.2.5 removes the PIN gate and stops the system taking a developer's workday
away from them. A stale heartbeat used to mean two things:

  * _cron_auto_away paused the running task after away_after_minutes (5) and
    un-paired the device, so a closed laptop lid sent you back to a PIN screen;
  * _cron_close_idle_workdays ENDED the workday after workday_idle_close_minutes
    (15), summary and all — an hour at lunch was enough.

Neither is a safe inference. A sleeping machine is not evidence that somebody
stopped working. The developer now starts and ends their own day, and the
midnight sweep (_close_overdue) remains the only automatic close.

Why this file is needed at all — three things the module data cannot do:

  1. data/kpi_workday_cron.xml is noupdate="1", so editing `active` in the XML
     does NOT reach a database that already has the record. It must be written
     here.
  2. New field defaults only apply to NEW res.company rows. Existing companies
     keep their stored 5 / 15 and would carry on as before.
  3. Deactivating a cron without zeroing the company value (or vice versa) leaves
     a half-off feature that the next person re-enables by accident. Both, or
     neither.

This is reversible by hand: set the minutes on res.company and re-activate the
cron. The methods are still there and still work.
"""
import logging

_logger = logging.getLogger(__name__)

# xml_id -> what it did, for the log line.
_CRONS = {
    'kra_kpi_module.ir_cron_kpi_auto_away': 'auto-pause idle developers',
    'kra_kpi_module.ir_cron_kpi_close_idle_workdays': 'auto-end forgotten workdays',
}


def migrate(cr, version):
    if not version:
        return      # fresh install: the XML/field defaults already ship it off

    from odoo import api, SUPERUSER_ID
    env = api.Environment(cr, SUPERUSER_ID, {})

    # 1) Deactivate both crons. ref(raise_if_not_found=False) so a database that
    #    never had one (or where it was already removed) upgrades cleanly.
    for xml_id, what in _CRONS.items():
        cron = env.ref(xml_id, raise_if_not_found=False)
        if not cron:
            _logger.info("19.0.2.5: %s not present — nothing to deactivate", xml_id)
            continue
        if cron.active:
            cron.write({'active': False})
            _logger.info("19.0.2.5: deactivated cron %s (%s)", xml_id, what)

    # 2) Zero the company settings so the methods short-circuit even if somebody
    #    re-activates a cron without reading why it was off. Written straight
    #    through the ORM on every company, including inactive ones.
    companies = env['res.company'].sudo().with_context(active_test=False).search([])
    changed = 0
    for company in companies:
        vals = {}
        if company.away_after_minutes:
            vals['away_after_minutes'] = 0
        if company.workday_idle_close_minutes:
            vals['workday_idle_close_minutes'] = 0
        if vals:
            company.write(vals)
            changed += 1
    _logger.info("19.0.2.5: idle auto-pause/auto-close switched off on %s of %s "
                 "company record(s)", changed, len(companies))

    # 3) Clear any 'leaving' stamps left behind by the retired leave beacon.
    #    Nothing reads the column now, but leaving live-looking values in a field
    #    documented as unused is how the next reader gets misled.
    cr.execute("""
        UPDATE kpi_work_session
           SET leaving_at = NULL
         WHERE leaving_at IS NOT NULL
    """)
    if cr.rowcount:
        _logger.info("19.0.2.5: cleared %s stale leaving_at stamp(s)", cr.rowcount)
