"""WhatsApp "🌙 End my day" -> the End Workday page in the browser.

The bot sends the developer a private link (/kpi/wa/endday/<token>, 2 hours).
The page shows the day like the web's End Workday dialog and asks for a
summary for EACH task worked today -- required, the same rule /kpi_workday/end
enforces -- then ends the day with kpi.work.session.action_end_day, which sends
the snapshot and message to the developer and the admins as from any screen.
"""

import hmac
import logging
from types import SimpleNamespace
from urllib.parse import urlencode

from odoo import fields, http
from odoo.http import request

from .kpi_wa_approval import _render

_logger = logging.getLogger(__name__)

NOTE_MAX = 2000
SUMMARY_MAX = 500


def _end_state(token):
    if not token or len(token) < 16 or len(token) > 64:
        return None
    st = request.env['kpi.wa.group.intake'].sudo().search([('staff_end_token', '=', token)], limit=1)
    if not st or not hmac.compare_digest(st.staff_end_token or '', token):
        return None
    if not st.staff_end_expires or st.staff_end_expires < fields.Datetime.now():
        return None
    return st


class KpiWaEndDay(http.Controller):

    def _resolve(self, token):
        st = _end_state(token)
        if not st:
            return None, None
        user, ok = request.env['kpi.wa.group.router'].sudo()._staff_member(st, st.group_id)
        return (st, user) if ok else (None, None)

    def _expired(self):
        return _render('kra_kpi_module.wa_approval_expired', {
            'reason': 'This end-of-day link has expired. Tap 🌙 End my day in WhatsApp for a fresh one.'})

    def _missing(self, user):
        return request.env['kpi.work.session'].sudo()._tasks_missing_progress_today(user=user)

    def _back(self, token, ok='', err=''):
        return request.redirect('/kpi/wa/endday/%s?%s' % (token, urlencode({'ok': ok} if ok else {'err': err})),
                                local=True)

    @http.route('/kpi/wa/endday/<string:token>', type='http', auth='public',
                methods=['GET'], csrf=False, website=False)
    def page(self, token, ok='', err='', **kw):
        st, user = self._resolve(token)
        if not user:
            return self._expired()
        router = request.env['kpi.wa.group.router'].sudo()
        sess, is_open, ended = router._workday(user)
        if not is_open:
            return _render('kra_kpi_module.wa_endday_done', {
                'title': 'Your day is already closed.' if ended else 'Your day is not open.',
                'sub': ''})
        sess.invalidate_recordset(['productive_seconds', 'presence_seconds', 'task_count'])
        d = sess._daily_summary_payload(full_day=True)
        return _render('kra_kpi_module.wa_endday_page', {
            'token': token, 'd': d, 'missing': self._missing(user), 'ok': ok, 'err': err,
            'user_name': user.name, 'theme': user._kpi_wa_color()[1]})

    @http.route('/kpi/wa/endday/<string:token>/summary', type='http', auth='public',
                methods=['POST'], csrf=False, website=False)
    def summary(self, token, **post):
        st, user = self._resolve(token)
        if not user:
            return self._expired()
        try:
            kpi_id = int(post.get('kpi_id') or 0)
        except ValueError:
            kpi_id = 0
        text = (post.get('summary') or '').strip()
        if kpi_id not in {m['kpi_id'] for m in self._missing(user)}:
            return self._back(token, err='That task does not need a summary.')
        if not text:
            return self._back(token, err='Write what you did on this task first.')
        request.env(user=user.id, su=True)['kpi.progress'].create({
            'kpi_id': kpi_id, 'summary': text[:SUMMARY_MAX], 'user_id': user.id, 'related_links': '[]'})
        return self._back(token, ok='Summary saved.')

    @http.route('/kpi/wa/endday/<string:token>/end', type='http', auth='public',
                methods=['POST'], csrf=False, website=False)
    def end(self, token, **post):
        st, user = self._resolve(token)
        if not user:
            return self._expired()
        if self._missing(user):
            return self._back(token, err='Add a summary for each task you worked on today — the day ends only '
                                         'after that.')
        router = request.env['kpi.wa.group.router'].sudo()
        sess, is_open, _ended = router._workday(user)
        if not is_open:
            return _render('kra_kpi_module.wa_endday_done', {'title': 'Your day is already closed.', 'sub': ''})
        try:
            sess.with_user(user).sudo().action_end_day(note=(post.get('note') or '').strip()[:NOTE_MAX])
        except Exception as exc:
            _logger.exception('end day from page failed')
            return self._back(token, err='Could not end your day: %s' % str(exc)[:200])
        st.sudo().write({'staff_end_token': False, 'staff_end_expires': False})
        try:
            session = request.env['whatsapp.session'].sudo().search([('status', '=', 'connected')], limit=1)
            if session and st.group_id.jid:
                router.with_context(kpi_wa_owner_mark=user._kpi_wa_color()[0])._text(
                    SimpleNamespace(phone=st.group_id.jid, session_id=session),
                    '🌙 Day closed, %s. Thanks.' % (user.name or ''))
        except Exception as exc:
            _logger.warning('end day group note failed: %s', exc)
        return _render('kra_kpi_module.wa_endday_done', {
            'title': '🌙 Your day is closed.', 'theme': user._kpi_wa_color()[1],
            'sub': 'Your workday snapshot and summary have been sent. Go back to WhatsApp.'})
