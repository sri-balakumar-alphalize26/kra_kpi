"""Run the KRA/KPI reply parser when a WhatsApp message actually arrives.

The parser used to be chained onto ``WhatsAppSession._process_credit_reply_instant``.
The gateway was rewritten, that method no longer exists, and the patch had been
failing at every startup since 2026-07-24:

    Could not install KRA/KPI inbound parser: type object 'WhatsAppSession'
    has no attribute '_process_credit_reply_instant'

So client "1" / "2" pre-approval replies were going nowhere at all.

Rather than chase whatever internal the gateway calls this week, this hooks the
one thing that has stayed stable through the rewrite: the gateway records every
inbound message as a ``whatsapp.message`` row. Creating that row is the trigger.

Two things follow from that choice. We reuse the gateway's own phone parsing —
including its LID handling — instead of re-deriving it from the raw event and
drifting out of step. And a reply we send back is an *outgoing* row, so it
cannot re-enter this hook.
"""

import logging

from odoo import api, models

_logger = logging.getLogger(__name__)


class WhatsappMessageKpiHook(models.Model):
    _inherit = 'whatsapp.message'

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        for rec in records:
            try:
                rec._kpi_maybe_handle_reply()
            except Exception as exc:
                # Inbound must never fail because our parser did. The message is
                # already recorded by the time we get here; losing the reply
                # handling is bad, losing the message would be worse.
                _logger.warning("KRA/KPI inbound reply handling failed: %s", exc)
        return records

    def _kpi_maybe_handle_reply(self):
        self.ensure_one()
        if self.direction != 'incoming':
            return False
        phone = (self.phone or '').strip()
        # Group traffic is chatter, not a reply to us — and a group JID is not a
        # phone number, so the parser could not resolve a client from it anyway.
        if not phone or '@g.us' in phone:
            return False
        body = (self.message or '').strip()
        if not body:
            return False

        from odoo.addons.kra_kpi_module.models.kpi_inbound_patch import (
            process_inbound_reply,
        )
        from odoo.modules.registry import Registry

        # The parser opens its own cursors from (pool, uid) — it was written to run
        # on the gateway's thread. Handing it the live registry keeps that contract
        # intact rather than rewriting a thousand lines of working parser.
        handled = process_inbound_reply(
            Registry(self.env.cr.dbname), self.env.uid,
            self.session_id.id if self.session_id else False, phone, body)
        if handled:
            _logger.info("KRA/KPI handled inbound reply from %s: %r", phone, body[:40])
        return handled
