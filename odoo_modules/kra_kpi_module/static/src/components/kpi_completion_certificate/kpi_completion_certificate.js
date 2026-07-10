/** @odoo-module **/
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

export class KpiCompletionCertificate extends Component {
    static template = xml/* xml */`
        <div class="o_kpi_completion_certificate p-4">
            <div class="d-flex justify-content-between align-items-center mb-4">
                <h2 class="fw-bold">
                    <i class="fa fa-certificate me-2 text-primary"/> Completion Certificates
                </h2>
                <div class="btn-group">
                    <a class="btn btn-outline-secondary btn-sm"
                       href="/kpi_completion_cert/template/requirement" target="_blank">
                        <i class="fa fa-download me-1"/> Requirement Template (XLSX)
                    </a>
                    <a class="btn btn-outline-secondary btn-sm"
                       href="/kpi_completion_cert/template/update" target="_blank">
                        <i class="fa fa-download me-1"/> Update Template (XLSX)
                    </a>
                    <a class="btn btn-outline-secondary btn-sm"
                       href="/kpi_completion_cert/template/bug_report" target="_blank">
                        <i class="fa fa-download me-1"/> Bug Report Template (XLSX)
                    </a>
                </div>
            </div>

            <!-- Quick Create Task from Requirement Doc -->
            <div class="card p-3 mb-4 shadow-sm border-success">
                <div class="d-flex justify-content-between align-items-center">
                    <h5 class="fw-bold mb-0">
                        <i class="fa fa-plus-circle me-2 text-success"/> Quick Create Task from Requirement Doc
                    </h5>
                    <button class="btn btn-sm btn-outline-secondary" t-on-click="() => state.showQuickCreate = !state.showQuickCreate">
                        <t t-if="state.showQuickCreate">Hide</t>
                        <t t-else="">Expand</t>
                    </button>
                </div>
                <div t-if="state.showQuickCreate" class="row g-3 mt-2">
                    <div class="col-md-3">
                        <label class="form-label fw-bold">Client (Root KRA)</label>
                        <select class="form-select" t-model="state.newTask.client_kra_id"
                                t-on-change="onNewTaskClientChange">
                            <option value="">-- Select Client --</option>
                            <t t-foreach="state.allRootKras" t-as="c" t-key="c.id">
                                <option t-att-value="c.id" t-esc="c.name"/>
                            </t>
                        </select>
                    </div>
                    <div class="col-md-3">
                        <label class="form-label fw-bold">Project (Sub-KRA)</label>
                        <select class="form-select" t-model="state.newTask.sub_kra_id">
                            <option value="">-- Select Project --</option>
                            <t t-foreach="state.subKras" t-as="s" t-key="s.id">
                                <option t-att-value="s.id" t-esc="s.display"/>
                            </t>
                        </select>
                    </div>
                    <div class="col-md-3">
                        <label class="form-label fw-bold">Task Name</label>
                        <input type="text" class="form-control" t-model="state.newTask.task_name"
                               placeholder="e.g. Discount option implementation"/>
                    </div>
                    <div class="col-md-3">
                        <label class="form-label fw-bold">Requirement Doc</label>
                        <input type="file" class="form-control"
                               accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
                               t-on-change="onNewTaskFileSelected"/>
                    </div>
                    <div class="col-md-2">
                        <label class="form-label fw-bold">Requirement Ver</label>
                        <input type="text" class="form-control" t-model="state.newTask.requirement_version"
                               placeholder="v1.1"/>
                    </div>
                    <div class="col-md-2">
                        <label class="form-label fw-bold">Est. Hours</label>
                        <input type="number" min="0" class="form-control" t-model.number="state.newTask.estimate_hours"/>
                    </div>
                    <div class="col-md-2">
                        <label class="form-label fw-bold">Est. Minutes</label>
                        <input type="number" min="0" max="59" class="form-control" t-model.number="state.newTask.estimate_minutes"/>
                    </div>
                    <div class="col-md-3">
                        <label class="form-label fw-bold">Primary Developer</label>
                        <select class="form-select" t-model="state.newTask.primary_user_id">
                            <option value="">-- None --</option>
                            <t t-foreach="state.allUsers" t-as="u" t-key="u.id">
                                <option t-att-value="u.id" t-esc="u.name"/>
                            </t>
                        </select>
                    </div>
                    <div class="col-md-3 d-flex align-items-end">
                        <button class="btn btn-success w-100" t-on-click="quickCreateTask">
                            <i class="fa fa-plus me-1"/> Create Task
                        </button>
                    </div>
                </div>
            </div>

            <!-- Filter card -->
            <div class="card p-3 mb-4 shadow-sm">
                <h5 class="fw-bold mb-3"><i class="fa fa-filter me-2 text-secondary"/> Filters</h5>
                <div class="row g-3 align-items-end">
                    <div class="col-md-3">
                        <label class="form-label fw-bold">Client</label>
                        <select class="form-select" t-model="state.filters.client_kra_id">
                            <option value="">All Clients</option>
                            <t t-foreach="state.clients" t-as="c" t-key="c.id">
                                <option t-att-value="c.id">
                                    <t t-esc="c.parent_name ? c.parent_name + ' > ' + c.name : c.name"/>
                                </option>
                            </t>
                        </select>
                    </div>
                    <div class="col-md-2">
                        <label class="form-label fw-bold">From</label>
                        <input type="date" class="form-control" t-model="state.filters.from_date"/>
                    </div>
                    <div class="col-md-2">
                        <label class="form-label fw-bold">To</label>
                        <input type="date" class="form-control" t-model="state.filters.to_date"/>
                    </div>
                    <div class="col-md-3">
                        <label class="form-label fw-bold">State</label>
                        <select class="form-select" t-model="state.filters.state">
                            <option value="completed">Completed</option>
                            <option value="partially_completed">Pending Approval</option>
                            <option value="all">All States</option>
                        </select>
                    </div>
                    <div class="col-md-2">
                        <button class="btn btn-primary w-100" t-on-click="loadList">
                            <i class="fa fa-search me-1"/> Search
                        </button>
                    </div>
                </div>
            </div>

            <!-- Results list -->
            <div class="card p-3 shadow-sm">
                <h5 class="fw-bold mb-3">
                    <i class="fa fa-list me-2 text-secondary"/> Eligible KPIs
                    <span class="badge bg-secondary ms-2" t-esc="state.kpis.length"/>
                </h5>
                <div t-if="state.kpis.length === 0" class="text-center text-muted p-4">
                    <i class="fa fa-inbox fa-3x mb-2 d-block"/>
                    No matching KPIs. Adjust filters and click Search.
                </div>
                <table t-if="state.kpis.length > 0" class="table table-hover align-middle">
                    <thead class="table-light">
                        <tr>
                            <th>KPI</th>
                            <th>Client &gt; Project</th>
                            <th>Assignee</th>
                            <th>Completed</th>
                            <th class="text-end">Hours</th>
                            <th>Delivery Ver</th>
                            <th style="min-width: 240px">Requirement (V01)</th>
                            <th style="min-width: 240px">Updates &amp; Errors (V02)</th>
                            <th>Cert Ver</th>
                            <th style="min-width: 180px">Signed Cert</th>
                            <th>State</th>
                            <th>&#160;</th>
                        </tr>
                    </thead>
                    <tbody>
                        <t t-foreach="state.kpis" t-as="k" t-key="k.id">
                            <tr>
                                <td class="fw-bold" t-esc="k.name"/>
                                <td>
                                    <t t-esc="k.client_name"/>
                                    <t t-if="k.project_name">
                                        <span class="text-muted"> &gt; </span>
                                        <t t-esc="k.project_name"/>
                                    </t>
                                </td>
                                <td t-esc="k.primary_assignee"/>
                                <td t-esc="k.completion_date or '—'"/>
                                <td class="text-end" t-esc="k.actual_hours + 'h'"/>
                                <td>
                                    <input type="text" class="form-control form-control-sm"
                                           placeholder="e.g. APK v1.0.5"
                                           t-att-value="k.delivery_version"
                                           t-on-blur="(ev) => this.saveVersion(k.id, ev.target.value)"
                                           style="min-width: 110px"/>
                                </td>
                                <td>
                                    <div class="d-flex gap-1 align-items-center">
                                        <input type="text" class="form-control form-control-sm"
                                               placeholder="v1.1"
                                               t-att-value="k.requirement_version"
                                               t-on-blur="(ev) => this.saveReqVersion(k.id, ev.target.value)"
                                               style="max-width: 70px"/>
                                        <input type="file" class="form-control form-control-sm"
                                               accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.png,.jpg,.jpeg"
                                               t-on-change="(ev) => this.uploadDoc(k.id, 'requirement', ev)"
                                               style="font-size: 0.75rem"/>
                                        <a t-if="k.has_requirement_document"
                                           t-att-href="'/kpi_completion_cert/download_doc?kpi_id=' + k.id + '&amp;doc_type=requirement'"
                                           target="_blank"
                                           class="btn btn-sm btn-outline-info"
                                           t-att-title="k.requirement_document_name">
                                            <i class="fa fa-paperclip"/>
                                        </a>
                                    </div>
                                    <div t-if="k.requirement_document_name" class="small text-muted text-truncate" style="max-width: 220px"
                                         t-esc="k.requirement_document_name"/>
                                </td>
                                <td>
                                    <div class="d-flex gap-1 align-items-center">
                                        <input type="file" class="form-control form-control-sm"
                                               accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
                                               t-on-change="(ev) => this.uploadDoc(k.id, 'updates', ev)"
                                               style="font-size: 0.75rem"/>
                                        <a t-if="k.has_updates_document"
                                           t-att-href="'/kpi_completion_cert/download_doc?kpi_id=' + k.id + '&amp;doc_type=updates'"
                                           target="_blank"
                                           class="btn btn-sm btn-outline-info"
                                           t-att-title="k.updates_document_name">
                                            <i class="fa fa-paperclip"/>
                                        </a>
                                    </div>
                                    <div t-if="k.updates_document_name" class="small text-muted text-truncate" style="max-width: 220px"
                                         t-esc="k.updates_document_name"/>
                                </td>
                                <td>
                                    <select class="form-select form-select-sm"
                                            t-model="state.certVersions[k.id]"
                                            style="min-width: 90px">
                                        <option value="V01">V01</option>
                                        <option value="V02">V02</option>
                                        <option value="V03">V03</option>
                                        <option value="Final">Final</option>
                                    </select>
                                </td>
                                <td>
                                    <div class="d-flex gap-1 align-items-center">
                                        <input type="file" accept=".pdf,.png,.jpg,.jpeg"
                                               class="form-control form-control-sm"
                                               t-on-change="(ev) => this.uploadSignedCert(k.id, ev)"
                                               style="font-size: 0.75rem"/>
                                        <a t-if="k.has_signed_certificate"
                                           t-att-href="'/kpi_completion_cert/download_doc?kpi_id=' + k.id + '&amp;doc_type=signed'"
                                           target="_blank"
                                           class="btn btn-sm btn-outline-info"
                                           t-att-title="k.signed_certificate_name">
                                            <i class="fa fa-paperclip"/>
                                        </a>
                                    </div>
                                    <div t-if="k.has_signed_certificate" class="small text-success">
                                        <i class="fa fa-check-circle"/> Signed
                                        <t t-if="k.signed_certificate_date"> on <t t-esc="k.signed_certificate_date"/></t>
                                    </div>
                                    <div t-else="" class="small text-warning">
                                        <i class="fa fa-exclamation-triangle"/> Awaiting signature
                                    </div>
                                </td>
                                <td>
                                    <span class="badge"
                                          t-att-class="k.task_state === 'completed' ? 'bg-success' : 'bg-warning text-dark'"
                                          t-esc="k.task_state"/>
                                </td>
                                <td>
                                    <button class="btn btn-sm btn-outline-success"
                                            t-on-click="() => this.downloadCertificate(k.id)">
                                        <i class="fa fa-download me-1"/> Certificate
                                    </button>
                                </td>
                            </tr>
                        </t>
                    </tbody>
                </table>
            </div>
        </div>
    `;

    setup() {
        const today = new Date();
        const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        this.state = useState({
            filters: {
                client_kra_id: '',
                from_date: fmt(firstOfMonth),
                to_date: fmt(today),
                state: 'completed',
            },
            clients: [],         // is_client KRAs (for the filter dropdown)
            allRootKras: [],     // ALL root KRAs (for Quick Create)
            subKras: [],         // sub-KRAs of the selected root (Quick Create)
            allUsers: [],        // active internal users (for assignee + role pickers)
            kpis: [],
            certVersions: {},    // {kpi_id: 'V01' | 'V02' | ...} — defaults to V01 on load
            showQuickCreate: false,
            newTask: {
                client_kra_id: '',
                sub_kra_id: '',
                task_name: '',
                requirement_version: '',
                estimate_hours: 0,
                estimate_minutes: 0,
                primary_user_id: '',
                file_data: '',
                file_name: '',
            },
        });
        onWillStart(async () => {
            const r = await rpc('/kpi_client_invoice/get_filters', {});
            if (r && r.status) this.state.clients = r.clients || [];
            // For Quick Create: need ALL root KRAs (not just is_client ones) — fetch via filter endpoint
            // and also via the broader list. We'll just use is_client clients as the dropdown for now,
            // since user said root = client.
            this.state.allRootKras = (r && r.clients ? r.clients : []).map(c => ({
                id: c.id, name: c.parent_name ? c.parent_name + ' > ' + c.name : c.name
            }));
            const ru = await rpc('/kpi_completion_cert/get_users', {});
            if (ru && ru.status) this.state.allUsers = ru.users || [];
            await this.loadList();
        });
    }

    async onNewTaskClientChange() {
        this.state.newTask.sub_kra_id = '';
        this.state.subKras = [];
        if (!this.state.newTask.client_kra_id) return;
        const r = await rpc('/kpi_completion_cert/get_sub_kras', {
            client_kra_id: this.state.newTask.client_kra_id,
        });
        if (r && r.status) this.state.subKras = r.kras || [];
    }

    onNewTaskFileSelected(ev) {
        const file = ev.target.files && ev.target.files[0];
        if (!file) {
            this.state.newTask.file_data = '';
            this.state.newTask.file_name = '';
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result || '';
            const idx = dataUrl.indexOf(',');
            this.state.newTask.file_data = idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
            this.state.newTask.file_name = file.name;
        };
        reader.readAsDataURL(file);
    }

    async quickCreateTask() {
        const nt = this.state.newTask;
        if (!nt.client_kra_id || !nt.sub_kra_id || !nt.task_name) {
            alert('Please select client, project, and enter a task name.');
            return;
        }
        const r = await rpc('/kpi_completion_cert/create_task_from_doc', {
            client_kra_id: nt.client_kra_id,
            sub_kra_id: nt.sub_kra_id,
            task_name: nt.task_name,
            requirement_version: nt.requirement_version,
            estimate_hours: nt.estimate_hours,
            estimate_minutes: nt.estimate_minutes,
            primary_user_id: nt.primary_user_id,
            file_data: nt.file_data,
            file_name: nt.file_name,
        });
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        alert(`Task created: ${r.name} (id=${r.kpi_id})`);
        // Reset form + reload list
        this.state.newTask = {
            client_kra_id: '', sub_kra_id: '', task_name: '',
            requirement_version: '', estimate_hours: 0, estimate_minutes: 0,
            primary_user_id: '', file_data: '', file_name: '',
        };
        this.state.subKras = [];
        await this.loadList();
    }

    async loadList() {
        const r = await rpc('/kpi_completion_cert/list', this.state.filters);
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        this.state.kpis = r.kpis || [];
        // Default cert version to V01 for any KPI we haven't seen yet
        for (const k of this.state.kpis) {
            if (!this.state.certVersions[k.id]) {
                this.state.certVersions[k.id] = 'V01';
            }
        }
    }

    async saveVersion(kpiId, value) {
        await rpc('/kpi_completion_cert/set_version', { kpi_id: kpiId, delivery_version: value });
    }

    async saveReqVersion(kpiId, value) {
        await rpc('/kpi_completion_cert/upload_doc', {
            kpi_id: kpiId,
            doc_type: 'requirement',
            requirement_version: value,
        });
    }

    async uploadSignedCert(kpiId, ev) {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
            const dataUrl = reader.result || '';
            const idx = dataUrl.indexOf(',');
            const b64 = idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
            const today = new Date().toISOString().slice(0, 10);
            const r = await rpc('/kpi_completion_cert/upload_signed', {
                kpi_id: kpiId,
                file_data: b64,
                file_name: file.name,
                signed_date: today,
            });
            if (!r.status) { alert('Upload failed: ' + (r.message || 'unknown')); return; }
            const k = this.state.kpis.find(x => x.id === kpiId);
            if (k) {
                k.has_signed_certificate = r.has_signed_certificate;
                k.signed_certificate_name = r.signed_certificate_name;
                k.signed_certificate_date = r.signed_certificate_date;
            }
            ev.target.value = '';
        };
        reader.readAsDataURL(file);
    }

    async uploadDoc(kpiId, docType, ev) {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
            // strip the "data:...;base64," prefix
            const dataUrl = reader.result || '';
            const idx = dataUrl.indexOf(',');
            const b64 = idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
            const r = await rpc('/kpi_completion_cert/upload_doc', {
                kpi_id: kpiId,
                doc_type: docType,
                file_data: b64,
                file_name: file.name,
            });
            if (!r.status) { alert('Upload failed: ' + (r.message || 'unknown')); return; }
            // Refresh the row data
            const k = this.state.kpis.find(x => x.id === kpiId);
            if (k) {
                k.requirement_document_name = r.requirement_document_name;
                k.has_requirement_document = r.has_requirement_document;
                k.updates_document_name = r.updates_document_name;
                k.has_updates_document = r.has_updates_document;
            }
            ev.target.value = '';  // clear file input
        };
        reader.readAsDataURL(file);
    }

    async downloadCertificate(kpiId) {
        const r = await rpc('/kpi_completion_cert/pdf_data', { kpi_id: kpiId });
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        const d = r.data;
        const certVer = this.state.certVersions[kpiId] || 'V01';
        if (!window.jspdf) { alert('jsPDF not loaded.'); return; }
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: 'pt', format: 'a4' });
        const pageW = doc.internal.pageSize.getWidth();
        let y = 40;

        // Top: logo (left) + company name (right)
        if (d.company_logo_b64) {
            try {
                doc.addImage('data:image/png;base64,' + d.company_logo_b64, 'PNG', 40, y, 60, 60);
            } catch (e) {}
        }
        doc.setFontSize(18);
        doc.setFont(undefined, 'bold');
        doc.text(d.company_name || '', pageW - 40, y + 25, { align: 'right' });
        doc.setFontSize(11);
        doc.setFont(undefined, 'normal');
        doc.text('Service Provider', pageW - 40, y + 45, { align: 'right' });
        y += 90;

        // Title with version stamp
        doc.setFontSize(22);
        doc.setFont(undefined, 'bold');
        doc.text('COMPLETION CERTIFICATE', pageW / 2, y, { align: 'center' });
        y += 24;
        doc.setFontSize(13);
        doc.setTextColor(80, 80, 200);
        doc.text(`(Certificate Version: ${certVer})`, pageW / 2, y, { align: 'center' });
        doc.setTextColor(0);
        y += 14;
        doc.setLineWidth(0.5);
        doc.line(40, y, pageW - 40, y);
        y += 20;

        // Client + project
        doc.setFontSize(11);
        doc.setFont(undefined, 'bold');
        doc.text('Issued To (Client):', 40, y);
        doc.setFont(undefined, 'normal');
        doc.text(d.client_name || '—', 200, y);
        y += 18;
        if (d.project_name) {
            doc.setFont(undefined, 'bold');
            doc.text('Project:', 40, y);
            doc.setFont(undefined, 'normal');
            doc.text(d.project_name, 200, y);
            y += 18;
        }
        const k = d.kpi;
        doc.setFont(undefined, 'bold');
        doc.text('Task / Requirement:', 40, y);
        doc.setFont(undefined, 'normal');
        doc.text(k.name || '', 200, y);
        y += 18;
        if (k.delivery_version) {
            doc.setFont(undefined, 'bold');
            doc.text('Delivery Version:', 40, y);
            doc.setFont(undefined, 'normal');
            doc.text(k.delivery_version, 200, y);
            y += 18;
        }
        doc.setFont(undefined, 'bold');
        doc.text('Priority:', 40, y);
        doc.setFont(undefined, 'normal');
        doc.text((k.priority || '').toUpperCase(), 200, y);
        doc.setFont(undefined, 'bold');
        doc.text('State:', pageW / 2 + 20, y);
        doc.setFont(undefined, 'normal');
        doc.text((k.task_state || '').toUpperCase(), pageW / 2 + 90, y);
        y += 24;

        // Requirement description block
        if (k.description) {
            doc.setFont(undefined, 'bold');
            doc.text('Requirement Details:', 40, y);
            y += 14;
            doc.setFont(undefined, 'normal');
            const descLines = doc.splitTextToSize(k.description, pageW - 80);
            doc.text(descLines, 40, y);
            y += descLines.length * 13 + 8;
        }

        // Dates block
        doc.setFont(undefined, 'bold');
        doc.text('Timeline:', 40, y);
        y += 14;
        doc.setFont(undefined, 'normal');
        const dateRows = [
            ['Assigned / Started:', k.assigned_date],
            ['Deadline:', k.deadline || '—'],
            ['Completion Date:', k.completion_date || '—'],
            ['Approval Date:', k.approval_date || '—'],
        ];
        for (const [label, val] of dateRows) {
            doc.text(label, 40, y);
            doc.text(val || '—', 200, y);
            y += 14;
        }
        y += 8;

        // Time breakdown
        doc.setFont(undefined, 'bold');
        doc.text('Effort / Developer Time:', 40, y);
        y += 14;
        doc.setFont(undefined, 'normal');
        doc.text(`Estimated:  ${(k.estimate_hours || 0).toFixed(2)} h`, 40, y);
        doc.text(`Actual Total:  ${(k.actual_hours || 0).toFixed(2)} h`, pageW / 2, y);
        y += 16;

        // Role breakdown table (only roles with hours > 0)
        if (doc.autoTable && d.role_totals) {
            const roleRows = d.role_totals
                .filter(r => (r.hours || 0) > 0)
                .map(r => [r.label, (r.hours || 0).toFixed(2) + ' h']);
            if (roleRows.length) {
                doc.setFont(undefined, 'bold');
                doc.text('Time by Role:', 40, y); y += 6;
                doc.setFont(undefined, 'normal');
                doc.autoTable({
                    startY: y,
                    head: [['Role', 'Hours']],
                    body: roleRows,
                    styles: { fontSize: 10 },
                    headStyles: { fillColor: [76, 130, 175] },
                    margin: { left: 40, right: 40 },
                });
                y = doc.lastAutoTable.finalY + 12;
            }
        }

        // Per-contributor table (developer + role + hours)
        if (doc.autoTable && d.contributors && d.contributors.length) {
            doc.setFont(undefined, 'bold');
            doc.text('Contributors:', 40, y); y += 6;
            doc.setFont(undefined, 'normal');
            const roleLabel = {
                developer: 'Developer', tester: 'Tester',
                coordinator: 'Coordinator', lead: 'Lead'
            };
            doc.autoTable({
                startY: y,
                head: [['Name', 'Role', 'Hours']],
                body: d.contributors.map(c => [
                    c.name,
                    roleLabel[c.role] || c.role || '—',
                    (c.hours || 0).toFixed(2) + ' h'
                ]),
                styles: { fontSize: 10 },
                headStyles: { fillColor: [108, 117, 125] },
                margin: { left: 40, right: 40 },
            });
            y = doc.lastAutoTable.finalY + 16;
        }

        // Source documents reference
        if (k.has_requirement_document || k.has_updates_document) {
            doc.setFont(undefined, 'bold');
            doc.text('Source Documents:', 40, y);
            y += 14;
            doc.setFont(undefined, 'normal');
            if (k.has_requirement_document) {
                const reqLabel = k.requirement_version
                    ? `Requirement (${k.requirement_version}):`
                    : 'Requirement:';
                doc.text(`• ${reqLabel} ${k.requirement_document_name}`, 50, y);
                y += 14;
            }
            if (k.has_updates_document) {
                doc.text(`• Updates & Errors: ${k.updates_document_name}`, 50, y);
                y += 14;
            }
            y += 8;
        }

        // Certification paragraph
        doc.setFontSize(11);
        doc.setFont(undefined, 'normal');
        const cert = `This certifies that the above task has been completed and delivered by ${d.company_name || '(provider)'} to ${d.client_name || '(client)'}. The work was carried out by the developer(s) listed above. The total developer time recorded for this task is ${(k.actual_hours || 0).toFixed(2)} hours. This is certificate version ${certVer}.`;
        const certLines = doc.splitTextToSize(cert, pageW - 80);
        doc.text(certLines, 40, y);
        y += certLines.length * 13 + 24;

        // Signature lines
        if (y > 720) { doc.addPage(); y = 40; }
        doc.setFont(undefined, 'bold');
        doc.text('Signatures', 40, y);
        y += 30;

        const colW = (pageW - 80) / 2;
        // Left: Developer / Provider
        doc.line(40, y, 40 + colW - 20, y);
        doc.text('For ' + (d.company_name || 'Service Provider'), 40, y + 14);
        doc.setFont(undefined, 'normal');
        doc.text(`Date: __________________`, 40, y + 30);
        if (k.approved_by) {
            doc.text(`(Approved by: ${k.approved_by})`, 40, y + 46);
        }

        // Right: Client
        doc.setFont(undefined, 'bold');
        doc.line(40 + colW + 20, y, pageW - 40, y);
        doc.text('Client: ' + (d.client_name || ''), 40 + colW + 20, y + 14);
        doc.setFont(undefined, 'normal');
        doc.text(`Date: __________________`, 40 + colW + 20, y + 30);

        // Footer
        doc.setFontSize(9);
        doc.setTextColor(120);
        doc.text(`Generated on ${new Date().toISOString().slice(0, 10)} — KPI ID #${k.id}`, pageW / 2, doc.internal.pageSize.getHeight() - 20, { align: 'center' });

        const safeName = (k.name || `KPI_${k.id}`).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
        doc.save(`Completion_Certificate_${certVer}_${safeName}.pdf`);
    }
}

registry.category("actions").add("kpi_completion_certificate", KpiCompletionCertificate);
