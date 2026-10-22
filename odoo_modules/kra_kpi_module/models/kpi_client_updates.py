"""Telling the client, like a person would, when work starts on their request.

Call notes (Oct 2026): once a request is approved and a developer starts it,
the client gets a human-style "work has started, we'll deliver as soon as
possible" message in their group -- a random line from kpi.wa.ack, signed with
the team name, 10-30 s later. Only the FIRST start: a pause and resume is not
news to the client.
"""

import logging

from odoo import fields, models

_logger = logging.getLogger(__name__)


class KraKpiClientUpdates(models.Model):
    _inherit = 'kra.kpi'

    client_started_told_at = fields.Datetime(
        string='Client Told Work Started', copy=False, readonly=True)

    def start_task(self):
        result = super().start_task()
        for rec in self.sudo():
            if rec.client_submitted and not rec.client_started_told_at:
                rec._tell_client_started()
        return result

    def _tell_client_started(self):
        self.ensure_one()
        try:
            grp = self.env['kpi.wa.group.report'].sudo()._group_for_kpi(self)
            if not grp or not grp.jid:
                return False
            details = '*%s* — %s' % (self.external_ref or '#%s' % self.id, self.name or '')
            body = self.env['kpi.wa.ack'].wrap(details, 'started')
            self.env['kpi.notification.queue'].sudo().enqueue_delayed(
                grp.jid, body, event='client_work_started', kpi_id=self.id)
            self.write({'client_started_told_at': fields.Datetime.now()})
            return True
        except Exception as exc:
            _logger.warning('work-started message for %s failed: %s', self.id, exc)
            return False
