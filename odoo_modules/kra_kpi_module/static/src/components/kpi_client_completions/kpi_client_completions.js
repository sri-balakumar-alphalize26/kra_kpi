/** @odoo-module **/
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

/**
 * Completions — dedicated screen for the client to review/sign tasks that the
 * admin has generated (state = partially_completed). Reuses the dashboard's
 * approve/reject endpoints.
 */
export class KpiClientCompletions extends Component {
    static template = xml/* xml */`
    <div class="o_kpi_client_completions p-4">
        <div class="d-flex justify-content-between align-items-center mb-4">
            <h2 class="fw-bold">
                <i class="fa fa-certificate me-2 text-warning"/> Completions Awaiting Your Sign-Off
            </h2>
            <button class="btn btn-outline-primary" t-on-click="refresh">
                <i class="fa fa-refresh me-1"/> Refresh
            </button>
        </div>

        <!-- One-time signature image upload — reused for every sign-off below -->
        <div class="card p-3 mb-3 shadow-sm border-info border-start border-4">
            <div class="row g-3 align-items-center">
                <div class="col-md-7">
                    <h6 class="fw-bold mb-1">
                        <i class="fa fa-pencil-square-o me-2 text-info"/>
                        Your Saved Signature
                    </h6>
                    <p class="small text-muted mb-2">
                        Upload your signature image once (PNG/JPG). It will auto-load on the
                        Review &amp; Sign popup for every task — you just confirm to approve.
                    </p>
                    <input type="file" class="form-control form-control-sm"
                           accept=".png,.jpg,.jpeg"
                           t-on-change="onSignatureUpload"
                           style="max-width: 320px"/>
                </div>
                <div class="col-md-5 text-end">
                    <div t-if="state.hasSignature">
                        <div class="small text-muted mb-1">Saved signature:</div>
                        <img t-att-src="'data:image/png;base64,' + state.signatureB64"
                             style="max-height: 80px; max-width: 280px; border: 1px solid #ddd; border-radius: 4px; background: #fff; padding: 4px"
                             alt="Saved signature"/>
                    </div>
                    <div t-else="" class="text-muted small">
                        <i class="fa fa-info-circle me-1"/>
                        No signature uploaded yet
                    </div>
                </div>
            </div>
        </div>

        <div t-if="state.error" class="alert alert-warning">
            <i class="fa fa-exclamation-triangle me-2"/> <t t-esc="state.error"/>
        </div>

        <div t-if="!state.error and state.pending.length === 0"
             class="card p-5 text-center shadow-sm">
            <i class="fa fa-check-circle fa-3x mb-3 text-success"/>
            <h4 class="text-muted">All caught up — nothing awaiting your sign-off.</h4>
            <p class="text-muted">
                When the team marks a task complete, it will appear here for your review.
            </p>
        </div>

        <!-- Project filter -->
        <div t-if="state.projects.length > 1 and state.pending.length > 0"
             class="card p-2 mb-3 shadow-sm bg-light">
            <div class="row g-2 align-items-center">
                <div class="col-auto fw-bold small text-muted">
                    <i class="fa fa-filter me-1"/> Filter by Project:
                </div>
                <div class="col-md-5">
                    <select class="form-select form-select-sm" t-model="state.projectFilter">
                        <option value="">All projects</option>
                        <t t-foreach="state.projects" t-as="p" t-key="p.id">
                            <option t-att-value="p.id" t-esc="p.display"/>
                        </t>
                    </select>
                </div>
                <div t-if="state.projectFilter" class="col-auto">
                    <button class="btn btn-sm btn-outline-secondary"
                            t-on-click="() => state.projectFilter = ''">
                        <i class="fa fa-times me-1"/> Clear
                    </button>
                </div>
            </div>
        </div>

        <div t-if="filteredPending.length > 0" class="card shadow-sm overflow-hidden">
            <!-- Header doubles as the toggle. One client has 132 pending; rendering
                 them all inline buried everything below it. -->
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
            <!-- Sign several at once. One dialog instead of one per task — with 40
                 pending that was 40 dialogs and 120 checkbox clicks.
                 Lives OUTSIDE the scroll box on purpose: inside it, the bar scrolled
                 away around row 90 and you had to scroll back up to find the button
                 you had just armed. t-stopPropagation so clicking it doesn't fold
                 the panel shut under your cursor. -->
            <div t-if="state.selected.length > 0"
                 t-on-click.stop=""
                 class="alert alert-warning d-flex align-items-center justify-content-between py-2 mx-3 mb-2">
                <div>
                    <strong t-esc="state.selected.length"/> task(s) selected
                </div>
                <div>
                    <button class="btn btn-sm btn-outline-secondary me-2" t-on-click="clearSelection">
                        Clear
                    </button>
                    <button class="btn btn-sm btn-warning" t-on-click="openBulkApproval">
                        <i class="fa fa-certificate me-1"/>
                        Sign selected (<t t-esc="state.selected.length"/>)
                    </button>
                </div>
            </div>
            <div t-if="state.pendingOpen" class="px-3 pb-3" style="max-height:420px; overflow-y:auto;">
            <table class="table table-hover align-middle">
                <thead class="table-light">
                    <tr>
                        <th style="width: 34px">
                            <input class="form-check-input" type="checkbox"
                                   t-att-checked="allSelected"
                                   t-on-change="toggleSelectAll"
                                   title="Select all"/>
                        </th>
                        <th style="width: 70px">Kind</th>
                        <th style="width: 90px">Ref</th>
                        <th>Task</th>
                        <th>Project</th>
                        <th>Delivered By</th>
                        <th style="width: 140px">Submitted</th>
                        <th style="width: 170px">&#160;</th>
                    </tr>
                </thead>
                <tbody>
                    <t t-foreach="filteredPending" t-as="p" t-key="p.id">
                        <tr>
                            <td>
                                <input class="form-check-input" type="checkbox"
                                       t-att-checked="state.selected.includes(p.id)"
                                       t-on-change="() => this.toggleSelect(p.id)"/>
                            </td>
                            <td>
                                <span class="badge"
                                      t-att-class="p.kind === 'bug' ? 'bg-danger' : (p.kind === 'update' ? 'bg-warning text-dark' : 'bg-primary')"
                                      t-esc="p.kind"/>
                            </td>
                            <td>
                                <span class="badge bg-secondary" t-esc="p.external_ref or '—'"/>
                            </td>
                            <td class="fw-bold" t-esc="p.name"/>
                            <td t-esc="p.project_name"/>
                            <td t-esc="p.primary_assignee"/>
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
                            <strong>Submitted by:</strong> <t t-esc="state.approval.data.kpi.primary_assignee"/><br/>
                            <strong>Submitted on:</strong> <t t-esc="state.approval.data.kpi.completion_date"/>
                        </div>
                        <div t-if="state.approval.data.kpi.description"
                             class="border rounded p-2 bg-light mb-3 small">
                            <t t-esc="state.approval.data.kpi.description"/>
                        </div>

                        <h6 class="fw-bold">Confirmation Checklist</h6>
                        <div class="form-check">
                            <input class="form-check-input" type="checkbox" id="chk1"
                                   t-model="state.approval.chk_delivered"/>
                            <label class="form-check-label" for="chk1">
                                I confirm the task has been delivered as specified.
                            </label>
                        </div>
                        <div class="form-check">
                            <input class="form-check-input" type="checkbox" id="chk2"
                                   t-model="state.approval.chk_works"/>
                            <label class="form-check-label" for="chk2">
                                The functionality works as expected.
                            </label>
                        </div>
                        <div class="form-check mb-3">
                            <input class="form-check-input" type="checkbox" id="chk3"
                                   t-model="state.approval.chk_authorized"/>
                            <label class="form-check-label" for="chk3">
                                I authorize this task as complete.
                            </label>
                        </div>

                        <div class="mb-3">
                            <label class="form-label fw-bold">Notes (optional)</label>
                            <textarea class="form-control" rows="2" t-model="state.approval.notes"/>
                        </div>

                        <!-- Saved signature image (auto-loaded) -->
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

                        <!-- Fallback: typed name when no image uploaded -->
                        <div t-else="" class="mb-3">
                            <div class="alert alert-warning small mb-2">
                                <i class="fa fa-exclamation-triangle me-1"/>
                                No signature image uploaded. Type your name to sign manually,
                                OR close this dialog and upload a signature image at the top of the page.
                            </div>
                            <label class="form-label fw-bold">
                                Type your full name as digital signature
                            </label>
                            <input type="text" class="form-control form-control-lg"
                                   style="font-family: cursive"
                                   t-model="state.approval.signature_text"
                                   placeholder="Your full name"/>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-danger me-auto" t-on-click="submitReject">
                            <i class="fa fa-times me-1"/> Reject &amp; Send Back
                        </button>
                        <button type="button" class="btn btn-secondary" t-on-click="closeApproval">Cancel</button>
                        <button type="button" class="btn btn-success" t-on-click="submitApprove">
                            <i class="fa fa-check me-1"/> Approve &amp; Sign
                        </button>
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

        <!-- Bulk sign-off modal -->
        <div t-if="state.bulk.open" class="modal d-block" tabindex="-1" style="background: rgba(0,0,0,0.5);">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">
                            <i class="fa fa-certificate me-2"/>
                            Sign off <t t-esc="state.selected.length"/> task(s)
                        </h5>
                        <button type="button" class="btn-close" t-on-click="closeBulk"/>
                    </div>
                    <div class="modal-body">
                        <!-- Every task is listed by name. Signing "12 tasks" with no names
                             would be asking for a signature on something unseen. -->
                        <div class="mb-3">
                            <div class="fw-bold mb-1">You are signing off:</div>
                            <div class="border rounded p-2" style="max-height:210px; overflow-y:auto;">
                                <t t-foreach="selectedTasks" t-as="t" t-key="t.id">
                                    <div class="small border-bottom py-1">
                                        <span class="badge bg-secondary me-1" t-esc="t.external_ref or '—'"/>
                                        <t t-esc="t.name"/>
                                        <span class="text-muted" t-if="t.project_name"> · <t t-esc="t.project_name"/></span>
                                    </div>
                                </t>
                            </div>
                        </div>
                        <div class="alert alert-light border">
                            <div class="fw-bold mb-2">By signing you confirm, for every task listed above:</div>
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" id="bchk1"
                                       t-model="state.bulk.chk_delivered"/>
                                <label class="form-check-label" for="bchk1">The work was delivered to me.</label>
                            </div>
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" id="bchk2"
                                       t-model="state.bulk.chk_works"/>
                                <label class="form-check-label" for="bchk2">It works as agreed.</label>
                            </div>
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" id="bchk3"
                                       t-model="state.bulk.chk_authorized"/>
                                <label class="form-check-label" for="bchk3">I am authorized to approve it.</label>
                            </div>
                        </div>
                        <div t-if="state.signatureB64" class="mb-3">
                            <div class="small text-muted mb-1">Your signature (auto-loaded)</div>
                            <img t-att-src="'data:image/png;base64,' + state.signatureB64"
                                 style="max-height:70px; border:1px solid #dee2e6; border-radius:4px;"
                                 alt="Saved signature"/>
                        </div>
                        <div t-else="" class="mb-3">
                            <label class="form-label fw-bold">Type your full name as digital signature</label>
                            <input type="text" class="form-control form-control-lg"
                                   style="font-family: cursive"
                                   t-model="state.bulk.signature_text"
                                   placeholder="Your full name"/>
                        </div>
                        <div class="mb-0">
                            <label class="form-label">Notes (optional — applied to all)</label>
                            <textarea class="form-control" rows="2" t-model="state.bulk.notes"/>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" t-on-click="closeBulk">Cancel</button>
                        <button type="button" class="btn btn-success"
                                t-att-disabled="state.bulk.busy"
                                t-on-click="submitBulkApprove">
                            <i t-att-class="'fa me-1 ' + (state.bulk.busy ? 'fa-spinner fa-spin' : 'fa-check')"/>
                            Approve &amp; Sign all
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>
    `;

    get filteredPending() {
        if (!this.state.projectFilter) return this.state.pending;
        const pid = parseInt(this.state.projectFilter, 10);
        return this.state.pending.filter(p => p.project_id === pid);
    }
    projectLabel(projectFilter) {
        const pid = parseInt(projectFilter, 10);
        const p = (this.state.projects || []).find(p => p.id === pid);
        return p ? (p.display || p.name || '') : projectFilter;
    }
    get selectedTasks() {
        return this.state.pending.filter(p => this.state.selected.includes(p.id));
    }
    get allSelected() {
        const vis = this.filteredPending;
        return vis.length > 0 && vis.every(p => this.state.selected.includes(p.id));
    }
    toggleSelect(id) {
        const sel = this.state.selected;
        const i = sel.indexOf(id);
        if (i === -1) sel.push(id); else sel.splice(i, 1);
    }
    toggleSelectAll() {
        // Operates on what's VISIBLE, so a project filter narrows "select all" too —
        // otherwise it would silently pick up tasks the client can't currently see.
        this.state.selected = this.allSelected ? [] : this.filteredPending.map(p => p.id);
    }
    clearSelection() { this.state.selected = []; }
    togglePending() { this.state.pendingOpen = !this.state.pendingOpen; }
    openBulkApproval() {
        Object.assign(this.state.bulk, {
            open: true, busy: false,
            chk_delivered: false, chk_works: false, chk_authorized: false,
            notes: '', signature_text: '',
        });
    }
    closeBulk() { this.state.bulk.open = false; }
    async submitBulkApprove() {
        const b = this.state.bulk;
        if (!(b.chk_delivered && b.chk_works && b.chk_authorized)) {
            alert('Please tick all three confirmations before signing.');
            return;
        }
        if (!this.state.signatureB64 && !(b.signature_text || '').trim()) {
            alert('Please type your full name, or upload a signature image at the top of the page.');
            return;
        }
        b.busy = true;
        try {
            const r = await rpc('/kpi_client_approval/approve_bulk', {
                kpi_ids: this.state.selected,
                chk_delivered: b.chk_delivered,
                chk_works: b.chk_works,
                chk_authorized: b.chk_authorized,
                notes: b.notes,
                signature_text: b.signature_text,
            });
            if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
            // Partial success is normal — say exactly which ones didn't go through.
            let msg = `Signed off ${r.approved.length} task(s).`;
            if ((r.skipped || []).length) {
                msg += `\n\nNot signed (${r.skipped.length}):\n`
                     + r.skipped.map(s => `• ${s.name || s.id}: ${s.reason}`).join('\n');
            }
            alert(msg);
            this.state.bulk.open = false;
            this.state.selected = [];
            await this.refresh();
        } finally {
            b.busy = false;
        }
    }

    setup() {
        this.state = useState({
            pending: [],
            projects: [],
            projectFilter: '',
            error: '',
            hasSignature: false,
            signatureB64: '',
            signatureFileName: '',
            userName: '',
            selected: [],                  // task ids ticked for bulk sign-off
            pendingOpen: false,            // list starts folded — see the header comment

            bulk: {
                open: false, busy: false,
                chk_delivered: false, chk_works: false, chk_authorized: false,
                notes: '', signature_text: '',
            },
            approval: {
                open: false,
                data: null,
                chk_delivered: false, chk_works: false, chk_authorized: false,
                notes: '', signature_text: '',
            },
        });
        onWillStart(async () => {
            await this.loadSignatureInfo();
            await this.refresh();
            const rp = await rpc('/kpi_client_portal/get_projects', {});
            if (rp && rp.status) this.state.projects = rp.projects || [];
        });
    }

    async loadSignatureInfo() {
        const r = await rpc('/kpi_client_portal/get_signature_info', {});
        if (r && r.status) {
            this.state.hasSignature = !!r.has_signature;
            this.state.signatureB64 = r.image_b64 || '';
            this.state.signatureFileName = r.file_name || '';
            this.state.userName = r.user_name || '';
        }
    }

    onSignatureUpload(ev) {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
            const dataUrl = reader.result || '';
            const idx = dataUrl.indexOf(',');
            const b64 = idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
            const r = await rpc('/kpi_client_portal/upload_signature', {
                file_data: b64, file_name: file.name,
            });
            if (!r.status) { alert('Upload failed: ' + (r.message || 'unknown')); return; }
            this.state.hasSignature = true;
            this.state.signatureB64 = b64;
            this.state.signatureFileName = file.name;
            ev.target.value = '';
        };
        reader.readAsDataURL(file);
    }

    async refresh() {
        // Reuse the dashboard endpoint — gives us authorized check + pending list directly
        const r = await rpc('/kpi_client_portal/dashboard', { state: 'partially_completed' });
        if (!r.status) { this.state.error = r.message || 'unknown'; return; }
        if (!r.authorized) { this.state.error = r.message; return; }
        this.state.error = '';
        this.state.pending = r.pending_approvals || [];
    }

    async openApproval(kpiId) {
        this.state.approval.open = true;
        this.state.approval.data = null;
        this.state.approval.chk_delivered = false;
        this.state.approval.chk_works = false;
        this.state.approval.chk_authorized = false;
        this.state.approval.notes = '';
        this.state.approval.signature_text = '';
        const r = await rpc('/kpi_client_approval/get', { kpi_id: kpiId });
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); this.closeApproval(); return; }
        this.state.approval.data = r.data;
    }
    closeApproval() {
        this.state.approval.open = false;
        this.state.approval.data = null;
    }
    async submitApprove() {
        const a = this.state.approval;
        if (!a.chk_delivered || !a.chk_works || !a.chk_authorized) {
            alert('Please tick all three confirmation checkboxes.');
            return;
        }
        // If a saved signature image exists, no need to type anything — server will
        // use the user's name as the textual signature alongside the image.
        if (!this.state.hasSignature && !(a.signature_text || '').trim()) {
            alert('Please upload a signature image at the top of the page, or type your name.');
            return;
        }
        const r = await rpc('/kpi_client_approval/approve', {
            kpi_id: a.data.kpi.id,
            chk_delivered: a.chk_delivered,
            chk_works: a.chk_works,
            chk_authorized: a.chk_authorized,
            notes: a.notes,
            signature_text: a.signature_text || '',  // empty allowed when image is saved
        });
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        alert('Approved and signed. Thank you!');
        this.closeApproval();
        await this.refresh();
    }
    async submitReject() {
        const reason = prompt('Reason for rejection?');
        if (!reason) return;
        const r = await rpc('/kpi_client_approval/reject', {
            kpi_id: this.state.approval.data.kpi.id,
            reason: reason,
        });
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        alert('Sent back to the team for changes.');
        this.closeApproval();
        await this.refresh();
    }
}

registry.category("actions").add("kpi_client_completions", KpiClientCompletions);
