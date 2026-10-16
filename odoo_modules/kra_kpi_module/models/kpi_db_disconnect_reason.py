"""Why a client asks for a database to be switched off.

A table for the same reason kpi.decline.reason is one: this is the business's
own vocabulary and it changes. Unlike the decline reasons, these are shown to
a CLIENT in a WhatsApp poll, so each row carries an emoji and the 12-option
poll cap applies.

`needs_detail` mirrors kpi.install.preset: "Moved to another system" is not
actionable without knowing which, so picking it makes the bot ask for one line
of free text before it will record the request.
"""

import logging

from odoo import api, fields, models

_logger = logging.getLogger(__name__)

# WhatsApp truncates a poll at 12 options silently. One slot is kept for the
# "Other -- type it" row the router appends, so the table is capped at 11.
POLL_MAX_REASONS = 11


class KpiDbDisconnectReason(models.Model):
    _name = 'kpi.db.disconnect.reason'
    _description = 'Database Disconnect Reason'
    _order = 'sequence, name'

    name = fields.Char(
        string='Reason', required=True,
        help='Shown to the client in the WhatsApp poll, so word it for them.')
    code = fields.Char(help='Stable key for reporting. Optional.')
    emoji = fields.Char(help='Shown before the name in the poll.')
    needs_detail = fields.Boolean(
        string='Ask for details',
        help='Tick for reasons that mean nothing on their own -- "Moved to '
             'another system" needs to know which. The bot then asks for one '
             'line before recording the request.')
    sequence = fields.Integer(default=10)
    active = fields.Boolean(default=True)

    _sql_constraints = [
        ('name_uniq', 'unique(name)', 'That reason already exists.'),
    ]

    def poll_label(self):
        self.ensure_one()
        emoji = (self.emoji or '').strip()
        return ('%s %s' % (emoji, self.name)).strip() if emoji else (self.name or '')

    @api.model
    def poll_options(self):
        """[(id, label, needs_detail)] for the picker, capped so nothing is lost."""
        rows = self.sudo().search([], limit=POLL_MAX_REASONS + 1)
        if len(rows) > POLL_MAX_REASONS:
            _logger.warning(
                'kpi.db.disconnect.reason: %s reasons but a WhatsApp poll fits '
                '%s once the "Other" row is added -- archive the ones you do '
                'not use.', len(rows), POLL_MAX_REASONS)
            rows = rows[:POLL_MAX_REASONS]
        return [(r.id, r.poll_label(), r.needs_detail) for r in rows]
