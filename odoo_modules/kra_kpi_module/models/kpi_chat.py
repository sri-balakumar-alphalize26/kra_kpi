"""💬 Discuss: one chat thread per task, between the client and the team.

The client writes from their WhatsApp group (hi → 💬 Discuss → pick the
request → type). The team answers from the 💬 Chat window in KPI details
(Odoo, web, the WhatsApp task page), from WhatsApp (📋 KPI details →
💬 Reply to client) or from the manager's private chat.

WHO THE CLIENT SEES
-------------------
Every team message reaches the client group as a link to the client's chat
page ("the Alphalize team replied … open the chat"), where it reads as
"Alphalize team" -- never a developer's name. Putting a client and a developer in direct touch is
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

import base64
import logging
import re
import secrets
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import UserError

from .kpi_legacy import _IMAGE_EXT_RE, is_audio, is_image_or_video

_logger = logging.getLogger(__name__)

CHAT_MAX = 1000
CHAT_SOURCES = [('whatsapp', 'WhatsApp'), ('odoo', 'Odoo'), ('web', 'Web'),
                ('wa_page', 'WhatsApp task page'), ('client_page', 'Client chat page')]
CLIENT_CHAT_HOURS = 24          # the client's chat link works this long
CHAT_FILES_MAX = 10             # 📎 files on one message
CHAT_FILE_MAX_BYTES = 50 * 1024 * 1024   # each; nginx allows 50 MB, like progress uploads
MAX_PICK_DEVS = 6               # developers offered in the manager's poll
EDIT_WINDOW_MIN = 15            # own text message may be edited this long (as 369Chats)
TEAM_LIVE_SECONDS = 20          # a chat that polled while ACTIVE this recently is "online"
DEVICE_TRUST_DAYS = 90          # a phone confirmed on WhatsApp opens client chats this long
CONFIRM_RE = re.compile(r'^\s*CHAT\s+(\S+)\s+([A-Z0-9]{4})\s*$', re.I)
CONFIRM_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'   # no 0/O, 1/I
ESCALATE_AFTER_MIN = 5          # a client message still unseen this long is raised again, once
DELETED_TEXT = 'This message was deleted'
# Reactions, the same set as the 369Chats app (its QUICK_REACTIONS + ALL_REACTIONS),
# so a tally never holds an emoji another screen cannot show.
QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']
ALL_REACTIONS = [
    '👍', '👎', '❤️', '🔥', '🎉', '👏', '🙏', '💯',
    '😂', '🤣', '😅', '😊', '😍', '😎', '🤔', '😐',
    '😮', '😢', '😭', '😡', '🥳', '🤝', '💪', '✅',
    '❌', '⚠️', '👀', '🚀', '⭐', '💡', '⏰', '📌',
]
# Who reacted / may edit: staff 'u:<uid>'; the client page has no login, so it
# keeps a random id in the browser and sends it as 'c:<id>'.
_ACTOR_RE = re.compile(r'^(u:\d{1,9}|c:[A-Za-z0-9_-]{8,40})$')


# 📄 Documents, as in WhatsApp's 📎 Document: office files, PDF, text, archives.
_DOC_EXT_RE = re.compile(r'\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|zip|rar|7z)$', re.I)


def chat_file_kind(name, mimetype=''):
    """'image' / 'video' / 'audio' / 'document', or '' for anything the chat does not take."""
    if is_audio(name, mimetype):
        return 'audio'
    if is_image_or_video(name, mimetype):
        m = (mimetype or '').lower()
        if m.startswith('image/') or (not m.startswith('video/') and _IMAGE_EXT_RE.search(name or '')):
            return 'image'
        return 'video'
    if _DOC_EXT_RE.search(name or ''):
        return 'document'
    return ''


def chat_check_files(files):
    """files: [(name, bytes, mimetype)]. Raises when the chat can't take them."""
    if len(files) > CHAT_FILES_MAX:
        raise UserError(_('At most %d files in one message.') % CHAT_FILES_MAX)
    for name, raw, mime in files:
        if not chat_file_kind(name, mime):
            raise UserError(_('"%s" can not be sent: photos, videos, audio and documents '
                              '(PDF, Word, Excel ...) only.') % (name or _('File')))
        if not raw:
            raise UserError(_('"%s" is empty.') % (name or _('File')))
        if len(raw) > CHAT_FILE_MAX_BYTES:
            raise UserError(_('"%s" is too big (max 50 MB).') % (name or _('File')))


def chat_files_label(kinds):
    """'📷 2 photos · 🎵 1 audio': the text of a files-only message for the
    manager's poll, the log and WhatsApp notes."""
    out = []
    for kind, icon, one, many in (('image', '📷', _('photo'), _('photos')),
                                  ('video', '🎥', _('video'), _('videos')),
                                  ('audio', '🎵', _('audio'), _('audios')),
                                  ('document', '📄', _('document'), _('documents'))):
        n = kinds.count(kind)
        if n:
            out.append('%s %d %s' % (icon, n, one if n == 1 else many))
    return ' · '.join(out)


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
    body = fields.Text()   # empty when the message is only 📎 files
    file_ids = fields.One2many('kpi.file.attachment', 'chat_message_id', string='Files')
    # ↩ Reply: the message this one answers, shown as a quote on top of it.
    reply_to_id = fields.Many2one('kpi.chat.message', string='Reply to', ondelete='set null')
    source = fields.Selection(CHAT_SOURCES, default='whatsapp')
    doubt_id = fields.Many2one('kpi.doubt', string='Manager question',
                               ondelete='set null')
    # ✓ / ✓✓ / blue ✓✓ on the sender's bubble, as in WhatsApp. The message is
    # saved at once (✓); the WhatsApp note that carries it to the other side
    # goes out AFTER the request commits (kpi_client_updates.py
    # _after_commit_in_background), so sending never waits on Evolution:
    #   pending = saved, the note not out yet
    #   sent    = the note reached the client group / the manager  (✓✓)
    #   failed  = WhatsApp refused it; "retry" puts it back to pending (⚠)
    # Rows from before this field count as sent: they were posted inline.
    delivery_state = fields.Selection(
        [('pending', 'Pending'), ('sent', 'Sent'), ('failed', 'Failed')],
        default='sent', index=True, readonly=True, copy=False)
    delivered_at = fields.Datetime(readonly=True, copy=False)
    delivery_error = fields.Char(readonly=True, copy=False)
    # The other side had it on screen (their chat page / window was open and
    # visible when it polled): blue ✓✓. Same style as kpi.notification.read_at.
    seen_at = fields.Datetime(readonly=True, copy=False)
    # Long-press actions (as 369Chats): an edit keeps the row and stamps it;
    # a delete keeps the row as a placeholder ("This message was deleted") so
    # replies that quote it and the thread's order still make sense.
    edited_at = fields.Datetime(readonly=True, copy=False)
    deleted_at = fields.Datetime(readonly=True, copy=False, index=True)
    # Escalation of a client message nobody on the team had on screen:
    # alerted_at = the developer + manager were told on WhatsApp at once;
    # escalated_at = still unseen after ESCALATE_AFTER_MIN, told again (once).
    alerted_at = fields.Datetime(readonly=True, copy=False)
    escalated_at = fields.Datetime(readonly=True, copy=False, index=True)
    reaction_ids = fields.One2many('kpi.chat.reaction', 'message_id', string='Reactions')

    def _chat_status(self):
        """'pending' | 'sent' | 'seen' | 'failed' -- the tick the sender sees."""
        self.ensure_one()
        # Seen wins: the other side had it on screen, so a WhatsApp note that
        # failed to announce it no longer matters.
        if self.seen_at:
            return 'seen'
        if self.delivery_state == 'failed':
            return 'failed'
        return 'sent' if self.delivery_state == 'sent' else 'pending'


class KpiChatReaction(models.Model):
    """One emoji per person per message, WhatsApp style: picking another
    emoji replaces it, picking the same one again removes it."""
    _name = 'kpi.chat.reaction'
    _description = 'Emoji reaction on a chat message'

    message_id = fields.Many2one('kpi.chat.message', required=True, ondelete='cascade', index=True)
    actor = fields.Char(required=True, index=True, help="'u:<uid>' for staff, 'c:<browser id>' for the client page.")
    emoji = fields.Char(required=True)

    # models.Constraint, NOT _sql_constraints: this Odoo ignores the old
    # attribute (see kpi_daily_report._uniq_report_day).
    _uniq_actor_message = models.Constraint(
        'UNIQUE (message_id, actor)',
        'One reaction per person per message.',
    )


class KpiChatDevice(models.Model):
    """A browser (phone or laptop) that proved, once, on WhatsApp that it
    belongs to a person of a client: it sent "CHAT <ref> <nonce>" from their
    own number to ours. Then that client's chat links open on it for
    DEVICE_TRUST_DAYS, renewed on each use. Before that it only holds the
    nonce the page showed."""
    _name = 'kpi.chat.device'
    _description = 'Browser confirmed for a client chat'

    browser_id = fields.Char(required=True, index=True, help="The chat page's own id ('c:...').")
    nonce = fields.Char(index=True, help='The 4 letters in the pre-typed WhatsApp message.')
    kpi_id = fields.Many2one('kra.kpi', ondelete='set null', help='The task it was started from.')
    kra_id = fields.Many2one('kra.master', ondelete='cascade', index=True,
                             help='The client whose group the sender is in.')
    number = fields.Char(help='The WhatsApp number (or LID) that confirmed it.')
    name = fields.Char()
    trusted_until = fields.Datetime(index=True)


class KraKpiChat(models.Model):
    _inherit = 'kra.kpi'

    # The client's own link to this task's chat (/kpi/wa/chat/<token>): the
    # chat and nothing else, for CLIENT_CHAT_HOURS. Sent in their group when
    # the manager hands the question to a developer.
    client_chat_token = fields.Char(copy=False, index=True, readonly=True)
    client_chat_expires = fields.Datetime(copy=False, readonly=True)
    # Last time a team chat window for this task polled while on screen:
    # someone is "in the chat", so a new client message needs no WhatsApp alert.
    chat_team_live_at = fields.Datetime(copy=False, readonly=True)
    # The same for the client's chat page: online = open, on screen and
    # touched in the last minute (the page says so on each poll).
    chat_client_live_at = fields.Datetime(copy=False, readonly=True)

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

    @staticmethod
    def _chat_actor(viewer=None, actor=None):
        """The actor key for reactions / edits: a valid 'c:<id>' as given, else
        the logged-in viewer's 'u:<uid>', else ''."""
        if actor and _ACTOR_RE.match(actor):
            return actor
        return 'u:%d' % viewer.id if viewer else ''

    @staticmethod
    def _chat_own(m, actor):
        """Is `m` the actor's own message? Staff own what they wrote; the
        client page (one company, no personal login) owns every client row."""
        if actor.startswith('u:'):
            return m.side == 'team' and m.author_user_id.id == int(actor[2:])
        return bool(actor) and m.side == 'client'

    def chat_rows(self, viewer=None, limit=200, file_url='/kpi/chat/file/%d', actor=None, admin=False):
        """The thread, oldest first, as plain dicts for every screen.
        `at` is UTC ('YYYY-MM-DD HH:MM:SS'); each screen shows it local.
        file_url: where a 📎 file opens for THIS viewer (logged in by default;
        the client page and the task page pass their token links).
        actor: who is looking (see _chat_actor), for `mine` on reactions and
        the can_edit / can_delete flags; admin: may delete any team message."""
        self.ensure_one()
        actor = self._chat_actor(viewer, actor)
        msgs = self.env['kpi.chat.message'].sudo().search(
            [('kpi_id', '=', self.id)], order='id desc', limit=limit)
        now = fields.Datetime.now()
        out = []
        for m in reversed(msgs):
            who = m.author_user_id.name if m.side == 'team' else m.author_name
            deleted = bool(m.deleted_at)
            files = [] if deleted else [
                {'id': f.id, 'name': f.file_name or '', 'mime': f.mimetype or '',
                 'kind': chat_file_kind(f.file_name, f.mimetype) or 'image',
                 'size': f.file_size or 0, 'url': file_url % f.id} for f in m.file_ids]
            label = chat_files_label([f['kind'] for f in files])
            q = m.reply_to_id
            reply = False
            if q:
                q_files = chat_files_label([chat_file_kind(f.file_name, f.mimetype) for f in q.file_ids])
                reply = {'id': q.id, 'side': q.side,
                         'who': (q.author_user_id.name if q.side == 'team' else q.author_name)
                         or (_('Client') if q.side == 'client' else _('Team')),
                         'text': DELETED_TEXT if q.deleted_at
                         else ' '.join(((q.body or '') or q_files).split())[:200]}
            # Reactions as a tally: {emoji: count}, own one flagged.
            tally, mine_emoji = {}, ''
            if not deleted:
                for r in m.reaction_ids:
                    tally[r.emoji] = tally.get(r.emoji, 0) + 1
                    if r.actor == actor:
                        mine_emoji = r.emoji
            reactions = [{'emoji': e, 'count': n, 'mine': e == mine_emoji}
                         for e, n in sorted(tally.items(), key=lambda kv: (-kv[1], kv[0]))]
            own = self._chat_own(m, actor)
            body = '' if deleted else (m.body or '')
            can_edit = (own and not deleted and bool(body)
                        and (now - m.create_date) <= timedelta(minutes=EDIT_WINDOW_MIN))
            can_delete = not deleted and (own or (admin and m.side == 'team'))
            out.append({
                'id': m.id, 'side': m.side, 'body': body,
                'who': who or (_('Client') if m.side == 'client' else _('Team')),
                'at': fields.Datetime.to_string(m.create_date),
                'mine': bool(viewer and m.author_user_id == viewer),
                'source': m.source or '',
                'files': files,
                'reply': reply,
                # For WhatsApp text: the body with "📷 1 photo" in front.
                'text': DELETED_TEXT if deleted
                else ('%s\n%s' % (label, body) if label and body else body or label or ''),
                # The tick on the sender's own bubble: pending ✓, sent ✓✓,
                # seen blue ✓✓, failed ⚠ (tap to retry).
                'status': m._chat_status(),
                'error': m.delivery_error or '',
                # Long-press actions.
                'edited': bool(m.edited_at) and not deleted,
                'deleted': deleted,
                'reactions': reactions,
                'can_edit': can_edit,
                'can_delete': can_delete,
                'info': ({'delivered_at': fields.Datetime.to_string(m.delivered_at) if m.delivered_at else '',
                          'seen_at': fields.Datetime.to_string(m.seen_at) if m.seen_at else ''}
                         if own else False),
                # Changes with every edit / delete / reaction, so the plain-JS
                # pages (which redraw only on a changed signature) notice them.
                'v': '%s|%s|%s' % (m.edited_at or '', m.deleted_at or '',
                                   ','.join('%s%d%s' % (r['emoji'], r['count'], 'm' if r['mine'] else '')
                                            for r in reactions)),
            })
        return out

    # ------------------------------------------------------------------
    # Long-press actions: react / edit / delete (as 369Chats).
    # ------------------------------------------------------------------
    def chat_act(self, msg_id, action, actor, emoji=None, text=None, admin=False):
        """`actor` as in _chat_actor (must be valid). Raises UserError when
        the action is not allowed; returns the message."""
        self.ensure_one()
        if not actor or not _ACTOR_RE.match(actor):
            raise UserError(_('Who is acting could not be told.'))
        msg = self.env['kpi.chat.message'].sudo().browse(int(msg_id or 0)).exists()
        if not msg or msg.kpi_id != self:
            raise UserError(_('That message is not on this chat.'))
        if msg.deleted_at:
            raise UserError(_('That message was deleted.'))
        own = self._chat_own(msg, actor)
        if action == 'react':
            if emoji not in ALL_REACTIONS:
                raise UserError(_('That reaction is not offered.'))
            Re = self.env['kpi.chat.reaction'].sudo()
            cur = Re.search([('message_id', '=', msg.id), ('actor', '=', actor)], limit=1)
            if cur and cur.emoji == emoji:
                cur.unlink()
            elif cur:
                cur.write({'emoji': emoji})
            else:
                Re.create({'message_id': msg.id, 'actor': actor, 'emoji': emoji})
            return msg
        if action == 'edit':
            if not own:
                raise UserError(_('Only your own message can be edited.'))
            if not (msg.body or '').strip():
                raise UserError(_('A message with no text cannot be edited.'))
            if fields.Datetime.now() - msg.create_date > timedelta(minutes=EDIT_WINDOW_MIN):
                raise UserError(_('A message can be edited for %d minutes after sending.') % EDIT_WINDOW_MIN)
            new = (text or '').strip()[:CHAT_MAX]
            if not new:
                raise UserError(_('Write the message first.'))
            if new == msg.body:
                return msg
            before = msg.body
            msg.write({'body': new, 'edited_at': fields.Datetime.now()})
            self._chat_sync_doubt(msg)
            self.sudo()._log_action('client_chat_edited', source='web',
                                    actor_user_id=int(actor[2:]) if actor.startswith('u:') else None,
                                    actor_label=None if actor.startswith('u:') else _('Client'),
                                    payload={'message': msg.id, 'before': (before or '')[:500], 'text': new})
            return msg
        if action == 'delete':
            if not (own or (admin and msg.side == 'team')):
                raise UserError(_('Only your own message can be deleted.'))
            before = msg.body
            msg.file_ids.sudo().unlink()
            msg.reaction_ids.sudo().unlink()
            msg.write({'deleted_at': fields.Datetime.now()})
            self._chat_sync_doubt(msg)
            self.sudo()._log_action('client_chat_deleted', source='web',
                                    actor_user_id=int(actor[2:]) if actor.startswith('u:') else None,
                                    actor_label=None if actor.startswith('u:') else _('Client'),
                                    payload={'message': msg.id, 'before': (before or '')[:500]})
            return msg
        raise UserError(_('Unknown action.'))

    def _chat_sync_doubt(self, msg):
        """A client message was edited or deleted: the manager's OPEN question
        (its text is the client messages joined) is rebuilt from what is still
        there. No new poll; the manager's answer flow is untouched."""
        doubt = msg.doubt_id
        if msg.side != 'client' or not doubt or doubt.state != 'open':
            return
        live = self.env['kpi.chat.message'].sudo().search(
            [('doubt_id', '=', doubt.id), ('deleted_at', '=', False)], order='id asc')
        parts = []
        for m in live:
            parts.append(m.body or chat_files_label([chat_file_kind(f.file_name, f.mimetype) for f in m.file_ids]))
        doubt.sudo().write({'question': ('\n'.join(p for p in parts if p).strip()
                                         or _('The client deleted their message.'))[-2000:]})

    def chat_mark_seen(self, side, active=False):
        """The `side` ('team' / 'client') has the chat on screen: every
        unseen message from the OTHER side is now seen (blue ✓✓ for its
        sender). Called by the list routes only when the window / page is
        open and visible, never by a count-only poll."""
        self.ensure_one()
        now = fields.Datetime.now()
        # active: on screen AND touched in the last 60 s ("online"). At most
        # every 10 s, so the 3-second polls don't rewrite the task.
        live_field = 'chat_team_live_at' if side == 'team' else 'chat_client_live_at'
        last = self[live_field]
        if active and (not last or (now - last).total_seconds() >= 10):
            self.sudo().write({live_field: now})
        other = 'client' if side == 'team' else 'team'
        unseen = self.env['kpi.chat.message'].sudo().search(
            [('kpi_id', '=', self.id), ('side', '=', other), ('seen_at', '=', False)])
        if unseen:
            unseen.write({'seen_at': fields.Datetime.now()})
        return len(unseen)

    def chat_retry(self, msg_id):
        """⚠ → ✓: a failed message goes back to pending and is delivered again
        after this request commits."""
        self.ensure_one()
        msg = self.env['kpi.chat.message'].sudo().browse(int(msg_id or 0)).exists()
        if not msg or msg.kpi_id != self:
            raise UserError(_('That message is not on this chat.'))
        if msg.deleted_at:
            raise UserError(_('That message was deleted.'))
        if msg.delivery_state == 'failed':
            msg.write({'delivery_state': 'pending', 'delivery_error': False})
            self._after_commit_in_background('_chat_deliver_pending')
        return msg

    def _chat_deliver_pending(self):
        """After commit, in a thread: every pending message on this task goes
        out -- a team message as the "open the chat" note in the client group
        (+ the staff group line), a client message as the manager's poll.
        Oldest first, one at a time; a failure is kept on the message so the
        sender sees ⚠ and can retry, the rest still go."""
        Msg = self.env['kpi.chat.message'].sudo()
        for rec in self.sudo():
            # Two quick messages start two of these threads at once. One task
            # at a time (a Postgres lock per task), and each message is read
            # again after waiting, so the second thread sees what the first
            # already announced and the group gets ONE notice, not two.
            self.env.cr.execute('SELECT pg_advisory_lock(%s, %s)', (7317, rec.id))
            # Odoo reads in REPEATABLE READ: end the transaction that waited, so
            # what the other thread committed meanwhile is seen. (The lock is
            # per connection; it outlives the commit.)
            self.env.cr.commit()
            try:
                rec._chat_deliver_locked(Msg)
            finally:
                self.env.cr.execute('SELECT pg_advisory_unlock(%s, %s)', (7317, rec.id))

    def _chat_deliver_locked(self, Msg):
        """The pending messages of ONE task, oldest first, each read fresh
        (another thread may have sent it while this one waited)."""
        while True:
            self.env.invalidate_all()
            msg = Msg.search([('kpi_id', '=', self.id), ('delivery_state', '=', 'pending')],
                             order='id asc', limit=1)
            if not msg:
                return
            if msg.deleted_at:
                # Deleted before its note went out: nothing to tell anyone.
                msg.write({'delivery_state': 'sent', 'delivery_error': False})
                self.env.cr.commit()
                continue
            try:
                with self.env.cr.savepoint():
                    ok, why = (self._chat_deliver_team(msg) if msg.side == 'team'
                               else self._chat_deliver_client(msg))
            except Exception as exc:
                _logger.warning('chat delivery of message %s failed: %s', msg.id, exc)
                ok, why = False, str(exc).strip()[:200]
            if ok:
                msg.write({'delivery_state': 'sent', 'delivered_at': fields.Datetime.now(),
                           'delivery_error': False})
            else:
                msg.write({'delivery_state': 'failed',
                           'delivery_error': why or _("WhatsApp couldn't be reached.")})
            self.env.cr.commit()

    def _chat_deliver_team(self, msg):
        """The client group gets a LINK to the chat, not the message itself:
        they read it there and carry on the conversation on that page.
        Returns (posted, why-not)."""
        self.ensure_one()
        # The client has the chat open and is using it: they see it, no WhatsApp.
        if self._chat_client_live():
            return True, ''
        # One notice per burst: another team message they haven't seen yet
        # was already announced, and its link opens this one too.
        if self.env['kpi.chat.message'].sudo().search_count([
                ('kpi_id', '=', self.id), ('side', '=', 'team'), ('id', '!=', msg.id),
                ('seen_at', '=', False), ('deleted_at', '=', False), ('alerted_at', '!=', False)]):
            return True, ''
        Report = self.env['kpi.wa.group.report'].sudo()
        ref = self._chat_ref()
        askers = self._chat_askers()
        # Only real WhatsApp numbers are tagged; a name typed on the chat page
        # (or the company name) is not a person in the group.
        tags = ['@%s' % d for _n, d in askers if len(d) >= 11]
        posted = Report.post_for_kpi(self, _(
            '💬 %(who)sthe Alphalize team replied about *%(ref)s — %(title)s*.\n'
            'Open the chat to read it and reply (works for %(hours)d hours):\n%(link)s') % {
                'who': (', '.join(tags) + ' — ') if tags else '',
                'ref': ref, 'title': self.name or '', 'hours': CLIENT_CHAT_HOURS,
                'link': self._client_chat_link()},
            mentions=[d for _n, d in askers if len(d) >= 11])
        if not posted:
            return False, _("WhatsApp couldn't be reached — the client group was not told.")
        user = msg.author_user_id
        staff = self.env['kpi.wa.group']._staff_group()
        Report._post(_('✅ *%(ref)s* — %(who)s replied to the client.') % {
            'ref': ref, 'who': (user.name if user else '') or _('The team')}, jid=staff.jid or None)
        msg.write({'alerted_at': fields.Datetime.now()})
        return True, ''

    def _chat_deliver_client(self, msg):
        """The MANAGER decides first (their poll: reply, ask the developer,
        meeting, not now); the developer is told only when asked. One open
        question per task: further client messages join it instead of
        sending the manager a new poll each time."""
        self.ensure_one()
        body = msg.body or chat_files_label([chat_file_kind(f.file_name, f.mimetype) for f in msg.file_ids])
        Doubt = self.env['kpi.doubt'].sudo()
        doubt = Doubt.search([('kpi_id', '=', self.id), ('kind', '=', 'client_msg'),
                              ('state', '=', 'open')], limit=1)
        # Online team: they see it in the chat, no WhatsApp. Offline: one
        # poll per burst (an unseen, already-announced message covers the rest).
        quiet = self._chat_team_live() or bool(self.env['kpi.chat.message'].sudo().search_count([
            ('kpi_id', '=', self.id), ('side', '=', 'client'), ('id', '!=', msg.id),
            ('seen_at', '=', False), ('deleted_at', '=', False), ('alerted_at', '!=', False)]))
        # Who is asked first: a question about one task asks ITS developer in
        # our team group ("can you reply now?"); a general one, or a task with
        # no reachable developer, goes to the manager chain to pick someone.
        devs = self._chat_task_devs().filtered(
            lambda u: (u._kpi_wa_target() or '') and '@' not in u._kpi_wa_target())
        if doubt:
            doubt.write({'question': ('%s\n%s' % (doubt.question or '', body)).strip()[-2000:]})
            if not quiet:
                if doubt.assigned_dev_id:
                    pass                    # already being answered
                elif doubt.dev_asked_at and not doubt.esc_tier_id:
                    pass                    # the developer's Yes / No poll is still open
                else:
                    doubt._ask_the_manager()
        else:
            # raised_group_id stays empty on purpose: the doubt's team notices
            # go to the group it names, and this one must never be the client's.
            doubt = Doubt.with_context(kpi_doubt_no_ask=True).create({
                'kpi_id': self.id, 'kind': 'client_msg', 'question': body,
                'raised_by_id': False, 'raised_by_name': msg.author_name or ''})
            if not quiet:
                if not (devs and doubt._ask_the_developer(devs)):
                    doubt._ask_the_manager()
        msg.write({'doubt_id': doubt.id})
        if not quiet:
            # Announced (counts for "one alert per burst"); the 5-minute
            # re-check (_cron_chat_escalate) still runs if nobody looks.
            msg.write({'alerted_at': fields.Datetime.now()})
        return True, ''

    # ------------------------------------------------------------------
    # Escalation: a client message nobody on the team has on screen.
    # ------------------------------------------------------------------
    def _chat_team_live(self):
        """Someone on the team is online in this chat: open, on screen, touched
        in the last minute."""
        last = self.chat_team_live_at
        return bool(last) and (fields.Datetime.now() - last).total_seconds() <= TEAM_LIVE_SECONDS

    def _chat_client_live(self):
        last = self.chat_client_live_at
        return bool(last) and (fields.Datetime.now() - last).total_seconds() <= TEAM_LIVE_SECONDS

    # ------------------------------------------------------------------
    # The client's chat page opens only on a phone / laptop that proved once,
    # on WhatsApp, that it belongs to a person of this client.
    # ------------------------------------------------------------------
    def _chat_client_members(self):
        """Members of this task's client WhatsApp group who count as the client
        (not our staff)."""
        group = self.env['kpi.wa.group.report'].sudo()._group_for_kpi(self)
        if not group:
            return self.env['kpi.wa.group.member']
        return self.env['kpi.wa.group.member'].sudo().search([
            ('group_id', '=', group.id), ('member_kind', 'in', ('client', 'unknown'))])

    @staticmethod
    def _chat_digits(raw):
        return ''.join(ch for ch in (raw or '').split('@')[0] if ch.isdigit())

    def _chat_member_for(self, number):
        d = self._chat_digits(number)
        if not d:
            return self.env['kpi.wa.group.member']
        return self._chat_client_members().filtered(
            lambda mm: self._chat_digits(mm.phone) == d or self._chat_digits(mm.lid) == d)[:1]

    def chat_device_allowed(self, who):
        """May the browser `who` ('c:...') open this task's client chat?"""
        self.ensure_one()
        if not who:
            return False
        now = fields.Datetime.now()
        for dev in self.env['kpi.chat.device'].sudo().search(
                [('browser_id', '=', who), ('trusted_until', '>', now)]):
            if self._chat_member_for(dev.number):
                if (dev.trusted_until - now).days < DEVICE_TRUST_DAYS - 1:
                    dev.write({'trusted_until': now + timedelta(days=DEVICE_TRUST_DAYS)})
                return True
        return False

    def chat_device_start(self, who):
        """The confirm step for a new browser: the 4 letters it must send."""
        self.ensure_one()
        Dev = self.env['kpi.chat.device'].sudo()
        dev = Dev.search([('browser_id', '=', who), ('nonce', '!=', False)], limit=1)
        if not dev:
            nonce = ''.join(secrets.choice(CONFIRM_LETTERS) for _i in range(4))
            dev = Dev.create({'browser_id': who, 'nonce': nonce, 'kpi_id': self.id})
        elif dev.kpi_id != self:
            dev.write({'kpi_id': self.id})
        session = self.env['whatsapp.session'].sudo().search([('status', '=', 'connected')], limit=1)
        ours = self._chat_digits(session.phone_number) if session else ''
        text = 'CHAT %s %s' % (self._chat_ref().replace(' ', ''), dev.nonce)
        return {'nonce': dev.nonce, 'text': text, 'number': ours,
                'url': ('https://wa.me/%s?text=%s' % (ours, text.replace(' ', '%20'))) if ours else ''}

    @api.model
    def _chat_confirm_from_wa(self, phone, body):
        """A private WhatsApp "CHAT <ref> <nonce>": the sender's number proves the
        browser that showed those letters. Returns the reply to send, or None
        when the message is not a confirmation."""
        mt = CONFIRM_RE.match(body or '')
        if not mt:
            return None
        Dev = self.env['kpi.chat.device'].sudo()
        dev = Dev.search([('nonce', '=', mt.group(2).upper())], limit=1)
        task = dev.kpi_id if dev else None
        if not task:
            return _('That code is not known any more. Open the chat link again and tap "Confirm on WhatsApp".')
        member = task._chat_member_for(phone)
        client = task.client_kra_id.name or task.kra_id.name or _('this client')
        if not member:
            _logger.info('chat confirm refused: %s is not a client member for task %s', phone, task.id)
            return _('🔒 This chat is only for %(client)s and its developer on %(ref)s.') % {
                'client': client, 'ref': task._chat_ref()}
        dev.write({'number': member.phone or member.lid or phone, 'name': member.wa_name or '',
                   'kra_id': (member.group_id.kra_id or task.kra_id).id, 'nonce': False,
                   'trusted_until': fields.Datetime.now() + timedelta(days=DEVICE_TRUST_DAYS)})
        return _('✅ Done — go back to the chat page, it opens by itself. '
                 'This phone or computer will open %(client)s chats directly from now on.') % {'client': client}


    def _chat_nudge_team(self, msg, again=False):
        """Our team group: the client is waiting, @developer @manager, with the
        link. Each developer privately: the client's words and their own reply
        link. Never raises. True when anything reached anyone."""
        self.ensure_one()
        Report = self.env['kpi.wa.group.report'].sudo()
        ref = self._chat_ref()
        client = self.client_kra_id.name or self.kra_id.name or msg.author_name or _('The client')
        said = ' '.join((msg.body or chat_files_label(
            [chat_file_kind(f.file_name, f.mimetype) for f in msg.file_ids])).split())[:300]
        devs = (self.user_id | self.contributor_ids).filtered(lambda u: u.active and not u.share)
        managers = (msg.doubt_id.esc_asked_ids or msg.doubt_id.manager_user_id
                    or self._manager_users()[:1])
        people = devs | managers
        head = (_('⏰ *%(ref)s — %(title)s*: %(client)s is still waiting (%(min)d min, not seen yet)')
                if again else _('💬 *%(ref)s — %(title)s*: %(client)s asked')) % {
            'ref': ref, 'title': self.name or '', 'client': client, 'min': ESCALATE_AFTER_MIN}
        staff = self.env['kpi.wa.group']._staff_group()
        reached = False
        try:
            # Our group: who should answer and what about. No link here: the
            # group is shared, so the link goes to each of them privately.
            reached = bool(Report._post('%s %s\n"%s"\n\n%s' % (
                ' '.join(Report._mention(u) for u in people), head, said,
                _('A chat link was sent to you privately — reply to the client there.')),
                jid=staff.jid or None,
                mentions=[d for d in (Report._mention_digits(u) for u in people) if d]))
        except Exception as exc:
            _logger.warning('chat alert: team group post failed for %s: %s', self.id, exc)
        for dev in people:
            try:
                link = self._chat_page_link(dev) or self._staff_task_url()
                if Report.post_text_to_user(dev, '%s\n"%s"\n\n%s' % (
                        head, said, _('Reply here (only for you, 2 hours): %s') % link)):
                    reached = True
            except Exception as exc:
                _logger.warning('chat alert: private message to %s failed: %s', dev.id, exc)
        return reached

    @api.model
    def _cron_chat_escalate(self):
        """Every minute: client messages still unseen ESCALATE_AFTER_MIN after
        they came in are raised again, once, to the group and the developer.
        One per task per run (the oldest), so a burst is one reminder."""
        Msg = self.env['kpi.chat.message'].sudo()
        due = Msg.search([
            ('side', '=', 'client'), ('seen_at', '=', False), ('deleted_at', '=', False),
            ('escalated_at', '=', False),
            ('create_date', '<=', fields.Datetime.now() - timedelta(minutes=ESCALATE_AFTER_MIN)),
            # Not a backlog from before this existed: only the last day.
            ('create_date', '>=', fields.Datetime.now() - timedelta(days=1)),
        ], order='id asc', limit=200)
        done = set()
        for msg in due:
            task = msg.kpi_id
            if task.id in done:
                msg.write({'escalated_at': fields.Datetime.now()})
                continue
            done.add(task.id)
            if task._chat_team_live():
                continue   # someone just opened it; the next poll marks it seen
            try:
                with self.env.cr.savepoint():
                    task.sudo()._chat_nudge_team(msg, again=True)
            except Exception as exc:
                _logger.warning('chat escalation of message %s failed: %s', msg.id, exc)
            msg.write({'escalated_at': fields.Datetime.now()})
        return True

    def chat_waiting(self):
        """How many client messages have come in since the team last wrote."""
        self.ensure_one()
        n = 0
        for m in self.env['kpi.chat.message'].sudo().search(
                [('kpi_id', '=', self.id), ('deleted_at', '=', False)], order='id desc', limit=50):
            if m.side == 'team':
                break
            n += 1
        return n

    # ------------------------------------------------------------------
    def _chat_body_and_label(self, text, files):
        """(body to save, text for the poll / log / notes). Needs text or files."""
        body = (text or '').strip()[:CHAT_MAX]
        files = files or []
        if not body and not files:
            raise UserError(_('Write the message first.'))
        chat_check_files(files)
        label = chat_files_label([chat_file_kind(n, m) for n, _r, m in files])
        return body, ('%s\n%s' % (label, body) if body and label else body or label)

    def _chat_reply_to(self, reply_to):
        """The quoted message id, only when it is on this task's chat."""
        try:
            rid = int(reply_to or 0)
        except (TypeError, ValueError):
            return False
        q = self.env['kpi.chat.message'].sudo().browse(rid).exists() if rid else None
        return q.id if q and q.kpi_id == self else False

    def _chat_attach(self, msg, files):
        Att = self.env['kpi.file.attachment'].sudo()
        for seq, (name, raw, mime) in enumerate(files or []):
            Att.create({'chat_message_id': msg.id, 'file': base64.b64encode(raw),
                        'file_name': name or 'file', 'mimetype': mime or False,
                        'file_size': len(raw), 'sequence': seq})

    def chat_post_client(self, text, name='', number='', source='whatsapp', files=None, reply_to=None):
        """A client's message, from the WhatsApp Discuss flow or their chat page.
        files: [(name, bytes, mimetype)], the photos / videos / audio from the 📎."""
        self.ensure_one()
        saved, body = self._chat_body_and_label(text, files)
        Msg = self.env['kpi.chat.message'].sudo()
        msg = Msg.create({'kpi_id': self.id, 'side': 'client', 'body': saved,
                          'author_name': name or '', 'author_number': number or False,
                          'source': source, 'reply_to_id': self._chat_reply_to(reply_to),
                          'delivery_state': 'pending'})
        self._chat_attach(msg, files)
        self.sudo()._log_action('client_chat_message', source='whatsapp', actor_label=name or _('Client'),
                                payload={'message': msg.id, 'text': body})
        # The manager's poll (_chat_deliver_client) goes out once this
        # request commits, so the client's page answers at once.
        self._after_commit_in_background('_chat_deliver_pending')
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
        """The team chat page for this task (/kpi/team/chat, needs their login)."""
        return '%s/kpi/team/chat/%s' % (self._public_base(), self.id)

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
                [('kpi_id', '=', self.id), ('deleted_at', '=', False)], order='id desc', limit=50):
            if m.side == 'team':
                break
            key = m.author_number or m.author_name or ''
            if key not in seen:
                seen.add(key)
                out.append((m.author_name or '', m.author_number or ''))
        return list(reversed(out))

    def _chat_task_devs(self):
        """The developer(s) on this task (not the hidden general task)."""
        self.ensure_one()
        if self.is_chat_general:
            return self.env['res.users']
        return (self.user_id | self.contributor_ids).filtered(lambda u: u.active and not u.share)

    def chat_ask_developer(self, manager, devs=None, accepted=False):
        """The manager hands the client's question to the task's developer.

        The team group only gets an @mention -- no client wording -- and the
        question itself goes to the developer's private chat, where their
        reply is taken (kpi_manager_dm._continue_dev_reply) and posted to the
        client group as "our team". Returns (developers, unreachable)."""
        self.ensure_one()
        devs = devs or self.user_id.filtered('active') or self.contributor_ids.filtered('active')
        if not devs:
            raise UserError(_('Nobody is assigned to %s yet.') % self._chat_ref())
        # accepted: the developer said "Yes, I will reply" to the team-group
        # poll themselves (kpi_doubt._dev_poll_vote); `manager` is then them.
        ref = self._chat_ref()
        client = self.client_kra_id.name or self.kra_id.name or ''
        waiting = self.chat_waiting()
        said = '\n'.join('%s: "%s"' % (r['who'], r['text']) for r in self.chat_rows(limit=max(waiting, 1))
                         if r['side'] == 'client' and not r['deleted'])
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
            head = (_('💬 *%(ref)s — %(title)s* · %(client)s\nYou said you can reply now.\n\n%(said)s\n\n')
                    if accepted else
                    _('💬 *%(ref)s — %(title)s* · %(client)s\n%(mgr)s asks you to reply to the client.\n\n%(said)s\n\n'))
            sent = Report.post_text_to_user(dev, (head + _(
                'Type your reply here — the client gets it in their chat as "Alphalize team". '
                '(Type cancel to stop.)%(link)s')) % {
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
        if doubt:
            # Someone will reply: the chain stops climbing.
            doubt.write({'assigned_dev_id': devs[:1].id, 'esc_due_at': False})
        askers = self._chat_askers()
        # The client group: the person who asked, tagged, and their chat link.
        # Never the developer's name -- to the client it is "our team".
        tags = [('@%s' % d) if len(d) >= 11 else (n or _('there')) for n, d in askers] or [_('there')]
        Report.post_for_kpi(self, _(
            '💬 %(who)s — about *%(ref)s — %(title)s*: a member of the Alphalize team is joining '
            'your chat now.\n\nOpen the chat (works for %(hours)d hours):\n%(link)s') % {
                'who': ', '.join(tags), 'ref': ref, 'title': self.name or '',
                'hours': CLIENT_CHAT_HOURS, 'link': self._client_chat_link()},
            mentions=[d for _n, d in askers if len(d) >= 11])
        # Our group: which developer was picked, by whom, for whom -- with the link.
        staff = self.env['kpi.wa.group']._staff_group()
        where = (_('📩 The question and a reply link are in their private chat.') if reached else
                 _('Reply from 📋 KPI details → 💬 Reply to client.'))
        if not accepted:
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

    def chat_post_team(self, text, user, source='odoo', files=None, reply_to=None):
        """A team message: saved at once (✓), posted in the client group as
        "our team" after commit (_chat_deliver_team → ✓✓), and the manager's
        open question about it is closed. Callers check that `user` may write
        on this task. files as in chat_post_client."""
        self.ensure_one()
        saved, body = self._chat_body_and_label(text, files)
        Report = self.env['kpi.wa.group.report'].sudo()
        if not Report._group_for_kpi(self):
            raise UserError(_('This client has no WhatsApp group linked, so the message '
                              'could not be sent.'))
        msg = self.env['kpi.chat.message'].sudo().create({
            'kpi_id': self.id, 'side': 'team', 'body': saved,
            'author_user_id': user.id if user else False, 'source': source,
            'reply_to_id': self._chat_reply_to(reply_to),
            'delivery_state': 'pending'})
        self._chat_attach(msg, files)
        self.env['kpi.doubt'].sudo().search([
            ('kpi_id', '=', self.id), ('kind', '=', 'client_msg'), ('state', '=', 'open'),
        ]).write({'state': 'answered', 'answer': body,
                  'answered_by_id': user.id if user else False,
                  'answered_at': fields.Datetime.now()})
        self.sudo()._log_action('client_chat_reply', source='whatsapp' if source in ('whatsapp', 'wa_page') else 'web',
                                actor_user_id=user.id if user else None,
                                payload={'message': msg.id, 'text': body})
        self._after_commit_in_background('_chat_deliver_pending')
        return msg
