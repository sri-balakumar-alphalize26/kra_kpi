"""WhatsApp number = login mobile, for everybody already in the database.

From 19.0.7.11 res.users keeps kpi_wa_number equal to the login mobile (with
the person's dial code) on every change. This lines up the existing rows,
which had drifted: a WhatsApp number that was somebody else's login number,
and people with a login mobile but no WhatsApp number.
"""
import logging

from odoo import SUPERUSER_ID, api

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    if not version:
        return
    env = api.Environment(cr, SUPERUSER_ID, {})
    users = env['res.users'].with_context(active_test=False).search(
        ['|', ('kpi_mobile_number', '!=', False), ('kpi_wa_number', '!=', False)])
    before = {u.id: u.kpi_wa_number or '' for u in users}
    users._kpi_sync_wa_number()
    changed = [u for u in users if (u.kpi_wa_number or '') != before[u.id]]
    _logger.info("kra_kpi 19.0.7.11: WhatsApp number aligned to login mobile for %d user(s): %s",
                 len(changed), ', '.join('%s %s->%s' % (u.login, before[u.id] or '-', u.kpi_wa_number or '-')
                                         for u in changed))
