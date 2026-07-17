/** @odoo-module **/

import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

export class KpiPeriodReport extends Component {

    static template = xml/* xml */`
        <div class="o_kpi_period_report p-4">
            <div class="d-flex justify-content-between align-items-center mb-3">
                <h2 class="fw-bold"><i class="fa fa-check-square-o me-2"></i> Work Report</h2>
            </div>

            <!-- Filter bar -->
            <div class="card p-3 mb-3 shadow-sm">
                <label class="form-label fw-bold"><i class="fa fa-calendar me-1 text-muted"/> Period</label>
                <div class="btn-group w-100 mb-2" role="group">
                    <button type="button" t-att-class="'btn btn-sm ' + (state.preset==='today'?'btn-primary':'btn-outline-primary')" t-on-click="() => this.setPreset('today')">Today</button>
                    <button type="button" t-att-class="'btn btn-sm ' + (state.preset==='this_week'?'btn-primary':'btn-outline-primary')" t-on-click="() => this.setPreset('this_week')">This Week</button>
                    <button type="button" t-att-class="'btn btn-sm ' + (state.preset==='this_month'?'btn-primary':'btn-outline-primary')" t-on-click="() => this.setPreset('this_month')">This Month</button>
                    <button type="button" t-att-class="'btn btn-sm ' + (state.preset==='last_month'?'btn-primary':'btn-outline-primary')" t-on-click="() => this.setPreset('last_month')">Last Month</button>
                    <button type="button" t-att-class="'btn btn-sm ' + (state.preset==='custom'?'btn-primary':'btn-outline-primary')" t-on-click="() => this.setPreset('custom')">Custom</button>
                </div>
                <div class="row g-3 align-items-end">
                    <div class="col-md-2">
                        <label class="form-label fw-bold">From</label>
                        <input type="date" class="form-control" t-model="state.from_date" t-on-change="() => state.preset='custom'"/>
                    </div>
                    <div class="col-md-2">
                        <label class="form-label fw-bold">To</label>
                        <input type="date" class="form-control" t-model="state.to_date" t-on-change="() => state.preset='custom'"/>
                    </div>
                    <div class="col-md-3">
                        <label class="form-label fw-bold">View</label>
                        <div class="btn-group w-100">
                            <button type="button" t-att-class="'btn btn-sm ' + (state.group_by==='task'?'btn-info text-white':'btn-outline-info')" t-on-click="() => this.setGroup('task')">Task-wise</button>
                            <button type="button" t-att-class="'btn btn-sm ' + (state.group_by==='client'?'btn-info text-white':'btn-outline-info')" t-on-click="() => this.setGroup('client')">Client-wise</button>
                        </div>
                    </div>
                    <div class="col-md-3">
                        <label class="form-label fw-bold">Client <span class="text-muted small">(optional)</span></label>
                        <select class="form-select" t-model="state.client_kra_id">
                            <option value="">All clients</option>
                            <t t-foreach="state.clients" t-as="c" t-key="c.id">
                                <option t-att-value="c.id" t-esc="c.name"/>
                            </t>
                        </select>
                    </div>
                    <div class="col-md-2">
                        <button class="btn btn-primary w-100" t-on-click="generate" t-att-disabled="state.loading">
                            <t t-if="state.loading"><i class="fa fa-spinner fa-spin me-1"/> Loading</t>
                            <t t-else=""><i class="fa fa-search me-1"/> Generate</t>
                        </button>
                    </div>
                </div>
            </div>

            <t t-if="state.error"><div class="alert alert-danger" t-esc="state.error"/></t>

            <t t-if="state.ranOnce and !state.error">
                <div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
                    <div>
                        <span class="badge bg-secondary me-2">Completed tasks: <t t-esc="state.total_tasks"/></span>
                        <span class="badge bg-secondary" t-if="state.showHours">Total hours: <t t-esc="state.total_hours_display"/></span>
                        <span class="text-muted small ms-2"><t t-esc="state.from_date_result"/> → <t t-esc="state.to_date_result"/></span>
                    </div>
                    <div class="d-flex align-items-center gap-3">
                        <div class="form-check form-switch mb-0">
                            <input class="form-check-input" type="checkbox" id="pr_show_hours" t-att-checked="state.showHours" t-on-change="(ev) => state.showHours = ev.target.checked"/>
                            <label class="form-check-label small" for="pr_show_hours">Show hours</label>
                        </div>
                        <button class="btn btn-outline-success btn-sm" t-on-click="downloadPdf" t-att-disabled="state.total_tasks===0">
                            <i class="fa fa-download me-1"/> Download PDF
                        </button>
                    </div>
                </div>

                <t t-if="state.total_tasks === 0">
                    <div class="alert alert-info">No completed tasks in this period.</div>
                </t>

                <!-- TASK-WISE -->
                <t t-if="state.result_group === 'task' and state.total_tasks > 0">
                    <div class="card shadow-sm"><div class="card-body p-0">
                        <table class="table table-hover mb-0 align-middle">
                            <thead class="table-light"><tr>
                                <th>Ref</th><th>Task</th><th>Client</th><th>Project</th><th>Assignee</th><th>Completed</th>
                                <th t-if="state.showHours" class="text-end">Hours</th>
                            </tr></thead>
                            <tbody>
                                <t t-foreach="state.tasks" t-as="t" t-key="t.task_id">
                                    <tr>
                                        <td><b t-esc="t.ref"/></td>
                                        <td t-esc="t.name"/>
                                        <td t-esc="t.client_name"/>
                                        <td class="text-muted" t-esc="t.project_name"/>
                                        <td t-esc="t.assignee"/>
                                        <td t-esc="t.completion_date"/>
                                        <td t-if="state.showHours" class="text-end" t-esc="t.hours_display"/>
                                    </tr>
                                </t>
                            </tbody>
                        </table>
                    </div></div>
                </t>

                <!-- CLIENT-WISE -->
                <t t-if="state.result_group === 'client' and state.total_tasks > 0">
                    <t t-foreach="state.clientGroups" t-as="cl" t-key="cl.client_id">
                        <div class="card shadow-sm mb-2">
                            <div class="card-header d-flex justify-content-between align-items-center" style="cursor:pointer;" t-on-click="() => this.toggleClient(cl.client_id)">
                                <span class="fw-bold">
                                    <i t-att-class="state.expanded[cl.client_id] ? 'fa fa-chevron-down me-2' : 'fa fa-chevron-right me-2'"/>
                                    <t t-esc="cl.client_name"/>
                                </span>
                                <span>
                                    <span class="badge bg-primary me-2"><t t-esc="cl.task_count"/> tasks</span>
                                    <span class="badge bg-info" t-if="state.showHours" t-esc="cl.total_display"/>
                                </span>
                            </div>
                            <div class="card-body p-0" t-if="state.expanded[cl.client_id]">
                                <table class="table table-sm mb-0 align-middle">
                                    <thead class="table-light"><tr>
                                        <th>Ref</th><th>Task</th><th>Project</th><th>Assignee</th><th>Completed</th>
                                        <th t-if="state.showHours" class="text-end">Hours</th>
                                    </tr></thead>
                                    <tbody>
                                        <t t-foreach="cl.tasks" t-as="t" t-key="t.task_id">
                                            <tr>
                                                <td><b t-esc="t.ref"/></td>
                                                <td t-esc="t.name"/>
                                                <td class="text-muted" t-esc="t.project_name"/>
                                                <td t-esc="t.assignee"/>
                                                <td t-esc="t.completion_date"/>
                                                <td t-if="state.showHours" class="text-end" t-esc="t.hours_display"/>
                                            </tr>
                                        </t>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </t>
                </t>
            </t>
        </div>
    `;

    setup() {
        this.state = useState({
            preset: 'this_month',
            from_date: '',
            to_date: '',
            group_by: 'task',
            client_kra_id: '',
            clients: [],            // dropdown list
            showHours: true,
            loading: false,
            ranOnce: false,
            error: '',
            result_group: 'task',   // grouping of the current result
            tasks: [],              // task-wise rows
            clientGroups: [],       // client-wise buckets
            total_tasks: 0,
            total_hours_display: '0h',
            from_date_result: '',
            to_date_result: '',
            expanded: {},
            company_name: '',
            company_logo_b64: '',
        });
        onWillStart(async () => {
            const today = new Date();
            this.state.from_date = this._fmt(new Date(today.getFullYear(), today.getMonth(), 1));
            this.state.to_date = this._fmt(today);
            try {
                const r = await rpc('/kpi_reports/period_work/clients', {});
                if (r && r.status) this.state.clients = r.clients || [];
            } catch (e) { /* non-fatal */ }
        });
    }

    _fmt(d) {
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }
    setPreset(preset) {
        this.state.preset = preset;
        const today = new Date();
        let from = new Date(today), to = new Date(today);
        if (preset === 'today') { /* from=to=today */ }
        else if (preset === 'this_week') { const dow = today.getDay() || 7; from = new Date(today); from.setDate(today.getDate() - (dow - 1)); }
        else if (preset === 'this_month') { from = new Date(today.getFullYear(), today.getMonth(), 1); }
        else if (preset === 'last_month') { from = new Date(today.getFullYear(), today.getMonth() - 1, 1); to = new Date(today.getFullYear(), today.getMonth(), 0); }
        else { return; }
        this.state.from_date = this._fmt(from);
        this.state.to_date = this._fmt(to);
    }
    setGroup(g) {
        this.state.group_by = g;
        if (this.state.ranOnce) this.generate();
    }
    toggleClient(id) { this.state.expanded[id] = !this.state.expanded[id]; }

    async generate() {
        this.state.loading = true;
        this.state.error = '';
        try {
            const r = await rpc('/kpi_reports/period_work/generate', {
                from_date: this.state.from_date,
                to_date: this.state.to_date,
                group_by: this.state.group_by,
                client_kra_id: this.state.client_kra_id || false,
            });
            if (!r || !r.status) { this.state.error = (r && r.message) || 'Failed to load report.'; return; }
            this.state.result_group = r.group_by;
            this.state.tasks = r.tasks || [];
            this.state.clientGroups = r.clients || [];
            this.state.total_tasks = r.total_tasks || 0;
            this.state.total_hours_display = r.total_hours_display || '0h';
            this.state.from_date_result = r.from_date;
            this.state.to_date_result = r.to_date;
            this.state.company_name = r.company_name || '';
            this.state.company_logo_b64 = r.company_logo_b64 || '';
            this.state.expanded = {};
        } catch (e) {
            this.state.error = (e && e.message) || String(e);
        } finally {
            this.state.loading = false;
            this.state.ranOnce = true;
        }
    }

    async downloadPdf() {
        if (!window.jspdf) { alert('jsPDF library not loaded.'); return; }
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: 'pt', format: 'a4' });
        doc.setFont('times', 'normal');
        const pageW = doc.internal.pageSize.getWidth();
        const pageH = doc.internal.pageSize.getHeight();
        const M = 48;
        let y = M;
        const showHours = this.state.showHours;
        const clientWise = this.state.result_group === 'client';
        const logo = this.state.company_logo_b64 ? ('data:image/png;base64,' + this.state.company_logo_b64) : '';
        let logoRatio = 1;
        if (logo) { try { const p = doc.getImageProperties(logo); if (p.width && p.height) logoRatio = p.width / p.height; } catch (e) {} }

        if (logo) { try { const h = 56, w = Math.min(h * logoRatio, 150); doc.addImage(logo, 'PNG', M, y, w, h); } catch (e) {} }
        doc.setFont('times', 'bold'); doc.setFontSize(22);
        doc.text(this.state.company_name || '', pageW - M, y + 22, { align: 'right' });
        doc.setFont('times', 'normal'); doc.setFontSize(12);
        doc.text('WORK REPORT', pageW - M, y + 44, { align: 'right' });
        y += 72;
        doc.setDrawColor(190); doc.setLineWidth(0.8); doc.line(M, y, pageW - M, y); y += 22;

        doc.setFontSize(11);
        doc.text(`Period: ${this.state.from_date_result} to ${this.state.to_date_result}`, M, y);
        doc.text(`Completed tasks: ${this.state.total_tasks}`, pageW - M, y, { align: 'right' });
        y += 16;
        if (showHours) { doc.text(`Total hours: ${this.state.total_hours_display}`, pageW - M, y, { align: 'right' }); }
        y += 12;

        const head = clientWise
            ? [showHours ? ['Ref', 'Task', 'Project', 'Assignee', 'Completed', 'Hours'] : ['Ref', 'Task', 'Project', 'Assignee', 'Completed']]
            : [showHours ? ['Ref', 'Task', 'Client', 'Project', 'Assignee', 'Completed', 'Hours'] : ['Ref', 'Task', 'Client', 'Project', 'Assignee', 'Completed']];
        const rowOf = (t) => {
            const r = clientWise
                ? [t.ref, t.name, t.project_name, t.assignee, t.completion_date]
                : [t.ref, t.name, t.client_name, t.project_name, t.assignee, t.completion_date];
            if (showHours) r.push(t.hours_display);
            return r;
        };
        const colStyles = { 0: { cellWidth: 55 } };
        if (showHours) colStyles[head[0].length - 1] = { halign: 'right', cellWidth: 55 };
        const tableOpts = {
            margin: { left: M, right: M },
            styles: { font: 'times', fontSize: 9, cellPadding: 5, lineColor: [225, 225, 225], lineWidth: 0.5, overflow: 'linebreak' },
            headStyles: { font: 'times', fontStyle: 'bold', fillColor: [56, 56, 92], textColor: 255, halign: 'left' },
            columnStyles: colStyles,
            alternateRowStyles: { fillColor: [247, 247, 251] },
        };

        if (!doc.autoTable) { alert('PDF table plugin not loaded.'); return; }
        if (clientWise) {
            for (const c of this.state.clientGroups) {
                y += 6;
                // Keep the client label with its table: if we're near the page bottom,
                // start a fresh page so the label never orphans/clips above the margin.
                if (y > pageH - 80) { doc.addPage(); y = M; }
                doc.setFont('times', 'bold'); doc.setFontSize(11);
                const label = showHours ? `${c.client_name}  —  ${c.task_count} tasks, ${c.total_display}` : `${c.client_name}  —  ${c.task_count} tasks`;
                doc.text(label, M, y); y += 4;
                doc.autoTable({ ...tableOpts, startY: y + 4, head: head, body: c.tasks.map(rowOf) });
                y = doc.lastAutoTable.finalY + 14;
            }
        } else {
            doc.autoTable({ ...tableOpts, startY: y, head: head, body: this.state.tasks.map(rowOf) });
        }

        // Watermark on every page
        if (logo) {
            try {
                let wmW = pageW * 0.55, wmH = wmW / (logoRatio || 1);
                if (wmH > pageH * 0.5) { wmH = pageH * 0.5; wmW = wmH * (logoRatio || 1); }
                const wmX = (pageW - wmW) / 2, wmY = (pageH - wmH) / 2;
                const pc = doc.internal.getNumberOfPages();
                for (let p = 1; p <= pc; p++) {
                    doc.setPage(p);
                    if (doc.GState) { doc.saveGraphicsState(); doc.setGState(new doc.GState({ opacity: 0.08 })); }
                    doc.addImage(logo, 'PNG', wmX, wmY, wmW, wmH);
                    if (doc.GState) doc.restoreGraphicsState();
                }
            } catch (e) {}
        }
        doc.save(`Work_Report_${this.state.from_date_result}_to_${this.state.to_date_result}.pdf`);
    }
}

registry.category("actions").add("kpi_period_report", KpiPeriodReport);
