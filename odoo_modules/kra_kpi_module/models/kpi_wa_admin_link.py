"""Admin decisions over WhatsApp: a private link per admin, per decision.

When something needs an admin -- a new client request, a developer's own task,
finished work to check, a New Database or a Destroy request -- every admin who
manages it gets a private one-use link on WhatsApp (/kpi/wa/admin/<token>,
controllers/kpi_wa_admin_decide.py). The page shows the details and the same
choices the web admin has, and the decision runs through the SAME routes the
web calls, so the two can never disagree.

A link is a key, not the state: the page always re-reads the task, so a
decision made on the web (or by another admin) shows as "already handled".

Sent with explicit calls from the places each event is raised, not through
kra.kpi._notify: its WhatsApp leg is switched off by default and turning it on
would change every other message as well.
"""

import logging
import secrets
from datetime import timedelta

from odoo import _, api, fields, models

_logger = logging.getLogger(__name__)

LINK_TTL_HOURS = 48
PARAM_ENABLED = 'kra_kpi.admin_wa_decisions'   # '0' switches the messages off

KINDS = [
    ('new_request', 'New client request'),
    ('new_database', 'New database'),
    ('disconnect', 'Destroy a database'),
    ('self_task', "Developer's own task"),
    ('qa', 'Finished work to check'),
]
_INTRO = {
    'new_request': '🆕 *New client request*',
    'new_database': '🗄️ *New Database request*',
    'disconnect': '💥 *Destroy Database request*',
    'self_task': '🧑‍💻 *Developer created a task*',
    'qa': '✅ *Work finished — please check it*',
}
_ACTION = {
    'new_request': 'Accept or refuse',
    'new_database': 'Approve or refuse',
    'disconnect': 'Destroy or refuse',
    'self_task': 'Accept or send back',
    'qa': 'Approve or send back',
}


def _is_admin(user):
    return bool(user) and (user.has_group('kra_kpi_module.group_kra_admin')
                           or user.has_group('kra_kpi_module.group_kra_owner')
                           or user.has_group('base.group_system'))


class KpiWaAdminLink(models.Model):
    _name = 'kpi.wa.admin.link'
    _description = 'WhatsApp admin decision link'
    _order = 'id desc'

    token = fields.Char(required=True, index=True, copy=False)
    kpi_id = fields.Many2one('kra.kpi', required=True, ondelete='cascade', index=True)
    kind = fields.Selection(KINDS, required=True, index=True)
    user_id = fields.Many2one('res.users', required=True, ondelete='cascade',
                              help='The admin this link was sent to.')
    expires = fields.Datetime(required=True)
    used_at = fields.Datetime(copy=False)
    decided_by_id = fields.Many2one('res.users', copy=False)
    decision = fields.Char(copy=False)

    _token_uniq = models.Constraint('unique(token)', 'Link tokens are unique.')

    # ------------------------------------------------------------------
    def _db(self):
        """The database a Destroy request is about."""
        self.ensure_one()
        Db = self.env['kpi.client.db'].sudo()
        db = Db.search([('disconnect_request_kpi_id', '=', self.kpi_id.id)], limit=1)
        return db or self.kpi_id.client_db_id

    def _still_open(self):
        """Does the task still need THIS decision? Re-read every time."""
        self.ensure_one()
        k = self.kpi_id.sudo()
        if not k.exists() or not k.active:
            return False
        if self.kind in ('new_request', 'new_database'):
            return not k.published and not k.admin_accepted
        if self.kind == 'disconnect':
            db = self._db()
            return bool(db) and db.disconnect_state == 'requested'
        if self.kind == 'self_task':
            return bool(k.is_self_created) and not k.admin_accepted
        if self.kind == 'qa':
            return k.task_state == 'partially_completed' and not k.admin_approved
        return False

    def _close_all(self, decision, user):
        """Every admin's link for this task and decision stops working."""
        self.ensure_one()
        self.sudo().search([('kpi_id', '=', self.kpi_id.id), ('kind', '=', self.kind),
                            ('used_at', '=', False)]).write({
            'used_at': fields.Datetime.now(), 'decided_by_id': user.id,
            'decision': decision})

    def _last_decision(self):
        """Who decided, when it was decided here. Empty when it was the web."""
        self.ensure_one()
        return self.sudo().search([('kpi_id', '=', self.kpi_id.id), ('kind', '=', self.kind),
                                   ('used_at', '!=', False)], limit=1, order='used_at desc')


class KraKpiAdminWa(models.Model):
    _inherit = 'kra.kpi'

    def _wa_admin_recipients(self):
        """The admins who manage this task and can be reached on WhatsApp.
        The task's own manager first (kpi_manager._manager_users); when that is
        not an admin, every coordinator / owner."""
        self.ensure_one()
        users = self._manager_users().filtered(_is_admin)
        if not users:
            for xmlid in ('kra_kpi_module.group_kra_admin', 'kra_kpi_module.group_kra_owner'):
                grp = self.env.ref(xmlid, raise_if_not_found=False)
                if grp:
                    grp = grp.sudo()
                    users |= grp.all_user_ids if 'all_user_ids' in grp._fields else grp.user_ids
            users = users.filtered(lambda u: u.active and not u.share)
        return users.filtered(lambda u: u._kpi_wa_target())

    def _wa_admin_kind(self):
        """Which decision a fresh client ticket needs."""
        self.ensure_one()
        cat = getattr(self, 'request_category', 'standard')
        return {'new_database': 'new_database', 'db_disconnect': 'disconnect'}.get(cat, 'new_request')

    def _wa_admin_summary(self, kind):
        self.ensure_one()
        client = (self.client_kra_id or self.kra_id).name or ''
        parts = [self.name or '', client]
        if self.client_db_id:
            parts.append('DB %s' % (self.client_db_id.db_name or ''))
        if kind in ('new_request', 'self_task'):
            parts.append(dict(self._fields['priority'].selection).get(self.priority, self.priority or ''))
        if kind in ('self_task', 'qa') and self.user_id:
            parts.append('by %s' % self.user_id.name)
        return ' · '.join(p for p in parts if p)

    def _wa_ask_admins(self, kind=None):
        """Send each managing admin a private link to decide. Never raises."""
        ICP = self.env['ir.config_parameter'].sudo()
        if ICP.get_param(PARAM_ENABLED, '1') in ('0', 'false', 'False', ''):
            return 0
        sent = 0
        for rec in self.sudo():
            try:
                k = kind or rec._wa_admin_kind()
                base = self.env['whatsapp.config'].sudo().get_config().get_kpi_public_base_url()
                Link = self.env['kpi.wa.admin.link'].sudo()
                Report = self.env['kpi.wa.group.report'].sudo()
                for admin in rec._wa_admin_recipients():
                    link = Link.create({
                        'token': secrets.token_urlsafe(24), 'kpi_id': rec.id, 'kind': k,
                        'user_id': admin.id,
                        'expires': fields.Datetime.now() + timedelta(hours=LINK_TTL_HOURS)})
                    text = _('%(intro)s — %(ref)s\n%(summary)s\n\n👉 %(action)s: %(url)s\n'
                             '_Only for you · works once · %(ttl)sh_') % {
                        'intro': _INTRO[k], 'ref': rec.external_ref or '#%s' % rec.id,
                        'summary': rec._wa_admin_summary(k), 'action': _ACTION[k],
                        'url': '%s/kpi/wa/admin/%s' % (base, link.token), 'ttl': LINK_TTL_HOURS}
                    if Report.post_text_to_user(admin, text):
                        sent += 1
            except Exception as exc:
                _logger.warning('admin WhatsApp link for %s failed: %s', rec.id, exc)
        return sent
