# -*- coding: utf-8 -*-
"""369 AI Assistant (Owner Dashboard) — the Odoo side.

The controller (/kra_kpi/ai_assistant/ask) builds the period's digest and hands
it here. This model adds today's workday sessions and the developer roster,
then lets kpi_ai_assistant_engine read the question and build the answer from
that data. No AI is involved by default.

When an AI key is configured (kpi.ai.is_available()), the AI is asked ONLY to
write a one-paragraph summary of the answer the rules already computed — the
tables and numbers always come from the data. Any AI failure leaves the
rule-based answer untouched. With no key, nothing leaves the server.
"""
import json
import logging

import pytz
from markupsafe import Markup, escape

from odoo import api, fields, models

from . import kpi_ai_assistant_engine as engine

_logger = logging.getLogger(__name__)

_AI_SYSTEM = (
    "You are 369 AI Assistant for a team's KRA/KPI task board. You get a user's "
    "question and the ANSWER DATA already computed from the live board. Write a short, "
    "plain-English reply (2-4 sentences) that answers the question using ONLY that data. "
    "Never invent names, numbers or tasks. If the data is empty, say so. "
    'Reply as JSON: {"text": "..."}'
)


class KpiAiChat(models.Model):
    """One saved 369 AI Assistant conversation (per user). The web drawer's
    History lists these; every question and answer is a kpi.ai.chat.message."""
    _name = 'kpi.ai.chat'
    _description = '369 AI Assistant chat'
    _order = 'write_date desc, id desc'

    name = fields.Char(required=True, default='New chat')
    user_id = fields.Many2one('res.users', required=True, index=True, ondelete='cascade',
                              default=lambda self: self.env.user)
    period = fields.Char(default='today')
    context_json = fields.Text(help='The last answer\'s follow-up context, so "and last week?" works after reopening.')
    message_ids = fields.One2many('kpi.ai.chat.message', 'chat_id', string='Conversation')
    message_count = fields.Integer(compute='_compute_message_count')
    question_count = fields.Integer('Questions', compute='_compute_message_count')

    @api.depends('message_ids', 'message_ids.role')
    def _compute_message_count(self):
        for chat in self:
            chat.message_count = len(chat.message_ids)
            chat.question_count = len(chat.message_ids.filtered(lambda m: m.role == 'user'))

    def _as_dict(self, with_messages=False):
        self.ensure_one()
        out = {'id': self.id, 'title': self.name, 'period': self.period or 'today',
               'updated': fields.Datetime.to_string(self.write_date), 'count': self.message_count}
        if with_messages:
            try:
                out['context'] = json.loads(self.context_json or '{}')
            except ValueError:
                out['context'] = {}
            out['messages'] = [m._as_dict() for m in self.message_ids.sorted('id')]
        return out


class KpiAiChatMessage(models.Model):
    _name = 'kpi.ai.chat.message'
    _description = '369 AI Assistant chat message'
    _order = 'id'

    chat_id = fields.Many2one('kpi.ai.chat', required=True, index=True, ondelete='cascade')
    role = fields.Selection([('user', 'Question'), ('bot', 'Answer')], required=True)
    text = fields.Text(help='The question, or the answer\'s one-line title.')
    payload_json = fields.Text(help='The full answer (blocks, suggestions, period) as the web drew it.')
    answer_html = fields.Html('Answer', compute='_compute_answer_html', sanitize=True)

    @api.depends('payload_json', 'role', 'text')
    def _compute_answer_html(self):
        """The saved answer drawn for the Odoo backend (AI Assistant Chats):
        title, stat tiles, tables (first 50 rows), lists and text."""
        for m in self:
            if m.role != 'bot':
                m.answer_html = False
                continue
            try:
                res = json.loads(m.payload_json or '{}')
            except ValueError:
                res = {'title': m.text}
            m.answer_html = Markup(self._answer_to_html(res))

    @api.model
    def _answer_to_html(self, res):
        cell = lambda v: escape('-' if v in (None, '') else v)
        th = 'style="text-align:left;padding:4px 8px;border-bottom:2px solid #d0d7e2;background:#eef2ff"'
        td = 'style="padding:4px 8px;border-bottom:1px solid #e5e9f0"'
        out = []
        if res.get('title'):
            out.append('<p><b>%s</b></p>' % escape(res['title']))
        dr = res.get('date_range') or {}
        if dr.get('start'):
            out.append('<p style="color:#6b7280;font-size:12px">Period: %s%s</p>' % (
                escape(dr['start']), (' to %s' % escape(dr['end'])) if dr.get('end') and dr['end'] != dr['start'] else ''))
        for b in res.get('blocks') or []:
            kind = b.get('type')
            if kind == 'stats':
                items = b.get('items') or []
                out.append('<table style="border-collapse:collapse;margin:4px 0 8px"><tr>%s</tr><tr>%s</tr></table>' % (
                    ''.join('<th %s>%s</th>' % (th, escape(i.get('label'))) for i in items),
                    ''.join('<td %s><b>%s</b></td>' % (td, cell(i.get('value'))) for i in items)))
            elif kind == 'table':
                cols = b.get('columns') or []
                rows = (b.get('rows') or [])[:50]
                more = len(b.get('rows') or []) - len(rows) + (b.get('more') or 0)
                out.append('<table style="border-collapse:collapse;margin:4px 0 8px;width:100%%"><tr>%s</tr>%s</table>' % (
                    ''.join('<th %s>%s</th>' % (th, escape(c.get('label'))) for c in cols),
                    ''.join('<tr>%s</tr>' % ''.join('<td %s>%s</td>' % (td, cell(r.get(c.get('key')))) for c in cols) for r in rows)))
                if more > 0:
                    out.append('<p style="color:#6b7280;font-size:12px">+%d more rows not shown.</p>' % more)
            elif kind == 'list':
                if b.get('title'):
                    out.append('<p style="margin:6px 0 2px"><b>%s</b></p>' % escape(b['title']))
                out.append('<ul>%s</ul>' % ''.join('<li>%s</li>' % escape(i) for i in b.get('items') or []))
            elif b.get('text'):
                out.append('<p>%s</p>' % escape(b['text']))
        return ''.join(out)

    def _as_dict(self):
        self.ensure_one()
        if self.role == 'user':
            return {'role': 'user', 'text': self.text or ''}
        try:
            res = json.loads(self.payload_json or '{}')
        except ValueError:
            res = {'title': self.text or '', 'blocks': []}
        return {'role': 'bot', 'res': res}


class KpiAiAssistant(models.AbstractModel):
    _name = 'kpi.ai.assistant'
    _description = 'KPI AI Assistant (rule-based answers, optional AI summary)'

    # ------------------------------------------------------------------ data
    @api.model
    def _local_hm(self, dt):
        if not dt:
            return ''
        tz = pytz.timezone(self.env.user.tz or 'Asia/Kolkata')
        return pytz.UTC.localize(dt).astimezone(tz).strftime('%I:%M %p').lstrip('0')

    @api.model
    def _workday(self):
        """Today's workday sessions plus the developers who have none yet."""
        Session = self.env['kpi.work.session'].sudo()
        today = fields.Date.context_today(self)
        sessions = Session.search([('session_date', '=', today)])
        by_user = {}
        for s in sessions:  # _order is latest login first: keep each user's latest
            if s.user_id and s.user_id.id not in by_user:
                by_user[s.user_id.id] = s
        rows = [{
            'name': s.user_id.name,
            'state': s.state,
            'is_paused': bool(getattr(s, 'is_paused', False)),
            'login_at': self._local_hm(s.login_at),
            'logout_at': self._local_hm(s.logout_at) if s.state != 'open' else '',
        } for s in by_user.values()]
        # Same roster rule as Live Tracking: pure developers with app access.
        try:
            devs = self.env.ref('kra_kpi_module.group_kra_developer').sudo().user_ids.filtered(
                lambda u: u.active and not u.share
                and getattr(u, 'kpi_app_login_enabled', True)
                and not u.has_group('kra_kpi_module.group_kra_admin')
                and not u.has_group('base.group_system'))
        except Exception as exc:  # roster is a nice-to-have; never fail the answer
            _logger.warning('ai assistant: developer roster failed: %s', exc)
            devs = self.env['res.users']
        without = sorted(u.name for u in devs if u.id not in by_user)
        return {'sessions': rows, 'without': without}

    @api.model
    def _find_tasks(self, text, limit=30):
        """Tasks whose reference or name matches `text`, across ALL tasks (any
        state, any date), newest activity first, in the digest's task shape.
        Empty text: the most recently updated tasks."""
        KPI = self.env['kra.kpi'].sudo()
        text = (text or '').strip()
        domain = []
        if text:
            ref = engine._REF_RX.search(text)
            if ref:
                domain = [('external_ref', '=ilike', ref.group(1))]
            else:
                words = [w for w in text.split() if len(w) > 1][:6] or [text]
                for w in words:
                    domain += ['|', ('name', 'ilike', w), ('external_ref', 'ilike', w)]
        tasks = KPI.search(domain, order='write_date desc, id desc', limit=limit)
        now = fields.Datetime.now()
        out = []
        for t in tasks:
            st = t.task_state
            out.append({
                'id': t.id, 'ref': t.external_ref or '', 'name': t.name,
                'person': t.user_id.name if t.user_id else 'Unassigned',
                'status': st, 'priority': t.priority or 'regular',
                'estimated_hours': round((t.estimate_hours or 0) + (t.estimate_minutes or 0) / 60.0, 2),
                'actual_hours': round((t.timer_total_seconds or 0) / 3600.0, 2),
                'days_paused': (now - t.write_date).days if st == 'paused' and t.write_date else 0,
                'days_not_started': (now - t.create_date).days if st in engine.NOT_STARTED_STATES and t.create_date else 0,
                'paused_reason': t.paused_reason or '',
                'deadline': str(t.deadline) if t.deadline else '',
            })
        return out

    # ---------------------------------------------------------------- answer
    @api.model
    def answer(self, question, digest, period, context=None, max_rows=engine.MAX_ROWS):
        """`max_rows` caps table rows: the drawer shows 50; a download asks for all."""
        # "Status of REQ-146" / "find task login": look the task up in ALL tasks,
        # not only the period's digest (an old completed task is not in it).
        search = engine.extract_search(question)
        if search:
            found = self._find_tasks(search, limit=max(30, max_rows))
            if found:
                res = engine.task_answer(search, found, max_rows=max_rows)
                res.update({'ai': False, 'source': 'rules'})
                return res
        workday = self._workday()
        tz = pytz.timezone(self.env.user.tz or 'Asia/Kolkata')
        hour = pytz.UTC.localize(fields.Datetime.now()).astimezone(tz).hour
        res = engine.answer(question, digest, period, context or {}, workday,
                            today=fields.Date.context_today(self), user_name=self.env.user.name, hour=hour,
                            max_rows=max_rows)
        res.update({'ai': False, 'source': 'rules'})

        ai = self.env['kpi.ai']
        if res.get('intent') not in ('help', 'unknown', 'smalltalk') and ai.is_available():
            data, source = ai.complete_json(
                _AI_SYSTEM,
                'QUESTION: %s\n\nANSWER DATA:\n%s' % (question, self._compact(res)),
                max_tokens=400)
            text = (data or {}).get('text') if isinstance(data, dict) else None
            if text:
                res['blocks'] = [{'type': 'text', 'text': str(text).strip()}] + res['blocks']
                res.update({'ai': True, 'source': source})
        return res

    @api.model
    def _compact(self, res):
        """The computed answer as small JSON for the optional AI summary."""
        out = {'title': res.get('title'), 'blocks': []}
        for b in res.get('blocks') or []:
            if b.get('type') == 'table':
                out['blocks'].append({'rows': b['rows'][:25], 'more': b.get('more', 0)})
            else:
                out['blocks'].append({k: v for k, v in b.items() if k != 'type'})
        return json.dumps(out, default=str)[:12000]
