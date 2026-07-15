"""whatsapp.config extension — KRA/KPI-specific notification toggles + secrets.

We extend the existing whatsapp.config singleton (per-company) so KRA/KPI
notification behaviour lives next to the rest of the WhatsApp config rather
than in a separate model.  Adds:

  * One Boolean per workflow event (default True) — operator can mute any
    event individually without redeploying.
  * kpi_token_secret — auto-filled with a 64-char hex secret on first read,
    used to HMAC the client-pre-approval tokens.
  * kpi_public_base_url — optional override for the host part of the
    approval-link URL (defaults to the system web.base.url).
"""

import secrets

from odoo import api, fields, models


class WhatsAppConfigKpi(models.Model):
    _inherit = 'whatsapp.config'

    # Per-event toggles — every event in _notify() checks the matching flag.
    notify_task_created          = fields.Boolean(default=True, string='Notify: Task Created')
    notify_pre_approval_request  = fields.Boolean(default=True, string='Notify: Pre-Approval Request')
    notify_pre_approval_decided  = fields.Boolean(default=True, string='Notify: Pre-Approval Decided')
    notify_partial_timeout       = fields.Boolean(default=True, string='Notify: 5-min Auto Partial Approval')
    notify_start                 = fields.Boolean(default=True, string='Notify: Task Started')
    notify_pause                 = fields.Boolean(default=True, string='Notify: Task Paused')
    notify_resume                = fields.Boolean(default=True, string='Notify: Task Resumed')
    notify_complete              = fields.Boolean(default=True, string='Notify: Task Completed')
    notify_internal_approved     = fields.Boolean(default=True, string='Notify: Coordinator Approved')
    notify_internal_rejected     = fields.Boolean(default=True, string='Notify: Coordinator Rejected')
    notify_daily_summary         = fields.Boolean(default=True, string='Notify: Developer Daily Summary',
        help="Send each developer's end-of-day summary (productive + presence hours + per-task breakdown) to owner + coordinator. Fires when developer clicks End Workday OR when the 23:55 cron auto-closes a forgotten session.")
    notify_workday_started       = fields.Boolean(default=True, string='Notify: Developer Workday Started',
        help='Fires the first time a developer opens the KPI Action Board each day. Sends "Workday Started — name @ login_time" to owner + coordinator.')
    notify_task_auto_away        = fields.Boolean(default=True, string='Notify: Task Auto-Paused (Away)',
        help='WhatsApp the developer when the idle/auto-away cron pauses their running task (tab closed or board idle). Default ON.')

    # MASTER SWITCH for every task-related WhatsApp message. OFF (the default)
    # means notifications go to the app only — the in-app feed + Expo push. The
    # per-event notify_* toggles above only matter while this is ON.
    # Password-reset OTP is NOT affected: it never goes through kra.kpi._notify().
    kpi_wa_task_notifications    = fields.Boolean(default=False, string='Send task notifications on WhatsApp',
        help='OFF (default): task notifications are delivered in the app only (bell + push). '
             'ON: also send them on WhatsApp, subject to the per-event toggles above. '
             'Password-reset OTP messages are unaffected either way.')

    # Master switch for the mobile push (Expo) banner sent alongside the in-app
    # notification feed on assignment/upload events. Default ON.
    kpi_push_enabled             = fields.Boolean(default=True, string='Mobile Push Notifications',
        help='Send a phone banner (via Expo push) to recipients\' registered devices on task assignment / upload events. Independent of the WhatsApp toggles.')

    # Token plumbing for the public client-approval page.
    kpi_token_secret = fields.Char(
        string='KPI Token Secret',
        help='HMAC secret used to derive client pre-approval tokens. '
             'Auto-generated on first access; keep secret.',
    )
    kpi_public_base_url = fields.Char(
        string='KPI Public Base URL',
        help='Optional override for the host portion of the approval URL '
             '(e.g. https://app.example.com). Falls back to web.base.url.',
    )

    def get_kpi_token_secret(self):
        """Return the secret, creating one on first call.  Multi-process safe:
        we use a SELECT…FOR UPDATE on the config row before the write.
        """
        self.ensure_one()
        if self.kpi_token_secret:
            return self.kpi_token_secret
        # Lock the row before writing so two workers don't generate competing secrets.
        self.env.cr.execute(
            'SELECT id FROM whatsapp_config WHERE id = %s FOR UPDATE',
            (self.id,),
        )
        # Re-read in case another worker just set it after we got the lock.
        self.invalidate_recordset(['kpi_token_secret'])
        if self.kpi_token_secret:
            return self.kpi_token_secret
        secret = secrets.token_hex(32)
        self.sudo().write({'kpi_token_secret': secret})
        return secret

    def get_kpi_public_base_url(self):
        """Resolve the URL prefix used to build pre-approval links."""
        self.ensure_one()
        url = (self.kpi_public_base_url or '').strip().rstrip('/')
        if url:
            return url
        base = self.env['ir.config_parameter'].sudo().get_param('web.base.url') or ''
        return base.rstrip('/')
