"""The admin's WhatsApp decision page (/kpi/wa/admin/<token>).

One page for five decisions (models/kpi_wa_admin_link.py): a new client
request, a New Database, a Destroy request, a developer's own task, and
finished work to check. Every choice runs through the route or model method
the web admin uses -- with the request switched to that admin -- so what is
checked, written and told to the client is identical either way.

auth='public' like the other WhatsApp pages: the phone opening the link is not
logged in. The token is the key; the admin behind it must still be an admin,
and the task must still need the decision, every time the page is used.
"""

import json
import logging
import re

from markupsafe import Markup

from odoo import fields, http
from odoo.exceptions import UserError
from odoo.http import request

from .kpi_wa_approval import _render
from .kpi_reports_api import KpiReportsAPI
from .kra_api import KraKpiAPI
from ..models.kpi import DELIVERABLE_TYPES, deliverable_type_label
from ..models.kpi_wa_admin_link import _is_admin
from ..models.kpi_escalation import CHAIN_KINDS

_logger = logging.getLogger(__name__)

PRIORITIES = [('regular', 'Regular'), ('important', 'Important'), ('urgent', 'Urgent')]
DOC_TYPES = [('requirement', 'Requirement'), ('update', 'Update'), ('bug', 'Bug')]
_TITLES = {
    'new_request': ('🆕', 'New client request', 'Accept', 'Refuse'),
    'new_database': ('🗄️', 'New Database request', 'Approve', 'Refuse'),
    'disconnect': ('💥', 'Destroy Database request', 'Destroy it', 'Refuse'),
    'self_task': ('🧑‍💻', "Developer's own task", 'Accept', 'Send back'),
    'qa': ('✅', 'Finished work — check it', 'Approve', 'Send back'),
}


def _link_for(token):
    if not token or len(token) < 16 or len(token) > 64:
        return None
    link = request.env['kpi.wa.admin.link'].sudo().search([('token', '=', token)], limit=1)
    if not link or link.token != token:
        return None
    return link


def _fmt_dt(value, user=None):
    """Local time, the module's way (kpi.tz: company zone, else the admin's)."""
    if not value:
        return ''
    tz = (user.tz if user else None) or None
    return request.env['kpi.tz'].sudo().fmt(value, tz=tz, with_zone=False)


class KpiWaAdminDecide(http.Controller):

    # ------------------------------------------------------------------
    # what the page shows
    # ------------------------------------------------------------------
    def _developers(self):
        """Same list as the web's developer picker (/kra_kpi/get_users)."""
        users = request.env['res.users'].sudo().search(
            [('active', '=', True), ('share', '=', False), ('id', '!=', 1)])
        return [{'id': u.id, 'name': u.name}
                for u in users.filtered(lambda u: u.kpi_role != 'client').sorted('name')]

    def _files(self, kpi):
        names = []
        for p in request.env['kpi.progress'].sudo().search([('kpi_id', '=', kpi.id)], order='id'):
            if p.file_name:
                names.append(p.file_name)
            names += [a.file_name for a in request.env['kpi.file.attachment'].sudo().search(
                [('progress_id', '=', p.id)], order='sequence') if a.file_name]
        return names

    # Photos, videos and voice notes are shown on the page, not just named.
    _IMAGE_EXT = ('jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif')
    _VIDEO_EXT = ('mp4', 'webm', 'mov', 'm4v', '3gp', 'mkv', 'avi')
    _AUDIO_EXT = ('mp3', 'm4a', 'ogg', 'oga', 'opus', 'wav', 'aac', 'amr')

    def _media(self, token, k):
        """Every file on the task, each with a link through THIS admin link
        (/kpi/wa/admin/<token>/file) and what it is: image / video / audio / file."""
        out = []
        Att = request.env['kpi.file.attachment'].sudo()

        def add(name, kind, entry, att):
            ext = (name or '').rsplit('.', 1)[-1].lower() if '.' in (name or '') else ''
            typ = ('image' if ext in self._IMAGE_EXT else 'video' if ext in self._VIDEO_EXT
                   else 'audio' if ext in self._AUDIO_EXT else 'file')
            out.append({'name': name, 'type': typ,
                        'url': '/kpi/wa/admin/%s/file?kind=%s&entry=%s&att=%s' % (token, kind, entry, att)})

        for p in request.env['kpi.progress'].sudo().search([('kpi_id', '=', k.id)], order='id'):
            if p.file_name:
                add(p.file_name, 'progress', p.id, 0)
            for a in Att.search([('progress_id', '=', p.id)], order='sequence'):
                add(a.file_name, 'progress', p.id, a.id)
        for m in k.user_manual_ids:
            if m.file_name:
                add(m.file_name, 'manual', m.id, 0)
            for a in Att.search([('manual_id', '=', m.id)], order='sequence'):
                add(a.file_name, 'manual', m.id, a.id)
        return out

    def _details(self, link):
        """[(label, value)] for the top of the page. Admin eyes only."""
        k = link.kpi_id.sudo()
        rows = [('Ref', k.external_ref or '#%s' % k.id), ('Task', k.name or ''),
                ('Client', (k.client_kra_id or k.kra_id).name or '')]
        if k.kra_id and k.client_kra_id and k.kra_id != k.client_kra_id:
            rows.append(('Project', k.kra_id.display_name or ''))
        if k.client_db_id:
            rows.append(('Database', '%s (%s)' % (k.client_db_id.db_name or '',
                                                 k.client_db_id.server_id.poll_label() or '')))
        if link.kind == 'new_database':
            rows += [('Server', k.provision_server_id.poll_label() if k.provision_server_id
                      else (k.provision_server_other or '')),
                     ('New DB name', k.provision_db_name or ''),
                     ('Login', k.provision_username or ''),
                     ('Password', k.provision_password or '')]
        if link.kind == 'disconnect':
            db = link._db()
            if db:
                rows += [('Destroy', '%s (%s)' % (db.db_name, db.server_id.poll_label() or '')),
                         ('Reason', db.disconnect_reason_text or '')]
        rows.append(('Urgency', dict(k._fields['priority'].selection).get(k.priority, k.priority or '')))
        if k.deadline:
            rows.append(('Needed by', k.deadline.strftime('%d-%m-%Y')))
        if k.deliverable_type:
            rows.append(('Type', deliverable_type_label(k.deliverable_type, k.deliverable_other)))
        who = k.submitted_by_uid or k.requested_by_id
        rows.append(('Raised by', '%s · %s' % (who.name if who else '—', _fmt_dt(k.create_date, link.user_id))))
        if link.kind in ('self_task', 'qa') and k.user_id:
            rows.append(('Developer', k.user_id.name))
        if link.kind == 'self_task':
            est = '%sh %sm' % (k.estimate_hours or 0, k.estimate_minutes or 0)
            rows.append(('Their estimate', est))
        if link.kind == 'qa':
            secs = int(k.timer_total_seconds or 0)
            rows.append(('Time worked', '%dh %02dm' % (secs // 3600, (secs % 3600) // 60)))
            last = request.env['kpi.progress'].sudo().search(
                [('kpi_id', '=', k.id), ('summary', '!=', False)], order='id desc', limit=1)
            if last:
                rows.append(('Last update', last.summary))
        files = self._files(k) + [m.file_name for m in k.user_manual_ids if m.file_name]
        if files:
            # The photos / videos themselves are shown below the details (_media).
            rows.append(('Attachments', '%d file(s) — shown below' % len(files)))
        if k.description:
            rows.append(('Description', re.sub(r'<[^>]+>', '', k.description or '').strip()[:1500]))
        return rows

    def _page(self, token, link, error='', values=None):
        k = link.kpi_id.sudo()
        emoji, title, yes, no = _TITLES[link.kind]
        reasons = request.env['kpi.decline.reason'].sudo().options_for('decline') \
            if link.kind in ('new_request', 'new_database') else []
        boot = {'kind': link.kind, 'yes': yes, 'no': no,
                'ref': k.external_ref or '#%s' % k.id, 'values': values or {}}
        return _render('kra_kpi_module.wa_admin_decide', {
            'token': token, 'kind': link.kind, 'emoji': emoji, 'title': title,
            'yes': yes, 'no': no, 'admin': link.user_id.name or '',
            'rows': self._details(link), 'error': error, 'media': self._media(token, k),
            'developers': self._developers() if link.kind in ('new_request', 'new_database') else [],
            'reasons': reasons, 'priorities': PRIORITIES, 'doc_types': DOC_TYPES,
            'deliverables': DELIVERABLE_TYPES,
            'cur': {'priority': (k.requested_priority if link.kind == 'self_task' else k.priority) or 'regular',
                    'doc_type': k.requested_doc_type or 'requirement',
                    'estimate_hours': k.estimate_hours or 0, 'estimate_minutes': k.estimate_minutes or 0,
                    'deliverable': (k.deliverable_type or '').split(','),
                    'deliverable_other': k.deliverable_other or '',
                    'user_id': k.user_id.id or 0},
            'boot': Markup(json.dumps(boot).replace('</', '<\\/'))})

    def _closed(self, link, why=''):
        last = link._last_decision()
        detail = ''
        if last:
            why = why or '%s %s by %s, %s.' % (
                '✅' if last.decision in ('accepted', 'approved') else '❌' if last.decision in ('refused', 'sent back') else 'ℹ️',
                (last.decision or 'decided').capitalize(), last.decided_by_id.name or '—',
                _fmt_dt(last.used_at, link.user_id))
            detail = last.decision_note or ''
            if not detail and last.decision == 'refused':
                # Decided before decision_note existed: the task kept the reason.
                k = link.kpi_id.sudo().with_context(active_test=False)
                detail = ('Reason: %s' % k.decline_note) if k.decline_note else ''
        else:
            # Decided on the web: the task itself still says who refused and why.
            k = link.kpi_id.sudo().with_context(active_test=False)
            if not why and k.decline_note and k.declined_by_id:
                why = '❌ Refused by %s, %s.' % (k.declined_by_id.name, _fmt_dt(k.declined_at, link.user_id))
                detail = 'Reason: %s' % k.decline_note
        return _render('kra_kpi_module.wa_admin_decide_closed', {
            'ref': link.kpi_id.external_ref or '', 'name': link.kpi_id.name or '',
            'why': why or 'Already handled on the web. Nothing more to do here.',
            'detail': detail})

    def _check(self, token):
        """-> (link, admin, response). response is set when the page must not be used."""
        link = _link_for(token)
        if not link:
            return None, None, _render('kra_kpi_module.wa_approval_expired', {
                'meta': 'This admin link can no longer be used.',
                'reason': 'This link is not valid.',
                'hint': 'Decide it on the web — Queue or Approvals.'})
        admin = link.user_id
        # Admins, and anyone named on an approval chain step for a client
        # request (kpi_escalation.py): being on the step is the permission.
        chain_ok = link.kind in CHAIN_KINDS and request.env['kra.kpi'].sudo()._is_chain_decider(admin)
        if not admin.active or not (_is_admin(admin) or chain_ok):
            return link, None, self._closed(link, 'This link was for an admin account that can no longer decide.')
        if not link._still_open():
            return link, None, self._closed(link)
        if link.used_at:
            return link, None, self._closed(link)
        if link.expires < fields.Datetime.now():
            return link, None, self._closed(link, 'This link has expired. Decide it on the web, or wait for the next reminder.')
        return link, admin, None

    @http.route('/kpi/wa/admin/<string:token>/file', type='http', auth='public',
                methods=['GET'], csrf=False, website=False)
    def file(self, token, kind='', entry=0, att=0, **kw):
        """One of the task's files, shown in the page (inline). Only files of
        THIS link's task, and only while the link has not expired."""
        import base64
        import mimetypes
        link = _link_for(token)
        if not link or link.expires < fields.Datetime.now():
            return request.not_found()
        kpi = link.kpi_id.sudo().with_context(active_test=False)
        model, field = {'progress': ('kpi.progress', 'uploaded_file'),
                        'manual': ('kpi.user.manual', 'manual_file')}.get(kind, (None, None))
        if not model:
            return request.not_found()
        rec = request.env[model].sudo().browse(int(entry or 0)).exists()
        if not rec or rec.kpi_id.id != kpi.id:
            return request.not_found()
        if int(att or 0):
            a = request.env['kpi.file.attachment'].sudo().browse(int(att)).exists()
            link_field = 'progress_id' if kind == 'progress' else 'manual_id'
            if not a or a[link_field].id != rec.id:
                return request.not_found()
            data, name, mime = a.file, a.file_name, a.mimetype
        else:
            data, name, mime = rec[field], rec.file_name, ''
        if not data:
            return request.not_found()
        raw = base64.b64decode(data)
        mime = mime or mimetypes.guess_type(name or '')[0] or 'application/octet-stream'
        return request.make_response(raw, headers=[
            ('Content-Type', mime), ('Content-Length', str(len(raw))),
            ('Content-Disposition', 'inline; filename="%s"' % (name or 'file').replace('"', '')),
            ('Cache-Control', 'private, max-age=600')])

    @http.route('/kpi/wa/admin/<string:token>', type='http', auth='public',
                methods=['GET'], csrf=False, website=False)
    def page(self, token, **kw):
        link, admin, stop = self._check(token)
        if stop:
            return stop
        return self._page(token, link)

    # ------------------------------------------------------------------
    # the decision -- through the web's own code, as that admin
    # ------------------------------------------------------------------
    @http.route('/kpi/wa/admin/<string:token>/decide', type='http', auth='public',
                methods=['POST'], csrf=False, website=False)
    def decide(self, token, **post):
        link, admin, stop = self._check(token)
        if stop:
            return stop
        action = post.get('action')
        if action not in ('yes', 'no'):
            return self._page(token, link, 'Choose what to do.', post)
        # The decision runs through the web's own routes, which check admin
        # rights. A chain decider who is not an admin runs it as the
        # Administrator; the link and the task log still name the real person.
        acting = admin if _is_admin(admin) else request.env.ref('base.user_admin')
        request.update_env(user=acting.id)
        try:
            ok, msg, label = self._apply(link, action, post)
        except UserError as exc:
            ok, msg, label = False, str(exc), ''
        except Exception as exc:
            _logger.exception('admin WhatsApp decision failed for %s: %s', link.kpi_id.id, exc)
            ok, msg, label = False, 'That could not be saved. Try again, or use the web.', ''
        if not ok:
            request.env.cr.rollback()
            return self._page(token, link, msg or 'That could not be saved.', post)

        # What they picked and typed, for anyone who opens a link after them.
        if action == 'no':
            rid = int(post.get('reason_id') or 0)
            reason = request.env['kpi.decline.reason'].sudo().browse(rid).exists() if rid else None
            typed = (post.get('note') or '').strip()
            note = '\n'.join(p for p in (
                ('Reason: %s' % reason.name) if reason else '',
                ('Note: %s' % typed) if typed else '') if p)
        else:
            note = msg[:1].upper() + msg[1:] if msg else ''
        link._close_all(label, admin, note)
        k = link.kpi_id.sudo()
        if acting != admin:
            k._log_action('chain_decision', source='whatsapp', actor_label=admin.name,
                          payload={'decision': label, 'by': admin.name, 'kind': link.kind})
        done = '%s — %s' % (k.external_ref or '#%s' % k.id, msg)
        try:
            request.env['kpi.wa.group.report'].sudo().post_text_to_user(admin, '✅ Done: ' + done)
        except Exception as exc:
            _logger.warning('admin WhatsApp confirmation failed: %s', exc)
        emoji, title, _y, _n = _TITLES[link.kind]
        return _render('kra_kpi_module.wa_admin_decide_done', {
            'emoji': emoji, 'title': title, 'ref': k.external_ref or '', 'name': k.name or '',
            'message': msg})

    def _apply(self, link, action, post):
        """-> (ok, message, decision label)."""
        k = link.kpi_id.sudo()
        kind = link.kind
        note = (post.get('note') or '').strip()
        reason_id = int(post.get('reason_id') or 0) or None
        reports, kra = KpiReportsAPI(), KraKpiAPI()

        if kind == 'new_request':
            if action == 'yes':
                if not post.get('user_id'):
                    return False, 'Pick the developer it goes to.', ''
                deliverable = request.httprequest.form.getlist('deliverable_type')
                res = reports.update_pending_kpi(
                    kpi_id=k.id, user_id=post.get('user_id'),
                    priority=post.get('priority') or k.priority or 'regular',
                    estimate_hours=post.get('estimate_hours') or 0,
                    estimate_minutes=post.get('estimate_minutes') or 0,
                    deliverable_type=deliverable or k.deliverable_type or '',
                    deliverable_other=post.get('deliverable_other') or k.deliverable_other or '')
                if not res.get('status'):
                    return False, res.get('message'), ''
                res = reports.publish_pending_kpi(kpi_id=k.id)
                if not res.get('status'):
                    return False, res.get('message'), ''
                dev = request.env['res.users'].sudo().browse(int(post['user_id']))
                return True, 'accepted → %s. The client is asked to approve it.' % dev.name, 'accepted'
            if not (note or reason_id):
                return False, 'Pick a reason or write one — the client is told.', ''
            res = reports.pending_queue_decline(kpi_id=k.id, mode='decline',
                                                reason_id=reason_id, reason_text=note)
            if not res.get('status'):
                return False, res.get('message'), ''
            return True, 'refused. The client has been told why.', 'refused'

        if kind in ('new_database', 'disconnect'):
            res_model, res_id = ('kra.kpi', k.id) if kind == 'new_database' else \
                ('kpi.client.db', link._db().id)
            vals = {'res_model': res_model, 'res_id': res_id, 'kind': kind,
                    'decision': 'approve' if action == 'yes' else 'reject',
                    'note': note, 'reason_id': reason_id or False,
                    'tell_client': post.get('tell_client') != '0'}
            if kind == 'new_database' and action == 'yes':
                if not post.get('user_id'):
                    return False, 'Pick the developer who builds it.', ''
                vals['user_id'] = int(post['user_id'])
            if kind == 'disconnect' and not note:
                return False, 'Write a note — it is recorded and shown to the client.', ''
            if kind == 'new_database' and action == 'no' and not (note or reason_id):
                return False, 'Pick a reason or write one — the client is told.', ''
            wiz = request.env['kpi.approval.decide'].create(vals)
            wiz.action_apply()
            if kind == 'new_database':
                return True, ('approved → %s.' % wiz.user_id.name) if action == 'yes' \
                    else 'refused. The client has been told why.', \
                    'approved' if action == 'yes' else 'refused'
            return True, 'database switched off.' if action == 'yes' \
                else 'refused — the database stays running.', \
                'destroyed' if action == 'yes' else 'refused'

        if kind == 'self_task':
            if action == 'yes':
                res = kra.accept_self_created(kpi_id=k.id, doc_type=post.get('doc_type') or 'requirement',
                                              priority=post.get('priority') or 'regular')
                return bool(res.get('status')), res.get('message') or 'accepted.', 'accepted'
            res = kra.reject_self_created(kpi_id=k.id, note=note, discard=post.get('discard') == '1')
            return bool(res.get('status')), res.get('message') or 'sent back.', \
                'discarded' if post.get('discard') == '1' else 'sent back'

        if kind == 'qa':
            if action == 'yes':
                res = kra.task_approve(kpi_id=k.id)
                if res.get('status'):
                    nxt = 'sent to the client for sign-off.' if res.get('new_state') == 'awaiting_client' \
                        else 'completed.'
                    return True, 'approved — %s' % nxt, 'approved'
                return False, res.get('message'), ''
            if not note:
                return False, 'Say what needs fixing — the developer sees it.', ''
            res = kra.task_reject(kpi_id=k.id, reason=note)
            return bool(res.get('status')), res.get('message') or 'sent back for rework.', 'sent back'

        return False, 'Nothing to do for this link.', ''
