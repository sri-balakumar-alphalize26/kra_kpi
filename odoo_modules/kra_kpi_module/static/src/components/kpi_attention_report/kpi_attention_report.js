/** @odoo-module **/

import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";

export class KpiAttentionReport extends Component {
    static template = xml/* xml */`
        <div class="o_kpi_attention_report p-4">
            <!-- Header -->
            <div class="d-flex justify-content-between align-items-center mb-4">
                <h2 class="fw-bold">KPI Attention Report</h2>
                <button class="btn btn-secondary" t-on-click="backToDashboard">
                    ← Back to Dashboard
                </button>
            </div>

            <!-- Report Description -->
            <div class="alert alert-info mb-4">
                <h5 class="alert-heading">
                    <i class="fa fa-info-circle me-2"></i>About This Report
                </h5>
                <p class="mb-0">
                    This report provides a centralized view of all paused KPI tasks that require managerial intervention. 
                    These tasks have been halted due to specific reasons such as pending clarification, resource allocation, 
                    or overlapping tasks. Use this report to quickly identify issues, address them, and enable team members 
                    to resume and complete their tasks.
                </p>
            </div>

            <!-- Filters Card -->
            <div class="card p-4 mb-4">
                <h4 class="fw-bold mb-3">Filters</h4>
                <div class="row g-3">
                    <div class="col-md-4">
                        <label class="form-label fw-bold">Employee Name</label>
                        <select class="form-select" t-model="state.filters.employee_id">
                            <option value="">All Employees</option>
                            <t t-foreach="state.employees" t-as="emp" t-key="emp.id">
                                <option t-att-value="emp.id" t-esc="emp.name"/>
                            </t>
                        </select>
                    </div>
                    <div class="col-md-4">
                        <label class="form-label fw-bold">From Date</label>
                        <input type="date" class="form-control" t-model="state.filters.from_date"/>
                    </div>
                    <div class="col-md-4">
                        <label class="form-label fw-bold">To Date</label>
                        <input type="date" class="form-control" t-model="state.filters.to_date"/>
                    </div>
                </div>

                <div class="mt-3">
                    <button class="btn btn-primary" t-on-click="generateReport">
                        <i class="fa fa-refresh me-2"></i>Generate Report
                    </button>
                    <button class="btn btn-outline-secondary ms-2" t-on-click="clearFilters">
                        <i class="fa fa-times me-2"></i>Clear Filters
                    </button>
                </div>
            </div>

            <!-- Report Results -->
            <t t-if="state.reportGenerated">
                <div class="card p-4">
                    <div class="d-flex justify-content-between align-items-center mb-3">
                        <h4 class="fw-bold mb-0">Paused KPI Tasks Requiring Attention</h4>
                        <span class="badge bg-warning text-dark fs-6">
                            <i class="fa fa-pause-circle me-1"></i>
                            <t t-esc="state.reportData.length"/> Task(s) Paused
                        </span>
                    </div>

                    <t t-if="state.reportData.length > 0">
                        <div class="table-responsive">
                            <table class="table table-bordered table-hover">
                                <thead class="table-warning">
                                    <tr>
                                        <th style="width: 5%;">No</th>
                                        <th style="width: 12%;">KPI Seq No</th>
                                        <th style="width: 20%;">KPI Name</th>
                                        <th style="width: 15%;">Employee Name</th>
                                        <th style="width: 12%;">Date Paused</th>
                                        <th style="width: 12%;">Time Paused</th>
                                        <th style="width: 24%;">Reason</th>
                                    </tr>
                                </thead>

                                <tbody>
                                    <t t-foreach="state.reportData" t-as="row" t-key="row.id">
                                        <tr class="align-middle">
                                            <td class="text-center" t-esc="row_index + 1"/>
                                            <td>
                                                <a href="#" 
                                                   class="text-primary fw-bold"
                                                   t-on-click="(e) => this.viewKpiDetail(e, row.id)">
                                                    <i class="fa fa-link me-1"></i>
                                                    <t t-esc="row.seq_no"/>
                                                </a>
                                            </td>
                                            <td>
                                                <strong t-esc="row.name"/>
                                                <t t-if="row.kra_name">
                                                    <br/>
                                                    <small class="text-muted">
                                                        KRA: <t t-esc="row.kra_name"/>
                                                    </small>
                                                </t>
                                            </td>
                                            <td>
                                                <i class="fa fa-user me-1"></i>
                                                <t t-esc="row.employee_name"/>
                                            </td>
                                            <td>
                                                <i class="fa fa-calendar me-1"></i>
                                                <t t-esc="row.paused_date"/>
                                            </td>
                                            <td>
                                                <i class="fa fa-clock-o me-1"></i>
                                                <t t-esc="row.paused_time"/>
                                            </td>
                                            <td>
                                                <span class="badge bg-danger me-2">!</span>
                                                <t t-esc="row.paused_reason || 'No reason provided'"/>
                                            </td>
                                        </tr>
                                    </t>
                                </tbody>
                            </table>
                        </div>

                        <!-- Summary Statistics -->
                        <div class="row mt-4">
                            <div class="col-md-3">
                                <div class="card bg-warning text-dark">
                                    <div class="card-body text-center">
                                        <h5>Total Paused</h5>
                                        <h2 t-esc="state.reportData.length"/>
                                        <p class="mb-0">tasks requiring attention</p>
                                    </div>
                                </div>
                            </div>
                            <div class="col-md-3">
                                <div class="card bg-info text-white">
                                    <div class="card-body text-center">
                                        <h5>Unique Employees</h5>
                                        <h2 t-esc="getUniqueEmployeeCount()"/>
                                        <p class="mb-0">with paused tasks</p>
                                    </div>
                                </div>
                            </div>
                            <div class="col-md-3">
                                <div class="card bg-danger text-white">
                                    <div class="card-body text-center">
                                        <h5>Oldest Pause</h5>
                                        <h2 t-esc="getOldestPauseDays()"/>
                                        <p class="mb-0">days ago</p>
                                    </div>
                                </div>
                            </div>
                            <div class="col-md-3">
                                <div class="card bg-secondary text-white">
                                    <div class="card-body text-center">
                                        <h5>Recent Pauses</h5>
                                        <h2 t-esc="getRecentPauseCount()"/>
                                        <p class="mb-0">in last 7 days</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </t>

                    <t t-else="">
                        <div class="alert alert-success">
                            <i class="fa fa-check-circle me-2"></i>
                            <strong>Great News!</strong> No paused tasks found for the selected filters. 
                            All team members are progressing smoothly on their KPIs.
                        </div>
                    </t>
                </div>
            </t>

            <!-- KPI Detail Modal -->
            <t t-if="state.showKpiDetail">
                <div class="modal-backdrop fade show"></div>
                <div class="modal d-block" tabindex="-1">
                    <div class="modal-dialog modal-xl">
                        <div class="modal-content">
                            <div class="modal-header">
                                <h5 class="modal-title">KPI Details</h5>
                                <button type="button" class="btn-close" t-on-click="closeKpiDetail"></button>
                            </div>

                            <div class="modal-body" style="max-height: 70vh; overflow-y: auto;">
                                <t t-if="state.kpiDetailLoaded and state.kpiDetail.name">
                                    <div class="card p-4 mb-3">
                                        <table class="table table-borderless">
                                            <tbody>
                                                <tr><td style="width:30%;"><b>Name</b></td><td t-esc="state.kpiDetail.name"/></tr>
                                                <tr><td><b>KRA</b></td><td t-esc="state.kpiDetail.kra"/></tr>
                                                <tr><td><b>Priority</b></td><td t-esc="state.kpiDetail.priority"/></tr>
                                                <tr><td><b>Status</b></td><td>
                                                    <span class="badge bg-warning">Paused</span>
                                                </td></tr>
                                                <tr><td><b>Estimate</b></td><td t-esc="state.kpiDetail.estimate"/></tr>
                                                <tr><td><b>Points</b></td><td t-esc="state.kpiDetail.points"/></tr>
                                                <tr><td><b>Assignee</b></td><td t-esc="state.kpiDetail.assignee"/></tr>
                                                <tr><td><b>User Group</b></td><td t-esc="state.kpiDetail.user_group"/></tr>
                                                <tr><td><b>Deadline</b></td><td t-esc="state.kpiDetail.deadline"/></tr>
                                               
                                                <tr><td><b>Description</b></td><td t-esc="state.kpiDetail.description || '-'"/></tr>
                                                <tr><td><b>Checklist</b></td><td t-esc="state.kpiDetail.checklist || '-'"/></tr>
                                                <tr><td><b>Guidelines</b></td><td t-esc="state.kpiDetail.guidelines || '-'"/></tr>
                                            </tbody>
                                        </table>
                                    </div>
                                </t>
                                <t t-elif="state.kpiDetailError">
                                    <div class="alert alert-danger">
                                        <p t-esc="state.kpiDetailError"/>
                                    </div>
                                </t>
                                <t t-else="">
                                    <div class="alert alert-info">
                                        <span class="spinner-border spinner-border-sm me-2"></span>
                                        Loading KPI details...
                                    </div>
                                </t>
                            </div>

                            <div class="modal-footer">
                                <button type="button" class="btn btn-secondary" t-on-click="closeKpiDetail">
                                    Close
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </t>
        </div>
    `;

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");

        this.state = useState({
            filters: {
                employee_id: "",
                from_date: "",
                to_date: "",
            },
            employees: [],
            reportData: [],
            reportGenerated: false,
            showKpiDetail: false,
            kpiDetail: {},
            kpiDetailLoaded: false,
            kpiDetailError: null,
        });

        onWillStart(async () => {
            await this.loadEmployees();
            // Auto-generate report on load to show all paused tasks
            await this.generateReport();
        });
    }

    async loadEmployees() {
        try {
            const users = await this.orm.searchRead(
                "res.users",
                [["share", "=", false]],
                ["id", "name"],
                { order: "name" }
            );
            this.state.employees = users;
        } catch (e) {
            console.error("Error loading employees:", e);
        }
    }

    async generateReport() {
        try {
            const result = await rpc("/kpi_reports/attention/generate", {
                employee_id: this.state.filters.employee_id || null,
                from_date: this.state.filters.from_date || null,
                to_date: this.state.filters.to_date || null,
            });

            if (result.status) {
                this.state.reportData = result.data;
                this.state.reportGenerated = true;
            } else {
                alert("Error generating report: " + result.message);
            }
        } catch (e) {
            console.error("Error generating report:", e);
            alert("Error generating report. Please try again.");
        }
    }

    clearFilters() {
        this.state.filters.employee_id = "";
        this.state.filters.from_date = "";
        this.state.filters.to_date = "";
    }

    async viewKpiDetail(event, kpiId) {
        if (event) event.preventDefault();
        
        this.state.showKpiDetail = true;
        this.state.kpiDetailLoaded = false;
        this.state.kpiDetailError = null;
        this.state.kpiDetail = {};
        
        try {
            const result = await rpc("/kpi_action/details", { id: parseInt(kpiId) });
            
            if (result && result.name) {
                this.state.kpiDetail = result;
                this.state.kpiDetailError = null;
            } else {
                this.state.kpiDetailError = "Failed to load KPI details";
            }
        } catch (error) {
            console.error("Error loading KPI details:", error);
            this.state.kpiDetailError = `Error: ${error.message || 'Failed to load KPI details'}`;
        } finally {
            this.state.kpiDetailLoaded = true;
        }
    }

    closeKpiDetail() {
        this.state.showKpiDetail = false;
        this.state.kpiDetail = {};
        this.state.kpiDetailLoaded = false;
        this.state.kpiDetailError = null;
    }

    backToDashboard() {
        window.history.back();
    }

    // Statistics Methods
    getUniqueEmployeeCount() {
        const uniqueEmployees = new Set(this.state.reportData.map(row => row.employee_id));
        return uniqueEmployees.size;
    }

    getOldestPauseDays() {
        if (this.state.reportData.length === 0) return 0;
        
        const today = new Date();
        let oldestDays = 0;
        
        this.state.reportData.forEach(row => {
            const pausedDate = new Date(row.paused_datetime);
            const daysDiff = Math.floor((today - pausedDate) / (1000 * 60 * 60 * 24));
            if (daysDiff > oldestDays) {
                oldestDays = daysDiff;
            }
        });
        
        return oldestDays;
    }

    getRecentPauseCount() {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        
        return this.state.reportData.filter(row => {
            const pausedDate = new Date(row.paused_datetime);
            return pausedDate >= sevenDaysAgo;
        }).length;
    }
}

registry.category("actions").add("kpi_attention_report", KpiAttentionReport);