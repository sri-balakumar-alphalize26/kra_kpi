# -*- coding: utf-8 -*-
"""Reopen tasks that were closed as 'nobody can sign this off' when somebody could.

WHY these tasks are stuck
-------------------------
`_client_approvers()` (models/kpi_workflow.py) read `client_kra_id.client_user_ids`
and never looked at the parent. But `client_kra_id` is the task's NEAREST `is_client`
ancestor and `_compute_is_client` flags BOTH level-1 and level-2, so a task in a
two-level tree resolves to the level-2 node — while whoever set the system up almost
always attached the portal user to the level-1 root.

The lookup found nobody, so `approve_task` took its "NOBODY can ever sign this off"
branch (models/kpi.py): the task closed as `completed` with `client_final_approved`
deliberately left False. The invoice domain filters on exactly that flag, so the work
was finished and permanently unbillable. In the live database that was 42 tasks across
9 clients, 20 of them for a single client.

This is the same gap `migrations/19.0.2.8/post-migrate.py` closed for the client record
rules; that release fixed the XML side and left the Python side behind. The code fix
lands with this version — this migration repairs the records it already stranded.

WHAT this does NOT do
---------------------
It never writes `client_final_approved`. Marking work as client-approved without a
client actually approving it is the precise defect this module was reported for, and
19.0.2.3 already had to reverse a batch of auto-approvals. These tasks go back to
`awaiting_client` so the real client signs them — or they stay unbilled.

`admin_approved` is deliberately kept: the admin's QA approval genuinely happened and
is not in doubt. Only `approved_by` / `approval_date`, which record the final closure,
are cleared, because the task is no longer closed.

Written against the ORM rather than raw SQL for the reason recorded in 19.0.2.8: a
previous release shipped a post-migrate that selected a column which did not exist and
aborted the upgrade mid-run.
"""
import logging

from odoo import SUPERUSER_ID, api

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    if not version:
        return
    env = api.Environment(cr, SUPERUSER_ID, {})
    Kpi = env['kra.kpi'].sudo()

    # Candidates: finished, unsigned, and closed through the no-client branch.
    stranded = Kpi.search([
        ('active', '=', True),
        ('task_state', '=', 'completed'),
        ('client_final_approved', '=', False),
    ])

    # Keep only those the fixed lookup would NOW find an approver for: no client user
    # on the task's own client KRA, but one on its parent. A task where NEITHER level
    # has a client user is correctly closed — nobody can sign it, and reopening would
    # park it in a queue waiting on a person who does not exist.
    to_reopen = stranded.filtered(
        lambda k: (k.client_kra_id or k.kra_id)
        and not (k.client_kra_id or k.kra_id).client_user_ids
        and (k.client_kra_id or k.kra_id).parent_id.client_user_ids
    )

    if not to_reopen:
        _logger.info("19.0.3.0: no stranded tasks to reopen.")
        return

    to_reopen.write({
        'task_state': 'awaiting_client',
        'approved_by': False,
        'approval_date': False,
    })

    by_client = {}
    for k in to_reopen:
        name = (k.client_kra_id or k.kra_id).name or '?'
        by_client[name] = by_client.get(name, 0) + 1

    _logger.info(
        "19.0.3.0: reopened %s task(s) for client sign-off (client_final_approved "
        "left False on all of them): %s",
        len(to_reopen),
        ', '.join(f"{n}={c}" for n, c in sorted(by_client.items(), key=lambda x: -x[1])),
    )
