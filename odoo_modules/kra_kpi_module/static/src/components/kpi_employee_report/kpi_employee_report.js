/** @odoo-module **/

import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";

export class KpiEmployeeReport extends Component {

    static template = xml/* xml */`
        <div class="o_kpi_employee_report p-4">
            <div class="d-flex justify-content-between align-items-center mb-4">
                <h2 class="fw-bold"><i class="fa fa-users me-2"></i>KRA Employee Report</h2>
                <button class="btn btn-secondary" t-on-click="backToDashboard">← Back to Dashboard</button>
            </div>

            <div class="card p-4 mb-4 shadow-sm">
                <h4 class="fw-bold mb-3"><i class="fa fa-filter me-2"></i>Filters</h4>
                <div class="row g-3">
                    <div class="col-md-2">
                        <label class="form-label fw-bold">Quick Select</label>
                        <select class="form-select" t-model="state.filters.time_frame" t-on-change="onTimeFrameChange">
                            <option value="">Custom</option>
                            <option value="today">Today</option>
                            <option value="yesterday">Yesterday</option>
                            <option value="last_week">Last Week</option>
                            <option value="last_month">Last Month</option>
                            <option value="last_year">Last Year</option>
                        </select>
                    </div>
                    <div class="col-md-2">
                        <label class="form-label fw-bold">From Date</label>
                        <input type="date" class="form-control" t-model="state.filters.from_date"/>
                    </div>
                    <div class="col-md-2">
                        <label class="form-label fw-bold">To Date</label>
                        <input type="date" class="form-control" t-model="state.filters.to_date"/>
                    </div>
                    <div class="col-md-3">
                        <label class="form-label fw-bold">Employee</label>
                        <select class="form-select" t-model="state.filters.employee_id">
                            <option value="">All Employees</option>
                            <t t-foreach="state.employees" t-as="emp" t-key="emp.id">
                                <option t-att-value="emp.id" t-esc="emp.name"/>
                            </t>
                        </select>
                    </div>
                    <div class="col-md-3 d-flex align-items-end">
                        <button class="btn btn-primary w-100" t-on-click="generateReport" t-att-disabled="state.loading">
                            <t t-if="state.loading"><i class="fa fa-spinner fa-spin me-2"></i>Loading...</t>
                            <t t-else=""><i class="fa fa-refresh me-2"></i>Generate Report</t>
                        </button>
                    </div>
                </div>
            </div>

            <t t-if="state.reportGenerated">
                <div class="row mb-4">
                    <div class="col-md-3">
                        <div class="card bg-primary text-white p-3">
                            <div class="d-flex justify-content-between">
                                <div><h6 class="mb-0">Total Employees</h6><h3 class="mb-0 fw-bold" t-esc="state.reportData.length"/></div>
                                <i class="fa fa-users fa-2x opacity-50"></i>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-3">
                        <div class="card bg-success text-white p-3">
                            <div class="d-flex justify-content-between">
                                <div><h6 class="mb-0">Total Tasks</h6><h3 class="mb-0 fw-bold" t-esc="getTotalTasks()"/></div>
                                <i class="fa fa-tasks fa-2x opacity-50"></i>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-3">
                        <div class="card bg-info text-white p-3">
                            <div class="d-flex justify-content-between">
                                <div><h6 class="mb-0">Total Estimated</h6><h3 class="mb-0 fw-bold" t-esc="getTotalEstimated()"/></div>
                                <i class="fa fa-clock-o fa-2x opacity-50"></i>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-3">
                        <div class="card bg-warning text-dark p-3">
                            <div class="d-flex justify-content-between">
                                <div><h6 class="mb-0">Total Actual</h6><h3 class="mb-0 fw-bold" t-esc="getTotalActual()"/></div>
                                <i class="fa fa-hourglass-half fa-2x opacity-50"></i>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="mb-3">
                    <button class="btn btn-danger" t-on-click="downloadPDF" t-att-disabled="state.generatingPdf">
                        <t t-if="state.generatingPdf"><i class="fa fa-spinner fa-spin me-2"></i>Generating PDF...</t>
                        <t t-else=""><i class="fa fa-file-pdf-o me-2"></i>Download PDF</t>
                    </button>
                </div>

                <t t-if="state.reportData.length > 0">
                    <t t-foreach="state.reportData" t-as="employee" t-key="employee.employee_id">
                        <div class="card mb-4 shadow-sm">
                            <div class="card-header bg-light d-flex justify-content-between align-items-center">
                                <div>
                                    <h5 class="mb-0 fw-bold"><i class="fa fa-user me-2"></i><t t-esc="employee.employee_name"/></h5>
                                    <small class="text-muted" t-esc="employee.employee_email"/>
                                </div>
                                <div class="text-end">
                                    <span class="badge bg-primary me-2"><t t-esc="employee.total_tasks"/> Tasks</span>
                                    <span class="badge bg-success me-2"><t t-esc="employee.completed_tasks"/> Completed</span>
                                    <span class="badge bg-info me-2"><t t-esc="employee.in_progress_tasks"/> In Progress</span>
                                    <span class="badge bg-secondary"><t t-esc="employee.pending_tasks"/> Pending</span>
                                </div>
                            </div>
                            <div class="card-body border-bottom bg-light">
                                <div class="row">
                                    <div class="col-md-3"><strong>Estimated:</strong> <span t-esc="employee.total_estimated_hours_display"/></div>
                                    <div class="col-md-3"><strong>Actual:</strong> <span t-esc="employee.total_actual_hours_display"/></div>
                                    <div class="col-md-3">
                                        <strong>Performance:</strong>
                                        <span t-att-class="employee.overall_performance.is_positive ? 'text-success fw-bold' : 'text-danger fw-bold'">
                                            <t t-if="employee.overall_performance.is_positive"><i class="fa fa-arrow-up"></i> +<t t-esc="employee.overall_performance.display"/> ahead</t>
                                            <t t-else=""><i class="fa fa-arrow-down"></i> -<t t-esc="employee.overall_performance.display"/> behind</t>
                                        </span>
                                    </div>
                                    <div class="col-md-3 text-end">
                                        <button class="btn btn-sm btn-outline-primary" t-on-click="(e) => this.toggleEmployeeTasks(employee.employee_id)">
                                            <t t-if="state.expandedEmployees[employee.employee_id]"><i class="fa fa-chevron-up"></i> Hide</t>
                                            <t t-else=""><i class="fa fa-chevron-down"></i> Show Tasks</t>
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <t t-if="state.expandedEmployees[employee.employee_id]">
                                <div class="card-body p-0">
                                    <table class="table table-hover mb-0">
                                        <thead class="table-light">
                                            <tr>
                                                <th>#</th><th>Task Name</th><th>KRA</th><th>Assigned</th><th>Started</th>
                                                <th>Estimated</th><th>Actual</th><th>Performance</th><th>Status</th><th>Actions</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <t t-foreach="employee.tasks" t-as="task" t-key="task.id">
                                                <tr>
                                                    <td t-esc="task_index + 1"/>
                                                    <td><strong t-esc="task.name"/></td>
                                                    <td><small t-esc="task.kra_name || '-'"/></td>
                                                    <td><small t-esc="task.assigned_date_display"/></td>
                                                    <td><small t-esc="task.started_date_display"/></td>
                                                    <td t-esc="task.estimated_hours_display"/>
                                                    <td t-esc="task.actual_hours_display"/>
                                                    <td>
                                                        <span t-att-class="task.performance.is_positive ? 'text-success' : 'text-danger'">
                                                            <t t-if="task.performance.status === 'neutral'">N/A</t>
                                                            <t t-else="">
                                                                <t t-if="task.performance.is_positive">+</t><t t-else="">-</t>
                                                                <t t-esc="task.performance.display"/>
                                                            </t>
                                                        </span>
                                                    </td>
                                                    <td><span t-att-class="'badge bg-' + getStatusClass(task.task_state)" t-esc="task.task_state_display"/></td>
                                                    <td><button class="btn btn-sm btn-outline-info" t-on-click="(e) => this.viewTaskProgress(task)"><i class="fa fa-eye"></i></button></td>
                                                </tr>
                                                <t t-if="state.expandedTasks[task.id] and task.daily_progress.length > 0">
                                                    <tr class="bg-light">
                                                        <td colspan="10" class="p-3">
                                                            <h6 class="fw-bold"><i class="fa fa-calendar me-2"></i>Daily Work Breakdown</h6>
                                                            <table class="table table-sm table-bordered mb-0">
                                                                <thead class="table-secondary">
                                                                    <tr><th>Date</th><th>Day</th><th>Hours Worked</th><th>Progress Summary</th></tr>
                                                                </thead>
                                                                <tbody>
                                                                    <t t-foreach="task.daily_progress" t-as="day" t-key="day.date">
                                                                        <tr>
                                                                            <td class="fw-bold" t-esc="day.date_display"/>
                                                                            <td t-esc="day.day_name"/>
                                                                            <td class="fw-bold text-primary" t-esc="day.total_time_display"/>
                                                                            <td>
                                                                                <t t-foreach="day.summaries" t-as="entry" t-key="entry.id">
                                                                                    <div class="mb-1"><small class="text-muted">[<t t-esc="entry.time"/>]</small> <t t-esc="entry.summary"/></div>
                                                                                </t>
                                                                            </td>
                                                                        </tr>
                                                                    </t>
                                                                </tbody>
                                                            </table>
                                                        </td>
                                                    </tr>
                                                </t>
                                            </t>
                                        </tbody>
                                    </table>
                                </div>
                            </t>
                        </div>
                    </t>
                </t>
                <t t-else=""><div class="alert alert-info"><i class="fa fa-info-circle me-2"></i>No data found.</div></t>
            </t>

            <t t-if="state.showTaskModal">
                <div class="modal-backdrop fade show"></div>
                <div class="modal d-block" tabindex="-1">
                    <div class="modal-dialog modal-xl">
                        <div class="modal-content">
                            <div class="modal-header bg-primary text-white">
                                <h5 class="modal-title"><i class="fa fa-tasks me-2"></i>Task: <t t-esc="state.selectedTask.name"/></h5>
                                <button type="button" class="btn-close btn-close-white" t-on-click="closeTaskModal"></button>
                            </div>
                            <div class="modal-body">
                                <div class="row mb-4">
                                    <div class="col-md-6">
                                        <table class="table table-sm">
                                            <tr><th>KRA:</th><td t-esc="state.selectedTask.kra_name || '-'"/></tr>
                                            <tr><th>Assigned:</th><td t-esc="state.selectedTask.assigned_date_display"/></tr>
                                            <tr><th>Started:</th><td t-esc="state.selectedTask.started_date_display"/></tr>
                                        </table>
                                    </div>
                                    <div class="col-md-6">
                                        <table class="table table-sm">
                                            <tr><th>Estimated:</th><td t-esc="state.selectedTask.estimated_hours_display"/></tr>
                                            <tr><th>Actual:</th><td t-esc="state.selectedTask.actual_hours_display"/></tr>
                                            <tr><th>Performance:</th><td t-att-class="state.selectedTask.performance.is_positive ? 'text-success fw-bold' : 'text-danger fw-bold'">
                                                <t t-if="state.selectedTask.performance.is_positive">+</t><t t-else="">-</t>
                                                <t t-esc="state.selectedTask.performance.display"/>
                                            </td></tr>
                                        </table>
                                    </div>
                                </div>
                                <h6 class="fw-bold mb-3"><i class="fa fa-clock-o me-2"></i>Daily Work Breakdown</h6>
                                <t t-if="state.selectedTask.daily_progress and state.selectedTask.daily_progress.length > 0">
                                    <table class="table table-bordered">
                                        <thead class="table-light"><tr><th>Date</th><th>Day</th><th>Hours Worked</th><th>Progress Summary</th></tr></thead>
                                        <tbody>
                                            <t t-foreach="state.selectedTask.daily_progress" t-as="day" t-key="day.date">
                                                <tr>
                                                    <td class="fw-bold bg-light" t-esc="day.date_display"/>
                                                    <td class="bg-light" t-esc="day.day_name"/>
                                                    <td class="fw-bold text-primary bg-light" t-esc="day.total_time_display"/>
                                                    <td><t t-foreach="day.summaries" t-as="entry" t-key="entry.id"><div class="mb-2"><small class="text-muted">[<t t-esc="entry.time"/>]</small> <t t-esc="entry.summary"/></div></t></td>
                                                </tr>
                                            </t>
                                        </tbody>
                                    </table>
                                </t>
                                <t t-else=""><div class="alert alert-secondary">No progress entries.</div></t>
                            </div>
                            <div class="modal-footer"><button type="button" class="btn btn-secondary" t-on-click="closeTaskModal">Close</button></div>
                        </div>
                    </div>
                </div>
            </t>
        </div>
    `;

    setup() {
        this.actionService = useService("action");
        const today = new Date().toISOString().split("T")[0];
        this.state = useState({
            loading: false, generatingPdf: false, reportGenerated: false,
            employees: [], reportData: [],
            filters: { from_date: today, to_date: today, employee_id: '', time_frame: 'today' },
            expandedEmployees: {}, expandedTasks: {}, showTaskModal: false, selectedTask: {},
        });
        onWillStart(async () => { await this.loadEmployees(); });
    }

    async loadEmployees() {
        try {
            const result = await rpc("/kpi_reports/employee/get_employees", {});
            if (result.status) this.state.employees = result.employees;
        } catch (e) { console.error("Error loading employees:", e); }
    }

    onTimeFrameChange(event) {
        const tf = event.target.value;
        const today = new Date();
        if (tf === "today") {
            this.state.filters.from_date = today.toISOString().split("T")[0];
            this.state.filters.to_date = today.toISOString().split("T")[0];
        } else if (tf === "yesterday") {
            const y = new Date(today); y.setDate(y.getDate() - 1);
            this.state.filters.from_date = y.toISOString().split("T")[0];
            this.state.filters.to_date = y.toISOString().split("T")[0];
        } else if (tf === "last_week") {
            const dow = today.getDay(); const diff = dow === 0 ? 6 : dow - 1;
            const lastMon = new Date(today); lastMon.setDate(today.getDate() - diff - 7);
            const lastSun = new Date(lastMon); lastSun.setDate(lastMon.getDate() + 6);
            this.state.filters.from_date = lastMon.toISOString().split("T")[0];
            this.state.filters.to_date = lastSun.toISOString().split("T")[0];
        } else if (tf === "last_month") {
            const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            const last = new Date(today.getFullYear(), today.getMonth(), 0);
            this.state.filters.from_date = first.toISOString().split("T")[0];
            this.state.filters.to_date = last.toISOString().split("T")[0];
        } else if (tf === "last_year") {
            this.state.filters.from_date = new Date(today.getFullYear() - 1, 0, 1).toISOString().split("T")[0];
            this.state.filters.to_date = new Date(today.getFullYear() - 1, 11, 31).toISOString().split("T")[0];
        }
    }

    async generateReport() {
        this.state.loading = true;
        try {
            const empId = this.state.filters.employee_id;
            const result = await rpc("/kpi_reports/employee/generate", {
                from_date: this.state.filters.from_date, to_date: this.state.filters.to_date,
                employee_ids: empId ? [empId] : [], time_frame: this.state.filters.time_frame || null,
            });
            if (result.status) {
                this.state.reportData = result.data;
                this.state.reportGenerated = true;
                if (result.data.length === 1) this.state.expandedEmployees[result.data[0].employee_id] = true;
            } else alert("Error: " + result.message);
        } catch (e) { console.error(e); alert("Error generating report."); }
        finally { this.state.loading = false; }
    }

    toggleEmployeeTasks(empId) { this.state.expandedEmployees[empId] = !this.state.expandedEmployees[empId]; }
    viewTaskProgress(task) { this.state.expandedTasks[task.id] = !this.state.expandedTasks[task.id]; this.state.selectedTask = task; this.state.showTaskModal = true; }
    closeTaskModal() { this.state.showTaskModal = false; this.state.selectedTask = {}; }

    async downloadPDF() {
        this.state.generatingPdf = true;
        try {
            const empId = this.state.filters.employee_id;
            const result = await rpc("/kpi_reports/employee/pdf_data", {
                from_date: this.state.filters.from_date, to_date: this.state.filters.to_date,
                employee_ids: empId ? [empId] : [], time_frame: this.state.filters.time_frame || null,
            });
            if (result.status) this.generatePDFDocument(result.pdf_data);
            else alert("Error: " + result.message);
        } catch (e) { console.error(e); alert("Error generating PDF."); }
        finally { this.state.generatingPdf = false; }
    }

    generatePDFDocument(data) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF('p', 'mm', 'a4');
        const pw = doc.internal.pageSize.getWidth();
        const ph = doc.internal.pageSize.getHeight();
        const m = 15;
        const cw = pw - 2 * m;
        let y = m;

        const checkPage = (sp = 25) => { if (y > ph - sp) { doc.addPage(); y = m; return true; } return false; };
        const wrap = (t, mw, fs) => { doc.setFontSize(fs); return doc.splitTextToSize(t || '', mw); };

        // ========== HEADER ==========
        doc.setFontSize(22);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(44, 62, 80);
        doc.text('KRA Employee Report', pw / 2, y, { align: 'center' });
        y += 12;

        doc.setDrawColor(44, 62, 80);
        doc.setLineWidth(0.5);
        doc.line(m, y, pw - m, y);
        y += 8;

        // ========== REPORT INFO ==========
        doc.setFontSize(10);
        doc.setTextColor(0, 0, 0);
        doc.setFont('helvetica', 'bold');
        doc.text('From Date:', m, y);
        doc.setFont('helvetica', 'normal');
        doc.text(data.from_date, m + 25, y);

        doc.setFont('helvetica', 'bold');
        doc.text('To Date:', pw / 2, y);
        doc.setFont('helvetica', 'normal');
        doc.text(data.to_date, pw / 2 + 20, y);
        y += 6;

        doc.setFont('helvetica', 'bold');
        doc.text('Generated:', m, y);
        doc.setFont('helvetica', 'normal');
        doc.text(data.generated_on, m + 25, y);
        y += 12;

        // ========== EMPLOYEE SECTIONS ==========
        for (const emp of data.employees) {
            checkPage(60);

            // Employee Header Box
            doc.setFillColor(41, 128, 185);
            doc.roundedRect(m, y, cw, 12, 2, 2, 'F');
            doc.setFontSize(12);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(255, 255, 255);
            doc.text(emp.employee_name, m + 5, y + 8);
            y += 16;

            // Employee Summary Row
            doc.setFillColor(236, 240, 241);
            doc.roundedRect(m, y, cw, 10, 2, 2, 'F');
            doc.setFontSize(9);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(44, 62, 80);
            const col = cw / 4;
            doc.text('Total Tasks: ' + emp.total_tasks, m + 5, y + 7);
            doc.text('Estimated: ' + emp.total_estimated_hours_display, m + col, y + 7);
            doc.text('Actual: ' + emp.total_actual_hours_display, m + col * 2, y + 7);
            
            // Performance
            if (emp.overall_performance.is_positive) {
                doc.setTextColor(39, 174, 96);
                doc.text('Performance: +' + emp.overall_performance.display + ' ahead', m + col * 3, y + 7);
            } else {
                doc.setTextColor(231, 76, 60);
                doc.text('Performance: -' + emp.overall_performance.display + ' behind', m + col * 3, y + 7);
            }
            y += 14;

            // ========== TASK DETAILS TABLE ==========
            doc.setTextColor(0, 0, 0);
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(10);
            doc.text('Task Details:', m, y + 4);
            y += 8;

            // Table Header
            doc.setFillColor(52, 73, 94);
            doc.rect(m, y, cw, 8, 'F');
            doc.setFontSize(8);
            doc.setTextColor(255, 255, 255);
            
            const taskCols = [35, 25, 25, 22, 22, 25, 26];
            let tx = m + 2;
            const taskHeaders = ['Task Name', 'Assigned', 'Started', 'Estimated', 'Actual', 'Performance', 'Status'];
            taskHeaders.forEach((h, i) => {
                doc.text(h, tx, y + 5.5);
                tx += taskCols[i];
            });
            y += 10;

            // Table Rows
            doc.setTextColor(0, 0, 0);
            doc.setFont('helvetica', 'normal');
            
            emp.tasks.forEach((task, idx) => {
                checkPage(12);
                
                // Alternate row colors
                if (idx % 2 === 0) {
                    doc.setFillColor(249, 249, 249);
                    doc.rect(m, y, cw, 8, 'F');
                }

                tx = m + 2;
                doc.setFontSize(8);
                
                // Task Name (truncate if needed)
                const taskName = task.name.length > 18 ? task.name.substring(0, 18) + '...' : task.name;
                doc.text(taskName, tx, y + 5.5);
                tx += taskCols[0];
                
                // Assigned
                doc.text(task.assigned_date_display || '-', tx, y + 5.5);
                tx += taskCols[1];
                
                // Started
                doc.text(task.started_date_display || '-', tx, y + 5.5);
                tx += taskCols[2];
                
                // Estimated
                doc.text(task.estimated_hours_display, tx, y + 5.5);
                tx += taskCols[3];
                
                // Actual
                doc.text(task.actual_hours_display, tx, y + 5.5);
                tx += taskCols[4];
                
                // Performance
                if (task.performance.is_positive) {
                    doc.setTextColor(39, 174, 96);
                    doc.text('+' + task.performance.display, tx, y + 5.5);
                } else if (task.performance.status === 'neutral') {
                    doc.setTextColor(127, 140, 141);
                    doc.text('N/A', tx, y + 5.5);
                } else {
                    doc.setTextColor(231, 76, 60);
                    doc.text('-' + task.performance.display, tx, y + 5.5);
                }
                doc.setTextColor(0, 0, 0);
                tx += taskCols[5];
                
                // Status
                doc.text(task.task_state_display, tx, y + 5.5);
                
                y += 8;
            });

            // Draw table border
            doc.setDrawColor(200, 200, 200);
            doc.rect(m, y - 8 * emp.tasks.length - 10, cw, 8 * emp.tasks.length + 10, 'S');
            y += 6;

            // ========== DAILY BREAKDOWN TABLE ==========
            checkPage(30);
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(10);
            doc.setTextColor(0, 0, 0);
            doc.text('Daily Work Breakdown:', m, y + 4);
            y += 8;

            // Collect all daily entries across all tasks
            const dailyEntries = [];
            emp.tasks.forEach(task => {
                if (task.daily_progress) {
                    task.daily_progress.forEach(day => {
                        day.summaries.forEach(entry => {
                            dailyEntries.push({
                                date: day.date,
                                date_display: day.date_display,
                                day_name: day.day_name,
                                task_name: task.name,
                                hours: day.total_time_display,
                                time: entry.time,
                                summary: entry.summary || ''
                            });
                        });
                        // If no summaries but has time
                        if (day.summaries.length === 0 && day.total_time_seconds > 0) {
                            dailyEntries.push({
                                date: day.date,
                                date_display: day.date_display,
                                day_name: day.day_name,
                                task_name: task.name,
                                hours: day.total_time_display,
                                time: '',
                                summary: ''
                            });
                        }
                    });
                }
            });

            // Sort by date
            dailyEntries.sort((a, b) => a.date.localeCompare(b.date));

            if (dailyEntries.length > 0) {
                // Table Header
                doc.setFillColor(52, 73, 94);
                doc.rect(m, y, cw, 8, 'F');
                doc.setFontSize(8);
                doc.setTextColor(255, 255, 255);
                doc.setFont('helvetica', 'bold');
                
                const dailyCols = [25, 22, 35, 22, cw - 104];
                let dx = m + 2;
                ['Date', 'Day', 'Task Name', 'Hours', 'Progress Summary'].forEach((h, i) => {
                    doc.text(h, dx, y + 5.5);
                    dx += dailyCols[i];
                });
                y += 10;

                // Table Rows
                doc.setTextColor(0, 0, 0);
                doc.setFont('helvetica', 'normal');
                
                dailyEntries.forEach((entry, idx) => {
                    checkPage(12);
                    
                    if (idx % 2 === 0) {
                        doc.setFillColor(249, 249, 249);
                        doc.rect(m, y, cw, 8, 'F');
                    }

                    dx = m + 2;
                    doc.setFontSize(8);
                    
                    doc.setTextColor(41, 128, 185);
                    doc.setFont('helvetica', 'bold');
                    doc.text(entry.date_display, dx, y + 5.5);
                    dx += dailyCols[0];
                    
                    doc.setTextColor(0, 0, 0);
                    doc.setFont('helvetica', 'normal');
                    doc.text(entry.day_name, dx, y + 5.5);
                    dx += dailyCols[1];
                    
                    const tn = entry.task_name.length > 18 ? entry.task_name.substring(0, 18) + '...' : entry.task_name;
                    doc.text(tn, dx, y + 5.5);
                    dx += dailyCols[2];
                    
                    doc.setTextColor(39, 174, 96);
                    doc.setFont('helvetica', 'bold');
                    doc.text(entry.hours, dx, y + 5.5);
                    dx += dailyCols[3];
                    
                    doc.setTextColor(60, 60, 60);
                    doc.setFont('helvetica', 'normal');
                    const summaryText = entry.summary.length > 50 ? entry.summary.substring(0, 50) + '...' : entry.summary;
                    doc.text(summaryText, dx, y + 5.5);
                    
                    y += 8;
                });
            } else {
                doc.setFontSize(9);
                doc.setTextColor(127, 140, 141);
                doc.setFont('helvetica', 'italic');
                doc.text('No daily breakdown available for this period', m + 5, y + 4);
                y += 8;
            }

            y += 10;
        }

        // ========== FOOTER ==========
        doc.setFontSize(8);
        doc.setTextColor(150, 150, 150);
        doc.setFont('helvetica', 'italic');
        doc.text('Generated by KRA/KPI Management System', pw / 2, ph - 10, { align: 'center' });

        // Save
        doc.save('KRA_Employee_Report_' + data.from_date + '_to_' + data.to_date + '.pdf');
    }

    formatHoursForPdf(h) { if (!h) return '0h 0m'; const hr = Math.floor(h); return hr + 'h ' + Math.round((h - hr) * 60) + 'm'; }
    backToDashboard() { window.history.back(); }
    getStatusClass(s) { return { completed: 'success', in_progress: 'primary', paused: 'warning', assigned: 'secondary', urgent: 'danger', important: 'warning', regular: 'info', partially_completed: 'info' }[s] || 'secondary'; }
    getTotalTasks() { return this.state.reportData.reduce((s, e) => s + e.total_tasks, 0); }
    getTotalEstimated() { return this.formatHoursForPdf(this.state.reportData.reduce((s, e) => s + e.total_estimated_hours, 0)); }
    getTotalActual() { return this.formatHoursForPdf(this.state.reportData.reduce((s, e) => s + e.total_actual_hours, 0)); }
}

registry.category("actions").add("kpi_employee_report", KpiEmployeeReport);
