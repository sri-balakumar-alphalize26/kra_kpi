"""Who decides about this task, and can we actually reach them.

THE RULE THIS SERVES
--------------------
No developer talks to a client. No client talks to a developer. One person --
the manager -- stands between them, approves the work, and carries every
question across in either direction.

For that rule to mean anything, two questions have to have an answer for every
single task: WHO is the manager, and HOW do we reach them. Neither had one
before this. `kra.master` had no responsible person, `kra.kpi` had no manager
field, and the notification path resolved recipients by group membership
company-wide -- so "the manager" meant "every coordinator", which on this
database means nobody at all.

WHY THE ANSWER IS NOT CACHED ON THE TASK
----------------------------------------
A stored computed field would be the obvious shortcut and is a trap here. The
walk is recursive (task -> kra -> parent -> parent -> ...), so @api.depends
cannot express it; keeping a stored copy correct would mean recomputing every
task under a subtree whenever anybody edits the tree. A manager who is stale
by one write is a message delivered to the wrong person, which is the one
failure this whole feature exists to prevent. The walk is a handful of reads
against an indexed parent_id -- cheap enough to just do it.

REACHABILITY IS A SEPARATE QUESTION, DELIBERATELY
-------------------------------------------------
`_manager_users()` answers "who". `_manager_wa_targets()` answers "who can be
sent a WhatsApp". They are kept apart because the second can legitimately be
empty while the first is not, and the caller must be able to tell those two
situations apart: an unreachable manager falls back to another channel, while
no manager at all is a configuration fault that needs saying out loud.
"""

import logging
import threading

from odoo import SUPERUSER_ID, _, api, fields, models

_logger = logging.getLogger(__name__)


def _announce_in_background(dbname, ids):
    """Thread body: post the team-group announcement with a fresh cursor."""
    try:
        from odoo.modules.registry import Registry
        with Registry(dbname).cursor() as cr:
            env = api.Environment(cr, SUPERUSER_ID, {})
            env['kra.kpi'].browse(ids).exists()._announce_assignment()
    except Exception as exc:
        _logger.warning('assignment announcement failed for %s: %s', ids, exc)


class KraKpiManager(models.Model):
    _inherit = 'kra.kpi'

    def _manager_users(self):
        """Who may decide about this task, best first. Never raises.

        Order:
          1. the nearest node up the KRA tree with a manager set
          2. the client node's manager, in case the branch above it is archived
          3. every Coordinator
          4. every Owner
          5. nobody -- logged, never silently swallowed
        """
        self.ensure_one()
        Users = self.env['res.users']

        for node in (self.kra_id, self.client_kra_id):
            if node:
                found = node.sudo().resolve_manager()
                if found:
                    return found

        # all_user_ids, NOT user_ids. Explicit membership only would miss
        # every owner and system administrator, who hold the coordinator
        # group by implication -- which is how most people here hold it.
        for xmlid in ('kra_kpi_module.group_kra_admin',
                      'kra_kpi_module.group_kra_owner'):
            group = self.env.ref(xmlid, raise_if_not_found=False)
            if group:
                people = group.sudo().all_user_ids.filtered(
                    lambda u: u.active and not u.share)
                if people:
                    return people

        _logger.warning(
            'kra.kpi %s (%s): no manager could be resolved -- no manager on '
            'the KRA tree and nobody holds Coordinator or Owner. The request '
            'stands on the Approvals desk and nothing was sent.',
            self.id, self.external_ref or self.name or '?')
        try:
            self.sudo()._log_action(
                'manager_unresolved', source='system',
                payload={'kra': self.kra_id.name or '',
                         'client': self.client_kra_id.name or ''})
        except Exception:
            pass
        return Users

    assignment_announced_at = fields.Datetime(
        string='Announced To The Team', readonly=True, copy=False,
        help='When the internal group was told who picked this up. Stops the '
             'same assignment being announced twice.')

    def _announce_assignment(self):
        """Tell the INTERNAL GROUP who a task went to.

        The team group, not a private message to the developer. Everyone
        should be able to see who picked up what without asking, and the bot
        does not message developers privately at all -- which is also the
        only thing that works, since the numbers we hold for staff came from
        the group member list in the first place.

        Hooked on write() rather than called from the two places that assign,
        so the web Approvals desk and the WhatsApp approval both announce,
        and so does anybody who sets the assignee by hand.
        """
        Report = self.env['kpi.wa.group.report'].sudo()
        for rec in self:
            if not rec.user_id or rec.assignment_announced_at:
                continue
            ref = rec.external_ref or ('#%s' % rec.id)
            body = _(
                '🧑‍💻 *%(ref)s* → %(dev)s\n'
                '%(title)s\n'
                '%(client)s\n'
                'Send *hi* here to take it, pause it or ask something.'
            ) % {'ref': ref, 'dev': rec.user_id.name or '',
                 'title': rec.name or '',
                 'client': rec.client_kra_id.name or ''}
            try:
                if Report._post(body):
                    rec.sudo().assignment_announced_at = fields.Datetime.now()
            except Exception as exc:
                _logger.warning('could not announce %s to the team: %s',
                                ref, exc)
        return True

    def write(self, vals):
        res = super().write(vals)
        # Only on the transition into being assigned. 'user_id' in vals is
        # not enough on its own -- clearing an assignee also writes that key.
        #
        # Posted AFTER the commit, once per transaction. Posting inside the
        # request meant a serialization retry (Odoo re-runs the whole request)
        # sent the same announcement twice -- REQ-010, 22 Oct 2026.
        if vals.get('user_id'):
            ids = self.filtered(lambda r: r.user_id and not r.assignment_announced_at).ids
            if ids:
                pending = self.env.cr.postcommit.data.setdefault('kpi_announce_ids', set())
                first = not pending
                pending.update(ids)
                if first:
                    dbname = self.env.cr.dbname

                    def _start():
                        threading.Thread(target=_announce_in_background,
                                         args=(dbname, sorted(pending)), daemon=True).start()
                    self.env.cr.postcommit.add(_start)
        return res

    def _manager_wa_targets(self):
        """[(user, digits)] for the managers we can actually message.

        A manager with no usable number is left OUT rather than returned with
        an empty string: every caller would otherwise have to remember to
        check, and the one that forgot would send to '' and report success.
        """
        self.ensure_one()
        out = []
        for user in self._manager_users():
            digits = user._kpi_wa_target()
            if digits:
                out.append((user, digits))
            else:
                _logger.info(
                    'kra.kpi %s: manager %s has no WhatsApp number.',
                    self.external_ref or self.id, user.login)
        return out


class KraMasterManagerHelpers(models.Model):
    _inherit = 'kra.master'

    manager_ready = fields.Boolean(
        string='Manager Reachable', compute='_compute_manager_ready',
        help="False when this client has a manager who cannot be messaged on "
             "WhatsApp, or no manager at all. Approvals still appear on the "
             "Approvals desk; they just do not reach anybody's phone.")

    @api.depends('manager_user_id', 'manager_user_id.kpi_wa_number',
                 'manager_user_id.kpi_mobile_number',
                 'manager_user_id.partner_id.phone')
    def _compute_manager_ready(self):
        for rec in self:
            user = rec.manager_user_id
            rec.manager_ready = bool(user and user._kpi_wa_target())

    @api.model
    def manager_coverage(self):
        """How much of this is actually set up. For the Approvals banner.

        Counting it is the point: every fallback in _manager_users ends
        somewhere sane, so a half-configured system does not break -- it just
        quietly stops sending, which is far worse than breaking.
        """
        clients = self.sudo().search([('is_client', '=', True)])
        no_manager = clients.filtered(lambda c: not c.resolve_manager())
        unreachable = clients.filtered(
            lambda c: c.resolve_manager()
            and not any(u._kpi_wa_target() for u in c.resolve_manager()))
        group = self.env.ref('kra_kpi_module.group_kra_admin',
                             raise_if_not_found=False)
        coordinators = group.sudo().all_user_ids.filtered(
            lambda u: u.active and not u.share) if group else self.env['res.users']
        return {
            'clients': len(clients),
            'clients_without_manager': len(no_manager),
            'clients_unreachable': len(unreachable),
            'coordinators': len(coordinators),
            'coordinators_without_number': len(
                coordinators.filtered(lambda u: not u._kpi_wa_target())),
            'names_without_manager': no_manager.mapped('name')[:10],
            # "Sri Balakumar (Nexgennpos)" — who to fix, not just how many.
            'names_unreachable': [
                '%s (%s)' % (', '.join(c.resolve_manager().mapped('name')), c.name)
                for c in unreachable[:10]],
        }

    @api.model
    def manager_coverage_message(self):
        """The coverage problems in plain words, or '' when there are none.

        One wording for both screens: the web Approvals banner and the
        notification Odoo's Approvals menu shows (kpi.approval.action_open_desk).

        The two cases are NOT the same and must not be described alike:
          * no manager at all -> _manager_users falls back to every
            Coordinator (then Owner), so the request does reach people;
          * a manager who cannot be messaged -> that manager IS the answer,
            _manager_wa_targets drops them for want of a number, and nothing
            reaches anybody's phone. It only waits on the Approvals desk.
        """
        cov = self.manager_coverage()
        parts = []
        if cov['clients_without_manager']:
            n = cov['clients_without_manager']
            names = ', '.join(cov['names_without_manager'])
            parts.append(_('%(n)s client%(s)s no manager%(names)s: approval requests go to every coordinator.') % {
                'n': n, 's': ' has' if n == 1 else 's have',
                'names': (' (%s)' % names) if names else ''})
        if cov['clients_unreachable']:
            n = cov['clients_unreachable']
            names = '; '.join(cov['names_unreachable'])
            parts.append(_('%(n)s manager%(s)s no WhatsApp number%(names)s: approval requests wait on the '
                           'Approvals desk but reach nobody\'s phone. Add a mobile in Login Management.') % {
                'n': n, 's': ' has' if n == 1 else 's have',
                'names': (' (%s)' % names) if names else ''})
        return ' '.join(parts)
