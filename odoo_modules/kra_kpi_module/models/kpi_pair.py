"""kpi.pair — device-pairing PIN linking the mobile app (key) to the web board.

Flow: the mobile app generates a fresh, short-lived PIN (per session). The
developer opens the KPI Action Board on their computer, which shows a PIN gate.
Entering the app's PIN pairs the two devices AND opens the workday — from that
moment the web's heartbeat detects "working". The app polls status_for() to
learn the pairing succeeded.

Security: PINs are short, single-use, expire fast, and are scoped to the
logged-in user (both the app and the web are already authenticated as the same
Odoo user via the session cookie — the PIN just binds *their* two devices).
Never log the PIN value.
"""

import secrets
from datetime import timedelta

from odoo import api, fields, models

# How long a freshly generated PIN stays valid if unused.
_PIN_TTL_MINUTES = 10
_PIN_DIGITS = 4  # 4-digit code (0000-9999)


class KpiPair(models.Model):
    _name = 'kpi.pair'
    _description = 'Mobile ↔ Web Pairing PIN'
    _order = 'create_date desc, id desc'

    user_id = fields.Many2one('res.users', string='User', required=True, index=True, ondelete='cascade')
    pin = fields.Char(string='PIN', required=True, index=True)
    state = fields.Selection([
        ('pending', 'Pending'),
        ('paired', 'Paired'),
        ('expired', 'Expired'),
    ], string='State', default='pending', index=True)
    # 'start'  = first pairing of the day → "start working"
    # 'resume' = re-pairing after an auto-away pause → "continue working"
    mode = fields.Selection([
        ('start', 'Start'),
        ('resume', 'Resume'),
    ], string='Mode', default='start')
    expires_at = fields.Datetime(string='Expires At')
    paired_at = fields.Datetime(string='Paired At')

    # ------------------------------------------------------------------ #
    @api.model
    def _new_pin(self):
        # Zero-padded random N-digit code. secrets = cryptographically strong.
        return str(secrets.randbelow(10 ** _PIN_DIGITS)).zfill(_PIN_DIGITS)

    @api.model
    def _next_mode(self, user):
        """The mode the NEXT pairing should carry. Once today's workday is already
        open, every pairing reads as 'resume' (Continue Working). Otherwise fall
        back to the auto-away 'resume' stamp, else 'start'."""
        today = fields.Date.context_today(self)
        open_sess = self.env['kpi.work.session'].sudo().search([
            ('user_id', '=', user.id),
            ('session_date', '=', today),
            ('state', '=', 'open'),
        ], limit=1)
        if open_sess:
            return 'resume'
        rec = self.sudo().search([('user_id', '=', user.id)], limit=1)  # newest first
        return rec.mode if rec and rec.mode == 'resume' and rec.state != 'paired' else 'start'

    @api.model
    def generate_for(self, user):
        """Invalidate any prior pending PIN and issue a fresh one for `user`.

        Returns {'pin', 'expires_at', 'mode'}.
        """
        now = fields.Datetime.now()
        mode = self._next_mode(user)
        # Expire any still-pending codes for this user.
        self.sudo().search([
            ('user_id', '=', user.id),
            ('state', '=', 'pending'),
        ]).write({'state': 'expired'})
        rec = self.sudo().create({
            'user_id': user.id,
            'pin': self._new_pin(),
            'state': 'pending',
            'mode': mode,
            'expires_at': now + timedelta(minutes=_PIN_TTL_MINUTES),
        })
        return {'pin': rec.pin, 'expires_at': fields.Datetime.to_string(rec.expires_at), 'mode': mode}

    @api.model
    def _unpair(self, user, mode='resume'):
        """Auto-away calls this: drop the current paired session so both the web
        board and the app fall back to the PIN gate. `mode='resume'` makes the
        next PIN read as 'continue working'."""
        self.sudo().search([
            ('user_id', '=', user.id),
            ('state', 'in', ('paired', 'pending')),
        ]).write({'state': 'expired', 'mode': mode})

    @api.model
    def _sweep_expired(self, user):
        """Mark pending PINs past their TTL as expired (lazy, on read/verify)."""
        now = fields.Datetime.now()
        self.sudo().search([
            ('user_id', '=', user.id),
            ('state', '=', 'pending'),
            ('expires_at', '<', now),
        ]).write({'state': 'expired'})

    @api.model
    def verify(self, user, pin):
        """Web gate calls this. On a valid, non-expired pending match → mark
        paired and open the workday (start detecting 'working' on the web).

        Returns {'ok': bool}.
        """
        self._sweep_expired(user)
        # Defensive: only digits, exactly the expected length.
        import re
        pin = re.sub(r'\D', '', pin or '')[:_PIN_DIGITS]
        if len(pin) != _PIN_DIGITS:
            return {'ok': False}
        rec = self.sudo().search([
            ('user_id', '=', user.id),
            ('state', '=', 'pending'),
            ('pin', '=', pin),
        ], limit=1)
        if not rec:
            return {'ok': False}
        rec.write({'state': 'paired', 'paired_at': fields.Datetime.now()})
        # Pairing = "start working": open today's workday so the heartbeat begins.
        try:
            sess = self.env['kpi.work.session'].sudo()._get_or_open_today(user=user)
            if sess and sess.leaving_at:
                sess.write({'leaving_at': False})   # board is back → cancel any pending leave
        except Exception:
            pass  # never let workday-open failure block a successful pairing
        return {'ok': True}

    @api.model
    def is_paired(self, user):
        """Cheap boolean for the heartbeat: is this user's device currently paired?"""
        self._sweep_expired(user)
        rec = self.sudo().search([('user_id', '=', user.id)], limit=1)
        return bool(rec and rec.state == 'paired')

    # Seconds after the board signals it's leaving (close / Back) before we
    # un-pair. Comfortably above a page-refresh reload (which re-heartbeats and
    # clears the 'leaving' stamp), so a refresh never falsely un-pairs.
    _LEAVE_GRACE_SECONDS = 8

    @api.model
    def _left_and_gone(self, user):
        """True if the board signalled 'leaving' (close/Back) and hasn't come back
        (a heartbeat would have cleared the stamp) within the grace — i.e. the tab
        is really gone, not a quick refresh. This is an explicit signal, NOT a
        heartbeat-timeout, so it can't misfire on a live board."""
        sess = self.env['kpi.work.session'].sudo().search([
            ('user_id', '=', user.id),
            ('session_date', '=', fields.Date.context_today(self)),
            ('state', '=', 'open'),
        ], limit=1)
        if not sess or not sess.leaving_at:
            return False
        return (fields.Datetime.now() - sess.leaving_at).total_seconds() >= self._LEAVE_GRACE_SECONDS

    @api.model
    def status_for(self, user):
        """App polls this. Returns {'state', 'paired', 'mode'}. If the board tab was
        closed/left (a 'leaving' beacon not cancelled by a refresh's heartbeat),
        un-pair + pause the running task so the app returns to the PIN screen."""
        self._sweep_expired(user)
        rec = self.sudo().search([('user_id', '=', user.id)], limit=1)  # _order = newest first
        if rec and rec.state == 'paired' and self._left_and_gone(user):
            try:
                self.env['kpi.work.session'].sudo()._away_now(user, source='leave')
            except Exception:
                self._unpair(user, mode='resume')
            rec = self.sudo().search([('user_id', '=', user.id)], limit=1)
        state = rec.state if rec else 'none'
        mode = rec.mode if rec else 'start'
        return {'state': state, 'paired': state == 'paired', 'mode': mode}
