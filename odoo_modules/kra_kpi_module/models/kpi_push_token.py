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
    # The EAS projectId the app held when it minted this token. Plain Char: it is
    # an external EAS uuid, not an Odoo record.
    #
    # Expo refuses a push request whose messages span two projects, rejecting the
    # WHOLE request. The token string doesn't reveal its project, so without this
    # the dispatcher cannot avoid mixing them, and one token left over from an
    # older projectId silently suppressed the notification for every other device
    # in the same send. Empty on rows created before this field existed; they
    # backfill on the next login, because the app re-registers every time.
    project_id = fields.Char(string='EAS Project')

    _sql_constraints = [
        ('token_uniq', 'unique(token)', 'This push token is already registered.'),
    ]

    @api.model
    def upsert(self, user, token, platform=None, device=None, project_id=None):
        """Register (or refresh) a device token for `user`.

        Deduped by token: an existing row is reassigned to `user`, reactivated,
        and its platform/device/project refreshed. Returns the record.
        """
        if not token:
            return self.browse()
        rec = self.sudo().search([('token', '=', token)], limit=1)
        vals = {'user_id': user.id, 'active': True}
        if platform:
            vals['platform'] = platform
        if device:
            vals['device'] = device
        # Always refresh when supplied: a token that survives an EAS project
        # change must not keep claiming the old project, or grouping would file
        # it with the wrong batch and re-create the bug this field exists to fix.
        if project_id:
            vals['project_id'] = project_id
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
    def token_groups_for_users(self, user_ids):
        """Active tokens for these users, grouped by EAS project.

        Returns {project_id_or_'': [token, ...]} so the dispatcher can send ONE
        request per project. Expo requires every message in a request to belong to
        the same project and rejects a mixed request outright — HTTP 400
        PUSH_TOO_MANY_EXPERIENCE_IDS — delivering to nobody, not even the devices
        that were fine.

        Rows with no project recorded are grouped under '' and kept SEPARATE from
        every known project rather than folded into one of them. Guessing would
        re-introduce the mixed request; isolating them means an unknown legacy
        token can only ever spoil its own group, and `_handle_push_receipts`
        retries that group per-token so even that group still gets delivered.

        Built on the same active-token query and de-dup rule as
        tokens_for_users(), which is left alone for its other callers.
        """
        if not user_ids:
            return {}
        recs = self.sudo().search([
            ('user_id', 'in', list(user_ids)),
            ('active', '=', True),
        ])
        groups = {}
        seen = set()
        for rec in recs:
            tok = rec.token
            # Same guard as tokens_for_users: a duplicate row must not double-push.
            if not tok or tok in seen:
                continue
            seen.add(tok)
            groups.setdefault(rec.project_id or '', []).append(tok)
        return groups

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
