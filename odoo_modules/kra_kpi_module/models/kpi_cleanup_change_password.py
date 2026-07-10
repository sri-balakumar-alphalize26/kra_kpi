from odoo import models, fields, api
from odoo.exceptions import UserError, ValidationError


class KpiCleanupChangePassword(models.TransientModel):
    _name = 'kpi.cleanup.change.password'
    _description = 'Change Data Cleanup Password'

    current_password = fields.Char(string='Current Password', required=True, password=True)
    new_password = fields.Char(string='New Password', required=True, password=True)
    confirm_password = fields.Char(string='Confirm New Password', required=True, password=True)
    
    def action_change_password(self):
        """Change the cleanup password"""
        self.ensure_one()
        
        # Verify new password and confirmation match
        if self.new_password != self.confirm_password:
            raise ValidationError("❌ New password and confirmation do not match!")
        
        # Get config
        config = self.env['kpi.cleanup.password.config'].sudo().get_or_create_config()
        
        # Verify current password
        if not config.verify_password(self.current_password):
            raise UserError("❌ Current password is incorrect!")
        
        # Set new password
        config.set_password(self.new_password)
        
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': '✅ Success',
                'message': 'Data Cleanup password changed successfully!',
                'type': 'success',
                'sticky': False,
            }
        }