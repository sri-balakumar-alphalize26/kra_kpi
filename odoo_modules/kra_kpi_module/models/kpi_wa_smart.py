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
  a task number or a command word on its own (those are never chat); client
  groups stay silent at idle exactly as before.
* One clear match only. Two matches ask "Which one?"; anything that changes
  the day (lunch, break, start / end / pause day, back to work) asks ✅ Yes /
  ❌ No first.
"""

import logging
import re

from odoo import _, api, models

from .kpi_wa_group_intake import _TYPE_BY_ID, _smart_rows, _strip_emoji, _words
from .kpi_wa_staff_menu import BACK_LABEL, HOME_LABEL, STAFF_BY_ID, _actions_for
from .kpi_wa_staff_task import HOME, MEDIA_TYPES, PAUSE_STORED
from .kpi_workflow import REF_PREFIX_FOR_DOC_TYPE

_logger = logging.getLogger(__name__)

# Longer than this is somebody talking, not somebody picking.
SMART_MAX_WORDS = 6

# Steps whose typed text IS the answer. Smart typing never touches them.
STAFF_FREE_TEXT = ('collect', 'branch', 'dupfile', 'entry_text', 'entry_file', 'entry_link', 'time',
                   'pause_note', 'meet_who', 'meet_note', 'resume_reason', 'mt_search', 'switch_search')

# Client pickers that get a "didn't catch that" hint. Free-text and confirm
# steps are left alone.
CLIENT_PICK_STEPS = ('pick_type', 'pick_server', 'pick_db', 'pick_area', 'pick_install', 'pick_hour',
                     'pick_slot', 'pick_tz', 'myreq_pick', 'livedb_server', 'livedb_db',
                     'pick_disc_db', 'pick_disc_reason')

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
    ('pause', ('pause', 'pause task')),
    ('switch', ('switch', 'switch task')),
    ('doubt', ('doubt', 'clarification')),
    ('meeting', ('meeting',)),
    ('newtask', ('new task', 'create task', 'create my own task', 'add task')),
]
STAFF_COMMAND_BY_TEXT = {t: code for code, texts in STAFF_COMMANDS for t in texts}

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
        res = super().handle(message)
        if res:
            return res
        try:
            return self._client_smart(message)
        except Exception as exc:
            _logger.warning('smart typing (client) failed: %s', exc)
            return False

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
        res = super()._handle_staff(message, state, group)
        # Only on the inner call, which carries the person's poll context
        # (_handle_staff calls itself once with it, for staff only).
        if res or not self.env.context.get('kpi_wa_state_id'):
            return res
        try:
            return self._staff_smart(message, state, group)
        except Exception as exc:
            _logger.warning('smart typing (staff) failed: %s', exc)
            return False

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
        rows = self._smart_menu_rows(state, user, d) if in_menu else []
        hits = _smart_rows(body, rows)
        if len(hits) == 1:
            return self._smart_tap(message, state, user, hits[0][1])
        if len(hits) > 1:
            return self._smart_repoll(message, state, user, d, rows, _('🤔 Which one — %s?') % _(' or ').join(
                '*%s*' % _strip_emoji(l) for _c, l in hits))

        # 2. A task number.
        done = self._smart_task_ref(message, state, user, body)
        if done is not None:
            return done

        # 3. A command, from anywhere.
        cmd = STAFF_COMMAND_BY_TEXT.get(' '.join(_words(body)))
        if cmd:
            return self._smart_cmd(message, state, user, cmd)

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
                state._reset()
                self._text(message, _('Your day is paused — resume it first.'))
                return True
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
