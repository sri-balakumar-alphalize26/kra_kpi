/** @odoo-module **/

// Workday Snapshots — the frozen End-Workday summary images, for admins.
//
// date  >  developer  >  image  ->  popup  ->  download
//
// The images are drawn SERVER-SIDE at End Workday (kpi.workday.snapshot). This
// screen only lists and shows them, so it stays a dumb viewer: no rendering, no
// recomputing. That matters — the numbers on a snapshot are frozen, while
// anything recomputed here would drift (the live session computes are mutable,
// which is exactly why the image exists).
//
// Image bytes never travel in the list payload: this tree can hold weeks of days
// and a base64 PNG per row would be megabytes of JSON for pictures nobody opened.
// Display goes through Odoo's own /web/image, download through /web/content —
// both already access-checked, so there is no bespoke file route to get wrong.

import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

export class KpiWorkdaySnapshot extends Component {
    static template = xml/* xml */`
        <div class="o_kra_dashboard p-3" style="position:relative;">
            <div class="alphalize-watermark"/>

            <div class="d-flex align-items-center mb-3">
                <h4 class="mb-0"><i class="fa fa-camera me-2"/> Workday Snapshots</h4>
                <span class="text-muted small ms-3">
                    A frozen picture of each developer's day, saved when they end their workday.
                </span>
                <div class="ms-auto d-flex align-items-center gap-2">
                    <label class="text-muted small mb-0">Show last</label>
                    <select class="form-select form-select-sm" style="width:auto;"
                            t-on-change="onDaysChange">
                        <option value="7">7 days</option>
                        <option value="30" selected="1">30 days</option>
                        <option value="90">90 days</option>
                        <option value="365">1 year</option>
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
                    <i class="fa fa-camera fa-2x mb-2"/>
                    <div>No workday snapshots yet.</div>
                    <div class="small">One is saved automatically each time a developer ends their workday.</div>
                </div>
            </t>
            <t t-else="">
                <t t-foreach="state.days" t-as="day" t-key="day.date">
                    <div class="card mb-2">
                        <!-- Level 1: the date -->
                        <div class="card-header d-flex align-items-center"
                             style="cursor:pointer;" t-on-click="() => this.toggleDate(day.date)">
                            <i t-att-class="state.openDates[day.date] ? 'fa fa-chevron-down me-2' : 'fa fa-chevron-right me-2'"/>
                            <b t-esc="day.label"/>
                            <span class="badge bg-secondary ms-2" t-esc="day.devs.length"/>
                            <span class="text-muted small ms-2">
                                developer<t t-if="day.devs.length != 1">s</t>
                            </span>
                        </div>

                        <t t-if="state.openDates[day.date]">
                            <div class="card-body py-2">
                                <t t-foreach="day.devs" t-as="dev" t-key="dev.snapshot_id">
                                    <div class="border rounded mb-2">
                                        <!-- Level 2: the developer -->
                                        <div class="d-flex align-items-center px-2 py-2"
                                             style="cursor:pointer;"
                                             t-on-click="() => this.toggleDev(dev.snapshot_id)">
                                            <i t-att-class="state.openDevs[dev.snapshot_id] ? 'fa fa-chevron-down me-2 text-muted' : 'fa fa-chevron-right me-2 text-muted'"/>
                                            <b t-esc="dev.name"/>
                                            <!-- The 9h rule, frozen as it was judged on the day -->
                                            <span t-att-class="dev.met_standard ? 'badge bg-success ms-2' : 'badge bg-danger ms-2'">
                                                <t t-esc="dev.presence_display"/>
                                            </span>
                                            <span class="text-muted small ms-2">
                                                presence vs <t t-esc="dev.standard_hours"/>h standard
                                            </span>
                                            <span class="text-muted small ms-3">
                                                Productive <t t-esc="dev.productive_display"/>
                                                · <t t-esc="dev.task_count"/> task<t t-if="dev.task_count != 1">s</t>
                                            </span>
                                        </div>

                                        <!-- Level 3: the image -->
                                        <t t-if="state.openDevs[dev.snapshot_id]">
                                            <div class="px-2 pb-2">
                                                <img t-att-src="imgSrc(dev)"
                                                     class="border rounded"
                                                     style="max-width:100%; cursor:zoom-in; display:block;"
                                                     t-att-alt="dev.name"
                                                     t-on-click="() => this.open(dev)"/>
                                                <div class="mt-2 d-flex gap-2">
                                                    <button class="btn btn-sm btn-outline-primary"
                                                            t-on-click="() => this.open(dev)">
                                                        <i class="fa fa-search-plus me-1"/> View full size
                                                    </button>
                                                    <a class="btn btn-sm btn-outline-secondary"
                                                       t-att-href="dlSrc(dev)">
                                                        <i class="fa fa-download me-1"/> Download
                                                    </a>
                                                    <span class="text-muted small align-self-center ms-2"
                                                          t-if="dev.generated_at">
                                                        Saved <t t-esc="dev.generated_at"/>
                                                    </span>
                                                </div>
                                            </div>
                                        </t>
                                    </div>
                                </t>
                            </div>
                        </t>
                    </div>
                </t>
            </t>

            <!-- Full-size popup -->
            <t t-if="state.viewing">
                <div class="modal-backdrop fade show"/>
                <div class="modal d-block" tabindex="-1" t-on-click="closeViewer">
                    <div class="modal-dialog modal-xl modal-dialog-centered">
                        <div class="modal-content" t-on-click.stop="">
                            <div class="modal-header">
                                <h5 class="modal-title">
                                    <t t-esc="state.viewing.name"/>
                                    <span class="text-muted fw-normal ms-2" t-esc="state.viewing.dateLabel"/>
                                </h5>
                                <button type="button" class="btn-close" t-on-click="closeViewer"/>
                            </div>
                            <div class="modal-body text-center" style="max-height:75vh; overflow:auto;">
                                <img t-att-src="imgSrc(state.viewing)" style="max-width:100%;"
                                     t-att-alt="state.viewing.name"/>
                            </div>
                            <div class="modal-footer">
                                <a class="btn btn-primary" t-att-href="dlSrc(state.viewing)">
                                    <i class="fa fa-download me-1"/> Download
                                </a>
                                <button class="btn btn-secondary" t-on-click="closeViewer">Close</button>
                            </div>
                        </div>
                    </div>
                </div>
            </t>
        </div>`;

    setup() {
        this.state = useState({
            loading: true,
            error: '',
            days: [],
            openDates: {},
            openDevs: {},
            viewing: null,
            limitDays: 30,
        });
        onWillStart(() => this.load());
    }

    async load() {
        this.state.loading = true;
        this.state.error = '';
        try {
            const res = await rpc('/kpi_workday_snapshot/list', { limit_days: this.state.limitDays });
            if (res && res.status) {
                this.state.days = res.days || [];
                // Open the most recent day by default — it is what an admin came for.
                if (this.state.days.length) {
                    this.state.openDates[this.state.days[0].date] = true;
                }
            } else {
                this.state.error = (res && res.message) || 'Could not load snapshots.';
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

    toggleDate(date) { this.state.openDates[date] = !this.state.openDates[date]; }
    toggleDev(id) { this.state.openDevs[id] = !this.state.openDevs[id]; }

    // Odoo's own image/content routes — already access-checked, so there is no
    // bespoke file route here to get wrong. (kpi.workday.snapshot has NO developer
    // ACL, so a developer hitting these URLs directly is refused.)
    imgSrc(dev) {
        return '/web/image/kpi.workday.snapshot/' + dev.snapshot_id + '/image';
    }
    dlSrc(dev) {
        return '/web/content/kpi.workday.snapshot/' + dev.snapshot_id
             + '/image?download=true&filename=' + encodeURIComponent(dev.image_name || 'workday.png');
    }

    open(dev) {
        const day = this.state.days.find(d => (d.devs || []).some(x => x.snapshot_id === dev.snapshot_id));
        this.state.viewing = Object.assign({}, dev, { dateLabel: day ? day.label : '' });
    }
    closeViewer() { this.state.viewing = null; }
}

registry.category("actions").add("kpi_workday_snapshot", KpiWorkdaySnapshot);
