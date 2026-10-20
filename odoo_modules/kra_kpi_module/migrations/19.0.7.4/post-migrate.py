"""Flag every app PIN that is still the default 1111.

Until 19.0.7.4 the must-change flag was cleared whenever a PIN was set
through _set_app_password, even when the PIN set was 1111 itself, so those
accounts never got the red "your password is still 1111" reminder. From now
on _set_app_password keeps the flag on for 1111; this fixes the accounts
already in that state. Runs once: checking a hash is deliberately slow, so it
is not done on every login check.
"""
import logging

from odoo import SUPERUSER_ID, api

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    if not version:
        return
    env = api.Environment(cr, SUPERUSER_ID, {})
    Users = env['res.users'].with_context(active_test=False)
    users = Users.search([('kpi_app_password_hash', '!=', False),
                          ('kpi_app_must_change_password', '=', False)])
    flagged = users.filtered(lambda u: u._check_app_password('1111'))
    if flagged:
        flagged.sudo().write({'kpi_app_must_change_password': True})
    _logger.info("kra_kpi 19.0.7.4: %d app PIN(s) still 1111 flagged for change: %s",
                 len(flagged), ', '.join(flagged.mapped('login')))
