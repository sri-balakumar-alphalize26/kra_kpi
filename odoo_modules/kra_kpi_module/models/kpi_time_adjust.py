"""Admin: take forgotten time off YESTERDAY's work on a task.

A developer who walked away without pausing -- laptop died, power cut, simply
forgot -- leaves the timer running until the midnight auto-close. The next
morning they tell an admin, and the task reads hours of work that never
happened (worked 15h, really 13h).

The rules, all enforced here and not only by hiding a button:

* Admins only (owner / coordinator / system) -- a developer cannot adjust
  their own recorded time.
* DECREASE only. Adding time that was not timed is a different thing (and
  the Add Done Task back-fill already exists for it).
* YESTERDAY only. Not today (the day is still running and can be paused
  properly) and not the day before (by then it has been reported on).
* A reason every time: one of the five usual ones, or Other with words.
  Saved in the task's activity log with the before / after.

HOW IT IS TAKEN OFF
-------------------
The forgotten time is the END of the day -- the timer kept running after the
person had gone. So the cut is made from the end of yesterday's latest
interval backwards (kpi.time.log.end_time), which is what every report reads,
and the task's running total (timer_total_seconds) goes down by the same
amount. Nothing is ever cut below an interval's own start.
"""

import json
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import UserError

# The five usual reasons, then Other. Keys are stored in the log.
REDUCE_REASONS = [
    ('power_cut', 'Power cut'),
    ('laptop', 'Laptop stuck / crashed'),
    ('internet', 'Internet down'),
    ('forgot_pause', 'Forgot to pause the task'),
    ('no_end_day', 'Left without ending the workday'),
    ('other', 'Other'),
]


def _hm(secs):
    m = int(round((secs or 0) / 60.0))
    return '%dh %02dm' % (m // 60, m % 60)


class KraKpiTimeAdjust(models.Model):
    _inherit = 'kra.kpi'

    def _prev_day_date(self):
        return fields.Date.context_today(self) - timedelta(days=1)

    def _prev_day_logs(self):
        """Yesterday's finished, timed intervals on this task, latest end first.
        Back-filled (is_manual) rows are not timer time and are left alone."""
        self.ensure_one()
        return self.env['kpi.time.log'].sudo().search([
            ('kpi_id', '=', self.id),
            ('work_date', '=', self._prev_day_date()),
            ('is_active', '=', False),
            ('is_manual', '=', False),
            ('end_time', '!=', False),
        ], order='end_time desc, id desc')

    @api.model
    def prev_day_seconds_map(self, kpi_ids):
        """{kpi_id: seconds worked yesterday} for many cards in one query."""
        if not kpi_ids:
            return {}
        rows = self.env['kpi.time.log'].sudo()._read_group(
            [('kpi_id', 'in', list(kpi_ids)), ('work_date', '=', self._prev_day_date()),
             ('is_active', '=', False), ('is_manual', '=', False)],
            ['kpi_id'], ['duration_seconds:sum'])
        return {k.id: s or 0.0 for k, s in rows}

    def prev_day_time_info(self):
        self.ensure_one()
        logs = self._prev_day_logs()
        total = sum(logs.mapped('duration_seconds'))
        day = self._prev_day_date()
        by_user = {}
        for l in logs:
            by_user[l.user_id.name or ''] = by_user.get(l.user_id.name or '', 0) + l.duration_seconds

        def hhmm(dt):
            return fields.Datetime.context_timestamp(self, dt).strftime('%I:%M %p') if dt else ''
        # The whole of yesterday, so the admin can see where the extra hours sit
        # before cutting: every interval on this task (earliest first), and each
        # person's total across ALL their tasks that day.
        intervals = [{'who': l.user_id.name or '', 'start': hhmm(l.start_time), 'end': hhmm(l.end_time),
                      'display': _hm(l.duration_seconds)} for l in logs.sorted('start_time')]
        day_totals = []
        for u in logs.mapped('user_id'):
            all_logs = self.env['kpi.time.log'].sudo().search([
                ('user_id', '=', u.id), ('work_date', '=', day),
                ('is_active', '=', False), ('is_manual', '=', False)])
            day_totals.append({'name': u.name or '', 'display': _hm(sum(all_logs.mapped('duration_seconds'))),
                               'tasks': len(all_logs.mapped('kpi_id'))})
        return {
            'status': True,
            'date': str(day),
            'date_display': day.strftime('%a %d %b %Y'),
            'seconds': total,
            'display': _hm(total),
            'last_end': fields.Datetime.context_timestamp(self, logs[0].end_time).strftime('%I:%M %p')
            if logs else '',
            'people': [{'name': n, 'display': _hm(s)} for n, s in by_user.items()],
            'intervals': intervals,
            'day_totals': day_totals,
            'task_total_display': _hm(self.timer_total_seconds or 0),
            'reasons': [{'key': k, 'label': l} for k, l in REDUCE_REASONS],
        }

    def action_reduce_prev_day(self, minutes, reason_code, reason_text='', source='web'):
        """Take `minutes` off yesterday's time on this task. Returns a dict."""
        self.ensure_one()
        user = self.env.user
        if not self.sudo()._user_is_kpi_admin(user):
            raise UserError(_('Only an admin can reduce recorded time.'))
        try:
            minutes = int(minutes or 0)
        except (TypeError, ValueError):
            minutes = 0
        if minutes <= 0:
            raise UserError(_('Enter how much time to take off (more than 0 minutes).'))
        labels = dict(REDUCE_REASONS)
        if reason_code not in labels:
            raise UserError(_('Pick a reason.'))
        text = (reason_text or '').strip()
        if reason_code == 'other' and not text:
            raise UserError(_('Type the reason — it is saved in the task log.'))
        reason = text if reason_code == 'other' else (
            labels[reason_code] + ((' — ' + text) if text else ''))

        logs = self._prev_day_logs()
        total = sum(logs.mapped('duration_seconds'))
        cut = minutes * 60
        if not logs or total <= 0:
            raise UserError(_('No time was recorded on this task yesterday (%s).')
                            % self._prev_day_date().strftime('%d %b'))
        if cut > total:
            raise UserError(_('Yesterday this task has %s recorded — you can take off at '
                              'most that much.') % _hm(total))

        left = cut
        for log in logs:
            if left <= 0:
                break
            take = min(left, log.duration_seconds)
            if take <= 0:
                continue
            log.write({'end_time': log.end_time - timedelta(seconds=take)})
            left -= take
        before_total = self.timer_total_seconds or 0.0
        self.sudo().write({'timer_total_seconds': max(0.0, before_total - cut)})

        day = self._prev_day_date()
        self.env['kpi.action.log'].sudo().create({
            'kpi_id': self.id,
            'event': 'time_reduced',
            'source': source if source in ('web', 'whatsapp') else 'web',
            'actor_user_id': user.id,
            'actor_label': user.name or user.login or '',
            'payload_json': json.dumps({
                'date': str(day),
                'from': _hm(total), 'to': _hm(total - cut),
                'reduced': _hm(cut), 'reduced_seconds': cut,
                'reason_code': reason_code, 'reason': reason,
            }),
        })
        return {
            'status': True,
            'message': _('Took %s off %s — yesterday (%s) is now %s instead of %s.') % (
                _hm(cut), self.external_ref or self.name, day.strftime('%d %b'),
                _hm(total - cut), _hm(total)),
            'before': _hm(total), 'after': _hm(total - cut),
        }
