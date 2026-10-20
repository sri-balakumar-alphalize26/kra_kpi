from odoo import api, fields, models

# Typical local mobile-number length per ISO country code (excluding the dial
# code). The country's entry here wins over the stored kpi_mobile_length, which
# only applies to a country not listed.
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
        default=0,
        help="Minutes with no heartbeat (tab closed / machine asleep) before a "
             "running task auto-pauses as 'Away'. 0 = OFF, which is the default: "
             "a sleeping laptop is not evidence that someone stopped working, and "
             "auto-pausing on it caused more trouble than it prevented. Set a "
             "value AND re-activate the 'KPI: Auto-Away idle developers' cron to "
             "turn strict idle pausing back on.")

    workday_idle_close_minutes = fields.Integer(
        string='Auto End Workday After (minutes)',
        default=0,
        help="Minutes with no heartbeat (board tab gone) before a workday the "
             "developer forgot to End is auto-closed with the full daily summary. "
             "0 = OFF, which is the default: the developer ends their own day, and "
             "the midnight cron is the only safety net. Set a value AND re-activate "
             "the 'Auto End forgotten workdays' cron to turn it back on. "
             "See _cron_close_idle_workdays.")

    # ---- Break / lunch / meeting over-run reminders ----------------------- #
    # Sent to the DEVELOPER only, never to an admin — the same rule
    # kpi.nontask.block.reason already states: telling admins about a meeting is
    # the false alarm that makes the whole feed worth ignoring. These exist so a
    # developer who lost track of time is told while they can still fix it,
    # instead of finding out afterwards when the cron has rewritten their day.
    # All four read by kpi.work.session._cron_check_long_breaks.
    break_alert_minutes = fields.Integer(
        string='Break Reminder Every (minutes)',
        default=15,
        help="How long an open BREAK runs before the developer is reminded, and the "
             "gap between repeats. Capped at BREAK_ALERT_MAX (4) pings so a genuinely "
             "long break is never nagged forever. 0 = OFF.")

    lunch_alert_minutes = fields.Integer(
        string='Lunch Reminder After (minutes)',
        default=30,
        help="How long an open LUNCH runs before the developer is reminded. Sent "
             "ONCE — lunch has a natural end and a repeat would just be nagging. "
             "0 = OFF.")

    meeting_alert_minutes = fields.Integer(
        string='Meeting Reminder After (minutes)',
        default=30,
        help="How long an open MEETING runs before the developer is reminded. Sent "
             "ONCE: an over-running meeting is usually not something they control, "
             "so repeating it would be noise. 0 = OFF.")

    break_budget_minutes = fields.Integer(
        string='Daily Break Budget (minutes)',
        default=60,
        help="Break + lunch TOTAL for the day, after which the developer is told "
             "once. This is what catches six short breaks that never individually "
             "tripped the per-break reminder. Meetings are excluded — a meeting is "
             "work, not a break. 0 = OFF.")

    # ---- Attendance (Admin Live Tracking) -------------------------------- #
    attendance_cutoff_hour = fields.Float(
        string='Attendance Cutoff (IST hour)',
        default=10.667,
        help="Local (IST) hour that separates on-time from late. A developer whose "
             "first workday login is after this reads 'Late (came HH:MM)'; one with "
             "NO login once this hour has passed reads 'Absent'. 10.667 = 10:40. "
             "Read by /kpi_owner/live_tracking.")

    admin_accept_minutes = fields.Integer(
        string='Admin Accept Window (minutes)',
        default=5,
        help="How long a new task waits for a coordinator/owner to Accept it before it "
             "is AUTO-ACCEPTED and moves on to client pre-approval. The admin keeps full "
             "power afterwards — they can still re-categorise (REQ/UPT/BUG) or reject it; "
             "auto-accept only stops an un-triaged task blocking the developer forever. "
             "Set 0 to disable auto-accept and require a human Accept, as before. "
             "Read by kra.kpi._admin_accept_minutes() / _cron_admin_accept_timeout.")

    client_approval_minutes = fields.Integer(
        string='Client Approval Window (minutes)',
        default=5,
        help="How long a client has to approve the developer assigned to their task "
             "before it is AUTO-RELEASED. Auto-release lets the developer start work; it "
             "is NOT recorded as the client's approval (pre_approval_decision stays "
             "empty) and the client can still object afterwards. Billing is unaffected: "
             "an invoice still needs the real sign-off at completion. Read by "
             "request_client_pre_approval() and _cron_pre_approval_timeout.")

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

    # ---- WhatsApp group reporting ---------------------------------------- #
    # Where workday start/end reports are posted. Stores the group's JID
    # ("120363...@g.us"), never the invite link: links are revocable and rotate,
    # the JID does not. Empty = reporting off, which is the default.
    kpi_wa_group_jid = fields.Char(
        string='WhatsApp Report Group',
        help="Group JID that workday start/end reports are posted to. "
             "Leave empty to post nothing.")
    kpi_wa_group_name = fields.Char(
        string='WhatsApp Report Group Name', readonly=True,
        help="Cached for display; the JID above is what is actually used.")

    standard_workday_hours = fields.Float(
        string='Standard Workday (hours)',
        default=9.0,
        help="A normal working day. The End Workday summary compares it against "
             "PRESENCE (wall clock, login→logout): at or over it reads green, under "
             "it reads red. Note this is presence, not productive time — a long day "
             "with little task work still reads green, which is why the summary shows "
             "Productive next to it.")

    # ---- Workday snapshot image retention -------------------------------- #
    # The End Workday summary PNG (kpi.workday.snapshot.image) lives in the
    # filestore and would otherwise pile up forever. A daily cron
    # (_gc_snapshot_images) clears images older than this window, keeping the
    # lightweight stats row. Number 0 = keep forever.
    kpi_snapshot_retention_number = fields.Integer(
        string='Snapshot Retention',
        default=3,
        help="Delete workday snapshot IMAGES older than this many "
             "days/months/years (unit below). The stats row is kept — only the "
             "PNG is freed. 0 = keep images forever. Read by "
             "kpi.workday.snapshot._gc_snapshot_images.")
    kpi_snapshot_retention_unit = fields.Selection(
        [('days', 'Days'), ('months', 'Months'), ('years', 'Years')],
        string='Snapshot Retention Unit', default='months')

    # ---- Daily employee task report (PDF to admins) ---------------------- #
    kpi_daily_report_enabled = fields.Boolean(
        string='Send Daily Task Report',
        default=True,
        help="When on, a consolidated daily employee task report (PDF) is generated "
             "and sent to admins on the schedule below. Read by "
             "kpi.daily.report._cron_daily_report.")
    kpi_daily_report_hour = fields.Float(
        string='Daily Report Send Time (IST hour)',
        default=10.0,
        help="Hour of day (IST, 24h; 10.5 = 10:30) at which the daily report is "
             "generated and sent. A 15-minute gate cron fires it once at/after this "
             "time each day.")
    kpi_daily_report_coverage = fields.Selection(
        [('yesterday', 'Previous day'), ('today', 'Same day')],
        string='Daily Report Covers', default='yesterday',
        help="Which day the report summarizes. 'Previous day' suits a morning send "
             "(everyone has ended their workday); 'Same day' suits an evening send.")
    kpi_daily_report_last_sent = fields.Date(
        string='Daily Report Last Sent',
        help="Internal guard: the last date the daily report was sent, so the gate "
             "cron fires only once per day. Not user-facing.")

    # ---- Daily report PDF retention -------------------------------------- #
    kpi_report_retention_number = fields.Integer(
        string='Report Retention',
        default=3,
        help="Delete generated daily report PDFs (kpi.daily.report) older than this "
             "many days/months/years (unit below). 0 = keep forever. Read by "
             "kpi.daily.report._gc_reports.")
    kpi_report_retention_unit = fields.Selection(
        [('days', 'Days'), ('months', 'Months'), ('years', 'Years')],
        string='Report Retention Unit', default='months')

    # ---- Downloaded KRA report retention --------------------------------- #
    # Same number+unit shape as its two siblings above, so the GC method needs no
    # special cases. The Configuration screen offers 7/30/45/60/90 days as presets
    # over these fields and falls back to showing the raw pair for anything else.
    # Defaults to 30 DAYS rather than the siblings' 3 months: these are the largest
    # blobs the module stores (a ZIP of PDFs), so keeping them for a quarter by
    # default would grow the filestore faster than anyone expects.
    kpi_download_retention_number = fields.Integer(
        string='Download Retention',
        default=30,
        help="Delete stored KRA report downloads (kpi.report.download) older than "
             "this many days/months/years (unit below). 0 = keep forever. Read by "
             "kpi.report.download._gc_downloads.")
    kpi_download_retention_unit = fields.Selection(
        [('days', 'Days'), ('months', 'Months'), ('years', 'Years')],
        string='Download Retention Unit', default='days')

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
        """Return (dial_digits, local_length) for this company's KPI numbers.

        Both come from the stored country. The length used to be read from
        kpi_mobile_length alone, which only follows the country when an admin
        changes it (onchange / set_country) — a company that got Oman by default
        at install kept the field's default 10, so the login showed +968 and
        took 10 digits. The stored length now only covers countries missing
        from COUNTRY_MOBILE_LENGTH.
        """
        self.ensure_one()
        dial = ''.join(filter(str.isdigit, self.kpi_country_dial_code or '')) or (
            str(self.country_id.phone_code) if self.country_id else '91')
        code = self.kpi_country_id.code if self.kpi_country_id else None
        return dial, (COUNTRY_MOBILE_LENGTH.get(code) or self.kpi_mobile_length or 10)
