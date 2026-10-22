"""Full Complete and the client-review settings (models/kpi_finish.py)."""

import logging

from odoo import http
from odoo.exceptions import UserError
from odoo.http import request

_logger = logging.getLogger(__name__)


def _is_admin(user):
    return request.env['kra.kpi']._is_kpi_admin_user(user)


class KpiFinishApi(http.Controller):

    @http.route('/kra_kpi/task/full_complete', type='json', auth='user', methods=['POST'], csrf=False)
    def task_full_complete(self, kpi_id=None, **kw):
        try:
            kpi = request.env['kra.kpi'].sudo().browse(int(kpi_id or 0))
        except (TypeError, ValueError):
            return {'status': False, 'message': 'Task not found.'}
        if not kpi.exists():
            return {'status': False, 'message': 'Task not found.'}
        try:
            kpi.full_complete(user=request.env.user, source='web')
        except UserError as exc:
            return {'status': False, 'message': str(exc), 'missing': kpi._full_complete_missing()}
        return {'status': True, 'message': '%s is fully complete — it moves to billing.'
                % (kpi.external_ref or kpi.name)}

    @http.route('/kpi_config/finish/get', type='json', auth='user', methods=['POST'], csrf=False)
    def finish_config_get(self, **kw):
        Kpi = request.env['kra.kpi']
        return {'status': True, 'review_days': Kpi._review_days(),
                'skip_admin': Kpi._skip_admin_qa()}

    @http.route('/kpi_config/finish/set', type='json', auth='user', methods=['POST'], csrf=False)
    def finish_config_set(self, review_days=None, skip_admin=None, **kw):
        if not _is_admin(request.env.user):
            return {'status': False, 'message': 'Not authorized'}
        ICP = request.env['ir.config_parameter'].sudo()
        if review_days is not None:
            try:
                days = int(review_days)
            except (TypeError, ValueError):
                return {'status': False, 'message': 'Days must be a whole number.'}
            if days < 1 or days > 60:
                return {'status': False, 'message': 'Pick between 1 and 60 days.'}
            ICP.set_param('kra_kpi.client_review_days', str(days))
        if skip_admin is not None:
            ICP.set_param('kra_kpi.client_review_skip_admin', '1' if skip_admin else '0')
        return self.finish_config_get()
