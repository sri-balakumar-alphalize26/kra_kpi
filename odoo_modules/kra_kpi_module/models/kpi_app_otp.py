"""kpi.app.otp — one-time codes for mobile-app password reset / onboarding.

The system SENDS a short code to the user's WhatsApp; the user types it into the
app to set a new password. Outbound-only (no WhatsApp reply needed). Codes are
short-lived and single-use.
"""

import secrets
from datetime import timedelta

from odoo import api, fields, models

_OTP_TTL_MINUTES = 5
_OTP_DIGITS = 4


class KpiAppOtp(models.Model):
    _name = 'kpi.app.otp'
    _description = 'Mobile-App Password OTP'
    _order = 'create_date desc, id desc'

    user_id = fields.Many2one('res.users', string='User', required=True, index=True, ondelete='cascade')
    code = fields.Char(string='Code', required=True, index=True)
    expires_at = fields.Datetime(string='Expires At')
    used = fields.Boolean(string='Used', default=False)

    @api.model
    def ttl_minutes(self):
        return _OTP_TTL_MINUTES

    @api.model
    def issue(self, user):
        """Invalidate any prior codes for the user and create a fresh one.
        Returns the code (caller sends it via WhatsApp — never expose it via API)."""
        self.sudo().search([('user_id', '=', user.id), ('used', '=', False)]).write({'used': True})
        code = str(secrets.randbelow(10 ** _OTP_DIGITS)).zfill(_OTP_DIGITS)
        self.sudo().create({
            'user_id': user.id,
            'code': code,
            'expires_at': fields.Datetime.now() + timedelta(minutes=_OTP_TTL_MINUTES),
        })
        return code

    @api.model
    def verify(self, user, code):
        """True if `code` is a valid, unused, non-expired code for `user`.
        Marks it used on success (single-use)."""
        code = (code or '').strip()
        if not code:
            return False
        rec = self.sudo().search([
            ('user_id', '=', user.id),
            ('code', '=', code),
            ('used', '=', False),
            ('expires_at', '>=', fields.Datetime.now()),
        ], limit=1)
        if not rec:
            return False
        rec.used = True
        return True
