import logging

from odoo import api, fields, models
from odoo.exceptions import AccessDenied

_logger = logging.getLogger(__name__)

# XML ids of the KRA/KPI role groups (kept in one place so the compute/inverse
# and the Login Management dropdown stay in sync).
_ROLE_GROUP_XMLIDS = (
    'kra_kpi_module.group_kra_developer',
    'kra_kpi_module.group_kra_client',
    'kra_kpi_module.group_kra_admin',
    'kra_kpi_module.group_kra_owner',
)

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

    # ---- Per-person mobile country (overrides the company default) -------- #
    # A client/developer in another country (e.g. Oman +968, 8 digits) can have
    # their OWN dial code + local length instead of the single global company
    # value. Empty -> falls back to the company's KPI country
    # (res_company_kpi._kpi_mobile_cfg). Drives BOTH the app-login mobile and the
    # WhatsApp number for this person.
    kpi_mobile_country_id = fields.Many2one(
        'res.country', string='App Mobile Country',
        help="This person's phone country. Sets the dial code (e.g. +968 Oman) and "
             "the typical local length for their app-login mobile AND WhatsApp "
             "number. Empty uses the company default from the Configuration screen.")
    kpi_mobile_length = fields.Integer(
        string='App Mobile Length',
        help="Local digit count for this person's number (excluding the dial code). "
             "Auto-filled from their country (Oman 8, India 10); 0 falls back to the "
             "company default.")

    # ---- App role (User / Client / Admin) -------------------------------- #
    # A simple 3-way role selector shown in Settings -> Users, right under the
    # base "Role: User / Administrator". It just maps to the KRA/KPI groups:
    #   User  -> group_kra_developer   (gets & creates own tasks)
    #   Client-> group_kra_client      (sees only their own project data)
    #   Admin -> group_kra_owner        (full KRA/KPI access)
    # Same mapping the Login Management dropdown uses, so both stay consistent.
    kpi_role = fields.Selection(
        selection=[
            ('developer', 'User'),
            ('client', 'Client'),
            ('admin', 'Admin'),
        ],
        string='KRA / KPI Role',
        compute='_compute_kpi_role',
        inverse='_inverse_kpi_role',
        store=False,
        help="App role for KRA/KPI. User = developer (gets & creates own tasks); "
             "Client = sees only their own project data; Admin = full access.")

    @api.depends('group_ids', 'all_group_ids')
    def _compute_kpi_role(self):
        for u in self:
            if (u.has_group('base.group_system')
                    or u.has_group('kra_kpi_module.group_kra_owner')
                    or u.has_group('kra_kpi_module.group_kra_admin')):
                u.kpi_role = 'admin'
            elif u.has_group('kra_kpi_module.group_kra_client'):
                u.kpi_role = 'client'
            else:
                u.kpi_role = 'developer'

    def _inverse_kpi_role(self):
        # Collect the four role groups (skip any that don't resolve).
        role_groups = self.env['res.groups']
        for xmlid in _ROLE_GROUP_XMLIDS:
            grp = self.env.ref(xmlid, raise_if_not_found=False)
            if grp:
                role_groups |= grp
        dev = self.env.ref('kra_kpi_module.group_kra_developer', raise_if_not_found=False)
        client = self.env.ref('kra_kpi_module.group_kra_client', raise_if_not_found=False)
        owner = self.env.ref('kra_kpi_module.group_kra_owner', raise_if_not_found=False)
        target_by_role = {'developer': dev, 'client': client, 'admin': owner}
        for u in self:
            # Never re-role the base super-admin from here.
            if u.has_group('base.group_system'):
                continue
            target = target_by_role.get(u.kpi_role)
            if not target:
                continue
            # Clear all four role groups, then add the chosen one. Odoo re-adds
            # the implied groups (e.g. Owner -> Coordinator -> Developer -> user).
            cmds = [(3, g.id) for g in role_groups] + [(4, target.id)]
            u.sudo().write({'group_ids': cmds})

    # ---- Per-person mobile dial code + length ---------------------------- #
    def _kpi_user_mobile_cfg(self):
        """(dial_digits, local_length) for THIS user's mobile/WhatsApp numbers.

        Uses the person's own country (kpi_mobile_country_id) when set — so an
        Oman user routes to +968 / 8 digits while others stay +91 / 10 — and
        otherwise falls back to the company-wide KPI country default. Single
        choke point every sender/normalizer resolves the code through.
        """
        self.ensure_one()
        country = self.kpi_mobile_country_id
        if country:
            from .res_company_kpi import COUNTRY_MOBILE_LENGTH
            dial = ''.join(filter(str.isdigit, str(country.phone_code or ''))) or '91'
            length = self.kpi_mobile_length or COUNTRY_MOBILE_LENGTH.get(
                country.code, self.env.company.kpi_mobile_length or 10)
            return dial, length
        return self.env.company._kpi_mobile_cfg()

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
            # Mirror Odoo's own Security -> Change Password: the same value also
            # becomes the Odoo login password, so username + password works on the
            # connect/device-setup screen (/web/session/authenticate), not just
            # mobile + PIN on the app screen. Keeps the two credentials in sync.
            'password': raw,
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
                # Keep the Odoo login password in sync with the default PIN, so
                # username + 1111 works on the connect screen too (must-change still
                # forces a real one on first app login, which re-syncs both).
                'password': _DEFAULT_APP_PASSWORD,
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
