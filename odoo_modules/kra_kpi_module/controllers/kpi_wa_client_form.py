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
import secrets
from datetime import timedelta

from markupsafe import Markup

from odoo import fields, http
from odoo.http import request

from .kpi_wa_approval import _render
from .kra_api import serve_file, _guess_mime
from ..models.kpi import DELIVERABLE_TYPES, clean_deliverable
from ..models.kpi_legacy import is_audio, is_image_or_video, legacy_input_problem
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
# What a declined task may be re-sent as.
FIX_KINDS = [('requirement', '✨ Requirement'), ('bug', '🐞 Bug'), ('update', '🔧 Update')]


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
        """The client's requirement tasks on one database, newest first --
        old-DB requirements already added (archived placeholders) included."""
        rows = request.env['kra.kpi'].sudo().with_context(active_test=False).search([
            ('client_db_id', '=', db.id), ('external_ref', '=ilike', 'REQ-%'),
            '|', ('active', '=', True), ('is_legacy', '=', True)],
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

    def _fix_values(self, kpi):
        """A declined task's earlier answers, in the form's own field names."""
        if kpi.request_category == 'new_database':
            return {'server_id': kpi.provision_server_id.id or '',
                    'db_name': kpi.provision_db_name or '',
                    'username': kpi.provision_username or '',
                    'description': kpi.provision_modules or ''}
        db = kpi.client_db_id
        parent = kpi.related_req_kpi_id if 'related_req_kpi_id' in kpi._fields else False
        desc = kpi.original_client_text or kpi.description or ''
        # Drop the lines the form itself appended (Database:, About:, footer).
        desc = re.split(r'\n\n(?:About: |Database: |— Sent from the WhatsApp form)', desc)[0]
        return {
            'server_id': db.server_id.id if db else '', 'db_id': db.id if db else '',
            'parent_id': parent.id if parent else '',
            'name': re.sub(r'^\[(Update|Bug)\]\s*', '', kpi.name or '', flags=re.I),
            'description': desc.strip(),
            'priority': kpi.priority or 'regular',
            'needed_by': fields.Date.to_string(kpi.deadline) if kpi.deadline else '',
            'deliverable': [c for c in (kpi.deliverable_type or '').split(',') if c],
            'deliverable_other': kpi.deliverable_other or '',
            'legacy_on': '1' if kpi.legacy_req_link and not parent else '',
            'legacy_ref': kpi.legacy_req_ref or '',
            'legacy_name': kpi.legacy_req_name or '',
            'legacy_note': kpi.legacy_note or '',
        }

    def _page(self, token, st, values=None, error=''):
        kind = st.client_form_kind
        emoji, title = _TITLES[kind]
        fix = st.client_form_fix_kpi_id
        if fix and values is None:
            values = self._fix_values(fix)
        boot = {
            'token': token, 'kind': kind,
            'servers': self._servers(st),
            'values': values or {},
            'example': NEW_DB_NAME_EXAMPLE,
            'filesMax': FILES_MAX_BYTES,
            # Fixing a declined request: the files sent the first time are
            # still on it -- shown (and counted) so nobody uploads them again.
            'existing': self._existing_files(token, fix) if fix else [],
        }
        return _render('kra_kpi_module.wa_client_form', {
            'token': token, 'kind': kind, 'emoji': emoji, 'title': title,
            'who': st.participant_name or '', 'client': self._client(st).name or '',
            'example': NEW_DB_NAME_EXAMPLE, 'error': error,
            'priorities': PRIORITIES, 'deliverables': DELIVERABLE_TYPES,
            'today': fields.Date.to_string(fields.Date.today()),
            'fix_ref': (fix.external_ref or '#%s' % fix.id) if fix else '',
            'fix_reason': (fix.decline_note or '') if fix else '',
            'fix_kinds': FIX_KINDS if fix and kind != 'newdb' else [],
            'boot': _json_for_script(boot)})

    def _existing_files(self, token, kpi):
        """The client's files already on a declined request, with a link that
        works only through this form link."""
        out = []
        for f in kpi._legacy_client_files():
            name, mime = f['name'], f['mime']
            kind = ('audio' if is_audio(name, mime) else
                    'video' if (mime or '').startswith('video/') or name.lower().endswith(
                        ('.mp4', '.mov', '.mkv', '.avi', '.3gp', '.m4v')) else
                    'image' if is_image_or_video(name, mime) else 'other')
            out.append({'name': name, 'kind': kind, 'mime': mime,
                        'url': '/kpi/wa/client/%s/file?entry=%s&att=%s' % (token, f['entry'], f['att'])})
        return out

    @http.route('/kpi/wa/client/<string:token>/file', type='http', auth='public',
                methods=['GET'], csrf=False, website=False)
    def existing_file(self, token, entry='0', att='0', **kw):
        """One file of the request being fixed -- nothing else."""
        st = _state_for(token)
        kpi = st.client_form_fix_kpi_id if st else None
        if not kpi:
            return request.not_found()
        try:
            entry, att = int(entry or 0), int(att or 0)
        except (TypeError, ValueError):
            return request.not_found()
        for f in kpi.sudo()._legacy_client_files():
            if f['entry'] == entry and f['att'] == att:
                return serve_file(base64.b64decode(f['data']), f['name'],
                                  _guess_mime(f['name'], f['mime'] or ''),
                                  inline=kw.get('download') not in ('1', 'true'))
        return request.not_found()

    @http.route('/kpi/wa/client/<string:token>', type='http', auth='public',
                methods=['GET'], csrf=False, website=False)
    def form(self, token, kind=None, **kw):
        st = _state_for(token)
        if not st:
            return self._expired()
        # Fixing a declined task: the client may switch Requirement / Bug / Update.
        if st.client_form_fix_kpi_id and kind in dict(FIX_KINDS) and kind != st.client_form_kind:
            st.sudo().write({'client_form_kind': kind})
        return self._page(token, st)

    @http.route('/kpi/wa/fix/<string:token>', type='http', auth='public',
                methods=['GET'], csrf=False, website=False)
    def fix(self, token, **kw):
        """The declined task's own link. It does not expire: each open starts a
        normal 30-minute form session on it and redirects there."""
        if not token or len(token) < 16 or len(token) > 64:
            return self._expired()
        kpi = request.env['kra.kpi'].sudo().with_context(active_test=False).search(
            [('client_fix_token', '=', token)], limit=1)
        if not kpi or not hmac.compare_digest(kpi.client_fix_token or '', token):
            return self._expired()
        group = request.env['kpi.wa.group.report'].sudo()._group_for_kpi(kpi)
        if not group or group.is_staff_group or not group.kra_id:
            return self._expired()
        Intake = request.env['kpi.wa.group.intake'].sudo()
        member = False
        if kpi.submitted_by_uid:
            member = request.env['kpi.wa.group.member'].sudo().search(
                [('group_id', '=', group.id), ('user_id', '=', kpi.submitted_by_uid.id)], limit=1)
        key = (member.lid or member.phone) if member else 'fix-%s' % kpi.id
        st = Intake._get_or_create(group, key, member.wa_name if member else '')
        form_token = secrets.token_urlsafe(24)
        kind = 'newdb' if kpi.request_category == 'new_database' else kpi._kind_now()
        st.write({'client_form_token': form_token, 'client_form_kind': kind,
                  'client_form_fix_kpi_id': kpi.id,
                  'client_form_expires': fields.Datetime.now() + timedelta(minutes=30)})
        return request.redirect('/kpi/wa/client/%s' % form_token, local=True)

    # ------------------------------------------------------------------
    # lookups (JSON)
    # ------------------------------------------------------------------
    @http.route('/kpi/wa/client/<string:token>/dbs', type='json', auth='public',
                methods=['POST'], csrf=False)
    def dbs(self, token, server_id=None, **kw):
        st = _state_for(token)
        if not st:
            return {'ok': False, 'expired': True}
        # url: the server's address, which prefills the Destroy form's Database URL.
        return {'ok': True, 'dbs': [{'id': d.id, 'name': d.db_name, 'label': d.poll_label(),
                                     'url': d.server_id.url or ''}
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
            'old': bool(k.is_legacy),
            'deliverable': k.deliverable_type or '', 'deliverable_other': k.deliverable_other or '',
        } for k in self._requirements(db)]}

    @http.route('/kpi/wa/client/<string:token>/children', type='json', auth='public',
                methods=['POST'], csrf=False)
    def children(self, token, server_id=None, db_id=None, parent_id=None, **kw):
        """The bugs (or updates -- the form's kind) already raised under the
        picked requirement, and the ref this one will get."""
        st = _state_for(token)
        if not st:
            return {'ok': False, 'expired': True}
        kind = st.client_form_kind
        db = self._db_for(st, server_id, db_id)
        if kind not in ('bug', 'update') or not db:
            return {'ok': True, 'items': [], 'next_ref': ''}
        try:
            parent = request.env['kra.kpi'].sudo().browse(int(parent_id or 0)).exists()
        except (TypeError, ValueError):
            parent = None
        # Same checks as _create: this client's database, a requirement.
        if (not parent or parent.client_db_id != db
                or not (parent.external_ref or '').upper().startswith('REQ-')):
            return {'ok': True, 'items': [], 'next_ref': ''}
        return dict(parent._child_requests(kind), ok=True, parent=parent.external_ref)

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
        clean, errors = self._check_new_db(name, server_id, fixing=st.client_form_fix_kpi_id)
        return {'ok': not errors, 'clean': clean, 'errors': errors}

    def _check_new_db(self, name, server_id, fixing=None):
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
        if dup and fixing and dup == fixing:
            dup = None
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
                if st.client_form_fix_kpi_id:
                    kpi, err, receipt = self._resubmit(st, kind, post)
                else:
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
                         'client_form_fix_kpi_id': False, 'created_kpi_id': kpi.id})
        receipt = receipt or self._receipt(st, kind, kpi, post)
        self._post_in_group(st, receipt)
        emoji, title = _TITLES[kind]
        return _render('kra_kpi_module.wa_client_form_done', {
            'emoji': emoji, 'title': title, 'ref': kpi.external_ref or '',
            'name': kpi.name or ''})

    def _create(self, st, kind, post):
        """-> (kra.kpi, error, receipt). Re-checks everything the page checked.
        `receipt` is only set when the model builds its own (Destroy).

        Every create here passes kpi_no_admin_arm: a client's request is never
        "accepted by an admin" on creation -- not even when the link was opened
        in a browser that is logged in to Odoo as an admin, which made create()
        take it for the admin's own task and closed the approval links."""
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
            # Which modules to install and anything the team needs to know first.
            if not text:
                return None, 'Write which modules to install / notes.', ''
            children = client.child_ids.filtered('active')
            target = children[0] if len(children) == 1 else client
            kpi = Kpi.browse(Kpi.with_context(kpi_no_admin_arm=True).create_kpi({
                'name': '[New DB] New DB %s on %s' % (clean, server.name),
                'kra_id': target.id, 'doc_type': 'requirement',
                'description': ('— New database —\nServer: %s\nDatabase name: %s\n'
                                'Login: %s\nPassword: set on the request (Login / '
                                'Password fields)\nModules / notes: %s%s') % (
                                    server.name, clean, username, text, footer),
            }))
            router._finish_client_ticket(kpi, group, st, {
                'request_category': 'new_database',
                'provision_server_id': server.id,
                'provision_db_name': clean,
                'provision_username': username,
                'provision_password': password,
                'provision_modules': text,
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
            # The team needs the way in to do the deletion: URL and login.
            url = (post.get('db_url') or '').strip()[:255]
            username = (post.get('username') or '').strip()[:64]
            password = (post.get('password') or '')[:128]
            if not url:
                return None, 'Type the database URL.', ''
            if not re.match(r'^https?://\S+$', url, re.I):
                return None, 'The database URL must start with http:// or https://', ''
            if not username:
                return None, 'Type the user ID.', ''
            if not password:
                return None, 'Type the password.', ''
            kpi = Kpi.browse(Kpi.with_context(kpi_no_admin_arm=True).create_kpi({
                'name': '[Destroy] Destroy %s on %s' % (db.db_name, db.server_id.name),
                'kra_id': target.id, 'doc_type': 'requirement',
                'description': ('— Destroy request —\nDatabase: %s\nServer: %s\nURL: %s\n'
                                'User ID: %s\nPassword: on the request (staff only)\n'
                                'Reason: %s\n\nNOT ACTIONED. The database is still live. '
                                'Approve or refuse it on Clients > Live Databases.%s')
                               % (db.db_name, db.server_id.name, url, username, text, footer),
            }))
            router._finish_client_ticket(kpi, group, st, {
                'client_db_id': db.id, 'request_category': 'db_disconnect',
                'provision_url': url, 'provision_username': username,
                'provision_password': password,
            }, {'form': kind, 'db_id': db.id}, action='wa_client_form')
            receipt = db.request_disconnect(
                kpi=kpi, reason_text=text,
                by_number=router._participant_number(st), by_name=st.participant_name or '')
            return kpi, '', receipt

        common, cerr = self._common(post)
        if cerr:
            return None, cerr, ''

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
            kpi = Kpi.browse(Kpi.with_context(kpi_no_admin_arm=True).create_kpi(dict(common, **{
                'name': name, 'kra_id': target.id, 'doc_type': 'requirement',
                'description': '%s\n\nDatabase: %s%s' % (text, scope, footer),
                'deliverable_type': dv['deliverable_type'],
                'deliverable_other': dv['deliverable_other'],
            })))
            router._finish_client_ticket(kpi, group, st, {'client_db_id': db.id},
                                         {'form': kind, 'db_id': db.id},
                                         action='wa_client_form')
        elif self._legacy_on(post):
            # Bug / Update about a requirement from the OLD database: nothing
            # to pick here, so a voice note (or the Request ID / name / a typed
            # explanation) says what it is about. kpi_legacy.py.
            lref, lname, lnote = self._legacy_post(post)
            problem = legacy_input_problem(lref, lname, lnote, files)
            if problem:
                return None, problem, ''
            dv, dv_err = self._type_from_post(post)
            if dv_err:
                return None, dv_err, ''
            title = lname or (text.split('\n')[0][:80].strip() or 'Old DB requirement')
            kpi = Kpi.browse(Kpi.with_context(kpi_no_admin_arm=True).create_kpi(dict(common, **dv, **{
                'name': NAME_PREFIX_FOR_DOC_TYPE[kind] + _clean_title(title),
                'kra_id': target.id,
                'description': '%s\n\nAbout: an old DB requirement%s\nDatabase: %s%s' % (
                    text, ' — %s' % ' · '.join(x for x in (lref, lname) if x)
                    if (lref or lname) else ' (details to be confirmed)', scope, footer),
            })))
            router._finish_client_ticket(kpi, group, st, dict(
                Kpi._legacy_vals(lref, lname, lnote),
                client_db_id=db.id, external_ref=Kpi._legacy_new_ref(kind),
                requested_doc_type=kind,
            ), {'form': kind, 'db_id': db.id, 'old_db': True},
                action='wa_client_form')
            if files:
                self._attach(kpi, files, st)
            if lref:
                err = kpi._legacy_link(lref, lname)
                if err:
                    return None, err, ''
            kpi._after_commit_in_background('_legacy_transcribe')
            return kpi, '', ''
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
            ref = '%s%03d-%s' % (prefix, Kpi._next_child_number(prefix, parent.external_ref),
                                 parent.external_ref)
            base = re.sub(r'^\[(Update|Bug)\]\s*', '', parent.name or '', flags=re.I)
            # The type the client ticked (the form pre-ticks the requirement's).
            dv, dv_err = self._type_from_post(post, parent)
            if dv_err:
                return None, dv_err, ''
            kpi = Kpi.browse(Kpi.with_context(kpi_no_admin_arm=True).create_kpi(dict(common, **dv, **{
                'name': NAME_PREFIX_FOR_DOC_TYPE[kind] + base,
                'kra_id': parent.kra_id.id or target.id,
                'description': '%s\n\nAbout: %s — %s\nDatabase: %s%s' % (
                    text, parent.external_ref, base, scope, footer),
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

    def _common(self, post):
        """Urgency and Needed by: the web portal's New Request fields
        (/kpi_client_portal/add_task), same values and same rules."""
        priority = post.get('priority') or 'regular'
        if priority not in PRIORITY_CODES:
            return None, 'Choose the urgency.'
        deadline = False
        if post.get('needed_by'):
            try:
                deadline = fields.Date.to_date(post['needed_by'])
            except ValueError:
                return None, 'Needed by: pick a date.'
            if deadline < fields.Date.today():
                return None, 'Needed by cannot be in the past.'
        return {'priority': priority, 'deadline': deadline}, ''

    @staticmethod
    def _type_from_post(post, parent=None):
        """Module / App / EXE / Other as ticked on the form -> (vals, error).
        Nothing ticked on a Bug / Update about a requirement: the requirement's."""
        dv, err = clean_deliverable(request.httprequest.form.getlist('deliverable_type'),
                                    post.get('deliverable_other'))
        if err:
            return None, err
        if not dv['deliverable_type'] and parent:
            dv = {'deliverable_type': parent.deliverable_type or False,
                  'deliverable_other': parent.deliverable_other or False}
        if not dv['deliverable_type']:
            return None, 'Tick the type — Module, App, EXE or Other.'
        return dv, ''

    @staticmethod
    def _legacy_on(post):
        return (post.get('legacy_on') or '') in ('1', 'on', 'true')

    @staticmethod
    def _legacy_post(post):
        """(Request ID, Task name, typed explanation) of a From-old-DB request."""
        return ((post.get('legacy_ref') or '').strip()[:32],
                ' '.join((post.get('legacy_name') or '').split())[:200],
                (post.get('legacy_note') or '').strip()[:TEXT_MAX])

    def _resubmit_newdb(self, st, kpi, post):
        """A declined New Database request, fixed on the New Database form.
        Same record and ref; a blank password keeps the one sent before."""
        if kpi.correction_round >= kpi.MAX_CORRECTION_ROUNDS:
            return None, ('This has been sent back %d times already, so a person from the '
                          'team will contact you about it.') % kpi.correction_round, ''
        server = request.env['kpi.server'].sudo().browse(int(post.get('server_id') or 0)).exists()
        if not server:
            return None, 'Choose a server.', ''
        clean, errors = self._check_new_db(post.get('db_name'), server.id, fixing=kpi)
        if errors:
            return None, 'Database name: ' + '; '.join(errors), ''
        username = (post.get('username') or '').strip()[:64]
        password = (post.get('password') or '')[:128] or kpi.provision_password or ''
        if not username:
            return None, 'Type the username.', ''
        if not password:
            return None, 'Type or generate the password.', ''
        notes = (post.get('description') or '').strip()[:TEXT_MAX]
        if not notes:
            return None, 'Write which modules to install / notes.', ''
        who = st.participant_name or st.participant_key
        footer = '\n\n— Sent again from the WhatsApp form by %s after a decline.' % who
        old_ref = kpi.external_ref or ''
        vals = {
            'name': '[New DB] New DB %s on %s' % (clean, server.poll_label() or server.name),
            'description': ('— New database —\nServer: %s\nDatabase name: %s\n'
                            'Login: %s\nPassword: set on the request (Login / '
                            'Password fields)\nModules / notes: %s%s') % (
                                server.poll_label() or server.name, clean, username, notes, footer),
            'provision_server_id': server.id, 'provision_db_name': clean, 'provision_modules': notes,
            'provision_username': username, 'provision_password': password,
            'active': True, 'published': False, 'user_id': False,
            'task_state': 'queue_waiting', 'admin_accept_deadline_at': False,
            'client_reconfirm_state': 'corrected', 'client_dispute': False,
            'correction_round': kpi.correction_round + 1,
            'last_correction_text': clean, 'client_fix_token': False,
            'self_review_note': ('[CLIENT FIXED] New DB %s' % clean)[:255],
        }
        if not kpi.original_client_text:
            vals['original_client_text'] = kpi.description or ''
        kpi.write(vals)
        kpi._log_action('client_resubmitted', source='whatsapp', actor_label=who, payload={
            'round': kpi.correction_round, 'old_ref': old_ref, 'new_ref': kpi.external_ref,
            'old_kind': 'newdb', 'new_kind': 'newdb'})
        kpi._after_commit_in_background('_announce_new_client_ticket')
        return kpi, '', ''

    def _resubmit(self, st, kind, post):
        """A declined task, fixed by the client on the same form.

        Same record. The ref stays unless the type changed (then a new ref,
        with the old one kept in previous_external_ref). Back in the queue for
        the approval chain, exactly like a fresh request."""
        Kpi = request.env['kra.kpi'].sudo()
        kpi = st.client_form_fix_kpi_id.sudo().with_context(active_test=False)
        if kind == 'newdb':
            return self._resubmit_newdb(st, kpi, post)
        if kind not in dict(FIX_KINDS):
            return None, 'Choose Requirement, Bug or Update.', ''
        if kpi.correction_round >= kpi.MAX_CORRECTION_ROUNDS:
            return None, ('This has been sent back %d times already, so a person from the '
                          'team will contact you about it.') % kpi.correction_round, ''
        db = self._db_for(st, post.get('server_id'), post.get('db_id'))
        if not db:
            return None, 'Choose the server and the database.', ''
        text = (post.get('description') or '').strip()[:TEXT_MAX]
        if not text:
            return None, 'Write the summary / description.', ''
        files, ferr = self._files()
        if ferr:
            return None, ferr, ''
        common, cerr = self._common(post)
        if cerr:
            return None, cerr, ''
        who = st.participant_name or st.participant_key
        footer = '\n\n— Sent again from the WhatsApp form by %s after a decline.' % who
        scope = '%s (%s)' % (db.db_name, db.server_id.name)
        old_ref, old_kind = kpi.external_ref or '', kpi._kind_now()
        vals = dict(common, client_db_id=db.id)

        if kind == 'requirement':
            name = _clean_title(post.get('name'))
            if not name:
                return None, 'Type the task name.', ''
            dv, dv_err = clean_deliverable(request.httprequest.form.getlist('deliverable_type'),
                                           post.get('deliverable_other'))
            if dv_err:
                return None, dv_err, ''
            if not dv['deliverable_type']:
                return None, 'Tick the type — Module, App, EXE or Other.', ''
            vals.update(dv, name=name, related_req_ref=False,
                        description='%s\n\nDatabase: %s%s' % (text, scope, footer))
            if old_kind != 'requirement':
                vals['external_ref'] = 'REQ-%03d' % Kpi._next_ref_for_prefix('REQ')
        elif self._legacy_on(post):
            lref, lname, lnote = self._legacy_post(post)
            # The files sent the first time are still on the task: they count.
            problem = legacy_input_problem(lref, lname, lnote,
                                           files + kpi._legacy_existing_inputs())
            if problem:
                return None, problem, ''
            dv, dv_err = self._type_from_post(post)
            if dv_err:
                return None, dv_err, ''
            title = lname or (text.split('\n')[0][:80].strip() or 'Old DB requirement')
            vals.update(dv)
            vals.update(Kpi._legacy_vals(lref, lname, lnote),
                        name=NAME_PREFIX_FOR_DOC_TYPE[kind] + _clean_title(title),
                        related_req_ref=False, requested_doc_type=kind,
                        description='%s\n\nAbout: an old DB requirement\nDatabase: %s%s' % (
                            text, scope, footer))
            if old_kind != kind or kpi.related_req_ref:
                vals['external_ref'] = Kpi._legacy_new_ref(kind)
        else:
            try:
                parent = Kpi.browse(int(post.get('parent_id') or 0)).exists()
            except (TypeError, ValueError):
                parent = None
            if (not parent or parent == kpi or parent.client_db_id != db
                    or not (parent.external_ref or '').upper().startswith('REQ-')):
                return None, 'Pick the task this is about.', ''
            base = re.sub(r'^\[(Update|Bug)\]\s*', '', parent.name or '', flags=re.I)
            dv, dv_err = self._type_from_post(post, parent)
            if dv_err:
                return None, dv_err, ''
            vals.update(dv)
            vals.update(name=NAME_PREFIX_FOR_DOC_TYPE[kind] + base,
                        related_req_ref=parent.external_ref, requested_doc_type=kind,
                        description='%s\n\nAbout: %s — %s\nDatabase: %s%s' % (
                            text, parent.external_ref, base, scope, footer))
            if old_kind != kind or kpi.related_req_ref != parent.external_ref:
                prefix = REF_PREFIX_FOR_DOC_TYPE[kind]
                vals['external_ref'] = '%s%03d-%s' % (
                    prefix, Kpi._next_child_number(prefix, parent.external_ref),
                    parent.external_ref)
        if vals.get('external_ref') and old_ref:
            vals['previous_external_ref'] = old_ref
        if not kpi.original_client_text:
            vals['original_client_text'] = kpi.description or ''
        vals.update({
            'active': True, 'published': False, 'user_id': False,
            'task_state': 'queue_waiting', 'admin_accept_deadline_at': False,
            'client_reconfirm_state': 'corrected', 'client_dispute': False,
            'correction_round': kpi.correction_round + 1,
            'last_correction_text': text, 'client_fix_token': False,
            'self_review_note': ('[CLIENT FIXED] %s' % text)[:255],
        })
        kpi.write(vals)
        if kind != 'requirement' and self._legacy_on(post):
            lref, lname, _n = self._legacy_post(post)
            if lref:
                err = kpi._legacy_link(lref, lname)
                if err:
                    return None, err, ''
            kpi._after_commit_in_background('_legacy_transcribe')
        kpi._log_action('client_resubmitted', source='whatsapp', actor_label=who, payload={
            'round': kpi.correction_round, 'old_ref': old_ref, 'new_ref': kpi.external_ref,
            'old_kind': old_kind, 'new_kind': kind})
        kpi._after_commit_in_background('_announce_new_client_ticket')
        if files:
            self._attach(kpi, files, st)
        return kpi, '', ''

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
        """The request's details. _post_in_group puts a human opening line and
        the team name around them (kpi.wa.ack)."""
        who = st.participant_name or ''
        ref = kpi.external_ref or str(kpi.id)
        if kind == 'newdb':
            return ('🗄️ *New Database* — *%s*\nDatabase: *%s*\nServer: %s\nLogin: %s\n'
                    'Notes: %s') % (
                ref, kpi.provision_db_name or '',
                kpi.provision_server_id.name or '', post.get('username') or '',
                kpi.provision_modules or '—')
        db = kpi.client_db_id
        emoji, title = _TITLES.get(kind, ('', ''))
        lines = ['%s *%s* — *%s*' % (emoji, title, ref), kpi.name or '']
        if kpi.legacy_req_link:
            lines.append('About: %s' % self._legacy_about(kpi))
        elif kpi.related_req_ref:
            lines.append('About: %s' % kpi.related_req_ref)
        if db:
            lines.append('🗄️ %s (%s)' % (db.db_name, db.server_id.name))
        if who:
            lines.append('Sent by %s' % who)
        return '\n'.join(lines)

    @staticmethod
    def _legacy_about(kpi):
        """What the client gave about their old-system requirement, in their
        own words: "REQ-012 — Leave screen (old system)", else the name, else
        what they attached ("old system — 📷 1 photo, 🎤 1 voice note")."""
        ref, name = kpi.legacy_req_ref or '', kpi.legacy_req_name or ''
        if ref or name:
            return '%s (old system)' % ' — '.join(x for x in (ref, name) if x)
        counts = {}
        for f in kpi._legacy_client_files():
            n, mime = f['name'], f['mime']
            kind = ('🎤 voice note' if is_audio(n, mime) else
                    '🎥 video' if (mime or '').startswith('video/') or n.lower().endswith(
                        ('.mp4', '.mov', '.mkv', '.avi', '.3gp', '.m4v')) else
                    '📷 photo' if is_image_or_video(n, mime) else '📎 file')
            counts[kind] = counts.get(kind, 0) + 1
        sent = ', '.join('%d %s%s' % (c, k, 's' if c > 1 else '') for k, c in counts.items())
        if not sent and kpi.legacy_note:
            sent = '💬 message'
        return 'old system — %s' % sent if sent else 'old system'

    def _post_in_group(self, st, text):
        """Not instantly: 10-30 s later, like a person who read it first."""
        try:
            if not st.group_id.jid:
                return
            body = request.env['kpi.wa.ack'].sudo().wrap(text, 'received')
            request.env['kpi.notification.queue'].sudo().enqueue_delayed(
                st.group_id.jid, body, event='client_receipt',
                kpi_id=st.created_kpi_id.id or False)
        except Exception as exc:
            _logger.warning('client form saved but the WhatsApp receipt failed: %s', exc)
