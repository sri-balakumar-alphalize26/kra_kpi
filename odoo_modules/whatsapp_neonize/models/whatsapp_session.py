"""WhatsApp session -- backed by a self-hosted Evolution API server.

HISTORY / WHY THE DIRECTORY IS STILL CALLED `whatsapp_neonize`
--------------------------------------------------------------
This module used to run neonize (a Python binding over the whatsmeow Go
library) *inside the Odoo worker*. That is gone. The technical module name is
deliberately retained because:

  * `kra_kpi_module/__manifest__.py` depends on `whatsapp_neonize`, and
    uninstalling a dependency makes Odoo cascade-uninstall the dependant --
    which would DROP roughly 40 `kra_*` / `kpi_*` tables.
  * `kra_kpi_module/views/menu.xml` references the XML id
    `whatsapp_neonize.action_whatsapp_session` at load time.
  * `kra_kpi_module/models/kpi_inbound_patch.py` imports
    `odoo.addons.whatsapp_neonize.models.whatsapp_session.WhatsAppSession`
    by path, inside a try/except that silently degrades the whole inbound
    reply parser to a no-op if the import fails.

So: same module name, same model names, same method signatures -- new transport.

WHAT CHANGED, AND WHY IT MATTERS
--------------------------------
* No in-process client, no per-session thread, no module-level client registry.
  Sending is a stateless HTTP POST, so any worker/cron/webhook can send. The old
  design kept the client in ONE worker's memory while `status` lived in
  Postgres, so other workers saw 'connected' and had no client to use.
* WhatsApp's client-version check is Evolution's problem now. This build died
  with `Client outdated (405)` because the whatsmeow version was compiled into
  neonize's bundled .dll and could not be updated from Odoo.
* Inbound arrives via ONE webhook (see controllers/evolution_webhook.py), not
  two drifted in-process callbacks. That also ends the double-fire of the
  sale.order credit parser, which used to run from the neonize callback AND
  again from kra_kpi's `whatsapp.message.create()` hook.
"""

import logging
import secrets

from odoo import models, fields, api, _
from odoo.exceptions import UserError

from . import wa_jid
from .evolution_api import (
    EvolutionClient,
    EvolutionError,
    EvolutionNotConnectedError,
    strip_data_uri,
    to_b64,
)

_logger = logging.getLogger(__name__)

# The sale.order credit-approval confirmation used to sleep this long so the
# order state settled before the confirmation went out. Kept as a constant so
# it is visible and tunable -- it runs on the inbound webhook thread, and
# Evolution's own WEBHOOK_REQUEST_TIMEOUT_MS defaults to 60000.
CREDIT_REPLY_SETTLE_SECONDS = 8

# Events we subscribe to. MESSAGES_SET is deliberately ABSENT: it replays the
# entire chat history on first connect -- thousands of rows, each one firing
# kra_kpi's create hook.
#
# These strings are validated against a hard enum by Evolution; an unknown one
# makes the whole /webhook/set call 400 with an empty body (the reason is only
# in Evolution's own stdout). Note the inconsistency, verified on 2.3.7:
# GROUPS_UPSERT is PLURAL but GROUP_UPDATE is SINGULAR.
WEBHOOK_EVENTS = [
    'QRCODE_UPDATED',
    'CONNECTION_UPDATE',
    'LOGOUT_INSTANCE',
    'REMOVE_INSTANCE',
    'MESSAGES_UPSERT',
    'MESSAGES_UPDATE',
    'SEND_MESSAGE',
    'GROUPS_UPSERT',
    'GROUP_UPDATE',
    'GROUP_PARTICIPANTS_UPDATE',
]

# How long without any sign of life before `wa_is_alive()` re-probes the server.
STALE_AFTER_MINUTES = 10

PARAM_GLOBAL_KEY = 'whatsapp_neonize.evolution_global_apikey'
PARAM_STALE_MIN = 'whatsapp_neonize.wa_stale_after_minutes'
# Set to 0 to allow more than one session connected at the same time.
PARAM_SINGLE_SESSION = 'whatsapp_neonize.single_connected_session'


class WhatsAppSession(models.Model):
    _name = 'whatsapp.session'
    _description = 'WhatsApp Session'
    _rec_name = 'name'

    name = fields.Char(
        'Session Name', required=True, default='Default',
        help='A friendly name for this WhatsApp session',
    )
    status = fields.Selection([
        ('disconnected', 'Disconnected'),
        ('waiting_qr', 'Scan QR Code'),
        ('reconnecting', 'Reconnecting'),
        ('connected', 'Connected'),
        ('error', 'Error'),
    ], string='Status', default='disconnected', readonly=True)
    phone_number = fields.Char('Connected Phone',
        help='Phone number with country code (e.g., 96895689684). Auto-detected on connect, or enter manually.')
    country_code = fields.Char(
        'Country Code', compute='_compute_country_code', store=True,
        help='Auto-detected calling code from connected phone number (e.g., 91 for India, 968 for Oman)',
    )
    country_name = fields.Char(
        'Country', compute='_compute_country_code', store=True,
    )
    qr_image = fields.Binary('QR Code', readonly=True, attachment=False)
    qr_last_update = fields.Datetime('QR Last Updated', readonly=True)
    db_path = fields.Char(
        'Session DB Path', readonly=True,
        help='DEPRECATED. The neonize session file. Evolution stores the session '
             'server-side, so nothing writes this any more. The column is kept '
             'because controllers/kra_api.py reads it.',
    )
    active = fields.Boolean(default=True)
    auto_reconnect = fields.Boolean(
        'Auto Reconnect', default=True,
        help='Automatically reconnect when Odoo restarts',
    )
    message_ids = fields.One2many(
        'whatsapp.message', 'session_id', string='Messages',
    )
    company_id = fields.Many2one(
        'res.company', string='Company',
        default=lambda self: self.env.company,
    )
    message_count = fields.Integer(
        compute='_compute_message_count', string='Messages',
    )
    error_message = fields.Text('Last Error', readonly=True)
    test_wa_phone = fields.Char(
        'Test Phone', help='Enter a full international phone number (e.g. 919876543210) then click Test WA Check')
    test_wa_result = fields.Text('WA Check Result', readonly=True)

    # ---------------- Evolution binding ----------------
    base_url = fields.Char(
        'Evolution URL', help='e.g. http://localhost:8080 (no trailing slash)')
    instance_name = fields.Char(
        'Instance Name', help="Evolution's instanceName, e.g. kra-kpi")
    instance_id = fields.Char('Instance Id', readonly=True)
    instance_token = fields.Char(
        'Instance Token', groups='base.group_system',
        help='Per-instance apikey returned by /instance/create.')
    webhook_secret = fields.Char(
        'Webhook Secret', groups='base.group_system', copy=False)
    webhook_url = fields.Char(
        'Webhook URL', compute='_compute_webhook_url',
        help='Register this exact URL with Evolution.')
    pairing_code = fields.Char('Pairing Code', readonly=True)
    last_state_check = fields.Datetime('Last State Check', readonly=True)
    last_webhook_at = fields.Datetime('Last Webhook', readonly=True)
    last_connection_event = fields.Datetime('Last Connection Event', readonly=True)
    send_delay_ms = fields.Integer(
        'Send Delay (ms)', default=0,
        help='Passed to Evolution as `delay` to throttle bursts.')

    # ---- is Evolution actually delivering HERE? ------------------------- #
    # An instance can be 'open' while its webhook points somewhere else: at a
    # different Odoo database, or at a port that no longer listens. Sending
    # keeps working, so the session reads "Connected" and every incoming
    # message is dropped with no error anywhere.
    #
    # That is not hypothetical. Moving the served database to KRAKPINEW left
    # the webhook registered against the old database's session id and
    # secret; the auto-reconnect cron then saw state 'open' and set this
    # session to connected. "Connected" meant "can send", and nobody could
    # tell from the screen that nothing could arrive.
    webhook_ok = fields.Boolean(
        'Webhook Points Here', readonly=True,
        help='Checked against Evolution. False means messages are being '
             'delivered somewhere else.')
    webhook_actual = fields.Char(
        'Evolution Is Delivering To', readonly=True,
        help='What Evolution has registered, as opposed to what this session '
             'expects.')
    webhook_checked_at = fields.Datetime('Webhook Checked', readonly=True)

    # ----------------------------------------------------------
    # Computed
    # ----------------------------------------------------------

    # Phone prefix -> country mapping
    PHONE_PREFIX_MAP = {
        '91': ('India', 'IN'), '1': ('USA/Canada', 'US'), '44': ('UK', 'GB'),
        '971': ('UAE', 'AE'), '966': ('Saudi Arabia', 'SA'), '968': ('Oman', 'OM'),
        '974': ('Qatar', 'QA'), '965': ('Kuwait', 'KW'), '973': ('Bahrain', 'BH'),
        '962': ('Jordan', 'JO'), '961': ('Lebanon', 'LB'), '90': ('Turkey', 'TR'),
        '20': ('Egypt', 'EG'), '65': ('Singapore', 'SG'), '60': ('Malaysia', 'MY'),
        '66': ('Thailand', 'TH'), '62': ('Indonesia', 'ID'), '63': ('Philippines', 'PH'),
        '81': ('Japan', 'JP'), '82': ('South Korea', 'KR'), '86': ('China', 'CN'),
        '61': ('Australia', 'AU'), '64': ('New Zealand', 'NZ'), '94': ('Sri Lanka', 'LK'),
        '880': ('Bangladesh', 'BD'), '977': ('Nepal', 'NP'), '92': ('Pakistan', 'PK'),
        '93': ('Afghanistan', 'AF'), '33': ('France', 'FR'), '49': ('Germany', 'DE'),
        '39': ('Italy', 'IT'), '34': ('Spain', 'ES'), '31': ('Netherlands', 'NL'),
        '41': ('Switzerland', 'CH'), '7': ('Russia', 'RU'), '55': ('Brazil', 'BR'),
        '52': ('Mexico', 'MX'), '234': ('Nigeria', 'NG'), '254': ('Kenya', 'KE'),
        '27': ('South Africa', 'ZA'), '353': ('Ireland', 'IE'), '47': ('Norway', 'NO'),
        '46': ('Sweden', 'SE'), '45': ('Denmark', 'DK'), '358': ('Finland', 'FI'),
        '48': ('Poland', 'PL'), '43': ('Austria', 'AT'), '32': ('Belgium', 'BE'),
        '351': ('Portugal', 'PT'), '30': ('Greece', 'GR'), '36': ('Hungary', 'HU'),
        '40': ('Romania', 'RO'), '380': ('Ukraine', 'UA'), '84': ('Vietnam', 'VN'),
        '95': ('Myanmar', 'MM'), '856': ('Laos', 'LA'), '855': ('Cambodia', 'KH'),
        '852': ('Hong Kong', 'HK'), '853': ('Macau', 'MO'), '886': ('Taiwan', 'TW'),
    }

    @api.depends('phone_number')
    def _compute_country_code(self):
        for rec in self:
            phone = (rec.phone_number or '').lstrip('+').replace(' ', '').replace('-', '')
            rec.country_code = ''
            rec.country_name = ''
            if phone:
                # Try longest prefix first for accuracy (e.g., 971 before 97)
                for prefix in sorted(rec.PHONE_PREFIX_MAP.keys(), key=len, reverse=True):
                    if phone.startswith(prefix):
                        rec.country_code = prefix
                        rec.country_name = rec.PHONE_PREFIX_MAP[prefix][0]
                        break

    def _compute_message_count(self):
        for rec in self:
            rec.message_count = self.env['whatsapp.message'].search_count([
                ('session_id', '=', rec.id)
            ])

    def _compute_webhook_url(self):
        base = self.env['ir.config_parameter'].sudo().get_param(
            'web.base.url', 'http://localhost:8069').rstrip('/')
        for rec in self:
            if rec.id and rec.webhook_secret:
                rec.webhook_url = '%s/whatsapp/evolution/%s/%s' % (
                    base, rec.id, rec.webhook_secret)
            else:
                rec.webhook_url = ''

    # ----------------------------------------------------------
    # Evolution plumbing
    # ----------------------------------------------------------
    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            vals.setdefault('webhook_secret', secrets.token_urlsafe(32))
        return super().create(vals_list)

    def _global_apikey(self):
        return self.env['ir.config_parameter'].sudo().get_param(PARAM_GLOBAL_KEY, '')

    def _api(self, admin=False):
        """Return an EvolutionClient. `admin=True` uses the global key."""
        self.ensure_one()
        if not self.base_url:
            raise UserError(_('Set the Evolution URL on session "%s" first.') % self.name)
        key = self._global_apikey() if admin else (
            self.sudo().instance_token or self._global_apikey())
        if not key:
            raise UserError(_(
                'No Evolution API key. Set the system parameter "%s" '
                '(Settings > Technical > System Parameters).') % PARAM_GLOBAL_KEY)
        return EvolutionClient(self.base_url, key)

    def _get_client(self):
        """Guard used by every send path.

        LOAD-BEARING ERROR TEXT. kra_kpi_module/models/kpi_notification_queue.py
        lowercases this message and tests for 'not connected' / 'scan the qr' to
        decide whether to stop retrying. Do not reword those two fragments.
        """
        self.ensure_one()
        if self.status != 'connected' or not self.instance_name:
            raise UserError(_(
                "WhatsApp is not connected for session '%s'. "
                "Please scan the QR code first."
            ) % self.name)
        return self._api(), self.instance_name

    def _get_connected_client(self):
        """Back-compat alias -- kra_kpi called this on the neonize build."""
        return self._get_client()[0]

    def wa_is_alive(self):
        """Cheap liveness check with a live re-probe when the data is stale.

        Replaces the old `_wa_socket_alive` helper, which read the in-memory
        client registry that no longer exists.
        """
        self.ensure_one()
        if self.status != 'connected':
            return False
        stale_min = int(self.env['ir.config_parameter'].sudo().get_param(
            PARAM_STALE_MIN, STALE_AFTER_MINUTES) or STALE_AFTER_MINUTES)
        newest = max([d for d in (self.last_webhook_at, self.last_state_check) if d] or [False])
        if newest and (fields.Datetime.now() - newest).total_seconds() < stale_min * 60:
            return True
        try:
            self._sync_connection_state()
        except Exception as exc:
            _logger.warning('wa_is_alive probe failed for %s: %s', self.name, exc)
            return self.status == 'connected'
        return self.status == 'connected'

    def _sync_connection_state(self):
        """Authoritative reconciliation against the Evolution server."""
        for rec in self:
            if not rec.base_url or not rec.instance_name:
                continue
            try:
                state = rec._api().connection_state(rec.instance_name)
            except EvolutionError as exc:
                rec.sudo().write({
                    'status': 'error',
                    'error_message': str(exc)[:1000],
                    'last_state_check': fields.Datetime.now(),
                })
                continue
            vals = {'last_state_check': fields.Datetime.now()}
            if state == 'open':
                vals.update(status='connected', error_message=False, qr_image=False)
                if not rec.phone_number:
                    vals.update(rec._owner_phone_vals())
                # 'open' only means the phone is linked. Ask where Evolution
                # is delivering before calling this connected on screen.
                vals.update(rec._check_webhook())
            elif state == 'connecting':
                vals['status'] = 'waiting_qr' if rec.qr_image else 'reconnecting'
            elif state == 'close':
                vals['status'] = 'disconnected'
            rec.sudo().write(vals)
        return True

    def _owner_phone_vals(self):
        """Read the linked number from Evolution (replaces get_me() sniffing)."""
        self.ensure_one()
        try:
            for inst in self._api().fetch_instances():
                if (inst.get('name') or inst.get('instanceName')) == self.instance_name:
                    owner = inst.get('ownerJid') or ''
                    if owner:
                        return {'phone_number': owner.split('@', 1)[0]}
        except EvolutionError:
            pass
        return {}

    def _log_outgoing(self, target, body, status, wa_id=None, err=None, message_type='text'):
        """The ONE place an outgoing row is written (was 6 near-identical copies)."""
        self.ensure_one()
        vals = {
            'session_id': self.id,
            'phone': target,
            'message': body,
            'direction': 'outgoing',
            'status': status,
        }
        for fname, value in (('wa_message_id', wa_id),
                             ('error_message', err),
                             ('message_type', message_type),
                             ('remote_jid', target),
                             ('from_me', True)):
            if value and fname in self.env['whatsapp.message']._fields:
                vals[fname] = value
        return self.env['whatsapp.message'].sudo().create(vals)

    # ----------------------------------------------------------
    # Credit approval reply (sale.order) -- preserved verbatim.
    # kra_kpi_module/models/kpi_inbound_patch.py chains onto this BY NAME and
    # reassigns it; the signature and the name are a contract.
    # ----------------------------------------------------------
    @staticmethod
    def _process_credit_reply_instant(pool, uid, session_id, phone_clean, msg_text):
        """Parse an incoming message for "1-SOxxx" / "2-SOxxx" pattern
        and act on the matched sale.order."""
        import re
        import time
        pattern = re.compile(r'^([12])-([A-Za-z0-9]+)$')
        body = (msg_text or '').strip()
        match = pattern.match(body)
        if not match:
            return False

        action_code = match.group(1)
        order_name = match.group(2).upper()
        action = "APPROVE" if action_code == "1" else "REJECT"

        _logger.info(
            "INSTANT credit reply: %s for %s from %s",
            action, order_name, phone_clean,
        )

        try:
            with pool.cursor() as cr:
                env = api.Environment(cr, uid, {})
                SaleOrder = env.get('sale.order')
                if SaleOrder is None:
                    _logger.info("sale.order model unavailable — skipping credit reply")
                    return True

                order = SaleOrder.sudo().search(
                    [('name', '=ilike', order_name)], limit=1,
                )
                if not order:
                    _logger.error("Order not found: %s", order_name)
                    WhatsAppSession._send_reply_bg(
                        pool, uid, session_id, phone_clean,
                        f"Order not found: {order_name}",
                    )
                    return True

                current_status = getattr(order, 'credit_approval_status', False)
                if current_status in ('approved', 'rejected'):
                    WhatsAppSession._send_reply_bg(
                        pool, uid, session_id, phone_clean,
                        f"Order *{order_name}* was already {current_status}.",
                    )
                    return True

                currency = order.currency_id.symbol or '$'

                if action == "APPROVE":
                    approve = getattr(order, 'action_approve_credit_override', None)
                    if not approve:
                        _logger.warning(
                            "sale.order.action_approve_credit_override missing — "
                            "credit reply received but no handler exists"
                        )
                        return True
                    order.sudo().action_approve_credit_override()
                    cr.commit()
                    time.sleep(CREDIT_REPLY_SETTLE_SECONDS)
                    WhatsAppSession._send_reply_bg(
                        pool, uid, session_id, phone_clean,
                        f"*ORDER APPROVED*\n\n"
                        f"Order *{order.name}* approved!\n"
                        f"Customer: {order.partner_id.name}\n"
                        f"Amount: {currency} {order.amount_total:,.2f}",
                    )
                else:
                    reject = getattr(order, 'action_reject_credit_override', None)
                    if not reject:
                        _logger.warning(
                            "sale.order.action_reject_credit_override missing"
                        )
                        return True
                    order.sudo().action_reject_credit_override()
                    cr.commit()
                    WhatsAppSession._send_reply_bg(
                        pool, uid, session_id, phone_clean,
                        f"*ORDER REJECTED*\n\n"
                        f"Order *{order.name}* rejected.\n"
                        f"Customer: {order.partner_id.name}\n"
                        f"Amount: {currency} {order.amount_total:,.2f}",
                    )
                return True
        except Exception as e:
            _logger.error(
                "Instant credit processing error for %s: %s",
                order_name, e, exc_info=True,
            )
            return True

    @staticmethod
    def _send_reply_bg(pool, uid, session_id, phone, message):
        """Send a reply from a background/parser context, on its own cursor.

        Signature is a contract: kra_kpi_module/models/kpi_inbound_patch.py
        imports and calls this directly. It now goes through the ORM send
        method, which is group-aware -- the old implementation called neonize's
        build_jid() and so produced `120363...@g.us@s.whatsapp.net` for groups.
        """
        try:
            with pool.cursor() as cr:
                env = api.Environment(cr, uid, {})
                session = env['whatsapp.session'].sudo().browse(session_id)
                if not session.exists():
                    _logger.warning('Reply skipped: session %s is gone', session_id)
                    return
                session.send_message(phone, message)
                cr.commit()
        except Exception as e:
            _logger.error("Reply failed to %s: %s", phone, e)

    # ----------------------------------------------------------
    # Actions
    # ----------------------------------------------------------
    def action_connect(self):
        """Create the instance if needed, register the webhook, fetch the QR."""
        self.ensure_one()
        if not self.base_url:
            raise UserError(_('Set the Evolution URL first (e.g. http://localhost:8080).'))
        if not self.instance_name:
            raise UserError(_('Set the Evolution Instance Name first (e.g. kra-kpi).'))
        if not self.webhook_secret:
            self.sudo().webhook_secret = secrets.token_urlsafe(32)

        api_admin = self._api(admin=True)
        hook = self.webhook_url
        try:
            state = api_admin.connection_state(self.instance_name)
        except EvolutionError:
            state = ''

        try:
            if not state:
                created = api_admin.create_instance(
                    self.instance_name, webhook_url=hook, events=WEBHOOK_EVENTS,
                    headers={'X-Odoo-WA-Token': self.sudo().webhook_secret})
                inst = (created or {}).get('instance') or {}
                self.sudo().write({
                    'instance_id': inst.get('instanceId') or False,
                    'instance_token': created.get('hash') or False,
                })
                qr = (created or {}).get('qrcode') or {}
            else:
                # Instance already exists (e.g. scanned via Evolution's own
                # manager). Point it at us and pull a fresh QR if needed.
                try:
                    api_admin.set_webhook(
                        self.instance_name, hook, events=WEBHOOK_EVENTS,
                        headers={'X-Odoo-WA-Token': self.sudo().webhook_secret})
                except EvolutionError as exc:
                    _logger.warning('Could not set webhook for %s: %s',
                                    self.instance_name, exc)
                qr = {} if state == 'open' else api_admin.connect_instance(self.instance_name)
        except EvolutionError as exc:
            self.sudo().write({'status': 'error', 'error_message': str(exc)[:1000]})
            raise UserError(_('Evolution refused the connect: %s') % exc)

        vals = {'error_message': False}
        b64 = strip_data_uri(qr.get('base64') or '')
        if b64:
            vals.update(qr_image=b64, qr_last_update=fields.Datetime.now(),
                        status='waiting_qr', pairing_code=qr.get('pairingCode') or False)
        self.sudo().write(vals)
        self._sync_connection_state()
        return True

    def action_disconnect(self):
        self.ensure_one()
        try:
            self._api(admin=True).logout_instance(self.instance_name)
        except EvolutionError as exc:
            _logger.warning('Logout failed for %s: %s', self.instance_name, exc)
        self.sudo().write({'status': 'disconnected', 'qr_image': False})
        return True

    def action_refresh_status(self):
        self._sync_connection_state()
        return True

    # ----------------------------------------------------------
    # Webhook truth-telling
    # ----------------------------------------------------------
    def _check_webhook(self):
        """Compare what Evolution has registered with what this session needs.

        Returns values to write. Never raises: a session that cannot be
        checked is reported as unchecked, not as broken.
        """
        self.ensure_one()
        vals = {'webhook_checked_at': fields.Datetime.now()}
        try:
            found = self._api(admin=True).find_webhook(self.instance_name)
        except Exception as exc:
            _logger.warning('Could not read the webhook for %s: %s',
                            self.instance_name, exc)
            return vals
        actual = (found.get('url') or '').strip()
        enabled = bool(found.get('enabled'))
        vals['webhook_actual'] = actual
        vals['webhook_ok'] = bool(
            enabled and actual and actual == (self.webhook_url or '').strip())
        if not vals['webhook_ok']:
            _logger.warning(
                'whatsapp.session %s: Evolution is delivering to %r, not %r. '
                'Incoming messages are being dropped.',
                self.name, actual or '(nothing)', self.webhook_url)
        return vals

    def action_register_webhook(self):
        """Point Evolution back at this session, without a full reconnect.

        Separate from Connect on purpose: Connect may create an instance or
        pull a QR, and the only thing wrong here is where the callbacks go.
        """
        self.ensure_one()
        if not self.base_url or not self.instance_name:
            raise UserError(_('Set the Evolution URL and Instance Name first.'))
        if not self.webhook_secret:
            self.sudo().webhook_secret = secrets.token_urlsafe(32)
        try:
            self._api(admin=True).set_webhook(
                self.instance_name, self.webhook_url, events=WEBHOOK_EVENTS,
                headers={'X-Odoo-WA-Token': self.sudo().webhook_secret})
        except EvolutionError as exc:
            raise UserError(_('Evolution refused it: %s') % exc)
        self.sudo().write(self._check_webhook())
        if not self.webhook_ok:
            raise UserError(_(
                'Evolution accepted the change but still reports %s. '
                'Check the Evolution server.') % (self.webhook_actual or '-'))
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {'type': 'success', 'title': _('Done'),
                       'sticky': False,
                       'message': _('Messages will now arrive here.')},
        }

    # ----------------------------------------------------------
    # ONE CONNECTED SESSION AT A TIME
    #
    # Three different places set status='connected': _sync_connection_state,
    # the CONNECTION_UPDATE webhook, and action_connect by way of the first.
    # Putting the rule in any one of them leaves the other two able to produce
    # a second connected row, so it lives in write() -- the one place all
    # three pass through, and the one place a fourth caller would pass through
    # too.
    #
    # It matters because a session is not just a label: each one owns an
    # Evolution instance and a webhook. Two connected sessions means two
    # instances delivering into the same Odoo, and a reply can go out on the
    # wrong number.
    # ----------------------------------------------------------
    def _single_session_enforced(self):
        """On unless somebody deliberately turns it off.

        A company running two numbers on purpose -- say OTP on one and client
        groups on another -- has a legitimate reason to want both connected.
        They set this to 0.
        """
        return self.env['ir.config_parameter'].sudo().get_param(
            PARAM_SINGLE_SESSION, '1') not in ('0', 'false', 'False', '')

    def _demote_other_sessions(self):
        """Disconnect every other session, and say so on the row."""
        self.ensure_one()
        others = self.sudo().search([
            ('id', '!=', self.id),
            ('status', 'in', ('connected', 'waiting_qr', 'reconnecting')),
        ])
        for other in others:
            # NEVER log out an instance this session is also using. Two rows
            # pointing at one instance name would otherwise mean connecting
            # the second kills the first AND itself, since Evolution only
            # knows the instance, not which Odoo row asked.
            same_instance = (other.instance_name or '') == (self.instance_name or '')
            if other.base_url and other.instance_name and not same_instance:
                try:
                    other._api(admin=True).logout_instance(other.instance_name)
                except Exception as exc:
                    # Best effort. The Odoo side is marked disconnected either
                    # way -- a row that says "connected" when it is not is
                    # worse than an instance left running on the server.
                    _logger.warning(
                        'Could not log %s out of Evolution: %s',
                        other.instance_name, exc)
            other.write({
                'status': 'disconnected',
                'qr_image': False,
                'error_message': _(
                    'Disconnected automatically on %(when)s because "%(who)s" '
                    'connected. Only one WhatsApp session runs at a time. '
                    'Press Connect WhatsApp here to switch back.'
                ) % {'when': fields.Datetime.to_string(fields.Datetime.now()),
                     'who': self.name or _('another session')},
            })
            _logger.info('whatsapp.session: %s disconnected because %s connected',
                         other.name, self.name)
        return others

    def write(self, vals):
        res = super().write(vals)
        # Only on the transition INTO connected, and never from inside the
        # demotion itself -- that writes 'disconnected', so it cannot recurse,
        # but the context flag makes that explicit rather than incidental.
        if (vals.get('status') == 'connected'
                and not self.env.context.get('skip_single_session')
                and self._single_session_enforced()):
            for rec in self.with_context(skip_single_session=True):
                rec._demote_other_sessions()
        return res

    def action_capture_phone(self):
        """Read the linked number back from Evolution."""
        self.ensure_one()
        vals = self._owner_phone_vals()
        if not vals:
            raise UserError(_('Evolution did not report a linked number yet.'))
        self.sudo().write(vals)
        return True

    def action_view_messages(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('WhatsApp Messages'),
            'res_model': 'whatsapp.message',
            'view_mode': 'list,form',
            'domain': [('session_id', '=', self.id)],
            'context': {'default_session_id': self.id},
        }

    def action_send_message_wizard(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Send WhatsApp Message'),
            'res_model': 'whatsapp.send.message.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {'default_session_id': self.id},
        }

    # ----------------------------------------------------------
    # Sending -- signatures are a contract, do not change them
    # ----------------------------------------------------------
    @staticmethod
    def _clean_phone(phone):
        """Kept for callers; delegates to the one JID helper."""
        return wa_jid.normalize_target(phone)

    def send_message(self, phone, message):
        """Send a text. Group-aware: Evolution accepts `...@g.us` directly, so
        the kra_kpi `send_message` override that existed only to hand-build a
        group JID is no longer needed (and must be removed)."""
        self.ensure_one()
        client, instance = self._get_client()
        target = wa_jid.normalize_target(phone)
        if not target:
            raise UserError(_('No valid WhatsApp number in "%s".') % phone)
        try:
            res = client.send_text(instance, target, message, delay=self.send_delay_ms)
        except EvolutionError as exc:
            self._log_outgoing(target, message, 'failed', err=str(exc)[:1000])
            raise UserError(_('WhatsApp send failed: %s') % exc)
        wa_id = ((res or {}).get('key') or {}).get('id')
        self._log_outgoing(target, message, 'sent', wa_id=wa_id)
        return True

    def send_image(self, phone, image_data, caption=''):
        self.ensure_one()
        client, instance = self._get_client()
        target = wa_jid.normalize_target(phone)
        try:
            res = client.send_media(instance, target, 'image', to_b64(image_data),
                                    mimetype='image/png', caption=caption,
                                    file_name='image.png', delay=self.send_delay_ms)
        except EvolutionError as exc:
            self._log_outgoing(target, caption or '[Image]', 'failed',
                               err=str(exc)[:1000], message_type='image')
            raise UserError(_('WhatsApp image send failed: %s') % exc)
        wa_id = ((res or {}).get('key') or {}).get('id')
        self._log_outgoing(target, caption or '[Image]', 'sent',
                           wa_id=wa_id, message_type='image')
        return True

    def send_document(self, phone, file_data, filename,
                      caption='', mimetype='application/pdf'):
        self.ensure_one()
        client, instance = self._get_client()
        target = wa_jid.normalize_target(phone)
        try:
            res = client.send_media(instance, target, 'document', to_b64(file_data),
                                    mimetype=mimetype, caption=caption,
                                    file_name=filename, delay=self.send_delay_ms)
        except EvolutionError as exc:
            self._log_outgoing(target, caption or ('[Document: %s]' % filename), 'failed',
                               err=str(exc)[:1000], message_type='document')
            raise UserError(_('WhatsApp document send failed: %s') % exc)
        wa_id = ((res or {}).get('key') or {}).get('id')
        self._log_outgoing(target, caption or ('[Document: %s]' % filename), 'sent',
                           wa_id=wa_id, message_type='document')
        return True

    def send_audio(self, phone, audio_data, caption=''):
        """New capability: push-to-talk audio. Unused today; kept thin."""
        self.ensure_one()
        client, instance = self._get_client()
        target = wa_jid.normalize_target(phone)
        try:
            res = client.send_audio(instance, target, to_b64(audio_data),
                                    delay=self.send_delay_ms)
        except EvolutionError as exc:
            self._log_outgoing(target, '[Audio]', 'failed',
                               err=str(exc)[:1000], message_type='audio')
            raise UserError(_('WhatsApp audio send failed: %s') % exc)
        wa_id = ((res or {}).get('key') or {}).get('id')
        self._log_outgoing(target, '[Audio]', 'sent', wa_id=wa_id, message_type='audio')
        return True

    def send_buttons(self, phone, title, description, buttons, footer=''):
        """Tappable reply buttons (max 3). Falls back to a numbered text menu
        if the server refuses -- a flow must never dead-end because an
        interactive message was rejected."""
        self.ensure_one()
        client, instance = self._get_client()
        target = wa_jid.normalize_target(phone)
        try:
            res = client.send_buttons(instance, target, title, description,
                                      buttons, footer=footer,
                                      delay=self.send_delay_ms)
        except EvolutionError as exc:
            _logger.warning('sendButtons refused (%s) -- falling back to text', exc)
            lines = ['*%s*' % title, description, '']
            lines += ['%d - %s' % (i + 1, b['text']) for i, b in enumerate(buttons)]
            return self.send_message(phone, '\n'.join(lines))
        wa_id = ((res or {}).get('key') or {}).get('id')
        self._log_outgoing(target, '[Buttons] %s' % description, 'sent', wa_id=wa_id)
        return True

    def send_list(self, phone, title, description, button_text, rows,
                  section_title='', footer=''):
        """Tappable picker (max 10 rows), with the same text fallback."""
        self.ensure_one()
        client, instance = self._get_client()
        target = wa_jid.normalize_target(phone)
        try:
            res = client.send_list(instance, target, title, description,
                                   button_text, rows,
                                   section_title=section_title, footer=footer,
                                   delay=self.send_delay_ms)
        except EvolutionError as exc:
            _logger.warning('sendList refused (%s) -- falling back to text', exc)
            lines = ['*%s*' % title, description, '']
            lines += ['%d - %s' % (i + 1, r['title']) for i, r in enumerate(rows)]
            return self.send_message(phone, '\n'.join(lines))
        wa_id = ((res or {}).get('key') or {}).get('id')
        self._log_outgoing(target, '[List] %s' % description, 'sent', wa_id=wa_id)
        return True

    def send_poll(self, phone, question, options, selectable=1):
        """Tappable single-choice menu. See EvolutionClient.send_poll for why
        this is used instead of buttons/lists."""
        self.ensure_one()
        client, instance = self._get_client()
        target = wa_jid.normalize_target(phone)
        try:
            res = client.send_poll(instance, target, question, options,
                                   selectable=selectable, delay=self.send_delay_ms)
        except EvolutionError as exc:
            _logger.warning('sendPoll refused (%s) -- falling back to text', exc)
            lines = ['*%s*' % question, '']
            lines += ['%d - %s' % (i + 1, o) for i, o in enumerate(options)]
            return self.send_message(phone, '\n'.join(lines))
        wa_id = ((res or {}).get('key') or {}).get('id')
        self._log_outgoing(target, '[Poll] %s' % question, 'sent',
                           wa_id=wa_id, message_type='poll')
        return True

    def send_odoo_report(self, phone, report_xmlid, record, caption=''):
        self.ensure_one()
        pdf_content, _content_type = self.env['ir.actions.report']._render_qweb_pdf(
            report_xmlid, record.ids)
        return self.send_document(
            phone, pdf_content, f"{record.display_name}.pdf", caption)

    def is_on_whatsapp(self, phone):
        """True/False/None. Never raises -- callers treat None as 'unknown'."""
        self.ensure_one()
        try:
            client, instance = self._get_client()
            target = wa_jid.normalize_target(phone)
            for row in client.check_numbers(instance, [target]):
                if (row.get('number') or '').endswith(target) or \
                   (row.get('jid') or '').startswith(target):
                    return bool(row.get('exists'))
            return False
        except Exception as exc:
            _logger.warning('is_on_whatsapp failed for %s: %s', phone, exc)
            return None

    def action_test_wa_check(self):
        self.ensure_one()
        if not self.test_wa_phone:
            raise UserError(_('Enter a phone number to test.'))
        result = self.is_on_whatsapp(self.test_wa_phone)
        if result is None:
            text = 'Could not check — see the Last Error field / server log.'
        else:
            text = 'ON WhatsApp' if result else 'NOT on WhatsApp'
        self.sudo().test_wa_result = '%s → %s' % (self.test_wa_phone, text)
        return True

    # ----------------------------------------------------------
    # Lifecycle / crons
    # ----------------------------------------------------------
    def _stop_client(self):
        """No in-process client any more. Kept so existing callers still work."""
        self.sudo().write({'status': 'disconnected'})
        return True

    def _reconnect_session(self):
        """Name is a contract -- kra_kpi's notification retry cron calls it."""
        self.ensure_one()
        try:
            if self.base_url and self.instance_name:
                self._api().connect_instance(self.instance_name)
            self._sync_connection_state()
            return self.status == 'connected'
        except Exception as exc:
            _logger.warning('Reconnect failed for %s: %s', self.name, exc)
            return False

    @api.model
    def _cron_auto_reconnect(self):
        """Reconciles every active session against Evolution. This is what
        kills the zombie-session class of bug: state lives in exactly two
        places (Postgres and Evolution) and this makes them agree."""
        sessions = self.sudo().search([('active', '=', True), ('base_url', '!=', False)])
        for session in sessions:
            try:
                session._sync_connection_state()
                if session.status in ('disconnected', 'error') and session.auto_reconnect:
                    session._reconnect_session()
            except Exception as exc:
                _logger.warning('State sync failed for %s: %s', session.name, exc)
        return True

    @api.model
    def _cron_health_check(self):
        """Folded into _cron_auto_reconnect. Kept because data/ir_cron.xml
        references this method by name."""
        return True

    @api.model
    def _cron_resolve_lids(self):
        """Neonize-specific LID resolution. Evolution supplies the number
        directly, so this is now a no-op. Name kept for the ir_cron record."""
        return True

    def action_resolve_pending_lids(self):
        return True

    def unlink(self):
        for rec in self:
            if rec.message_count:
                raise UserError(_(
                    "Session '%s' has %s messages. Deleting it would delete them "
                    "all (whatsapp.message.session_id cascades). Disconnect it "
                    "instead, or archive it."
                ) % (rec.name, rec.message_count))
        return super().unlink()
