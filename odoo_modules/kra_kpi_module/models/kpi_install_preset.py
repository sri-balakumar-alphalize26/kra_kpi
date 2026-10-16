"""The install packages offered by the WhatsApp "New Database" menu.

A TABLE, not a Python list, for the same reason `kpi.server` is: this list
changes with the business, and it had already been edited twice before it was
a week old. Hard-coding it means every "add VFD to the retail pack" is a
deploy.

`needs_detail` is the one piece of behaviour a row carries: a package like
"Same as another shop" cannot be acted on without knowing WHICH shop, so
choosing it makes the bot ask for free text. Everything else is just a label
and a description.
"""

import logging

from odoo import api, fields, models

_logger = logging.getLogger(__name__)

# WhatsApp caps a poll at 12 options and truncates silently.
POLL_MAX = 12


class KpiInstallPreset(models.Model):
    _name = 'kpi.install.preset'
    _description = 'Install Package'
    _order = 'sequence, name'

    name = fields.Char(
        required=True,
        help='Shown in the WhatsApp menu, e.g. "POS + Scale + VFD".')
    code = fields.Char(help='Stable key for reporting. Optional.')
    emoji = fields.Char(
        help='Shown before the name in the menu. One or two characters.')
    contents = fields.Text(
        string='What it includes',
        help='The actual module / hardware list. This is what the person '
             'provisioning reads, so write it for them, not for the client.')
    needs_detail = fields.Boolean(
        string='Ask for details',
        help='Tick for packages that cannot be acted on as-is — "Same as '
             'another shop" needs to know which shop. The bot then asks for '
             'a free-text message before creating the ticket.')
    sequence = fields.Integer(default=10)
    active = fields.Boolean(default=True)

    _sql_constraints = [
        ('name_uniq', 'unique(name)', 'That package already exists.'),
    ]

    def poll_label(self):
        self.ensure_one()
        emoji = (self.emoji or '').strip()
        return ('%s %s' % (emoji, self.name)).strip() if emoji else (self.name or '')

    @api.model
    def poll_options(self):
        """[(id, label, needs_detail)] for the picker, capped so nothing is lost."""
        rows = self.sudo().search([], limit=POLL_MAX + 1)
        if len(rows) > POLL_MAX:
            _logger.warning(
                'kpi.install.preset: %s packages but a WhatsApp poll fits %s — '
                'archive the ones you do not use.', len(rows), POLL_MAX)
            rows = rows[:POLL_MAX]
        return [(r.id, r.poll_label(), r.needs_detail) for r in rows]
