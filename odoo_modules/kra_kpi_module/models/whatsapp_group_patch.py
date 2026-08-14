"""Let whatsapp.session address a GROUP, not just a personal number.

The gateway's send_message() builds its JID with neonize's build_jid(), which
defaults to the personal server and does not split on '@':

    build_jid("120363...@g.us")
      -> JID(User="120363...@g.us", Server="s.whatsapp.net")
      -> serialises to "120363...@g.us@s.whatsapp.net"   <- not a real address

So a group id went nowhere. Every one of the ~1,500 messages this database has
sent or received is one-to-one, which is consistent with that.

Patched HERE rather than in the whatsapp_neonize addon so the fix survives that
addon being updated, and so a KRA/KPI install carries its own behaviour.

Mentions need no work: neonize's send_message runs _parse_mention() over the
text and turns any @<5-16 digits> into a real tap-able mention. Writing
"@919876543210 started work" is the whole trick — but the number must carry its
country code, or it resolves to a JID that does not exist and renders as plain
text.
"""

import logging

from odoo import models

_logger = logging.getLogger(__name__)

GROUP_SUFFIX = '@g.us'


class WhatsappSessionGroupPatch(models.Model):
    _inherit = 'whatsapp.session'

    @staticmethod
    def _is_group_target(target):
        return GROUP_SUFFIX in (target or '')

    def send_message(self, phone, message):
        """Send to a group when the target is a group JID; otherwise unchanged.

        Personal sends are deliberately left to super(): that path carries retry,
        logging and error handling that has been working in production, and there
        is no reason for a group feature to take ownership of it.
        """
        target = (phone or '').strip()
        if not self._is_group_target(target):
            return super().send_message(phone, message)

        self.ensure_one()
        client = self._get_connected_client()
        from neonize.proto.Neonize_pb2 import JID

        # "120363041234567890@g.us" -> User=120363041234567890, Server=g.us
        user_part = target.split('@', 1)[0].strip()
        jid = JID(User=user_part, Server='g.us', Device=0, RawAgent=0,
                  Integrator=0, IsEmpty=False)
        try:
            client.send_message(jid, message)
            status = 'sent'
            _logger.info("WhatsApp GROUP message sent to %s", target)
        except Exception as e:
            # neonize dispatches to the Go binary FIRST and parses the reply after:
            #
            #     bytes_ptr = self.__client.SendMessage(...)          # already sent
            #     model = SendMessageReturnFunction.FromString(...)   # raises here
            #
            # On this build that parse fails for group sends, so a message that
            # actually arrived was being recorded as failed. That false negative is
            # not cosmetic: it invites a retry, and retrying a send that already
            # worked is how one test message became four in a live client group.
            #
            # Matched on the type name only — a blanket "treat parse errors as sent"
            # would start claiming success for genuine failures too.
            if 'SendMessageReturnFunction' in str(e):
                status = 'sent'
                # Deliberately not "sent" in the log's wording: we know it left, we
                # do not know it arrived, and this gateway cannot tell us.
                _logger.info(
                    "WhatsApp GROUP message dispatched to %s; the gateway could not "
                    "return a receipt (%s). Recorded as sent so nothing retries.",
                    target, str(e)[:80])
            else:
                status = 'failed'
                _logger.error("WhatsApp group send failed for %s: %s", target, e)
        # Logged either way, and with the full JID so is_group computes True on
        # whatsapp.message (it looks for '@g.us' in phone).
        self.env['whatsapp.message'].sudo().create({
            'session_id': self.id,
            'phone': target,
            'message': message,
            'direction': 'outgoing',
            'status': status,
        })
        if status == 'failed':
            # Never raise: a group report is a side-effect of ending a workday,
            # and a failed report must not roll back the workday itself.
            return False
        return True

    # ---- discovery ---------------------------------------------------------- #

    # Group DISCOVERY is unreliable on the installed gateway: neonize 0.4.1's Go
    # binary returns bytes its own Python protos cannot parse, so get_joined_groups
    # and get_group_info_from_link both fail with
    # "Error parsing message with type 'neonize.GetJoinedGroupsReturnFunction'".
    #
    # SENDING is unaffected — that needs only the JID and goes through send_message,
    # the same path every other message already uses — so the settings screen takes
    # the id by hand and these two stay as a best-effort convenience.
    _LOOKUP_HINT = ("Asking WhatsApp for the group list does not work on this "
                    "gateway build. It is not needed: add this number to the group "
                    "from your phone and send any message there — the group is "
                    "captured automatically and appears in the list.")

    def wa_list_groups(self):
        """The groups this account is already in: [{'jid', 'name', 'size'}].

        Only ever lists groups the connected number has joined — which is why the
        invite-link path below exists, otherwise a bot that nobody has added has
        no way in from inside Odoo.
        """
        self.ensure_one()
        client = self._get_connected_client()
        out = []
        for g in client.get_joined_groups() or []:
            try:
                jid = '%s@g.us' % g.JID.User
                name = getattr(getattr(g, 'GroupName', None), 'Name', '') or jid
                out.append({'jid': jid, 'name': name,
                            'size': len(getattr(g, 'Participants', []) or [])})
            except Exception as e:
                _logger.warning("skipping unreadable group: %s", e)
        return sorted(out, key=lambda x: (x['name'] or '').lower())

    @staticmethod
    def _invite_code(link):
        """The code out of https://chat.whatsapp.com/XXXX (or a bare code)."""
        raw = (link or '').strip()
        if 'chat.whatsapp.com' in raw:
            raw = raw.split('chat.whatsapp.com', 1)[1].lstrip('/')
        return raw.split('?')[0].split('/')[0].strip()

    def wa_peek_invite(self, link):
        """Read a group's name from an invite link WITHOUT joining.

        Joining is visible to everyone in the group — members see the number
        appear — so it is not something to do silently on paste. This is what
        makes a confirm step possible.
        """
        self.ensure_one()
        client = self._get_connected_client()
        code = self._invite_code(link)
        if not code:
            return {'ok': False, 'message': 'That does not look like an invite link.'}
        try:
            info = client.get_group_info_from_link(code)
            return {'ok': True, 'code': code,
                    'jid': '%s@g.us' % info.JID.User,
                    'name': getattr(getattr(info, 'GroupName', None), 'Name', '') or '',
                    'size': len(getattr(info, 'Participants', []) or [])}
        except Exception as e:
            _logger.error("wa_peek_invite: %s", e)
            return {'ok': False, 'message': str(e)}

    def wa_join_invite(self, link):
        """Join via invite link and return the group's permanent JID.

        The JID is what gets stored, never the link: invite links are revocable
        and rotate, the JID does not.
        """
        self.ensure_one()
        client = self._get_connected_client()
        code = self._invite_code(link)
        if not code:
            return {'ok': False, 'message': 'That does not look like an invite link.'}
        try:
            jid = client.join_group_with_link(code)
            return {'ok': True, 'jid': '%s@g.us' % jid.User}
        except Exception as e:
            _logger.error("wa_join_invite: %s", e)
            return {'ok': False, 'message': str(e)}
