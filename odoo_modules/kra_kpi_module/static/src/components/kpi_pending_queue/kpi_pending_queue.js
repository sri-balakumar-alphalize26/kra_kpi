/** @odoo-module **/
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

/**
 * Client Task Queue — admin-only screen showing KPIs that are awaiting publish.
 * Admin reviews each, sets Ref ID / linked req / estimate / developer / priority,
 * then clicks Publish to make the task visible to the team.
 *
 * Laid out as a drill-down rather than a stack of full-width cards:
 *     Date  ▸  Client  ▸  Task  ▸  the full editable form (one task at a time)
 * Everything starts collapsed — only the dates show — so a long queue stays
 * scannable and you only open what you're working on. Mirrors the mobile app's
 * Client Task Queue screen.
 */
export class KpiPendingQueue extends Component {
    static template = xml/* xml */`
    <div class="o_kpi_pending_queue p-4">
        <div class="d-flex justify-content-between align-items-center mb-4">
            <h2 class="fw-bold">
                <i class="fa fa-inbox me-2 text-primary"/> Client Task Queue
            </h2>
            <div class="d-flex gap-2">
                <!-- Pending: waiting for a decision. 🚫 Refused: declined requests,
                     archived with their reason (kpi_decline), and ↩️ Restore. -->
                <div class="btn-group">
                    <button t-att-class="'btn ' + (state.tab === 'pending' ? 'btn-primary' : 'btn-outline-primary')"
                            t-on-click="() => this.setTab('pending')">
                        Pending <span class="badge bg-warning text-dark ms-1" t-esc="state.queue.length"/>
                    </button>
                    <button t-att-class="'btn ' + (state.tab === 'refused' ? 'btn-danger' : 'btn-outline-danger')"
                            t-on-click="() => this.setTab('refused')">
                        🚫 Refused <span class="badge bg-light text-danger ms-1" t-esc="state.refusedCount"/>
                    </button>
                </div>
                <button class="btn btn-outline-primary" t-on-click="refresh">
                    <i class="fa fa-refresh me-1"/> Refresh
                </button>
            </div>
        </div>

        <t t-if="state.tab === 'refused'">
            <div t-if="!state.refused.length" class="card p-5 text-center text-muted shadow-sm">
                <h4 class="text-muted">Nothing refused.</h4>
                <p class="text-muted">Requests you decline are kept here with their reason, and can be brought back.</p>
            </div>
            <div t-foreach="state.refused" t-as="r" t-key="r.id" class="card shadow-sm mb-2 p-3">
                <div class="d-flex align-items-start gap-3">
                    <div class="flex-grow-1">
                        <div class="fw-bold">
                            <span class="badge bg-danger me-2" t-esc="r.external_ref or ('#' + r.id)"/>
                            <t t-esc="r.name"/>
                        </div>
                        <div class="small text-muted mt-1">
                            <t t-esc="r.client_name"/><t t-if="r.project_name"> · <t t-esc="r.project_name"/></t>
                            · received <t t-esc="r.received_at"/>
                            <t t-if="r.submitted_by"> by <t t-esc="r.submitted_by"/></t>
                        </div>
                        <div class="small mt-2">
                            🚫 Refused <b t-esc="r.declined_at"/> by <b t-esc="r.declined_by or '—'"/>
                            <span t-if="r.decline_count > 1" class="badge bg-secondary ms-1" t-esc="'refused ' + r.decline_count + '×'"/>
                        </div>
                        <div class="small"><b>Reason:</b> <t t-esc="r.reason or '—'"/></div>
                        <div t-if="r.note" class="small text-muted" style="white-space:pre-wrap"><t t-esc="r.note"/></div>
                        <div class="small mt-1"><b>Client answer:</b> <t t-esc="refusedAnswer(r)"/></div>
                        <div t-if="state.openRefused === r.id" class="border-top mt-2 pt-2 small">
                            <div style="white-space:pre-wrap" t-esc="r.description or '(no description)'"/>
                            <div t-if="r.attachments.length" class="mt-1 text-muted">
                                📎 <t t-foreach="r.attachments" t-as="a" t-key="a.id"><t t-esc="a.file_name"/><t t-if="!a_last">, </t></t>
                            </div>
                        </div>
                    </div>
                    <div class="d-flex flex-column gap-2">
                        <button class="btn btn-sm btn-outline-secondary" t-on-click="() => this.state.openRefused = (this.state.openRefused === r.id ? null : r.id)">👁 View</button>
                        <button class="btn btn-sm btn-success" t-on-click="() => this.restoreRefused(r)">↩️ Restore</button>
                    </div>
                </div>
            </div>
        </t>

        <t t-if="state.tab === 'pending'">
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

            <!-- ── Level 1: date ── -->
            <t t-foreach="groups" t-as="g" t-key="g.day">
                <div class="card shadow-sm mb-2 overflow-hidden">
                    <div class="d-flex align-items-center gap-2 px-3 py-3 user-select-none"
                         style="cursor:pointer" t-on-click="() => this.toggleDate(g.day)">
                        <i t-att-class="state.openDates[g.day] ? 'fa fa-chevron-down text-muted' : 'fa fa-chevron-right text-muted'"/>
                        <i class="fa fa-calendar-o text-muted"/>
                        <strong t-esc="g.day"/>
                        <span t-if="g.rejected" class="badge rounded-pill bg-danger">&#160;</span>
                        <span class="ms-auto badge bg-light text-primary border" t-esc="g.count"/>
                    </div>

                    <t t-if="state.openDates[g.day]">
                        <!-- ── Level 2: client ── -->
                        <t t-foreach="g.clients" t-as="c" t-key="c.key">
                            <div class="border-top">
                                <div class="d-flex align-items-center gap-2 py-2 pe-3 bg-light user-select-none"
                                     style="cursor:pointer; padding-left:2.2rem"
                                     t-on-click="() => this.toggleClient(c.key)">
                                    <i t-att-class="state.openClients[c.key] ? 'fa fa-chevron-down text-primary small' : 'fa fa-chevron-right text-primary small'"/>
                                    <i class="fa fa-building-o text-muted small"/>
                                    <span class="fw-bold small" t-esc="c.name"/>
                                    <span t-if="c.rejected" class="badge rounded-pill bg-danger">&#160;</span>
                                    <span class="ms-auto badge bg-white text-muted border" t-esc="c.tasks.length"/>
                                </div>

                                <t t-if="state.openClients[c.key]">
                                    <!-- ── Level 3: task ── -->
                                    <t t-foreach="c.tasks" t-as="q" t-key="q.id">
                                        <div class="border-top">
                                            <div class="d-flex align-items-center gap-2 py-2 pe-3 user-select-none"
                                                 style="cursor:pointer; padding-left:3.4rem"
                                                 t-att-class="q.rejected ? 'bg-danger bg-opacity-10' : (state.openTask === q.id ? 'bg-primary bg-opacity-10' : '')"
                                                 t-on-click="() => this.toggleTask(q.id)">
                                                <i t-att-class="state.openTask === q.id ? 'fa fa-chevron-down text-muted small' : 'fa fa-chevron-right text-muted small'"/>
                                                <span class="badge"
                                                      t-att-class="q.kind === 'bug' ? 'bg-danger' : (q.kind === 'update' ? 'bg-warning text-dark' : 'bg-primary')"
                                                      t-esc="q.kind"/>
                                                <span t-if="q.legacy_req_link" class="badge bg-secondary" title="About a requirement from the old database">🗄️ Old DB</span>
                                                <span t-if="q.legacy_req_link and q.legacy_status !== 'confirmed'" class="badge bg-warning text-dark"
                                                      title="Pending — confirm with client">Pending</span>
                                                <span class="small text-truncate" t-esc="q.name"/>
                                                <i t-if="q.rejected" class="fa fa-times-circle text-danger small"/>
                                                <i t-if="!q.user_id" class="fa fa-user-times text-warning small" title="No developer assigned"/>
                                            </div>

                                            <!-- ── The full editable box, for this task alone ── -->
                                            <t t-if="state.openTask === q.id">
                                                <div class="p-3 border-top bg-white">
                                                    <!-- Why it came back. The admin reassigns from this screen, so
                                                         the reason has to live here, not only in the notification. -->
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
                                                        <div class="col-12 d-flex justify-content-between align-items-center">
                                                            <div class="small text-muted">
                                                                <span t-if="q.project_name"><i class="fa fa-folder-o me-1"/><t t-esc="q.project_name"/></span>
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
                                                                   t-model="q.external_ref" placeholder="REQ-001"/>
                                                        </div>
                                                        <div class="col-md-2">
                                                            <label class="form-label small fw-bold">Linked Req
                                                                <span t-if="q.legacy_req_link" class="badge bg-secondary ms-1">🗄️ Old DB</span>
                                                                <span t-if="q.legacy_req_link and q.legacy_status !== 'confirmed'" class="badge bg-warning text-dark ms-1">Pending</span>
                                                            </label>
                                                            <select class="form-select form-select-sm" t-model="q.related_req_ref">
                                                                <option value="">— none —</option>
                                                                <t t-foreach="q.req_options or []" t-as="ro" t-key="ro.ref">
                                                                    <option t-att-value="ro.ref" t-esc="ro.label"/>
                                                                </t>
                                                            </select>
                                                        </div>
                                                        <div class="col-md-8">
                                                            <label class="form-label small fw-bold">Task Name</label>
                                                            <input type="text" class="form-control form-control-sm" t-model="q.name"/>
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
                                                        <!-- Module / App / EXE. Clients may leave it blank; the
                                                             admin fills it in here. Not required to publish. -->
                                                        <div class="col-md-2">
                                                            <label class="form-label small fw-bold">Type (Module / App / EXE / Other)</label>
                                                            <select class="form-select form-select-sm" t-model="q.deliverable_type">
                                                                <option value="">— choose —</option>
                                                                <option value="module">Module</option>
                                                                <option value="app">App</option>
                                                                <option value="exe">EXE</option>
                                                                <option value="other">Other</option>
                                                            </select>
                                                            <!-- Other: say what it is (required when Other) -->
                                                            <input t-if="q.deliverable_type === 'other'" type="text"
                                                                   class="form-control form-control-sm mt-1" maxlength="40"
                                                                   placeholder="What is it? e.g. Plugin, Website"
                                                                   t-model="q.deliverable_other"/>
                                                        </div>
                                                        <div class="col-md-4">
                                                            <label class="form-label small fw-bold">
                                                                Assign Developer <span class="text-danger">*</span>
                                                            </label>
                                                            <select class="form-select form-select-sm" t-model="q.user_id"
                                                                    t-att-class="!q.user_id ? 'border-warning' : ''">
                                                                <option value="">-- None --</option>
                                                                <t t-foreach="state.users" t-as="u" t-key="u.id">
                                                                    <option t-att-value="u.id" t-esc="u.name"/>
                                                                </t>
                                                            </select>
                                                        </div>

                                                        <!-- Always rendered. The t-if on q.description meant an
                                                             empty description hid the field entirely, so an admin
                                                             could neither read what the developer wrote nor add
                                                             one themselves — the field only appeared once it was
                                                             already filled in, which is backwards. -->
                                                        <div class="col-12">
                                                            <label class="form-label small fw-bold">Description</label>
                                                            <textarea class="form-control form-control-sm" rows="2"
                                                                      placeholder="No description was given — you can add one here."
                                                                      t-model="q.description"/>
                                                        </div>

                                                        <!-- Decline / Reclassify panel.
                                                             Opened from the button row below. Unlike Discard,
                                                             nothing is destroyed: the task is archived with the
                                                             reason stored, and the client is told in their own
                                                             WhatsApp group. -->
                                                        <t t-if="state.declineFor === q.id">
                                                            <div class="col-12">
                                                                <div class="border rounded p-2 bg-body-tertiary">
                                                                    <div class="d-flex gap-2 mb-2">
                                                                        <select class="form-select form-select-sm"
                                                                                style="max-width:170px"
                                                                                t-model="state.declineMode"
                                                                                t-on-change="() => this.loadReasons()">
                                                                            <option value="decline">Decline it</option>
                                                                            <option value="reclassify">Re-type it</option>
                                                                        </select>
                                                                        <select class="form-select form-select-sm"
                                                                                t-model="state.declineReasonId"
                                                                                t-on-change="(ev) => this.onReasonPick(ev)">
                                                                            <option value="">— pick a reason —</option>
                                                                            <t t-foreach="state.reasons" t-as="r" t-key="r.id">
                                                                                <option t-att-value="r.id" t-esc="r.name"/>
                                                                            </t>
                                                                        </select>
                                                                        <select t-if="state.declineMode === 'reclassify'"
                                                                                class="form-select form-select-sm"
                                                                                style="max-width:160px"
                                                                                t-model="state.declineDocType">
                                                                            <option value="">— new type —</option>
                                                                            <option value="requirement">Requirement</option>
                                                                            <option value="update">Update</option>
                                                                            <option value="bug">Bug</option>
                                                                        </select>
                                                                    </div>
                                                                    <textarea class="form-control form-control-sm mb-2" rows="2"
                                                                              placeholder="What the client will be told. Leave empty to send the reason above as written."
                                                                              t-model="state.declineText"/>
                                                                    <div class="d-flex justify-content-between align-items-center">
                                                                        <small class="text-muted">
                                                                            The client is messaged in their own WhatsApp group and asked to confirm.
                                                                        </small>
                                                                        <div class="d-flex gap-2">
                                                                            <button class="btn btn-sm btn-outline-secondary"
                                                                                    t-on-click="() => this.closeDecline()">Cancel</button>
                                                                            <button class="btn btn-sm btn-warning"
                                                                                    t-on-click="() => this.submitDecline(q)">
                                                                                <i class="fa fa-reply me-1"/> Send to client
                                                                            </button>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </t>

                                                        <!-- Actions -->
                                                        <div class="col-12 d-flex justify-content-end gap-2">
                                                            <button class="btn btn-sm btn-outline-warning"
                                                                    t-on-click="() => this.openDecline(q)">
                                                                <i class="fa fa-reply me-1"/> Decline / Re-type
                                                            </button>
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
                                        </div>
                                    </t>
                                </t>
                            </div>
                        </t>
                    </t>
                </div>
            </t>
        </t>
        </t>
    </div>
    `;

    setup() {
        // openDates / openClients are plain objects used as sets (key -> true).
        // Everything starts closed: only the dates are visible on load.
        this.state = useState({
            queue: [], users: [], openDates: {}, openClients: {}, openTask: null,
            // Decline / re-type panel. declineFor holds the task id whose panel
            // is open, so only one is ever open at a time.
            declineFor: null, declineMode: 'decline', declineReasonId: '',
            declineDocType: '', declineText: '', reasons: [],
            // 🚫 Refused list (kpi_decline): archived declined requests.
            tab: 'pending', refused: [], refusedCount: 0, openRefused: null,
        });
        onWillStart(async () => {
            const ru = await rpc('/kpi_completion_cert/get_users', {});
            if (ru && ru.status) this.state.users = ru.users || [];
            await this.refresh();
        });
    }

    /**
     * Date -> Client -> tasks.
     *
     * IMPORTANT: the task arrays hold REFERENCES to the objects in state.queue,
     * never copies. Every field below is bound with t-model, which mutates the
     * object it's given — spreading/cloning here would bind the inputs to throwaway
     * copies and edits would silently never reach saveTask().
     */
    get groups() {
        const byDate = new Map();
        for (const q of this.state.queue) {
            // received_at is pre-formatted 'YYYY-MM-DD HH:MM' — take the date half.
            const day = String(q.received_at || '').split(' ')[0] || 'Unknown';
            if (!byDate.has(day)) byDate.set(day, new Map());
            const byClient = byDate.get(day);
            const name = q.client_name || '—';
            if (!byClient.has(name)) byClient.set(name, []);
            byClient.get(name).push(q);
        }
        const out = [];
        for (const [day, byClient] of byDate.entries()) {
            const clients = [];
            for (const [name, tasks] of byClient.entries()) {
                clients.push({
                    name,
                    key: day + '|' + name,
                    tasks,
                    rejected: tasks.some((t) => t.rejected),
                });
            }
            out.push({
                day,
                clients,
                count: clients.reduce((a, c) => a + c.tasks.length, 0),
                rejected: clients.some((c) => c.rejected),
            });
        }
        return out;
    }

    toggleDate(day) { this.state.openDates[day] = !this.state.openDates[day]; }
    toggleClient(key) { this.state.openClients[key] = !this.state.openClients[key]; }
    toggleTask(id) { this.state.openTask = this.state.openTask === id ? null : id; }

    async refresh() {
        const r = await rpc('/kpi_pending_queue/list', {});
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        // Seed the Other text so its input binds to a real key.
        this.state.queue = (r.queue || []).map((q) => ({ ...q, deliverable_other: q.deliverable_other || '' }));
        this.state.refusedCount = r.refused_count || 0;
        if (this.state.tab === 'refused') await this.loadRefused();
    }

    // ---- 🚫 Refused ------------------------------------------------------
    async setTab(tab) {
        this.state.tab = tab;
        if (tab === 'refused') await this.loadRefused();
    }
    async loadRefused() {
        const r = await rpc('/kpi_pending_queue/refused', {});
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        this.state.refused = r.refused || [];
        this.state.refusedCount = this.state.refused.length;
    }
    refusedAnswer(r) {
        return ({
            pending: '⏳ No answer yet', accepted: '✅ Accepted the refusal',
            disputed: '⚖️ Disagreed', withdrawn: '🗑 Withdrew it', corrected: '✏️ Sent a correction',
        })[r.client_answer] || (r.client_answer_label || '—');
    }
    async restoreRefused(r) {
        if (!confirm(`Bring ${r.external_ref || ('#' + r.id)} back to the client queue? It goes to Pending, where you can publish it or refuse it again.`)) return;
        const res = await rpc('/kpi_pending_queue/restore', { kpi_id: r.id });
        if (!res.status) { alert(res.message || 'Could not restore.'); return; }
        await this.refresh();
        await this.loadRefused();
    }

    async saveTask(q, silent = false) {
        const other = q.deliverable_type === 'other' ? (q.deliverable_other || '').trim() : '';
        if (q.deliverable_type === 'other' && !other) {
            alert('Type what the Other type is (e.g. Plugin, Website).');
            return false;
        }
        const r = await rpc('/kpi_pending_queue/update', {
            kpi_id: q.id,
            name: q.name,
            description: q.description,
            external_ref: q.external_ref,
            related_req_ref: q.related_req_ref,
            priority: q.priority,
            // Blank clears it on the server.
            deliverable_type: q.deliverable_type || '',
            deliverable_other: other,
            estimate_hours: q.estimate_hours || 0,
            estimate_minutes: q.estimate_minutes || 0,
            user_id: q.user_id || false,
        });
        if (!r.status) { alert('Save failed: ' + (r.message || 'unknown')); return false; }
        if (!silent) alert('Saved.');
        return true;
    }

    async publishTask(q) {
        // Save first then publish — keeps the latest edits (and commits the
        // developer before the server checks one is set).
        const saved = await this.saveTask(q, true);
        if (!saved) return;
        const r = await rpc('/kpi_pending_queue/publish', { kpi_id: q.id });
        if (!r.status) { alert('Publish failed: ' + (r.message || 'unknown')); return; }
        alert(r.message || 'Published.');
        this.state.openTask = null;
        await this.refresh();
    }

    // ---- decline / re-type ------------------------------------------------ //
    async openDecline(q) {
        this.state.declineFor = q.id;
        this.state.declineMode = 'decline';
        this.state.declineReasonId = '';
        this.state.declineDocType = '';
        this.state.declineText = '';
        await this.loadReasons();
    }

    closeDecline() {
        this.state.declineFor = null;
        this.state.declineText = '';
    }

    async loadReasons() {
        // Reasons differ by mode, so re-fetch whenever the mode changes rather
        // than filtering client-side — the server owns which reason is valid.
        this.state.declineReasonId = '';
        this.state.declineDocType = '';
        const r = await rpc('/kpi_pending_queue/decline_reasons', {
            mode: this.state.declineMode,
        });
        this.state.reasons = (r && r.reasons) || [];
    }

    onReasonPick(ev) {
        // A reason can carry the type to re-mint as ("Not a bug" -> Update),
        // so picking it pre-selects the type. The admin can still override.
        const id = parseInt(ev.target.value || 0, 10);
        const hit = this.state.reasons.find((x) => x.id === id);
        if (hit && hit.target_doc_type) {
            this.state.declineDocType = hit.target_doc_type;
        }
    }

    async submitDecline(q) {
        if (!this.state.declineReasonId && !this.state.declineText.trim()) {
            alert('Pick a reason or type one — the client is told why.');
            return;
        }
        if (this.state.declineMode === 'reclassify' && !this.state.declineDocType) {
            alert('Choose what to re-type it as.');
            return;
        }
        const r = await rpc('/kpi_pending_queue/decline', {
            kpi_id: q.id,
            mode: this.state.declineMode,
            reason_id: this.state.declineReasonId || false,
            reason_text: this.state.declineText || '',
            doc_type: this.state.declineDocType || false,
        });
        if (!r || !r.status) {
            alert((r && r.message) || 'Could not do that.');
            return;
        }
        // Say plainly whether the client was actually reached. "Saved" alone
        // would let an admin believe a client was told when no group is linked.
        if (r.warning) {
            alert(r.warning);
        } else if (r.mode === 'reclassify') {
            alert(`Re-typed to ${r.external_ref} (was ${r.previous_external_ref}). The client has been asked to confirm.`);
        } else {
            alert('Declined. The client has been told and asked to confirm.');
        }
        this.closeDecline();
        await this.refresh();
    }

    async deleteTask(q) {
        if (!confirm(`Discard "${q.name}"? This cannot be undone.`)) return;
        const r = await rpc('/kpi_pending_queue/delete', { kpi_id: q.id });
        if (!r.status) { alert('Delete failed: ' + (r.message || 'unknown')); return; }
        this.state.openTask = null;
        await this.refresh();
    }
}

registry.category("actions").add("kpi_pending_queue", KpiPendingQueue);
