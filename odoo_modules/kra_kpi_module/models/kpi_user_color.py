"""A colour per person for the WhatsApp group.

WhatsApp cannot colour messages or polls, and every bot reply comes from the
same number -- so in a busy group nobody can tell at a glance which menu is
whose. Each person gets a coloured square that leads their polls and replies
(🟦 Sri Balakumar — …), and the browser pages opened from their links use the
same colour.

Assigned once, the first time it is needed: the first colour no other active
staff member has; when all are taken it cycles. Stored, so it never changes.
"""

from odoo import fields, models

# key, emoji, hex
PALETTE = [
    ('blue', '🟦', '#2563EB'),
    ('green', '🟩', '#16A34A'),
    ('orange', '🟧', '#EA580C'),
    ('purple', '🟪', '#7C3AED'),
    ('red', '🟥', '#DC2626'),
    ('amber', '🟨', '#CA8A04'),
    ('brown', '🟫', '#92400E'),
    ('slate', '⬛', '#374151'),
]
_BY_KEY = {k: (e, h) for k, e, h in PALETTE}


class ResUsersKpiColor(models.Model):
    _inherit = 'res.users'

    kpi_wa_color = fields.Char(string='WhatsApp Colour', copy=False,
                               help='This person\'s colour in the WhatsApp group (set automatically).')

    def _kpi_wa_color(self):
        """(emoji, hex) for this person; assigns one on first use."""
        self.ensure_one()
        u = self.sudo()
        key = u.kpi_wa_color
        if key not in _BY_KEY:
            used = set(u.search([('active', '=', True), ('share', '=', False),
                                 ('kpi_wa_color', '!=', False), ('id', '!=', u.id)]).mapped('kpi_wa_color'))
            free = [k for k, _e, _h in PALETTE if k not in used]
            key = free[0] if free else PALETTE[u.id % len(PALETTE)][0]
            u.write({'kpi_wa_color': key})
        return _BY_KEY[key]
