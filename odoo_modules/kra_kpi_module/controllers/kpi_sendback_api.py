"""↩ Send back with proof (models/kpi_client_sendback.py): the files, for the
team (logged in) and for the developer's WhatsApp task page (token)."""

import base64
import logging

from odoo import http
from odoo.http import request

from .kra_api import _guess_mime, serve_file

_logger = logging.getLogger(__name__)


def sendback_file_response(kpi, att_id):
    """One proof file of `kpi`, inline with Range so video / audio play on
    phones. 404 when the file is not on one of this task's send-backs."""
    att = request.env['kpi.file.attachment'].sudo().browse(int(att_id)).exists()
    if not att or not att.sendback_id or att.sendback_id.kpi_id != kpi:
        return request.not_found()
    return serve_file(base64.b64decode(att.file or b''), att.file_name,
                      _guess_mime(att.file_name, att.mimetype or ''), inline=True)


class KpiSendbackApi(http.Controller):

    @http.route('/kpi/sendback/file/<int:att_id>', type='http', auth='user', methods=['GET'], csrf=False)
    def sendback_file(self, att_id, **kw):
        """For anyone on the team who may open the task (kra_api._may_view_kpi_details)."""
        from .kra_api import KraKpiAPI
        att = request.env['kpi.file.attachment'].sudo().browse(att_id).exists()
        kpi = att.sendback_id.kpi_id if att else None
        if not kpi:
            return request.not_found()
        if KraKpiAPI()._may_view_kpi_details(kpi):
            return request.not_found()
        return sendback_file_response(kpi, att_id)

    @http.route('/kpi/wa/task/<string:token>/sendback/file/<int:att_id>', type='http', auth='public',
                methods=['GET'], csrf=False, website=False)
    def sendback_file_page(self, token, att_id, **kw):
        from .kpi_wa_task_page import KpiWaTaskPage
        st, user, task = KpiWaTaskPage()._resolve(token)
        if not task:
            return request.not_found()
        return sendback_file_response(task, att_id)
