"""Public client pre-approval endpoints.

These two routes power the WhatsApp-link approval UX:

  GET  /kpi/wa/<token>          → render the 4-color decision page
  POST /kpi/wa/<token>/decide   → record the decision, render confirmation

Both routes are `auth='public'` because the client tapping the link is not a
logged-in Odoo user.  Security comes from the 32-char HMAC token + the
single-use `approval_token_used` flag + the 24h expiry.  The token also
constant-time-compares via `hmac.compare_digest`.
"""

import hmac
import logging

from odoo import fields, http
from odoo.exceptions import UserError
from odoo.http import request

_logger = logging.getLogger(__name__)


def _render(template_xmlid, ctx):
    """Render a QWeb template and prepend an HTML5 doctype so browsers don't
    fall into quirks mode.  We do this in Python because Odoo's XML parser
    rejects `<!DOCTYPE html>` literals inside a <template> tag.
    """
    html = request.env['ir.qweb']._render(template_xmlid, ctx)
    body = (html if isinstance(html, str) else html.decode('utf-8'))
    # ''.join, not '+': the render is a Markup, and plain-str + Markup escapes
    # the plain side -- the doctype came out as "&lt;!DOCTYPE html&gt;" text
    # at the top of every page.
    return request.make_response(
        ''.join(['<!DOCTYPE html>\n', body]),
        headers=[
            ('Content-Type', 'text/html; charset=utf-8'),
            ('Cache-Control', 'no-store'),
            ('X-Frame-Options', 'DENY'),
        ],
    )


# Color hex used by the four buttons + the confirmation card background.
_ACTION_COLORS = {
    'approve': '#28a745',  # green
    'reject':  '#dc3545',  # red
    'hold':    '#ffc107',  # amber
    'clarify': '#0d6efd',  # blue
}

# Friendly labels for confirmation page.
_ACTION_LABELS = {
    'approve': 'Approved',
    'reject':  'Rejected',
    'hold':    'On Hold',
    'clarify': 'Clarification Requested',
}


def _lookup_task(token):
    """Resolve a token → kra.kpi row (sudo, single record) or None.
    Uses hmac.compare_digest for constant-time match — small detail but
    keeps the lookup uniform regardless of where a wrong token diverges.
    """
    if not token or len(token) < 8 or len(token) > 64:
        return None
    candidates = request.env['kra.kpi'].sudo().search([
        ('approval_token', '!=', False),
        ('approval_token', '=', token),
    ], limit=1)
    if not candidates:
        return None
    # Constant-time confirm — defends against timing leaks if the DB short-circuits.
    if not hmac.compare_digest(candidates.approval_token or '', token):
        return None
    return candidates


def _signers_for_page(task):
    """The Full Name list for the page: key, name and the saved signature as a
    data URL (so picking a name shows it at once)."""
    out = []
    for e in task.sudo()._client_signers():
        sig = e.get('sig')
        if isinstance(sig, bytes):
            sig = sig.decode()
        out.append({'key': e['key'], 'name': e['name'],
                    'sig': ('data:image/png;base64,%s' % sig) if sig else ''})
    return out


def _media_kind(name):
    """'image' / 'video' / 'audio' / 'doc' from the file name."""
    from .kra_api import _guess_mime
    mime = _guess_mime(name or '', '') or ''
    for k in ('image', 'video', 'audio'):
        if mime.startswith(k + '/'):
            return k
    return 'doc'


def _team_files(task, token):
    """The team's files on the task -- progress updates (never the client's own
    attachments) and user manuals -- for the client's finishing page, each with
    a link that works only through this page's token (/kpi/wa/<token>/media)."""
    out = []

    def add(kind, entry, att, name):
        if name:
            out.append({'name': name, 'kind': _media_kind(name),
                        'url': '/kpi/wa/%s/file?kind=%s&entry=%s&att=%s' % (token, kind, entry.id, att)})

    Att = request.env['kpi.file.attachment'].sudo()
    for p in request.env['kpi.progress'].sudo().search(
            [('kpi_id', '=', task.id), ('from_client', '=', False)], order='create_date desc'):
        add('progress', p, 0, p.file_name)
        for a in Att.search([('progress_id', '=', p.id)], order='sequence, id'):
            add('progress', p, a.id, a.file_name)
    for m in request.env['kpi.user.manual'].sudo().search([('kpi_id', '=', task.id)], order='id desc'):
        add('manual', m, 0, m.file_name)
        for a in Att.search([('manual_id', '=', m.id)], order='sequence, id'):
            add('manual', m, a.id, a.file_name)
    return out[:40]


class KpiWaApproval(http.Controller):

    # ------------------------------------------------------------------ #
    # GET /kpi/wa/<token>                                                 #
    # ------------------------------------------------------------------ #
    @http.route('/kpi/wa/<string:token>', type='http', auth='public',
                methods=['GET'], csrf=False, website=False)
    def render_approval_page(self, token, **kw):
        task = _lookup_task(token)
        if not task:
            return _render('kra_kpi_module.wa_approval_expired',
                                  {'reason': 'Token not recognized.'})

        now = fields.Datetime.now()
        # The sign-off link (awaiting_client) has no timer: it ends when used.
        if (task.task_state != 'awaiting_client' and task.approval_token_expires
                and task.approval_token_expires < now):
            return _render('kra_kpi_module.wa_approval_expired',
                                  {'reason': 'This approval link has expired.'})

        # Already decided with a TERMINAL action → render the already-decided
        # page so the client knows the system has it.
        if task.approval_token_used and task.pre_approval_decision != 'clarify':
            return _render('kra_kpi_module.wa_approval_already_decided', {
                'task':     task,
                'decision': task.pre_approval_decision,
                'decision_label': _ACTION_LABELS.get(task.pre_approval_decision, ''),
                'decision_color': _ACTION_COLORS.get(task.pre_approval_decision, '#6c757d'),
            })

        # Final sign-off page reuses the same template but trims the button
        # set to Approve / Reject / Clarify (no Hold) and labels the heading
        # accordingly.  The QWeb template reads `stage` to swap copy.
        stage = 'final' if task.task_state == 'awaiting_client' else 'pre'
        # A Partial Finish: the page says so and shows the team's summary.
        partial = stage == 'final' and bool(task.sudo().finish_partial)
        return _render('kra_kpi_module.wa_signoff_page' if stage == 'final' else 'kra_kpi_module.wa_approval_page', {
            'task':   task,
            'token':  task.approval_token,
            'colors': _ACTION_COLORS,
            'stage':  stage,
            'partial': partial,
            'partial_summary': task.sudo()._finish_partial_summary() if partial else '',
            'partial_n': task.sudo().partial_finish_count if partial else 0,
            # The team's photos, videos and documents, viewable like KPI Details.
            'team_files': _team_files(task, token) if stage == 'final' else [],
            # Full Name: only this task's client's people (KRA Master client users
            # + its WhatsApp group's client members), each with a saved signature.
            'signers': _signers_for_page(task),
        })

    # ------------------------------------------------------------------ #
    # GET /kpi/wa/<token>/media -- one of the team's files, for the       #
    # finishing page (only while the sign-off link is valid).             #
    # ------------------------------------------------------------------ #
    # /file is what the shared viewer.js opens in its popup (photos, videos,
    # audio, PDFs); /media is the 7.97 name, kept for links already out.
    @http.route(['/kpi/wa/<string:token>/file', '/kpi/wa/<string:token>/media'], type='http',
                auth='public', methods=['GET'], csrf=False, website=False)
    def media(self, token, kind='', entry='0', att='0', **kw):
        task = _lookup_task(token)
        if not task or task.task_state != 'awaiting_client':
            return request.not_found()
        if kind == 'progress':
            p = request.env['kpi.progress'].sudo().browse(int(entry or 0)).exists()
            if not p or p.from_client:
                return request.not_found()
        from .kpi_wa_task_page import KpiWaTaskPage
        return KpiWaTaskPage()._send_file(kind, entry, att, [task.id], download=kw.get('download'))

    # ------------------------------------------------------------------ #
    # POST /kpi/wa/<token>/decide                                         #
    # ------------------------------------------------------------------ #
    @http.route('/kpi/wa/<string:token>/decide', type='http', auth='public',
                methods=['POST'], csrf=False, website=False)
    def submit_decision(self, token, **post):
        task = _lookup_task(token)
        if not task:
            return _render('kra_kpi_module.wa_approval_expired',
                                  {'reason': 'Token not recognized.'})

        action = (post.get('action') or '').strip().lower()
        if action not in ('approve', 'reject', 'hold', 'clarify'):
            return _render('kra_kpi_module.wa_approval_expired',
                                  {'reason': 'Invalid action submitted.'})

        partner_name = (post.get('partner_name') or '').strip()
        feedback = (post.get('feedback') or '').strip()

        # Network metadata for the audit log.
        try:
            ip = request.httprequest.remote_addr
            ua = (request.httprequest.user_agent.string
                  if request.httprequest.user_agent else None)
        except Exception:
            ip, ua = None, None

        final = task.task_state == 'awaiting_client'
        done = lambda icon, title, msg: _render('kra_kpi_module.wa_signoff_done', {  # noqa: E731
            'task': task, 'icon': icon, 'title': title, 'message': msg})
        # Full Name picked from this client's people: never someone else's.
        signers = {e['key']: e for e in task.sudo()._client_signers()}
        signer_key, partner_id = (post.get('signer') or '').strip(), None
        if signers:
            pick = signers.get(signer_key)
            if not pick:
                return done('⚠️', "Couldn't save", 'Pick your name from the list.') if final else                     _render('kra_kpi_module.wa_approval_expired', {'reason': 'Pick your name from the list.'})
            partner_name, partner_id = pick['name'], pick['partner_id'] or None
        # ✓ Accept & Sign needs a signature (a PNG from the sign box).
        sig_b64 = ''
        raw_sig = post.get('signature') or ''
        if raw_sig.startswith('data:image/png;base64,'):
            sig_b64 = raw_sig.split(',', 1)[1]
        if final and action == 'approve':
            if not sig_b64 or len(sig_b64) > 3 * 1024 * 1024:
                return done('✍️', 'Please sign', 'Go back, sign in the box, then tap Accept & Sign.')
            task.sudo()._save_client_signature(signer_key, sig_b64)
        try:
            if task.task_state == 'awaiting_client':
                # Final sign-off — only approve / reject / clarify make sense
                # here; map a stray 'hold' to 'clarify' so the URL never 500s.
                if action == 'hold':
                    action = 'clarify'
                # 📎 Send back with proof: photos / videos / voice notes come
                # in the same multipart form, as `files`.
                from .kpi_client_chat import chat_upload_files
                result = task.sudo().record_client_final_decision(
                    action=action,
                    partner_name=partner_name,
                    feedback=feedback,
                    source='web',
                    ip=ip,
                    user_agent=ua,
                    partner_id=partner_id,
                    files=chat_upload_files() if action == 'reject' else None,
                    sendback_source='whatsapp',
                )
            else:
                result = task.sudo().record_client_pre_decision(
                    action=action,
                    partner_id=partner_id,
                    partner_name=partner_name,
                    feedback=feedback,
                    source='web',
                    ip=ip,
                    user_agent=ua,
                )
        except UserError as ue:
            if final:
                # Never "Link Expired" for something only our team can fix.
                return done('⚠️', "Couldn't save", '%s' % ue)
            return _render('kra_kpi_module.wa_approval_expired',
                                  {'reason': str(ue)})
        except Exception as exc:
            _logger.exception("kpi_wa_approval decide error: %s", exc)
            return _render('kra_kpi_module.wa_approval_expired',
                                  {'reason': 'Unexpected error.  Please contact the team.'})

        status = result.get('status')
        if status == 'expired':
            return _render('kra_kpi_module.wa_approval_expired',
                                  {'reason': 'This approval link has expired.'})
        if status == 'already_decided':
            return _render('kra_kpi_module.wa_approval_already_decided', {
                'task':     task,
                'decision': result.get('decision'),
                'decision_label': _ACTION_LABELS.get(result.get('decision'), ''),
                'decision_color': _ACTION_COLORS.get(result.get('decision'), '#6c757d'),
            })

        if final:
            return done(*{
                'approve': ('✅', 'Thank you — finished', result.get('message') if result.get('pending_team')
                            else 'We have your sign-off. The task is closed.'),
                'reject': ('↩️', 'Sent back', 'The developer has your notes and will fix it.'),
                'clarify': ('💬', 'Question sent', result.get('message') or 'Your question was sent.'),
            }.get(action, ('✅', 'Saved', result.get('message') or '')))

        # status == 'ok' — render the confirmation card colored by action.
        return _render('kra_kpi_module.wa_approval_confirmed', {
            'task':     task,
            'decision': action,
            'decision_label': _ACTION_LABELS.get(action, ''),
            'decision_color': _ACTION_COLORS.get(action, '#6c757d'),
            'partner_name':   partner_name,
        })
