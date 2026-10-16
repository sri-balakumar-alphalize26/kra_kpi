import json
import logging
import re
from html import unescape as html_unescape

from odoo import api, fields, models
from odoo.exceptions import ValidationError

_logger = logging.getLogger(__name__)

# How money moved. Shared by the admin's confirmation and the client's claim so the two
# are directly comparable — if a client says "cash" and the admin confirms "bank
# transfer", that difference is visible rather than buried in free text.
PAYMENT_METHODS = [
    ('bank_transfer', 'Bank Transfer'),
    ('cash', 'Cash'),
    ('cheque', 'Cheque'),
    ('card', 'Card'),
    ('other', 'Other'),
]


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
    # Why a confirmed payment was reversed. Deliberately NOT payment_notes: that field
    # carries internal remarks and is withheld from the client — and the client is
    # precisely the person who needs to know their payment was put back to Due. Kept
    # separate for the same reason the client's payment details are kept separate from
    # the admin's: one of the two is publishable and the other is not.
    unpaid_reason = fields.Char(
        string='Reversal Reason', copy=False,
        help="Why a paid invoice was put back to Due. Shown to the client.")
    unpaid_on = fields.Datetime(string='Reverted On', readonly=True, copy=False)
    payment_method = fields.Selection(
        PAYMENT_METHODS, string='Payment Method', copy=False,
        help='How the payment actually arrived, recorded by the admin who confirmed it.')
    # Client-side "I've paid" claim: the client can flag that they've paid (which
    # notifies admins to confirm). It does NOT set payment_status — only an admin's
    # Mark Paid does that. Cleared automatically once actually marked paid.
    client_paid_claim = fields.Boolean(
        string='Client Marked Paid', default=False, copy=False,
        help="The client indicated they've paid this invoice; awaiting admin confirmation.")
    client_paid_claim_date = fields.Datetime(string='Client Paid-Claim On', readonly=True, copy=False)
    # The client's OWN account of the payment, kept separate from the admin fields above
    # on purpose. Sharing one pair would let the admin's confirmation overwrite what the
    # client said, and both halves are worth keeping: "client says bank transfer, ref
    # 4417" and "confirmed, arrived short by 5" tell different parts of the story.
    client_paid_method = fields.Selection(
        PAYMENT_METHODS, string='Client-Stated Method', copy=False,
        help='How the client says they paid. Their claim, not a confirmation.')
    client_paid_notes = fields.Text(
        string='Client Payment Note', copy=False,
        help='Optional reference or note the client supplied with their payment claim.')

    # ── Revision trail ────────────────────────────────────────────────────────
    # action_reset_draft records nothing, so a reduced invoice used to change with no
    # trace of who did it or why. The client may be holding a PDF with the old figure.
    revised_on = fields.Datetime(string='Last Revised On', readonly=True, copy=False)
    revision_reason = fields.Char(string='Revision Reason', readonly=True, copy=False)
    revision_count = fields.Integer(string='Times Revised', default=0, readonly=True, copy=False)
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

        # Tasks already carried by ANY other invoice — draft included. Excluding these is
        # what stops a billed task being offered again, and it has to be membership of an
        # invoice line rather than the `is_invoiced` flag: that flag only turns on once an
        # invoice reaches finalized/sent, so two concurrent DRAFTS would each bill the same
        # task at full value with nothing to stop them.
        #
        # Deliberately not date-based. /kpi_client_invoice/create is also called from the
        # Owner Dashboard, which hardcodes 2000-01-01 → 2099-12-31 (services/ownerDashboard.js),
        # so a date filter alone would never exclude anything on that path.
        already_billed_ids = self.env['kpi.client.invoice.line'].search([
            ('kpi_id', '!=', False),
            ('invoice_id', '!=', self.id),
        ]).mapped('kpi_id').ids

        domain = [
            ('is_active', '=', False),
            ('work_date', '>=', self.from_date),
            ('work_date', '<=', self.to_date),
            ('kpi_id.kra_id', 'in', kra_ids),
            # Only bill work on tasks the CLIENT has signed off as complete.
            ('kpi_id.task_state', '=', 'completed'),
            ('kpi_id.client_final_approved', '=', True),
            ('kpi_id', 'not in', already_billed_ids),
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
        #
        # `id not in already_billed_ids` is the de-duplication: without it this pass
        # re-offered every task the client had ever signed off, on every invoice, forever.
        task_domain = [('kra_id', 'in', kra_ids), ('active', '=', True),
                       ('task_state', '=', 'completed'),
                       ('client_final_approved', '=', True),
                       ('id', 'not in', already_billed_ids)]
        if self.filter_kpi_ids:
            task_domain.append(('id', 'in', self.filter_kpi_ids.ids))
        if type_allowed_ids is not None:
            task_domain.append(('id', 'in', type_allowed_ids))
        candidate_tasks = self.env['kra.kpi'].search(task_domain)

        # This pass had NO date filter at all, so an invoice dated 2020 happily pulled in
        # tasks completed in 2026. Sign-off is the right anchor — a task with no time logs
        # in range has no work_date to filter on, and sign-off is the moment it became
        # billable. Filtered in Python rather than the domain so the fallback below stays
        # readable: if a task somehow reached client_final_approved without a signing
        # timestamp, fall back to its completion date instead of silently dropping it.
        # Dropping a billable task is a worse failure than including a borderline one.
        def _in_period(t):
            stamp = t.client_signed_datetime or t.completion_date
            if not stamp:
                return True
            return self.from_date <= stamp.date() <= self.to_date
        candidate_tasks = candidate_tasks.filtered(_in_period)

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

        created = len(self.line_ids.filtered(lambda l: l.line_type == 'kpi'))
        result = {'lines_created': created}
        if not created:
            # An empty invoice is the confusing case: the UI used to show a bare
            # "No lines yet." while the server knew exactly which gate rejected
            # every task. Only computed when there is nothing to bill, so the
            # normal path pays nothing for it.
            result['empty_reasons'] = self._diagnose_empty(kra_ids, already_billed_ids,
                                                           type_allowed_ids)
        return result

    def _diagnose_empty(self, kra_ids, already_billed_ids, type_allowed_ids):
        """Plain-language reasons why nothing was billable, most useful first.

        Each task is attributed to the FIRST gate that rejected it, walking the gates
        in the order populate applies them, so the counts sum to the candidate pool
        instead of double-counting a task that fails several at once.
        """
        self.ensure_one()
        Kpi = self.env['kra.kpi'].sudo()
        tasks = Kpi.search([('kra_id', 'in', kra_ids), ('active', '=', True)])
        if not tasks:
            return ["This client has no tasks yet."]

        unsigned = billed = out_of_period = wrong_type = 0
        holders = {}   # invoice name -> state, so the message can name what to delete
        for t in tasks:
            if t.task_state != 'completed' or not t.client_final_approved:
                unsigned += 1
            elif t.id in already_billed_ids:
                billed += 1
                for line in t.invoice_line_ids:
                    if line.invoice_id and line.invoice_id != self:
                        holders[line.invoice_id.name or '?'] = line.invoice_id.state
            elif type_allowed_ids is not None and t.id not in type_allowed_ids:
                wrong_type += 1
            else:
                stamp = t.client_signed_datetime or t.completion_date
                if stamp and not (self.from_date <= stamp.date() <= self.to_date):
                    out_of_period += 1

        reasons = []
        if unsigned:
            reasons.append(
                "%s task%s still waiting for the client to sign off — they become "
                "billable as soon as the client approves them in their portal."
                % (unsigned, '' if unsigned == 1 else 's'))
        if billed:
            # Name the holders: "already on another invoice" is true but useless if
            # you cannot tell WHICH one to delete. Drafts are the actionable case.
            where = ', '.join('%s (%s)' % (n, s) for n, s in sorted(holders.items())[:5])
            tail = (" — on %s. Delete that draft to free the work." % where) if where else "."
            reasons.append(
                "%s task%s already on another invoice%s"
                % (billed, ' is' if billed == 1 else 's are', tail))
        if out_of_period:
            reasons.append(
                "%s signed-off task%s outside %s → %s. Widen the date range to include them."
                % (out_of_period, ' falls' if out_of_period == 1 else 's fall',
                   self.from_date, self.to_date))
        if wrong_type:
            reasons.append(
                "%s task%s excluded by the REQ / UPT / BUG filter."
                % (wrong_type, ' was' if wrong_type == 1 else 's were'))
        if not reasons:
            reasons.append("No completed, signed-off work found for this period.")
        return reasons

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
            # _effective_client_users falls back to the parent KRA: an invoice raised
            # against a level-2 project has no client users of its own, so this
            # notified nobody at all before.
            inv._fire_invoice_notification(
                'invoice_ready', inv.client_kra_id._effective_client_users().ids)

    def action_send(self):
        for inv in self:
            if inv.state != 'finalized':
                raise ValidationError("Only Finalized invoices can be marked Sent.")
            inv.state = 'sent'

    def _billed_tasks(self):
        """The tasks this invoice actually bills. Used to archive them on payment."""
        self.ensure_one()
        return self.line_ids.mapped('kpi_id').filtered(lambda k: k)

    def action_mark_paid(self, note='', method=''):
        """Mark this invoice as paid. Only valid once the invoice is at least
        Finalized — we shouldn't allow recording payment on a draft.

        `method` is required: an invoice that is paid but does not say how leaves
        nothing to reconcile against a bank statement later.
        """
        method = (method or '').strip()
        valid = dict(PAYMENT_METHODS)
        if method and method not in valid:
            raise ValidationError("Unknown payment method '%s'." % method)
        if not method:
            # No method supplied → record it as Other rather than refusing.
            #
            # The UIs make it a required choice, but app builds already on people's
            # phones predate the field and send nothing. Refusing here would mean an
            # admin simply cannot mark an invoice paid from the phone until every
            # device is updated — and a payment that can't be recorded is a worse
            # outcome than one recorded as "Other". Drop this default once the fleet
            # is on a build that sends the method.
            method = 'other'
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
                'payment_method': method,
                'client_paid_claim': False,   # confirmed → clear any pending client claim
                # A fresh payment settles the previous reversal; leaving the banner up
                # would tell the client it is still in dispute.
                'unpaid_reason': False,
                'unpaid_on': False,
            })
            # Paid work is finished work: file its tasks away so day-to-day lists show
            # only what is still live. Nothing is destroyed — every hour, log and invoice
            # line survives, and action_mark_unpaid puts them straight back.
            tasks = inv._billed_tasks()
            if tasks:
                tasks.sudo().write({'active': False})
                _logger.info("invoice %s paid → archived %s task(s)", inv.name, len(tasks))
            # Receipt confirmation to the client.
            inv._fire_invoice_notification(
                'invoice_paid', inv.client_kra_id._effective_client_users().ids)

    def action_mark_unpaid(self, note=''):
        """Revert a 'paid' invoice back to 'unpaid' (e.g. payment bounced
        or was mis-recorded).  Audit fields are cleared.

        The reason is REQUIRED and is published to the client. Telling someone their
        settled invoice is due again without saying why is how a payment dispute
        starts; enforced here rather than only in the dialog, because the dialog is
        one caller of several (the app and call_kw reach this too).
        """
        reason = (note or '').strip()
        if not reason:
            raise ValidationError(
                "Give a reason for reverting this payment — the client is told the "
                "invoice is due again and sees the reason.")
        for inv in self:
            if inv.payment_status != 'paid':
                continue
            inv.write({
                'payment_status': 'unpaid',
                'payment_date':   False,
                'paid_by_id':     False,
                'payment_method': False,
                'unpaid_reason':  reason[:255],
                'unpaid_on':      fields.Datetime.now(),
                'payment_notes':  ((inv.payment_notes or '') +
                                   f"\n[Reverted on {fields.Datetime.now()} by "
                                   f"{self.env.user.name}: {reason}]").strip()[:2000],
            })
            # Un-archive what marking it paid filed away. Without this, reversing a
            # mistaken payment would leave the tasks invisible with no way back.
            # active_test=False because they are archived — a plain read finds nothing.
            tasks = inv.with_context(active_test=False)._billed_tasks()
            if tasks:
                tasks.sudo().write({'active': True})
                _logger.info("invoice %s un-paid → restored %s task(s)", inv.name, len(tasks))

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
            if inv.client_paid_claim:
                raise ValidationError(self._claim_lock_message(inv, 'reset to draft'))
            inv.state = 'draft'

    @staticmethod
    def _claim_lock_message(inv, what):
        """Why an amount is frozen while the client says they have paid.

        Once a client reports payment they have sent money against a specific
        figure. Changing it underneath them turns a settled bill into a dispute,
        so the amount stays put until the claim is resolved either way.
        """
        return ("Invoice %s has a payment claim from the client awaiting confirmation, "
                "so it can't be %s. Confirm the payment, or clear the claim if the money "
                "never arrived." % (inv.name or '', what))

    def action_revise(self, reason=''):
        """Reopen a FINALIZED invoice so its amount can be reduced, then re-finalized.

        Deliberately stricter than action_reset_draft, and with its own state check
        rather than leaning on that one:
          * `finalized` only. Not `sent` — the client already has that document, and it
            should not change under them. Not `paid` — the money has arrived. Not while
            a client payment claim is open — they have sent money against this exact
            figure, and it must not move until the claim is confirmed or cleared.
          * a reason is required, because the client will be told the figure changed and
            "it just changed" is not an answer.

        Reopening is safe against double-billing: the invoice keeps its lines while in
        draft, and the billing de-dup excludes any task already sitting on an invoice
        line regardless of that invoice's state.
        """
        reason = (reason or '').strip()
        if not reason:
            raise ValidationError("Give a reason for revising this invoice — the client is told it changed.")
        for inv in self:
            if inv.payment_status == 'paid':
                raise ValidationError(
                    "Invoice %s is marked PAID and can't be revised. Mark it Unpaid first "
                    "if a correction is genuinely needed." % (inv.name or ''))
            if inv.client_paid_claim:
                raise ValidationError(self._claim_lock_message(inv, 'revised'))
            if inv.state != 'finalized':
                raise ValidationError(
                    "Only a finalized invoice can be revised — %s is %s." %
                    (inv.name or '', inv.state or 'draft'))
            inv.write({
                'state': 'draft',
                'revised_on': fields.Datetime.now(),
                'revision_reason': reason[:255],
                'revision_count': (inv.revision_count or 0) + 1,
            })
            _logger.info("invoice %s revised by %s: %s", inv.name, self.env.user.login, reason)

    def _resolve_currency(self):
        """The invoice's currency: its own, else the project's, else the root
        client KRA's, else USD. One resolver for the PDF and the list/detail
        serializers, so the list can never show a different symbol than the PDF."""
        self.ensure_one()
        root = self.client_kra_id
        while root.parent_id:
            root = root.parent_id
        cur = self.currency_id or self.client_kra_id.currency_id or root.currency_id
        if not cur:
            cur = self.env.ref('base.USD', raise_if_not_found=False) or self.env['res.currency']
        return cur

    def _serialize_for_list(self, for_client=False):
        """`for_client=True` strips the internal payment-record fields.

        Same contract as _serialize_for_ui below, and it has to live here too:
        these two keys are built in this dict, so a guard that only runs after
        this method returns would be defeated by the very fields it is meant to
        remove. `paid_by_name` in particular carries exactly what `paid_by`
        carries, and `paid_by` was already being stripped — so a client was told
        which member of staff recorded their payment through the sibling field.
        """
        self.ensure_one()
        result = {
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
            # Drives the "Payment claimed — awaiting confirmation" row state on both
            # sides. A boolean, not a payment_status value: nothing is part-settled, the
            # client has claimed the full amount and nobody has verified it yet.
            'client_paid_claim': self.client_paid_claim,
            # On the LIST too, not just the detail: a client scanning their invoices
            # should see which one went back to Due without opening each.
            'unpaid_reason': self.unpaid_reason or '',
            'unpaid_on': fields.Datetime.to_string(self.unpaid_on) if self.unpaid_on else '',
            'revision_count': self.revision_count or 0,
            'total_quoted_hours': round(self.total_quoted_hours or 0.0, 2),
            'total_actual_hours': round(self.total_actual_hours or 0.0, 2),
            'total_adjusted_hours': round(self.total_adjusted_hours or 0.0, 2),
            'grand_total_hours': round(self.grand_total_hours or 0.0, 2),
            'line_count': len(self.line_ids),
        }
        # Same resolution as the PDF (get_pdf_data). The list had no currency at
        # all, so the web and the app fell back to a hard-coded symbol.
        cur = self._resolve_currency()
        result['currency_id'] = cur.id or False
        result['currency_symbol'] = cur.symbol or ''
        result['currency_position'] = cur.position or 'after'
        if for_client:
            # WHO settled it and WHEN it was recorded are ours, not theirs. The
            # client already sees the Paid badge; the staff name behind it is
            # internal, and both the web and the app only ever render these
            # inside admin-gated blocks — so removing them costs no reader.
            result.pop('paid_by_name', None)
            result.pop('payment_date', None)
        return result

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
        cur = self._resolve_currency()
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

    def _notes_as_text(self):
        """Overall Notes as the plain text somebody actually typed.

        The field is Html, so Odoo wraps a typed paragraph in <p>…</p> on write. OWL's
        t-out only renders raw markup for a value flagged as such — a plain string is
        escaped — so the client was reading "<p>How about this one</p>", tags and all.
        Converting here rather than in the template keeps the app and any other caller
        on the same text.
        """
        self.ensure_one()
        raw = self.notes or ''
        if not raw:
            return ''
        # Block ends become line breaks BEFORE tags are stripped, or every paragraph
        # would run into the next one — which is the "big para" complaint.
        text = re.sub(r'(?i)<br\s*/?>', '\n', raw)
        text = re.sub(r'(?i)</p\s*>|</div\s*>|</li\s*>', '\n', text)
        text = re.sub(r'(?i)<li[^>]*>', '• ', text)
        text = re.sub(r'<[^>]+>', '', text)
        text = html_unescape(text)
        # Odoo's wrapper leaves a trailing newline of its own; collapse runs of three
        # or more so deliberate blank lines survive but artefacts do not.
        text = re.sub(r'\n{3,}', '\n\n', text)
        return text.strip()

    def _serialize_for_ui(self, for_client=False):
        """`for_client=True` strips anything the client must not read.

        The admin's confirmation note routinely carries internal remarks — "chased
        twice", "arrived short by 5, wrote off". Withholding it has to happen HERE and
        not by hiding a field in the OWL template: a client can read the JSON response
        straight out of the browser, so a template-only guard hides nothing at all.
        """
        self.ensure_one()
        # Pass the flag DOWN — the strip at the bottom of this method cannot reach
        # keys the list serializer builds, and that is where paid_by_name lives.
        result = self._serialize_for_list(for_client=for_client)
        result.update({
            'notes': self._notes_as_text(),
            'project_quoted_hours': round(self.client_kra_id.client_quoted or 0.0, 2),
            'lines': [l._serialize() for l in self.line_ids.sorted(key=lambda l: (l.line_type != 'kpi', l.sequence, l.id))],
            'filter_user_ids': [{'id': u.id, 'name': u.name} for u in self.filter_user_ids],
            'filter_kpi_ids': [{'id': k.id, 'name': k.name} for k in self.filter_kpi_ids],
            'filter_sub_kra_ids': [{'id': k.id, 'name': k.name} for k in self.filter_sub_kra_ids],
            'client_paid_claim': self.client_paid_claim,
            'client_paid_claim_date': fields.Datetime.to_string(self.client_paid_claim_date) if self.client_paid_claim_date else '',
            # The client's own submission — shown back to them so they can see their
            # claim registered, rather than tapping Paid into silence and claiming again.
            'client_paid_method': self.client_paid_method or '',
            'client_paid_method_label': dict(PAYMENT_METHODS).get(self.client_paid_method, ''),
            'client_paid_notes': self.client_paid_notes or '',
            # Both sides may know an invoice was revised and why — that is the whole
            # point of telling them.
            'revised_on': fields.Datetime.to_string(self.revised_on) if self.revised_on else '',
            'revision_reason': self.revision_reason or '',
            'revision_count': self.revision_count or 0,
        })
        if not for_client:
            result.update({
                'payment_notes': self.payment_notes or '',
                'payment_method': self.payment_method or '',
                'payment_method_label': dict(PAYMENT_METHODS).get(self.payment_method, ''),
                'paid_by': self.paid_by_id.name or '',
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
            # What the client wrote in the Review & Sign popup when they accepted this
            # task. It lived only on the task, so at billing time — the moment someone
            # is checking what they are charging for — the client's own words about the
            # work were nowhere to be seen. Read-only here; the task owns it.
            'client_signoff_notes': (self.kpi_id.client_approval_notes or '') if self.kpi_id else '',
            'client_signed_by': (self.kpi_id.client_signature_text or '') if self.kpi_id else '',
        }
