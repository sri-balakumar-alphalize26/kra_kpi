"""WhatsApp group metadata cache.

Stores a `jid â†’ name` mapping so the WA Tracker chat list can render the
group's friendly name (e.g. "Family", "Team Sales") instead of the raw
group JID like 120363314353366557.

The model is populated:
  * Lazily â€” on every incoming group message in `_on_message`, the JID is
    upserted (no-op if already present and fresh).
  * Periodically â€” an hourly cron `_cron_refresh_group_names()` re-fetches
    group info from neonize so renames eventually propagate.
"""

import logging
from datetime import timedelta

from odoo import models, fields, api, _

_logger = logging.getLogger(__name__)


GROUP_NAME_REFRESH_HOURS = 6  # don't re-hit neonize more than every 6h per group


class WhatsAppGroup(models.Model):
    _name = 'whatsapp.group'
    _description = 'WhatsApp Group Metadata Cache'
    _rec_name = 'name'
    _order = 'name, jid'

    jid = fields.Char('Group JID', required=True, index=True,
                       help='Numeric WhatsApp group identifier, e.g. 120363314353366557.')
    name = fields.Char('Group Name', help='Friendly group name as shown on WhatsApp.')
    subject = fields.Char('Subject', help='Group subject / description.')
    session_id = fields.Many2one(
        'whatsapp.session', string='Session', ondelete='cascade',
        help='WhatsApp session that fetched this metadata.',
    )
    last_refreshed = fields.Datetime('Last Refreshed', readonly=True)
    participant_count = fields.Integer('Participants', readonly=True)

    _unique_jid_session = models.Constraint(
        'UNIQUE (jid, session_id)',
        'A whatsapp.group row already exists for this JID + session pair.',
    )

    # ------------------------------------------------------------------
    # Public API used by whatsapp_session._on_message
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # REMOVED 16 Oct 2026 (Evolution migration): _upsert_from_client,
    # _fetch_group_info and _extract_group_fields.
    #
    # All three took a live in-process neonize client and sniffed its
    # protobuf return shapes -- _fetch_group_info tried five different
    # method names because neonize renamed the call between releases, and
    # on the installed build every variant failed to parse, which is why
    # the hourly cron logged "Group name refresh: 0 / 7 rows updated"
    # indefinitely.
    #
    # Evolution answers GET /group/fetchAllGroups as plain JSON, so
    # _cron_refresh_group_names below now does the whole job in one call
    # per session, and the webhook keeps rows warm via GROUPS_UPSERT /
    # GROUP_UPDATE. Their only other caller was the neonize message
    # callback, which no longer exists.
    # ------------------------------------------------------------------

    @api.model
    def _cron_refresh_group_names(self):
        """Hourly cron -- refresh cached group names from Evolution.

        ONE call per connected session now (GET /group/fetchAllGroups), not one
        per cached row. The neonize version asked the in-process Go client for
        each group individually and, on the installed build, every such call
        failed to parse -- the log read "Group name refresh: 0 / 7 rows updated"
        indefinitely.
        """
        sessions = self.env['whatsapp.session'].sudo().search([
            ('status', '=', 'connected'),
            ('base_url', '!=', False),
            ('instance_name', '!=', False),
        ])
        if not sessions:
            return False

        refreshed = 0
        for session in sessions:
            try:
                client, instance = session._get_client()
                remote = client.fetch_all_groups(instance, get_participants=False)
            except Exception as exc:
                _logger.warning("Group refresh failed for session %s: %s",
                                session.name, exc)
                continue
            for g in remote or []:
                jid_full = (g.get('id') or '').strip()
                if not jid_full:
                    continue
                bare = jid_full.split('@', 1)[0]
                # `jid` is stored bare here and has a UNIQUE(jid, session_id)
                # constraint -- do not "fix" it to the full form without a
                # migration.
                row = self.sudo().search([
                    ('jid', '=', bare), ('session_id', '=', session.id)], limit=1)
                vals = {
                    'name': g.get('subject') or bare,
                    'subject': g.get('subject') or '',
                    'participant_count': g.get('size') or 0,
                    'last_refreshed': fields.Datetime.now(),
                }
                if row:
                    row.write(vals)
                else:
                    vals.update(jid=bare, session_id=session.id)
                    self.sudo().create(vals)
                refreshed += 1
                type(self)._invalidate_conversation_names(self.env, bare)
        _logger.info("Group name refresh: %d rows updated from %d session(s)",
                     refreshed, len(sessions))
        return True

    @staticmethod
    def _invalidate_conversation_names(env, jid):
        """Force `wa.conversation` rows whose `phone == jid` to recompute
        their `contact_name`. Safe no-op if whatsapp_employee_tracker isn't
        installed."""
        if 'wa.conversation' not in env:
            return
        try:
            convs = env['wa.conversation'].sudo().search([('phone', '=', jid)])
            if convs:
                convs._compute_contact_name()
        except Exception as e:
            _logger.debug("wa.conversation invalidate skipped: %s", e)

    @staticmethod
    def looks_like_group_jid(raw):
        """Quick heuristic: WhatsApp group JIDs are long numeric strings,
        typically starting with '120363' and >= 18 digits. The raw value
        passed in may already have @g.us stripped."""
        if not raw:
            return False
        s = str(raw).strip().lstrip('+').replace('@g.us', '')
        if not s.isdigit():
            return False
        return len(s) >= 15 and s.startswith('120')
