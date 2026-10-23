"""↩ Send back with proof: every time a client sends finished work back, one
row -- the round, what is still wrong, who said it, and the photos / videos /
voice notes that show it.

The client's reason has always been written over pre_approval_feedback, so
the second send-back erased the first. These rows keep every round; the task
screens (Odoo board, web, app, the developer's WhatsApp page) list them with
the files to open or play.

Files follow the chat's rules (models/kpi_chat.py): photos, videos and audio
only, at most 10, 50 MB each. They live in kpi.file.attachment (sendback_id).
"""

import base64
import logging

from odoo import _, api, fields, models

from .kpi_chat import chat_check_files, chat_file_kind, chat_files_label

_logger = logging.getLogger(__name__)

SENDBACK_SOURCES = [('whatsapp', 'WhatsApp page'), ('odoo', 'Odoo'), ('web', 'Web'), ('app', 'App')]


class KpiClientSendback(models.Model):
    _name = 'kpi.client.sendback'
    _description = 'Client send-back (what is still wrong, with proof)'
    _order = 'kpi_id, round desc, id desc'

    kpi_id = fields.Many2one('kra.kpi', string='Task', required=True, ondelete='cascade', index=True)
    round = fields.Integer(required=True, default=1)
    reason = fields.Text(required=True)
    by_name = fields.Char(string='Sent back by')
    partner_id = fields.Many2one('res.partner', ondelete='set null')
    source = fields.Selection(SENDBACK_SOURCES, default='web')
    file_ids = fields.One2many('kpi.file.attachment', 'sendback_id', string='Proof')

    def _serialize(self, file_url='/kpi/sendback/file/%d'):
        self.ensure_one()
        files = [{'id': f.id, 'name': f.file_name or '', 'mime': f.mimetype or '',
                  'kind': chat_file_kind(f.file_name, f.mimetype) or 'image',
                  'size': f.file_size or 0, 'url': file_url % f.id} for f in self.file_ids]
        return {
            'id': self.id, 'round': self.round, 'reason': self.reason or '',
            'by': self.by_name or '', 'source': self.source or '',
            'at': fields.Datetime.to_string(self.create_date),
            'files': files, 'files_label': chat_files_label([f['kind'] for f in files]),
        }


class KraKpiSendback(models.Model):
    _inherit = 'kra.kpi'

    sendback_ids = fields.One2many('kpi.client.sendback', 'kpi_id', string='Sent back')

    def sendback_rows(self, file_url='/kpi/sendback/file/%d'):
        """Every round, newest first, for the task screens."""
        self.ensure_one()
        rounds = self.env['kpi.client.sendback'].sudo().search([('kpi_id', '=', self.id)], order='round desc, id desc')
        return [s._serialize(file_url) for s in rounds]

    def _finish_payload(self):
        """Every task screen (board card, web, app) gets the rounds with the
        finish fields. Only tasks the client sent back pay for the search."""
        out = super()._finish_payload()
        out['sendbacks'] = self.sendback_rows() if self.client_revert_count else []
        return out

    def record_client_final_decision(self, action, partner_name='', feedback='', source='web',
                                     ip=None, user_agent=None, partner_id=None, files=None,
                                     sendback_source=None):
        """files: [(name, bytes, mimetype)] -- the proof sent with ↩ Send back.
        Checked before anything moves, so a refused file never half-sends."""
        files = files or []
        if action == 'reject' and files:
            chat_check_files(files)
        res = super().record_client_final_decision(
            action, partner_name=partner_name, feedback=feedback, source=source,
            ip=ip, user_agent=user_agent, partner_id=partner_id)
        if action == 'reject' and isinstance(res, dict) and res.get('status') == 'ok':
            try:
                self._sendback_record(feedback, partner_name, partner_id, sendback_source or source, files)
            except Exception as exc:
                # The send-back itself already happened; losing the proof is
                # bad, refusing the client's decision would be worse.
                _logger.exception('send-back proof for %s not saved: %s', self.id, exc)
        return res

    def _sendback_record(self, reason, by_name, partner_id, source, files):
        self.ensure_one()
        if source not in dict(SENDBACK_SOURCES):
            source = 'web'
        rnd = self.env['kpi.client.sendback'].sudo().search_count([('kpi_id', '=', self.id)]) + 1
        sb = self.env['kpi.client.sendback'].sudo().create({
            'kpi_id': self.id, 'round': rnd, 'reason': (reason or '').strip()[:4000] or '-',
            'by_name': (by_name or '').strip()[:120] or False,
            'partner_id': partner_id or False, 'source': source,
        })
        Att = self.env['kpi.file.attachment'].sudo()
        for seq, (name, raw, mime) in enumerate(files or []):
            Att.create({'sendback_id': sb.id, 'file': base64.b64encode(raw),
                        'file_name': name or 'file', 'mimetype': mime or False,
                        'file_size': len(raw), 'sequence': seq})
        return sb

    def _sendback_latest(self):
        self.ensure_one()
        return self.env['kpi.client.sendback'].sudo().search([('kpi_id', '=', self.id)], limit=1)

    def _finish_tell_revert(self):
        """The text notes (kpi_finish.py), then the proof: the team group and
        the developer hear what was attached, and the developer gets their
        page link, where the photos / videos / voice notes open."""
        super()._finish_tell_revert()
        Report = self.env['kpi.wa.group.report'].sudo()
        for rec in self:
            sb = rec._sendback_latest()
            if not sb or not sb.file_ids:
                continue
            label = chat_files_label([chat_file_kind(f.file_name, f.mimetype) for f in sb.file_ids])
            ref, dev = rec._finish_ref(), rec.user_id
            rec._finish_alpha(_('📎 The client attached proof to *%(ref)s* (round %(round)d): %(label)s. '
                                'Open the task to see it.') % {'ref': ref, 'round': sb.round, 'label': label},
                              users=dev)
            if dev:
                link = ''
                try:
                    link = rec._chat_page_link(dev).replace('#chat', '#sendback')
                except Exception as exc:
                    _logger.warning('send-back page link for %s failed: %s', rec.id, exc)
                rec._finish_dm(dev, _('📎 The client attached %(label)s to show what is wrong on %(ref)s.%(link)s') % {
                    'label': label, 'ref': ref,
                    'link': ('\n\n' + _('See / hear it here (only for you, 2 hours):\n%s') % link) if link else ''})
