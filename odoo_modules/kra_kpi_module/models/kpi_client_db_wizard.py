"""Suspend / disconnect / refuse, with the reason captured in the same act.

WHY A WIZARD AND NOT A PLAIN BUTTON
-----------------------------------
Every one of these state changes is told to the client, so every one of them
needs wording. A bare `<button name="action_disconnect">` cannot carry an
argument, and a reason typed into the record first and acted on second is a
reason that gets left blank -- which is the exact failure the decline flow was
built to end: `/kpi_pending_queue/delete` accepted a `reason` and stored it
nowhere.

So the reason is a required field on the step that performs the action. There
is no path to 'disconnected' that does not pass through here or through the
client's own request.
"""

import logging

from odoo import _, api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

MODES = [
    ('suspend', 'Suspend'),
    ('disconnect', 'Disconnect'),
    ('reject', 'Refuse the disconnect request'),
]


class KpiClientDbAction(models.TransientModel):
    _name = 'kpi.client.db.action'
    _description = 'Change a database status'

    db_ids = fields.Many2many('kpi.client.db', string='Databases',
                              required=True)
    mode = fields.Selection(MODES, required=True)
    note = fields.Text(
        string='Reason', required=True,
        help='The client is shown this. Write it for them.')
    tell_client = fields.Boolean(
        string='Post to the client group', default=True,
        help='Untick only when the client already knows by other means. The '
             'state change and the audit entry happen either way.')
    summary = fields.Char(compute='_compute_summary')

    @api.depends('db_ids', 'mode')
    def _compute_summary(self):
        for rec in self:
            names = ', '.join(rec.db_ids.mapped('db_name')) or '—'
            rec.summary = names

    @api.model
    def default_get(self, fields_list):
        vals = super().default_get(fields_list)
        ctx = self.env.context
        ids = list(ctx.get('active_ids') or [])
        if not ids and ctx.get('active_id'):
            ids = [ctx['active_id']]
        if ids and 'db_ids' in fields_list:
            vals['db_ids'] = [(6, 0, ids)]
        mode = self.env.context.get('default_mode')
        if mode and 'mode' in fields_list:
            vals['mode'] = mode
        return vals

    def action_apply(self):
        self.ensure_one()
        rows = self.db_ids
        if not rows:
            raise UserError(_('Pick at least one database.'))
        note = (self.note or '').strip()
        if not note:
            raise UserError(_('Give a reason — the client is told this.'))

        if self.mode == 'suspend':
            live = rows.filtered(lambda r: r.state == 'live')
            if not live:
                raise UserError(_('None of those are live.'))
            live.action_suspend(note=note)
            msg = _('%s suspended.') % ', '.join(live.mapped('db_name'))

        elif self.mode == 'disconnect':
            open_ = rows.filtered(lambda r: r.state != 'disconnected')
            if not open_:
                raise UserError(_('Those are already disconnected.'))
            open_.action_disconnect(note=note, tell_client=self.tell_client)
            msg = _('%s disconnected.') % ', '.join(open_.mapped('db_name'))

        elif self.mode == 'reject':
            asked = rows.filtered(lambda r: r.disconnect_state == 'requested')
            if not asked:
                raise UserError(_(
                    'There is no open disconnect request on those.'))
            asked.action_reject_disconnect(note=note)
            msg = _('Request refused for %s.') % ', '.join(
                asked.mapped('db_name'))
        else:
            raise UserError(_('Unknown action.'))

        _logger.info('kpi.client.db.action: %s by %s', msg, self.env.user.login)
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {'type': 'success', 'title': _('Done'),
                       'message': msg, 'next': {'type': 'ir.actions.act_window_close'},
                       'sticky': False},
        }
