"""Smart typing: understand what is TYPED instead of tapped.

After "hi" the bot used to understand only a tapped option, its exact text or
its number; anything else typed was silently ignored. This is one fallback,
run only when the normal step found no match, so it never takes over a step
that is collecting words (an update, a reason, a search):

* part of an option on the current menu -- "pause", "kpi", "in prog";
* a task number typed any way -- REQ-010, req10, req 10;
* a few commands from anywhere -- "lunch", "my tasks", "end day";
* in client groups, part of an option ("bug", "new requirement").

Two guards keep ordinary group chat quiet:

* Only while someone is in a menu. At idle, the staff group still understands
  a task number or a command word on its own (those are never chat). In a
  client group, a short message that names one request type ("bug",
  "update", "my requests") asks "🐞 Report a Bug? ✅ Yes / ❌ No" even at idle;
  anything else there stays silent, as before.
* One clear match only. Two matches ask "Which one?".
* Typed is not tapped. A tap runs at once, as always; anything TYPED that
  would change something (lunch, break, start / end / pause day, back to
  work, take / resume / switch a task, a pause reason…) asks ✅ Yes / ❌ No
  first. Typing that only opens or shows something opens it straight away.
"""

import logging
import re

from odoo import _, api, models

from .kpi_wa_group_intake import _CANCELS, _GREETINGS, _TYPE_BY_ID, _smart_rows, _strip_emoji, _words
from .kpi_wa_staff_menu import BACK_LABEL, HOME_LABEL, STAFF_BY_ID, _actions_for
from .kpi_wa_staff_task import HOME, MEDIA_TYPES, PAUSE_STORED
from .kpi_workflow import REF_PREFIX_FOR_DOC_TYPE

_logger = logging.getLogger(__name__)

# Longer than this is somebody talking, not somebody picking.
SMART_MAX_WORDS = 6
# With no menu open (client groups), only a few words can be a request type.
IDLE_MAX_WORDS = 3

# Steps whose typed text IS the answer. Smart typing never touches them.
STAFF_FREE_TEXT = ('collect', 'branch', 'dupfile', 'entry_text', 'entry_file', 'entry_link', 'time',
                   'pause_note', 'meet_who', 'meet_note', 'resume_reason', 'mt_search', 'switch_search',
                   'client_reply')

# Client pickers that get a "didn't catch that" hint. Free-text and confirm
# steps are left alone.
CLIENT_PICK_STEPS = ('pick_type', 'pick_server', 'pick_db', 'pick_area', 'pick_install', 'pick_hour',
                     'pick_slot', 'pick_tz', 'myreq_pick', 'discuss_kind', 'discuss_pick', 'livedb_server', 'livedb_db',
                     'pick_disc_db', 'pick_disc_reason')

# Steps where a request word the step itself did not take ("bug" while a
# decline question waits) still gets "🐞 Report a Bug? ✅ Yes / ❌ No".
MID_STEP_WORDS = ('decline_reconfirm',) + tuple(s for s in CLIENT_PICK_STEPS if s != 'pick_type')

# Typed command -> code. The whole message must be one of these.
STAFF_COMMANDS = [
    ('mytasks', ('my tasks', 'tasks', 'my task', 'task list')),
    ('inprog', ('in progress', 'running', 'inprogress')),
    ('status', ('status', 'my status', 'current status')),
    ('day_start', ('start day', 'start my day', 'start workday', 'start work', 'day start')),
    ('day_end', ('end day', 'end my day', 'end workday', 'end work', 'day end')),
    ('day_pause', ('pause day', 'pause my day', 'pause my whole day', 'pause workday')),
    ('lunch', ('lunch', 'lunch break')),
    ('break', ('break', 'tea', 'tea break', 'coffee', 'coffee break', 'short break')),
    ('back', ('back to work', 'resume', 'resume day', 'resume my day', 'im back', 'i am back')),
    # "stop" is how people say pause: it asks first, then the reason.
    ('pause', ('pause', 'pause task', 'stop', 'stop task', 'stop work', 'stop it')),
    ('switch', ('switch', 'switch task')),
    ('doubt', ('doubt', 'clarification')),
    ('meeting', ('meeting',)),
    ('newtask', ('new task', 'create task', 'create my own task', 'add task')),
]
STAFF_COMMAND_BY_TEXT = {t: code for code, texts in STAFF_COMMANDS for t in texts}

# Single main words -> command, for short typed messages that are not one of
# the phrases above ("task", "progress", "prog", "tea"). A word matches when it
# is the keyword or its start (3+ letters). Every typed command asks first.
STAFF_KEYWORDS = [
    ('mytasks', ('task', 'tasks', 'mytask', 'mytasks', 'todo', 'list', 'work', 'job', 'jobs')),
    ('inprog', ('progress', 'inprogress', 'running', 'ongoing', 'current')),
    ('status', ('status', 'where')),
    ('doubt', ('doubt', 'doubts', 'clarification', 'clarify', 'query', 'question')),
    ('meeting', ('meeting', 'meet', 'call')),
    ('newtask', ('newtask', 'create')),
    ('lunch', ('lunch',)),
    ('break', ('break', 'tea', 'coffee', 'snack')),
    ('back', ('resume', 'back', 'continue')),
    ('pause', ('pause', 'hold')),
    ('switch', ('switch', 'change')),
    ('day_start', ('start', 'login', 'checkin')),
    ('day_end', ('end', 'logout', 'checkout')),
]
# How each command is asked when it was typed (day commands ask their own).
STAFF_CMD_ASK = {
    'mytasks': '📋 Open my tasks?',
    'inprog': '▶️ Show my tasks in progress?',
    'status': '📍 Show my current status?',
    'doubt': '❓ Raise a doubt / clarification?',
    'meeting': '📅 Set up a meeting?',
    'newtask': '➕ Create a new task?',
    'pause': '⏸️ Pause a task?',
    'switch': '🔀 Switch task?',
}
# At idle (no menu open) only a short message can be a command; longer is chat.
STAFF_IDLE_MAX_WORDS = 4
# Labels for "Which one did you mean?" when a word fits several commands.
STAFF_CMD_LABEL = {
    'mytasks': '📋 My tasks', 'inprog': '▶️ In progress', 'status': '📍 Current status',
    'doubt': '❓ Doubt / clarification', 'meeting': '📅 Meeting', 'newtask': '➕ New task',
    'lunch': '🍽️ Lunch', 'break': '☕ Break', 'back': '🔙 Back to work', 'pause': '⏸️ Pause a task',
    'switch': '🔀 Switch task', 'day_start': '🌅 Start my day', 'day_end': '🌙 End my day',
}
# Typed answers to a waiting ✅ Yes / ❌ No (client groups).
_YES_NO_WORDS = ('yes', 'y', 'yeah', 'yep', 'ok', 'okay', 'no', 'n', 'nope', 'send', 'confirm')


def _staff_cmds_for(body):
    """The commands a short typed message points at: [] none, one = clear."""
    words = [w.lower() for w in _words(body)]
    if not words:
        return []
    exact = STAFF_COMMAND_BY_TEXT.get(' '.join(words))
    if exact:
        return [exact]
    # "new task" / "start task" are phrases; "task" alone is My tasks.
    joined = ' '.join(words)
    for phrase, code in (('new task', 'newtask'), ('add task', 'newtask'), ('create task', 'newtask'),
                         ('start task', 'mytasks'), ('take task', 'mytasks'),
                         ('start day', 'day_start'), ('end day', 'day_end')):
        if phrase in joined:
            return [code]
    found = []
    for code, keys in STAFF_KEYWORDS:
        for w in words:
            if any(k == w or (len(w) >= 3 and k.startswith(w)) for k in keys):
                if code not in found:
                    found.append(code)
                break
    return found

# Main-menu rows that change the day. Reached by TYPING, they go through the
# matching command, which asks ✅ Yes / ❌ No first. A tap still runs at once.
MENU_CONFIRM = {
    'day_start': 'day_start', 'day_end': 'day_end', 'day_pause': 'day_pause',
    'day_resume': 'back', 'nt_end': 'back', 'brk_resume': 'back',
    'nt_lunch': 'lunch', 'nt_break': 'break', 'no_tasks': 'no_tasks',
    'pause_menu': 'pause',
}
# Other rows that DO something when picked. Typed, they ask "Did you mean …?"
MENU_TAP_CONFIRM = ('meet_end',)
TASK_TAP_CONFIRM = ('take', 'resume', 'switch', 'pause')
# Polls that only open or show something; anything picked in any other poll
# changes something (a pause reason, a switch, a meeting, a delete…).
VIEW_FLOW_STEPS = ('mt_phase', 'mt_lane', 'mt_task', 'mt_filter', 'mt_proj', 'kpi_menu', 'logs', 'files',
                   'day_pick', 'pause_which', 'entry', 'mine', 'smart_pick',
                   'client_reply_confirm')       # itself the ✅ Send / ❌ Cancel question

# Labels for the "what next" poll after a command that has nothing to act on.
NEXT_LABELS = {
    'mytasks': '▶️ Start a task (My tasks)',
    'day_pause': '🗓️ Pause my whole day',
    'lunch': '🍽️ Lunch',
    'break': '☕ Break',
}
YES, NO = '✅ Yes', '❌ No'

STAFF_HINT = "🤔 Didn't catch that — tap an option, or type part of it (e.g. *pause*, *REQ-010*, *lunch*)."
CLIENT_HINT = "🤔 Didn't catch that — tap an option, or type part of it (e.g. *bug*, *new requirement*, *my requests*)."


def _typed(message):
    """The typed text, or '' for a poll vote, a button or a file."""
    if message.message_type == 'poll_vote' or message.message_type in MEDIA_TYPES:
        return ''
    if (message.interactive_reply_id or '').strip():
        return ''
    return (message.message or '').strip()


class KpiWaSmartTyping(models.AbstractModel):
    _inherit = 'kpi.wa.group.router'

    # ================================================================== #
    # client groups                                                       #
    # ================================================================== #
    @api.private
    @api.model
    def handle(self, message):
        try:
            asked = self._client_smart_first(message)
        except Exception as exc:
            _logger.warning('smart typing (client, confirm) failed: %s', exc)
            asked = None
        if asked:
            return asked
        res = super().handle(message)
        if res:
            return res
        try:
            # The step waiting (a decline question, a picker) did not take it:
            # a request word ("bug") still gets its Yes / No.
            asked = self._client_smart_first(message, mid_step=True)
            if asked:
                return asked
            return self._client_smart(message)
        except Exception as exc:
            _logger.warning('smart typing (client) failed: %s', exc)
            return False

    def _client_smart_first(self, message, mid_step=False):
        """A request type TYPED in a client group -- "bug", "update", "my
        requests" -- asks "🐞 Report a Bug? ✅ Yes / ❌ No" first, even with no
        menu open. Only a whole short message that names one option; ordinary
        chat stays quiet. On the menu, a typed number or exact name asks too.
        None lets the normal flow handle it (taps, everything else)."""
        body = _typed(message)
        if not body:
            return None
        low = body.lower()
        if low in _GREETINGS or low in _CANCELS:
            return None
        group = self.env['kpi.wa.group'].sudo().search([('jid', '=', (message.phone or '').strip())], limit=1)
        if not group or group.is_staff_group or not group.intake_enabled or not group.kra_id:
            return None
        key = (message.participant_jid or '').strip() or (message.push_name or '').strip()
        if not key:
            return None
        state = self.env['kpi.wa.group.intake']._get_or_create(group, key, message.push_name or '')
        if mid_step:
            # Called after the waiting step found no answer in the message.
            # Never a free-text step: there the words ARE the answer.
            if state.step not in MID_STEP_WORDS:
                return None
        elif state.step == 'type_confirm':
            # A "📅 Request a Meeting? ✅ Yes / ❌ No" is waiting and they typed
            # another request word ("bug"): ask about that one instead of
            # going quiet. A typed yes / no still answers the waiting question.
            if _strip_emoji(body).lower() in _YES_NO_WORDS:
                return None
        elif state.step not in ('idle', 'pick_type'):
            return None
        rows = [(c, l) for c, l, _b in self._type_rows_for(group)]
        on_menu = state.step == 'pick_type'
        if on_menu:
            offered = [c for c in (state.menu_csv or '').split(',') if c]
            if offered:
                rows = [r for r in rows if r[0] in offered]
        elif len(body.split()) > IDLE_MAX_WORDS:
            return None                       # a sentence at idle is chat
        if len(body.split()) > SMART_MAX_WORDS:
            return None
        clean = _strip_emoji(body)
        row = next((r for r in rows if _strip_emoji(r[1]) == clean), None)
        if not row and on_menu and body.isdigit() and 1 <= int(body) <= len(rows):
            row = rows[int(body) - 1]
        if not row:
            hits = _smart_rows(body, rows)
            row = hits[0] if len(hits) == 1 else None
        if not row:
            return None
        code, label = row
        state._touch(step='type_confirm', menu_csv=code)
        self._poll(message, _('%s?') % label, [YES, NO])
        return True

    def _client_smart(self, message):
        """Nothing matched in a client menu: say so and show the options again.
        Part-of-an-option matching itself lives in the pickers (_smart_rows)."""
        body = _typed(message)
        if not body or len(body.split()) > SMART_MAX_WORDS:
            return False
        group = self.env['kpi.wa.group'].sudo().search([('jid', '=', (message.phone or '').strip())], limit=1)
        if not group or group.is_staff_group or not group.intake_enabled or not group.kra_id:
            return False
        key = (message.participant_jid or '').strip() or (message.push_name or '').strip()
        state = self.env['kpi.wa.group.intake'].sudo().search(
            [('group_id', '=', group.id), ('participant_key', '=', key)], limit=1)
        if not state or state.step not in CLIENT_PICK_STEPS:
            return False                      # idle: ordinary chatter, stay quiet
        if state.step == 'pick_type':
            offered = [c for c in (state.menu_csv or '').split(',') if c in _TYPE_BY_ID]
            rows = [(c, _TYPE_BY_ID[c][1]) for c in offered]
            hits = _smart_rows(body, rows)
            q = (_('🤔 Which one — %s?') % _(' or ').join('*%s*' % _strip_emoji(l) for _c, l in hits)
                 if len(hits) > 1 else CLIENT_HINT)
            self._poll(message, q, [l for _c, l in rows])
            return True
        self._text(message, _("🤔 Didn't catch that — tap an option on the menu above, or type part of it."))
        return True

    # ================================================================== #
    # staff group                                                         #
    # ================================================================== #
    def _handle_staff(self, message, state, group):
        # Only on the inner call, which carries the person's poll context
        # (_handle_staff calls itself once with it, for staff only).
        inner = bool(self.env.context.get('kpi_wa_state_id'))
        if inner:
            # Before the normal step: a TYPED answer that would change
            # something asks first -- even the option's exact words or its
            # number, which the step itself would otherwise run at once.
            try:
                asked = self._staff_smart_first(message, state, group)
            except Exception as exc:
                _logger.warning('smart typing (staff, confirm) failed: %s', exc)
                asked = None
            if asked:
                return asked
        res = super()._handle_staff(message, state, group)
        if res or not inner:
            return res
        try:
            return self._staff_smart(message, state, group)
        except Exception as exc:
            _logger.warning('smart typing (staff) failed: %s', exc)
            return False

    def _staff_smart_first(self, message, state, group):
        """A typed answer on a poll that would CHANGE something: ask ✅ Yes /
        ❌ No instead of running it. None lets the normal step handle it
        (taps, Yes / No answers, typing that only opens something)."""
        body = _typed(message)
        if not body or len(body.split()) > SMART_MAX_WORDS:
            return None
        if body.lower() in ('cancel', 'stop', 'exit', 'hi', 'hello', 'hey', 'menu', 'help'):
            return None
        user, allowed = self._staff_member(state, group)
        if not allowed:
            return None
        step = state.step
        d = self._fd(state) if step == 'staff_flow' else {}
        if step not in ('staff_menu', 'staff_pick_task', 'staff_task_actions', 'staff_flow') \
                or d.get('at') in STAFF_FREE_TEXT:
            return None
        rows = self._smart_menu_rows(state, user, d)
        clean = _strip_emoji(body)
        row = next((r for r in rows if _strip_emoji(r[1]) == clean), None)
        if not row and body.isdigit() and 1 <= int(body) <= len(rows):
            row = rows[int(body) - 1]
        if not row:
            hits = _smart_rows(body, rows)
            row = hits[0] if len(hits) == 1 else None
        if not row:
            return None
        code, label = row
        if step == 'staff_menu' and code in MENU_CONFIRM:
            cmd = STAFF_COMMAND_BY_TEXT.get(' '.join(_words(body)))
            return self._smart_cmd(message, state, user, cmd or MENU_CONFIRM[code])
        # Anything TYPED asks first -- a tap still runs at once. Not the ✅ Yes
        # / ❌ No answer itself, and not ⬅️ Back / 🏠 Home.
        if self._smart_typed_asks(step, d, label):
            return self._smart_confirm_tap(message, state, d, label)
        return None

    def _staff_smart(self, message, state, group):
        body = _typed(message)
        if not body or len(body.split()) > SMART_MAX_WORDS:
            return False
        user, allowed = self._staff_member(state, group)
        if not allowed:
            return False
        step = state.step
        d = self._fd(state) if step == 'staff_flow' else {}
        if step == 'staff_text' or d.get('at') in STAFF_FREE_TEXT:
            return False
        in_menu = step in ('staff_menu', 'staff_pick_task', 'staff_task_actions') \
            or (step == 'staff_flow' and d.get('at'))

        # 1. Part of an option on the poll they are looking at.
        cmds = _staff_cmds_for(body) if (in_menu or len(body.split()) <= STAFF_IDLE_MAX_WORDS) else []
        cmd = cmds[0] if len(cmds) == 1 else None
        rows = self._smart_menu_rows(state, user, d) if in_menu else []
        hits = _smart_rows(body, rows)
        if len(hits) == 1:
            # A typed word is not a tap: a main-menu row that changes the day
            # goes through a command, which checks what is running and asks
            # ✅ Yes / ❌ No first. "pause" on the main menu is the pause
            # command, never a silent ⏸️ Pause my day.
            code, label = hits[0]
            if step == 'staff_menu' and code in MENU_CONFIRM:
                return self._smart_cmd(message, state, user, cmd or MENU_CONFIRM[code])
            if self._smart_typed_asks(step, d, label):
                return self._smart_confirm_tap(message, state, d, label)
            return self._smart_tap(message, state, user, label)
        if cmd:
            return self._smart_ask_cmd(message, state, user, cmd)
        if len(cmds) > 1:
            # "start" could be the day or a task: ask which.
            return self._fask(message, state, {'at': 'smart_pick', 'codes': cmds[:9] + ['no']},
                              _('🤔 Which one did you mean?'),
                              [STAFF_CMD_LABEL.get(c, c) for c in cmds[:9]] + [NO])
        if len(hits) > 1:
            return self._smart_repoll(message, state, user, d, rows, _('🤔 Which one — %s?') % _(' or ').join(
                '*%s*' % _strip_emoji(l) for _c, l in hits))

        # 3. A task number.
        done = self._smart_task_ref(message, state, user, body)
        if done is not None:
            return done

        # 4. Nothing understood: only answered inside a menu, never at idle.
        if in_menu:
            return self._smart_repoll(message, state, user, d, rows, STAFF_HINT)
        return False

    # ------------------------------------------------------------------
    def _smart_menu_rows(self, state, user, d):
        """[(code, label)] of the poll this person was last sent."""
        step = state.step
        offered = [c for c in (state.menu_csv or '').split(',') if c]
        if step == 'staff_menu':
            current = dict(self._staff_rows_for(user))
            return [(c, current.get(c) or STAFF_BY_ID.get(c, c)) for c in offered]
        if step == 'staff_task_actions':
            task = state.staff_kpi_id
            if not task or not task.exists():
                return []
            rows = [(c, l) for c, l in _actions_for(task, user) if c in offered]
            rows += [(c, l) for c, l in (('back', BACK_LABEL), ('home', HOME_LABEL)) if c in offered]
            return rows
        if step == 'staff_pick_task':
            ids = [int(i) for i in offered if i.strip().isdigit()]
            return [(t.id, self._task_line(t, True)) for t in self.env['kra.kpi'].sudo().browse(ids).exists()]
        if step == 'staff_flow':
            return list(enumerate(d.get('opts') or []))
        return []

    def _smart_tap(self, message, state, user, label):
        """Run the step as if `label` had been tapped, so the normal handler does the work."""
        step = state.step
        low = label.lower()
        if step == 'staff_menu':
            return self._staff_pick_action(message, state, user, label, low)
        if step == 'staff_pick_task':
            return self._staff_pick_task(message, state, user, label, low)
        if step == 'staff_task_actions':
            return self._staff_task_action(message, state, user, label, low)
        return self._flow(message, state, user, label, low, label)

    @staticmethod
    def _smart_tap_changes(step, d, code, label):
        """True when picking this row changes something (rather than only
        opening or showing something), so a TYPED pick asks first."""
        if _strip_emoji(label) in (_strip_emoji(BACK_LABEL), _strip_emoji(HOME_LABEL)):
            return False
        if step == 'staff_menu':
            return code in MENU_TAP_CONFIRM
        if step == 'staff_task_actions':
            return code in TASK_TAP_CONFIRM
        if step == 'staff_flow':
            if d.get('at') == 'smart_pick':          # the Yes / No itself is the answer
                return label not in (YES, NO)
            return d.get('at') not in VIEW_FLOW_STEPS
        return False

    @staticmethod
    def _smart_typed_asks(step, d, label):
        """A TYPED pick asks "Did you mean …?" first -- everything except the
        ✅ Yes / ❌ No answer itself and ⬅️ Back / 🏠 Home."""
        if _strip_emoji(label) in (_strip_emoji(BACK_LABEL), _strip_emoji(HOME_LABEL)):
            return False
        if step == 'staff_flow' and d.get('at') == 'smart_pick':
            return label not in (YES, NO)
        return True

    def _smart_ask_cmd(self, message, state, user, cmd):
        """A typed command: ask first. The day commands ask their own question
        (and check what is running); the rest ask STAFF_CMD_ASK."""
        if cmd in STAFF_CMD_ASK:
            return self._smart_confirm(message, state, cmd, _(STAFF_CMD_ASK[cmd]))
        return self._smart_cmd(message, state, user, cmd)

    def _smart_confirm_tap(self, message, state, d, label):
        """"Did you mean …?" -- on ✅ Yes the step is put back as it was and
        the option is run exactly as if it had been tapped."""
        prev = {'step': state.step, 'draft': state.staff_draft or False,
                'menu_csv': state.menu_csv or False, 'action': state.staff_action or False}
        return self._fask(message, state, {'at': 'smart_pick', 'codes': ['tap', 'no'],
                                           'label': label, 'prev': prev},
                          _('Did you mean *%s*?') % label, [YES, NO])

    def _smart_repoll(self, message, state, user, d, rows, question):
        """The same poll again, under a new question. Same options in the same
        order, so whatever is tapped next still resolves."""
        labels = [l for _c, l in rows]
        if not labels:
            return False
        if state.step == 'staff_flow':
            return self._fask(message, state, d, question, [l for l in labels if l != HOME])
        self._poll(message, question, labels)
        return True

    # ------------------------------------------------------------------
    def _smart_task_ref(self, message, state, user, body):
        """REQ-010 / req10 / req 10 -> that task's menu. None when the text is
        not a task number at all."""
        m = re.match(r'^([a-z]+)0*(\d+)$', self._norm(body))
        if not m or len(m.group(1)) < 2:
            return None
        board = self.env['kra.kpi'].sudo().browse(
            list({i for ids in self._board_lanes(user).values() for i in ids})).exists()
        prefixes = {p.lower() for p in REF_PREFIX_FOR_DOC_TYPE.values()} | {'task'}
        prefixes |= {re.match(r'^[a-z]*', self._norm(t.external_ref)).group(0) for t in board} - {''}
        if not any(p.startswith(m.group(1)) for p in prefixes):
            return None                       # "win10", "covid19": not a task number
        ref = '%s-%03d' % (m.group(1).upper(), int(m.group(2)))
        ids = [i for i in self._mt_search_ids(user, body)
               if re.match(r'^[a-z]+0*%s$' % m.group(2), self._norm(self.env['kra.kpi'].sudo().browse(i).external_ref))]
        if not ids:
            self._text(message, _('No task %s on your list.') % ref)
            return True
        if len(ids) > 1:
            return self._mt_tasks(message, state, user, None, None, 0, query=body)
        task = self.env['kra.kpi'].sudo().browse(ids[0])
        state._touch(staff_action='mytasks', menu_csv=False, staff_draft=False)
        return self._staff_offer_actions(message, state, task)

    # ------------------------------------------------------------------
    def _smart_next(self, message, state, why, codes):
        """Say why the command could not run, then offer what can."""
        return self._fask(message, state, {'at': 'smart_pick', 'codes': codes}, why,
                          [NEXT_LABELS[c] for c in codes])

    def _smart_confirm(self, message, state, cmd, question):
        return self._fask(message, state, {'at': 'smart_pick', 'codes': [cmd, 'no']}, question, [YES, NO])

    def _fl_smart_pick(self, message, state, user, d, task, tapped, low, body):
        i = self._fchoice(d, tapped, low)
        if i is None:
            return False
        codes = d.get('codes') or []
        code = codes[i] if i < len(codes) else None
        if not code:
            state._reset()
            return self._show_staff_menu(message, state, user)
        if code == 'no':
            state._reset()
            self._text(message, _('OK — nothing changed.'))
            return True
        if code.startswith('resume:'):
            # "Your day is paused. Resume it?" → Yes: resume the day (as ▶️
            # Resume my day does), then the command they typed, asked as usual.
            sess, is_open, _ended = self._workday(user)
            if is_open and sess and sess.is_paused:
                try:
                    res = sess.with_user(user).sudo().action_resume_workday()
                except Exception as exc:
                    res = {'status': False, 'message': str(exc).strip()[:200]}
                if isinstance(res, dict) and res.get('status') is False:
                    state._reset()
                    self._text(message, _('Could not resume your day: %s') % (res.get('message') or ''))
                    return True
                self._text(message, _('▶️ Your day is running again, %s.') % (user.name or ''))
            state._reset()
            return self._smart_cmd(message, state, user, code.split(':', 1)[1])
        if code == 'tap':
            prev = d.get('prev') or {}
            state._touch(step=prev.get('step') or 'idle', staff_draft=prev.get('draft') or False,
                         menu_csv=prev.get('menu_csv') or False, staff_action=prev.get('action') or False)
            return self._smart_tap(message, state, user, d.get('label') or '')
        return self._smart_cmd(message, state, user, code, confirmed=True)

    def _smart_cmd(self, message, state, user, cmd, confirmed=False):
        """A typed command. Only runs when it makes sense right now (the same
        checks _staff_rows_for uses); otherwise says why and offers what does."""
        sess, is_open, ended = self._workday(user)
        day_paused = bool(is_open and sess and sess.is_paused)
        on_break = bool(is_open and sess and sess.nontask_reason)
        running = self._running_tasks(user)
        not_started = _('Your day has not started — send *hi* → 🌅 Start my day.')

        if cmd == 'mytasks':
            state._touch(staff_action='mytasks')
            return self._mytasks_begin(message, state, user)
        if cmd == 'inprog':
            if not self._board_lanes(user).get('in_progress'):
                self._text(message, _('Nothing is in progress right now.'))
                return self._mytasks_begin(message, state, user)
            return self._mt_tasks(message, state, user, 'do', 'in_progress', 0)
        if cmd in ('status', 'doubt', 'meeting'):
            return self._staff_run_code(message, state, user, cmd)
        if cmd == 'newtask':
            return self._create_begin(message, state, user)

        if cmd == 'day_start':
            if is_open:
                self._text(message, _('Your day is already open.'))
                return self._show_staff_menu(message, state, user)
            if ended:
                state._reset()
                self._text(message, _('You already ended your day today — an admin can reopen it.'))
                return True
            if not confirmed:
                return self._smart_confirm(message, state, cmd, _('🌅 Start your day now?'))
            return self._staff_day_start(message, state, user)

        if cmd == 'day_end':
            if is_open and not confirmed:
                return self._smart_confirm(message, state, cmd, _('🌙 End your day now?'))
            return self._staff_day_end(message, state, user)

        if not is_open:
            state._reset()
            self._text(message, not_started)
            return True

        if cmd == 'no_tasks':
            if not confirmed:
                return self._smart_confirm(message, state, cmd, _(
                    '🙅 Tell the admins you have no tasks to work on?'))
            return self._staff_day_control(message, state, user, 'no_tasks')

        if cmd == 'day_pause':
            if day_paused:
                state._reset()
                self._text(message, _('Your day is already paused.'))
                return True
            if not confirmed:
                return self._smart_confirm(message, state, cmd, _(
                    '🗓️ Pause your whole day? Running tasks pause too.'))
            return self._staff_day_control(message, state, user, 'day_pause')

        if cmd in ('lunch', 'break'):
            if day_paused:
                # Not a dead end: offer to resume, then carry on with what they typed.
                return self._fask(message, state, {'at': 'smart_pick', 'codes': ['resume:' + cmd, 'no']},
                                  _('▶️ Your day is paused. Resume it?'), [YES, NO])
            if not confirmed:
                what = _('🍽️ Start lunch?') if cmd == 'lunch' else _('☕ Start a break?')
                if running:
                    what += ' ' + _('%s pauses.') % ', '.join(self._ref(t) for t in running)
                return self._smart_confirm(message, state, cmd, what)
            if len(running) == 1:
                return self._pause_apply(message, state, user, running, cmd, PAUSE_STORED[cmd], [])
            if running:
                return self._pause_all_apply(message, state, user, cmd, PAUSE_STORED[cmd], [])
            return self._staff_nontask(message, state, user, 'nt_%s' % cmd)

        if cmd == 'back':
            back_to = self._break_source_task(user)
            if day_paused:
                if not confirmed:
                    return self._smart_confirm(message, state, cmd, _('▶️ Resume your day?'))
                return self._staff_day_control(message, state, user, 'day_resume')
            if back_to or on_break:
                if not confirmed:
                    q = (_('🔙 Back to work on %s?') % self._ref(back_to)) if back_to else _('🔙 Back to work?')
                    return self._smart_confirm(message, state, cmd, q)
                if back_to:
                    return self._staff_begin(message, state, user, back_to, 'resume')
                return self._staff_nontask_end(message, state, user)
            if self._board_lanes(user).get('paused'):
                return self._mt_tasks(message, state, user, 'do', 'paused', 0,
                                      note=_('You are not on a break. Pick the task to resume:'))
            return self._smart_next(message, state, _('You are not on a break.'), ['mytasks'])

        if cmd == 'pause':
            if day_paused:
                state._reset()
                self._text(message, _('Your whole day is already paused.'))
                return True
            if running:
                if not confirmed:
                    # Typed "pause" / "stop": ask first, then the reason poll.
                    return self._smart_confirm(message, state, cmd, _(
                        '⏸️ Pause %s? You will pick the reason next.') % ', '.join(self._ref(t) for t in running))
                return self._pause_menu(message, state, user)
            return self._smart_next(message, state, _('No task is running right now.'),
                                    ['mytasks', 'day_pause', 'lunch', 'break'])

        if cmd == 'switch':
            if len(running) == 1:
                state._touch(staff_kpi_id=running.id)
                return self._switch_from_begin(message, state, user, running)
            if running:
                return self._mt_tasks(message, state, user, 'do', 'in_progress', 0,
                                      note=_('Pick the running task to switch from, then 🔀 Switch.'))
            return self._smart_next(message, state, _('No task is running right now, so there is nothing '
                                                      'to switch from.'), ['mytasks'])
        return False
