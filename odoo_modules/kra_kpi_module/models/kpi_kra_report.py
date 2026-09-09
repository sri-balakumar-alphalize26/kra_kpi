from odoo import models, fields, api
from datetime import datetime, timedelta
from dateutil.relativedelta import relativedelta


class KpiKraReport(models.TransientModel):
    """
    KRA Report - Shows KPIs with full hierarchical KRA path structure
    Fields: KRA Path, Sub KRA, KPI Name, Employee Name, Time Worked (hours)
    """
    _name = 'kpi.kra.report'
    _description = 'KRA Report with Hierarchical Structure'

    # Filters
    from_date = fields.Date(string='From Date', required=True, default=fields.Date.today)
    to_date = fields.Date(string='To Date', required=True, default=fields.Date.today)
    employee_id = fields.Many2one('res.users', string='Employee')
    kra_id = fields.Many2one('kra.master', string='KRA')

    # Multi-select include / exclude. A client such as Nexgenn owns several
    # sub-clients (Van Sale, Golden Spoon, ...) as child KRAs, and a single
    # report often needs "this client except that one sub-client", or two
    # unrelated sub-clients together — neither of which kra_id alone can say.
    # kra_id is kept so any caller still posting a single id keeps working.
    kra_ids = fields.Many2many(
        'kra.master', 'kpi_kra_report_kra_rel', 'report_id', 'kra_id_rel',
        string='KRAs')
    excluded_kra_ids = fields.Many2many(
        'kra.master', 'kpi_kra_report_excl_kra_rel', 'report_id', 'kra_id_rel',
        string='Excluded KRAs',
        help="These KRAs and everything below them are left out of the report.")

    # employee_id is kept as the single-id fallback, same as kra_id.
    employee_ids = fields.Many2many(
        'res.users', 'kpi_kra_report_user_rel', 'report_id', 'user_id_rel',
        string='Employees')

    # Comma-separated rather than Many2many because neither dimension is a
    # record: the type is a prefix inside external_ref and the state is a
    # Selection. kpi.client.invoice.filter_task_types stores its types the
    # same way, for the same reason.
    task_types = fields.Char(
        string='Task Types',
        help="Comma-separated external_ref prefixes (REQ,UPT,BUG). Empty = every type.")
    task_states = fields.Char(
        string='Task States',
        help="Comma-separated task_state codes. Empty = every state.")

    time_frame = fields.Selection([
        ('today', 'Today'),
        ('yesterday', 'Yesterday'),
        ('last_month', 'Last Month'),
        ('last_year', 'Last Year')
    ], string='Time Frame')

    @api.onchange('time_frame')
    def _onchange_time_frame(self):
        """Auto-populate dates based on selected time frame"""
        if not self.time_frame:
            return
        
        today = fields.Date.today()

        if self.time_frame == 'today':
            self.from_date = today
            self.to_date = today

        elif self.time_frame == 'yesterday':
            self.from_date = today - timedelta(days=1)
            self.to_date = today - timedelta(days=1)

        elif self.time_frame == 'last_month':
            first_day_last_month = (today.replace(day=1) - timedelta(days=1)).replace(day=1)
            last_day_last_month = today.replace(day=1) - timedelta(days=1)
            self.from_date = first_day_last_month
            self.to_date = last_day_last_month

        elif self.time_frame == 'last_year':
            self.from_date = today.replace(year=today.year - 1, month=1, day=1)
            self.to_date = today.replace(year=today.year - 1, month=12, day=31)

    def _get_kra_full_path(self, kra):
        """
        Build the full hierarchical path for a KRA
        Returns: string like "Nexgenn > Restaurant > Restaurant App"
        Using > instead of → for PDF compatibility
        """
        if not kra:
            return ''
        
        path_parts = []
        current = kra
        
        # Walk up the tree to build path
        while current:
            path_parts.insert(0, current.name)
            current = current.parent_id
        
        return ' > '.join(path_parts)

    def _get_parent_kra_name(self, kra):
        """Get the immediate parent KRA name (Sub KRA's parent)"""
        if not kra:
            return ''
        if kra.parent_id:
            return kra.parent_id.name
        return ''  # This is a root KRA

    def _get_kra_level(self, kra):
        """Get the level depth of KRA (0 = root, 1 = sub, 2 = sub-sub, etc.)"""
        if not kra:
            return 0
        level = 0
        current = kra
        while current.parent_id:
            level += 1
            current = current.parent_id
        return level

    def _get_all_child_kra_ids(self, kra_id):
        """Get all child KRA IDs recursively including the given KRA"""
        if not kra_id:
            return []
        
        result = [kra_id]
        kra_model = self.env['kra.master']
        
        def get_children(parent_id):
            children = kra_model.search([('parent_id', '=', parent_id)])
            for child in children:
                result.append(child.id)
                get_children(child.id)
        
        get_children(kra_id)
        return result

    def _resolve_kra_scope(self):
        """Resolve the include / exclude pickers into two flat id sets.

        Returns (included_ids, excluded_ids) where included_ids is None when no
        include restriction was asked for (i.e. "all KRAs").  Both sides expand
        to whole subtrees: excluding Golden Spoon drops its sub-projects too.
        """
        self.ensure_one()

        include_roots = set(self.kra_ids.ids)
        if self.kra_id:
            include_roots.add(self.kra_id.id)

        included = None
        if include_roots:
            included = set()
            for root_id in include_roots:
                included.update(self._get_all_child_kra_ids(root_id))

        excluded = set()
        for root_id in self.excluded_kra_ids.ids:
            excluded.update(self._get_all_child_kra_ids(root_id))

        return (sorted(included) if included is not None else None), sorted(excluded)

    @staticmethod
    def _split_csv(value):
        """Split a comma-separated filter value into clean, non-empty parts."""
        return [part.strip() for part in (value or '').split(',') if part.strip()]

    def _task_type_domain(self):
        """OR-of-ilike over the external_ref prefixes selected.

        There is no doc_type column to filter on — the Requirement / Update /
        Bug type lives in the ref itself (REQ-012 / UPT-004 / BUG-021), so this
        mirrors the domain kpi.client.invoice already builds for the same job.
        A task with no external_ref matches no prefix, so picking any type
        deliberately drops it.
        """
        self.ensure_one()
        prefixes = [p.upper() for p in self._split_csv(self.task_types)]
        if not prefixes:
            return []

        # Odoo domains are prefix notation: N terms OR-ed together need N-1
        # leading '|' operators.
        domain = ['|'] * (len(prefixes) - 1)
        for prefix in prefixes:
            domain.append(('external_ref', '=ilike', prefix + '-%'))
        return domain

    def _kra_filter_label(self):
        """Human-readable summary of the KRA filter, for report/export headers."""
        self.ensure_one()

        included = self.kra_ids or self.kra_id
        label = ', '.join(self._get_kra_full_path(k) for k in included) if included else 'All KRAs'

        if self.excluded_kra_ids:
            excluded = ', '.join(k.name for k in self.excluded_kra_ids)
            label = f"{label} (excluding {excluded})"

        return label

    def _format_time_hours(self, seconds):
        """
        Convert seconds to hours with proper formatting
        Returns: dict with hours, minutes, and display string
        """
        if not seconds or seconds <= 0:
            return {'hours': 0, 'minutes': 0, 'display': '0h 0m', 'total_hours': 0.0}
        
        total_hours = seconds / 3600.0
        hours = int(total_hours)
        minutes = int((total_hours - hours) * 60)
        
        display = f"{hours}h {minutes}m"
        
        return {
            'hours': hours,
            'minutes': minutes,
            'display': display,
            'total_hours': round(total_hours, 2)
        }

    def _build_domain(self, skip=None):
        """Search domain for the current filters.

        `skip` omits one facet ('employee' | 'kra' | 'type' | 'state') so that
        facet's own counts stay meaningful — a faceted list has to show what
        selecting a value WOULD give, not what the current selection already
        gives, otherwise every unticked option reads 0.
        """
        self.ensure_one()

        domain = [('user_id', '!=', False)]  # Only tasks with assignees

        # Employee filter — union of the multi-select and the single-id fallback
        if skip != 'employee':
            employee_ids = set(self.employee_ids.ids)
            if self.employee_id:
                employee_ids.add(self.employee_id.id)
            if employee_ids:
                domain.append(('user_id', 'in', sorted(employee_ids)))

        # KRA filter - each picked KRA pulls in its whole subtree, then the
        # excluded subtrees are subtracted (exclude wins over include).
        if skip != 'kra':
            included_kra_ids, excluded_kra_ids = self._resolve_kra_scope()
            if included_kra_ids is not None:
                domain.append(('kra_id', 'in', included_kra_ids))
            if excluded_kra_ids:
                domain.append(('kra_id', 'not in', excluded_kra_ids))

        # Task type (external_ref prefix) and task state. Both are balanced
        # sub-expressions, so they AND with everything already in the domain.
        if skip != 'type':
            domain += self._task_type_domain()
        if skip != 'state':
            task_states = self._split_csv(self.task_states)
            if task_states:
                domain.append(('task_state', 'in', task_states))

        # Date filter: a task is in range if it has at least one kpi.time.log
        # row whose work_date falls within [from_date, to_date].  We fall back
        # to the task's own deadline / create_date when the task has no logs
        # so manually-tracked tasks are still discoverable.
        if self.from_date or self.to_date:
            log_domain = []
            if self.from_date:
                log_domain.append(('work_date', '>=', self.from_date))
            if self.to_date:
                log_domain.append(('work_date', '<=', self.to_date))
            logged_kpi_ids = self.env['kpi.time.log'].search(log_domain).mapped('kpi_id').ids

            # End-of-day for the "to_date" so same-day created tasks aren't lost.
            from_dt = fields.Datetime.to_datetime(self.from_date) if self.from_date else None
            to_dt = (
                fields.Datetime.to_datetime(self.to_date).replace(hour=23, minute=59, second=59)
                if self.to_date else None
            )

            meta_domain = []
            if self.from_date and self.to_date:
                meta_domain = [
                    '|',
                        '&', ('deadline', '>=', self.from_date),
                             ('deadline', '<=', self.to_date),
                        '&', ('create_date', '>=', from_dt),
                             ('create_date', '<=', to_dt),
                ]
            elif self.from_date:
                meta_domain = ['|',
                    ('deadline', '>=', self.from_date),
                    ('create_date', '>=', from_dt)]
            elif self.to_date:
                meta_domain = ['|',
                    ('deadline', '<=', self.to_date),
                    ('create_date', '<=', to_dt)]

            if logged_kpi_ids and meta_domain:
                domain += ['|', ('id', 'in', logged_kpi_ids)] + meta_domain
            elif logged_kpi_ids:
                domain.append(('id', 'in', logged_kpi_ids))
            elif meta_domain:
                domain += meta_domain

        return domain

    def get_filter_counts(self):
        """Per-option task counts for each filter dropdown.

        Each facet is counted with its OWN selection skipped, so the list keeps
        telling you what ticking another value would return.
        """
        self.ensure_one()
        Kpi = self.env['kra.kpi']

        kras = {}
        for group in Kpi.read_group(
                self._build_domain('kra') + [('kra_id', '!=', False)], ['kra_id'], ['kra_id']):
            kras[group['kra_id'][0]] = group['kra_id_count']

        employees = {}
        for group in Kpi.read_group(
                self._build_domain('employee'), ['user_id'], ['user_id']):
            if group['user_id']:
                employees[group['user_id'][0]] = group['user_id_count']

        states = {}
        for group in Kpi.read_group(
                self._build_domain('state') + [('task_state', '!=', False)],
                ['task_state'], ['task_state']):
            states[group['task_state']] = group['task_state_count']

        # No ORM grouping on a string prefix, so bucket the refs in Python.
        types = {}
        for kpi in Kpi.search(self._build_domain('type') + [('external_ref', '!=', False)]):
            prefix = (kpi.external_ref or '').split('-')[0].strip().upper()
            if prefix:
                types[prefix] = types.get(prefix, 0) + 1

        return {
            'kras': kras,
            'employees': employees,
            'task_types': types,
            'task_states': states,
        }

    def get_report_data(self):
        """
        Generate KRA Report data with full hierarchical structure
        Returns list of dicts with: kra_path, sub_kra, kpi_name, employee_name, time_worked
        """
        self.ensure_one()

        # Search for KPIs
        kpi_tasks = self.env['kra.kpi'].search(
            self._build_domain(), order='kra_id, user_id, id')

        # Raw task_state codes read badly on a client-facing report
        # ("partially_completed"), so carry the Selection's own labels along.
        state_labels = dict(self.env['kra.kpi']._fields['task_state'].selection)
        
        import logging
        _logger = logging.getLogger(__name__)
        _logger.info(f"KRA Report Domain: {self._build_domain()}")
        _logger.info(f"Found {len(kpi_tasks)} tasks")

        result = []
        for kpi in kpi_tasks:
            kra = kpi.kra_id
            
            # Build hierarchical path
            kra_path = self._get_kra_full_path(kra)
            
            # Get immediate parent name as sub_kra
            # If KRA has a parent, the KRA itself is the sub-KRA
            # The parent hierarchy is shown in kra_path
            kra_level = self._get_kra_level(kra)
            
            # Determine root KRA and sub KRA
            if kra_level == 0:
                # This is a root KRA
                root_kra_name = kra.name if kra else ''
                sub_kra_name = '-'
            else:
                # Walk up to find root
                current = kra
                while current.parent_id:
                    current = current.parent_id
                root_kra_name = current.name
                sub_kra_name = kra.name if kra else ''
            
            # Time worked in hours
            time_data = self._format_time_hours(kpi.timer_total_seconds or 0)

            # Per-task user breakdown: aggregate kpi.time.log rows by user so
            # the export can show "Sribalakumar — 2h 30m, Karthick — 30m" per task.
            user_totals = {}
            for tlog in self.env['kpi.time.log'].sudo().search([('kpi_id', '=', kpi.id)]):
                uid = tlog.user_id.id if tlog.user_id else 0
                uname = tlog.user_id.name if tlog.user_id else 'Unknown'
                if uid not in user_totals:
                    user_totals[uid] = {'id': uid, 'name': uname, 'seconds': 0.0}
                user_totals[uid]['seconds'] += (tlog.duration_seconds or 0.0)

            # Fallback: if no time-log rows exist, attribute all timer_total_seconds
            # to the primary assignee so the breakdown is never empty.
            if not user_totals and kpi.user_id:
                user_totals[kpi.user_id.id] = {
                    'id': kpi.user_id.id,
                    'name': kpi.user_id.name,
                    'seconds': float(kpi.timer_total_seconds or 0.0),
                }

            user_breakdown = []
            for ut in sorted(user_totals.values(), key=lambda x: -x['seconds']):
                fmt = self._format_time_hours(ut['seconds'])
                user_breakdown.append({
                    'user_id': ut['id'],
                    'user_name': ut['name'],
                    'seconds': ut['seconds'],
                    'hours': round(ut['seconds'] / 3600.0, 2),
                    'display': fmt['display'],
                })

            result.append({
                'id': kpi.id,
                'kra_id': kra.id if kra else False,
                'kra_path': kra_path,  # Full hierarchical path: "Nexgenn → Restaurant → App"
                'root_kra': root_kra_name,  # Top-level KRA name
                'sub_kra': sub_kra_name,  # Immediate KRA name (could be sub-sub-sub KRA)
                'kra_level': kra_level,  # Depth level
                'kpi_name': kpi.name,
                'external_ref': kpi.external_ref or '',
                # There is no doc_type field on kra.kpi — the Requirement /
                # Update / Bug type lives in the external_ref prefix
                # (REQ-012 / UPT-004 / BUG-021), same as the invoice picker reads it.
                'task_type': (kpi.external_ref or '').split('-')[0].strip().upper(),
                'task_state': kpi.task_state or '',
                'task_state_label': state_labels.get(kpi.task_state, kpi.task_state or ''),
                'priority': kpi.priority or 'regular',
                'deadline': str(kpi.deadline) if kpi.deadline else '',
                'employee_id': kpi.user_id.id if kpi.user_id else False,
                'employee_name': kpi.user_id.name if kpi.user_id else 'Unassigned',
                'time_worked_seconds': kpi.timer_total_seconds or 0,
                'time_worked_hours': time_data['total_hours'],
                'time_worked_display': time_data['display'],
                'user_breakdown': user_breakdown,
            })

        return result

    def get_kra_summary(self):
        """
        Get summary data grouped by KRA hierarchy
        Useful for totals and grouping in reports
        """
        self.ensure_one()
        
        report_data = self.get_report_data()
        
        # Group by KRA path
        kra_summary = {}
        for row in report_data:
            kra_path = row['kra_path']
            if kra_path not in kra_summary:
                kra_summary[kra_path] = {
                    'kra_path': kra_path,
                    'root_kra': row['root_kra'],
                    'kpi_count': 0,
                    'total_time_seconds': 0,
                    'employees': set()
                }
            
            kra_summary[kra_path]['kpi_count'] += 1
            kra_summary[kra_path]['total_time_seconds'] += row['time_worked_seconds']
            if row['employee_name']:
                kra_summary[kra_path]['employees'].add(row['employee_name'])
        
        # Convert to list and format time
        result = []
        for kra_path, data in kra_summary.items():
            time_data = self._format_time_hours(data['total_time_seconds'])
            result.append({
                'kra_path': data['kra_path'],
                'root_kra': data['root_kra'],
                'kpi_count': data['kpi_count'],
                'total_time_display': time_data['display'],
                'total_time_hours': time_data['total_hours'],
                'employee_count': len(data['employees']),
            })
        
        return result

    @api.model
    def get_all_kras_for_filter(self):
        """Get all KRAs formatted for dropdown filter with hierarchy indication"""
        kras = self.env['kra.master'].search([], order='sequence, id')

        # Tasks sitting on the node ITSELF, not its subtree. 21 of the real KRAs
        # are a root with a child of the identical name, and the per-node count
        # is the only thing on screen that tells the two rows apart.
        task_counts = {}
        for group in self.env['kra.kpi'].read_group(
                [('kra_id', '!=', False)], ['kra_id'], ['kra_id']):
            task_counts[group['kra_id'][0]] = group['kra_id_count']

        result = []

        for kra in kras:
            # Build path for display
            level = 0
            current = kra
            while current.parent_id:
                level += 1
                current = current.parent_id
            
            # Add indent based on level
            prefix = '    ' * level  # 4 spaces per level
            if level > 0:
                prefix += '↳ '
            
            result.append({
                'id': kra.id,
                'name': kra.name,
                'display_name': f"{prefix}{kra.name}",
                'level': level,
                'parent_id': kra.parent_id.id if kra.parent_id else False,
                'parent_name': kra.parent_id.name if kra.parent_id else '',
                'task_count': task_counts.get(kra.id, 0),
            })

        return result

    @api.model
    def get_all_task_types_for_filter(self):
        """The external_ref prefixes actually in use (REQ / UPT / BUG / ...).

        Read through the ORM rather than raw SQL so record rules still apply.
        """
        counts = {}
        for kpi in self.env['kra.kpi'].search([('external_ref', '!=', False)]):
            prefix = (kpi.external_ref or '').split('-')[0].strip().upper()
            if prefix:
                counts[prefix] = counts.get(prefix, 0) + 1

        return [{'id': prefix, 'name': prefix, 'task_count': count}
                for prefix, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]

    @api.model
    def get_all_task_states_for_filter(self):
        """Only the task states actually in use, with their readable labels."""
        labels = dict(self.env['kra.kpi']._fields['task_state'].selection)

        counts = {}
        for group in self.env['kra.kpi'].read_group(
                [('task_state', '!=', False)], ['task_state'], ['task_state']):
            counts[group['task_state']] = group['task_state_count']

        return [{'id': code, 'name': labels.get(code, code), 'task_count': count}
                for code, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]

    @api.model
    def get_all_employees_for_filter(self):
        """Get all employees who have KPI tasks assigned"""
        employees = self.env['res.users'].search([
            ('active', '=', True),
            ('share', '=', False),  # Internal users only
        ], order='name')
        
        return [{'id': emp.id, 'name': emp.name} for emp in employees]
