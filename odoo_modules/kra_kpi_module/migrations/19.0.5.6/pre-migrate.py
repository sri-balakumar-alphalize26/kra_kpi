# -*- coding: utf-8 -*-
"""kra.kpi.deliverable_type is now a Char ('module,app'), no longer a Selection.

WHY
---
A task can build more than one thing, so the field holds a comma-separated list
of codes. The column is varchar either way and every value already in it
('module', 'app', 'exe') is still valid, so no data moves.

What does break is the Selection's leftovers: one ir.model.fields.selection row
per option, each with its ir.model.data. At the end of the upgrade Odoo deletes
them as obsolete and runs their "ondelete" — which reads `field.ondelete`, an
attribute only a Selection has. On the Char that raises, and the whole upgrade
fails with "'Char' object has no attribute 'ondelete'".

WHAT this does
--------------
Deletes those rows and their xml ids before the module loads, so there is
nothing left to clean up. Task values are untouched.
"""

import logging

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    if not version:
        return
    cr.execute("""
        DELETE FROM ir_model_data
         WHERE module = 'kra_kpi_module'
           AND model = 'ir.model.fields.selection'
           AND name LIKE 'selection__kra_kpi__deliverable_type__%%'
    """)
    xmlids = cr.rowcount
    cr.execute("""
        DELETE FROM ir_model_fields_selection
         WHERE field_id IN (SELECT id FROM ir_model_fields
                             WHERE model = 'kra.kpi' AND name = 'deliverable_type')
    """)
    _logger.info("deliverable_type is now a Char: removed %s selection option(s), %s xml id(s)",
                 cr.rowcount, xmlids)
