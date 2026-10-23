"""Human-sounding acknowledgments for clients on WhatsApp.

From the call notes (Oct 2026): the bot must not reply like a template.
Every receipt / "work started" message opens with a line picked at random
from a pool, never the same line twice in a row, is signed with the team
name, and goes out 10-30 s after the event instead of instantly (see
kpi.notification.queue.enqueue_delayed).

The team name is an ICP so it can change without a release:
    kra_kpi.wa_team_name   (default "Alphalize Technologies")
"""

import random

from odoo import api, models

PARAM_TEAM = 'kra_kpi.wa_team_name'
DEFAULT_TEAM = 'Alphalize Technologies'
PARAM_LAST = 'kra_kpi.wa_ack_last.%s'

# A request (requirement / bug / update / new DB / destroy) was received.
RECEIVED = [
    "Got it, thanks 👍",
    "Thanks! We've received this and will look at it shortly.",
    "Noted — the team has it now.",
    "Received, thank you. We'll review it and get back to you.",
    "Thanks for sending this over. We're on it.",
    "All received 👍 We'll check the details and come back to you.",
    "Thank you! This is with the team now.",
    "Got your request. We'll go through it shortly.",
    "Thanks, noted. Someone from the team will review it soon.",
    "Received with thanks. We'll update you once it's reviewed.",
    "Okay, got it! We'll take a look and let you know.",
    "Thanks — logged it for the team.",
    "Appreciate it! We'll review this shortly.",
    "Noted with thanks 🙏 We'll get back to you soon.",
    "Thanks, we have it. Our team will check it shortly.",
]

# The developer started working on the client's task.
STARTED = [
    "Work has started on this. We'll deliver as soon as possible.",
    "Quick update: we've started on it 👍",
    "Good news — the team has started working on this.",
    "We're working on it now. We'll keep you posted.",
    "Started on this today. We'll share an update soon.",
    "This is in progress now. We'll deliver as soon as we can.",
    "Our developer has picked this up and started.",
    "Work is underway. We'll let you know once it's ready.",
    "We've begun on this. Thanks for your patience!",
    "Started 👍 We'll get it to you as soon as possible.",
]

POOLS = {'received': RECEIVED, 'started': STARTED}


class KpiWaAck(models.AbstractModel):
    _name = 'kpi.wa.ack'
    _description = 'KRA/KPI human-style WhatsApp acknowledgments'

    @api.model
    def team_name(self):
        return (self.env['ir.config_parameter'].sudo().get_param(PARAM_TEAM)
                or DEFAULT_TEAM).strip()

    @api.model
    def pick(self, pool='received'):
        """A random line from the pool, never the one used last time."""
        lines = POOLS.get(pool) or RECEIVED
        ICP = self.env['ir.config_parameter'].sudo()
        key = PARAM_LAST % pool
        try:
            last = int(ICP.get_param(key) or -1)
        except ValueError:
            last = -1
        choices = [i for i in range(len(lines)) if i != last] or [0]
        idx = random.choice(choices)
        ICP.set_param(key, str(idx))
        return lines[idx]

    @api.model
    def signature(self):
        return '— %s' % self.team_name()

    @api.model
    def wrap(self, details='', pool='received'):
        """Opening line, the request details (if any), then the team name."""
        parts = [self.pick(pool)]
        if details:
            parts.append(details.strip())
        parts.append('_%s_' % self.signature())
        return '\n\n'.join(parts)

    @api.model
    def delay_seconds(self):
        return random.randint(10, 30)
