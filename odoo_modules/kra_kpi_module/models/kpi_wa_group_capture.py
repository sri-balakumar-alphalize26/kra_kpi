"""Learn WhatsApp group ids by watching incoming messages.

Why this exists
---------------
Posting to a group needs the group's id ("120363…@g.us"). There are normally
three ways to get one, and on this gateway all three crash inside neonize's Go
binary: get_joined_groups, get_group_info_from_link and join_group_with_link.
The gateway also drops group messages before recording them —

    if IsFromMe or IsGroup: return   # whatsapp_session.py

— so the id never reaches the database either. Between them there is no way to
learn a group id from inside Odoo.

How this works
--------------
neonize keeps exactly one handler per event type in a plain dict
(``client.event.list_func[code]``). So the gateway's message handler can be
WRAPPED rather than replaced: ours calls theirs first, then records the group.

Their handler runs first and its result is untouched, and ours is wrapped in a
try — so a fault here cannot affect password-reset or OTP replies, which ride on
the same event. That is the whole reason for this shape.

Groups only appear once somebody posts in them. A silent group stays unknown,
which is fine: you add the number to the group and send one message to register
it.
"""

import logging

from odoo import api, fields, models

_logger = logging.getLogger(__name__)

GROUP_SERVER = 'g.us'


class KpiWaGroup(models.Model):
    """A WhatsApp group we have seen a message from."""
    _name = 'kpi.wa.group'
    _description = 'Seen WhatsApp Group'
    _order = 'last_seen desc'

    jid = fields.Char(string='Group ID', required=True, index=True)
    # The admin's own label. Left EMPTY when unknown rather than defaulted to the
    # jid: a row reading "120363…@g.us" looks like a name and is not one, and that
    # is exactly how a client group got mistaken for the dev group and posted to.
    name = fields.Char(
        string='Group Name',
        help="Your label for this group. WhatsApp does not tell us the real name "
             "on this gateway, so set it yourself — it is the only reliable way to "
             "tell one group id from another before posting to it.")
    last_seen = fields.Datetime(string='Last Message', required=True)
    last_sender = fields.Char(
        string='Last Posted By',
        help="Display name of whoever last posted in this group. Free from the "
             "incoming event, and often enough to recognise a group with no label.")
    message_count = fields.Integer(string='Messages Seen', default=0)

    _sql_constraints = [
        ('jid_uniq', 'unique(jid)', 'This group is already recorded.'),
    ]

    @api.model
    def record_seen(self, jid, name='', sender=''):
        """Upsert on every group message. Cheap by design — it runs inside the
        gateway's inbound path, so it must not do real work.

        `name` is only ever written when it carries something real; a hand-set
        label must not be overwritten by a later blank.
        """
        jid = (jid or '').strip()
        if not jid.endswith('@' + GROUP_SERVER):
            return False
        rec = self.sudo().search([('jid', '=', jid)], limit=1)
        vals = {'last_seen': fields.Datetime.now()}
        if name:
            vals['name'] = name
        if sender:
            vals['last_sender'] = sender[:80]
        if rec:
            vals['message_count'] = (rec.message_count or 0) + 1
            rec.write(vals)
        else:
            vals.update({'jid': jid, 'message_count': 1})
            rec = self.sudo().create(vals)
            _logger.info("KRA/KPI learned a new WhatsApp group: %s (last post by %s)",
                         jid, sender or 'unknown')
        return rec.id

    def rename(self, label):
        """Label a captured group. The one identification route that cannot fail:
        no gateway call, so it works with the phone offline and on a build whose
        group lookups crash."""
        self.ensure_one()
        self.sudo().write({'name': (label or '').strip()[:120]})
        return True


class WhatsappSessionGroupCapture(models.Model):
    _inherit = 'whatsapp.session'

    def action_connect(self):
        """Connect as normal, then chain our listener onto the message event.

        Both auto-reconnect paths in the gateway call action_connect, so this one
        override covers startup, the cron and the manual button.
        """
        res = super().action_connect()
        try:
            self._kpi_install_group_capture()
        except Exception as exc:
            # Never let this stop a connection — the gateway carries OTP logins.
            _logger.warning("group capture not installed for session %s: %s", self.id, exc)
        return res

    def _kpi_install_group_capture(self):
        self.ensure_one()
        from neonize.events import MessageEv, EVENT_TO_INT
        from odoo.addons.whatsapp_neonize.models.whatsapp_session import _wa_clients

        client = _wa_clients.get(self.id)
        if client is None:
            return False
        code = EVENT_TO_INT[MessageEv]
        original = client.event.list_func.get(code)
        if original is None:
            _logger.info("no gateway message handler yet for session %s", self.id)
            return False
        if getattr(original, '_kpi_group_capture', False):
            return True                      # already wrapped — reconnects re-run this

        dbname = self.env.cr.dbname
        session_id = self.id

        def _wrapped(client_ref, event):
            # Theirs first and unconditionally: everything downstream of the
            # gateway — OTP replies, transcription, reporting — depends on it.
            try:
                original(client_ref, event)
            finally:
                try:
                    _capture(event)
                except Exception as exc:
                    _logger.warning("group capture failed: %s", exc)

        def _capture(event):
            info = getattr(event, 'Info', None)
            source = getattr(info, 'MessageSource', None) if info else None
            if source is None or not getattr(source, 'IsGroup', False):
                return
            chat = getattr(source, 'Chat', None)
            user = getattr(chat, 'User', '') if chat else ''
            server = getattr(chat, 'Server', '') if chat else ''
            if not user or server != GROUP_SERVER:
                return
            jid = '%s@%s' % (user, server)
            # The sender's display name rides along on the event for free. It is
            # the only human-readable clue available here — WhatsApp does not put
            # the group's own name on a message, and asking for it (get_group_info)
            # is in the family of calls that crash the Go binary on this build.
            # "last posted by Ramesh, 18:24" is often enough to recognise a group.
            sender = str(getattr(info, 'PushName', '') or '')
            # Own cursor: this runs on the gateway's thread, outside any request.
            from odoo.modules.registry import Registry
            with Registry(dbname).cursor() as cr:
                env = api.Environment(cr, self.env.uid, {})
                env['kpi.wa.group'].record_seen(jid, name='', sender=sender)
                cr.commit()

        _wrapped._kpi_group_capture = True
        client.event.list_func[code] = _wrapped
        _logger.info("KRA/KPI group capture installed on session %s", session_id)
        return True
