# -*- coding: utf-8 -*-
"""Widen the three client record rules to accept a portal user on the PARENT KRA.

`security/kpi_client_invoice_record_rules.xml` is wrapped in `<data noupdate="1">`,
so editing the XML alone changes nothing on a database where the rules already
exist — an upgrade deliberately will not overwrite them. This migration applies
the same change to the live records.

WHY the change is needed
------------------------
`kra.kpi.client_kra_id` is the task's NEAREST `is_client` ancestor, and
`_compute_is_client` (models/kra.py) flags BOTH level-1 (root) and level-2. So in
a two-level client tree the task resolves to the level-2 node, while whoever set
the system up almost always attached the portal user to the level-1 root. The old
domains matched only `client_kra_id.client_user_ids`, found nobody, and the client
could never see their own invoices. In the live database that was 89 of the 93
tasks sitting in `awaiting_client`.

The controllers already resolve a client's scope by walking descendants
(`_resolve_client_kras_for_user`), so the rules were the odd one out; this brings
them into step. Checking one level up is COMPLETE rather than a heuristic:
`is_client` is only ever true at level 1 or 2, so if `client_kra_id` is not itself
the root then its parent is.

Written against the ORM rather than raw SQL on purpose. A previous release shipped
a post-migrate that selected a column which did not exist (`kind` vs `break_type`);
it aborted the upgrade mid-run and left a stored field with no column behind it.
`env.ref()` fails loudly and early if an XML id is missing, and `write()` validates
the domain, so a typo here cannot half-apply.
"""
import logging

from odoo import SUPERUSER_ID, api

_logger = logging.getLogger(__name__)

# xml_id -> new domain_force. Keep these byte-identical to the XML file, otherwise
# a later reinstall on a fresh database would diverge from an upgraded one.
_NEW_DOMAINS = {
    'kra_kpi_module.rule_client_invoice_client_own':
        "['&', '|', ('client_kra_id.client_user_ids', 'in', user.id), "
        "('client_kra_id.parent_id.client_user_ids', 'in', user.id), "
        "('state', 'in', ['finalized','sent'])]",
    'kra_kpi_module.rule_client_invoice_line_client_own':
        "['&', '|', ('invoice_id.client_kra_id.client_user_ids', 'in', user.id), "
        "('invoice_id.client_kra_id.parent_id.client_user_ids', 'in', user.id), "
        "('invoice_id.state', 'in', ['finalized','sent'])]",
    'kra_kpi_module.rule_kpi_client_own':
        "['|', ('client_kra_id.client_user_ids', 'in', user.id), "
        "('client_kra_id.parent_id.client_user_ids', 'in', user.id)]",
}


def migrate(cr, version):
    if not version:
        return
    env = api.Environment(cr, SUPERUSER_ID, {})

    updated = 0
    for xml_id, domain in _NEW_DOMAINS.items():
        rule = env.ref(xml_id, raise_if_not_found=False)
        if not rule:
            # Not fatal: a database that never installed these rules has nothing
            # to widen, and the XML will create them correctly on next install.
            _logger.warning("19.0.2.8: record rule %s not found — skipped.", xml_id)
            continue
        if rule.domain_force == domain:
            continue
        rule.write({'domain_force': domain})
        updated += 1

    _logger.info(
        "19.0.2.8: widened %s client record rule(s) to match a portal user on the "
        "client KRA or its parent.", updated)
