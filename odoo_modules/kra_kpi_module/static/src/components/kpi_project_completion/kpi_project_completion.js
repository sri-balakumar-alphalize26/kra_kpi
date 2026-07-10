/** @odoo-module **/
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

export class KpiProjectCompletion extends Component {
    static template = xml/* xml */`
    <div class="o_kpi_project_completion p-4">
        <h2 class="fw-bold mb-4">
            <i class="fa fa-check-square-o me-2 text-primary"/> Project Completion Check
        </h2>

        <!-- Filter card -->
        <div class="card p-3 mb-4 shadow-sm">
            <div class="row g-3 align-items-end">
                <div class="col-md-4">
                    <label class="form-label fw-bold">Client (Root KRA)</label>
                    <select class="form-select" t-model="state.client_kra_id" t-on-change="onClientChange">
                        <option value="">-- Select Client --</option>
                        <t t-foreach="state.clients" t-as="c" t-key="c.id">
                            <option t-att-value="c.id" t-esc="c.name"/>
                        </t>
                    </select>
                </div>
                <div class="col-md-5">
                    <label class="form-label fw-bold">Project (Sub-KRA)</label>
                    <select class="form-select" t-model="state.project_kra_id">
                        <option value="">-- Select Project --</option>
                        <t t-foreach="state.subKras" t-as="s" t-key="s.id">
                            <option t-att-value="s.id" t-esc="s.display"/>
                        </t>
                    </select>
                </div>
                <div class="col-md-3">
                    <button class="btn btn-primary w-100" t-on-click="loadStatus">
                        <i class="fa fa-search me-1"/> Check Status
                    </button>
                </div>
            </div>
        </div>

        <!-- Empty state -->
        <div t-if="!state.report" class="card p-5 text-center text-muted shadow-sm">
            <i class="fa fa-clipboard-check fa-3x mb-3"/>
            <div>Pick a project and click "Check Status" to see completion progress.</div>
        </div>

        <!-- Report -->
        <t t-if="state.report">
            <!-- Totals strip -->
            <div class="row g-3 mb-3">
                <div class="col-md-3">
                    <div class="card p-3 text-center">
                        <div class="small text-muted">Requirements</div>
                        <div class="fs-4 fw-bold">
                            <t t-esc="state.report.totals.requirements_done"/>
                            <span class="text-muted">/ <t t-esc="state.report.totals.requirements_total"/></span>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card p-3 text-center">
                        <div class="small text-muted">Updates</div>
                        <div class="fs-4 fw-bold">
                            <t t-esc="state.report.totals.updates_done"/>
                            <span class="text-muted">/ <t t-esc="state.report.totals.updates_total"/></span>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card p-3 text-center">
                        <div class="small text-muted">Bugs</div>
                        <div class="fs-4 fw-bold">
                            <t t-esc="state.report.totals.bugs_done"/>
                            <span class="text-muted">/ <t t-esc="state.report.totals.bugs_total"/></span>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card p-3 text-center"
                         t-att-class="state.report.totals.project_complete ? 'bg-success text-white' : 'bg-warning text-dark'">
                        <div class="small">Overall</div>
                        <div class="fs-4 fw-bold">
                            <t t-if="state.report.totals.project_complete">
                                <i class="fa fa-check-circle me-1"/> Complete
                            </t>
                            <t t-else="">
                                <i class="fa fa-clock-o me-1"/> In Progress
                            </t>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Per-requirement breakdown -->
            <div t-if="state.report.requirements.length > 0" class="card p-3 mb-3 shadow-sm">
                <h5 class="fw-bold mb-3">
                    <i class="fa fa-list-ol me-2 text-info"/> Per-Requirement Breakdown
                </h5>
                <t t-foreach="state.report.requirements" t-as="grp" t-key="grp.ref">
                    <div class="border rounded p-3 mb-3"
                         t-att-class="grp.req and grp.req.task_state === 'completed' ? 'border-success' : 'border-warning'">
                        <!-- Requirement header -->
                        <div class="d-flex justify-content-between align-items-center">
                            <div>
                                <span class="badge bg-primary me-2" t-esc="grp.ref"/>
                                <strong>
                                    <t t-if="grp.req" t-esc="grp.req.name"/>
                                    <t t-else=""><em class="text-muted">No requirement KPI found for this ref</em></t>
                                </strong>
                            </div>
                            <div>
                                <t t-if="grp.req">
                                    <span class="badge me-1"
                                          t-att-class="grp.req.task_state === 'completed' ? 'bg-success' : 'bg-secondary'"
                                          t-esc="grp.req.task_state"/>
                                    <span class="badge bg-light text-dark me-1"
                                          t-esc="(grp.req.actual_hours || 0).toFixed(2) + 'h actual'"/>
                                    <span t-if="grp.req.has_signed_cert" class="badge bg-info">
                                        <i class="fa fa-paperclip"/> signed
                                    </span>
                                </t>
                            </div>
                        </div>
                        <!-- Linked updates -->
                        <div t-if="grp.updates.length > 0" class="mt-2 ms-3">
                            <div class="small text-muted">Updates (<t t-esc="grp.updates.length"/>):</div>
                            <ul class="mb-0 small">
                                <t t-foreach="grp.updates" t-as="u" t-key="u.id">
                                    <li>
                                        <span class="badge bg-warning text-dark me-1" t-esc="u.external_ref or '—'"/>
                                        <t t-esc="u.name"/>
                                        <span class="badge ms-1"
                                              t-att-class="u.task_state === 'completed' ? 'bg-success' : 'bg-secondary'"
                                              t-esc="u.task_state"/>
                                    </li>
                                </t>
                            </ul>
                        </div>
                        <!-- Linked bugs -->
                        <div t-if="grp.bugs.length > 0" class="mt-2 ms-3">
                            <div class="small text-muted">Bugs (<t t-esc="grp.bugs.length"/>):</div>
                            <ul class="mb-0 small">
                                <t t-foreach="grp.bugs" t-as="b" t-key="b.id">
                                    <li>
                                        <span class="badge bg-danger me-1" t-esc="b.external_ref or '—'"/>
                                        <t t-esc="b.name"/>
                                        <span class="badge ms-1"
                                              t-att-class="b.task_state === 'completed' ? 'bg-success' : 'bg-secondary'"
                                              t-esc="b.task_state"/>
                                    </li>
                                </t>
                            </ul>
                        </div>
                    </div>
                </t>
            </div>

            <!-- Orphans -->
            <div t-if="state.report.orphan_updates.length > 0 or state.report.orphan_bugs.length > 0"
                 class="card p-3 shadow-sm border-warning">
                <h5 class="fw-bold mb-3 text-warning">
                    <i class="fa fa-exclamation-triangle me-2"/> Orphan Items
                    <span class="text-muted small">(no parent requirement found — fix the "Linked Req" field on the KPI)</span>
                </h5>
                <div t-if="state.report.orphan_updates.length > 0">
                    <div class="fw-bold">Updates without linked requirement:</div>
                    <ul class="small">
                        <t t-foreach="state.report.orphan_updates" t-as="u" t-key="u.id">
                            <li>
                                <span class="badge bg-warning text-dark me-1" t-esc="u.external_ref or '—'"/>
                                <t t-esc="u.name"/>
                            </li>
                        </t>
                    </ul>
                </div>
                <div t-if="state.report.orphan_bugs.length > 0">
                    <div class="fw-bold">Bugs without linked requirement:</div>
                    <ul class="small">
                        <t t-foreach="state.report.orphan_bugs" t-as="b" t-key="b.id">
                            <li>
                                <span class="badge bg-danger me-1" t-esc="b.external_ref or '—'"/>
                                <t t-esc="b.name"/>
                            </li>
                        </t>
                    </ul>
                </div>
            </div>
        </t>
    </div>
    `;

    setup() {
        this.state = useState({
            clients: [],
            subKras: [],
            client_kra_id: '',
            project_kra_id: '',
            report: null,
        });
        onWillStart(async () => {
            const r = await rpc('/kpi_client_invoice/get_filters', {});
            if (r && r.status) this.state.clients = r.clients || [];
        });
    }

    async onClientChange() {
        this.state.project_kra_id = '';
        this.state.subKras = [];
        if (!this.state.client_kra_id) return;
        const r = await rpc('/kpi_completion_cert/get_sub_kras', {
            client_kra_id: this.state.client_kra_id,
        });
        if (r && r.status) this.state.subKras = r.kras || [];
    }

    async loadStatus() {
        if (!this.state.project_kra_id) {
            alert('Select a project first.');
            return;
        }
        const r = await rpc('/kpi_project/completion_status', {
            project_kra_id: this.state.project_kra_id,
        });
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        this.state.report = r;
    }
}

registry.category("actions").add("kpi_project_completion", KpiProjectCompletion);
