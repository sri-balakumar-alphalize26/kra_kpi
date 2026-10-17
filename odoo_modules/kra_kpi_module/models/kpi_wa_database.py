"""Which Odoo database on this server owns WhatsApp -- and moving it.

THE SITUATION THIS EXISTS FOR
-----------------------------
This machine has eight databases in Postgres. Odoo serves exactly ONE of
them, named by `db_name` in odoo.conf, and Evolution has exactly ONE
instance with ONE phone number. So only one database can own WhatsApp at a
time -- that is not a policy, it is arithmetic.

Before this screen there was no way to see which one that was, and no way to
change it short of editing odoo.conf by hand and restarting the service.
Worse, four of the eight databases still carry the OLD neonize schema: moving
WhatsApp onto one of those would produce a database that boots fine and
cannot send a message, with nothing on screen saying why.

WHAT IT CHECKS BEFORE IT WILL MOVE ANYTHING
-------------------------------------------
* the target is really a database on this Postgres (never a typed name)
* it is an Odoo database, not something else -- `evolution_db` is Evolution's
  own storage and must never be served
* `whatsapp_neonize` is installed in it
* its `whatsapp_session` table has `instance_name`, which only the Evolution
  rewrite has. This is the check that catches the four neonize databases.

HOW THE MOVE IS MADE SAFE
-------------------------
odoo.conf is copied first, then rewritten, then a DETACHED watchdog restarts
the service and waits for Odoo to answer on the new database. If it does not
answer, the watchdog copies the backup back and restarts again. Odoo cannot
do this itself: it is stopping the server that is running the request.

The webhook is deliberately NOT re-pointed here. `whatsapp.session.
action_connect` already registers it with Evolution, it is tested, and it
runs inside the new database where the session's own id and secret live.
Doing it from this side would mean writing into another database over raw
SQL to invent a session that may not exist. So the last step stays manual
and is stated plainly on screen: open WhatsApp Sessions there, press Connect.
"""

import logging
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime

import psycopg2

from odoo import _, api, fields, models, tools
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

# A database name is pasted into a config file, so it is validated against
# this AND against the real list from pg_database. Belt and braces: the
# config file is read by a process running as LocalSystem.
SAFE_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._\-]{0,62}$')

# Never offer these. evolution_db is the Evolution API's own storage; serving
# it as an Odoo database would be a mess to undo.
NEVER_SERVE = {'postgres', 'template0', 'template1', 'evolution_db'}

SERVICE_NAME = 'odoo-server-19.0'


class KpiWaDatabase(models.TransientModel):
    """A snapshot of the server, rebuilt every time the screen is opened.

    Transient on purpose: this describes Postgres and odoo.conf as they are
    right now. A stored table would be a second copy of the truth, and the
    first thing it would do is disagree with the first.
    """
    _name = 'kpi.wa.database'
    _description = 'WhatsApp database on this server'
    _order = 'is_served desc, ready desc, name'

    name = fields.Char(string='Database', readonly=True)
    is_served = fields.Boolean(string='Served Now', readonly=True)
    is_odoo = fields.Boolean(string='Odoo Database', readonly=True)
    module_state = fields.Char(string='WhatsApp Module', readonly=True)
    schema_kind = fields.Selection([
        ('evolution', 'Evolution'),
        ('neonize', 'Old neonize'),
        ('none', 'No WhatsApp tables'),
    ], string='Build', readonly=True)
    session_count = fields.Integer(string='Sessions', readonly=True)
    connected_session = fields.Char(string='Connected As', readonly=True)
    last_message_at = fields.Datetime(string='Last Message', readonly=True)
    ready = fields.Boolean(string='Can Take WhatsApp', readonly=True)
    blocked_reason = fields.Char(string='Why Not', readonly=True)
    state_label = fields.Char(string='Status', compute='_compute_state_label')

    @api.depends('is_served', 'ready', 'connected_session')
    def _compute_state_label(self):
        for rec in self:
            if rec.is_served and rec.connected_session:
                rec.state_label = _('WhatsApp is here')
            elif rec.is_served:
                rec.state_label = _('Served, no WhatsApp session')
            elif rec.ready:
                rec.state_label = _('Ready')
            else:
                rec.state_label = _('Not usable')

    # ------------------------------------------------------------------
    # Reading the server
    # ------------------------------------------------------------------
    @api.model
    def _pg_params(self):
        """The same credentials Odoo itself uses. Never hard-coded."""
        return {
            'host': tools.config.get('db_host') or 'localhost',
            'port': int(tools.config.get('db_port') or 5432),
            'user': tools.config.get('db_user'),
            'password': tools.config.get('db_password'),
        }

    @api.model
    def _served_names(self):
        """The databases odoo.conf names, always as a list of strings.

        `db_name` is declared type='comma' with my_default=[], so Odoo 19
        hands back a LIST, not the string that is written in the file.
        Comparing a name to it directly is always False -- which showed up
        here as every row claiming not to be the served one, including the
        one actually running.
        """
        raw = tools.config.get('db_name') or []
        if isinstance(raw, str):
            raw = [p.strip() for p in raw.split(',')]
        return [str(p).strip() for p in raw if str(p).strip()]

    @api.model
    def _database_names(self):
        params = self._pg_params()
        conn = psycopg2.connect(dbname='postgres', connect_timeout=8, **params)
        try:
            cur = conn.cursor()
            cur.execute("""SELECT datname FROM pg_database
                            WHERE datistemplate = false
                            ORDER BY datname""")
            return [r[0] for r in cur.fetchall()
                    if r[0] not in NEVER_SERVE and SAFE_NAME.match(r[0])]
        finally:
            conn.close()

    @api.model
    def _inspect(self, dbname):
        """Everything this screen needs to know about one database."""
        out = {
            'name': dbname, 'is_odoo': False, 'module_state': '',
            'schema_kind': 'none', 'session_count': 0,
            'connected_session': '', 'last_message_at': False,
            'ready': False, 'blocked_reason': '',
        }
        params = self._pg_params()
        try:
            conn = psycopg2.connect(dbname=dbname, connect_timeout=8, **params)
        except Exception as exc:
            out['blocked_reason'] = _('Cannot be opened: %s') % (
                str(exc).strip().splitlines()[0][:80])
            return out
        try:
            cur = conn.cursor()
            cur.execute("SELECT to_regclass('public.ir_module_module')")
            out['is_odoo'] = cur.fetchone()[0] is not None
            if not out['is_odoo']:
                out['blocked_reason'] = _('Not an Odoo database.')
                return out

            cur.execute("""SELECT state FROM ir_module_module
                            WHERE name = 'whatsapp_neonize'""")
            got = cur.fetchone()
            out['module_state'] = got[0] if got else _('not there')
            if (got[0] if got else '') != 'installed':
                out['blocked_reason'] = _(
                    'The WhatsApp module is %s here. Install it in that '
                    'database first.') % out['module_state']
                return out

            cur.execute("SELECT to_regclass('public.whatsapp_session')")
            if cur.fetchone()[0] is None:
                out['blocked_reason'] = _('No WhatsApp tables.')
                return out

            # instance_name exists only on the Evolution rewrite. Its absence
            # is what tells a neonize database apart from a working one, and
            # the module version number does NOT -- the two lineages share
            # version numbers.
            cur.execute("""SELECT EXISTS (SELECT 1
                             FROM information_schema.columns
                            WHERE table_name = 'whatsapp_session'
                              AND column_name = 'instance_name')""")
            is_evo = cur.fetchone()[0]
            out['schema_kind'] = 'evolution' if is_evo else 'neonize'

            cur.execute('SELECT count(*) FROM whatsapp_session')
            out['session_count'] = cur.fetchone()[0]

            if not is_evo:
                out['blocked_reason'] = _(
                    'This database still has the old neonize build, whose '
                    'transport is dead. Upgrade whatsapp_neonize there '
                    'first -- it would serve, but it could not send a '
                    'single message.')
                return out

            cur.execute("""SELECT name, instance_name FROM whatsapp_session
                            WHERE status = 'connected' LIMIT 1""")
            got = cur.fetchone()
            if got:
                out['connected_session'] = '%s / %s' % (got[0],
                                                        got[1] or '-')

            cur.execute("SELECT to_regclass('public.whatsapp_message')")
            if cur.fetchone()[0] is not None:
                cur.execute('SELECT max(create_date) FROM whatsapp_message')
                out['last_message_at'] = cur.fetchone()[0] or False

            out['ready'] = True
            return out
        except Exception as exc:
            out['blocked_reason'] = _('Could not be read: %s') % (
                str(exc).strip().splitlines()[0][:80])
            return out
        finally:
            conn.close()

    @api.model
    def refresh(self):
        """Throw the snapshot away and take a new one."""
        self.search([]).unlink()
        served = self._served_names()
        rows = []
        for name in self._database_names():
            vals = self._inspect(name)
            vals['is_served'] = name in served
            # The one already running is not a thing to "switch to", and
            # offering it as one is how somebody restarts the server for no
            # reason.
            if vals['is_served']:
                vals['ready'] = False
                if not vals['blocked_reason']:
                    vals['blocked_reason'] = _('This is the one running now.')
            rows.append(vals)
        return self.create(rows)

    @api.model
    def action_open(self):
        self.refresh()
        return {
            'type': 'ir.actions.act_window',
            'name': _('WhatsApp Database'),
            'res_model': 'kpi.wa.database',
            'view_mode': 'list',
            'target': 'current',
            'context': {'create': False, 'delete': False},
        }

    def action_refresh(self):
        self.refresh()
        return {'type': 'ir.actions.act_window',
                'name': _('WhatsApp Database'),
                'res_model': 'kpi.wa.database',
                'view_mode': 'list', 'target': 'current'}

    # ------------------------------------------------------------------
    # Moving WhatsApp
    # ------------------------------------------------------------------
    def _conf_path(self):
        path = tools.config.rcfile
        if not path or not os.path.isfile(path):
            raise UserError(_(
                'Odoo cannot tell where its own configuration file is, so it '
                'will not edit one. Change db_name by hand.'))
        return path

    def action_take_over(self):
        """Point Odoo at this database and restart onto it."""
        self.ensure_one()
        if not self.env.user.has_group('base.group_system'):
            raise UserError(_(
                'Only a system administrator can move WhatsApp to another '
                'database. It restarts the server for everybody.'))

        target = self.name or ''
        # Re-check everything, now, rather than trusting the snapshot. The
        # screen may have been open for an hour.
        if not SAFE_NAME.match(target) or target in NEVER_SERVE:
            raise UserError(_('%s is not a database this may be pointed at.')
                            % target)
        if target not in self._database_names():
            raise UserError(_(
                '%s is not on this Postgres server any more. Refresh the '
                'list.') % target)
        fresh = self._inspect(target)
        if not fresh['ready']:
            raise UserError(_('%(db)s cannot take WhatsApp.\n\n%(why)s') % {
                'db': target, 'why': fresh['blocked_reason']})
        served = self._served_names()
        if served == [target]:
            raise UserError(_(
                'Odoo is already serving %s on its own. If WhatsApp is not '
                'working here, open WhatsApp Sessions and press Connect '
                'WhatsApp.') % target)
        # More than one name in db_name is its own fault: the WhatsApp
        # webhook arrives with no session cookie, so Odoo resolves the
        # database with db_monodb(), which needs EXACTLY one match. Switching
        # to a single name is the fix, so this is allowed through.
        if len(served) > 1:
            _logger.warning(
                'kpi.wa.database: db_name currently lists %s databases (%s); '
                'the WhatsApp webhook cannot work until it names exactly one.',
                len(served), ', '.join(served))

        conf = self._conf_path()
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        backup = '%s.bak-%s' % (conf, stamp)
        shutil.copyfile(conf, backup)

        self._rewrite_db_name(conf, target)
        log = os.path.join(
            tools.config.get('data_dir') or os.path.dirname(conf),
            'wa_database_switch.log')
        self._spawn_watchdog(conf, backup, target, log)

        _logger.warning(
            'kpi.wa.database: %s is switching Odoo from %s to %s '
            '(backup: %s)', self.env.user.login,
            tools.config.get('db_name'), target, backup)

        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'type': 'warning',
                'sticky': True,
                'title': _('Moving WhatsApp to %s') % target,
                'message': _(
                    'Odoo is restarting onto %(db)s. Give it about a minute, '
                    'then sign in again.\n\n'
                    'Last step: open WhatsApp Sessions there and press '
                    'Connect WhatsApp, so Evolution sends messages to the '
                    'new database.\n\n'
                    'If it does not come back up by itself, the old settings '
                    'are put back automatically. The log is %(log)s'
                ) % {'db': target, 'log': log},
            },
        }

    @api.model
    def _rewrite_db_name(self, conf, target):
        """Replace the db_name line, touch nothing else, leave no BOM.

        No configparser round trip: that rewrites the whole file, drops the
        comments and reorders the keys, and this file is read by a server
        that will not start if it is wrong. One line changes.
        """
        with open(conf, encoding='utf-8-sig') as fh:
            lines = fh.read().splitlines()

        out, done = [], False
        for line in lines:
            if re.match(r'^\s*db_name\s*=', line) and not done:
                out.append('db_name = %s' % target)
                done = True
            else:
                out.append(line)
        if not done:
            raise UserError(_(
                'There is no db_name line in %s, so Odoo will not guess '
                'where to add one.') % conf)

        # utf-8 with NO BOM. A BOM here stops Odoo booting -- the first key
        # of the first section comes back with invisible bytes on the front.
        with open(conf, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write('\n'.join(out) + '\n')

    @api.model
    def _spawn_watchdog(self, conf, backup, target, log):
        """Start the restarter so it outlives the server that started it."""
        script = os.path.join(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))), 'tools', 'switch_wa_database.py')
        if not os.path.isfile(script):
            raise UserError(_('The restart helper is missing: %s') % script)

        flags = 0
        if os.name == 'nt':
            # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP -- without these the
            # child dies with the service it was started from, which is the
            # service it is meant to be restarting.
            flags = 0x00000008 | 0x00000200

        subprocess.Popen(
            [sys.executable, script, conf, backup, target, SERVICE_NAME, log],
            creationflags=flags, close_fds=True,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=os.path.dirname(script))
        return True
