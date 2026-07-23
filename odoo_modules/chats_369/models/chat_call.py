"""chat.call — call history, and chat.call.schedule — upcoming scheduled calls.

`chat.call` logs each 1:1 call once (created by the caller side) so both parties
see it in their WhatsApp-style Calls tab with the right direction + missed flag.
`chat.call.schedule` is a planned call the organizer sets for a future time; the
Calls tab lists upcoming ones and the client reminds when they're due. A cron
clears old logs/schedules so the tables stay small.
"""

from datetime import timedelta

from odoo import api, fields, models


class ChatCall(models.Model):
    _name = 'chat.call'
    _description = '369Chats Call Log'
    _order = 'started_at desc, id desc'

    conversation_id = fields.Many2one('chat.conversation', string='Conversation', ondelete='cascade', index=True)
    caller_id = fields.Many2one('res.users', string='Caller', ondelete='cascade', index=True)
    callee_id = fields.Many2one('res.users', string='Callee', ondelete='cascade', index=True)
    video = fields.Boolean(string='Video', default=False)
    status = fields.Selection([('answered', 'Answered'), ('missed', 'Missed')],
                              string='Status', default='answered')
    started_at = fields.Datetime(string='Started At', default=fields.Datetime.now, index=True)
    duration = fields.Integer(string='Duration (s)', default=0)

    @api.model
    def _gc_calls(self):
        """Cron: keep the call log to the last 60 days."""
        cutoff = fields.Datetime.now() - timedelta(days=60)
        old = self.sudo().search([('started_at', '<', cutoff)])
        if old:
            old.unlink()


class ChatCallSchedule(models.Model):
    _name = 'chat.call.schedule'
    _description = '369Chats Scheduled Call'
    _order = 'scheduled_at asc, id asc'

    title = fields.Char(string='Title', required=True)
    scheduled_at = fields.Datetime(string='Scheduled At', required=True, index=True)
    organizer_id = fields.Many2one('res.users', string='Organizer', ondelete='cascade', index=True)
    conversation_id = fields.Many2one('chat.conversation', string='Conversation', ondelete='set null')
    invitee_ids = fields.Many2many('res.users', 'chat_call_sched_user_rel', 'sched_id', 'user_id',
                                   string='Invitees')
    video = fields.Boolean(string='Video', default=False)

    @api.model
    def _gc_schedules(self):
        """Cron: drop scheduled calls more than a day past their time."""
        cutoff = fields.Datetime.now() - timedelta(days=1)
        old = self.sudo().search([('scheduled_at', '<', cutoff)])
        if old:
            old.unlink()
