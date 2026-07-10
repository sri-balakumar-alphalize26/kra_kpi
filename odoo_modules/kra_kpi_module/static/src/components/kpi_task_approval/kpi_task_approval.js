/** @odoo-module **/
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

/**
 * Task Approval Status — admin-only screen.
 *
 * Two sections:
 *  1. Approved & Started — client already approved, dev is working.
 *  2. Not Approved & Started — dev started but client hasn't decided.
 *     Each row has a "Send Approval Request" button that manually re-fires
 *     the pre_approval_request WhatsApp to the next non-notified client
 *     (sequential single-client escalation).
 */
export class KpiTaskApproval extends Component {
    static template = xml/* xml */`
    <div class="o_kpi_task_approval p-4">
        <div class="d-flex justify-content-between align-items-center mb-4">
            <h2 class="fw-bold">
                <i class="fa fa-check-square-o me-2 text-primary"/> Task Approval Status
            </h2>
            <button class="btn btn-outline-primary" t-on-click="refresh">
                <i class="fa fa-refresh me-1"/> Refresh
            </button>
        </div>

        <t t-if="state.loading">
            <div class="text-center text-muted py-5">
                <i class="fa fa-spinner fa-spin fa-2x mb-2"/>
                <div>Loading...</div>
            </div>
        </t>

        <t t-else="">
            <!-- SECTION 1: Not Approved & Started (action needed) -->
            <div class="card mb-4 border-danger">
                <div class="card-header bg-danger text-white d-flex justify-content-between align-items-center">
                    <div>
                        <i class="fa fa-exclamation-triangle me-2"/>
                        <strong>Not Approved &amp; Started</strong>
                        <span class="ms-2 small">— dev is working but client hasn't approved yet</span>
                    </div>
                    <span class="badge bg-light text-danger" t-esc="state.unapproved.length"/>
                </div>
                <div class="card-body p-0">
                    <t t-if="state.unapproved.length === 0">
                        <div class="text-center text-muted py-4">
                            <i class="fa fa-check-circle fa-2x mb-2 text-success"/>
                            <div>All started tasks are approved. Nothing to send.</div>
                        </div>
                    </t>
                    <t t-else="">
                        <table class="table table-hover mb-0">
                            <thead class="table-light">
                                <tr>
                                    <th>Ref</th>
                                    <th>Task</th>
                                    <th>Client / Project</th>
                                    <th>Developer</th>
                                    <th>State</th>
                                    <th>Currently Notified</th>
                                    <th>Next Client</th>
                                    <th class="text-end">Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                <t t-foreach="state.unapproved" t-as="t" t-key="t.id">
                                    <tr>
                                        <td><strong t-esc="t.external_ref"/></td>
                                        <td t-esc="t.name"/>
                                        <td>
                                            <div t-esc="t.client_name"/>
                                            <div class="small text-muted" t-esc="t.kra_name"/>
                                        </td>
                                        <td t-esc="t.developer"/>
                                        <td>
                                            <span class="badge bg-warning text-dark" t-esc="t.task_state"/>
                                        </td>
                                        <td>
                                            <t t-if="t.current_client">
                                                <div t-esc="t.current_client"/>
                                                <div class="small text-muted">
                                                    <t t-esc="t.notified_count"/> of <t t-esc="t.total_clients"/> tried
                                                </div>
                                            </t>
                                            <t t-else="">
                                                <span class="text-muted">— none yet —</span>
                                            </t>
                                        </td>
                                        <td>
                                            <t t-if="t.next_client">
                                                <span class="badge bg-info text-white" t-esc="t.next_client"/>
                                            </t>
                                            <t t-else="">
                                                <span class="text-muted small">all tried — will wrap</span>
                                            </t>
                                        </td>
                                        <td class="text-end">
                                            <t t-if="t.total_clients === 0">
                                                <button class="btn btn-sm btn-warning me-1"
                                                        t-on-click="() => this.openClientPicker(t)">
                                                    <i class="fa fa-user-plus me-1"/> Choose Client
                                                </button>
                                            </t>
                                            <t t-else="">
                                                <button class="btn btn-sm btn-outline-secondary me-1"
                                                        t-on-click="() => this.openClientPicker(t)"
                                                        title="Edit assigned clients">
                                                    <i class="fa fa-users"/>
                                                </button>
                                            </t>
                                            <button class="btn btn-sm btn-danger"
                                                    t-att-disabled="state.sending[t.id] || t.total_clients === 0 ? true : false"
                                                    t-on-click="() => this.sendApproval(t)">
                                                <t t-if="state.sending[t.id]">
                                                    <i class="fa fa-spinner fa-spin me-1"/> Sending...
                                                </t>
                                                <t t-else="">
                                                    <i class="fa fa-whatsapp me-1"/> Send Approval Request
                                                </t>
                                            </button>
                                        </td>
                                    </tr>
                                </t>
                            </tbody>
                        </table>
                    </t>
                </div>
            </div>

            <!-- SECTION 2: Approved & Started (all good) -->
            <div class="card border-success">
                <div class="card-header bg-success text-white d-flex justify-content-between align-items-center">
                    <div>
                        <i class="fa fa-check me-2"/>
                        <strong>Approved &amp; Started</strong>
                        <span class="ms-2 small">— client approved, dev is working / completed</span>
                    </div>
                    <span class="badge bg-light text-success" t-esc="state.approved.length"/>
                </div>
                <div class="card-body p-0">
                    <t t-if="state.approved.length === 0">
                        <div class="text-center text-muted py-4">
                            <i class="fa fa-inbox fa-2x mb-2"/>
                            <div>No approved-and-started tasks.</div>
                        </div>
                    </t>
                    <t t-else="">
                        <table class="table table-hover mb-0">
                            <thead class="table-light">
                                <tr>
                                    <th>Ref</th>
                                    <th>Task</th>
                                    <th>Client / Project</th>
                                    <th>Developer</th>
                                    <th>State</th>
                                    <th>Decided By</th>
                                    <th>Approval Date</th>
                                </tr>
                            </thead>
                            <tbody>
                                <t t-foreach="state.approved" t-as="t" t-key="t.id">
                                    <tr>
                                        <td><strong t-esc="t.external_ref"/></td>
                                        <td t-esc="t.name"/>
                                        <td>
                                            <div t-esc="t.client_name"/>
                                            <div class="small text-muted" t-esc="t.kra_name"/>
                                        </td>
                                        <td t-esc="t.developer"/>
                                        <td>
                                            <span class="badge bg-success" t-esc="t.task_state"/>
                                        </td>
                                        <td t-esc="t.decided_by || '—'"/>
                                        <td class="small" t-esc="t.approval_date ? t.approval_date.slice(0,16).replace('T',' ') : '—'"/>
                                    </tr>
                                </t>
                            </tbody>
                        </table>
                    </t>
                </div>
            </div>
        </t>

        <!-- Client Picker Modal -->
        <div t-if="state.picker" class="modal show d-block" style="background:rgba(0,0,0,.5)">
            <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">
                            <i class="fa fa-users me-2"/> Assign Client to <span t-esc="state.picker.task.client_name || state.picker.task.kra_name"/>
                        </h5>
                        <button type="button" class="btn-close" t-on-click="() => (state.picker = null)"/>
                    </div>
                    <div class="modal-body">
                        <p class="small text-muted mb-2">
                            Select which client user(s) should receive the pre-approval WhatsApp for tasks under
                            <strong t-esc="state.picker.task.kra_name"/>.
                        </p>
                        <t t-if="state.picker.availableClients.length === 0">
                            <div class="alert alert-warning small mb-0">
                                No client users found. Create one via KRA / KPI → Manage KRAs → 👥 Add Client.
                            </div>
                        </t>
                        <t t-else="">
                            <div class="list-group">
                                <label class="list-group-item d-flex align-items-center"
                                       t-foreach="state.picker.availableClients" t-as="c" t-key="c.id">
                                    <input type="checkbox" class="form-check-input me-3"
                                           t-att-checked="state.picker.selected.includes(c.id)"
                                           t-on-change="(ev) => this.toggleClient(c.id, ev.target.checked)"/>
                                    <div class="flex-grow-1">
                                        <div><strong t-esc="c.name"/></div>
                                        <div class="small text-muted">
                                            <t t-esc="c.login"/>
                                            <span t-if="c.phone"> • <t t-esc="c.phone"/></span>
                                        </div>
                                    </div>
                                </label>
                            </div>
                        </t>
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-secondary" t-on-click="() => (state.picker = null)">Cancel</button>
                        <button class="btn btn-primary"
                                t-att-disabled="state.picker.saving || state.picker.selected.length === 0 ? true : false"
                                t-on-click="saveClients">
                            <t t-if="state.picker.saving"><i class="fa fa-spinner fa-spin me-1"/> Saving...</t>
                            <t t-else=""><i class="fa fa-save me-1"/> Save</t>
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <!-- Toast -->
        <div t-if="state.toast" class="position-fixed bottom-0 end-0 p-3" style="z-index:1080;">
            <div class="toast show" role="alert">
                <div class="toast-header" t-att-class="state.toast.ok ? 'bg-success text-white' : 'bg-danger text-white'">
                    <strong class="me-auto">
                        <i t-att-class="state.toast.ok ? 'fa fa-check me-1' : 'fa fa-exclamation-triangle me-1'"/>
                        <t t-esc="state.toast.ok ? 'Sent' : 'Failed'"/>
                    </strong>
                    <button type="button" class="btn-close btn-close-white" t-on-click="() => (this.state.toast = null)"/>
                </div>
                <div class="toast-body" t-esc="state.toast.message"/>
            </div>
        </div>
    </div>`;

    setup() {
        this.state = useState({
            loading: true,
            approved: [],
            unapproved: [],
            sending: {},
            toast: null,
            picker: null,          // {task, availableClients:[], selected:[], saving:false}
            availableClientsCache: null,
        });
        onWillStart(async () => { await this.refresh(); });
    }

    async openClientPicker(task) {
        // Lazy-load the client list once per session.
        if (!this.state.availableClientsCache) {
            try {
                const r = await rpc("/kpi_task_approval/get_available_clients", {});
                if (r && r.status) {
                    this.state.availableClientsCache = r.clients || [];
                } else {
                    this._showToast(false, (r && r.message) || "Failed to load clients");
                    return;
                }
            } catch (e) {
                this._showToast(false, e.message || String(e));
                return;
            }
        }
        this.state.picker = {
            task,
            availableClients: this.state.availableClientsCache,
            // Pre-select currently-notified users if any; otherwise empty.
            selected: [],
            saving: false,
        };
    }

    toggleClient(userId, checked) {
        if (!this.state.picker) return;
        const sel = this.state.picker.selected;
        if (checked && !sel.includes(userId)) {
            sel.push(userId);
        } else if (!checked) {
            const i = sel.indexOf(userId);
            if (i !== -1) sel.splice(i, 1);
        }
    }

    async saveClients() {
        if (!this.state.picker) return;
        const { task, selected } = this.state.picker;
        this.state.picker.saving = true;
        try {
            const r = await rpc("/kpi_task_approval/set_kra_clients", {
                kpi_id: task.id,
                client_user_ids: selected,
            });
            if (r && r.status) {
                this._showToast(true, r.message);
                this.state.picker = null;
                await this.refresh();
            } else {
                this._showToast(false, (r && r.message) || "Failed to save");
                this.state.picker.saving = false;
            }
        } catch (e) {
            this._showToast(false, e.message || String(e));
            this.state.picker.saving = false;
        }
    }

    async refresh() {
        this.state.loading = true;
        try {
            const r = await rpc("/kpi_task_approval/list", {});
            if (r && r.status) {
                this.state.approved = r.approved_started || [];
                this.state.unapproved = r.unapproved_started || [];
            } else {
                this._showToast(false, (r && r.message) || "Failed to load");
            }
        } catch (e) {
            this._showToast(false, e.message || String(e));
        } finally {
            this.state.loading = false;
        }
    }

    async sendApproval(task) {
        this.state.sending[task.id] = true;
        try {
            const r = await rpc("/kpi_task_approval/resend", { kpi_id: task.id });
            if (r && r.status) {
                this._showToast(true, `${task.external_ref}: ${r.message}`);
                await this.refresh();
            } else {
                this._showToast(false, (r && r.message) || "Failed");
            }
        } catch (e) {
            this._showToast(false, e.message || String(e));
        } finally {
            delete this.state.sending[task.id];
        }
    }

    _showToast(ok, message) {
        this.state.toast = { ok, message };
        setTimeout(() => { this.state.toast = null; }, 4000);
    }
}

registry.category("actions").add("kpi_task_approval", KpiTaskApproval);
