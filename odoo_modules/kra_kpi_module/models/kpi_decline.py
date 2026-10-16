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
    ], readonly=True, copy=False, index=True)

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
            vals.update({
                'active': False,
                'task_state': 'rework',
                'admin_accept_deadline_at': False,
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

        return {
            'status': True,
            'mode': mode,
            'posted_to_group': posted,
            'external_ref': self.external_ref,
            'previous_external_ref': self.previous_external_ref or '',
        }

    # ------------------------------------------------------------------
    def _post_decline_to_group(self, mode, text, old_ref):
        """Tell the client, in their own group, naming the task."""
        self.ensure_one()
        Report = self.env['kpi.wa.group.report'].sudo()
        if mode == 'decline':
            body = _(
                "*Not taken forward*\n"
                "%(ref)s — %(title)s\n\n"
                "%(reason)s\n\n"
                "Reply *1* if that is OK, *2* if you disagree."
            ) % {'ref': old_ref or self.id, 'title': self.name or '',
                 'reason': text}
        else:
            body = _(
                "*Re-classified*\n"
                "%(old)s is now *%(new)s*\n"
                "%(title)s\n\n"
                "%(reason)s\n\n"
                "Reply *1* to go ahead, *2* if you disagree."
            ) % {'old': old_ref or '—', 'new': self.external_ref or '',
                 'title': self.name or '', 'reason': text}
        try:
            return bool(Report.post_for_kpi(self, body))
        except Exception as exc:
            _logger.warning('Could not post decline for %s: %s',
                            self.external_ref or self.id, exc)
            return False

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
