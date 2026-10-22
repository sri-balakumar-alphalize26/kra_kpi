"""Billing Configuration: one rate table, and a bill the moment a task is
fully complete (kpi_finish.py).

A rate is: client (empty = the default for everyone) x work type (New
Database / Requirement / Bug / Update) x Hourly or Per task x amount x
currency x the dates it is valid. The client's own row wins over the
default; among several, the one that started most recently. Two active rows
for the same client and work type may not cover the same day.

The bill is an ordinary kpi.client.invoice (source = automatic) holding just
that task, finalized at once, so it is locked the same way a hand-made one
is (change it with Revise). A task with no matching rate is left waiting and
the admins are told; 🧾 Bill now retries it.
"""

import json
import logging

from odoo import _, api, fields, models
from odoo.exceptions import UserError, ValidationError

from .kpi_client_invoice import _kind_from_ref

_logger = logging.getLogger(__name__)

WORK_TYPES = [
    ('database', 'New Database'),
    ('requirement', 'Requirement'),
    ('bug', 'Bug'),
    ('update', 'Update'),
]
# work type -> the invoice's own per-type price field (kpi_client_invoice.py)
_PRICE_FIELD = {'database': 'price_req', 'requirement': 'price_req',
                'bug': 'price_bug', 'update': 'price_upt'}


class KpiBillingRate(models.Model):
    _name = 'kpi.billing.rate'
    _description = 'Billing Rate'
    _order = 'client_kra_id, work_type, date_from desc, id desc'

    client_kra_id = fields.Many2one(
        'kra.master', string='Client', ondelete='cascade', index=True,
        domain=[('is_client', '=', True)],
        help='Empty = the default rate for every client without its own.')
    work_type = fields.Selection(WORK_TYPES, required=True, index=True)
    method = fields.Selection([('hourly', 'Hourly'), ('per_task', 'Per task')],
                              required=True, default='per_task')
    amount = fields.Float(required=True, digits=(16, 2))
    currency_id = fields.Many2one('res.currency', required=True,
                                  default=lambda s: s.env.company.currency_id)
    date_from = fields.Date(string='From', required=True, default=fields.Date.today)
    date_to = fields.Date(string='To', help='Empty = no end date.')
    active = fields.Boolean(default=True)
    note = fields.Char()

    @api.constrains('amount', 'date_from', 'date_to')
    def _check_values(self):
        for r in self:
            if r.amount < 0:
                raise ValidationError(_('The amount can\'t be below zero.'))
            if r.date_to and r.date_to < r.date_from:
                raise ValidationError(_('"To" is before "From".'))

    @api.constrains('client_kra_id', 'work_type', 'date_from', 'date_to', 'active')
    def _check_overlap(self):
        far = fields.Date.to_date('9999-12-31')
        for r in self.filtered('active'):
            others = self.search([('id', '!=', r.id), ('active', '=', True),
                                  ('work_type', '=', r.work_type),
                                  ('client_kra_id', '=', r.client_kra_id.id or False)])
            for o in others:
                if r.date_from <= (o.date_to or far) and o.date_from <= (r.date_to or far):
                    raise ValidationError(_(
                        'Two %(type)s rates for %(client)s cover the same days (%(a)s and %(b)s). '
                        'Give the older one an end date first.') % {
                        'type': dict(WORK_TYPES)[r.work_type],
                        'client': r.client_kra_id.name or _('Default'),
                        'a': r._range_label(), 'b': o._range_label()})

    def _range_label(self):
        self.ensure_one()
        return '%s → %s' % (self.date_from, self.date_to or _('no end'))

    @api.model
    def _rate_for(self, client, work_type, on_date):
        """The rate that prices `work_type` work for `client` on `on_date`."""
        base = [('work_type', '=', work_type), ('active', '=', True),
                ('date_from', '<=', on_date), '|', ('date_to', '=', False), ('date_to', '>=', on_date)]
        node, seen = client, set()
        while node and node.id not in seen:
            seen.add(node.id)
            rate = self.sudo().search(base + [('client_kra_id', '=', node.id)], order='date_from desc', limit=1)
            if rate:
                return rate
            node = node.parent_id
        return self.sudo().search(base + [('client_kra_id', '=', False)], order='date_from desc', limit=1)

    def _serialize(self):
        self.ensure_one()
        return {
            'id': self.id,
            'client_id': self.client_kra_id.id or False,
            'client_name': self.client_kra_id.name or '',
            'work_type': self.work_type,
            'work_type_label': dict(WORK_TYPES)[self.work_type],
            'method': self.method,
            'amount': self.amount,
            'currency_id': self.currency_id.id,
            'currency': self.currency_id.name or '',
            'currency_symbol': self.currency_id.symbol or '',
            'date_from': fields.Date.to_string(self.date_from) if self.date_from else '',
            'date_to': fields.Date.to_string(self.date_to) if self.date_to else '',
            'note': self.note or '',
        }


class KpiClientInvoiceAuto(models.Model):
    _inherit = 'kpi.client.invoice'

    source = fields.Selection([('manual', 'Made by hand'), ('auto', 'Automatic (Full Complete)')],
                              default='manual', readonly=True, copy=False)


class KpiClientInvoiceLineRate(models.Model):
    _inherit = 'kpi.client.invoice.line'

    rate_id = fields.Many2one('kpi.billing.rate', string='Rate Used', ondelete='set null', readonly=True)


class ResCompanyBilling(models.Model):
    _inherit = 'res.company'

    kpi_billing_wa_numbers = fields.Char(
        string='Bill alert WhatsApp numbers',
        help='Comma-separated. Each new bill and each payment is sent here. '
             'Empty = the CEO day-note numbers.')


class KraKpiBilling(models.Model):
    _inherit = 'kra.kpi'

    def _billing_work_type(self):
        self.ensure_one()
        if (self.request_category or '') == 'new_database':
            return 'database'
        return {'req': 'requirement', 'bug': 'bug', 'upt': 'update'}.get(_kind_from_ref(self.external_ref), '')

    def _billing_hours(self):
        """(billable hours, actual hours, contributors) -- the same rule the
        invoice screen uses: the client's quoted hours, else the time logged."""
        self.ensure_one()
        by_user = {}
        for log in self.env['kpi.time.log'].sudo().search([('kpi_id', '=', self.id), ('is_active', '=', False)]):
            by_user[log.user_id.id] = by_user.get(log.user_id.id, 0) + (log.duration_seconds or 0)
        actual = round(sum(by_user.values()) / 3600.0, 2)
        Users = self.env['res.users'].sudo()
        contributors = [{'user_id': uid, 'name': Users.browse(uid).name or '', 'hours': round(s / 3600.0, 2)}
                        for uid, s in sorted(by_user.items(), key=lambda x: -x[1]) if uid]
        return (self.client_quoted or actual), actual, contributors

    def _billing_numbers(self):
        c = self.env.company.sudo()
        raw = c.kpi_billing_wa_numbers or c.kpi_ceo_wa_numbers or ''
        return [n.strip() for n in raw.split(',') if n.strip()]

    def _billing_quote(self):
        """What the bill would be, without making it: (rate, amount, hours, why-not)."""
        self.ensure_one()
        wt = self._billing_work_type()
        if not wt:
            return None, 0.0, 0.0, _('%s has no REQ / BUG / UPT number yet.') % (self.external_ref or self.name)
        client = self.client_kra_id
        if not client:
            return None, 0.0, 0.0, _('%s is not under a client.') % (self.external_ref or self.name)
        on = fields.Datetime.to_datetime(self.full_complete_at or fields.Datetime.now()).date()
        rate = self.env['kpi.billing.rate']._rate_for(client, wt, on)
        if not rate:
            return None, 0.0, 0.0, _('No %(type)s rate for %(client)s on %(day)s.') % {
                'type': dict(WORK_TYPES)[wt], 'client': client.name, 'day': on.strftime('%d %b %Y')}
        hours = self._billing_hours()[0]
        amount = rate.amount if rate.method == 'per_task' else round(hours * rate.amount, 2)
        return rate, amount, hours, ''

    def _already_billed(self):
        self.ensure_one()
        return bool(self.env['kpi.client.invoice.line'].sudo().search_count([('kpi_id', '=', self.id)]))

    def _bill_invoice(self):
        """The finalized / sent bill holding this task (newest), or empty."""
        self.ensure_one()
        line = self.env['kpi.client.invoice.line'].sudo().search(
            [('kpi_id', '=', self.id), ('invoice_id.state', 'in', ('finalized', 'sent'))],
            order='id desc', limit=1)
        return line.invoice_id

    def _bill_info(self):
        self.ensure_one()
        inv = self._bill_invoice()
        if not inv:
            return {}
        return {'id': inv.id, 'name': inv.name, 'amount': inv.total_amount,
                'money': self._money(inv.total_amount, inv.currency_id),
                'paid': inv.payment_status == 'paid', 'auto': inv.source == 'auto',
                'client_says_paid': bool(inv.client_paid_claim)}

    def _finish_payload(self):
        out = super()._finish_payload()
        if self.full_complete_at:
            out['bill'] = self._bill_info()
        return out

    def _auto_bill(self):
        """Make and lock this task's bill. True when one was made (or already
        exists); False when it can't be priced -- the admins are told why."""
        self.ensure_one()
        rec = self.sudo()
        if not rec.full_complete_at:
            return False
        if rec._already_billed():
            return True
        rate, amount, hours, why = rec._billing_quote()
        ref = rec.external_ref or '#%s' % rec.id
        if not rate:
            rec._log_action('auto_bill_skipped', source='system', payload={'why': why})
            rec._finish_alpha(_('🧾 %(ref)s is fully complete but has no bill yet: %(why)s\n'
                                'Add the rate in Configuration → Billing, then tap 🧾 Bill now on the task.')
                              % {'ref': ref, 'why': why})
            return False
        _q, actual, contributors = rec._billing_hours()
        day = fields.Datetime.to_datetime(rec.full_complete_at).date()
        wt = rec._billing_work_type()
        vals = {
            'client_kra_id': rec.client_kra_id.id,
            'from_date': day, 'to_date': day, 'invoice_date': day,
            'currency_id': rate.currency_id.id,
            'billing_method': rate.method,
            'hourly_rate': rate.amount if rate.method == 'hourly' else 0.0,
            'invoice_title': '%s — %s' % (ref, rec.name or ''),
            'source': 'auto',
        }
        if rate.method == 'per_task':
            vals[_PRICE_FIELD[wt]] = rate.amount
        if rec.review_close_reason == 'timeout':
            note = _('Closed after %d days without a reply from the client.') % rec._review_days()
            vals['notes'] = '<p>%s</p>' % note
        Invoice = self.env['kpi.client.invoice'].sudo()
        inv = Invoice.create(vals)
        self.env['kpi.client.invoice.line'].sudo().create({
            'invoice_id': inv.id, 'sequence': 10, 'line_type': 'kpi', 'kpi_id': rec.id,
            'description': rec.name or ref,
            'quoted_hours': hours, 'actual_hours': actual,
            'unit_price': rate.amount if rate.method == 'per_task' else 0.0,
            'contributor_data': json.dumps(contributors), 'rate_id': rate.id,
        })
        inv.action_finalize()
        rec._log_action('auto_billed', source='system',
                        payload={'invoice': inv.name, 'amount': inv.total_amount,
                                 'currency': rate.currency_id.name, 'rate_id': rate.id})
        rec._bill_tell(inv)
        return True

    def _money(self, amount, currency):
        sym = currency.symbol or currency.name or ''
        txt = '{:,.2f}'.format(amount or 0)
        return ('%s %s' % (txt, sym)) if currency.position == 'after' else ('%s%s' % (sym, txt))

    def _bill_tell(self, inv):
        """The bill went out: the team, the client group, the owner numbers."""
        self.ensure_one()
        ref = self.external_ref or '#%s' % self.id
        money = self._money(inv.total_amount, inv.currency_id)
        self._finish_alpha(_('🧾 *%(inv)s* — %(ref)s %(name)s — %(money)s. Queued for billing.') % {
            'inv': inv.name, 'ref': ref, 'name': self.name or '', 'money': money})
        self._finish_client_group(_('✅ *%(ref)s* — %(name)s is complete and closed.\n🧾 Bill %(inv)s: %(money)s. '
                                    'You can see it in your portal under Invoices.') % {
            'ref': ref, 'name': self.name or '', 'inv': inv.name, 'money': money})
        text = _('🧾 New bill %(inv)s\nClient: %(client)s\nTask: %(ref)s — %(name)s\nAmount: %(money)s') % {
            'inv': inv.name, 'client': inv.client_kra_id.name or '', 'ref': ref,
            'name': self.name or '', 'money': money}
        self._bill_to_owners(text, 'bill_created')

    def _bill_to_owners(self, text, event):
        Queue = self.env['kpi.notification.queue'].sudo()
        for num in self._billing_numbers():
            try:
                Queue.enqueue_delayed(num, text, event=event, seconds=1, role='owner')
            except Exception as exc:
                _logger.warning('bill alert to %s failed: %s', num, exc)

    def action_bill_now(self):
        """🧾 Bill now: retry a fully complete task that had no rate."""
        for rec in self:
            if not rec.full_complete_at:
                raise UserError(_('%s is not fully complete yet.') % (rec.external_ref or rec.name))
            if rec._already_billed():
                raise UserError(_('%s already has a bill.') % (rec.external_ref or rec.name))
            rate, _a, _h, why = rec._billing_quote()
            if not rate:
                raise UserError(why)
            rec._auto_bill()
        return True


class KpiClientInvoicePaidTell(models.Model):
    _inherit = 'kpi.client.invoice'

    def action_mark_paid(self, *args, **kwargs):
        was = {inv.id: inv.payment_status for inv in self}
        res = super().action_mark_paid(*args, **kwargs)
        for inv in self:
            if was.get(inv.id) == 'paid' or inv.payment_status != 'paid' or inv.source != 'auto':
                continue
            try:
                task = inv.line_ids.mapped('kpi_id')[:1].with_context(active_test=False)
                if not task:
                    continue
                money = task._money(inv.total_amount, inv.currency_id)
                task._finish_alpha(_('✅ %(inv)s settled — %(money)s.') % {'inv': inv.name, 'money': money})
                task._finish_client_group(_('✅ Payment for %(inv)s received (%(money)s). Thank you!')
                                          % {'inv': inv.name, 'money': money})
                task._bill_to_owners(_('✅ Paid: %(inv)s — %(client)s — %(money)s') % {
                    'inv': inv.name, 'client': inv.client_kra_id.name or '', 'money': money}, 'bill_paid')
            except Exception as exc:
                _logger.warning('paid message for %s failed: %s', inv.name, exc)
        return res
