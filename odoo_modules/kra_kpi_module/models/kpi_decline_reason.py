"""Standard reasons an admin declines or re-types a client submission.

A MODEL, not a Selection, on purpose: these are the admin's business
vocabulary and they change as the business does. A Selection means adding
"Not a bug -- billable customisation" is a module upgrade; a model means it is
a row. `kpi.checklist.master` / `kpi.guideline.master` set exactly this
precedent in this codebase.

`target_doc_type` is what makes the list useful rather than decorative:
choosing "Not a bug; this is a paid change" pre-selects Update on the decline
form, so the reason and the re-typing are one decision instead of two.
"""

from odoo import api, fields, models

# Keep in step with REF_PREFIX_FOR_DOC_TYPE in kpi_workflow.py. There is no
# doc_type column on kra.kpi -- type lives in the external_ref prefix and the
# name prefix -- so this is a chooser, not a stored classification.
DOC_TYPES = [
    ('requirement', 'Requirement'),
    ('update', 'Update'),
    ('bug', 'Bug'),
]


class KpiDeclineReason(models.Model):
    _name = 'kpi.decline.reason'
    _description = 'Decline / Reclassify Reason'
    _order = 'sequence, name'

    name = fields.Char(
        string='Reason', required=True,
        help="What the admin sees in the picker, e.g. "
             "'Not a bug; this is a paid change'.")
    code = fields.Char(
        string='Code',
        help='Stable key for reporting. Safe to leave empty.')
    mode = fields.Selection([
        ('decline', 'Decline only'),
        ('reclassify', 'Reclassify only'),
        ('both', 'Both'),
    ], default='both', required=True, string='Use For')
    target_doc_type = fields.Selection(
        DOC_TYPES, string='Re-type As',
        help="When this reason is chosen for a RECLASSIFY, pre-select this "
             "type. Leave empty for reasons that are not about typing.")
    client_message = fields.Text(
        string='Message To Client',
        help="What the client is told, if it should differ from the internal "
             "wording above. Empty means send the reason as written.")
    sequence = fields.Integer(default=10)
    active = fields.Boolean(default=True)

    _sql_constraints = [
        ('name_uniq', 'unique(name)', 'That reason already exists.'),
    ]

    def text_for_client(self):
        """The wording to send. Internal label unless an override is set."""
        self.ensure_one()
        return (self.client_message or self.name or '').strip()

    @api.model
    def options_for(self, mode):
        """Reasons offered for 'decline' or 'reclassify', newest rules first."""
        domain = ['|', ('mode', '=', 'both'), ('mode', '=', mode)]
        return [{
            'id': r.id,
            'name': r.name,
            'target_doc_type': r.target_doc_type or '',
        } for r in self.sudo().search(domain)]
