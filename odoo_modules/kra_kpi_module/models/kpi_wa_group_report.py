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

from odoo import fields, models

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

    def _post(self, text):
        """True if it went out. Never raises."""
        jid = self._group_jid()
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

    def post_workday_end(self, user, when_label, worked_seconds,
                         tasks_touched=0, tasks_completed=None, note=''):
        if not self._group_jid():
            return False
        time_s, date_s = self._clock()
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
        text = self._render_event('workday_end', {
            'dev': self._mention(user),
            'time': time_s,
            'date': date_s,
            'hours': self._hm(worked_seconds),
            'tasks': tasks_phrase,
            'note': (note or '').strip()[:400],
        })
        return self._post(text) if text else False
