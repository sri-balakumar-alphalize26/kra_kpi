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

    <!-- Step 3b: Photos / video — hidden behind ONE button. Every role gets it. -->
    <div class="card p-3 mb-3 shadow-sm">
        <button t-if="!state.mediaOpen" class="btn btn-outline-primary w-100 py-2"
                style="border-style:dashed" t-on-click="() => state.mediaOpen = true">
            <i class="fa fa-paperclip me-2"/> Add photos / video
        </button>

        <t t-if="state.mediaOpen">
            <div class="d-flex justify-content-between align-items-center mb-3">
                <h5 class="fw-bold mb-0"><i class="fa fa-paperclip me-2 text-primary"/> Photos / video</h5>
                <button class="btn btn-sm btn-light" t-on-click="() => state.mediaOpen = false">
                    <i class="fa fa-chevron-up"/>
                </button>
            </div>

            <div t-if="namedRows.length === 0" class="text-muted small">
                Type a task name above first — attachments are added to a task.
            </div>

            <t t-if="namedRows.length > 0">
                <div class="row g-3">
                    <!-- Which task (by the name typed above) -->
                    <div class="col-md-5">
                        <label class="form-label small fw-bold">Which task? <span class="text-danger">*</span></label>
                        <select class="form-select form-select-sm" t-model.number="state.mediaRow">
                            <option value="">— select a task —</option>
                            <t t-foreach="namedRows" t-as="r" t-key="r.i">
                                <option t-att-value="r.i" t-esc="'#' + (r.i + 1) + '  ' + r.name"/>
                            </t>
                        </select>
                    </div>

                    <!-- Photo is the default; video is the exception -->
                    <div class="col-md-3">
                        <label class="form-label small fw-bold">Type</label>
                        <div class="btn-group w-100">
                            <button class="btn btn-sm"
                                    t-att-class="state.mediaKind === 'image' ? 'btn-primary' : 'btn-outline-secondary'"
                                    t-on-click="() => this.setMediaKind('image')">
                                <i class="fa fa-image me-1"/> Photo
                            </button>
                            <button class="btn btn-sm"
                                    t-att-class="state.mediaKind === 'video' ? 'btn-danger' : 'btn-outline-secondary'"
                                    t-on-click="() => this.setMediaKind('video')">
                                <i class="fa fa-video-camera me-1"/> Video
                            </button>
                        </div>
                    </div>

                    <div class="col-md-4">
                        <label class="form-label small fw-bold">
                            <t t-esc="state.mediaKind === 'video' ? 'Choose a video' : 'Choose photo'"/>
                        </label>
                        <input type="file" class="form-control form-control-sm"
                               t-att-accept="state.mediaKind === 'video' ? 'video/*' : 'image/*'"
                               t-on-change="(ev) => this.onMediaFile(ev)"/>
                    </div>

                    <div t-if="state.mediaKind === 'video'" class="col-12">
                        <div class="alert alert-danger py-2 px-3 mb-0 small d-flex align-items-start">
                            <i class="fa fa-exclamation-triangle me-2 mt-1"/>
                            <div>
                                Only upload a video if it's <strong>really needed</strong> — a photo is usually
                                enough, and videos are slow to upload. Limit:
                                <strong t-esc="this.humanSize(this.maxVideoBytes)"/>.
                            </div>
                        </div>
                    </div>

                    <!-- Preview (the web can show the real thing) -->
                    <div t-if="state.mediaPicked" class="col-12 d-flex align-items-center gap-3">
                        <img t-if="state.mediaPicked.preview" t-att-src="state.mediaPicked.preview"
                             style="height:64px;width:64px;object-fit:cover;border-radius:8px;border:1px solid #dee2e6"/>
                        <div t-else="" class="d-flex align-items-center justify-content-center"
                             style="height:64px;width:64px;border-radius:8px;background:#f1f5fb">
                            <i class="fa fa-video-camera fa-2x text-muted"/>
                        </div>
                        <div class="small">
                            <div class="fw-bold" t-esc="state.mediaPicked.name"/>
                            <div class="text-muted" t-esc="this.humanSize(state.mediaPicked.size)"/>
                        </div>
                    </div>

                    <!-- Mandatory: an attachment with no explanation is noise -->
                    <div class="col-12">
                        <label class="form-label small fw-bold">Reason <span class="text-danger">*</span></label>
                        <input type="text" class="form-control form-control-sm"
                               placeholder="Why are you attaching this?"
                               t-model="state.mediaReason"/>
                    </div>

                    <div class="col-12">
                        <button class="btn btn-sm btn-primary" t-att-disabled="!mediaReady"
                                t-on-click="addAttachment">
                            <i class="fa fa-plus me-1"/> Add attachment
                        </button>
                        <span t-if="!mediaReady" class="text-muted small ms-2">
                            Pick a task, choose a file, and give a reason.
                        </span>
                    </div>
                </div>
            </t>

            <!-- Queued / uploading -->
            <div t-if="state.attachments.length" class="mt-3">
                <t t-foreach="state.attachments" t-as="a" t-key="a_index">
                    <div class="d-flex align-items-center gap-2 py-2 border-top">
                        <i t-att-class="a.kind === 'video' ? 'fa fa-video-camera text-primary' : 'fa fa-image text-primary'"/>
                        <div class="flex-grow-1 small">
                            <div>
                                <span class="fw-bold" t-esc="a.name"/>
                                <span class="text-muted"> · <t t-esc="this.humanSize(a.size)"/></span>
                                <span t-if="state.tasks[a.rowIndex]" class="text-muted">
                                    →  <t t-esc="state.tasks[a.rowIndex].name"/>
                                </span>
                            </div>
                            <div class="text-muted" t-esc="a.reason"/>
                            <div t-if="a.status === 'uploading'" class="progress mt-1" style="height:5px">
                                <div class="progress-bar" t-attf-style="width: {{a.pct}}%"/>
                            </div>
                            <div t-if="a.status === 'uploading'" class="text-primary fw-bold" style="font-size:11px">
                                <t t-esc="this.humanSize(a.size)"/> · <t t-esc="a.pct"/>%
                            </div>
                            <div t-if="a.status === 'failed'" class="text-danger fw-bold" style="font-size:11px">Upload failed</div>
                        </div>
                        <i t-if="a.status === 'done'" class="fa fa-check-circle text-success"/>
                        <button t-if="a.status === 'idle'" class="btn btn-sm btn-link text-muted p-0"
                                t-on-click="() => this.removeAttachment(a_index)">
                            <i class="fa fa-times-circle"/>
                        </button>
                    </div>
                </t>
                <button t-if="state.attachments.some(x => x.status === 'failed')"
                        class="btn btn-sm btn-outline-danger mt-2" t-att-disabled="state.uploading"
                        t-on-click="retryFailedUploads">
                    <i class="fa fa-refresh me-1"/> Retry failed uploads
                </button>
            </div>
        </t>
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
            // ---- Photos / video (mirrors the mobile app) --------------------
            // Hidden behind one button. Each attachment belongs to ONE task row
            // (picked by the task name typed above) and MUST carry a reason.
            // Files are attached AFTER the tasks exist, via kpi.user.manual.
            mediaOpen: false,
            mediaKind: 'image',      // 'image' | 'video' — photo is the default
            mediaRow: null,          // index of the task row it belongs to
            mediaReason: '',
            mediaPicked: null,       // {data, name, size, kind, preview}
            attachments: [],         // [{rowIndex, kind, data, name, size, reason, status, pct}]
            uploading: false,
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
    // ---- Photos / video ----------------------------------------------------
    // Same rules as the mobile app: photo is the default, video is capped, and
    // a reason is mandatory. Files ride the EXISTING /kpi/manual/upload route.

    // Only NAMED rows can be attached to — the name is what identifies the task.
    get namedRows() {
        return this.state.tasks
            .map((t, i) => ({ i, name: (t.name || '').trim() }))
            .filter(r => r.name);
    }
    get maxVideoBytes() { return 10 * 1024 * 1024; }
    humanSize(b) {
        b = Number(b) || 0;
        if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
        if (b >= 1024) return Math.round(b / 1024) + ' KB';
        return b + ' B';
    }
    // Reason is mandatory, and it must belong to a task.
    get mediaReady() {
        return !!this.state.mediaPicked
            && this.state.mediaRow !== null
            && (this.state.mediaReason || '').trim().length > 0;
    }
    setMediaKind(kind) {
        this.state.mediaKind = kind;
        this.state.mediaPicked = null;   // a picked photo isn't a video
    }
    async onMediaFile(ev) {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        const isVideo = this.state.mediaKind === 'video';
        // Refuse at PICK time, never mid-upload.
        if (isVideo && file.size > this.maxVideoBytes) {
            alert(`That video is ${this.humanSize(file.size)} — the limit is ${this.humanSize(this.maxVideoBytes)}.\n\nRecord a shorter clip, or use a photo instead.`);
            ev.target.value = '';
            return;
        }
        const dataUrl = await new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.onerror = reject;
            fr.readAsDataURL(file);
        });
        this.state.mediaPicked = {
            data: String(dataUrl).split(',')[1] || '',   // strip the data: prefix
            name: file.name,
            size: file.size,
            kind: this.state.mediaKind,
            // The web can show a real preview — the app can't do this cheaply.
            preview: isVideo ? '' : dataUrl,
        };
        ev.target.value = '';
    }
    addAttachment() {
        if (!this.mediaReady) return;
        const p = this.state.mediaPicked;
        this.state.attachments.push({
            rowIndex: this.state.mediaRow,
            kind: p.kind, data: p.data, name: p.name, size: p.size,
            preview: p.preview,
            reason: this.state.mediaReason.trim(),
            status: 'idle', pct: 0, kpiId: null,
        });
        this.state.mediaPicked = null;
        this.state.mediaReason = '';
    }
    removeAttachment(i) { this.state.attachments.splice(i, 1); }

    // Upload ONE file with a live %.
    //
    // Hand-rolled XHR rather than rpc(): the module notes at
    // /kpi/progress/upload_file that "base64-in-JSON can't" show progress — true
    // of OWL's rpc() helper, which exposes no progress hook. XHR does, so we get
    // a real bar on the existing JSON route without a multipart endpoint.
    _uploadManual(att, onPct) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/kpi/manual/upload', true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.upload.onprogress = (e) => {
                // e.total is the BASE64 body (~+33% of the file) — use it, or the
                // bar stalls around 75%.
                if (e.lengthComputable && onPct) onPct(Math.min(100, Math.round((e.loaded / e.total) * 100)));
            };
            xhr.onload = () => {
                try {
                    const body = JSON.parse(xhr.responseText || '{}');
                    const r = body.result;
                    if (body.error) return reject(new Error(body.error.data?.message || 'Upload failed'));
                    if (!r || r.status === false) return reject(new Error(r?.message || 'Upload failed'));
                    resolve(r);
                } catch (e) { reject(e); }
            };
            xhr.onerror = () => reject(new Error('Network error'));
            xhr.send(JSON.stringify({
                jsonrpc: '2.0', method: 'call',
                params: {
                    kpi_id: att.kpiId,
                    file_data: att.data,
                    file_name: att.name,
                    description: att.reason,
                    related_links: '',
                },
            }));
        });
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

        // ---- Attachments -----------------------------------------------------
        // The tasks exist now, so each file can be hung off its kpi_id. Uploaded
        // ONE AT A TIME so the % means something. The tasks are NEVER rolled back:
        // a failed photo must not cost the user everything they typed.
        const ids = r.kpi_ids || [];
        const failedNames = [];
        if (this.state.attachments.length && ids.length) {
            // `tasks` above is the FILTERED list actually sent, so kpi_ids[n] lines
            // up with it. Map each attachment's ORIGINAL row index onto that.
            const namedIdx = new Map();
            let k = 0;
            this.state.tasks.forEach((t, i) => { if ((t.name || '').trim()) namedIdx.set(i, k++); });

            this.state.uploading = true;
            for (const att of this.state.attachments) {
                const sent = namedIdx.get(att.rowIndex);
                att.kpiId = sent != null ? (ids[sent] || null) : null;
                if (!att.kpiId) { att.status = 'failed'; failedNames.push(att.name); continue; }
                att.status = 'uploading'; att.pct = 0;
                try {
                    await this._uploadManual(att, (pct) => { att.pct = pct; });
                    att.status = 'done'; att.pct = 100;
                } catch (e) {
                    att.status = 'failed';
                    failedNames.push(att.name);
                }
            }
            this.state.uploading = false;
        }

        // Keep destination, clear task table + source
        this.state.tasks = [];
        this.state.paste_text = '';
        this.state.file_data = '';
        this.state.file_name = '';
        this.state.import_status = '';

        if (failedNames.length) {
            // Keep ONLY the failures (they already carry their kpiId) so Retry
            // re-sends just those — the tasks are gone from the form, so a retry
            // can never duplicate them.
            this.state.attachments = this.state.attachments.filter(a => a.status === 'failed');
            alert(`Your ${r.created_count} task(s) were created.\n\nBut these files did not upload:\n\n${failedNames.map(n => '•  ' + n).join('\n')}\n\nUse "Retry failed uploads" to send them again.`);
        } else {
            this.state.attachments = [];
            this.state.mediaOpen = false;
        }
        // Refresh the next-ref preview so a follow-up batch starts at the right number
        try {
            const rp = await rpc('/kpi_requirements/peek_next_ref', { doc_type: this.docType });
            if (rp && rp.status) {
                this.state.refPrefix = rp.prefix || 'REQ';
                this.state.refNextNum = rp.next_number || 1;
            }
        } catch (_) { /* ignore */ }
    }
    // Re-send only the failures. The tasks already exist and the form is cleared,
    // so this attaches to the stored kpiId — it can never duplicate a task.
    async retryFailedUploads() {
        this.state.uploading = true;
        const stillFailed = [];
        for (const att of this.state.attachments) {
            if (att.status === 'done' || !att.kpiId) continue;
            att.status = 'uploading'; att.pct = 0;
            try {
                await this._uploadManual(att, (pct) => { att.pct = pct; });
                att.status = 'done'; att.pct = 100;
            } catch (e) {
                att.status = 'failed';
                stillFailed.push(att.name);
            }
        }
        this.state.uploading = false;
        if (stillFailed.length) {
            this.state.attachments = this.state.attachments.filter(a => a.status === 'failed');
            alert('Still could not upload:\n\n' + stillFailed.map(n => '•  ' + n).join('\n'));
        } else {
            this.state.attachments = [];
            this.state.mediaOpen = false;
            alert('All files uploaded.');
        }
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
