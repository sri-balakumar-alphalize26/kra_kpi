"""Configuration -> Billing, 🧾 Bill now and one-click Paid (models/kpi_billing.py)."""

import logging
import re

from odoo import fields, http
from odoo.exceptions import UserError, ValidationError
from odoo.http import request

from ..models.kpi_billing import ALWAYS_FROM, WORK_TYPES

_logger = logging.getLogger(__name__)


def _is_admin(user):
    return request.env['kra.kpi']._is_kpi_admin_user(user)


def _no():
    return {'status': False, 'message': 'Only an admin can change billing.'}


class KpiBillingApi(http.Controller):

    @http.route('/kpi_billing/config', type='json', auth='user', methods=['POST'], csrf=False)
    def billing_config(self, **kw):
        if not _is_admin(request.env.user):
            return _no()
        env = request.env
        Rate = env['kpi.billing.rate'].sudo()
        clients = env['kra.master'].sudo().search([('is_client', '=', True)], order='name')
        # Every currency, the ones already in use first: INR / OMR / ... may be
        # switched off in Odoo; choosing one on a price switches it on.
        currencies = env['res.currency'].sudo().with_context(active_test=False).search([], order='active desc, name')
        c = env.company.sudo()
        Kpi = env['kra.kpi']
        return {
            'status': True,
            'rates': [r._serialize() for r in Rate.search([])],
            'clients': [{'id': k.id, 'name': k.name,
                         'currency': k.currency_id.name or '',
                         'invoice_group_jid': k.kpi_invoice_group_jid or '',
                         'invoice_group_name': k.kpi_invoice_group_name or '',
                         'send_invoice': bool(k.kpi_send_invoice)} for k in clients],
            'currencies': [{'id': cur.id, 'name': cur.name, 'symbol': cur.symbol or '',
                            'active': cur.active} for cur in currencies],
            'work_types': [{'key': k, 'label': v} for k, v in WORK_TYPES],
            'company_currency_id': c.currency_id.id,
            'numbers': c.kpi_billing_wa_numbers or '',
            'ceo_numbers': c.kpi_ceo_wa_numbers or '',
            'review_days': Kpi._review_days(),
            'skip_admin': Kpi._skip_admin_qa(),
        }

    @http.route('/kpi_billing/rate/save', type='json', auth='user', methods=['POST'], csrf=False)
    def rate_save(self, id=None, client_id=None, work_type=None, method=None, amount=None,
                  currency_id=None, date_from=None, date_to=None, note='', **kw):
        if not _is_admin(request.env.user):
            return _no()
        if work_type not in dict(WORK_TYPES):
            return {'status': False, 'message': 'Pick a work type.'}
        if method not in ('hourly', 'per_task'):
            return {'status': False, 'message': 'Pick Hourly or Per task.'}
        try:
            amt = float(str(amount).replace(',', '').strip())
        except (TypeError, ValueError):
            return {'status': False, 'message': 'The amount must be a number.'}
        if not currency_id:
            return {'status': False, 'message': 'Pick a currency.'}
        # No "From" = the price applies always.
        date_from = date_from or fields.Date.to_string(ALWAYS_FROM)
        vals = {
            'client_kra_id': int(client_id) if client_id else False,
            'work_type': work_type, 'method': method, 'amount': amt,
            'currency_id': int(currency_id),
            'date_from': date_from, 'date_to': date_to or False,
            'note': (note or '').strip()[:200] or False,
        }
        Rate = request.env['kpi.billing.rate'].sudo()
        cur = request.env['res.currency'].sudo().with_context(active_test=False).browse(int(currency_id)).exists()
        if not cur:
            return {'status': False, 'message': 'Pick a currency.'}
        if not cur.active:
            cur.active = True
        try:
            with request.env.cr.savepoint():
                rate = Rate.browse(int(id)) if id else Rate
                if id:
                    if not rate.exists():
                        return {'status': False, 'message': 'That rate is gone — reload.'}
                    rate.write(vals)
                else:
                    rate = Rate.create(vals)
        except (ValidationError, UserError) as exc:
            return {'status': False, 'message': str(exc)}
        return {'status': True, 'rate': rate._serialize()}

    @http.route('/kpi_billing/rate/delete', type='json', auth='user', methods=['POST'], csrf=False)
    def rate_delete(self, id=None, **kw):
        if not _is_admin(request.env.user):
            return _no()
        rate = request.env['kpi.billing.rate'].sudo().browse(int(id or 0))
        if not rate.exists():
            return {'status': True}
        # A rate already used on a bill is kept (archived) so that bill still
        # shows which rate priced it.
        used = request.env['kpi.client.invoice.line'].sudo().search_count([('rate_id', '=', rate.id)])
        if used:
            rate.active = False
        else:
            rate.unlink()
        return {'status': True, 'archived': bool(used)}

    @http.route('/kpi_billing/set_numbers', type='json', auth='user', methods=['POST'], csrf=False)
    def set_numbers(self, numbers='', **kw):
        if not _is_admin(request.env.user):
            return _no()
        from .kra_api import normalize_wa
        c = request.env.company.sudo()
        dial, length = c._kpi_mobile_cfg()
        out = []
        for raw in re.split(r'[,;\s]+', str(numbers or '')):
            n = normalize_wa(raw.strip(), dial, length)
            if not n:
                continue
            if len(n) < 8 or len(n) > 15:
                return {'status': False, 'message': '%s does not look like a WhatsApp number.' % raw.strip()}
            if n not in out:
                out.append(n)
        c.kpi_billing_wa_numbers = ','.join(out) or False
        return {'status': True, 'numbers': ','.join(out)}

    @http.route('/kpi_billing/client_invoice_set', type='json', auth='user', methods=['POST'], csrf=False)
    def client_invoice_set(self, client_id=None, jid=None, name=None, send=None, **kw):
        """Per client: the WhatsApp group its invoices go to, and the
        "Send invoices" switch. Only the keys given are changed."""
        if not _is_admin(request.env.user):
            return _no()
        client = request.env['kra.master'].sudo().browse(int(client_id or 0)).exists()
        if not client:
            return {'status': False, 'message': 'Client not found.'}
        vals = {}
        if jid is not None:
            jid = (jid or '').strip()
            if jid and not jid.endswith('@g.us'):
                return {'status': False, 'message': 'Pick a WhatsApp group.'}
            vals['kpi_invoice_group_jid'] = jid or False
            vals['kpi_invoice_group_name'] = (name or '').strip()[:120] or False
        if send is not None:
            vals['kpi_send_invoice'] = bool(send)
        if vals:
            client.write(vals)
        return {'status': True, 'invoice_group_jid': client.kpi_invoice_group_jid or '',
                'invoice_group_name': client.kpi_invoice_group_name or '',
                'send_invoice': bool(client.kpi_send_invoice)}

    def _task(self, kpi_id):
        try:
            kpi = request.env['kra.kpi'].sudo().with_context(active_test=False).browse(int(kpi_id or 0))
        except (TypeError, ValueError):
            return None
        return kpi if kpi.exists() else None

    @http.route('/kpi_billing/bill_now', type='json', auth='user', methods=['POST'], csrf=False)
    def bill_now(self, kpi_id=None, **kw):
        if not _is_admin(request.env.user):
            return _no()
        kpi = self._task(kpi_id)
        if not kpi:
            return {'status': False, 'message': 'Task not found.'}
        try:
            kpi.action_bill_now()
        except UserError as exc:
            return {'status': False, 'message': str(exc)}
        return {'status': True, 'message': 'Bill made.', 'bill': kpi._bill_info()}

    @http.route('/kpi_billing/mark_paid', type='json', auth='user', methods=['POST'], csrf=False)
    def mark_paid(self, kpi_id=None, method='bank_transfer', note='', **kw):
        """Admin, one tap: the money came in (bank credit) -- no client claim needed."""
        if not _is_admin(request.env.user):
            return _no()
        kpi = self._task(kpi_id)
        if not kpi:
            return {'status': False, 'message': 'Task not found.'}
        inv = kpi._bill_invoice()
        if not inv:
            return {'status': False, 'message': 'This task has no bill yet.'}
        if inv.payment_status == 'paid':
            return {'status': True, 'message': '%s is already paid.' % inv.name}
        try:
            inv.with_user(request.env.user).sudo().action_mark_paid(
                note=(note or '').strip() or 'Marked paid by %s' % request.env.user.name, method=method)
        except (UserError, ValidationError) as exc:
            return {'status': False, 'message': str(exc)}
        return {'status': True, 'message': '%s marked paid.' % inv.name}
