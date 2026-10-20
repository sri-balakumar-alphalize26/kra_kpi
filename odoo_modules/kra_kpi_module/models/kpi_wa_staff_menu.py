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
    ('nt_meeting', '👥 In a meeting'),
]
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
    ('meet_admin', '📅 Meeting with manager'),
    ('meet_client', '📅 Meeting with client'),
]
STAFF_BY_ID = dict(STAFF_ROWS + [STAFF_DAY_START, STAFF_DAY_END, STAFF_BACK,
                                 STAFF_MEET_END] + STAFF_BREAK_ROWS)

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


def _actions_for(task):
    """The verbs that make sense for this task, in the order they are used.

    At most TEN rows (the poll limit): a running or paused task is exactly
    ten -- Pause/Resume, Completed, the three update rows, details, more
    time and the three always-rows.
    """
    state = task.task_state
    if state == 'in_progress':
        rows = list(ACTIONS_RUNNING)
    elif state in ('paused', 'hold', 'rework'):
        rows = list(ACTIONS_PAUSED)
    elif state == 'partially_completed':
        rows = []                       # finished; waiting on a manager
    else:
        rows = list(ACTIONS_FRESH)
    if state in STARTED_STATES:
        rows += [ACT_UPDATE, ACT_MINE, ACT_MANUAL]
    elif task.env['kpi.progress'].sudo().search_count([('kpi_id', '=', task.id)]):
        # Rework / hold: nothing new until it is started again, but what was
        # already added can still be corrected -- the history is shown there.
        rows.append(ACT_MINE)
    rows.append(ACT_INFO)
    if state not in ESTIMATE_LOCKED_STATES:
        rows.append(ACT_TIME)
    return rows + list(ACTIONS_ALWAYS)

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

    def _my_tasks(self, user):
        """What this person could act on, newest first."""
        return self.env['kra.kpi'].sudo().search([
            ('user_id', '=', user.id),
            ('active', '=', True),
            ('task_state', 'not in', ('completed', 'awaiting_client')),
        ], order='id desc', limit=MAX_TASK_ROWS)

    # ------------------------------------------------------------------
    def _handle_staff(self, message, state, group):
        """Everything that happens in the internal group."""
        body = (message.message or '').strip()
        low = body.lower()
        tapped = (message.interactive_reply_id or '').strip() or body

        user, allowed = self._staff_member(state, group)
        step = state.step if state.step in _STAFF_STEPS else 'idle'

        if low in ('cancel', 'stop', 'exit'):
            state._reset()
            self._text(message, _('Stopped.'))
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
        if step == 'staff_pause_reason':
            return self._staff_do_pause(message, state, user, body)
        if step == 'staff_text':
            return self._staff_do_text(message, state, user, body)
        if step == 'staff_day_note':
            return self._staff_do_day_end(message, state, user, body)
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

        The longest version is TEN rows: End my day, Finish the meeting, the
        five STAFF_ROWS and the three break rows. On a break it is eight,
        because the break rows are replaced by one Back to work. Ten is the
        ceiling Evolution allows -- the next row added here needs one taken
        away, or the menu silently turns back into text.
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

        on_break = bool(sess and sess.nontask_reason)
        rows.append(STAFF_DAY_END)
        if live:
            rows.append(STAFF_MEET_END)
        if on_break:
            # One way out, so the running block is always closed explicitly
            # rather than left to be guessed at from the next thing they do.
            rows.append(STAFF_BACK)
        rows += list(STAFF_ROWS)
        if not on_break:
            rows += STAFF_BREAK_ROWS
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
        state._touch(step='staff_day_note')
        self._text(message, _(
            'What did you get done today? One or two lines — it goes in the '
            'daily summary.'))
        return True

    def _staff_do_day_end(self, message, state, user, body):
        sess, is_open, _ended = self._workday(user)
        if not is_open or not sess:
            state._reset()
            self._text(message, _('Your day is not open.'))
            return True
        try:
            sess.with_user(user).sudo().action_end_day(note=(body or '').strip())
        except Exception as exc:
            state._reset()
            self._text(message, _('Could not end your day: %s')
                       % str(exc).strip()[:200])
            return True
        state._reset()
        self._text(message, _('🌙 Day closed, %(who)s. Thanks.') % {
            'who': user.name or ''})
        return True

    def _staff_pick_action(self, message, state, user, tapped, low):
        # Matched against what was OFFERED, not the full table: the workday
        # rows appear only when they apply, so position 1 is not always the
        # same thing.
        rows = self._staff_rows_for(user)
        offered = [c for c in (state.menu_csv or '').split(',') if c]
        if offered:
            rows = [(c, STAFF_BY_ID.get(c, c)) for c in offered]
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

        # 'mytasks' is not a verb: pick the task, then be shown what can be
        # done to it. It used to print a plain text list, which is the one
        # place in the whole bot that answered a tap with something you
        # cannot tap back.
        state._touch(staff_action=choice)
        return self._staff_offer_tasks(message, state, user, choice)

    def _staff_offer_tasks(self, message, state, user, action):
        tasks = self._my_tasks(user)
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
            if action == 'mytasks':
                return self._staff_offer_actions(message, state, only)
            return self._staff_begin(message, state, user, only, action)

        # The reference leads every label: a poll vote carries only the
        # visible text, so "Printer not working" alone could not say which
        # task was meant if two had similar names. The state is shown too,
        # so a developer can see what is running before they pick.
        labels = dict(tasks._fields['task_state'].selection)
        opts = ['%s — %s · %s' % (t.external_ref or ('#%s' % t.id),
                                  (t.name or '')[:30],
                                  labels.get(t.task_state, t.task_state))
                for t in tasks]
        state._touch(step='staff_pick_task',
                     menu_csv=','.join(str(t.id) for t in tasks))
        header = (_('Your tasks — pick one')
                  if action == 'mytasks'
                  else _('Which one? (%s)') % STAFF_BY_ID.get(action, ''))
        self._poll(message, header, opts)
        return True

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
        rows = _actions_for(task)
        ref = task.external_ref or ('#%s' % task.id)
        labels = dict(task._fields['task_state'].selection)
        if not rows:
            state._reset()
            self._text(message, _(
                '%(ref)s is %(state)s — nothing for you to do on it right '
                'now.') % {'ref': ref,
                           'state': labels.get(task.task_state, '')})
            return True
        state._touch(step='staff_task_actions', staff_kpi_id=task.id,
                     staff_draft=False,
                     menu_csv=','.join(c for c, _l in rows))
        status = labels.get(task.task_state, '')
        if task.task_state == 'paused' and (task.paused_reason or '').strip():
            status += ' — %s' % task.paused_reason.strip()
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
        rows = [(c, l) for c, l in _actions_for(task) if c in offered]
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
        state._touch(staff_action=choice)
        return self._staff_begin(message, state, user, task, choice)

    def _staff_begin(self, message, state, user, task, action):
        """One place every verb goes through, however it was reached."""
        # Every flow below reads the task back from the state on the next
        # message, so it is pinned here rather than trusted to each caller.
        state._touch(staff_kpi_id=task.id)
        if action == 'take':
            return self._staff_run(message, state, user, task, 'start')
        if action == 'resume':
            return self._staff_run(message, state, user, task, 'resume')
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
        if action == 'info':
            return self._info_show(message, state, user, task)
        if action == 'time':
            return self._time_begin(message, state, user, task)
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
                    'who': user.name, 'ref': ref}
            elif verb == 'resume':
                rec.resume_task()
                msg = _('▶️ %(who)s is back on %(ref)s.') % {
                    'who': user.name, 'ref': ref}
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

    def _staff_do_pause(self, message, state, user, body):
        kpi = state.staff_kpi_id
        if not kpi or not kpi.exists():
            state._reset()
            return False
        ref = kpi.external_ref or ('#%s' % kpi.id)
        try:
            kpi.with_user(user).sudo().pause_task(
                reason=body or _('Paused from WhatsApp'))
        except Exception as exc:
            state._reset()
            self._text(message, _('%(ref)s: %(why)s') % {
                'ref': ref, 'why': str(exc).strip()[:300]})
            self._menu_again(message, state, user)
            return True
        state._reset()
        self._text(message, _('⏸️ %(ref)s paused — %(why)s') % {
            'ref': ref, 'why': body})
        return True

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

_STAFF_STEPS = ('idle', 'staff_menu', 'staff_pick_task',
                'staff_task_actions', 'staff_pause_reason', 'staff_text',
                'staff_day_note', 'staff_flow')
