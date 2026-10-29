"""Task actions taken on the web or the app, said in the WhatsApp staff group.

The bot already says "🟨 ▶️ Angitha is back on REQ-005." in the group when
someone resumes from WhatsApp. The same resume from the web or the phone said
nothing, so the group only ever saw half of what the team did. Now every
start / pause / resume / switch / new task from the web or the app posts the
bot's own line, with the person's colour and where it came from:

    🟨 ▶️ Angitha is back on REQ-005. · 🌐 from web

The wording lives here and the bot formats from the same constants, so the two
cannot drift. Only plain text: the actions were already taken, there is
nothing to tap.

WHO SETS THE SOURCE: the web/app task routes (controllers/kra_api.py
_mark_action_source) put `kpi_action_source` in the context. The bot, the
WhatsApp pages, crons and the shell never do, so they never post twice.
Finishing a task is not here: kpi_finish already tells the group on every
channel.

THE DEVELOPER'S OWN COPY: a start or resume also sends the same line to the
task's developer in their private chat, from every channel -- web, app and the
bot (_wa_dm_lifecycle). A switch, quiet in the group, still sends it.
"""

import logging
import threading

from odoo import SUPERUSER_ID, api, models

_logger = logging.getLogger(__name__)

# The bot's lines (kpi_wa_staff_menu._staff_run, kpi_wa_staff_task).
WA_TAKEN = '▶️ %(who)s has taken %(ref)s.'
WA_BACK_ON = '▶️ %(who)s is back on %(ref)s.'
WA_BACK_ON_CHANGED = '▶️ %(who)s is back on %(ref)s — changed: %(why)s'
WA_PAUSED = '⏸️ %(ref)s paused — %(why)s%(who)s'
WA_PAUSED_ALL = '⏸️ Paused %(refs)s — %(why)s%(who)s'
WA_SWITCHED_FROM = '🔀 %(who)s switched from %(a)s to %(b)s. %(a)s is paused (moved to another task).'
WA_SWITCHED_TO = '🔀 %(who)s switched to %(ref)s.%(still)s'
WA_CREATED = '🆕 %(who)s created %(ref)s — "%(name)s".\n⏳ Waiting for approval.'

# What a switch writes as the pause reason (pause code 'priority_task').
SWITCH_NOTE = 'Moved to another task'

SOURCE_TAG = {'web': '🌐 from web', 'app': '📱 from app'}


def _post_in_background(dbname, text):
    """Thread body: a fresh cursor, the staff group, the send. Never raises."""
    try:
        from odoo.modules.registry import Registry
        with Registry(dbname).cursor() as cr:
            env = api.Environment(cr, SUPERUSER_ID, {})
            group = env['kpi.wa.group']._staff_group()
            env['kpi.wa.group.report']._post(text, jid=group.jid if group else None)
    except Exception as exc:
        _logger.warning('wa group activity post failed: %s', exc)


def _dm_in_background(dbname, user_id, text):
    """Thread body: the same line, to one person's own number. Never raises."""
    try:
        from odoo.modules.registry import Registry
        with Registry(dbname).cursor() as cr:
            env = api.Environment(cr, SUPERUSER_ID, {})
            env['kpi.wa.group.report'].post_text_to_user(env['res.users'].browse(user_id), text)
    except Exception as exc:
        _logger.warning('wa private activity line failed: %s', exc)


class KraKpiWaActivity(models.Model):
    _inherit = 'kra.kpi'

    @api.model
    def _wa_action_source(self):
        """'web' / 'app' when a web or app route is acting, else None."""
        src = self.env.context.get('kpi_action_source')
        return src if src in SOURCE_TAG else None

    @api.model
    def _wa_say_in_group(self, line, user=None):
        """Post one bot-worded line to the staff group, after this request
        commits (a refused or rolled-back action must not be announced), in a
        thread (a slow WhatsApp send must not hold the board up)."""
        src = self._wa_action_source()
        if not src or self.env.context.get('kpi_wa_quiet') or not line:
            return
        user = user or self.env.user
        try:
            mark = user._kpi_wa_color()[0]
        except Exception:
            mark = ''
        text = ('%s %s · %s' % (mark, line, SOURCE_TAG[src])).strip()
        dbname = self.env.cr.dbname

        def _start():
            threading.Thread(target=_post_in_background, args=(dbname, text), daemon=True).start()
        self.env.cr.postcommit.add(_start)

    def _wa_ref(self):
        self.ensure_one()
        return self.external_ref or ('#%s' % self.id)

    def _wa_pause_why(self, reason='', reason_code=False):
        """The words after "paused —": what was typed, else the reason's label."""
        why = (reason or '').strip()
        if not why and reason_code:
            why = dict(self._fields['pause_reason_code'].selection).get(reason_code) or reason_code
        return why or 'paused'

    def _wa_group_lifecycle(self, event, payload=None):
        """start / pause / resume from _wrap_lifecycle, as the bot words them."""
        if not self._wa_action_source() or self.env.context.get('kpi_wa_quiet'):
            return
        payload = payload or {}
        who = self.env.user.name or ''
        for rec in self:
            vals = {'who': who, 'ref': rec._wa_ref()}
            if event == 'start':
                line = WA_TAKEN % vals
            elif event == 'resume':
                why = self.env.context.get('kpi_resume_reason')
                line = (WA_BACK_ON_CHANGED % dict(vals, why=why)) if why else WA_BACK_ON % vals
            elif event == 'pause':
                line = WA_PAUSED % dict(vals, who='', why=rec._wa_pause_why(
                    payload.get('reason'), payload.get('reason_code')))
            else:
                continue
            rec._wa_say_in_group(line)

    def _wa_dm_lifecycle(self, event):
        """start / resume: the group's line, privately to the task's developer.

        Every channel, the bot's included (kpi_wa_state_id); crons and the
        shell have neither marker and stay silent. Not held back by
        kpi_wa_quiet: a switch still starts or resumes the developer's task."""
        if event not in ('start', 'resume'):
            return
        src = self._wa_action_source()
        if not src and not self.env.context.get('kpi_wa_state_id'):
            return
        actor = self.env.user
        try:
            mark = actor._kpi_wa_color()[0]
        except Exception:
            mark = ''
        why = self.env.context.get('kpi_resume_reason')
        dbname = self.env.cr.dbname
        for rec in self:
            vals = {'who': actor.name or '', 'ref': rec._wa_ref()}
            if event == 'start':
                line = WA_TAKEN % vals
            else:
                line = (WA_BACK_ON_CHANGED % dict(vals, why=why)) if why else WA_BACK_ON % vals
            # No "· from web / app" tag: in their own chat it is just the line.
            text = ('%s %s' % (mark, line)).strip()
            dev_id = (rec.user_id or actor).id

            def _start(dev_id=dev_id, text=text):
                threading.Thread(target=_dm_in_background, args=(dbname, dev_id, text), daemon=True).start()
            self.env.cr.postcommit.add(_start)
