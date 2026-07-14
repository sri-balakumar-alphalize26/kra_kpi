from odoo import api, models, fields
from odoo.exceptions import ValidationError


class KraMaster(models.Model):
    _name = "kra.master"
    _description = "KRA / Sub KRA Master"
    _rec_name = "name"

    name = fields.Char(string="KRA Name", required=True)

    is_sub = fields.Boolean(string="Is Sub KRA?", default=False)

    parent_id = fields.Many2one(
        "kra.master",
        string="Parent KRA",
        ondelete="cascade"
    )

    child_ids = fields.One2many(
        "kra.master",
        "parent_id",
        string="Sub KRAs"
    )

    # KPIs linked to this KRA
    kpi_ids = fields.One2many(
        "kra.kpi",
        "kra_id",
        string="KPIs"
    )

    sequence = fields.Integer(string="Sequence", default=10)

    active = fields.Boolean(string="Active", default=True)

    # Auto-flagged for level-2 KRAs (children of a root). readonly=False so admins can override.
    is_client = fields.Boolean(
        string="Is Billable Client",
        compute='_compute_is_client',
        store=True,
        readonly=False,
        help="Auto-true for level-2 KRAs (children of a root). Override manually if needed."
    )

    client_quoted_hours = fields.Integer(string="Project Quoted Hours", default=0)
    client_quoted_minutes = fields.Integer(string="Project Quoted Minutes", default=0)
    client_quoted = fields.Float(
        string="Project Quoted Time",
        compute='_compute_client_quoted',
        store=True,
        help="Total quoted hours = client_quoted_hours + client_quoted_minutes/60."
    )

    # Portal users on the client side who can read this KRA's finalized invoices + KPI list.
    client_user_ids = fields.Many2many(
        'res.users',
        'kra_master_client_user_rel',
        'kra_id',
        'user_id',
        string='Client Portal Users',
        help="Users with the Client role authorized to view this client's invoices and KPIs."
    )

    # Company-style logo (used by invoice PDFs). Typically set on root KRAs.
    logo = fields.Binary(string='Logo', attachment=True,
        help='Logo image used on invoice PDFs. Set this on the root KRA (your company).')

    # Per-client billing currency. Falls back to USD if not set.
    currency_id = fields.Many2one('res.currency', string='Billing Currency',
        help="Default currency used when generating invoices for this client.")

    @api.depends('parent_id', 'parent_id.parent_id')
    def _compute_is_client(self):
        """A KRA is a billable Client when:
          * it has NO parent (root-level — new convention: client at top), OR
          * its parent has no parent (level-2 — legacy convention).
        Either way, admins can flip the flag manually since readonly=False.
        """
        for r in self:
            if not r.parent_id:
                # Root-level KRAs are clients by default.
                r.is_client = True
            elif not r.parent_id.parent_id:
                # Legacy level-2 client (child of a root org container).
                r.is_client = True
            else:
                # Deeper than level-2 → it's a project or sub-project, not a client.
                r.is_client = False

    @api.depends('client_quoted_hours', 'client_quoted_minutes')
    def _compute_client_quoted(self):
        for r in self:
            r.client_quoted = (r.client_quoted_hours or 0) + (r.client_quoted_minutes or 0) / 60.0

    @api.constrains('client_quoted_minutes')
    def _check_client_quoted_minutes(self):
        for r in self:
            if r.client_quoted_minutes < 0 or r.client_quoted_minutes > 59:
                raise ValidationError("Project Quoted Minutes must be between 0 and 59")

    def _get_descendant_ids(self):
        """Return list of this KRA's id plus all descendant KRA ids (recursive)."""
        self.ensure_one()
        ids = [self.id]
        children = self.search([('parent_id', '=', self.id)])
        for c in children:
            ids.extend(c._get_descendant_ids())
        return ids

    def get_nearest_client_kra(self):
        """Walk up parent chain until finding a KRA with is_client=True. Returns recordset (may be empty)."""
        self.ensure_one()
        cur = self
        while cur:
            if cur.is_client:
                return cur
            cur = cur.parent_id
        return self.env['kra.master']

    @api.model
    def get_parent_kras(self):
        records = self.search([], order='sequence')
        return [{'id': r.id, 'name': r.name} for r in records]

    @api.model
    def create_kra(self, vals):
        # Accept either a dict or a list containing a dict
        if isinstance(vals, (list, tuple)) and vals:
            vals = vals[0]
        vals = vals or {}

        # Get the name and parent_id from vals
        kra_name = vals.get('name', '').strip()
        parent_id = vals.get('parent_id')

        # Check if name is provided
        if not kra_name:
            raise ValidationError("KRA name is required")

        # Check for duplicate KRA names
        # Case 1: If it's a main KRA (no parent), check against all main KRAs
        if not parent_id:
            existing = self.search([
                ('name', '=ilike', kra_name),
                ('parent_id', '=', False)
            ], limit=1)
            if existing:
                raise ValidationError(f"This KRA already exists: '{kra_name}'")

        # Case 2: If it's a sub-KRA, check against sub-KRAs with the same parent
        else:
            existing = self.search([
                ('name', '=ilike', kra_name),
                ('parent_id', '=', parent_id)
            ], limit=1)
            if existing:
                raise ValidationError(f"This Sub-KRA already exists under the selected parent: '{kra_name}'")

        is_sub = True if parent_id else False

        create_vals = {
            'name':      kra_name,
            'parent_id': parent_id or False,
            'sequence':  vals.get('sequence', 10),
            'active':    vals.get('active', True),
            'is_sub':    is_sub,
        }
        # Optional inline client assignment — only meaningful for is_client KRAs
        # (root / level-2).  Sub-sub KRAs inherit via the walk-up to the
        # ancestor client KRA, so we ignore the param when this is a sub-KRA.
        raw_cuids = vals.get('client_user_ids') or []
        if raw_cuids and not is_sub:
            clean = []
            for u in raw_cuids:
                try:
                    clean.append(int(u))
                except (TypeError, ValueError):
                    pass
            if clean:
                create_vals['client_user_ids'] = [(6, 0, clean)]

        rec = self.create(create_vals)
        return rec.id

    @api.model
    def get_kra_tree(self):
        kras = self.search([], order='sequence')
        kpis = self.env['kra.kpi'].search([])

        mapping = {}
        for r in kras:
            mapping[r.id] = {
                'id': r.id,
                'name': r.name,
                'parent': r.parent_id.id if r.parent_id else None,
                'parent_id': r.parent_id.id if r.parent_id else False,
                'is_client': bool(r.is_client),
                'client_user_ids': [
                    {'id': u.id, 'name': u.name or u.login, 'login': u.login}
                    for u in r.client_user_ids
                ],
                'child_ids': [],
                'kpi_ids': [],
            }

        for k in kpis:
            kra_id = k.kra_id.id if k.kra_id else None
            if kra_id and kra_id in mapping:
                mapping[kra_id]['kpi_ids'].append({
                    'id': k.id,
                    'name': k.name,
                    'has_user_manual': bool(k.user_manual_ids),
                    'manual_count': len(k.user_manual_ids)
                })

        roots = []
        for node in mapping.values():
            if node['parent'] and node['parent'] in mapping:
                mapping[node['parent']]['child_ids'].append(node)
            else:
                roots.append(node)

        return roots
