"""Multi-session email accounts. Each row represents one email account
(Gmail, Outlook, custom domain, etc.) that the user can send from.
Mirrors the multi-session pattern of `whatsapp.session`."""

import email as email_lib
import email.header
import imaplib
import logging
import re
from odoo import models, fields, api, _
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')

# Auto-detect SMTP host/port/security from the email's domain.
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

# Auto-detect IMAP host/port for inbox polling.
IMAP_PRESETS = {
    'gmail.com':       ('imap.gmail.com',          993, 'ssl'),
    'googlemail.com':  ('imap.gmail.com',          993, 'ssl'),
    'outlook.com':     ('outlook.office365.com',   993, 'ssl'),
    'hotmail.com':     ('outlook.office365.com',   993, 'ssl'),
    'live.com':        ('outlook.office365.com',   993, 'ssl'),
    'office365.com':   ('outlook.office365.com',   993, 'ssl'),
    'yahoo.com':       ('imap.mail.yahoo.com',     993, 'ssl'),
    'yahoo.co.in':     ('imap.mail.yahoo.com',     993, 'ssl'),
    'icloud.com':      ('imap.mail.me.com',        993, 'ssl'),
    'me.com':          ('imap.mail.me.com',        993, 'ssl'),
    'zoho.com':        ('imap.zoho.com',           993, 'ssl'),
    'zoho.in':         ('imap.zoho.in',            993, 'ssl'),
    'aol.com':         ('imap.aol.com',            993, 'ssl'),
    'protonmail.com':  ('imap.protonmail.com',     993, 'ssl'),
}

# Token format embedded in the subject of approval-request emails.
# The reply-poller scans incoming subjects for this and matches by token.
TOKEN_RE = re.compile(r'\[CF-TOKEN-([a-zA-Z0-9-]+)\]')

APP_PASSWORD_HELP = {
    'gmail.com':       'https://myaccount.google.com/apppasswords',
    'googlemail.com':  'https://myaccount.google.com/apppasswords',
    'outlook.com':     'https://account.microsoft.com/security/app-passwords',
    'hotmail.com':     'https://account.microsoft.com/security/app-passwords',
    'live.com':        'https://account.microsoft.com/security/app-passwords',
    'yahoo.com':       'https://login.yahoo.com/account/security',
    'icloud.com':      'https://support.apple.com/en-us/HT204397',
}

# Direct links to enable IMAP per provider (used when polling test fails).
IMAP_ENABLE_HELP = {
    'gmail.com':       'https://mail.google.com/mail/u/0/#settings/fwdandpop',
    'googlemail.com':  'https://mail.google.com/mail/u/0/#settings/fwdandpop',
    'outlook.com':     'https://outlook.live.com/mail/0/options/mail/forwarding',
    'hotmail.com':     'https://outlook.live.com/mail/0/options/mail/forwarding',
    'live.com':        'https://outlook.live.com/mail/0/options/mail/forwarding',
    'yahoo.com':       'https://login.yahoo.com/account/security',
}


class EmailSession(models.Model):
    _name = 'email.session'
    _description = 'Connected Email Account / Session'
    _order = 'is_default desc, sequence, id'
    _rec_name = 'display_name'

    sequence = fields.Integer(default=10)
    name = fields.Char(
        string='Label', required=True,
        help='Friendly label, e.g. "Sales Team" or "Support".',
    )
    display_name = fields.Char(compute='_compute_display_name', store=True)

    email_address = fields.Char(
        string='Email Address', required=True,
        help='The email account to send from. e.g. sales@yourcompany.com',
    )
    app_password = fields.Char(
        string='App Password',
        help='For Gmail / Outlook / Yahoo this MUST be an App Password — '
             'NOT the normal login password.',
    )
    from_email = fields.Char(
        string='Send From (optional)',
        help='Override the From address. Leave blank to use the email address above.',
    )

    status = fields.Selection([
        ('not_set', 'Not Connected'),
        ('connected', 'Connected ✓'),
        ('failed', 'Failed'),
    ], default='not_set', readonly=True, copy=False, tracking=True)
    last_message = fields.Char(string='Last Connection Message', readonly=True, copy=False)

    is_default = fields.Boolean(
        string='Default',
        help='When checked, this session is used by default for auto-send features.',
    )
    active = fields.Boolean(default=True)

    enable_reply_polling = fields.Boolean(
        string='Auto-Process Approval Replies',
        default=True,
        help='When enabled, the system polls this inbox every minute. '
             'When the approver replies YES or NO to a credit facility '
             'approval email, the application is auto-approved or auto-rejected. '
             'Requires IMAP access (Gmail App Password works for both SMTP and IMAP).',
    )
    last_poll_at = fields.Datetime(
        string='Last Poll At', readonly=True, copy=False,
        help='Timestamp of the most recent IMAP poll cycle.',
    )

    mail_server_id = fields.Many2one(
        'ir.mail_server', string='Linked SMTP Server', readonly=True, copy=False,
        ondelete='set null',
    )

    company_id = fields.Many2one(
        'res.company', string='Company',
        default=lambda self: self.env.company,
    )

    _sql_constraints = [
        ('email_address_unique', 'unique(email_address, company_id)',
         'An email session for this address already exists in this company.'),
    ]

    @api.depends('name', 'email_address', 'status')
    def _compute_display_name(self):
        for rec in self:
            base = rec.name or '?'
            email = rec.email_address or ''
            mark = ' ✓' if rec.status == 'connected' else (' ✗' if rec.status == 'failed' else '')
            rec.display_name = '%s — %s%s' % (base, email, mark) if email else base + mark

    @api.constrains('is_default', 'active', 'company_id')
    def _check_single_default(self):
        for rec in self.filtered(lambda r: r.is_default and r.active):
            others = self.search([
                ('is_default', '=', True),
                ('active', '=', True),
                ('company_id', '=', rec.company_id.id),
                ('id', '!=', rec.id),
            ])
            if others:
                others.write({'is_default': False})

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        # If no default exists in the company, mark the first new active record as default.
        for rec in records:
            if rec.active and not self.search([
                ('is_default', '=', True),
                ('active', '=', True),
                ('company_id', '=', rec.company_id.id),
                ('id', '!=', rec.id),
            ], limit=1):
                rec.is_default = True
        return records

    # ──────────────────────────────────────────────────────────────────────

    @staticmethod
    def _detect_smtp(email):
        domain = email.split('@')[-1].lower().strip()
        if domain in SMTP_PRESETS:
            return SMTP_PRESETS[domain]
        return ('smtp.' + domain, 587, 'starttls')

    def _translate_smtp_error(self, error):
        text = str(error).lower()
        domain = (self.email_address or '').split('@')[-1].lower().strip()
        help_url = APP_PASSWORD_HELP.get(domain)

        if (
            'authenticationfailed' in text
            or 'authentication failed' in text
            or '535' in text
            or 'username and password not accepted' in text
            or 'application-specific password required' in text
        ):
            base = _(
                "❌ Wrong password.\n\n"
                "Most providers (Gmail, Outlook, Yahoo) DO NOT accept your normal "
                "login password. You need an App Password — a special 16-character "
                "password generated for apps like Odoo."
            )
            if help_url:
                base += _("\n\nGet your App Password here:\n%s") % help_url
            return base

        if (
            'getaddrinfo failed' in text
            or 'name or service not known' in text
            or 'no address associated' in text
        ):
            return _(
                "❌ Could not find the email server.\n\n"
                "DNS lookup failed. Check the email spelling, or your internet."
            )
        if 'connection refused' in text or 'timed out' in text or 'timeout' in text:
            return _(
                "❌ Could not connect to the email server.\n\n"
                "Your network or firewall may be blocking outgoing SMTP (port 587)."
            )
        if 'sender address rejected' in text or '550' in text:
            return _(
                "❌ Your provider rejected the sender address.\n\n"
                "Make sure the email above is the same address tied to the App Password."
            )
        return _("❌ Connection failed: %s") % str(error)

    def _server_name(self):
        return 'WhatsApp & Email — %s' % (self.email_address or self.name or 'Session')

    def _upsert_mail_server(self, host, port, encryption):
        Server = self.env['ir.mail_server'].sudo()
        server = self.mail_server_id
        smtp_encryption = encryption if encryption in ('starttls', 'ssl', 'none') else 'starttls'
        vals = {
            'name':              self._server_name(),
            'smtp_host':         host,
            'smtp_port':         port,
            'smtp_encryption':   smtp_encryption,
            'smtp_authentication': 'login',
            'smtp_user':         (self.email_address or '').strip(),
            'smtp_pass':         (self.app_password or '').strip(),
            'sequence':          5,
            'from_filter':       (self.email_address or '').strip(),
        }
        if server and server.exists():
            server.write(vals)
        else:
            server = Server.create(vals)
            self.with_context(skip_recurse=True).mail_server_id = server.id
        return server

    def get_from_email(self):
        self.ensure_one()
        if self.from_email and EMAIL_RE.match(self.from_email.strip()):
            return self.from_email.strip()
        if self.email_address:
            return self.email_address.strip()
        return self.env.company.email or 'noreply@example.com'

    # ──────────────────────────────────────────────────────────────────────

    def connect_and_test(self):
        """One-click setup. Detects SMTP, creates ir.mail_server, sends test email."""
        self.ensure_one()
        email = (self.email_address or '').strip()
        password = (self.app_password or '').strip()

        if not email or not EMAIL_RE.match(email):
            raise UserError(_("Please type a valid email address first."))
        if not password:
            raise UserError(_(
                "Please type your email App Password first.\n\n"
                "If you use Gmail, Outlook, or Yahoo, this is a special password — "
                "not your normal login password. See the help section below the form."
            ))

        host, port, encryption = self._detect_smtp(email)
        _logger.info(
            "email.session connect_and_test: %s @ %s:%s (%s)",
            email, host, port, encryption,
        )

        try:
            server = self._upsert_mail_server(host, port, encryption)
        except Exception as e:
            _logger.exception("email.session: upsert mail_server failed: %s", e)
            self.write({'status': 'failed', 'last_message': str(e)[:500]})
            raise UserError(_("Could not save SMTP settings: %s") % str(e))

        # Test the SMTP login
        try:
            server.test_smtp_connection()
        except Exception as e:
            self.write({'status': 'failed', 'last_message': str(e)[:500]})
            raise UserError(self._translate_smtp_error(e))

        # Send a real test email
        body = (
            '<p>Hello,</p>'
            '<p>This is a test email from <strong>WhatsApp and Email Integration</strong>.</p>'
            '<p>The session <strong>%s</strong> (%s) is now connected. Auto-send '
            'notifications, credit approvals, and manual sends can use this address.</p>'
            '<p style="color:#888;font-size:12px;">Sent automatically by Odoo.</p>'
        ) % (self.name or '', email)
        try:
            mail = self.env['mail.mail'].sudo().create({
                'subject': '[WhatsApp & Email] %s connected ✓' % email,
                'body_html': body,
                'email_to': email,
                'email_from': email,
                'mail_server_id': server.id,
                'auto_delete': False,
            })
            mail.send(raise_exception=True)
        except Exception as e:
            self.write({'status': 'failed', 'last_message': str(e)[:500]})
            raise UserError(self._translate_smtp_error(e))

        # Test IMAP too (for auto-approval reply polling). Failure is
        # non-fatal — sending still works.
        imap_ok, imap_err = self._try_imap_login()

        if imap_ok:
            self.write({
                'status': 'connected',
                'last_message': _('Connected. Sending + inbox-polling both working.'),
            })
            return {
                'type': 'ir.actions.client',
                'tag': 'display_notification',
                'params': {
                    'title': _('✓ Fully Connected'),
                    'message': _(
                        'Test email sent to %s. Auto-approval replies will be '
                        'processed automatically.'
                    ) % email,
                    'type': 'success',
                    'sticky': False,
                }
            }

        # SMTP works but IMAP doesn't — degrade gracefully.
        self.write({
            'status': 'connected',
            'enable_reply_polling': False,
            'last_message': _(
                'Sending works ✓ — but inbox polling is disabled. '
                '%s'
            ) % imap_err,
        })

        domain = email.split('@')[-1].lower().strip()
        help_url = IMAP_ENABLE_HELP.get(domain)
        msg = _(
            "✅ Sending works — your test email was delivered to %s.\n\n"
            "⚠️ Auto-approval REPLIES are not active yet. For replies to be "
            "processed automatically, your email needs IMAP enabled."
        ) % email

        if domain in ('gmail.com', 'googlemail.com'):
            msg += _(
                "\n\nFor Gmail, do this once (3 clicks, 30 seconds):\n"
                "1. Open this link: %s\n"
                "2. Scroll to 'IMAP access' → click 'Enable IMAP'.\n"
                "3. Click 'Save Changes' at the bottom.\n"
                "4. Come back here and click 'Connect & Test' again.\n\n"
                "If you don't need auto-approval replies, you can ignore this — "
                "sending and auto-send features all work."
            ) % help_url
        elif help_url:
            msg += _(
                "\n\nEnable IMAP here: %s\n\n"
                "Then click 'Connect & Test' again."
            ) % help_url
        else:
            msg += _(
                "\n\nAsk your IT admin to enable IMAP on the server.\n\n"
                "Underlying error: %s"
            ) % imap_err

        # Use UserError so the message shows in a clear modal popup the user
        # can read and act on (vs. a tiny corner notification).
        raise UserError(msg)

    def action_set_default(self):
        self.ensure_one()
        self.search([
            ('company_id', '=', self.company_id.id),
            ('id', '!=', self.id),
        ]).write({'is_default': False})
        self.is_default = True
        return True

    @api.model
    def get_default_session(self, company_id=None):
        company_id = company_id or self.env.company.id
        rec = self.search([
            ('is_default', '=', True),
            ('active', '=', True),
            ('company_id', '=', company_id),
            ('status', '=', 'connected'),
        ], limit=1)
        if rec:
            return rec
        # Fallback: any active connected session
        return self.search([
            ('active', '=', True),
            ('company_id', '=', company_id),
            ('status', '=', 'connected'),
        ], limit=1)

    # ──────────────────────────────────────────────────────────────────────
    # INBOX POLLING (auto-approve / auto-reject from email replies)
    # ──────────────────────────────────────────────────────────────────────

    @staticmethod
    def _detect_imap(email_addr):
        domain = email_addr.split('@')[-1].lower().strip()
        if domain in IMAP_PRESETS:
            return IMAP_PRESETS[domain]
        return ('imap.' + domain, 993, 'ssl')

    def _try_imap_login(self):
        """Quick IMAP login probe for connect-and-test.
        Returns (ok: bool, error: str)."""
        self.ensure_one()
        if not self.email_address or not self.app_password:
            return False, _("missing email or password")
        host, port, security = self._detect_imap(self.email_address)
        try:
            if security == 'ssl':
                conn = imaplib.IMAP4_SSL(host, port)
            else:
                conn = imaplib.IMAP4(host, port)
                if security == 'starttls':
                    conn.starttls()
            conn.login(self.email_address.strip(), self.app_password.strip())
            conn.logout()
            return True, ''
        except imaplib.IMAP4.error as e:
            text = str(e).lower()
            if 'authenticationfailed' in text or 'imap access is disabled' in text:
                return False, _("IMAP is disabled on this account")
            return False, _("IMAP login failed: %s") % str(e)
        except Exception as e:
            return False, _("Could not reach IMAP server: %s") % str(e)

    @staticmethod
    def _classify_reply(body):
        """Look at the first non-quoted line of the email body. Return
        'yes' / 'no' / None."""
        if not body:
            return None
        # Take the first 500 chars to avoid long signatures / quoted history.
        head = body[:500]
        # Strip quoted reply markers (>) and blank lines.
        clean_lines = []
        for line in head.splitlines():
            line = line.strip()
            if not line:
                continue
            # Skip "On <date>, <person> wrote:" markers
            if line.lower().startswith('on ') and 'wrote:' in line.lower():
                break
            # Strip leading > markers
            while line.startswith('>'):
                line = line[1:].lstrip()
            if not line:
                continue
            clean_lines.append(line)
            if len(clean_lines) >= 3:
                break
        if not clean_lines:
            return None
        first = clean_lines[0].lower()
        # Match common positive replies
        if first.startswith('yes') or first == 'y' or first.startswith('approve'):
            return 'yes'
        # Match common negative replies
        if first.startswith('no') or first == 'n' or first.startswith('reject') or first.startswith('deny'):
            return 'no'
        return None

    @staticmethod
    def _decode_subject(raw_subject):
        if not raw_subject:
            return ''
        out = ''
        for content, encoding in email_lib.header.decode_header(raw_subject):
            if isinstance(content, bytes):
                out += content.decode(encoding or 'utf-8', errors='ignore')
            else:
                out += content
        return out

    @staticmethod
    def _extract_body(msg):
        """Return the plain-text body of an email.message.Message."""
        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_type() == 'text/plain' and 'attachment' not in (part.get('Content-Disposition') or ''):
                    payload = part.get_payload(decode=True) or b''
                    return payload.decode(part.get_content_charset() or 'utf-8', errors='ignore')
            for part in msg.walk():
                if part.get_content_type() == 'text/html':
                    payload = part.get_payload(decode=True) or b''
                    html = payload.decode(part.get_content_charset() or 'utf-8', errors='ignore')
                    return re.sub(r'<[^>]+>', '\n', html)
        else:
            payload = msg.get_payload(decode=True) or b''
            return payload.decode(msg.get_content_charset() or 'utf-8', errors='ignore')
        return ''

    def _poll_replies(self):
        """Cron entry. Returns the diagnostic dict from _do_poll."""
        self.ensure_one()
        if not self.enable_reply_polling:
            return {'skipped': True, 'reason': 'polling disabled'}
        result = self._do_poll(verbose=False)
        # Update visible status on the session record
        summary = self._format_poll_summary(result)
        self.sudo().write({
            'last_poll_at': fields.Datetime.now(),
            'last_message': summary[:500],
        })
        return result

    def _do_poll(self, verbose=False):
        """Connect via IMAP, scan recent + unseen messages across INBOX
        and (Gmail) All Mail, dispatch YES/NO actions. Returns a structured
        diagnostic dict."""
        self.ensure_one()
        report = {
            'session': self.email_address,
            'folders_scanned': [],
            'unseen_count': 0,
            'recent_count': 0,
            'token_messages': [],   # list of dicts per token-tagged message
            'processed': 0,
            'errors': [],
        }

        if not self.email_address or not self.app_password:
            report['errors'].append('Missing email address or App Password.')
            return report

        host, port, security = self._detect_imap(self.email_address)
        try:
            if security == 'ssl':
                conn = imaplib.IMAP4_SSL(host, port)
            else:
                conn = imaplib.IMAP4(host, port)
                if security == 'starttls':
                    conn.starttls()
            conn.login(self.email_address.strip(), self.app_password.strip())
        except Exception as e:
            report['errors'].append('IMAP login failed: %s' % str(e))
            _logger.warning("IMAP login failed for %s: %s", self.email_address, e)
            return report

        try:
            domain = (self.email_address or '').split('@')[-1].lower().strip()
            # Pick which folders to scan; for Gmail also try All Mail so
            # archived / labeled messages aren't missed.
            folders = ['INBOX']
            if domain in ('gmail.com', 'googlemail.com'):
                folders.append('"[Gmail]/All Mail"')

            seen_uids_per_folder = set()
            for folder in folders:
                try:
                    typ, _data = conn.select(folder, readonly=False)
                    if typ != 'OK':
                        continue
                    report['folders_scanned'].append(folder.strip('"'))
                except Exception as e:
                    _logger.warning("IMAP select %s failed: %s", folder, e)
                    continue

                # Collect message UIDs from BOTH UNSEEN and RECENT (last 1 day)
                uid_set = set()
                for crit in ['(UNSEEN)', '(SINCE %s)' % self._imap_since_date(days=1)]:
                    try:
                        ok, data = conn.search(None, crit)
                        if ok == 'OK' and data and data[0]:
                            for uid in data[0].split():
                                uid_set.add(uid)
                    except Exception as e:
                        _logger.warning("IMAP search %s failed in %s: %s", crit, folder, e)

                # Track counts only the first folder pass
                if folder == 'INBOX':
                    try:
                        ok, data = conn.search(None, '(UNSEEN)')
                        report['unseen_count'] = len(data[0].split()) if (ok == 'OK' and data and data[0]) else 0
                        ok, data = conn.search(None, '(SINCE %s)' % self._imap_since_date(days=1))
                        report['recent_count'] = len(data[0].split()) if (ok == 'OK' and data and data[0]) else 0
                    except Exception:
                        pass

                for uid in uid_set:
                    if (folder, uid) in seen_uids_per_folder:
                        continue
                    seen_uids_per_folder.add((folder, uid))
                    try:
                        self._process_imap_message(conn, uid, report)
                    except Exception as e:
                        _logger.exception("Failed to process IMAP msg %s: %s", uid, e)
                        report['errors'].append('msg %s: %s' % (uid, e))
        finally:
            try:
                conn.logout()
            except Exception:
                pass

        return report

    @staticmethod
    def _imap_since_date(days=1):
        """IMAP requires SINCE <DD-Mon-YYYY> format."""
        from datetime import datetime, timedelta
        d = datetime.utcnow() - timedelta(days=days)
        return d.strftime('%d-%b-%Y')

    def _format_poll_summary(self, report):
        if report.get('skipped'):
            return 'Polling disabled'
        if report['errors']:
            return 'Last poll %s: ERROR — %s' % (
                fields.Datetime.now().strftime('%H:%M'),
                '; '.join(report['errors'])[:200],
            )
        token_n = len(report['token_messages'])
        proc_n = report['processed']
        return (
            'Last poll %s: unseen=%d, recent=%d, token-tagged=%d, processed=%d'
            % (
                fields.Datetime.now().strftime('%Y-%m-%d %H:%M'),
                report['unseen_count'],
                report['recent_count'],
                token_n,
                proc_n,
            )
        )

    def _process_imap_message(self, conn, uid, report=None):
        """Fetch one message, parse for [CF-TOKEN-...] + YES/NO, and act.
        Appends a diagnostic entry to `report` if provided."""
        result, data = conn.fetch(uid, '(RFC822)')
        if result != 'OK' or not data or not data[0]:
            return
        msg = email_lib.message_from_bytes(data[0][1])
        subject = self._decode_subject(msg.get('Subject') or '')
        from_addr = msg.get('From') or ''

        m = TOKEN_RE.search(subject)
        if not m:
            return  # not a reply we care about (don't even add to report)
        token = m.group(1)

        body = self._extract_body(msg)
        decision = self._classify_reply(body)
        first_line = self._first_clean_line(body)

        entry = {
            'from': from_addr,
            'subject': subject,
            'token': token,
            'first_line': first_line,
            'decision': decision or 'UNKNOWN',
            'action': None,
            'facility': None,
        }

        facility = self.env['credit.facility'].sudo().search(
            [('email_approval_token', '=', token)], limit=1,
        )
        if not facility:
            entry['action'] = 'NO_MATCHING_FACILITY'
            _logger.warning("IMAP reply token %s — no matching credit.facility", token)
            try:
                conn.store(uid, '+FLAGS', '\\Seen')
            except Exception:
                pass
            if report is not None:
                report['token_messages'].append(entry)
            return
        entry['facility'] = facility.name

        if facility.state != 'submitted':
            entry['action'] = 'SKIPPED (facility state=%s)' % facility.state
            _logger.info(
                "IMAP reply for facility %s but state is %s — ignoring",
                facility.name, facility.state,
            )
            try:
                conn.store(uid, '+FLAGS', '\\Seen')
            except Exception:
                pass
            if report is not None:
                report['token_messages'].append(entry)
            return

        if not decision:
            entry['action'] = 'UNCLASSIFIED (replied with: %r)' % (first_line or '')
            facility.message_post(body=(
                "📧 Email reply received from %s but could not be classified as YES or NO. "
                "First line read: <code>%s</code>. Please reply again with YES or NO."
            ) % (from_addr, first_line or '(empty)'))
            try:
                conn.store(uid, '+FLAGS', '\\Seen')
            except Exception:
                pass
            if report is not None:
                report['token_messages'].append(entry)
            return

        try:
            if decision == 'yes':
                facility.action_approve()
                facility.message_post(body=(
                    "✅ Auto-APPROVED via email reply from %s." % from_addr
                ))
                entry['action'] = 'APPROVED'
                _logger.info("Facility %s auto-approved via email reply", facility.name)
            else:
                facility.action_reject()
                facility.message_post(body=(
                    "❌ Auto-REJECTED via email reply from %s." % from_addr
                ))
                entry['action'] = 'REJECTED'
                _logger.info("Facility %s auto-rejected via email reply", facility.name)
            if report is not None:
                report['processed'] += 1
        except Exception as e:
            entry['action'] = 'ACTION_FAILED: %s' % e
            _logger.exception("Failed to act on facility %s: %s", facility.name, e)
            facility.message_post(body=(
                "📧 Email reply '%s' was received but the action failed: %s"
                % (decision.upper(), e)
            ))

        try:
            conn.store(uid, '+FLAGS', '\\Seen')
        except Exception:
            pass

        if report is not None:
            report['token_messages'].append(entry)

    @staticmethod
    def _first_clean_line(body):
        if not body:
            return ''
        for line in body[:500].splitlines():
            line = line.strip()
            if not line:
                continue
            if line.lower().startswith('on ') and 'wrote:' in line.lower():
                break
            while line.startswith('>'):
                line = line[1:].lstrip()
            if line:
                return line
        return ''

    def action_force_poll_now(self):
        """Manual diagnostic — runs the poll synchronously and shows a
        human-readable report."""
        self.ensure_one()
        report = self._do_poll(verbose=True)
        # Persist summary
        self.sudo().write({
            'last_poll_at': fields.Datetime.now(),
            'last_message': self._format_poll_summary(report)[:500],
        })

        # Build human-readable message
        lines = []
        lines.append("Polled inbox of %s" % self.email_address)
        if report.get('folders_scanned'):
            lines.append("Folders scanned: %s" % ', '.join(report['folders_scanned']))
        lines.append(
            "  • UNSEEN messages: %d" % report['unseen_count']
        )
        lines.append(
            "  • RECENT (24h) messages: %d" % report['recent_count']
        )
        lines.append(
            "  • Token-tagged messages: %d" % len(report['token_messages'])
        )
        lines.append("  • Processed: %d" % report['processed'])

        if report['errors']:
            lines.append("")
            lines.append("ERRORS:")
            for err in report['errors']:
                lines.append("  - %s" % err)

        if report['token_messages']:
            lines.append("")
            lines.append("Per-message detail:")
            for e in report['token_messages']:
                lines.append("  • From: %s" % e['from'])
                lines.append("    Token: %s  →  facility: %s" % (e['token'], e['facility'] or 'NOT FOUND'))
                lines.append("    First line: %r  →  %s" % (e['first_line'], e['decision']))
                lines.append("    Action: %s" % e['action'])
        else:
            lines.append("")
            lines.append("No token-tagged replies were found.")
            lines.append("Common causes:")
            lines.append("  - Reply hasn't arrived yet (wait a moment, try again).")
            lines.append("  - Original email was sent BEFORE the YES/NO template was deployed →")
            lines.append("    re-submit the credit facility to get a token-tagged email.")
            lines.append("  - Approver replied without the [CF-TOKEN-...] left in the subject.")

        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('Force Poll — Result'),
                'message': '\n'.join(lines),
                'type': 'success' if report['processed'] else 'warning',
                'sticky': True,
            }
        }

    @api.model
    def _cron_poll_replies(self):
        """Cron entry point: poll all eligible sessions."""
        sessions = self.search([
            ('active', '=', True),
            ('enable_reply_polling', '=', True),
            ('status', '=', 'connected'),
        ])
        for s in sessions:
            try:
                s._poll_replies()
            except Exception as e:
                _logger.exception("email.session %s poll failed: %s", s.email_address, e)
