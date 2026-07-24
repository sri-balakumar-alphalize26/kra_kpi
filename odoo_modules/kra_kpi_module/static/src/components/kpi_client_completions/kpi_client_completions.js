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

        <div t-if="filteredPending.length > 0" class="card p-3 shadow-sm">
            <h5 class="fw-bold mb-3 text-warning">
                <i class="fa fa-bell me-2"/>
                <t t-esc="filteredPending.length"/> task(s) need your approval
                <span t-if="state.projectFilter" class="badge bg-info ms-2">
                    Project: <t t-esc="this.projectLabel(state.projectFilter)"/>
                </span>
            </h5>
            <table class="table table-hover align-middle">
                <thead class="table-light">
                    <tr>
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
