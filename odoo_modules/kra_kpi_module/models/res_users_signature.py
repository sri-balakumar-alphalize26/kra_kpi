from odoo import fields, models


class ResUsers(models.Model):
    """Store a saved signature image per user (client portal users especially).
    When approving a task in the Completions screen the saved image is auto-loaded
    instead of asking the user to type their name every time."""
    _inherit = 'res.users'

    kpi_signature_image = fields.Binary(
        string='KPI Signature Image',
        attachment=True,
        help='Saved signature image used to auto-fill the Completion sign-off form.'
    )
    kpi_signature_image_name = fields.Char(string='Signature Filename')

    kpi_allow_multitask = fields.Boolean(
        string='Allow multiple concurrent in-progress tasks',
        default=False,
        help="When ON, this developer may have more than one task In Progress at the same time. "
             "Default OFF keeps one active timer per developer.")

    kpi_wa_number = fields.Char(
        string='KPI WhatsApp number',
        help="This developer's WhatsApp number, used to identify them in Urgent-pause / "
             "auto-away messages. Falls back to the linked partner's phone if empty.")
