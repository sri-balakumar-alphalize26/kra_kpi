"""Which updates get posted to the WhatsApp group, and in what words.

One row per event per company: a switch and an editable message. The wording is
the admin's, not ours — so nothing here may assume a template still contains a
particular token, or any token at all.

Why a registry rather than a column per event
---------------------------------------------
Adding "also post when a task is reassigned" should be one dict entry, not a
schema change plus a migration. Rows are created on demand from WA_GROUP_EVENTS,
so an event that has never been touched costs nothing and a new one appears by
itself.

Empty template == use the default, exactly like res.company.kpi_otp_message_template
(res_company_kpi.py). That single convention is what makes "Reset to default" a
one-liner that stores '' rather than a copy of the default text, which would go
stale the moment the default changed.

Everything new is seeded OFF. Turning task-level reporting on for a team of nine
is hundreds of messages a day into a group, and that has to be a decision
somebody makes on purpose.
"""

import logging

from odoo import api, fields, models

_logger = logging.getLogger(__name__)

# Order here is the order shown on the settings screen.
#
# `wa_event` is the key kpi_notify._notify() dispatches on, when there is one.
# The workday entry has none: it is posted from kpi_work_session via
# kpi.wa.group.report, not through the task notification pipeline.
#
# There is no workday_start entry: the start of the day is posted by
# hr_attendance_369_whatsapp ("@Name present 9:30") when the check-in is
# created. An old workday_start row left in the database is never listed,
# because _rows() walks this list, and _row() refuses the unknown key.
WA_GROUP_EVENTS = [
    {
        'key': 'workday_end',
        'label': 'Workday ended',
        'help': 'When a developer presses End Workday.',
        'default_enabled': True,
        'tokens': ['dev', 'time', 'date', 'hours', 'tasks', 'note'],
        'default': ("🔴 *Workday ended*\n{dev}\n{time} · {date} · {hours} logged\n"
                    "{tasks}\n📝 \"{note}\""),
    },
    {
        'key': 'complete',
        'label': 'Task completed',
        'help': 'When a developer marks a task complete.',
        'default_enabled': False,
        'tokens': ['dev', 'title', 'ref', 'client', 'project', 'elapsed'],
        'default': "✅ *Task completed*\n{title} ({ref})\n{dev} · {elapsed}",
    },
    {
        'key': 'final_approved',
        'label': 'Task signed off',
        'help': 'When a completed task is finally approved.',
        'default_enabled': False,
        'tokens': ['dev', 'title', 'ref', 'client', 'project'],
        'default': "🏁 *Signed off*\n{title} ({ref})\n{client}",
    },
    {
        'key': 'start',
        'label': 'Task started',
        'help': 'When a developer starts working on a task.',
        'default_enabled': False,
        'tokens': ['dev', 'title', 'ref', 'client', 'project', 'priority', 'deadline'],
        'default': "▶️ *Task started*\n{title} ({ref})\n{dev}",
    },
    {
        'key': 'pause',
        'label': 'Task paused',
        'help': 'When a developer pauses a task.',
        'default_enabled': False,
        'tokens': ['dev', 'title', 'ref', 'elapsed', 'pause_reason'],
        'default': "⏸ *Task paused*\n{title} ({ref})\n{dev} · {pause_reason}",
    },
    {
        'key': 'resume',
        'label': 'Task resumed',
        'help': 'When a developer resumes a paused task.',
        'default_enabled': False,
        'tokens': ['dev', 'title', 'ref', 'elapsed'],
        'default': "⏵ *Task resumed*\n{title} ({ref})\n{dev}",
    },
]

WA_GROUP_EVENTS_BY_KEY = {e['key']: e for e in WA_GROUP_EVENTS}

# Posted from the workday hook rather than from _notify(). The task pipeline
# must NOT also post it: workday_end already has its own call from
# kpi_work_session, and hooking it in both places is a double post.
WORKDAY_EVENT_KEYS = ('workday_end',)

# Sample values for the settings-screen preview. Deliberately obvious fakes —
# a preview that looks like real data invites someone to read it as real data.
PREVIEW_SAMPLES = {
    'dev': 'Ramesh',
    'time': '09:02 AM',
    'date': 'Mon 17 Aug',
    'hours': '8h 30m',
    'tasks': '5 task(s) touched · 3 completed',
    'note': 'finished the invoice screen',
    'title': 'Fix the invoice PDF',
    'ref': '#1042',
    'client': 'Keerthana Silks',
    'project': 'Billing',
    'priority': 'Regular',
    'deadline': '20 Aug 2026',
    'elapsed': '2h 15m',
    'pause_reason': 'Waiting on client',
    'now': '09:02 AM',
}


class KpiWaGroupEvent(models.Model):
    _name = 'kpi.wa.group.event'
    _description = 'WhatsApp group report — per-event switch and wording'
    _order = 'sequence, id'

    company_id = fields.Many2one(
        'res.company', required=True, ondelete='cascade', index=True,
        default=lambda self: self.env.company)
    event = fields.Char(required=True, index=True)
    sequence = fields.Integer(default=10)
    enabled = fields.Boolean(default=False)
    # No `default=` on purpose: empty means "use the built-in default", the same
    # convention as kpi_otp_message_template. Storing a copy of the default here
    # would freeze it at today's wording.
    template = fields.Text(
        help="Your wording for this message. Leave empty to use the built-in default.")

    _sql_constraints = [
        ('event_company_uniq', 'unique(event, company_id)',
         'This event is already configured for this company.'),
    ]

    # ---- registry plumbing -------------------------------------------------- #

    @property
    def _spec(self):
        return WA_GROUP_EVENTS_BY_KEY.get(self.event or '', {})

    def effective_template(self):
        """The admin's wording, or the built-in default when they have not set one."""
        self.ensure_one()
        return self.template or self._spec.get('default', '')

    @api.model
    def _rows(self, company=None):
        """Every configured event for `company`, creating any that are missing.

        Created lazily rather than by a data file so that adding an entry to
        WA_GROUP_EVENTS is genuinely the only step.
        """
        company = company or self.env.company
        existing = {r.event: r for r in self.sudo().search(
            [('company_id', '=', company.id)])}
        out = []
        for idx, spec in enumerate(WA_GROUP_EVENTS):
            row = existing.get(spec['key'])
            if not row:
                row = self.sudo().create({
                    'company_id': company.id,
                    'event': spec['key'],
                    'sequence': idx * 10,
                    'enabled': spec['default_enabled'],
                })
            out.append(row)
        return out

    @api.model
    def _row(self, event, company=None):
        """One event's row, or an empty recordset for an unknown key."""
        if event not in WA_GROUP_EVENTS_BY_KEY:
            return self.browse()
        company = company or self.env.company
        row = self.sudo().search(
            [('company_id', '=', company.id), ('event', '=', event)], limit=1)
        if not row:
            spec = WA_GROUP_EVENTS_BY_KEY[event]
            row = self.sudo().create({
                'company_id': company.id,
                'event': event,
                'sequence': WA_GROUP_EVENTS.index(spec) * 10,
                'enabled': spec['default_enabled'],
            })
        return row

    @api.model
    def is_enabled(self, event, company=None):
        row = self._row(event, company=company)
        return bool(row and row.enabled)

    # ---- rendering ---------------------------------------------------------- #

    @staticmethod
    def render(template, values):
        """Substitute {tokens} and drop lines that ended up saying nothing.

        str.replace, never str.format: these templates are written by hand and
        contain emoji, quotes and sometimes a stray brace, all of which make
        format() raise. A group report is a side effect of finishing a workday,
        and finishing a workday is one-way — a typo in a message must not be able
        to block it. Unknown {tokens} are left as literal text: visible, harmless
        and self-explaining.

        A line whose tokens ALL resolved to empty is dropped entirely, including
        whatever decoration sat around them. Without this an empty note renders
        as a bare 📝 "" and a day with no tasks as "0 task(s) touched" — which
        reads as a bad day rather than as a day nobody recorded anything for.

        The test is on the TOKENS, not on how the finished line looks: emoji,
        quotes and separators are decoration for a value that is not there, so
        `📝 "{note}"` and `{tasks} task(s) touched` both disappear when their
        token is empty. Trying to judge it from the rendered text instead means
        guessing which characters count as content, and an emoji is enough to
        defeat that. Lines with no tokens at all are always kept, so headers and
        fixed text survive.
        """
        out = []
        for line in (template or '').split('\n'):
            filled, resolved = line, []
            for key, val in (values or {}).items():
                token = '{%s}' % key
                if token in filled:
                    val = '' if val is None else str(val)
                    resolved.append(val.strip())
                    filled = filled.replace(token, val)
            if resolved and not any(resolved):
                continue
            out.append(filled)
        # Collapse the runs of blank lines that dropping can leave behind.
        text, prev_blank = [], False
        for line in out:
            blank = not line.strip()
            if blank and prev_blank:
                continue
            text.append(line)
            prev_blank = blank
        return '\n'.join(text).strip()

    def render_preview(self):
        """The message as it would look, using the obvious-fake sample values."""
        self.ensure_one()
        return self.render(self.effective_template(), PREVIEW_SAMPLES)
