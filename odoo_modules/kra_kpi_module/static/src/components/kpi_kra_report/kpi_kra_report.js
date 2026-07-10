/** @odoo-module **/
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";

export class KpiKraReport extends Component {
    static template = xml/* xml */`
        <div class="o_kpi_kra_report p-4">
            <!-- Header -->
            <div class="d-flex justify-content-between align-items-center mb-4">
                <h2 class="fw-bold">
                    <i class="fa fa-sitemap me-2 text-primary"></i>
                    KRA Report
                </h2>
                <div>
                    <button class="btn btn-warning me-2"
                            t-on-click="downloadZip"
                            t-if="state.reportGenerated"
                            title="Download project + per-task PDFs bundled in one ZIP">
                        <i class="fa fa-file-archive-o me-2"></i>Download ZIP
                    </button>
                    <button class="btn btn-success me-2"
                            t-on-click="downloadPDF"
                            t-if="state.reportGenerated"
                            title="Download report as PDF">
                        <i class="fa fa-file-pdf-o me-2"></i>Download PDF
                    </button>
                    <button class="btn btn-info me-2"
                            t-on-click="downloadExcel"
                            t-if="state.reportGenerated"
                            title="Download report as Excel">
                        <i class="fa fa-file-excel-o me-2"></i>Download Excel
                    </button>
                    <button class="btn btn-secondary" t-on-click="backToDashboard">
                        ← Back
                    </button>
                </div>
            </div>

            <!-- Filters Card -->
            <div class="card p-4 mb-4 shadow-sm">
                <h5 class="fw-bold mb-3">
                    <i class="fa fa-filter me-2 text-secondary"></i>
                    Report Filters
                </h5>
                <div class="row g-3">
                    <!-- Time Frame Quick Select -->
                    <div class="col-md-2">
                        <label class="form-label fw-bold">Quick Select</label>
                        <select class="form-select" t-model="state.filters.time_frame" t-on-change="onTimeFrameChange">
                            <option value="">Custom</option>
                            <option value="today">Today</option>
                            <option value="yesterday">Yesterday</option>
                            <option value="last_month">Last Month</option>
                            <option value="last_year">Last Year</option>
                        </select>
                    </div>
                    <!-- From Date -->
                    <div class="col-md-2">
                        <label class="form-label fw-bold">From Date</label>
                        <input type="date" class="form-control" t-model="state.filters.from_date"/>
                    </div>
                    <!-- To Date -->
                    <div class="col-md-2">
                        <label class="form-label fw-bold">To Date</label>
                        <input type="date" class="form-control" t-model="state.filters.to_date"/>
                    </div>
                    <!-- KRA Filter -->
                    <div class="col-md-3">
                        <label class="form-label fw-bold">KRA</label>
                        <select class="form-select" t-model="state.filters.kra_id">
                            <option value="">All KRAs</option>
                            <t t-foreach="state.kras" t-as="kra" t-key="kra.id">
                                <option t-att-value="kra.id">
                                    <t t-esc="kra.display_name"/>
                                </option>
                            </t>
                        </select>
                    </div>
                    <!-- Employee Filter -->
                    <div class="col-md-3">
                        <label class="form-label fw-bold">Employee</label>
                        <select class="form-select" t-model="state.filters.employee_id">
                            <option value="">All Employees</option>
                            <t t-foreach="state.employees" t-as="emp" t-key="emp.id">
                                <option t-att-value="emp.id" t-esc="emp.name"/>
                            </t>
                        </select>
                    </div>
                </div>
                <div class="mt-3 d-flex gap-2">
                    <button class="btn btn-primary" t-on-click="generateReport" t-att-disabled="state.isLoading">
                        <i class="fa fa-refresh me-2" t-att-class="{'fa-spin': state.isLoading}"></i>
                        <t t-if="state.isLoading">Generating...</t>
                        <t t-else="">Generate Report</t>
                    </button>
                    <button class="btn btn-outline-secondary" t-on-click="resetFilters">
                        <i class="fa fa-times me-2"></i>Reset
                    </button>
                </div>
            </div>

            <!-- Report Results -->
            <t t-if="state.reportGenerated">
                <!-- Summary Cards -->
                <div class="row mb-4">
                    <div class="col-md-4">
                        <div class="card bg-primary text-white p-3 shadow-sm">
                            <div class="d-flex justify-content-between align-items-center">
                                <div>
                                    <h6 class="mb-0 opacity-75">Total Tasks</h6>
                                    <h3 class="mb-0 fw-bold" t-esc="state.reportData.length"/>
                                </div>
                                <i class="fa fa-tasks fa-2x opacity-50"></i>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-4">
                        <div class="card bg-success text-white p-3 shadow-sm">
                            <div class="d-flex justify-content-between align-items-center">
                                <div>
                                    <h6 class="mb-0 opacity-75">Total Time Worked</h6>
                                    <h3 class="mb-0 fw-bold" t-esc="getTotalTimeWorked()"/>
                                </div>
                                <i class="fa fa-clock-o fa-2x opacity-50"></i>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-4">
                        <div class="card bg-warning text-dark p-3 shadow-sm">
                            <div class="d-flex justify-content-between align-items-center">
                                <div>
                                    <h6 class="mb-0 opacity-75">Employees</h6>
                                    <h3 class="mb-0 fw-bold" t-esc="getUniqueEmployeeCount()"/>
                                </div>
                                <i class="fa fa-users fa-2x opacity-50"></i>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Data Table -->
                <div class="card p-4 shadow-sm">
                    <div class="d-flex justify-content-between align-items-center mb-3">
                        <h5 class="fw-bold mb-0">
                            <i class="fa fa-table me-2 text-secondary"></i>
                            KRA Details
                        </h5>
                        <div class="input-group" style="max-width: 300px;">
                            <span class="input-group-text"><i class="fa fa-search"></i></span>
                            <input type="text" class="form-control" placeholder="Search..." 
                                   t-model="state.searchQuery" t-on-input="onSearchChange"/>
                        </div>
                    </div>
                    
                    <t t-if="getFilteredData().length > 0">
                        <div class="table-responsive">
                            <table class="table table-bordered table-hover table-sm">
                                <thead class="table-dark">
                                    <tr>
                                        <th class="text-center" style="width: 50px;">#</th>
                                        <th style="min-width: 280px;">
                                            <i class="fa fa-sitemap me-1"></i>
                                            KRA Hierarchy Path
                                        </th>
                                        <th style="min-width: 150px;">
                                            <i class="fa fa-bookmark me-1"></i>
                                            Sub KRA
                                        </th>
                                        <th style="min-width: 200px;">
                                            <i class="fa fa-flag me-1"></i>
                                            Task Name
                                        </th>
                                        <th style="min-width: 150px;">
                                            <i class="fa fa-user me-1"></i>
                                            Employee
                                        </th>
                                        <th class="text-center" style="width: 120px;">
                                            <i class="fa fa-clock-o me-1"></i>
                                            Time Worked
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <t t-foreach="getFilteredData()" t-as="row" t-key="row.id">
                                        <tr>
                                            <td class="text-center text-muted" t-esc="row_index + 1"/>
                                            <td>
                                                <span class="badge bg-light text-dark border" 
                                                      style="font-size: 0.95rem; white-space: normal; text-align: left; padding: 8px 12px;">
                                                    <t t-esc="row.kra_path"/>
                                                </span>
                                            </td>
                                            <td>
                                                <t t-if="row.sub_kra !== '-'">
                                                    <span class="badge bg-secondary" style="font-size: 0.9rem;" t-esc="row.sub_kra"/>
                                                </t>
                                                <t t-else="">
                                                    <span class="text-muted">-</span>
                                                </t>
                                            </td>
                                            <td class="fw-bold text-primary" t-esc="row.kpi_name"/>
                                            <td>
                                                <i class="fa fa-user-circle me-1 text-muted"></i>
                                                <t t-esc="row.employee_name"/>
                                            </td>
                                            <td class="text-center">
                                                <span class="badge bg-info" t-esc="row.time_worked_display"/>
                                            </td>
                                        </tr>
                                    </t>
                                </tbody>
                                <tfoot class="table-light fw-bold">
                                    <tr>
                                        <td class="text-center">-</td>
                                        <td colspan="4">Total</td>
                                        <td class="text-center">
                                            <span class="badge bg-success" t-esc="getTotalTimeWorked()"/>
                                        </td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    </t>
                    <t t-else="">
                        <div class="alert alert-info text-center">
                            <i class="fa fa-info-circle me-2"></i>
                            No data found matching your filters.
                        </div>
                    </t>
                </div>

                <!-- KRA Summary Section -->
                <t t-if="state.summaryData.length > 0">
                    <div class="card p-4 mt-4 shadow-sm">
                        <h5 class="fw-bold mb-3">
                            <i class="fa fa-bar-chart me-2 text-secondary"></i>
                            KRA Summary
                        </h5>
                        <div class="table-responsive">
                            <table class="table table-bordered table-sm">
                                <thead class="table-secondary">
                                    <tr>
                                        <th>KRA Path</th>
                                        <th class="text-center">Task Count</th>
                                        <th class="text-center">Total Time</th>
                                        <th class="text-center">Employees</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <t t-foreach="state.summaryData" t-as="summary" t-key="summary.kra_path">
                                        <tr>
                                            <td style="font-size: 0.95rem;" t-esc="summary.kra_path"/>
                                            <td class="text-center">
                                                <span class="badge bg-primary" t-esc="summary.kpi_count"/>
                                            </td>
                                            <td class="text-center">
                                                <span class="badge bg-info" t-esc="summary.total_time_display"/>
                                            </td>
                                            <td class="text-center">
                                                <span class="badge bg-secondary" t-esc="summary.employee_count"/>
                                            </td>
                                        </tr>
                                    </t>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </t>
            </t>

            <!-- Initial State -->
            <t t-if="!state.reportGenerated and !state.isLoading">
                <div class="card p-5 text-center shadow-sm">
                    <i class="fa fa-sitemap fa-4x text-muted mb-3"></i>
                    <h4 class="text-muted">Select filters and click "Generate Report"</h4>
                    <p class="text-muted mb-0">
                        This report shows tasks organized by their hierarchical KRA structure with time tracking.
                    </p>
                </div>
            </t>
        </div>
    `;

    setup() {
        this.actionService = useService("action");
        
        const today = new Date().toISOString().split('T')[0];
        
        this.state = useState({
            isLoading: false,
            reportGenerated: false,
            filters: {
                from_date: today,
                to_date: today,
                employee_id: '',
                kra_id: '',
                time_frame: '',
            },
            kras: [],
            employees: [],
            reportData: [],
            summaryData: [],
            searchQuery: '',
            appliedFilters: {},
        });

        onWillStart(async () => {
            await this.loadFilterOptions();
        });
    }

    async loadFilterOptions() {
        try {
            const result = await rpc('/kpi_reports/kra/get_filters', {});
            if (result.status) {
                this.state.kras = result.kras || [];
                this.state.employees = result.employees || [];
            }
        } catch (error) {
            console.error('Error loading filter options:', error);
        }
    }

    onTimeFrameChange() {
        const timeFrame = this.state.filters.time_frame;
        const today = new Date();
        
        if (timeFrame === 'today') {
            const todayStr = today.toISOString().split('T')[0];
            this.state.filters.from_date = todayStr;
            this.state.filters.to_date = todayStr;
        } else if (timeFrame === 'yesterday') {
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = yesterday.toISOString().split('T')[0];
            this.state.filters.from_date = yesterdayStr;
            this.state.filters.to_date = yesterdayStr;
        } else if (timeFrame === 'last_month') {
            const firstDay = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            const lastDay = new Date(today.getFullYear(), today.getMonth(), 0);
            this.state.filters.from_date = firstDay.toISOString().split('T')[0];
            this.state.filters.to_date = lastDay.toISOString().split('T')[0];
        } else if (timeFrame === 'last_year') {
            const lastYear = today.getFullYear() - 1;
            this.state.filters.from_date = `${lastYear}-01-01`;
            this.state.filters.to_date = `${lastYear}-12-31`;
        }
    }

    async generateReport() {
        this.state.isLoading = true;
        this.state.reportGenerated = false;
        
        try {
            const result = await rpc('/kpi_reports/kra/generate', {
                from_date: this.state.filters.from_date,
                to_date: this.state.filters.to_date,
                employee_id: this.state.filters.employee_id || false,
                kra_id: this.state.filters.kra_id || false,
                time_frame: this.state.filters.time_frame || false,
            });
            
            if (result.status) {
                this.state.reportData = result.data || [];
                this.state.summaryData = result.summary || [];
                this.state.appliedFilters = result.filters || {};
                this.state.reportGenerated = true;
            } else {
                alert('Error generating report: ' + (result.message || 'Unknown error'));
            }
        } catch (error) {
            console.error('Error generating report:', error);
            alert('Error generating report. Please try again.');
        } finally {
            this.state.isLoading = false;
        }
    }

    resetFilters() {
        const today = new Date().toISOString().split('T')[0];
        this.state.filters = {
            from_date: today,
            to_date: today,
            employee_id: '',
            kra_id: '',
            time_frame: '',
        };
        this.state.searchQuery = '';
    }

    onSearchChange() {
        // Search is reactive through getFilteredData()
    }

    getFilteredData() {
        if (!this.state.searchQuery.trim()) {
            return this.state.reportData;
        }
        
        const query = this.state.searchQuery.toLowerCase().trim();
        return this.state.reportData.filter(row => 
            row.kra_path.toLowerCase().includes(query) ||
            row.sub_kra.toLowerCase().includes(query) ||
            row.kpi_name.toLowerCase().includes(query) ||
            row.employee_name.toLowerCase().includes(query)
        );
    }

    getTotalTimeWorked() {
        const totalSeconds = this.getFilteredData().reduce((sum, row) => sum + (row.time_worked_seconds || 0), 0);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        return `${hours}h ${minutes}m`;
    }

    getUniqueKraCount() {
        const uniqueKras = new Set(this.getFilteredData().map(row => row.kra_path));
        return uniqueKras.size;
    }

    getUniqueEmployeeCount() {
        const uniqueEmployees = new Set(this.getFilteredData().map(row => row.employee_id).filter(id => id));
        return uniqueEmployees.size;
    }

    // Group the current filtered rows by KRA hierarchy path so the PDF/Excel
    // can render a "project summary" block above the task-detail list.
    getProjectSummary() {
        const buckets = new Map();
        for (const row of this.getFilteredData()) {
            const key = row.kra_path || row.sub_kra || 'Unassigned';
            if (!buckets.has(key)) {
                buckets.set(key, {
                    kra_path: key,
                    root_kra: row.root_kra || '',
                    sub_kra: row.sub_kra || '',
                    task_count: 0,
                    total_seconds: 0,
                    employees: new Set(),
                });
            }
            const b = buckets.get(key);
            b.task_count += 1;
            b.total_seconds += (row.time_worked_seconds || 0);
            if (row.employee_name) b.employees.add(row.employee_name);
        }
        const fmt = (sec) => {
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            return `${h}h ${m}m`;
        };
        return Array.from(buckets.values())
            .map(b => ({
                kra_path: b.kra_path,
                root_kra: b.root_kra,
                sub_kra: b.sub_kra,
                task_count: b.task_count,
                employee_count: b.employees.size,
                employees: Array.from(b.employees).sort().join(', '),
                total_seconds: b.total_seconds,
                total_hours: +(b.total_seconds / 3600).toFixed(2),
                total_display: fmt(b.total_seconds),
            }))
            .sort((a, b) => a.kra_path.localeCompare(b.kra_path));
    }

    getStatusBadgeClass(status) {
        const classes = {
            'completed': 'badge bg-success',
            'in_progress': 'badge bg-primary',
            'paused': 'badge bg-warning text-dark',
            'partially_completed': 'badge bg-info',
            'assigned': 'badge bg-secondary',
            'urgent': 'badge bg-danger',
            'important': 'badge bg-warning text-dark',
            'regular': 'badge bg-light text-dark border',
        };
        return classes[status] || 'badge bg-secondary';
    }

    formatStatus(status) {
        const labels = {
            'completed': 'Completed',
            'in_progress': 'In Progress',
            'paused': 'Paused',
            'partially_completed': 'Pending Approval',
            'assigned': 'Assigned',
            'urgent': 'Urgent',
            'important': 'Important',
            'regular': 'Regular',
        };
        return labels[status] || status || 'Unknown';
    }

    backToDashboard() {
        window.history.back();
    }

    // Helper function to convert arrow symbols to PDF-safe format
    formatKraPathForPdf(path) {
        // Replace → with > for PDF compatibility
        return path.replace(/→/g, '>');
    }

    // Safe filename: strip characters illegal on Windows/Unix and collapse whitespace.
    _safeFilename(s) {
        return String(s || 'untitled')
            .replace(/[\\/:*?"<>|]+/g, '-')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
    }

    // Build a single per-project summary PDF (jsPDF Blob).
    _buildProjectSummaryPdf(projectKey, projectRows) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF('p', 'mm', 'a4');
        const filterFrom = this.state.filters.from_date || '';
        const filterTo   = this.state.filters.to_date || '';

        // Header band
        doc.setFillColor(33, 136, 56);
        doc.rect(0, 0, 210, 24, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(15);
        doc.setFont(undefined, 'bold');
        doc.text(this.formatKraPathForPdf(projectKey), 14, 12);
        doc.setFontSize(9);
        doc.setFont(undefined, 'normal');
        doc.text(`Period: ${filterFrom}  to  ${filterTo}`, 14, 19);

        // Aggregate user totals across this project's rows
        const userTotals = new Map();
        let totalSec = 0;
        for (const row of projectRows) {
            totalSec += row.time_worked_seconds || 0;
            for (const ub of (row.user_breakdown || [])) {
                const cur = userTotals.get(ub.user_name) || 0;
                userTotals.set(ub.user_name, cur + (ub.seconds || 0));
            }
        }
        const fmt = (sec) => {
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            return `${h}h ${m}m`;
        };

        doc.setTextColor(0, 0, 0);
        doc.setFontSize(10);
        doc.text(`Total tasks: ${projectRows.length}`, 14, 32);
        doc.text(`Total time: ${fmt(totalSec)}`, 80, 32);
        doc.text(`Contributors: ${userTotals.size}`, 145, 32);

        // Contributor breakdown table
        const ubBody = Array.from(userTotals.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([name, sec]) => [name, fmt(sec), ((sec * 100) / (totalSec || 1)).toFixed(1) + '%']);
        doc.autoTable({
            head: [['Contributor', 'Time Worked', 'Share']],
            body: ubBody,
            startY: 38,
            styles: { fontSize: 9, cellPadding: 2 },
            headStyles: { fillColor: [33, 136, 56], textColor: 255, fontStyle: 'bold' },
            columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
        });

        // Task list table
        const startY = (doc.lastAutoTable && doc.lastAutoTable.finalY ? doc.lastAutoTable.finalY : 38) + 8;
        doc.setFont(undefined, 'bold');
        doc.text('Task list', 14, startY);

        const taskBody = projectRows.map((r, i) => [
            i + 1,
            r.external_ref || '—',
            r.kpi_name,
            r.employee_name,
            r.time_worked_display,
        ]);
        taskBody.push(['', 'TOTAL', `${projectRows.length} tasks`, '', fmt(totalSec)]);

        doc.autoTable({
            head: [['#', 'Ref', 'Task Name', 'Primary Assignee', 'Time Worked']],
            body: taskBody,
            startY: startY + 2,
            styles: { fontSize: 8.5, cellPadding: 2, overflow: 'linebreak' },
            headStyles: { fillColor: [52, 58, 64], textColor: 255, fontStyle: 'bold' },
            alternateRowStyles: { fillColor: [245, 245, 245] },
            columnStyles: {
                0: { cellWidth: 10 },
                1: { cellWidth: 20 },
                2: { cellWidth: 95 },
                3: { cellWidth: 40 },
                4: { cellWidth: 26, halign: 'right' },
            },
            didParseCell: (cd) => {
                if (cd.row.index === taskBody.length - 1) {
                    cd.cell.styles.fillColor = [236, 240, 241];
                    cd.cell.styles.fontStyle = 'bold';
                }
            },
        });

        return doc.output('blob');
    }

    // Build a per-task detail PDF (jsPDF Blob).
    _buildTaskDetailPdf(row) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF('p', 'mm', 'a4');

        doc.setFillColor(52, 58, 64);
        doc.rect(0, 0, 210, 22, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(13);
        doc.setFont(undefined, 'bold');
        doc.text(this.formatKraPathForPdf(row.kpi_name || 'Task'), 14, 12);
        doc.setFontSize(9);
        doc.setFont(undefined, 'normal');
        doc.text(`Ref: ${row.external_ref || '—'}    State: ${row.task_state || '—'}`, 14, 18);

        doc.setTextColor(0, 0, 0);
        doc.setFontSize(10);
        doc.autoTable({
            head: [['Field', 'Value']],
            body: [
                ['KRA Hierarchy', this.formatKraPathForPdf(row.kra_path || '')],
                ['Sub-KRA', row.sub_kra || '—'],
                ['External Ref', row.external_ref || '—'],
                ['Priority', row.priority || '—'],
                ['Task State', row.task_state || '—'],
                ['Deadline', row.deadline || '—'],
                ['Primary Assignee', row.employee_name || '—'],
                ['Total Time Worked', row.time_worked_display || '0h 0m'],
            ],
            startY: 28,
            styles: { fontSize: 9.5, cellPadding: 2.5 },
            headStyles: { fillColor: [52, 58, 64], textColor: 255, fontStyle: 'bold' },
            columnStyles: { 0: { cellWidth: 55, fontStyle: 'bold' }, 1: { cellWidth: 130 } },
        });

        // User-breakdown table
        const yStart = (doc.lastAutoTable && doc.lastAutoTable.finalY ? doc.lastAutoTable.finalY : 28) + 8;
        doc.setFont(undefined, 'bold');
        doc.setFontSize(11);
        doc.text('Who worked on this task', 14, yStart);

        const ub = row.user_breakdown || [];
        const totalSec = ub.reduce((s, u) => s + (u.seconds || 0), 0) || (row.time_worked_seconds || 1);
        const body = ub.map((u, i) => [
            i + 1,
            u.user_name,
            u.display,
            ((u.seconds * 100) / totalSec).toFixed(1) + '%',
        ]);
        if (body.length === 0) {
            body.push(['—', row.employee_name || 'Unassigned', row.time_worked_display, '100.0%']);
        }

        doc.autoTable({
            head: [['#', 'User', 'Time Logged', 'Share of task']],
            body,
            startY: yStart + 2,
            styles: { fontSize: 9.5, cellPadding: 2.5 },
            headStyles: { fillColor: [33, 136, 56], textColor: 255, fontStyle: 'bold' },
            columnStyles: {
                0: { cellWidth: 12 },
                1: { cellWidth: 95 },
                2: { cellWidth: 40, halign: 'right' },
                3: { cellWidth: 40, halign: 'right' },
            },
        });

        return doc.output('blob');
    }

    async downloadZip() {
        try {
            if (!window.JSZip) {
                alert('JSZip not loaded yet. Refresh the page and try again.');
                return;
            }
            if (!window.jspdf || !window.jspdf.jsPDF) {
                alert('jsPDF not loaded yet. Refresh the page and try again.');
                return;
            }

            const rows = this.getFilteredData();
            if (!rows.length) {
                alert('No tasks to export.');
                return;
            }

            // Group rows by project (sub-KRA / kra_path) so each project becomes
            // its own summary PDF + folder of per-task PDFs.
            const groups = new Map();
            for (const r of rows) {
                const key = r.sub_kra && r.sub_kra !== '-' ? r.sub_kra : (r.root_kra || r.kra_path || 'Project');
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(r);
            }

            const zip = new window.JSZip();

            for (const [projectName, projectRows] of groups.entries()) {
                const safeProject = this._safeFilename(projectName);
                // 1 summary PDF per project
                const summaryBlob = this._buildProjectSummaryPdf(projectName, projectRows);
                zip.file(`${safeProject}.pdf`, summaryBlob);

                // 1 folder per project, 1 PDF per task inside
                const folder = zip.folder(safeProject);
                projectRows.forEach((r, idx) => {
                    const refPart = r.external_ref ? `${r.external_ref} ` : `${String(idx + 1).padStart(3, '0')} `;
                    const fname = this._safeFilename(refPart + (r.kpi_name || 'task')) + '.pdf';
                    folder.file(fname, this._buildTaskDetailPdf(r));
                });
            }

            const fromDate = this.state.filters.from_date || 'all';
            const toDate = this.state.filters.to_date || 'all';
            const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `KRA_Report_${fromDate}_to_${toDate}.zip`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('Error generating ZIP:', err);
            alert('Error generating ZIP. See browser console for details.');
        }
    }

    async downloadPDF() {
        try {
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF('l', 'mm', 'a4'); // Landscape for more columns
            
            const fromDate = this.state.filters.from_date;
            const toDate = this.state.filters.to_date;
            const filterKra = this.state.appliedFilters.kra_name || 'All KRAs';
            const filterEmployee = this.state.appliedFilters.employee_name || 'All Employees';
            
            // Header
            doc.setFillColor(52, 58, 64);
            doc.rect(0, 0, 297, 25, 'F');
            
            doc.setTextColor(255, 255, 255);
            doc.setFontSize(18);
            doc.setFont(undefined, 'bold');
            doc.text('KRA Report', 14, 15);
            
            doc.setFontSize(10);
            doc.setFont(undefined, 'normal');
            doc.text(`Generated: ${new Date().toLocaleString()}`, 200, 10);
            doc.text(`Period: ${fromDate} to ${toDate}`, 200, 15);
            doc.text(`KRA: ${filterKra} | Employee: ${filterEmployee}`, 200, 20);
            
            // Summary Stats
            doc.setTextColor(0, 0, 0);
            doc.setFontSize(11);
            doc.setFont(undefined, 'bold');
            doc.text('Summary', 14, 35);
            
            const summaryY = 40;
            doc.setFontSize(9);
            doc.setFont(undefined, 'normal');
            doc.text(`Total Tasks: ${this.state.reportData.length}`, 14, summaryY);
            doc.text(`Total Time Worked: ${this.getTotalTimeWorked()}`, 100, summaryY);
            doc.text(`Employees: ${this.getUniqueEmployeeCount()}`, 200, summaryY);
            
            // -------- SECTION A: Project-wise summary --------
            doc.setFontSize(11);
            doc.setFont(undefined, 'bold');
            doc.text('Project-wise Summary', 14, 50);

            const summaryHeaders = [[
                '#', 'KRA Hierarchy Path', 'Tasks', 'Employees', 'Total Time'
            ]];
            const projectSummary = this.getProjectSummary();
            const summaryRows = projectSummary.map((g, i) => [
                i + 1,
                this.formatKraPathForPdf(g.kra_path),
                g.task_count,
                g.employees || `${g.employee_count}`,
                g.total_display,
            ]);
            summaryRows.push([
                '-',
                'GRAND TOTAL',
                projectSummary.reduce((s, g) => s + g.task_count, 0),
                this.getUniqueEmployeeCount(),
                this.getTotalTimeWorked(),
            ]);

            doc.autoTable({
                head: summaryHeaders,
                body: summaryRows,
                startY: 53,
                styles: { fontSize: 9, cellPadding: 3, overflow: 'linebreak' },
                headStyles: { fillColor: [33, 136, 56], textColor: 255, fontStyle: 'bold' },
                alternateRowStyles: { fillColor: [240, 248, 240] },
                columnStyles: {
                    0: { cellWidth: 12 },
                    1: { cellWidth: 110 },
                    2: { cellWidth: 20, halign: 'right' },
                    3: { cellWidth: 110 },
                    4: { cellWidth: 30, halign: 'right' },
                },
                didParseCell: (cellData) => {
                    if (cellData.row.index === summaryRows.length - 1) {
                        cellData.cell.styles.fillColor = [236, 240, 241];
                        cellData.cell.styles.fontStyle = 'bold';
                    }
                },
            });

            const detailStartY = (doc.lastAutoTable && doc.lastAutoTable.finalY ? doc.lastAutoTable.finalY : 53) + 10;
            doc.setFontSize(11);
            doc.setFont(undefined, 'bold');
            doc.text('Task-wise Details', 14, detailStartY - 2);

            // -------- SECTION B: Task-level detail (existing flat list) --------
            const headers = [[
                '#',
                'KRA Hierarchy Path',
                'Sub KRA',
                'Task Name',
                'Employee',
                'Time Worked'
            ]];

            // Table data (removed Status, use > instead of → for PDF)
            const data = this.getFilteredData().map((row, index) => [
                index + 1,
                this.formatKraPathForPdf(row.kra_path),
                row.sub_kra,
                row.kpi_name,
                row.employee_name,
                row.time_worked_display
            ]);

            // Add totals row
            data.push([
                '-',
                'TOTAL',
                '-',
                `${this.getFilteredData().length} Tasks`,
                `${this.getUniqueEmployeeCount()} Employees`,
                this.getTotalTimeWorked()
            ]);

            // Generate table
            doc.autoTable({
                head: headers,
                body: data,
                startY: detailStartY,
                styles: {
                    fontSize: 9,
                    cellPadding: 3,
                    overflow: 'linebreak',
                },
                headStyles: {
                    fillColor: [52, 58, 64],
                    textColor: 255,
                    fontStyle: 'bold',
                },
                alternateRowStyles: {
                    fillColor: [245, 245, 245]
                },
                columnStyles: {
                    0: { cellWidth: 12 },    // #
                    1: { cellWidth: 95 },    // KRA Path (wider)
                    2: { cellWidth: 40 },    // Sub KRA
                    3: { cellWidth: 70 },    // Task Name
                    4: { cellWidth: 45 },    // Employee
                    5: { cellWidth: 30 },    // Time
                },
                didParseCell: (cellData) => {
                    // Bold the totals row
                    if (cellData.row.index === data.length - 1) {
                        cellData.cell.styles.fillColor = [236, 240, 241];
                        cellData.cell.styles.fontStyle = 'bold';
                    }
                }
            });
            
            // Footer
            const pageCount = doc.internal.getNumberOfPages();
            for (let i = 1; i <= pageCount; i++) {
                doc.setPage(i);
                doc.setTextColor(150, 150, 150);
                doc.setFontSize(8);
                doc.text('Generated by KRA/KPI Management System', 14, 200);
                doc.text(`Page ${i} of ${pageCount}`, 260, 200);
            }
            
            // Save
            const filename = `KRA_Report_${fromDate}_to_${toDate}.pdf`;
            doc.save(filename);
            
        } catch (error) {
            console.error('Error generating PDF:', error);
            alert('Error generating PDF. Please try again.');
        }
    }

    async downloadExcel() {
        try {
            const q = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
            let csv = '';

            // -------- SECTION A: Project-wise summary --------
            csv += 'PROJECT-WISE SUMMARY\n';
            csv += ['#', 'KRA Hierarchy Path', 'Tasks', 'Employees Count', 'Employees', 'Total Time (Hours)', 'Total Time (Display)'].join(',') + '\n';
            const projectSummary = this.getProjectSummary();
            projectSummary.forEach((g, i) => {
                csv += [
                    i + 1,
                    q(g.kra_path),
                    g.task_count,
                    g.employee_count,
                    q(g.employees),
                    g.total_hours,
                    q(g.total_display),
                ].join(',') + '\n';
            });
            csv += [
                '-', q('GRAND TOTAL'),
                projectSummary.reduce((s, g) => s + g.task_count, 0),
                this.getUniqueEmployeeCount(),
                q(''),
                +(this.getFilteredData().reduce((s, r) => s + (r.time_worked_seconds || 0), 0) / 3600).toFixed(2),
                q(this.getTotalTimeWorked()),
            ].join(',') + '\n';

            // Blank separator
            csv += '\n';

            // -------- SECTION B: Task-wise details --------
            csv += 'TASK-WISE DETAILS\n';
            const headers = ['#', 'KRA Hierarchy Path', 'Sub KRA', 'Task Name', 'Employee', 'Time Worked (Hours)', 'Time Worked (Display)'];
            csv += headers.join(',') + '\n';

            this.getFilteredData().forEach((row, index) => {
                const rowData = [
                    index + 1,
                    q(row.kra_path),
                    q(row.sub_kra),
                    q(row.kpi_name),
                    q(row.employee_name),
                    row.time_worked_hours,
                    q(row.time_worked_display),
                ];
                csv += rowData.join(',') + '\n';
            });

            // Add totals row
            csv += [
                '-', q('TOTAL'), q('-'),
                q(`${this.getFilteredData().length} Tasks`),
                q(`${this.getUniqueEmployeeCount()} Employees`),
                +(this.getFilteredData().reduce((s, r) => s + (r.time_worked_seconds || 0), 0) / 3600).toFixed(2),
                q(this.getTotalTimeWorked()),
            ].join(',') + '\n';
            
            // Download
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            const url = URL.createObjectURL(blob);
            
            const fromDate = this.state.filters.from_date;
            const toDate = this.state.filters.to_date;
            
            link.setAttribute('href', url);
            link.setAttribute('download', `KRA_Report_${fromDate}_to_${toDate}.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
        } catch (error) {
            console.error('Error generating Excel:', error);
            alert('Error generating Excel. Please try again.');
        }
    }
}

registry.category("actions").add("kpi_kra_report", KpiKraReport);
