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
        """App polls this. Returns {'state', 'paired', 'mode'}.

        A record is only genuinely 'paired' while TODAY's workday session is OPEN.
        If the session was closed (End Workday / midnight auto-close) or a cross-day
        stale pair was left behind WITHOUT un-pairing, the record is expired here so
        the app (and its read-only gate) falls back to the PIN screen — otherwise a
        stuck 'paired' row makes a developer look like their workday is running when
        it isn't. If the board tab was left (a 'leaving' beacon not cancelled by a
        refresh's heartbeat), un-pair + pause the running task instead.
        """
        self._sweep_expired(user)
        rec = self.sudo().search([('user_id', '=', user.id)], limit=1)  # _order = newest first
        if rec and rec.state == 'paired':
            open_sess = self.env['kpi.work.session'].sudo().search([
                ('user_id', '=', user.id),
                ('session_date', '=', fields.Date.context_today(self)),
                ('state', '=', 'open'),
            ], limit=1)
            if not open_sess:
                # Paired but no open workday today → not actually working (stale pair
                # from a closed / midnight-auto-closed session, or a cross-day leak).
                # Expire it so the app returns to the read-only "Start Workday" gate.
                _logger.info("pair/status: stale 'paired' with no open session -> un-pair user=%s(%s) rec=%s",
                             user.login, user.id, rec.id)
                self._unpair(user, mode='start')
                rec = self.sudo().search([('user_id', '=', user.id)], limit=1)
            elif self._left_and_gone(user):
                try:
                    self.env['kpi.work.session'].sudo()._away_now(user, source='leave')
                except Exception:
                    self._unpair(user, mode='resume')
                rec = self.sudo().search([('user_id', '=', user.id)], limit=1)
        state = rec.state if rec else 'none'
        mode = rec.mode if rec else 'start'
        # One start + one end per day: tell the app when today is already ended
        # by the developer, so it shows "Workday ended for today" instead of
        # routing to the PIN screen. (Auto-closed days report day_done=False.)
        day_done = self.env['kpi.work.session'].sudo()._day_done(user)
        _logger.info("pair/status user=%s(%s) -> state=%s paired=%s mode=%s day_done=%s",
                     user.login, user.id, state, state == 'paired', mode, day_done)
        return {'state': state, 'paired': state == 'paired', 'mode': mode,
                'day_done': day_done}
