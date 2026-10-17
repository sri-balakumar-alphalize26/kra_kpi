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

from odoo import _, api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

KINDS = [
    ('question', 'Question'),
    ('meet_admin', 'Meeting with the manager'),
    ('meet_client', 'Meeting with the client'),
    ('escalation', 'Escalated'),
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
    # Where it came from, so the answer goes back to the same place rather
    # than to wherever the code happens to be looking.
    raised_group_id = fields.Many2one(
        'kpi.wa.group', string='Raised In', readonly=True,
        ondelete='set null')
    manager_user_id = fields.Many2one(
        'res.users', string='Waiting On', readonly=True, ondelete='set null',
        help='Snapshot of who was asked, taken when it was raised.')

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
        for vals in vals_list:
            if not vals.get('manager_user_id') and vals.get('kpi_id'):
                kpi = self.env['kra.kpi'].sudo().browse(vals['kpi_id'])
                people = kpi._manager_users()
                if people:
                    vals['manager_user_id'] = people[0].id
        rows = super().create(vals_list)
        for rec in rows:
            rec._ask_the_manager()
        return rows

    def _ask_the_manager(self):
        """Privately, because a decision is not team chatter."""
        self.ensure_one()
        Report = self.env['kpi.wa.group.report'].sudo()
        ref = self.kpi_id.external_ref or ('#%s' % self.kpi_id.id)
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

        if self.kind == 'meet_client':
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

        sent = False
        for user in (self.manager_user_id
                     or self.kpi_id._manager_users()):
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
        body = (text or '').strip()
        if not body:
            raise UserError(_('Write the answer first.'))
        user = by_user or self.env.user
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

        user = by_user or self.env.user
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
        if self.meeting_id:
            return self.meeting_id
        user = by_user or self.env.user
        internal = self.kind == 'meet_admin'
        Meeting = self.env['kpi.meeting'].sudo()
        meeting = Meeting.create({
            'name': self.kpi_id.name or _('Meeting'),
            'kpi_id': self.kpi_id.id,
            'requested_by_name': self.raised_by_id.name or '',
            'requested_text': self.question or '',
            'is_internal': internal,
            'state': 'requested',
        })
        self.sudo().write({'meeting_id': meeting.id, 'state': 'answered',
                           'answered_by_id': user.id,
                           'answered_at': fields.Datetime.now()})
        ref = self.kpi_id.external_ref or ('#%s' % self.kpi_id.id)

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
        user = by_user or self.env.user
        self.sudo().write({'state': 'rejected', 'answer': note or '',
                           'answered_by_id': user.id,
                           'answered_at': fields.Datetime.now()})
        ref = self.kpi_id.external_ref or ('#%s' % self.kpi_id.id)
        self._tell_the_team(_(
            '🚫 *%(ref)s* — not now, %(who)s.%(note)s') % {
                'ref': ref, 'who': self.raised_by_id.name or '',
                'note': ('\n%s' % note) if note else ''})
        return True
