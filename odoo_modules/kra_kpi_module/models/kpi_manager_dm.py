"""The manager's private approval channel.

WHY PRIVATE, AND WHY A SECOND STATE MACHINE
-------------------------------------------
Approvals go to the manager as a 1:1 WhatsApp message, not into a team group:
the decision, the client's wording and the reason for a refusal are nobody
else's business. Everything else a staff member does -- the developer menu,
raising a question -- happens in the internal group.

That split is also why this does not reuse `kpi.wa.group.intake`. That model is
keyed `(group_id, participant_key)` with `group_id` required and a UNIQUE
constraint across the pair. Allowing a NULL group would silently stop Postgres
enforcing that constraint at all (every NULL compares distinct), so duplicate
rows would pile up and `_get_or_create` would start picking an arbitrary one.
`kpi.wa.conversation` is already keyed on `phone`, which is exactly the right
key when the phone IS the participant -- so there are two state machines
because there are genuinely two kinds of key, not because of history.

HOW A VOTE FINDS ITS TASK
-------------------------
A WhatsApp poll vote carries the option's VISIBLE LABEL and nothing else -- no
index, no id. With several approvals open at once every label would otherwise
read "Approve", and there would be no way to tell which task was meant.

So the task reference goes FIRST in every label:  "✅ REQ-336 — Approve".

First, not last, because Evolution truncates each option at 100 characters
SILENTLY; a ref trailing a long title would simply vanish and the vote could
never be bound to anything. Matching is by regex on the ref, never string
equality, so losing the decorative tail costs nothing.

The happy consequence is that binding is STATELESS. Polls on WhatsApp never
expire, so a vote can arrive after an Odoo restart, after a prune, or out of
order -- a late vote on a stale poll has already corrupted a ticket once in
this codebase. The conversation row here only ever carries the FOLLOW-UP ("the
next line you type is the reason"), never the binding.
"""

import logging
import re

from odoo import _, api, fields, models

_logger = logging.getLogger(__name__)

# A task reference as this module mints them: REQ-336, UPT-018, BUG-004.
REF_RE = re.compile(r'\b([A-Z]{2,5}-\d{1,6})\b', re.IGNORECASE)

# A developer's question, labelled D5 in the poll it is decided from.
# Deliberately a DIFFERENT shape from a task reference and matched by its own
# pattern: REF_RE needs two or more letters, so "D5" never matched it, the
# manager's tap was not recognised as anything, and the vote fell through the
# whole inbound chain in silence. That is what this exists to stop.
DOUBT_RE = re.compile(r'\bD(\d{1,7})\b')

APPROVE_WORDS = ('approve', 'approved', 'accept', 'yes', 'ok')
REJECT_WORDS = ('reject', 'rejected', 'refuse', 'decline', 'no')

# Evolution truncates each poll option at 100 characters without complaining.
# Titles are trimmed to leave room for the ref and the verb, which must survive.
TITLE_IN_LABEL = 38
# A poll holds 12 options; anything past that is dropped in silence.
MAX_DEV_ROWS = 10


class KpiWaConversationManager(models.Model):
    _inherit = 'kpi.wa.conversation'

    # Reusing this model, so the new steps are added to its Selection rather
    # than kept in a parallel list that could drift out of step with it.
    step = fields.Selection(selection_add=[
        ('mgr_pick_dev', 'Manager: pick a developer'),
        ('mgr_pick_reason', 'Manager: pick a decline reason'),
        ('mgr_type_reason', 'Manager: type a decline reason'),
        ('mgr_doubt_decide', 'Manager: decide on a question'),
        ('mgr_doubt_answer', 'Manager: answer a question'),
    ], ondelete={
        'mgr_pick_dev': 'set default',
        'mgr_pick_reason': 'set default',
        'mgr_type_reason': 'set default',
        'mgr_doubt_decide': 'set default',
        'mgr_doubt_answer': 'set default',
    })

    decline_reason_id = fields.Many2one(
        'kpi.decline.reason', string='Chosen decline reason', ondelete='set null')
    # target_doubt_id is added in kpi_doubt.py, where kpi.doubt is defined --
    # a Many2one to a model that does not exist yet fails at registry build,
    # and this file must load before that one.

    def _is_mgr_step(self):
        return (self.step or '').startswith('mgr_')

    @api.model
    def _is_stale(self, rec):
        """A pending decision does not expire after ten minutes.

        The TTL exists so a client who wandered off mid-menu gets a fresh start
        rather than a half-filled one. A manager who was asked for a reason and
        answers after lunch is not the same situation: resetting them would
        silently discard the refusal they are in the middle of giving.
        """
        if rec.step and rec.step.startswith('mgr_'):
            return False
        return super()._is_stale(rec)


class KraKpiManagerAsk(models.Model):
    _inherit = 'kra.kpi'

    manager_asked_at = fields.Datetime(
        string='Manager Asked', readonly=True, copy=False,
        help='When the approval was last sent to a manager on WhatsApp.')
    manager_escalated_at = fields.Datetime(
        string='Escalated To Owner', readonly=True, copy=False)

    # ------------------------------------------------------------------
    def _label_title(self):
        self.ensure_one()
        title = (self.name or '').strip()
        return (title[:TITLE_IN_LABEL - 1] + '…') if len(title) > TITLE_IN_LABEL else title

    def _ref(self):
        self.ensure_one()
        return self.external_ref or ('TASK-%s' % self.id)

    def ask_manager_to_decide(self, escalate=False):
        """Send the approve/reject poll privately. Never raises.

        Returns the users it actually reached. An empty result is not an error
        -- it means nobody is reachable -- and the caller is expected to fall
        back rather than assume the message landed.
        """
        self.ensure_one()
        Report = self.env['kpi.wa.group.report'].sudo()
        ref = self._ref()

        people = self._manager_users()
        if escalate:
            group = self.env.ref('kra_kpi_module.group_kra_owner',
                                 raise_if_not_found=False)
            if group:
                owners = group.sudo().all_user_ids.filtered(
                    lambda u: u.active and not u.share)
                people = owners or people

        question = _('%(ref)s — %(title)s\n%(client)s%(who)s') % {
            'ref': ref,
            'title': self.name or '',
            'client': (self.client_kra_id.name + '\n')
                      if self.client_kra_id else '',
            'who': _('Raised by %s') % self.submitted_by_uid.name
                   if self.submitted_by_uid else '',
        }
        options = ['✅ %s — Approve' % ref, '❌ %s — Reject' % ref]

        reached = self.env['res.users']
        for user in people:
            if Report.post_poll_to_user(user, question, options):
                reached |= user

        vals = {'manager_asked_at': fields.Datetime.now()}
        if escalate:
            vals['manager_escalated_at'] = fields.Datetime.now()
        self.sudo().write(vals)

        if not reached:
            # Visible, but WITHOUT the client's wording: the internal group is
            # the right place to say "somebody look at this", and the wrong
            # place to repeat what a client wrote in confidence.
            Report._post(_(
                '⚠️ %s needs a decision and no manager could be reached on '
                'WhatsApp. Open the Approvals desk.') % ref)
            _logger.warning('kra.kpi %s: no manager reachable for approval',
                            ref)
        return reached

    # ------------------------------------------------------------------
    def _already_decided(self):
        """Why this can no longer be decided, or None.

        Checked against the RECORD, never against the poll. WhatsApp sends a
        fresh event every time somebody changes their vote, and manager and
        owner can both be holding the same question -- so "has this already
        happened" has to be answered by the task itself.
        """
        self.ensure_one()
        if not self.active:
            return _('%s was already closed.') % self._ref()
        if self.decline_mode:
            return _('%(ref)s was already refused%(by)s.') % {
                'ref': self._ref(),
                'by': (_(' by %s') % self.declined_by_id.name)
                      if self.declined_by_id else ''}
        if self.user_id or self.published:
            return _('%(ref)s was already approved%(by)s and is with %(dev)s.') % {
                'ref': self._ref(),
                'by': '',
                'dev': self.user_id.name or _('the team')}
        return None


class KpiManagerDmRouter(models.AbstractModel):
    """Everything the manager's private channel does, in one place."""
    _name = 'kpi.manager.dm'
    _description = 'Manager approval over a private WhatsApp message'

    # ------------------------------------------------------------------
    @api.model
    def _actor(self, phone):
        """(user, is_manager). Resolved by GROUP, never by member_kind.

        member_kind lives on kpi.wa.group.member, is per-group and is
        admin-overridable -- the same person is 'client' in one group and
        'developer' in another on this very database. It describes a seat in a
        chat, not an authority.

        has_group(), not group.user_ids: almost everybody here holds the
        coordinator group by implication (system -> owner -> coordinator), and
        explicit-membership checks are exactly why _resolve_actor reports those
        people as role 'unknown'.
        """
        user = self.env['res.users']._kpi_user_for_number(phone)
        if not user:
            return user, False
        allowed = (user.has_group('kra_kpi_module.group_kra_admin')
                   or user.has_group('kra_kpi_module.group_kra_owner')
                   or user.has_group('base.group_system'))
        return user, allowed

    @api.model
    def _kpi_from_text(self, text):
        """The task a label refers to, looked up every way _ref() can write it.

        _ref() falls back to 'TASK-<id>' for a task that has not been given an
        external reference yet -- which happens, because the reference is
        minted by the admin-accept step and an unapproved task has not been
        through it. Searching only external_ref meant those labels went into a
        poll and could never be bound back: the manager tapped Approve and
        nothing at all happened.

        Searched with active_test off on purpose: a refused task is archived,
        and a late vote on one must still resolve so it can be told the
        decision was already made, rather than silently ignored.
        """
        Kpi = self.env['kra.kpi'].sudo().with_context(active_test=False)
        refs = REF_RE.findall(text or '')
        if not refs:
            return Kpi.browse()
        ref = refs[0].upper()
        hit = Kpi.search([('external_ref', '=', ref)], limit=1)
        if hit:
            return hit
        if ref.startswith('TASK-') and ref[5:].isdigit():
            row = Kpi.browse(int(ref[5:]))
            # A bare id is only trustworthy when that row really has no
            # reference of its own; otherwise TASK-7 could collide with the
            # task whose reference happens to be REQ-007.
            if row.exists() and not row.external_ref:
                return row
        return Kpi.browse()

    @api.model
    def _verb(self, text):
        low = (text or '').lower()
        if any(w in low for w in APPROVE_WORDS) or '✅' in (text or ''):
            return 'approve'
        if any(w in low for w in REJECT_WORDS) or '❌' in (text or ''):
            return 'reject'
        return None

    # ------------------------------------------------------------------
    @api.model
    def _doubt_from_text(self, text):
        hit = DOUBT_RE.search(text or '')
        if not hit:
            return self.env['kpi.doubt']
        return self.env['kpi.doubt'].sudo().browse(int(hit.group(1))).exists()

    @api.model
    def _doubt_verb(self, text):
        """Which of the manager's four answers this is.

        Matched on words, in an order that matters: 'answer' appears in both
        "I will answer it" and "I will answer here", and "Ask the client"
        must not be read as an answer.
        """
        # No emoji stripping needed: these are substring tests, and the emoji
        # sit beside the words rather than inside them.
        low = (text or '').lower()
        if 'client' in low:
            return 'client'
        if 'meeting' in low or 'let us talk' in low or 'set up' in low:
            return 'meeting'
        if 'answer' in low:
            return 'answer'
        if 'not now' in low or 'reject' in low or 'refuse' in low:
            return 'reject'
        return None

    @api.model
    def handle(self, phone, body):
        """True when this was a manager's message and we answered it."""
        text = (body or '').strip()
        if not text:
            return False

        user, allowed = self._actor(phone)
        Conv = self.env['kpi.wa.conversation'].sudo()
        live = Conv.search([('phone', '=', phone)], limit=1)
        mid_flow = bool(live and live._is_mgr_step())

        doubt = self._doubt_from_text(text)
        doubt_verb = self._doubt_verb(text) if doubt else None

        kpi = self._kpi_from_text(text)
        verb = self._verb(text) if kpi else None
        if not mid_flow and not (kpi and verb) and not (doubt and doubt_verb):
            return False            # not ours; let the chain keep walking

        if doubt and doubt_verb:
            if not user or not allowed:
                self._reply(phone, _('Only a manager can decide that.'))
                return True
            return self._decide_doubt(phone, user, doubt, doubt_verb)

        if not user or not allowed:
            # Loud, not quiet. A manager verb arriving from a number that is
            # not a manager means we sent an approval to the wrong person --
            # a configuration fault, not a user mistake.
            _logger.warning(
                'Manager verb from %s, who is %s. Nothing applied.',
                phone, ('not a coordinator: %s' % user.login) if user
                else 'not a known user')
            self._reply(phone, _(
                'You are not set up to approve tasks here. If you think you '
                'should be, ask an administrator to give you the '
                'Coordinator role.'))
            return True

        if kpi and verb:
            return self._begin(phone, user, kpi, verb)
        return self._continue(phone, user, live, text)

    # ------------------------------------------------------------------
    @api.model
    def _decide_doubt(self, phone, user, doubt, verb):
        """What the manager chose to do with a developer's question."""
        ref = doubt.kpi_id.external_ref or ('#%s' % doubt.kpi_id.id)
        if doubt.state not in ('open',):
            self._reply(phone, _(
                '%(ref)s — that one was already dealt with (%(state)s).') % {
                    'ref': ref,
                    'state': dict(doubt._fields['state'].selection).get(
                        doubt.state, doubt.state)})
            return True

        Conv = self.env['kpi.wa.conversation'].sudo()
        conv = Conv.get_or_create(phone)

        if verb == 'answer':
            # The answer is their next message, so hold the question.
            conv.write({'actor_user_id': user.id,
                        'target_doubt_id': doubt.id,
                        'target_kpi_id': doubt.kpi_id.id,
                        'pending_action': 'doubt_answer',
                        'step': 'mgr_doubt_answer'})
            self._reply(phone, _(
                'What should I tell %(who)s about %(ref)s? It goes to the '
                'team group, not to the client.') % {
                    'who': doubt.raised_by_id.name or _('them'), 'ref': ref})
            return True

        try:
            if verb == 'client':
                doubt.action_release_to_client(by_user=user)
                msg = _('➡️ Asked the client about %s. Their reply will come '
                        'back here.') % ref
            elif verb == 'meeting':
                meeting = doubt.action_make_meeting(by_user=user)
                if meeting and meeting.is_internal:
                    msg = _('📅 Room is open for %(ref)s and the link is in '
                            'the team group. %(who)s can join now.') % {
                        'ref': ref, 'who': doubt.raised_by_id.name or ''}
                else:
                    msg = _('📅 Client meeting requested for %(ref)s. Set the '
                            'time and who joins on the Meetings screen — the '
                            'client is told from there.') % {'ref': ref}
            else:
                doubt.action_reject(by_user=user)
                msg = _('🚫 %s — told them not now.') % ref
        except Exception as exc:
            _logger.exception('doubt decision failed for %s: %s', doubt.id, exc)
            self._reply(phone, _('That did not go through: %s')
                        % str(exc).strip()[:200])
            return True

        conv.reset()
        self._reply(phone, msg)
        return True

    @api.model
    def _begin(self, phone, user, kpi, verb):
        stop = kpi._already_decided()
        if stop:
            self._reply(phone, stop)
            return True

        Conv = self.env['kpi.wa.conversation'].sudo()
        conv = Conv.get_or_create(phone)
        conv.write({'actor_user_id': user.id, 'target_kpi_id': kpi.id,
                    'pending_action': verb, 'decline_reason_id': False})

        if verb == 'approve':
            return self._offer_developers(phone, conv, kpi)
        return self._offer_reasons(phone, conv, kpi)

    @api.model
    def _offer_developers(self, phone, conv, kpi):
        # EXPLICIT members (user_ids), and this is the one place in this
        # feature where that is the right choice rather than the usual trap.
        # Everywhere else -- "may this person approve?" -- implied membership
        # counts, because a coordinator holds the developer group by
        # implication and should still pass an authority check. Here the
        # question is different: who has been DESIGNATED a developer. Using
        # all_user_ids put "Administrator" and the manager herself in the
        # assign list, which is noise, not a feature.
        group = self.env.ref('kra_kpi_module.group_kra_developer',
                             raise_if_not_found=False)
        devs = (group.sudo().user_ids.filtered(
            lambda u: u.active and not u.share).sorted('name')
            if group else self.env['res.users'])[:MAX_DEV_ROWS]
        if not devs:
            self._reply(phone, _(
                'There are no developers to assign %s to. Add somebody to the '
                'Developer role first.') % kpi._ref())
            conv.reset()
            return True

        ref = kpi._ref()
        options = ['%s → %s' % (ref, u.name) for u in devs]
        conv.write({'step': 'mgr_pick_dev',
                    'user_choices_csv': ','.join(str(u.id) for u in devs)})
        self.env['kpi.wa.group.report'].sudo()._post_poll(
            phone, _('%(ref)s — who should do it?') % {'ref': ref}, options)
        return True

    @api.model
    def _offer_reasons(self, phone, conv, kpi):
        Reason = self.env['kpi.decline.reason'].sudo()
        reasons = Reason.search([('mode', '=', 'decline')], limit=10)
        ref = kpi._ref()
        if not reasons:
            conv.write({'step': 'mgr_type_reason'})
            self._reply(phone, _(
                'Why are you refusing %s? The client is shown what you type.')
                % ref)
            return True
        options = ['%s · %s' % (ref, r.name) for r in reasons]
        conv.write({'step': 'mgr_pick_reason',
                    'task_choices_csv': ','.join(str(r.id) for r in reasons)})
        self.env['kpi.wa.group.report'].sudo()._post_poll(
            phone, _('%(ref)s — why are you refusing it?') % {'ref': ref},
            options)
        return True

    # ------------------------------------------------------------------
    @api.model
    def _continue(self, phone, user, conv, text):
        # The manager typing the answer to a question they took on.
        if conv.step == 'mgr_doubt_answer':
            doubt = conv.target_doubt_id
            if not doubt or not doubt.exists():
                conv.reset()
                self._reply(phone, _('That question is gone.'))
                return True
            try:
                doubt.action_answer(text, by_user=user)
            except Exception as exc:
                self._reply(phone, _('That did not go through: %s')
                            % str(exc).strip()[:200])
                return True
            ref = doubt.kpi_id.external_ref or ('#%s' % doubt.kpi_id.id)
            conv.reset()
            self._reply(phone, _(
                '✅ Sent to the team group for %(ref)s. The client was not '
                'told.') % {'ref': ref})
            return True

        kpi = conv.target_kpi_id
        if not kpi or not kpi.exists():
            conv.reset()
            self._reply(phone, _('That task is gone. Nothing was changed.'))
            return True

        stop = kpi._already_decided()
        if stop and conv.step in ('mgr_pick_dev', 'mgr_pick_reason',
                                  'mgr_type_reason'):
            conv.reset()
            self._reply(phone, stop)
            return True

        if conv.step == 'mgr_pick_dev':
            dev = self._pick(text, conv.user_choices_csv, 'res.users')
            if not dev:
                self._reply(phone, _(
                    'I could not tell which developer that was. Tap one of '
                    'the options, or send their number from the list.'))
                return True
            return self._approve(phone, user, conv, kpi, dev)

        if conv.step == 'mgr_pick_reason':
            reason = self._pick(text, conv.task_choices_csv,
                                'kpi.decline.reason')
            if not reason:
                self._reply(phone, _(
                    'I could not tell which reason that was. Tap one of the '
                    'options.'))
                return True
            conv.write({'decline_reason_id': reason.id,
                        'step': 'mgr_type_reason'})
            self._reply(phone, _(
                'Anything to add in your own words? Send it now, or reply '
                '*skip* to send just "%s".') % reason.name)
            return True

        if conv.step == 'mgr_type_reason':
            note = '' if text.strip().lower() in ('skip', '-', 'no') else text
            return self._reject(phone, user, conv, kpi, note)

        return False

    # ------------------------------------------------------------------
    @api.model
    def _approve(self, phone, user, conv, kpi, dev):
        """Assign, which in this codebase IS the approval.

        The ORDER of with_user and sudo is load-bearing, and the obvious way
        round is wrong. `with_user()` returns an env with su=False by
        definition (orm/models.py), so `sudo().with_user(u)` silently throws
        the sudo away and the write runs as a coordinator who has no write
        access to kra.kpi -- an AccessError, not an approval.

        `with_user(u).sudo()` keeps uid=the manager AND su=True, which is what
        both halves need: the accept-on-assign gate in kpi_workflow.write
        tests the ACTING user, so it has to see the manager rather than the
        webhook's own uid, and the write itself has to get past the ACL.
        Authorisation already happened in _actor(); this is execution.

        Done this way, one write accepts the task, publishes it, re-refs it
        and asks the client to approve the assignee.
        """
        ref = kpi._ref()
        try:
            kpi.with_user(user).sudo().write({'user_id': dev.id})
        except Exception as exc:
            _logger.exception('Manager approve failed for %s: %s', ref, exc)
            self._reply(phone, _(
                'That did not go through: %s') % str(exc).strip()[:180])
            return True

        try:
            kpi.sudo()._log_action('manager_approved', source='whatsapp',
                                   actor_user_id=user.id,
                                   payload={'developer': dev.login})
        except Exception:
            pass
        conv.reset()
        self._reply(phone, _(
            '✅ %(ref)s is with %(dev)s.\n'
            'The client has been asked to approve the assignment.') % {
                'ref': ref, 'dev': dev.name})
        return True

    @api.model
    def _reject(self, phone, user, conv, kpi, note):
        ref = kpi._ref()
        reason = conv.decline_reason_id
        try:
            # Same order as _approve, for the same reason: action_decline
            # stamps declined_by_id from env.user and must also get past the
            # ACL to write the task.
            kpi.with_user(user).sudo().action_decline(
                mode='decline', reason_id=reason.id or None,
                reason_text=(note or '').strip(), notify_group=True)
        except Exception as exc:
            _logger.exception('Manager reject failed for %s: %s', ref, exc)
            self._reply(phone, _(
                'That did not go through: %s') % str(exc).strip()[:180])
            return True

        conv.reset()
        self._reply(phone, _(
            '❌ %(ref)s is closed and the client has been told why.\n'
            'They can send a corrected version, and it will come back to you '
            'with the same reference.') % {'ref': ref})
        return True

    # ------------------------------------------------------------------
    @api.model
    def _pick(self, text, csv_ids, model):
        """Which row of the offered list this answer means.

        Accepts the tapped label, the position number, or enough of the name
        to be unambiguous -- the three things a person actually sends.
        """
        ids = [int(i) for i in (csv_ids or '').split(',') if i.strip().isdigit()]
        if not ids:
            return self.env[model]
        rows = self.env[model].sudo().browse(ids).exists()
        low = (text or '').strip().lower()

        digits = ''.join(ch for ch in low if ch.isdigit())
        # A bare position number, but not a reference that happens to end in
        # digits -- "REQ-336" must never be read as "option 336".
        if digits and digits == low and 1 <= int(digits) <= len(rows):
            return rows[int(digits) - 1]
        for row in rows:
            label = (row.name or '').strip().lower()
            if label and label in low:
                return row
        return self.env[model]

    @api.model
    def _reply(self, phone, text):
        session = self.env['whatsapp.session'].sudo().search(
            [('status', '=', 'connected')], limit=1)
        if not session:
            return False
        try:
            return bool(session.send_message(phone, text))
        except Exception as exc:
            _logger.warning('manager dm reply failed: %s', exc)
            return False
