import os
import threading
import logging
import base64
import io
import time

from odoo import models, fields, api, _
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

# ============================================================
# Global state — survives across requests within same worker
# ============================================================
_wa_clients = {}       # session_id -> neonize NewClient
_wa_qr_data = {}       # session_id -> raw QR string
_wa_qr_image = {}      # session_id -> base64 PNG
_wa_status = {}        # session_id -> status string
_wa_threads = {}       # session_id -> threading.Thread
_wa_locks = {}         # session_id -> threading.Lock


def _ensure_session_dir():
    """Create session storage directory.

    Priority:
    1. ODOO_WA_SESSION_DIR environment variable (set this on your server)
    2. /var/lib/odoo/whatsapp_sessions  (standard Odoo data dir)
    3. Module's own sessions/ folder (local dev fallback)
    """
    import os

    # Allow override via env var — recommended for production servers
    env_path = os.environ.get('ODOO_WA_SESSION_DIR')
    if env_path:
        os.makedirs(env_path, exist_ok=True)
        return env_path

    # Try standard Odoo data directory
    standard_path = '/var/lib/odoo/whatsapp_sessions'
    try:
        os.makedirs(standard_path, exist_ok=True)
        # Quick write-test
        test_file = os.path.join(standard_path, '.write_test')
        with open(test_file, 'w') as f:
            f.write('ok')
        os.remove(test_file)
        return standard_path
    except (PermissionError, OSError):
        pass

    # Fall back to module's own folder (works for local dev)
    module_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(module_dir, 'sessions')
    try:
        os.makedirs(path, exist_ok=True)
        return path
    except (PermissionError, OSError):
        pass

    # Last resort: use /tmp (sessions won't survive reboot but at least it works)
    tmp_path = '/tmp/odoo_whatsapp_sessions'
    os.makedirs(tmp_path, exist_ok=True)
    _logger.warning(
        "WhatsApp sessions stored in /tmp — they will not survive a reboot. "
        "Set ODOO_WA_SESSION_DIR env variable to a persistent writable path."
    )
    return tmp_path


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
        ('connected', 'Connected'),
        ('error', 'Error'),
    ], string='Status', default='disconnected', readonly=True)
    phone_number = fields.Char('Connected Phone', readonly=True)
    qr_image = fields.Binary('QR Code', readonly=True, attachment=False)
    qr_last_update = fields.Datetime('QR Last Updated', readonly=True)
    db_path = fields.Char('Session DB Path', readonly=True)
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

    # ----------------------------------------------------------
    # Computed
    # ----------------------------------------------------------
    def _compute_message_count(self):
        for rec in self:
            rec.message_count = self.env['whatsapp.message'].search_count([
                ('session_id', '=', rec.id)
            ])

    # ----------------------------------------------------------
    # Actions
    # ----------------------------------------------------------
    def action_connect(self):
        """Start WhatsApp connection — generates QR in Odoo UI."""
        self.ensure_one()

        try:
            from neonize.client import NewClient
            from neonize.events import ConnectedEv, MessageEv
        except ImportError as e:
            raise UserError(_(
                "Neonize library not installed.\n\n"
                "Please run on the server:\n"
                "  pip install neonize qrcode[pil] Pillow\n\n"
                "Error: %s"
            ) % str(e))

        session_id = self.id
        db_name = self.env.cr.dbname
        session_dir = _ensure_session_dir()
        db_path = os.path.join(session_dir, f"{db_name}_session_{session_id}.db")

        _logger.info(
            "WhatsApp connect: session=%s, db_path=%s, dir_writable=%s",
            session_id, db_path, os.access(session_dir, os.W_OK)
        )

        # Stop existing client if running
        self._stop_client()

        # Only ONE WhatsApp session may be active at a time — take over from any others.
        for _other_id in list(_wa_clients.keys()):
            if _other_id != session_id:
                _other = self.browse(_other_id)
                if _other.exists():
                    _other._stop_client()
                    _other.write({'status': 'disconnected', 'qr_image': False})

        self.write({
            'db_path': db_path,
            'status': 'waiting_qr',
            'error_message': False,
            'qr_image': False,
        })

        client = NewClient(db_path)
        _wa_clients[session_id] = client
        _wa_status[session_id] = 'waiting_qr'
        _wa_locks[session_id] = threading.Lock()

        pool = self.pool
        uid = self.env.uid

        # --- Event: QR Code ---
        def _on_qr(client_ref, qr_data):
            _logger.info("WhatsApp QR received for session %s", session_id)
            try:
                import qrcode as qrcode_lib

                # qr_data is raw bytes — decode to string directly
                qr_string = qr_data.decode('utf-8') if isinstance(qr_data, bytes) else str(qr_data)

                _logger.info("QR string length: %s", len(qr_string))
                _wa_qr_data[session_id] = qr_string
                _wa_status[session_id] = 'waiting_qr'

                # Generate QR image
                qr_img = qrcode_lib.make(qr_string)
                buffer = io.BytesIO()
                qr_img.save(buffer, format='PNG')
                qr_b64 = base64.b64encode(buffer.getvalue())
                _wa_qr_image[session_id] = qr_b64

                # Save to DB with new cursor
                with pool.cursor() as cr:
                    env = api.Environment(cr, uid, {})
                    env['whatsapp.session'].browse(session_id).write({
                        'qr_image': qr_b64,
                        'status': 'waiting_qr',
                        'qr_last_update': fields.Datetime.now(),
                    })
            except Exception as e:
                _logger.error("QR generation error: %s", e, exc_info=True)

        # --- Event: Connected ---
        def _on_connected(client_ref, event):
            _logger.info("WhatsApp CONNECTED for session %s", session_id)
            _wa_status[session_id] = 'connected'
            _wa_qr_data.pop(session_id, None)
            _wa_qr_image.pop(session_id, None)

            try:
                with pool.cursor() as cr:
                    env = api.Environment(cr, uid, {})
                    env['whatsapp.session'].browse(session_id).write({
                        'status': 'connected',
                        'qr_image': False,
                        'error_message': False,
                    })
            except Exception as e:
                _logger.error("Connection status update error: %s", e)

        # --- Event: Message Received ---
        def _on_message(client_ref, event):
            try:
                info = getattr(event, 'Info', None)
                source = getattr(info, 'MessageSource', None) if info else None
                if source is None:
                    return
                if getattr(source, 'IsFromMe', False) or getattr(source, 'IsGroup', False):
                    return  # ignore our own + group messages
                chat = getattr(source, 'Chat', None)
                is_group = str(getattr(chat, 'Server', '') or '') == 'g.us'
                # Resolve the real phone number (handle WhatsApp LID addressing)
                sender_jid = getattr(source, 'Sender', None)
                try:
                    from neonize.utils.jid import jid_is_lid
                    if sender_jid is not None and jid_is_lid(sender_jid):
                        alt = getattr(source, 'SenderAlt', None)
                        if alt is not None and alt.ListFields():
                            sender_jid = alt
                except Exception:
                    pass
                phone_clean = str(getattr(sender_jid, 'User', '') or '')
                if not phone_clean and chat is not None:
                    phone_clean = str(getattr(chat, 'User', '') or '')
                if not phone_clean:
                    return

                m = getattr(event, 'Message', None)
                msg_text = ''
                is_audio = False
                if m is not None:
                    try:
                        if m.HasField('buttonsResponseMessage'):
                            msg_text = m.buttonsResponseMessage.selectedButtonID
                        elif m.HasField('templateButtonReplyMessage'):
                            msg_text = m.templateButtonReplyMessage.selectedID
                        elif m.HasField('listResponseMessage'):
                            msg_text = m.listResponseMessage.singleSelectReply.selectedRowID
                        elif m.HasField('interactiveResponseMessage'):
                            import json as _json
                            nfr = m.interactiveResponseMessage.nativeFlowResponseMessage
                            msg_text = _json.loads(nfr.paramsJSON or '{}').get('id', '')
                        elif m.HasField('conversation'):
                            msg_text = m.conversation or ''
                        elif m.HasField('extendedTextMessage'):
                            msg_text = m.extendedTextMessage.text or ''
                        elif m.HasField('audioMessage'):
                            is_audio = True
                    except Exception as ee:
                        _logger.error("WA extract error: %s", ee)

                # Voice note -> download bytes (no cursor needed for the download)
                audio_bytes = b''
                if is_audio:
                    try:
                        cobj = _wa_clients.get(session_id)
                        audio_bytes = cobj.download_any(m) if cobj else b''
                    except Exception as de:
                        _logger.error("Audio download error: %s", de)

                with pool.cursor() as cr:
                    env = api.Environment(cr, uid, {})
                    engine = env['wa.report.engine'].sudo() if 'wa.report.engine' in env else None
                    if is_audio and audio_bytes and engine is not None:
                        try:
                            msg_text = engine.transcribe_audio_bytes(audio_bytes) or ''
                        except Exception as te:
                            _logger.error("Transcription error: %s", te)

                    _logger.info("WA incoming from %s (group=%s audio=%s): %r",
                                 phone_clean, is_group, is_audio, (msg_text or '')[:60])

                    env['whatsapp.message'].sudo().create({
                        'session_id': session_id,
                        'phone': phone_clean,
                        'message': msg_text or ('[voice note]' if is_audio else ''),
                        'direction': 'incoming',
                        'status': 'received',
                        'wa_message_id': str(getattr(info, 'ID', '')),
                    })

                    if not is_group and engine is not None:
                        try:
                            cfg = env['wa.reporting.config'].sudo().get_config()
                            if cfg and cfg.is_phone_allowed(phone_clean):
                                if msg_text:
                                    engine.handle_incoming(phone_clean, msg_text)
                                elif is_audio:
                                    engine.send_wa_text(phone_clean,
                                        "Sorry, I couldn't understand the voice note. "
                                        "Please type your request or send a clearer one.")
                        except Exception as fe:
                            _logger.error("Reporting forward error: %s", fe)
            except Exception as e:
                _logger.error("Message receive error: %s", e)

        # Register QR callback via client.qr() method
        client.qr(_on_qr)

        # Register other events
        client.event(ConnectedEv)(_on_connected)
        client.event(MessageEv)(_on_message)

        # Run in background thread
        def _run():
            try:
                client.connect()
            except Exception as e:
                _logger.error(
                    "WhatsApp client error for session %s: %s", session_id, e
                )
                _wa_status[session_id] = 'error'
                try:
                    with pool.cursor() as cr:
                        env = api.Environment(cr, uid, {})
                        env['whatsapp.session'].browse(session_id).write({
                            'status': 'error',
                            'error_message': str(e),
                        })
                except Exception:
                    pass

        thread = threading.Thread(
            target=_run, daemon=True,
            name=f"wa_neonize_{session_id}",
        )
        _wa_threads[session_id] = thread
        thread.start()

        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('WhatsApp'),
                'message': _(
                    'Connecting... QR Code will appear shortly. '
                    'Please wait a few seconds and refresh the page.'
                ),
                'type': 'info',
                'sticky': False,
            },
        }

    def action_disconnect(self):
        """Disconnect the WhatsApp session."""
        self.ensure_one()
        self._stop_client()
        self.write({
            'status': 'disconnected',
            'qr_image': False,
            'error_message': False,
        })

    def action_refresh_status(self):
        """Refresh the displayed status from in-memory state."""
        self.ensure_one()
        status = _wa_status.get(self.id, 'disconnected')
        vals = {'status': status}

        qr = _wa_qr_image.get(self.id)
        if qr and status == 'waiting_qr':
            vals['qr_image'] = qr

        if status == 'connected':
            vals['qr_image'] = False

        self.write(vals)

    def action_view_messages(self):
        """Open message list for this session."""
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
        """Open Send Message wizard for this session."""
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
    # Send Methods
    # ----------------------------------------------------------
    def _get_connected_client(self):
        """Return the neonize client or raise."""
        self.ensure_one()
        client = _wa_clients.get(self.id)
        if not client or _wa_status.get(self.id) != 'connected':
            raise UserError(_(
                "WhatsApp is not connected for session '%(name)s'.\n"
                "Please scan the QR code first.",
                name=self.name,
            ))
        return client

    @staticmethod
    def _clean_phone(phone):
        """Remove formatting from phone number."""
        if not phone:
            return ''
        for ch in ('+', ' ', '-', '(', ')'):
            phone = phone.replace(ch, '')
        return phone

    def send_message(self, phone, message):
        """Send a text message via WhatsApp."""
        self.ensure_one()
        client = self._get_connected_client()
        from neonize.utils import build_jid

        phone_clean = self._clean_phone(phone)
        if not phone_clean:
            raise UserError(_("No phone number provided."))

        jid = build_jid(phone_clean)

        try:
            client.send_message(jid, message)
            self.env['whatsapp.message'].sudo().create({
                'session_id': self.id,
                'phone': phone_clean,
                'message': message,
                'direction': 'outgoing',
                'status': 'sent',
            })
            _logger.info("WhatsApp message sent to %s", phone_clean)
            return True
        except Exception as e:
            _logger.error("Send message error: %s", e)
            self.env['whatsapp.message'].sudo().create({
                'session_id': self.id,
                'phone': phone_clean,
                'message': message,
                'direction': 'outgoing',
                'status': 'failed',
            })
            raise UserError(_("Failed to send message: %s") % str(e))

    def send_buttons(self, phone, body, buttons, include_numbers=True):
        """Send native-flow quick-reply tappable buttons via neonize."""
        self.ensure_one()
        client = self._get_connected_client()
        import json as _json
        from neonize.utils.jid import build_jid
        from neonize.proto.waE2E.WAWebProtobufsE2E_pb2 import Message, InteractiveMessage

        text_body = body
        if include_numbers:
            numbered = "\n".join("%d. %s" % (i, b['title']) for i, b in enumerate(buttons, 1))
            text_body = body + "\n\n" + numbered + \
                "\n\nTap a button, reply with the number, or type what you need."

        im = InteractiveMessage()
        im.body.text = text_body
        nf = im.nativeFlowMessage
        nf.messageVersion = 1
        for b in buttons:
            btn = nf.buttons.add()
            btn.name = "quick_reply"
            btn.buttonParamsJSON = _json.dumps({"display_text": b['title'], "id": b['id']})

        phone_clean = self._clean_phone(phone)
        jid = build_jid(phone_clean)
        client.send_message(jid, Message(interactiveMessage=im))
        self.env['whatsapp.message'].sudo().create({
            'session_id': self.id, 'phone': phone_clean,
            'message': body, 'direction': 'outgoing', 'status': 'sent',
        })
        return True

    def send_image(self, phone, image_data, caption=''):
        """Send an image via WhatsApp."""
        self.ensure_one()
        client = self._get_connected_client()
        from neonize.utils import build_jid

        phone_clean = self._clean_phone(phone)
        jid = build_jid(phone_clean)

        try:
            if isinstance(image_data, str):
                image_data = base64.b64decode(image_data)

            img_msg = client.build_image_message(image_data, caption=caption)
            client.send_message(jid, message=img_msg)

            self.env['whatsapp.message'].sudo().create({
                'session_id': self.id,
                'phone': phone_clean,
                'message': f"📷 Image: {caption}" if caption else "📷 Image",
                'direction': 'outgoing',
                'status': 'sent',
            })
            return True
        except Exception as e:
            raise UserError(_("Failed to send image: %s") % str(e))

    def send_document(self, phone, file_data, filename,
                      caption='', mimetype='application/pdf'):
        """Send a document (PDF, Excel, etc.) via WhatsApp."""
        self.ensure_one()
        client = self._get_connected_client()
        from neonize.utils import build_jid

        phone_clean = self._clean_phone(phone)
        jid = build_jid(phone_clean)

        try:
            if isinstance(file_data, str):
                file_data = base64.b64decode(file_data)

            doc_msg = client.build_document_message(
                file_data,
                caption=caption,
                filename=filename,
                mimetype=mimetype,
            )
            client.send_message(jid, message=doc_msg)

            self.env['whatsapp.message'].sudo().create({
                'session_id': self.id,
                'phone': phone_clean,
                'message': f"📎 {filename}" + (
                    f" - {caption}" if caption else ""
                ),
                'direction': 'outgoing',
                'status': 'sent',
            })
            return True
        except Exception as e:
            raise UserError(_("Failed to send document: %s") % str(e))

    def send_odoo_report(self, phone, report_xmlid, record, caption=''):
        """Generate an Odoo QWeb PDF report and send via WhatsApp."""
        self.ensure_one()
        try:
            pdf_content, content_type = self.env[
                'ir.actions.report'
            ]._render_qweb_pdf(report_xmlid, record.ids)
        except Exception as e:
            raise UserError(_("Failed to generate report: %s") % str(e))

        filename = f"{record.display_name or 'document'}.pdf"
        return self.send_document(phone, pdf_content, filename, caption)

    # ----------------------------------------------------------
    # Private Helpers
    # ----------------------------------------------------------
    def _stop_client(self):
        """Stop and clean up a neonize client."""
        sid = self.id
        if sid in _wa_clients:
            try:
                _wa_clients[sid].disconnect()
            except Exception:
                pass
            _wa_clients.pop(sid, None)
        _wa_status.pop(sid, None)
        _wa_qr_data.pop(sid, None)
        _wa_qr_image.pop(sid, None)
        _wa_threads.pop(sid, None)
        _wa_locks.pop(sid, None)

    # ----------------------------------------------------------
    # Cron: Auto-reconnect
    # ----------------------------------------------------------
    @api.model
    def _cron_auto_reconnect(self):
        """Cron job to reconnect sessions marked as auto_reconnect."""
        sessions = self.search([
            ('auto_reconnect', '=', True),
            ('db_path', '!=', False),
        ])
        for session in sessions:
            # Check if already connected in memory
            if _wa_status.get(session.id) == 'connected':
                continue
            if session.db_path and os.path.exists(session.db_path):
                _logger.info(
                    "Auto-reconnecting WhatsApp session: %s", session.name
                )
                try:
                    session.action_connect()
                except Exception as e:
                    _logger.error(
                        "Auto-reconnect failed for %s: %s", session.name, e
                    )

    @api.model
    def _cron_health_check(self):
        """Periodic health check — sync in-memory status to DB."""
        sessions = self.search([('active', '=', True)])
        for session in sessions:
            mem_status = _wa_status.get(session.id)
            if mem_status and mem_status != session.status:
                session.write({'status': mem_status})

    # ----------------------------------------------------------
    # Unlink
    # ----------------------------------------------------------
    def unlink(self):
        for session in self:
            session._stop_client()
        return super().unlink()

    # ----------------------------------------------------------
    # Auto-reconnect on server startup
    # ----------------------------------------------------------
    def _register_hook(self):
        """Called when registry is ready — auto-reconnect sessions."""
        super()._register_hook()
        import threading

        def _delayed_reconnect():
            import time
            time.sleep(10)  # Wait for Odoo to fully start
            try:
                from odoo import api
                with self.pool.cursor() as cr:
                    env = api.Environment(cr, 1, {})
                    sessions = env['whatsapp.session'].sudo().search([
                        ('auto_reconnect', '=', True),
                        ('db_path', '!=', False),
                    ])
                    for session in sessions:
                        import os
                        if session.db_path and os.path.exists(session.db_path):
                            _logger.info(
                                "Auto-reconnecting WhatsApp session on startup: %s",
                                session.name,
                            )
                            try:
                                session.action_connect()
                            except Exception as e:
                                _logger.error(
                                    "Auto-reconnect failed for %s: %s",
                                    session.name, e,
                                )
            except Exception as e:
                _logger.error("WhatsApp startup reconnect error: %s", e)

        t = threading.Thread(target=_delayed_reconnect, daemon=True, name="wa_startup_reconnect")
        t.start()
