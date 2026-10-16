/** @odoo-module **/

// Admin LIVE TRACKING — "who is doing what right now" + attendance.
// Polls /kpi_owner/live_tracking every 15s and shows, per developer:
//   • current activity: running task + live elapsed / Break / Lunch / Meeting /
//     Idle / Not started
//   • attendance: Present · Late (came HH:MM) · Absent · Yet to start
// Owner / Coordinator / System only (route is gated server-side too).

import { Component, xml, useState, onWillStart, onMounted, onWillUnmount, markup } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
import { renderTimelineHtml } from "@kra_kpi_module/components/kpi_workday_timeline/workday_timeline";

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
                                <th style="width:150px"/>
                            </tr>
                        </thead>
                        <tbody>
                            <t t-foreach="state.rows" t-as="row" t-key="row.user_id">
                                <!-- A click opens that person's day in the side panel. -->
                                <tr style="cursor:pointer" title="Open their day"
                                    t-att-class="state.day_for and state.day_for.user_id === row.user_id ? 'table-active' : ''"
                                    t-on-click="() => this.openDay(row)">
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
                                            <!-- One badge per running timer. A multitasking
                                                 developer used to show a single arbitrary task
                                                 here, so the board under-reported what people
                                                 were actually doing. The t-else keeps the old
                                                 single badge if active_tasks ever arrives empty
                                                 on a 'task' row, so this can't render blank. -->
                                            <t t-if="row.active_tasks and row.active_tasks.length">
                                                <span class="badge text-bg-dark me-1" t-if="row.active_task_count > 1">
                                                    <i class="fa fa-clone me-1"/>Multi-tasking <t t-esc="row.active_task_count"/>
                                                </span>
                                                <t t-foreach="row.active_tasks" t-as="at" t-key="at.id">
                                                    <span class="badge text-bg-primary me-1"><i class="fa fa-clipboard me-1"/><t t-esc="at.name"/> (<t t-esc="fmtElapsed(at.elapsed_seconds)"/>)</span>
                                                </t>
                                            </t>
                                            <t t-else="">
                                                <span class="badge text-bg-primary"><i class="fa fa-clipboard me-1"/><t t-esc="row.activity_label"/> (<t t-esc="fmtElapsed(row.elapsed_seconds)"/>)</span>
                                            </t>
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
                                        <!-- Why they're away, in their own words. The badge
                                             above says "Lunch"; this says "back by 2, dentist"
                                             — which is the half that decides whether an admin
                                             needs to do anything about it. -->
                                        <div t-if="row.activity_note" class="small text-muted mt-1"
                                             style="white-space:pre-wrap;" t-esc="row.activity_note"/>
                                        <!-- This day was reopened by an admin. Shown here
                                             because this is the screen the Reopen button is on,
                                             so it is where someone looks for what happened. -->
                                        <div t-if="row.reopened_reason" class="small mt-1 text-warning">
                                            <i class="fa fa-unlock me-1"/>Reopened<t t-if="row.reopened_by"> by <t t-esc="row.reopened_by"/></t>:
                                            <span class="text-muted" t-esc="row.reopened_reason"/>
                                        </div>
                                    </td>
                                    <td class="text-end">
                                        <!-- End Workday is one-way for the developer. This is the
                                             only way back, and it lives here because this is the
                                             screen where an admin can see WHOSE day ended. -->
                                        <button t-if="row.day_done"
                                                class="btn btn-sm btn-outline-warning"
                                                t-att-disabled="state.reverting === row.user_id"
                                                t-on-click.stop="() => this.revertDay(row)">
                                            <t t-if="state.reverting === row.user_id">
                                                <i class="fa fa-spinner fa-spin me-1"/>Reopening…
                                            </t>
                                            <t t-else="">
                                                <i class="fa fa-undo me-1"/>Reopen day
                                            </t>
                                        </button>
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

            <!-- One person's day: the End Workday summary, read by an admin, live.
                 Same payload the developer's own summary is built from. -->
            <t t-if="state.day_for">
                <div class="kpi-lt-backdrop" t-on-click="() => this.closeDay()"/>
                <div class="kpi-lt-panel">
                    <div class="d-flex align-items-center gap-2 p-3 border-bottom bg-white sticky-top">
                        <div class="flex-grow-1">
                            <h4 class="fw-bold mb-0" t-esc="state.day_for.name"/>
                            <small class="text-muted">
                                <t t-if="state.day and state.day.started === false">No workday today</t>
                                <t t-elif="state.day and state.day.logout_at">Day ended</t>
                                <t t-else="">Today so far · updates every 15s</t>
                            </small>
                        </div>
                        <button class="btn btn-sm btn-outline-secondary" t-on-click="() => this.loadDay(false)">
                            <i t-att-class="state.day_loading ? 'fa fa-spinner fa-spin' : 'fa fa-refresh'"/>
                        </button>
                        <button class="btn btn-sm btn-light" t-on-click="() => this.closeDay()"><i class="fa fa-times"/></button>
                    </div>
                    <div class="p-3">
                        <div t-if="state.day_error and !state.day" class="alert alert-danger" t-esc="state.day_error"/>
                        <div t-elif="!state.day" class="text-muted"><i class="fa fa-spinner fa-spin me-1"/> Loading…</div>
                        <div t-elif="state.day.started === false" class="alert alert-info mb-0">
                            <t t-esc="state.day_for.name"/> has not started a workday today.
                        </div>
                        <t t-else="">
                            <t t-set="d" t-value="state.day"/>
                            <div t-if="d.missing_progress and d.missing_progress.length" class="alert alert-warning py-2">
                                <b><t t-esc="d.missing_progress.length"/> task(s) worked today have no progress update</b>
                                <div t-foreach="d.missing_progress" t-as="m" t-key="m_index" class="small">
                                    <t t-esc="m.external_ref"/> <t t-esc="m.name"/>
                                </div>
                            </div>
                            <div class="row g-2 mb-3">
                                <div class="col-6 col-md-3"><div class="kpi-lt-tile"><small>Login</small><b t-esc="d.login_at or '—'"/></div></div>
                                <div class="col-6 col-md-3"><div class="kpi-lt-tile"><small>Productive</small><b class="text-success" t-esc="d.productive_display or '0m'"/></div></div>
                                <div class="col-6 col-md-3"><div class="kpi-lt-tile"><small>Presence</small>
                                    <b t-att-class="d.met_standard ? 'text-success' : 'text-danger'" t-esc="d.presence_display or '0m'"/>
                                    <small t-if="d.standard_display" t-att-class="d.met_standard ? 'text-success' : 'text-danger'"><t t-esc="d.standard_display"/> standard</small></div></div>
                                <div class="col-6 col-md-3"><div class="kpi-lt-tile"><small>Accounted</small><b class="text-primary" t-esc="d.accounted_display or '0m'"/></div></div>
                            </div>
                            <!-- Every start and end of the day. Attendance is the FIRST
                                 start; a restart or a reopen later shows here instead. -->
                            <div t-if="d.sessions and d.sessions.length" class="kpi-lt-log mb-3">
                                <b>🕘 Start / end log</b>
                                <div t-att-class="'small fw-bold mt-1 ' + (d.late ? 'text-warning' : 'text-success')">
                                    First start <t t-esc="d.first_login"/> · <t t-esc="d.late ? 'Late' : 'On time'"/>
                                </div>
                                <table class="table table-sm mb-0 mt-1">
                                    <tbody>
                                        <tr t-foreach="d.sessions" t-as="x" t-key="x.n">
                                            <td class="text-muted fw-bold" style="width:24px" t-esc="x.n"/>
                                            <td>
                                                <b><t t-esc="x.login"/> → <t t-esc="x.open ? 'now' : (x.logout or '—')"/></b>
                                                <span class="text-muted"> · <t t-esc="x.duration_display"/></span>
                                                <div t-if="x.reopened" class="small text-warning fw-semibold">
                                                    ↩ Reopened <t t-esc="x.reopened_at"/><t t-if="x.reopened_by"> by <t t-esc="x.reopened_by"/></t><t t-if="x.reopen_reason"> — <t t-esc="x.reopen_reason"/></t>
                                                </div>
                                            </td>
                                            <td class="text-end">
                                                <span t-if="x.open" class="badge text-bg-primary">● Open</span>
                                                <span t-elif="x.auto_closed" class="badge text-bg-warning">Auto-closed</span>
                                                <span t-else="" class="badge text-bg-light border">Ended</span>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                            <div class="kpi-lt-away mb-3">
                                <b>☕ Away time</b> <small class="text-muted">(inside Presence — never Productive)</small>
                                <div class="d-flex flex-wrap gap-2 mt-2">
                                    <t t-foreach="awayCells(d)" t-as="c" t-key="c[0]">
                                        <div class="kpi-lt-away-cell"><small t-esc="c[0]"/><b t-esc="c[1] or '0m'"/></div>
                                    </t>
                                </div>
                            </div>
                            <h5 class="fw-bold">🗺 Workday Map <small class="text-muted fw-normal">(<t t-esc="d.dev"/>'s day in order)</small></h5>
                            <t t-out="timelineHtml()"/>
                            <h5 class="fw-bold mt-4">Tasks worked today (<t t-esc="(d.tasks or []).length"/>)</h5>
                            <table class="table table-sm mb-0">
                                <thead><tr><th>Ref</th><th>Title</th><th class="text-end">Time</th></tr></thead>
                                <tbody>
                                    <tr t-if="!(d.tasks or []).length"><td colspan="3" class="text-muted text-center">No task time logged.</td></tr>
                                    <tr t-foreach="d.tasks or []" t-as="tk" t-key="tk.kpi_id">
                                        <td class="fw-bold"><t t-if="tk.concurrent">⚡ </t><t t-esc="tk.ref"/></td>
                                        <td t-esc="tk.name"/>
                                        <td class="text-end fw-bold" t-esc="tk.duration_display"/>
                                    </tr>
                                </tbody>
                            </table>
                        </t>
                    </div>
                </div>
            </t>
        </div>
    `;

    setup() {
        this.state = useState({
            rows: [], loading: true, error: '', as_of: '', cutoff: '',
            total: 0, present: 0, active: 0, absent: 0, late: 0,
            reverting: 0,   // user_id currently being reopened
            day_for: null,  // the row whose day is open in the side panel
            day: null, day_error: '', day_loading: false,
        });
        this._timer = null;
        onWillStart(async () => { await this.load(false); });
        // Poll live every 15s while the screen is open.
        onMounted(() => {
            this._timer = setInterval(() => {
                this.load(true);
                if (this.state.day_for) { this.loadDay(true); }
            }, 15000);
        });
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

    // Reopen a developer's explicitly-ended workday. Asks for a reason, because
    // the day's summary has already reached the owner and coordinator and they
    // are about to be told it no longer stands.
    async revertDay(row) {
        const reason = window.prompt(
            `Reopen ${row.name}'s workday?\n\n` +
            "A reason is REQUIRED — it is sent to them word for word, and it is the " +
            'only thing that explains why their day suddenly reopened. Everyone who ' +
            "received the day's summary is told too. Any task they had running stays " +
            'paused until they resume it.\n\nReason:');
        if (reason === null) { return; }        // cancelled
        if (!reason.trim()) {
            this.state.error = 'A reason is required to reopen a workday — the developer is told, in your words.';
            return;
        }
        this.state.reverting = row.user_id;
        try {
            const res = await rpc('/kpi_workday/revert', { user_id: row.user_id, reason });
            if (!res || !res.status) {
                this.state.error = (res && res.message) || 'Could not reopen that workday.';
            } else {
                this.state.error = '';
            }
            await this.load(true);
        } catch (e) {
            this.state.error = (e && e.message) || String(e);
        } finally {
            this.state.reverting = 0;
        }
    }

    // ---- One person's day (side panel) ---------------------------------
    openDay(row) {
        this.state.day_for = row;
        this.state.day = null;
        this.state.day_error = '';
        this.loadDay(false);
    }

    closeDay() {
        this.state.day_for = null;
        this.state.day = null;
        this._daySeq = (this._daySeq || 0) + 1;
    }

    async loadDay(silent) {
        const row = this.state.day_for;
        if (!row) { return; }
        const seq = this._daySeq = (this._daySeq || 0) + 1;
        if (!silent) { this.state.day_loading = true; }
        try {
            const res = await rpc('/kpi_owner/employee_day', { user_id: row.user_id });
            if (seq !== this._daySeq) { return; }
            if (res && res.status) {
                this.state.day = res;
                this.state.day_error = '';
            } else if (!silent) {
                this.state.day_error = (res && res.message) || 'Could not load that day.';
            }
        } catch (e) {
            if (seq === this._daySeq && !silent) { this.state.day_error = (e && e.message) || String(e); }
        } finally {
            if (seq === this._daySeq) { this.state.day_loading = false; }
        }
    }

    awayCells(d) {
        return [
            ['Break', d.break_display], ['Lunch', d.lunch_display], ['Meeting', d.meeting_display],
            ['No tasks', d.no_tasks_display], ['Other', d.other_display],
            ['Away (system)', d.away_display], ['Other/Idle', d.other_idle_display],
        ];
    }

    // The shared Workday Map renderer — same one the End Workday popup uses.
    timelineHtml() {
        return markup(renderTimelineHtml((this.state.day && this.state.day.timeline) || [], Date.now()));
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
