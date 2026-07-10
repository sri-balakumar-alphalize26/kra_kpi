from odoo import models, fields, api
from odoo.exceptions import UserError, ValidationError


class KpiCleanupAuth(models.TransientModel):
    _name = 'kpi.cleanup.auth'
    _description = 'Data Cleanup Authentication'

    password = fields.Char(string='Enter Password', required=True, password=True)
    
    def action_authenticate(self):
        """Authenticate and redirect to Data Cleanup"""
        self.ensure_one()
        
        # Get password config
        config = self.env['kpi.cleanup.password.config'].sudo().get_or_create_config()
        
        # Verify password
        if not config.verify_password(self.password):
            raise UserError("❌ Incorrect password! Please try again.")
        
        # Password correct - redirect to Data Cleanup
        return {
            'type': 'ir.actions.act_window',
            'name': 'Data Cleanup',
            'res_model': 'kpi.data.cleanup',
            'view_mode': 'list,form',
            'target': 'current',
            'context': {'authenticated': True},
        }