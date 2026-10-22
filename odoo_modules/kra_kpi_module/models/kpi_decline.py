"""Decline or re-type a queued client submission, with a reason that reaches them.

WHAT THIS REPLACES
------------------
Before this, the only admin action on a queued client item was
`/kpi_pending_queue/delete`, which **unlinks the record**. It accepts a
`reason` parameter and never stores it anywhere -- the text lives only inside
a notification body string, and then the task (with any photos the client
sent, and its whole audit trail) is gone. `reject_self_created` looks like the
alternative but is gated on `is_self_created`, which client submissions never
set, so it refuses every queue item.

So: declining destroyed evidence, and re-typing (`/kpi_action/update_meta`)
told nobody at all.

WHAT THIS DOES
--------------
* ARCHIVES instead of deleting (`active=False`). The media, the description
  and the kpi.action.log history all survive, and an archived row can be
  brought back if the client disputes.
* STORES the reason -- both the picked `kpi.decline.reason` and the final
  rendered text -- rather than only speaking it once.
* POSTS it into the client's OWN WhatsApp group, naming the task, via
  `kpi.wa.group.report.post_for_kpi`.
* On reclassify, RE-MINTS the ref through the same shared prefix tables the
  admin-accept path uses, keeps the old ref on the record so a client quoting
  it still gets a hit, and puts the task BACK IN THE QUEUE pending the
  client's re-confirmation. It never becomes billable work on the admin's word
  alone, and never on the client's silence.
"""

import logging

from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

_logger = logging.getLogger(__name__)


class KraKpiDecline(models.Model):
    _inherit = 'kra.kpi'

    # ---- decline / reclassify bookkeeping ---------------------------------- #
    decline_reason_id = fields.Many2one(
        'kpi.decline.reason', string='Decline Reason',
        ondelete='set null', copy=False, index=True)
    decline_note = fields.Text(
        string='Decline / Reclassify Note', readonly=True, copy=False,
        help='The exact wording the client was given.')
    declined_at = fields.Datetime(readonly=True, copy=False)
    declined_by_id = fields.Many2one('res.users', readonly=True, copy=False,
                                     ondelete='set null')
    decline_mode = fields.Selection([
        ('decline', 'Declined'),
        ('reclassify', 'Reclassified'),
    ], readonly=True, copy=False, index=True)

    previous_external_ref = fields.Char(
        string='Previous Ref', readonly=True, copy=False,
        help="The reference this task carried before it was re-typed. Kept "
             "because the client already has the old one in writing on "
             "WhatsApp -- a ref that resolves to nothing is worse than an "
             "out-of-date one.")
    reclassified_from = fields.Selection([
        ('requirement', 'Was a Requirement'),
        ('update', 'Was an Update'),
        ('bug', 'Was a Bug'),
    ], readonly=True, copy=False)

    client_dispute = fields.Boolean(
        string='Client Disputed', readonly=True, copy=False, index=True,
        help='The client answered "No" to a decline or reclassification. The '
             'task is back in the queue for a human to look at again.')
    client_reconfirm_state = fields.Selection([
        ('pending', 'Waiting for the client'),
        ('accepted', 'Client accepted'),
        ('disputed', 'Client disputed'),
        ('withdrawn', 'Client withdrew it'),
        ('corrected', 'Client sent a correction'),
    ], readonly=True, copy=False, index=True)

    # ---- the client fixing it and sending it back ------------------------- #
    #
    # Until now a refused task could only be accepted, disputed or withdrawn.
    # None of those carries a corrected version, so "not enough detail to act
    # on" left the client with no way to supply the detail -- they had to
    # raise the whole thing again under a new reference, and the manager lost
    # the thread between the two.
    #
    # The correction keeps the SAME record and the SAME reference. REQ-336
    # stays REQ-336, because that is what the client has in writing.
    correction_round = fields.Integer(
        string='Corrections Sent', default=0, readonly=True, copy=False,
        help='How many times the client has re-sent this after a refusal.')
    original_client_text = fields.Text(
        string='Original Words', readonly=True, copy=False,
        help="What the client wrote the first time, kept verbatim. Written "
             "once and never again, so no correction can overwrite it.")
    last_correction_text = fields.Text(
        string='Latest Correction', readonly=True, copy=False)

    # Only ever goes up: the card shows "Declined N×" for good, even after the
    # client fixes it and it is accepted.
    decline_count = fields.Integer(
        string='Times Declined', default=0, readonly=True, copy=False)
    # The client's link to fix a declined task on the same form
    # (/kpi/wa/fix/<token>). It does not expire; it is cleared when they
    # resubmit, and a new decline mints a new one.
    client_fix_token = fields.Char(index=True, copy=False, readonly=True)

    # Two rounds, then a human. A loop with no limit is a loop a client and a
    # manager can sit in all day, each believing the other is about to move.
    MAX_CORRECTION_ROUNDS = 2

    def apply_client_correction(self, text, actor_label=''):
        """The client's corrected wording. Same task, same reference.

        The original words are NEVER overwritten: description is appended to,
        original_client_text is written once behind a guard, and every round
        is also copied verbatim into an immutable kpi.action.log row. Three
        copies, because the one thing this must not do is lose what a client
        actually asked for.
        """
        self.ensure_one()
        body = (text or '').strip()
        if not body:
            return _('Send the corrected wording and I will pass it on.')

        if self.correction_round >= self.MAX_CORRECTION_ROUNDS:
            return _(
                "This is the third time round on %s, so I have passed it to "
                "a person instead. Somebody will come back to you."
            ) % (self.external_ref or self.id)

        vals = {
            'last_correction_text': body,
            'correction_round': self.correction_round + 1,
            'client_reconfirm_state': 'corrected',
            'client_dispute': False,
            # Back in front of the manager, exactly where a fresh submission
            # sits: un-archived, unpublished, nobody assigned.
            'active': True,
            'published': False,
            'user_id': False,
            'task_state': 'queue_waiting',
            'self_review_note': ('[CLIENT CORRECTED] %s' % body)[:255],
            # The accept-deadline must stay clear. _cron_admin_accept_timeout
            # would otherwise publish the corrected words, re-derive the doc
            # type from the name prefix and ask the client to pre-approve --
            # with nobody having read the correction.
            'admin_accept_deadline_at': False,
        }
        if not self.original_client_text:
            vals['original_client_text'] = self.description or ''

        stamp = fields.Datetime.to_string(fields.Datetime.now())
        vals['description'] = '%s\n\n--- Correction %d (client, %s) ---\n%s' % (
            (self.description or '').rstrip(), self.correction_round + 1,
            stamp, body)

        self.sudo().write(vals)
        self.sudo()._log_action(
            'client_correction', source='whatsapp', actor_label=actor_label,
            payload={'round': self.correction_round, 'text': body})
        try:
            self.sudo()._notify('client_task_queued')
            self.sudo()._schedule_queue_nudge()
        except Exception as exc:
            _logger.warning('correction notify failed for %s: %s', self.id, exc)
        try:
            self.sudo().ask_manager_to_decide()
        except Exception as exc:
            _logger.warning('could not re-ask the manager for %s: %s',
                            self.id, exc)
        return _(
            "Thanks — %s has gone back for another look with your new "
            "wording. The reference is unchanged."
        ) % (self.external_ref or self.id)

    def _is_refused(self):
        """Refused and still archived -- what the 🚫 Refused list shows."""
        self.ensure_one()
        return bool(not self.active and self.declined_at and self.decline_mode == 'decline')

    def action_restore_declined(self, by_user=None):
        """↩️ Restore from the 🚫 Refused list: back in the client queue, where
        a fresh submission sits, for the admin to publish or refuse again.

        Same writes as the client-fix path (apply_client_correction /
        _resubmit). The refusal itself -- reason, note, who, when, count --
        stays on the task as history. The client is not messaged here: they
        hear the usual notices when it is published."""
        self.ensure_one()
        if not self._is_refused():
            raise ValidationError(_('%s is not a refused request.') % (self.external_ref or self.id))
        user = by_user or self.env.user
        self.sudo().write({
            'active': True,
            'published': False,
            'task_state': 'queue_waiting',
            'admin_accept_deadline_at': False,
            'client_dispute': False,
            'client_reconfirm_state': False,
            # The old fix link stops working; old-DB items stop reading "refused".
            'client_fix_token': False,
            'decline_mode': False,
        })
        # The client's WhatsApp may still be waiting on the refusal question:
        # a late "disagree" or "withdraw" must not act on a restored request.
        Intake = self.env['kpi.wa.group.intake'].sudo()
        for st in Intake.search([('pending_decline_kpi_id', '=', self.id)]):
            st._touch(step='idle' if st.step in ('decline_reconfirm', 'ask_correction') else st.step,
                      pending_decline_kpi_id=False)
        self.sudo()._log_action('restored', source='web', actor_user_id=user.id,
                                payload={'from': 'refused'})
        try:
            self.sudo()._notify('client_task_queued')
            self.sudo()._schedule_queue_nudge()
        except Exception as exc:
            _logger.warning('restore notify failed for %s: %s', self.id, exc)
        try:
            self.sudo().ask_manager_to_decide()
        except Exception as exc:
            _logger.warning('could not re-ask the manager for %s: %s', self.id, exc)
        return True

    # ------------------------------------------------------------------
    def _kind_now(self):
        """Current doc type, derived the way the rest of the module derives it:
        the name prefix first, then the ref prefix."""
        self.ensure_one()
        name = (self.name or '')
        if name.startswith('[Update]'):
            return 'update'
        if name.startswith('[Bug]'):
            return 'bug'
        ref = (self.external_ref or '').upper()
        if ref.startswith('UPT') or ref.startswith('UPD'):
            return 'update'
        if ref.startswith('BUG'):
            return 'bug'
        return 'requirement'

    def action_decline(self, mode='decline', reason_id=None, reason_text='',
                       doc_type=None, notify_group=True):
        """Decline or re-type a queued submission. Returns a result dict."""
        self.ensure_one()
        import re as _re
        from .kpi_workflow import (NAME_PREFIX_FOR_DOC_TYPE,
                                   REF_PREFIX_FOR_DOC_TYPE)

        if mode not in ('decline', 'reclassify'):
            raise ValidationError(_('Unknown mode %s.') % mode)
        if self.published:
            raise ValidationError(_(
                'This task is already published to the team. Use the task '
                'screen rather than the queue.'))

        reason = self.env['kpi.decline.reason'].sudo().browse(
            int(reason_id)) if reason_id else self.env['kpi.decline.reason']
        text = (reason_text or '').strip()
        if reason and reason.exists() and not text:
            text = reason.text_for_client()
        if not text:
            raise ValidationError(_(
                'Give a reason. The whole point of this is that the client is '
                'told why.'))

        old_ref = self.external_ref or ''
        old_kind = self._kind_now()
        vals = {
            'decline_reason_id': reason.id if reason and reason.exists() else False,
            'decline_note': text,
            'declined_at': fields.Datetime.now(),
            'declined_by_id': self.env.user.id,
            'decline_mode': mode,
            'client_reconfirm_state': 'pending',
            'client_dispute': False,
            # Reuse the existing send-back fields so the queue card and the
            # detail pane show this with no UI change.
            'self_review_note': text[:255],
            'self_review_by': self.env.user.name,
        }

        if mode == 'decline':
            # ARCHIVE, never unlink. Also clear the accept deadline so
            # _cron_admin_accept_timeout cannot resurrect it -- that cron keys
            # on active=True, but an admin un-archiving later would otherwise
            # inherit a stale deadline.
            import secrets
            vals.update({
                'active': False,
                'task_state': 'rework',
                'admin_accept_deadline_at': False,
                'decline_count': self.decline_count + 1,
                'client_fix_token': secrets.token_urlsafe(24),
            })
        else:
            target = doc_type or (reason.target_doc_type if reason else None)
            if target not in REF_PREFIX_FOR_DOC_TYPE:
                raise ValidationError(_(
                    'Choose what to re-type it as (Requirement, Update or Bug).'))
            if target == old_kind:
                raise ValidationError(_(
                    'It is already a %s.') % target)
            prefix = REF_PREFIX_FOR_DOC_TYPE[target]
            n = self.env['kra.kpi']._next_ref_for_prefix(prefix)
            base_name = _re.sub(r'^\[(Update|Bug)\]\s*', '', self.name or '',
                                flags=_re.IGNORECASE)
            vals.update({
                'previous_external_ref': old_ref,
                'reclassified_from': old_kind,
                'external_ref': '%s-%03d' % (prefix, n),
                'name': NAME_PREFIX_FOR_DOC_TYPE.get(target, '') + base_name,
                # BACK IN THE QUEUE, not accepted. Re-typing something into
                # billable work is a decision the client has to agree to.
                'published': False,
                'user_id': False,
                'task_state': 'queue_waiting',
            })

        self.sudo().write(vals)
        self.sudo()._log_action(
            'declined' if mode == 'decline' else 'reclassified',
            source='web', actor_user_id=self.env.user.id,
            payload={'mode': mode, 'reason_id': reason.id if reason else False,
                     'reason': text, 'old_ref': old_ref,
                     'new_ref': self.external_ref, 'old_kind': old_kind,
                     'new_kind': doc_type or ''})

        posted = False
        if notify_group:
            posted = self._post_decline_to_group(mode, text, old_ref)
            self._arm_client_reconfirm()
            if mode == 'decline':
                self._post_fix_link()

        return {
            'status': True,
            'mode': mode,
            'posted_to_group': posted,
            'external_ref': self.external_ref,
            'previous_external_ref': self.previous_external_ref or '',
        }

    # ------------------------------------------------------------------
    def _post_decline_to_group(self, mode, text, old_ref):
        """Tell the client, in their own group, as a TAPPABLE question.

        This used to be plain text ending "reply 1 if that is OK, 2 if you
        disagree" -- the only question in the whole bot that asked somebody to
        type a digit, because this file had no poll path. A client has no way
        to know that one message works differently from every other, and a
        typed answer is where people reply with a sentence instead.

        It also offers a third answer that did not exist at all: send the
        corrected version. "Not enough detail to act on" was a dead end -- the
        client could agree or disagree with the refusal, but could not supply
        the detail being asked for.

        The reference leads every option, because a poll vote carries only the
        visible label. With two refusals open in one group, "OK" alone could
        not say which was meant.
        """
        self.ensure_one()
        Report = self.env['kpi.wa.group.report'].sudo()
        ref = old_ref or self.external_ref or ('#%s' % self.id)
        if mode == 'decline':
            question = _(
                "*Not taken forward*\n"
                "%(ref)s — %(title)s\n\n"
                "%(reason)s"
            ) % {'ref': ref, 'title': self.name or '', 'reason': text}
            options = [
                '✅ %s — OK' % ref,
                '✏️ %s — Send a correction' % ref,
                '❌ %s — I disagree' % ref,
            ]
        else:
            question = _(
                "*Re-classified*\n"
                "%(old)s is now *%(new)s*\n"
                "%(title)s\n\n"
                "%(reason)s"
            ) % {'old': ref, 'new': self.external_ref or '',
                 'title': self.name or '', 'reason': text}
            options = [
                '✅ %s — Go ahead' % ref,
                '❌ %s — I disagree' % ref,
            ]
        try:
            if Report.post_poll_for_kpi(self, question, options):
                return True
            # No poll got out. Say it in words rather than saying nothing --
            # the client still has to be told their request was refused.
            return bool(Report.post_for_kpi(self, '%s\n\n%s' % (
                question, _('Reply *1* if that is OK, *2* to send a '
                            'correction, *3* if you disagree.'))))
        except Exception as exc:
            _logger.warning('Could not post decline for %s: %s',
                            self.external_ref or self.id, exc)
            return False

    def fix_url(self):
        self.ensure_one()
        if not self.client_fix_token:
            return ''
        base = self.env['whatsapp.config'].sudo().get_config().get_kpi_public_base_url()
        return '%s/kpi/wa/fix/%s' % (base, self.client_fix_token)

    def _post_fix_link(self):
        """The same form, already filled in, to fix and send it back."""
        self.ensure_one()
        url = self.fix_url()
        if not url:
            return False
        try:
            return bool(self.env['kpi.wa.group.report'].sudo().post_for_kpi(self, _(
                "✏️ To fix %(ref)s, open the same form — your earlier answers are "
                "already filled in. Change what is needed (you can also change "
                "the type) and send it again:\n%(url)s") % {
                    'ref': self.external_ref or '#%s' % self.id, 'url': url}))
        except Exception as exc:
            _logger.warning('Could not post fix link for %s: %s', self.id, exc)
            return False

    def _next_child_number(self, prefix, parent_ref):
        """Next N for <PREFIX>NNN-<parent_ref>, counted per requirement.
        Archived tasks and retired refs count, so a number is never reused.
        Shared by the WhatsApp form and the portal."""
        import re as _re
        Kpi = self.env['kra.kpi'].sudo().with_context(active_test=False)
        pat = '%s%%-%s' % (prefix, parent_ref)
        rx = _re.compile(r'^%s(\d{1,9})-%s$' % (_re.escape(prefix), _re.escape(parent_ref)), _re.I)
        nums = [0]
        for k in Kpi.search(['|', ('external_ref', '=ilike', pat),
                             ('previous_external_ref', '=ilike', pat)]):
            for r in (k.external_ref, k.previous_external_ref):
                m = rx.match((r or '').strip())
                if m:
                    nums.append(int(m.group(1)))
        return max(nums) + 1

    def _arm_client_reconfirm(self):
        """Put the submitter's group conversation into the re-confirm step, so
        their next '1' or '2' is read as an answer to THIS decision."""
        self.ensure_one()
        try:
            grp = self.env['kpi.wa.group.report'].sudo()._group_for_kpi(self)
            if not grp:
                return False
            Intake = self.env['kpi.wa.group.intake'].sudo()
            member = False
            if self.submitted_by_uid:
                member = self.env['kpi.wa.group.member'].sudo().search(
                    [('group_id', '=', grp.id),
                     ('user_id', '=', self.submitted_by_uid.id)], limit=1)
            key = (member.lid or member.phone) if member else False
            if not key:
                # No identified submitter: anyone in the group may answer.
                # Better than silently dropping the question.
                return False
            state = Intake._get_or_create(grp, key, member.wa_name or '')
            state._touch(step='decline_reconfirm',
                         pending_decline_kpi_id=self.id)
            return True
        except Exception as exc:
            _logger.warning('Could not arm re-confirmation for %s: %s',
                            self.external_ref or self.id, exc)
            return False

    # ------------------------------------------------------------------
    def apply_client_reconfirm(self, answer, actor_label=''):
        """Record the client's answer. `answer` in {'accept','dispute','withdraw'}."""
        self.ensure_one()
        if answer == 'correct':
            # Nothing changes on the task yet. The client has said they WANT
            # to correct it; the correction itself is their next message, and
            # until it arrives the refusal stands exactly as it was.
            self.sudo().write({'client_reconfirm_state': 'pending'})
            return _(
                "Send the corrected version as your next message and I will "
                "pass it back for another look. %s keeps its reference."
            ) % (self.external_ref or self.id)

        if answer == 'accept':
            self.sudo().write({'client_reconfirm_state': 'accepted',
                               'client_dispute': False})
            msg = _("Thanks — noted.")
        elif answer == 'withdraw':
            self.sudo().write({'client_reconfirm_state': 'withdrawn',
                               'active': False})
            msg = _("Closed. Send *hi* any time to raise something new.")
        else:
            # Disputed: bring it back and make the disagreement visible. A
            # dispute must land on a human's desk, not sit in an archive.
            self.sudo().write({
                'client_reconfirm_state': 'disputed',
                'client_dispute': True,
                'active': True,
                'published': False,
                'task_state': 'queue_waiting',
                'self_review_note': ('[CLIENT DISAGREED] %s'
                                     % (self.decline_note or ''))[:255],
            })
            try:
                self.sudo()._notify('client_task_queued')
                self.sudo()._schedule_queue_nudge()
            except Exception as exc:
                _logger.warning('dispute re-queue notify failed: %s', exc)
            msg = _("Noted — I've put it back for the team to look at again.")
        self.sudo()._log_action(
            'client_reconfirm', source='whatsapp',
            actor_label=actor_label or '', payload={'answer': answer})
        return msg
