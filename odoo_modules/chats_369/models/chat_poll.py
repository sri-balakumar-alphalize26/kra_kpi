"""chat.poll — a WhatsApp-style poll attached to a poll message.

A poll message (chat.message with kind='poll') owns one chat.poll, which has a
question and 2+ options; each chat.poll.vote is one user's vote on one option.
Single-choice polls keep one vote per user (voting again moves it); multi polls
allow several. Tallies are computed live in the controller for serialization.
"""

from odoo import fields, models


class ChatPoll(models.Model):
    _name = 'chat.poll'
    _description = '369Chats Poll'

    message_id = fields.Many2one(
        'chat.message', string='Message', required=True,
        ondelete='cascade', index=True)
    question = fields.Char(string='Question', required=True)
    multi = fields.Boolean(string='Allow Multiple Answers', default=False)
    option_ids = fields.One2many('chat.poll.option', 'poll_id', string='Options')


class ChatPollOption(models.Model):
    _name = 'chat.poll.option'
    _description = '369Chats Poll Option'
    _order = 'sequence, id'

    poll_id = fields.Many2one(
        'chat.poll', string='Poll', required=True,
        ondelete='cascade', index=True)
    text = fields.Char(string='Option', required=True)
    sequence = fields.Integer(string='Sequence', default=10)
    vote_ids = fields.One2many('chat.poll.vote', 'option_id', string='Votes')


class ChatPollVote(models.Model):
    _name = 'chat.poll.vote'
    _description = '369Chats Poll Vote'

    option_id = fields.Many2one(
        'chat.poll.option', string='Option', required=True,
        ondelete='cascade', index=True)
    poll_id = fields.Many2one(
        'chat.poll', string='Poll', related='option_id.poll_id',
        store=True, index=True)
    user_id = fields.Many2one(
        'res.users', string='Voter', required=True,
        ondelete='cascade', index=True)

    _sql_constraints = [
        ('uniq_vote', 'unique(option_id, user_id)',
         'You can only vote once per option.'),
    ]
