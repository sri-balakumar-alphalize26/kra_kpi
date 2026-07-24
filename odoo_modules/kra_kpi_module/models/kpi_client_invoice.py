import json
import logging

from odoo import api, fields, models
from odoo.exceptions import ValidationError

_logger = logging.getLogger(__name__)


def _kind_from_ref(ref):
    """Map a task's external_ref prefix to its billing kind: 'req' / 'upt' / 'bug'
    (or '' if none). Matches the REQ/UPT/BUG prefixes the task-type filter uses."""
    r = (ref or '').strip().upper()
    if r.startswith('REQ'):
        return 'req'
    if r.startswith('UPT'):
        return 'upt'
    if r.startswith('BUG'):
        return 'bug'
    return ''


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
    # Client-side "I've paid" claim: the client can flag that they've paid (which
    # notifies admins to confirm). It does NOT set payment_status — only an admin's
    # Mark Paid does that. Cleared automatically once actually marked paid.
    client_paid_claim = fields.Boolean(
        string='Client Marked Paid', default=False, copy=False,
        help="The client indicated they've paid this invoice; awaiting admin confirmation.")
    client_paid_claim_date = fields.Datetime(string='Client Paid-Claim On', readonly=True, copy=False)
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

    # Billing mode: 'hourly' = grand_total_hours × hourly_rate (the original path,
    # unchanged). 'per_task' = each task priced by its type (REQ/UPT/BUG), summed.
    billing_method = fields.Selection(
        [('hourly', 'Per Hour'), ('per_task', 'Per Task by Type')],
        string='Billing Method', default='hourly', required=True,
        help='Per Hour: total = hours × rate. Per Task: each task priced by its '
             'type (Requirement / Update / Bug); total = sum of task prices.')
    # Per-type prices used by per_task mode (in the invoice's currency, no forex).
    price_req = fields.Float(string='Requirement Price', default=0.0,
        help='Flat price charged for each Requirement (REQ) task in per_task mode.')
    price_upt = fields.Float(string='Update Price', default=0.0,
        help='Flat price charged for each Update (UPT) task in per_task mode.')
    price_bug = fields.Float(string='Bug Price', default=0.0,
        help='Flat price charged for each Bug (BUG) task in per_task mode.')

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

    def _is_locked_line(self, line):
        """A KPI line is 'locked' (already billed elsewhere) only while THIS invoice is a
        DRAFT and the task already sits on a DIFFERENT finalized/sent invoice. Lock is a
        draft-only exclusion — a finalized/sent invoice always counts its OWN lines, so its
        issued total never changes when another invoice later bills a shared task."""
        self.ensure_one()
        return bool(self.state == 'draft' and line.kpi_id and line.kpi_id.is_invoiced
                    and line.kpi_id.invoiced_on_id != self)

    @api.depends('line_ids', 'line_ids.quoted_hours', 'line_ids.actual_hours',
                 'line_ids.line_type', 'line_ids.unit_price', 'hourly_rate', 'billing_method',
                 'line_ids.kpi_id.is_invoiced', 'line_ids.kpi_id.invoiced_on_id', 'state')
    def _compute_totals(self):
        for inv in self:
            kpi_lines = inv.line_ids.filtered(lambda l: l.line_type == 'kpi' and not inv._is_locked_line(l))
            adj_lines = inv.line_ids.filtered(lambda l: l.line_type == 'adjustment')
            inv.total_quoted_hours = sum(kpi_lines.mapped('quoted_hours'))
            inv.total_actual_hours = sum(kpi_lines.mapped('actual_hours'))
            inv.total_adjusted_hours = sum(adj_lines.mapped('quoted_hours'))
            inv.grand_total_hours = inv.total_quoted_hours + inv.total_adjusted_hours
            if inv.billing_method == 'per_task':
                # Each line carries its own flat price; the total sums the billable ones.
                inv.total_amount = sum((kpi_lines + adj_lines).mapped('unit_price'))
            else:
                inv.total_amount = inv.grand_total_hours * (inv.hourly_rate or 0.0)

    def _price_for_kind(self, kind):
        """The per-task price configured on this invoice for a REQ/UPT/BUG kind."""
        self.ensure_one()
        return {'req': self.price_req, 'upt': self.price_upt, 'bug': self.price_bug}.get(kind, 0.0)

    def _apply_type_prices(self):
        """(Re-)price every KPI line by its task type. Called after populate and
        whenever a type price changes, so 'change REQ price → all REQ tasks update'."""
        for inv in self:
            if inv.billing_method != 'per_task':
                continue
            for line in inv.line_ids.filtered(lambda l: l.line_type == 'kpi'):
                line.unit_price = inv._price_for_kind(line.task_kind)

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
            # Only bill work on tasks the CLIENT has signed off as complete.
            ('kpi_id.task_state', '=', 'completed'),
            ('kpi_id.client_final_approved', '=', True),
        ]
        if self.filter_user_ids:
            domain.append(('user_id', 'in', self.filter_user_ids.ids))
        if self.filter_kpi_ids:
            domain.append(('kpi_id', 'in', self.filter_kpi_ids.ids))
        # Filter by task-type prefix (REQ / UPT / BUG, comma-separated).
        type_allowed_ids = None
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
                type_allowed_ids = allowed.ids
                domain.append(('kpi_id', 'in', type_allowed_ids))
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
            # In per_task mode, seed each line's flat price from its task type.
            kind = _kind_from_ref(kpi.external_ref)
            unit_price = self._price_for_kind(kind) if self.billing_method == 'per_task' else 0.0
            Line.create({
                'invoice_id': self.id,
                'sequence': seq,
                'line_type': 'kpi',
                'kpi_id': kpi_id,
                'description': kpi.name,
                'quoted_hours': quoted,
                'actual_hours': round(actual_secs / 3600.0, 2),
                'unit_price': unit_price,
                'contributor_data': json.dumps(contributors),
            })
            seq += 10

        # ── Second pass (task-driven) ──────────────────────────────────────────
        # Include the client's tasks that had NO time logs in range, so per-task /
        # estimated billing can still price them. Purely ADDITIVE: only creates a
        # line for a task the log pass didn't already add, with actual_hours = 0
        # (a 0-hour line adds 0 to an hourly total, so nothing existing changes).
        Kpi = self.env['kra.kpi']
        # Same rule as the time-log domain above: an invoice may only ever list
        # tasks the client has signed off.  Without these two clauses every
        # active task under the client was offered for billing, including
        # in-progress and never-approved ones.
        task_domain = [('kra_id', 'in', kra_ids), ('active', '=', True),
                       ('task_state', '=', 'completed'),
                       ('client_final_approved', '=', True)]
        if self.filter_kpi_ids:
            task_domain.append(('id', 'in', self.filter_kpi_ids.ids))
        if type_allowed_ids is not None:
            task_domain.append(('id', 'in', type_allowed_ids))
        candidate_tasks = self.env['kra.kpi'].search(task_domain)
        if self.filter_user_ids:
            wanted = set(self.filter_user_ids.ids)
            candidate_tasks = candidate_tasks.filtered(
                lambda t: wanted & set(t.effective_contributor_ids.ids))
        for kpi in candidate_tasks.sorted('id'):
            if kpi.id in bucket:
                continue  # already billed from its own time logs above
            kind = _kind_from_ref(kpi.external_ref)
            unit_price = self._price_for_kind(kind) if self.billing_method == 'per_task' else 0.0
            Line.create({
                'invoice_id': self.id,
                'sequence': seq,
                'line_type': 'kpi',
                'kpi_id': kpi.id,
                'description': kpi.name,
                'quoted_hours': kpi.client_quoted or 0.0,
                'actual_hours': 0.0,
                'unit_price': unit_price,
                'contributor_data': json.dumps([]),
            })
            seq += 10

        return {'lines_created': len(self.line_ids.filtered(lambda l: l.line_type == 'kpi'))}

    def _fire_invoice_notification(self, event, user_ids=None):
        """Fire an app-only notification for this invoice (push + in-app feed).
        `_notify` lives on kra.kpi, so we anchor on any task and thread the invoice
        id (→ tap-through) + recipients through context/extra_users — the same
        pattern as kpi.daily.report._notify_admins. Never raises."""
        self.ensure_one()
        try:
            anchor = self.env['kra.kpi'].sudo().search([], order='id desc', limit=1)
            if not anchor:
                _logger.info("invoice notify: no kra.kpi to anchor; skipping %s", event)
                return
            anchor.with_context(kpi_invoice_id=self.id)._notify(
                event, extra_users=list(user_ids or []), name=self.name or '')
        except Exception as exc:
            _logger.warning("invoice %s notify failed: %s", event, exc)

    def action_finalize(self):
        for inv in self:
            if inv.state != 'draft':
                raise ValidationError("Only Draft invoices can be finalized.")
            # Double-billing guard: drop any line whose task is already billed on
            # another finalized/sent invoice, so nothing is billed twice.
            locked = inv.line_ids.filtered(lambda l: inv._is_locked_line(l))
            if locked:
                locked.unlink()
            inv.state = 'finalized'
            # The invoice is now visible to the client — tell them it's ready.
            inv._fire_invoice_notification('invoice_ready', inv.client_kra_id.client_user_ids.ids)

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
                'client_paid_claim': False,   # confirmed → clear any pending client claim
            })
            # Receipt confirmation to the client.
            inv._fire_invoice_notification('invoice_paid', inv.client_kra_id.client_user_ids.ids)

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
            # Guard the double-billing lock: resetting to draft unlocks this invoice's
            # tasks (is_invoiced recomputes False), so they could be billed again. Never
            # allow that once the client has the invoice or has paid.
            if inv.payment_status == 'paid':
                raise ValidationError(
                    "Invoice %s is marked PAID — it can't be reset to draft (that would let "
                    "already-paid work be billed again). Mark it Unpaid first if a correction "
                    "is genuinely needed." % (inv.name or ''))
            if inv.state == 'sent':
                raise ValidationError(
                    "Invoice %s has already been sent to the client — it can't be reset to "
                    "draft. Only a finalized (un-sent) invoice can go back to draft." % (inv.name or ''))
            inv.state = 'draft'

    def _serialize_for_list(self):
        self.ensure_one()
        return {
            'id': self.id,
            'name': self.name or '',
            'invoice_title': self.invoice_title or '',
            'hourly_rate': round(self.hourly_rate or 0.0, 2),
            'billing_method': self.billing_method or 'hourly',
            'price_req': round(self.price_req or 0.0, 2),
            'price_upt': round(self.price_upt or 0.0, 2),
            'price_bug': round(self.price_bug or 0.0, 2),
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

        # Logo: use the Company Branding logo (res.company.logo) first, so the invoice
        # and the daily task report share one branding source; fall back to a client-set
        # root-KRA logo, then the module's bundled brand logo. An unset company logo is
        # falsy here, so a fresh company skips straight to the fallbacks rather than
        # showing the Odoo "Your logo" placeholder.
        logo_b64 = ''
        # Skip Odoo's default placeholder (uses_default_logo) so a company that hasn't
        # uploaded a Company Branding logo falls through to the bundled brand logo
        # rather than printing the "Your logo" placeholder.
        branding_logo = company.logo if not company.uses_default_logo else False
        for candidate in (branding_logo, root.logo):
            if candidate:
                logo_b64 = candidate.decode() if isinstance(candidate, bytes) else candidate
                break
        if not logo_b64:
            try:
                import base64
                from odoo.tools import file_open
                with file_open('kra_kpi_module/static/src/img/alphalize_logo.png', 'rb') as f:
                    logo_b64 = base64.b64encode(f.read()).decode()
            except Exception:
                logo_b64 = ''

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
            # Per-task invoices also carry amounts — the PDF shows a Price column then.
            'has_amount': bool(
                (self.billing_method == 'per_task' and self.total_amount)
                or (self.hourly_rate and self.hourly_rate > 0)
            ),
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
            'client_paid_claim': self.client_paid_claim,
            'client_paid_claim_date': fields.Datetime.to_string(self.client_paid_claim_date) if self.client_paid_claim_date else '',
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
    unit_price = fields.Float(
        string='Unit Price',
        default=0.0,
        help='Per-task flat price. Used when the invoice bills Per Task by Type.'
    )
    task_kind = fields.Char(
        string='Task Kind',
        compute='_compute_task_kind', store=True,
        help="'req' / 'upt' / 'bug' derived from the task's external_ref prefix; "
             "drives the default per-type price."
    )
    notes = fields.Text(string='Line Notes')

    @api.depends('kpi_id', 'kpi_id.external_ref')
    def _compute_task_kind(self):
        for line in self:
            line.task_kind = _kind_from_ref(line.kpi_id.external_ref if line.kpi_id else '')
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
        # Locked = task billed on a DIFFERENT finalized/sent invoice, and THIS invoice is
        # still a draft (only drafts red-flag/exclude already-billed lines — finalized
        # invoices are frozen and show every line normally).
        locked = bool(self.invoice_id.state == 'draft' and self.kpi_id and self.kpi_id.is_invoiced
                      and self.kpi_id.invoiced_on_id != self.invoice_id)
        return {
            'id': self.id,
            'sequence': self.sequence or 0,
            'line_type': self.line_type,
            'kpi_id': self.kpi_id.id if self.kpi_id else False,
            'description': self.description or '',
            'quoted_hours': round(self.quoted_hours or 0.0, 2),
            'actual_hours': round(self.actual_hours or 0.0, 2),
            'unit_price': round(self.unit_price or 0.0, 2),
            'task_kind': self.task_kind or '',
            'notes': self.notes or '',
            'contributors': contributors,
            'already_invoiced': locked,
            'invoiced_on': (self.kpi_id.invoiced_on_id.name or '') if locked else '',
        }
