"""Client Talks: every discussion, meeting and question in one place.

Three lists (Odoo menu KRA / KPI > Client Talks, and the web /talks pages):

  * 💬 Discussions: every task chat with the client (models/kpi_chat.py),
    split into Task-oriented and General (a client's hidden GEN task).
  * 📅 Meetings: every kpi.meeting, the same two halves, each with all its
    details: attendance, summary, action items, transcript, recordings.
  * ❓ Questions: every kpi.doubt, and who it is with now.

Talk is grouped by DATE, and inside a day into SESSIONS: a new session starts
when more than `gap` minutes (60 by default) passed since the last message.
The grouping is done here so Odoo and the web draw the same blocks.

Who sees what: admins everything; anyone else the tasks they work on, the
general chats a question was put to them on, and meetings they run or attend.
"""
import logging
from datetime import timedelta

from odoo import fields, http
from odoo.http import request

from .kra_api import KraKpiAPI

_logger = logging.getLogger(__name__)

GAP_MIN = 60
MEETING_STATES = {'requested': 'Waiting to confirm', 'confirmed': 'Confirmed',
                  'live': 'Open now', 'done': 'Finished', 'cancelled': 'Cancelled'}
UPCOMING = ('requested', 'confirmed', 'live')


def _one_line(text, size=140):
    return ' '.join((text or '').split())[:size]


class KpiTalksApi(http.Controller):

    # ------------------------------------------------------------------ #
    # helpers
    # ------------------------------------------------------------------ #
    def _api(self):
        return KraKpiAPI()

    def _admin(self):
        return self._api()._is_kra_admin(request.env.user)

    def _local(self, dt):
        return request.env['kpi.tz'].sudo().to_local(dt) if dt else None

    @staticmethod
    def _hm(d):
        return d.strftime('%I:%M %p').lstrip('0').lower() if d else ''

    @staticmethod
    def _day_label(d):
        return d.strftime('%a %d %b') if d else ''

    def _may_open(self, kpi, admin):
        """Can this person read this task's talk (chat, meetings)?"""
        if admin:
            return True
        api = self._api()
        if not api._may_view_kpi_details(kpi):
            return True
        return bool(kpi.is_chat_general and api._general_chat_ok(kpi))

    def _kpi(self, kpi_id):
        try:
            kid = int(kpi_id or 0)
        except (TypeError, ValueError):
            return None
        return request.env['kra.kpi'].sudo().with_context(active_test=False).browse(kid).exists() if kid else None

    @staticmethod
    def _client(kpi):
        return kpi.client_kra_id.name or kpi.kra_id.name or ''

    def _task_head(self, kpi):
        return {'kpi_id': kpi.id, 'is_general': bool(kpi.is_chat_general),
                'ref': kpi.external_ref or '#%d' % kpi.id,
                'title': kpi.name or '', 'client': self._client(kpi)}

    # ------------------------------------------------------------------ #
    # date + session grouping
    # ------------------------------------------------------------------ #
    def _sessions(self, items, gap):
        """items: [{'dt': utc datetime, ...}] oldest first ->
        days newest first, each {label, date, sessions oldest first}; a
        session is {n, start, end, items}."""
        days = []
        last_dt = None
        for it in items:
            here = self._local(it['dt'])
            key = here.date().isoformat() if here else ''
            if not days or days[-1]['date'] != key:
                days.append({'date': key, 'label': self._day_label(here), 'sessions': []})
                last_dt = None
            day = days[-1]
            if last_dt is None or (it['dt'] - last_dt) > timedelta(minutes=gap):
                day['sessions'].append({'n': len(day['sessions']) + 1, 'items': [],
                                        'start_dt': it['dt'], 'gap_min': int((it['dt'] - last_dt).total_seconds() // 60)
                                        if last_dt else 0})
            sess = day['sessions'][-1]
            sess['items'].append(it)
            sess['end_dt'] = it['dt']
            last_dt = it['dt']
        for day in days:
            for s in day['sessions']:
                s['start'] = self._hm(self._local(s.pop('start_dt')))
                s['end'] = self._hm(self._local(s.pop('end_dt')))
        days.reverse()
        return days

    # ------------------------------------------------------------------ #
    # 💬 Discussions
    # ------------------------------------------------------------------ #
    @http.route('/kpi_action/talks/discussions', type='json', auth='user', methods=['POST'], csrf=False)
    def talks_discussions(self, tab='task', filter='all', search='', **kw):
        """One row per task chat. tab: task | general; filter: waiting | all."""
        try:
            admin = self._admin()
            cr = request.env.cr
            cr.execute("""SELECT kpi_id, max(id), count(*) FROM kpi_chat_message
                          WHERE deleted_at IS NULL GROUP BY kpi_id""")
            stats = {k: (last, n) for k, last, n in cr.fetchall()}
            Kpi = request.env['kra.kpi'].sudo().with_context(active_test=False)
            Msg = request.env['kpi.chat.message'].sudo()
            words = (search or '').strip().lower()
            hits = set()
            if words:
                cr.execute("""SELECT DISTINCT kpi_id FROM kpi_chat_message
                              WHERE deleted_at IS NULL AND body ILIKE %s""", ('%' + words + '%',))
                hits = {r[0] for r in cr.fetchall()}
            rows, counts = [], {'task': 0, 'general': 0, 'waiting_task': 0, 'waiting_general': 0}
            for kpi in Kpi.browse(list(stats)).exists():
                if not self._may_open(kpi, admin):
                    continue
                half = 'general' if kpi.is_chat_general else 'task'
                waiting = kpi.chat_waiting()
                counts[half] += 1
                if waiting:
                    counts['waiting_' + half] += 1
                if half != tab or (filter == 'waiting' and not waiting):
                    continue
                head = self._task_head(kpi)
                if words and kpi.id not in hits and not any(
                        words in (head[f] or '').lower() for f in ('ref', 'title', 'client')):
                    continue
                last = Msg.browse(stats[kpi.id][0])
                said = last.body or ('📎 ' + ', '.join(last.file_ids.mapped('file_name')))
                here = self._local(last.create_date)
                head.update({
                    'last': _one_line(said, 120), 'last_side': last.side,
                    'last_who': (last.author_user_id.name if last.side == 'team' else last.author_name) or '',
                    'at': fields.Datetime.to_string(last.create_date),
                    'at_label': '%s %s' % (self._day_label(here), self._hm(here)),
                    'count': stats[kpi.id][1], 'waiting': waiting})
                rows.append(head)
            rows.sort(key=lambda r: r['at'], reverse=True)
            rows.sort(key=lambda r: r['waiting'] == 0)
            return {'status': True, 'rows': rows, 'counts': counts}
        except Exception as e:
            _logger.warning('talks_discussions failed: %s', e)
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_action/talks/thread', type='json', auth='user', methods=['POST'], csrf=False)
    def talks_thread(self, kpi_id=None, gap=GAP_MIN, **kw):
        """The whole chat of one task: days -> sessions -> messages."""
        try:
            kpi = self._kpi(kpi_id)
            if not kpi or not self._may_open(kpi, self._admin()):
                return {'status': False, 'message': 'Task not found.'}
            try:
                gap = max(5, int(gap or GAP_MIN))
            except (TypeError, ValueError):
                gap = GAP_MIN
            user = request.env.user
            items = []
            for m in kpi.chat_rows(viewer=user, limit=2000, admin=self._admin()):
                if m['deleted']:
                    continue
                dt = fields.Datetime.from_string(m['at'])
                items.append({'dt': dt, 'id': m['id'], 'side': m['side'], 'who': m['who'],
                              'body': m['body'], 'files': m['files'], 'status': m['status'],
                              'time': self._hm(self._local(dt))})
            days = self._sessions(items, gap)
            latest = days[0]['sessions'][-1] if days else None
            for day in days:
                for s in day['sessions']:
                    msgs = s.pop('items')
                    for it in msgs:
                        it.pop('dt', None)
                    s['messages'] = msgs
                    s['count'] = len(msgs)
                    sides = [x['side'] for x in msgs]
                    if sides and sides[-1] == 'team':
                        team = [x['who'] for x in msgs if x['side'] == 'team']
                        s['status'] = 'answered'
                        s['by'] = team[-1] if team else ''
                    else:
                        s['status'] = 'waiting' if s is latest else 'no_reply'
                        s['by'] = ''
            out = self._task_head(kpi)
            out.update({'status': True, 'days': days, 'gap': gap, 'count': len(items),
                        'waiting': kpi.chat_waiting()})
            return out
        except Exception as e:
            _logger.warning('talks_thread failed: %s', e)
            return {'status': False, 'message': str(e)}

    # ------------------------------------------------------------------ #
    # 📅 Meetings
    # ------------------------------------------------------------------ #
    def _meeting_visible(self, m, admin, user):
        if admin or m.organizer_id == user or user in m.attendee_user_ids:
            return True
        return bool(m.kpi_id) and self._may_open(m.kpi_id, False)

    def _meeting_card(self, m, user):
        """Everything saved on one meeting, for the screens."""
        start = m.opened_at or m.scheduled_start
        when = self._hm(self._local(start))
        # A range once the room was opened: when it opened, when it ended.
        if when and m.opened_at and m.ended_at:
            when = '%s – %s' % (when, self._hm(self._local(m.ended_at)))
        people = {}
        for p in m.participant_ids.filtered(lambda r: not r.is_recorder).sorted('joined_at'):
            key = p.user_id.id and ('u', p.user_id.id) or ('n', (p.person_name or '').strip().lower())
            row = people.setdefault(key, {'name': (p.user_id.name if p.user_id else p.person_name) or 'Guest',
                                          'joined': p.joined_at, 'left': p.left_at, 'minutes': 0,
                                          'staff': bool(p.user_id), 'removed': False})
            row['minutes'] += p.minutes or 0
            row['removed'] = row['removed'] or p.removed_no_reply
            if p.left_at and (not row['left'] or p.left_at > row['left']):
                row['left'] = p.left_at
        attendance = []
        for row in people.values():
            attendance.append({'name': row['name'], 'minutes': row['minutes'], 'staff': row['staff'],
                               'removed': row['removed'], 'absent': False,
                               'joined': self._hm(self._local(row['joined'])),
                               'left': self._hm(self._local(row['left']))})
        joined_users = {k[1] for k in people if k[0] == 'u'}
        for u in (m.organizer_id | m.attendee_user_ids):
            if u.id not in joined_users and m.state == 'done':
                attendance.append({'name': u.name, 'minutes': 0, 'staff': True, 'removed': False,
                                   'absent': True, 'joined': '', 'left': ''})
        kpi = m.kpi_id
        recordings = [{'id': a.id, 'name': a.name or '', 'mime': a.mimetype or '', 'size': a.file_size or 0,
                       'url': '/web/content/%d' % a.id} for a in m.recording_ids]
        booked = self._local(m.create_date)
        return {
            'id': m.id, 'name': m.name or '', 'state': m.state,
            'state_label': MEETING_STATES.get(m.state, m.state),
            'upcoming': m.state in UPCOMING,
            'kpi_id': kpi.id or False, 'is_general': bool(kpi.is_chat_general),
            'ref': ('General · %s' % self._client(kpi)) if kpi.is_chat_general else (kpi.external_ref or ''),
            'title': '' if kpi.is_chat_general else (kpi.name or ''),
            'client': m.client_kra_id.name or self._client(kpi),
            'db': m.client_db_id.display_name if m.client_db_id else '',
            'when': when or (m.requested_text and 'Asked: %s' % m.requested_text) or 'No time yet',
            'local_when': m.local_when or '',
            'minutes': m.actual_minutes or 0,
            'organizer': m.organizer_id.name or '',
            'asked_by': m.requested_by_name or '',
            'booked': '%s, %s' % (self._day_label(booked), self._hm(booked)) if booked else '',
            'internal': bool(m.is_internal),
            'attendance': attendance,
            'summary': m.summary or '', 'action_items': m.action_items or '',
            'transcript': m.transcript or '', 'notes': m.notes or '',
            'recordings': recordings,
            'can_join': m.state in ('confirmed', 'live') and bool(m.join_url) and m._user_can_join(user),
            '_dt': start or m.create_date,
        }

    def _meeting_days(self, cards, newest_first=True):
        days = {}
        for c in cards:
            here = self._local(c['_dt'])
            key = here.date().isoformat() if here else ''
            day = days.setdefault(key, {'date': key, 'label': self._day_label(here), 'meetings': []})
            day['meetings'].append(c)
        out = sorted(days.values(), key=lambda d: d['date'], reverse=newest_first)
        for d in out:
            d['meetings'].sort(key=lambda c: c['_dt'], reverse=newest_first)
            for c in d['meetings']:
                c.pop('_dt', None)
            d['upcoming'] = all(c['upcoming'] for c in d['meetings'])
        return out

    @http.route('/kpi_action/talks/meetings', type='json', auth='user', methods=['POST'], csrf=False)
    def talks_meetings(self, tab='task', filter='all', search='', **kw):
        """Every meeting this person may see. tab: task | general;
        filter: upcoming | past | all. -> days -> meetings (full cards)."""
        try:
            admin, user = self._admin(), request.env.user
            Meeting = request.env['kpi.meeting'].sudo().with_context(active_test=False)
            words = (search or '').strip().lower()
            cards, counts = [], {'task': 0, 'general': 0, 'upcoming': 0}
            for m in Meeting.search([], order='id desc', limit=1000):
                if not self._meeting_visible(m, admin, user):
                    continue
                half = 'general' if m.kpi_id.is_chat_general else 'task'
                counts[half] += 1
                if m.state in UPCOMING:
                    counts['upcoming'] += 1
                if half != tab:
                    continue
                if filter == 'upcoming' and m.state not in UPCOMING:
                    continue
                if filter == 'past' and m.state in UPCOMING:
                    continue
                if words and not any(words in (v or '').lower() for v in (
                        m.name, m.kpi_id.external_ref, m.kpi_id.name, m.client_kra_id.name,
                        m.kpi_id.kra_id.name, m.summary, m.transcript, m.organizer_id.name)):
                    continue
                cards.append(self._meeting_card(m, user))
            return {'status': True, 'days': self._meeting_days(cards, newest_first=filter != 'upcoming'),
                    'counts': counts}
        except Exception as e:
            _logger.warning('talks_meetings failed: %s', e)
            return {'status': False, 'message': str(e)}

    @http.route('/kpi_action/meetings', type='json', auth='user', methods=['POST'], csrf=False)
    def task_meetings(self, kpi_id=None, **kw):
        """KPI details > 📅 Meetings: one task's meetings, by date."""
        try:
            kpi = self._kpi(kpi_id)
            admin, user = self._admin(), request.env.user
            if not kpi:
                return {'status': False, 'message': 'Task not found.'}
            Meeting = request.env['kpi.meeting'].sudo()
            rows = Meeting.search([('kpi_id', '=', kpi.id)], order='id desc')
            if not self._may_open(kpi, admin):
                rows = rows.filtered(lambda m: m.organizer_id == user or user in m.attendee_user_ids)
            cards = [self._meeting_card(m, user) for m in rows]
            return {'status': True, 'count': len(cards), 'days': self._meeting_days(cards)}
        except Exception as e:
            _logger.warning('task_meetings failed: %s', e)
            return {'status': False, 'message': str(e)}

    # ------------------------------------------------------------------ #
    # ❓ Questions
    # ------------------------------------------------------------------ #
    @http.route('/kpi_action/talks/questions', type='json', auth='user', methods=['POST'], csrf=False)
    def talks_questions(self, filter='open', search='', **kw):
        """Every kpi.doubt this person raised, was asked, or (admins) all.
        filter: open | answered | all."""
        try:
            admin, user = self._admin(), request.env.user
            Doubt = request.env['kpi.doubt'].sudo()
            kinds = dict(Doubt._fields['kind'].selection)
            states = dict(Doubt._fields['state'].selection)
            dom = [] if admin else ['|', '|', '|', ('raised_by_id', '=', user.id),
                                    ('assigned_dev_id', '=', user.id), ('manager_user_id', '=', user.id),
                                    ('esc_asked_ids', 'in', user.id)]
            words = (search or '').strip().lower()
            now = fields.Datetime.now()
            tiers = request.env['kpi.escalation.tier'].sudo().chain()
            rows, counts = [], {'open': 0, 'answered': 0}
            for d in Doubt.search(dom, order='id desc', limit=500):
                is_open = d.state == 'open'
                counts['open' if is_open else 'answered'] += 1
                if (filter == 'open' and not is_open) or (filter == 'answered' and is_open):
                    continue
                kpi = d.kpi_id.with_context(active_test=False)
                if words and not any(words in (v or '').lower() for v in (
                        d.question, d.task_ref, kpi.name, d.raised_by_name, d.raised_by_id.name,
                        self._client(kpi))):
                    continue
                if is_open:
                    with_now = d.esc_asked_ids.mapped('name') or [d.manager_user_id.name or '']
                else:
                    with_now = [d.assigned_dev_id.name or d.answered_by_id.name or '']
                step = ''
                if is_open and d.esc_tier_id:
                    pos = list(tiers.ids).index(d.esc_tier_id.id) + 1 if d.esc_tier_id.id in tiers.ids else 0
                    step = '%s · step %d' % (d.esc_tier_id.name, pos) if pos else d.esc_tier_id.name
                elif is_open:
                    step = 'Manager'
                age = int((now - d.create_date).total_seconds() // 60) if is_open and d.create_date else 0
                rows.append({
                    'id': d.id, 'kind': d.kind, 'kind_label': kinds.get(d.kind, d.kind),
                    'kpi_id': kpi.id, 'is_general': bool(kpi.is_chat_general),
                    'ref': kpi.external_ref or '', 'title': kpi.name or '', 'client': self._client(kpi),
                    'question': _one_line(d.question, 160),
                    'raised_by': d.raised_by_id.name or d.raised_by_name or '',
                    'with_now': ', '.join(n for n in with_now if n),
                    'step': step, 'state': d.state, 'state_label': states.get(d.state, d.state),
                    'open': is_open, 'age_min': age,
                    'answer': _one_line(d.answer, 160),
                    'meeting_id': d.meeting_id.id or False,
                    'at': fields.Datetime.to_string(d.create_date),
                })
            return {'status': True, 'rows': rows, 'counts': counts}
        except Exception as e:
            _logger.warning('talks_questions failed: %s', e)
            return {'status': False, 'message': str(e)}
