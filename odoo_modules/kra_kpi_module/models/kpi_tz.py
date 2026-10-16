"""One timezone formatter that actually prints the timezone.

WHY THIS EXISTS
---------------
The module had three date formatters and none of them said which zone it was
showing:

* `convert_to_user_tz` (controllers/kra_api.py) -> '2026-10-16 19:42'
* `_fmt_ist`           (models/kpi_notify.py)   -> '16/10 19:42', Kolkata pinned
* `_local_now`         (models/kpi_wa_group_intake.py) -> ('Fri 16 Oct 2026',
                                                          '7:42 PM')

That is fine for a reminder somebody reads in the next minute, and not fine for
a record that has to settle an argument months later. The groups span India and
Oman, so '19:42' without a zone is ambiguous by an hour and a half, and a
disconnect receipt or a task log is exactly the kind of evidence where that
matters.

The three existing helpers are deliberately LEFT ALONE: they are called from
every screen in the module and rewriting them all at once to gain a suffix
would be a large change with no new capability. New surfaces use this one.

PRECEDENCE
----------
Follows `_local_now`'s, which is the most careful of the three: the company's
own timezone first, then the acting user's, then Asia/Kolkata as a last resort.
Never raises -- a formatter that throws is worse than one that falls back,
because it takes down whatever was being recorded.
"""

import logging

from odoo import fields, models

_logger = logging.getLogger(__name__)

FALLBACK_TZ = 'Asia/Kolkata'


class KpiTz(models.AbstractModel):
    _name = 'kpi.tz'
    _description = 'Timezone-aware formatting'

    def tz_name(self, tz=None):
        """The zone to render in. Explicit > company > user > Kolkata."""
        if tz:
            return tz
        try:
            return (self.env.company.partner_id.tz
                    or self.env.user.tz
                    or FALLBACK_TZ)
        except Exception:                 # pragma: no cover - defensive
            return FALLBACK_TZ

    def to_local(self, dt, tz=None):
        """A naive UTC datetime -> an aware datetime in `tz`, or None."""
        if not dt:
            return None
        try:
            import pytz
            if isinstance(dt, str):
                dt = fields.Datetime.from_string(dt)
            name = self.tz_name(tz)
            return pytz.utc.localize(dt).astimezone(pytz.timezone(name))
        except Exception as exc:
            _logger.debug('kpi.tz: could not localise %r (%s)', dt, exc)
            return None

    def fmt(self, dt, tz=None, with_zone=True):
        """'16 Oct 2026 19:42 (+04:00 Asia/Muscat)'.

        Falls back to the stored UTC value marked as such, so a log line is
        never blank and never silently claims local time it could not compute.
        """
        if not dt:
            return ''
        local = self.to_local(dt, tz)
        if local is None:
            return '%s UTC' % fields.Datetime.to_string(dt)
        stamp = local.strftime('%d %b %Y %H:%M')
        if not with_zone:
            return stamp
        # %z gives '+0400'; the colon form is what people recognise from
        # timestamps elsewhere, and the zone NAME is what removes the
        # remaining ambiguity about which +04:00 this is.
        offset = local.strftime('%z')
        if len(offset) == 5:
            offset = '%s:%s' % (offset[:3], offset[3:])
        return '%s (%s %s)' % (stamp, offset, self.tz_name(tz))

    def fmt_now(self, tz=None):
        """The same string, for right now."""
        return self.fmt(fields.Datetime.now(), tz=tz)
