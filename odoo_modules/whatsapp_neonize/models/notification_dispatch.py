"""Generic Email + WhatsApp dispatch helpers used by sale.order, purchase.order,
account.move, and pos.order. Reads the active whatsapp.config record for
toggles, admin email, from email, and POS recipient lists."""

from odoo import models, fields, api, _
from odoo.exceptions import UserError
import base64
import logging

_logger = logging.getLogger(__name__)


class WhatsAppEmailDispatch(models.AbstractModel):
    _name = 'whatsapp.email.dispatch'
    _description = 'Cross-channel (Email + WhatsApp) Notification Dispatcher'

    @api.model
    def get_config(self):
        return self.env['whatsapp.config'].sudo().search(
            [('company_id', '=', self.env.company.id)], limit=1,
        ) or self.env['whatsapp.config'].sudo().search([], limit=1)

    @api.model
    def get_default_email_session(self):
        config = self.get_config()
        if config and config.default_email_session_id:
            return config.default_email_session_id
        return self.env['email.session'].sudo().get_default_session()

    @api.model
    def get_default_whatsapp_session(self):
        config = self.get_config()
        if config and config.default_whatsapp_session_id:
            return config.default_whatsapp_session_id
        return self.env['whatsapp.session'].sudo().search(
            [('status', '=', 'connected')], limit=1,
        )

    @api.model
    def send_record(self, record, partner, report_xmlid,
                    subject, body_html=None, wa_caption=None,
                    send_email=True, send_whatsapp=True,
                    email_session=None, whatsapp_session=None):
        """Send `record` PDF to `partner` via the requested channels.
        `email_session` and `whatsapp_session` may be passed explicitly to
        override the configured defaults. Failures log to the chatter and
        never block the originating action. Returns dict of channel -> bool."""
        result = {'email': False, 'whatsapp': False}
        if not partner:
            if record:
                record.message_post(body=_("Auto-send skipped: no partner on record."))
            return result

        errors = []
        if send_email:
            try:
                sess = email_session or self.get_default_email_session()
                self._send_email(record, partner, report_xmlid, subject, body_html, sess)
                result['email'] = True
                if record:
                    record.message_post(body=_("📧 Email sent to %s") % partner.email)
            except Exception as e:
                _logger.exception("dispatch email failed: %s", e)
                if record:
                    record.message_post(body=_("📧 Email FAILED: %s") % str(e))
                errors.append(_("Email: %s") % str(e))

        if send_whatsapp:
            try:
                sess = whatsapp_session or self.get_default_whatsapp_session()
                self._send_whatsapp(record, partner, report_xmlid, wa_caption or subject, sess)
                result['whatsapp'] = True
                if record:
                    target = (getattr(partner, 'mobile', '') or '') or (partner.phone or '')
                    record.message_post(body=_("📱 WhatsApp sent to %s") % (target or partner.display_name))
            except Exception as e:
                _logger.exception("dispatch whatsapp failed: %s", e)
                if record:
                    record.message_post(body=_("📱 WhatsApp FAILED: %s") % str(e))
                errors.append(_("WhatsApp: %s") % str(e))

        result['errors'] = errors
        return result

    # ──────────────────────────────────────────────────────────────────────

    def _send_email(self, record, partner, report_xmlid, subject, body_html, email_session=None):
        if not partner.email:
            raise UserError(_(
                "Partner '%s' has no email address — cannot send."
            ) % partner.display_name)

        if not email_session:
            raise UserError(_(
                "No connected Email Session.\n\n"
                "Add one under WhatsApp and Email → Email Sessions, mark it Default, "
                "and try again."
            ))

        from_email = email_session.get_from_email()
        body = body_html or (
            "<p>Dear %s,</p><p>Please find attached <strong>%s</strong>.</p>"
            "<p>Regards,<br/>%s</p>" % (
                partner.name,
                getattr(record, 'display_name', '') or getattr(record, 'name', ''),
                self.env.company.name,
            )
        )

        attachments = []
        if report_xmlid and record:
            try:
                pdf_content, _ext = self.env['ir.actions.report']._render_qweb_pdf(
                    report_xmlid, res_ids=record.ids,
                )
                fname = (getattr(record, 'name', None) or 'document').replace('/', '_')
                attachments.append((f'{fname}.pdf', pdf_content))
            except Exception as e:
                _logger.warning("Could not render report %s for %s: %s",
                                report_xmlid, record, e)

        mail_vals = {
            'subject': subject,
            'body_html': body,
            'email_to': partner.email,
            'email_from': from_email,
            'auto_delete': False,
        }
        if email_session.mail_server_id:
            mail_vals['mail_server_id'] = email_session.mail_server_id.id
        if attachments:
            mail_vals['attachment_ids'] = [
                (0, 0, {
                    'name': fname,
                    'datas': base64.b64encode(content),
                    'res_model': 'mail.mail',
                    'mimetype': 'application/pdf',
                })
                for (fname, content) in attachments
            ]
        self.env['mail.mail'].sudo().create(mail_vals).send(raise_exception=True)

    def _send_whatsapp(self, record, partner, report_xmlid, caption, whatsapp_session=None):
        # Odoo 19 builds may not have res.partner.mobile — defensive lookup.
        mobile_raw = getattr(partner, 'mobile', '') or ''
        phone_raw = partner.phone or ''
        phone = mobile_raw or phone_raw
        if not phone:
            raise UserError(_(
                "Partner '%s' has no phone/mobile number — set one on the partner "
                "to enable WhatsApp auto-send."
            ) % partner.display_name)
        clean = self._clean_phone(phone)

        session = whatsapp_session
        if not session:
            raise UserError(_(
                "No connected WhatsApp session. Open WhatsApp and Email → WhatsApp Sessions, "
                "scan the QR, then try again."
            ))
        if session.status != 'connected':
            raise UserError(_(
                "WhatsApp session '%s' is not connected (status: %s). "
                "Reconnect it before retrying."
            ) % (session.name, session.status))

        # Try PDF send if the session supports it; fall back to text.
        if report_xmlid and record and hasattr(session, 'send_odoo_report'):
            try:
                session.send_odoo_report(clean, report_xmlid, record, caption=caption)
                _logger.info("dispatch: WhatsApp PDF sent to %s", clean)
                return
            except Exception as e:
                _logger.warning(
                    "dispatch: send_odoo_report failed (%s) — falling back to text",
                    e,
                )
        session.send_message(clean, caption)
        _logger.info("dispatch: WhatsApp text sent to %s", clean)

    @staticmethod
    def _clean_phone(phone):
        if not phone:
            return ''
        for ch in ('+', ' ', '-', '(', ')'):
            phone = phone.replace(ch, '')
        return phone
