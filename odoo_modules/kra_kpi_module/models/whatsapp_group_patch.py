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

    # send_message override REMOVED (16 Oct 2026, Evolution migration).
    #
    # Everything above in this file's docstring described a neonize problem:
    # build_jid("120363...@g.us") produced "120363...@g.us@s.whatsapp.net".
    # Evolution's REST API takes the group JID directly in its `number` field,
    # so the base whatsapp.session.send_message is group-aware by construction
    # (it normalises through whatsapp_neonize/models/wa_jid.py).
    #
    # Three real consequences of deleting this override:
    #   1. send_image / send_document now work for groups. They were NEVER
    #      overridden here, so every media send to a group has been silently
    #      going nowhere.
    #   2. The "treat a SendMessageReturnFunction parse error as sent" fudge is
    #      gone. It existed because neonize dispatched before parsing the reply,
    #      so a delivered message looked failed. Evolution returns a real HTTP
    #      status and a message key, so success and failure are now honest --
    #      and a genuine failure is no longer recorded as 'sent'.
    #   3. Group rows are logged by the base _log_outgoing with the full
    #      "...@g.us", so whatsapp.message.is_group computes True.

    # ---- discovery ---------------------------------------------------------- #

    # Group DISCOVERY is unreliable on the installed gateway: neonize 0.4.1's Go
    # binary returns bytes its own Python protos cannot parse, so get_joined_groups
    # and get_group_info_from_link both fail with
    # "Error parsing message with type 'neonize.GetJoinedGroupsReturnFunction'".
    #
    # SENDING is unaffected — that needs only the JID and goes through send_message,
    # the same path every other message already uses — so the settings screen takes
    # the id by hand and these two stay as a best-effort convenience.
    _LOOKUP_HINT = ("Could not read the group list from the WhatsApp server. "
                    "You can still add this number to the group from your phone "
                    "and send any message there — the group is captured "
                    "automatically and appears in the list.")

    def wa_list_groups(self):
        """The groups this account is already in: [{'jid', 'name', 'size'}].

        WORKS NOW. On the neonize build this raised
        "Error parsing message with type 'neonize.GetJoinedGroupsReturnFunction'"
        because the Go binary returned bytes its own Python protos could not
        parse, which is why the settings screen asked for the group id by hand.
        Evolution answers GET /group/fetchAllGroups as plain JSON.
        """
        self.ensure_one()
        client, instance = self._get_client()
        out = []
        for g in client.fetch_all_groups(instance, get_participants=False) or []:
            try:
                jid = (g.get('id') or '').strip()
                if not jid:
                    continue
                out.append({
                    'jid': jid,
                    'name': g.get('subject') or jid,
                    'size': g.get('size') or len(g.get('participants') or []),
                })
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
        client, instance = self._get_client()
        code = self._invite_code(link)
        if not code:
            return {'ok': False, 'message': 'That does not look like an invite link.'}
        try:
            info = client.group_info_from_invite(instance, code) or {}
            return {'ok': True, 'code': code,
                    'jid': info.get('id') or '',
                    'name': info.get('subject') or '',
                    'size': info.get('size') or len(info.get('participants') or [])}
        except Exception as e:
            _logger.error("wa_peek_invite: %s", e)
            return {'ok': False, 'message': str(e)}

    def wa_join_invite(self, link):
        """Join via invite link and return the group's permanent JID.

        The JID is what gets stored, never the link: invite links are revocable
        and rotate, the JID does not.
        """
        self.ensure_one()
        client, instance = self._get_client()
        code = self._invite_code(link)
        if not code:
            return {'ok': False, 'message': 'That does not look like an invite link.'}
        try:
            res = client.group_join(instance, code) or {}
            jid = res.get('id') or res.get('groupJid') or ''
            if not jid:
                return {'ok': False, 'message': 'Joined, but no group id was returned.'}
            return {'ok': True, 'jid': jid}
        except Exception as e:
            _logger.error("wa_join_invite: %s", e)
            return {'ok': False, 'message': str(e)}
