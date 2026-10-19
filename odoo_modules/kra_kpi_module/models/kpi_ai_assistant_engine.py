# -*- coding: utf-8 -*-
"""369 AI Assistant — the rule-based question reader (no AI, no Odoo imports).

The Owner Dashboard's assistant answers questions about the team's work from
live data. With no AI key configured this module IS the assistant: it reads
the question (who, which statuses, which priority, which period, a count or a
list, a task name), filters the period's digest (/kra_kpi/ai_digest data) and
answers with typed blocks the web draws as stat tiles, tables and lists.

Pure Python on purpose: kpi_ai_assistant.py feeds it the digest and today's
workday sessions, and it can be exercised without an Odoo server.

Answer shape:
    {title, blocks: [...], suggestions: [str], context: {...}, intent}
Blocks:
    {'type': 'stats', 'items': [{'label', 'value'}]}
    {'type': 'table', 'columns': [{'key', 'label', 'kind'}], 'rows': [{...}], 'more': int}
        kind: 'task' (row carries task_id -> link), 'person' (ask about them), 'num', 'text'
    {'type': 'list', 'items': [str]}
    {'type': 'text', 'text': str}
It never invents anything: a question it can't place gets "I didn't
understand" plus examples, and an empty result says so.
"""
import re
from datetime import date

PERIOD_LABEL = {
    'today': 'today', 'yesterday': 'yesterday', 'this_week': 'this week',
    'last_week': 'last week', 'this_month': 'this month', 'last_month': 'last month',
}
# Longest phrases first so "last week" wins over "week".
_PERIOD_WORDS = [
    ('last week', 'last_week'), ('previous week', 'last_week'), ('past week', 'last_week'),
    ('this week', 'this_week'), ('current week', 'this_week'), ('weekly', 'this_week'),
    ('last month', 'last_month'), ('previous month', 'last_month'), ('past month', 'last_month'),
    ('this month', 'this_month'), ('current month', 'this_month'), ('monthly', 'this_month'),
    ('yesterday', 'yesterday'), ('today', 'today'), ('now', 'today'),
    ('week', 'this_week'), ('month', 'this_month'),
]

NOT_STARTED_STATES = {'assigned', 'urgent', 'important', 'regular'}
STATUS_LABEL = {
    'not_started': 'Not started', 'in_progress': 'Running', 'paused': 'Paused',
    'partially_completed': 'Pending approval', 'completed': 'Completed',
    # States only a task lookup meets (the digest groups none of these):
    'queue_waiting': 'Queued', 'pre_approval_pending': 'Waiting for client approval',
    'pre_approval_approved': 'Client approved, not started', 'pre_approval_partial': 'Partly approved by client',
    'hold': 'On hold', 'rework': 'Rework needed', 'awaiting_client': 'Awaiting client sign-off',
}
STATUS_ORDER = ['in_progress', 'paused', 'not_started', 'partially_completed', 'completed']
PRIORITY_RANK = {'urgent': 0, 'important': 1, 'regular': 2}

# (phrase, status). Order matters: each phrase is removed once matched, so
# "not started" is consumed before "started", "pending approval" before "pending".
_STATUS_WORDS = [
    ('pending approval', 'partially_completed'), ('waiting for approval', 'partially_completed'),
    ('waiting for my approval', 'partially_completed'), ('need approval', 'partially_completed'),
    ('needs approval', 'partially_completed'), ('to approve', 'partially_completed'),
    ('approvals', 'partially_completed'), ('approval', 'partially_completed'),
    ('approve', 'partially_completed'), ('review', 'partially_completed'),
    ('sign off', 'partially_completed'), ('signoff', 'partially_completed'),
    ('not yet started', 'not_started'), ('not started', 'not_started'), ('yet to start', 'not_started'),
    ('unstarted', 'not_started'), ('to do', 'not_started'), ('todo', 'not_started'),
    ('backlog', 'not_started'), ('pending', 'not_started'), ('not begun', 'not_started'),
    ('in progress', 'in_progress'), ('in-progress', 'in_progress'), ('working on', 'in_progress'),
    ('running', 'in_progress'), ('ongoing', 'in_progress'), ('active', 'in_progress'),
    ('on hold', 'paused'), ('paused', 'paused'), ('pause', 'paused'), ('stuck', 'paused'),
    ('blocked', 'paused'), ('hold', 'paused'),
    ('completed', 'completed'), ('complete', 'completed'), ('finished', 'completed'),
    ('done', 'completed'), ('closed', 'completed'),
]
_PRIORITY_WORDS = [('urgent', 'urgent'), ('critical', 'urgent'), ('important', 'important'),
                   ('high priority', 'important'), ('regular', 'regular'), ('normal', 'regular')]

_INTENT_WORDS = [
    ('help', ['help', 'what can you do', 'what can i ask', 'how to use', 'commands', 'examples']),
    ('workday', ['workday', 'work day', 'attendance', 'absent', 'present', 'logged in', 'log in',
                 'login', 'clocked', 'clock in', 'online', 'who came', 'came to work', 'started the day',
                 'started their day', 'start their day', 'started work', 'on leave']),
    ('leaderboard', ['leaderboard', 'ranking', 'rank', 'top', 'best', 'most', 'performer',
                     'productive', 'highest', 'least', 'lowest', 'worst']),
    ('overdue', ['overdue', 'deadline', 'past due', 'late', 'missed', 'delayed', 'due']),
    ('over_estimate', ['over estimate', 'overestimate', 'extra time', 'exceeded', 'overtime',
                       'over time', 'took longer', 'slow', 'low performance', 'over budget', 'overrun']),
    ('alerts', ['alert', 'attention', 'problem', 'issue', 'risk', 'warning', 'concern', 'red flag']),
    ('summary', ['summary', 'summarise', 'summarize', 'overview', 'how are we', 'how is the team',
                 'how is it going', 'status of the team', 'team status', 'report', 'progress',
                 'dashboard', 'brief', 'update me', 'whats happening', 'what is happening']),
]
_COUNT_WORDS = ['how many', 'count', 'number of', 'total']
_PRONOUNS = {'he', 'she', 'his', 'her', 'him', 'their', 'them', 'they', 'same person'}
_STOP = {
    'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'is', 'are', 'was', 'were', 'what', 'which',
    'who', 'whom', 'show', 'me', 'list', 'give', 'get', 'find', 'tell', 'about', 'and', 'or', 'with',
    'task', 'tasks', 'status', 'please', 'all', 'any', 'my', 'our', 'has', 'have', 'had', 'do', 'does',
    'did', 'there', 'by', 'it', 'its', 'this', 'that', 'these', 'those', 'can', 'you', 'i', 'we',
    'from', 'at', 'be', 'so', 'far', 'right', 'currently', 'current', 'details', 'detail', 'info',
    'work', 'job', 'jobs', 'many', 'how', 'much', 'still', 'yet', 'also', 'just', 'only', 'some',
}

MAX_ROWS = 50

STARTERS = [
    'Summary of today', 'Who has paused tasks?', 'Urgent tasks not started',
    "What's waiting for my approval?", 'Overdue tasks', 'Who started their workday?',
    'Top performers this week', 'Help',
]


# --------------------------------------------------------------------- utils
def _norm(text):
    t = (text or '').lower()
    t = t.replace('’', "'")
    t = re.sub(r"'s\b", '', t)                 # Ravi's -> Ravi
    t = re.sub(r"[^\w\s\-\"']", ' ', t)
    return ' ' + re.sub(r'\s+', ' ', t).strip() + ' '


def _variants(phrase):
    """The phrase and its plural ("alert" also matches "alerts")."""
    return (phrase, phrase + 's', phrase + 'es')


def _has(q, phrase):
    return any((' %s ' % v) in q for v in _variants(phrase))


def _take(q, phrase):
    """Remove a matched phrase so it isn't matched again by a shorter one."""
    for v in _variants(phrase):
        if (' %s ' % v) in q:
            return q.replace(' %s ' % v, ' ', 1)
    return q


def status_group(state):
    return 'not_started' if state in NOT_STARTED_STATES else state


def _hours(h):
    h = float(h or 0)
    if not h:
        return '0h'
    hh, mm = int(h), int(round((h - int(h)) * 60))
    if mm == 60:
        hh, mm = hh + 1, 0
    return ('%dh %02dm' % (hh, mm)) if mm else '%dh' % hh


def _plural(n, one, many=None):
    return '%d %s' % (n, one if n == 1 else (many or one + 's'))


def detect_period(question):
    q = _norm(question)
    for phrase, key in _PERIOD_WORDS:
        if _has(q, phrase):
            return key
    return None


# -------------------------------------------------------------------- parsing
def parse(question, employees, context=None):
    """-> dict(intent, statuses, priorities, employee, count, search, period_only)."""
    context = context or {}
    q = _norm(question)
    out = {'intent': None, 'statuses': [], 'priorities': [], 'employee': None,
           'count': any(_has(q, w) for w in _COUNT_WORDS), 'search': None, 'unassigned': False}

    # Quoted text or "status of X" / "task called X" is a task-name search.
    m = re.search(r'"([^"]{2,})"', question or '') or re.search(r"'([^']{3,})'", question or '')
    if m:
        out['search'] = m.group(1).strip()
    else:
        m = re.search(r'\b(?:status of|progress of|task (?:named|called)|about the task|find task|search(?: for)?)\s+(.+)$',
                      (question or '').strip(), re.I)
        if m:
            out['search'] = m.group(1).strip(' ?.!')

    # A task-name search ("status of login issue") is taken literally: its words
    # must not also be read as statuses or intents ("issue" -> alerts).
    if out['search']:
        out['employee'] = match_employee(_norm(out['search']), employees)
        out['rest'] = []
        out['period_only'] = False
        return out

    # Statuses and priorities before intents, so "in progress" is a status and
    # not the summary word "progress".
    for phrase, st in _STATUS_WORDS:
        if _has(q, phrase):
            if st not in out['statuses']:
                out['statuses'].append(st)
            q = _take(q, phrase)
    for phrase, pr in _PRIORITY_WORDS:
        if _has(q, phrase):
            if pr not in out['priorities']:
                out['priorities'].append(pr)
            q = _take(q, phrase)

    for intent, words in _INTENT_WORDS:
        if any(_has(q, w) for w in words):
            out['intent'] = intent
            for w in words:
                if _has(q, w):
                    q = _take(q, w)
            break
    for phrase, _k in _PERIOD_WORDS:
        if _has(q, phrase):
            q = _take(q, phrase)

    for w in ('unassigned', 'not assigned', 'nobody', 'no one'):
        if _has(q, w):
            out['unassigned'] = True
            q = _take(q, w)
    out['employee'] = match_employee(q, employees)
    if not out['employee'] and any(_has(q, p) for p in _PRONOUNS) and context.get('employee'):
        out['employee'] = context['employee']

    # Leftover words that may name a task ("login page", "invoice module").
    out['rest'] = [w for w in q.split() if w not in _STOP and len(w) > 2
                   and not (out['employee'] and w in out['employee'].lower().split())]
    out['period_only'] = (not out['intent'] and not out['statuses'] and not out['priorities']
                          and not out['employee'] and not out['search'] and not out['rest']
                          and detect_period(question) is not None)
    return out


def match_employee(q, employees):
    """Best employee name for the normalised question, or None."""
    names = [e for e in employees if e and e != 'Unassigned']
    words = [w for w in q.split() if len(w) >= 3 and w not in _STOP]
    best, best_score = None, 0
    for name in names:
        low = name.lower()
        parts = [p for p in re.split(r'\s+', low) if p]
        score = 0
        if _has(q, low):
            score = 100
        else:
            for w in words:
                if w in parts:
                    score = max(score, 60 if w == parts[0] else 50)
                elif len(w) >= 4 and any(p.startswith(w) for p in parts):
                    score = max(score, 30)
        if score > best_score:
            best, best_score = name, score
    return best


# ------------------------------------------------------------------- answering
def _all_tasks(digest):
    out = []
    for emp in digest.get('employees') or []:
        for t in emp.get('tasks') or []:
            row = dict(t)
            row['person'] = emp.get('name') or 'Unassigned'
            row['group'] = status_group(t.get('status'))
            out.append(row)
    return out


def _sort_key(t):
    return (STATUS_ORDER.index(t['group']) if t['group'] in STATUS_ORDER else 9,
            PRIORITY_RANK.get(t.get('priority') or 'regular', 3),
            -(t.get('days_paused') or 0), -(t.get('days_not_started') or 0), t.get('name') or '')


def _task_table(tasks, extra=None, sort=True, max_rows=MAX_ROWS):
    """Table block for task rows. `extra`: additional column keys to force."""
    tasks = sorted(tasks, key=_sort_key) if sort else list(tasks)
    extra = set(extra or [])
    cols = [{'key': 'task', 'label': 'Task', 'kind': 'task'},
            {'key': 'person', 'label': 'Person', 'kind': 'person'},
            {'key': 'priority', 'label': 'Priority', 'kind': 'text'},
            {'key': 'status', 'label': 'Status', 'kind': 'text'},
            {'key': 'est', 'label': 'Est.', 'kind': 'num'},
            {'key': 'actual', 'label': 'Actual', 'kind': 'num'}]
    if 'paused' in extra or any(t['group'] == 'paused' for t in tasks):
        cols.append({'key': 'paused', 'label': 'Paused', 'kind': 'text'})
    if 'waiting' in extra or any(t['group'] == 'not_started' and t.get('days_not_started') for t in tasks):
        cols.append({'key': 'waiting', 'label': 'Waiting', 'kind': 'text'})
    if 'extra' in extra:
        cols.append({'key': 'extra', 'label': 'Over by', 'kind': 'num'})
    if 'deadline' in extra or any(t.get('deadline') for t in tasks):
        cols.append({'key': 'deadline', 'label': 'Deadline', 'kind': 'text'})
    rows = []
    for t in tasks[:max_rows]:
        paused = ''
        if t['group'] == 'paused':
            paused = _plural(t.get('days_paused') or 0, 'day')
            if t.get('paused_reason'):
                paused += ' · ' + t['paused_reason']
        rows.append({
            'task_id': t.get('id'),
            'task': ('%s · %s' % (t['ref'], t.get('name'))) if t.get('ref') else (t.get('name') or ''),
            'person': t.get('person') or '',
            'priority': (t.get('priority') or 'regular').capitalize(),
            'status': STATUS_LABEL.get(t['group'], t.get('status') or ''),
            'est': _hours(t.get('estimated_hours')),
            'actual': _hours(t.get('actual_hours')),
            'paused': paused,
            'waiting': _plural(t.get('days_not_started') or 0, 'day') if t['group'] == 'not_started' else '',
            'extra': _hours(t.get('extra_time')),
            'deadline': t.get('deadline') or '',
        })
    return {'type': 'table', 'columns': cols, 'rows': rows, 'more': max(0, len(tasks) - max_rows)}


def _describe(statuses, priorities):
    st = ' / '.join(STATUS_LABEL[s].lower() for s in statuses if s in STATUS_LABEL)
    pr = ' / '.join(p for p in priorities)
    return ' '.join(x for x in [pr, st] if x).strip()


def _summary(digest, plabel, workday=None):
    s = digest.get('summary') or {}
    items = [
        {'label': 'Tasks', 'value': s.get('total_tasks', 0)},
        {'label': 'Completed', 'value': s.get('completed', 0)},
        {'label': 'Running', 'value': s.get('in_progress', 0)},
        {'label': 'Paused', 'value': s.get('paused', 0)},
        {'label': 'Not started', 'value': s.get('not_started', 0)},
        {'label': 'Pending approval', 'value': s.get('pending_approval', 0)},
        {'label': 'Progress', 'value': '%s%%' % s.get('progress_percentage', 0)},
    ]
    blocks = [{'type': 'stats', 'items': items}]
    emps = [e for e in digest.get('employees') or [] if e.get('name') != 'Unassigned']
    busy = sorted(emps, key=lambda e: -(e.get('completed_count') or 0))
    lines = []
    if busy and busy[0].get('completed_count'):
        lines.append('Most completed %s: %s (%d).' % (plabel, busy[0]['name'], busy[0]['completed_count']))
    running = [e['name'] for e in emps if e.get('in_progress_count')]
    if running:
        lines.append('Working on a task now: %s.' % ', '.join(running[:8]) + (' and %d more' % (len(running) - 8) if len(running) > 8 else ''))
    if workday is not None:
        open_n = sum(1 for r in workday.get('sessions') or [] if r.get('state') == 'open')
        lines.append('%s started their workday today%s.' % (
            _plural(open_n, 'person', 'people'),
            (', %d not yet' % len(workday.get('without') or [])) if workday.get('without') else ''))
    if lines:
        blocks.append({'type': 'text', 'text': ' '.join(lines)})
    alerts = digest.get('alerts') or []
    if alerts:
        blocks.append({'type': 'list', 'title': 'Needs attention',
                       'items': [a.get('message') + (' — ' + a['employee'] if a.get('employee') else '')
                                 for a in alerts[:5]] + (['…and %d more alerts' % (len(alerts) - 5)] if len(alerts) > 5 else [])})
    title = '%s: %s, %d%% done' % (plabel.capitalize(), _plural(s.get('total_tasks', 0), 'task'),
                                   round(s.get('progress_percentage', 0) or 0))
    return title, blocks


_REF_RX = re.compile(r'\b([A-Za-z]{2,6}-\d{1,6})\b')


def extract_search(question):
    """The task name / reference a question asks about, or None.
    'status of REQ-146', 'find task "login page"', 'search invoice', or just 'REQ-146'."""
    text = (question or '').strip()
    m = re.search(r'"([^"]{2,})"', text) or re.search(r"'([^']{3,})'", text)
    if m:
        return m.group(1).strip()
    m = re.search(r'\b(?:status of|progress of|details of|task (?:named|called)|about the task|find task|find|search(?: for)?)\s+(.+)$',
                  text, re.I)
    if m:
        return m.group(1).strip(' ?.!')
    m = _REF_RX.search(text)
    return m.group(1) if m else None


def task_answer(search, tasks, max_rows=MAX_ROWS):
    """Answer for a task lookup: `tasks` are task dicts (digest shape + 'person')
    found by name or reference across ALL tasks, newest first."""
    for t in tasks:
        t['group'] = status_group(t.get('status'))
    sugg = ['Who has paused tasks?', "What's waiting for my approval?", 'Summary of today']
    if len(tasks) == 1:
        t = tasks[0]
        label = STATUS_LABEL.get(t['group'], t.get('status') or '')
        items = [{'label': 'Status', 'value': label},
                 {'label': 'Person', 'value': t.get('person') or 'Unassigned'},
                 {'label': 'Priority', 'value': (t.get('priority') or 'regular').capitalize()},
                 {'label': 'Estimate', 'value': _hours(t.get('estimated_hours'))},
                 {'label': 'Time spent', 'value': _hours(t.get('actual_hours'))}]
        if t.get('deadline'):
            items.append({'label': 'Deadline', 'value': t['deadline']})
        blocks = [{'type': 'stats', 'items': items}]
        notes = []
        if t['group'] == 'paused':
            notes.append('Paused for %s%s.' % (_plural(t.get('days_paused') or 0, 'day'),
                                              (': ' + t['paused_reason']) if t.get('paused_reason') else ''))
        if t.get('estimated_hours') and (t.get('actual_hours') or 0) > t['estimated_hours']:
            notes.append('Over its estimate by %s.' % _hours((t.get('actual_hours') or 0) - t['estimated_hours']))
        if t['group'] == 'not_started' and t.get('days_not_started'):
            notes.append('Waiting to start for %s.' % _plural(t['days_not_started'], 'day'))
        if notes:
            blocks.append({'type': 'text', 'text': ' '.join(notes)})
        blocks.append(_task_table([t], sort=False))
        name = ('%s · %s' % (t['ref'], t.get('name'))) if t.get('ref') else t.get('name')
        if t.get('person') and t['person'] != 'Unassigned':
            sugg = ['How is %s doing?' % t['person'], "%s's paused tasks" % t['person'], 'Summary of today']
        return {'title': '%s: %s' % (name, label.lower()), 'blocks': blocks, 'suggestions': sugg,
                'context': {'intent': 'search', 'employee': t.get('person')}, 'intent': 'search'}
    return {'title': 'Found %s matching "%s"' % (_plural(len(tasks), 'task'), search),
            'blocks': [_task_table(tasks, sort=False, max_rows=max_rows)], 'suggestions': sugg,
            'context': {'intent': 'search'}, 'intent': 'search'}


_SMALLTALK = [
    ('greet', r'^(hi+|hii+|hello+|hey+|hai|helo|hola|namaste|vanakkam|yo|good (morning|afternoon|evening|day))( there| assistant| ai| 369| bot| team| all)*$'),
    ('thanks', r'^(thanks?|thank you( so much| very much)?|thx|ty|tq|thanks a lot|many thanks|great|super|nice|cool|awesome|perfect|ok(ay)?|k|got it|fine|good)( thanks?| thank you)?$'),
    ('how', r'^(how are you|how r u|how are u|how do you do|hows it going|how is it going|whats up|sup)( today)?$'),
    ('who', r'^(who are you|what are you|what is your name|whats your name|your name|introduce yourself|what is this|what can i do here)$'),
    ('bye', r'^(bye+|goodbye|good bye|see you|see ya|good night|gn|cya|take care|exit|close)$'),
    ('sorry', r'^(sorry|my bad|oops|nevermind|never mind|no|nope|nothing)$'),
]


def _greeting(hour):
    if hour is None:
        return 'Hello'
    return 'Good morning' if hour < 12 else 'Good afternoon' if hour < 17 else 'Good evening'


def smalltalk(question, user_name='', hour=None):
    """A friendly reply to greetings, thanks and the like, or None. Matched on
    the whole (short) message only, so "hi, who has paused tasks" still gets
    the data answer."""
    q = (question or '').lower().replace('’', '').replace("'", '')
    q = re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9\s]+', ' ', q)).strip()
    if not q or len(q) > 40:
        return None
    first = (user_name or '').split(' ')[0]
    for kind, rx in _SMALLTALK:
        if re.match(rx, q):
            break
    else:
        return None
    you = (', ' + first) if first else ''
    text = {
        'greet': ('%s%s! I can look up your team\'s tasks, workdays and progress. '
                  'Pick a question below or just type one.') % (_greeting(hour), you),
        'thanks': "You're welcome%s! Anything else you'd like to check?" % you,
        'how': "I'm doing well, thanks for asking! The board is up to date. What would you like to know?",
        'who': ("I'm 369 AI Assistant. I read your KRA/KPI board and answer questions about tasks, people, "
                "workdays and performance, straight from the live data."),
        'bye': 'Bye%s! Your chat is saved in History if you need it later.' % you,
        'sorry': 'No problem! Here are a few things I can check for you.',
    }[kind]
    sugg = {'greet': ['Summary of today', 'Who has paused tasks?', "What's waiting for my approval?", 'Help'],
            'thanks': ['Summary of today', 'Overdue tasks', 'Top performers this week'],
            'bye': ['Summary of today'],
            }.get(kind, ['Summary of today', 'Who has paused tasks?', 'Help'])
    return {'title': '', 'blocks': [{'type': 'text', 'text': text}], 'suggestions': sugg,
            'context': {}, 'intent': 'smalltalk'}


def answer(question, digest, period, context=None, workday=None, today=None, user_name='', hour=None,
           max_rows=MAX_ROWS):
    """Answer `question` from `digest` (the /kra_kpi/ai_digest payload for `period`)."""
    context = context or {}
    today = today or date.today()
    chat = smalltalk(question, user_name, hour)
    if chat:
        chat['context'] = dict(context or {})  # small talk doesn't break a follow-up
        return chat
    plabel = PERIOD_LABEL.get(period, period)
    emp_names = [e.get('name') for e in digest.get('employees') or []]
    p = parse(question, emp_names, context)

    # "and last week?" / "what about this month" — repeat the previous question's filters.
    if p['period_only'] and context:
        p['intent'] = context.get('intent')
        p['statuses'] = context.get('statuses') or []
        p['priorities'] = context.get('priorities') or []
        p['employee'] = context.get('employee')
        p['count'] = bool(context.get('count'))

    tasks = _all_tasks(digest)
    ctx = {'intent': p['intent'], 'statuses': p['statuses'], 'priorities': p['priorities'],
           'employee': p['employee'], 'count': p['count'], 'period': period}
    past = period in ('last_week', 'last_month')
    past_note = ({'type': 'text', 'text': 'For %s only completed tasks are kept, so running, paused and waiting work shows under Today or This week.' % plabel}
                 if past else None)

    def done(title, blocks, suggestions, intent):
        if past_note and intent not in ('help', 'workday') and not any(b.get('type') == 'text' and b.get('text') == past_note['text'] for b in blocks):
            blocks = blocks + [past_note]
        ctx['intent'] = ctx['intent'] or intent
        return {'title': title, 'blocks': blocks, 'suggestions': suggestions[:4], 'context': ctx, 'intent': intent}

    intent = p['intent']

    # ---- help
    if intent == 'help':
        return done('Here is what I can look up for you', [
            {'type': 'list', 'items': [
                'A summary for a period: "summary of this week"',
                'Tasks by status: paused, running, not started, waiting for approval, completed',
                'By priority: "urgent tasks not started"',
                'One person: "how is Ravi doing", "Ravi\'s paused tasks last week"',
                'Overdue tasks and tasks that went over their estimate',
                'Alerts that need attention',
                'Who started their workday today',
                'Top performers for a period',
                'A task by name: "status of login page"',
                'Add "how many" for a number, and a period like "yesterday" or "this month"',
            ]},
            {'type': 'text', 'text': 'Answers come straight from the live board. AI is off, so I only show what is in the data.'},
        ], STARTERS[:4], 'help')

    # ---- workday (today's sessions, whatever the period)
    if intent == 'workday':
        wd = workday or {'sessions': [], 'without': []}
        rows = []
        for r in sorted(wd.get('sessions') or [], key=lambda r: (r.get('state') != 'open', r.get('name') or '')):
            st = 'Paused' if r.get('is_paused') and r.get('state') == 'open' else ('Working' if r.get('state') == 'open' else 'Ended')
            rows.append({'person': r.get('name') or '', 'status': st, 'start': r.get('login_at') or '', 'end': r.get('logout_at') or ''})
        for n in wd.get('without') or []:
            rows.append({'person': n, 'status': 'Not started', 'start': '', 'end': ''})
        if p['employee']:
            rows = [r for r in rows if r['person'] == p['employee']] or [{'person': p['employee'], 'status': 'Not started', 'start': '', 'end': ''}]
        only_missing = any(_has(_norm(question), w) for w in (
            'absent', 'not started', 'not yet', "didn't", 'didnt', "hasn't", 'hasnt', "haven't", 'havent', 'missing', 'on leave'))
        if only_missing:
            rows = [r for r in rows if r['status'] == 'Not started']
        working = sum(1 for r in rows if r['status'] in ('Working', 'Paused'))
        missing = sum(1 for r in rows if r['status'] == 'Not started')
        if p['employee'] and rows:
            title = '%s %s' % (p['employee'], {
                'Working': 'has started their workday' + (' (at %s)' % rows[0]['start'] if rows[0].get('start') else ''),
                'Paused': 'has paused their workday', 'Ended': 'has ended their workday',
            }.get(rows[0]['status'], "hasn't started their workday today"))
        elif only_missing:
            title = ('%s %s started their workday today' % (_plural(missing, 'person', 'people'), "hasn't" if missing == 1 else "haven't")
                     if missing else 'Everyone has started their workday today')
        else:
            title = '%s started their workday today%s' % (_plural(working, 'person', 'people'),
                                                         (', %d not yet' % missing) if missing else '')
        blocks = [{'type': 'table', 'columns': [
            {'key': 'person', 'label': 'Person', 'kind': 'person'}, {'key': 'status', 'label': 'Workday', 'kind': 'text'},
            {'key': 'start', 'label': 'Started', 'kind': 'text'}, {'key': 'end', 'label': 'Ended', 'kind': 'text'}],
            'rows': rows, 'more': 0}] if rows else [{'type': 'text', 'text': 'No workday has been started today.'}]
        ctx['period'] = 'today'
        return done(title, blocks, ['Who has paused tasks?', 'Summary of today', 'Who is running a task?'], 'workday')

    # ---- leaderboard
    if intent == 'leaderboard':
        emps = [e for e in digest.get('employees') or [] if e.get('name') != 'Unassigned']
        q = _norm(question)
        worst = any(_has(q, w) for w in ('least', 'lowest', 'worst'))
        key, metric = 'completed_count', 'completed task'
        st0 = p['statuses'][0] if p['statuses'] else None
        if st0 in ('paused', 'in_progress', 'not_started', 'partially_completed'):
            key, metric = {'paused': ('paused_count', 'paused task'), 'in_progress': ('in_progress_count', 'running task'),
                           'not_started': ('not_started_count', 'unstarted task'),
                           'partially_completed': ('pending_approval_count', 'task waiting for approval')}[st0]
        emps = sorted(emps, key=lambda e: ((e.get(key) or 0), -(e.get('total_actual_hours') or 0)), reverse=not worst)
        rows = [{'person': e['name'], 'completed': e.get('completed_count', 0), 'running': e.get('in_progress_count', 0),
                 'paused': e.get('paused_count', 0), 'waiting': e.get('not_started_count', 0),
                 'hours': _hours(e.get('total_actual_hours')), 'perf': (e.get('overall_performance') or '').replace('_', ' ').capitalize()}
                for e in emps]
        if not rows:
            return done('No work recorded %s' % plabel, [{'type': 'text', 'text': 'Nobody has tasks in this period.'}],
                        ['Summary of today', 'Top performers this month'], 'leaderboard')
        lead = emps[0]
        if not worst and not (lead.get(key) or 0):
            title = 'Nobody has a %s %s yet' % (metric, plabel)
        else:
            title = ('%s %s with %s' % (lead['name'], 'is lowest' if worst else 'leads',
                                        _plural(lead.get(key) or 0, metric, metric.replace('task', 'tasks', 1)))
                     + ' ' + plabel)
        return done(title, [{'type': 'table', 'columns': [
            {'key': 'person', 'label': 'Person', 'kind': 'person'}, {'key': 'completed', 'label': 'Completed', 'kind': 'num'},
            {'key': 'running', 'label': 'Running', 'kind': 'num'}, {'key': 'paused', 'label': 'Paused', 'kind': 'num'},
            {'key': 'waiting', 'label': 'Not started', 'kind': 'num'}, {'key': 'hours', 'label': 'Hours', 'kind': 'num'},
            {'key': 'perf', 'label': 'Performance', 'kind': 'text'}], 'rows': rows, 'more': 0}],
            ['Top performers this month', 'Who has paused tasks?', 'Summary of this week'], 'leaderboard')

    # ---- alerts
    if intent == 'alerts':
        alerts = digest.get('alerts') or []
        if p['employee']:
            alerts = [a for a in alerts if a.get('employee') == p['employee']]
        if not alerts:
            return done('Nothing needs attention%s' % (' for %s' % p['employee'] if p['employee'] else ''),
                        [{'type': 'text', 'text': 'No urgent task is waiting, no important task is unstarted and nothing has been paused for 2+ days.'}],
                        ['Who has paused tasks?', 'Summary of today'], 'alerts')
        groups = {'URGENT_NOT_STARTED': 'Urgent and not started', 'IMPORTANT_NOT_STARTED': 'Important and not started',
                  'PAUSED_TOO_LONG': 'Paused for 2+ days'}
        blocks = []
        for typ, label in groups.items():
            items = [a.get('message') + (' — ' + a['employee'] if a.get('employee') else '')
                     + (' (%s)' % a['reason'] if a.get('reason') and a.get('reason') != 'No reason' else '')
                     for a in alerts if a.get('type') == typ]
            if items:
                blocks.append({'type': 'list', 'title': '%s (%d)' % (label, len(items)), 'items': items})
        return done('%s need attention' % _plural(len(alerts), 'item'), blocks,
                    ['Urgent tasks not started', 'Who has paused tasks?', 'Overdue tasks'], 'alerts')

    # ---- task filters (status / priority / person / overdue / over estimate / search)
    sel = tasks
    if p['employee']:
        sel = [t for t in sel if t['person'] == p['employee']]
    elif p['unassigned']:
        sel = [t for t in sel if t['person'] == 'Unassigned']
    if p['statuses']:
        sel = [t for t in sel if t['group'] in p['statuses']]
    if p['priorities']:
        sel = [t for t in sel if (t.get('priority') or 'regular') in p['priorities']]
    extra_cols = []
    if intent == 'overdue':
        iso = today.isoformat()
        sel = [t for t in sel if t.get('deadline') and t['deadline'][:10] < iso and t['group'] != 'completed']
        sel = sorted(sel, key=lambda t: t['deadline'])
        extra_cols = ['deadline']
    elif intent == 'over_estimate':
        sel = [t for t in sel if (t.get('extra_time') or 0) > 0
               or (t.get('estimated_hours') and (t.get('actual_hours') or 0) > t['estimated_hours'])]
        for t in sel:
            if not t.get('extra_time'):
                t['extra_time'] = round((t.get('actual_hours') or 0) - (t.get('estimated_hours') or 0), 2)
        sel = sorted(sel, key=lambda t: -(t.get('extra_time') or 0))
        extra_cols = ['extra']

    search = p['search']
    if not search and not intent and not p['statuses'] and not p['priorities'] and not p['employee'] \
            and not p['unassigned'] and p['rest']:
        search = ' '.join(p['rest'])
    if search:
        words = [w for w in _norm(search).split() if w not in _STOP and len(w) > 1]
        hits = [t for t in sel if words and all(w in _norm((t.get('ref') or '') + ' ' + (t.get('name') or '')) for w in words)]
        if not hits and words:  # any word, ranked by how many matched
            scored = [(sum(w in _norm(t.get('name') or '') for w in words), t) for t in sel]
            hits = [t for s, t in sorted(scored, key=lambda x: -x[0]) if s][:10]
        if hits:
            label = 'Found %s matching "%s"' % (_plural(len(hits), 'task'), search)
            return done(label, [_task_table(hits, max_rows=max_rows)], ['Who has paused tasks?', 'Summary of today'], 'search')
        if not (intent or p['statuses'] or p['priorities'] or p['employee']):
            return done("I didn't understand that", [
                {'type': 'text', 'text': 'No task matches "%s" %s, and it isn\'t a question I know. Try one of these:' % (search, plabel)}],
                STARTERS[:4], 'unknown')

    filtered = bool(p['statuses'] or p['priorities'] or p['employee'] or p['unassigned'] or intent in ('overdue', 'over_estimate'))
    if not filtered:
        if intent == 'summary' or p['count'] or not p['rest']:
            title, blocks = _summary(digest, plabel, workday)
            if p['count']:
                s = digest.get('summary') or {}
                title = 'There are %s %s' % (_plural(s.get('total_tasks', 0), 'task'), plabel)
            return done(title, blocks, ['Who has paused tasks?', 'Urgent tasks not started', 'Top performers this week'], 'summary')
        return done("I didn't understand that", [{'type': 'text', 'text': 'Try one of these:'}], STARTERS[:4], 'unknown')

    # Person with no status filter: their own summary + tasks.
    what = _describe(p['statuses'], p['priorities'])
    if intent == 'overdue':
        what = ('overdue ' + what).strip()
    elif intent == 'over_estimate':
        what = (what + ' over-estimate').strip()
    if p['unassigned'] and not p['employee']:
        what = ('unassigned ' + what).strip()
    who = p['employee']
    blocks = []
    if p['employee'] and not p['statuses'] and not p['priorities'] and intent not in ('overdue', 'over_estimate'):
        emp = next((e for e in digest.get('employees') or [] if e.get('name') == p['employee']), {})
        blocks.append({'type': 'stats', 'items': [
            {'label': 'Completed', 'value': emp.get('completed_count', 0)},
            {'label': 'Running', 'value': emp.get('in_progress_count', 0)},
            {'label': 'Paused', 'value': emp.get('paused_count', 0)},
            {'label': 'Not started', 'value': emp.get('not_started_count', 0)},
            {'label': 'Pending approval', 'value': emp.get('pending_approval_count', 0)},
            {'label': 'Hours (est / actual)', 'value': '%s / %s' % (_hours(emp.get('total_estimated_hours')), _hours(emp.get('total_actual_hours')))},
        ]})
        title = '%s %s: %s' % (p['employee'], plabel, _plural(len(sel), 'task'))
        sugg = ["%s's paused tasks" % p['employee'], "%s's completed tasks this week" % p['employee'], 'Top performers this week']
    else:
        n = len(sel)
        noun = (what + ' task') if what else 'task'
        if p['count']:
            title = ('%s has %s' % (who, _plural(n, noun)) if who
                     else 'There %s %s' % ('is' if n == 1 else 'are', _plural(n, noun)))
        else:
            title = '%s%s (%d)' % (noun[0].upper() + noun[1:] + 's', (' for ' + who) if who else '', n)
        title += (' ' + plabel) if ('completed' in p['statuses'] or past or period != 'today'
                                    or intent == 'over_estimate') else ' right now'
        sugg = ['Who has paused tasks?', 'Urgent tasks not started', "What's waiting for my approval?", 'Summary of today']
        if p['statuses'] == ['paused']:
            sugg = ['Paused tasks this week', 'Alerts that need attention', 'Who is running a task?']
        elif p['statuses'] == ['partially_completed']:
            sugg = ['Completed tasks this week', 'Who has paused tasks?', 'Top performers this week']
    if not sel:
        blocks.append({'type': 'text', 'text': 'None %s.' % ('for ' + who if who else 'found') + (' ' + plabel if past else '')})
    else:
        blocks.append(_task_table(sel, extra_cols, sort=intent not in ('overdue', 'over_estimate'), max_rows=max_rows))
    return done(title, blocks, [s for s in sugg if s.lower() != (question or '').strip().lower()], intent or 'filter')
