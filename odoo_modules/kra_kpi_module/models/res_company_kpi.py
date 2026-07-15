from odoo import api, fields, models

# Typical local mobile-number length per ISO country code (excluding the dial
# code). Auto-fills the length when a country is chosen; still editable.
# Adapted from pos_loyalty_card's COUNTRY_MOBILE_LENGTH.
COUNTRY_MOBILE_LENGTH = {
    'IN': 10, 'US': 10, 'CA': 10, 'GB': 10, 'IE': 9, 'AU': 9, 'NZ': 9,
    'AE': 9, 'SA': 9, 'QA': 8, 'KW': 8, 'OM': 8, 'BH': 8, 'JO': 9,
    'DE': 10, 'FR': 9, 'IT': 10, 'ES': 9, 'NL': 9, 'BE': 9, 'CH': 9,
    'SE': 9, 'NO': 8, 'DK': 8, 'FI': 9, 'PT': 9, 'AT': 10, 'PL': 9,
    'SG': 8, 'MY': 9, 'ID': 10, 'PH': 10, 'TH': 9, 'VN': 9, 'KR': 10,
    'JP': 10, 'CN': 11, 'HK': 8, 'TW': 9,
    'PK': 10, 'BD': 10, 'LK': 9, 'NP': 10,
    'ZA': 9, 'NG': 10, 'KE': 9, 'EG': 10, 'TR': 10, 'RU': 10, 'BR': 11,
    'MX': 10,
}

# Default editable WhatsApp message for app password-reset codes. Classic
# format — the recipient's name, the company name and the code are in *bold*
# (WhatsApp markdown). Placeholders filled at send time: {app} {name} {code}
# {minutes}.
DEFAULT_OTP_TEMPLATE = (
    "Hi *{name}* 👋\n\n"
    "🔐 *{app}* — Password Reset\n\n"
    "Your one-time code is:\n\n"
    "🔢 *{code}*\n\n"
    "⏱️ Expires in {minutes} minutes.\n"
    "Open the app and enter this code to set your new password.\n\n"
    "⚠️ Didn't request this? You can ignore this message."
)


class ResCompany(models.Model):
    """Global KRA/KPI settings stored on the company."""
    _inherit = 'res.company'

    away_after_minutes = fields.Integer(
        string='Away After (minutes)',
        default=5,
        help="Minutes with no heartbeat (tab closed / machine asleep) before a "
             "running task auto-pauses as 'Away'. Read by the browser and the server.")

    client_approval_minutes = fields.Integer(
        string='Client Approval Window (minutes)',
        default=5,
        help="How long a client has to approve the developer assigned to their task "
             "before it is auto-approved. Read by request_client_pre_approval() when "
             "setting pre_approval_deadline_at.")

    queue_nudge_minutes = fields.Integer(
        string='Queue Re-nudge Gap (minutes)',
        default=30,
        help="Gap between re-notifying admins about a client task still sitting in "
             "the Client Task Queue with no developer. Nudging stops once an admin "
             "reads the notification. Read by kra.kpi._cron_nudge_queued_tasks.")

    urgent_nudge_minutes = fields.Integer(
        string='Urgent Re-nudge Gap (minutes)',
        default=5,
        help="Gap between re-notifying admins that a developer 🚨 Urgent-paused a task. "
             "Nudging stops once an admin reads the notification (or the task resumes). "
             "Read by kra.kpi._cron_nudge_urgent_pause.")

    standard_workday_hours = fields.Float(
        string='Standard Workday (hours)',
        default=9.0,
        help="A normal working day. The End Workday summary compares it against "
             "PRESENCE (wall clock, login→logout): at or over it reads green, under "
             "it reads red. Note this is presence, not productive time — a long day "
             "with little task work still reads green, which is why the summary shows "
             "Productive next to it.")

    kpi_wa_sender_number = fields.Char(
        string='App OTP Sender (WhatsApp)',
        help="WhatsApp number shown to users as the sender of password-reset codes. "
             "Note: the actual code is sent from the connected WhatsApp session — "
             "this is a display/record value.")

    kpi_otp_message_template = fields.Text(
        string='App OTP WhatsApp Message',
        help="Editable WhatsApp message for password-reset codes. Placeholders: "
             "{app} {name} {code} {minutes}. Empty falls back to the default.")

    def kpi_otp_template(self):
        """Return the OTP message template (custom or the built-in default)."""
        self.ensure_one()
        return self.kpi_otp_message_template or DEFAULT_OTP_TEMPLATE

    # --- Country / mobile-number format (drives the Configuration screen) --- #
    kpi_country_id = fields.Many2one(
        'res.country', string='KPI Mobile Country',
        default=lambda self: self.env.company.country_id,
        help="Country whose dial code and typical mobile length apply to all "
             "WhatsApp numbers entered on the KRA/KPI Configuration screen.")
    kpi_country_dial_code = fields.Char(
        string='KPI Dial Code', compute='_compute_kpi_dial_code', store=True,
        help="Dial code derived from the selected country (e.g. 91 for India, "
             "968 for Oman).")
    kpi_mobile_length = fields.Integer(
        string='KPI Mobile Length', default=10,
        help="Number of local digits a mobile number must have (excluding the "
             "dial code). Auto-filled from the country but editable.")

    @api.depends('kpi_country_id')
    def _compute_kpi_dial_code(self):
        for rec in self:
            code = rec.kpi_country_id.phone_code if rec.kpi_country_id else False
            rec.kpi_country_dial_code = str(code) if code else '91'

    @api.onchange('kpi_country_id')
    def _onchange_kpi_country_id(self):
        """Auto-fill the mobile length from the chosen country (still editable)."""
        if self.kpi_country_id and self.kpi_country_id.code:
            self.kpi_mobile_length = COUNTRY_MOBILE_LENGTH.get(
                self.kpi_country_id.code, self.kpi_mobile_length or 10)

    def _kpi_mobile_cfg(self):
        """Return (dial_digits, local_length) for this company's KPI numbers."""
        self.ensure_one()
        dial = ''.join(filter(str.isdigit, self.kpi_country_dial_code or '')) or (
            str(self.country_id.phone_code) if self.country_id else '91')
        return dial, (self.kpi_mobile_length or 10)
