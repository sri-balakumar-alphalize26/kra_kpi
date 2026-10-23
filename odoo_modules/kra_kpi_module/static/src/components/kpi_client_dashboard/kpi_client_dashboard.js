/** @odoo-module **/
import { Component, xml, useState, onWillStart, onWillUnmount } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

// Same cap as /kpi_client_portal/add_task.
const MAX_ATTACH_BYTES = 25 * 1024 * 1024;

export class KpiClientDashboard extends Component {
    static template = xml/* xml */`
    <div class="o_kpi_client_dashboard p-4">
        <div t-if="state.dlg.open" class="modal d-block" tabindex="-1" style="background: rgba(0,0,0,0.5); z-index:2000;">
            <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content">
                    <div t-att-class="'modal-header ' + (state.dlg.okClass === 'btn-danger' ? 'bg-danger text-white' : 'bg-primary text-white')">
                        <h5 class="modal-title" t-esc="state.dlg.title"/>
                        <button type="button" class="btn-close btn-close-white" t-on-click="dlgCancel"/>
                    </div>
                    <div class="modal-body">
                        <p t-if="state.dlg.message" style="white-space:pre-wrap;" t-esc="state.dlg.message"/>
                        <div t-if="state.dlg.input" class="mb-2">
                            <label class="form-label fw-bold">
                                <t t-esc="state.dlg.inputLabel"/>
                                <span t-if="state.dlg.required" class="text-danger">*</span>
                            </label>
                            <textarea class="form-control" rows="3"
                                      t-att-placeholder="state.dlg.placeholder"
                                      t-att-value="state.dlg.value"
                                      t-on-input="(ev) => this.dlgSet(ev.target.value)"/>
                        </div>
                        <div t-if="state.dlg.error" class="alert alert-danger py-2 mb-0 small" t-esc="state.dlg.error"/>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" t-on-click="dlgCancel">Cancel</button>
                        <button type="button" t-att-class="'btn ' + state.dlg.okClass"
                                t-on-click="dlgOk" t-esc="state.dlg.okLabel"/>
                    </div>
                </div>
            </div>
        </div>

        <div t-if="state.toast.show"
             t-att-class="'alert alert-dismissible d-flex align-items-start gap-2 alert-' + state.toast.kind"
             style="position:sticky; top:0; z-index:1080; white-space:pre-wrap;">
            <i t-att-class="'fa mt-1 ' + (state.toast.kind === 'success' ? 'fa-check-circle' : (state.toast.kind === 'danger' ? 'fa-exclamation-circle' : 'fa-info-circle'))"/>
            <div class="flex-grow-1" t-esc="state.toast.text"/>
            <button type="button" class="btn-close" t-on-click="dismissToast"/>
        </div>


        <!-- Header -->
        <div class="d-flex justify-content-between align-items-center mb-4">
            <h2 class="fw-bold">
                <i class="fa fa-th-large me-2 text-primary"/> My Dashboard
                <span t-if="state.dashboard and state.dashboard.clients.length"
                      class="text-muted small ms-2">
                    (<t t-esc="state.dashboard.clients.map(c => c.name).join(', ')"/>)
                </span>
            </h2>
            <div>
                <button class="btn btn-success me-2" t-on-click="() => state.showAdd = !state.showAdd">
                    <i class="fa fa-plus me-1"/>
                    <t t-if="state.showAdd">Cancel</t>
                    <t t-else="">New Task</t>
                </button>
                <button class="btn btn-outline-primary" t-on-click="refresh">
                    <i class="fa fa-refresh me-1"/> Refresh
                </button>
            </div>
        </div>

        <!-- Not authorized -->
        <div t-if="state.dashboard and !state.dashboard.authorized" class="alert alert-warning">
            <i class="fa fa-exclamation-triangle me-2"/>
            <t t-esc="state.dashboard.message"/>
        </div>

        <t t-if="state.dashboard and state.dashboard.authorized">

            <!-- What a client can also do from WhatsApp: the same pages, opened from here
                 (controllers/kpi_client_links.py). Fix and the database forms need the
                 client's WhatsApp group, so they show only when there is one. -->
            <div t-if="state.links" class="d-flex flex-wrap gap-2 mb-3">
                <button t-if="state.links.declined.length" class="btn btn-outline-danger btn-sm"
                        t-on-click="() => this.togglePanel('fix')">
                    🔧 Fix a declined request <span class="badge bg-danger ms-1" t-esc="state.links.declined.length"/>
                </button>
                <button t-if="state.links.has_group" class="btn btn-outline-primary btn-sm"
                        t-on-click="() => this.openDbForm('newdb')">🗄️ New Database</button>
                <button t-if="state.links.can_destroy" class="btn btn-outline-primary btn-sm"
                        t-on-click="() => this.openDbForm('dbdisconnect')">💥 Destroy a Database</button>
                <button class="btn btn-outline-primary btn-sm" t-on-click="() => this.togglePanel('dbs')">
                    📋 Live Databases <span class="badge bg-secondary ms-1" t-esc="state.links.live_dbs.length"/>
                </button>
                <button class="btn btn-outline-primary btn-sm" t-on-click="() => this.openChat()">💬 Chat with the team</button>
            </div>
            <div t-if="state.links and state.panel === 'fix'" class="card p-3 mb-3 border-danger">
                <h6 class="fw-bold mb-2">🔧 Declined requests: fix one and send it again</h6>
                <div t-foreach="state.links.declined" t-as="d" t-key="d.id" class="d-flex align-items-start gap-2 py-2 border-top">
                    <div class="flex-grow-1">
                        <b class="text-primary me-1" t-esc="d.ref"/><t t-esc="d.name"/>
                        <div t-if="d.reason" class="small text-muted" style="white-space:pre-wrap">Reason: <t t-esc="d.reason"/></div>
                    </div>
                    <a class="btn btn-sm btn-danger" t-att-href="d.url" target="_blank" rel="noopener">Fix</a>
                </div>
            </div>
            <div t-if="state.links and state.panel === 'dbs'" class="card p-3 mb-3">
                <h6 class="fw-bold mb-2">📋 Your live databases</h6>
                <div t-if="!state.links.live_dbs.length" class="text-muted small">No live databases yet.</div>
                <div t-foreach="state.links.live_dbs" t-as="d" t-key="d.id" class="py-2 border-top">
                    <b t-esc="d.name"/><span t-if="d.label and d.label !== d.name" class="text-muted ms-1" t-esc="'· ' + d.label"/>
                    <div class="small text-muted">
                        🖥️ <t t-esc="d.server or '—'"/>
                        <t t-if="d.created"> · 📅 <t t-esc="d.created"/></t>
                        <t t-if="d.expires"> · ⏳ expires <t t-esc="d.expires"/></t>
                    </div>
                </div>
            </div>

            <!-- Add Task card (collapsible) -->
            <div t-if="state.showAdd" class="card p-3 mb-4 shadow-sm border-success">
                <h5 class="fw-bold mb-3"><i class="fa fa-plus-circle me-2 text-success"/> Submit a New Task</h5>
                <div class="row g-3">
                    <div class="col-md-3">
                        <label class="form-label fw-bold">Type</label>
                        <select class="form-select" t-att-value="state.newTask.kind" t-on-change="onKindChange">
                            <option value="requirement">Requirement</option>
                            <option value="update">Update / Amendment</option>
                            <option value="bug">Bug</option>
                        </select>
                    </div>
                    <div class="col-md-6">
                        <label class="form-label fw-bold">Project</label>
                        <select class="form-select" t-att-value="state.newTask.sub_kra_id" t-on-change="onProjectChange">
                            <option value="">-- Select Project --</option>
                            <t t-foreach="state.projects" t-as="p" t-key="p.id">
                                <option t-att-value="p.id" t-esc="p.display"/>
                            </t>
                        </select>
                    </div>
                    <div class="col-md-3">
                        <label class="form-label fw-bold">Priority</label>
                        <select class="form-select" t-model="state.newTask.priority">
                            <option value="urgent">Urgent</option>
                            <option value="important">Important</option>
                            <option value="regular">Regular</option>
                        </select>
                    </div>
                    <!-- Bug / Update: always about ONE requirement, numbered under it
                         (BUG001-REQ-012); the server refuses one without it. -->
                    <div class="col-12" t-if="state.newTask.kind !== 'requirement'">
                        <t t-if="!state.newTask.legacy_on">
                        <label class="form-label fw-bold">Which requirement is it about? <span class="text-danger">*</span></label>
                        <select class="form-select" t-att-value="state.newTask.parent_id" t-on-change="onParentChange"
                                t-att-disabled="!state.newTask.sub_kra_id or !state.parents.length">
                            <option value="" t-esc="!state.newTask.sub_kra_id ? '-- Select the project first --'
                                : (state.parentsLoading ? 'Loading…'
                                : (state.parents.length ? '-- Select the requirement --' : 'No requirements in this project yet'))"/>
                            <t t-foreach="state.parents" t-as="pt" t-key="pt.id">
                                <option t-att-value="pt.id"
                                        t-esc="pt.ref + ' — ' + pt.name + (pt.old ? ' · Old DB' : '') + (pt.date ? ' (' + pt.date + ')' : '')"/>
                            </t>
                        </select>
                        <!-- The bugs / updates already raised under it, and this one's ref. -->
                        <div t-if="state.kids" class="card p-2 mt-2 bg-light small">
                            <t t-if="state.kids.loading">Checking earlier ones…</t>
                            <t t-else="">
                                <div class="fw-bold" t-esc="state.kids.items.length
                                    ? (state.newTask.kind === 'bug' ? '🐞' : '🔧') + ' Already raised under ' + state.kids.parent + ':'
                                    : 'No ' + (state.newTask.kind === 'bug' ? 'bugs' : 'updates') + ' under ' + state.kids.parent + ' yet.'"/>
                                <div t-foreach="state.kids.items" t-as="kd" t-key="kd.ref">
                                    <b class="text-primary me-1" t-esc="kd.ref"/><t t-esc="kd.name"/>
                                    <span class="text-muted"> · <t t-esc="kd.status"/><t t-if="kd.date"> · <t t-esc="kd.date"/></t></span>
                                </div>
                                <div t-if="state.kids.next_ref" class="fw-bold mt-1">➜ This one will be <t t-esc="state.kids.next_ref"/></div>
                            </t>
                        </div>
                        </t>
                        <!-- 🗄️ Not in the list: say what it is about instead (same as the web portal / WhatsApp form). -->
                        <label class="d-flex align-items-center gap-2 fw-bold mt-2" style="cursor:pointer">
                            <input type="checkbox" class="form-check-input m-0" t-att-checked="state.newTask.legacy_on" t-on-change="onLegacyToggle"/>
                            <span>🗄️ It's from the old system — not in this list</span>
                        </label>
                        <div t-if="state.newTask.legacy_on" class="card p-3 mt-2 border-warning" style="background:#FFF8E6">
                            <div class="small text-muted mb-2">Best: a 📷 photo or 🎥 video of the old screen (add it under Attachments below). If not possible, record a voice note or type a message.</div>
                            <div class="row g-2">
                                <div class="col-md-4">
                                    <label class="form-label fw-bold">Request ID (optional)</label>
                                    <input type="text" class="form-control" placeholder="REQ-012" t-model="state.newTask.legacy_ref"/>
                                </div>
                                <div class="col-md-8">
                                    <label class="form-label fw-bold">Task name (optional)</label>
                                    <input type="text" class="form-control" placeholder="Its name in the old system" t-model="state.newTask.legacy_name"/>
                                </div>
                                <div class="col-12">
                                    <label class="form-label fw-bold">Message</label>
                                    <textarea class="form-control" rows="2" t-model="state.newTask.legacy_note"
                                              placeholder="Which screen, what it does today, what is wrong or should change"/>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div t-att-class="state.newTask.kind === 'requirement' ? 'col-md-9' : 'col-12'">
                        <label class="form-label fw-bold">Task Name <span class="text-danger">*</span></label>
                        <input type="text" class="form-control" t-model="state.newTask.name"
                               placeholder="What needs to be done?"/>
                    </div>
                    <!-- What is being built. Separate from the Type above. Requirement
                         only: a Bug / Update takes its requirement's (server side). -->
                    <div class="col-md-3" t-if="state.newTask.kind === 'requirement'">
                        <label class="form-label fw-bold">Type (Module / App / EXE / Other) <span class="text-danger">*</span></label>
                        <select class="form-select" t-model="state.newTask.deliverable_type">
                            <option value="">— choose —</option>
                            <option value="module">Module</option>
                            <option value="app">App</option>
                            <option value="exe">EXE</option>
                            <option value="other">Other</option>
                        </select>
                        <!-- Other: say what it is (required) -->
                        <input t-if="state.newTask.deliverable_type === 'other'" type="text" class="form-control mt-2"
                               maxlength="40" placeholder="What is it? e.g. Plugin, Website"
                               t-model="state.newTask.deliverable_other"/>
                    </div>
                    <div class="col-12">
                        <label class="form-label fw-bold">Description</label>
                        <textarea class="form-control" rows="3" t-model="state.newTask.description"
                                  placeholder="Details, acceptance criteria, links..."/>
                    </div>
                    <!-- Photos, videos, voice notes and files (25 MB in total). -->
                    <div class="col-12">
                        <label class="form-label fw-bold">Attachments (optional)</label>
                        <div class="d-flex flex-wrap gap-2 align-items-center">
                            <label class="btn btn-outline-primary btn-sm mb-0">📷 Photo
                                <input type="file" accept="image/*" capture="environment" class="d-none" t-on-change="onAddFiles"/></label>
                            <label class="btn btn-outline-primary btn-sm mb-0">🎥 Video
                                <input type="file" accept="video/*" capture="environment" class="d-none" t-on-change="onAddFiles"/></label>
                            <button type="button" t-att-class="'btn btn-sm ' + (state.rec ? 'btn-danger' : 'btn-outline-primary')" t-on-click="onVoice">
                                <t t-if="state.rec">⏹ Stop and attach (<t t-esc="state.rec.secs"/>s)</t><t t-else="">🎤 Voice note</t>
                            </button>
                            <label class="btn btn-outline-secondary btn-sm mb-0">📎 Files
                                <input type="file" multiple="multiple" class="d-none" t-on-change="onAddFiles"/></label>
                            <span class="small text-muted" t-esc="state.files.length ? state.files.length + ' file(s) · ' + fmtSize(filesTotal()) : 'up to 25 MB in total'"/>
                        </div>
                        <div t-if="state.files.length" class="d-flex flex-wrap gap-2 mt-2">
                            <t t-foreach="state.files" t-as="f" t-key="f_index">
                                <span class="badge text-bg-light border d-inline-flex align-items-center gap-1 fw-normal">
                                    <t t-esc="f.name"/> · <t t-esc="fmtSize(f.size)"/>
                                    <a href="#" class="text-danger ms-1" t-on-click.prevent="() => this.removeFile(f_index)">✕</a>
                                </span>
                            </t>
                        </div>
                    </div>
                    <div class="col-12 text-end">
                        <button class="btn btn-success" t-on-click="submitNewTask">
                            <i class="fa fa-paper-plane me-1"/> Submit Task
                        </button>
                    </div>
                </div>
            </div>

            <!-- Project + User filter (narrows pending-approvals + My-Tasks list) -->
            <div class="card p-2 mb-3 shadow-sm bg-light">
                <div class="row g-2 align-items-center">
                    <div t-if="state.projects.length > 1" class="col-auto fw-bold small text-muted">
                        <i class="fa fa-filter me-1"/> Project:
                    </div>
                    <div t-if="state.projects.length > 1" class="col-md-4">
                        <select class="form-select form-select-sm" t-model="state.projectFilter">
                            <option value="">All projects</option>
                            <t t-foreach="state.projects" t-as="p" t-key="p.id">
                                <option t-att-value="p.id" t-esc="p.display"/>
                            </t>
                        </select>
                    </div>
                    <div t-if="state.projectFilter" class="col-auto">
                        <button class="btn btn-sm btn-outline-secondary"
                                t-on-click="() => { state.projectFilter = ''; }">
                            <i class="fa fa-times me-1"/> Clear
                        </button>
                    </div>
                </div>
                <!-- Total-duration summary across the current filter scope -->
                <div t-if="filterSummary.show" class="mt-2 small">
                    <span class="badge bg-primary me-2">
                        <i class="fa fa-list me-1"/>
                        <t t-esc="filterSummary.taskCount"/> task(s)
                    </span>
                    <span t-if="state.projectFilter" class="badge bg-info">
                        Project: <t t-esc="this.projectLabel(state.projectFilter)"/>
                    </span>
                </div>
            </div>

            <!-- Three tabs: Pending / In Progress / Completed (same buckets as the app) -->
            <div class="row g-2 mb-3">
                <t t-foreach="statusChips" t-as="chip" t-key="chip.key">
                    <div class="col">
                        <button class="card p-3 w-100 border-0 text-center"
                                t-att-class="state.tab === chip.key ? 'bg-primary text-white' : 'bg-light'"
                                t-on-click="() => (state.tab = chip.key)">
                            <div class="small" t-esc="chip.label"/>
                            <div class="fs-4 fw-bold" t-esc="tabCount(chip.key)"/>
                        </button>
                    </div>
                </t>
            </div>

            <!-- Per-type breakdown (Requirements / Updates / Bugs) -->
            <div class="row g-3 mb-3" t-if="state.dashboard">
                <div class="col-md-4">
                    <div class="card p-3 shadow-sm border-primary border-start border-4">
                        <div class="d-flex justify-content-between align-items-center">
                            <div>
                                <div class="text-muted small">Requirements</div>
                                <div class="fs-3 fw-bold" t-esc="byType.requirement.total"/>
                            </div>
                            <div class="text-end">
                                <div class="small">
                                    <span class="badge bg-success">
                                        <i class="fa fa-check"/> <t t-esc="byType.requirement.done"/>
                                    </span>
                                    <span class="badge bg-warning text-dark ms-1">
                                        <i class="fa fa-clock-o"/> <t t-esc="byType.requirement.open"/>
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="col-md-4">
                    <div class="card p-3 shadow-sm border-warning border-start border-4">
                        <div class="d-flex justify-content-between align-items-center">
                            <div>
                                <div class="text-muted small">Updates / Amendments</div>
                                <div class="fs-3 fw-bold" t-esc="byType.update.total"/>
                            </div>
                            <div class="text-end">
                                <div class="small">
                                    <span class="badge bg-success">
                                        <i class="fa fa-check"/> <t t-esc="byType.update.done"/>
                                    </span>
                                    <span class="badge bg-warning text-dark ms-1">
                                        <i class="fa fa-clock-o"/> <t t-esc="byType.update.open"/>
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="col-md-4">
                    <div class="card p-3 shadow-sm border-danger border-start border-4">
                        <div class="d-flex justify-content-between align-items-center">
                            <div>
                                <div class="text-muted small">Bugs</div>
                                <div class="fs-3 fw-bold" t-esc="byType.bug.total"/>
                            </div>
                            <div class="text-end">
                                <div class="small">
                                    <span class="badge bg-success">
                                        <i class="fa fa-check"/> <t t-esc="byType.bug.done"/>
                                    </span>
                                    <span class="badge bg-warning text-dark ms-1">
                                        <i class="fa fa-clock-o"/> <t t-esc="byType.bug.open"/>
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Pending Approvals (call-out) -->
            <div t-if="filteredPending.length > 0"
                 class="card mb-3 shadow-sm border-warning border-3 overflow-hidden">
                <!-- Header is the toggle, and the body only renders when open. With one
                     client sitting on 132 pending, rendering every row inline made the
                     card ~6000px tall and pushed the task list and invoices off screen.
                     Same shape as kpi_pending_queue's date/client groups. -->
                <div class="d-flex align-items-center gap-2 p-3 user-select-none"
                     style="cursor:pointer" t-on-click="() => this.togglePending()">
                    <i t-att-class="state.pendingOpen ? 'fa fa-chevron-down text-warning' : 'fa fa-chevron-right text-warning'"/>
                    <i class="fa fa-bell text-warning"/>
                    <span class="fw-bold text-warning">
                        <t t-esc="filteredPending.length"/> task(s) need your approval
                    </span>
                    <span t-if="state.projectFilter" class="badge bg-info">
                        Project: <t t-esc="this.projectLabel(state.projectFilter)"/>
                    </span>
                    <span class="ms-auto badge bg-light text-warning border" t-esc="filteredPending.length"/>
                </div>
                <!-- Bounded and scrolled internally, so the list can never grow the page. -->
                <div t-if="state.pendingOpen" class="px-3 pb-3" style="max-height:420px; overflow-y:auto;">
                <table class="table table-sm align-middle mb-0">
                    <thead class="table-light">
                        <tr>
                            <th>Ref</th><th>Task</th><th>Project</th><th>Submitted</th><th>&#160;</th>
                        </tr>
                    </thead>
                    <tbody>
                        <t t-foreach="filteredPending" t-as="p" t-key="p.id">
                            <tr>
                                <td><span class="badge bg-secondary" t-esc="p.external_ref or '—'"/></td>
                                <td class="fw-bold" t-esc="p.name"/>
                                <td t-esc="p.project_name"/>
                                <td t-esc="p.completion_date"/>
                                <td>
                                    <button class="btn btn-sm btn-warning"
                                            t-on-click="() => this.openApproval(p.id)">
                                        <i class="fa fa-check me-1"/> Review &amp; Sign
                                    </button>
                                </td>
                            </tr>
                        </t>
                    </tbody>
                </table>
                </div>
            </div>

            <!-- All Tasks table -->
            <div class="card p-3 shadow-sm">
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <h5 class="fw-bold mb-0">
                        <i class="fa fa-list me-2 text-info"/> Requests
                        <span class="text-muted small"><t t-if="state.projectFilter">(project: <t t-esc="this.projectLabel(state.projectFilter)"/>)</t></span>
                    </h5>
                    <div class="small text-muted">
                        Showing <strong t-esc="filteredKpis.length"/> task(s)
                    </div>
                </div>
                <div t-if="filteredKpis.length === 0" class="text-center text-muted p-4">
                    <i class="fa fa-inbox fa-3x mb-2 d-block"/>
                    No tasks match this filter.
                </div>
                <table t-if="filteredKpis.length > 0" class="table table-sm table-hover align-middle">
                    <thead class="table-light">
                        <tr>
                            <th style="width: 70px">Kind</th>
                            <th style="width: 90px">Ref</th>
                            <th>Task</th>
                            <th>Project</th>
                            <th style="width: 130px">State</th>
                            <th style="width: 110px">Deadline</th>
                            <th style="width: 90px">Cert</th>
                            <th style="width: 100px">&#160;</th>
                        </tr>
                    </thead>
                    <tbody>
                        <t t-foreach="filteredKpis" t-as="k" t-key="k.id">
                            <tr>
                                <td>
                                    <span class="badge"
                                          t-att-class="k.kind === 'bug' ? 'bg-danger' : (k.kind === 'update' ? 'bg-warning text-dark' : 'bg-primary')"
                                          t-esc="k.kind"/>
                                </td>
                                <td>
                                    <span class="badge bg-secondary" t-esc="k.external_ref or '—'"/>
                                    <span t-if="k.related_req_ref" class="badge bg-light text-dark ms-1">
                                        →<t t-esc="k.related_req_ref"/>
                                    </span>
                                    <span t-if="k.legacy_req_link" class="badge bg-secondary ms-1"
                                          title="About a requirement from the old database">🗄️ Old DB</span>
                                    <span t-if="k.legacy_req_link and k.legacy_status !== 'confirmed'"
                                          class="badge bg-warning text-dark ms-1" title="Pending — confirm with client">Pending</span>
                                </td>
                                <td class="fw-bold">
                                    <div t-esc="k.name"/>
                                    <!-- The client's own list showed a bare title: the summary
                                         payload never carried the description, so the only place
                                         they ever saw what a task was for was the approval
                                         modal at sign-off time. Clamped to two lines; the
                                         title attribute holds the full text. -->
                                    <div t-if="k.description" class="text-muted small fw-normal"
                                         style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;"
                                         t-att-title="k.description"
                                         t-esc="k.description"/>
                                </td>
                                <td t-esc="k.project_name"/>
                                <td>
                                    <span class="badge" t-att-class="this.stateBadge(k.task_state)" t-esc="k.task_state"/>
                                </td>
                                <td t-esc="k.deadline or '—'"/>
                                <td>
                                    <a t-if="k.has_signed_certificate"
                                       t-att-href="'/kpi_client_portal/download_cert?kpi_id=' + k.id"
                                       target="_blank" class="btn btn-sm btn-outline-info">
                                        <i class="fa fa-paperclip"/>
                                    </a>
                                    <span t-else="" class="text-muted small">—</span>
                                </td>
                                <td>
                                    <!-- Must mirror the server gate in
                                         /kpi_client_approval/approve. This used to offer
                                         Sign for any 'partially_completed' row, including
                                         work no admin had QA-approved — the one affordance
                                         that let a client sign off unchecked work. -->
                                    <button t-if="k.task_state === 'awaiting_client'"
                                            class="btn btn-sm btn-warning"
                                            t-on-click="() => this.openApproval(k.id)">
                                        <i class="fa fa-check"/> Sign
                                    </button>
                                </td>
                            </tr>
                        </t>
                    </tbody>
                </table>
            </div>

            <!-- Invoices link -->
            <div t-if="state.dashboard.invoice_count > 0" class="card p-3 mt-3 shadow-sm bg-light">
                <div class="d-flex justify-content-between align-items-center">
                    <div>
                        <i class="fa fa-file-text-o me-2"/>
                        You have <strong t-esc="state.dashboard.invoice_count"/> finalized invoice(s).
                    </div>
                    <span class="text-muted small">Open "Client Portal → My Invoices" from the menu</span>
                </div>
            </div>
        </t>

        <!-- Approval modal -->
        <div t-if="state.approval.open" class="modal d-block" tabindex="-1" style="background: rgba(0,0,0,0.5);">
            <div class="modal-dialog modal-lg">
                <div class="modal-content" t-if="state.approval.data">
                    <div class="modal-header">
                        <h5 class="modal-title">
                            <i class="fa fa-certificate me-2"/> Review &amp; Sign
                        </h5>
                        <button type="button" class="btn-close" t-on-click="closeApproval"/>
                    </div>
                    <div class="modal-body">
                        <div class="mb-3">
                            <strong>Task:</strong> <t t-esc="state.approval.data.kpi.name"/><br/>
                            <strong>Client:</strong> <t t-esc="state.approval.data.client_name"/><br/>
                            <strong>Project:</strong> <t t-esc="state.approval.data.project_name"/><br/>
                            <strong>Submitted on:</strong> <t t-esc="state.approval.data.kpi.completion_date"/>
                        </div>
                        <div t-if="state.approval.data.kpi.description" class="border rounded p-2 bg-light mb-3 small">
                            <t t-esc="state.approval.data.kpi.description"/>
                        </div>

                        <h6 class="fw-bold">Confirmation Checklist</h6>
                        <div class="form-check">
                            <input class="form-check-input" type="checkbox" id="chkdel"
                                   t-model="state.approval.chk_delivered"/>
                            <label class="form-check-label" for="chkdel">
                                I confirm the task has been delivered as specified.
                            </label>
                        </div>
                        <div class="form-check">
                            <input class="form-check-input" type="checkbox" id="chkworks"
                                   t-model="state.approval.chk_works"/>
                            <label class="form-check-label" for="chkworks">
                                The functionality works as expected.
                            </label>
                        </div>
                        <div class="form-check mb-3">
                            <input class="form-check-input" type="checkbox" id="chkauth"
                                   t-model="state.approval.chk_authorized"/>
                            <label class="form-check-label" for="chkauth">
                                I authorize this task as complete.
                            </label>
                        </div>

                        <div class="mb-3">
                            <label class="form-label fw-bold">Notes (optional)</label>
                            <textarea class="form-control" rows="2" t-model="state.approval.notes"/>
                        </div>
                        <!-- Saved signature image → use it, nothing to type. -->
                        <div t-if="state.hasSignature" class="mb-3">
                            <label class="form-label fw-bold">
                                <i class="fa fa-check-circle text-success me-1"/>
                                Your signature (auto-loaded)
                            </label>
                            <div class="border rounded p-2 bg-white text-center">
                                <img t-att-src="'data:image/png;base64,' + state.signatureB64"
                                     style="max-height: 90px; max-width: 100%"
                                     alt="Saved signature"/>
                            </div>
                        </div>
                        <!-- No image → the normal flow: type the name. -->
                        <div t-else="" class="mb-3">
                            <label class="form-label fw-bold">Type your full name as digital signature <span class="text-danger">*</span></label>
                            <input type="text" class="form-control form-control-lg"
                                   style="font-family: cursive"
                                   t-model="state.approval.signature_text"
                                   placeholder="Your full name"/>
                        </div>
                    </div>
                    <!-- Send back with proof: what is still wrong, plus photos, videos and
                         a voice note that show it (models/kpi_client_sendback.py). -->
                    <div t-if="state.approval.sending" class="modal-body border-top" style="background:#fff5f5;">
                        <h6 class="fw-bold text-danger mb-2">↩ Send this back to the team</h6>
                        <label class="form-label fw-bold">What is still wrong? <span class="text-danger">*</span></label>
                        <textarea class="form-control mb-2" rows="3" t-model="state.approval.reason"
                                  placeholder="Tell the developer exactly what to fix"/>
                        <div class="d-flex flex-wrap gap-2 align-items-center">
                            <label class="btn btn-outline-primary btn-sm mb-0">📷 Photo
                                <input type="file" accept="image/*" multiple="multiple" class="d-none" t-on-change="onAddFiles"/></label>
                            <label class="btn btn-outline-primary btn-sm mb-0">🎥 Video
                                <input type="file" accept="video/*" class="d-none" t-on-change="onAddFiles"/></label>
                            <button type="button" t-att-class="'btn btn-sm ' + (state.rec ? 'btn-danger' : 'btn-outline-primary')" t-on-click="onVoice">
                                <t t-if="state.rec">⏹ Stop and attach (<t t-esc="state.rec.secs"/>s)</t><t t-else="">🎤 Voice note</t>
                            </button>
                            <span class="small text-muted" t-esc="state.files.length ? state.files.length + ' file(s) · ' + fmtSize(filesTotal()) : 'optional: show the problem (up to 25 MB in total)'"/>
                        </div>
                        <div t-if="state.files.length" class="d-flex flex-wrap gap-2 mt-2">
                            <t t-foreach="state.files" t-as="f" t-key="f_index">
                                <span class="badge text-bg-light border d-inline-flex align-items-center gap-1 fw-normal">
                                    <t t-esc="f.name"/> · <t t-esc="fmtSize(f.size)"/>
                                    <a href="#" class="text-danger ms-1" t-on-click.prevent="() => this.removeFile(f_index)">✕</a>
                                </span>
                            </t>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <t t-if="state.approval.sending">
                            <button type="button" class="btn btn-secondary me-auto" t-on-click="() => { this._stopVoice(false); this.state.approval.sending = false; }">Back</button>
                            <button type="button" class="btn btn-danger" t-att-disabled="state.approval.busy or state.rec" t-on-click="submitReject">
                                <i t-att-class="'fa me-1 ' + (state.approval.busy ? 'fa-spinner fa-spin' : 'fa-undo')"/> Send back
                            </button>
                        </t>
                        <t t-else="">
                            <button type="button" class="btn btn-danger me-auto" t-on-click="() => { this.state.files = []; this.state.approval.reason = ''; this.state.approval.sending = true; }">
                                <i class="fa fa-times me-1"/> Reject &amp; Send Back
                            </button>
                            <button type="button" class="btn btn-secondary" t-on-click="closeApproval">Cancel</button>
                            <button type="button" class="btn btn-success" t-on-click="submitApprove">
                                <i class="fa fa-check me-1"/> Approve &amp; Sign
                            </button>
                        </t>
                    </div>
                </div>
                <div class="modal-content" t-if="!state.approval.data">
                    <div class="modal-body text-center p-5">
                        <i class="fa fa-spinner fa-spin fa-3x"/>
                        <p class="mt-3">Loading...</p>
                    </div>
                </div>
            </div>
        </div>
    </div>
    `;

    // Three tabs (same buckets as the mobile app): Pending / In Progress / Completed.
    get statusChips() {
        return [
            { key: 'pending', label: 'Pending', states: ['assigned', 'urgent', 'important', 'regular',
                'queue_waiting', 'pre_approval_pending', 'pre_approval_approved', 'pre_approval_partial'] },
            { key: 'in_progress', label: 'In Progress', states: ['in_progress', 'paused', 'hold', 'rework',
                'partially_completed', 'awaiting_client'] },
            { key: 'completed', label: 'Completed', states: ['completed'] },
        ];
    }
    // Counts must honour the Project / User filters, exactly like `filteredKpis` does —
    // otherwise the tile and the "Showing N task(s)" line below it disagree.
    tabCount(key) {
        const c = this.statusChips.find(x => x.key === key);
        const list = this._applyFilters((this.state.dashboard && this.state.dashboard.kpis) || []);
        return c ? list.filter(k => c.states.includes(k.task_state)).length : 0;
    }
    stateBadge(state) {
        const map = {
            'assigned': 'bg-secondary',
            'in_progress': 'bg-info',
            'paused': 'bg-warning text-dark',
            'partially_completed': 'bg-warning text-dark',
            // The state the client is actually being asked to act on — it had no entry
            // here, so it rendered as a washed-out badge showing the raw code.
            'awaiting_client': 'bg-danger',
            'completed': 'bg-success',
        };
        return map[state] || 'bg-light text-dark';
    }

    _applyFilters(list) {
        let out = list;
        if (this.state.projectFilter) {
            const pid = parseInt(this.state.projectFilter, 10);
            out = out.filter(x => x.project_id === pid);
        }
        return out;
    }
    get filteredPending() {
        return this._applyFilters((this.state.dashboard && this.state.dashboard.pending_approvals) || []);
    }
    // Per-type breakdown recomputed client-side from the FILTERED list. The payload's
    // `by_type` is built server-side over the whole client scope (kpi_reports_api.py),
    // so binding the tiles to it left them frozen whenever a filter was applied.
    get byType() {
        const out = {
            requirement: { total: 0, done: 0, open: 0 },
            update: { total: 0, done: 0, open: 0 },
            bug: { total: 0, done: 0, open: 0 },
        };
        const list = this._applyFilters((this.state.dashboard && this.state.dashboard.kpis) || []);
        for (const k of list) {
            // Unknown kind falls back rather than throwing — a task must never vanish from the totals.
            const b = out[k.kind] || out.requirement;
            b.total++;
            if (k.task_state === 'completed') b.done++; else b.open++;
        }
        return out;
    }
    get filteredKpis() {
        const tab = this.statusChips.find(c => c.key === this.state.tab) || this.statusChips[0];
        const base = this._applyFilters((this.state.dashboard && this.state.dashboard.kpis) || []);
        return base.filter(k => tab.states.includes(k.task_state));
    }
    get filterSummary() {
        const active = !!this.state.projectFilter;
        if (!active) return { show: false };
        const list = this.filteredKpis;
        const totalHours = list.reduce((s, k) => s + (k.actual_hours || 0), 0);
        return {
            show: true,
            taskCount: list.length,
            hoursLabel: this._formatHours(totalHours),
        };
    }
    _formatHours(h) {
        if (!h) return '0h';
        const totalMin = Math.round(h * 60);
        const hr = Math.floor(totalMin / 60);
        const mn = totalMin % 60;
        if (hr && mn) return `${hr}h ${mn}m`;
        if (hr) return `${hr}h`;
        return `${mn}m`;
    }
    projectLabel(projectFilter) {
        const pid = parseInt(projectFilter, 10);
        const p = (this.state.projects || []).find(p => p.id === pid);
        return p ? (p.display || p.name || '') : projectFilter;
    }

    setup() {
        this.state = useState({
            // Promise-driven in-page dialog, replacing window.confirm/prompt.
            // Those are the browser's chrome, not ours: unstyleable, and on a work
            // screen they read as something having gone wrong.
            dlg: { open: false, title: '', message: '', okLabel: 'OK', okClass: 'btn-primary',
                   input: false, inputLabel: '', placeholder: '', required: false,
                   value: '', error: '', resolve: null },
            // Replaces alert(). A browser alert blocks the whole tab and hides the
            // screen it is talking about; this sits in the page and can be ignored.
            toast: { show: false, text: '', kind: 'warning' },
            dashboard: null,
            projects: [],
            tab: 'pending',     // active tab: pending | in_progress | completed
            projectFilter: '',  // '' = all projects
            showAdd: false,
            newTask: {
                kind: 'requirement', sub_kra_id: '', name: '',
                external_ref: '', related_req_ref: '',
                description: '', priority: 'regular',
                deliverable_type: '', deliverable_other: '', parent_id: '',
                legacy_on: false, legacy_ref: '', legacy_name: '', legacy_note: '',
            },
            // Picked files (File objects) and the running voice recording, if any.
            files: [],
            rec: null,          // { secs } while recording
            // /kpi_client_portal/links/info: declined requests, live DBs, has_group.
            links: null,
            panel: '',          // '' | 'fix' | 'dbs'
            // Bug / Update: the requirements of the chosen project to pick from.
            parents: [],
            parentsLoading: false,
            kids: null,         // earlier bugs / updates under the picked requirement
            approval: {
                open: false,
                data: null,
                chk_delivered: false, chk_works: false, chk_authorized: false,
                sending: false, reason: "", busy: false,   // ↩ send back with proof
                notes: '', signature_text: '',
            },
            // The client's saved signature image. This screen never loaded it, so it
            // demanded a typed name on every task even from clients who had uploaded
            // one — while the Completions screen accepted the image. Same client, same
            // task, two different answers depending on which menu they came in through.
            hasSignature: false,
            signatureB64: '',
            // Closed by default — same call the pending queue makes: a long list stays
            // scannable only if it starts folded.
            pendingOpen: false,
        });
        onWillStart(async () => {
            await this.refresh();
            await this.loadSignatureInfo();
            const rp = await rpc('/kpi_client_portal/get_projects', {});
            if (rp && rp.status) this.state.projects = rp.projects || [];
            await this.loadLinks();
        });
        this._voiceCount = 0;
        onWillUnmount(() => this._stopVoice(false));
    }

    // ---- Fix / databases / chat: the client's WhatsApp pages ---------------------
    async loadLinks() {
        const r = await rpc('/kpi_client_portal/links/info', {});
        this.state.links = (r && r.status) ? r : null;
    }
    togglePanel(name) { this.state.panel = this.state.panel === name ? '' : name; }
    // The link comes back from the server, so the tab is opened first (inside the
    // click) and pointed at it afterwards; a pop-up blocker would stop a late open.
    async _openLink(route, params) {
        const w = window.open('', '_blank');
        const r = await rpc(route, params);
        if (!r || !r.status) {
            if (w) w.close();
            this._toast((r && r.message) || 'Could not open it.', 'danger');
            return;
        }
        if (w) { w.location = r.url; } else { window.location = r.url; }
    }
    openDbForm(kind) { return this._openLink('/kpi_client_portal/links/db_form', { kind }); }
    openChat() { return this._openLink('/kpi_client_portal/links/chat', {}); }

    // ---- Attachments (photo / video / voice / files) --------------------------
    fmtSize(n) {
        if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
        return Math.max(1, Math.round(n / 1024)) + ' KB';
    }
    filesTotal() { return this.state.files.reduce((n, f) => n + f.size, 0); }
    // Camera files all arrive as image.jpg / video.mp4: a single camera shot gets its own name.
    onAddFiles(ev) {
        const picked = [...(ev.target.files || [])];
        const camera = ev.target.hasAttribute('capture');
        ev.target.value = '';
        for (const f of picked) {
            let file = f;
            if (camera) {
                const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
                const isVideo = (f.type || '').startsWith('video');
                const ext = (f.name.match(/\.[A-Za-z0-9]+$/) || [isVideo ? '.mp4' : '.jpg'])[0];
                file = new File([f], `${isVideo ? 'Video' : 'Photo'} ${stamp}${ext}`, { type: f.type });
            }
            if (this.filesTotal() + file.size > MAX_ATTACH_BYTES) {
                this._toast('Attachments are limited to 25 MB in total.', 'warning');
                return;
            }
            this.state.files.push(file);
        }
    }
    removeFile(i) { this.state.files.splice(i, 1); }
    // 🎤 Record → Stop attaches it, named "Voice note 1 (0m07s).webm" (the server
    // reads the length back from the name), as the web portal's VoiceRecorder.
    async onVoice() {
        if (this._rec) { this._stopVoice(true); return; }
        if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder)) {
            this._toast("Can't use the mic — type it instead.", 'warning');
            return;
        }
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
            this._toast("Can't use the mic — type it instead.", 'warning');
            return;
        }
        const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
            .find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
        const rec = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
        const r = { rec, stream, chunks: [], from: Date.now(), keep: false,
                    mime: (rec.mimeType || type || 'audio/webm').split(';')[0] };
        rec.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
        rec.onstop = () => {
            stream.getTracks().forEach((t) => t.stop());
            clearInterval(r.tick); clearTimeout(r.cap);
            if (this._rec === r) { this._rec = null; }
            this.state.rec = null;
            if (!r.keep || !r.chunks.length) { return; }
            const secs = Math.round((Date.now() - r.from) / 1000);
            const ext = r.mime.includes('mp4') ? 'm4a' : (r.mime.includes('ogg') ? 'ogg' : 'webm');
            this._voiceCount += 1;
            const name = `Voice note ${this._voiceCount} (${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s).${ext}`;
            const file = new File([new Blob(r.chunks, { type: r.mime })], name, { type: r.mime });
            if (this.filesTotal() + file.size > MAX_ATTACH_BYTES) {
                this._toast('Attachments are limited to 25 MB in total.', 'warning');
                return;
            }
            this.state.files.push(file);
        };
        rec.start(250);
        this._rec = r;
        this.state.rec = { secs: 0 };
        r.tick = setInterval(() => { if (this.state.rec) this.state.rec.secs = Math.round((Date.now() - r.from) / 1000); }, 500);
        r.cap = setTimeout(() => this._stopVoice(true), 5 * 60 * 1000);   // 5-minute cap
    }
    _stopVoice(keep) {
        const r = this._rec;
        if (!r) { return; }
        r.keep = keep;
        if (r.rec.state !== 'inactive') { r.rec.stop(); }
    }
    async _attachmentsPayload() {
        const read = (f) => new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
            fr.onerror = () => reject(fr.error);
            fr.readAsDataURL(f);
        });
        const out = [];
        for (const f of this.state.files) {
            out.push({ name: f.name, data_b64: await read(f), mimetype: f.type || '' });
        }
        return out;
    }

    // Same call and same shape as kpi_client_completions.loadSignatureInfo — the two
    // screens sign off through the same route, so they have to agree on what counts
    // as a signature.
    togglePending() { this.state.pendingOpen = !this.state.pendingOpen; }

    async loadSignatureInfo() {
        const r = await rpc('/kpi_client_portal/get_signature_info', {});
        if (r && r.status) {
            this.state.hasSignature = !!r.has_signature;
            this.state.signatureB64 = r.image_b64 || '';
        }
    }

    async refresh() {
        // Always load the full list; the 3 tabs bucket it client-side.
        const r = await rpc('/kpi_client_portal/dashboard', { state: 'all' });
        if (!r.status) { this._toast('Error: ' + (r.message || 'unknown'), 'danger'); return; }
        this.state.dashboard = r;
    }
    async setFilter(key) {
        const r = await rpc('/kpi_client_portal/dashboard', { state: key });
        if (!r.status) { this._toast('Error: ' + (r.message || 'unknown'), 'danger'); return; }
        this.state.dashboard = r;
    }

    onLegacyToggle(ev) {
        this.state.newTask.legacy_on = ev.target.checked;
        if (ev.target.checked) {
            this.state.newTask.parent_id = '';
            this.state.kids = null;
        }
    }
    onKindChange(ev) {
        this.state.newTask.kind = ev.target.value;
        this.state.newTask.parent_id = '';
        this.loadParents();
    }
    onProjectChange(ev) {
        this.state.newTask.sub_kra_id = ev.target.value;
        this.state.newTask.parent_id = '';
        this.loadParents();
    }
    async onParentChange(ev) {
        const pid = ev.target.value;
        this.state.newTask.parent_id = pid;
        this.state.kids = pid ? { loading: true } : null;
        if (!pid) { return; }
        const r = await rpc('/kpi_client_portal/children', { parent_id: Number(pid), kind: this.state.newTask.kind });
        if (this.state.newTask.parent_id !== pid) { return; }      // picked another meanwhile
        this.state.kids = (r && r.status) ? r : null;
    }
    // Same list the web portal and the WhatsApp form use: the project's
    // requirements, newest first (old-DB ones already added included).
    async loadParents() {
        const t = this.state.newTask;
        this.state.parents = [];
        this.state.kids = null;
        if (t.kind === 'requirement' || !t.sub_kra_id) { return; }
        const want = t.sub_kra_id;
        this.state.parentsLoading = true;
        const r = await rpc('/kpi_client_portal/parent_tasks', { sub_kra_id: Number(want) });
        this.state.parentsLoading = false;
        if (this.state.newTask.sub_kra_id !== want) { return; }   // changed meanwhile
        this.state.parents = (r && r.status) ? (r.tasks || []) : [];
    }

    async submitNewTask() {
        const t = this.state.newTask;
        if (!t.name || !t.sub_kra_id) {
            this._toast('Project and Task Name are required.', 'warning');
            return;
        }
        if (this._rec) {
            this._toast('Stop the voice recording first.', 'warning');
            return;
        }
        const attachments = await this._attachmentsPayload();
        if (t.kind !== 'requirement') {
            if (!t.legacy_on && !t.parent_id) {
                this._toast('Pick the requirement this bug or update is about, or tick "It\'s from the old system".', 'warning');
                return;
            }
            // From the old system: the server checks it says enough (photo / video /
            // voice note / message / Request ID / name) and answers what is missing.
            const r = await rpc('/kpi_client_portal/add_task', {
                ...t, parent_id: t.legacy_on ? false : Number(t.parent_id),
                deliverable_type: '', deliverable_other: '', attachments });
            if (!r.status) { this._toast('Error: ' + (r.message || 'unknown'), 'danger'); return; }
            this._toast(`Task submitted: ${r.name}. Your admin will review and assign it.`, 'warning');
            this._resetNewTask();
            await this.refresh();
            return;
        }
        if (!t.deliverable_type) {
            this._toast('Please choose a type — Module, App, EXE or Other.', 'warning');
            return;
        }
        const other = t.deliverable_type === 'other' ? (t.deliverable_other || '').trim() : '';
        if (t.deliverable_type === 'other' && !other) {
            this._toast('Type what the Other type is (e.g. Plugin, Website).', 'warning');
            return;
        }
        const r = await rpc('/kpi_client_portal/add_task', { ...t, legacy_on: false, deliverable_other: other, attachments });
        if (!r.status) { this._toast('Error: ' + (r.message || 'unknown'), 'danger'); return; }
        this._toast(`Task submitted: ${r.name}. Your admin will review and assign it.`, 'warning');
        this._resetNewTask();
        await this.refresh();
    }

    _resetNewTask() {
        this.state.newTask = {
            kind: 'requirement', sub_kra_id: '', name: '',
            external_ref: '', related_req_ref: '',
            description: '', priority: 'regular',
            deliverable_type: '', deliverable_other: '', parent_id: '',
            legacy_on: false, legacy_ref: '', legacy_name: '', legacy_note: '',
        };
        this.state.files = [];
        this.state.parents = [];
        this.state.kids = null;
        this.state.showAdd = false;
    }

    async openApproval(kpiId) {
        this.state.approval.open = true;
        this.state.approval.data = null;
        this.state.approval.chk_delivered = false;
        this.state.approval.chk_works = false;
        this.state.approval.chk_authorized = false;
        this.state.approval.notes = '';
        this.state.approval.signature_text = '';
        this.state.approval.sending = false;
        this.state.approval.reason = '';
        const r = await rpc('/kpi_client_approval/get', { kpi_id: kpiId });
        if (!r.status) { this._toast('Error: ' + (r.message || 'unknown'), 'danger'); this.closeApproval(); return; }
        this.state.approval.data = r.data;
    }
    closeApproval() {
        this.state.approval.open = false;
        this.state.approval.data = null;
    }
    async submitApprove() {
        const a = this.state.approval;
        if (!a.chk_delivered || !a.chk_works || !a.chk_authorized) {
            this._toast('Please tick all three confirmation checkboxes.', 'warning');
            return;
        }
        // Only demand a typed name when there is no saved signature to fall back on —
        // this used to be unconditional, so an uploaded signature was ignored here.
        // Mirrors the server rule in _resolve_client_signature.
        if (!this.state.hasSignature && !(a.signature_text || '').trim()) {
            this._toast('Please type your name as signature, or upload a signature image from the Completions page.', 'warning');
            return;
        }
        const r = await rpc('/kpi_client_approval/approve', {
            kpi_id: a.data.kpi.id,
            chk_delivered: a.chk_delivered,
            chk_works: a.chk_works,
            chk_authorized: a.chk_authorized,
            notes: a.notes,
            signature_text: a.signature_text,
        });
        if (!r.status) { this._toast('Error: ' + (r.message || 'unknown'), 'danger'); return; }
        this._toast('Approved and signed. Thank you!', 'warning');
        this.closeApproval();
        await this.refresh();
    }
    async submitReject() {
        const a = this.state.approval;
        const reason = (a.reason || '').trim();
        if (reason.length < 3) {
            this._toast('Please write what is still wrong, so the developer knows what to fix.', 'warning');
            return;
        }
        a.busy = true;
        try {
            const r = await rpc('/kpi_client_approval/reject', {
                kpi_id: a.data.kpi.id,
                reason: reason,
                source: 'odoo',
                attachments: await this._attachmentsPayload(),
            });
            if (!r.status) { this._toast('Error: ' + (r.message || 'unknown'), 'danger'); return; }
            const n = this.state.files.length;
            this._toast(n ? `Sent back to the team with ${n} file(s).` : 'Sent back to the team for changes.', 'warning');
            this.state.files = [];
            this.closeApproval();
            await this.refresh();
        } finally { a.busy = false; }
    }

    // Errors stay until dismissed — an error that vanishes before it is read is the
    // same as no error at all. Anything else clears itself.
    _toast(text, kind = 'warning') {
        this.state.toast = { show: true, text: String(text == null ? '' : text), kind };
        if (kind !== 'danger') {
            setTimeout(() => { this.state.toast.show = false; }, 4500);
        }
    }
    dismissToast() { this.state.toast.show = false; }


    _dialog({ title, message = '', okLabel = 'OK', okClass = 'btn-primary',
              input = false, inputLabel = '', placeholder = '', required = false }) {
        Object.assign(this.state.dlg, {
            open: true, title, message, okLabel, okClass,
            input, inputLabel, placeholder, required, value: '', error: '',
        });
        return new Promise((resolve) => { this.state.dlg.resolve = resolve; });
    }
    _confirm(title, message, okLabel = 'OK', okClass = 'btn-primary') {
        return this._dialog({ title, message, okLabel, okClass });
    }
    dlgSet(v) { this.state.dlg.value = v; this.state.dlg.error = ''; }
    dlgCancel() {
        const r = this.state.dlg.resolve;
        this.state.dlg.open = false; this.state.dlg.resolve = null;
        if (r) r(null);
    }
    dlgOk() {
        const d = this.state.dlg;
        // Stated rather than enforced by disabling OK, so a click that does nothing
        // always says why.
        if (d.input && d.required && !String(d.value || '').trim()) {
            d.error = (d.inputLabel || 'This') + ' is required.';
            return;
        }
        const val = d.input ? d.value : true;
        const r = d.resolve;
        d.open = false; d.resolve = null;
        if (r) r(val);
    }

}

registry.category("actions").add("kpi_client_dashboard", KpiClientDashboard);
