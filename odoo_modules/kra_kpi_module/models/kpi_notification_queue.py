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
from datetime import timedelta

from odoo import api, fields, models

_logger = logging.getLogger(__name__)

# How long to keep retrying before giving up.
RETRY_WINDOW_MIN = 15


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

    # ------------------------------------------------------------------ #
    # Public helpers                                                     #
    # ------------------------------------------------------------------ #
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
        ], order='first_queued_at asc', limit=50)
        if not pending:
            return 0

        # Pick a session and check its in-memory state.
        session = self.env['whatsapp.session'].sudo().search(
            [('status', '=', 'connected')], limit=1)
        if not session:
            _logger.info("notification_queue: no connected session, %s items waiting", len(pending))
            return 0
        try:
            from odoo.addons.whatsapp_neonize.models.whatsapp_session import (
                _wa_status, _wa_clients,
            )
            mem_status = _wa_status.get(session.id, 'unknown')
            has_client = session.id in _wa_clients
        except Exception as exc:
            _logger.warning("notification_queue: can't read neonize memory state: %s", exc)
            mem_status, has_client = 'unknown', False

        if mem_status != 'connected' or not has_client:
            _logger.info(
                "notification_queue: session in DB=%s but memory=%s (has_client=%s) — "
                "kicking reconnect, %s items still waiting",
                session.status, mem_status, has_client, len(pending),
            )
            try:
                session.sudo()._reconnect_session()
            except Exception as exc:
                _logger.warning("notification_queue: _reconnect_session raised: %s", exc)
            return 0

        # Memory says we're alive — try the actual sends.
        sent = 0
        for item in pending:
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
