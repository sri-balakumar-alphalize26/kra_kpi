"""Post workday end (and task events) to a WhatsApp group.

The start of the day is no longer posted from here: hr_attendance_369_whatsapp
posts "@Name present 9:30" when the attendance check-in is created.

A group report is a SIDE EFFECT of starting or ending a day, never a condition of
it: every failure here is swallowed and logged. Ending a workday is one-way, and
nobody should be unable to close their day because a group is unreachable.

Mentions are free — neonize's send_message turns any "@<5-16 digits>" in the text
into a real tap-able mention. The catch is the country code: a bare 10-digit
number parses but resolves to a JID that does not exist, so it renders as plain
text instead of naming the person. _mention() therefore only produces a mention
when it is confident the number is in international form, and falls back to the
person's name otherwise rather than printing a broken @12345.
"""

import logging

from odoo import _, api, fields, models

_logger = logging.getLogger(__name__)

# Shortest plausible international number (country code + subscriber). Below this
# it is almost certainly a local-format number that would not resolve.
_MIN_INTL_DIGITS = 11


class KpiWaGroupReport(models.AbstractModel):
    _name = 'kpi.wa.group.report'
    _description = 'Workday reports posted to a WhatsApp group'

    # ---- plumbing ----------------------------------------------------------- #

    def _group_jid(self):
        return (self.env.company.kpi_wa_group_jid or '').strip()

    def _session(self):
        return self.env['whatsapp.session'].sudo().search(
            [('status', '=', 'connected')], limit=1)

    @staticmethod
    def _digits(raw):
        return ''.join(ch for ch in (raw or '') if ch.isdigit())

    def _mention(self, user):
        """"@919876543210" when the number can actually resolve, else the name.

        A mention that does not resolve renders as literal text — "@1234567890"
        sitting in the message — which is worse than simply writing the name.
        """
        num = self._digits(user.kpi_wa_number
                           or (user.partner_id.phone if user.partner_id else ''))
        if len(num) >= _MIN_INTL_DIGITS:
            return '@%s' % num
        return user.name or user.login or 'Someone'

    def _post(self, text, jid=None):
        """True if it went out. Never raises.

        `jid` lets a caller name the destination; without it the message goes to
        the single company-wide group (`res.company.kpi_wa_group_jid`), which is
        what every workday report wants.
        """
        jid = (jid or self._group_jid() or '').strip()
        if not jid:
            return False
        session = self._session()
        if not session:
            _logger.info("wa group report skipped: no connected session")
            return False
        try:
            return bool(session.send_message(jid, text))
        except Exception as e:
            _logger.error("wa group report failed: %s", e)
            return False

    # ---- tappable menus sent somewhere we choose ---------------------------- #
    #
    # The router's own _poll (kpi_wa_group_intake.py) can only reply into the
    # group a message arrived from -- it takes the inbound `message` and reuses
    # message.phone. That is right for a conversation and useless for the two
    # things this feature needs: pushing an approval to a manager who has not
    # said anything, and posting a question into the internal group from code
    # that has no inbound message at all.
    #
    # These live here, beside _post, because this abstract model is already the
    # module's single "send to a named destination" entry point: it owns
    # _session() and the never-raise discipline, and needs no whatsapp.message.

    def _post_poll(self, target, question, options):
        """Send a tappable poll to a group JID or a bare number. Never raises.

        send_poll normalizes either shape (whatsapp_session.py -> wa_jid), and
        falls back to a numbered text message by itself when Evolution refuses
        the poll, so a failure here degrades rather than disappears.
        """
        target = (target or '').strip()
        if not target or not options:
            return False
        session = self._session()
        if not session:
            _logger.info('wa poll skipped: no connected session')
            return False
        try:
            return bool(session.send_poll(target, question, list(options)))
        except Exception as exc:
            _logger.error('wa poll to %s failed: %s', target, exc)
            return False

    # Every post_* below is @api.private. This is an AbstractModel with no ACL,
    # so a public method here is callable by ANY signed-in user over call_kw --
    # post_poll(question, options, jid) let a developer put any text into any
    # group, a client's included, which is the one thing this design forbids.
    # Python callers are unaffected; only RPC is refused.
    @api.private
    def post_poll(self, question, options, jid=None):
        """Poll into a named group, or the company-wide one."""
        return self._post_poll(jid or self._group_jid(), question, options)

    @api.private
    def post_poll_to_user(self, user, question, options):
        """Poll privately to one person. False when they cannot be reached.

        Returning False rather than silently doing nothing is the whole point:
        the caller has just written a decision that now needs a human, and it
        has to be able to fall back to another channel. A send that reports
        success to a number nobody owns is how an approval disappears.

        REFUSES A GROUP JID. A manager's "number" that ends @g.us means a
        misconfiguration, and sending there would put a private approval --
        with the client's own wording in it -- in front of whoever is in that
        group. That is the one failure this whole design exists to prevent, so
        it is blocked here rather than trusted to every caller.
        """
        if not user:
            return False
        digits = user._kpi_wa_target()
        if not digits:
            _logger.info('no WhatsApp number for %s -- nothing sent',
                         user.login)
            return False
        if '@g.us' in digits or '@' in digits:
            _logger.error(
                'refusing to send a private message to %r for %s: that is a '
                'group, not a person.', digits, user.login)
            return False
        return self._post_poll(digits, question, options)

    @api.private
    def post_poll_for_kpi(self, kpi, question, options):
        """A tappable menu in THIS task's client group. False if we cannot.

        The decline message used to be plain text ending "reply 1 if that is
        OK, 2 if you disagree", purely because this file had no poll path --
        every other question the bot asks is a tap. Clients had no reason to
        know that one message was different, and a typed digit is exactly the
        step where people reply with a sentence instead.

        Resolution goes through _group_for_kpi, which walks up the KRA tree
        and returns nothing rather than falling back to the company group --
        so a task whose client cannot be identified stays unasked instead of
        being broadcast to the wrong people.
        """
        group = self._group_for_kpi(kpi)
        if not group:
            _logger.info('no client group for %s -- poll not sent',
                         kpi.external_ref or kpi.id)
            return False
        return self._post_poll(group.jid, question, options)

    @api.private
    def post_text_to_user(self, user, text):
        """The same contract, for a line that needs no answer."""
        if not user:
            return False
        digits = user._kpi_wa_target()
        if not digits or '@' in digits:
            return False
        session = self._session()
        if not session:
            return False
        try:
            return bool(session.send_message(digits, text))
        except Exception as exc:
            _logger.error('wa dm to %s failed: %s', user.login, exc)
            return False

    # ---- posting about ONE task, to ITS client's group ---------------------- #

    def _group_for_kpi(self, kpi):
        """The WhatsApp group that belongs to this task's client, or False.

        Until now a group message could only ever go to ONE destination: the
        company-wide `res.company.kpi_wa_group_jid`. That is right for a workday
        report, and wrong for anything about a specific client's task -- telling
        client A's group that client B's ticket was declined is a real leak, and
        it is exactly the mistake the kpi.wa.group model's own docstring warns
        about ("a client group got mistaken for the dev group and posted to").

        Resolution walks UP the KRA tree, because a task hangs off a sub-client
        (a shop) while the group is linked to the client (the reseller):

            task.kra_id -> ... -> the kra.master a kpi.wa.group points at

        Returns an empty recordset when the task's client has no group. Silence
        is the correct outcome there -- never fall back to the company group,
        which would post a named client's business into whatever group happens
        to be configured.
        """
        Group = self.env['kpi.wa.group'].sudo()
        if not kpi:
            return Group
        seen = set()
        node = kpi.kra_id
        while node and node.id not in seen:
            seen.add(node.id)
            grp = Group.search([('kra_id', '=', node.id),
                                ('active', '=', True)], limit=1)
            if grp:
                return grp
            node = node.parent_id
        # Last resort: the task's computed client KRA, in case the chain above
        # was broken by an archived intermediate node.
        if kpi.client_kra_id and kpi.client_kra_id.id not in seen:
            return Group.search([('kra_id', '=', kpi.client_kra_id.id),
                                 ('active', '=', True)], limit=1)
        return Group

    @api.private
    def post_for_kpi(self, kpi, text):
        """Post `text` into the group belonging to `kpi`'s client.

        Returns True only if it actually went somewhere, so callers can tell the
        admin "the client was told" versus "no group is linked".
        """
        grp = self._group_for_kpi(kpi)
        if not grp:
            _logger.info("No WhatsApp group linked to the client of %s (%s)",
                         kpi.external_ref or kpi.id,
                         kpi.client_kra_id.name or kpi.kra_id.name or '-')
            return False
        return self._post(text, jid=grp.jid)

    # ---- the reports -------------------------------------------------------- #

    @staticmethod
    def _hm(seconds):
        m = int((seconds or 0) // 60)
        return '%dh %02dm' % (m // 60, m % 60)

    def _clock(self):
        """('09:02 AM', 'Mon 17 Aug') for right now, in the reader's timezone.

        Derived here rather than split out of the caller's `when_label`: that
        label arrives already formatted ('%I:%M %p · %a %d %b'), and splitting it
        on '·' would break silently the first time anyone edits that format. The
        post happens in the same instant as the caller's stamp, so these agree.
        """
        local = fields.Datetime.context_timestamp(self, fields.Datetime.now())
        return local.strftime('%I:%M %p'), local.strftime('%a %d %b')

    def _render_event(self, event, values):
        """Render one configured event, or '' when it is switched off."""
        Event = self.env['kpi.wa.group.event'].sudo()
        row = Event._row(event)
        if not row or not row.enabled:
            return ''
        return Event.render(row.effective_template(), values)

    # There is no post_workday_start: the start of the day is posted by
    # hr_attendance_369_whatsapp as "@Name present 9:30" when the attendance
    # check-in is created.

    @api.private
    def send_private(self, user, text):
        """Text to a person's own WhatsApp number (their login mobile). Never raises."""
        number = ''.join(ch for ch in (user.kpi_wa_number or '') if ch.isdigit())
        session = self._session()
        if not number or not session or not text:
            _logger.info("private message to %s skipped (number=%s, session=%s)",
                         user.login, bool(number), bool(session))
            return False
        try:
            return bool(session.send_message(number, text))
        except Exception as e:
            _logger.error("private message to %s failed: %s", user.login, e)
            return False

    def post_workday_reopened(self, user, admin, reason=''):
        """The developer hears, privately, that their ended day was reopened."""
        return self.send_private(user, _(
            "🔁 *Workday reopened*\n%(admin)s reopened your workday for today.%(why)s\n\n"
            "Your timer is NOT running — press Start on the board, or send *hi* in the "
            "group and tap 🌅 Start my day, when you are back.") % {
                'admin': admin.name or admin.login or _('An admin'),
                'why': ('\nReason: %s' % reason.strip()) if (reason or '').strip() else ''})

    def post_workday_end(self, user, when_label, worked_seconds,
                         tasks_touched=0, tasks_completed=None, note='',
                         snapshot=None):
        """The end-of-day message and the day's Workday Snapshot image, sent
        PRIVATELY to the developer's own WhatsApp number and to every admin's
        (Owner / Coordinator / System) -- not to the group. Called once, from
        action_end_day, i.e. only when the developer ends the day themself.
        """
        def digits(u):
            return ''.join(ch for ch in (u.kpi_wa_number or '') if ch.isdigit())
        own = digits(user)
        if not own:
            _logger.info("workday end: %s has no WhatsApp number", user.login)
        # Admins as kra.kpi._user_is_kpi_admin defines them, each on their own
        # login-mobile WhatsApp. The developer never gets two copies.
        admins = self.env['res.users'].sudo().search([
            ('active', '=', True), ('share', '=', False), ('id', '!=', user.id)])
        Kpi = self.env['kra.kpi'].sudo()
        targets = [own] if own else []
        for a in admins:
            n = digits(a)
            if n and n not in targets and Kpi._user_is_kpi_admin(a):
                targets.append(n)
        if not targets:
            return False
        # In the developer's timezone: this message is theirs now.
        from .kpi_wa_staff_task import kpi_tz_name
        time_s, date_s = self.with_context(tz=kpi_tz_name(self.env, user))._clock()
        # {tasks} is the whole phrase, not a bare count, so that a day with
        # nothing recorded leaves an empty token and the line disappears — the
        # behaviour this had before it was templated. "0 task(s) touched" reads
        # as a bad day rather than as a day nobody logged anything for, and
        # "completed" is still only shown when it is actually known.
        tasks_phrase = ''
        if tasks_touched:
            tasks_phrase = "%d task(s) touched" % tasks_touched
            if tasks_completed is not None:
                tasks_phrase += " · %d completed" % tasks_completed
        # The person's name, not an @mention: a mention means nothing in a
        # private chat.
        text = self._render_event('workday_end', {
            'dev': user.name or user.login or '',
            'time': time_s,
            'date': date_s,
            'hours': self._hm(worked_seconds),
            'tasks': tasks_phrase,
            'note': (note or '').strip()[:400],
        }) or ("🌙 %s ended the workday at %s · %s\nWorked %s%s" % (
            user.name or '', time_s, date_s, self._hm(worked_seconds),
            ('\n' + tasks_phrase) if tasks_phrase else ''))
        session = self._session()
        if not session:
            _logger.info("workday end: no connected WhatsApp session")
            return False
        # The frozen snapshot image with the message as its caption; the plain
        # message when there is no image or the image send fails. Each number
        # on its own, so one bad number never stops the rest.
        img = None
        if snapshot and snapshot.image:
            img = snapshot.image
            img = img.decode('ascii') if isinstance(img, bytes) else img
        sent = False
        for number in targets:
            try:
                if img and session.send_image(number, img, caption=text):
                    sent = True
                    continue
            except Exception as e:
                _logger.warning("workday snapshot send to %s failed: %s", number, e)
            try:
                sent = bool(session.send_message(number, text)) or sent
            except Exception as e:
                _logger.error("workday end message to %s failed: %s", number, e)
        return sent
