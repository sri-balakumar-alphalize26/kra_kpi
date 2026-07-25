/** @odoo-module **/
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

export class KpiClientDashboard extends Component {
    static template = xml/* xml */`
    <div class="o_kpi_client_dashboard p-4">

        <!-- Header -->
        <div class="d-flex justify-content-between align-items-center mb-4">
            <h2 class="fw-bold">
                <i class="fa fa-th-large me-2 text-primary"/> My Dashboard
                <span t-if="state.dashboard and state.dashboard.clients.length"
                      class="text-muted small ms-2">
                    (<t t-esc="state.dashboard.clients.map(c => c.name).join(', ')"/>)
                </span>
            </h2>
            <div>
                <button class="btn btn-success me-2" t-on-click="() => state.showAdd = !state.showAdd">
                    <i class="fa fa-plus me-1"/>
                    <t t-if="state.showAdd">Cancel</t>
                    <t t-else="">New Task</t>
                </button>
                <button class="btn btn-outline-primary" t-on-click="refresh">
                    <i class="fa fa-refresh me-1"/> Refresh
                </button>
            </div>
        </div>

        <!-- Not authorized -->
        <div t-if="state.dashboard and !state.dashboard.authorized" class="alert alert-warning">
            <i class="fa fa-exclamation-triangle me-2"/>
            <t t-esc="state.dashboard.message"/>
        </div>

        <t t-if="state.dashboard and state.dashboard.authorized">

            <!-- Add Task card (collapsible) -->
            <div t-if="state.showAdd" class="card p-3 mb-4 shadow-sm border-success">
                <h5 class="fw-bold mb-3"><i class="fa fa-plus-circle me-2 text-success"/> Submit a New Task</h5>
                <div class="row g-3">
                    <div class="col-md-3">
                        <label class="form-label fw-bold">Type</label>
                        <select class="form-select" t-model="state.newTask.kind">
                            <option value="requirement">Requirement</option>
                            <option value="update">Update / Amendment</option>
                            <option value="bug">Bug</option>
                        </select>
                    </div>
                    <div class="col-md-6">
                        <label class="form-label fw-bold">Project</label>
                        <select class="form-select" t-model="state.newTask.sub_kra_id">
                            <option value="">-- Select Project --</option>
                            <t t-foreach="state.projects" t-as="p" t-key="p.id">
                                <option t-att-value="p.id" t-esc="p.display"/>
                            </t>
                        </select>
                    </div>
                    <div class="col-md-3">
                        <label class="form-label fw-bold">Priority</label>
                        <select class="form-select" t-model="state.newTask.priority">
                            <option value="urgent">Urgent</option>
                            <option value="important">Important</option>
                            <option value="regular">Regular</option>
                        </select>
                    </div>
                    <div class="col-12">
                        <label class="form-label fw-bold">Task Name <span class="text-danger">*</span></label>
                        <input type="text" class="form-control" t-model="state.newTask.name"
                               placeholder="What needs to be done?"/>
                    </div>
                    <div class="col-12">
                        <label class="form-label fw-bold">Description</label>
                        <textarea class="form-control" rows="3" t-model="state.newTask.description"
                                  placeholder="Details, acceptance criteria, links..."/>
                    </div>
                    <div class="col-12 text-end">
                        <button class="btn btn-success" t-on-click="submitNewTask">
                            <i class="fa fa-paper-plane me-1"/> Submit Task
                        </button>
                    </div>
                </div>
            </div>

            <!-- Project + User filter (narrows pending-approvals + My-Tasks list) -->
            <div class="card p-2 mb-3 shadow-sm bg-light">
                <div class="row g-2 align-items-center">
                    <div t-if="state.projects.length > 1" class="col-auto fw-bold small text-muted">
                        <i class="fa fa-filter me-1"/> Project:
                    </div>
                    <div t-if="state.projects.length > 1" class="col-md-4">
                        <select class="form-select form-select-sm" t-model="state.projectFilter">
                            <option value="">All projects</option>
                            <t t-foreach="state.projects" t-as="p" t-key="p.id">
                                <option t-att-value="p.id" t-esc="p.display"/>
                            </t>
                        </select>
                    </div>
                    <div class="col-auto fw-bold small text-muted">
                        <i class="fa fa-user me-1"/> User:
                    </div>
                    <div class="col-md-4">
                        <select class="form-select form-select-sm" t-model="state.userFilter">
                            <option value="">All users</option>
                            <t t-foreach="userOptions" t-as="u" t-key="u.id">
                                <option t-att-value="u.id" t-esc="u.name"/>
                            </t>
                        </select>
                    </div>
                    <div t-if="state.projectFilter or state.userFilter" class="col-auto">
                        <button class="btn btn-sm btn-outline-secondary"
                                t-on-click="() => { state.projectFilter = ''; state.userFilter = ''; }">
                            <i class="fa fa-times me-1"/> Clear
                        </button>
                    </div>
                </div>
                <!-- Total-duration summary across the current filter scope -->
                <div t-if="filterSummary.show" class="mt-2 small">
                    <span class="badge bg-primary me-2">
                        <i class="fa fa-list me-1"/>
                        <t t-esc="filterSummary.taskCount"/> task(s)
                    </span>
                    <span t-if="state.userFilter" class="badge bg-info me-2">
                        User: <t t-esc="this.userLabel(state.userFilter)"/>
                    </span>
                    <span t-if="state.projectFilter" class="badge bg-info">
                        Project: <t t-esc="this.projectLabel(state.projectFilter)"/>
                    </span>
                </div>
            </div>

            <!-- Three tabs: Pending / In Progress / Completed (same buckets as the app) -->
            <div class="row g-2 mb-3">
                <t t-foreach="statusChips" t-as="chip" t-key="chip.key">
                    <div class="col">
                        <button class="card p-3 w-100 border-0 text-center"
                                t-att-class="state.tab === chip.key ? 'bg-primary text-white' : 'bg-light'"
                                t-on-click="() => (state.tab = chip.key)">
                            <div class="small" t-esc="chip.label"/>
                            <div class="fs-4 fw-bold" t-esc="tabCount(chip.key)"/>
                        </button>
                    </div>
                </t>
            </div>

            <!-- Per-type breakdown (Requirements / Updates / Bugs) -->
            <div class="row g-3 mb-3" t-if="state.dashboard">
                <div class="col-md-4">
                    <div class="card p-3 shadow-sm border-primary border-start border-4">
                        <div class="d-flex justify-content-between align-items-center">
                            <div>
                                <div class="text-muted small">Requirements</div>
                                <div class="fs-3 fw-bold" t-esc="byType.requirement.total"/>
                            </div>
                            <div class="text-end">
                                <div class="small">
                                    <span class="badge bg-success">
                                        <i class="fa fa-check"/> <t t-esc="byType.requirement.done"/>
                                    </span>
                                    <span class="badge bg-warning text-dark ms-1">
                                        <i class="fa fa-clock-o"/> <t t-esc="byType.requirement.open"/>
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="col-md-4">
                    <div class="card p-3 shadow-sm border-warning border-start border-4">
                        <div class="d-flex justify-content-between align-items-center">
                            <div>
                                <div class="text-muted small">Updates / Amendments</div>
                                <div class="fs-3 fw-bold" t-esc="byType.update.total"/>
                            </div>
                            <div class="text-end">
                                <div class="small">
                                    <span class="badge bg-success">
                                        <i class="fa fa-check"/> <t t-esc="byType.update.done"/>
                                    </span>
                                    <span class="badge bg-warning text-dark ms-1">
                                        <i class="fa fa-clock-o"/> <t t-esc="byType.update.open"/>
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="col-md-4">
                    <div class="card p-3 shadow-sm border-danger border-start border-4">
                        <div class="d-flex justify-content-between align-items-center">
                            <div>
                                <div class="text-muted small">Bugs</div>
                                <div class="fs-3 fw-bold" t-esc="byType.bug.total"/>
                            </div>
                            <div class="text-end">
                                <div class="small">
                                    <span class="badge bg-success">
                                        <i class="fa fa-check"/> <t t-esc="byType.bug.done"/>
                                    </span>
                                    <span class="badge bg-warning text-dark ms-1">
                                        <i class="fa fa-clock-o"/> <t t-esc="byType.bug.open"/>
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Pending Approvals (call-out) -->
            <div t-if="filteredPending.length > 0"
                 class="card p-3 mb-3 shadow-sm border-warning border-3">
                <h5 class="fw-bold mb-3 text-warning">
                    <i class="fa fa-bell me-2"/>
                    <t t-esc="filteredPending.length"/> task(s) need your approval
                    <span t-if="state.projectFilter" class="badge bg-info ms-2">
                        Project: <t t-esc="this.projectLabel(state.projectFilter)"/>
                    </span>
                </h5>
                <table class="table table-sm align-middle mb-0">
                    <thead class="table-light">
                        <tr>
                            <th>Ref</th><th>Task</th><th>Project</th><th>By</th><th>Submitted</th><th>&#160;</th>
                        </tr>
                    </thead>
                    <tbody>
                        <t t-foreach="filteredPending" t-as="p" t-key="p.id">
                            <tr>
                                <td><span class="badge bg-secondary" t-esc="p.external_ref or '—'"/></td>
                                <td class="fw-bold" t-esc="p.name"/>
                                <td t-esc="p.project_name"/>
                                <td t-esc="p.primary_assignee"/>
                                <td t-esc="p.completion_date"/>
                                <td>
                                    <button class="btn btn-sm btn-warning"
                                            t-on-click="() => this.openApproval(p.id)">
                                        <i class="fa fa-check me-1"/> Review &amp; Sign
                                    </button>
                                </td>
                            </tr>
                        </t>
                    </tbody>
                </table>
            </div>

            <!-- All Tasks table -->
            <div class="card p-3 shadow-sm">
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <h5 class="fw-bold mb-0">
                        <i class="fa fa-list me-2 text-info"/> Requests
                        <span class="text-muted small"><t t-if="state.projectFilter">(project: <t t-esc="this.projectLabel(state.projectFilter)"/>)</t></span>
                    </h5>
                    <div class="small text-muted">
                        Showing <strong t-esc="filteredKpis.length"/> task(s)
                    </div>
                </div>
                <div t-if="filteredKpis.length === 0" class="text-center text-muted p-4">
                    <i class="fa fa-inbox fa-3x mb-2 d-block"/>
                    No tasks match this filter.
                </div>
                <table t-if="filteredKpis.length > 0" class="table table-sm table-hover align-middle">
                    <thead class="table-light">
                        <tr>
                            <th style="width: 70px">Kind</th>
                            <th style="width: 90px">Ref</th>
                            <th>Task</th>
                            <th>Project</th>
                            <th style="width: 130px">State</th>
                            <th style="width: 110px">Deadline</th>
                            <th style="width: 90px">Cert</th>
                            <th style="width: 100px">&#160;</th>
                        </tr>
                    </thead>
                    <tbody>
                        <t t-foreach="filteredKpis" t-as="k" t-key="k.id">
                            <tr>
                                <td>
                                    <span class="badge"
                                          t-att-class="k.kind === 'bug' ? 'bg-danger' : (k.kind === 'update' ? 'bg-warning text-dark' : 'bg-primary')"
                                          t-esc="k.kind"/>
                                </td>
                                <td>
                                    <span class="badge bg-secondary" t-esc="k.external_ref or '—'"/>
                                    <span t-if="k.related_req_ref" class="badge bg-light text-dark ms-1">
                                        →<t t-esc="k.related_req_ref"/>
                                    </span>
                                </td>
                                <td class="fw-bold">
                                    <div t-esc="k.name"/>
                                    <div t-if="k.primary_assignee" class="text-muted small fw-normal">
                                        <i class="fa fa-user me-1"/>By: <t t-esc="k.primary_assignee"/>
                                    </div>
                                </td>
                                <td t-esc="k.project_name"/>
                                <td>
                                    <span class="badge" t-att-class="this.stateBadge(k.task_state)" t-esc="k.task_state"/>
                                </td>
                                <td t-esc="k.deadline or '—'"/>
                                <td>
                                    <a t-if="k.has_signed_certificate"
                                       t-att-href="'/kpi_client_portal/download_cert?kpi_id=' + k.id"
                                       target="_blank" class="btn btn-sm btn-outline-info">
                                        <i class="fa fa-paperclip"/>
                                    </a>
                                    <span t-else="" class="text-muted small">—</span>
                                </td>
                                <td>
                                    <button t-if="k.task_state === 'partially_completed'"
                                            class="btn btn-sm btn-warning"
                                            t-on-click="() => this.openApproval(k.id)">
                                        <i class="fa fa-check"/> Sign
                                    </button>
                                </td>
                            </tr>
                        </t>
                    </tbody>
                </table>
            </div>

            <!-- Invoices link -->
            <div t-if="state.dashboard.invoice_count > 0" class="card p-3 mt-3 shadow-sm bg-light">
                <div class="d-flex justify-content-between align-items-center">
                    <div>
                        <i class="fa fa-file-text-o me-2"/>
                        You have <strong t-esc="state.dashboard.invoice_count"/> finalized invoice(s).
                    </div>
                    <span class="text-muted small">Open "Client Portal → My Invoices" from the menu</span>
                </div>
            </div>
        </t>

        <!-- Approval modal -->
        <div t-if="state.approval.open" class="modal d-block" tabindex="-1" style="background: rgba(0,0,0,0.5);">
            <div class="modal-dialog modal-lg">
                <div class="modal-content" t-if="state.approval.data">
                    <div class="modal-header">
                        <h5 class="modal-title">
                            <i class="fa fa-certificate me-2"/> Review &amp; Sign
                        </h5>
                        <button type="button" class="btn-close" t-on-click="closeApproval"/>
                    </div>
                    <div class="modal-body">
                        <div class="mb-3">
                            <strong>Task:</strong> <t t-esc="state.approval.data.kpi.name"/><br/>
                            <strong>Client:</strong> <t t-esc="state.approval.data.client_name"/><br/>
                            <strong>Project:</strong> <t t-esc="state.approval.data.project_name"/><br/>
                            <strong>Submitted by:</strong> <t t-esc="state.approval.data.kpi.primary_assignee"/><br/>
                            <strong>Submitted on:</strong> <t t-esc="state.approval.data.kpi.completion_date"/>
                        </div>
                        <div t-if="state.approval.data.kpi.description" class="border rounded p-2 bg-light mb-3 small">
                            <t t-esc="state.approval.data.kpi.description"/>
                        </div>

                        <h6 class="fw-bold">Confirmation Checklist</h6>
                        <div class="form-check">
                            <input class="form-check-input" type="checkbox" id="chkdel"
                                   t-model="state.approval.chk_delivered"/>
                            <label class="form-check-label" for="chkdel">
                                I confirm the task has been delivered as specified.
                            </label>
                        </div>
                        <div class="form-check">
                            <input class="form-check-input" type="checkbox" id="chkworks"
                                   t-model="state.approval.chk_works"/>
                            <label class="form-check-label" for="chkworks">
                                The functionality works as expected.
                            </label>
                        </div>
                        <div class="form-check mb-3">
                            <input class="form-check-input" type="checkbox" id="chkauth"
                                   t-model="state.approval.chk_authorized"/>
                            <label class="form-check-label" for="chkauth">
                                I authorize this task as complete.
                            </label>
                        </div>

                        <div class="mb-3">
                            <label class="form-label fw-bold">Notes (optional)</label>
                            <textarea class="form-control" rows="2" t-model="state.approval.notes"/>
                        </div>
                        <div class="mb-3">
                            <label class="form-label fw-bold">Type your full name as digital signature <span class="text-danger">*</span></label>
                            <input type="text" class="form-control form-control-lg"
                                   style="font-family: cursive"
                                   t-model="state.approval.signature_text"
                                   placeholder="Your full name"/>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-danger me-auto" t-on-click="submitReject">
                            <i class="fa fa-times me-1"/> Reject &amp; Send Back
                        </button>
                        <button type="button" class="btn btn-secondary" t-on-click="closeApproval">Cancel</button>
                        <button type="button" class="btn btn-success" t-on-click="submitApprove">
                            <i class="fa fa-check me-1"/> Approve &amp; Sign
                        </button>
                    </div>
                </div>
                <div class="modal-content" t-if="!state.approval.data">
                    <div class="modal-body text-center p-5">
                        <i class="fa fa-spinner fa-spin fa-3x"/>
                        <p class="mt-3">Loading...</p>
                    </div>
                </div>
            </div>
        </div>
    </div>
    `;

    // Three tabs (same buckets as the mobile app): Pending / In Progress / Completed.
    get statusChips() {
        return [
            { key: 'pending', label: 'Pending', states: ['assigned', 'urgent', 'important', 'regular',
                'queue_waiting', 'pre_approval_pending', 'pre_approval_approved', 'pre_approval_partial'] },
            { key: 'in_progress', label: 'In Progress', states: ['in_progress', 'paused', 'hold', 'rework',
                'partially_completed', 'awaiting_client'] },
            { key: 'completed', label: 'Completed', states: ['completed'] },
        ];
    }
    // Counts must honour the Project / User filters, exactly like `filteredKpis` does —
    // otherwise the tile and the "Showing N task(s)" line below it disagree.
    tabCount(key) {
        const c = this.statusChips.find(x => x.key === key);
        const list = this._applyFilters((this.state.dashboard && this.state.dashboard.kpis) || []);
        return c ? list.filter(k => c.states.includes(k.task_state)).length : 0;
    }
    stateBadge(state) {
        const map = {
            'assigned': 'bg-secondary',
            'in_progress': 'bg-info',
            'paused': 'bg-warning text-dark',
            'partially_completed': 'bg-warning text-dark',
            'completed': 'bg-success',
        };
        return map[state] || 'bg-light text-dark';
    }

    _applyFilters(list) {
        let out = list;
        if (this.state.projectFilter) {
            const pid = parseInt(this.state.projectFilter, 10);
            out = out.filter(x => x.project_id === pid);
        }
        if (this.state.userFilter) {
            const uid = parseInt(this.state.userFilter, 10);
            out = out.filter(x => x.primary_assignee_id === uid);
        }
        return out;
    }
    get filteredPending() {
        return this._applyFilters((this.state.dashboard && this.state.dashboard.pending_approvals) || []);
    }
    // Per-type breakdown recomputed client-side from the FILTERED list. The payload's
    // `by_type` is built server-side over the whole client scope (kpi_reports_api.py),
    // so binding the tiles to it left them frozen whenever a filter was applied.
    get byType() {
        const out = {
            requirement: { total: 0, done: 0, open: 0 },
            update: { total: 0, done: 0, open: 0 },
            bug: { total: 0, done: 0, open: 0 },
        };
        const list = this._applyFilters((this.state.dashboard && this.state.dashboard.kpis) || []);
        for (const k of list) {
            // Unknown kind falls back rather than throwing — a task must never vanish from the totals.
            const b = out[k.kind] || out.requirement;
            b.total++;
            if (k.task_state === 'completed') b.done++; else b.open++;
        }
        return out;
    }
    get filteredKpis() {
        const tab = this.statusChips.find(c => c.key === this.state.tab) || this.statusChips[0];
        const base = this._applyFilters((this.state.dashboard && this.state.dashboard.kpis) || []);
        return base.filter(k => tab.states.includes(k.task_state));
    }
    get userOptions() {
        const seen = new Map();
        const all = [
            ...((this.state.dashboard && this.state.dashboard.kpis) || []),
            ...((this.state.dashboard && this.state.dashboard.pending_approvals) || []),
        ];
        for (const x of all) {
            if (x.primary_assignee_id && !seen.has(x.primary_assignee_id)) {
                seen.set(x.primary_assignee_id, x.primary_assignee || ('User #' + x.primary_assignee_id));
            }
        }
        return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
    }
    get filterSummary() {
        const active = !!(this.state.projectFilter || this.state.userFilter);
        if (!active) return { show: false };
        const list = this.filteredKpis;
        const totalHours = list.reduce((s, k) => s + (k.actual_hours || 0), 0);
        return {
            show: true,
            taskCount: list.length,
            hoursLabel: this._formatHours(totalHours),
        };
    }
    _formatHours(h) {
        if (!h) return '0h';
        const totalMin = Math.round(h * 60);
        const hr = Math.floor(totalMin / 60);
        const mn = totalMin % 60;
        if (hr && mn) return `${hr}h ${mn}m`;
        if (hr) return `${hr}h`;
        return `${mn}m`;
    }
    projectLabel(projectFilter) {
        const pid = parseInt(projectFilter, 10);
        const p = (this.state.projects || []).find(p => p.id === pid);
        return p ? (p.display || p.name || '') : projectFilter;
    }
    userLabel(userFilter) {
        const uid = parseInt(userFilter, 10);
        const u = this.userOptions.find(u => u.id === uid);
        return u ? u.name : userFilter;
    }

    setup() {
        this.state = useState({
            dashboard: null,
            projects: [],
            tab: 'pending',     // active tab: pending | in_progress | completed
            projectFilter: '',  // '' = all projects
            userFilter: '',     // '' = all users
            showAdd: false,
            newTask: {
                kind: 'requirement', sub_kra_id: '', name: '',
                external_ref: '', related_req_ref: '',
                description: '', priority: 'regular',
            },
            approval: {
                open: false,
                data: null,
                chk_delivered: false, chk_works: false, chk_authorized: false,
                notes: '', signature_text: '',
            },
        });
        onWillStart(async () => {
            await this.refresh();
            const rp = await rpc('/kpi_client_portal/get_projects', {});
            if (rp && rp.status) this.state.projects = rp.projects || [];
        });
    }

    async refresh() {
        // Always load the full list; the 3 tabs bucket it client-side.
        const r = await rpc('/kpi_client_portal/dashboard', { state: 'all' });
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        this.state.dashboard = r;
    }
    async setFilter(key) {
        const r = await rpc('/kpi_client_portal/dashboard', { state: key });
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        this.state.dashboard = r;
    }

    async submitNewTask() {
        const t = this.state.newTask;
        if (!t.name || !t.sub_kra_id) {
            alert('Project and Task Name are required.');
            return;
        }
        const r = await rpc('/kpi_client_portal/add_task', t);
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        alert(`Task submitted: ${r.name}. Your admin will review and assign it.`);
        this.state.newTask = {
            kind: 'requirement', sub_kra_id: '', name: '',
            external_ref: '', related_req_ref: '',
            description: '', priority: 'regular',
        };
        this.state.showAdd = false;
        await this.refresh();
    }

    async openApproval(kpiId) {
        this.state.approval.open = true;
        this.state.approval.data = null;
        this.state.approval.chk_delivered = false;
        this.state.approval.chk_works = false;
        this.state.approval.chk_authorized = false;
        this.state.approval.notes = '';
        this.state.approval.signature_text = '';
        const r = await rpc('/kpi_client_approval/get', { kpi_id: kpiId });
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); this.closeApproval(); return; }
        this.state.approval.data = r.data;
    }
    closeApproval() {
        this.state.approval.open = false;
        this.state.approval.data = null;
    }
    async submitApprove() {
        const a = this.state.approval;
        if (!a.chk_delivered || !a.chk_works || !a.chk_authorized) {
            alert('Please tick all three confirmation checkboxes.');
            return;
        }
        if (!(a.signature_text || '').trim()) {
            alert('Please type your name as signature.');
            return;
        }
        const r = await rpc('/kpi_client_approval/approve', {
            kpi_id: a.data.kpi.id,
            chk_delivered: a.chk_delivered,
            chk_works: a.chk_works,
            chk_authorized: a.chk_authorized,
            notes: a.notes,
            signature_text: a.signature_text,
        });
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        alert('Approved and signed. Thank you!');
        this.closeApproval();
        await this.refresh();
    }
    async submitReject() {
        const reason = prompt('Reason for rejection?');
        if (!reason) return;
        const r = await rpc('/kpi_client_approval/reject', {
            kpi_id: this.state.approval.data.kpi.id,
            reason: reason,
        });
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        alert('Sent back to the team for changes.');
        this.closeApproval();
        await this.refresh();
    }
}

registry.category("actions").add("kpi_client_dashboard", KpiClientDashboard);
