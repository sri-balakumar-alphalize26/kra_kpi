from odoo import models, fields, api
from odoo.exceptions import ValidationError

class KpiConfigScreen(models.Model):
    _name = "kpi.config.screen"
    _description = "KPI Config Screen"
    _rec_name = "name"

    name = fields.Char("Screen Name", required=True)
    url = fields.Char("Screen URL", required=True)
    active = fields.Boolean(default=True)

    # Update to model.Constraint instead of _sql_constraints
    @api.model
    def _check_unique_url(self):
        for record in self:
            if self.search([('url', '=', record.url), ('id', '!=', record.id)]):
                raise ValidationError("This Screen URL already exists!")

    _constraints = [
        (_check_unique_url, 'This Screen URL already exists!', ['url'])
    ]