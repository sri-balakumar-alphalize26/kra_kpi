"""kpi.push.token — per-device Expo push tokens for mobile push notifications.

One row per device that has registered for push. The token is the Expo push
token (ExponentPushToken[...]) obtained by the app via
Notifications.getExpoPushTokenAsync(). The push dispatcher (kpi_notify.py) looks
up the active tokens for each recipient user and POSTs to Expo's push API.

Tokens are deduped by the token string: if the same device token re-registers
under a different user (shared device / re-login), it is reassigned to the new
user so a banner never lands on the wrong account.
"""

from odoo import api, fields, models


class KpiPushToken(models.Model):
    _name = 'kpi.push.token'
    _description = 'Mobile Push Token (Expo)'
    _order = 'write_date desc, id desc'

    user_id = fields.Many2one(
        'res.users',
        string='User',
        required=True,
        index=True,
        ondelete='cascade',
    )
    token = fields.Char(string='Expo Push Token', required=True, index=True)
    platform = fields.Char(string='Platform')   # 'android' | 'ios'
    device = fields.Char(string='Device')        # optional label/model
    active = fields.Boolean(string='Active', default=True)

    _sql_constraints = [
        ('token_uniq', 'unique(token)', 'This push token is already registered.'),
    ]

    @api.model
    def upsert(self, user, token, platform=None, device=None):
        """Register (or refresh) a device token for `user`.

        Deduped by token: an existing row is reassigned to `user`, reactivated,
        and its platform/device refreshed. Returns the record.
        """
        if not token:
            return self.browse()
        rec = self.sudo().search([('token', '=', token)], limit=1)
        vals = {'user_id': user.id, 'active': True}
        if platform:
            vals['platform'] = platform
        if device:
            vals['device'] = device
        if rec:
            rec.write(vals)
        else:
            vals['token'] = token
            rec = self.sudo().create(vals)
        # De-dupe: one active token per (user, device). Older rows for the same
        # physical device (Expo tokens can rotate) are deactivated so the user
        # never receives the same push twice.
        if device:
            self.sudo().search([
                ('user_id', '=', user.id),
                ('device', '=', device),
                ('id', '!=', rec.id),
                ('active', '=', True),
            ]).write({'active': False})
        return rec

    @api.model
    def deactivate(self, token):
        """Mark a token inactive (logout, or DeviceNotRegistered from Expo)."""
        if not token:
            return
        self.sudo().search([('token', '=', token)]).write({'active': False})

    @api.model
    def tokens_for_users(self, user_ids):
        """Return the list of active token strings for the given user ids."""
        if not user_ids:
            return []
        recs = self.sudo().search([
            ('user_id', 'in', list(user_ids)),
            ('active', '=', True),
        ])
        # Final guard: unique tokens only, so a duplicate row can never cause a
        # double push.
        seen = set()
        out = []
        for tok in recs.mapped('token'):
            if tok and tok not in seen:
                seen.add(tok)
                out.append(tok)
        return out
