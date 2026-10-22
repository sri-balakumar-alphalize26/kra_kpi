"""kpi.notification.queue — retry queue for WhatsApp sends.

Built because the unofficial neonize WhatsApp Web client periodically goes
into a "zombie" state where the DB row reports `status='connected'` but the
in-memory socket is dead (`_wa_status` mismatch).  POS sends bypass this by
pre-checking the in-memory state and bailing gracefully; we instead queue
the send and retry every minute until the memory state recovers or the
message expires.

Lifecycle:
  enqueue() -> state='pending'
  _cron_retry() picks up pending rows whose expires_at > now
  -> on success: state='sent'
  -> on failure: increments attempt_count, leaves state='pending'
  -> when expires_at < now: state='failed'

The audit log (`kpi.action.log`) is still written by _notify_one for visibility.
"""

import logging
import threading
from datetime import timedelta

from odoo import SUPERUSER_ID, api, fields, models

_logger = logging.getLogger(__name__)

# How long to keep retrying before giving up.
RETRY_WINDOW_MIN = 15


def _fire_delayed(dbname, row_id):
    """Runs in a timer thread, outside any request: open a fresh cursor."""
    try:
        from odoo.modules.registry import Registry
        with Registry(dbname).cursor() as cr:
            env = api.Environment(cr, SUPERUSER_ID, {})
            env['kpi.notification.queue'].browse(row_id)._send_now()
    except Exception as exc:
        _logger.warning("delayed WhatsApp send %s failed: %s", row_id, exc)


class KpiNotificationQueue(models.Model):
    _name = 'kpi.notification.queue'
    _description = 'KRA/KPI WhatsApp Notification Retry Queue'
    _order = 'first_queued_at desc, id desc'

    kpi_id = fields.Many2one('kra.kpi', ondelete='set null', index=True,
                             string='Related Task')
    event  = fields.Char(required=True, index=True,
                         help='The notification event name (e.g. start, pause, complete, task_assigned).')
    phone  = fields.Char(required=True, index=True,
                         help='Destination phone (digits only).')
    body   = fields.Text(required=True,
                         help='Already-rendered WhatsApp message body.')
    role   = fields.Char(help='owner / coordinator / developer / client')

    state = fields.Selection([
        ('pending', 'Pending'),
        ('sent',    'Sent'),
        ('failed',  'Failed (expired)'),
    ], default='pending', index=True, required=True)

    attempt_count   = fields.Integer(default=0)
    first_queued_at = fields.Datetime(default=fields.Datetime.now)
    last_attempt_at = fields.Datetime()
    expires_at      = fields.Datetime(required=True,
        default=lambda self: fields.Datetime.now() + timedelta(minutes=RETRY_WINDOW_MIN))
    last_error      = fields.Text()
    # Held back until then (enqueue_delayed). Empty = send on the next tick.
    send_after      = fields.Datetime(index=True)

    # ------------------------------------------------------------------ #
    # Public helpers                                                     #
    # ------------------------------------------------------------------ #
    @api.model
    def enqueue_delayed(self, phone, body, event='ack', seconds=None, kpi_id=False, role='client'):
        """Send `body` to `phone` (a number or a group jid) `seconds` from now.

        A timer started after the commit sends it on time; the 1-minute retry
        cron is the backstop if the server restarts before the timer fires.
        """
        if not phone or not body:
            return False
        if seconds is None:
            seconds = self.env['kpi.wa.ack'].delay_seconds()
        now = fields.Datetime.now()
        try:
            row = self.sudo().create({
                'kpi_id': kpi_id or False, 'event': event or 'ack', 'phone': phone,
                'role': role or '', 'body': body,
                'send_after': now + timedelta(seconds=seconds),
                'expires_at': now + timedelta(seconds=seconds, minutes=RETRY_WINDOW_MIN),
            })
        except Exception as exc:
            _logger.warning("notification_queue.enqueue_delayed failed: %s", exc)
            return False
        dbname, row_id = self.env.cr.dbname, row.id

        def _start_timer():
            t = threading.Timer(seconds, _fire_delayed, args=(dbname, row_id))
            t.daemon = True
            t.start()
        self.env.cr.postcommit.add(_start_timer)
        return row_id

    def _lock_pending(self):
        """True when this row is still pending and nobody else is sending it."""
        self.ensure_one()
        self.env.cr.execute(
            "SELECT id FROM kpi_notification_queue WHERE id = %s AND state = 'pending' "
            "FOR UPDATE SKIP LOCKED", (self.id,))
        return bool(self.env.cr.fetchone())

    def _send_now(self):
        """Timer path: send one delayed row if it is still pending."""
        self.ensure_one()
        if not self.exists() or not self._lock_pending():
            return False
        session = self.env['whatsapp.session'].sudo().search(
            [('status', '=', 'connected')], limit=1)
        if not session:
            return False
        try:
            session.send_message(self.phone, self.body)
            self.write({'state': 'sent', 'last_attempt_at': fields.Datetime.now(),
                        'attempt_count': self.attempt_count + 1})
            return True
        except Exception as exc:
            # Left pending: the retry cron tries again.
            self.write({'last_attempt_at': fields.Datetime.now(),
                        'attempt_count': self.attempt_count + 1,
                        'last_error': str(exc)[:500]})
            return False
    @api.model
    def enqueue(self, kpi_id, event, phone, role, body, error=None):
        """Queue a failed send for retry.  Returns the created row id."""
        try:
            return self.sudo().create({
                'kpi_id':     kpi_id or False,
                'event':      event or 'unknown',
                'phone':      phone,
                'role':       role or '',
                'body':       body or '',
                'last_error': error or '',
            }).id
        except Exception as exc:
            _logger.warning("notification_queue.enqueue failed: %s", exc)
            return False

    # ------------------------------------------------------------------ #
    # Cron — retries pending items every minute                          #
    # ------------------------------------------------------------------ #
    @api.model
    def _cron_retry(self):
        """Walk the pending queue and try to send anything that's still alive.

        Strategy mirrors what POS does for its WhatsApp sends:
          1. Check the in-memory client state first (`_wa_status`).  If dead,
             attempt `_reconnect_session()` once, then bail; we'll try again
             next tick.  This avoids hammering the socket while it's dead.
          2. Only when memory says 'connected' do we actually send.
          3. Between sends add a small delay so rapid bursts don't kill the
             socket.
        """
        import time
        now = fields.Datetime.now()

        # Expire any items past their retry window.
        expired = self.search([
            ('state',      '=',  'pending'),
            ('expires_at', '<=', now),
        ])
        if expired:
            expired.write({'state': 'failed'})
            _logger.info("notification_queue: expired %s items past retry window", len(expired))

        # Anything left to try?
        pending = self.search([
            ('state',      '=',  'pending'),
            ('expires_at', '>',  now),
            '|', ('send_after', '=', False), ('send_after', '<=', now),
        ], order='first_queued_at asc', limit=50)
        if not pending:
            return 0

        # Pick a session and check its in-memory state.
        session = self.env['whatsapp.session'].sudo().search(
            [('status', '=', 'connected')], limit=1)
        if not session:
            _logger.info("notification_queue: no connected session, %s items waiting", len(pending))
            return 0
        # Transport is Evolution API over HTTP. There is no in-process client to
        # inspect any more; wa_is_alive() trusts a recent webhook/state-check and
        # otherwise re-probes the server.
        #
        # FAIL-OPEN on error. The old code set mem_status='unknown' in its except
        # branch, which fell into the `!= 'connected'` test below and returned 0 --
        # i.e. the moment reading neonize's internals failed, the retry queue
        # stopped sending ANYTHING and every item silently expired after
        # RETRY_WINDOW_MIN. The thing that exists so notifications are not lost
        # was the thing losing them.
        try:
            alive = bool(session.sudo().wa_is_alive())
        except Exception as exc:
            _logger.warning("notification_queue: liveness probe failed (%s) — "
                            "assuming alive and attempting the sends", exc)
            alive = True

        if not alive:
            _logger.info(
                "notification_queue: session %s is not connected — kicking "
                "reconnect, %s items still waiting",
                session.name, len(pending),
            )
            try:
                session.sudo()._reconnect_session()
            except Exception as exc:
                _logger.warning("notification_queue: _reconnect_session raised: %s", exc)
            return 0

        # Transport says we're alive — try the actual sends.
        sent = 0
        for item in pending:
            # A delayed row's own timer may be sending it right now.
            if item.send_after and not item._lock_pending():
                continue
            try:
                session.send_message(item.phone, item.body)
                item.write({
                    'state':           'sent',
                    'last_attempt_at': fields.Datetime.now(),
                    'attempt_count':   item.attempt_count + 1,
                })
                if item.kpi_id:
                    try:
                        item.kpi_id._log_action(
                            'notification_sent',
                            source='retry-cron',
                            payload={'event': item.event, 'channel': 'whatsapp',
                                     'phone': item.phone, 'role': item.role,
                                     'retried': True,
                                     'attempt': item.attempt_count},
                        )
                    except Exception:
                        pass
                sent += 1
                # Small breather between rapid-fire sends so the socket
                # doesn't get overwhelmed.  The POS path is naturally slow
                # (one order at a time); we batch through queues.
                time.sleep(0.25)
            except Exception as exc:
                item.write({
                    'last_attempt_at': fields.Datetime.now(),
                    'attempt_count':   item.attempt_count + 1,
                    'last_error':      str(exc)[:500],
                })
                # If the socket just died mid-batch, stop the batch — let
                # the next cron tick handle the remaining items after the
                # reconnect path has had a chance to run.
                err = str(exc).lower()
                if 'not connected' in err or 'scan the qr' in err:
                    _logger.info("notification_queue: socket died mid-batch after %s sends — stopping", sent)
                    break
        return sent
