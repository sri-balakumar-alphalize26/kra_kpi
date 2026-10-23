"""Telling the client, like a person would, when work starts on their request.

Call notes (Oct 2026): once a request is approved and a developer starts it,
the client gets a human-style "work has started, we'll deliver as soon as
possible" message in their group -- a random line from kpi.wa.ack, signed with
the team name, 10-30 s later. Only the FIRST start: a pause and resume is not
news to the client.
"""

import logging
import threading

from odoo import SUPERUSER_ID, api, fields, models

_logger = logging.getLogger(__name__)


def _run_in_background(dbname, ids, method):
    """Thread body: a fresh cursor, the task, then the slow work."""
    try:
        from odoo.modules.registry import Registry
        with Registry(dbname).cursor() as cr:
            env = api.Environment(cr, SUPERUSER_ID, {})
            getattr(env['kra.kpi'].browse(ids).exists(), method)()
    except Exception as exc:
        _logger.warning('background %s for %s failed: %s', method, ids, exc)


class KraKpiClientUpdates(models.Model):
    _inherit = 'kra.kpi'

    def _after_commit_in_background(self, method):
        """Run `method` on these tasks in a thread once this request commits,
        so a slow WhatsApp send never keeps the person who submitted waiting."""
        if not self:
            return
        dbname, ids = self.env.cr.dbname, list(self.ids)

        def _start():
            t = threading.Thread(target=_run_in_background, args=(dbname, ids, method), daemon=True)
            t.start()
        self.env.cr.postcommit.add(_start)

    def _announce_new_client_ticket(self):
        """Everything a new (or re-sent) client request tells the admins:
        the in-app queue notice, its re-nudge, and the approval-chain links."""
        for rec in self:
            try:
                rec._notify('client_task_queued')
                rec._schedule_queue_nudge()
            except Exception as exc:
                _logger.warning('client ticket notify failed for %s: %s', rec.id, exc)
            rec._post_db_request_to_team()
            rec._wa_ask_admins()

    def _post_db_request_to_team(self):
        """A new database / destroy request goes to our team group as well
        (the 'new_database' / 'db_destroy' events, switched and worded in
        Configuration > WhatsApp Group Reports). The client's own group already
        has its receipt from the form. Never raises."""
        self.ensure_one()
        event = {'new_database': 'new_database', 'db_disconnect': 'db_destroy'}.get(
            self.request_category or '')
        if not event:
            return False
        try:
            Report = self.env['kpi.wa.group.report'].sudo()
            db = self.client_db_id
            if event == 'db_destroy' and not db:
                db = self.env['kpi.client.db'].sudo().search(
                    [('disconnect_request_kpi_id', '=', self.id)], limit=1)
            values = {
                'client': (self.client_kra_id or self.kra_id).name or '',
                'ref': self.external_ref or '#%s' % self.id,
                'server': (self.provision_server_id.name if event == 'new_database'
                           else db.server_id.name) or self.provision_server_other or '—',
                'db': (self.provision_db_name if event == 'new_database' else db.db_name) or '—',
                'notes': self.provision_modules or '—',
                'reason': (db.disconnect_reason_text if db else '') or '—',
                'by': self.submitted_by_uid.name or (
                    db.disconnect_requested_by_name if db and event == 'db_destroy' else '') or '—',
            }
            body = Report._render_event(event, values)
            return bool(body.strip()) and bool(Report._post(body))
        except Exception as exc:
            _logger.warning('team group post (%s) for %s failed: %s', event, self.id, exc)
            return False

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
