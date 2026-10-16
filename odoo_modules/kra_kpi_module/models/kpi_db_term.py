"""How long a client's database is paid up for -- weekly, monthly, yearly,
lifetime, or whatever this business actually sells.

A TABLE, NOT A SELECTION
------------------------
Same reason as kpi.server and kpi.install.preset: a Selection means every
"we also do quarterly now" is a deploy and a migration for the stored values.
Nothing in the code matches on a term's NAME, only on its id and its length,
so these rows can be renamed, reordered or archived freely.

ENTIRELY OPTIONAL
-----------------
A kpi.client.db with `track_term` unticked has no term, no expiry date, no
countdown and no reminders. That is the DEFAULT. Terms exist for the clients
where a monthly or yearly arrangement is real, and stay invisible for the rest
-- which is why `track_term` is a separate tick rather than being inferred from
`term_id` being set. Inferring it would mean an admin who picked a term once to
see what it did could never un-pick it.
"""

import logging

from odoo import api, fields, models
from odoo.exceptions import ValidationError

_logger = logging.getLogger(__name__)


class KpiDbTerm(models.Model):
    _name = 'kpi.db.term'
    _description = 'Database Term'
    _order = 'sequence, id'

    name = fields.Char(
        required=True,
        help='What you call it: Weekly, Monthly, Yearly, Lifetime, '
             '"6 months", anything.')
    months = fields.Integer(
        string='Months',
        help='Length in months. Added on top of Days.')
    days = fields.Integer(
        string='Days',
        help='Length in days. Added on top of Months, so "1 month + 7 days" '
             'is possible for a grace period.')
    is_perpetual = fields.Boolean(
        string='Never expires',
        help='Tick for Lifetime. The length is then ignored and no expiry '
             'date is ever suggested.')
    sequence = fields.Integer(default=10)
    active = fields.Boolean(default=True)
    notes = fields.Text(
        help='Internal only -- what this term includes, what it costs, who '
             'agreed it. Never shown to a client.')

    length_display = fields.Char(
        string='Length', compute='_compute_length_display')

    _sql_constraints = [
        ('name_uniq', 'unique(name)', 'That term already exists.'),
    ]

    @api.depends('months', 'days', 'is_perpetual')
    def _compute_length_display(self):
        for rec in self:
            if rec.is_perpetual:
                rec.length_display = 'Never expires'
                continue
            parts = []
            if rec.months:
                parts.append('%d month%s' % (rec.months,
                                             '' if rec.months == 1 else 's'))
            if rec.days:
                parts.append('%d day%s' % (rec.days,
                                           '' if rec.days == 1 else 's'))
            rec.length_display = ' + '.join(parts) or '—'

    @api.constrains('months', 'days', 'is_perpetual')
    def _check_length(self):
        for rec in self:
            if rec.is_perpetual:
                continue
            if rec.months < 0 or rec.days < 0:
                raise ValidationError('A term cannot be a negative length.')
            if not rec.months and not rec.days:
                raise ValidationError(
                    'Give %s a length in months or days, or tick '
                    '"Never expires".' % (rec.name or 'this term'))

    def expiry_from(self, start_date):
        """The expiry this term suggests for a database activated on `start_date`.

        Returns False for a perpetual term, and False when there is no start
        date to count from -- never today's date as a fallback. A wrong expiry
        is worse than a blank one: blank reads as "nobody set this up", while a
        wrong one reads as fact and starts a reminder clock.
        """
        self.ensure_one()
        if self.is_perpetual or not start_date:
            return False
        try:
            from dateutil.relativedelta import relativedelta
            return start_date + relativedelta(months=self.months or 0,
                                              days=self.days or 0)
        except Exception as exc:          # pragma: no cover - defensive
            _logger.warning('kpi.db.term %s: could not compute expiry: %s',
                            self.name or self.id, exc)
            return False
