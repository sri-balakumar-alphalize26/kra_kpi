"""kpi.app.otp — one-time codes for mobile-app password reset / onboarding.

The system SENDS a short code to the user's WhatsApp; the user types it into the
app to set a new password. Outbound-only (no WhatsApp reply needed). Codes are
short-lived, single-use, and — because /kpi_app/otp/verify is a PUBLIC route —
bounded in how many wrong guesses they survive and how often they can be issued.

WHY THE LIMITS. A 4-digit code that lives 5 minutes and could be guessed without
limit was 10,000 requests away from anybody's account: sweep them all inside the
window and the route set a new password AND logged the caller in. The digit
count is deliberately unchanged (the app's code box and the WhatsApp message
stay exactly as they are); the attempts cap is what closes the hole — five wrong
guesses burn the code, so a sweep needs two thousand fresh codes, and the
request throttle allows three per quarter hour.
"""

import hmac
import secrets
from datetime import timedelta

from odoo import api, fields, models

_OTP_TTL_MINUTES = 5
_OTP_DIGITS = 4
# Wrong guesses a single code survives before it is burned.
_OTP_MAX_ATTEMPTS = 5
# Codes one user may be issued inside _OTP_REQUEST_WINDOW_MINUTES.
_OTP_MAX_REQUESTS = 3
_OTP_REQUEST_WINDOW_MINUTES = 15


class KpiAppOtp(models.Model):
    _name = 'kpi.app.otp'
    _description = 'Mobile-App Password OTP'
    _order = 'create_date desc, id desc'

    user_id = fields.Many2one('res.users', string='User', required=True, index=True, ondelete='cascade')
    code = fields.Char(string='Code', required=True, index=True)
    expires_at = fields.Datetime(string='Expires At')
    used = fields.Boolean(string='Used', default=False)
    attempts = fields.Integer(string='Wrong Attempts', default=0)

    @api.model
    def ttl_minutes(self):
        return _OTP_TTL_MINUTES

    @api.model
    def can_issue(self, user):
        """False while the user has already had their share of codes recently."""
        since = fields.Datetime.now() - timedelta(minutes=_OTP_REQUEST_WINDOW_MINUTES)
        recent = self.sudo().search_count([
            ('user_id', '=', user.id),
            ('create_date', '>=', since),
        ])
        return recent < _OTP_MAX_REQUESTS

    @api.model
    def issue(self, user):
        """Invalidate any prior codes for the user and create a fresh one.
        Returns the code (caller sends it via WhatsApp — never expose it via API),
        or None when the user is over the request throttle."""
        if not self.can_issue(user):
            return None
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
        """True if `code` is the user's live (unused, unexpired) code. Marks it
        used on success (single-use). A wrong guess counts against the live code;
        after _OTP_MAX_ATTEMPTS it is burned and a fresh one must be requested."""
        code = (code or '').strip()
        live = self.sudo().search([
            ('user_id', '=', user.id),
            ('used', '=', False),
            ('expires_at', '>=', fields.Datetime.now()),
        ], order='id desc', limit=1)
        if not live:
            return False
        # Constant-time: the comparison must not leak how many digits matched.
        if code and hmac.compare_digest(live.code.encode(), code.encode()):
            live.used = True
            return True
        live.attempts = (live.attempts or 0) + 1
        if live.attempts >= _OTP_MAX_ATTEMPTS:
            live.used = True
        return False
