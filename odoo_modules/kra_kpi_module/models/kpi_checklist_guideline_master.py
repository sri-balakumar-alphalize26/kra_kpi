from odoo import models, fields, api

class KpiChecklistMaster(models.Model):
    _name = 'kpi.checklist.master'
    _description = 'KPI Checklist Master'
    _order = 'sequence, name'

    name = fields.Char(string='Checklist Item', required=True)
    sequence = fields.Integer(string='Sequence', default=10)
    active = fields.Boolean(string='Active', default=True)
    
    _sql_constraints = [
        ('name_unique', 'unique(name)', 'This checklist item already exists!')
    ]


class KpiGuidelineMaster(models.Model):
    _name = 'kpi.guideline.master'
    _description = 'KPI Guideline Master'
    _order = 'sequence, name'

    name = fields.Char(string='Guideline Item', required=True)
    sequence = fields.Integer(string='Sequence', default=10)
    active = fields.Boolean(string='Active', default=True)
    
    _sql_constraints = [
        ('name_unique', 'unique(name)', 'This guideline item already exists!')
    ]