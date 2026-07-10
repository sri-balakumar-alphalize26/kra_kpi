/** @odoo-module **/
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

/**
 * Owner Dashboard — business / financial role.
 * Lists each billable client with their certified (client-signed) task counts and
 * total hours. Click into a row to see the individual tasks and jump to Invoices.
 */
export class KpiOwnerDashboard extends Component {
    static template = xml/* xml */`
    <div class="o_kpi_owner_dashboard p-4">

        <div class="d-flex justify-content-between align-items-center mb-4">
            <h2 class="fw-bold">
                <i class="fa fa-briefcase me-2 text-primary"/> Owner Dashboard
                <span class="text-muted small ms-2">Certified tasks ready to invoice</span>
            </h2>
            <button class="btn btn-outline-primary" t-on-click="refresh">
                <i class="fa fa-refresh me-1"/> Refresh
            </button>
        </div>

        <!-- Project filter (narrows visible cards) -->
        <div t-if="state.clients.length > 1" class="card p-2 mb-3 shadow-sm bg-light">
            <div class="row g-2 align-items-center">
                <div class="col-auto fw-bold small text-muted">
                    <i class="fa fa-filter me-1"/> Filter by Project:
                </div>
                <div class="col-md-5">
                    <select class="form-select form-select-sm" t-model="state.projectFilter">
                        <option value="">All projects</option>
                        <t t-foreach="state.clients" t-as="c" t-key="c.client_id">
                            <option t-att-value="c.client_id" t-esc="c.client_name"/>
                        </t>
                    </select>
                </div>
                <div t-if="state.projectFilter" class="col-auto">
                    <button class="btn btn-sm btn-outline-secondary"
                            t-on-click="() => state.projectFilter = ''">
                        <i class="fa fa-times me-1"/> Clear
                    </button>
                </div>
                <div class="col-auto small text-muted">
                    Showing <strong t-esc="filteredClients.length"/> / <t t-esc="state.clients.length"/>
                </div>
            </div>
        </div>

        <div t-if="filteredClients.length === 0" class="card p-5 text-center text-muted shadow-sm">
            <i class="fa fa-handshake-o fa-3x mb-3"/>
            <h4 class="text-muted">No billable clients yet.</h4>
        </div>

        <!-- Per-client cards -->
        <div class="row g-3">
            <t t-foreach="filteredClients" t-as="c" t-key="c.client_id">
                <div class="col-md-6 col-xl-4">
                    <div class="card shadow-sm h-100 border-start border-primary border-4">
                        <div class="card-body">
                            <div class="d-flex justify-content-between align-items-start mb-2">
                                <div>
                                    <h5 class="card-title mb-1" t-esc="c.client_name"/>
                                    <small t-if="c.parent_name" class="text-muted">
                                        under <t t-esc="c.parent_name"/>
                                    </small>
                                </div>
                                <span t-if="c.currency_name" class="badge bg-light text-dark border" t-esc="c.currency_name"/>
                            </div>

                            <!-- Stats row -->
                            <div class="row g-2 my-3">
                                <div class="col-4 text-center">
                                    <div class="small text-muted">Certified</div>
                                    <div class="fw-bold fs-4 text-success" t-esc="c.completed_count"/>
                                </div>
                                <div class="col-4 text-center">
                                    <div class="small text-muted">Awaiting</div>
                                    <div class="fw-bold fs-4 text-warning" t-esc="c.awaiting_client_count"/>
                                </div>
                                <div class="col-4 text-center">
                                    <div class="small text-muted">In Progress</div>
                                    <div class="fw-bold fs-4 text-info" t-esc="c.in_progress_count"/>
                                </div>
                            </div>

                            <!-- Hours strip -->
                            <div class="border-top pt-2 mb-2 small">
                                <div class="d-flex justify-content-between">
                                    <span>Actual hours:</span>
                                    <strong t-esc="c.total_actual_hours + 'h'"/>
                                </div>
                                <div class="d-flex justify-content-between">
                                    <span>Quoted hours:</span>
                                    <strong t-esc="c.total_quoted_hours + 'h'"/>
                                </div>
                            </div>

                            <!-- Last invoice -->
                            <div t-if="c.last_invoice_name" class="small text-muted mb-2">
                                Last invoice: <strong t-esc="c.last_invoice_name"/>
                                <span class="badge ms-1"
                                      t-att-class="c.last_invoice_state === 'sent' ? 'bg-success' : (c.last_invoice_state === 'finalized' ? 'bg-warning text-dark' : 'bg-secondary')"
                                      t-esc="c.last_invoice_state"/>
                                <span t-if="c.last_invoice_date"> on <t t-esc="c.last_invoice_date"/></span>
                            </div>
                            <div t-else="" class="small text-muted mb-2">
                                <i class="fa fa-info-circle me-1"/> No invoices yet
                            </div>

                            <!-- Per-project breakdown (collapsible) -->
                            <div t-if="c.projects and c.projects.length > 0" class="border-top pt-2 mt-2">
                                <button class="btn btn-sm btn-link p-0 text-decoration-none"
                                        t-on-click="() => this.toggleProjects(c.client_id)">
                                    <i class="fa"
                                       t-att-class="state.expandedProjects[c.client_id] ? 'fa-caret-down' : 'fa-caret-right'"/>
                                    Projects (<t t-esc="c.projects.length"/>)
                                </button>
                                <div t-if="state.expandedProjects[c.client_id]" class="mt-2">
                                    <t t-foreach="c.projects" t-as="p" t-key="p.project_id">
                                        <div class="card bg-light p-2 mb-2 border-start border-info border-3">
                                            <div class="d-flex justify-content-between align-items-start">
                                                <div>
                                                    <div class="fw-bold small" t-esc="p.project_name"/>
                                                    <div class="small text-muted">
                                                        <span class="text-success" t-esc="p.completed_count + ' certified'"/>
                                                        <span class="ms-2 text-warning" t-esc="p.awaiting_client_count + ' awaiting'"/>
                                                        <span class="ms-2 text-info" t-esc="p.in_progress_count + ' active'"/>
                                                    </div>
                                                    <div class="small text-muted">
                                                        Actual <t t-esc="p.total_actual_hours"/>h · Quoted <t t-esc="p.total_quoted_hours"/>h
                                                    </div>
                                                </div>
                                                <button class="btn btn-sm btn-outline-success"
                                                        t-att-disabled="!p.completed_count"
                                                        t-att-title="!p.completed_count ? 'No certified tasks for this project' : 'Invoice this project'"
                                                        t-on-click="() => this.goToInvoiceProject(c.client_id, p.project_id)">
                                                    <i class="fa fa-file-text-o me-1"/> Invoice this project
                                                </button>
                                            </div>
                                        </div>
                                    </t>
                                </div>
                            </div>

                            <div class="d-flex gap-2 mt-3">
                                <button class="btn btn-sm btn-outline-primary flex-grow-1"
                                        t-on-click="() => this.drillDown(c.client_id, c.client_name)">
                                    <i class="fa fa-list me-1"/> View Certified Tasks
                                </button>
                                <button class="btn btn-sm btn-success"
                                        t-att-disabled="!c.completed_count"
                                        t-att-title="!c.completed_count ? 'No certified tasks yet' : 'Generate invoice from certified tasks'"
                                        t-on-click="() => this.goToInvoice(c.client_id, c.client_name)">
                                    <i class="fa fa-file-text-o me-1"/> Invoice
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </t>
        </div>

        <!-- Drill-down modal -->
        <div t-if="state.drilldown.open" class="modal d-block" tabindex="-1" style="background: rgba(0,0,0,0.5);">
            <div class="modal-dialog modal-xl">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">
                            <i class="fa fa-list me-2"/> Certified Tasks — <t t-esc="state.drilldown.client_name"/>
                        </h5>
                        <button type="button" class="btn-close" t-on-click="closeDrilldown"/>
                    </div>
                    <div class="modal-body">
                        <!-- Drill-down task filter -->
                        <div t-if="state.drilldown.tasks.length > 0" class="mb-2">
                            <div class="input-group input-group-sm" style="max-width: 360px">
                                <span class="input-group-text">
                                    <i class="fa fa-search"/>
                                </span>
                                <input type="text" class="form-control"
                                       placeholder="Filter by task name, ref, developer..."
                                       t-model="state.drilldown.textFilter"/>
                                <button t-if="state.drilldown.textFilter"
                                        class="btn btn-outline-secondary"
                                        t-on-click="() => state.drilldown.textFilter = ''">
                                    <i class="fa fa-times"/>
                                </button>
                            </div>
                        </div>
                        <div t-if="filteredDrilldownTasks.length === 0" class="text-center text-muted p-4">
                            <i class="fa fa-inbox fa-2x mb-2 d-block"/>
                            <t t-if="state.drilldown.tasks.length === 0">No certified tasks for this client yet.</t>
                            <t t-else="">No tasks match the filter.</t>
                        </div>
                        <table t-if="filteredDrilldownTasks.length > 0" class="table table-sm">
                            <thead class="table-light">
                                <tr>
                                    <th style="width: 90px">Ref</th>
                                    <th>Task</th>
                                    <th>Developer</th>
                                    <th>Signed by Client</th>
                                    <th class="text-end">Actual</th>
                                    <th class="text-end">Quoted</th>
                                    <th>Signed On</th>
                                </tr>
                            </thead>
                            <tbody>
                                <t t-foreach="filteredDrilldownTasks" t-as="t" t-key="t.id">
                                    <tr>
                                        <td><span class="badge bg-secondary" t-esc="t.external_ref or '—'"/></td>
                                        <td class="fw-bold" t-esc="t.name"/>
                                        <td t-esc="t.primary_assignee"/>
                                        <td t-esc="t.client_signed_by or '—'"/>
                                        <td class="text-end" t-esc="t.actual_hours + 'h'"/>
                                        <td class="text-end" t-esc="t.quoted_hours + 'h'"/>
                                        <td t-esc="t.signed_date or t.completion_date"/>
                                    </tr>
                                </t>
                            </tbody>
                            <tfoot>
                                <tr class="table-light">
                                    <th colspan="4" class="text-end">Total:</th>
                                    <th class="text-end" t-esc="filteredDrilldownTasks.reduce((a, t) => a + t.actual_hours, 0).toFixed(2) + 'h'"/>
                                    <th class="text-end" t-esc="filteredDrilldownTasks.reduce((a, t) => a + t.quoted_hours, 0).toFixed(2) + 'h'"/>
                                    <th/>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-secondary" t-on-click="closeDrilldown">Close</button>
                        <button class="btn btn-success"
                                t-att-disabled="!state.drilldown.tasks.length"
                                t-on-click="() => this.goToInvoice(state.drilldown.client_id, state.drilldown.client_name)">
                            <i class="fa fa-file-text-o me-1"/> Generate Invoice
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>
    `;

    get filteredClients() {
        if (!this.state.projectFilter) return this.state.clients;
        const pid = parseInt(this.state.projectFilter, 10);
        return this.state.clients.filter(c => c.client_id === pid);
    }
    get filteredDrilldownTasks() {
        const tasks = this.state.drilldown.tasks || [];
        const q = (this.state.drilldown.textFilter || '').trim().toLowerCase();
        if (!q) return tasks;
        return tasks.filter(t =>
            (t.name || '').toLowerCase().includes(q) ||
            (t.external_ref || '').toLowerCase().includes(q) ||
            (t.primary_assignee || '').toLowerCase().includes(q) ||
            (t.client_signed_by || '').toLowerCase().includes(q)
        );
    }

    setup() {
        this.state = useState({
            clients: [],
            projectFilter: '',
            drilldown: { open: false, client_id: null, client_name: '', tasks: [], textFilter: '' },
            expandedProjects: {},   // {client_id: bool}
        });
        onWillStart(async () => { await this.refresh(); });
    }

    toggleProjects(client_id) {
        this.state.expandedProjects[client_id] = !this.state.expandedProjects[client_id];
    }

    async refresh() {
        const r = await rpc('/kpi_owner/certified_by_client', {});
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        this.state.clients = r.clients || [];
    }

    async drillDown(client_id, client_name) {
        this.state.drilldown.client_id = client_id;
        this.state.drilldown.client_name = client_name;
        this.state.drilldown.tasks = [];
        this.state.drilldown.textFilter = '';
        this.state.drilldown.open = true;
        const r = await rpc('/kpi_owner/client_certified_tasks', { client_kra_id: client_id });
        if (r && r.status) this.state.drilldown.tasks = r.tasks || [];
    }

    closeDrilldown() {
        this.state.drilldown.open = false;
        this.state.drilldown.client_id = null;
        this.state.drilldown.tasks = [];
        this.state.drilldown.textFilter = '';
    }

    goToInvoice(client_id, client_name) {
        // Navigate the user to the Client Invoices screen with the picked client preselected.
        try {
            sessionStorage.setItem('kpi_invoice_prefill', JSON.stringify({
                client_kra_id: client_id,
                sub_kra_ids: [],
            }));
        } catch (e) { /* sessionStorage blocked — invoice screen will just open empty */ }
        window.location.hash = '#action=kpi_client_invoice_admin';
        this.closeDrilldown();
    }

    goToInvoiceProject(client_id, project_id) {
        // Same as goToInvoice but also preselects the sub-KRA (project) filter.
        try {
            sessionStorage.setItem('kpi_invoice_prefill', JSON.stringify({
                client_kra_id: client_id,
                sub_kra_ids: [project_id],
            }));
        } catch (e) { /* ignore */ }
        window.location.hash = '#action=kpi_client_invoice_admin';
    }
}

registry.category("actions").add("kpi_owner_dashboard", KpiOwnerDashboard);
