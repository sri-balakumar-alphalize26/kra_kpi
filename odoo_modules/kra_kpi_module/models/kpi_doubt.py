"""A developer's question, and the manager who decides what happens to it.

THE RULE
--------
A developer never contacts a client and a client never contacts a developer.
When a developer needs something from the customer -- a detail, a decision, a
call -- it goes to the manager FIRST, and only reaches the client if the
manager sends it.

WHY A MODEL AND NOT A FIELD
---------------------------
A question has a life: raised, decided, answered, maybe released to the
client, maybe answered by them. The free-text fields that already exist on
kra.kpi (paused_reason, decline_note, self_review_note, pre_approval_feedback)
are all single-slot and one-directional -- a second question overwrites the
first and nothing records who it is waiting on. kpi.progress is a work log
with no addressee and no state. kpi.action.log is append-only audit, and
putting a mutable state column in an audit trail destroys the one property
that makes it worth keeping.

WHERE EACH PIECE GOES, AND WHY IT IS A FIELD RATHER THAN A CODE PATH
--------------------------------------------------------------------
This thing lives in three places at once: raised in the internal group,
decided privately by the manager, and sometimes posted into the client's
group. `raised_group_id` and `state` say which, explicitly, so that "where
does the answer go" is answered by reading the record rather than by
remembering which function created it.

THE LEAK GUARANTEE
------------------
`post_for_kpi` -- the only call that can reach a client group -- appears in
exactly ONE method here, and that method is the only writer of
`client_posted_at`. If a question ever reaches a client, it went through
action_release_to_client, and a manager chose it.
"""

import logging
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError

_logger = logging.getLogger(__name__)

# What a developer may set when raising a question. Everything else on the row
# is the manager's (answer, state, client_posted_at...) and `readonly=True` only
# hides it in the form -- over call_kw a developer could have created a
# question already "answered", or already "sent to the client".
ASKER_FIELDS = {'kpi_id', 'kind', 'question'}

KINDS = [
    ('question', 'Question'),
    ('meet_admin', 'Meeting with the manager'),
    ('meet_client', 'Meeting with the client'),
    ('escalation', 'Escalated'),
    # A client's 💬 Discuss message (kpi_chat.py). Answered into the CLIENT
    # group through kra.kpi.chat_post_team, never into the team group.
    ('client_msg', 'Client message'),
    # A client asked for a meeting in WhatsApp (kpi_wa_group_intake →
    # _route_meeting): settled once someone is the meeting's organiser.
    ('client_meet', 'Client asked for a meeting'),
]


class KpiWaConversationDoubt(models.Model):
    """The manager's private conversation needs to remember which question.

    Added here rather than in kpi_manager_dm because that file loads first --
    a Many2one to a model that does not exist yet fails at registry build.
    """
    _inherit = 'kpi.wa.conversation'

    target_doubt_id = fields.Many2one(
        'kpi.doubt', string='Question being decided', ondelete='cascade')


class KpiDoubt(models.Model):
    _name = 'kpi.doubt'
    _description = 'Developer question or meeting request'
    _order = 'create_date desc, id desc'
    _rec_name = 'display_ref'

    kpi_id = fields.Many2one('kra.kpi', string='Task', required=True,
                             ondelete='cascade', index=True)
    kind = fields.Selection(KINDS, default='question', required=True,
                            index=True)
    question = fields.Text(
        string='What they asked', required=True, readonly=True,
        help="The developer's own words, never edited after they are sent.")
    raised_by_id = fields.Many2one(
        'res.users', string='Raised By', readonly=True,
        default=lambda self: self.env.user, ondelete='set null')
    raised_by_name = fields.Char(
        string='Client Name', readonly=True,
        help="A client message: the client's WhatsApp name (clients have no user).")
    # Where it came from, so the answer goes back to the same place rather
    # than to wherever the code happens to be looking.
    raised_group_id = fields.Many2one(
        'kpi.wa.group', string='Raised In', readonly=True,
        ondelete='set null')
    manager_user_id = fields.Many2one(
        'res.users', string='Waiting On', readonly=True, ondelete='set null',
        help='Snapshot of who was asked, taken when it was raised.')
    # Approval Chain (kpi_escalation.py, Settings › Approval Chain), as for a
    # client's new request: tier 1 is asked first; nobody answers within its
    # minutes -> the next tier gets the same poll, and so on; the last tier is
    # reminded every LAST_TIER_REMIND_MIN. Everyone asked may answer.
    esc_tier_id = fields.Many2one('kpi.escalation.tier', string='Approval Tier',
                                  readonly=True, copy=False, ondelete='set null')
    esc_due_at = fields.Datetime(string='Next Tier At', readonly=True, copy=False, index=True)
    esc_asked_ids = fields.Many2many('res.users', 'kpi_doubt_esc_user_rel', 'doubt_id', 'user_id',
                                     string='Asked', readonly=True, copy=False)
    # 💬 A client's question about one task first asks THAT task's developer,
    # in our team group, "can you reply now?" (Yes / No). Yes, or a manager
    # picking someone, sets assigned_dev_id and the chain stops.
    assigned_dev_id = fields.Many2one('res.users', string='Replying', readonly=True,
                                      copy=False, ondelete='set null')
    dev_poll_id = fields.Char(readonly=True, copy=False, index=True,
                              help="WhatsApp id of the team-group Yes/No poll to the developer.")
    dev_asked_at = fields.Datetime(readonly=True, copy=False)

    state = fields.Selection([
        ('open', 'Waiting for the manager'),
        ('answered', 'Answered'),
        ('released', 'Sent to the client'),
        ('client_replied', 'Client answered'),
        ('rejected', 'Refused'),
        ('closed', 'Closed'),
    ], default='open', required=True, index=True)

    answer = fields.Text(string='Answer', readonly=True)
    answered_by_id = fields.Many2one('res.users', readonly=True,
                                     ondelete='set null')
    answered_at = fields.Datetime(readonly=True)

    client_posted_at = fields.Datetime(
        string='Sent To Client', readonly=True,
        help='Set once, and only by action_release_to_client. Its presence '
             'is what stops the same question being asked twice.')
    client_answer = fields.Text(readonly=True)
    client_answered_at = fields.Datetime(readonly=True)

    meeting_id = fields.Many2one('kpi.meeting', readonly=True,
                                 ondelete='set null')

    display_ref = fields.Char(compute='_compute_display_ref', store=True)
    task_ref = fields.Char(related='kpi_id.external_ref', store=True,
                           string='Task Ref')
    client_kra_id = fields.Many2one(related='kpi_id.client_kra_id',
                                    store=True, string='Client')

    @api.depends('kpi_id.external_ref', 'kind')
    def _compute_display_ref(self):
        for rec in self:
            rec.display_ref = '%s · %s' % (
                rec.kpi_id.external_ref or ('#%s' % rec.kpi_id.id),
                dict(KINDS).get(rec.kind, rec.kind))

    # ------------------------------------------------------------------
    @api.model_create_multi
    def create(self, vals_list):
        if not self.env.su and not self._may_decide(self.env.user):
            # A developer asks about a task they can see, as themselves.
            vals_list = [{k: v for k, v in vals.items() if k in ASKER_FIELDS}
                         for vals in vals_list]
            for vals in vals_list:
                vals['raised_by_id'] = self.env.user.id
                if vals.get('kpi_id'):
                    self.env['kra.kpi'].browse(vals['kpi_id']).check_access('read')
        for vals in vals_list:
            if not vals.get('manager_user_id') and vals.get('kpi_id'):
                kpi = self.env['kra.kpi'].sudo().browse(vals['kpi_id'])
                people = kpi._manager_users()
                if people:
                    vals['manager_user_id'] = people[0].id
        rows = super().create(vals_list)
        # kpi_doubt_no_ask: the team is online in that chat (models/kpi_chat.py),
        # so the question is kept without a WhatsApp poll.
        if not self.env.context.get('kpi_doubt_no_ask'):
            for rec in rows:
                rec._ask_the_manager()
        return rows

    def _esc_wait(self, tier):
        from .kpi_escalation import LAST_TIER_REMIND_MIN
        last = tier == self.env['kpi.escalation.tier'].chain()[-1:]
        return max(tier.minutes, 1) if not last else max(tier.minutes, LAST_TIER_REMIND_MIN)

    def _esc_first_people(self):
        """Who the poll goes to now. The first time: tier 1 of the Approval
        Chain (with the manager snapshot when that tier uses the task's
        manager), and the clock for tier 2 starts. Later (a client's new
        message on the same question): everyone asked so far."""
        self.ensure_one()
        # Only people WhatsApp can reach: someone with no number would make
        # the question wait on nobody.
        def reachable(us):
            return us.filtered(lambda u: u.active and (u._kpi_wa_target() or '') and '@' not in u._kpi_wa_target())
        asked = reachable(self.esc_asked_ids)
        if asked:
            return asked
        base = reachable(self.manager_user_id) or reachable(self.kpi_id._manager_users())
        tiers = self.env['kpi.escalation.tier'].chain()
        if not tiers:
            return base
        tier = tiers[0]
        users = self.kpi_id._esc_tier_users(tier)
        if tier.use_task_manager or not users:
            users |= reachable(self.manager_user_id)
        users = users or base
        self.sudo().write({'esc_tier_id': tier.id,
                           'esc_due_at': fields.Datetime.now() + timedelta(minutes=self._esc_wait(tier)),
                           'esc_asked_ids': [(4, u.id) for u in users]})
        return users

    @api.model
    def _cron_escalate_doubts(self):
        """Every minute: a question / meeting request / client message nobody
        answered within its tier's minutes goes to the next tier; after the
        last tier, the last one is reminded. Never answered automatically."""
        now = fields.Datetime.now()
        tiers = self.env['kpi.escalation.tier'].chain()
        moved = 0
        # The developer was asked "can you reply now?" and did not say yes in
        # tier 1's minutes: the manager chain picks someone.
        wait = max((tiers[:1].minutes or 3), 1) if tiers else 3
        for rec in self.sudo().search([
                ('state', '=', 'open'), ('assigned_dev_id', '=', False), ('esc_tier_id', '=', False),
                ('dev_asked_at', '!=', False), ('dev_asked_at', '<=', now - timedelta(minutes=wait))], limit=50):
            try:
                rec._ask_the_manager(note=(_('⏰ %(dev)s did not answer in %(min)d min — please pick who runs the meeting.')
                                           if rec.kind == 'client_meet' else
                                           _('⏰ %(dev)s did not answer in %(min)d min — please pick who replies.')) % {
                    'dev': ', '.join(rec.kpi_id._chat_task_devs().mapped('name')) or _('The developer'), 'min': wait})
                self.env.cr.commit()
                moved += 1
            except Exception as exc:
                _logger.warning('developer → manager step for question %s failed: %s', rec.id, exc)
                self.env.cr.rollback()
        # Open questions that never got onto the chain (raised before it, or
        # asked of someone WhatsApp could not reach): start it now.
        if tiers:
            for rec in self.sudo().search([
                    ('state', '=', 'open'), ('esc_tier_id', '=', False),
                    ('assigned_dev_id', '=', False), ('dev_asked_at', '=', False),
                    ('create_date', '<=', now - timedelta(minutes=2)),
                    ('create_date', '>=', now - timedelta(days=7))], limit=50):
                try:
                    rec._ask_the_manager()
                    self.env.cr.commit()
                    moved += 1
                except Exception as exc:
                    _logger.warning('approval chain start for question %s failed: %s', rec.id, exc)
                    self.env.cr.rollback()
        for rec in self.sudo().search([('state', '=', 'open'), ('esc_due_at', '!=', False),
                                       ('assigned_dev_id', '=', False),
                                       ('esc_due_at', '<=', now)], limit=100):
            try:
                if not tiers:
                    rec.write({'esc_due_at': False})
                    continue
                prev = rec.esc_tier_id
                after = tiers.filtered(lambda t: (t.sequence, t.id) > (prev.sequence, prev.id)) if prev else tiers
                who = ', '.join(rec.esc_asked_ids.mapped('name')) or _('the manager')
                if after[:1]:
                    tier = after[0]
                    note = _('⏰ No reply from %(who)s (%(tier)s) in %(min)d min — now asking you.') % {
                        'who': who, 'tier': prev.name if prev else _('Manager'), 'min': prev.minutes if prev else 0}
                else:
                    tier = tiers[-1]
                    note = _('🔁 Reminder: still no answer. Already asked: %s.') % who
                users = rec.kpi_id._esc_tier_users(tier) or rec.esc_asked_ids
                rec.write({'esc_tier_id': tier.id,
                           'esc_due_at': now + timedelta(minutes=rec._esc_wait(tier)),
                           'esc_asked_ids': [(4, u.id) for u in users]})
                rec._ask_the_manager(users=users, note=note)
                rec.kpi_id.sudo()._log_action('approval_tier', source='cron', payload={
                    'tier': tier.name, 'users': users.mapped('name'), 'kind': 'doubt_%s' % rec.kind,
                    'doubt': rec.id, 'note': note})
                self.env.cr.commit()
                moved += 1
            except Exception as exc:
                _logger.warning('approval chain step for question %s failed: %s', rec.id, exc)
                self.env.cr.rollback()
        return moved

    def _ask_the_developer(self, devs):
        """Our team group: "@dev — the client asked about <task>: … Can you
        reply now?" as a poll only the task's developer may answer
        (kpi_wa_staff_menu._handle_staff → _dev_poll_vote). True if it went out."""
        self.ensure_one()
        Report = self.env['kpi.wa.group.report'].sudo()
        staff = self.env['kpi.wa.group']._staff_group()
        if not staff or not staff.jid:
            return False
        task = self.kpi_id
        client = task.client_kra_id.name or task.kra_id.name or self.raised_by_name or _('The client')
        said = ' '.join((self.question or '').split())[:300]
        if self.kind == 'client_meet':
            Report._post(_('%(tags)s — 📅 %(client)s asked for a meeting about *%(ref)s — %(title)s*\n'
                           '%(said)s\n\nCan you take it? Answer the poll below.') % {
                'tags': ' '.join(Report._mention(u) for u in devs), 'client': client,
                'ref': task._chat_ref(), 'title': task.name or '', 'said': said},
                jid=staff.jid, mentions=[x for x in (Report._mention_digits(u) for u in devs) if x])
            pid = Report._post_poll(staff.jid, _('📅 %(ref)s — can you take the meeting with %(client)s? (%(who)s)') % {
                'ref': task._chat_ref(), 'client': client, 'who': ', '.join(devs.mapped('name'))},
                ['✅ D%s — Yes, I will take the meeting' % self.id, '❌ D%s — No, ask the manager' % self.id])
            if not pid:
                return False
            self.sudo().write({'dev_poll_id': pid if isinstance(pid, str) else False,
                               'dev_asked_at': fields.Datetime.now()})
            return True
        Report._post(_('%(tags)s — 💬 %(client)s asked about *%(ref)s — %(title)s*:\n"%(said)s"\n\n'
                       'Can you reply now? Answer the poll below.') % {
            'tags': ' '.join(Report._mention(u) for u in devs), 'client': client,
            'ref': task._chat_ref(), 'title': task.name or '', 'said': said},
            jid=staff.jid, mentions=[x for x in (Report._mention_digits(u) for u in devs) if x])
        pid = Report._post_poll(staff.jid, _('💬 %(ref)s — can you reply to %(client)s now? (%(who)s)') % {
            'ref': task._chat_ref(), 'client': client, 'who': ', '.join(devs.mapped('name'))},
            ['✅ D%s — Yes, I will reply' % self.id, '❌ D%s — No, ask the manager' % self.id])
        if not pid:
            return False
        self.sudo().write({'dev_poll_id': pid if isinstance(pid, str) else False,
                           'dev_asked_at': fields.Datetime.now()})
        return True

    @api.model
    def _route_meeting(self, meeting, picked=False):
        """📅 A client asked for a meeting in WhatsApp (kpi_wa_group_intake,
        right after kpi.meeting.create_from_intake). About one of their
        requests (`picked`): that task's developer is the organiser at once,
        and our team group is told, tagging them and the task's manager. A
        new topic, or a task with no developer: the Approval Chain picks who
        runs it (the cron climbs the tiers as for any question)."""
        meeting = meeting.sudo()
        task = meeting.kpi_id
        if not task or meeting.organizer_id:
            return self.browse()
        when = meeting.scheduled_start and meeting.local_when or meeting.requested_text or _('no time given yet')
        rec = self.sudo().with_context(kpi_doubt_no_ask=True).create({
            'kpi_id': task.id, 'kind': 'client_meet', 'meeting_id': meeting.id,
            'raised_by_id': False, 'raised_by_name': meeting.requested_by_name or '',
            'question': _('📅 %(subject)s\nWhen: %(when)s') % {'subject': meeting.name or task.name or '',
                                                              'when': when}})
        devs = task._chat_task_devs() if picked else self.env['res.users']
        owner = (task.user_id & devs) or devs[:1]
        if owner:
            rec._meeting_owner(owner, owner, booked=True)
        else:
            rec._ask_the_manager()
        task._log_action('meeting_routed', source='whatsapp', payload={
            'meeting': meeting.id, 'doubt': rec.id, 'picked': bool(picked),
            'owner': owner.name or '', 'asked': rec.esc_asked_ids.mapped('name')})
        return rec

    def _meeting_owner(self, owner, by_user, booked=False):
        """`owner` runs the client's meeting: organiser on it, the question
        settled (the chain stops), told privately, our team group told.
        `booked`: given straight to the task's developer, so the group line
        tags the task's manager too and carries the time and the link."""
        self.ensure_one()
        meeting = self.meeting_id.sudo()
        task = self.kpi_id
        if meeting and not meeting.organizer_id:
            meeting.write({'organizer_id': owner.id, 'attendee_user_ids': [(4, owner.id)]})
        self.sudo().write({'assigned_dev_id': owner.id, 'state': 'answered', 'esc_due_at': False,
                           'answer': _('%s runs the meeting.') % owner.name,
                           'answered_by_id': by_user.id, 'answered_at': fields.Datetime.now()})
        Report = self.env['kpi.wa.group.report'].sudo()
        client = task.client_kra_id.name or task.kra_id.name or self.raised_by_name or _('the client')
        # Never the bare Jitsi link: our page (kpi_meeting.page_url) names
        # people from Odoo and records who joined. The owner gets their own
        # signed link, so it does not even ask for their number.
        mine = meeting._pass_url('u', owner.id) if meeting and meeting.join_url else ''
        Report.post_text_to_user(owner, _(
            '📅 You run the meeting about %(ref)s — %(title)s with %(client)s.\n%(body)s\n\n'
            'Set the time and confirm it on the Meetings screen; the customer is told from there.%(link)s') % {
                'ref': task._chat_ref(), 'title': task.name or '', 'client': client, 'body': self.question or '',
                'link': ('\n\n' + _('Your link to join: %s') % mine) if mine else ''})
        staff = self.env['kpi.wa.group']._staff_group()
        if staff and staff.jid and booked:
            # The task's manager; when that is the developer themself, the
            # Approval Chain's first step.
            mgrs = self.manager_user_id - owner
            if not mgrs:
                tiers = self.env['kpi.escalation.tier'].chain()
                mgrs = (task._esc_tier_users(tiers[0]) if tiers else task._manager_users()) - owner
            people = owner | mgrs
            Report._post(_('📅 %(tags)s — %(client)s booked a meeting about *%(ref)s — %(title)s* · %(when)s%(link)s') % {
                'tags': ' '.join(Report._mention(u) for u in people), 'client': client,
                'ref': task._chat_ref(), 'title': task.name or '',
                'when': meeting.scheduled_start and meeting.local_when or meeting.requested_text or _('time not set yet'),
                'link': (' · %s' % meeting.page_url()) if meeting.join_url else ''},
                jid=staff.jid, mentions=[x for x in (Report._mention_digits(u) for u in people) if x])
        elif staff and staff.jid:
            by = '' if by_user == owner else _(' (picked by %s)') % by_user.name
            Report._post(_('📅 %(ref)s — %(owner)s runs the meeting with %(client)s%(by)s.') % {
                'ref': task._chat_ref(), 'owner': Report._mention(owner), 'client': client, 'by': by},
                jid=staff.jid, mentions=[x for x in [Report._mention_digits(owner)] if x])
        task._log_action('meeting_owner', source='whatsapp', payload={
            'meeting': meeting.id, 'owner': owner.name, 'by': by_user.name})
        return True

    @api.model
    def _dev_poll_vote(self, message, state, group, router):
        """A vote in our team group on a developer's "can you reply now?" poll.
        Only the task's developer counts. True when it was such a vote."""
        pid = (message.quoted_wa_message_id or '').strip()
        tapped = (message.interactive_reply_id or message.message or '').strip()
        rec = self.sudo().search([('dev_poll_id', '=', pid)], limit=1) if pid else self.browse()
        if not rec:
            # A text fallback poll (no id): match the "D<id>" in the option.
            import re as _re
            mt = _re.search(r'\bD(\d+)\b', tapped)
            if not mt or not any(w in tapped for w in ('Yes, I will reply', 'Yes, I will take the meeting',
                                                       'No, ask the manager')):
                return False
            rec = self.sudo().browse(int(mt.group(1))).exists()
            if not rec or not rec.dev_asked_at:
                return False
        voter, _ok = router._staff_member(state, group)
        devs = rec.kpi_id._chat_task_devs()
        if voter not in devs:
            router._text(message, _('%(voter)s, this one is for %(dev)s.') % {
                'voter': voter.name or state.participant_name or _('Hi'),
                'dev': ', '.join(devs.mapped('name')) or _('the developer')})
            return True
        ref = rec.kpi_id._chat_ref()
        # First answer wins: lock the question so a manager's pick at the
        # same moment waits, then read it again.
        self.env.cr.execute('SELECT id FROM kpi_doubt WHERE id = %s FOR UPDATE', (rec.id,))
        rec.invalidate_recordset()
        if rec.state != 'open' or rec.assigned_dev_id:
            router._text(message, _('%(ref)s — already taken by %(who)s.') % {
                'ref': ref, 'who': rec.assigned_dev_id.name or rec.answered_by_id.name or _('the team')})
            return True
        if ('✅' in tapped or 'Yes' in tapped) and rec.kind == 'client_meet':
            rec._meeting_owner(voter, voter)
            router._text(message, _('✅ %(dev)s takes the meeting for %(ref)s — details are in your private chat.') % {
                'dev': voter.name, 'ref': ref})
        elif '✅' in tapped or 'Yes' in tapped:
            rec.kpi_id.sudo().chat_ask_developer(voter, voter, accepted=True)
            router._text(message, _('✅ %(dev)s is replying on %(ref)s — the link is in your private chat.') % {
                'dev': voter.name, 'ref': ref})
        else:
            rec.sudo().write({'dev_asked_at': fields.Datetime.now() - timedelta(days=1)})
            rec._ask_the_manager(note=(_('❌ %(dev)s can\'t take it — please pick who runs the meeting.')
                                       if rec.kind == 'client_meet' else
                                       _('❌ %(dev)s can\'t reply now — please pick who replies.')) % {'dev': voter.name})
            router._text(message, _('OK — asking the manager to pick someone for %s.') % ref)
        return True

    def _ask_the_manager(self, users=None, note=''):
        """Privately, because a decision is not team chatter. `users`: who
        to ask (the cron's next tier); by default the Approval Chain's tier 1
        the first time, everyone asked so far afterwards. `note` goes on top
        ("No reply from … — now asking you")."""
        self.ensure_one()
        Report = self.env['kpi.wa.group.report'].sudo()
        ref = self.kpi_id._chat_ref()
        label = {
            'question': _('has a question'),
            'meet_admin': _('wants a word with you'),
            'meet_client': _('wants a meeting with the client'),
            'escalation': _('needs you to look at this'),
        }.get(self.kind, _('needs you'))

        question = _('%(who)s %(what)s about %(ref)s\n%(title)s\n\n%(body)s') % {
            'who': self.raised_by_id.name or _('A developer'),
            'what': label, 'ref': ref, 'title': self.kpi_id.name or '',
            'body': self.question or ''}

        if self.kind == 'client_msg':
            client = self.kpi_id.client_kra_id.name or self.kpi_id.kra_id.name or ''
            question = _('💬 %(client)s%(who)s wants to discuss %(ref)s\n%(title)s\n\n%(body)s\n\n'
                         'Your answer goes to their group as "the Alphalize team".') % {
                'client': client, 'who': (' (%s)' % self.raised_by_name) if self.raised_by_name else '',
                'ref': ref, 'title': self.kpi_id.name or '', 'body': self.question or ''}
            # The manager opens it straight away (their own page link, else
            # the task in Odoo).
            link = self.kpi_id._chat_page_link(self.manager_user_id) if self.manager_user_id else ''
            question += '\n\n' + _('Open: %s') % (link or self.kpi_id._staff_task_url())
            # No word "client" in these: _doubt_verb reads "client" as "ask the client".
            options = ['✍️ D%s — I will answer it' % self.id]
            # Pick who replies: the people on the task first, then the
            # Developer role. The developer is told privately, our group says
            # who was picked, and the client gets their chat link
            # (kpi_chat.chat_ask_developer).
            options += ['👨‍💻 D%s → %s' % (self.id, (u.name or '')[:40])
                        for u in self.kpi_id._chat_dev_candidates()]
            options += ['📅 D%s — Arrange a meeting' % self.id,
                        '❌ D%s — Not now' % self.id]
        elif self.kind == 'client_meet':
            meeting = self.meeting_id.sudo()
            question = _('📅 %(client)s%(who)s asked for a meeting about %(ref)s\n%(title)s\n\n%(body)s\n\n'
                         'Pick who runs it. They set the time and confirm it on the Meetings screen; '
                         'the customer is told from there.') % {
                'client': self.kpi_id.client_kra_id.name or self.kpi_id.kra_id.name or '',
                'who': (' (%s)' % self.raised_by_name) if self.raised_by_name else '',
                'ref': ref, 'title': self.kpi_id.name or '', 'body': self.question or ''}
            # No word "client" in the options: _doubt_verb reads it as "ask the client".
            options = ['👨‍💻 D%s → %s' % (self.id, (u.name or '')[:40])
                       for u in self.kpi_id._chat_dev_candidates() if u != meeting.organizer_id]
            options += ['📅 D%s — I will take the meeting' % self.id,
                        '❌ D%s — Not now' % self.id]
        elif self.kind == 'meet_client':
            options = ['📅 D%s — Set up the meeting' % self.id,
                       '✅ D%s — I will answer instead' % self.id,
                       '❌ D%s — Not now' % self.id]
        elif self.kind == 'meet_admin':
            options = ['📅 D%s — Yes, let us talk' % self.id,
                       '✅ D%s — I will answer here' % self.id,
                       '❌ D%s — Not now' % self.id]
        else:
            options = ['✅ D%s — I will answer it' % self.id,
                       '➡️ D%s — Ask the client' % self.id,
                       '📅 D%s — Arrange a meeting' % self.id,
                       '❌ D%s — Not now' % self.id]

        if note:
            question = '%s\n\n%s' % (note, question)
        if users is None:
            users = self._esc_first_people()
        sent = False
        for user in users:
            if Report.post_poll_to_user(user, question, options):
                sent = True
        if not sent:
            # Visible to the team, deliberately WITHOUT the client's task
            # wording -- enough to act on, nothing a customer wrote.
            Report._post(_(
                '⚠️ %(ref)s: %(who)s is waiting on a manager and nobody '
                'could be reached. Open the Approvals desk.') % {
                    'ref': ref, 'who': self.raised_by_id.name or '?'})
        return sent

    # ------------------------------------------------------------------
    def _may_decide(self, user):
        """A coordinator (owner and system imply it), or someone it was asked:
        the manager, or anyone the Approval Chain has reached."""
        return bool(user) and (
            user.has_group('kra_kpi_module.group_kra_admin')
            or (self and all(rec.manager_user_id == user or user in rec.esc_asked_ids for rec in self)))

    def _decider(self, by_user=None):
        """Who is deciding, refused unless they may.

        The actions below write under sudo() and one of them is the only path
        to a client group, so the check has to live here, not in whichever
        screen calls them: over call_kw any developer could otherwise answer
        their own question or put it to the client. `by_user` is the manager a
        WhatsApp vote resolved to; from RPC it would arrive as a bare id, and
        is refused rather than trusted.
        """
        if by_user and not isinstance(by_user, models.BaseModel):
            raise AccessError(_('Only a manager can decide on a question.'))
        if self.env.su and not by_user:
            return self.env.user        # internal code; it has decided already
        user = by_user or self.env.user
        if not self._may_decide(user):
            raise AccessError(_('Only a manager can decide on a question.'))
        return user

    def _tell_the_team(self, text):
        """Back to the group it was raised in, so the asker sees the answer.

        Never a private message to the developer: developers are not DM'd by
        the bot at all, which is also the only thing that works given none of
        them is reachable individually today.
        """
        self.ensure_one()
        Report = self.env['kpi.wa.group.report'].sudo()
        jid = (self.raised_group_id.jid
               or self.env['kpi.wa.group']._staff_group().jid or '')
        return Report._post(text, jid=jid or None)

    def action_answer(self, text, by_user=None):
        """The manager answers it themselves. The client never hears about it."""
        self.ensure_one()
        user = self._decider(by_user)
        body = (text or '').strip()
        if not body:
            raise UserError(_('Write the answer first.'))
        if self.kind == 'client_msg':
            # To the CLIENT group, as "our team"; chat_post_team closes this.
            if self.state != 'open':
                raise UserError(_('Already answered by %(who)s: "%(answer)s"') % {
                    'who': self.answered_by_id.name or _('the team'), 'answer': (self.answer or '')[:200]})
            self.kpi_id.chat_post_team(body, user, source='whatsapp')
            return True
        self.sudo().write({'answer': body, 'answered_by_id': user.id,
                           'answered_at': fields.Datetime.now(),
                           'state': 'answered'})
        ref = self.kpi_id.external_ref or ('#%s' % self.kpi_id.id)
        self._tell_the_team(_(
            '💬 *%(ref)s* — answer for %(who)s\n\n%(body)s') % {
                'ref': ref, 'who': self.raised_by_id.name or '', 'body': body})
        self.kpi_id.sudo()._log_action(
            'doubt_answered', source='whatsapp', actor_user_id=user.id,
            payload={'doubt': self.id, 'answer': body})
        return True

    def action_release_to_client(self, text=None, by_user=None):
        """Put the question to the client. THE ONLY path to a client group.

        Guarded by client_posted_at so a second tap, or a repeated poll vote,
        cannot ask the customer the same thing twice.
        """
        self.ensure_one()
        user = self._decider(by_user)
        if self.client_posted_at:
            raise UserError(_('That was already sent to the client on %s.')
                            % fields.Datetime.to_string(self.client_posted_at))
        Report = self.env['kpi.wa.group.report'].sudo()
        kpi = self.kpi_id
        ref = kpi.external_ref or ('#%s' % kpi.id)
        body = (text or self.question or '').strip()

        # Name the person who RAISED THE TASK, not the developer. The client
        # knows who asked them for this work; they have never heard of the
        # developer, and naming one would be the first time a client and a
        # developer were put in touch.
        who = ''
        if kpi.submitted_by_uid:
            who = '%s, ' % Report._mention(kpi.submitted_by_uid)

        posted = Report.post_for_kpi(kpi, _(
            '*%(ref)s — %(title)s*\n%(who)sa question about this:\n\n%(body)s'
        ) % {'ref': ref, 'title': kpi.name or '', 'who': who, 'body': body})
        if not posted:
            raise UserError(_(
                'That client has no WhatsApp group set up, so there is '
                'nowhere to ask them. Set the Client on their group first.'))

        self.sudo().write({'state': 'released',
                           'client_posted_at': fields.Datetime.now(),
                           'answered_by_id': user.id})
        self._tell_the_team(_('➡️ *%(ref)s* — asked the client.') % {'ref': ref})
        kpi.sudo()._log_action(
            'doubt_released', source='whatsapp', actor_user_id=user.id,
            payload={'doubt': self.id, 'text': body})
        return True

    def action_make_meeting(self, by_user=None):
        """Turn it into a meeting. Developers still cannot create one.

        Create rights on kpi.meeting stay at 0 for developers in the ACL --
        the rule is held by access rules, not by remembering to check, so the
        only way a meeting exists is a manager deciding there should be one.

        TWO KINDS, AND THEY ARE NOT THE SAME DECISION
        ---------------------------------------------
        A word with the manager (`meet_admin`) is two colleagues talking. It
        needs no negotiation and no client involvement, so the room is opened
        NOW and the link goes straight into the team group. Making somebody
        agree a time with the person sitting next to them is ceremony.

        A meeting with the CLIENT (`meet_client`) is the opposite: a time has
        to suit them, somebody has to be named to attend, and the client is
        told. That one stays a request for the manager to schedule, which is
        what action_confirm already enforces.
        """
        self.ensure_one()
        user = self._decider(by_user)
        if self.meeting_id:
            return self.meeting_id
        internal = self.kind == 'meet_admin'
        Meeting = self.env['kpi.meeting'].sudo()
        meeting = Meeting.create({
            'name': self.kpi_id.name or _('Meeting'),
            'kpi_id': self.kpi_id.id,
            'requested_by_name': self.raised_by_id.name or self.raised_by_name or '',
            'requested_text': self.question or '',
            'is_internal': internal,
            'state': 'requested',
        })
        self.sudo().write({'meeting_id': meeting.id, 'state': 'answered',
                           'answered_by_id': user.id,
                           'answered_at': fields.Datetime.now()})
        ref = self.kpi_id.external_ref or ('#%s' % self.kpi_id.id)

        if self.kind == 'client_msg':
            self.kpi_id.chat_post_team(_("📅 Let's talk this through in a meeting — we'll send you a time "
                                         "shortly."), user, source='whatsapp')
            return meeting
        if not internal:
            self._tell_the_team(_(
                '📅 *%(ref)s* — a client meeting is being arranged. %(who)s, '
                'you will get the link here once the time is set.') % {
                    'ref': ref, 'who': self.raised_by_id.name or ''})
            return meeting

        # Internal: open it now. confirm then open, so the room is minted and
        # both the link and the "starting now" line land in the team group --
        # _post sends internal meetings there, never to the client.
        try:
            meeting.write({'organizer_id': user.id,
                           'scheduled_start': fields.Datetime.now(),
                           'attendee_user_ids': [(4, self.raised_by_id.id)]})
            meeting.action_confirm()
            meeting._open()
        except Exception as exc:
            _logger.warning('could not open the internal meeting for %s: %s',
                            ref, exc)
            self._tell_the_team(_(
                '📅 *%(ref)s* — %(mgr)s wants a word with %(who)s, but the '
                'room could not be opened. Call them instead.') % {
                    'ref': ref, 'mgr': user.name or '',
                    'who': self.raised_by_id.name or ''})
        return meeting

    def action_reject(self, note='', by_user=None):
        self.ensure_one()
        user = self._decider(by_user)
        if self.kind == 'client_msg':
            # The client is not left without an answer: a holding line, in the chat too.
            ref = self.kpi_id.external_ref or ('#%s' % self.kpi_id.id)
            self.kpi_id.chat_post_team(note or _("Thanks — we'll get back to you on %s soon.") % ref,
                                       user, source='whatsapp')
            self.sudo().write({'state': 'rejected'})
            return True
        self.sudo().write({'state': 'rejected', 'answer': note or '',
                           'answered_by_id': user.id,
                           'answered_at': fields.Datetime.now()})
        ref = self.kpi_id.external_ref or ('#%s' % self.kpi_id.id)
        self._tell_the_team(_(
            '🚫 *%(ref)s* — not now, %(who)s.%(note)s') % {
                'ref': ref, 'who': self.raised_by_id.name or '',
                'note': ('\n%s' % note) if note else ''})
        return True

    # ------------------------------------------------------------------
    # 💬 Discuss from the web Approvals desk: the same hand-off as the
    # WhatsApp "👨‍💻 D<id> → name" buttons (kpi_manager_dm._decide_doubt).
    # ------------------------------------------------------------------
    def chat_dev_options(self):
        """[{id, name}]: who this client message can be handed to -- the people
        on the task first, then the Developer role (kra.kpi._chat_dev_candidates)."""
        self.ensure_one()
        self._decider()
        return [{'id': u.id, 'name': u.name} for u in self.sudo().kpi_id._chat_dev_candidates()]

    def action_ask_developer(self, user_id, by_user=None):
        """Hand an open client message to one developer: they get the question
        privately with their chat link, our group is told who was picked, and
        the client gets their chat link (kra.kpi.chat_ask_developer)."""
        self.ensure_one()
        user = self._decider(by_user)
        if self.kind != 'client_msg':
            raise UserError(_('Only a client message can be handed to a developer.'))
        if self.state != 'open':
            raise UserError(_('Already answered by %s.') % (self.answered_by_id.name or _('the team')))
        dev = self.env['res.users'].sudo().browse(int(user_id or 0)).exists()
        if not dev or dev not in self.sudo().kpi_id._chat_dev_candidates():
            raise UserError(_('Pick one of the developers in the list.'))
        devs, unreachable = self.sudo().kpi_id.chat_ask_developer(user, devs=dev)
        return {'sent_to': devs.mapped('name'), 'unreachable': unreachable.mapped('name')}
