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
        missing = self._missing(user)
        # Every task worked today, each with today's summary or a box for one.
        # A task with time but missing from d['tasks'] (still running) is added.
        tasks = list(d.get('tasks') or [])
        listed = {t.get('kpi_id') for t in tasks}
        for m in missing:
            if m['kpi_id'] not in listed:
                tasks.append({'kpi_id': m['kpi_id'], 'ref': m.get('external_ref') or '#%s' % m['kpi_id'],
                              'name': m.get('name'), 'duration_display': ''})
        W = request.env['kpi.work.session'].sudo()
        ids = [t.get('kpi_id') for t in tasks if t.get('kpi_id')]
        summaries = W._task_summaries_today(user, ids)
        # "What did you work on today?" is filled from the summaries, not typed.
        work_blocks = W._today_work_blocks(user, ids)
        return _render('kra_kpi_module.wa_endday_page', {
            'token': token, 'd': d, 'missing': missing, 'ok': ok, 'err': err,
            'tasks': tasks, 'summaries': summaries, 'work_blocks': work_blocks,
            'missing_ids': [m['kpi_id'] for m in missing],
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
        # One end per day, even on a double tap: lock the day's row first. A
        # second request arriving while the first is closing it used to fail
        # with "transaction aborted" and show the phone an Internal Server Error
        # (22 Oct 2026) -- now it just says the day is closed.
        import psycopg2
        try:
            with request.env.cr.savepoint():
                request.env.cr.execute(
                    'SELECT id FROM kpi_work_session WHERE id = %s FOR UPDATE NOWAIT', (sess.id,))
        except (psycopg2.errors.LockNotAvailable, psycopg2.errors.SerializationFailure):
            return _render('kra_kpi_module.wa_endday_done', {
                'title': 'Your day is being closed.', 'sub': 'It was already sent — go back to WhatsApp.'})
        sess.invalidate_recordset(['state'])
        if sess.state != 'open':
            return _render('kra_kpi_module.wa_endday_done', {'title': 'Your day is already closed.', 'sub': ''})
        # The day's note is built from today's task summaries (the page shows it,
        # read-only), so what is sent is exactly what was written on the tasks.
        W = request.env['kpi.work.session'].sudo()
        d = sess._daily_summary_payload(full_day=True)
        ids = [t.get('kpi_id') for t in (d.get('tasks') or []) if t.get('kpi_id')]
        note = W._today_work_note(W._today_work_blocks(user, ids))
        try:
            sess.with_user(user).sudo().action_end_day(note=note[:NOTE_MAX])
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
