/** @odoo-module **/
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

const TEMPLATE = xml/* xml */`
<div class="o_kpi_requirements_upload p-4">

    <!-- Header -->
    <div class="d-flex justify-content-between align-items-center mb-4">
        <h2 class="fw-bold">
            <t t-if="docType === 'requirement'">
                <i class="fa fa-file-text-o me-2 text-primary"/> Upload Requirements
            </t>
            <t t-elif="docType === 'update'">
                <i class="fa fa-refresh me-2 text-warning"/> Upload Updates &amp; Amendments
            </t>
            <t t-else="">
                <i class="fa fa-bug me-2 text-danger"/> Upload Bug Reports
            </t>
        </h2>
        <a class="btn btn-outline-secondary btn-sm"
           t-att-href="templateUrl()" target="_blank">
            <i class="fa fa-download me-1"/> Download Blank Template
        </a>
    </div>

    <!-- Step 1: Pick destination -->
    <div class="card p-3 mb-3 shadow-sm">
        <h5 class="fw-bold mb-3"><i class="fa fa-folder-open me-2 text-info"/> 1. Destination</h5>
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
            <div class="col-md-4">
                <label class="form-label fw-bold">Project / Sub-KRA</label>
                <select class="form-select" t-model="state.sub_kra_id">
                    <option value="">-- Select Project --</option>
                    <t t-foreach="state.subKras" t-as="s" t-key="s.id">
                        <option t-att-value="s.id" t-esc="s.display"/>
                    </t>
                </select>
            </div>
            <div class="col-md-4">
                <label class="form-label fw-bold">Version (optional)</label>
                <input type="text" class="form-control"
                       placeholder="v1.0"
                       t-model="state.requirement_version"/>
            </div>
        </div>
    </div>

    <!-- Step 2: Source — file (attached to every task) + optional task-list import -->
    <div class="card p-3 mb-3 shadow-sm">
        <h5 class="fw-bold mb-3">
            <i class="fa fa-upload me-2 text-success"/>
            2. Source &amp; Bulk Import
        </h5>
        <div class="row g-3">
            <div class="col-md-4">
                <label class="form-label fw-bold">Source Document
                    <span class="text-muted small">(attached to every created task)</span>
                </label>
                <input type="file" class="form-control"
                       accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
                       t-on-change="onSourceFileSelected"/>
                <div t-if="state.file_name" class="small text-success mt-1">
                    <i class="fa fa-check"/> <t t-esc="state.file_name"/>
                </div>
            </div>
            <div class="col-md-4">
                <label class="form-label fw-bold">Import Task List
                    <span class="text-muted small">(XLSX / CSV — auto-parses into rows)</span>
                </label>
                <input type="file" class="form-control"
                       accept=".xlsx,.xls,.csv,.txt"
                       t-on-change="onImportFileSelected"/>
                <div t-if="state.import_status" class="small mt-1" t-esc="state.import_status"/>
            </div>
            <div class="col-md-4">
                <label class="form-label fw-bold">Or Paste Doc Text
                    <span class="text-muted small">(for AI task suggestions)</span>
                </label>
                <textarea class="form-control" rows="3"
                          placeholder="Paste requirement/update/bug text..."
                          t-model="state.paste_text"/>
            </div>
        </div>
    </div>

    <!-- Step 3: Editable per-task table -->
    <div class="card p-3 mb-3 shadow-sm">
        <div class="d-flex justify-content-between align-items-center mb-3">
            <h5 class="fw-bold mb-0">
                <i class="fa fa-list me-2 text-primary"/>
                3. Tasks <span class="text-muted small">(each task has its own time + developer)</span>
            </h5>
            <div class="btn-group">
                <button class="btn btn-outline-primary btn-sm"
                        t-on-click="suggestTasks"
                        t-att-disabled="state.suggesting">
                    <i class="fa fa-magic me-1"/>
                    <t t-if="state.suggesting">Analyzing...</t>
                    <t t-else="">Suggest Tasks (AI)</t>
                </button>
                <button class="btn btn-outline-success btn-sm" t-on-click="addRow">
                    <i class="fa fa-plus me-1"/> Add Row
                </button>
            </div>
        </div>

        <div t-if="state.suggestionSource" class="small text-muted mb-2">
            <i class="fa fa-info-circle"/>
            Source:
            <span t-att-class="state.suggestionSource === 'ai' ? 'badge bg-success' : 'badge bg-secondary'"
                  t-esc="state.suggestionSource === 'ai' ? 'AI (Claude)' : (state.suggestionSource || 'Manual')"/>
            <t t-if="state.suggestionMessage">— <t t-esc="state.suggestionMessage"/></t>
        </div>

        <div t-if="state.tasks.length === 0" class="text-center text-muted py-4">
            <i class="fa fa-list fa-2x mb-2 d-block"/>
            No tasks yet. Add a row, import an XLSX/CSV, or click "Suggest Tasks (AI)".
        </div>

        <table t-if="state.tasks.length > 0" class="table table-sm align-middle">
            <thead class="table-light">
                <tr>
                    <th style="width: 30px">#</th>
                    <th style="width: 100px">Ref ID</th>
                    <th t-if="docType !== 'requirement'" style="width: 110px">Linked Req</th>
                    <th>Task Name</th>
                    <!-- Hours/Min/Priority/Developer are admin/manager-only fields.
                         Clients submit and admin sets allocation during review. -->
                    <th t-if="!state.isClientOnly" style="width: 70px">Hours</th>
                    <th t-if="!state.isClientOnly" style="width: 70px">Min</th>
                    <th t-if="!state.isClientOnly" style="width: 110px">Priority</th>
                    <th t-if="!state.isClientOnly" style="width: 160px">Developer</th>
                    <th style="width: 40px">&#160;</th>
                </tr>
            </thead>
            <tbody>
                <t t-foreach="state.tasks" t-as="t" t-key="t_index">
                    <tr>
                        <td class="text-muted" t-esc="t_index + 1"/>
                        <td>
                            <input type="text" class="form-control form-control-sm bg-light text-muted"
                                   readonly="readonly"
                                   tabindex="-1"
                                   t-att-value="previewRef(t_index)"
                                   title="Auto-assigned at create time. Final number may shift if other users add tasks first."/>
                        </td>
                        <td t-if="docType !== 'requirement'">
                            <input type="text" class="form-control form-control-sm"
                                   t-model="t.related_req_ref"
                                   placeholder="REQ-001"/>
                        </td>
                        <td>
                            <input type="text" class="form-control form-control-sm"
                                   t-model="t.name"
                                   placeholder="Task name"/>
                        </td>
                        <td t-if="!state.isClientOnly">
                            <input type="number" min="0" class="form-control form-control-sm"
                                   t-model.number="t.estimate_hours"/>
                        </td>
                        <td t-if="!state.isClientOnly">
                            <input type="number" min="0" max="59" class="form-control form-control-sm"
                                   t-model.number="t.estimate_minutes"/>
                        </td>
                        <td t-if="!state.isClientOnly">
                            <select class="form-select form-select-sm" t-model="t.priority">
                                <option value="urgent">Urgent</option>
                                <option value="important">Important</option>
                                <option value="regular">Regular</option>
                            </select>
                        </td>
                        <td t-if="!state.isClientOnly">
                            <select class="form-select form-select-sm" t-model="t.primary_user_id">
                                <option value="">-- None --</option>
                                <t t-foreach="state.users" t-as="u" t-key="u.id">
                                    <option t-att-value="u.id" t-esc="u.name"/>
                                </t>
                            </select>
                        </td>
                        <td>
                            <button class="btn btn-sm btn-outline-danger"
                                    t-on-click="() => this.removeRow(t_index)"
                                    title="Remove row">
                                <i class="fa fa-times"/>
                            </button>
                        </td>
                    </tr>
                </t>
            </tbody>
        </table>
    </div>

    <!-- Step 4: Defaults for NEW rows (and AI/import suggestions) — ADMIN/MANAGER ONLY -->
    <div t-if="!state.isClientOnly" class="card p-3 mb-3 shadow-sm">
        <h5 class="fw-bold mb-3">
            <i class="fa fa-cog me-2 text-secondary"/>
            4. Defaults for new rows
            <span class="text-muted small">(applied when adding rows or importing — each row is still editable above)</span>
        </h5>
        <div class="row g-3">
            <div class="col-md-3">
                <label class="form-label fw-bold">Default Hours</label>
                <input type="number" min="0" class="form-control" t-model.number="state.def_hours"/>
            </div>
            <div class="col-md-3">
                <label class="form-label fw-bold">Default Minutes</label>
                <input type="number" min="0" max="59" class="form-control" t-model.number="state.def_minutes"/>
            </div>
            <div class="col-md-3">
                <label class="form-label fw-bold">Default Priority</label>
                <select class="form-select" t-model="state.def_priority">
                    <option value="urgent">Urgent</option>
                    <option value="important">Important</option>
                    <option value="regular">Regular</option>
                </select>
            </div>
            <div class="col-md-3">
                <label class="form-label fw-bold">Default Developer</label>
                <select class="form-select" t-model="state.def_user_id">
                    <option value="">-- None --</option>
                    <t t-foreach="state.users" t-as="u" t-key="u.id">
                        <option t-att-value="u.id" t-esc="u.name"/>
                    </t>
                </select>
            </div>
        </div>
    </div>

    <!-- Step 5: Create -->
    <div class="d-flex justify-content-end gap-2">
        <button class="btn btn-secondary" t-on-click="resetForm">
            <i class="fa fa-times me-1"/> Reset
        </button>
        <button class="btn btn-success btn-lg" t-on-click="createAllTasks">
            <i class="fa fa-plus-circle me-1"/> Create All Tasks
            <span t-if="state.tasks.length > 0" class="badge bg-light text-dark ms-2"
                  t-esc="state.tasks.length"/>
        </button>
    </div>

    <div t-if="state.lastCreated" class="alert alert-success mt-3">
        <i class="fa fa-check-circle me-2"/>
        Successfully created <strong t-esc="state.lastCreated"/> task(s).
    </div>
</div>
`;

class _BaseUpload extends Component {
    static template = TEMPLATE;
    get docType() { return 'requirement'; }
    templateUrl() {
        const map = { requirement: 'requirement', update: 'update', bug: 'bug_report' };
        return `/kpi_completion_cert/template/${map[this.docType] || 'requirement'}`;
    }
    setup() {
        this.state = useState({
            client_kra_id: '',
            sub_kra_id: '',
            requirement_version: '',
            clients: [],
            subKras: [],
            users: [],
            isClientOnly: false,
            file_data: '',
            file_name: '',
            paste_text: '',
            tasks: [],               // editable array of {name, estimate_hours, estimate_minutes, priority, primary_user_id}
            def_hours: 0,
            def_minutes: 0,
            def_priority: 'regular',
            def_user_id: '',
            suggesting: false,
            suggestionSource: '',
            suggestionMessage: '',
            import_status: '',
            lastCreated: 0,
            refPrefix: 'REQ',     // overwritten by /kpi_requirements/peek_next_ref
            refNextNum: 1,        // overwritten by /kpi_requirements/peek_next_ref
        });
        onWillStart(async () => {
            // Detect role so we hide developer/time/priority fields from clients
            const info = await rpc('/kpi_user/info', {});
            if (info && info.status) {
                this.state.isClientOnly = !!info.is_client_only;
            }
            const rc = await rpc('/kpi_client_invoice/get_filters', {});
            if (rc && rc.status) this.state.clients = rc.clients || [];
            // Users dropdown is only relevant for admins; clients don't see it
            if (!this.state.isClientOnly) {
                const ru = await rpc('/kpi_completion_cert/get_users', {});
                if (ru && ru.status) this.state.users = ru.users || [];
            }
            // Server-controlled REQ/UPT/BUG sequence — fetch once at load so the UI
            // can show what ref each row WILL become.  Final number is re-derived
            // at create-time on the server.
            try {
                const rp = await rpc('/kpi_requirements/peek_next_ref', { doc_type: this.docType });
                if (rp && rp.status) {
                    this.state.refPrefix = rp.prefix || 'REQ';
                    this.state.refNextNum = rp.next_number || 1;
                }
            } catch (_) { /* leave defaults */ }
        });
    }
    // Display the auto-assigned ref for the row at this index in the current list.
    previewRef(idx) {
        const n = (this.state.refNextNum || 1) + idx;
        return `${this.state.refPrefix || 'REQ'}-${String(n).padStart(3, '0')}`;
    }
    async onClientChange() {
        this.state.sub_kra_id = '';
        this.state.subKras = [];
        if (!this.state.client_kra_id) return;
        const r = await rpc('/kpi_completion_cert/get_sub_kras', {
            client_kra_id: this.state.client_kra_id,
        });
        if (r && r.status) this.state.subKras = r.kras || [];
    }
    _newRow(name, external_ref, related_req_ref) {
        return {
            name: name || '',
            external_ref: external_ref || '',
            related_req_ref: related_req_ref || '',
            estimate_hours: this.state.def_hours || 0,
            estimate_minutes: this.state.def_minutes || 0,
            priority: this.state.def_priority || 'regular',
            primary_user_id: this.state.def_user_id || '',
        };
    }
    addRow() {
        this.state.tasks.push(this._newRow(''));
    }
    removeRow(idx) {
        this.state.tasks.splice(idx, 1);
    }
    _mergeTasks(items) {
        // Merge incoming items (from parser or AI). Each can be a string (just a name) or
        // an object {name, external_ref, related_req_ref}. Dedup by ref-id or name.
        const seenRef = new Set(this.state.tasks.map(t => (t.external_ref || '').toLowerCase()).filter(Boolean));
        const seenName = new Set(this.state.tasks.map(t => (t.name || '').toLowerCase()));
        for (const it of items) {
            const item = (typeof it === 'string') ? { name: it } : it;
            const name = (item.name || '').trim();
            const ref = (item.external_ref || '').trim();
            if (!name) continue;
            // Dedup by ref-id (preferred) or by name
            if (ref && seenRef.has(ref.toLowerCase())) continue;
            if (!ref && seenName.has(name.toLowerCase())) continue;
            if (ref) seenRef.add(ref.toLowerCase());
            seenName.add(name.toLowerCase());
            this.state.tasks.push(this._newRow(name, ref, item.related_req_ref));
        }
    }
    onSourceFileSelected(ev) {
        const file = ev.target.files && ev.target.files[0];
        if (!file) {
            this.state.file_data = '';
            this.state.file_name = '';
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result || '';
            const idx = dataUrl.indexOf(',');
            this.state.file_data = idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
            this.state.file_name = file.name;
        };
        reader.readAsDataURL(file);
    }
    onImportFileSelected(ev) {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
            const dataUrl = reader.result || '';
            const idx = dataUrl.indexOf(',');
            const b64 = idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
            this.state.import_status = 'Parsing ' + file.name + '...';
            const r = await rpc('/kpi_requirements/parse_file', {
                file_data: b64,
                file_name: file.name,
                doc_type: this.docType,
            });
            if (!r.status) {
                this.state.import_status = '❌ ' + (r.message || 'parse failed');
                alert('Parse failed: ' + (r.message || 'unknown'));
                return;
            }
            const before = this.state.tasks.length;
            this._mergeTasks(r.tasks || []);
            const added = this.state.tasks.length - before;
            this.state.import_status =
                `✓ Imported ${added} task(s) from ${r.source || 'file'} ` +
                (r.matched_column ? `(column: "${r.matched_column}")` : '');
            ev.target.value = '';
        };
        reader.readAsDataURL(file);
    }
    async suggestTasks() {
        const text = (this.state.paste_text || '').trim();
        if (!text) {
            alert('Paste document text in the right-side textarea first.');
            return;
        }
        this.state.suggesting = true;
        try {
            const r = await rpc('/kpi_requirements/suggest_tasks', {
                text: text, doc_type: this.docType,
            });
            if (!r.status) {
                alert('Error: ' + (r.message || 'unknown'));
                return;
            }
            const before = this.state.tasks.length;
            this._mergeTasks(r.tasks || []);
            this.state.suggestionSource = r.source || '';
            this.state.suggestionMessage = r.message || '';
        } finally {
            this.state.suggesting = false;
        }
    }
    async createAllTasks() {
        if (!this.state.client_kra_id || !this.state.sub_kra_id) {
            alert('Pick a Client and Project first.');
            return;
        }
        const tasks = this.state.tasks
            .filter(t => (t.name || '').trim())
            .map(t => ({
                name: (t.name || '').trim(),
                external_ref: (t.external_ref || '').trim(),
                related_req_ref: (t.related_req_ref || '').trim(),
                estimate_hours: t.estimate_hours || 0,
                estimate_minutes: t.estimate_minutes || 0,
                priority: t.priority || 'regular',
                primary_user_id: t.primary_user_id || false,
            }));
        if (!tasks.length) {
            alert('Add at least one task row.');
            return;
        }
        const r = await rpc('/kpi_requirements/create_bulk_tasks', {
            sub_kra_id: this.state.sub_kra_id,
            doc_type: this.docType,
            tasks: tasks,
            file_data: this.state.file_data,
            file_name: this.state.file_name,
            requirement_version: this.state.requirement_version,
        });
        if (!r.status) {
            alert('Error: ' + (r.message || 'unknown'));
            return;
        }
        this.state.lastCreated = r.created_count || 0;
        // Keep destination, clear task table + source
        this.state.tasks = [];
        this.state.paste_text = '';
        this.state.file_data = '';
        this.state.file_name = '';
        this.state.import_status = '';
        // Refresh the next-ref preview so a follow-up batch starts at the right number
        try {
            const rp = await rpc('/kpi_requirements/peek_next_ref', { doc_type: this.docType });
            if (rp && rp.status) {
                this.state.refPrefix = rp.prefix || 'REQ';
                this.state.refNextNum = rp.next_number || 1;
            }
        } catch (_) { /* ignore */ }
    }
    resetForm() {
        this.state.client_kra_id = '';
        this.state.sub_kra_id = '';
        this.state.subKras = [];
        this.state.requirement_version = '';
        this.state.tasks = [];
        this.state.paste_text = '';
        this.state.file_data = '';
        this.state.file_name = '';
        this.state.def_hours = 0;
        this.state.def_minutes = 0;
        this.state.def_priority = 'regular';
        this.state.def_user_id = '';
        this.state.suggestionSource = '';
        this.state.suggestionMessage = '';
        this.state.import_status = '';
        this.state.lastCreated = 0;
    }
}

export class KpiUploadRequirements extends _BaseUpload {
    get docType() { return 'requirement'; }
}
export class KpiUploadUpdates extends _BaseUpload {
    get docType() { return 'update'; }
}
export class KpiUploadBugReports extends _BaseUpload {
    get docType() { return 'bug'; }
}

registry.category("actions").add("kpi_upload_requirements", KpiUploadRequirements);
registry.category("actions").add("kpi_upload_updates", KpiUploadUpdates);
registry.category("actions").add("kpi_upload_bug_reports", KpiUploadBugReports);
