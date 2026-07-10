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
    return request.make_response(
        '<!DOCTYPE html>\n' + body,
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
        if task.approval_token_expires and task.approval_token_expires < now:
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
        return _render('kra_kpi_module.wa_approval_page', {
            'task':   task,
            'token':  task.approval_token,
            'colors': _ACTION_COLORS,
            'stage':  stage,
        })

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

        try:
            if task.task_state == 'awaiting_client':
                # Final sign-off — only approve / reject / clarify make sense
                # here; map a stray 'hold' to 'clarify' so the URL never 500s.
                if action == 'hold':
                    action = 'clarify'
                result = task.sudo().record_client_final_decision(
                    action=action,
                    partner_name=partner_name,
                    feedback=feedback,
                    source='web',
                    ip=ip,
                    user_agent=ua,
                )
            else:
                result = task.sudo().record_client_pre_decision(
                    action=action,
                    partner_name=partner_name,
                    feedback=feedback,
                    source='web',
                    ip=ip,
                    user_agent=ua,
                )
        except UserError as ue:
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

        # status == 'ok' — render the confirmation card colored by action.
        return _render('kra_kpi_module.wa_approval_confirmed', {
            'task':     task,
            'decision': action,
            'decision_label': _ACTION_LABELS.get(action, ''),
            'decision_color': _ACTION_COLORS.get(action, '#6c757d'),
            'partner_name':   partner_name,
        })
