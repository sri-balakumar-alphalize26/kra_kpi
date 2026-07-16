/** @odoo-module **/

import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

export class KpiDeveloperSummary extends Component {

    static template = xml/* xml */`
        <div class="o_kpi_developer_summary p-4">
            <div class="d-flex justify-content-between align-items-center mb-3">
                <h2 class="fw-bold">
                    <i class="fa fa-calendar-check-o me-2"></i> Employee Tracker
                </h2>
            </div>

            <div class="card p-3 mb-3 shadow-sm">
                <div class="row g-3 align-items-end">
                    <div class="col-md-3">
                        <label class="form-label fw-bold">Time frame</label>
                        <select class="form-select" t-model="state.time_frame">
                            <option value="daily">Daily</option>
                            <option value="weekly">Weekly (ISO week)</option>
                            <option value="monthly">Monthly</option>
                        </select>
                    </div>
                    <div class="col-md-3">
                        <label class="form-label fw-bold">Developer</label>
                        <select class="form-select" t-model="state.user_id">
                            <option value="">All Developers</option>
                            <t t-foreach="state.employees" t-as="emp" t-key="emp.id">
                                <option t-att-value="emp.id" t-esc="emp.name"/>
                            </t>
                        </select>
                    </div>
                    <div class="col-md-2">
                        <label class="form-label fw-bold">From</label>
                        <input type="date" class="form-control" t-model="state.from_date"/>
                    </div>
                    <div class="col-md-2">
                        <label class="form-label fw-bold">To</label>
                        <input type="date" class="form-control" t-model="state.to_date"/>
                    </div>
                    <div class="col-md-2">
                        <button class="btn btn-primary w-100"
                                t-on-click="generate"
                                t-att-disabled="state.loading">
                            <t t-if="state.loading"><i class="fa fa-spinner fa-spin me-1"></i> Loading...</t>
                            <t t-else=""><i class="fa fa-search me-1"></i> Generate</t>
                        </button>
                    </div>
                </div>
            </div>

            <t t-if="state.error">
                <div class="alert alert-danger" t-esc="state.error"/>
            </t>

            <t t-if="!state.error and state.periods.length === 0 and state.ranOnce">
                <div class="alert alert-info">No workday sessions / time logs in this range.</div>
            </t>

            <t t-if="state.periods.length > 0">
                <div class="card shadow-sm">
                    <div class="card-body p-0">
                        <table class="table table-hover mb-0">
                            <thead class="table-light">
                                <tr>
                                    <th style="width:32px"></th>
                                    <th>Period</th>
                                    <th>Developer</th>
                                    <th class="text-end">Productive</th>
                                    <th class="text-end">Presence</th>
                                    <th class="text-end">Tasks</th>
                                    <th class="text-end">Sessions</th>
                                </tr>
                            </thead>
                            <tbody>
                                <t t-foreach="state.periods" t-as="row" t-key="row.user_id + '|' + row.period_key">
                                    <tr style="cursor:pointer;"
                                        t-on-click="() => this.toggleExpand(row.user_id + '|' + row.period_key)">
                                        <td>
                                            <i t-att-class="state.expanded[row.user_id + '|' + row.period_key] ? 'fa fa-chevron-down' : 'fa fa-chevron-right'"/>
                                        </td>
                                        <td t-esc="row.label"/>
                                        <td t-esc="row.user_name"/>
                                        <td class="text-end text-success fw-bold" t-esc="row.productive_display"/>
                                        <td class="text-end text-primary fw-bold" t-esc="row.presence_display"/>
                                        <td class="text-end" t-esc="row.task_count"/>
                                        <td class="text-end" t-esc="row.sessions.length"/>
                                    </tr>
                                    <t t-if="state.expanded[row.user_id + '|' + row.period_key]">
                                        <tr>
                                            <td></td>
                                            <td colspan="6" class="bg-light">
                                                <div class="row">
                                                    <div class="col-md-7">
                                                        <h6 class="mb-2"><i class="fa fa-tasks me-1"></i> Tasks worked</h6>
                                                        <table class="table table-sm">
                                                            <thead>
                                                                <tr>
                                                                    <th>Ref</th>
                                                                    <th>Title</th>
                                                                    <th class="text-end">Time</th>
                                                                </tr>
                                                            </thead>
                                                            <tbody>
                                                                <t t-foreach="row.tasks" t-as="t" t-key="t.kpi_id">
                                                                    <tr>
                                                                        <td><b t-esc="t.ref"/></td>
                                                                        <td t-esc="t.name"/>
                                                                        <td class="text-end" t-esc="t.duration_display"/>
                                                                    </tr>
                                                                </t>
                                                                <t t-if="row.tasks.length === 0">
                                                                    <tr><td colspan="3" class="text-muted text-center">No task time logged.</td></tr>
                                                                </t>
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                    <div class="col-md-5">
                                                        <h6 class="mb-2"><i class="fa fa-clock-o me-1"></i> Sessions</h6>
                                                        <table class="table table-sm">
                                                            <thead>
                                                                <tr>
                                                                    <th>Date</th>
                                                                    <th>Login</th>
                                                                    <th>Logout</th>
                                                                </tr>
                                                            </thead>
                                                            <tbody>
                                                                <t t-foreach="row.sessions" t-as="s" t-key="s.session_id">
                                                                    <tr>
                                                                        <td t-esc="s.session_date"/>
                                                                        <td t-esc="s.login_at"/>
                                                                        <td>
                                                                            <t t-esc="s.logout_at || '(open)'"/>
                                                                            <t t-if="s.auto_closed">
                                                                                <span class="badge bg-warning ms-1" title="Auto-closed by cron">auto</span>
                                                                            </t>
                                                                        </td>
                                                                    </tr>
                                                                </t>
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    </t>
                                </t>
                            </tbody>
                        </table>
                    </div>
                </div>
            </t>
        </div>
    `;

    setup() {
        this.state = useState({
            time_frame: 'daily',
            user_id:    '',
            from_date:  '',
            to_date:    '',
            employees:  [],
            periods:    [],
            expanded:   {},
            loading:    false,
            error:      '',
            ranOnce:    false,
        });

        onWillStart(async () => {
            try {
                const res = await rpc('/kpi_reports/employee/get_employees', {});
                this.state.employees = (res && res.employees) || [];
            } catch (e) {
                console.warn('Failed to fetch employee list', e);
            }
        });
    }

    toggleExpand(key) {
        this.state.expanded[key] = !this.state.expanded[key];
    }

    async generate() {
        this.state.loading = true;
        this.state.error = '';
        try {
            const res = await rpc('/kpi_reports/developer_summary', {
                time_frame: this.state.time_frame,
                user_id:    this.state.user_id || null,
                from_date:  this.state.from_date || null,
                to_date:    this.state.to_date || null,
            });
            if (res && res.status) {
                this.state.periods = res.periods || [];
            } else {
                this.state.error = res && res.message || 'Failed to load report.';
                this.state.periods = [];
            }
        } catch (e) {
            this.state.error = (e && e.message) || String(e);
            this.state.periods = [];
        } finally {
            this.state.loading = false;
            this.state.ranOnce = true;
        }
    }
}

registry.category("actions").add("kpi_developer_summary", KpiDeveloperSummary);
