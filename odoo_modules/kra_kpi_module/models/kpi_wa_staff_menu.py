"""The developer's menu, in the internal group.

WHY THE INTERNAL GROUP AND NOT A PRIVATE MESSAGE
-------------------------------------------------
Approvals go to the manager privately, because a decision is nobody else's
business. Everything a developer does is the opposite: the team should see
who picked up what, who is stuck, and who is waiting on an answer. So the
whole developer side lives in one group, and the bot never sends a developer
a private message at all.

That is also the only thing that works today: the numbers we hold for staff
came from the WhatsApp group member list, and a group is where they already
are.

HOW IT SITS BESIDE THE CLIENT FLOW
----------------------------------
This is a separate router branch, reached before the client step chain and
before the step sanitiser. The client flow -- _show_types, _create_ticket and
the whole pick_type -> ask_text -> confirm chain -- is untouched. A staff
group has no Client set, and _welcome_header and _live_dbs both dereference
group.kra_id, so letting a client-less group into that chain would not just
be wrong, it would raise.

ACTIONS CALL THE REAL METHODS
-----------------------------
Take / pause / complete go through start_task, pause_task and complete_task,
not through writes. Every guard therefore still applies -- the workday must
be open, the client must have approved, one task at a time unless multitask
is allowed -- and the developer gets the existing, carefully worded refusal
rather than a second set of rules that can drift out of step with the first.
"""

import logging

from odoo import _, api, fields, models

_logger = logging.getLogger(__name__)

# The top menu. "My tasks" leads the list because picking the task first and
# then being shown what can be done to it is one tap shorter than choosing a
# verb and then hunting for the task -- and it is the only way the options
# can be state-aware. A task that is running cannot be started and a task
# that has not started cannot be paused; offering both and refusing one
# afterwards is a worse conversation than only offering what is possible.
#
# The workday rows are first and are shown CONDITIONALLY: no task can be
# started until the day is open, so "Start my day" has to be reachable from
# here or the whole menu is a dead end that answers every tap with "start
# your workday first". Only the one that applies is offered, because
# "Start my day" on an already-open day is a question with no good answer.
STAFF_DAY_START = ('day_start', '🌅 Start my day')
STAFF_DAY_END = ('day_end', '🌙 End my day')

# Time that is not a task, recorded rather than left as unexplained idle.
# These are the SAME three reasons the board uses (kpi_nontask_block
# NONTASK_REASONS) and they go through the same _set_nontask_reason, so the
# Workday Map reads identically whether somebody tapped here or there.
STAFF_BREAK_ROWS = [
    ('nt_break', '☕ On a break'),
    ('nt_lunch', '🍽️ Lunch'),
]
# Freeze / unfreeze the whole workday (kpi.work.session.action_pause_workday),
# and "I have no tasks" (the board's no_tasks reason -- admins are told).
STAFF_CREATE_LABEL = '➕ Create my own task'
BACK_LABEL = '↩️ Back'
HOME_LABEL = '🏠 Main menu'
STAFF_DAY_PAUSE = ('day_pause', '⏸️ Pause my day')
STAFF_PAUSE_MENU = ('pause_menu', '⏸️ Pause')
STAFF_DAY_RESUME = ('day_resume', '▶️ Resume my day')
STAFF_NO_TASKS = ('no_tasks', '🙅 No tasks to work on')
# "In a meeting" now lives under 📅 Meeting (with a developer / team meeting).
# Kept addressable so a poll sent before this change still resolves.
STAFF_NT_MEETING = ('nt_meeting', '👥 In a meeting')
STAFF_BACK = ('nt_end', '🔙 Back to work')
# Offered only while a room is actually open, so there is a way to finish a
# meeting from the same place it was started. Without it the only end was the
# quiet-close cron ten minutes later, and nobody was told anything.
STAFF_MEET_END = ('meet_end', '🏁 Finish the meeting')
NONTASK_BY_ID = {'nt_break': 'break', 'nt_lunch': 'lunch',
                 'nt_meeting': 'meeting'}

# TEN is the ceiling, not twelve: Evolution refuses an 11-row poll outright
# and whatsapp.session then falls back to a numbered text list, so a menu
# that grows past ten does not lose its last rows -- it stops being tappable.
# This list plus the conditional workday and break rows must stay under it.
#
# Take / Pause / Resume / Completed are deliberately NOT here. They were, and
# they were pure duplication: "My tasks" offers exactly those verbs against a
# chosen task, and only the ones that task can actually do. Keeping both cost
# four rows, pushed the menu to twelve, and gave the same verb two routes --
# one state-aware and one not.
MAX_MENU_ROWS = 10

STAFF_ROWS = [
    ('mytasks', '📋 My tasks — take, pause, finish'),
    # Sent to the person's own number, not the group: what they are doing
    # right now, as the KPI Actions live strip shows it.
    ('status', '📍 Current status'),
    ('doubt', '❓ Doubt / clarification'),
    # ONE row; the next poll asks with whom (kpi_wa_staff_task._meeting_menu).
    ('meeting', '📅 Meeting'),
]
STAFF_BY_ID = dict(STAFF_ROWS + [STAFF_DAY_START, STAFF_DAY_END, STAFF_BACK,
                                 STAFF_MEET_END, STAFF_NT_MEETING, STAFF_DAY_PAUSE, STAFF_PAUSE_MENU,
                                 STAFF_DAY_RESUME, STAFF_NO_TASKS] + STAFF_BREAK_ROWS
                   + [('meet_admin', '📅 Meeting with manager'),
                      ('meet_client', '📅 Meeting with client')])

# What can be done to a task, given where it is. Everything here is a tap.
# 'in_progress' is the only state that can be paused; 'paused' and 'hold' are
# the only ones that can be resumed. These mirror the real guards in
# kpi_workflow._start_block rather than restating them, so the menu and the
# method cannot disagree.
ACTIONS_RUNNING = [('pause', '⏸️ Pause'), ('done', '✅ Completed')]
ACTIONS_PAUSED = [('resume', '▶️ Resume'), ('done', '✅ Completed')]
ACTIONS_FRESH = [('take', '▶️ Take it')]
ACTIONS_ALWAYS = [('doubt', '❓ Doubt / clarification'),
                  ('meet_admin', '📅 Meeting with manager'),
                  ('meet_client', '📅 Meeting with client')]

# The task-details page, row for row (kpi_wa_staff_task.py does the work).
# Updates, files, manuals and GitHub links only once the task has STARTED --
# the same has_started rule /kpi_action/details hands the board, so nothing is
# offered here that the details page would hide.
ACT_UPDATE = ('update', '📝 Add update')
ACT_MINE = ('mine', '🗂️ My updates & files')
ACT_MANUAL = ('manual', '📘 Add user manual')
ACT_INFO = ('info', 'ℹ️ Task details')
ACT_TIME = ('time', '⏱️ Ask for more time')
STARTED_STATES = ('in_progress', 'paused', 'partially_completed',
                  'awaiting_client', 'completed')
# add_time refuses these: the estimate is what the client signed off against.
ESTIMATE_LOCKED_STATES = ('awaiting_client', 'completed')


ACT_KPI = ('kpi', '📋 KPI details')


def _kpi_actions_for(task):
    """What the 📋 KPI details poll offers, after the details are shown:
    Completed, Get a file, Logs.

    Add update, My updates & files and Add user manual are no longer offered:
    the task page link sent with the details does all three (with files kept on
    a mistake and an upload percentage). Their handlers stay, so a poll sent
    before this change still works when tapped."""
    state = task.task_state
    rows = []
    if state in ('in_progress', 'paused', 'hold', 'rework'):
        rows.append(('done', '✅ Completed'))
    env = task.env
    # The manager's answers, once anything has been asked on the task.
    asked = env['kpi.doubt'].sudo().search_count([('kpi_id', '=', task.id), ('kind', '!=', 'client_msg')])
    if asked:
        rows.append(('answers', '💬 Manager answers (%d)' % asked))
    # Get a file only when the task has one; Logs always.
    has_file = (env['kpi.progress'].sudo().search_count([('kpi_id', '=', task.id), ('file_name', '!=', False)])
                or env['kpi.user.manual'].sudo().search_count([('kpi_id', '=', task.id)]))
    if has_file:
        rows.append(('getfile', '📎 Get a file'))
    # 💬 Discuss (kpi_chat.py): reply to the client, or write first -- only
    # when the client has a WhatsApp group the message can go to.
    if env['kpi.wa.group.report'].sudo()._group_for_kpi(task):
        waiting = task.chat_waiting()
        rows.insert(0, ('client_reply', '💬 Reply to client (%d waiting)' % waiting) if waiting
                    else ('client_reply', '💬 Message the client'))
    rows.append(('logs', '🧾 Logs'))
    return rows


ACT_SWITCH = ('switch', '🔀 Switch to this task')
ACT_SWITCH_FROM = ('switchfrom', '🔀 Switch to another task')


def _switch_targets(task, user):
    """The person's other tasks that a switch could move to: not running and
    not finished. Whether each can really start is decided by switch_to_task,
    which refuses before pausing anything."""
    return task.env['kra.kpi'].sudo().search([
        ('user_id', '=', user.id), ('active', '=', True), ('id', '!=', task.id),
        ('task_state', 'not in', ('in_progress', 'partially_completed', 'awaiting_client', 'completed')),
    ], order='write_date desc', limit=7)
ACT_UNDO = ('undo', '↩️ Undo start')


def _time_offered(task):
    """The web's canAddTime (web/components/task/actions.js): only on a running
    or paused task, and only once 80% of the estimate is used -- or at once
    when there is no estimate. The live running time counts."""
    if task.task_state not in ('in_progress', 'paused'):
        return False
    # A RUNNING task can always ask for more time (asked for on WhatsApp);
    # a paused one keeps the web's 80% rule.
    if task.task_state == 'in_progress':
        return True
    est = (task.estimate_hours or 0) * 3600 + (task.estimate_minutes or 0) * 60
    if not est:
        return True
    spent = task.timer_total_seconds or 0
    if task.task_state == 'in_progress' and task.timer_start_datetime:
        spent += max(0, (fields.Datetime.now() - task.timer_start_datetime).total_seconds())
    return spent >= est * 0.8


def _actions_for(task, user=None):
    """The verbs that make sense for this task, in the order they are used.

    Take / Pause / Resume, then 📋 KPI details (the details first, then
    Completed and the update rows inside it), more time and the meeting /
    doubt rows. Switch and Undo start appear only when they can be used right
    now, so a normal task menu stays short.
    """
    state = task.task_state
    # Workday paused: nothing can be started or resumed (the server refuses), but
    # the task can still be finished -- 📋 KPI details → ✅ Completed below.
    day_paused = bool(user) and bool(task.env['kpi.work.session'].sudo().search_count(
        [('user_id', '=', user.id), ('state', '=', 'open'), ('is_paused', '=', True)]))
    if day_paused:
        rows = []
        rows.append(ACT_KPI)
        if _time_offered(task):
            rows.append(ACT_TIME)
        return rows + list(ACTIONS_ALWAYS)
    if state == 'in_progress':
        rows = [ACTIONS_RUNNING[0]]          # Pause
        # The web's "Switch to…" lives on the RUNNING task: stop this one and
        # start / resume another, in one step (kra.kpi.switch_to_task).
        if user and _switch_targets(task, user):
            rows.append(ACT_SWITCH_FROM)
    elif state in ('paused', 'hold', 'rework'):
        rows = [ACTIONS_PAUSED[0]]           # Resume
    elif state in ('partially_completed', 'awaiting_client', 'completed'):
        rows = []                       # finished: details, files, logs only
    else:
        rows = list(ACTIONS_FRESH)
    if user and state != 'in_progress' and state not in ('partially_completed',) + ESTIMATE_LOCKED_STATES:
        # Another task is running: one tap to stop it and start this one.
        running = task.env['kpi.time.log'].sudo().search_count([
            ('user_id', '=', user.id), ('is_active', '=', True), ('kpi_id', '!=', task.id)])
        if running:
            rows.append(ACT_SWITCH)
    if user:
        try:
            Kpi = task.env['kra.kpi'].sudo()
            today = fields.Date.context_today(task.with_context(tz=user.tz or 'Asia/Kolkata'))
            if task._can_undo_start_cheap(user, today, Kpi._user_is_kpi_admin(user)):
                rows.append(ACT_UNDO)
        except Exception:
            pass
    rows.append(ACT_KPI)
    if _time_offered(task):
        rows.append(ACT_TIME)
    if user and user.kpi_allow_multitask:
        # Multitask: say which running task this would be -- "(2nd multi task)"
        # with one already going, "(3rd multi task)" with two. The tap is matched
        # against this same list rebuilt, so the label stays in step.
        others = task.env['kpi.time.log'].sudo().search([
            ('user_id', '=', user.id), ('is_active', '=', True), ('kpi_id', '!=', task.id)]).mapped('kpi_id')
        if others:
            nth = _ordinal(len(others) + 1)
            rows = [(c, '%s (%s multi task)' % (l, nth)) if c in ('take', 'resume') else (c, l)
                    for c, l in rows]
    return rows + list(ACTIONS_ALWAYS)


def _ordinal(n):
    """2 → '2nd', 3 → '3rd', 4 → '4th', 11 → '11th', 21 → '21st'."""
    if 10 <= n % 100 <= 20:
        return '%dth' % n
    return '%d%s' % (n, {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th'))

# How many of a person's tasks to offer at once. Ten leaves room inside the
# poll limit and is already more than anybody is working on.
MAX_TASK_ROWS = 10


class KpiWaStaffRouter(models.AbstractModel):
    _inherit = 'kpi.wa.group.router'

    # ------------------------------------------------------------------
    def _staff_member(self, state, group):
        """(user, allowed). Resolved by Odoo GROUP, never by member_kind.

        member_kind is per-group and admin-overridable -- on this very
        database the same person is 'client' in one group and 'developer' in
        another. It describes a seat in a chat, not an authority.
        """
        Member = self.env['kpi.wa.group.member'].sudo()
        key = state.participant_key or ''
        member = Member.search(
            ['|', ('lid', '=', key), ('phone', '=', key),
             ('group_id', '=', group.id)], limit=1)
        user = member.user_id
        if not user:
            user = self.env['res.users']._kpi_user_for_number(key)
        if not user:
            return self.env['res.users'], False
        allowed = (user.has_group('kra_kpi_module.group_kra_developer')
                   or user.has_group('kra_kpi_module.group_kra_admin')
                   or user.has_group('kra_kpi_module.group_kra_owner'))
        return user, allowed

    def _my_tasks(self, user, limit=MAX_TASK_ROWS):
        """What this person could act on, newest first. limit=None: all of
        them, for a list that pages (kpi_wa_staff_task._pick_list)."""
        return self.env['kra.kpi'].sudo().search([
            ('user_id', '=', user.id),
            ('active', '=', True),
            ('task_state', 'not in', ('completed', 'awaiting_client')),
        ], order='id desc', limit=limit)

    # ------------------------------------------------------------------
    def _handle_staff(self, message, state, group):
        """Everything that happens in the internal group."""
        if not self.env.context.get('kpi_wa_state_id'):
            # Every poll sent while handling this person names them and is
            # remembered as theirs (kpi.wa.group.router._poll reads these).
            who, ok = self._staff_member(state, group)
            if ok:
                return self.with_context(kpi_wa_state_id=state.id,
                                         kpi_wa_owner_name=who.name or '',
                                         kpi_wa_owner_mark=who._kpi_wa_color()[0])._handle_staff(
                    message, state, group)
        # 💬 A vote on a developer's "can you reply now?" poll (kpi_doubt
        # _ask_the_developer): only that task's developer counts.
        if message.message_type == 'poll_vote' and self.env['kpi.doubt']._dev_poll_vote(message, state, group, self):
            return True
        # Everybody in a group sees every poll. A vote on SOMEONE ELSE'S poll is
        # not acted on -- it would otherwise run as the voter's own choice.
        voted_on = (message.quoted_wa_message_id or '').strip() \
            if message.message_type == 'poll_vote' else ''
        if voted_on and voted_on not in (state.staff_poll_ids or '').split(','):
            owner = self.env['kpi.wa.group.intake'].sudo().search([
                ('group_id', '=', group.id), ('id', '!=', state.id),
                ('staff_poll_ids', 'ilike', voted_on)], limit=1)
            if owner:
                owner_user, _ok = self._staff_member(owner, group)
                voter, _ok2 = self._staff_member(state, group)
                self._text(message, _('%(voter)s, this menu is for %(owner)s — send *hi* for your own.') % {
                    'voter': voter.name or state.participant_name or _('Hi'),
                    'owner': owner_user.name or owner.participant_name or _('someone else')})
                return True
        body = (message.message or '').strip()
        low = body.lower()
        tapped = (message.interactive_reply_id or '').strip() or body

        user, allowed = self._staff_member(state, group)
        step = state.step if state.step in _STAFF_STEPS else 'idle'

        # cancel / exit leave the step in progress -- only for staff who ARE in
        # one. With nothing open it is chat, and "Stopped." would claim a task
        # was stopped when nothing was. "stop" on its own means "pause my
        # task" (kpi_wa_smart: ask first, then the reason); it only cancels
        # while they are typing into a step.
        typing = step == 'staff_text' or (step == 'staff_flow' and self._fd(state).get('at') in (
            'collect', 'branch', 'entry_text', 'time', 'pause_note', 'meet_note', 'resume_reason',
            'mt_search', 'switch_search', 'client_reply', 'lp_search'))
        if low in ('cancel', 'exit') or (low == 'stop' and typing):
            if step == 'idle' or not allowed:
                return False
            state._reset()
            self._text(message, _('Cancelled — nothing was changed.'))
            return True

        # NOT 'start'. In a client group "start" means "show me the menu"; to
        # a developer it means "start this task", and treating it as a
        # greeting threw them back to the top menu at the exact moment they
        # were trying to begin work.
        if low in ('hi', 'hello', 'hey', 'menu', 'help'):
            if not allowed:
                # Quiet. A public "you are not allowed" in front of the whole
                # team is the wrong reply to somebody simply saying hello.
                _logger.info('staff menu: %r is not staff', state.participant_key)
                return False
            return self._show_staff_menu(message, state, user)

        if step == 'idle':
            return False                      # ordinary team chatter

        if not allowed:
            return False

        if step == 'staff_menu':
            return self._staff_pick_action(message, state, user, tapped, low)
        if step == 'staff_pick_task':
            return self._staff_pick_task(message, state, user, tapped, low)
        if step == 'staff_task_actions':
            return self._staff_task_action(message, state, user, tapped, low)
        if step == 'staff_text':
            return self._staff_do_text(message, state, user, body)
        if step == 'staff_flow':
            return self._flow(message, state, user, tapped, low, body)
        return False

    # ------------------------------------------------------------------
    def _workday(self, user):
        """(session, is_open, ended_today) for this person, today."""
        Session = self.env['kpi.work.session'].sudo()
        today = fields.Date.context_today(self.env.user)
        openrow = Session.search([('user_id', '=', user.id),
                                  ('session_date', '=', today),
                                  ('state', '=', 'open')], limit=1)
        if openrow:
            return openrow, True, False
        # "Ended" means what the board means by it (_ended_session_today): a
        # day the developer ended themselves and nobody reopened. A REVERTED
        # (reopened by an admin) or auto-closed session does not end the day --
        # reading every closed row as ended told a reopened developer "your day
        # is finished" and hid Start my day from their menu.
        from .kpi_wa_staff_task import kpi_tz_name
        ended = Session.with_context(tz=kpi_tz_name(self.env, user))._ended_session_today(user=user)
        if ended:
            return ended, False, True
        closed = Session.search([('user_id', '=', user.id),
                                 ('session_date', '=', today),
                                 ('state', '=', 'closed')], limit=1)
        return closed, False, False

    def _live_meeting(self, user):
        """A room this person is in, open right now. Newest first.

        Organiser OR attendee: a developer who asked for the word should be
        able to finish it too, not only the manager who started it.
        """
        return self.env['kpi.meeting'].sudo().search([
            ('state', 'in', ('live', 'confirmed')),
            '|', ('organizer_id', '=', user.id),
            ('attendee_user_ids', 'in', user.id),
        ], order='id desc', limit=1)

    def _staff_finish_meeting(self, message, state, user):
        meeting = self._live_meeting(user)
        if not meeting:
            state._reset()
            self._text(message, _('You are not in a meeting right now.'))
            return True
        try:
            meeting.close_meeting(closed_by=user)
        except Exception as exc:
            state._reset()
            self._text(message, _('Could not close it: %s')
                       % str(exc).strip()[:200])
            return True
        state._reset()
        # The recap itself is posted by close_meeting into the right group;
        # no second copy here, or the group gets the same thing twice.
        return True

    def _staff_rows_for(self, user):
        """The menu this person should see right now.

        Built from the state of their day rather than fixed, so nothing is
        ever offered that would only be refused.

        The longest version is TEN rows, with nothing running: Finish the
        meeting, the four STAFF_ROWS, On a break, Lunch, No tasks, Pause my day
        and End my day. With a task running those four give way to one Pause;
        on a break, to one Back to work. Ten is the
        ceiling Evolution allows -- past it the menu silently turns back into
        text.
        """
        sess, is_open, ended = self._workday(user)
        live = self._live_meeting(user)
        rows = []
        if not is_open and not ended:
            rows.append(STAFF_DAY_START)
            if live:
                rows.append(STAFF_MEET_END)
            return rows + list(STAFF_ROWS)
        if ended:
            return ([STAFF_MEET_END] if live else []) + list(STAFF_ROWS)

        if sess and sess.is_paused:
            # The whole day is frozen: the only sensible moves are to unfreeze
            # it or end it. Starting a task would be refused anyway.
            # My tasks stays: a task can still be FINISHED on a paused day (the
            # web allows it -- finishing is not starting work); _actions_for hides
            # Take / Resume there, which the server would refuse.
            rows = [STAFF_DAY_RESUME] + ([STAFF_MEET_END] if live else [])
            return rows + [r for r in STAFF_ROWS if r[0] in ('mytasks', 'status', 'doubt')] + [STAFF_DAY_END]
        on_break = bool(sess and sess.nontask_reason)
        if live:
            rows.append(STAFF_MEET_END)
        if on_break:
            # One way out, so the running block is always closed explicitly
            # rather than left to be guessed at from the next thing they do.
            rows.append(STAFF_BACK)
        rows += list(STAFF_ROWS)
        if not on_break:
            running = self.env['kpi.time.log'].sudo().search_count(
                [('user_id', '=', user.id), ('is_active', '=', True)])
            if running:
                # Like the web: Pause only while a task runs. Break, Lunch,
                # Meeting and Pause my whole day live under that ONE row.
                rows.append(STAFF_PAUSE_MENU)
            else:
                # Nothing running: the web's "not on a task" buttons instead --
                # break / lunch recorded as non-task time (📅 Meeting is already
                # a row above), "I have no tasks", and pausing the whole day.
                # On a break FROM a task, one tap back to it replaces "On a
                # break" (they are on it already; keeps the poll within ten).
                back_to = self._break_source_task(user)
                if back_to:
                    rows += [('brk_resume', _('▶️ Back to %s') % self._ref(back_to)), STAFF_BREAK_ROWS[1]]
                else:
                    rows += list(STAFF_BREAK_ROWS)
                rows += [STAFF_NO_TASKS, STAFF_DAY_PAUSE]
        # Last: ending the day is the final thing you do, after Pause.
        rows.append(STAFF_DAY_END)
        if len(rows) > MAX_MENU_ROWS:
            # Should be unreachable by construction; logged rather than
            # silently sliced, because the symptom of overflowing is a menu
            # that stops being tappable and nobody would connect the two.
            _logger.warning(
                'staff menu built %d rows, over the %d Evolution allows -- '
                'the poll will be refused and arrive as text.',
                len(rows), MAX_MENU_ROWS)
        return rows[:MAX_MENU_ROWS]

    def _show_staff_menu(self, message, state, user):
        tasks = self._my_tasks(user)
        _sess, is_open, ended = self._workday(user)
        sess, _o, _e = self._workday(user)
        if is_open and sess and sess.nontask_reason:
            day = _('You are on %s.') % dict(
                sess._fields['nontask_reason'].selection or []).get(
                    sess.nontask_reason, sess.nontask_reason)
        else:
            day = (_('Your day is open.') if is_open
                   else _('Your day is finished.') if ended
                   else _('Your day has not started.'))
        header = _('Hello %(who)s. %(day)s You have %(n)s task(s) open.') % {
            'who': user.name or '', 'day': day, 'n': len(tasks)}
        rows = self._staff_rows_for(user)
        state._touch(step='staff_menu', staff_action=False,
                     staff_kpi_id=False,
                     menu_csv=','.join(c for c, _l in rows))
        self._poll(message, header, [l for _c, l in rows])
        return True

    # ------------------------------------------------------------------
    def _staff_day_start(self, message, state, user):
        """Open the workday. One start and one end per day is the model's rule.

        _get_or_open_today returns a CLOSED session rather than opening a
        second one when the day was explicitly ended -- its docstring says
        callers must read that as "refuse to start" -- so that is checked
        rather than assumed from the return being truthy.
        """
        Session = self.env['kpi.work.session'].sudo()
        try:
            sess = Session.with_user(user).sudo()._get_or_open_today(user=user)
        except Exception as exc:
            state._reset()
            self._text(message, _('Could not start your day: %s')
                       % str(exc).strip()[:200])
            return True
        if sess and sess.state == 'closed':
            state._reset()
            self._text(message, _(
                '%s, you already ended your day. A day is started once and '
                'ended once; an admin can reopen it if that was a mistake.')
                % (user.name or ''))
            return True

        # Straight on to the work. Telling somebody "send hi again" after they
        # have just tapped a button is an extra step for no reason -- they
        # opened their day in order to start something.
        self._text(message, _('🌅 Your day is open, %s.') % (user.name or ''))
        tasks = self._my_tasks(user)
        if not tasks:
            state._reset()
            self._text(message, _(
                'Nothing is assigned to you yet. A manager puts work on you '
                'after approving it, and it will be announced here.'))
            return True
        state._touch(staff_action='mytasks')
        return self._staff_offer_tasks(message, state, user, 'mytasks')

    def _staff_nontask(self, message, state, user, choice):
        """Break, lunch or meeting -- the same three the board records.

        Goes through kpi.work.session._set_nontask_reason, which is where
        every rule about switching and idempotence already lives: tapping
        Lunch while on a Break closes one and opens the other at the same
        instant, so the Workday Map has no gap and no overlap. Re-tapping the
        same one keeps the original start rather than restarting the clock.

        Starting a task closes the block by itself (start_task does it), so
        there is no way to be on a break and working at once.
        """
        reason = NONTASK_BY_ID.get(choice)
        _sess, is_open, _ended = self._workday(user)
        if not is_open:
            state._reset()
            self._text(message, _('Start your day first.'))
            return True
        if reason == 'meeting':
            # Who it is with and what it is about, like the board's
            # "In a meeting" picker. Recorded once both are known.
            return self._meet_begin(message, state, user, purpose='nontask')
        # A task's break still open: split it rather than open a block on top.
        switched = self._switch_open_break(message, state, user, reason)
        if switched is not None:
            return switched
        Session = self.env['kpi.work.session'].sudo()
        try:
            sess = Session.with_user(user).sudo()._get_or_open_today(user=user)
            sess.with_user(user).sudo()._set_nontask_reason(reason, note='')
        except Exception as exc:
            state._reset()
            self._text(message, _('Could not record that: %s')
                       % str(exc).strip()[:200])
            return True
        state._reset()
        self._text(message, {
            'nt_break': _('☕ Break noted. Tap *Back to work* when you are in.'),
            'nt_lunch': _('🍽️ Lunch noted. Tap *Back to work* when you are in.'),
            'nt_meeting': _('👥 Meeting noted. Tap *Back to work* afterwards.'),
        }.get(choice, _('Noted.')))
        return True

    def _staff_nontask_end(self, message, state, user):
        """Close the open break/meeting block without starting a task."""
        Session = self.env['kpi.work.session'].sudo()
        try:
            sess = Session.with_user(user).sudo()._get_or_open_today(user=user)
            closed = sess.with_user(user).sudo()._close_nontask_block()
        except Exception as exc:
            state._reset()
            self._text(message, _('Could not close that: %s')
                       % str(exc).strip()[:200])
            return True
        state._reset()
        if not closed:
            self._text(message, _('Nothing was running.'))
            return True
        # Back to work means back to a task, so offer them.
        self._text(message, _('🔙 Welcome back, %s.') % (user.name or ''))
        if self._my_tasks(user):
            state._touch(staff_action='mytasks')
            return self._staff_offer_tasks(message, state, user, 'mytasks')
        return True

    def _staff_day_end(self, message, state, user):
        """Ask for the day's note, then close. The note is the point."""
        _sess, is_open, ended = self._workday(user)
        if ended:
            state._reset()
            self._text(message, _('Your day is already finished.'))
            return True
        if not is_open:
            state._reset()
            self._text(message, _('Your day has not started yet.'))
            return True
        # The End Workday page (controllers/kpi_wa_endday.py): a summary for each
        # task worked today is REQUIRED there, then the day ends -- the same rule
        # as the web, the Odoo board and the app.
        return self._send_endday_link(message, state, user)

    def _break_source_task(self, user):
        """The paused task an open break came from (the web's break-pill
        Resume), or an empty recordset."""
        brk = self.env['kpi.break.log'].sudo().search(
            [('user_id', '=', user.id), ('is_active', '=', True)], limit=1)
        task = brk.source_task_id
        return task if task and task.exists() and task.task_state == 'paused' else self.env['kra.kpi']

    def _staff_pick_action(self, message, state, user, tapped, low):
        # Matched against what was OFFERED, not the full table: the workday
        # rows appear only when they apply, so position 1 is not always the
        # same thing.
        rows = self._staff_rows_for(user)
        offered = [c for c in (state.menu_csv or '').split(',') if c]
        if offered:
            # Labels from the menu as it is now first: some carry a task ref
            # (▶️ Back to REQ-002), which the fixed table cannot know.
            current = dict(rows)
            rows = [(c, current.get(c) or STAFF_BY_ID.get(c, c)) for c in offered]
        choice = None
        clean = _strip_emoji(tapped).strip().lower()
        for code, label in rows:
            if _strip_emoji(label).strip().lower() == clean:
                choice = code
                break
        if not choice:
            by_number = {str(i + 1): c for i, (c, _l) in enumerate(rows)}
            choice = by_number.get(low.strip())
        if not choice:
            return False
        return self._staff_run_code(message, state, user, choice)

    def _staff_run_code(self, message, state, user, choice):
        """Run one main-menu row by its code -- tapped, or typed (kpi_wa_smart)."""
        if choice == 'day_start':
            return self._staff_day_start(message, state, user)
        if choice == 'day_end':
            return self._staff_day_end(message, state, user)
        if choice in NONTASK_BY_ID:
            return self._staff_nontask(message, state, user, choice)
        if choice == 'nt_end':
            return self._staff_nontask_end(message, state, user)
        if choice == 'meet_end':
            return self._staff_finish_meeting(message, state, user)
        if choice == 'status':
            return self._staff_status(message, state, user)
        if choice == 'meeting':
            return self._meeting_menu(message, state, user)
        if choice == 'pause_menu':
            return self._pause_menu(message, state, user)
        if choice == 'brk_resume':
            back_to = self._break_source_task(user)
            if not back_to:
                state._reset()
                self._text(message, _('That break has already ended.'))
                return self._show_staff_menu(message, state, user)
            # Through _staff_begin, so a sent-back task still asks what changed.
            # resume_task closes the break by itself.
            return self._staff_begin(message, state, user, back_to, 'resume')
        if choice in ('day_pause', 'day_resume', 'no_tasks'):
            return self._staff_day_control(message, state, user, choice)

        # 'mytasks' is not a verb: pick the task, then be shown what can be
        # done to it. It used to print a plain text list, which is the one
        # place in the whole bot that answered a tap with something you
        # cannot tap back.
        state._touch(staff_action=choice)
        return self._staff_offer_tasks(message, state, user, choice)

    def _staff_offer_tasks(self, message, state, user, action):
        if action == 'mytasks':
            # The web board: PLAN / DO / CHECK → lane → task (kpi_wa_staff_task).
            return self._mytasks_begin(message, state, user)
        tasks = self._my_tasks(user, limit=None)
        if not tasks:
            state._reset()
            self._text(message, _(
                'Nothing is assigned to you, so there is nothing to do that '
                'to. A manager assigns work after approving it.'))
            return True

        # ONE task: do not ask which. A WhatsApp poll needs at least two
        # options -- Evolution refuses a single-option poll, _poll falls back
        # to a numbered TEXT list, and the developer is left reading
        # "1 - REQ-002 ..." with nothing to tap. Which is also the wrong
        # question: there is only one answer.
        if len(tasks) == 1:
            only = tasks[0]
            state._touch(staff_kpi_id=only.id)
            return self._staff_begin(message, state, user, only, action)

        # The reference leads every label: a poll vote carries only the
        # visible text, so "Printer not working" alone could not say which
        # task was meant if two had similar names. The state is shown too,
        # so a developer can see what is running before they pick.
        # Paged, with 🔍 Search and ↩️ Back: a poll holds 10 rows, and a
        # developer with more open tasks than that could not reach the rest.
        return self._pick_list(message, state, user, {'kind': 'task', 'ctx': action,
                                                      'all': tasks.ids})

    def _staff_pick_task(self, message, state, user, tapped, low):
        ids = [int(i) for i in (state.menu_csv or '').split(',')
               if i.strip().isdigit()]
        tasks = self.env['kra.kpi'].sudo().browse(ids).exists()
        picked = self.env['kra.kpi']
        text = _strip_emoji(tapped).strip().lower()
        for t in tasks:
            ref = (t.external_ref or ('#%s' % t.id)).lower()
            if ref and ref in text:
                picked = t
                break
        if not picked:
            n = low.strip()
            if n.isdigit() and 1 <= int(n) <= len(tasks):
                picked = tasks[int(n) - 1]
        if not picked:
            return False

        action = state.staff_action
        state._touch(staff_kpi_id=picked.id)

        # Came in through "My tasks": show what can be done to THIS one.
        if action == 'mytasks':
            return self._staff_offer_actions(message, state, picked)
        return self._staff_begin(message, state, user, picked, action)

    def _staff_offer_actions(self, message, state, task):
        user, _allowed = self._staff_member(state, state.group_id)
        rows = _actions_for(task, user or None)
        ref = task.external_ref or ('#%s' % task.id)
        labels = dict(task._fields['task_state'].selection)
        if not rows:
            state._reset()
            self._text(message, _(
                '%(ref)s is %(state)s — nothing for you to do on it right '
                'now.') % {'ref': ref,
                           'state': labels.get(task.task_state, '')})
            return True
        # ↩️ Back returns to where the task was picked: its lane (PLAN / DO /
        # CHECK) when it came from 📋 My tasks, otherwise the main menu. The
        # target rides in menu_csv so it survives the sub-flows in between.
        back_to = next((t[5:] for t in (state.menu_csv or '').split(',')
                        if t.startswith('back@')), '')
        if (state.staff_action or '').startswith('mt:'):
            back_to = state.staff_action
        rows = rows + [('back', BACK_LABEL), ('home', HOME_LABEL)]
        state._touch(step='staff_task_actions', staff_kpi_id=task.id,
                     staff_draft=False,
                     menu_csv=','.join([c for c, _l in rows]
                                       + (['back@' + back_to] if back_to else [])))
        status = labels.get(task.task_state, '')
        if task.task_state == 'paused' and (task.paused_reason or '').strip():
            status += ' — %s' % task.paused_reason.strip()
        waiting = task.chat_waiting()
        if waiting:
            status += _('\n💬 %d client message(s) waiting — 📋 KPI details → 💬 Reply to client') % waiting
        self._poll(message, _('%(ref)s — %(title)s\n%(state)s') % {
            'ref': ref, 'title': task.name or '', 'state': status},
            [l for _c, l in rows])
        return True

    def _staff_task_action(self, message, state, user, tapped, low):
        """They picked a verb for the task already chosen."""
        task = state.staff_kpi_id
        if not task or not task.exists():
            state._reset()
            return False
        offered = [c for c in (state.menu_csv or '').split(',') if c]
        rows = [(c, l) for c, l in _actions_for(task, user) if c in offered]
        if 'back' in offered:
            rows.append(('back', BACK_LABEL))
        if 'home' in offered:
            rows.append(('home', HOME_LABEL))
        clean = _strip_emoji(tapped).strip().lower()
        choice = None
        for code, label in rows:
            if _strip_emoji(label).strip().lower() == clean:
                choice = code
                break
        if not choice:
            n = low.strip()
            if n.isdigit() and 1 <= int(n) <= len(rows):
                choice = rows[int(n) - 1][0]
        if not choice:
            return False
        if choice == 'home':
            state._reset()
            return self._show_staff_menu(message, state, user)
        if choice == 'back':
            back_to = next((t[5:] for t in offered if t.startswith('back@')), '')
            if back_to.startswith('mt:') and back_to.count(':') == 2:
                _mt, phase, lane = back_to.split(':')
                if phase in ('None', ''):         # opened from a top-level search
                    return self._mytasks_begin(message, state, user)
                return self._mt_tasks(message, state, user, phase, lane, 0)
            state._reset()
            return self._show_staff_menu(message, state, user)
        state._touch(staff_action=choice)
        return self._staff_begin(message, state, user, task, choice)

    def _staff_begin(self, message, state, user, task, action):
        """One place every verb goes through, however it was reached."""
        # Every flow below reads the task back from the state on the next
        # message, so it is pinned here rather than trusted to each caller.
        state._touch(staff_kpi_id=task.id)
        if action == 'take':
            # Guidelines first, like the board's Start dialog.
            if (task.guidelines or '').strip():
                return self._guidelines_begin(message, state, user, task)
            return self._staff_run(message, state, user, task, 'start')
        if action == 'resume':
            # A self-created task an admin sent back: say what changed first.
            if task.is_self_created and task.self_needs_resume_reason:
                return self._resume_reason_begin(message, state, user, task)
            return self._staff_run(message, state, user, task, 'resume')
        if action == 'switch':
            return self._switch_to(message, state, user, task)
        if action == 'switchfrom':
            return self._switch_from_begin(message, state, user, task)
        if action == 'undo':
            return self._undo_begin(message, state, user, task)
        # Completed asks for the summary and the checklist first, as the board
        # does; Pause asks for the reason type (and who, for a meeting).
        if action == 'done':
            return self._done_begin(message, state, user, task)
        if action == 'pause':
            return self._pause_begin(message, state, user, task)
        if action == 'update':
            return self._upd_begin(message, state, user, task, mode='progress')
        if action == 'manual':
            return self._upd_begin(message, state, user, task, mode='manual')
        if action == 'mine':
            return self._mine_begin(message, state, user, task)
        if action in ('info', 'kpi'):
            return self._kpi_details(message, state, user, task)
        if action == 'answers':
            return self._answers_show(message, state, user, task)
        if action == 'time':
            return self._time_begin(message, state, user, task)
        if action == 'getfile':
            return self._files_begin(message, state, user, task)
        if action == 'logs':
            return self._logs_begin(message, state, user, task)
        if action == 'client_reply':
            return self._client_reply_begin(message, state, user, task)
        # doubt / meet_admin / meet_client all want words next.
        state._touch(step='staff_text', staff_kpi_id=task.id)
        prompt = {
            'doubt': _('What is the question about %s?'),
            'meet_admin': _('What do you want to talk about on %s?'),
            'meet_client': _('What should the meeting with the client about '
                             '%s cover?'),
        }.get(action, _('Tell me about %s.'))
        self._text(message, prompt % (task.external_ref or task.id))
        return True

    # ------------------------------------------------------------------
    def _staff_run(self, message, state, user, kpi, verb, checklist=None,
                   partial=False):
        """Call the REAL workflow method, as the developer, and relay it.

        with_user(user).sudo(), in that order: with_user() returns an env with
        su=False, so sudo().with_user() would throw the sudo away and the
        write would fail on access rights. The acting user has to be the
        developer so the workday and single-task guards judge the right
        person.
        """
        ref = kpi.external_ref or ('#%s' % kpi.id)
        try:
            rec = kpi.with_user(user).sudo()
            if verb == 'start':
                rec.start_task()
                msg = _('▶️ %(who)s has taken %(ref)s.') % {
                    'who': user.name, 'ref': ref} + self._still_running(user, kpi)
            elif verb == 'resume':
                rec.resume_task()
                msg = _('▶️ %(who)s is back on %(ref)s.') % {
                    'who': user.name, 'ref': ref} + self._still_running(user, kpi)
            else:
                # The checklist the developer ticked, saved on the task for
                # the manager to review -- the same flags the board stores.
                rec.complete_task(employee_checklist=checklist or {})
                msg = (_('🏁 %(who)s finished %(ref)s as a partial finish — '
                         'sent for review with the summary.')
                       if partial else
                       _('✅ %(who)s finished %(ref)s. It is with a manager to '
                         'check.')) % {'who': user.name, 'ref': ref}
        except Exception as exc:
            # The existing guards already explain themselves properly --
            # "Start your workday before working on X" and the rest -- so the
            # message is relayed rather than replaced.
            state._reset()
            self._text(message, _('%(ref)s: %(why)s') % {
                'ref': ref, 'why': str(exc).strip()[:300]})
            self._menu_again(message, state, user)
            return True
        state._reset()
        self._text(message, msg)
        return True

    def _menu_again(self, message, state, user):
        """After a refused action, put the menu straight back.

        A refusal used to end the conversation: "Start your workday before
        working on REQ-002", and then nothing -- the person had to send "hi"
        again to get the poll that has "Start my day" on it, which is the
        very thing the warning told them to do. The menu follows the warning
        now. Never allowed to swallow the warning itself."""
        try:
            self._show_staff_menu(message, state, user)
        except Exception as exc:
            _logger.warning('staff menu: could not re-show the menu: %s', exc)

    def _staff_do_text(self, message, state, user, body):
        """A question or a meeting request. It goes to the manager, not out."""
        kpi = state.staff_kpi_id
        action = state.staff_action
        if not kpi or not kpi.exists() or not body.strip():
            state._reset()
            return False
        kind = {'doubt': 'question', 'meet_admin': 'meet_admin',
                'meet_client': 'meet_client'}.get(action, 'question')
        group = state.group_id
        try:
            self.env['kpi.doubt'].sudo().create({
                'kpi_id': kpi.id, 'kind': kind, 'question': body.strip(),
                'raised_by_id': user.id, 'raised_group_id': group.id,
            })
        except Exception as exc:
            _logger.exception('could not raise a doubt: %s', exc)
            state._reset()
            self._text(message, _('Sorry — I could not pass that on.'))
            return True
        state._reset()
        self._text(message, _(
            '📨 Passed to the manager for %(ref)s. Nothing has gone to the '
            'client; they will only see it if the manager sends it.') % {
                'ref': kpi.external_ref or kpi.id})
        return True


# Imported at the bottom so this module can be read top-down; _strip_emoji and
# the step list live with the router they belong to.
from .kpi_wa_group_intake import _strip_emoji          # noqa: E402

# staff_pause_reason / staff_day_note stay in the step Selection (intake.py) but
# nothing routes them any more: a state left on one reads as idle.
_STAFF_STEPS = ('idle', 'staff_menu', 'staff_pick_task',
                'staff_task_actions', 'staff_text', 'staff_flow')
