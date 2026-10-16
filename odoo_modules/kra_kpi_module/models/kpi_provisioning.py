"""New-database requests: the extra fields and the provisioning checklist.

The request is an ordinary `kra.kpi` with `doc_type='requirement'`, so it
inherits the queue, assignment, time logging, audit and invoicing. What marks
it out is `request_category`, an ORTHOGONAL field.

WHY NOT A NEW DOC TYPE
----------------------
Type is not a column in this module -- it lives in the `external_ref` prefix
plus the name prefix, and that convention is duplicated across nine literal
maps, ~12 Python kind-derivations, ~8 JS sites and the invoice's
price_req/upt/bug columns. Worse, `_auto_admin_accept` re-derives the type by
regex on the NAME prefix, so an unknown type silently becomes 'requirement'
on the cron path -- the classification would be destroyed five minutes after
it was made. An orthogonal field touches none of that.

The `[New DB] ` name prefix is safe: `_auto_admin_accept` only strips
`[Update]` / `[Bug]`, so it survives the accept rewrite intact.

WHY SEVEN BOOLEANS AND NOT A CHILD MODEL
----------------------------------------
`employee_checklist_*` and `manager_checklist_*` already set the pattern, and
the surrounding machinery -- the backup export, the detail serialisers, the
action screen -- is all shaped around flat Booleans. `kpi.checklist.master`
is NOT an alternative despite the name: `kra.kpi.checklist` is a plain Text
field and the master only populates that blob. There is no per-item tick, no
actor, no timestamp. Per-step who/when comes from `kpi.action.log` instead.
"""

import logging

from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

_logger = logging.getLogger(__name__)

PROVISION_STEPS = [
    ('provision_chk_db_created', 'Database created on the agreed server'),
    ('provision_chk_modules_installed', 'Requested modules installed'),
    ('provision_chk_company_set', 'Company, branding and tax details set'),
    ('provision_chk_users_created', 'Users created and credentials issued'),
    ('provision_chk_data_loaded', 'Opening data loaded'),
    ('provision_chk_backup_configured', 'Backup configured and verified'),
    ('provision_chk_handed_over', 'Handed over; shop confirmed access'),
    # The eighth step is what makes the database exist to the rest of the
    # system: until it is in kpi.client.db, the WhatsApp menus cannot offer it
    # and nothing tracks whether it is still live. Ticking it creates the row.
    ('provision_chk_registered', 'Added to the client database list'),
]
PROVISION_FIELDS = [f for f, _l in PROVISION_STEPS]
PROVISION_LABEL = dict(PROVISION_STEPS)


class KraKpiProvisioning(models.Model):
    _inherit = 'kra.kpi'

    request_category = fields.Selection([
        ('standard', 'Standard'),
        ('new_database', 'New Database'),
    ], default='standard', index=True, string='Request Category',
        help="Orthogonal to Requirement / Update / Bug. 'new_database' "
             "switches on the provisioning fields and checklist below.")

    provision_server_id = fields.Many2one(
        'kpi.server', string='Server', ondelete='restrict')
    provision_server_other = fields.Char(
        string='Server (not listed)',
        help='Typed by the requester when the server was not on the menu. '
             'Promote it to the server list from here if it is real.')
    provision_db_name = fields.Char(string='Database Name', index=True)
    provision_preset = fields.Char(string='Install Preset')
    provision_modules = fields.Text(string='Requested Modules')

    provision_chk_db_created = fields.Boolean('Database created')
    provision_chk_modules_installed = fields.Boolean('Modules installed')
    provision_chk_company_set = fields.Boolean('Company / branding set')
    provision_chk_users_created = fields.Boolean('Users created')
    provision_chk_data_loaded = fields.Boolean('Opening data loaded')
    provision_chk_backup_configured = fields.Boolean('Backup configured')
    provision_chk_handed_over = fields.Boolean('Handed over')
    provision_chk_registered = fields.Boolean('Registered in database list')

    provision_progress = fields.Integer(
        string='Provisioning', compute='_compute_provision_progress',
        store=True, help='How many of the seven steps are done.')
    provision_server_label = fields.Char(
        compute='_compute_provision_server_label')

    @api.depends(*PROVISION_FIELDS)
    def _compute_provision_progress(self):
        for rec in self:
            rec.provision_progress = sum(
                1 for f in PROVISION_FIELDS if rec[f])

    @api.depends('provision_server_id', 'provision_server_other')
    def _compute_provision_server_label(self):
        for rec in self:
            rec.provision_server_label = (
                rec.provision_server_id.name or rec.provision_server_other or '')

    # ------------------------------------------------------------------
    def set_provision_step(self, field, value):
        """Tick or untick one step, and record who did it.

        Saved immediately rather than on submit: the whole point is that
        progress is visible WHILE it happens, not after.
        """
        self.ensure_one()
        if field not in PROVISION_FIELDS:
            raise ValidationError(_('Unknown provisioning step.'))

        # Registering the database happens BEFORE the tick is stored, so a
        # failure (an unusable name, no server on the ticket) leaves the step
        # unticked rather than claiming a registration that did not happen.
        registered = ''
        if field == 'provision_chk_registered' and value:
            row = self.env['kpi.client.db'].sudo().register_from_kpi(self)
            if not row:
                raise ValidationError(_(
                    'This ticket does not name both a server and a database '
                    'name, so there is nothing to register. Fill those in '
                    'first.'))
            registered = row.display_name
        # Unticking never deletes the kpi.client.db row. The database either
        # exists on the server or it does not, and that is not something a
        # checkbox on a ticket gets to decide retroactively.

        self.sudo().write({field: bool(value)})
        self.sudo()._log_action(
            'provision_step', source='web', actor_user_id=self.env.user.id,
            payload={'step': field, 'on': bool(value),
                     'registered': registered,
                     'progress': self.provision_progress})
        return {'status': True, 'progress': self.provision_progress,
                'total': len(PROVISION_FIELDS),
                'registered': registered}

    def provision_payload(self):
        """What the action screen needs to draw the card."""
        self.ensure_one()
        return {
            'category': self.request_category,
            'server': self.provision_server_label,
            'db_name': self.provision_db_name or '',
            'preset': self.provision_preset or '',
            'modules': self.provision_modules or '',
            'progress': self.provision_progress,
            'total': len(PROVISION_FIELDS),
            'steps': [{'field': f, 'label': l, 'done': bool(self[f])}
                      for f, l in PROVISION_STEPS],
        }

    # ------------------------------------------------------------------
    def complete_task(self, employee_checklist=None):
        """Refuse to complete a provisioning task with steps outstanding.

        Enforced in Python, not only in the UI, because the web pane and the
        mobile app both call this. Guarded against the two-step deploy where
        the .py loads before the column exists.
        """
        for rec in self:
            try:
                if (rec.request_category == 'new_database'
                        and rec.provision_progress < len(PROVISION_FIELDS)):
                    raise ValidationError(_(
                        'Tick all %(total)s provisioning steps first — '
                        '%(done)s done.') % {
                            'total': len(PROVISION_FIELDS),
                            'done': rec.provision_progress})
            except ValidationError:
                raise
            except Exception:
                # Column not there yet (upgrade in flight). Never let a schema
                # race stop somebody completing ordinary work.
                _logger.debug('provisioning gate skipped: schema not ready')
        return super().complete_task(employee_checklist=employee_checklist)
