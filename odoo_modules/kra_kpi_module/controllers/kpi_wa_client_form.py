"""WhatsApp client menu -> a form page instead of the poll conversation.

A client taps ✨ New Requirement / 🐞 Report a Bug / 🔧 Request an Update /
🗄️ New Database / 💥 Destroy a Database in their group, and the bot posts a
private link (/kpi/wa/client/<token>): one person, one use, 30 minutes
(kpi_wa_group_intake._client_form_begin). The page has the dropdowns for that
request, scoped to the group's client only, a live Preview, and a confirmation
popup that shows the preview again. Submit files the ticket the same way the
poll flow does (router._finish_client_ticket) and posts the receipt back in
the group.

auth='public' like the other WhatsApp pages (kpi_wa_task_form.py): the phone
opening the link is not logged in to Odoo. The token is the key, and every
list and every submitted id is checked against the token's client.
"""

import base64
import hmac
import json
import logging
import re
from types import SimpleNamespace

from markupsafe import Markup

from odoo import fields, http
from odoo.http import request

from .kpi_wa_approval import _render
from ..models.kpi import DELIVERABLE_TYPES, clean_deliverable
from ..models.kpi_server import NEW_DB_NAME_EXAMPLE
from ..models.kpi_workflow import NAME_PREFIX_FOR_DOC_TYPE, REF_PREFIX_FOR_DOC_TYPE

_logger = logging.getLogger(__name__)

FILES_MAX_BYTES = 50 * 1024 * 1024
PRIORITIES = [('regular', 'Regular'), ('important', 'Important'), ('urgent', 'Urgent')]
PRIORITY_CODES = tuple(c for c, _l in PRIORITIES)
TEXT_MAX = 4000

_TITLES = {
    'requirement': ('✨', 'New Requirement'),
    'bug': ('🐞', 'Report a Bug'),
    'update': ('🔧', 'Request an Update'),
    'newdb': ('🗄️', 'New Database'),
    'dbdisconnect': ('💥', 'Destroy a Database'),
}


def _state_for(token):
    """The WhatsApp conversation this link belongs to, if still valid."""
    if not token or len(token) < 16 or len(token) > 64:
        return None
    st = request.env['kpi.wa.group.intake'].sudo().search(
        [('client_form_token', '=', token)], limit=1)
    if not st or not hmac.compare_digest(st.client_form_token or '', token):
        return None
    if not st.client_form_expires or st.client_form_expires < fields.Datetime.now():
        return None
    if st.client_form_kind not in _TITLES:
        return None
    group = st.group_id
    if not group or group.is_staff_group or not group.kra_id:
        return None
    return st


class _FormError(Exception):
    """A check failed: show the message on the form, keep nothing."""


def _clean_title(text):
    """Task name: single spaces, first letter capital."""
    s = ' '.join((text or '').split())[:200]
    return s[:1].upper() + s[1:]


def _json_for_script(data):
    """JSON safe to drop inside <script>."""
    return Markup(json.dumps(data).replace('</', '<\\/'))


class KpiWaClientForm(http.Controller):

    # ------------------------------------------------------------------
    # what the client may pick
    # ------------------------------------------------------------------
    def _client(self, st):
        return st.group_id.kra_id

    def _servers(self, st):
        """New Database: every active server. Everything else: the servers
        this client has live databases on."""
        if st.client_form_kind == 'newdb':
            rows = request.env['kpi.server'].sudo().search([])
        else:
            rows = request.env['kpi.client.db'].sudo().servers_for_client(self._client(st))
        return [{'id': s.id, 'name': s.poll_label()}
                for s in rows.sorted(lambda s: (s.poll_label() or '').lower())]

    def _dbs(self, st, server_id):
        Db = request.env['kpi.client.db'].sudo()
        rows = Db.search([('client_kra_id', '=', self._client(st).id),
                          ('state', '=', 'live'),
                          ('server_id', '=', int(server_id or 0))], order='db_name')
        return rows

    def _requirements(self, db):
        """The client's requirement tasks on one database, newest first."""
        rows = request.env['kra.kpi'].sudo().search([
            ('client_db_id', '=', db.id), ('external_ref', '=ilike', 'REQ-%')],
            order='create_date desc', limit=200)
        return rows

    def _db_for(self, st, server_id, db_id):
        try:
            db = request.env['kpi.client.db'].sudo().browse(int(db_id or 0)).exists()
        except (TypeError, ValueError):
            return None
        if (not db or db.client_kra_id != self._client(st) or db.state != 'live'
                or db.server_id.id != int(server_id or 0)):
            return None
        return db

    # ------------------------------------------------------------------
    # pages
    # ------------------------------------------------------------------
    def _expired(self):
        # A web page, not a WhatsApp message: no *bold* marks here.
        return _render('kra_kpi_module.wa_approval_expired', {
            'meta': 'This request link can no longer be used.',
            'reason': 'It has expired (links last 30 minutes) or was already used to send a request.',
            'hint': 'Send “hi” in your WhatsApp group to get a fresh link.'})

    def _page(self, token, st, values=None, error=''):
        kind = st.client_form_kind
        emoji, title = _TITLES[kind]
        boot = {
            'token': token, 'kind': kind,
            'servers': self._servers(st),
            'values': values or {},
            'example': NEW_DB_NAME_EXAMPLE,
            'filesMax': FILES_MAX_BYTES,
        }
        return _render('kra_kpi_module.wa_client_form', {
            'token': token, 'kind': kind, 'emoji': emoji, 'title': title,
            'who': st.participant_name or '', 'client': self._client(st).name or '',
            'example': NEW_DB_NAME_EXAMPLE, 'error': error,
            'priorities': PRIORITIES, 'deliverables': DELIVERABLE_TYPES,
            'today': fields.Date.to_string(fields.Date.today()),
            'boot': _json_for_script(boot)})

    @http.route('/kpi/wa/client/<string:token>', type='http', auth='public',
                methods=['GET'], csrf=False, website=False)
    def form(self, token, **kw):
        st = _state_for(token)
        if not st:
            return self._expired()
        return self._page(token, st)

    # ------------------------------------------------------------------
    # lookups (JSON)
    # ------------------------------------------------------------------
    @http.route('/kpi/wa/client/<string:token>/dbs', type='json', auth='public',
                methods=['POST'], csrf=False)
    def dbs(self, token, server_id=None, **kw):
        st = _state_for(token)
        if not st:
            return {'ok': False, 'expired': True}
        return {'ok': True, 'dbs': [{'id': d.id, 'name': d.db_name, 'label': d.poll_label()}
                                    for d in self._dbs(st, server_id)]}

    @http.route('/kpi/wa/client/<string:token>/tasks', type='json', auth='public',
                methods=['POST'], csrf=False)
    def tasks(self, token, server_id=None, db_id=None, **kw):
        st = _state_for(token)
        if not st:
            return {'ok': False, 'expired': True}
        db = self._db_for(st, server_id, db_id)
        if not db:
            return {'ok': True, 'tasks': []}
        return {'ok': True, 'tasks': [{
            'id': k.id, 'ref': k.external_ref or '', 'name': k.name or '',
            'date': k.create_date.strftime('%d-%m-%Y') if k.create_date else '',
        } for k in self._requirements(db)]}

    @http.route('/kpi/wa/client/<string:token>/polish', type='json', auth='public',
                methods=['POST'], csrf=False)
    def polish(self, token, text='', **kw):
        st = _state_for(token)
        if not st:
            return {'ok': False, 'expired': True}
        res = request.env['kpi.ai'].sudo().polish_text((text or '')[:3000])
        return {'ok': True, 'text': res['text'], 'source': res['source']}

    @http.route('/kpi/wa/client/<string:token>/check_db', type='json', auth='public',
                methods=['POST'], csrf=False)
    def check_db(self, token, name='', server_id=None, **kw):
        st = _state_for(token)
        if not st:
            return {'ok': False, 'expired': True}
        clean, errors = self._check_new_db(name, server_id)
        return {'ok': not errors, 'clean': clean, 'errors': errors}

    def _check_new_db(self, name, server_id):
        Server = request.env['kpi.server'].sudo()
        clean, errors = Server.validate_new_db_name(name)
        if errors:
            return clean, errors
        if server_id:
            exists = request.env['kpi.client.db'].sudo().with_context(active_test=False).search([
                ('server_id', '=', int(server_id)), ('db_name', '=ilike', clean)], limit=1)
            if exists:
                return clean, ['%s already exists on this server' % clean]
        dup = Server.existing_request(clean)
        if dup:
            return clean, ['%s is already requested (%s)' % (clean, dup.external_ref or dup.id)]
        return clean, []

    # ------------------------------------------------------------------
    # submit
    # ------------------------------------------------------------------
    def _files(self):
        out, total = [], 0
        for f in request.httprequest.files.getlist('files'):
            if not f or not f.filename:
                continue
            data = f.read()
            if not data:
                continue
            total += len(data)
            if total > FILES_MAX_BYTES:
                return None, 'Files are over the %d MB limit.' % (FILES_MAX_BYTES // (1024 * 1024))
            out.append((f.filename[:255], data, (f.mimetype or '')[:128]))
        return out, ''

    @http.route('/kpi/wa/client/<string:token>/submit', type='http', auth='public',
                methods=['POST'], csrf=False, website=False)
    def submit(self, token, **post):
        st = _state_for(token)
        if not st:
            return self._expired()
        kind = st.client_form_kind
        values = {k: v for k, v in post.items() if k != 'password'}
        values['deliverable'] = request.httprequest.form.getlist('deliverable_type')
        receipt = ''
        try:
            with request.env.cr.savepoint():
                kpi, err, receipt = self._create(st, kind, post)
                if err:
                    # Roll back anything half made (e.g. a ticket created
                    # before its files were refused).
                    raise _FormError(err)
        except _FormError as exc:
            return self._page(token, st, values, str(exc))
        except Exception as exc:
            _logger.exception('client form submit failed: %s', exc)
            return self._page(token, st, values,
                              'Sorry — that could not be saved. Please try again.')

        # One use: the link stops working the moment the request exists.
        st.sudo().write({'client_form_token': False, 'client_form_expires': False,
                         'created_kpi_id': kpi.id})
        receipt = receipt or self._receipt(st, kind, kpi, post)
        self._post_in_group(st, receipt)
        emoji, title = _TITLES[kind]
        return _render('kra_kpi_module.wa_client_form_done', {
            'emoji': emoji, 'title': title, 'ref': kpi.external_ref or '',
            'name': kpi.name or ''})

    def _create(self, st, kind, post):
        """-> (kra.kpi, error, receipt). Re-checks everything the page checked.
        `receipt` is only set when the model builds its own (Destroy)."""
        router = request.env['kpi.wa.group.router'].sudo()
        Kpi = request.env['kra.kpi'].sudo()
        group, client = st.group_id, self._client(st)
        who = st.participant_name or st.participant_key
        server_id = post.get('server_id')
        text = (post.get('description') or '').strip()[:TEXT_MAX]
        footer = '\n\n— Sent from the WhatsApp form by %s in %s.' % (
            who, group.name or group.jid)

        if kind == 'newdb':
            server = request.env['kpi.server'].sudo().browse(int(server_id or 0)).exists()
            if not server:
                return None, 'Choose a server.', ''
            clean, errors = self._check_new_db(post.get('db_name'), server.id)
            if errors:
                return None, 'Database name: ' + '; '.join(errors), ''
            username = (post.get('username') or '').strip()[:64]
            password = (post.get('password') or '')[:128]
            if not username:
                return None, 'Type the username.', ''
            if not password:
                return None, 'Type or generate the password.', ''
            children = client.child_ids.filtered('active')
            target = children[0] if len(children) == 1 else client
            kpi = Kpi.browse(Kpi.create_kpi({
                'name': '[New DB] New DB %s on %s' % (clean, server.name),
                'kra_id': target.id, 'doc_type': 'requirement',
                'description': ('— New database —\nServer: %s\nDatabase name: %s\n'
                                'Login: %s\nPassword: set on the request (Login / '
                                'Password fields)%s') % (server.name, clean, username, footer),
            }))
            router._finish_client_ticket(kpi, group, st, {
                'request_category': 'new_database',
                'provision_server_id': server.id,
                'provision_db_name': clean,
                'provision_username': username,
                'provision_password': password,
            }, {'form': kind, 'db_name': clean, 'server': server.name},
                action='wa_client_form')
            return kpi, '', ''

        db = self._db_for(st, server_id, post.get('db_id'))
        if not db:
            return None, 'Choose the server and the database.', ''
        if not text:
            return None, 'Write the summary / description.', ''
        files, ferr = self._files()
        if ferr:
            return None, ferr, ''
        target = db.target_kra() or client
        scope = '%s (%s)' % (db.db_name, db.server_id.name)

        if kind == 'dbdisconnect':
            kpi = Kpi.browse(Kpi.create_kpi({
                'name': '[Destroy] Destroy %s on %s' % (db.db_name, db.server_id.name),
                'kra_id': target.id, 'doc_type': 'requirement',
                'description': ('— Destroy request —\nDatabase: %s\nServer: %s\n'
                                'Reason: %s\n\nNOT ACTIONED. The database is still live. '
                                'Approve or refuse it on Clients > Live Databases.%s')
                               % (db.db_name, db.server_id.name, text, footer),
            }))
            router._finish_client_ticket(kpi, group, st, {
                'client_db_id': db.id, 'request_category': 'db_disconnect',
            }, {'form': kind, 'db_id': db.id}, action='wa_client_form')
            receipt = db.request_disconnect(
                kpi=kpi, reason_text=text,
                by_number=router._participant_number(st), by_name=st.participant_name or '')
            return kpi, '', receipt

        # Urgency and Needed by: the web portal's New Request fields
        # (/kpi_client_portal/add_task), same values and same rules.
        priority = post.get('priority') or 'regular'
        if priority not in PRIORITY_CODES:
            return None, 'Choose the urgency.', ''
        deadline = False
        if post.get('needed_by'):
            try:
                deadline = fields.Date.to_date(post['needed_by'])
            except ValueError:
                return None, 'Needed by: pick a date.', ''
            if deadline < fields.Date.today():
                return None, 'Needed by cannot be in the past.', ''
        common = {'priority': priority, 'deadline': deadline}

        if kind == 'requirement':
            name = _clean_title(post.get('name'))
            if not name:
                return None, 'Type the task name.', ''
            deliverable = request.httprequest.form.getlist('deliverable_type')
            dv, dv_err = clean_deliverable(deliverable, post.get('deliverable_other'))
            if dv_err:
                return None, dv_err, ''
            if not dv['deliverable_type']:
                return None, 'Tick the type — Module, App, EXE or Other.', ''
            kpi = Kpi.browse(Kpi.create_kpi(dict(common, **{
                'name': name, 'kra_id': target.id, 'doc_type': 'requirement',
                'description': '%s\n\nDatabase: %s%s' % (text, scope, footer),
                'deliverable_type': dv['deliverable_type'],
                'deliverable_other': dv['deliverable_other'],
            })))
            router._finish_client_ticket(kpi, group, st, {'client_db_id': db.id},
                                         {'form': kind, 'db_id': db.id},
                                         action='wa_client_form')
        else:
            # Bug / Update: always about ONE existing requirement on this DB,
            # numbered under it -- BUG001-REQ-012, UPT001-REQ-012.
            try:
                parent = Kpi.browse(int(post.get('parent_id') or 0)).exists()
            except (TypeError, ValueError):
                parent = None
            if (not parent or parent.client_db_id != db
                    or not (parent.external_ref or '').upper().startswith('REQ-')):
                return None, 'Pick the task this is about.', ''
            prefix = REF_PREFIX_FOR_DOC_TYPE[kind]
            ref = '%s%03d-%s' % (prefix, self._next_child_number(prefix, parent.external_ref),
                                 parent.external_ref)
            base = re.sub(r'^\[(Update|Bug)\]\s*', '', parent.name or '', flags=re.I)
            # The type comes from the requirement it is about.
            kpi = Kpi.browse(Kpi.create_kpi(dict(common, **{
                'name': NAME_PREFIX_FOR_DOC_TYPE[kind] + base,
                'kra_id': parent.kra_id.id or target.id,
                'description': '%s\n\nAbout: %s — %s\nDatabase: %s%s' % (
                    text, parent.external_ref, base, scope, footer),
                'deliverable_type': parent.deliverable_type or False,
                'deliverable_other': parent.deliverable_other or False,
            })))
            router._finish_client_ticket(kpi, group, st, {
                'client_db_id': db.id, 'external_ref': ref,
                'related_req_ref': parent.external_ref,
                'requested_doc_type': kind,
            }, {'form': kind, 'db_id': db.id, 'parent': parent.external_ref},
                action='wa_client_form')
        if files:
            self._attach(kpi, files, st)
        return kpi, '', ''

    def _next_child_number(self, prefix, parent_ref):
        """Next N for <PREFIX>NNN-<parent_ref>, counted per requirement.
        Archived tasks and retired refs count, so a number is never reused."""
        Kpi = request.env['kra.kpi'].sudo().with_context(active_test=False)
        pat = '%s%%-%s' % (prefix, parent_ref)
        rx = re.compile(r'^%s(\d{1,9})-%s$' % (re.escape(prefix), re.escape(parent_ref)), re.I)
        has_prev = 'previous_external_ref' in Kpi._fields
        domain = [('external_ref', '=ilike', pat)]
        if has_prev:
            domain = ['|'] + domain + [('previous_external_ref', '=ilike', pat)]
        nums = [0]
        for k in Kpi.search(domain):
            for r in (k.external_ref, k.previous_external_ref if has_prev else ''):
                m = rx.match((r or '').strip())
                if m:
                    nums.append(int(m.group(1)))
        return max(nums) + 1

    def _attach(self, kpi, files, st):
        """Same storage as the portal's client files: one progress entry, the
        first file on it and the rest as kpi.file.attachment rows."""
        member = request.env['kpi.wa.group.router'].sudo()._member_for(st.group_id, st)
        user = member.user_id if member and member.user_id else request.env.ref('base.user_admin')
        name, data, _mime = files[0]
        progress = request.env['kpi.progress'].sudo().create({
            'kpi_id': kpi.id, 'user_id': user.id,
            'summary': 'Attached by %s on the WhatsApp form.' % (
                st.participant_name or 'the client'),
            'uploaded_file': base64.b64encode(data), 'file_name': name,
        })
        Att = request.env['kpi.file.attachment'].sudo()
        for seq, (name, data, mime) in enumerate(files[1:], start=2):
            Att.create({'progress_id': progress.id, 'file': base64.b64encode(data),
                        'file_name': name, 'mimetype': mime or False,
                        'sequence': seq * 10})

    # ------------------------------------------------------------------
    # back in the group
    # ------------------------------------------------------------------
    def _receipt(self, st, kind, kpi, post):
        who = st.participant_name or ''
        client = self._client(st).name or ''
        ref = kpi.external_ref or str(kpi.id)
        if kind == 'dbdisconnect':
            return '💥 Destroy requested — %s' % ref
        if kind == 'newdb':
            return ('🗄️ *New Database* — logged *%s* for *%s*\n'
                    'Database: *%s*\nServer: %s\nLogin: %s\n\n'
                    '_In the admin queue for review._') % (
                ref, client, kpi.provision_db_name or '',
                kpi.provision_server_id.name or '', post.get('username') or '')
        db = kpi.client_db_id
        emoji, title = _TITLES[kind]
        lines = ['%s *%s* — logged *%s* for *%s*' % (emoji, title, ref, client),
                 kpi.name or '']
        if kpi.related_req_ref:
            lines.append('About: %s' % kpi.related_req_ref)
        if db:
            lines.append('🗄️ %s (%s)' % (db.db_name, db.server_id.name))
        lines.append('\n_%sIn the admin queue for review._' % (
            ('Sent by %s. ' % who) if who else ''))
        return '\n'.join(lines)

    def _post_in_group(self, st, text):
        try:
            session = request.env['whatsapp.session'].sudo().search(
                [('status', '=', 'connected')], limit=1)
            if not session or not st.group_id.jid:
                return
            msg = SimpleNamespace(phone=st.group_id.jid, session_id=session, message='',
                                  message_type='text', interactive_reply_id='')
            request.env['kpi.wa.group.router'].sudo()._text(msg, text)
        except Exception as exc:
            _logger.warning('client form saved but the WhatsApp receipt failed: %s', exc)
