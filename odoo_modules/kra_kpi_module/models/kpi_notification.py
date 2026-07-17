"""kpi.notification — per-user, browsable notification feed for the mobile app.

Unlike kpi.action.log (an audit trail) and kpi.notification.queue (a WhatsApp
retry queue), this model stores one row *per recipient user* with per-user
read/unread state, so the app can show a Notifications section with an accurate
unread badge and mark-as-read.

Rows are written by the `_notify` dispatcher (see kpi_notify.py) for a curated
set of assignment/upload events, reusing its already-resolved recipient list.
Because that recipient list comes from `_EVENT_RECIPIENTS`, the "admins see all
/ developers see their own tasks" scoping falls out for free: a developer only
ever gets a row when they are a recipient of the event (i.e. their own task).
"""

from datetime import timedelta

from odoo import api, fields, models


class KpiNotification(models.Model):
    _name = 'kpi.notification'
    _description = 'KPI User Notification (per-recipient feed)'
    _order = 'create_date desc, id desc'

    user_id = fields.Many2one(
        'res.users',
        string='Recipient',
        required=True,
        index=True,
        ondelete='cascade',
    )
    kpi_id = fields.Many2one(
        'kra.kpi',
        string='Task',
        ondelete='cascade',
        index=True,
    )
    # What to open when this notification is TAPPED, when the answer isn't a task.
    # "X ended their workday" points at the day's frozen summary image, not at any
    # kra.kpi — without this the row is untappable, because the app routes purely
    # on kpi_id.
    #
    # ondelete='set null', NOT cascade: deleting a snapshot must not silently delete
    # the notification that mentioned it. The row survives and simply stops being
    # tappable — the same trap that bit the discard notification with kpi_id.
    snapshot_id = fields.Many2one(
        'kpi.workday.snapshot',
        string='Workday Snapshot',
        ondelete='set null',
        index=True,
    )
    # What to open when a "daily report ready" notification is TAPPED — the day's
    # generated PDF (kpi.daily.report), which is not a task either. Same rationale
    # and same ondelete='set null' trap as snapshot_id: purging a report must not
    # delete the notification that mentioned it — the row survives, untappable.
    report_id = fields.Many2one(
        'kpi.daily.report',
        string='Daily Report',
        ondelete='set null',
        index=True,
    )
    # What to open when an invoice notification is TAPPED — the client invoice
    # (kpi.client.invoice). Same ondelete='set null' rationale as report_id/snapshot_id:
    # deleting an invoice must not delete the notification that mentioned it.
    invoice_id = fields.Many2one(
        'kpi.client.invoice',
        string='Client Invoice',
        ondelete='set null',
        index=True,
    )
    # Free-text event key mirroring kpi.action.log.event, e.g.
    #   task_created, task_assigned, reassigned, self_task_submitted
    event = fields.Char(string='Event', required=True, index=True)
    # The recipient role that matched (owner / coordinator / developer), kept
    # for context / potential filtering. Not security-relevant.
    role = fields.Char(string='Recipient Role')

    title = fields.Char(string='Title')
    body = fields.Text(string='Body')

    is_read = fields.Boolean(string='Read', default=False, index=True)
    read_at = fields.Datetime(string='Read At')

    @api.model
    def create_for_recipients(self, kpi, event, title, body, recipients):
        """Create one notification row per distinct recipient user.

        `recipients` is the list of {phone, partner_id, user_id, role} dicts
        produced by `kra.kpi._resolve_recipients`. Recipients without a
        `user_id` (ad-hoc phone numbers, urgent-extra) are skipped — there is
        no in-app account to show them to. Duplicate user_ids within one call
        are collapsed so a user never gets two rows for the same event.
        """
        seen = set()
        vals_list = []
        for rcp in (recipients or []):
            uid = rcp.get('user_id')
            if not uid or uid in seen:
                continue
            seen.add(uid)
            vals_list.append({
                'user_id': uid,
                'kpi_id': kpi.id if kpi else False,
                'event': event,
                'role': rcp.get('role'),
                'title': title,
                'body': body,
            })
        if not vals_list:
            return self.browse()
        return self.sudo().create(vals_list)

    @api.model
    def _gc_notifications(self, days=30):
        """Delete notifications older than `days` (default 30). Called by the
        daily cron so the in-app feed stays recent and the table small."""
        if not days or days <= 0:
            return 0
        cutoff = fields.Datetime.now() - timedelta(days=days)
        old = self.sudo().search([('create_date', '<', cutoff)])
        count = len(old)
        old.unlink()
        return count
