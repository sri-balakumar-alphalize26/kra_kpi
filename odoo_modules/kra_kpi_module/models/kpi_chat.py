"""💬 Discuss: one chat thread per task, between the client and the team.

The client writes from their WhatsApp group (hi → 💬 Discuss → pick the
request → type). The team answers from the 💬 Chat window in KPI details
(Odoo, web, the WhatsApp task page), from WhatsApp (📋 KPI details →
💬 Reply to client) or from the manager's private chat.

WHO THE CLIENT SEES
-------------------
Every team message reaches the client group as "Reply from the Alphalize team" --
never a developer's name. Putting a client and a developer in direct touch is
the one thing the rest of this module is careful not to do (see
kpi_doubt.action_release_to_client). Inside the Chat window staff see who
wrote what.

THE MANAGER'S POLL
------------------
A client message also opens a kpi.doubt of kind 'client_msg', so the
manager gets the same private poll a developer's question gets (✍️ answer /
📅 meeting / ❌ not now) and can answer by typing in their private chat. One
open per task: further client messages join it instead of sending the
manager a new poll each time. Any team reply closes it.
"""

import logging
import secrets
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

CHAT_MAX = 1000
CHAT_SOURCES = [('whatsapp', 'WhatsApp'), ('odoo', 'Odoo'), ('web', 'Web'),
                ('wa_page', 'WhatsApp task page'), ('client_page', 'Client chat page')]
CLIENT_CHAT_HOURS = 24          # the client's chat link works this long
MAX_PICK_DEVS = 6               # developers offered in the manager's poll


class KpiChatMessage(models.Model):
    _name = 'kpi.chat.message'
    _description = 'Chat message between the client and the team on a task'
    _order = 'create_date asc, id asc'

    kpi_id = fields.Many2one('kra.kpi', string='Task', required=True,
                             ondelete='cascade', index=True)
    side = fields.Selection([('client', 'Client'), ('team', 'Team')],
                            required=True, index=True)
    author_user_id = fields.Many2one('res.users', string='Staff', ondelete='set null')
    author_name = fields.Char(string='Name', help="The client's WhatsApp name.")
    author_number = fields.Char(string='Number',
                                help="The client's phone digits, to @mention them in their group.")
    body = fields.Text(required=True)
    source = fields.Selection(CHAT_SOURCES, default='whatsapp')
    doubt_id = fields.Many2one('kpi.doubt', string='Manager question',
                               ondelete='set null')


class KraKpiChat(models.Model):
    _inherit = 'kra.kpi'

    # The client's own link to this task's chat (/kpi/wa/chat/<token>): the
    # chat and nothing else, for CLIENT_CHAT_HOURS. Sent in their group when
    # the manager hands the question to a developer.
    client_chat_token = fields.Char(copy=False, index=True, readonly=True)
    client_chat_expires = fields.Datetime(copy=False, readonly=True)

    # 💬 Discuss › "Something else": a client's general questions, not about
    # one request, are held on ONE hidden task per client -- archived, like
    # the old-requirement placeholders (kpi_legacy), so no report, queue,
    # count or invoice ever sees it -- and get the same chat, manager poll
    # and developer hand-off as a request.
    is_chat_general = fields.Boolean(
        string='General questions (Discuss)', readonly=True, copy=False, index=True)

    def _chat_ref(self):
        if self.is_chat_general:
            return _('General question')
        return self.external_ref or ('#%s' % self.id)

    @api.model
    def _chat_general_task(self, client):
        """The hidden task that holds `client`'s general questions, made once."""
        Kpi = self.env['kra.kpi'].sudo().with_context(active_test=False)
        rec = Kpi.search([('is_chat_general', '=', True), ('kra_id', '=', client.id)], limit=1)
        if rec:
            return rec
        # kpi_legacy_quiet: no "new task" notices for bookkeeping;
        # kpi_no_admin_arm: nothing for an admin to accept.
        rec = Kpi.with_context(kpi_no_admin_arm=True, kpi_legacy_quiet=True).create({
            'name': client.name or _('Client'),
            'kra_id': client.id,
            'external_ref': 'GEN-%03d' % client.id,
            'is_chat_general': True,
            'task_state': 'completed',
            'published': False,
            'description': _('💬 Discuss: general questions from the client, not about one request.'),
        })
        rec.active = False
        return rec

    def chat_rows(self, viewer=None, limit=200):
        """The thread, oldest first, as plain dicts for every screen.
        `at` is UTC ('YYYY-MM-DD HH:MM:SS'); each screen shows it local."""
        self.ensure_one()
        msgs = self.env['kpi.chat.message'].sudo().search(
            [('kpi_id', '=', self.id)], order='id desc', limit=limit)
        out = []
        for m in reversed(msgs):
            who = m.author_user_id.name if m.side == 'team' else m.author_name
            out.append({
                'id': m.id, 'side': m.side, 'body': m.body or '',
                'who': who or (_('Client') if m.side == 'client' else _('Team')),
                'at': fields.Datetime.to_string(m.create_date),
                'mine': bool(viewer and m.author_user_id == viewer),
                'source': m.source or '',
            })
        return out

    def chat_waiting(self):
        """How many client messages have come in since the team last wrote."""
        self.ensure_one()
        n = 0
        for m in self.env['kpi.chat.message'].sudo().search(
                [('kpi_id', '=', self.id)], order='id desc', limit=50):
            if m.side == 'team':
                break
            n += 1
        return n

    # ------------------------------------------------------------------
    def chat_post_client(self, text, name='', number='', source='whatsapp'):
        """A client's message, from the WhatsApp Discuss flow or their chat page."""
        self.ensure_one()
        body = (text or '').strip()[:CHAT_MAX]
        if not body:
            raise UserError(_('Write the message first.'))
        Msg = self.env['kpi.chat.message'].sudo()
        msg = Msg.create({'kpi_id': self.id, 'side': 'client', 'body': body,
                          'author_name': name or '', 'author_number': number or False,
                          'source': source})
        Doubt = self.env['kpi.doubt'].sudo()
        doubt = Doubt.search([('kpi_id', '=', self.id), ('kind', '=', 'client_msg'),
                              ('state', '=', 'open')], limit=1)
        if doubt:
            # Still unanswered: the manager gets the full alert again -- every
            # message so far, the Open link and the developer buttons -- not a
            # bare "added" line they cannot act on.
            doubt.sudo().write({'question': ('%s\n%s' % (doubt.question or '', body)).strip()[-2000:]})
            doubt._ask_the_manager()
        else:
            # The MANAGER decides first (their poll: reply, ask the developer,
            # meeting, not now); the developer is told only when asked.
            # raised_group_id stays empty on purpose: the doubt's team notices
            # go to the group it names, and this one must never be the client's.
            doubt = Doubt.create({'kpi_id': self.id, 'kind': 'client_msg', 'question': body,
                                  'raised_by_id': False, 'raised_by_name': name or ''})
        msg.doubt_id = doubt.id
        self.sudo()._log_action('client_chat_message', source='whatsapp', actor_label=name or _('Client'),
                                payload={'message': msg.id, 'text': body})
        return msg

    def _chat_page_link(self, dev):
        """The developer's own task-page link (/kpi/wa/task/<token>#chat),
        opening straight on the 💬 Chat -- the same 2-hour, one-person link
        kpi_wa_staff_task._send_page_link makes. '' when they are not in the
        team group. Never posted in a group: it works for this person only."""
        staff = self.env['kpi.wa.group']._staff_group()
        mem = self.env['kpi.wa.group.member'].sudo().search(
            [('group_id', '=', staff.id), ('user_id', '=', dev.id)], limit=1) if staff else None
        key = mem and (mem.lid or mem.phone)
        if not key:
            return ''
        st = self.env['kpi.wa.group.intake']._get_or_create(staff, key, dev.name or '')
        token = secrets.token_urlsafe(24)
        st.sudo().write({'staff_page_token': token, 'staff_page_kpi_id': self.id,
                         'staff_page_expires': fields.Datetime.now() + timedelta(hours=2)})
        base = self.env['whatsapp.config'].sudo().get_config().get_kpi_public_base_url()
        return '%s/kpi/wa/task/%s#chat' % (base, token)

    def _public_base(self):
        return self.env['whatsapp.config'].sudo().get_config().get_kpi_public_base_url()

    def _staff_task_url(self):
        """The task in Odoo, for the team (needs their login)."""
        return '%s/odoo/kra.kpi/%s' % (self._public_base(), self.id)

    def _client_chat_link(self):
        """The client's chat page for this task, valid CLIENT_CHAT_HOURS from now.
        The same link is kept while it is still good, so earlier messages in
        the group keep working."""
        self.ensure_one()
        now = fields.Datetime.now()
        vals = {'client_chat_expires': now + timedelta(hours=CLIENT_CHAT_HOURS)}
        if not self.client_chat_token or not self.client_chat_expires or self.client_chat_expires <= now:
            vals['client_chat_token'] = secrets.token_urlsafe(24)
        self.sudo().write(vals)
        return '%s/kpi/wa/chat/%s' % (self._public_base(), self.client_chat_token)

    def _chat_dev_candidates(self):
        """Who the manager can hand a client question to: the people on the
        task first, then the Developer role, at most MAX_PICK_DEVS."""
        self.ensure_one()
        devs = (self.user_id | self.contributor_ids).filtered(lambda u: u.active and not u.share)
        group = self.env.ref('kra_kpi_module.group_kra_developer', raise_if_not_found=False)
        if group:
            devs |= group.sudo().user_ids.filtered(lambda u: u.active and not u.share).sorted('name')
        return devs[:MAX_PICK_DEVS]

    def _chat_askers(self):
        """The client people waiting for an answer: [(name, digits)]."""
        out, seen = [], set()
        for m in self.env['kpi.chat.message'].sudo().search(
                [('kpi_id', '=', self.id)], order='id desc', limit=50):
            if m.side == 'team':
                break
            key = m.author_number or m.author_name or ''
            if key not in seen:
                seen.add(key)
                out.append((m.author_name or '', m.author_number or ''))
        return list(reversed(out))

    def chat_ask_developer(self, manager, devs=None):
        """The manager hands the client's question to the task's developer.

        The team group only gets an @mention -- no client wording -- and the
        question itself goes to the developer's private chat, where their
        reply is taken (kpi_manager_dm._continue_dev_reply) and posted to the
        client group as "our team". Returns (developers, unreachable)."""
        self.ensure_one()
        devs = devs or self.user_id.filtered('active') or self.contributor_ids.filtered('active')
        if not devs:
            raise UserError(_('Nobody is assigned to %s yet.') % self._chat_ref())
        ref = self._chat_ref()
        client = self.client_kra_id.name or self.kra_id.name or ''
        waiting = self.chat_waiting()
        said = '\n'.join('%s: "%s"' % (r['who'], r['body']) for r in self.chat_rows(limit=max(waiting, 1))
                         if r['side'] == 'client')
        doubt = self.env['kpi.doubt'].sudo().search([('kpi_id', '=', self.id), ('kind', '=', 'client_msg'),
                                                     ('state', '=', 'open')], limit=1)
        Report = self.env['kpi.wa.group.report'].sudo()
        Conv = self.env['kpi.wa.conversation'].sudo()
        reached = self.env['res.users']
        for dev in devs:
            number = dev._kpi_wa_target()
            if not number or '@' in number:
                continue
            link = self._chat_page_link(dev)
            sent = Report.post_text_to_user(dev, _(
                '💬 *%(ref)s — %(title)s* · %(client)s\n%(mgr)s asks you to reply to the client.\n\n%(said)s\n\n'
                'Type your reply here — it goes to their group as "Reply from the Alphalize team". '
                '(Type cancel to stop.)%(link)s') % {
                    'ref': ref, 'title': self.name or '', 'client': client,
                    'mgr': manager.name or _('The manager'), 'said': said,
                    'link': ('\n\n' + _('Or reply in the chat on the page (only for you, 2 hours):\n%s') % link)
                    if link else ''})
            if sent:
                Conv.get_or_create(number).write({
                    'step': 'dev_client_reply', 'target_kpi_id': self.id,
                    'target_doubt_id': doubt.id if doubt else False, 'chat_draft': False,
                    'last_activity': fields.Datetime.now()})
                reached |= dev
        unreachable = devs - reached
        askers = self._chat_askers()
        # The client group: the person who asked, tagged, and their chat link.
        # Never the developer's name -- to the client it is "our team".
        tags = [('@%s' % d) if len(d) >= 11 else (n or _('there')) for n, d in askers] or [_('there')]
        Report.post_for_kpi(self, _(
            '💬 %(who)s — about *%(ref)s — %(title)s*: the Alphalize team has your message and '
            'will reply soon.\n\nOpen the chat (works for %(hours)d hours):\n%(link)s') % {
                'who': ', '.join(tags), 'ref': ref, 'title': self.name or '',
                'hours': CLIENT_CHAT_HOURS, 'link': self._client_chat_link()},
            mentions=[d for _n, d in askers if len(d) >= 11])
        # Our group: which developer was picked, by whom, for whom -- with the link.
        staff = self.env['kpi.wa.group']._staff_group()
        where = (_('📩 The question and a reply link are in their private chat.') if reached else
                 _('Reply from 📋 KPI details → 💬 Reply to client.'))
        Report._post(_('👨‍💻 *%(ref)s — %(title)s* · %(client)s\n%(mgr)s picked %(mention)s to reply to '
                       '%(asker)s. %(where)s\n\nOpen: %(url)s') % {
            'mention': ' '.join(Report._mention(u) for u in devs), 'client': client, 'ref': ref,
            'title': self.name or '', 'mgr': manager.name or _('The manager'), 'where': where,
            'asker': ', '.join(n for n, _d in askers if n) or _('the client'),
            'url': self._staff_task_url()},
            jid=staff.jid or None,
            mentions=[d for d in (Report._mention_digits(u) for u in devs) if d])
        self.sudo()._log_action('client_chat_forwarded', source='whatsapp', actor_user_id=manager.id,
                                payload={'to': devs.ids, 'private': reached.ids})
        return devs, unreachable

    def chat_post_team(self, text, user, source='odoo'):
        """A team message: saved, posted in the client group as "our team",
        and the manager's open question about it is closed. Callers check
        that `user` may write on this task."""
        self.ensure_one()
        body = (text or '').strip()[:CHAT_MAX]
        if not body:
            raise UserError(_('Write the message first.'))
        ref = self._chat_ref()
        Report = self.env['kpi.wa.group.report'].sudo()
        if not Report._group_for_kpi(self):
            raise UserError(_('This client has no WhatsApp group linked, so the message '
                              'could not be sent.'))
        posted = Report.post_for_kpi(self, _(
            '💬 *%(ref)s — %(title)s*\nReply from the Alphalize team:\n\n%(body)s\n\n'
            '_To answer, send *hi* → 💬 Discuss._') % {
                'ref': ref, 'title': self.name or '', 'body': body})
        if not posted:
            raise UserError(_("WhatsApp couldn't be reached just now — nothing was sent. "
                              "Try again in a minute."))
        msg = self.env['kpi.chat.message'].sudo().create({
            'kpi_id': self.id, 'side': 'team', 'body': body,
            'author_user_id': user.id if user else False, 'source': source})
        self.env['kpi.doubt'].sudo().search([
            ('kpi_id', '=', self.id), ('kind', '=', 'client_msg'), ('state', '=', 'open'),
        ]).write({'state': 'answered', 'answer': body,
                  'answered_by_id': user.id if user else False,
                  'answered_at': fields.Datetime.now()})
        staff = self.env['kpi.wa.group']._staff_group()
        Report._post(_('✅ *%(ref)s* — %(who)s replied to the client.') % {
            'ref': ref, 'who': (user.name if user else '') or _('The team')}, jid=staff.jid or None)
        self.sudo()._log_action('client_chat_reply', source='whatsapp' if source in ('whatsapp', 'wa_page') else 'web',
                                actor_user_id=user.id if user else None,
                                payload={'message': msg.id, 'text': body})
        return msg
