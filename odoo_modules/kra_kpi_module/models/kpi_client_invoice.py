import json

from odoo import api, fields, models
from odoo.exceptions import ValidationError


class KpiClientInvoice(models.Model):
    _name = 'kpi.client.invoice'
    _description = 'Client Invoice'
    _order = 'invoice_date desc, id desc'

    name = fields.Char(default='/', readonly=True, copy=False)
    client_kra_id = fields.Many2one(
        'kra.master',
        string='Client',
        required=True,
        domain=[('is_client', '=', True)],
    )
    from_date = fields.Date(string='Period From', required=True)
    to_date = fields.Date(string='Period To', required=True)
    invoice_date = fields.Date(string='Invoice Date', default=fields.Date.today)
    state = fields.Selection(
        [('draft', 'Draft'), ('finalized', 'Finalized'), ('sent', 'Sent')],
        default='draft',
        required=True,
    )
    # Payment tracking — only meaningful once state != 'draft'.
    payment_status = fields.Selection(
        [('unpaid', 'Unpaid (Due)'), ('paid', 'Paid')],
        default='unpaid', required=True, copy=False, index=True,
        help='Whether this invoice has been collected from the client.',
    )
    payment_date = fields.Datetime(
        string='Paid On', readonly=True, copy=False,
        help='Timestamp the invoice was marked paid.',
    )
    paid_by_id = fields.Many2one(
        'res.users', string='Marked Paid By', readonly=True, copy=False,
    )
    payment_notes = fields.Text(string='Payment Notes', help='Optional note recorded on payment.')
    line_ids = fields.One2many('kpi.client.invoice.line', 'invoice_id', string='Lines')
    notes = fields.Html(string='Overall Notes')

    # Custom invoice title (shown on PDF). Optional — falls back to client name.
    invoice_title = fields.Char(string='Invoice Title',
        help='Custom title that appears on the PDF invoice (e.g. "Monthly Services - May 2026").')

    # Per-hour billing rate. If > 0, PDF includes amount columns.
    hourly_rate = fields.Float(string='Hourly Rate', default=0.0,
        help='Per-hour rate used to compute line amounts. Leave at 0 for time-only invoices.')

    total_amount = fields.Float(string='Total Amount', compute='_compute_totals', store=True,
        help='grand_total_hours x hourly_rate. Only meaningful when hourly_rate > 0.')

    # Billing currency — defaults from the client KRA's currency on create.
    currency_id = fields.Many2one('res.currency', string='Currency',
        help="Currency for this invoice. Defaults from the client KRA's currency.")

    # Optional filters narrowing what gets pulled from time logs.
    filter_user_ids = fields.Many2many(
        'res.users',
        'kpi_client_invoice_filter_user_rel',
        'invoice_id',
        'user_id',
        string='Filter: Developers',
        help='If set, only include time logs from these developers. Empty = all developers.'
    )
    filter_kpi_ids = fields.Many2many(
        'kra.kpi',
        'kpi_client_invoice_filter_kpi_rel',
        'invoice_id',
        'kpi_id',
        string='Filter: Tasks',
        help='If set, only include these specific KPIs. Empty = all KPIs under the client KRA.'
    )
    filter_sub_kra_ids = fields.Many2many(
        'kra.master',
        'kpi_client_invoice_subkra_rel',
        'invoice_id',
        'sub_kra_id',
        string='Filter: Sub-KRAs (Projects)',
        help='If set, only include KPIs under these sub-projects of the client. Empty = all sub-KRAs of the client.'
    )
    # Comma-separated list of external_ref prefixes to include
    # (e.g. "REQ,UPT" includes only requirements + updates, excludes bugs).
    # Empty = all task types.
    filter_task_types = fields.Char(
        string='Filter: Task Types',
        help='Comma-separated list of task-type prefixes to include (REQ, UPT, BUG). '
             'Empty = all task types. Matches the external_ref prefix.',
    )

    total_quoted_hours = fields.Float(compute='_compute_totals', store=True)
    total_actual_hours = fields.Float(compute='_compute_totals', store=True)
    total_adjusted_hours = fields.Float(compute='_compute_totals', store=True)
    grand_total_hours = fields.Float(
        compute='_compute_totals',
        store=True,
        help='total_quoted_hours + total_adjusted_hours — billable total for the client.'
    )

    @api.model_create_multi
    def create(self, vals_list):
        Kra = self.env['kra.master']
        for v in vals_list:
            if v.get('name', '/') in (False, '/', ''):
                v['name'] = self.env['ir.sequence'].next_by_code('kpi.client.invoice') or '/'
            # Auto-default currency from the client KRA if not explicitly set
            if not v.get('currency_id') and v.get('client_kra_id'):
                client = Kra.browse(int(v['client_kra_id']))
                if client.currency_id:
                    v['currency_id'] = client.currency_id.id
        return super().create(vals_list)

    @api.depends('line_ids', 'line_ids.quoted_hours', 'line_ids.actual_hours', 'line_ids.line_type', 'hourly_rate')
    def _compute_totals(self):
        for inv in self:
            kpi_lines = inv.line_ids.filtered(lambda l: l.line_type == 'kpi')
            adj_lines = inv.line_ids.filtered(lambda l: l.line_type == 'adjustment')
            inv.total_quoted_hours = sum(kpi_lines.mapped('quoted_hours'))
            inv.total_actual_hours = sum(kpi_lines.mapped('actual_hours'))
            inv.total_adjusted_hours = sum(adj_lines.mapped('quoted_hours'))
            inv.grand_total_hours = inv.total_quoted_hours + inv.total_adjusted_hours
            inv.total_amount = inv.grand_total_hours * (inv.hourly_rate or 0.0)

    @api.constrains('from_date', 'to_date')
    def _check_dates(self):
        for inv in self:
            if inv.from_date and inv.to_date and inv.from_date > inv.to_date:
                raise ValidationError("Period From cannot be after Period To.")

    def _guard_draft(self):
        for inv in self:
            if inv.state != 'draft':
                raise ValidationError(
                    "Invoice %s is %s — only Draft invoices can be modified." %
                    (inv.name, inv.state)
                )

    def action_populate_from_logs(self):
        """Auto-create KPI lines from time logs in [from_date, to_date] under client_kra_id (or any descendant)."""
        self.ensure_one()
        self._guard_draft()
        # Wipe any prior KPI lines (preserve adjustment lines).
        self.line_ids.filtered(lambda l: l.line_type == 'kpi').unlink()

        kra_ids = self.client_kra_id._get_descendant_ids()
        # If sub-KRA filter is set, restrict to the union of those sub-trees (intersected with client's tree)
        if self.filter_sub_kra_ids:
            sub_ids = set()
            for sub in self.filter_sub_kra_ids:
                sub_ids.update(sub._get_descendant_ids())
            kra_ids = list(sub_ids & set(kra_ids))
        domain = [
            ('is_active', '=', False),
            ('work_date', '>=', self.from_date),
            ('work_date', '<=', self.to_date),
            ('kpi_id.kra_id', 'in', kra_ids),
        ]
        if self.filter_user_ids:
            domain.append(('user_id', 'in', self.filter_user_ids.ids))
        if self.filter_kpi_ids:
            domain.append(('kpi_id', 'in', self.filter_kpi_ids.ids))
        # Filter by task-type prefix (REQ / UPT / BUG, comma-separated).
        if self.filter_task_types:
            types = [t.strip().upper() for t in self.filter_task_types.split(',')
                     if t.strip()]
            if types:
                # Build an OR-of-ilike domain. For N prefixes we need N-1
                # leading '|' operators in Odoo's prefix-style domain.
                ref_dom = []
                for _ in range(len(types) - 1):
                    ref_dom.append('|')
                for t in types:
                    ref_dom.append(('external_ref', '=ilike', t + '-%'))
                allowed = self.env['kra.kpi'].search(ref_dom)
                domain.append(('kpi_id', 'in', allowed.ids))
        logs = self.env['kpi.time.log'].search(domain)

        # Bucket by kpi_id, then user_id -> seconds
        bucket = {}
        for log in logs:
            kb = bucket.setdefault(log.kpi_id.id, {'kpi': log.kpi_id, 'by_user': {}})
            kb['by_user'][log.user_id.id] = kb['by_user'].get(log.user_id.id, 0) + (log.duration_seconds or 0)

        Line = self.env['kpi.client.invoice.line']
        Users = self.env['res.users']
        seq = 10
        # Sort by KPI id for stable display
        for kpi_id in sorted(bucket.keys()):
            data = bucket[kpi_id]
            kpi = data['kpi']
            actual_secs = sum(data['by_user'].values())
            contributors = []
            for uid, secs in sorted(data['by_user'].items(), key=lambda x: -x[1]):
                u = Users.browse(uid)
                contributors.append({
                    'user_id': uid,
                    'name': u.name or u.login or 'Unknown',
                    'hours': round(secs / 3600.0, 2),
                })
            # If the KPI has no client-quoted value, default the billable line to the actual hours.
            # This way time tracked still gets billed, and admin can manually override per line.
            quoted = kpi.client_quoted if kpi.client_quoted else round(actual_secs / 3600.0, 2)
            Line.create({
                'invoice_id': self.id,
                'sequence': seq,
                'line_type': 'kpi',
                'kpi_id': kpi_id,
                'description': kpi.name,
                'quoted_hours': quoted,
                'actual_hours': round(actual_secs / 3600.0, 2),
                'contributor_data': json.dumps(contributors),
            })
            seq += 10

        return {'lines_created': len([1 for k in bucket])}

    def action_finalize(self):
        for inv in self:
            if inv.state != 'draft':
                raise ValidationError("Only Draft invoices can be finalized.")
            inv.state = 'finalized'

    def action_send(self):
        for inv in self:
            if inv.state != 'finalized':
                raise ValidationError("Only Finalized invoices can be marked Sent.")
            inv.state = 'sent'

    def action_mark_paid(self, note=''):
        """Mark this invoice as paid. Only valid once the invoice is at least
        Finalized — we shouldn't allow recording payment on a draft.
        """
        for inv in self:
            if inv.state == 'draft':
                raise ValidationError("Finalize the invoice before recording a payment.")
            if inv.payment_status == 'paid':
                # Idempotent: already paid, nothing to do.
                continue
            inv.write({
                'payment_status': 'paid',
                'payment_date':   fields.Datetime.now(),
                'paid_by_id':     self.env.user.id,
                'payment_notes':  (note or '').strip() or False,
            })

    def action_mark_unpaid(self, note=''):
        """Revert a 'paid' invoice back to 'unpaid' (e.g. payment bounced
        or was mis-recorded).  Audit fields are cleared.
        """
        for inv in self:
            if inv.payment_status != 'paid':
                continue
            inv.write({
                'payment_status': 'unpaid',
                'payment_date':   False,
                'paid_by_id':     False,
                'payment_notes':  ((inv.payment_notes or '') +
                                   f"\n[Reverted on {fields.Datetime.now()} by "
                                   f"{self.env.user.name}: {note or 'no note'}]").strip()[:2000],
            })

    def action_reset_draft(self):
        for inv in self:
            inv.state = 'draft'

    def _serialize_for_list(self):
        self.ensure_one()
        return {
            'id': self.id,
            'name': self.name or '',
            'invoice_title': self.invoice_title or '',
            'hourly_rate': round(self.hourly_rate or 0.0, 2),
            'total_amount': round(self.total_amount or 0.0, 2),
            'client_id': self.client_kra_id.id,
            'client_name': self.client_kra_id.name or '',
            'parent_name': self.client_kra_id.parent_id.name or '',
            'from_date': str(self.from_date) if self.from_date else '',
            'to_date': str(self.to_date) if self.to_date else '',
            'invoice_date': str(self.invoice_date) if self.invoice_date else '',
            'state': self.state,
            'payment_status': self.payment_status or 'unpaid',
            'payment_date':   fields.Datetime.to_string(self.payment_date) if self.payment_date else '',
            'paid_by_name':   self.paid_by_id.name or '',
            'total_quoted_hours': round(self.total_quoted_hours or 0.0, 2),
            'total_actual_hours': round(self.total_actual_hours or 0.0, 2),
            'total_adjusted_hours': round(self.total_adjusted_hours or 0.0, 2),
            'grand_total_hours': round(self.grand_total_hours or 0.0, 2),
            'line_count': len(self.line_ids),
        }

    def get_pdf_data(self):
        """Return everything the OWL/jsPDF generator needs to render a PDF invoice.

        Layout convention:
          - Company header (top) = the Odoo company (e.g. '369 ai.Biz') — from res.company
          - Bill To              = the root-level KRA (the CLIENT, e.g. 'Nexgenn')
          - Project line         = the selected client_kra_id (the sub-KRA = project name)
        """
        self.ensure_one()
        company = self.env.company

        # Walk up the KRA tree to find the root (= the billable client entity)
        root = self.client_kra_id
        while root.parent_id:
            root = root.parent_id

        # Company logo from res.company, fall back to root KRA's logo if env company has none
        logo_b64 = ''
        if company.logo:
            raw = company.logo
            logo_b64 = raw.decode() if isinstance(raw, bytes) else raw
        elif root.logo:
            raw = root.logo
            logo_b64 = raw.decode() if isinstance(raw, bytes) else raw

        # Currency info
        cur = self.currency_id or self.client_kra_id.currency_id or root.currency_id
        if not cur:
            cur = self.env.ref('base.USD', raise_if_not_found=False) or self.env['res.currency']
        currency_info = {
            'id': cur.id,
            'name': cur.name or '',
            'symbol': cur.symbol or '',
            'position': cur.position or 'after',
            'decimal_places': cur.decimal_places if hasattr(cur, 'decimal_places') else 2,
        }

        # Project label: the selected client_kra_id (sub-KRA) — shown next to Bill To.
        # When client_kra_id IS already the root, project is blank.
        is_project = bool(self.client_kra_id.parent_id)

        return {
            'invoice': self._serialize_for_ui(),
            'company_name': company.name or '',
            'company_logo_b64': logo_b64,
            'bill_to_name': root.name or '',
            'project_name': self.client_kra_id.name if is_project else '',
            'client_name': root.name or '',  # back-compat for older OWL builds
            'has_rate': bool(self.hourly_rate and self.hourly_rate > 0),
            'currency': currency_info,
        }

    def _serialize_for_ui(self):
        self.ensure_one()
        result = self._serialize_for_list()
        result.update({
            'notes': self.notes or '',
            'project_quoted_hours': round(self.client_kra_id.client_quoted or 0.0, 2),
            'lines': [l._serialize() for l in self.line_ids.sorted(key=lambda l: (l.line_type != 'kpi', l.sequence, l.id))],
            'filter_user_ids': [{'id': u.id, 'name': u.name} for u in self.filter_user_ids],
            'filter_kpi_ids': [{'id': k.id, 'name': k.name} for k in self.filter_kpi_ids],
            'filter_sub_kra_ids': [{'id': k.id, 'name': k.name} for k in self.filter_sub_kra_ids],
            'payment_notes': self.payment_notes or '',
        })
        return result


class KpiClientInvoiceLine(models.Model):
    _name = 'kpi.client.invoice.line'
    _description = 'Client Invoice Line'
    _order = 'invoice_id, line_type desc, sequence, id'

    invoice_id = fields.Many2one(
        'kpi.client.invoice',
        required=True,
        ondelete='cascade',
        index=True,
    )
    sequence = fields.Integer(default=10)
    line_type = fields.Selection(
        [('kpi', 'KPI'), ('adjustment', 'Adjustment')],
        default='kpi',
        required=True,
    )
    kpi_id = fields.Many2one('kra.kpi', string='KPI', ondelete='set null')
    description = fields.Char(required=True)
    quoted_hours = fields.Float(
        string='Quoted Hours',
        default=0.0,
        help='Editable. For KPI lines: defaults to KPI.client_quoted. For adjustments: may be negative.'
    )
    actual_hours = fields.Float(
        string='Actual Hours',
        default=0.0,
        help='Auto-filled from time logs for KPI lines. Read-only display.'
    )
    notes = fields.Text(string='Line Notes')
    contributor_data = fields.Text(
        string='Contributor Data (JSON)',
        help='JSON list: [{user_id, name, hours}, ...] for the per-developer breakdown.'
    )

    def _serialize(self):
        self.ensure_one()
        try:
            contributors = json.loads(self.contributor_data) if self.contributor_data else []
        except (ValueError, TypeError):
            contributors = []
        return {
            'id': self.id,
            'sequence': self.sequence or 0,
            'line_type': self.line_type,
            'kpi_id': self.kpi_id.id if self.kpi_id else False,
            'description': self.description or '',
            'quoted_hours': round(self.quoted_hours or 0.0, 2),
            'actual_hours': round(self.actual_hours or 0.0, 2),
            'notes': self.notes or '',
            'contributors': contributors,
        }
