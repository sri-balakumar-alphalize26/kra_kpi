"""kpi.pair — RETIRED. Device-pairing PIN, no longer part of any flow.

It used to work like this: the mobile app generated a short-lived PIN, the
developer typed it into a gate in front of the KPI Action Board on their
computer, and that both paired the devices and opened the workday. The PIN was
the proof that the developer had their phone with them.

It is gone because the cost outweighed the proof. Auto-away un-paired the device
after five minutes of a stale heartbeat, so a closed laptop lid meant fetching
your phone and re-entering a code to get your own board back — several times a
day. The workday now starts from the board's own Start Workday button, which
already enforced one start + one end per day on its own.

The model and its table are kept ON PURPOSE:
  * security/ir.model.access.csv references model_kpi_pair,
  * historical rows are harmless,
  * dropping a model needs a migration and buys nothing.
Nothing writes to it any more. The routes in controllers/kra_api.py that the
mobile app still calls are shims that answer "nothing to pair" — see the comment
there before deleting anything.
"""

import logging
import secrets
from datetime import timedelta

from odoo import api, fields, models

_logger = logging.getLogger(__name__)

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
        """The mode the NEXT pairing should carry: 'resume' (Continue Working)
        ONLY while today's workday is still open, else 'start'.

        An open session today is exactly the auto-away case: _away_now
        (kpi_work_session.py) requires an open session, pauses the running task
        and un-pairs the device, but deliberately leaves the session OPEN. So the
        genuine "you went away" case always still has one.

        With no open session today the developer either never started or already
        ended their day — both mean 'start'.

        This used to fall back to the newest kpi.pair row's `mode` with NO date
        filter. _unpair() stamps mode='resume' and that row lives forever, so a
        developer who went away YESTERDAY and never started today was told "You
        went away and your task was paused". That fallback could only ever be
        reached with no open session — i.e. only ever with a stale cross-day
        stamp — so it is gone rather than merely date-scoped.
        """
        today = fields.Date.context_today(self)
        open_sess = self.env['kpi.work.session'].sudo().search([
            ('user_id', '=', user.id),
            ('session_date', '=', today),
            ('state', '=', 'open'),
        ], limit=1)
        return 'resume' if open_sess else 'start'

    @api.model
    def generate_for(self, user):
        """Invalidate any prior pending PIN and issue a fresh one for `user`.

        Returns {'pin', 'expires_at', 'mode'} — or {'done': True} when the
        developer already ended their workday today (one start + one end per
        day): no PIN is issued and the app shows the "ended for today" state.
        """
        # One start + one end per day. Auto-closed days can still restart.
        if self.env['kpi.work.session'].sudo()._day_done(user):
            return {'done': True}
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
        # One start + one end per day: refuse to re-open a workday the developer
        # already ended today. Decline WITHOUT pairing or reopening the session.
        if self.env['kpi.work.session'].sudo()._day_done(user):
            return {'ok': False, 'day_done': True}
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

    @api.model
    def status_for(self, user):
        """RETIRED — reports 'paired' unconditionally.

        Pairing is gone, so there is no state left to report. The method is kept
        only because the model is kept; the live answer the app gets now comes
        from the /kpi_pair/status shim in controllers/kra_api.py.

        What used to live here, and why it is gone: a branch that expired a stale
        pair when no workday was open, and another that called
        kpi.work.session._away_now() when the board tab had been closed for more
        than a grace period — pausing the running task and un-pairing the device.
        That second branch is what sent a developer back to the PIN screen for
        closing a tab, and _away_now no longer exists.
        """
        return {'state': 'paired', 'paired': True, 'mode': 'start',
                'day_done': self.env['kpi.work.session'].sudo()._day_done(user)}
