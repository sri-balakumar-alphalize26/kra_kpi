/** @odoo-module **/

// Admin LIVE TRACKING — "who is doing what right now" + attendance.
// Polls /kpi_owner/live_tracking every 15s and shows, per developer:
//   • current activity: running task + live elapsed / Break / Lunch / Meeting /
//     Idle / Not started
//   • attendance: Present · Late (came HH:MM) · Absent · Yet to start
// Owner / Coordinator / System only (route is gated server-side too).

import { Component, xml, useState, onWillStart, onMounted, onWillUnmount } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

export class KpiLiveTracking extends Component {

    static template = xml/* xml */`
        <div class="o_kpi_live_tracking p-4">
            <div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
                <h2 class="fw-bold mb-0"><i class="fa fa-street-view me-2"/> Live Tracking</h2>
                <div class="d-flex align-items-center gap-2">
                    <small class="text-muted" t-if="state.as_of">as of <t t-esc="state.as_of"/></small>
                    <button class="btn btn-sm btn-outline-secondary" t-on-click="() => this.load(false)">
                        <i class="fa fa-refresh me-1"/> Refresh
                    </button>
                </div>
            </div>

            <div class="d-flex flex-wrap gap-2 mb-3">
                <span class="badge rounded-pill text-bg-light border">Employees: <b t-esc="state.total"/></span>
                <span class="badge rounded-pill text-bg-success">Present: <b t-esc="state.present"/></span>
                <span class="badge rounded-pill text-bg-primary">Active now: <b t-esc="state.active"/></span>
                <span class="badge rounded-pill text-bg-warning">Late: <b t-esc="state.late"/></span>
                <span class="badge rounded-pill text-bg-danger">Absent: <b t-esc="state.absent"/></span>
                <span class="badge rounded-pill text-bg-light border" t-if="state.cutoff">Absent/late after <t t-esc="state.cutoff"/></span>
            </div>

            <t t-if="state.error"><div class="alert alert-danger" t-esc="state.error"/></t>
            <t t-if="state.loading and state.rows.length === 0">
                <div class="text-muted"><i class="fa fa-spinner fa-spin me-1"/> Loading…</div>
            </t>

            <div class="card shadow-sm" t-if="state.rows.length > 0">
                <div class="card-body p-0">
                    <table class="table table-hover align-middle mb-0">
                        <thead class="table-light">
                            <tr>
                                <th>Employee</th>
                                <th style="width:210px">Attendance</th>
                                <th>Doing now</th>
                            </tr>
                        </thead>
                        <tbody>
                            <t t-foreach="state.rows" t-as="row" t-key="row.user_id">
                                <tr>
                                    <td class="fw-semibold" t-esc="row.name"/>
                                    <td>
                                        <t t-if="row.attendance === 'present'">
                                            <span class="badge text-bg-success">Present</span>
                                            <small class="text-muted ms-1" t-if="row.arrival">at <t t-esc="row.arrival"/></small>
                                        </t>
                                        <t t-elif="row.attendance === 'late'">
                                            <span class="badge text-bg-warning">Late · came <t t-esc="row.arrival"/></span>
                                        </t>
                                        <t t-elif="row.attendance === 'absent'">
                                            <span class="badge text-bg-danger">Absent</span>
                                        </t>
                                        <t t-else="">
                                            <span class="badge text-bg-secondary">Yet to start</span>
                                        </t>
                                    </td>
                                    <td>
                                        <i class="fa fa-circle me-2" style="font-size:8px"
                                           t-att-class="row.active ? 'text-success' : 'text-muted'"/>
                                        <t t-if="row.activity_kind === 'task'">
                                            <span class="badge text-bg-primary"><i class="fa fa-clipboard me-1"/><t t-esc="row.activity_label"/> (<t t-esc="fmtElapsed(row.elapsed_seconds)"/>)</span>
                                        </t>
                                        <t t-elif="row.activity_kind === 'break'">
                                            <span class="badge text-bg-warning"><i class="fa fa-coffee me-1"/>Break (<t t-esc="fmtElapsed(row.elapsed_seconds)"/>)</span>
                                        </t>
                                        <t t-elif="row.activity_kind === 'lunch'">
                                            <span class="badge" style="background:#EA580C;color:#fff"><i class="fa fa-cutlery me-1"/>Lunch (<t t-esc="fmtElapsed(row.elapsed_seconds)"/>)</span>
                                        </t>
                                        <t t-elif="row.activity_kind === 'meeting'">
                                            <span class="badge" style="background:#7C3AED;color:#fff"><i class="fa fa-users me-1"/>Meeting (<t t-esc="fmtElapsed(row.elapsed_seconds)"/>)</span>
                                        </t>
                                        <t t-elif="row.activity_kind === 'no_tasks'">
                                            <span class="badge text-bg-secondary">No tasks (<t t-esc="fmtElapsed(row.elapsed_seconds)"/>)</span>
                                        </t>
                                        <t t-elif="row.activity_kind === 'idle'">
                                            <span class="badge text-bg-light border text-muted">Idle — no task running</span>
                                        </t>
                                        <t t-else="">
                                            <span class="text-muted">Not started</span>
                                        </t>
                                    </td>
                                </tr>
                            </t>
                        </tbody>
                    </table>
                </div>
            </div>

            <t t-if="!state.loading and state.rows.length === 0 and !state.error">
                <div class="alert alert-info">No developers to track.</div>
            </t>
        </div>
    `;

    setup() {
        this.state = useState({
            rows: [], loading: true, error: '', as_of: '', cutoff: '',
            total: 0, present: 0, active: 0, absent: 0, late: 0,
        });
        this._timer = null;
        onWillStart(async () => { await this.load(false); });
        // Poll live every 15s while the screen is open.
        onMounted(() => { this._timer = setInterval(() => this.load(true), 15000); });
        onWillUnmount(() => { if (this._timer) { clearInterval(this._timer); this._timer = null; } });
    }

    async load(silent) {
        if (!silent) this.state.loading = true;
        try {
            const res = await rpc('/kpi_owner/live_tracking', {});
            if (res && res.status) {
                this.state.rows = res.rows || [];
                this.state.as_of = res.as_of || '';
                this.state.cutoff = res.cutoff_display || '';
                this.state.total = res.total || (res.rows || []).length;
                this.state.present = res.present_count || 0;
                this.state.active = res.active_count || 0;
                this.state.absent = res.absent_count || 0;
                this.state.late = res.late_count || 0;
                this.state.error = '';
            } else {
                this.state.error = (res && res.message) || 'Failed to load.';
            }
        } catch (e) {
            this.state.error = (e && e.message) || String(e);
        } finally {
            this.state.loading = false;
        }
    }

    // Seconds → "3h 4min" / "15 min".
    fmtElapsed(secs) {
        secs = Math.max(0, Math.floor(secs || 0));
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        return h > 0 ? `${h}h ${m}min` : `${m} min`;
    }
}

registry.category("actions").add("kpi_live_tracking", KpiLiveTracking);
