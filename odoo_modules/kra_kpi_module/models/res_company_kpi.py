from odoo import fields, models


class ResCompany(models.Model):
    """Global KRA/KPI settings stored on the company."""
    _inherit = 'res.company'

    away_after_minutes = fields.Integer(
        string='Away After (minutes)',
        default=5,
        help="Minutes with no heartbeat (tab closed / machine asleep) before a "
             "running task auto-pauses as 'Away'. Read by the browser and the server.")

    kpi_urgent_recipients = fields.Char(
        string='Urgent-pause recipients',
        help="Extra WhatsApp numbers (comma-separated) that receive the note when a "
             "developer taps the 🚨 Urgent button in the Pause dialog. The owner is "
             "always included in addition to these.")
