import logging
import re
from odoo import models, fields, api, _
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')

# Auto-detect SMTP host/port/security from the email's domain.
# Format: domain -> (smtp_host, port, encryption: 'ssl'|'starttls'|'none')
SMTP_PRESETS = {
    'gmail.com':       ('smtp.gmail.com',          587, 'starttls'),
    'googlemail.com':  ('smtp.gmail.com',          587, 'starttls'),
    'outlook.com':     ('smtp-mail.outlook.com',   587, 'starttls'),
    'hotmail.com':     ('smtp-mail.outlook.com',   587, 'starttls'),
    'live.com':        ('smtp-mail.outlook.com',   587, 'starttls'),
    'office365.com':   ('smtp.office365.com',      587, 'starttls'),
    'yahoo.com':       ('smtp.mail.yahoo.com',     587, 'starttls'),
    'yahoo.co.in':     ('smtp.mail.yahoo.com',     587, 'starttls'),
    'icloud.com':      ('smtp.mail.me.com',        587, 'starttls'),
    'me.com':          ('smtp.mail.me.com',        587, 'starttls'),
    'zoho.com':        ('smtp.zoho.com',           587, 'starttls'),
    'zoho.in':         ('smtp.zoho.in',            587, 'starttls'),
    'aol.com':         ('smtp.aol.com',            587, 'starttls'),
    'protonmail.com':  ('smtp.protonmail.com',     587, 'starttls'),
}

# Provider-specific App Password help links shown in error messages
APP_PASSWORD_HELP = {
    'gmail.com':       'https://myaccount.google.com/apppasswords',
    'googlemail.com':  'https://myaccount.google.com/apppasswords',
    'outlook.com':     'https://account.microsoft.com/security/app-passwords',
    'hotmail.com':     'https://account.microsoft.com/security/app-passwords',
    'live.com':        'https://account.microsoft.com/security/app-passwords',
    'yahoo.com':       'https://login.yahoo.com/account/security',
    'icloud.com':      'https://support.apple.com/en-us/HT204397',
}

MAIL_SERVER_AUTO_NAME = 'WhatsApp & Email Auto-Configured SMTP'


class WhatsAppOwnerNumber(models.Model):
    _name = 'whatsapp.owner.number'
    _description = 'WhatsApp Owner Notification Number'
    _order = 'sequence, id'

    sequence = fields.Integer(default=10)
    name = fields.Char('Label', required=True, help='e.g. Owner, Manager, Accountant')
    phone = fields.Char(
        'Phone Number', required=True,
        help='Phone number with country code, no + sign. e.g. 919944080209',
    )
    active = fields.Boolean(default=True)
    config_id = fields.Many2one(
        'whatsapp.config', string='Configuration',
        ondelete='cascade',
    )
    company_id = fields.Many2one(
        'res.company', string='Company',
        default=lambda self: self.env.company,
    )


class WhatsAppConfig(models.Model):
    _name = 'whatsapp.config'
    _description = 'WhatsApp Configuration'
    _rec_name = 'company_id'

    company_id = fields.Many2one(
        'res.company', string='Company', required=True,
        default=lambda self: self.env.company,
        ondelete='cascade',
    )

    # --- POS Settings ---
    pos_notify_enabled = fields.Boolean(
        'Enable POS WhatsApp Notifications', default=False,
    )
    pos_notify_owners = fields.Boolean(
        'Send POS Orders to Owners', default=True,
        help='Send order summary to owner numbers when POS order is completed.',
    )
    pos_notify_customer = fields.Boolean(
        'Send POS Receipt to Customer', default=False,
        help='Send order summary to the customer selected in POS order.',
    )
    pos_session_id = fields.Many2one(
        'whatsapp.session', string='WhatsApp Session for POS',
        help='Which WhatsApp session to use for POS notifications. '
             'Leave empty to use the first connected session.',
    )
    pos_message_template = fields.Text(
        'POS Message Template',
        default="""🧾 *POS Order: {order_name}*
📅 Date: {date}
🏪 POS: {pos_name}

{order_lines}

💰 *Subtotal:* {amount_untaxed}
📊 *Tax:* {amount_tax}
✅ *Total:* {amount_total}
💳 *Paid:* {amount_paid}

{customer_info}

Thank you for your purchase! 🙏""",
        help='Template for POS order messages. Available placeholders: '
             '{order_name}, {date}, {pos_name}, {order_lines}, '
             '{amount_untaxed}, {amount_tax}, {amount_total}, '
             '{amount_paid}, {customer_name}, {customer_info}',
    )

    owner_number_ids = fields.One2many(
        'whatsapp.owner.number', 'config_id', string='Owner Numbers',
    )

    # ──────────────────────────────────────────────────────────────────────
    # MULTI-SESSION DEFAULTS
    # ──────────────────────────────────────────────────────────────────────

    default_email_session_id = fields.Many2one(
        'email.session', string='Default Email Session',
        domain="[('active', '=', True), ('status', '=', 'connected')]",
        help='Default email account used for auto-send (sale confirm, PO confirm, '
             'vendor bill post, POS, credit approvals).',
    )
    default_whatsapp_session_id = fields.Many2one(
        'whatsapp.session', string='Default WhatsApp Session',
        domain="[('status', '=', 'connected')]",
        help='Default WhatsApp session used for auto-send. Leave blank to use '
             'the first connected session.',
    )

    # Backward-compat: admin_email + from_email now read from the default email session.
    admin_email = fields.Char(
        string='Default Admin Email',
        compute='_compute_admin_email', store=False,
        help='Default email address. Comes from the Default Email Session.',
    )
    from_email = fields.Char(
        string='Default Send From',
        compute='_compute_admin_email', store=False,
    )

    @api.depends('default_email_session_id',
                 'default_email_session_id.email_address',
                 'default_email_session_id.from_email')
    def _compute_admin_email(self):
        for rec in self:
            sess = rec.default_email_session_id
            rec.admin_email = sess.email_address if sess else False
            rec.from_email = (sess.from_email or sess.email_address) if sess else False

    # ──────────────────────────────────────────────────────────────────────
    # AUTO-SEND TOGGLES (Email + WhatsApp, per event)
    # ──────────────────────────────────────────────────────────────────────

    # Sales — Quotation/SO
    auto_send_so_quotation_email = fields.Boolean(
        string='Auto Email Quotation',
        help="Email the quotation PDF when state changes to 'sent' (Send by Email pressed).",
    )
    auto_send_so_quotation_wa = fields.Boolean(
        string='Auto WhatsApp Quotation',
        help="WhatsApp the quotation PDF when state changes to 'sent'.",
    )
    auto_send_so_confirm_email = fields.Boolean(
        string='Auto Email on SO Confirm',
        help='Email the sale order PDF to the customer when the order is confirmed.',
    )
    auto_send_so_confirm_wa = fields.Boolean(
        string='Auto WhatsApp on SO Confirm',
        help='WhatsApp the sale order PDF to the customer when the order is confirmed.',
    )

    # Purchase
    auto_send_po_confirm_email = fields.Boolean(
        string='Auto Email PO on Confirm',
        help='Email the purchase order PDF to the vendor when the PO is confirmed.',
    )
    auto_send_po_confirm_wa = fields.Boolean(
        string='Auto WhatsApp PO on Confirm',
        help='WhatsApp the purchase order PDF to the vendor when the PO is confirmed.',
    )

    # Vendor bills
    auto_send_bill_email = fields.Boolean(
        string='Auto Email Vendor Bill on Post',
        help='Email the vendor bill PDF when posted.',
    )
    auto_send_bill_wa = fields.Boolean(
        string='Auto WhatsApp Vendor Bill on Post',
        help='WhatsApp the vendor bill PDF when posted.',
    )

    # Customer invoices
    auto_send_invoice_email = fields.Boolean(
        string='Auto Email Customer Invoice on Post',
        help='Email the customer invoice PDF to the customer when posted.',
    )
    auto_send_invoice_wa = fields.Boolean(
        string='Auto WhatsApp Customer Invoice on Post',
        help='WhatsApp the customer invoice PDF to the customer when posted.',
    )

    # Payment receipts (account.payment.action_post)
    auto_send_payment_receipt_email = fields.Boolean(
        string='Auto Email Payment Receipt',
        help='Email a receipt to the customer when an inbound payment is '
             'posted, OR a remittance to the vendor when an outbound payment '
             'is posted.',
    )
    auto_send_payment_receipt_wa = fields.Boolean(
        string='Auto WhatsApp Payment Receipt',
        help='WhatsApp a receipt to the customer/vendor when a payment is '
             'posted.',
    )

    # POS Email — mirrors the existing WhatsApp POS auto-send
    pos_email_notify_enabled = fields.Boolean(
        string='Enable POS Email Notifications', default=False,
    )
    pos_email_notify_owners = fields.Boolean(
        string='Email POS Order to Owners',
        help='Email the POS order summary to the addresses listed in Owner Emails '
             'when a POS order is paid/done/invoiced.',
    )
    pos_email_notify_customer = fields.Boolean(
        string='Email POS Receipt to Customer',
        help='Email the POS order summary to the customer (partner_id.email) when '
             'a POS order is paid/done/invoiced.',
    )
    pos_owner_emails = fields.Char(
        string='Owner Emails (comma-separated)',
        help='One or more email addresses (comma-separated) that receive POS '
             'order summaries.',
    )

    # ──────────────────────────────────────────────────────────────────────
    # EMAIL HELPERS
    # ──────────────────────────────────────────────────────────────────────

    def _get_from_email(self):
        """Return the From address of the default email session, falling back
        to the company email."""
        self.ensure_one()
        sess = self.default_email_session_id
        if sess:
            return sess.get_from_email()
        return self.env.company.email or 'noreply@example.com'

    @api.model
    def get_config(self, company_id=None):
        """Get or create config for current company."""
        company_id = company_id or self.env.company.id
        config = self.search([('company_id', '=', company_id)], limit=1)
        if not config:
            config = self.create({'company_id': company_id})
        return config

    def format_pos_message(self, order):
        """Format POS order into WhatsApp message."""
        self.ensure_one()
        template = self.pos_message_template or self._fields['pos_message_template'].default

        # Build order lines
        lines = []
        for line in order.lines:
            qty_str = f"{line.qty:g}"
            line_total = line.price_subtotal_incl
            line_text = f"  • {line.full_product_name or line.product_id.name}"
            line_text += f"  ×{qty_str}"
            if line.discount:
                line_text += f"  (-{line.discount:g}%)"
            line_text += f"  = {line_total:,.2f}"
            lines.append(line_text)

        order_lines = "\n".join(lines) if lines else "  (no items)"

        # Customer info
        customer_name = order.partner_id.name if order.partner_id else 'Walk-in Customer'
        customer_info = ""
        if order.partner_id:
            customer_info = f"👤 Customer: {order.partner_id.name}"
            if order.partner_id.phone:
                customer_info += f"\n📱 Phone: {order.partner_id.phone}"

        # Get POS config name
        pos_name = 'N/A'
        if order.session_id and order.session_id.config_id:
            pos_name = order.session_id.config_id.name

        # Format amounts
        amount_untaxed = order.amount_total - order.amount_tax
        date_str = order.date_order.strftime('%d/%m/%Y %I:%M %p') if order.date_order else ''

        return template.format(
            order_name=order.name or '',
            date=date_str,
            pos_name=pos_name,
            order_lines=order_lines,
            amount_untaxed=f"{amount_untaxed:,.2f}",
            amount_tax=f"{order.amount_tax:,.2f}",
            amount_total=f"{order.amount_total:,.2f}",
            amount_paid=f"{order.amount_paid:,.2f}",
            customer_name=customer_name,
            customer_info=customer_info,
        )
