# -*- coding: utf-8 -*-
"""369 AI Assistant (Owner Dashboard) — the Odoo side.

The controller (/kra_kpi/ai_assistant/ask) builds the period's digest and hands
it here. This model adds today's workday sessions and the developer roster,
then lets kpi_ai_assistant_engine read the question and build the answer from
that data. No AI is involved by default.

When an AI key is configured (kpi.ai.is_available(); Configuration > 369 AI
Assistant), two things change:
  - a question the rules understood gets a short AI summary on top of the
    rule-built answer (the tables and numbers always come from the data);
  - a question the rules did NOT understand goes to the AI with a compact copy
    of the live data, and the AI answers it in plain words.
Both see the chat's last few turns (`history`), so follow-ups read naturally.
Any AI failure leaves the rule-based answer untouched. With no key, nothing
leaves the server.
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

# For questions the rules don't know: the AI answers from the live data itself.
_AI_CHAT_SYSTEM = (
    "You are 369 AI Assistant, the assistant inside a team's KRA/KPI task board. You chat "
    "with the owner or an admin the way ChatGPT or Claude would: friendly, direct, plain "
    "English. The latest message carries LIVE DATA from the board (one period: a summary, "
    "each person's tasks and counts, alerts, and today's workday sessions) and then the "
    "QUESTION. Earlier messages are the conversation so far; use them to understand "
    "follow-ups like 'and him?' or 'only the urgent ones'.\n"
    "Rules: names, numbers, tasks and dates come ONLY from the LIVE DATA. Never invent "
    "them. If the data cannot answer the question, say so plainly and say what it does "
    "show. General questions (how to use the board, advice on running the team, drafting "
    "a short message) you may answer from general knowledge. Hours are decimal hours. "
    "Keep it short: 1-6 sentences, or a few lines starting with '- ' for a list.\n"
    'Reply as JSON only: {"text": "...", "suggestions": ["up to 3 short follow-up questions"]}'
)
_HISTORY_TURNS = 6          # questions + answers of the chat the AI gets to see
_HISTORY_CHARS = 600        # per turn
_AI_TIMEOUT = 25            # seconds per provider, so the cascade fits the web's wait


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
    def answer(self, question, digest, period, context=None, max_rows=engine.MAX_ROWS, history=None):
        """`max_rows` caps table rows: the drawer shows 50; a download asks for all.
        `history` is the chat so far, [{role: 'user'|'assistant', text}], oldest
        first (see history_of); only the AI uses it."""
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
        if not ai.is_available():
            return res
        intent = res.get('intent')
        history = (history or [])[-_HISTORY_TURNS:]
        if intent == 'help':
            for b in res.get('blocks') or []:
                if b.get('type') == 'text' and 'AI is off' in (b.get('text') or ''):
                    b['text'] = ('AI is on: ask anything about the team in your own words, and '
                                 'follow up the way you would in a chat. Names and numbers always '
                                 'come from the live board.')
        elif intent == 'unknown':
            # The rules don't know this question: the AI answers it from the data.
            data, source = ai.complete_chat_json(
                _AI_CHAT_SYSTEM,
                history + [{'role': 'user', 'text': 'LIVE DATA:\n%s\n\nQUESTION: %s' % (
                    self._compact_digest(digest, workday, period), question)}],
                max_tokens=700, timeout=_AI_TIMEOUT)
            text = (data or {}).get('text') if isinstance(data, dict) else None
            if text:
                sugg = data.get('suggestions') if isinstance(data.get('suggestions'), list) else []
                res.update({
                    'title': '', 'intent': 'ai', 'ai': True, 'source': source,
                    'blocks': [{'type': 'text', 'text': str(text).strip()}],
                    'suggestions': [str(s).strip()[:80] for s in sugg if str(s).strip()][:3] or res.get('suggestions') or [],
                })
        elif intent != 'smalltalk':
            data, source = ai.complete_chat_json(
                _AI_SYSTEM,
                history + [{'role': 'user', 'text': 'QUESTION: %s\n\nANSWER DATA:\n%s' % (question, self._compact(res))}],
                max_tokens=400, timeout=_AI_TIMEOUT)
            text = (data or {}).get('text') if isinstance(data, dict) else None
            if text:
                res['blocks'] = [{'type': 'text', 'text': str(text).strip()}] + res['blocks']
                res.update({'ai': True, 'source': source})
        return res

    @api.model
    def history_of(self, chat):
        """A saved kpi.ai.chat as AI turns: the questions, and each answer's
        title and text paragraphs (tables are summed up by their title)."""
        if not chat:
            return []
        msgs = chat.message_ids.sorted('id')[-_HISTORY_TURNS * 2:]
        out = []
        for m in msgs:
            if m.role == 'user':
                text = m.text or ''
            else:
                try:
                    res = json.loads(m.payload_json or '{}')
                except Exception:
                    res = {}
                parts = [res.get('title') or m.text or '']
                parts += [b.get('text') or '' for b in res.get('blocks') or [] if b.get('type') == 'text']
                parts += [b.get('title') or '' for b in res.get('blocks') or [] if b.get('type') == 'list']
                text = '\n'.join(p for p in parts if p)
            text = text.strip()
            if text:
                out.append({'role': 'user' if m.role == 'user' else 'assistant', 'text': text[:_HISTORY_CHARS]})
        return out

    @api.model
    def _compact_digest(self, digest, workday, period):
        """The period's live data as small JSON for the AI: the summary, each
        person with counts and a trimmed task list, alerts and today's workday.
        Shrinks the per-person task lists until it fits."""
        keep = ('ref', 'name', 'status', 'priority', 'deadline', 'estimated_hours', 'actual_hours',
                'days_paused', 'days_not_started', 'paused_reason', 'completed_date')
        base = {
            'today': str(fields.Date.context_today(self)),
            'period': period, 'date_range': digest.get('date_range'),
            'note': 'last_week / last_month list completed tasks only' if period in ('last_week', 'last_month') else '',
            'summary': digest.get('summary'),
            'alerts': [{k: a.get(k) for k in ('type', 'employee', 'task_name', 'days', 'reason') if a.get(k) not in (None, '')}
                       for a in (digest.get('alerts') or [])[:30]],
            'workday_today': workday,
        }
        for per_person in (40, 15, 6, 0):
            people = []
            for e in digest.get('employees') or []:
                people.append({
                    'name': e.get('name'),
                    'completed': e.get('completed_count'), 'in_progress': e.get('in_progress_count'),
                    'paused': e.get('paused_count'), 'not_started': e.get('not_started_count'),
                    'pending_approval': e.get('pending_approval_count'),
                    'estimated_hours': e.get('total_estimated_hours'), 'actual_hours': e.get('total_actual_hours'),
                    'performance': e.get('overall_performance'),
                    'tasks': [{k: t.get(k) for k in keep if t.get(k) not in (None, '', 0)}
                              for t in (e.get('tasks') or [])[:per_person]],
                    'tasks_not_listed': max(0, len(e.get('tasks') or []) - per_person),
                })
            text = json.dumps(dict(base, people=people), default=str)
            if len(text) <= 14000:
                return text
        return text[:14000]

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
