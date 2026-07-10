from . import models
from . import controllers


def _post_init_client_invoice(env):
    """Backfill computed fields on module install/upgrade.

    `is_client`, `client_quoted`, and KPI `client_kra_id` are computed-stored fields. Odoo only
    auto-recomputes them when one of their dependency fields changes. Existing rows from before
    this upgrade need an explicit one-time recompute.
    """
    Kra = env['kra.master']
    rows = Kra.search([])
    level2 = rows.filtered(lambda k: k.parent_id and not k.parent_id.parent_id)
    if level2:
        level2._compute_is_client()
    rows._compute_client_quoted()
    env['kra.kpi'].search([])._compute_client_kra()
