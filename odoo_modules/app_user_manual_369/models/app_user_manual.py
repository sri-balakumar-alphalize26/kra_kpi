from odoo import _, api, models, fields


class AppUserManual(models.Model):
    _name = 'app.user.manual'
    _description = 'App User Manual'
    # mail.thread powers the chatter on the form so admins can audit who
    # uploaded / replaced / removed which manual document and when.
    _inherit = ['mail.thread']
    # Admin-controlled display order in the app, then newest last.
    _order = 'sequence, id'
    _rec_name = 'name'

    name = fields.Char(string='Title', required=True, tracking=True)
    pdf_file = fields.Binary(
        string='Manual PDF',
        attachment=True,
        tracking=True,
    )
    pdf_filename = fields.Char(string='Filename')
    sequence = fields.Integer(string='Sequence', default=10)
    active = fields.Boolean(string='Active', default=True, tracking=True)
    # Who sees this manual in the app. 'all' = everyone; otherwise only that KRA role.
    role = fields.Selection([
        ('all', 'Everyone'),
        ('developer', 'Developer'),
        ('admin', 'Admin'),
        ('client', 'Client'),
    ], string='Visible To', default='all', required=True, tracking=True)

    @api.model
    def _role_of(self, user):
        """The caller's KRA role: 'admin' | 'client' | 'developer'.

        Reuses res.users.kpi_role — the app's single source of truth — so this
        can never drift from the rest of the KRA/KPI role gating. Falls back to
        the raw group checks only if that field is somehow unavailable.
        """
        role = getattr(user, 'kpi_role', False)
        if role in ('admin', 'client', 'developer'):
            return role
        if (user.has_group('base.group_system')
                or user.has_group('kra_kpi_module.group_kra_owner')
                or user.has_group('kra_kpi_module.group_kra_admin')):
            return 'admin'
        if user.has_group('kra_kpi_module.group_kra_client'):
            return 'client'
        return 'developer'

    def name_get(self):
        # Keep the breadcrumb / picker readable even before a title is typed.
        return [(rec.id, rec.name or _('Document #%s') % rec.id) for rec in self]

    # --- App-facing methods ----------------------------------------------------

    @api.model
    def app_bundle(self):
        """One call for the app's User Manual screen.

        Returns ``{'can_edit': bool, 'role': str, 'manuals': [...]}`` — the
        role-filtered manual list plus whether this user may add / edit /
        delete (admins only). ``role`` lets the app label the Everyone/role
        options sensibly. Keeps the screen to a single round-trip.
        """
        role = self._role_of(self.env.user)
        return {
            'can_edit': role == 'admin',
            'role': role,
            'manuals': self.get_manuals(),
        }

    @api.model
    def get_manuals(self):
        """App-facing list of available manual documents (metadata only).

        Returns a list of ``{'id', 'name', 'filename', 'role'}`` for every
        active document that actually has a PDF — WITHOUT the bytes, so the
        list is light. The app then calls ``get_manual(id)`` for the one the
        user opens. When the module is not installed the RPC errors and the app
        treats it as "no manuals". Uses sudo() so any logged-in user can read
        the shared library regardless of record rules.

        Role filtering (server-side, so a client can never see admin docs):
        - admin/owner/system -> sees ALL manuals (they also manage them);
        - everyone else -> only their own role's manuals + those tagged 'all'.
        """
        role = self._role_of(self.env.user)
        domain = [('pdf_file', '!=', False)]
        if role != 'admin':
            domain.append(('role', 'in', [role, 'all']))
        records = self.sudo().search(domain)
        return [{
            'id': rec.id,
            'name': rec.name or 'User Manual',
            'filename': rec.pdf_filename or (rec.name or 'User Manual') + '.pdf',
            'role': rec.role,
        } for rec in records]

    @api.model
    def get_manual(self, manual_id):
        """App-facing read: one document's PDF as base64.

        Returns ``{'id', 'name', 'filename', 'data'}`` (``data`` is a base64
        string) for the given id, or ``False`` when it is missing / empty or
        not visible to the caller's role.
        """
        record = self.sudo().browse(int(manual_id)).exists()
        if not record or not record.pdf_file:
            return False
        role = self._role_of(self.env.user)
        if role != 'admin' and record.role not in (role, 'all'):
            return False
        data = record.pdf_file
        if isinstance(data, bytes):
            data = data.decode()
        return {
            'id': record.id,
            'name': record.name or 'User Manual',
            'filename': record.pdf_filename or 'User Manual.pdf',
            'data': data,
        }
