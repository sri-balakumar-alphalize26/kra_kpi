import logging

from odoo import fields, models
from odoo.exceptions import AccessDenied

_logger = logging.getLogger(__name__)

# Default first-time app password (admin can override per user).
_DEFAULT_APP_PASSWORD = '1111'


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

    # ---- Mobile-app login ("Login Management (Non-odoo)") ---------------- #
    kpi_mobile_number = fields.Char(
        string='App Login Mobile', index=True,
        help="Mobile number this user logs into the mobile app with (app-only "
             "credential, separate from Odoo login).")
    kpi_app_password_hash = fields.Char(
        string='App Password (hashed)', copy=False,
        help="Hashed mobile-app password. Never stored or shown in plain text.")
    kpi_app_login_enabled = fields.Boolean(
        string='App Login Enabled', default=True,
        help="When OFF, this user cannot log in — neither by mobile#+password NOR "
             "by Odoo username+password (hard cut-off).")
    kpi_app_must_change_password = fields.Boolean(
        string='Must Change App Password', default=True,
        help="Force the user to set their own password on next login.")
    kpi_last_app_login = fields.Datetime(string='Last App Login', copy=False)
    kpi_last_device = fields.Char(string='Last Device', copy=False)

    # ---- Password hashing (reuses Odoo's own passlib crypt context) ------ #
    def _set_app_password(self, raw):
        """Hash + store the app password; clears the must-change flag."""
        self.ensure_one()
        raw = (raw or '').strip()
        if not raw:
            return
        hashed = self._crypt_context().hash(raw)
        self.sudo().write({
            'kpi_app_password_hash': hashed,
            'kpi_app_must_change_password': False,
        })

    def _check_app_password(self, raw):
        """Return True if `raw` matches the stored app-password hash."""
        self.ensure_one()
        if not self.kpi_app_password_hash or not raw:
            return False
        try:
            return bool(self._crypt_context().verify(raw, self.kpi_app_password_hash))
        except Exception:
            return False

    def _app_login_state(self):
        """State for the mobile-first login UX: disabled | needs_setup | ready."""
        self.ensure_one()
        if not self.kpi_app_login_enabled:
            return 'disabled'
        if not self.kpi_app_password_hash or self.kpi_app_must_change_password:
            return 'needs_setup'
        return 'ready'

    def _seed_default_app_password(self):
        """Give the user the default password + force-change flag (admin onboard/reset)."""
        for u in self:
            u.sudo().write({
                'kpi_app_password_hash': u._crypt_context().hash(_DEFAULT_APP_PASSWORD),
                'kpi_app_must_change_password': True,
            })

    # ---- Hard cut-off: block disabled app users at the Odoo login layer -- #
    def _check_credentials(self, credential, env):
        auth_info = super()._check_credentials(credential, env)
        # Only affects users who are app users (have a mobile#) AND are disabled.
        # Admins / users without a mobile# are never impacted → no lockout risk.
        try:
            uid = auth_info.get('uid') if isinstance(auth_info, dict) else auth_info
            user = self.env['res.users'].sudo().browse(uid) if uid else self.sudo()
            if user and user.kpi_mobile_number and not user.kpi_app_login_enabled:
                _logger.info("login blocked: user %s app-login disabled", user.id)
                raise AccessDenied()
        except AccessDenied:
            raise
        except Exception:
            pass  # never break core auth on our own check
        return auth_info
