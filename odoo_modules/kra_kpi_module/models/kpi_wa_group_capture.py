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
import re

from odoo import _, api, fields, models
from odoo.exceptions import UserError

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
    #
    # The old help here said WhatsApp does not tell us the group's real name on
    # this gateway. That was true of neonize; Evolution's /group/fetchAllGroups
    # returns `subject`, which is the actual WhatsApp group name. Import Groups
    # fills this in, and you can still overwrite it with your own label.
    name = fields.Char(
        string='Group Name',
        help="Your label for this group. Import Groups fills it in with the "
             "real WhatsApp name; change it to whatever you would rather see. "
             "It is what tells one group id from another before posting.")
    # NOT required. A group imported from WhatsApp has genuinely never been
    # posted in as far as we know, and inventing a "last message" time to
    # satisfy a constraint would put a date on screen that never happened.
    last_seen = fields.Datetime(string='Last Message')
    last_sender = fields.Char(
        string='Last Posted By',
        help="Display name of whoever last posted in this group. Free from the "
             "incoming event, and often enough to recognise a group with no label.")
    message_count = fields.Integer(string='Messages Seen', default=0)
    active = fields.Boolean(default=True)

    # ---- which client this group belongs to -------------------------------- #
    # ONE group -> ONE client. The client's own children are its sub-clients
    # (shops/branches), so a message in this group is scoped to that client's
    # subtree rather than searched across every customer in the database.
    # Without this, a reference like "KM TRADING" typed in one reseller's group
    # could resolve onto another reseller's record.
    kra_id = fields.Many2one(
        'kra.master', string='Client', ondelete='restrict', index=True,
        domain="[('is_client', '=', True)]",
        help="The client this WhatsApp group belongs to. Everything raised in "
             "this group is scoped to this client and the sub-clients beneath it.")
    sub_client_ids = fields.One2many(
        related='kra_id.child_ids', string='Sub-clients', readonly=True,
        help="Shops / branches under this client. Managed on the client itself, "
             "not here -- this is a read-only view of what the group covers.")
    sub_client_count = fields.Integer(
        string='Sub-clients', compute='_compute_sub_client_count')
    client_user_ids = fields.Many2many(
        related='kra_id.client_user_ids', string='Client Users', readonly=True)

    # ---- who is actually in the group -------------------------------------- #
    member_ids = fields.One2many('kpi.wa.group.member', 'group_id',
                                 string='Members')
    member_count = fields.Integer(compute='_compute_member_stats', string='Members')
    client_member_count = fields.Integer(compute='_compute_member_stats',
                                         string='Client Members')
    members_synced_at = fields.Datetime(string='Members Synced', readonly=True)

    # ---- the one group that is OURS, not a client's ----------------------- #
    #
    # Every other group in this table belongs to a client and is read by them.
    # This one is the team's own: approvals that could not be delivered, the
    # developer menu, questions on their way to a manager. Nothing a client
    # should ever see is posted to a client group by accident, and nothing
    # internal is posted anywhere but here.
    #
    # Deliberately a separate flag from intake_enabled rather than a third
    # state of it: a group can be internal AND have the bot answering in it,
    # and the two answer different questions -- "whose group is this" versus
    # "does the bot speak here".
    is_staff_group = fields.Boolean(
        string='Our Internal Team Group', default=False,
        help="Tick this on the ONE group that is your own team's, not a "
             "client's.\n\n"
             "The bot uses it for everything staff-facing: the developer "
             "menu, questions on their way to a manager, and a warning when "
             "an approval could not be delivered to anybody.\n\n"
             "A client must never be in this group.")

    @api.constrains('is_staff_group')
    def _check_one_staff_group(self):
        """Exactly one, or the bot has to guess which team it belongs to."""
        for rec in self.filtered('is_staff_group'):
            other = self.sudo().search([('is_staff_group', '=', True),
                                        ('id', '!=', rec.id)], limit=1)
            if other:
                raise UserError(
                    "%s is already marked as the internal team group.\n\n"
                    "There can only be one, or the bot cannot tell where to "
                    "put a message that is not for a client. Untick it there "
                    "first." % other.name)

    def write(self, vals):
        res = super().write(vals)
        if vals.get('is_staff_group'):
            # Point the company-wide sender here too. _post() with no jid --
            # used by workday reports and by the "no manager reachable"
            # warning -- falls back to res.company.kpi_wa_group_jid, and
            # while that is empty those messages are built, sent nowhere and
            # reported as failed. Marking the group is the moment somebody
            # has actually decided where they should go.
            for rec in self.filtered(lambda r: r.jid):
                rec.env.company.sudo().kpi_wa_group_jid = rec.jid
        return res

    @api.model
    def _staff_group(self):
        """The internal group, however it was named.

        One resolver so the router, the question poster and the fallback
        warning cannot disagree about which group is internal -- that
        disagreement is how an internal message ends up in a client's chat.
        """
        hit = self.sudo().search([('is_staff_group', '=', True)], limit=1)
        if hit:
            return hit
        jid = (self.env.company.kpi_wa_group_jid or '').strip()
        if jid:
            return self.sudo().search([('jid', '=', jid)], limit=1)
        return self.browse()

    intake_enabled = fields.Boolean(
        string='Bot Replies In This Group', default=False,
        help="When on, a member typing 'hi' here gets a menu and can raise a "
             "ticket against this group's Client.\n\n"
             "OFF BY DEFAULT, and per-group on purpose: a reply posted in a "
             "group is seen by everyone in it, including the client. Turn it "
             "on for one internal group first.\n\n"
             "A Client must also be set, or the bot stays silent.")

    @api.depends('member_ids', 'member_ids.is_client')
    def _compute_member_stats(self):
        for rec in self:
            rec.member_count = len(rec.member_ids)
            rec.client_member_count = len(rec.member_ids.filtered('is_client'))

    _sql_constraints = [
        ('jid_uniq', 'unique(jid)', 'This group is already recorded.'),
    ]

    @api.depends('kra_id', 'kra_id.child_ids')
    def _compute_sub_client_count(self):
        for rec in self:
            rec.sub_client_count = len(rec.kra_id.child_ids) if rec.kra_id else 0

    def name_get(self):
        """Show the client alongside the label -- the whole point of the link is
        knowing WHOSE group you are about to post into."""
        out = []
        for rec in self:
            label = rec.name or rec.jid
            if rec.kra_id:
                label = '%s (%s)' % (label, rec.kra_id.name)
            out.append((rec.id, label))
        return out

    def set_client(self, kra_id):
        """Link this group to a client. Used by the settings screen."""
        self.ensure_one()
        if kra_id:
            kra = self.env['kra.master'].sudo().browse(int(kra_id))
            if not kra.exists():
                return {'status': False, 'message': 'Client not found.'}
            self.sudo().kra_id = kra.id
        else:
            self.sudo().kra_id = False
        return {'status': True, 'kra_id': self.kra_id.id,
                'client_name': self.kra_id.name or '',
                'sub_client_count': self.sub_client_count}

    # ------------------------------------------------------------------
    # Importing the groups themselves
    # ------------------------------------------------------------------
    @api.model
    def action_import_groups(self):
        """Create a row for every WhatsApp group this number is a member of.

        Rows normally appear by themselves when somebody posts, which is fine
        on a database that has been running a while and useless on a fresh
        one: nothing exists until a client happens to type something, and
        there is no way to prepare the groups before that.

        Creating one by hand is not an option either -- `jid` is required and
        is a WhatsApp-assigned id nobody can type -- so the New button on
        this screen could only ever produce "Missing required fields".

        This asks Evolution instead. It fills in the id and the real group
        name, and deliberately leaves Client and Bot Replies alone: who a
        group belongs to, and whether the bot should speak in it, are
        decisions, not facts to be imported.
        """
        session = self.env['whatsapp.session'].sudo().search(
            [('status', '=', 'connected')], limit=1)
        if not session:
            raise UserError(_(
                'No connected WhatsApp session. Connect one under '
                'Setup > WhatsApp Connect first.'))
        client, instance = session._get_client()
        try:
            groups = client.fetch_all_groups(instance, get_participants=False)
        except Exception as exc:
            raise UserError(_('Could not read the group list: %s') % exc)

        added, renamed, already = 0, 0, 0
        for g in groups or []:
            jid = (g.get('id') or '').strip()
            if not jid or not jid.endswith(GROUP_SERVER):
                continue
            subject = (g.get('subject') or '').strip()
            row = self.sudo().with_context(active_test=False).search(
                [('jid', '=', jid)], limit=1)
            if not row:
                self.sudo().create({'jid': jid, 'name': subject or False})
                added += 1
            elif subject and not row.name:
                # Only fills a BLANK label. An admin who renamed a group in
                # Odoo did it so the screen would read the way they want; a
                # sync should not undo that every time it runs.
                row.name = subject
                renamed += 1
            else:
                already += 1

        parts = []
        if added:
            parts.append(_('%s added') % added)
        if renamed:
            parts.append(_('%s named') % renamed)
        if already:
            parts.append(_('%s already here') % already)
        _logger.info('kpi.wa.group: imported %s group(s) from WhatsApp',
                     len(groups or []))
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'type': 'success' if (added or renamed) else 'info',
                'title': _('Groups imported'),
                'sticky': False,
                'message': (', '.join(parts) or _('Nothing found.'))
                + _('\n\nSet a Client on each one, then turn on Bot Replies '
                    'for the groups the bot should answer in.'),
                'next': {'type': 'ir.actions.act_window_close'},
            },
        }

    @api.model
    def action_open_groups(self):
        """Refresh from WhatsApp, then show the list.

        The import used to sit on a button in the list header. That does not
        work: a <header> button in a list view only appears once rows are
        SELECTED, because it is meant for acting on a selection -- so an
        action that creates rows could never be reached from an empty or
        unselected list. Every core example does it that way for the same
        reason (ir.profile, res.lang).

        Doing it on open is also closer to what somebody expects: they added
        a group on their phone, so it should be here. There is nothing to
        press and nothing to remember.

        Failures are swallowed on purpose. The import talks to Evolution over
        HTTP, and WhatsApp being down must not make this screen unopenable --
        the rows already in it are still worth reading. The explicit path
        still raises, so a deliberate import that fails still says why.
        """
        try:
            self.action_import_groups()
        except Exception as exc:
            _logger.info('WhatsApp group auto-import skipped: %s', exc)
        return {
            'type': 'ir.actions.act_window',
            'name': _('WhatsApp Groups'),
            'res_model': 'kpi.wa.group',
            'view_mode': 'list,form',
            'target': 'current',
            'search_view_id': [
                self.env.ref('kra_kpi_module.view_kpi_wa_group_search').id,
                'search'],
        }

    # ------------------------------------------------------------------
    # Members
    # ------------------------------------------------------------------
    def action_sync_members(self):
        """Pull the group's participant list from the WhatsApp server.

        A group has many members and only some of them are the client. Until
        you can see WHO is in a group, "link this group to a client" is a guess.

        Evolution returns BOTH identifiers per participant:
            {"id": "6957981286468@lid",
             "phoneNumber": "971529454455@s.whatsapp.net",
             "admin": "admin"|null, "name": "..."}
        The LID is what rides on an inbound group message; the phoneNumber is
        what res.partner can actually be matched on. Storing the pair here is
        what later lets a message be attributed to a person.
        """
        Member = self.env['kpi.wa.group.member'].sudo()
        total = 0
        for rec in self:
            session = self.env['whatsapp.session'].sudo().search(
                [('status', '=', 'connected')], limit=1)
            if not session:
                raise UserError(_('No connected WhatsApp session.'))
            client, instance = session._get_client()
            try:
                parts = client.group_participants(instance, rec.jid)
            except Exception as exc:
                raise UserError(_('Could not read members: %s') % exc)

            seen = []
            for p in parts or []:
                lid = (p.get('id') or '').strip()
                phone_raw = (p.get('phoneNumber') or '').strip()
                phone = re.sub(r'\D+', '', phone_raw.split('@', 1)[0]) if phone_raw else ''
                if not lid and not phone:
                    continue
                vals = {
                    'group_id': rec.id,
                    'lid': lid,
                    'phone': phone,
                    'wa_name': (p.get('name') or '')[:120],
                    'is_admin': bool(p.get('admin')),
                    'last_synced': fields.Datetime.now(),
                }
                row = Member.search([
                    ('group_id', '=', rec.id),
                    '|', ('lid', '=', lid), ('phone', '=', phone),
                ], limit=1) if (lid or phone) else Member
                if row:
                    # Never blank a name we already have with an empty one.
                    if not vals['wa_name']:
                        vals.pop('wa_name')
                    # manual_client_kra_id is deliberately NOT in vals, so a
                    # hand-set client survives every re-sync.
                    row.write(vals)
                else:
                    row = Member.create(vals)
                row._resolve_identity()
                seen.append(row.id)
                total += 1
            # Members who have left the group.
            Member.search([('group_id', '=', rec.id), ('id', 'not in', seen)]).unlink()
            rec.sudo().members_synced_at = fields.Datetime.now()
        return total


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

class KpiWaGroupMember(models.Model):
    """One participant of a WhatsApp group, matched to Odoo where possible."""
    _name = 'kpi.wa.group.member'
    _description = 'WhatsApp Group Member'
    _order = 'is_client desc, wa_name, phone'
    _rec_name = 'wa_name'

    group_id = fields.Many2one('kpi.wa.group', required=True,
                               ondelete='cascade', index=True)
    group_kra_id = fields.Many2one(related='group_id.kra_id',
                                   string='Group Client', store=True)
    lid = fields.Char(
        string='LID', index=True,
        help="WhatsApp's internal id for this member. This is what arrives on "
             "an inbound group message, which is why it is stored next to the "
             "phone number rather than discarded.")
    phone = fields.Char(string='Phone', index=True)
    wa_name = fields.Char(string='WhatsApp Name')
    is_admin = fields.Boolean(string='Group Admin')
    last_synced = fields.Datetime(readonly=True)

    partner_id = fields.Many2one('res.partner', string='Contact',
                                 ondelete='set null')
    user_id = fields.Many2one('res.users', string='Odoo User',
                              ondelete='set null')
    client_kra_ids = fields.Many2many(
        'kra.master', string='Client Of',
        help='Clients this member is registered against (kra.master.client_user_ids). '
             'Rewritten on every Sync Members, so do not hand-edit it -- use '
             '"Client (set here)" instead.')
    manual_client_kra_id = fields.Many2one(
        'kra.master', string='Client (set here)', ondelete='set null', index=True,
        domain="[('is_client', '=', True)]",
        help="Mark this member as a client WITHOUT having to wire them up in "
             "Odoo first. Use it when somebody is plainly the client on "
             "WhatsApp but has no contact, no user, or is not yet listed under "
             "the client's Client Users. Survives Sync Members; the automatic "
             "'Client Of' above does not.")
    is_client = fields.Boolean(
        string='Is Client', compute='_compute_member_kind', store=True,
        help="Derived, so not directly tickable. It turns on when the member "
             "is linked to a client -- either automatically through their Odoo "
             "user, or by setting 'Client (set here)'.")
    member_kind = fields.Selection([
        ('client', 'Client'),
        ('developer', 'Developer'),
        ('coordinator', 'Coordinator'),
        ('owner', 'Owner'),
        ('staff', 'Staff (no KRA role)'),
        ('unknown', 'Not in Odoo'),
    ], string='Role', compute='_compute_member_kind', store=True)

    @api.depends('user_id', 'partner_id', 'client_kra_ids', 'manual_client_kra_id')
    def _compute_member_kind(self):
        for rec in self:
            kind = 'unknown'
            # A human saying "this is the client" outranks anything inferred.
            # Without this, somebody who is obviously the client on WhatsApp but
            # has no Odoo user stays 'Not in Odoo' forever and there is no way
            # to say otherwise.
            if rec.manual_client_kra_id:
                rec.member_kind = 'client'
                rec.is_client = True
                continue
            if rec.user_id:
                # has_group(), not grp.user_ids: direct membership misses an
                # implied role, which is the same bug fixed in kpi_notify.
                if rec.user_id.has_group('kra_kpi_module.group_kra_owner'):
                    kind = 'owner'
                elif rec.user_id.has_group('kra_kpi_module.group_kra_admin'):
                    kind = 'coordinator'
                elif rec.client_kra_ids or rec.user_id.has_group('kra_kpi_module.group_kra_client'):
                    kind = 'client'
                elif rec.user_id.has_group('kra_kpi_module.group_kra_developer'):
                    kind = 'developer'
                else:
                    kind = 'staff'
            elif rec.client_kra_ids:
                kind = 'client'
            elif rec.partner_id:
                kind = 'staff'
            rec.member_kind = kind
            rec.is_client = (kind == 'client')

    def _resolve_identity(self):
        """Match this member to a partner / user / client by phone.

        Matching is on the LAST 9 DIGITS of a digits-only form, both sides.
        A plain ilike on the full number -- which is what the existing inbound
        parser does -- cannot match '919876543210' against a partner stored as
        '+91 98765 43210', and that is the normal way a number is stored.
        """
        Partner = self.env['res.partner'].sudo()
        for rec in self:
            digits = re.sub(r'\D+', '', rec.phone or '')
            if not digits:
                continue
            tail = digits[-9:]
            partner = False
            # Cheap exact attempts first, then the suffix scan.
            for probe in (digits, '+' + digits):
                partner = Partner.search([('phone', '=', probe)], limit=1)
                if partner:
                    break
            if not partner:
                candidates = Partner.search(
                    ['|', ('phone', 'like', tail), ('phone', 'ilike', tail)], limit=20)
                for cand in candidates:
                    if re.sub(r'\D+', '', cand.phone or '')[-9:] == tail:
                        partner = cand
                        break
            user = self.env['res.users'].sudo().search(
                [('partner_id', '=', partner.id)], limit=1) if partner else False
            if not user:
                user = self.env['res.users'].sudo().search(
                    [('kpi_wa_number', 'like', tail)], limit=1) or \
                    self.env['res.users'].sudo().search(
                    [('kpi_mobile_number', 'like', tail)], limit=1)
                if user and not partner:
                    partner = user.partner_id
            kras = self.env['kra.master'].sudo().search(
                [('client_user_ids', 'in', user.id)]) if user else self.env['kra.master']
            rec.write({
                'partner_id': partner.id if partner else False,
                'user_id': user.id if user else False,
                'client_kra_ids': [(6, 0, kras.ids)],
            })
        return True



class WhatsappSessionGroupCapture(models.Model):
    _inherit = 'whatsapp.session'

    # The action_connect override and _kpi_install_group_capture were REMOVED
    # on 16 Oct 2026 (Evolution migration).
    #
    # They monkey-wrapped neonize's single registered MessageEv handler
    # (client.event.list_func[EVENT_TO_INT[MessageEv]]) to observe group traffic,
    # because there was an in-process Go client to reach into. There is no such
    # client now: Evolution delivers every message -- group traffic included --
    # to the webhook at /whatsapp/evolution/<session>/<token>, which records a
    # whatsapp.message row and calls kpi.wa.group.record_seen() directly.
    #
    # That is strictly better than the wrapper was:
    #   * one inbound path instead of a wrapper around one of two drifted
    #     in-process callbacks, which a reconnect could double-wrap;
    #   * the in-group SENDER is available (Evolution sends data.key.participant),
    #     where this code could only ever see info.PushName, a display name;
    #   * the message BODY survives -- _capture() discarded it entirely.
    #
    # The kpi.wa.group model and record_seen() above are unchanged and are now
    # called from the webhook.

    def _kpi_install_group_capture(self):
        """Retained as a no-op: older code paths and any stale ir.cron or data
        row may still call it by name."""
        return True
