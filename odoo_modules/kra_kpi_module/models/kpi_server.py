"""The servers a new database can be created on, and the name rules.

WHY A MODEL AND NOT A CHAR
--------------------------
The WhatsApp menu is a POLL, and a poll vote comes back as the option's
visible LABEL -- the router resolves it by matching that text. So the option
list and the stored value have to agree character for character. A free Char
on the task would mean the label set lives in a Python constant (adding
`nexgennpos4` becomes a deploy) and the field would quietly accumulate
`nexgennpos2`, `Nexgennpos2`, `nexgen2`.

WHY NOT A kra.master NODE
-------------------------
`kra.master._compute_is_client` marks any root or level-2 node as a client
automatically. A "server" KRA would therefore become a billable client,
appear in the KRA report, and be eligible for invoicing. Hosting inventory
and the billing tree are different things.
"""

import logging
import re

from odoo import _, api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

# Listing databases needs one short query. If a server is unreachable the
# admin must find out in seconds, not watch a spinner for a minute.
PG_CONNECT_TIMEOUT = 8

# WhatsApp caps a poll at 12 options and truncates each label SILENTLY.
# Keep one slot for "Other".
POLL_MAX_SERVERS = 11

# Postgres identifiers: <= 63 bytes. Case is KEPT: Odoo quotes database
# names, so HILAL_VAN_SALE stays HILAL_VAN_SALE, and the client form now asks
# for exactly that shape. Lowercase names already on the servers still pass.
_DB_NAME_RE = re.compile(r'^[A-Za-z][A-Za-z0-9_]{2,62}$')

# What a client types on the New Database form: CAPITAL words joined by a
# single underscore, e.g. HILAL_VAN_SALE.
_NEW_DB_NAME_RE = re.compile(r'^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$')
NEW_DB_NAME_EXAMPLE = 'HILAL_VAN_SALE'

RESERVED_DB_NAMES = {'postgres', 'template0', 'template1', 'odoo', 'root'}


class KpiServer(models.Model):
    _name = 'kpi.server'
    _description = 'Hosting Server'
    _order = 'sequence, name'

    name = fields.Char(
        required=True,
        help='Exactly as it is known operationally, e.g. nexgennpos2.')
    label = fields.Char(
        help='Friendlier text for the WhatsApp menu. Falls back to the name.')
    sequence = fields.Integer(default=10)
    active = fields.Boolean(default=True)
    notes = fields.Text(
        help='Internal only — panel URL, who to call, anything the provisioner '
             'needs. Never shown to a client.')

    # ---- reading the real database list ------------------------------------ #
    #
    # OPTIONAL, AND ADVISORY. The database picker reads kpi.client.db, which is
    # also filled by hand and by the provisioning checklist. This block only
    # saves somebody typing the list out; the bot must never depend on a live
    # Postgres connection, because then an unreachable server would silently
    # make a client's menu empty.
    fetch_enabled = fields.Boolean(
        string='Can list databases', default=False,
        help='Tick once the connection below works. Leave off to manage this '
             "server's database list entirely by hand.")
    fetch_method = fields.Selection([
        ('url', 'Odoo web address'),
        ('postgres', 'Postgres connection'),
    ], default='url', required=True, string='Read the list from',
        help='The web address is easier: it needs no database password and '
             'no firewall change, as long as the Odoo on that server still '
             'shows its database list. Postgres is the fallback when it does '
             'not.')

    # ---- method 1: ask the Odoo on that server ----------------------------- #
    url = fields.Char(
        string='Odoo Address',
        help='e.g. https://nexgennpos2.com — the address you log in at.')
    url_verify_ssl = fields.Boolean(
        string='Check the certificate', default=True,
        help='Untick only for a server with a self-signed certificate.')

    # ---- method 2: ask Postgres directly ----------------------------------- #
    host = fields.Char(help='Hostname or IP of the Postgres server.')
    port = fields.Integer(default=5432)
    pg_user = fields.Char(string='Postgres User')
    pg_password = fields.Char(
        string='Postgres Password',
        help='Use a dedicated role with CONNECT and nothing else — listing '
             'pg_database needs no more than that. Stored in plain text, '
             'like every other credential here: Odoo has no secret store.')
    pg_sslmode = fields.Selection([
        ('prefer', 'Prefer'),
        ('require', 'Require'),
        ('disable', 'Disable'),
    ], default='prefer', string='SSL')
    pg_maintenance_db = fields.Char(
        string='Connect To', default='postgres',
        help='The database to connect to in order to ask for the list. '
             'Almost always postgres.')
    last_fetch_at = fields.Datetime(readonly=True)
    last_fetch_error = fields.Text(
        readonly=True,
        help='Why the last attempt failed. Empty means the last attempt '
             'worked.')
    db_count = fields.Integer(
        string='Databases', compute='_compute_db_count')

    _sql_constraints = [
        ('name_uniq', 'unique(name)', 'That server is already listed.'),
    ]

    def _compute_db_count(self):
        Db = self.env['kpi.client.db'].sudo()
        for rec in self:
            rec.db_count = Db.search_count(
                [('server_id', '=', rec.id)]) if rec.id else 0

    def poll_label(self):
        self.ensure_one()
        return (self.label or self.name or '').strip()

    @api.model
    def poll_options(self):
        """[(id, label)] for the WhatsApp picker, capped so nothing is lost.

        Evolution truncates a poll silently at 12 options, so the cap is
        enforced here where it can be logged rather than discovered later.
        """
        rows = self.sudo().search([], limit=POLL_MAX_SERVERS + 1)
        if len(rows) > POLL_MAX_SERVERS:
            _logger.warning(
                'kpi.server: %s active servers but a WhatsApp poll fits %s — '
                'the rest will not be offered. Archive the unused ones.',
                len(rows), POLL_MAX_SERVERS)
            rows = rows[:POLL_MAX_SERVERS]
        return [(r.id, r.poll_label()) for r in rows]

    # ------------------------------------------------------------------
    @api.model
    def validate_db_name(self, raw):
        """-> (clean_name, error_message). One validator, two callers.

        Used by BOTH the WhatsApp flow and the admin triage screen, so the bot
        and the admin can never disagree about what a legal name is. Never
        raises: an invalid name must re-prompt, not crash a conversation.
        """
        s = (raw or '').strip().strip('`"\'')
        if not s:
            return '', 'Type the database name.'
        if any(ch.isspace() for ch in s):
            return '', ('A database name cannot contain spaces. '
                        'Try %s' % re.sub(r'\s+', '_', s))
        if '-' in s:
            return '', ('Hyphens have to be quoted in every script. Use %s'
                        % s.replace('-', '_'))
        if s.lower() in RESERVED_DB_NAMES:
            return '', '"%s" is reserved. Pick another name.' % s
        if not _DB_NAME_RE.match(s):
            return '', ('Use letters, numbers and _ only, starting '
                        'with a letter, 3-63 characters.')
        return s, ''

    @api.model
    def validate_new_db_name(self, raw):
        """-> (clean_name, [errors]). The client New Database form's rule.

        Stricter than validate_db_name: CAPITAL words joined by one _ , e.g.
        HILAL_VAN_SALE. Every mismatch is listed, not just the first, so the
        client can fix the name in one go. `clean_name` is the corrected
        suggestion whenever one can be made. The form's JavaScript repeats
        these rules for the live check; this is the one that decides.
        """
        s = (raw or '').strip()
        if not s:
            return '', ['Type the database name.']
        errors = []
        if any(ch.isspace() for ch in s):
            errors.append('No spaces — join the words with _')
        if any(ch.islower() for ch in s):
            errors.append('Use CAPITAL letters only (found small letters)')
        bad = sorted({ch for ch in s if not (ch.isalnum() or ch == '_' or ch.isspace())})
        if bad:
            errors.append('Not allowed: %s — only A-Z, 0-9 and _' % ' '.join(bad))
        if s[:1].isdigit() or s[:1] == '_':
            errors.append('Must start with a letter')
        if '__' in s:
            errors.append('Only one _ between words')
        if s.endswith('_'):
            errors.append('Cannot end with _')
        if not 3 <= len(s) <= 63:
            errors.append('Must be 3 to 63 characters')
        if s.lower() in RESERVED_DB_NAMES:
            errors.append('"%s" is a reserved name' % s)
        # The suggestion: what they probably meant.
        fix = re.sub(r'[^A-Z0-9]+', '_', s.upper()).strip('_')
        fix = re.sub(r'_+', '_', fix)
        if not errors and not _NEW_DB_NAME_RE.match(s):
            errors.append('Use the format %s' % NEW_DB_NAME_EXAMPLE)
        return (s if not errors else fix), errors

    # ------------------------------------------------------------------
    # reading the database list off the server
    # ------------------------------------------------------------------
    def _pg_connect(self):
        """A short-lived read connection, or a UserError the admin can act on.

        Deliberately NOT cached or pooled: this runs when somebody presses a
        button, a handful of times a day, and a held connection to somebody
        else's production box is a liability for no gain.
        """
        self.ensure_one()
        if not self.host or not self.pg_user:
            raise UserError(_(
                'Set a host and a Postgres user on %s first.') % self.name)
        try:
            import psycopg2
        except ImportError:                 # pragma: no cover - Odoo depends on it
            raise UserError(_('psycopg2 is not available on this server.'))
        try:
            return psycopg2.connect(
                host=self.host,
                port=self.port or 5432,
                user=self.pg_user,
                password=self.pg_password or '',
                dbname=self.pg_maintenance_db or 'postgres',
                sslmode=self.pg_sslmode or 'prefer',
                connect_timeout=PG_CONNECT_TIMEOUT,
            )
        except Exception as exc:
            # The driver's message is the useful part -- "no pg_hba.conf entry
            # for host" tells the admin exactly what to fix, and paraphrasing
            # it would throw that away.
            raise UserError(_('Could not connect to %(srv)s:\n\n%(err)s') % {
                'srv': self.name, 'err': str(exc).strip()})

    def _read_database_names_via_url(self):
        """Ask the Odoo running on that server for its own database list.

        `/web/database/list` is Odoo's own endpoint behind the database
        manager screen. It answers only when the remote has `list_db = True`
        (the default) and, where a `db_filter` is set, it returns only the
        databases that filter allows -- which is usually the one database that
        hostname serves. That is a feature here: a per-shop subdomain returns
        that shop's database and nothing else.

        No credentials are involved, so nothing about this grants access to
        the data inside those databases.
        """
        self.ensure_one()
        import json
        import requests

        base = (self.url or '').strip().rstrip('/')
        if not base:
            raise UserError(_('Set the Odoo address for %s first.') % self.name)
        if not base.startswith(('http://', 'https://')):
            base = 'https://%s' % base
        endpoint = '%s/web/database/list' % base
        try:
            resp = requests.post(
                endpoint,
                data=json.dumps({'jsonrpc': '2.0', 'method': 'call',
                                 'params': {}}),
                headers={'Content-Type': 'application/json'},
                timeout=(5, 20),
                verify=bool(self.url_verify_ssl),
            )
        except Exception as exc:
            raise UserError(_(
                'Could not reach %(url)s:\n\n%(err)s') % {
                    'url': endpoint, 'err': str(exc).strip()[:500]})
        if resp.status_code != 200:
            raise UserError(_(
                '%(url)s answered %(code)s.\n\nIf that is a 404, this server '
                'is probably not an Odoo, or its database list is turned '
                'off. Use the Postgres method instead.') % {
                    'url': endpoint, 'code': resp.status_code})
        try:
            data = resp.json()
        except ValueError:
            raise UserError(_(
                '%s did not answer with JSON. That usually means a proxy or '
                'a login page answered instead of Odoo.') % endpoint)
        if isinstance(data, dict) and data.get('error'):
            err = data['error']
            raise UserError(_('%(url)s refused:\n\n%(msg)s') % {
                'url': endpoint,
                'msg': (err.get('data') or {}).get('message') or str(err)})
        names = (data or {}).get('result')
        if not isinstance(names, list):
            raise UserError(_(
                '%s answered, but not with a database list. The database '
                'manager is probably disabled there (list_db = False).')
                % endpoint)
        return [str(n) for n in names if n and str(n) not in RESERVED_DB_NAMES]

    def _read_database_names(self):
        """The database names on this server, by whichever method is set."""
        self.ensure_one()
        if self.fetch_method == 'url':
            return self._read_database_names_via_url()
        return self._read_database_names_via_pg()

    def _read_database_names_via_pg(self):
        """Every connectable, non-template database on the box."""
        self.ensure_one()
        conn = self._pg_connect()
        try:
            cur = conn.cursor()
            cur.execute("""
                SELECT datname FROM pg_database
                 WHERE NOT datistemplate AND datallowconn
                 ORDER BY datname
            """)
            names = [r[0] for r in cur.fetchall()]
            cur.close()
        finally:
            try:
                conn.close()
            except Exception:
                pass
        # Postgres' own plumbing is not a client's database.
        return [n for n in names if n not in RESERVED_DB_NAMES]

    def action_test_connection(self):
        """Report what happened, and nothing else. Changes no data."""
        self.ensure_one()
        names = self._read_database_names()
        self.sudo().write({'last_fetch_error': False})
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'type': 'success',
                'title': _('%s is reachable') % self.name,
                'message': _('%(n)s database(s) visible: %(list)s') % {
                    'n': len(names),
                    'list': ', '.join(names[:12]) + ('…' if len(names) > 12 else '')},
                'sticky': False,
            },
        }

    def action_fetch_databases(self):
        """Pull the list into kpi.client.db. Never assigns a client.

        A fetch sees EVERY database on the box, including other resellers'.
        New rows therefore land with `client_kra_id` empty, and
        `kpi.client.db.poll_options_for_client` offers nothing without one --
        so a fetch cannot leak one client's database names into another's
        WhatsApp menu. Assigning the client is a deliberate human act on the
        Databases screen.

        Never deletes. A name that has vanished is archived, because tickets
        still point at it and the history has to stay readable.
        """
        Db = self.env['kpi.client.db'].sudo()
        summary = []
        for rec in self:
            try:
                names = rec._read_database_names()
            except UserError as exc:
                rec.sudo().write({'last_fetch_error': str(exc),
                                  'last_fetch_at': fields.Datetime.now()})
                raise
            now = fields.Datetime.now()
            known = Db.with_context(active_test=False).search(
                [('server_id', '=', rec.id)])
            # Matched case-insensitively: rows saved before names kept their
            # case were stored lowercased, and must not be listed twice.
            by_name = {(r.db_name or '').lower(): r for r in known}
            added = 0
            for name in names:
                clean, err = self.validate_db_name(name)
                if err:
                    # A real database whose name this module would refuse to
                    # create. It still exists, so it is recorded under its
                    # actual name -- refusing to list it would hide reality.
                    clean = name
                row = by_name.get(clean.lower())
                if row:
                    row.write({'last_fetch_at': now, 'active': True})
                    continue
                Db.create({
                    'db_name': clean,
                    'server_id': rec.id,
                    'source': 'fetched',
                    'state': 'live',
                    'last_fetch_at': now,
                })
                added += 1
            seen = {(n or '').lower() for n in names}
            gone = [r for r in known if (r.db_name or '').lower() not in seen and r.active
                    and r.source == 'fetched']
            for row in gone:
                row.write({'active': False})
            rec.sudo().write({'last_fetch_at': now, 'last_fetch_error': False,
                              'fetch_enabled': True})
            summary.append(_('%(srv)s: %(seen)s seen, %(new)s new, %(gone)s gone') % {
                'srv': rec.name, 'seen': len(names), 'new': added,
                'gone': len(gone)})
            _logger.info('kpi.server %s: fetched %s databases (%s new, %s archived)',
                         rec.name, len(names), added, len(gone))
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'type': 'success',
                'title': _('Database list updated'),
                'message': '\n'.join(summary) + _(
                    '\n\nNew entries have no client yet, so nobody is offered '
                    'them. Assign one under Setup > Databases.'),
                'sticky': True,
            },
        }

    @api.model
    def existing_request(self, db_name):
        """A task already asking for this database, if any. Advisory only.

        Odoo cannot see the Postgres cluster -- there is no automation, by
        decision -- so this is the only duplicate signal available and it must
        warn rather than block.
        """
        if not db_name:
            return self.env['kra.kpi']
        return self.env['kra.kpi'].sudo().search(
            [('provision_db_name', '=ilike', db_name), ('active', '=', True)], limit=1)
