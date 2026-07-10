/** @odoo-module **/

import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";

export class KpiUnitReport extends Component {

    static template = xml/* xml */`
        <div class="o_kpi_unit_report p-4">

            <!-- Header -->
            <div class="d-flex justify-content-between align-items-center mb-4">
                <h2 class="fw-bold">KPI Unit Report</h2>
                <button class="btn btn-secondary" t-on-click="backToDashboard">
                    ← Back to Dashboard
                </button>
            </div>

            <!-- Filters Card -->
            <div class="card p-4 mb-4">
                <h4 class="fw-bold mb-3">Filters</h4>
                <div class="row g-3">
                    <div class="col-md-3">
                        <label class="form-label fw-bold">From Date</label>
                        <input type="date" class="form-control" t-model="state.filters.from_date"/>
                    </div>
                    <div class="col-md-3">
                        <label class="form-label fw-bold">To Date</label>
                        <input type="date" class="form-control" t-model="state.filters.to_date"/>
                    </div>
                    <div class="col-md-3">
                        <label class="form-label fw-bold">Employee Name</label>
                        <select class="form-select" t-model="state.filters.employee_id">
                            <option value="">All Employees</option>
                            <t t-foreach="state.employees" t-as="emp" t-key="emp.id">
                                <option t-att-value="emp.id" t-esc="emp.name"/>
                            </t>
                        </select>
                    </div>
                    <div class="col-md-3">
                        <label class="form-label fw-bold">Time Frame</label>
                        <select class="form-select" t-model="state.filters.time_frame" t-on-change="onTimeFrameChange">
                            <option value="">Custom</option>
                            <option value="yesterday">Yesterday</option>
                            <option value="last_month">Last Month</option>
                            <option value="last_year">Last Year</option>
                        </select>
                    </div>
                </div>

                <div class="mt-3">
                    <button class="btn btn-primary" t-on-click="generateReport">
                        <i class="fa fa-refresh me-2"></i>Generate Report
                    </button>
                </div>
            </div>

            <!-- Report Results -->
            <t t-if="state.reportGenerated">
                <div class="card p-4">
                    <h4 class="fw-bold mb-3">Employee Summary</h4>

                    <t t-if="state.reportData.length > 0">
                        <div class="alert alert-info mb-3">
                            <strong>Time Format:</strong> Displayed as Days (8hrs/day), Hours, Minutes
                            <br/>
                            Example: 3d 2h 30m = 3 days, 2 hours, 30 minutes = 26.5 total hours
                        </div>

                        <div class="table-responsive">
                            <table class="table table-bordered table-hover">
                                <thead class="table-light">
                                    <tr>
                                        <th>No</th>
                                        <th>Employee Name</th>
                                        <th>No. of Tasks</th>
                                        <th>Estimate Total</th>
                                        <th>Estimate Unit</th>
                                        <th>Duration</th>
                                    </tr>
                                </thead>

                                <tbody>
                                    <t t-foreach="state.reportData" t-as="row" t-key="row.employee_id">
                                        <tr>
                                            <td t-esc="row_index + 1"/>
                                            <td>
                                                <a href="#" class="text-primary fw-bold"
                                                   t-on-click="(e) => this.viewEmployeeTasks(e, row.employee_id, row.employee_name)">
                                                    <t t-esc="row.employee_name"/>
                                                </a>
                                            </td>
                                            <td class="fw-bold text-center" t-esc="row.no_of_tasks"/>
                                            <td t-esc="row.estimate_total_display"/>
                                            <td t-esc="row.estimate_unit.toFixed(2)"/>
                                            <td t-esc="row.duration_display"/>
                                        </tr>
                                    </t>
                                </tbody>

                                <tfoot class="table-light fw-bold">
                                    <tr>
                                        <td colspan="2">Total</td>
                                        <td class="text-center" t-esc="getTotalTasks()"/>
                                        <td t-esc="getTotalEstimateDisplay()"/>
                                        <td t-esc="getTotalEstimateUnit().toFixed(2)"/>
                                        <td t-esc="getTotalDurationDisplay()"/>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    </t>

                    <t t-else="">
                        <div class="alert alert-info">
                            <i class="fa fa-info-circle me-2"></i>
                            No data found for the selected filters.
                        </div>
                    </t>
                </div>
            </t>

            <!-- Task Details Modal -->
            <t t-if="state.showTaskDetails">
                <div class="modal-backdrop fade show"></div>
                <div class="modal d-block" tabindex="-1">
                    <div class="modal-dialog modal-xl">
                        <div class="modal-content">

                            <div class="modal-header">
                                <h5 class="modal-title">Task Details - 
                                    <t t-esc="state.selectedEmployeeName"/>
                                </h5>
                                <button type="button" class="btn-close" t-on-click="closeTaskDetails"></button>
                            </div>

                            <div class="modal-body">
                                <t t-if="state.employeeTasks.length > 0">
                                    <div class="table-responsive">
                                        <table class="table table-bordered">
                                            <thead class="table-light">
                                                <tr>
                                                    <th>SEQ No</th>
                                                    <th>Task Name</th>
                                                    <th>KRA</th>
                                                    <th>Priority</th>
                                                    <th>Status</th>
                                                    <th>Estimated Hrs</th>
                                                    <th>Hrs Spent</th>
                                                    <th>Unit Spent</th>
                                                    <th>Action</th>
                                                </tr>
                                            </thead>

                                            <tbody>
                                                <t t-foreach="state.employeeTasks" t-as="task" t-key="task.id">
                                                    <tr>
                                                        <td>
                                                            <a href="#" class="text-primary"
                                                               t-on-click="(e) => this.viewTaskDetail(e, task.id)">
                                                                <t t-esc="task.seq_no"/>
                                                            </a>
                                                        </td>
                                                        <td t-esc="task.name"/>
                                                        <td t-esc="task.kra_name || '-'"/>
                                                        <td>
                                                            <span t-att-class="'badge bg-' + getPriorityClass(task.priority)"
                                                                  t-esc="task.priority || '-'"/>
                                                        </td>
                                                        <td>
                                                            <span t-att-class="'badge bg-' + getStatusClass(task.task_state)"
                                                                  t-esc="task.task_state || '-'"/>
                                                        </td>
                                                        <td t-esc="task.estimated_hrs.toFixed(2)"/>
                                                        <td t-esc="task.hrs_spent.toFixed(2)"/>
                                                        <td t-esc="task.unit_spent.toFixed(2)"/>
                                                        <td>
                                                            <button class="btn btn-sm btn-info"
                                                                t-on-click="(e) => this.viewTaskDetail(e, task.id)">
                                                                <i class="fa fa-eye"></i> View
                                                            </button>
                                                        </td>
                                                    </tr>
                                                </t>
                                            </tbody>
                                        </table>
                                    </div>
                                </t>

                                <t t-else="">
                                    <div class="alert alert-info">
                                        No tasks found for this employee.
                                    </div>
                                </t>
                            </div>

                            <div class="modal-footer">
                                <button type="button" class="btn btn-secondary" t-on-click="closeTaskDetails">
                                    Close
                                </button>
                            </div>

                        </div>
                    </div>
                </div>
            </t>

            <!-- ✅ UPDATED: KPI Detail View Modal with Related Links -->
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
                                                <tr><td><b>Estimate</b></td><td t-esc="state.kpiDetail.estimate"/></tr>
                                                <tr><td><b>Points</b></td><td t-esc="state.kpiDetail.points"/></tr>
                                                <tr><td><b>Assignee</b></td><td t-esc="state.kpiDetail.assignee"/></tr>
                                                <tr><td><b>User Group</b></td><td t-esc="state.kpiDetail.user_group"/></tr>
                                                <tr><td><b>Deadline</b></td><td t-esc="state.kpiDetail.deadline"/></tr>
                                                <tr><td><b>Reminder Days</b></td><td t-esc="state.kpiDetail.reminder_days"/></tr>
                                                <tr><td><b>Next KPI</b></td><td t-esc="state.kpiDetail.next_kpi"/></tr>
                                                <tr><td><b>Warehouse</b></td><td t-esc="state.kpiDetail.warehouse"/></tr>
                                                <tr><td><b>File Name</b></td><td t-esc="state.kpiDetail.file_name"/></tr>
                                                <tr>
                                                    <td><b>Uploaded File</b></td>
                                                    <td>
                                                        <t t-if="state.kpiDetail.file_url">
                                                            <a class="btn btn-primary btn-sm" 
                                                               t-att-href="state.kpiDetail.file_url" 
                                                               t-att-download="state.kpiDetail.file_name || 'file'">
                                                                ⬇ Download File
                                                            </a>
                                                        </t>
                                                        <t t-else="">
                                                            <span class="text-muted">No file uploaded</span>
                                                        </t>
                                                    </td>
                                                </tr>
                                                <!-- ✅ NEW: Related Links Row -->
                                                <tr>
                                                    <td><b>Related Links</b></td>
                                                    <td>
                                                        <t t-set="parsedLinks" t-value="parseRelatedLinks(state.kpiDetail.related_links)"/>
                                                        <t t-if="parsedLinks.length > 0">
                                                            <ul class="list-unstyled mb-0">
                                                                <t t-foreach="parsedLinks" t-as="link" t-key="link_index">
                                                                    <li class="mb-1">
                                                                        <i class="fa fa-external-link text-primary me-1"/>
                                                                        <a t-att-href="link" target="_blank" class="text-truncate" style="max-width: 300px; display: inline-block;" t-esc="link"/>
                                                                    </li>
                                                                </t>
                                                            </ul>
                                                        </t>
                                                        <t t-else="">
                                                            <span class="text-muted">No links added</span>
                                                        </t>
                                                    </td>
                                                </tr>
                                                <tr><td><b>Actions</b></td><td t-esc="state.kpiDetail.actions || '-'"/></tr>
                                                <tr><td><b>Description</b></td><td t-esc="state.kpiDetail.description || '-'"/></tr>
                                                <tr><td><b>Checklist</b></td><td t-esc="state.kpiDetail.checklist || '-'"/></tr>
                                                <tr><td><b>Guidelines</b></td><td t-esc="state.kpiDetail.guidelines || '-'"/></tr>
                                                <tr><td><b>Is Mandatory</b></td><td t-esc="yesNo(state.kpiDetail.is_mandatory)"/></tr>
                                                <tr><td><b>Auto Estimated</b></td><td t-esc="yesNo(state.kpiDetail.auto_estimated)"/></tr>
                                                <tr><td><b>Service KPI</b></td><td t-esc="yesNo(state.kpiDetail.service_kpi)"/></tr>
                                                <tr><td><b>Coordinator Review</b></td><td t-esc="yesNo(state.kpiDetail.manager_review)"/></tr>
                                                <tr><td><b>Auto Assign</b></td><td t-esc="yesNo(state.kpiDetail.auto_assign)"/></tr>
                                                <tr><td><b>Is Permanent</b></td><td t-esc="yesNo(state.kpiDetail.is_permanent)"/></tr>
                                                <tr><td><b>Is Meeting</b></td><td t-esc="yesNo(state.kpiDetail.is_meeting)"/></tr>
                                                <tr><td><b>Customer Review</b></td><td t-esc="yesNo(state.kpiDetail.customer_review)"/></tr>
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
                from_date: this.getDefaultFromDate(),
                to_date: this.getDefaultToDate(),
                employee_id: "",
                time_frame: "",
            },
            employees: [],
            reportData: [],
            reportGenerated: false,
            showTaskDetails: false,
            employeeTasks: [],
            selectedEmployeeId: null,
            selectedEmployeeName: "",
            // KPI Detail Modal State
            showKpiDetail: false,
            kpiDetail: {},
            kpiDetailLoaded: false,
            kpiDetailError: null,
        });

        onWillStart(async () => {
            await this.loadEmployees();
        });
    }

    getDefaultFromDate() {
        const d = new Date();
        d.setDate(1);
        return d.toISOString().split("T")[0];
    }

    getDefaultToDate() {
        return new Date().toISOString().split("T")[0];
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

    onTimeFrameChange(event) {
        const tf = event.target.value;
        const today = new Date();

        if (tf === "yesterday") {
            const y = new Date(today);
            y.setDate(y.getDate() - 1);
            this.state.filters.from_date = y.toISOString().split("T")[0];
            this.state.filters.to_date = y.toISOString().split("T")[0];
        }
        else if (tf === "last_month") {
            const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            const last = new Date(today.getFullYear(), today.getMonth(), 0);
            this.state.filters.from_date = first.toISOString().split("T")[0];
            this.state.filters.to_date = last.toISOString().split("T")[0];
        }
        else if (tf === "last_year") {
            const first = new Date(today.getFullYear() - 1, 0, 1);
            const last = new Date(today.getFullYear() - 1, 11, 31);
            this.state.filters.from_date = first.toISOString().split("T")[0];
            this.state.filters.to_date = last.toISOString().split("T")[0];
        }
    }

    async generateReport() {
        try {
            const result = await rpc("/kpi_reports/unit/generate", {
                from_date: this.state.filters.from_date,
                to_date: this.state.filters.to_date,
                employee_id: this.state.filters.employee_id || null,
                time_frame: this.state.filters.time_frame || null,
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

    async viewEmployeeTasks(event, employeeId, employeeName) {
        if (event) event.preventDefault();

        try {
            const result = await rpc("/kpi_reports/unit/employee_tasks", {
                employee_id: employeeId,
                from_date: this.state.filters.from_date,
                to_date: this.state.filters.to_date,
            });

            if (result.status) {
                this.state.employeeTasks = result.tasks;
                this.state.selectedEmployeeId = employeeId;
                this.state.selectedEmployeeName = employeeName;
                this.state.showTaskDetails = true;
            }
        } catch (e) {
            console.error("Error loading employee tasks:", e);
            alert("Error loading tasks. Please try again.");
        }
    }

    async viewTaskDetail(event, taskId) {
        if (event) event.preventDefault();
        
        this.state.showKpiDetail = true;
        this.state.kpiDetailLoaded = false;
        this.state.kpiDetailError = null;
        this.state.kpiDetail = {};
        
        try {
            const result = await rpc("/kpi_action/details", { id: parseInt(taskId) });
            
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

    yesNo(value) {
        return value ? "Yes" : "No";
    }

    // ✅ NEW: Helper method to parse related links
    parseRelatedLinks(linksJson) {
        try {
            if (!linksJson) return [];
            const parsed = JSON.parse(linksJson);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.error("Error parsing related links:", e);
            return [];
        }
    }

    closeTaskDetails() {
        this.state.showTaskDetails = false;
        this.state.employeeTasks = [];
    }

    backToDashboard() {
        window.history.back();
    }

    getPriorityClass(priority) {
        const map = {
            'urgent': 'danger',
            'important': 'warning',
            'regular': 'info'
        };
        return map[priority] || 'secondary';
    }

    getStatusClass(status) {
        const map = {
            'completed': 'success',
            'in_progress': 'primary',
            'paused': 'warning',
            'assigned': 'secondary'
        };
        return map[status] || 'secondary';
    }

    // Totals
    getTotalTasks() {
        return this.state.reportData.reduce((s, r) => s + r.no_of_tasks, 0);
    }

    getTotalEstimateDisplay() {
        const total = this.state.reportData.reduce((s, r) => s + (r.estimate_total_hours || 0), 0);
        return this.formatTimeDisplay(total);
    }

    getTotalEstimateUnit() {
        return this.state.reportData.reduce((s, r) => s + (r.estimate_unit || 0), 0);
    }

    getTotalDurationDisplay() {
        const total = this.state.reportData.reduce((s, r) => s + (r.duration_hours || 0), 0);
        return this.formatTimeDisplay(total);
    }

    formatTimeDisplay(totalHours) {
        if (!totalHours || totalHours <= 0) return '0d 0h 0m';
        
        const days = Math.floor(totalHours / 8);
        const remainingHours = totalHours % 8;
        const hours = Math.floor(remainingHours);
        const minutes = Math.floor((remainingHours - hours) * 60);
        
        return `${days}d ${hours}h ${minutes}m`;
    }
}

registry.category("actions").add("kpi_unit_report", KpiUnitReport);