"""One desk for every decision waiting on an admin.

WHY THIS EXISTS
---------------
Six different things wait on an admin, and before this they waited in six
different places:

* a client raised something            -> inside the OWL KPI board, in a tab
* a client asked for a new database    -> the same tab, looking identical
* a developer finished something       -> a different tab of the same board
* a client asked to be switched off    -> Clients > Live Databases
* a database is waiting to go live     -> Setup > Databases
* a client asked for a meeting         -> My Work > Meetings

Right now that is 8 + 1 + 57 + 0 + 0 + 4 = seventy decisions spread over four
screens, three of which are inside a board the admin says confuses them. The
practical result is that things are not refused -- they are simply never
looked at.

HOW IT IS BUILT, AND WHY THAT WAY
---------------------------------
A SQL VIEW, not a table. There is no copy of anything here: every row is read
straight from the record it stands for, every time the screen opens. The
alternative -- a real table kept in step by hooks on six models -- has one
failure mode this cannot have, which is a queue that disagrees with reality.
A task approved somewhere else simply stops appearing here; nothing has to
notice and nothing has to clean up.

The consequence is that rows are READ-ONLY. Every decision therefore goes
through `action_approve` / `action_reject`, which call the SAME methods the
original screens call -- `publish`, `action_decline`, `approve_task`,
`action_disconnect`, `action_activate`, `action_confirm`. This screen adds no
new way to change anything. If a rule exists on one of those methods (a
developer must be named before publishing; a reason must be given before
declining) it still applies here, because it is still the same code running.

IDs
---
A view has to produce one unique id per row, and six sources can all hand out
id 7. Each kind therefore gets a 100-million band: new requests are
100000001.., QA is 300000001.., and so on. `res_model` / `res_id` carry the
real address, and `_source()` is the only thing that should ever resolve it.
"""

import logging

from odoo import _, api, fields, models, tools
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

# The band each kind lives in. Order here is the order the sections appear.
KIND_BAND = {
    'new_request': 1,
    'new_database': 2,
    'disconnect': 3,
    'db_live': 4,
    'meeting': 5,
    'qa': 6,
}
BAND = 100000000

KINDS = [
    ('new_request', 'Client raised something'),
    ('new_database', 'New database asked for'),
    ('disconnect', 'Asked to be switched off'),
    ('db_live', 'Database waiting to go live'),
    ('meeting', 'Meeting asked for'),
    ('qa', 'Work finished, needs checking'),
]

# What the two buttons mean, per kind, in the admin's own words. Shown on the
# confirmation step so nobody approves one kind thinking it does another.
WORDING = {
    'new_request': ('Accept it and put it on a developer',
                    'Tell the client we are not doing it'),
    'new_database': ('Accept it and start building the database',
                     'Tell the client we are not building it'),
    'disconnect': ('Switch the database off',
                   'Refuse -- keep the database running'),
    'db_live': ('Mark the database live',
                'Drop it from the list'),
    'meeting': ('Confirm the time and send the link',
                'Cancel the meeting'),
    'qa': ('Passed -- send it on for sign-off',
           'Send it back to the developer'),
}


class KpiApproval(models.Model):
    _name = 'kpi.approval'
    _description = 'Waiting for an admin'
    _auto = False
    _order = 'requested_on desc, id desc'

    kind = fields.Selection(KINDS, string='What', readonly=True)
    res_model = fields.Char(string='Model', readonly=True)
    res_id = fields.Integer(string='Record', readonly=True)
    reference = fields.Char(string='Ref', readonly=True)
    name = fields.Char(string='What is waiting', readonly=True)
    detail = fields.Char(string='About', readonly=True)
    client_kra_id = fields.Many2one('kra.master', string='Client',
                                    readonly=True)
    requested_on = fields.Datetime(string='Asked On', readonly=True)
    requested_by = fields.Char(string='Asked By', readonly=True)

    # Shown as a plain sentence on the row, so the admin does not have to know
    # what "QA" or "db_live" mean to decide.
    approve_label = fields.Char(compute='_compute_labels')
    reject_label = fields.Char(compute='_compute_labels')
    waiting_days = fields.Integer(string='Waiting', compute='_compute_waiting')

    # ------------------------------------------------------------------
    @api.depends('kind')
    def _compute_labels(self):
        for rec in self:
            yes, no = WORDING.get(rec.kind, ('Approve', 'Reject'))
            rec.approve_label = yes
            rec.reject_label = no

    @api.depends('requested_on')
    def _compute_waiting(self):
        now = fields.Datetime.now()
        for rec in self:
            rec.waiting_days = ((now - rec.requested_on).days
                                if rec.requested_on else 0)

    # ------------------------------------------------------------------
    def init(self):
        tools.drop_view_if_exists(self.env.cr, self._table)
        self.env.cr.execute("""
CREATE OR REPLACE VIEW %s AS

-- 1. A client raised a requirement / update / bug and nobody has taken it on.
--    'new_database' is excluded here because it gets its own section; without
--    that exclusion every database request would be listed twice.
SELECT (%s + k.id)                              AS id,
       'new_request'::varchar                   AS kind,
       'kra.kpi'::varchar                       AS res_model,
       k.id                                     AS res_id,
       COALESCE(k.external_ref, '')::varchar    AS reference,
       k.name::varchar                          AS name,
       (SELECT m.name FROM kra_master m
         WHERE m.id = k.kra_id)::varchar        AS detail,
       k.client_kra_id                          AS client_kra_id,
       k.create_date                            AS requested_on,
       (SELECT p.name FROM res_users u
          JOIN res_partner p ON p.id = u.partner_id
         WHERE u.id = k.submitted_by_uid)::varchar AS requested_by
  FROM kra_kpi k
 WHERE k.client_submitted IS TRUE
   AND k.published IS NOT TRUE
   AND COALESCE(k.active, TRUE) IS TRUE
   AND COALESCE(k.request_category, 'standard') <> 'new_database'

UNION ALL

-- 2. A client asked for a whole new database. Same gate as above, but the
--    work behind a yes is the 8-step provisioning checklist, so it is worth
--    seeing separately from "fix the printer".
SELECT (%s + k.id), 'new_database'::varchar, 'kra.kpi'::varchar, k.id,
       COALESCE(k.external_ref, '')::varchar,
       k.name::varchar,
       (COALESCE(k.provision_db_name, '?') || ' on ' ||
        COALESCE((SELECT s.name FROM kpi_server s
                   WHERE s.id = k.provision_server_id),
                 COALESCE(k.provision_server_other, '?')))::varchar,
       k.client_kra_id,
       k.create_date,
       (SELECT p.name FROM res_users u
          JOIN res_partner p ON p.id = u.partner_id
         WHERE u.id = k.submitted_by_uid)::varchar
  FROM kra_kpi k
 WHERE k.request_category = 'new_database'
   AND COALESCE(k.active, TRUE) IS TRUE
   AND COALESCE(k.provision_chk_registered, FALSE) IS NOT TRUE

UNION ALL

-- 3. The client asked, on WhatsApp, for a database to be switched off. Until
--    an admin acts the database stays live and still accepts work.
SELECT (%s + d.id), 'disconnect'::varchar, 'kpi.client.db'::varchar, d.id,
       ''::varchar,
       (d.db_name || ' @ ' ||
        COALESCE((SELECT s.name FROM kpi_server s
                   WHERE s.id = d.server_id), '?'))::varchar,
       COALESCE(d.disconnect_reason_text, '')::varchar,
       d.client_kra_id,
       d.disconnect_requested_at,
       NULLIF(TRIM(COALESCE(d.disconnect_requested_by_name, '') || ' ' ||
                   COALESCE(d.disconnect_requested_by_number, '')),
              '')::varchar
  FROM kpi_client_db d
 WHERE d.disconnect_state = 'requested'
   AND COALESCE(d.active, TRUE) IS TRUE

UNION ALL

-- 4. A database row exists but has never been marked live -- typically one
--    found by a server scan, or added by hand and left half-done. It is
--    offered to nobody on WhatsApp until somebody says yes.
SELECT (%s + d.id), 'db_live'::varchar, 'kpi.client.db'::varchar, d.id,
       ''::varchar,
       (d.db_name || ' @ ' ||
        COALESCE((SELECT s.name FROM kpi_server s
                   WHERE s.id = d.server_id), '?'))::varchar,
       COALESCE(d.source, '')::varchar,
       d.client_kra_id,
       COALESCE(d.first_seen_at, d.create_date),
       NULL::varchar
  FROM kpi_client_db d
 WHERE d.state = 'pending'
   AND COALESCE(d.active, TRUE) IS TRUE

UNION ALL

-- 5. A meeting the client asked for that nobody has confirmed. These arrive
--    with no organiser, and sometimes with only the words the client typed
--    rather than a time, which is why saying yes needs a dialog.
SELECT (%s + m.id), 'meeting'::varchar, 'kpi.meeting'::varchar, m.id,
       ''::varchar,
       m.name::varchar,
       COALESCE(m.requested_text,
                TO_CHAR(m.scheduled_start, 'DD Mon HH24:MI'),
                '')::varchar,
       m.client_kra_id,
       m.create_date,
       COALESCE(m.requested_by_name, m.requested_by_number)::varchar
  FROM kpi_meeting m
 WHERE m.state = 'requested'

UNION ALL

-- 6. A developer says the work is done. Nothing reaches the client for
--    sign-off until an admin has checked it.
SELECT (%s + k.id), 'qa'::varchar, 'kra.kpi'::varchar, k.id,
       COALESCE(k.external_ref, '')::varchar,
       k.name::varchar,
       (SELECT p.name FROM res_users u
          JOIN res_partner p ON p.id = u.partner_id
         WHERE u.id = k.user_id)::varchar,
       k.client_kra_id,
       COALESCE(k.completion_date, k.write_date),
       (SELECT p.name FROM res_users u
          JOIN res_partner p ON p.id = u.partner_id
         WHERE u.id = k.completed_by)::varchar
  FROM kra_kpi k
 WHERE k.task_state = 'partially_completed'
   AND COALESCE(k.admin_approved, FALSE) IS NOT TRUE
   AND COALESCE(k.active, TRUE) IS TRUE
""" % ((self._table,) + tuple(KIND_BAND[k] * BAND for k, _lbl in KINDS)))

    # ------------------------------------------------------------------
    # A SQL view reads the TABLES. Odoo flushes pending writes per model, and
    # it has no way to know that reading kpi.approval means reading kra_kpi,
    # kpi_client_db and kpi_meeting -- so a decision taken earlier in the same
    # transaction would still be sitting in the ORM cache, and the row it
    # removed would still be on the list.
    #
    # In the browser that is hidden, because the next read is a new request on
    # a committed transaction. It shows up the moment anything approves and
    # re-reads in one go: a test, a cron, or a JSON route that returns the new
    # counts. Flushing here makes the view mean what it says in every case.
    _SOURCE_MODELS = ('kra.kpi', 'kpi.client.db', 'kpi.meeting')

    def _flush_sources(self):
        for model in self._SOURCE_MODELS:
            self.env[model].flush_model()

    def _search(self, domain, offset=0, limit=None, order=None, **kwargs):
        self._flush_sources()
        return super()._search(domain, offset=offset, limit=limit,
                               order=order, **kwargs)

    def _read_group(self, domain, groupby=(), aggregates=(), **kwargs):
        self._flush_sources()
        return super()._read_group(domain, groupby, aggregates, **kwargs)

    # ------------------------------------------------------------------
    def _source(self):
        """The real record this row stands for.

        Everything that changes anything goes through here, so there is
        exactly one place where a view id turns back into a record.
        """
        self.ensure_one()
        if not self.res_model or not self.res_id:
            raise UserError(_('This row has lost track of its record. '
                              'Refresh the list.'))
        rec = self.env[self.res_model].sudo().browse(self.res_id)
        if not rec.exists():
            raise UserError(_(
                'That record is gone -- somebody dealt with it while this '
                'list was open. Refresh and it will no longer be here.'))
        return rec

    def _check_admin(self):
        """Same three groups the original screens check."""
        user = self.env.user
        if not (user.has_group('kra_kpi_module.group_kra_admin')
                or user.has_group('kra_kpi_module.group_kra_owner')
                or user.has_group('base.group_system')):
            raise UserError(_('Only an admin can approve or refuse these.'))

    # ------------------------------------------------------------------
    def action_open(self):
        """Open the real record, for when the one line here is not enough."""
        self.ensure_one()
        rec = self._source()
        return {
            'type': 'ir.actions.act_window',
            'res_model': self.res_model,
            'res_id': rec.id,
            'view_mode': 'form',
            'target': 'current',
            'name': self.name or _('Record'),
        }

    def action_approve(self):
        return self._decide('approve')

    def action_reject(self):
        return self._decide('reject')

    def _decide(self, decision):
        """Do it now when nothing more is needed; otherwise ask for what is.

        Refusing ALWAYS opens the dialog -- a refusal with no reason is the
        exact failure `/kpi_pending_queue/delete` had, where the client was
        told nothing and nothing was written down.
        """
        self.ensure_one()
        self._check_admin()
        rec = self._source()

        if decision == 'approve':
            # The only two that need nothing from the admin.
            if self.kind == 'qa':
                rec.approve_task()
                return self._done(_('Checked. %s now goes to the client to '
                                    'sign off.') % (self.name or ''))
            if self.kind == 'db_live':
                rec.action_activate()
                return self._done(_('%s is live.') % (self.name or ''))

        return self._ask(decision)

    def _ask(self, decision):
        """Open the one dialog that collects whatever this decision needs."""
        self.ensure_one()
        yes, no = WORDING.get(self.kind, ('Approve', 'Reject'))
        return {
            'type': 'ir.actions.act_window',
            'res_model': 'kpi.approval.decide',
            'view_mode': 'form',
            'target': 'new',
            'name': yes if decision == 'approve' else no,
            'context': {
                'default_res_model': self.res_model,
                'default_res_id': self.res_id,
                'default_kind': self.kind,
                'default_decision': decision,
                'default_summary': '%s%s' % (
                    (self.reference + ' — ') if self.reference else '',
                    self.name or ''),
            },
        }

    @api.model
    def _done(self, message):
        """Say what happened and put the admin back on the list, one shorter."""
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'type': 'success',
                'title': _('Done'),
                'message': message,
                'sticky': False,
                'next': {'type': 'ir.actions.act_window_close'},
            },
        }

    # ------------------------------------------------------------------
    @api.model
    def waiting_counts(self):
        """How many of each kind are waiting. Used by the welcome screen and
        available to the web UI over JSON."""
        out = {k: 0 for k, _lbl in KINDS}
        for kind, count in self.sudo()._read_group([], ['kind'], ['__count']):
            if kind in out:
                out[kind] = count
        out['total'] = sum(out[k] for k, _lbl in KINDS)
        return out

    # A view has no table to write to. Saying so plainly beats whatever
    # Postgres would say about a read-only relation.
    def write(self, vals):
        raise UserError(_(
            'Nothing is edited here. Use Approve or Refuse, or open the '
            'record itself with the link on the row.'))

    @api.model_create_multi
    def create(self, vals_list):
        raise UserError(_('This list is built from what is waiting. Rows '
                          'cannot be added to it by hand.'))

    def unlink(self):
        raise UserError(_(
            'Deciding is what removes a row from this list. Approve it or '
            'refuse it -- do not delete it.'))


class KpiApprovalDecide(models.TransientModel):
    """The one dialog behind both buttons.

    It shows only the fields the decision in front of it actually needs, and
    then calls the module's existing method for that decision. It deliberately
    holds no logic of its own beyond collecting input: the rules about who may
    do what, and what has to be true first, stay on the models.
    """
    _name = 'kpi.approval.decide'
    _description = 'Approve or refuse'

    res_model = fields.Char(required=True, readonly=True)
    res_id = fields.Integer(required=True, readonly=True)
    kind = fields.Selection(KINDS, required=True, readonly=True)
    decision = fields.Selection([('approve', 'Approve'),
                                 ('reject', 'Refuse')],
                                required=True, readonly=True)
    summary = fields.Char(string='This one', readonly=True)
    headline = fields.Char(compute='_compute_headline')

    # --- accepting a client request ---
    user_id = fields.Many2one(
        'res.users', string='Give it to',
        help='A task cannot be published without a developer: the client is '
             'asked to approve WHO it went to, so there has to be a name.')

    # --- refusing anything ---
    reason_id = fields.Many2one(
        'kpi.decline.reason', string='Reason',
        domain="[('mode', '=', 'decline')]")
    note = fields.Text(
        string='In your own words',
        help='The client is shown this. Leave it blank to send the standard '
             'wording for the reason above.')
    tell_client = fields.Boolean(
        string='Tell the client on WhatsApp', default=True,
        help='Untick only when they already know. It is recorded either way.')

    # --- confirming a meeting ---
    scheduled_start = fields.Datetime(string='Starts')
    organizer_id = fields.Many2one('res.users', string='Who joins')
    requested_text = fields.Char(string='They asked for', readonly=True)

    # ------------------------------------------------------------------
    @api.depends('kind', 'decision')
    def _compute_headline(self):
        for rec in self:
            yes, no = WORDING.get(rec.kind, ('Approve', 'Reject'))
            rec.headline = yes if rec.decision == 'approve' else no

    @api.model
    def default_get(self, fields_list):
        vals = super().default_get(fields_list)
        model, rid = vals.get('res_model'), vals.get('res_id')
        if model == 'kpi.meeting' and rid:
            meeting = self.env['kpi.meeting'].sudo().browse(rid)
            if meeting.exists():
                vals.setdefault('scheduled_start', meeting.scheduled_start)
                vals.setdefault('organizer_id',
                                meeting.organizer_id.id or self.env.uid)
                vals['requested_text'] = meeting.requested_text or ''
        if model == 'kra.kpi' and rid and vals.get('decision') == 'approve':
            kpi = self.env['kra.kpi'].sudo().browse(rid)
            if kpi.exists() and kpi.user_id:
                vals.setdefault('user_id', kpi.user_id.id)
        return vals

    # ------------------------------------------------------------------
    def _record(self):
        self.ensure_one()
        rec = self.env[self.res_model].sudo().browse(self.res_id)
        if not rec.exists():
            raise UserError(_('That record is gone. Close this and refresh.'))
        return rec

    def _reason_text(self):
        """The wording the client is shown. One of the two has to be there."""
        text = (self.note or '').strip()
        if not text and self.reason_id:
            text = self.reason_id.text_for_client()
        if not text:
            raise UserError(_(
                'Say why. The client is told this, and "no" with no reason '
                'is what brings them back asking the same thing again.'))
        return text

    def action_apply(self):
        self.ensure_one()
        self.env['kpi.approval']._check_admin()
        rec = self._record()
        handler = getattr(self, '_do_%s_%s' % (self.decision, self.kind), None)
        if handler is None:
            raise UserError(_('Nothing is wired up for that yet.'))
        message = handler(rec)
        _logger.info('kpi.approval: %s %s %s#%s by %s',
                     self.decision, self.kind, self.res_model, self.res_id,
                     self.env.user.login)
        return self.env['kpi.approval']._done(message)

    # ---- accepting --------------------------------------------------- #
    def _publish(self, kpi):
        """Accept a client submission. Mirrors /kpi_pending_queue/publish."""
        if not self.user_id:
            raise UserError(_(
                'Pick who it goes to. The client is asked to approve the '
                'person as well as the work, so there has to be a name.'))
        if kpi.user_id != self.user_id:
            kpi.write({'user_id': self.user_id.id})
        if not kpi.published:
            kpi.write({'published': True})
            # Assigning a developer can publish the row by itself and fire the
            # pre-approval; only ask when that did not happen, or a task that
            # already had a developer would go out without the client ever
            # being asked.
            if kpi.task_state in ('assigned', 'queue_waiting') \
                    and kpi.admin_accepted:
                try:
                    kpi.request_client_pre_approval()
                except Exception as exc:
                    _logger.warning('pre-approval request failed for %s: %s',
                                    kpi.id, exc)
        return kpi

    def _do_approve_new_request(self, kpi):
        self._publish(kpi)
        return _('%(ref)s is on %(who)s.') % {
            'ref': kpi.external_ref or kpi.name,
            'who': self.user_id.name}

    def _do_approve_new_database(self, kpi):
        self._publish(kpi)
        return _('%(ref)s is on %(who)s. Open it to work through the '
                 'build checklist.') % {
            'ref': kpi.external_ref or kpi.name,
            'who': self.user_id.name}

    def _do_approve_disconnect(self, db):
        db.action_disconnect(note=self._reason_text(),
                             tell_client=self.tell_client)
        return _('%s is switched off. Existing tickets on it stay '
                 'invoiceable.') % db.db_name

    def _do_approve_meeting(self, meeting):
        vals = {}
        if self.scheduled_start:
            vals['scheduled_start'] = self.scheduled_start
        if self.organizer_id:
            vals['organizer_id'] = self.organizer_id.id
        if vals:
            meeting.write(vals)
        meeting.action_confirm()
        return _('Meeting confirmed. %s has been sent the link.') % (
            meeting.requested_by_name or _('The client'))

    # ---- refusing ---------------------------------------------------- #
    def _do_reject_new_request(self, kpi):
        kpi.action_decline(mode='decline',
                           reason_id=self.reason_id.id or None,
                           reason_text=(self.note or '').strip(),
                           notify_group=self.tell_client)
        return _('%s is closed, and the client has been told why.') % (
            kpi.external_ref or kpi.name)

    _do_reject_new_database = _do_reject_new_request

    def _do_reject_disconnect(self, db):
        db.action_reject_disconnect(note=self._reason_text())
        return _('Refused. %s stays running and the client has been '
                 'told why.') % db.db_name

    def _do_reject_db_live(self, db):
        """Not a client-facing refusal: the row is simply dropped from the
        list. Archived rather than deleted, so a scan that finds the database
        again does not quietly create a second row for it."""
        db.write({'active': False,
                  'notes': ((db.notes or '') + '\n' + self._reason_text()).strip()})
        return _('%s dropped from the list.') % db.db_name

    def _do_reject_meeting(self, meeting):
        meeting.action_cancel(reason=self._reason_text())
        return _('Meeting cancelled, and the client has been told.')

    def _do_reject_qa(self, kpi):
        kpi.reject_task(rejection_reason=self._reason_text())
        return _('Sent back to %s.') % (kpi.user_id.name or _('the developer'))
