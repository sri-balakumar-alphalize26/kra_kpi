"""Group intake: tappable pickers, one free-text line, AI tidy-up, confirm.

THE FLOW
--------
    "hi"              -> LIST: what do you need?        (4 rows)
    tap type          -> LIST: which area?              (7 rows)
    tap area          -> "describe it in one line"      <- the ONLY typing
    free text         -> AI corrects + classifies
                      -> BUTTONS: Create / Edit / Cancel (3, the WA maximum)
    tap Create        -> ticket in the admin queue

Interactive messages were verified renderable on this connection on
16 Oct 2026. They are still not trusted blindly: every step also accepts the
typed number, and whatsapp.session.send_list/send_buttons fall back to a
numbered text menu if the server refuses the interactive payload. A flow that
dead-ends because WhatsApp changed its mind about buttons is worse than an
ugly one.

MATCHING IS ON THE OPTION ID, NEVER THE LABEL
---------------------------------------------
A tap returns the `rowId`/`selectedButtonId` we set (e.g. 'bug'), which the
webhook stores in whatsapp.message.interactive_reply_id. Matching on that
rather than the visible text means re-wording or translating a menu cannot
break the flow.

STATE
-----
Keyed by (group, participant): several people can be mid-flow in the same
group at once, which the phone-keyed kpi.wa.conversation used for 1:1 chats
cannot represent.
"""

import logging
import secrets
from datetime import timedelta

from odoo import _, api, fields, models

from .kpi_ai import AREA_LABEL, WORK_AREAS, WORK_AREA_CODES

_logger = logging.getLogger(__name__)

GROUP_TTL_MINUTES = 15

# Interactive (tappable) menus are OFF because WhatsApp does not deliver them
# to an unofficial client -- see the long note on _list/_buttons below. Set to
# True only if this number is moved to the official WhatsApp Business API.
USE_INTERACTIVE = False

_GREETINGS = ('hi', 'hello', 'hey', 'menu', 'start', 'help')
_CANCELS = ('cancel', 'stop', 'exit', 'abort', 'quit')

# id -> (action_type, label, blurb)
#
# ORDER MATTERS for the typed-number fallback, but only within one
# conversation: the number map is built from the rows ACTUALLY OFFERED and
# stored on the state (`menu_csv`), because 'dbdisconnect' is hidden from
# clients who have no live database. A static index map would have made "3"
# mean different things to different groups.
_TYPE_ROWS = [
    ('requirement', '✨ New Requirement', 'Something new to build'),
    ('bug', '🐞 Report a Bug', 'Something is not working'),
    ('update', '🔧 Request an Update', 'Change something existing'),
    ('meeting', '📅 Request a Meeting', 'Call or Google Meet'),
    ('newdb', '🗄️ New Database', 'Set up a new DB for a shop'),
    # The id stays 'dbdisconnect': menu_csv and in-flight rows store it.
    ('dbdisconnect', '💥 Destroy a Database',
     'Remove a database you no longer need'),
    ('livedb', '📂 Live Databases', 'See your databases and their details'),
    ('myreq', '📋 My Requests', 'Where each of your requests is'),
    ('waiting', '✍️ Waiting for me', 'Approvals and sign-offs you need to give'),
]

# 📋 My Requests: what the client is told about each task state. Mirrors the
# web portal's wording (web/components/portal/PortalRequests.jsx). Never the
# developer -- see _client_status.
_CLIENT_STATUS = {
    'pre_approval_pending': '✍️ Waiting for your approval',
    'pre_approval_partial': '✍️ Waiting for your approval',
    'pre_approval_approved': '⏳ Not started yet',
    'assigned': '⏳ Not started yet', 'urgent': '⏳ Not started yet',
    'important': '⏳ Not started yet', 'regular': '⏳ Not started yet',
    'queue_waiting': '⏳ Not started yet',
    'in_progress': '🔨 Being worked on', 'paused': '🔨 Being worked on',
    'hold': '🔨 Being worked on', 'rework': '🔨 Being worked on',
    'partially_completed': '🔍 Being checked',
    'awaiting_client': '✍️ Your sign-off needed',
    'completed': '✅ Done',
}
_MYREQ_PAGE_ROWS = 8

# Types answered with a private one-use form link (/kpi/wa/client/<token>,
# controllers/kpi_wa_client_form.py) instead of the poll conversation.
_FORM_TYPES = ('requirement', 'bug', 'update', 'newdb', 'dbdisconnect')
CLIENT_FORM_TTL_MINUTES = 30
_LIVEDB_PAGE_ROWS = 8
_LIVEDB_MORE_ID = '__more__'
_LIVEDB_BACK_ID = '__back__'

# The types that ask WHICH DATABASE the work is about before anything else.
# A new database has no database to pick yet, and a disconnect has its own
# picker (live rows only), so neither is in here.
_DB_SCOPED_TYPES = ('requirement', 'bug', 'update', 'meeting')

# Every step, in one place. The router used to repeat this list as a literal
# tuple in its sanitiser, and a step added in one and not the other is how a
# conversation ends up on a value no branch matches -- which made the bot go
# silent mid-flow on 16 Oct 2026. Derived, so it cannot drift again.
_STEPS = [
    ('idle', 'Idle'),
    ('pick_type', 'Picking a type'),
    ('pick_area', 'Picking an area'),
    ('ask_text', 'Waiting for the description'),
    ('confirm', 'Waiting for confirmation'),
    ('decline_reconfirm', 'Answering a decline'),
    # They tapped "Send a correction" on a refusal; their next message is it.
    ('ask_correction', 'Typing a corrected version'),
    # The internal group: a developer working, not a client asking.
    ('staff_menu', 'Staff: picking what to do'),
    ('staff_pick_task', 'Staff: picking which task'),
    ('staff_task_actions', 'Staff: picking what to do with it'),
    ('staff_pause_reason', 'Staff: saying why they paused'),
    ('staff_text', 'Staff: typing a question or a meeting request'),
    ('staff_day_note', 'Staff: what they got done today'),
    # The task-details page over WhatsApp (kpi_wa_staff_task.py): add an
    # update, finish with the checklist, edit what they added, pause with a
    # reason, say who a meeting is with. ONE step, with the sub-step kept in
    # staff_draft, so a new screen there never needs a new selection value.
    ('staff_flow', 'Staff: working on a task (update / finish / edit)'),
    # New database
    ('pick_server', 'Picking a server'),
    ('type_server', 'Typing a server name'),
    ('ask_db_name', 'Typing the database name'),
    ('confirm_db_name', 'Confirming the database name'),
    ('ask_db_desc', 'Adding a description'),
    ('pick_install', 'Picking what to install'),
    ('type_install', 'Typing what to install'),
    # Meeting
    ('pick_hour', 'Picking which hour'),
    ('pick_slot', 'Picking a time'),
    # Retired, kept so a conversation mid-flow when this shipped does not
    # land on a step the router cannot name.
    ('pick_day', 'Picking a day (retired)'),
    ('pick_band', 'Picking a part of the day (retired)'),
    ('type_slot', 'Asking for a time in their own words'),
    ('pick_tz', 'Saying which timezone they meant'),
    # Which existing database is this about
    ('pick_db', 'Picking a database'),
    ('type_db', 'Naming a database we do not have listed'),
    # Disconnect
    ('pick_disc_db', 'Picking a database to disconnect'),
    ('pick_disc_reason', 'Picking why'),
    ('type_disc_reason', 'Typing why'),
    ('confirm_disconnect', 'Confirming a disconnect'),
    # Live Databases (read-only)
    ('livedb_server', 'Live databases: picking a server'),
    ('livedb_db', 'Live databases: picking a database'),
    # My Requests (read-only)
    ('myreq_pick', 'My requests: picking one'),
]
_STEP_CODES = tuple(c for c, _l in _STEPS)

# A poll fits TEN options, not twelve -- Evolution answers an 11-row poll with
# 400 "values does not meet maximum length of 10" and whatsapp.session then
# falls back to a numbered text list, so an oversized menu stops being
# tappable rather than losing its tail.
#
# This was 10 while the comment said 12 fit: the picker appends Common AND
# Other, so a client with ten databases produced twelve rows and the menu
# silently became text. Eight leaves exactly ten with both extras.
POLL_MAX_OPTIONS = 10
POLL_MAX_DB_ROWS = 8

# Rows the database picker appends to whatever the client actually has.
_DB_COMMON_ID = '__common__'
_DB_OTHER_ID = '__other__'
_DB_COMMON_LABEL = '🌐 Common — whole server'
_DB_OTHER_LABEL = '➕ Other — type it'

# Install packages now live in the kpi.install.preset TABLE (Setup > Install
# Packages), because this list changed twice in its first week. These
# constants are retained only so an older stored state value still renders.
_INSTALL_PRESETS = [
    ('pos', '📦 Standard POS pack'),
    ('pos_scale', '⚖️ POS + weighing scale'),
    ('copy', '📋 Same as another shop'),
    ('custom', "✍️ Custom — I'll type it"),
]
_PRESET_BY_ID = dict(_INSTALL_PRESETS)
_PRESET_BY_NUMBER = {str(i + 1): c for i, (c, _l) in enumerate(_INSTALL_PRESETS)}

# Emoji for the area picker. Kept HERE and not in kpi_ai.WORK_AREAS on
# purpose: those codes and labels are fed to the LLM prompt as an enum, and
# decorating a machine-readable enum with emoji is asking for mis-parses.
_AREA_EMOJI = {
    'pos': '🧾', 'print': '🖨️', 'hardware': '⚖️', 'apk': '📱',
    'server': '🖥️', 'report': '📊', 'website': '🌐',
}


def _area_label(code):
    """Display label for an area: emoji + its plain name."""
    plain = AREA_LABEL.get(code, code)
    emoji = _AREA_EMOJI.get(code, '')
    return ('%s %s' % (emoji, plain)).strip()
_TYPE_BY_ID = {r[0]: r for r in _TYPE_ROWS}
# Typed-number fallback, in the order the rows are shown.
_TYPE_BY_NUMBER = {str(i + 1): r[0] for i, r in enumerate(_TYPE_ROWS)}
_AREA_BY_NUMBER = {str(i + 1): c for i, (c, _l) in enumerate(WORK_AREAS)}

# A POLL VOTE RETURNS THE OPTION'S VISIBLE LABEL, not an id we chose -- that is
# the one real cost of using polls instead of buttons. So every menu also needs
# a label -> id map, and the labels must stay unique within a step.
def _strip_emoji(text):
    """'🐞 Report a Bug' -> 'report a bug'. Keeps matching working whether the
    member tapped the decorated option or typed the plain words."""
    out = ''.join(ch for ch in (text or '') if ch.isalnum() or ch.isspace()
                  or ch in "/-&'")
    return ' '.join(out.split()).lower()


# Both the decorated label (what a poll vote returns) and the plain words
# (what somebody might type) resolve to the same id.
_TYPE_BY_LABEL = {}
for _r in _TYPE_ROWS:
    _TYPE_BY_LABEL[_r[1].lower()] = _r[0]
    _TYPE_BY_LABEL[_strip_emoji(_r[1])] = _r[0]

_AREA_BY_LABEL = {}
for _c, _l in WORK_AREAS:
    _AREA_BY_LABEL[_l.lower()] = _c
    _AREA_BY_LABEL[_strip_emoji(_l)] = _c
    _AREA_BY_LABEL[_strip_emoji(_area_label(_c))] = _c
    _AREA_BY_LABEL[_area_label(_c).lower()] = _c

_CONFIRM_ROWS = [('create', '✅ Create'), ('edit', '✏️ Edit text'),
                 ('cancel', '❌ Cancel')]
_CONFIRM_BY_LABEL = {}
for _i, _l in _CONFIRM_ROWS:
    _CONFIRM_BY_LABEL[_l.lower()] = _i
    _CONFIRM_BY_LABEL[_strip_emoji(_l)] = _i


def _choose(tapped, typed, valid_ids, by_label, by_number):
    """Resolve a step's answer, whichever way the member gave it.

    Three routes, in order: an id we already recognise, a poll vote (which
    arrives as the option's visible label), or a typed number.
    Returns the id, or None.
    """
    t = (tapped or '').strip()
    if t and t in valid_ids:
        return t
    if t and t.lower() in by_label:
        return by_label[t.lower()]
    return by_number.get((typed or '').strip())


def _words(text):
    return _strip_emoji(text).replace('/', ' ').replace('-', ' ').replace("'", '').split()


def _smart_rows(typed, rows):
    """Smart typing: the rows [(id, label)] that TYPED words point at.

    "pause" -> ⏸️ Pause, "in prog" -> ▶️ In progress, "bug" -> 🐞 Report a Bug.
    Every typed word must start a word of the label. Labels that START with
    the typed words win over ones that only contain them, so "pause" is the
    ⏸️ Pause row and not "My tasks — take, pause, finish".
    Returns the matching rows; one row means one clear answer.
    """
    typed_w = _words(typed)
    if not typed_w or len(''.join(typed_w)) < 2 or ''.join(typed_w).isdigit():
        return []
    leading, anywhere = [], []
    for oid, label in rows:
        lw = _words(label)
        if len(lw) >= len(typed_w) and all(lw[i].startswith(w) for i, w in enumerate(typed_w)):
            leading.append((oid, label))
        elif all(any(x.startswith(w) for x in lw) for w in typed_w):
            anywhere.append((oid, label))
    return leading or anywhere


class KpiWaGroupIntake(models.Model):
    """One in-progress flow, for one person, in one group."""
    _name = 'kpi.wa.group.intake'
    _description = 'WhatsApp Group Intake State'
    _order = 'last_activity desc'

    group_id = fields.Many2one('kpi.wa.group', required=True,
                               ondelete='cascade', index=True)
    participant_key = fields.Char(required=True, index=True)
    participant_name = fields.Char()
    step = fields.Selection(_STEPS, default='idle', required=True)
    srv_id = fields.Many2one('kpi.server', string='Chosen Server')
    srv_other = fields.Char(string='Server (typed)')
    db_name = fields.Char(string='Database Name')
    db_note = fields.Text(string='Database Notes')
    install_preset = fields.Char()
    install_text = fields.Text()

    # ---- which EXISTING database this is about ---------------------------- #
    client_db_id = fields.Many2one(
        'kpi.client.db', string='Chosen Database', ondelete='set null')
    db_is_common = fields.Boolean(
        string='Whole server',
        help='They said it is about the server generally, not one database.')
    db_other = fields.Char(
        string='Database (typed)',
        help='A database the client named that we do not have listed. Kept so '
             'an admin can register it rather than guess.')

    # ---- meeting ---------------------------------------------------------- #
    meet_start = fields.Datetime(
        string='Requested Start',
        help='Set when they tapped one of the offered slots.')
    meet_hour = fields.Char(
        string='Chosen Hour',
        help="'now' for the hour in progress, otherwise the local hour as "
             "two digits. The first of the two taps that pick a time.")
    meet_band = fields.Char(
        string='Part of Day (retired)',
        help='Was morning / afternoon / evening / night. Replaced by '
             'meet_hour; kept so in-flight rows do not break.')
    meet_tz = fields.Char(
        string='Timezone They Meant',
        help='Asked whenever a time is typed. IST and the Gulf are 90 '
             'minutes apart and the difference is never guessed.')
    meet_day = fields.Integer(
        string='Day Offset', default=-1,
        help='0 = today, 1 = tomorrow, -1 = not picked yet. NOT zero for '
             '"unset": today is 0 and 0 is falsy, so `meet_day or None` threw '
             'the day away and a typed time lost the day it belonged to.')
    meet_text = fields.Char(
        string='Requested Time (their words)',
        help='Set when they asked for a time we did not offer. An admin reads '
             'it and sets a real time -- the bot never parses a date out of '
             'free text, because getting that wrong books the wrong day.')

    # ---- disconnect ------------------------------------------------------- #
    disc_reason_id = fields.Many2one(
        'kpi.db.disconnect.reason', string='Disconnect Reason',
        ondelete='set null')
    disc_reason_text = fields.Text(string='Disconnect Reason (typed)')

    # What the LAST menu actually offered, in the order it was shown. The
    # typed-number fallback resolves against this rather than against a static
    # index, because the type menu is not the same for every client.
    menu_csv = fields.Char()

    # ---- the internal group's scratch ------------------------------------ #
    # Separate from created_kpi_id and pending_decline_kpi_id on purpose:
    # those belong to the client flows, and one field doing three jobs is how
    # a stale value from one conversation lands on another.
    staff_action = fields.Char(
        string='Staff action in flight',
        help='take / pause / done / doubt / meet_admin / meet_client')
    staff_kpi_id = fields.Many2one(
        'kra.kpi', string='Task the developer picked', ondelete='set null')
    # The private one-use link to the New Task page (/kpi/wa/newtask/<token>).
    staff_form_token = fields.Char(index=True, copy=False)
    staff_form_expires = fields.Datetime(copy=False)
    # The private link to one task's page (/kpi/wa/task/<token>), 2 hours.
    staff_page_token = fields.Char(index=True, copy=False)
    staff_page_kpi_id = fields.Many2one('kra.kpi', ondelete='set null', copy=False)
    staff_page_expires = fields.Datetime(copy=False)
    # The private link to the End Workday page (/kpi/wa/endday/<token>), 2 hours.
    staff_end_token = fields.Char(index=True, copy=False)
    staff_end_expires = fields.Datetime(copy=False)
    # The client's private one-use form link (/kpi/wa/client/<token>), 30 min.
    # NOT cleared by _reset(): the link outlives the 15-minute chat TTL, and
    # it is used up (cleared) when the form is submitted.
    client_form_token = fields.Char(index=True, copy=False)
    client_form_kind = fields.Char(copy=False)
    client_form_expires = fields.Datetime(copy=False)
    # Set when this form session is the client fixing a DECLINED task
    # (/kpi/wa/fix/<token>): submit updates that task instead of creating one.
    client_form_fix_kpi_id = fields.Many2one('kra.kpi', ondelete='set null', copy=False)
    # 📂 Live Databases: which server, and which page of its databases.
    livedb_server_id = fields.Many2one('kpi.server', ondelete='set null', copy=False)
    livedb_page = fields.Integer(default=0, copy=False)
    staff_poll_ids = fields.Char(
        string='Polls sent to this person',
        help='WhatsApp ids of the last polls the bot sent this person in the '
             'internal group. A vote on a poll that is not theirs is not acted on.')
    staff_draft = fields.Text(
        string='Staff flow scratch (JSON)',
        help='Where a staff_flow conversation is (sub-step) and what has been '
             'collected so far: the summary, links, GitHub links, files waiting '
             'to be saved, checklist ticks, meeting attendees.')

    pending_decline_kpi_id = fields.Many2one(
        'kra.kpi', ondelete='set null',
        help='The task whose decline / reclassification this person is being '
             'asked to confirm.')
    # MUST stay in step with _TYPE_ROWS. A menu row whose id is not a valid
    # Selection value raises on write, the router's try/except swallows it,
    # and the bot goes silent mid-flow with nothing visible to the user --
    # which is exactly what 'newdb' did on 16 Oct 2026. Derived from the one
    # table rather than re-typed, so it cannot drift again.
    action_type = fields.Selection(
        selection=lambda self: [(r[0], r[1]) for r in _TYPE_ROWS])
    work_area = fields.Char()
    raw_text = fields.Text(help='Exactly what the member typed, before tidying.')
    draft_title = fields.Char(help='After AI correction; what will be created.')
    ai_source = fields.Char()
    last_activity = fields.Datetime(default=lambda s: fields.Datetime.now())
    created_kpi_id = fields.Many2one('kra.kpi', ondelete='set null')

    _sql_constraints = [
        ('group_participant_uniq', 'unique(group_id, participant_key)',
         'One intake state per person per group.'),
    ]

    @api.model
    def _get_or_create(self, group, key, name=''):
        rec = self.sudo().search([('group_id', '=', group.id),
                                  ('participant_key', '=', key)], limit=1)
        if rec:
            if rec._is_stale():
                rec._reset()
            if name and rec.participant_name != name:
                rec.participant_name = name
            return rec
        return self.sudo().create({'group_id': group.id, 'participant_key': key,
                                   'participant_name': name, 'step': 'idle'})

    # Conversations WE opened, where the next move is the client's. These do
    # not time out.
    #
    # The TTL exists so somebody who wandered off half way through a menu
    # gets a clean start instead of a half-filled one. A question we pushed
    # at them is the opposite situation: a refusal posted at 6pm and answered
    # at 9am next morning is a perfectly normal thing for a client to do, and
    # expiring it would silently throw away their answer -- or, worse, the
    # correction they had just typed out.
    _PUSHED_STEPS = ('decline_reconfirm', 'ask_correction')

    def _is_stale(self):
        self.ensure_one()
        if self.step in self._PUSHED_STEPS:
            return False
        if not self.last_activity:
            return True
        return (fields.Datetime.now() - self.last_activity).total_seconds() \
            > GROUP_TTL_MINUTES * 60

    def _reset(self):
        self.sudo().write({'step': 'idle', 'action_type': False,
                           'work_area': False, 'raw_text': False,
                           'draft_title': False, 'ai_source': False,
                           'db_note': False,
                           # Scratch from the database and disconnect pickers.
                           # Left behind, a stale client_db_id would attach the
                           # NEXT ticket to the previous conversation's
                           # database -- the same class of bug as the stale
                           # poll vote that re-titled a New Database request.
                           'client_db_id': False, 'db_is_common': False,
                           'db_other': False, 'disc_reason_id': False,
                           'disc_reason_text': False, 'menu_csv': False,
                           'meet_start': False, 'meet_text': False,
                           'meet_day': -1, 'meet_tz': False,
                           'meet_band': False, 'meet_hour': False,
                           # Which refusal we were waiting on an answer about.
                           # Left behind it is only noise -- step is idle so
                           # nothing reads it -- but a dangling pointer to an
                           # archived task is exactly what the comment above
                           # is about.
                           'pending_decline_kpi_id': False,
                           # The internal group's scratch. Listed here for
                           # the same reason as everything above it: a value
                           # left behind attaches the NEXT action to the
                           # PREVIOUS conversation's task.
                           'staff_action': False, 'staff_kpi_id': False,
                           'staff_draft': False,
                           'livedb_server_id': False, 'livedb_page': 0,
                           'last_activity': fields.Datetime.now()})
        # Files a developer sent mid-update are parked as attachments on this
        # row until they press Save. A reset means they were never saved.
        self.env['ir.attachment'].sudo().search([
            ('res_model', '=', self._name), ('res_id', 'in', self.ids)]).unlink()

    def _touch(self, **vals):
        vals['last_activity'] = fields.Datetime.now()
        self.sudo().write(vals)

    @api.model
    def _cron_prune(self):
        for rec in self.sudo().search([('step', '!=', 'idle')]):
            if rec._is_stale():
                rec._reset()
        return True


class KpiWaGroupIntakeRouter(models.AbstractModel):
    _name = 'kpi.wa.group.router'
    _description = 'WhatsApp Group Intake Router'

    @api.private
    @api.model
    def handle(self, message):
        """Entry point from whatsapp.message.create(). Never raises.

        Private, like kpi.manager.dm.handle: the sender is whoever the message
        says it is, so this must only ever be reached from the webhook."""
        body = (message.message or '').strip()
        tapped = (message.interactive_reply_id or '').strip()
        if not body and not tapped:
            return False

        jid = (message.phone or '').strip()
        group = self.env['kpi.wa.group'].sudo().search([('jid', '=', jid)], limit=1)
        if not group or not group.intake_enabled:
            return False
        # A CLIENT group needs a Client; the internal group must not have one.
        # Checked separately because _welcome_header and _live_dbs both
        # dereference group.kra_id -- letting a client-less group into the
        # client chain would raise, not merely misbehave.
        if not group.is_staff_group and not group.kra_id:
            return False

        key = (message.participant_jid or '').strip() or (message.push_name or '').strip()
        if not key:
            return False

        state = self.env['kpi.wa.group.intake']._get_or_create(
            group, key, message.push_name or '')
        low = body.lower().strip()

        # THE INTERNAL GROUP IS A DIFFERENT CONVERSATION ENTIRELY.
        #
        # Branched here, before the cancel/greeting handling and the client
        # step chain, because a developer saying "hi" wants the staff menu and
        # not the "what do you need?" menu a customer gets. The client flow
        # below is untouched.
        if group.is_staff_group:
            return self._handle_staff(message, state, group)

        if low in _CANCELS:
            if state.step != 'idle':
                state._reset()
                self._text(message, _("Cancelled. Send *hi* to start again."))
                return True
            return False

        # A GREETING ALWAYS RESTARTS, from any step.
        #
        # It used to be handled only from 'idle', which meant a half-finished
        # flow could not be escaped except by waiting out the TTL or typing
        # CANCEL -- and nobody guesses CANCEL. It also made a renamed step value
        # unrecoverable: an in-flight row whose `step` no longer existed matched
        # no branch at all and the bot went permanently silent for that person.
        if low in _GREETINGS:
            return self._show_types(message, state, group)

        # Defensive: a step this code does not know (an old row from a previous
        # version of the flow) is treated as idle rather than falling through
        # into silence.
        # Answering a decline comes BEFORE the step sanitiser, because this
        # conversation was opened by us, not by them -- they never typed "hi",
        # so there is no flow for them to be "part way through".
        if state.step == 'decline_reconfirm':
            return self._handle_reconfirm(message, state, tapped, low)

        # Same reasoning: this conversation is one we opened. It also takes
        # the message BODY rather than a menu choice, so it must not reach the
        # pickers below, which would read a sentence as a failed option tap.
        if state.step == 'ask_correction':
            return self._handle_correction(message, state, body)

        step = state.step
        if step not in _STEP_CODES:
            _logger.info('Group intake: resetting unknown step %r', step)
            state._reset()
            step = 'idle'

        if step == 'idle':
            return False                      # ordinary chatter: stay quiet

        if step == 'pick_type':
            # Numbers resolve against what was OFFERED, not against the full
            # table -- 'dbdisconnect' is hidden from clients with nothing live.
            offered = [c for c in (state.menu_csv or '').split(',') if c] \
                or [r[0] for r in _TYPE_ROWS]
            by_number = {str(i + 1): c for i, c in enumerate(offered)}
            choice = _choose(tapped, low, _TYPE_BY_ID, _TYPE_BY_LABEL, by_number)
            if not choice and not tapped:
                # Typed part of an option ("bug", "new req"): one clear match only.
                hits = _smart_rows(low, [(c, _TYPE_BY_ID[c][1]) for c in offered if c in _TYPE_BY_ID])
                choice = hits[0][0] if len(hits) == 1 else None
            if not choice:
                if low in _GREETINGS:
                    return self._show_types(message, state, group)
                return False
            # Requirement / Bug / Update / New DB / Destroy: a private form
            # link with dropdowns, media and a preview, instead of the polls.
            if choice in _FORM_TYPES:
                return self._client_form_begin(message, state, group, choice)
            if choice == 'livedb':
                return self._livedb_begin(message, state, group)
            if choice == 'myreq':
                state._touch(livedb_page=0)
                return self._myreq_show(message, state, group)
            if choice == 'waiting':
                self._text(message, self._waiting_text(group))
                state._reset()
                return True
            if choice == 'newdb':
                # Skip the area picker: a new database is unambiguously
                # Server / Hosting. One less turn.
                state._touch(step='pick_server', action_type='newdb',
                             work_area='server')
                return self._show_servers(message, state)
            if choice == 'dbdisconnect':
                state._touch(action_type='dbdisconnect', work_area='server')
                return self._show_disc_dbs(message, state, group)
            state._touch(action_type=choice)
            # Which database is this about? Asked BEFORE the area, because it
            # decides which KRA the ticket is filed against.
            return self._begin_db_scope(message, state, group)

        if step == 'pick_server':
            opts = self._server_options_from_state(state)
            pick = self._resolve_rows(tapped, low, opts)
            if not pick:
                return False
            if pick == _DB_OTHER_ID:
                state._touch(step='type_server')
                self._text(message, _('Type the server name exactly.'))
                return True
            state._touch(srv_id=int(pick), srv_other=False)
            # A NEW database needs a name typed next. Anything else is about a
            # database that already exists, so the next question is which one.
            if state.action_type == 'newdb':
                state._touch(step='ask_db_name')
                return self._ask_db_name(message)
            return self._show_dbs(message, state, group)

        if step == 'type_server':
            state._touch(srv_other=body[:80], srv_id=False)
            if state.action_type == 'newdb':
                state._touch(step='ask_db_name')
                return self._ask_db_name(message)
            # An unlisted server means we have nothing registered on it, so
            # there is no database list to show. Take the name and move on.
            state._touch(step='pick_area', db_is_common=True)
            return self._show_areas(message, state, group)

        if step == 'ask_db_name':
            clean, err = self.env['kpi.server'].sudo().validate_db_name(body)
            if err:
                self._text(message, '%s\n\n%s' % (err, _('Try again.')))
                return True          # stay on this step; never advance on error
            dup = self.env['kpi.server'].sudo().existing_request(clean)
            warn = ''
            if dup:
                warn = _('\n\n⚠️ %s already asks for this database.') % (
                    dup.external_ref or dup.id)
            state._touch(step='confirm_db_name', db_name=clean)
            self._poll(message, _('Create the database exactly as:  %s%s') % (
                clean, warn),
                [_('✅ Yes — %s') % clean, _('✏️ No — retype')])
            return True

        if step == 'confirm_db_name':
            ans = _strip_emoji(tapped or body)
            if ans.startswith('yes') or low == '1':
                # Description comes AFTER the name is locked in, and is
                # optional. Asking for both at once is how a database ends up
                # named "nexgen_shop3 for the new branch".
                state._touch(step='ask_db_desc')
                self._text(message, _(
                    '*%(db)s* — anything else we should know?\n\n'
                    'Shop name, branch, who it is for, anything special.\n'
                    '_Or reply SKIP._') % {'db': state.db_name or ''})
                return True
            if ans.startswith('no') or low == '2':
                state._touch(step='ask_db_name', db_name=False)
                return self._ask_db_name(message)
            return False

        if step == 'ask_db_desc':
            note = '' if low in ('skip', 'no', 'none', '-') else body[:400]
            state._touch(step='pick_install', db_note=note or False)
            opts = self.env['kpi.install.preset'].sudo().poll_options()
            if not opts:
                # No packages configured: skip straight to free text rather
                # than showing an empty poll.
                state._touch(step='type_install')
                self._text(message, _('List what to install — one message.'))
                return True
            self._poll(message, _('%s — what should be installed?') % (
                state.db_name or ''), [l for _i, l, _n in opts])
            return True

        if step == 'pick_install':
            opts = self.env['kpi.install.preset'].sudo().poll_options()
            by_label = {}
            by_number = {}
            needs = {}
            for n, (pid, plabel, nd) in enumerate(opts):
                by_label[plabel.lower()] = str(pid)
                by_label[_strip_emoji(plabel)] = str(pid)
                by_number[str(n + 1)] = str(pid)
                needs[str(pid)] = nd
            pick = _choose(tapped, low, (), by_label, by_number)
            if not pick:
                return False
            preset = self.env['kpi.install.preset'].sudo().browse(int(pick))
            state._touch(install_preset=preset.name or '')
            if needs.get(pick):
                state._touch(step='type_install')
                self._text(message, _(
                    'List what to install — one message. Name the shop to copy '
                    'from if there is one.'))
                return True
            state._touch(step='confirm')
            return self._confirm_newdb(message, state, group)

        if step == 'type_install':
            state._touch(step='confirm', install_text=body[:600])
            return self._confirm_newdb(message, state, group)

        # ---- meeting: when? ----------------------------------------------- #
        if step == 'pick_hour':
            opts = self._hour_options_from_state(state)
            pick = self._resolve_rows(tapped, low, opts)
            if not pick:
                return False
            if pick == _DB_OTHER_ID:
                state._touch(step='type_slot')
                self._text(message, _(
                    'What time suits you?\n\n_Somebody will confirm it._'))
                return True
            state._touch(meet_hour=pick, meet_day=0)
            return self._show_slots(message, state)

        if step == 'pick_slot':
            opts = self._slot_options_from_state(state)
            pick = self._resolve_rows(tapped, low, opts)
            if not pick:
                return False
            if pick == _DB_OTHER_ID:
                state._touch(step='type_slot')
                self._text(message, _(
                    'When suits you? Tell me the day and time.\n\n'
                    '_Somebody will confirm it._'))
                return True
            state._touch(step='confirm', meet_start=pick, meet_text=False)
            return self._confirm_meeting(message, state, group)

        if step == 'type_slot':
            # Which zone they meant is ASKED, never guessed: IST and the Gulf
            # are 90 minutes apart, and a meeting booked in the wrong one is
            # a missed meeting.
            state._touch(meet_text=body[:120], meet_start=False)
            return self._show_tz(message, state)

        if step == 'pick_tz':
            opts = self._tz_options_from_state(state)
            pick = self._resolve_rows(tapped, low, opts)
            if not pick:
                return False
            Meeting = self.env['kpi.meeting'].sudo()
            when, _local = Meeting.parse_time_text(
                state.meet_text or '', pick,
                day_offset=state.meet_day if state.meet_day >= 0 else None)
            state._touch(step='confirm', meet_tz=pick,
                         meet_start=when or False)
            return self._confirm_meeting(message, state, group)

        # ---- which EXISTING database is this about ------------------------ #
        if step == 'pick_db':
            opts = self._db_options(state, group)
            pick = self._resolve_rows(tapped, low, opts)
            if not pick:
                return False
            if pick == _DB_OTHER_ID:
                state._touch(step='type_db')
                self._text(message, _(
                    'Which database? Type its name.\n\n'
                    '_It is not on our list, so somebody will check it._'))
                return True
            if pick == _DB_COMMON_ID:
                # Server-wide: filed against the client, not a sub-client.
                state._touch(step='pick_area', db_is_common=True,
                             client_db_id=False, db_other=False)
                return self._show_areas(message, state, group)
            state._touch(step='pick_area', client_db_id=int(pick),
                         db_is_common=False, db_other=False)
            return self._show_areas(message, state, group)

        if step == 'type_db':
            state._touch(step='pick_area', db_other=body[:80],
                         client_db_id=False, db_is_common=False)
            return self._show_areas(message, state, group)

        # ---- 📋 my requests (read-only) ---------------------------------- #
        if step == 'myreq_pick':
            pick = self._resolve_rows(tapped, low, self._myreq_options(state, group))
            if not pick:
                return False
            if pick == _LIVEDB_MORE_ID:
                state._touch(livedb_page=state.livedb_page + 1)
                return self._myreq_show(message, state, group)
            if pick == _LIVEDB_BACK_ID:
                state._touch(livedb_page=max(0, state.livedb_page - 1))
                return self._myreq_show(message, state, group)
            task = self.env['kra.kpi'].sudo().browse(int(pick)).exists()
            if not task or task.kra_id.id not in self._client_kra_ids(group):
                return False
            self._text(message, self._myreq_details(task))
            state._reset()
            return True

        # ---- 📂 live databases (read-only) -------------------------------- #
        if step == 'livedb_server':
            pick = self._resolve_rows(tapped, low, self._livedb_server_options(group))
            if not pick:
                return False
            state._touch(livedb_server_id=int(pick), livedb_page=0)
            return self._livedb_show_dbs(message, state, group)

        if step == 'livedb_db':
            pick = self._resolve_rows(tapped, low, self._livedb_db_options(state, group))
            if not pick:
                return False
            if pick == _LIVEDB_MORE_ID:
                state._touch(livedb_page=state.livedb_page + 1)
                return self._livedb_show_dbs(message, state, group)
            if pick == _LIVEDB_BACK_ID:
                if state.livedb_page > 0:
                    state._touch(livedb_page=state.livedb_page - 1)
                    return self._livedb_show_dbs(message, state, group)
                return self._livedb_begin(message, state, group)
            db = self.env['kpi.client.db'].sudo().browse(int(pick)).exists()
            if not db or db.client_kra_id != group.kra_id:
                return False
            self._text(message, self._livedb_details(db))
            state._reset()
            return True

        # ---- disconnect -------------------------------------------------- #
        if step == 'pick_disc_db':
            opts = self._disc_db_options(state, group)
            pick = self._resolve_rows(tapped, low, opts)
            if not pick:
                return False
            state._touch(client_db_id=int(pick))
            return self._show_disc_reasons(message, state)

        if step == 'pick_disc_reason':
            opts = self._disc_reason_options()
            pick = self._resolve_rows(tapped, low, opts)
            if not pick:
                return False
            if pick == _DB_OTHER_ID:
                state._touch(step='type_disc_reason', disc_reason_id=False)
                self._text(message, _('Tell me why, in one line.'))
                return True
            reason = self.env['kpi.db.disconnect.reason'].sudo().browse(int(pick))
            state._touch(disc_reason_id=reason.id)
            if reason.needs_detail:
                state._touch(step='type_disc_reason')
                self._text(message, _(
                    '*%s* — one line of detail, please.') % reason.name)
                return True
            return self._confirm_disconnect(message, state)

        if step == 'type_disc_reason':
            state._touch(disc_reason_text=body[:400])
            return self._confirm_disconnect(message, state)

        if step == 'confirm_disconnect':
            ans = _strip_emoji(tapped or body)
            if ans.startswith('yes') or low == '1':
                return self._do_disconnect_request(message, state, group)
            if ans.startswith('no') or low in ('2', 'cancel'):
                state._reset()
                self._text(message, _(
                    'Cancelled — nothing has been switched off.'))
                return True
            return False

        if step == 'pick_area':
            area = _choose(tapped, low, WORK_AREA_CODES, _AREA_BY_LABEL, _AREA_BY_NUMBER)
            if not area and not tapped:
                hits = _smart_rows(low, [(c, _area_label(c)) for c, _l in WORK_AREAS])
                area = hits[0][0] if len(hits) == 1 else None
            if not area:
                return False
            state._touch(step='ask_text', work_area=area)
            label = self._type_label(state.action_type)
            scope = self._db_scope_label(state)
            self._text(message, _(
                "*%(kind)s · %(area)s*%(scope)s\n"
                "Describe it in one line.\n\n"
                "_Or reply CANCEL to stop._") % {
                    'kind': label, 'area': _area_label(area),
                    'scope': ('\n🗄️ %s' % scope) if scope != '—' else ''})
            return True

        if step == 'ask_text':
            return self._propose(message, state, group, body)

        if step == 'confirm':
            action = _choose(tapped, low, ('create', 'edit', 'cancel'),
                              _CONFIRM_BY_LABEL,
                              {'1': 'create', '2': 'edit', '3': 'cancel'}) or low
            if action in ('create', 'yes', 'y', '1', 'ok'):
                kpi = self._create_ticket(group, state, message)
                state._touch(step='idle', created_kpi_id=kpi.id if kpi else False)
                if kpi and state.action_type == 'meeting':
                    meeting = False
                    try:
                        meeting = self.env['kpi.meeting'].sudo() \
                            .create_from_intake(kpi, state)
                    except Exception as exc:
                        # The ticket exists either way. A meeting record that
                        # failed to create is a thing an admin can add; a
                        # swallowed error that loses the whole request is not.
                        _logger.exception(
                            'could not create meeting for %s: %s', kpi.id, exc)
                    when = self._meet_when_label(state)
                    link = ''
                    if meeting and meeting.page_url():
                        link = _('\n🔗 %s') % meeting.page_url()
                    self._text(message, _(
                        "📅 Logged *%(ref)s* for *%(client)s*.\n"
                        "%(title)s\n"
                        "🕒 %(when)s%(link)s\n\n"
                        "_Somebody will confirm and tell you who is "
                        "joining.%(warn)s_") % {
                            'ref': kpi.external_ref or kpi.id,
                            'client': group.kra_id.name,
                            'title': kpi.name,
                            'when': when or _('a time to be agreed'),
                            'link': link,
                            'warn': '' if meeting else _(
                                ' (Please mention it again if you do not '
                                'hear back.)')})
                    return True
                if kpi and state.action_type == 'newdb':
                    # Echo the database name back. It is the one detail that
                    # must be right, and the requester's last chance to spot a
                    # typo before somebody creates it.
                    self._text(message, _(
                        "Logged *%(ref)s* for *%(client)s*.\n\n"
                        "🗄️ Database: *%(db)s*\n"
                        "🖥️ Server: %(srv)s\n"
                        "📦 Install: %(pkg)s\n\n"
                        "_In the admin queue for review._") % {
                            'ref': kpi.external_ref or kpi.id,
                            'client': group.kra_id.name,
                            'db': state.db_name or '—',
                            'srv': (state.srv_id.name if state.srv_id
                                    else (state.srv_other or '—')),
                            'pkg': state.install_preset or '—'})
                elif kpi:
                    # The database is echoed back for the same reason the New
                    # DB flow echoes its name: it is the detail that decides
                    # who looks at this, and the requester's last chance to
                    # spot that they picked the wrong shop.
                    scope = self._db_scope_label(state)
                    self._text(message, _(
                        "Logged *%(ref)s* for *%(client)s*.\n"
                        "%(title)s%(scope)s\n\n"
                        "_In the admin queue for review._") % {
                            'ref': kpi.external_ref or kpi.id,
                            'client': group.kra_id.name, 'title': kpi.name,
                            'scope': ('\n🗄️ %s' % scope) if scope != '—' else ''})
                else:
                    self._text(message, _("Sorry — I could not log that."))
                return True
            if action in ('edit', 'no', 'n', '2'):
                state._touch(step='ask_text')
                self._text(message, _("Go ahead — type the corrected line."))
                return True
            if action in ('cancel', '3'):
                state._reset()
                self._text(message, _("Cancelled."))
                return True

            # A TAP that did not match is a stale vote, not a new description.
            #
            # WhatsApp sends a pollUpdateMessage every time somebody changes a
            # vote, and a vote on the PREVIOUS poll can land after the step has
            # already moved on. Falling through to _propose here treated that
            # stale label as a retyped title -- which is how a New Database
            # ticket ended up named "Full Package" instead of its database
            # name on 16 Oct 2026. Ignore it; the confirm poll is still there
            # to tap.
            if tapped:
                _logger.info('Ignoring stale poll vote %r at confirm', tapped)
                return False

            # Typed text at confirm genuinely is a retyped description -- but
            # only for the free-text flows. A New Database request was built
            # from structured answers and must not be re-titled by a stray
            # message.
            if state.action_type in ('newdb', 'dbdisconnect'):
                return False
            return self._propose(message, state, group, body)

        return False

    # ------------------------------------------------------------------
    @api.model
    def _reconfirm_answer(self, tapped, low):
        """Which of the three answers this is, or None.

        NOT _choose(), which does an exact dictionary lookup on the whole
        label. These options carry the reference so a vote can be bound to
        the right task -- "✏️ REQ-336 — Send a correction" -- so the label is
        never equal to any key and every tap resolved to nothing.

        Order matters twice over: "disagree" contains "agree", and the
        reference contains digits, so a bare position number is only read as
        one when it is the entire message.
        """
        text = _strip_emoji('%s %s' % (tapped or '', low or '')).lower()

        if 'correction' in text or 'correct' in text:
            return 'correct'
        if 'disagree' in text:                    # before 'agree'
            return 'dispute'
        if 'withdraw' in text or 'close it' in text or 'cancel' in text:
            return 'withdraw'
        if ('go ahead' in text or 'agree' in text or 'yes' in text
                or ' ok' in text or text.strip().endswith('ok')):
            return 'accept'

        # Typed, not tapped: only when the message is nothing but the number.
        return {'1': 'accept', '2': 'correct', '3': 'dispute',
                '4': 'withdraw'}.get((low or '').strip())

    def _handle_reconfirm(self, message, state, tapped, low):
        """The client answering a decline / reclassification we posted.

        Deliberately NOT auto-accepted on silence. An unanswered question
        leaves the task exactly where the admin put it; turning a client's
        silence into agreement that something is chargeable is precisely the
        consent that must not be inferred.
        """
        kpi = state.pending_decline_kpi_id
        if not kpi or not kpi.exists():
            state._reset()
            return False

        answer = self._reconfirm_answer(tapped, low)
        if not answer:
            # Don't nag. Re-state the question once; a group is a conversation
            # between people and most of what is said is not aimed at us.
            if low in _GREETINGS:
                self._text(message, _(
                    "Before that — %(ref)s: tap *OK*, *Send a correction* or "
                    "*I disagree* on the question above.") % {
                        'ref': kpi.external_ref or kpi.id})
                return True
            return False

        try:
            msg = kpi.sudo().apply_client_reconfirm(
                answer, actor_label=state.participant_name
                or state.participant_key)
        except Exception as exc:
            _logger.exception('reconfirm failed for %s: %s', kpi.id, exc)
            self._text(message, _('Sorry — I could not record that.'))
            state._touch(step='idle', pending_decline_kpi_id=False)
            return True

        if answer == 'correct':
            # Stay on this task and wait for the words. The id is kept so the
            # correction lands on the right one even with two open refusals.
            state._touch(step='ask_correction')
        else:
            state._touch(step='idle', pending_decline_kpi_id=False)
        self._text(message, msg)
        return True

    def _handle_correction(self, message, state, body):
        """The client's corrected wording, arriving as free text."""
        kpi = state.pending_decline_kpi_id
        if not kpi or not kpi.exists():
            state._reset()
            return False
        try:
            msg = kpi.sudo().apply_client_correction(
                body, actor_label=state.participant_name
                or state.participant_key)
        except Exception as exc:
            _logger.exception('correction failed for %s: %s', kpi.id, exc)
            self._text(message, _('Sorry — I could not record that.'))
            state._touch(step='idle', pending_decline_kpi_id=False)
            return True
        state._touch(step='idle', pending_decline_kpi_id=False)
        self._text(message, msg)
        return True

    @api.model
    def _type_label(self, action_type):
        """'bug' -> 'Report a Bug'. One lookup, used by every prompt."""
        return _TYPE_BY_ID.get(action_type, ('', action_type or '-', ''))[1]

    def _local_now(self):
        """Now, in the company's timezone, as (date_str, time_str).

        The module hard-defaults to Asia/Kolkata elsewhere, but these groups
        span India and Oman, so the company's own tz is used when it is set and
        Kolkata is only the last resort. Falls back to naive UTC rather than
        raising -- a greeting must never be the thing that breaks the flow.
        """
        try:
            import pytz
            tzname = (self.env.company.partner_id.tz
                      or self.env.user.tz
                      or 'Asia/Kolkata')
            now = fields.Datetime.now().replace(tzinfo=pytz.utc).astimezone(
                pytz.timezone(tzname))
        except Exception:
            now = fields.Datetime.now()
        return now.strftime('%a %d %b %Y'), now.strftime('%I:%M %p').lstrip('0')

    def _welcome_header(self, state, group):
        """The greeting line shown with the menu.

        Deliberately part of the poll's question rather than a separate
        message: two messages per step is the thing that made this flow feel
        noisy, and a greeting is not worth a notification of its own.
        """
        day, clock = self._local_now()
        who = (state.participant_name or '').strip()
        hello = _('👋 Welcome %s') % who if who else _('👋 Welcome')
        return '%s\n%s · %s, %s\n\n%s' % (
            hello, group.kra_id.name or '', day, clock,
            _('What do you need?'))

    def _type_rows_for(self, group):
        """The main menu for THIS client.

        Disconnect is hidden when the client has no live database: offering it
        would lead to an empty picker, and a menu option that dead-ends is
        worse than one that is not there.
        """
        rows = list(_TYPE_ROWS)
        if not self._live_dbs(group):
            rows = [r for r in rows if r[0] not in ('dbdisconnect', 'livedb')]
        return rows

    def _show_types(self, message, state, group):
        rows = self._type_rows_for(group)
        state._touch(step='pick_type', action_type=False, work_area=False,
                     client_db_id=False, db_is_common=False, db_other=False,
                     disc_reason_id=False, disc_reason_text=False,
                     menu_csv=','.join(r[0] for r in rows))
        self._poll(message, self._welcome_header(state, group),
                   [r[1] for r in rows])
        return True

    # ------------------------------------------------------------------
    # which database is this about
    # ------------------------------------------------------------------
    @api.model
    def _resolve_rows(self, tapped, low, rows):
        """Resolve a tap or a typed number against `rows` = [(id, label)].

        One helper for every picker built from a table, so a new menu cannot
        get the label/number matching subtly wrong. Ids are strings here
        because the synthetic rows ('__common__') are not database ids.
        """
        by_label, by_number = {}, {}
        for n, (oid, label) in enumerate(rows):
            by_label[(label or '').lower()] = oid
            by_label[_strip_emoji(label)] = oid
            by_number[str(n + 1)] = oid
        pick = _choose(tapped, low, tuple(o for o, _l in rows),
                       by_label, by_number)
        if not pick and not (tapped or '').strip():
            # Typed part of an option: one clear match only.
            hits = _smart_rows(low, rows)
            pick = hits[0][0] if len(hits) == 1 else None
        return pick

    @api.model
    def _db_scope_label(self, state):
        """What the client said this is about, for the description and the log."""
        if state.client_db_id:
            return '%s (%s)' % (state.client_db_id.db_name or '?',
                                state.client_db_id.server_id.name or '?')
        if state.db_is_common:
            srv = state.srv_id.name or state.srv_other or ''
            return _('Common — whole server %s') % srv if srv \
                else _('Common — whole server')
        if state.db_other:
            return _('%s (not on our list)') % state.db_other
        return '—'

    def _live_dbs(self, group):
        Db = self.env['kpi.client.db'].sudo()
        return Db.search([('client_kra_id', '=', group.kra_id.id),
                          ('state', '=', 'live')])

    def _begin_db_scope(self, message, state, group):
        """Ask which database, skipping any question that has one answer.

        Three shapes, cheapest first:
          * nothing registered -> straight to the area picker. This is exactly
            how the flow behaved before databases existed, so a client whose
            list has not been filled in yet notices no change.
          * all on one server  -> skip the server question and go to the
            database picker. A menu with one option is a wasted turn.
          * several servers    -> ask the server, then the database.
        """
        dbs = self._live_dbs(group)
        if not dbs:
            state._touch(step='pick_area', db_is_common=False)
            return self._show_areas(message, state, group)
        servers = dbs.mapped('server_id')
        if len(servers) == 1:
            state._touch(srv_id=servers.id)
            return self._show_dbs(message, state, group)
        return self._show_servers(message, state, group=group,
                                  only_client=True)

    def _db_options(self, state, group):
        """[(id, label)] for the database picker: the client's own live rows
        on the chosen server, then Common, then Other."""
        Db = self.env['kpi.client.db'].sudo()
        domain = [('client_kra_id', '=', group.kra_id.id),
                  ('state', '=', 'live')]
        if state.srv_id:
            domain.append(('server_id', '=', state.srv_id.id))
        rows = Db.search(domain, limit=POLL_MAX_DB_ROWS)
        opts = [(str(r.id), r.poll_label()) for r in rows]
        opts.append((_DB_COMMON_ID, _DB_COMMON_LABEL))
        opts.append((_DB_OTHER_ID, _DB_OTHER_LABEL))
        return opts

    def _show_dbs(self, message, state, group):
        opts = self._db_options(state, group)
        state._touch(step='pick_db',
                     menu_csv=','.join(o for o, _l in opts))
        srv = state.srv_id.poll_label() if state.srv_id else ''
        self._poll(message,
                   (_('%s — which database?') % srv) if srv
                   else _('Which database?'),
                   [l for _o, l in opts])
        return True

    # ------------------------------------------------------------------
    # disconnect
    # ------------------------------------------------------------------
    def _disc_db_options(self, state, group):
        """Live rows only, and no Common/Other: you cannot disconnect a
        database we do not know about, and "the whole server" is not a thing
        a client gets to switch off from a chat message."""
        rows = self._live_dbs(group)[:POLL_MAX_DB_ROWS]
        return [(str(r.id), '%s (%s)' % (r.poll_label(), r.server_id.name or '?'))
                for r in rows]

    def _show_disc_dbs(self, message, state, group):
        opts = self._disc_db_options(state, group)
        if not opts:
            # Should be unreachable: the type is hidden when nothing is live.
            state._reset()
            self._text(message, _(
                'There are no live databases listed for you. '
                'Send *hi* to start again.'))
            return True
        # One live database: do not ask which. A single-option poll is
        # refused by WhatsApp and arrives as untappable text -- and "which of
        # these one things did you mean" is not a question worth asking.
        if len(opts) == 1:
            db = self.env['kpi.client.db'].sudo().browse(int(opts[0][0]))
            if db.exists():
                state._touch(client_db_id=db.id)
                return self._show_disc_reasons(message, state)
        state._touch(step='pick_disc_db',
                     menu_csv=','.join(o for o, _l in opts))
        self._poll(message, _('Which database should be switched off?'),
                   [l for _o, l in opts])
        return True

    def _disc_reason_options(self):
        rows = self.env['kpi.db.disconnect.reason'].sudo().poll_options()
        opts = [(str(rid), label) for rid, label, _nd in rows]
        opts.append((_DB_OTHER_ID, _DB_OTHER_LABEL))
        return opts

    def _show_disc_reasons(self, message, state):
        opts = self._disc_reason_options()
        db = state.client_db_id
        state._touch(step='pick_disc_reason',
                     menu_csv=','.join(o for o, _l in opts))
        self._poll(message, _('*%s* — why?') % (db.db_name or ''),
                   [l for _o, l in opts])
        return True

    def _confirm_disconnect(self, message, state):
        """The last gate. Names the database, because this is the one request
        in the whole flow that ends a service."""
        db = state.client_db_id
        reason = ' — '.join(p for p in (
            state.disc_reason_id.name or '',
            (state.disc_reason_text or '').strip()) if p) or '—'
        # There is no free-text step in this flow, so the title is built here.
        # Without it `name` would be False and create_kpi would refuse the
        # record -- the same way a renamed step once left a ticket nameless.
        state._touch(step='confirm_disconnect',
                     draft_title=_('Disconnect %(db)s on %(srv)s') % {
                         'db': db.db_name or '?',
                         'srv': db.server_id.name or '?'})
        self._poll(message, _(
            '⚠️ *Switch off a database*\n\n'
            '🗄️ %(db)s\n'
            '🖥️ %(srv)s\n'
            '📝 %(reason)s\n\n'
            'Is that right?') % {
                'db': db.db_name or '',
                'srv': db.server_id.name or '—',
                'reason': reason},
            [_('✅ Yes — request it'), _('❌ No — cancel')])
        return True

    def _do_disconnect_request(self, message, state, group):
        """Create the ticket, record the request, post the receipt.

        Order matters: the ticket first, so the receipt can quote a reference
        the client can hold us to, and so the request is attached to something
        that lands in the admin queue. Nothing here changes the database's
        state -- only an admin does that.
        """
        db = state.client_db_id
        if not db or not db.exists():
            state._reset()
            self._text(message, _('Sorry — I lost track of which database. '
                                  'Send *hi* to start again.'))
            return True
        kpi = self._create_ticket(group, state, message)
        if not kpi:
            self._text(message, _('Sorry — I could not log that.'))
            state._reset()
            return True
        try:
            receipt = db.request_disconnect(
                kpi=kpi, reason=state.disc_reason_id,
                reason_text=state.disc_reason_text or '',
                by_number=self._participant_number(state),
                by_name=state.participant_name or '')
        except Exception as exc:
            _logger.exception('disconnect request failed for %s: %s',
                              db.db_name, exc)
            self._text(message, _(
                'Logged *%s*, but I could not flag the database. '
                'Somebody will check it.') % (kpi.external_ref or kpi.id))
            state._touch(step='idle', created_kpi_id=kpi.id)
            return True
        state._touch(step='idle', created_kpi_id=kpi.id)
        self._text(message, receipt)
        return True

    @api.model
    def _participant_number(self, state):
        """The sender's phone digits, when we can get them.

        A group message arrives from a LID on newer WhatsApp builds, which has
        no digits anybody can dial. The synced member row is where the real
        number lives, so it is looked up there rather than parsed out of the
        key -- an invented number on a disconnect receipt is worse than none.
        """
        key = (state.participant_key or '').strip()
        digits = ''.join(ch for ch in key.split('@')[0] if ch.isdigit())
        member = self.env['kpi.wa.group.member'].sudo().search([
            ('group_id', '=', state.group_id.id),
            '|', ('lid', '=', key), ('phone', '=', key)], limit=1)
        if member and member.phone:
            return ''.join(ch for ch in member.phone if ch.isdigit())
        # A LID is a long opaque id, not a dialable number. Only return the
        # digits when they look like a phone number.
        return digits if 8 <= len(digits) <= 15 else ''

    def _server_options_from_state(self, state):
        """Rebuild the server picker exactly as it was SHOWN.

        The list is not the same every time -- a client is offered only the
        servers they actually have databases on -- so resolving a typed number
        against `kpi.server.poll_options()` would read "2" off the wrong list.
        `menu_csv` records what was offered; the fallback covers a
        conversation that was already mid-flow when this shipped.
        """
        Server = self.env['kpi.server'].sudo()
        opts = []
        for oid in [c for c in (state.menu_csv or '').split(',') if c]:
            if oid == _DB_OTHER_ID:
                opts.append((oid, _('➕ Other (type it)')))
                continue
            try:
                srv = Server.browse(int(oid))
            except (TypeError, ValueError):
                continue
            if srv.exists():
                opts.append((oid, srv.poll_label()))
        if not opts:
            opts = [(str(i), l) for i, l in Server.poll_options()]
            opts.append((_DB_OTHER_ID, _('➕ Other (type it)')))
        return opts

    def _show_servers(self, message, state, group=None, only_client=False):
        """The server picker.

        `only_client` narrows it to the servers this client has live databases
        on, which is what the "which database is this about" path wants: a
        server where they have nothing leads to a picker with no real options.
        The New Database path still shows every server, because that is the
        whole point of it.
        """
        Server = self.env['kpi.server'].sudo()
        if only_client and group:
            servers = self.env['kpi.client.db'].sudo().servers_for_client(
                group.kra_id)
            opts = [(str(s.id), s.poll_label()) for s in servers]
        else:
            opts = [(str(i), l) for i, l in Server.poll_options()]
        if not opts:
            # No server list configured. Fall through to typing one rather
            # than dead-ending the conversation.
            state._touch(step='type_server')
            self._text(message, _('Type the server name exactly.'))
            return True
        opts.append((_DB_OTHER_ID, _('➕ Other (type it)')))
        state._touch(step='pick_server',
                     menu_csv=','.join(o for o, _l in opts))
        question = (_('New Database — which server?')
                    if state.action_type == 'newdb'
                    else _('Which server is it on?'))
        self._poll(message, question, [l for _o, l in opts])
        return True

    def _ask_db_name(self, message):
        self._text(message, _(
            '*DB NAME* — type the exact database name.\n\n'
            'Lowercase letters, numbers and _ only. This becomes a real '
            'database, so it must be exact.'))
        return True

    def _confirm_newdb(self, message, state, group):
        srv = state.srv_id.name if state.srv_id else (state.srv_other or '—')
        lines = [
            _('*New Database*'),
            _('Server: %s') % srv,
            _('Name: %s') % (state.db_name or '—'),
            _('Install: %s') % (state.install_preset or '—'),
        ]
        if state.db_note:
            lines.append(_('Notes: %s') % state.db_note[:160])
        if state.install_text:
            lines.append(state.install_text[:200])
        state._touch(draft_title=_('New DB %s on %s') % (
            state.db_name or '?', srv))
        self._poll(message, '\n'.join(lines),
                   [l for _i, l in _CONFIRM_ROWS])
        return True

    def _show_areas(self, message, state, group):
        self._list(message, _TYPE_BY_ID[state.action_type][1],
                   _('Which area is it about?'), _('Choose area'),
                   [{'id': c, 'title': _area_label(c), 'description': ''}
                    for c, l in WORK_AREAS],
                   section_title=_('Area'))
        return True

    # ------------------------------------------------------------------
    # meeting: when, and the confirm card that shows it
    # ------------------------------------------------------------------
    def _menu_from_state(self, state):
        """Rebuild a picker exactly as it was SHOWN, from `menu_csv`.

        Slots are relative to the moment they were offered, so regenerating
        them to resolve a tap would shift every option by however long the
        person took to answer -- "2" would then book a different time than the
        one they read.
        """
        rows = []
        for part in [c for c in (state.menu_csv or '').split('|') if c]:
            key, _sep, label = part.partition('~')
            rows.append((key, label or key))
        return rows

    def _store_menu(self, state, opts, step):
        state._touch(step=step,
                     menu_csv='|'.join('%s~%s' % (o, l) for o, l in opts))

    def _day_options_from_state(self, state):
        rows = self._menu_from_state(state)
        if not rows:
            rows = list(self.env['kpi.meeting'].sudo().day_options())
            rows.append((_DB_OTHER_ID, _('📆 A later date — tell me')))
        return rows

    def _show_days(self, message, state):
        """Ask the day first, so the time poll only has to list one day.

        Asked before the time because the whole of today plus the whole of
        tomorrow does not fit in a 12-option poll once the slots are half
        hourly.
        """
        opts = list(self.env['kpi.meeting'].sudo().day_options())
        # The ONLY typing left in this flow, and only for a date beyond the
        # six offered. Day and time within those six are pure taps.
        opts.append((_DB_OTHER_ID, _('📆 A later date — tell me')))
        self._store_menu(state, opts, 'pick_day')
        self._poll(message, _('📅 Which day?'), [l for _o, l in opts])
        return True

    def _tz_options_from_state(self, state):
        rows = self._menu_from_state(state)
        if not rows:
            rows = list(self.env['kpi.meeting'].sudo().tz_options())
        return rows

    def _show_tz(self, message, state):
        opts = list(self.env['kpi.meeting'].sudo().tz_options())
        self._store_menu(state, opts, 'pick_tz')
        self._poll(message, _(
            '*%s* — which time is that?') % (state.meet_text or ''),
            [l for _o, l in opts])
        return True

    def _hour_options_from_state(self, state):
        rows = self._menu_from_state(state)
        if not rows:
            rows = list(self.env['kpi.meeting'].sudo().hour_options())
        return rows

    def _show_hours(self, message, state):
        """Tap one: which hour. Today only.

        'Within the hour' then one row per hour left today. The client reads
        their own zone and the developer's on the same line, because the
        client is in Oman and whoever takes the call is on IST.
        """
        Meeting = self.env['kpi.meeting'].sudo()
        opts = list(Meeting.hour_options())
        if not opts:
            # Too late in the day for anything. The one place typing is still
            # offered, because there is genuinely nothing left to tap.
            state._touch(step='type_slot')
            self._text(message, _(
                'Nothing left today. What time suits you?\n\n'
                '_Somebody will confirm it._'))
            return True
        # Exactly four rows, no escape row. Five would still fit a poll, but
        # the point of four is that the whole menu is readable at a glance.
        self._store_menu(state, opts, 'pick_hour')
        self._poll(message, _('🕒 When today?'), [l for _o, l in opts])
        return True

    def _slot_options_from_state(self, state):
        rows = self._menu_from_state(state)
        if not rows:
            rows = list(self.env['kpi.meeting'].sudo()
                        .hour_slots(state.meet_hour))
        return rows

    def _show_slots(self, message, state):
        """Tap two: the exact quarter hour inside the chosen hour."""
        Meeting = self.env['kpi.meeting'].sudo()
        opts = list(Meeting.hour_slots(state.meet_hour))
        if not opts:
            return self._show_hours(message, state)
        # No "tell me" row: every quarter of that hour is already listed.
        self._store_menu(state, opts, 'pick_slot')
        self._poll(message, _('🕒 Exact time?'), [l for _o, l in opts])
        return True

    def _meet_when_label(self, state):
        """What the confirm card shows for the time.

        A resolved time is echoed in BOTH zones, so the person who typed
        "11:50 IST" can see what that is for the other half of the group. A
        time we could not read is shown back in their own words, with no
        pretence that it has been understood.
        """
        if not state.meet_start:
            return (state.meet_text or '').strip()
        import pytz
        Meeting = self.env['kpi.meeting'].sudo()
        try:
            here = state.meet_start.replace(tzinfo=pytz.utc).astimezone(
                pytz.timezone(self.env['kpi.tz'].tz_name()))
            # Name the day in words as well as by date: "Tomorrow" read the
            # next morning means the wrong thing, and a bare date makes
            # somebody count.
            days = (here.date() - Meeting._now_local().date()).days
            if days == 0:
                word = _('Today')
            elif days == 1:
                word = _('Tomorrow')
            else:
                word = here.strftime('%A')
            return '%s, %s · %s' % (word, here.strftime('%d %b'),
                                    Meeting._slot_label(here).replace('🕒 ', ''))
        except Exception:
            return self.env['kpi.tz'].fmt(state.meet_start)

    def _confirm_meeting(self, message, state, group):
        when = self._meet_when_label(state)
        state._touch(step='confirm')
        self._poll(message, _(
            '📅 *Meeting request*\n\n'
            '%(title)s\n'
            '🕒 %(when)s\n\n'
            '_Somebody will confirm the time and send a link._') % {
                'title': state.draft_title or state.raw_text or '',
                'when': when or _('a time to be agreed')},
            [l for _i, l in _CONFIRM_ROWS])
        return True

    def _propose(self, message, state, group, body):
        """Run the text through the AI, then ask for confirmation."""
        raw = (body or '').strip()
        if not raw:
            return False
        res = self.env['kpi.ai'].correct_and_classify(
            raw, hint_doc_type=(state.action_type if state.action_type != 'meeting'
                                else None),
            hint_area=state.work_area)
        state._touch(raw_text=raw, draft_title=res['title'],
                     ai_source=res['source'])
        # A meeting needs a TIME before it needs confirming. Asked here rather
        # than before the description so the slot poll is the last thing on
        # screen when they answer it.
        if state.action_type == 'meeting':
            return self._show_hours(message, state)
        state._touch(step='confirm')
        # No "(no AI key set)" note. Running without an LLM is a deliberate
        # configuration here, not a degraded state -- the type and area come
        # from what the member actually picked, which is better information
        # than a model would infer anyway. Telling them a key is missing makes
        # a working flow look broken. Which path ran is still recorded on the
        # ticket (`Title source:`) and on the intake row for diagnostics.
        self._buttons(
            message,
            _('Confirm'),
            _("*%(title)s*\n\n%(kind)s · %(area)s%(urgent)s") % {
                'title': res['title'],
                'kind': self._type_label(state.action_type),
                'area': _area_label(state.work_area) if state.work_area else '-',
                'urgent': _(' · URGENT') if res['urgent'] else '',
            },
            [{'id': i, 'text': l} for i, l in _CONFIRM_ROWS],
            footer=_('Original: %s') % raw[:60])
        return True

    # ------------------------------------------------------------------
    def _create_ticket(self, group, state, message):
        try:
            Kpi = self.env['kra.kpi'].sudo()
            kra = group.kra_id
            db = state.client_db_id if state.client_db_id.exists() else False

            # WHERE THE TICKET IS FILED
            #
            # A chosen database names its own KRA, which is the whole point of
            # asking. "Common" means the whole server, so it goes to the
            # client itself.
            #
            # The last branch is the pre-database behaviour, kept deliberately:
            # a client whose database list has not been filled in yet should
            # see no change in where their tickets land. It is a guess -- one
            # active child gets the ticket -- and the way to stop guessing is
            # to register that client's databases, not to move everybody's
            # tickets in the same change that introduced the list.
            if db:
                target = db.target_kra() or kra
            elif state.db_is_common:
                target = kra
            else:
                children = kra.child_ids.filtered('active')
                target = children[0] if len(children) == 1 else kra

            # A New DB request is a Requirement with an orthogonal category --
            # never a new doc type, which _auto_admin_accept would silently
            # re-derive back to 'requirement' from the name prefix anyway. A
            # disconnect request is the same shape for the same reason.
            is_newdb = state.action_type == 'newdb'
            is_disc = state.action_type == 'dbdisconnect'
            doc_type = 'requirement' \
                if state.action_type in ('meeting', 'newdb', 'dbdisconnect') \
                else state.action_type
            vals = {
                'name': state.draft_title or state.raw_text,
                'kra_id': target.id,
                'doc_type': doc_type,
                'description': _(
                    "Raised on WhatsApp in group '%(group)s' by %(who)s.\n"
                    "Area: %(area)s\n"
                    "Type picked: %(kind)s\n"
                    "Database: %(db)s\n"
                    "Exactly as typed: %(raw)s\n"
                    "Title source: %(src)s") % {
                        'group': group.name or group.jid,
                        'who': state.participant_name or state.participant_key,
                        'area': _area_label(state.work_area) if state.work_area else '-',
                        'kind': state.action_type or '-',
                        'db': self._db_scope_label(state),
                        'raw': state.raw_text or '-',
                        'src': state.ai_source or '-'},
                # The flag has existed since the beginning and nothing read
                # it. kpi.meeting reads it now.
                'is_meeting': state.action_type == 'meeting',
            }
            if is_disc:
                vals['name'] = '[Disconnect] ' + (vals['name'] or '')
                vals['description'] = '%s\n%s' % (
                    vals.get('description') or '', _(
                        "— Disconnect request —\n"
                        "Database: %(db)s\n"
                        "Server: %(srv)s\n"
                        "Reason: %(reason)s\n"
                        "Detail: %(detail)s\n\n"
                        "NOT ACTIONED. The database is still live. Approve or "
                        "refuse it on Clients > Live Databases.") % {
                            'db': db.db_name if db else '—',
                            'srv': (db.server_id.name if db else '') or '—',
                            'reason': state.disc_reason_id.name or '—',
                            'detail': state.disc_reason_text or '—'})
            if is_newdb:
                vals['name'] = '[New DB] ' + (vals['name'] or '')
                # Spell the request out in the description too. The dedicated
                # columns are what the queue card and the checklist read, but a
                # screen that knows nothing about them still has to be able to
                # show somebody what was actually asked for.
                srv = (state.srv_id.name if state.srv_id
                       else (state.srv_other or '—'))
                vals['description'] = '%s\n%s' % (vals.get('description') or '', _(
                    "— New database —\n"
                    "Server: %(srv)s\n"
                    "Database name: %(db)s\n"
                    "Install: %(preset)s\n"
                    "Notes: %(note)s\n"
                    "Detail: %(detail)s") % {
                        'srv': srv,
                        'db': state.db_name or '—',
                        'preset': state.install_preset or '—',
                        'note': state.db_note or '—',
                        'detail': state.install_text or '—'})
            kpi = Kpi.browse(Kpi.create_kpi(vals))
            post = {# create_kpi's whitelist does not accept these, so they go
                    # in the write that already follows -- the same route the
                    # provisioning fields take.
                    'client_db_id': db.id if db else False,
                    'is_common_request': bool(state.db_is_common)}
            if is_disc:
                post['request_category'] = 'db_disconnect'
            if is_newdb:
                post.update({
                    'request_category': 'new_database',
                    'provision_server_id': state.srv_id.id or False,
                    'provision_server_other': state.srv_other or False,
                    'provision_db_name': state.db_name or False,
                    'provision_preset': state.install_preset or False,
                    'provision_modules': state.install_text or False,
                })
            self._finish_client_ticket(kpi, group, state, post, {
                'area': state.work_area, 'ai_source': state.ai_source,
                'db_scope': self._db_scope_label(state),
                'db_id': db.id if db else False,
                'common': bool(state.db_is_common),
                'db_typed': state.db_other or '',
                'raw_text': state.raw_text})
            return kpi
        except Exception as exc:
            _logger.exception('Group intake could not create a ticket: %s', exc)
            return False

    def _member_for(self, group, state):
        return self.env['kpi.wa.group.member'].sudo().search([
            ('group_id', '=', group.id),
            '|', ('lid', '=', state.participant_key),
            ('phone', '=', state.participant_key)], limit=1)

    def _finish_client_ticket(self, kpi, group, state, post=None, payload=None,
                              action='wa_group_intake'):
        """Everything after create_kpi that makes a WhatsApp ticket a CLIENT
        request: hidden until an admin accepts it, who sent it, queue notice,
        audit log. Shared by the poll flow and the form link, so both file
        tickets identically."""
        member = self._member_for(group, state)
        vals = {'published': False, 'client_submitted': True,
                'submitted_by_uid': member.user_id.id
                if member and member.user_id else False}
        vals.update(post or {})
        kpi.write(vals)
        # Queue notice + the admins' private decision links (approval chain).
        # In the background after commit: those are WhatsApp sends, one per
        # admin, and they used to hold the client's Submit for ~5 seconds.
        kpi._after_commit_in_background('_announce_new_client_ticket')
        log = {'group': group.jid, 'participant': state.participant_key,
               'number': self._participant_number(state)}
        log.update(payload or {})
        kpi._log_action(
            action, source='whatsapp',
            actor_label=state.participant_name or state.participant_key,
            payload=log)
        return kpi

    # ------------------------------------------------------------------
    # the client form link (controllers/kpi_wa_client_form.py)
    # ------------------------------------------------------------------
    _FORM_INTRO = {
        'requirement': '✨ New Requirement',
        'bug': '🐞 Report a Bug',
        'update': '🔧 Request an Update',
        'newdb': '🗄️ New Database',
        'dbdisconnect': '💥 Destroy a Database',
    }

    def _client_form_begin(self, message, state, group, kind):
        """Post a private one-use link to the form for `kind` in the group.

        Same shape as the staff ➕ Create my own task link: one person, one
        use, 30 minutes. The form fills the dropdowns from this group's client
        only, shows a preview and asks for confirmation before creating."""
        token = secrets.token_urlsafe(24)
        state._reset()
        state.sudo().write({
            'client_form_token': token, 'client_form_kind': kind,
            'client_form_fix_kpi_id': False,
            'client_form_expires': fields.Datetime.now()
            + timedelta(minutes=CLIENT_FORM_TTL_MINUTES)})
        base = self.env['whatsapp.config'].sudo().get_config().get_kpi_public_base_url()
        who = (state.participant_name or '').strip()
        self._text(message, _(
            '*%(kind)s*\n%(who)sfill it in here — only for you, works once, '
            'for %(ttl)s minutes:\n%(url)s\n\n'
            '_You will see a preview before it is sent._') % {
                'kind': self._FORM_INTRO.get(kind, kind),
                'who': ('%s, ' % who) if who else '',
                'ttl': CLIENT_FORM_TTL_MINUTES,
                'url': '%s/kpi/wa/client/%s' % (base, token)})
        return True

    # ------------------------------------------------------------------
    # 📂 Live Databases -- polls only, read-only
    # ------------------------------------------------------------------
    def _livedb_server_options(self, group):
        """[(id, 'server (N)')]: the servers this client has live DBs on."""
        dbs = self._live_dbs(group)
        opts = []
        for srv in dbs.mapped('server_id').sorted(lambda s: (s.poll_label() or '').lower()):
            n = len(dbs.filtered(lambda d, s=srv: d.server_id == s))
            opts.append((str(srv.id), '%s (%d)' % (srv.poll_label(), n)))
        return opts[:POLL_MAX_OPTIONS]

    def _livedb_begin(self, message, state, group):
        dbs = self._live_dbs(group)
        if not dbs:
            state._reset()
            self._text(message, _('There are no live databases listed for you.'))
            return True
        if len(dbs) == 1:
            # A one-option poll is refused by WhatsApp: just show it.
            self._text(message, self._livedb_details(dbs))
            state._reset()
            return True
        opts = self._livedb_server_options(group)
        if len(opts) == 1:
            state._touch(livedb_server_id=int(opts[0][0]), livedb_page=0,
                         action_type='livedb')
            return self._livedb_show_dbs(message, state, group)
        state._touch(step='livedb_server', action_type='livedb',
                     livedb_server_id=False, livedb_page=0,
                     menu_csv=','.join(o for o, _l in opts))
        self._poll(message, _('📂 Live Databases — which server?'),
                   [l for _o, l in opts])
        return True

    def _livedb_rows(self, state, group):
        return self.env['kpi.client.db'].sudo().search([
            ('client_kra_id', '=', group.kra_id.id), ('state', '=', 'live'),
            ('server_id', '=', state.livedb_server_id.id)], order='db_name')

    def _livedb_db_options(self, state, group):
        """One page of databases + ➡️ More / ⬅️ Back, at most 10 options."""
        rows = self._livedb_rows(state, group)
        pages = max(1, -(-len(rows) // _LIVEDB_PAGE_ROWS))
        page = min(max(state.livedb_page, 0), pages - 1)
        chunk = rows[page * _LIVEDB_PAGE_ROWS:(page + 1) * _LIVEDB_PAGE_ROWS]
        opts = [(str(r.id), r.poll_label()) for r in chunk]
        if page + 1 < pages:
            opts.append((_LIVEDB_MORE_ID, _('➡️ More (page %d of %d)') % (page + 2, pages)))
        multi_server = len(self._livedb_server_options(group)) > 1
        if page > 0 or multi_server:
            opts.append((_LIVEDB_BACK_ID, _('⬅️ Back')))
        return opts

    def _livedb_show_dbs(self, message, state, group):
        opts = self._livedb_db_options(state, group)
        if len(opts) == 1 and opts[0][0] not in (_LIVEDB_MORE_ID, _LIVEDB_BACK_ID):
            db = self.env['kpi.client.db'].sudo().browse(int(opts[0][0]))
            self._text(message, self._livedb_details(db))
            state._reset()
            return True
        rows = self._livedb_rows(state, group)
        pages = max(1, -(-len(rows) // _LIVEDB_PAGE_ROWS))
        page = min(max(state.livedb_page, 0), pages - 1)
        state._touch(step='livedb_db', livedb_page=page,
                     menu_csv=','.join(o for o, _l in opts))
        srv = state.livedb_server_id
        self._poll(message, _('📂 %(srv)s — %(n)d database(s)%(pg)s. Which one?') % {
            'srv': srv.poll_label() if srv else '', 'n': len(rows),
            'pg': (_(' · page %d of %d') % (page + 1, pages)) if pages > 1 else ''},
            [l for _o, l in opts])
        return True

    @api.model
    def _livedb_details(self, db):
        """The details message for one database."""
        def d(value):
            return value.strftime('%d-%m-%Y') if value else '—'
        state_label = dict(db._fields['state'].selection).get(db.state, db.state or '—')
        created = db.activated_on or (db.first_seen_at and db.first_seen_at.date())
        lines = [
            '🗄️ *%s*' % (db.db_name or ''),
            _('🖥️ Server: %s') % (db.server_id.poll_label() or '—'),
            _('🟢 Status: %s') % state_label,
            _('📅 Created: %s') % d(created),
        ]
        if db.label and db.label != db.db_name:
            lines.insert(1, _('🏷️ %s') % db.label)
        if db.track_term and db.expires_on:
            lines.append(_('⏳ Expires: %(d)s (%(n)s days left)') % {
                'd': d(db.expires_on), 'n': db.days_left})
        tasks = db.task_ids
        done = len(tasks.filtered(lambda t: t.task_state == 'completed'))
        lines.append(_('📋 Tasks: %(open)d open · %(done)d done') % {
            'open': len(tasks) - done, 'done': done})
        return '\n'.join(lines)

    # ------------------------------------------------------------------
    # 📋 My Requests / ✍️ Waiting for me -- read-only, no developer names
    # ------------------------------------------------------------------
    def _client_kra_ids(self, group):
        """The client and everything under it -- the portal dashboard's scope
        (/kpi_client_portal/dashboard), from the group's client record."""
        return group.kra_id._get_descendant_ids() if group.kra_id else []

    def _myreq_tasks(self, group):
        """What the client's dashboard shows: accepted, active tasks."""
        return self.env['kra.kpi'].sudo().search([
            ('kra_id', 'in', self._client_kra_ids(group)), ('active', '=', True),
            ('admin_accepted', '=', True)], order='create_date desc, id desc')

    @api.model
    def _client_status(self, task):
        return _CLIENT_STATUS.get(task.task_state, '⏳ Not started yet')

    @api.model
    def _started_without_reply(self, task):
        """Work began after the approval window with no answer from the client.
        They can still object -- the web portal says exactly that."""
        return bool(task.pre_approval_auto_released and not task.pre_approval_decision
                    and task.task_state not in ('completed', 'awaiting_client'))

    @api.model
    def _needs_client(self, task):
        return task.task_state in ('pre_approval_pending', 'pre_approval_partial',
                                   'awaiting_client') \
            or (task.task_state == 'partially_completed' and task.admin_approved) \
            or self._started_without_reply(task)

    def _myreq_open(self, group):
        """Open requests, the ones needing the client first, newest next."""
        tasks = self._myreq_tasks(group).filtered(lambda t: t.task_state != 'completed')
        return tasks.sorted(lambda t: (0 if self._needs_client(t) else 1,
                                       -(t.create_date.timestamp() if t.create_date else 0)))

    @api.model
    def _myreq_label(self, task):
        name = ' '.join((task.name or '').split())
        label = '%s %s' % (task.external_ref or '#%s' % task.id, name)
        return label if len(label) <= 70 else label[:69] + '…'

    def _myreq_options(self, state, group):
        rows = self._myreq_open(group)
        pages = max(1, -(-len(rows) // _MYREQ_PAGE_ROWS))
        page = min(max(state.livedb_page, 0), pages - 1)
        chunk = rows[page * _MYREQ_PAGE_ROWS:(page + 1) * _MYREQ_PAGE_ROWS]
        opts = [(str(t.id), self._myreq_label(t)) for t in chunk]
        if page + 1 < pages:
            opts.append((_LIVEDB_MORE_ID, _('➡️ More (page %d of %d)') % (page + 2, pages)))
        if page > 0:
            opts.append((_LIVEDB_BACK_ID, _('⬅️ Back')))
        return opts

    def _myreq_show(self, message, state, group):
        tasks = self._myreq_tasks(group)
        open_ = self._myreq_open(group)
        need = len(open_.filtered(self._needs_client))
        done = len(tasks) - len(open_)
        summary = _('📋 *My Requests* — %(client)s\n%(open)d open · %(need)d need you · %(done)d done') % {
            'client': group.kra_id.name or '', 'open': len(open_), 'need': need, 'done': done}
        if not open_:
            state._reset()
            self._text(message, summary + _('\n\nNothing open right now. Send *hi* to raise something new.'))
            return True
        if len(open_) == 1:
            state._reset()
            self._text(message, summary + '\n\n' + self._myreq_details(open_))
            return True
        opts = self._myreq_options(state, group)
        pages = max(1, -(-len(open_) // _MYREQ_PAGE_ROWS))
        page = min(max(state.livedb_page, 0), pages - 1)
        state._touch(step='myreq_pick', action_type='myreq', livedb_page=page,
                     menu_csv=','.join(o for o, _l in opts))
        self._poll(message, summary + _('\n\nWhich one do you want to see?%s') % (
            (_(' (page %d of %d)') % (page + 1, pages)) if pages > 1 else ''),
            [l for _o, l in opts])
        return True

    @api.model
    def _myreq_details(self, task):
        def d(value):
            return value.strftime('%d-%m-%Y') if value else '—'
        lines = ['📌 *%s* — %s' % (task.external_ref or '#%s' % task.id, task.name or ''),
                 _('Status: %s') % self._client_status(task),
                 _('📅 Raised: %s') % d(task.create_date)]
        if self._started_without_reply(task):
            lines.insert(2, _('⚠️ Started without your reply — you can still object.'))
        if task.deadline:
            lines.append(_('🎯 Needed by: %s') % d(task.deadline))
        if task.client_db_id:
            lines.append(_('🗄️ %s (%s)') % (task.client_db_id.db_name or '',
                                            task.client_db_id.server_id.poll_label() or ''))
        if task.related_req_ref:
            lines.append(_('🔗 About: %s') % task.related_req_ref)
        if task.completion_date:
            lines.append(_('🏁 Finished: %s') % d(task.completion_date))
        lines.append(_('🕒 Last update: %s') % d(task.write_date))
        if self._needs_client(task):
            link = self._approval_link(task)
            lines.append('\n' + (_('👉 Open to decide: %s') % link if link else
                                 _('👉 Ask the team for a fresh approval link.')))
        return '\n'.join(lines)

    @api.model
    def _approval_link(self, task):
        """The task's existing approval / sign-off page (/kpi/wa/<token>).

        Never mints a token or touches the task's state: request_client_pre_approval
        would reset its clocks and re-notify. A valid unused token is simply
        rebuilt; an EXPIRED unused one on a task that is still waiting only has
        its expiry pushed out, so the old tap-to-send codes keep working too.
        A used token means the decision was made -- no link."""
        if not task.approval_token or task.approval_token_used:
            return ''
        if not self._needs_client(task):
            return ''
        now = fields.Datetime.now()
        if task.approval_token_expires and task.approval_token_expires < now:
            from .kpi_workflow import APPROVAL_TOKEN_TTL_HOURS
            task.sudo().write({'approval_token_expires':
                               now + timedelta(hours=APPROVAL_TOKEN_TTL_HOURS)})
        try:
            return task._build_approval_url()
        except Exception as exc:
            _logger.warning('approval link for %s failed: %s', task.id, exc)
            return ''

    def _waiting_text(self, group):
        """✍️ Waiting for me: sign-offs and pre-approvals, each with its link."""
        Kpi = self.env['kra.kpi'].sudo()
        kra_ids = self._client_kra_ids(group)
        signoff = Kpi.search([
            ('kra_id', 'in', kra_ids), ('active', '=', True), '|',
            ('task_state', '=', 'awaiting_client'),
            '&', ('task_state', '=', 'partially_completed'), ('admin_approved', '=', True)],
            order='completion_date desc')
        pre = Kpi.search([
            ('kra_id', 'in', kra_ids), ('active', '=', True), ('user_id', '!=', False),
            '|', ('task_state', 'in', ('pre_approval_pending', 'pre_approval_partial')),
            '&', '&', ('pre_approval_auto_released', '=', True),
            ('pre_approval_decision', '=', False),
            ('task_state', 'not in', ('completed', 'awaiting_client'))],
            order='pre_approval_deadline_at asc, id desc')
        pre -= signoff
        if not signoff and not pre:
            return _('✍️ *Waiting for me* — %s\n\nNothing is waiting for you 🎉') % (
                group.kra_id.name or '')
        lines = [_('✍️ *Waiting for me* — %(client)s · %(n)d item(s)') % {
            'client': group.kra_id.name or '', 'n': len(signoff) + len(pre)}]

        def block(title, tasks, what):
            if not tasks:
                return
            lines.append('\n*%s*' % title)
            for t in tasks[:15]:
                link = self._approval_link(t)
                lines.append('• *%s* — %s · %s\n  %s' % (
                    t.external_ref or '#%s' % t.id, t.name or '',
                    _('started without your reply — you can still object')
                    if self._started_without_reply(t) else what,
                    link or _('ask the team for a fresh link')))
            if len(tasks) > 15:
                lines.append(_('…and %d more — see 📋 My Requests.') % (len(tasks) - 15))
        block(_('Finished work — your sign-off'), signoff, _('sign-off needed'))
        block(_('New work — your go-ahead'), pre, _('approval needed'))
        return '\n'.join(lines)

    # ---- transport helpers (always reply INTO the group) ------------------
    def _session(self, message):
        return message.session_id or self.env['whatsapp.session'].sudo().search(
            [('status', '=', 'connected')], limit=1)

    def _text(self, message, text):
        # Replies to a staff member carry their colour too (see _poll).
        mark = self.env.context.get('kpi_wa_owner_mark')
        if mark and text and not text.startswith(mark):
            text = '%s %s' % (mark, text)
        try:
            s = self._session(message)
            if s:
                s.sudo().send_message(message.phone, text)
        except Exception as exc:
            _logger.warning('group reply failed: %s', exc)

    # ONE numbered text menu per step. No interactive messages.
    #
    # Verified on this connection, 16 Oct 2026:
    #   * /message/sendButtons -> accepted by Evolution, arrives as
    #     "This message couldn't load. Open the message on your phone to
    #     view it." -- i.e. it does not render at all.
    #   * /message/sendList    -> accepted, and WhatsApp delivers it as PLAIN
    #     TEXT. It looks like a menu but nothing is tappable.
    #
    # WhatsApp restricts interactive messages to the official Business API;
    # an unofficial (Baileys) connection like this one does not get them. The
    # send SUCCEEDS at every layer we can observe -- Evolution returns a
    # message id -- so there is nothing server-side to detect or fall back on.
    # Sending the card AND the text just produced the same menu twice.
    #
    # whatsapp.session.send_list / send_buttons are kept (they are correct,
    # and cost nothing) in case this account is ever moved to the official
    # API, but the flow does not use them. Flip USE_INTERACTIVE to try again.
    def _numbered(self, items):
        return '\n'.join('%d - %s' % (i + 1, t) for i, t in enumerate(items))

    def _list(self, message, title, description, button_text, rows,
              section_title=''):
        self._poll(message, '%s — %s' % (title, description),
                   [r['title'] for r in rows])

    def _buttons(self, message, title, description, buttons, footer=''):
        self._poll(message, description, [b['text'] for b in buttons])

    def _poll(self, message, question, options):
        """Send a tappable poll, with a numbered text menu as the safety net.

        A poll is the only tappable menu WhatsApp delivers to an unofficial
        connection: buttons arrive as "This message couldn't load" and list
        messages arrive as plain text. A poll renders natively and Evolution
        decrypts the vote into readable `selectedOptions`.

        The text version still follows, because a poll cannot be voted on from
        every client and an older WhatsApp build may not render it either. It
        is the same two-messages-per-step cost as before -- but this time the
        first message is genuinely tappable, which it never was with buttons.
        """
        s = self._session(message)
        if not s:
            _logger.warning('Group intake: no connected session to reply with')
            return
        # A poll needs TWO options. WhatsApp refuses a single-option poll, the
        # fallback below then sends a numbered text list, and the person is
        # left reading "1 - REQ-002 ..." with nothing to tap -- which is how
        # the one-task developer menu ended up untappable.
        #
        # Logged loudly rather than quietly worked around: a menu with one
        # answer is a question that should not have been asked, and the fix
        # belongs at the call site. Kept as a warning so a fourth caller
        # someday is findable instead of silently degrading.
        n = len(options or [])
        if n < 2 or n > POLL_MAX_OPTIONS:
            # Both ends of the range turn a tappable menu into plain text:
            # one option is refused as not being a choice, more than ten is
            # refused by Evolution outright. Named here so the next occurrence
            # is one grep away rather than a screenshot of a numbered list.
            _logger.warning(
                'poll with %d option(s) (allowed 2-%d) -- it will be refused '
                'and arrive as untappable text. Question was: %r',
                n, POLL_MAX_OPTIONS, (question or '')[:80])
        # ONE message. The numbered text that used to follow every poll is
        # gone: it was a hedge against the poll not rendering, and the poll
        # demonstrably renders on this connection. Sending both just showed
        # the same menu twice.
        #
        # The text version is still the FALLBACK -- but only when the poll is
        # actually refused, which whatsapp.session.send_poll handles itself.
        # The internal group: every poll names whose it is, and its id is kept
        # on that person's state so a vote can be checked against its owner.
        owner_state = self.env['kpi.wa.group.intake'].sudo().browse(
            self.env.context.get('kpi_wa_state_id') or 0).exists()
        owner_name = self.env.context.get('kpi_wa_owner_name')
        if owner_name:
            # The person's own colour (🟦 / 🟩 / …, kpi_user_color.py) so each
            # menu in the group is recognisably theirs.
            mark = self.env.context.get('kpi_wa_owner_mark') or '👤'
            question = '%s %s — %s' % (mark, owner_name, question)
        try:
            sent = s.sudo().send_poll(message.phone, question, options, selectable=1)
            if owner_state and isinstance(sent, str):
                ids = [i for i in (owner_state.staff_poll_ids or '').split(',') if i][-19:]
                owner_state.sudo().write({'staff_poll_ids': ','.join(ids + [sent])})
        except Exception as exc:
            _logger.warning('group poll failed, sending text instead: %s', exc)
            try:
                s.sudo().send_message(message.phone, '%s\n\n%s\n\n_%s_' % (
                    question, self._numbered(options),
                    _('Reply with the number.')))
            except Exception as exc2:
                _logger.warning('group poll text fallback failed: %s', exc2)
