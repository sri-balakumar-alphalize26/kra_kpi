/** @odoo-module **/
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";

export class KpiPerformanceReport extends Component {
    static template = xml/* xml */`
        <div class="o_kpi_performance_report p-4">
            <!-- Header -->
            <div class="d-flex justify-content-between align-items-center mb-4">
                <h2 class="fw-bold">KPI Performance Report</h2>
                <div>
                    <button class="btn btn-success me-2" 
                            t-on-click="downloadMainReportPDF" 
                            t-if="state.reportGenerated"
                            title="Download report as PDF">
                        <i class="fa fa-file-pdf-o me-2"></i>Download PDF
                    </button>
                    <button class="btn btn-secondary" t-on-click="backToDashboard">
                        ← Back to Dashboard
                    </button>
                </div>
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
                    <button class="btn btn-primary" t-on-click="generateReport" t-att-disabled="state.isLoading">
                        <i class="fa fa-refresh me-2" t-att-class="{'fa-spin': state.isLoading}"></i>
                        <t t-if="state.isLoading">Generating...</t>
                        <t t-else="">Generate Report</t>
                    </button>
                </div>
            </div>

            <!-- Missing Salary/Attendance Warning -->
            <t t-if="state.missingEmployees.length > 0">
                <div class="alert alert-warning mb-4">
                    <h5 class="alert-heading">
                        <i class="fa fa-exclamation-triangle me-2"></i>
                        Missing Salary/Attendance Data
                    </h5>
                    <p>The following employees don't have salary/attendance hours configured:</p>
                    <ul class="mb-2">
                        <t t-foreach="state.missingEmployees" t-as="emp" t-key="emp.id">
                            <li t-esc="emp.name"/>
                        </t>
                    </ul>
                    <p class="mb-0">
                        <strong>Configure in:</strong> KPI Reports → Employee Salary Master
                    </p>
                </div>
            </t>

            <!-- Report Results -->
            <t t-if="state.reportGenerated">
                <div class="card p-4">
                    <h4 class="fw-bold mb-3">Performance Analysis</h4>
                    
                    <t t-if="state.reportData.length > 0">
                        <div class="table-responsive">
                            <table class="table table-bordered table-hover table-sm">
                                <thead class="table-light">
                                    <tr>
                                        <th>S.No</th>
                                        <th>Name</th>
                                        <th>Salary</th>
                                        <th>Working Days</th>
                                        <th>Estimated Hrs</th>
                                        <th>Estimated Unit</th>
                                        <th>Actual Hrs</th>
                                        <th>Productivity Units</th>
                                        <th>Performance Deviation</th>
                                        <th>Available Units</th>
                                        <th>Unit Cost</th>
                                        <th>Productivity Cost</th>
                                        <th>Productivity Cost %</th>
                                        <th>Remarks</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <t t-foreach="state.reportData" t-as="row" t-key="row.employee_id">
                                        <tr t-att-class="getRowClass(row)">
                                            <td t-esc="row_index + 1"/>
                                            <td class="fw-bold">
                                                <a href="#" 
                                                   class="text-primary text-decoration-none"
                                                   t-on-click.prevent="(e) => this.showEmployeeDetail(row.employee_id)"
                                                   style="cursor: pointer;">
                                                    <i class="fa fa-user me-1"></i>
                                                    <t t-esc="row.employee_name"/>
                                                </a>
                                            </td>
                                            <td t-esc="row.salary.toFixed(2)"/>
                                            <td t-esc="row.working_days"/>
                                            <td t-esc="formatHoursWithMinutes(row.estimated_hours)"/>
                                            <td t-esc="row.estimated_units.toFixed(2)"/>
                                            <td t-esc="formatHoursWithMinutes(row.actual_hours)"/>
                                            <td t-esc="row.productivity_units.toFixed(2)"/>
                                            <td>
                                                <span t-att-class="getDeviationClass(row.performance_deviation, row)">
                                                    <t t-esc="row.performance_deviation.toFixed(2)"/>
                                                </span>
                                            </td>
                                            <td t-esc="row.available_units.toFixed(2)"/>
                                            <td t-esc="row.unit_cost.toFixed(4)"/>
                                            <td t-esc="row.productivity_cost.toFixed(2)"/>
                                            <td><t t-esc="row.productivity_cost_pct.toFixed(2)"/>%</td>
                                            <td>
                                                <span t-att-class="row.remarks_class + ' fw-bold'" t-esc="row.remarks"/>
                                            </td>
                                        </tr>
                                    </t>
                                </tbody>
                                <tfoot class="table-light fw-bold">
                                    <tr>
                                        <td>-</td>
                                        <td>Total / Average</td>
                                        <td t-esc="getTotalSalary().toFixed(2)"/>
                                        <td t-esc="getTotalWorkingDays()"/>
                                        <td t-esc="formatHoursWithMinutes(getTotalEstimatedHours())"/>
                                        <td t-esc="getTotalEstimatedUnits().toFixed(2)"/>
                                        <td t-esc="formatHoursWithMinutes(getTotalActualHours())"/>
                                        <td t-esc="getTotalProductivityUnits().toFixed(2)"/>
                                        <td><t t-esc="getAveragePerformanceDeviation().toFixed(2)"/></td>
                                        <td t-esc="getTotalAvailableUnits().toFixed(2)"/>
                                        <td t-esc="getAverageUnitCost().toFixed(4)"/>
                                        <td t-esc="getTotalProductivityCost().toFixed(2)"/>
                                        <td><t t-esc="getAverageProductivityPct().toFixed(2)"/>%</td>
                                        <td>-</td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>

                        <!-- Summary Statistics -->
                        <div class="row mt-4">
                            <div class="col-md-3">
                                <div class="card bg-success text-white">
                                    <div class="card-body text-center">
                                        <h5>Excellent Performer</h5>
                                        <h2 t-esc="getCountByRemark('Excellent Performance')"/>
                                        <p class="mb-0">employees (Positive Deviation)</p>
                                    </div>
                                </div>
                            </div>
                            <div class="col-md-3">
                                <div class="card bg-danger text-white">
                                    <div class="card-body text-center">
                                        <h5>Low Performer</h5>
                                        <h2 t-esc="getCountByRemark('Low Performance')"/>
                                        <p class="mb-0">employees (Negative Deviation)</p>
                                    </div>
                                </div>
                            </div>
                            <div class="col-md-3">
                                <div class="card bg-primary text-white">
                                    <div class="card-body text-center">
                                        <h5>Not Started</h5>
                                        <h2 t-esc="getCountByRemark('Not Started')"/>
                                        <p class="mb-0">employees (Task Assigned)</p>
                                    </div>
                                </div>
                            </div>
                            <div class="col-md-3">
                                <div class="card bg-warning text-dark">
                                    <div class="card-body text-center">
                                        <h5>No Tasks Assigned</h5>
                                        <h2 t-esc="getCountByRemark('No Tasks Assigned')"/>
                                        <p class="mb-0">employees (Idle)</p>
                                    </div>
                                </div>
                            </div>
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
            
            <!-- Performance Metrics Info -->
            <t t-if="state.reportGenerated">
                <div class="alert alert-info mb-4">
                    <h5 class="alert-heading">📊 Performance Metrics</h5>
                    <ul class="mb-0">
                        <li><strong>Unit Calculation:</strong> 1 hour = 100 units</li>
                        <li><strong>Available Hours:</strong> Working Days × Attendance Hours/Day</li>
                        <li><strong>Available Units:</strong> Available Hours × 100</li>
                        <li><strong>Estimated Unit:</strong> Estimated Hours × 100</li>
                        <li><strong>Productivity Units:</strong> Actual Hours × 100</li>
                        <li><strong>Performance Deviation:</strong> Estimated Units - Productivity Units</li>
                        <li><strong>Unit Cost:</strong> Salary / Available Units</li>
                        <li><strong>Productivity Cost:</strong> Productivity Units × Unit Cost</li>
                        <li><strong>Productivity Cost %:</strong> (Actual Hours / Available Hours) × 100</li>
                    </ul>
                    <hr/>
                    <h6 class="mt-3">Performance Categories:</h6>
                    <ul class="mb-0">
                        <li><strong class="text-success">Excellent Performance:</strong> Positive Performance Deviation (completed work faster than estimated)</li>
                        <li><strong class="text-danger">Low Performance:</strong> Negative Performance Deviation (took longer than estimated)</li>
                        <li><strong class="text-primary">Not Started:</strong> Task assigned but work hasn't begun yet</li>
                        <li><strong class="text-warning">No Tasks Assigned:</strong> Employee is idle with no tasks</li>
                    </ul>
                </div>
            </t>

            <!-- ✅ NEW: Employee Detail Modal -->
            <t t-if="state.showModal">
                <div class="modal fade show d-block" tabindex="-1" style="background-color: rgba(0,0,0,0.5);">
                    <div class="modal-dialog modal-xl modal-dialog-scrollable">
                        <div class="modal-content">
                            <div class="modal-header bg-primary text-white">
                                <h5 class="modal-title">
                                    <i class="fa fa-user-circle me-2"></i>
                                    Individual Performance Report - <t t-esc="state.modalEmployeeName"/>
                                </h5>
                                <button type="button" class="btn-close btn-close-white" t-on-click="closeModal"></button>
                            </div>
                            <div class="modal-body">
                                <t t-if="state.loadingModal">
                                    <div class="text-center p-5">
                                        <i class="fa fa-spinner fa-spin fa-3x text-primary"></i>
                                        <p class="mt-3">Loading task details...</p>
                                    </div>
                                </t>
                                <t t-else="">
                                    <t t-if="state.modalTasks.length > 0">
                                        <!-- Summary Cards -->
                                        <div class="row mb-4">
                                            <div class="col-md-3">
                                                <div class="card border-primary">
                                                    <div class="card-body text-center">
                                                        <h6 class="text-muted">Total Tasks</h6>
                                                        <h3 class="text-primary mb-0" t-esc="state.modalTasks.length"/>
                                                    </div>
                                                </div>
                                            </div>
                                            <div class="col-md-3">
                                                <div class="card border-success">
                                                    <div class="card-body text-center">
                                                        <h6 class="text-muted">Excellent</h6>
                                                        <h3 class="text-success mb-0" t-esc="getModalTaskCountByDeviation('positive')"/>
                                                    </div>
                                                </div>
                                            </div>
                                            <div class="col-md-3">
                                                <div class="card border-danger">
                                                    <div class="card-body text-center">
                                                        <h6 class="text-muted">Low Performance</h6>
                                                        <h3 class="text-danger mb-0" t-esc="getModalTaskCountByDeviation('negative')"/>
                                                    </div>
                                                </div>
                                            </div>
                                            <div class="col-md-3">
                                                <div class="card border-warning">
                                                    <div class="card-body text-center">
                                                        <h6 class="text-muted">On Target</h6>
                                                        <h3 class="text-warning mb-0" t-esc="getModalTaskCountByDeviation('zero')"/>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>

                                        <!-- Task Details Table -->
                                        <div class="table-responsive">
                                            <table class="table table-bordered table-hover table-sm">
                                                <thead class="table-dark">
                                                    <tr>
                                                        <th>#</th>
                                                        <th>Task Name</th>
                                                        <th>Status</th>
                                                        <th>Estimated Hrs</th>
                                                        <th>Estimated Units</th>
                                                        <th>Actual Hrs</th>
                                                        <th>Productivity Units</th>
                                                        <th>Performance Deviation</th>
                                                        <th>Assignment Type</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    <t t-foreach="state.modalTasks" t-as="task" t-key="task.task_id">
                                                        <tr t-att-class="getModalTaskRowClass(task)">
                                                            <td t-esc="task_index + 1"/>
                                                            <td>
                                                                <div class="fw-bold" t-esc="task.task_name"/>
                                                                <small class="text-muted" t-if="task.kra_name">
                                                                    <i class="fa fa-folder me-1"></i>
                                                                    <t t-esc="task.kra_name"/>
                                                                </small>
                                                            </td>
                                                            <td>
                                                                <span t-att-class="getTaskStatusClass(task.status)" t-esc="formatTaskStatus(task.status)"/>
                                                            </td>
                                                            <td t-esc="task.estimated_hrs"/>
                                                            <td t-esc="task.estimated_units"/>
                                                            <td t-esc="task.actual_hrs"/>
                                                            <td t-esc="task.productivity_units"/>
                                                            <td>
                                                                <span t-att-class="getModalDeviationClass(task.performance_deviation)">
                                                                    <t t-esc="task.performance_deviation"/>
                                                                </span>
                                                            </td>
                                                            <td>
                                                                <span t-att-class="getAssignmentTypeClass(task.assignment_type)" t-esc="task.assignment_type"/>
                                                            </td>
                                                        </tr>
                                                    </t>
                                                </tbody>
                                                <tfoot class="table-light fw-bold">
                                                    <tr>
                                                        <td colspan="3" class="text-end">Totals:</td>
                                                        <td t-esc="getModalTotalEstimatedHrs()"/>
                                                        <td t-esc="getModalTotalEstimatedUnits()"/>
                                                        <td t-esc="getModalTotalActualHrs()"/>
                                                        <td t-esc="getModalTotalProductivityUnits()"/>
                                                        <td t-esc="getModalTotalDeviation()"/>
                                                        <td>-</td>
                                                    </tr>
                                                </tfoot>
                                            </table>
                                        </div>
                                    </t>
                                    <t t-else="">
                                        <div class="alert alert-info">
                                            <i class="fa fa-info-circle me-2"></i>
                                            No tasks found for this employee in the selected date range.
                                        </div>
                                    </t>
                                </t>
                            </div>
                            <div class="modal-footer">
                                <button type="button" 
                                        class="btn btn-success me-2" 
                                        t-on-click="downloadEmployeeDetailPDF"
                                        title="Download individual performance as PDF">
                                    <i class="fa fa-file-pdf-o me-2"></i>Download PDF
                                </button>
                                <button type="button" class="btn btn-secondary" t-on-click="closeModal">
                                    <i class="fa fa-times me-2"></i>Close
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
        
        this.state = useState({
            filters: {
                from_date: this.getDefaultFromDate(),
                to_date: this.getDefaultToDate(),
                employee_id: '',
                time_frame: ''
            },
            employees: [],
            reportData: [],
            reportGenerated: false,
            isLoading: false,
            missingEmployees: [],
            // Modal state
            showModal: false,
            loadingModal: false,
            modalEmployeeName: '',
            modalTasks: []
        });

        onWillStart(async () => {
            await this.loadEmployees();
        });
    }

    formatHoursWithMinutes(hours) {
        if (!hours || hours <= 0) {
            return '0 mins (0.00hrs)';
        }
        
        const totalMinutes = Math.round(hours * 60);
        return `${totalMinutes} mins (${hours.toFixed(2)}hrs)`;
    }

    getDefaultFromDate() {
        const date = new Date();
        date.setDate(1);
        return date.toISOString().split('T')[0];
    }

    getDefaultToDate() {
        const date = new Date();
        return date.toISOString().split('T')[0];
    }

    async loadEmployees() {
        try {
            const users = await this.orm.searchRead('res.users', 
                [['share', '=', false]], 
                ['id', 'name'], 
                { order: 'name' }
            );
            this.state.employees = users;
        } catch (e) {
            console.error('Error loading employees:', e);
        }
    }

    onTimeFrameChange(ev) {
        const timeFrame = ev.target.value;
        const today = new Date();
        
        if (timeFrame === 'yesterday') {
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            this.state.filters.from_date = yesterday.toISOString().split('T')[0];
            this.state.filters.to_date = yesterday.toISOString().split('T')[0];
        } else if (timeFrame === 'last_month') {
            const firstDay = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            const lastDay = new Date(today.getFullYear(), today.getMonth(), 0);
            this.state.filters.from_date = firstDay.toISOString().split('T')[0];
            this.state.filters.to_date = lastDay.toISOString().split('T')[0];
        } else if (timeFrame === 'last_year') {
            const firstDay = new Date(today.getFullYear() - 1, 0, 1);
            const lastDay = new Date(today.getFullYear() - 1, 11, 31);
            this.state.filters.from_date = firstDay.toISOString().split('T')[0];
            this.state.filters.to_date = lastDay.toISOString().split('T')[0];
        }
    }

    async generateReport() {
        try {
            this.state.isLoading = true;
            this.state.reportGenerated = false;
            this.state.missingEmployees = [];
            
            const result = await rpc('/kpi_reports/performance/generate_direct', {
                from_date: this.state.filters.from_date,
                to_date: this.state.filters.to_date,
                employee_id: this.state.filters.employee_id || null
            });

            if (result.status) {
                this.state.reportData = result.data;
                this.state.reportGenerated = true;
                this.state.missingEmployees = result.missing_employees || [];
                
                if (this.state.missingEmployees.length > 0) {
                    setTimeout(() => {
                        document.querySelector('.alert-warning')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 100);
                }
            } else {
                alert('Error generating report: ' + result.message);
            }
        } catch (e) {
            console.error('Error generating report:', e);
            alert('Error generating report. Please try again.');
        } finally {
            this.state.isLoading = false;
        }
    }

    // ============================================================
    //  ✅ NEW: Show Employee Detail Modal
    // ============================================================
    async showEmployeeDetail(employeeId) {
        try {
            this.state.showModal = true;
            this.state.loadingModal = true;
            this.state.modalTasks = [];
            
            // Get employee name from report data
            const employee = this.state.reportData.find(row => row.employee_id === employeeId);
            this.state.modalEmployeeName = employee ? employee.employee_name : 'Employee';
            
            // Call API to get task details
            const result = await rpc('/kpi_reports/performance/employee_detail', {
                employee_id: employeeId,
                from_date: this.state.filters.from_date,
                to_date: this.state.filters.to_date
            });

            if (result.status) {
                this.state.modalTasks = result.tasks || [];
                this.state.modalEmployeeName = result.employee_name || this.state.modalEmployeeName;
            } else {
                alert('Error loading employee details: ' + result.message);
                this.state.showModal = false;
            }
        } catch (e) {
            console.error('Error loading employee details:', e);
            alert('Error loading employee details. Please try again.');
            this.state.showModal = false;
        } finally {
            this.state.loadingModal = false;
        }
    }

    closeModal() {
        this.state.showModal = false;
        this.state.modalTasks = [];
    }

    // Modal helper methods
    getModalTaskRowClass(task) {
        // ✅ FIX: Show violet for not started tasks (deviation = 0)
        if (task.actual_hrs === 0 && task.estimated_hrs > 0) {
            return 'table-primary';  // Violet color for not started
        } else if (task.performance_deviation > 0) {
            return 'table-success';
        } else if (task.performance_deviation < 0) {
            return 'table-danger';
        }
        return '';
    }

    getModalDeviationClass(deviation) {
        if (deviation === 0) {
            return 'badge bg-secondary';  // ✅ Violet/gray for 0 deviation
        } else if (deviation > 0) {
            return 'badge bg-success';
        } else {
            return 'badge bg-danger';
        }
    }

    getTaskStatusClass(status) {
        const statusClasses = {
            'completed': 'badge bg-success',
            'in_progress': 'badge bg-primary',
            'paused': 'badge bg-warning',
            'not_started': 'badge bg-secondary',
            'reassigned': 'badge bg-info'
        };
        return statusClasses[status] || 'badge bg-secondary';
    }

    formatTaskStatus(status) {
        const statusLabels = {
            'completed': 'Completed',
            'in_progress': 'In Progress',
            'paused': 'Paused',
            'not_started': 'Not Started',
            'reassigned': 'Reassigned'
        };
        return statusLabels[status] || status;
    }

    getAssignmentTypeClass(type) {
        return type === 'Current Assignee' ? 'badge bg-primary' : 'badge bg-info';
    }

    getModalTaskCountByDeviation(type) {
        if (type === 'positive') {
            return this.state.modalTasks.filter(t => t.performance_deviation > 0).length;
        } else if (type === 'negative') {
            return this.state.modalTasks.filter(t => t.performance_deviation < 0).length;
        } else {
            return this.state.modalTasks.filter(t => t.performance_deviation === 0).length;
        }
    }

    getModalTotalEstimatedHrs() {
        const total = this.state.modalTasks.reduce((sum, t) => sum + t.estimated_hrs, 0);
        return total.toFixed(2);
    }

    getModalTotalEstimatedUnits() {
        const total = this.state.modalTasks.reduce((sum, t) => sum + t.estimated_units, 0);
        return total.toFixed(2);
    }

    getModalTotalActualHrs() {
        const total = this.state.modalTasks.reduce((sum, t) => sum + t.actual_hrs, 0);
        return total.toFixed(2);
    }

    getModalTotalProductivityUnits() {
        const total = this.state.modalTasks.reduce((sum, t) => sum + t.productivity_units, 0);
        return total.toFixed(2);
    }

    getModalTotalDeviation() {
        const total = this.state.modalTasks.reduce((sum, t) => sum + t.performance_deviation, 0);
        return total.toFixed(2);
    }

    getRowClass(row) {
        if (row.remarks === 'No Tasks Assigned') {
            return 'table-warning';
        }
        
        if (row.remarks === 'Not Started') {
            return 'table-primary';
        }

        if (row.performance_deviation > 0) {
            return 'table-success';
        }
        return 'table-danger';
    }
    
    getDeviationClass(deviation, row) {
        if (row.remarks === 'No Tasks Assigned') {
            return 'badge bg-warning';
        }
        
        if (row.remarks === 'Not Started') {
            return 'badge bg-primary';
        }
        
        if (deviation > 0) {
            return 'badge bg-success';
        }
        return 'badge bg-danger';
    }

    backToDashboard() {
        window.history.back();
    }

    // Summary calculations
    getTotalSalary() {
        return this.state.reportData.reduce((sum, row) => sum + row.salary, 0);
    }
    
    getTotalWorkingDays() {
        return this.state.reportData.reduce((sum, row) => sum + row.working_days, 0);
    }

    getTotalEstimatedHours() {
        return this.state.reportData.reduce((sum, row) => sum + row.estimated_hours, 0);
    }
    
    getTotalEstimatedUnits() {
        return this.state.reportData.reduce((sum, row) => sum + row.estimated_units, 0);
    }

    getTotalActualHours() {
        return this.state.reportData.reduce((sum, row) => sum + row.actual_hours, 0);
    }
    
    getTotalProductivityUnits() {
        return this.state.reportData.reduce((sum, row) => sum + row.productivity_units, 0);
    }
    
    getAveragePerformanceDeviation() {
        if (this.state.reportData.length === 0) return 0;
        const total = this.state.reportData.reduce((sum, row) => sum + row.performance_deviation, 0);
        return total / this.state.reportData.length;
    }

    getTotalAvailableUnits() {
        return this.state.reportData.reduce((sum, row) => sum + row.available_units, 0);
    }

    getAverageUnitCost() {
        if (this.state.reportData.length === 0) return 0;
        const total = this.state.reportData.reduce((sum, row) => sum + row.unit_cost, 0);
        return total / this.state.reportData.length;
    }

    getTotalProductivityCost() {
        return this.state.reportData.reduce((sum, row) => sum + row.productivity_cost, 0);
    }

    getAverageProductivityPct() {
        if (this.state.reportData.length === 0) return 0;
        const total = this.state.reportData.reduce((sum, row) => sum + row.productivity_cost_pct, 0);
        return total / this.state.reportData.length;
    }
    
    getCountByRemark(remark) {
        return this.state.reportData.filter(row => row.remarks === remark).length;
    }
    // ============================================================
    // PDF EXPORT METHODS - Add these to your KpiPerformanceReport class
    // ============================================================

    async downloadMainReportPDF() {
        try {
            // Check if jsPDF is loaded
            if (!window.jspdf) {
                alert('PDF library is loading. Please try again in a moment.');
                return;
            }

            const { jsPDF } = window.jspdf;
            const doc = new jsPDF('l', 'mm', 'a4'); // landscape orientation
            
            // Add title
            doc.setFontSize(18);
            doc.setFont(undefined, 'bold');
            doc.text('KPI Performance Report', 14, 15);
            
            // Add date range and generated date
            doc.setFontSize(10);
            doc.setFont(undefined, 'normal');
            const fromDate = this.state.filters.from_date;
            const toDate = this.state.filters.to_date;
            const today = new Date().toLocaleDateString();
            doc.text(`Period: ${fromDate} to ${toDate}`, 14, 23);
            doc.text(`Generated: ${today}`, 14, 28);
            
            // Prepare table headers
            const headers = [[
                'S.No', 
                'Employee Name', 
                'Salary', 
                'Working Days', 
                'Est. Hrs', 
                'Est. Units', 
                'Actual Hrs', 
                'Prod. Units', 
                'Perf. Dev', 
                'Avail. Units', 
                'Unit Cost', 
                'Prod. Cost', 
                'Prod. Cost %', 
                'Remarks'
            ]];
            
            // Prepare table data
            const data = this.state.reportData.map((row, index) => [
                index + 1,
                row.employee_name,
                row.salary.toFixed(2),
                row.working_days,
                this.formatHoursWithMinutes(row.estimated_hours),
                row.estimated_units.toFixed(2),
                this.formatHoursWithMinutes(row.actual_hours),
                row.productivity_units.toFixed(2),
                row.performance_deviation.toFixed(2),
                row.available_units.toFixed(2),
                row.unit_cost.toFixed(4),
                row.productivity_cost.toFixed(2),
                row.productivity_cost_pct.toFixed(2) + '%',
                row.remarks
            ]);
            
            // Add totals/average row
            data.push([
                '-',
                'Total / Average',
                this.getTotalSalary().toFixed(2),
                this.getTotalWorkingDays(),
                this.formatHoursWithMinutes(this.getTotalEstimatedHours()),
                this.getTotalEstimatedUnits().toFixed(2),
                this.formatHoursWithMinutes(this.getTotalActualHours()),
                this.getTotalProductivityUnits().toFixed(2),
                this.getAveragePerformanceDeviation().toFixed(2),
                this.getTotalAvailableUnits().toFixed(2),
                this.getAverageUnitCost().toFixed(4),
                this.getTotalProductivityCost().toFixed(2),
                this.getAverageProductivityPct().toFixed(2) + '%',
                '-'
            ]);
            
            // Generate table with autoTable plugin
            doc.autoTable({
                head: headers,
                body: data,
                startY: 35,
                styles: { 
                    fontSize: 7, 
                    cellPadding: 1.5,
                    overflow: 'linebreak',
                    cellWidth: 'wrap'
                },
                headStyles: { 
                    fillColor: [66, 139, 202],
                    textColor: 255,
                    fontStyle: 'bold'
                },
                alternateRowStyles: { 
                    fillColor: [245, 245, 245] 
                },
                columnStyles: {
                    0: { cellWidth: 10 },  // S.No
                    1: { cellWidth: 25 },  // Name
                    2: { cellWidth: 15 },  // Salary
                    3: { cellWidth: 15 },  // Working Days
                    13: { cellWidth: 25 }, // Remarks
                },
                didParseCell: (data) => {
                    const rowIndex = data.row.index;
                    const colIndex = data.column.index;
                    
                    // Don't color the totals row
                    if (rowIndex === this.state.reportData.length) {
                        data.cell.styles.fillColor = [236, 240, 241];
                        data.cell.styles.fontStyle = 'bold';
                        return;
                    }
                    
                    // Color code remarks column
                    if (colIndex === 13 && rowIndex < this.state.reportData.length) {
                        const remark = this.state.reportData[rowIndex].remarks;
                        data.cell.styles.fontStyle = 'bold';
                        
                        if (remark === 'Excellent Performance') {
                            data.cell.styles.textColor = [40, 167, 69];
                        } else if (remark === 'Low Performance') {
                            data.cell.styles.textColor = [220, 53, 69];
                        } else if (remark === 'Not Started') {
                            data.cell.styles.textColor = [13, 110, 253];
                        } else if (remark === 'No Tasks Assigned') {
                            data.cell.styles.textColor = [255, 193, 7];
                        }
                    }
                    
                    // Color code performance deviation column
                    if (colIndex === 8 && rowIndex < this.state.reportData.length) {
                        const row = this.state.reportData[rowIndex];
                        const deviation = row.performance_deviation;
                        
                        if (row.remarks === 'Not Started' || row.remarks === 'No Tasks Assigned') {
                            data.cell.styles.textColor = [13, 110, 253];
                            data.cell.styles.fontStyle = 'bold';
                        } else if (deviation > 0) {
                            data.cell.styles.textColor = [40, 167, 69];
                            data.cell.styles.fontStyle = 'bold';
                        } else if (deviation < 0) {
                            data.cell.styles.textColor = [220, 53, 69];
                            data.cell.styles.fontStyle = 'bold';
                        }
                    }
                }
            });
            
            // Add summary statistics
            const finalY = doc.lastAutoTable.finalY + 10;
            doc.setFontSize(12);
            doc.setFont(undefined, 'bold');
            doc.text('Summary Statistics', 14, finalY);
            
            doc.setFontSize(9);
            doc.setFont(undefined, 'normal');
            const summaryY = finalY + 7;
            
            doc.setTextColor(40, 167, 69);
            doc.text(`✓ Excellent Performers: ${this.getCountByRemark('Excellent Performance')} employees (Positive Deviation)`, 14, summaryY);
            
            doc.setTextColor(220, 53, 69);
            doc.text(`✗ Low Performers: ${this.getCountByRemark('Low Performance')} employees (Negative Deviation)`, 14, summaryY + 5);
            
            doc.setTextColor(13, 110, 253);
            doc.text(`⊙ Not Started: ${this.getCountByRemark('Not Started')} employees (Tasks Assigned)`, 14, summaryY + 10);
            
            doc.setTextColor(255, 193, 7);
            doc.text(`○ No Tasks Assigned: ${this.getCountByRemark('No Tasks Assigned')} employees (Idle)`, 14, summaryY + 15);
            
            // Add footer
            doc.setTextColor(150, 150, 150);
            doc.setFontSize(8);
            doc.text('Generated by KRA/KPI Management System', 14, 200);
            doc.text(`Page 1 of 1`, 260, 200);
            
            // Save the PDF
            const filename = `KPI_Performance_Report_${fromDate}_to_${toDate}.pdf`;
            doc.save(filename);
            
        } catch (error) {
            console.error('Error generating PDF:', error);
            alert('Error generating PDF. Please ensure all data is loaded and try again.');
        }
    }

    async downloadEmployeeDetailPDF() {
        try {
            // Check if jsPDF is loaded
            if (!window.jspdf) {
                alert('PDF library is loading. Please try again in a moment.');
                return;
            }

            const { jsPDF } = window.jspdf;
            const doc = new jsPDF('l', 'mm', 'a4');
            
            // Add title
            doc.setFontSize(16);
            doc.setFont(undefined, 'bold');
            doc.text(`Individual Performance Report - ${this.state.modalEmployeeName}`, 14, 15);
            
            // Add date range
            doc.setFontSize(10);
            doc.setFont(undefined, 'normal');
            const fromDate = this.state.filters.from_date;
            const toDate = this.state.filters.to_date;
            const today = new Date().toLocaleDateString();
            doc.text(`Period: ${fromDate} to ${toDate}`, 14, 23);
            doc.text(`Generated: ${today}`, 14, 28);
            
            // Add summary statistics boxes
            doc.setFontSize(9);
            const summaryY = 35;
            
            // Total Tasks
            doc.setFillColor(13, 110, 253);
            doc.rect(14, summaryY, 50, 12, 'F');
            doc.setTextColor(255, 255, 255);
            doc.setFont(undefined, 'bold');
            doc.text('Total Tasks', 16, summaryY + 5);
            doc.setFontSize(14);
            doc.text(this.state.modalTasks.length.toString(), 16, summaryY + 10);
            
            // Excellent
            doc.setFillColor(40, 167, 69);
            doc.rect(68, summaryY, 50, 12, 'F');
            doc.setFontSize(9);
            doc.text('Excellent', 70, summaryY + 5);
            doc.setFontSize(14);
            doc.text(this.getModalTaskCountByDeviation('positive').toString(), 70, summaryY + 10);
            
            // Low Performance
            doc.setFillColor(220, 53, 69);
            doc.rect(122, summaryY, 50, 12, 'F');
            doc.setFontSize(9);
            doc.text('Low Performance', 124, summaryY + 5);
            doc.setFontSize(14);
            doc.text(this.getModalTaskCountByDeviation('negative').toString(), 124, summaryY + 10);
            
            // On Target
            doc.setFillColor(255, 193, 7);
            doc.rect(176, summaryY, 50, 12, 'F');
            doc.setTextColor(0, 0, 0);
            doc.setFontSize(9);
            doc.text('On Target', 178, summaryY + 5);
            doc.setFontSize(14);
            doc.text(this.getModalTaskCountByDeviation('zero').toString(), 178, summaryY + 10);
            
            // Reset colors
            doc.setTextColor(0, 0, 0);
            doc.setFontSize(11);
            doc.setFont(undefined, 'bold');
            doc.text('Task Details', 14, summaryY + 20);
            
            // Prepare task table headers
            const headers = [[
                '#', 
                'Task Name', 
                'Status', 
                'Estimated Hrs', 
                'Estimated Units', 
                'Actual Hrs', 
                'Productivity Units', 
                'Performance Deviation',
                'Assignment Type'
            ]];
            
            // Prepare task data
            const data = this.state.modalTasks.map((task, index) => [
                index + 1,
                task.task_name + (task.kra_name ? `\n[${task.kra_name}]` : ''),
                this.formatTaskStatus(task.status),
                task.estimated_hrs.toFixed(2),
                task.estimated_units.toFixed(2),
                task.actual_hrs.toFixed(2),
                task.productivity_units.toFixed(2),
                task.performance_deviation.toFixed(2),
                task.assignment_type
            ]);
            
            // Add totals row
            data.push([
                '-',
                'Totals',
                '-',
                this.getModalTotalEstimatedHrs(),
                this.getModalTotalEstimatedUnits(),
                this.getModalTotalActualHrs(),
                this.getModalTotalProductivityUnits(),
                this.getModalTotalDeviation(),
                '-'
            ]);
            
            // Generate table
            doc.autoTable({
                head: headers,
                body: data,
                startY: summaryY + 25,
                styles: { 
                    fontSize: 8, 
                    cellPadding: 2,
                    overflow: 'linebreak'
                },
                headStyles: { 
                    fillColor: [52, 58, 64],
                    textColor: 255,
                    fontStyle: 'bold'
                },
                alternateRowStyles: { 
                    fillColor: [245, 245, 245] 
                },
                columnStyles: {
                    0: { cellWidth: 10 },  // #
                    1: { cellWidth: 60 },  // Task Name
                    2: { cellWidth: 20 },  // Status
                    8: { cellWidth: 35 },  // Assignment Type
                },
                didParseCell: (data) => {
                    const rowIndex = data.row.index;
                    const colIndex = data.column.index;
                    
                    // Don't color the totals row
                    if (rowIndex === this.state.modalTasks.length) {
                        data.cell.styles.fillColor = [236, 240, 241];
                        data.cell.styles.fontStyle = 'bold';
                        return;
                    }
                    
                    // Color code performance deviation column
                    if (colIndex === 7 && rowIndex < this.state.modalTasks.length) {
                        const task = this.state.modalTasks[rowIndex];
                        const deviation = task.performance_deviation;
                        
                        if (task.actual_hrs === 0 && task.estimated_hrs > 0) {
                            data.cell.styles.textColor = [13, 110, 253];
                            data.cell.styles.fontStyle = 'bold';
                        } else if (deviation > 0) {
                            data.cell.styles.textColor = [40, 167, 69];
                            data.cell.styles.fontStyle = 'bold';
                        } else if (deviation < 0) {
                            data.cell.styles.textColor = [220, 53, 69];
                            data.cell.styles.fontStyle = 'bold';
                        }
                    }
                }
            });
            
            // Add performance summary
            const finalY = doc.lastAutoTable.finalY + 10;
            doc.setFontSize(11);
            doc.setFont(undefined, 'bold');
            doc.setTextColor(0, 0, 0);
            doc.text(`Performance Summary for ${this.state.modalEmployeeName}`, 14, finalY);
            
            doc.setFontSize(9);
            doc.setFont(undefined, 'normal');
            doc.text(`• Total Tasks Assigned: ${this.state.modalTasks.length}`, 14, finalY + 6);
            doc.text(`• Total Estimated Hours: ${this.getModalTotalEstimatedHrs()} hrs`, 14, finalY + 11);
            doc.text(`• Total Actual Hours: ${this.getModalTotalActualHrs()} hrs`, 14, finalY + 16);
            doc.text(`• Overall Deviation: ${this.getModalTotalDeviation()} units`, 14, finalY + 21);
            
            // Add footer
            doc.setTextColor(150, 150, 150);
            doc.setFontSize(8);
            doc.text('Generated by KRA/KPI Management System', 14, 200);
            doc.text(`Page 1 of 1`, 260, 200);
            
            // Save the PDF
            const employeeName = this.state.modalEmployeeName.replace(/\s+/g, '_');
            const filename = `Employee_Performance_${employeeName}_${fromDate}_to_${toDate}.pdf`;
            doc.save(filename);
            
        } catch (error) {
            console.error('Error generating employee PDF:', error);
            alert('Error generating employee detail PDF. Please try again.');
        }
    }
    
}

registry.category("actions").add("kpi_performance_report", KpiPerformanceReport);