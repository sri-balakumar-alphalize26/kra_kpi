"""Which databases exist, whose they are, and whether they are still live.

WHAT THIS FIXES
---------------
Before this, the only trace of a database anywhere in the module was
`kra.kpi.provision_db_name` -- a Char on a ticket. So:

* the intake bot could not ask WHICH database a bug was about, and filed every
  ticket against the client (or, worse, against their only child node, because
  `_create_ticket` picked `children[0]` when there happened to be exactly one);
* nothing knew which databases were live, on what terms, or when they expired;
* a client asking for a database to be switched off left no record at all.

WHY NOT A kra.master NODE PER DATABASE
--------------------------------------
`kra.master._compute_is_client` marks every root and every level-2 node as a
client automatically, and the invoice routes list roots and call level-2 nodes
"projects". A node per database would therefore put databases on invoices and
into the billing tree. `kpi_server.py` already refuses to model servers as KRAs
for exactly this reason; a database is the same kind of thing -- inventory, not
billing.

So the KRA tree keeps its meaning and a ticket gains `client_db_id` beside its
`kra_id`. `kra_id` still says WHO is billed; `client_db_id` says WHAT it was
about.

THE CLIENT-LEAK RULE
--------------------
`client_kra_id` is the gate. A row with no client is offered to NOBODY --
`poll_options_for_client` filters on it, and a database fetched from a server
starts with it empty on purpose. Listing another reseller's database names in a
client's WhatsApp poll is the exact mistake `kpi.wa.group`'s docstring warns
about, and a fetch pulls in every database on the box.

TERMS ARE OPTIONAL
------------------
`track_term` defaults False. Unticked means no term, no expiry, no countdown
and no reminders -- the database just exists and is live. It is a separate tick
rather than "is term_id set?" so that an admin who picked a term once to see
what it did can un-pick it again.

NOTHING HERE SWITCHES ANYTHING OFF BY ITSELF
--------------------------------------------
The bot records a disconnect REQUEST. The expiry cron only notifies. State
changes are an admin pressing a button, because ending a client's service on a
timer or on a chat message is not a decision this system gets to make on its
own -- the same rule the decline flow already follows about never reading
silence as consent.
"""

import logging

from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

_logger = logging.getLogger(__name__)

# A poll fits 12 options. The database picker also needs a "Common" row and an
# "Other" row, so the table itself is capped at 10.
POLL_MAX_DBS = 10

# Reminder points, in days before expiry, plus 0 for the day it passes.
TERM_REMINDER_DAYS = (30, 7, 1, 0)


class KpiClientDb(models.Model):
    _name = 'kpi.client.db'
    _description = 'Client Database'
    _order = 'client_kra_id, server_id, db_name'
    _rec_name = 'db_name'

    # ---- identity ----------------------------------------------------------- #
    db_name = fields.Char(
        string='Database', required=True, index=True,
        help='The real Postgres database name, exactly.')
    server_id = fields.Many2one(
        'kpi.server', string='Server', required=True, index=True,
        ondelete='restrict')
    label = fields.Char(
        help='Friendlier text for the WhatsApp menu, e.g. "Al Khuwair shop". '
             'Falls back to the database name.')

    # ---- ownership ---------------------------------------------------------- #
    client_kra_id = fields.Many2one(
        'kra.master', string='Client', index=True, ondelete='cascade',
        domain="[('is_client', '=', True)]",
        help='EMPTY MEANS NOBODY IS OFFERED THIS DATABASE. A name fetched '
             'from a server starts empty until somebody says whose it is.')
    kra_id = fields.Many2one(
        'kra.master', string='File Tasks Under', ondelete='restrict',
        help='The KRA a task about this database is created against. Leave '
             'empty to use the client itself; set it to a sub-client when '
             'this database is one shop of several.')

    source = fields.Selection([
        ('manual', 'Entered by hand'),
        ('provisioned', 'Created by us'),
        ('fetched', 'Found on the server'),
    ], default='manual', required=True, index=True, string='Source')

    # ---- lifecycle ---------------------------------------------------------- #
    state = fields.Selection([
        ('pending', 'Not built yet'),
        ('live', 'Live'),
        ('suspended', 'Suspended'),
        ('disconnected', 'Disconnected'),
    ], default='live', required=True, index=True, string='Status')

    # ---- term (entirely optional) ------------------------------------------- #
    track_term = fields.Boolean(
        string='Track term', default=False,
        help='Off by default. Tick only where a weekly / monthly / yearly '
             'arrangement is real. While it is off there is no term, no '
             'expiry date and no reminders.')
    term_id = fields.Many2one(
        'kpi.db.term', string='Term', ondelete='restrict')
    activated_on = fields.Date(string='Activated')
    expires_on = fields.Date(
        string='Expires',
        help='Suggested from the term when you activate, then yours to edit. '
             'A real agreement rarely matches the arithmetic.')
    # NOT stored. A stored day count is wrong by one every midnight and
    # nothing recomputes it, which is worse than no number at all. The list
    # filters use `expires_on` directly, so nothing needs to sort on this.
    days_left = fields.Integer(
        string='Days Left', compute='_compute_days_left')

    # ---- disconnect --------------------------------------------------------- #
    disconnect_state = fields.Selection([
        ('none', 'Not requested'),
        ('requested', 'Requested by client'),
        ('rejected', 'Request rejected'),
        ('done', 'Disconnected'),
    ], default='none', required=True, index=True, string='Disconnect')
    disconnect_requested_at = fields.Datetime(readonly=True)
    disconnect_requested_by_number = fields.Char(
        string='Asked By (number)', readonly=True)
    disconnect_requested_by_name = fields.Char(
        string='Asked By', readonly=True)
    disconnect_reason_id = fields.Many2one(
        'kpi.db.disconnect.reason', string='Client Reason',
        ondelete='set null', readonly=True)
    disconnect_reason_text = fields.Text(
        string='Reason (as given)', readonly=True)
    disconnect_request_kpi_id = fields.Many2one(
        'kra.kpi', string='Request Ticket', ondelete='set null', readonly=True)
    disconnected_on = fields.Date(readonly=True)
    # The moment it stopped, to the minute. A date alone cannot settle "was
    # this ticket raised before or after we switched it off", which is the
    # one question a disputed invoice turns on.
    disconnected_at = fields.Datetime(string='Stopped At', readonly=True)
    disconnected_by_id = fields.Many2one(
        'res.users', string='Disconnected By', readonly=True,
        ondelete='set null')
    disconnect_note = fields.Text(
        string='Our Note', readonly=True,
        help='Why we suspended, disconnected or refused. Shown to the client.')

    # ---- bookkeeping -------------------------------------------------------- #
    first_seen_at = fields.Datetime(
        string='Added On', default=lambda s: fields.Datetime.now(),
        readonly=True,
        help='When this database was first recorded here — by hand, by a '
             'fetch, or by the last step of a New Database task.')
    last_fetch_at = fields.Datetime(
        string='Last Seen On Server', readonly=True)
    # A real relation, not a search in a compute. The first version counted
    # with search_count() and declared no depends, so Odoo cached the number
    # and never refreshed it -- the screen kept showing a stale count after
    # tickets were added.
    task_ids = fields.One2many('kra.kpi', 'client_db_id', string='Tasks')
    task_count = fields.Integer(compute='_compute_task_count')
    active = fields.Boolean(default=True)
    notes = fields.Text(help='Internal only. Never shown to a client.')

    _sql_constraints = [
        ('server_db_uniq', 'unique(server_id, db_name)',
         'That database is already listed on that server.'),
    ]

    # ------------------------------------------------------------------
    # computes
    # ------------------------------------------------------------------
    @api.depends('db_name', 'server_id.name')
    def _compute_display_name(self):
        """'aoc @ nexgennpos2' -- a bare database name is ambiguous across
        servers, and this record is picked in m2o widgets where only the label
        is visible.

        Overriding the METHOD, not declaring a `display_name` field: declaring
        one shadows Odoo's own and broke `_order` on kpi.wa.group.member the
        last time it was tried in this module.
        """
        for rec in self:
            srv = rec.server_id.name or ''
            rec.display_name = ('%s @ %s' % (rec.db_name or '?', srv)
                                if srv else (rec.db_name or '?'))

    @api.depends('expires_on', 'track_term')
    def _compute_days_left(self):
        today = fields.Date.context_today(self)
        for rec in self:
            if rec.track_term and rec.expires_on:
                rec.days_left = (rec.expires_on - today).days
            else:
                rec.days_left = 0

    @api.depends('task_ids')
    def _compute_task_count(self):
        for rec in self:
            rec.task_count = len(rec.task_ids)

    def action_view_tasks(self):
        """Every ticket ever raised against this database, stopped or not."""
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Tasks on %s') % self.db_name,
            'res_model': 'kra.kpi',
            'view_mode': 'list,form',
            'domain': [('client_db_id', '=', self.id)],
            'context': {'active_test': False},
        }

    # ------------------------------------------------------------------
    # validation
    # ------------------------------------------------------------------
    # Saving a database row is what builds its KRA tree. The alternative was
    # typing the server and the database twice -- once here and once in the
    # KRA master -- and then remembering to untick a flag.
    _KRA_TRIGGERS = {'client_kra_id', 'server_id', 'db_name'}

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('db_name'):
                vals['db_name'] = self._clean_name(vals['db_name'])
        recs = super().create(vals_list)
        recs._ensure_kra()
        return recs

    def write(self, vals):
        if vals.get('db_name'):
            vals['db_name'] = self._clean_name(vals['db_name'])
        res = super().write(vals)
        # No recursion: _ensure_kra writes only `kra_id`, which is not a
        # trigger, and it returns early once kra_id is set.
        if self._KRA_TRIGGERS & set(vals):
            self._ensure_kra()
        return res

    @api.model
    def _clean_name(self, raw):
        """Through kpi.server's validator, so the bot, the fetch and this
        screen can never disagree about what a legal name is."""
        clean, err = self.env['kpi.server'].sudo().validate_db_name(raw)
        if err:
            raise ValidationError(_('%s') % err)
        return clean

    @api.constrains('kra_id', 'client_kra_id')
    def _check_kra_under_client(self):
        """`kra_id` has to sit inside the client's own subtree.

        Without this an admin can file a client's tasks under somebody else's
        KRA with one careless m2o pick, and the mistake only surfaces on an
        invoice.
        """
        for rec in self:
            if not rec.kra_id or not rec.client_kra_id:
                continue
            found = False
            node, seen = rec.kra_id, set()
            while node and node.id not in seen:
                if node.id == rec.client_kra_id.id:
                    found = True
                    break
                seen.add(node.id)
                node = node.parent_id
            if not found:
                raise ValidationError(_(
                    '"%(kra)s" is not under "%(client)s". A task about this '
                    'database would be billed to the wrong client.') % {
                        'kra': rec.kra_id.name or '',
                        'client': rec.client_kra_id.name or ''})

    # ------------------------------------------------------------------
    # the KRA a task about this database belongs to
    # ------------------------------------------------------------------
    def _ensure_kra(self):
        """Build  client -> server -> database  in the KRA tree, on demand.

        The shape the business actually uses:

            Nexgennpos        the client        bills go here
              nexgennpos2     main KRA          the server
                rtr           sub KRA           the database
                  REQ-123     KPI               the task

        Created from the database row rather than typed twice. Nodes are
        found by name before being created, so saving the same row again, or
        adding a second database on the same server, reuses the server node
        instead of making a duplicate.

        THE SERVER NODE IS UNTICKED AS A CLIENT. `kra.master._compute_is_client`
        marks every node one level under a root as a client automatically, so
        a server would otherwise show up as a billable customer in the
        invoices and the KRA report. Unticking it also makes the billing walk
        work: a task under `rtr` looks UP for the nearest node still marked as
        a client, skips the server, and finds Nexgennpos -- which is who the
        invoice should name.
        """
        Kra = self.env['kra.master'].sudo()
        for rec in self:
            if rec.kra_id or not rec.client_kra_id or not rec.db_name:
                continue
            server_name = (rec.server_id.name or '').strip()
            if not server_name:
                continue

            node = Kra.search([('name', '=', server_name),
                               ('parent_id', '=', rec.client_kra_id.id)],
                              limit=1)
            if not node:
                node = Kra.create({'name': server_name,
                                   'parent_id': rec.client_kra_id.id,
                                   'is_sub': True})
                _logger.info('kpi.client.db: created server KRA %r under %r',
                             server_name, rec.client_kra_id.name)
            if node.is_client:
                # A server is not a customer.
                node.write({'is_client': False})

            db_node = Kra.search([('name', '=', rec.db_name),
                                  ('parent_id', '=', node.id)], limit=1)
            if not db_node:
                db_node = Kra.create({'name': rec.db_name,
                                      'parent_id': node.id,
                                      'is_sub': True})
                _logger.info('kpi.client.db: created database KRA %r under %r',
                             rec.db_name, server_name)
            rec.write({'kra_id': db_node.id})
        return True

    def action_build_kra(self):
        """The same thing from a button, for a row that predates this."""
        self._ensure_kra()
        return True

    def target_kra(self):
        """Where a ticket about this database is filed.

        Builds the tree if it is not there yet -- a database registered
        before this existed, or one a client picks seconds after an admin
        adds it, should not have to wait for somebody to create two KRA
        records by hand. Never empty-handed: falls back to the client.
        """
        self.ensure_one()
        if not self.kra_id and self.client_kra_id and self.db_name:
            try:
                self._ensure_kra()
            except Exception as exc:
                # A ticket must never fail to be created because the tree
                # could not be built. It lands on the client instead.
                _logger.warning('could not build the KRA tree for %s: %s',
                                self.db_name, exc)
        return self.kra_id or self.client_kra_id

    # ------------------------------------------------------------------
    # the WhatsApp picker
    # ------------------------------------------------------------------
    @api.model
    def poll_options_for_client(self, client_kra, state='live'):
        """[(id, label)] of one client's databases, for a poll.

        `client_kra` is the kra.master the group is linked to. Only rows that
        name THAT client are returned -- see the client-leak rule above.
        """
        if not client_kra:
            return []
        domain = [('client_kra_id', '=', client_kra.id)]
        if state:
            domain.append(('state', '=', state))
        rows = self.sudo().search(domain, limit=POLL_MAX_DBS + 1)
        if len(rows) > POLL_MAX_DBS:
            _logger.warning(
                'kpi.client.db: %s databases for %s but the poll fits %s once '
                'Common and Other are added -- give the client a shorter '
                'list or archive what is gone.',
                len(rows), client_kra.name or client_kra.id, POLL_MAX_DBS)
            rows = rows[:POLL_MAX_DBS]
        return [(r.id, r.poll_label()) for r in rows]

    def poll_label(self):
        self.ensure_one()
        return (self.label or self.db_name or '').strip()

    @api.model
    def servers_for_client(self, client_kra, state='live'):
        """The kpi.server records this client actually has databases on.

        Used to SKIP the server question when there is only one answer. A menu
        with one option is a turn wasted.
        """
        if not client_kra:
            return self.env['kpi.server']
        domain = [('client_kra_id', '=', client_kra.id)]
        if state:
            domain.append(('state', '=', state))
        return self.sudo().search(domain).mapped('server_id')

    # ------------------------------------------------------------------
    # activation / term
    # ------------------------------------------------------------------
    def action_activate(self):
        """Mark live, and suggest an expiry if a term is being tracked."""
        for rec in self:
            vals = {'state': 'live'}
            if not rec.activated_on:
                vals['activated_on'] = fields.Date.context_today(rec)
            if rec.track_term and rec.term_id and not rec.expires_on:
                vals['expires_on'] = rec.term_id.expiry_from(
                    vals.get('activated_on') or rec.activated_on)
            rec.sudo().write(vals)
        return True

    @api.onchange('term_id', 'track_term', 'activated_on')
    def _onchange_suggest_expiry(self):
        """Fill the expiry in the form as soon as there is enough to compute
        it, and clear it the moment term tracking is switched off."""
        for rec in self:
            if not rec.track_term:
                rec.expires_on = False
                continue
            if rec.term_id and rec.activated_on and not rec.expires_on:
                rec.expires_on = rec.term_id.expiry_from(rec.activated_on)

    # ------------------------------------------------------------------
    # admin state changes
    # ------------------------------------------------------------------
    def _open_status_wizard(self, mode, title):
        """Open the reason-capturing wizard for the selected rows.

        Built in Python rather than referenced as `%(action_x)d` from the view
        so the buttons do not depend on record order inside the XML file, and
        so one method serves both the list header (self = the ticked rows) and
        the form (self = the one record).
        """
        return {
            'type': 'ir.actions.act_window',
            'name': title,
            'res_model': 'kpi.client.db.action',
            'view_mode': 'form',
            'views': [(False, 'form')],
            'target': 'new',
            'context': dict(self.env.context, default_mode=mode,
                            active_model=self._name, active_ids=self.ids,
                            active_id=self.ids[0] if self.ids else False),
        }

    def action_open_suspend(self):
        return self._open_status_wizard('suspend', _('Suspend database'))

    def action_open_disconnect(self):
        return self._open_status_wizard('disconnect', _('Disconnect database'))

    def action_open_reject(self):
        return self._open_status_wizard('reject', _('Refuse the request'))

    def action_suspend(self, note=''):
        """Stop offering it, without losing it."""
        for rec in self:
            rec.sudo().write({'state': 'suspended',
                              'disconnect_note': note or rec.disconnect_note})
            rec._log('db_suspended', {'note': note})
        return True

    def action_reactivate(self):
        for rec in self:
            if rec.state == 'disconnected':
                raise ValidationError(_(
                    '%s was disconnected. Reactivating a disconnected '
                    'database hides the fact that it ever stopped; create a '
                    'fresh row, or clear the disconnection first.')
                    % rec.db_name)
            rec.sudo().write({'state': 'live'})
            rec._log('db_reactivated', {})
        return True

    def action_disconnect(self, note='', tell_client=True):
        """Switch it off for good. The only method that sets 'disconnected'."""
        for rec in self:
            rec.sudo().write({
                'state': 'disconnected',
                'disconnect_state': 'done',
                'disconnected_on': fields.Date.context_today(rec),
                'disconnected_at': fields.Datetime.now(),
                'disconnected_by_id': rec.env.user.id,
                'disconnect_note': note or rec.disconnect_note,
            })
            rec._log('db_disconnected', {'note': note})
            if tell_client:
                rec._tell_client_disconnected(note)
        return True

    def action_reject_disconnect(self, note=''):
        """Refuse a client's request, with a reason they are told."""
        for rec in self:
            if rec.disconnect_state != 'requested':
                raise ValidationError(_(
                    'There is no open disconnect request for %s.')
                    % rec.db_name)
            if not (note or '').strip():
                raise ValidationError(_(
                    'Give a reason. The client asked for this in writing and '
                    'is owed an answer in writing.'))
            rec.sudo().write({'disconnect_state': 'rejected',
                              'disconnect_note': note})
            rec._log('db_disconnect_rejected', {'note': note})
            rec._post_to_client_group(_(
                "*Disconnect not actioned*\n"
                "Database: *%(db)s*  ·  Server: %(srv)s\n\n"
                "%(note)s\n\n"
                "_%(db)s is still live. Reply here if this is wrong._") % {
                    'db': rec.db_name or '',
                    'srv': rec.server_id.name or '—',
                    'note': note})
        return True

    # ------------------------------------------------------------------
    # the client's request, from WhatsApp
    # ------------------------------------------------------------------
    def request_disconnect(self, kpi=None, reason=None, reason_text='',
                           by_number='', by_name=''):
        """Record that the client asked for this database to be switched off.

        Records a REQUEST and nothing more: `state` is untouched, so the
        database stays live until an admin acts. Returns the receipt text the
        bot posts, which is also the proof -- it names the database, the
        person, their number and the time, in the group where the whole client
        team can see it.
        """
        self.ensure_one()
        reason_label = ''
        if reason and reason.exists():
            reason_label = reason.name or ''
        text = (reason_text or '').strip()
        self.sudo().write({
            'disconnect_state': 'requested',
            'disconnect_requested_at': fields.Datetime.now(),
            'disconnect_requested_by_number': by_number or '',
            'disconnect_requested_by_name': by_name or '',
            'disconnect_reason_id': reason.id if (reason and reason.exists())
                                    else False,
            'disconnect_reason_text': text or reason_label,
            'disconnect_request_kpi_id': kpi.id if kpi else False,
        })
        self._log('db_disconnect_requested', {
            'db': self.db_name, 'server': self.server_id.name,
            'reason': reason_label or text, 'by_number': by_number,
            'by_name': by_name}, kpi=kpi)

        shown = ' — '.join(p for p in (reason_label, text) if p) or '—'
        return _(
            "💥 *Destroy requested*%(ref)s\n"
            "🗄️ Database: *%(db)s*\n"
            "🖥️ Server: %(srv)s\n"
            "📝 Reason: %(reason)s\n"
            "👤 Asked by: %(who)s%(num)s\n"
            "🕒 %(when)s\n\n"
            "_Nothing is switched off yet. The team will confirm._") % {
                'ref': (' — %s' % kpi.external_ref) if (kpi and kpi.external_ref)
                       else '',
                'db': self.db_name or '',
                'srv': self.server_id.name or '—',
                'reason': shown,
                'who': by_name or _('a group member'),
                'num': (' (+%s)' % by_number) if by_number else '',
                'when': self.env['kpi.tz'].fmt_now(),
            }

    # ------------------------------------------------------------------
    # telling the client
    # ------------------------------------------------------------------
    def _client_group(self):
        """The WhatsApp group linked to this database's client, or empty.

        Walks UP from the filing KRA the way kpi.wa.group.report does, because
        a database may be filed under a sub-client while the group is linked
        to the reseller. Never falls back to the company group.
        """
        self.ensure_one()
        Group = self.env['kpi.wa.group'].sudo()
        node, seen = self.target_kra(), set()
        while node and node.id not in seen:
            seen.add(node.id)
            grp = Group.search([('kra_id', '=', node.id),
                                ('active', '=', True)], limit=1)
            if grp:
                return grp
            node = node.parent_id
        return Group

    def _post_to_client_group(self, body):
        """True if it went out. Never raises -- telling the client is a side
        effect of the state change, never a condition of it."""
        self.ensure_one()
        try:
            if self.disconnect_request_kpi_id:
                return bool(self.env['kpi.wa.group.report'].sudo()
                            .post_for_kpi(self.disconnect_request_kpi_id, body))
            grp = self._client_group()
            if not grp:
                _logger.info('No WhatsApp group for the client of %s',
                             self.display_name)
                return False
            return bool(self.env['kpi.wa.group.report'].sudo()
                        ._post(body, jid=grp.jid))
        except Exception as exc:
            _logger.warning('Could not post about %s: %s',
                            self.db_name or self.id, exc)
            return False

    def _tell_client_disconnected(self, note=''):
        self.ensure_one()
        asked = ''
        if self.disconnect_requested_by_name or self.disconnect_requested_by_number:
            asked = _("\n👤 Requested by: %(who)s%(num)s\n🕒 %(when)s") % {
                'who': self.disconnect_requested_by_name or _('a group member'),
                'num': (' (+%s)' % self.disconnect_requested_by_number)
                       if self.disconnect_requested_by_number else '',
                'when': self.env['kpi.tz'].fmt(self.disconnect_requested_at),
            }
        return self._post_to_client_group(_(
            "✅ *Database disconnected*\n"
            "🗄️ *%(db)s*  ·  🖥️ %(srv)s\n"
            "🕒 Switched off: %(now)s%(asked)s%(note)s\n\n"
            "_Keep this message. It is the record of what was switched off, "
            "who asked, and when._") % {
                'db': self.db_name or '',
                'srv': self.server_id.name or '—',
                'now': self.env['kpi.tz'].fmt_now(),
                'asked': asked,
                'note': ('\n\n%s' % note) if note else '',
            })

    # ------------------------------------------------------------------
    def _log(self, event, payload, kpi=None):
        """Audit onto the request ticket when there is one, otherwise a plain
        log line. A registry row is not a kra.kpi, so kpi.action.log needs a
        ticket to hang off."""
        self.ensure_one()
        target = kpi or self.disconnect_request_kpi_id
        payload = dict(payload or {}, db=self.db_name,
                       server=self.server_id.name or '',
                       client=self.client_kra_id.name or '')
        if target:
            try:
                target.sudo()._log_action(
                    event, source='web', actor_user_id=self.env.user.id,
                    payload=payload)
                return True
            except Exception as exc:
                _logger.warning('%s: could not log %s: %s',
                                self.db_name, event, exc)
        _logger.info('kpi.client.db %s: %s %s', self.db_name, event, payload)
        return False

    # ------------------------------------------------------------------
    # expiry reminders -- notify only, never act
    # ------------------------------------------------------------------
    @api.model
    def _cron_db_term_check(self):
        """Warn about expiring terms. CHANGES NO STATE, EVER.

        Switching off a client's live database because a date arrived is not a
        timer's decision. Nothing is said to the client either: an expiry is a
        billing conversation between people.
        """
        today = fields.Date.context_today(self)
        rows = self.sudo().search([
            ('track_term', '=', True),
            ('state', '=', 'live'),
            ('expires_on', '!=', False),
        ])
        warned = 0
        for rec in rows:
            days = (rec.expires_on - today).days
            if days not in TERM_REMINDER_DAYS:
                continue
            try:
                rec._notify_internal_expiry(days)
                warned += 1
            except Exception as exc:
                _logger.warning('expiry notice failed for %s: %s',
                                rec.db_name, exc)
        if warned:
            _logger.info('kpi.client.db: %s expiry notices sent', warned)
        return True

    def _notify_internal_expiry(self, days):
        """Owner + coordinator only, in the app. Never the client.

        Routed through the request ticket's _notify when there is one so it
        lands in the existing feed; otherwise a log line, because there is no
        task to hang a notification off and inventing one would put a fake
        ticket in somebody's queue.
        """
        self.ensure_one()
        when = _('expires today') if days == 0 else _('expires in %s days') % days
        _logger.info('DB TERM: %s (%s) %s on %s',
                     self.db_name, self.client_kra_id.name or '-', when,
                     self.expires_on)
        # all_user_ids, not user_ids: a group's implied members are in the
        # former only -- the same trap kpi_notify.py documents at length.
        users = self.env['res.users']
        for xmlid in ('kra_kpi_module.group_kra_owner',
                      'kra_kpi_module.group_kra_admin'):
            grp = self.env.ref(xmlid, raise_if_not_found=False)
            if grp:
                users |= grp.all_user_ids
        body = _('%(db)s on %(srv)s for %(client)s %(when)s (%(date)s).') % {
            'db': self.db_name or '',
            'srv': self.server_id.name or '—',
            'client': self.client_kra_id.name or '—',
            'when': when,
            'date': fields.Date.to_string(self.expires_on)}
        vals = [{
            'user_id': u.id,
            'event': 'db_term_expiry',
            'role': 'owner',
            'title': _('Database term %s') % when,
            'body': body,
        } for u in users]
        if vals:
            self.env['kpi.notification'].sudo().create(vals)
        return True

    # ------------------------------------------------------------------
    # registration from a completed provisioning task
    # ------------------------------------------------------------------
    @api.model
    def register_from_kpi(self, kpi):
        """Create (or find) the row for a database we just built.

        Idempotent: ticking the provisioning step twice must not raise on the
        unique constraint. Returns the row, or an empty recordset when the
        ticket does not name a server and a database -- which is a data
        problem for a human, not something to guess at.
        """
        if not kpi or not kpi.provision_db_name or not kpi.provision_server_id:
            return self
        clean, err = self.env['kpi.server'].sudo().validate_db_name(
            kpi.provision_db_name)
        if err:
            raise ValidationError(_(
                'The database name on this ticket is not usable: %s') % err)
        existing = self.sudo().with_context(active_test=False).search([
            ('server_id', '=', kpi.provision_server_id.id),
            ('db_name', '=', clean)], limit=1)
        if existing:
            existing.sudo().write({
                'active': True,
                'state': 'live' if existing.state == 'pending' else existing.state,
                'source': existing.source or 'provisioned',
            })
            return existing
        # NO kra_id here on purpose. Setting it to the request ticket's KRA
        # (which is the client) would make _ensure_kra skip, and a database
        # created through WhatsApp would end up with no server/database nodes
        # while a hand-added one got them. Leaving it empty lets create()
        # build  client -> server -> database  the same way for both routes.
        return self.sudo().create({
            'db_name': clean,
            'server_id': kpi.provision_server_id.id,
            'client_kra_id': (kpi.client_kra_id or kpi.kra_id).id,
            'source': 'provisioned',
            'state': 'live',
            'activated_on': fields.Date.context_today(self),
            'notes': _('Created by %s.') % (kpi.external_ref or kpi.id),
        })


class KraKpiClientDb(models.Model):
    """The ticket's link to a database, beside its link to a KRA.

    A DISCONNECTED DATABASE TAKES NO NEW WORK, AND LOSES NONE OF ITS OLD WORK.

    Those are two different things and both matter. Once a client has asked
    for a database to be switched off and an admin has actioned it, nobody
    should be able to raise a ticket against it -- not from WhatsApp, not
    from the web, not from the app. But every ticket raised BEFORE that
    moment stays exactly where it is: active, visible, and billable. Nothing
    is archived, nothing is unlinked, and the KRA nodes stay in the tree, so
    an invoice raised next month still finds the work and still names the
    client.

    The bot is already handled -- `poll_options_for_client` only ever offers
    `state='live'` rows -- but that only covers WhatsApp. The guard below is
    what covers everything else.
    """
    _inherit = 'kra.kpi'

    client_db_id = fields.Many2one(
        'kpi.client.db', string='Database', index=True, ondelete='restrict',
        help='Which database this is about. Empty for work that is not about '
             'one particular database.')
    is_common_request = fields.Boolean(
        string='Server-wide', index=True,
        help='The client said this is about the whole server rather than one '
             'database. Filed against the client, not a sub-client.')

    # 'db_disconnect' joins the orthogonal category rather than becoming a doc
    # type, for the reasons spelled out at the top of kpi_provisioning.py.
    request_category = fields.Selection(
        selection_add=[('db_disconnect', 'Disconnect Database')],
        ondelete={'db_disconnect': 'set default'})

    # ------------------------------------------------------------------
    @api.model
    def _stopped_db(self, db_id=None, kra_id=None):
        """The disconnected database a new ticket would land on, or empty.

        Checked two ways because tickets arrive two ways: the bot sets
        `client_db_id` directly, while the web and the app create against a
        `kra_id`. Without the second check a disconnected database is still
        reachable from every screen in the system.
        """
        Db = self.env['kpi.client.db'].sudo()
        if db_id:
            row = Db.browse(int(db_id))
            if row.exists() and row.state == 'disconnected':
                return row
        if kra_id:
            row = Db.search([('kra_id', '=', int(kra_id)),
                             ('state', '=', 'disconnected')], limit=1)
            if row:
                return row
        return Db

    @api.model
    def _refuse_if_stopped(self, db_id=None, kra_id=None):
        row = self._stopped_db(db_id=db_id, kra_id=kra_id)
        if not row:
            return
        when = self.env['kpi.tz'].fmt(row.disconnected_at) \
            if row.disconnected_at else fields.Date.to_string(row.disconnected_on)
        raise ValidationError(_(
            '%(db)s was disconnected on %(when)s, so no new work can be '
            'raised against it.\n\n'
            'Everything logged before then is untouched and still '
            'invoiceable. If this database is coming back, reactivate it '
            'under Clients > Live Databases first.') % {
                'db': row.display_name, 'when': when})

    @api.model_create_multi
    def create(self, vals_list):
        Db = self.env['kpi.client.db'].sudo()
        for vals in vals_list:
            self._refuse_if_stopped(db_id=vals.get('client_db_id'),
                                    kra_id=vals.get('kra_id'))
            # Link the ticket to its database even when it was created by
            # KRA alone, which is how the web and the app create everything.
            # Without this a database's own task list and invoice trail only
            # ever contained the tickets the WhatsApp bot made, and the count
            # on the Databases screen quietly undercounted.
            if not vals.get('client_db_id') and vals.get('kra_id'):
                row = Db.search([('kra_id', '=', vals['kra_id'])], limit=1)
                if row:
                    vals['client_db_id'] = row.id
        return super().create(vals_list)

    def write(self, vals):
        # Only guards a MOVE onto a stopped database. Editing a ticket that
        # already lives on one stays allowed: the work happened, and it still
        # has to be completed, approved and invoiced.
        if vals.get('client_db_id') or vals.get('kra_id'):
            self._refuse_if_stopped(db_id=vals.get('client_db_id'),
                                    kra_id=vals.get('kra_id'))
        return super().write(vals)
