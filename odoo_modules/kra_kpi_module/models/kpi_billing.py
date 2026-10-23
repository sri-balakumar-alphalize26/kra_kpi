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
from datetime import date

from odoo import _, api, fields, models
from odoo.exceptions import UserError, ValidationError

from .kpi_client_invoice import _kind_from_ref

_logger = logging.getLogger(__name__)

# A price with no "From" date applies always: it is stored from this day.
ALWAYS_FROM = date(2000, 1, 1)

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
    date_from = fields.Date(string='From', required=True, default=ALWAYS_FROM,
                            help='2000-01-01 = always (no start date was set).')
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
                        '%(client)s already has a %(type)s price (%(price)s, %(range)s). '
                        'Edit that one instead.') % {
                        'type': dict(WORK_TYPES)[r.work_type],
                        'client': r.client_kra_id.name or _('The Default'),
                        'price': o._price_label(), 'range': o._range_label()})

    def _is_always(self):
        self.ensure_one()
        return self.date_from <= ALWAYS_FROM and not self.date_to

    def _range_label(self):
        self.ensure_one()
        if self._is_always():
            return _('always')
        start = _('from %s') % self.date_from if self.date_from > ALWAYS_FROM else _('from the start')
        return '%s %s' % (start, (_('to %s') % self.date_to) if self.date_to else _('with no end'))

    def _price_label(self):
        self.ensure_one()
        sym = self.currency_id.symbol or self.currency_id.name or ''
        amt = '{:,.2f}'.format(self.amount or 0)
        money = ('%s %s' % (amt, sym)) if self.currency_id.position == 'after' else ('%s%s' % (sym, amt))
        return '%s %s' % (money, _('per hour') if self.method == 'hourly' else _('per task'))

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
            # '' when it applies from the start (stored as ALWAYS_FROM).
            'date_from': fields.Date.to_string(self.date_from) if self.date_from and self.date_from > ALWAYS_FROM else '',
            'always': self._is_always(),
            'range_label': self._range_label(),
            'price_label': self._price_label(),
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


class KraMasterInvoiceGroup(models.Model):
    _inherit = 'kra.master'

    # 🧾 Settings › Billing, per client: each new bill is posted in this
    # WhatsApp group while "Send invoices" is on. Off (the default) = no
    # invoice message at all. A project uses its client's setting.
    kpi_invoice_group_jid = fields.Char(string='Invoice WhatsApp group')
    kpi_invoice_group_name = fields.Char(string='Invoice group name')
    kpi_send_invoice = fields.Boolean(string='Send invoices', default=False)

    def _invoice_target(self):
        """(send, jid, name) for this client: its own, else the nearest
        parent that has an invoice group set."""
        node, seen = self, set()
        while node and node.id not in seen:
            seen.add(node.id)
            if node.kpi_invoice_group_jid or node.kpi_send_invoice:
                return bool(node.kpi_send_invoice), node.kpi_invoice_group_jid or '', node.kpi_invoice_group_name or ''
            node = node.parent_id
        return False, '', ''


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
            # No WhatsApp for this: the Billing page shows the missing price in
            # red and the task offers 🧾 Bill now.
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
        """The bill goes to the client's invoice WhatsApp group, only while
        that client's "Send invoices" is on (Settings › Billing). Nothing
        private, nothing in the team / client chat groups (they were told
        just "complete" in kpi_finish._finish_after_full)."""
        self.ensure_one()
        send, jid, _name = (inv.client_kra_id or self.client_kra_id)._invoice_target()
        if not send:
            return False
        if not jid:
            _logger.warning('invoice %s not sent: "Send invoices" is on but no invoice group is picked', inv.name)
            return False
        ref = self.external_ref or '#%s' % self.id
        money = self._money(inv.total_amount, inv.currency_id)
        text = _('🧾 *%(inv)s*\nClient: %(client)s\nTask: %(ref)s — %(name)s\nAmount: *%(money)s*') % {
            'inv': inv.name, 'client': inv.client_kra_id.name or '', 'ref': ref,
            'name': self.name or '', 'money': money}
        return self.env['kpi.wa.group.report'].sudo()._post(text, jid=jid)

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
        # No WhatsApp for a payment: only the invoice itself is sent
        # (_bill_tell). The in-app notices of kpi_client_invoice stay.
        return super().action_mark_paid(*args, **kwargs)
