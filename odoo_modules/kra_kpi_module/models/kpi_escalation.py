"""Approval chain for new client requests (call notes, Oct 2026).

A new client request (requirement / bug / update / new database / destroy)
first goes to tier 1. If nobody there decides within that tier's minutes, the
decision link goes to tier 2, then 3, then 4. After the last tier nothing is
accepted automatically: the last tier is reminded every LAST_TIER_REMIND_MIN
until somebody decides. Anyone who got a link can decide at any time.

Tiers are records (kpi.escalation.tier) so the people, the names and the
minutes are set in Settings. A tier with no people and "Task's manager" ticked
uses the task's own managers (kpi_manager._manager_users), which is what the
decision link used before this existed.

No tiers at all = the old behaviour (every manager at once).
"""

import logging
from datetime import timedelta

from odoo import api, fields, models

_logger = logging.getLogger(__name__)

LAST_TIER_REMIND_MIN = 30
# Which decisions climb the chain. Finished work (qa) and a developer's own
# task (self_task) keep going to the task's managers straight away.
CHAIN_KINDS = ('new_request', 'new_database', 'disconnect')


class KpiEscalationTier(models.Model):
    _name = 'kpi.escalation.tier'
    _description = 'Approval chain tier'
    _order = 'sequence, id'

    name = fields.Char(required=True, help='e.g. Manager, Owner / CEO, Senior')
    sequence = fields.Integer(default=10)
    minutes = fields.Integer(default=5, help='How long this tier has before the next one is asked.')
    user_ids = fields.Many2many('res.users', 'kpi_escalation_tier_user_rel',
                                'tier_id', 'user_id', string='People',
                                domain=[('share', '=', False)])
    use_task_manager = fields.Boolean(
        string="Task's manager",
        help="Also ask the task's own manager (the KRA tree manager, then coordinators, then owners).")
    active = fields.Boolean(default=True)

    @api.model
    def chain(self):
        return self.sudo().search([])


class KraKpiEscalation(models.Model):
    _inherit = 'kra.kpi'

    esc_tier_id = fields.Many2one('kpi.escalation.tier', string='Approval Tier',
                                  copy=False, ondelete='set null', readonly=True)
    esc_due_at = fields.Datetime(string='Next Tier At', copy=False, index=True, readonly=True)

    def _esc_tier_users(self, tier):
        self.ensure_one()
        users = tier.user_ids.filtered(lambda u: u.active)
        if tier.use_task_manager or not users:
            users |= self._manager_users()
        return users.filtered(lambda u: u._kpi_wa_target())

    def _esc_needs_decision(self):
        """Still waiting for an admin? (accepted = published; refused = archived)"""
        self.ensure_one()
        if not self.active:
            return False
        if self.request_category == 'db_disconnect':
            db = self.env['kpi.client.db'].sudo().search(
                [('disconnect_request_kpi_id', '=', self.id)], limit=1) or self.client_db_id
            return bool(db) and db.disconnect_state == 'requested'
        return not self.published and not self.admin_accepted

    def _esc_start(self, kind):
        """Ask tier 1. Returns the users asked, or None when there is no chain."""
        self.ensure_one()
        tiers = self.env['kpi.escalation.tier'].chain()
        if not tiers or kind not in CHAIN_KINDS:
            return None
        return self._esc_ask(tiers[0], kind)

    def _esc_ask(self, tier, kind):
        self.ensure_one()
        users = self._esc_tier_users(tier)
        tiers = self.env['kpi.escalation.tier'].chain()
        last = tier == tiers[-1:]
        wait = max(tier.minutes, 1) if not last else max(tier.minutes, LAST_TIER_REMIND_MIN)
        self.sudo().write({'esc_tier_id': tier.id,
                           'esc_due_at': fields.Datetime.now() + timedelta(minutes=wait)})
        self.sudo()._wa_send_admin_links(kind, users)
        self.sudo()._log_action('approval_tier', source='cron', payload={
            'tier': tier.name, 'users': users.mapped('name'), 'kind': kind})
        return users

    @api.model
    def _cron_escalate_tiers(self):
        """Every minute: move undecided requests up one tier."""
        now = fields.Datetime.now()
        due = self.sudo().search([('esc_due_at', '!=', False), ('esc_due_at', '<=', now)],
                                 limit=100)
        tiers = self.env['kpi.escalation.tier'].chain()
        moved = 0
        for rec in due:
            try:
                if not rec._esc_needs_decision() or not tiers:
                    rec.write({'esc_due_at': False})
                    continue
                kind = rec._wa_admin_kind()
                after = tiers.filtered(lambda t: (t.sequence, t.id) > (
                    rec.esc_tier_id.sequence, rec.esc_tier_id.id)) if rec.esc_tier_id else tiers
                # Past the last tier: remind the last one again. Never auto-accept.
                rec._esc_ask(after[:1] or tiers[-1:], kind)
                moved += 1
            except Exception as exc:
                _logger.warning('approval chain step failed for %s: %s', rec.id, exc)
        return moved
