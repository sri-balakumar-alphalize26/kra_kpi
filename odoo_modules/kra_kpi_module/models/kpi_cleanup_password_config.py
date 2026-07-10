from odoo import models, fields, api
from odoo.exceptions import ValidationError
import hashlib
import logging

_logger = logging.getLogger(__name__)


class KpiCleanupPasswordConfig(models.Model):
    _name = 'kpi.cleanup.password.config'
    _description = 'Data Cleanup Password Configuration'
    _rec_name = 'id'

    password_hash = fields.Char(string='Password Hash', required=True)
    last_changed_date = fields.Datetime(string='Last Changed', readonly=True, default=fields.Datetime.now)
    last_changed_by = fields.Many2one('res.users', string='Last Changed By', readonly=True)
    
    @api.model
    def create(self, vals):
        existing = self.search([], limit=1)
        if existing:
            _logger.warning("Password config already exists, returning existing record")
            return existing
        return super(KpiCleanupPasswordConfig, self).create(vals)
    
    def _hash_password(self, password):
        """Hash password using SHA-256"""
        import hashlib
        return hashlib.sha256(password.encode()).hexdigest()
    
    def set_password(self, new_password):
        """Set new password"""
        self.ensure_one()
        if not new_password or len(new_password) < 6:
            raise ValidationError("Password must be at least 6 characters long!")
        
        self.write({
            'password_hash': self._hash_password(new_password),
            'last_changed_date': fields.Datetime.now(),
            'last_changed_by': self.env.user.id,
        })
        
        _logger.info(f"Data Cleanup password changed by {self.env.user.name}")
        return True
    
    def verify_password(self, password):
        """Verify if provided password matches"""
        self.ensure_one()
        import hashlib
        input_hash = hashlib.sha256(password.encode()).hexdigest()
        
        # Debug logging
        _logger.info(f"Verifying password...")
        _logger.info(f"Stored hash: {self.password_hash}")
        _logger.info(f"Input hash:  {input_hash}")
        _logger.info(f"Match: {self.password_hash == input_hash}")
        
        return self.password_hash == input_hash
    
    @api.model
    def get_or_create_config(self):
        """Get existing config or create with default password"""
        config = self.search([], limit=1)
        if not config:
            import hashlib
            default_hash = hashlib.sha256('admin123'.encode()).hexdigest()
            
            config = self.sudo().create({
                'password_hash': default_hash,
                'last_changed_by': self.env.user.id,
            })
            _logger.warning("Data Cleanup password config created with default password 'admin123'. Please change it!")
        return config