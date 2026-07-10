from odoo import models, fields

class KpiWarehouse(models.Model):
    _name = "kra.warehouse"
    _description = "KPI Warehouse"

    name = fields.Char(string="Warehouse Name", required=True)
    phone = fields.Char(string="Phone Number")
    transaction_number = fields.Char(string="Transaction Number")
    address = fields.Text(string="Address")
    company = fields.Char(string="Company")