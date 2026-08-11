/** @odoo-module **/

// My Workday — a developer's own last 30 days: presence, productive and paused
// time per day, with the tasks they touched.
//
// The web port of screens/MyWorkday.js in the app, which has had this since it
// shipped while the web offered developers nothing equivalent — the only workday
// screens here were the admin ones, gated on group_kra_admin.
//
// No new controller work: /kpi_reports/my_workday already exists and is HARD-
// SCOPED to request.env.user (it deliberately ignores any user_id in the
// payload), so it is safe to expose to any logged-in developer as-is.
//
// A dumb viewer on purpose. Every number arrives pre-formatted (*_display) from
// kpi.work.session, and recomputing any of it here would drift from what the
// End Workday summary and the frozen snapshot say.

import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

export class KpiMyWorkday extends Component {
    static template = xml/* xml */`
        <div class="o_kra_dashboard p-3" style="position:relative;">
            <div class="alphalize-watermark"/>

            <div class="d-flex align-items-center mb-3 flex-wrap gap-2">
                <h4 class="mb-0"><i class="fa fa-calendar-check-o me-2"/> My Workday</h4>
                <span class="text-muted small ms-2">
                    Your presence, productive and paused time, day by day.
                </span>
                <div class="ms-auto d-flex align-items-center gap-2">
                    <label class="text-muted small mb-0">Show last</label>
                    <select class="form-select form-select-sm" style="width:auto;" t-on-change="onDaysChange">
                        <option value="7">7 days</option>
                        <option value="30" selected="1">30 days</option>
                        <option value="90">90 days</option>
                    </select>
                    <button class="btn btn-sm btn-outline-secondary" t-on-click="load">
                        <i class="fa fa-refresh"/>
                    </button>
                </div>
            </div>

            <t t-if="state.loading">
                <div class="text-center text-muted py-5">
                    <i class="fa fa-spinner fa-spin fa-2x"/>
                    <div class="mt-2">Loading…</div>
                </div>
            </t>
            <t t-elif="state.error">
                <div class="alert alert-danger"><t t-esc="state.error"/></div>
            </t>
            <t t-elif="!state.days.length">
                <div class="text-center text-muted py-5">
                    <i class="fa fa-calendar-o fa-2x mb-2"/>
                    <div>No workday activity in this period.</div>
                </div>
            </t>
            <t t-else="">
                <t t-foreach="state.days" t-as="day" t-key="day.date">
                    <div class="card mb-2">
                        <div class="card-header d-flex align-items-center flex-wrap gap-2"
                             style="cursor:pointer;" t-on-click="() => this.toggle(day.date)">
                            <i t-att-class="state.open[day.date] ? 'fa fa-chevron-down me-2' : 'fa fa-chevron-right me-2'"/>
                            <b t-esc="day.date"/>
                            <span class="badge bg-secondary ms-2">
                                <t t-esc="day.task_count"/> task<t t-if="day.task_count != 1">s</t>
                            </span>
                            <span class="badge bg-light text-dark border">
                                <t t-esc="day.session_count"/> session<t t-if="day.session_count != 1">s</t>
                            </span>
                            <span class="ms-auto d-flex gap-2 flex-wrap">
                                <span class="badge bg-success">
                                    Productive <t t-esc="day.productive_display"/>
                                </span>
                                <span class="badge bg-primary">
                                    Present <t t-esc="day.presence_display"/>
                                </span>
                                <!-- Only when there was one: a "Paused 0m" chip on
                                     every row is noise, and the app hides it the
                                     same way. -->
                                <span class="badge bg-warning text-dark" t-if="day.paused_seconds">
                                    Paused <t t-esc="day.paused_display"/>
                                </span>
                            </span>
                        </div>

                        <t t-if="state.open[day.date]">
                            <div class="card-body py-2">
                                <t t-if="!day.tasks.length">
                                    <div class="text-muted small">No task time logged on this day.</div>
                                </t>
                                <t t-else="">
                                    <table class="table table-sm mb-0">
                                        <tbody>
                                            <t t-foreach="day.tasks" t-as="task" t-key="task.ref + '-' + task_index">
                                                <tr>
                                                    <td style="width:110px;">
                                                        <span class="badge bg-secondary" t-esc="task.ref or '—'"/>
                                                    </td>
                                                    <td t-esc="task.name"/>
                                                    <td class="text-end fw-semibold" style="width:110px;"
                                                        t-esc="task.hours_display"/>
                                                </tr>
                                            </t>
                                        </tbody>
                                    </table>
                                </t>
                            </div>
                        </t>
                    </div>
                </t>
            </t>
        </div>`;

    setup() {
        this.state = useState({
            loading: true,
            error: '',
            days: [],
            open: {},
            limitDays: 30,
        });
        onWillStart(() => this.load());
    }

    async load() {
        this.state.loading = true;
        this.state.error = '';
        try {
            // The route takes a date range, not a day count.
            const to = new Date();
            const from = new Date(to.getTime() - this.state.limitDays * 86400000);
            const iso = (d) => d.toISOString().slice(0, 10);
            const res = await rpc('/kpi_reports/my_workday', {
                from_date: iso(from),
                to_date: iso(to),
            });
            if (res && res.status) {
                this.state.days = res.days || [];
                // Open today (or the most recent day) — it is what you came for.
                if (this.state.days.length) {
                    this.state.open[this.state.days[0].date] = true;
                }
            } else {
                this.state.error = (res && res.message) || 'Could not load your workday.';
            }
        } catch (e) {
            this.state.error = (e && e.message) || String(e);
        } finally {
            this.state.loading = false;
        }
    }

    onDaysChange(ev) {
        this.state.limitDays = parseInt(ev.target.value) || 30;
        this.load();
    }

    toggle(date) { this.state.open[date] = !this.state.open[date]; }
}

registry.category("actions").add("kpi_my_workday", KpiMyWorkday);
