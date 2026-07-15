/** @odoo-module **/
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

/**
 * Client Task Queue — admin-only screen showing KPIs that are awaiting publish.
 * Admin reviews each, sets Ref ID / linked req / estimate / developer / priority,
 * then clicks Publish to make the task visible to the team.
 */
export class KpiPendingQueue extends Component {
    static template = xml/* xml */`
    <div class="o_kpi_pending_queue p-4">
        <div class="d-flex justify-content-between align-items-center mb-4">
            <h2 class="fw-bold">
                <i class="fa fa-inbox me-2 text-primary"/> Client Task Queue
                <span class="badge bg-warning text-dark ms-2" t-esc="state.queue.length"/>
            </h2>
            <button class="btn btn-outline-primary" t-on-click="refresh">
                <i class="fa fa-refresh me-1"/> Refresh
            </button>
        </div>

        <div t-if="state.queue.length === 0" class="card p-5 text-center text-muted shadow-sm">
            <i class="fa fa-check-circle fa-3x mb-3 text-success"/>
            <h4 class="text-muted">No pending submissions.</h4>
            <p class="text-muted">When clients submit tasks via the portal or bulk-import XLSX, they appear here for your review.</p>
        </div>

        <t t-if="state.queue.length > 0">
            <div class="alert alert-info">
                <i class="fa fa-info-circle me-2"/>
                Tasks listed here are <strong>NOT</strong> visible to the team yet. Fill in the
                missing details (Ref ID, time estimate, developer) and click <strong>Publish</strong>
                to release each task to the team.
            </div>

            <t t-foreach="state.queue" t-as="q" t-key="q.id">
                <!-- Red border when the client sent it BACK, so a rejected task is
                     distinguishable from a fresh submission at a glance. -->
                <div class="card p-3 mb-3 shadow-sm border-start border-4"
                     t-att-class="q.rejected ? 'border-danger' : 'border-warning'">
                    <!-- Why it came back. The admin reassigns from this screen, so the
                         reason has to live here, not only in the notification. -->
                    <div t-if="q.rejected" class="alert alert-danger py-2 px-3 mb-3 d-flex align-items-start">
                        <i class="fa fa-times-circle me-2 mt-1"/>
                        <div class="small">
                            <div><strong>Client rejected the assignment</strong> — needs a new developer.</div>
                            <div t-if="q.reject_reason">Reason: <strong t-esc="q.reject_reason"/></div>
                            <div class="text-muted">
                                <span t-if="q.rejected_by">by <t t-esc="q.rejected_by"/></span>
                                <span t-if="q.rejected_at"> · <t t-esc="q.rejected_at"/></span>
                            </div>
                        </div>
                    </div>
                    <div class="row g-3">
                        <!-- Header line: submitted by + when + client/project -->
                        <div class="col-12 d-flex justify-content-between align-items-center">
                            <div>
                                <span class="badge me-1"
                                      t-att-class="q.kind === 'bug' ? 'bg-danger' : (q.kind === 'update' ? 'bg-warning text-dark' : 'bg-primary')"
                                      t-esc="q.kind"/>
                                <strong t-esc="q.client_name"/>
                                <span t-if="q.project_name" class="text-muted"> &gt; <t t-esc="q.project_name"/></span>
                            </div>
                            <div class="small text-muted">
                                Submitted by <strong t-esc="q.submitted_by"/>
                                <span t-if="q.submitted_login"> (<t t-esc="q.submitted_login"/>)</span>
                                on <strong t-esc="q.received_at"/>
                            </div>
                        </div>

                        <!-- Editable fields -->
                        <div class="col-md-2">
                            <label class="form-label small fw-bold">Ref ID</label>
                            <input type="text" class="form-control form-control-sm"
                                   t-model="q.external_ref"
                                   placeholder="REQ-001"/>
                        </div>
                        <div class="col-md-2">
                            <label class="form-label small fw-bold">Linked Req</label>
                            <select class="form-select form-select-sm" t-model="q.related_req_ref">
                                <option value="">— none —</option>
                                <t t-foreach="q.req_options or []" t-as="ro" t-key="ro.ref">
                                    <option t-att-value="ro.ref" t-esc="ro.label"/>
                                </t>
                            </select>
                        </div>
                        <div class="col-md-8">
                            <label class="form-label small fw-bold">Task Name</label>
                            <input type="text" class="form-control form-control-sm"
                                   t-model="q.name"/>
                        </div>

                        <div class="col-md-2">
                            <label class="form-label small fw-bold">Estimate Hours</label>
                            <input type="number" min="0" class="form-control form-control-sm"
                                   t-model.number="q.estimate_hours"/>
                        </div>
                        <div class="col-md-2">
                            <label class="form-label small fw-bold">Minutes</label>
                            <input type="number" min="0" max="59" class="form-control form-control-sm"
                                   t-model.number="q.estimate_minutes"/>
                        </div>
                        <div class="col-md-2">
                            <label class="form-label small fw-bold">Priority</label>
                            <select class="form-select form-select-sm" t-model="q.priority">
                                <option value="urgent">Urgent</option>
                                <option value="important">Important</option>
                                <option value="regular">Regular</option>
                            </select>
                        </div>
                        <div class="col-md-6">
                            <label class="form-label small fw-bold">Assign Developer</label>
                            <select class="form-select form-select-sm" t-model="q.user_id">
                                <option value="">-- None --</option>
                                <t t-foreach="state.users" t-as="u" t-key="u.id">
                                    <option t-att-value="u.id" t-esc="u.name"/>
                                </t>
                            </select>
                        </div>

                        <div class="col-12" t-if="q.description">
                            <label class="form-label small fw-bold">Description</label>
                            <textarea class="form-control form-control-sm" rows="2"
                                      t-model="q.description"/>
                        </div>

                        <!-- Actions -->
                        <div class="col-12 d-flex justify-content-end gap-2">
                            <button class="btn btn-sm btn-outline-danger"
                                    t-on-click="() => this.deleteTask(q)">
                                <i class="fa fa-trash me-1"/> Discard
                            </button>
                            <button class="btn btn-sm btn-outline-secondary"
                                    t-on-click="() => this.saveTask(q)">
                                <i class="fa fa-save me-1"/> Save
                            </button>
                            <button class="btn btn-sm btn-success"
                                    t-on-click="() => this.publishTask(q)">
                                <i class="fa fa-paper-plane me-1"/> Save &amp; Publish
                            </button>
                        </div>
                    </div>
                </div>
            </t>
        </t>
    </div>
    `;

    setup() {
        this.state = useState({ queue: [], users: [] });
        onWillStart(async () => {
            const ru = await rpc('/kpi_completion_cert/get_users', {});
            if (ru && ru.status) this.state.users = ru.users || [];
            await this.refresh();
        });
    }

    async refresh() {
        const r = await rpc('/kpi_pending_queue/list', {});
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        this.state.queue = r.queue || [];
    }

    async saveTask(q, silent = false) {
        const r = await rpc('/kpi_pending_queue/update', {
            kpi_id: q.id,
            name: q.name,
            description: q.description,
            external_ref: q.external_ref,
            related_req_ref: q.related_req_ref,
            priority: q.priority,
            estimate_hours: q.estimate_hours || 0,
            estimate_minutes: q.estimate_minutes || 0,
            user_id: q.user_id || false,
        });
        if (!r.status) { alert('Save failed: ' + (r.message || 'unknown')); return false; }
        if (!silent) alert('Saved.');
        return true;
    }

    async publishTask(q) {
        // Save first then publish — keeps the latest edits
        const saved = await this.saveTask(q, true);
        if (!saved) return;
        const r = await rpc('/kpi_pending_queue/publish', { kpi_id: q.id });
        if (!r.status) { alert('Publish failed: ' + (r.message || 'unknown')); return; }
        alert(r.message || 'Published.');
        await this.refresh();
    }

    async deleteTask(q) {
        if (!confirm(`Discard "${q.name}"? This cannot be undone.`)) return;
        const r = await rpc('/kpi_pending_queue/delete', { kpi_id: q.id });
        if (!r.status) { alert('Delete failed: ' + (r.message || 'unknown')); return; }
        await this.refresh();
    }
}

registry.category("actions").add("kpi_pending_queue", KpiPendingQueue);
