/** @odoo-module **/
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

export class KpiConfiguration extends Component {
    static template = xml/* xml */`
        <div class="o_kpi_configuration p-4" style="max-width: 860px; margin: 0 auto;">
            <div class="d-flex align-items-center justify-content-between mb-1">
                <h2 class="mb-0"><i class="fa fa-cog me-2 text-secondary"></i> Configuration</h2>
                <span class="badge bg-light text-muted border">Changes save automatically</span>
            </div>
            <p class="text-muted small mb-4">Away timers, urgent-pause recipients, and per-developer WhatsApp numbers.</p>

            <t t-if="state.loading"><div class="text-muted">Loading…</div></t>
            <t t-elif="state.error"><div class="alert alert-danger" t-esc="state.error"/></t>
            <t t-else="">

                <!-- Timers & Away -->
                <div class="card shadow-sm mb-4 border-0" style="border-left: 4px solid #0ea5e9 !important; border-left-style: solid;">
                    <div class="card-header bg-white fw-bold d-flex align-items-center">
                        <i class="fa fa-clock-o me-2 text-info"></i> Timers &amp; Away
                    </div>
                    <div class="card-body">
                        <label class="form-label fw-semibold">Away after (minutes)</label>
                        <div class="input-group" style="max-width:180px;">
                            <input type="number" min="1" class="form-control"
                                   t-model.number="state.away_after_minutes" t-on-change="() => this.saveAway()"/>
                            <span class="input-group-text">min</span>
                            <span t-if="state.savedAway" class="input-group-text text-success bg-white border-success">✓</span>
                        </div>
                        <small class="text-muted d-block mt-2">Minutes with no heartbeat (tab closed / machine asleep)
                            before a running task auto-pauses as "Away". Used by the browser AND the server.</small>

                        <label class="form-label fw-semibold mt-4">Admin accept window (minutes)</label>
                        <div class="input-group" style="max-width:180px;">
                            <input type="number" min="0" class="form-control"
                                   t-model.number="state.admin_accept_minutes"
                                   t-on-change="() => this.saveAdminAccept()"/>
                            <span class="input-group-text">min</span>
                            <span t-if="state.savedAdminAccept" class="input-group-text text-success bg-white border-success">✓</span>
                        </div>
                        <small class="text-muted d-block mt-2">How long a new task waits for a coordinator to
                            <b>Accept</b> it before it is accepted automatically and sent to the client for
                            approval. You keep every power afterwards — re-categorise (Requirement / Update /
                            Bug) or reject it. This only stops an un-triaged task blocking its developer.
                            <b>Set 0</b> to switch auto-accept off and require a human Accept.</small>

                        <label class="form-label fw-semibold mt-4">Client approval window (minutes)</label>
                        <div class="input-group" style="max-width:180px;">
                            <input type="number" min="1" class="form-control"
                                   t-model.number="state.client_approval_minutes"
                                   t-on-change="() => this.saveClientApproval()"/>
                            <span class="input-group-text">min</span>
                            <span t-if="state.savedClientApproval" class="input-group-text text-success bg-white border-success">✓</span>
                        </div>
                        <small class="text-muted d-block mt-2">How long a client has to approve the developer
                            assigned to their task before the task is <b>released</b> for work. Drives the
                            countdown the client sees in the app. Releasing is not approving: the client can
                            still object, and nothing is billable until they sign off at completion.</small>

                        <label class="form-label fw-semibold mt-4">Queue re-nudge gap (minutes)</label>
                        <div class="input-group" style="max-width:180px;">
                            <input type="number" min="1" class="form-control"
                                   t-model.number="state.queue_nudge_minutes"
                                   t-on-change="() => this.saveQueueNudge()"/>
                            <span class="input-group-text">min</span>
                            <span t-if="state.savedQueueNudge" class="input-group-text text-success bg-white border-success">✓</span>
                        </div>
                        <small class="text-muted d-block mt-2">Gap between re-notifying admins about a client task
                            still sitting in the Client Task Queue with no developer.</small>

                        <label class="form-label fw-semibold mt-4">Urgent re-nudge gap (minutes)</label>
                        <div class="input-group" style="max-width:180px;">
                            <input type="number" min="1" class="form-control"
                                   t-model.number="state.urgent_nudge_minutes"
                                   t-on-change="() => this.saveUrgentNudge()"/>
                            <span class="input-group-text">min</span>
                            <span t-if="state.savedUrgentNudge" class="input-group-text text-success bg-white border-success">✓</span>
                        </div>
                        <small class="text-muted d-block mt-2">When a developer taps 🚨 <b>Urgent</b> in the Pause
                            dialog, the owner + coordinators are notified in the app and re-nudged this often
                            <b>until one of them reads it</b> (also stops when the task resumes).</small>
                    </div>
                </div>

                <!-- Daily Task Report & Retention -->
                <div class="card shadow-sm mb-4 border-0" style="border-left: 4px solid #f59e0b !important; border-left-style: solid;">
                    <div class="card-header bg-white fw-bold d-flex align-items-center">
                        <i class="fa fa-file-text-o me-2 text-warning"></i> Daily Task Report &amp; Retention
                    </div>
                    <div class="card-body">
                        <div class="form-check form-switch mb-2">
                            <input type="checkbox" class="form-check-input" role="switch"
                                   t-att-checked="state.daily_report_enabled"
                                   t-on-change="() => this.toggleDailyReport()"/>
                            <label class="form-check-label fw-semibold">Send daily employee task report (PDF) to admins</label>
                            <span t-if="state.savedDailyReport" class="text-success small ms-2">✓ Saved</span>
                        </div>
                        <div class="row g-3" t-if="state.daily_report_enabled">
                            <div class="col-md-4">
                                <label class="form-label fw-semibold">Send time (IST)</label>
                                <input type="time" class="form-control" style="max-width:160px;"
                                       t-att-value="state.daily_report_time"
                                       t-on-change="(ev) => this.saveDailyReportTime(ev)"/>
                            </div>
                            <div class="col-md-5">
                                <label class="form-label fw-semibold">Report covers</label>
                                <select class="form-select" style="max-width:200px;"
                                        t-on-change="(ev) => this.saveDailyReportCoverage(ev)">
                                    <option value="yesterday" t-att-selected="state.daily_report_coverage === 'yesterday'">Previous day</option>
                                    <option value="today" t-att-selected="state.daily_report_coverage === 'today'">Same day</option>
                                </select>
                            </div>
                        </div>
                        <small class="text-muted d-block mt-2">One PDF with every employee's task details for the day,
                            delivered to admins in-app at the time above. Previous day suits a morning send (everyone has
                            ended their workday).</small>

                        <hr class="my-4"/>

                        <label class="form-label fw-semibold">Keep workday snapshot images for</label>
                        <div class="input-group" style="max-width:280px;">
                            <input type="number" min="0" class="form-control"
                                   t-model.number="state.snapshot_retention_number"
                                   t-on-change="() => this.saveSnapshotRetention()"/>
                            <select class="form-select" t-on-change="(ev) => this.saveSnapshotRetentionUnit(ev)">
                                <option value="days" t-att-selected="state.snapshot_retention_unit === 'days'">Days</option>
                                <option value="months" t-att-selected="state.snapshot_retention_unit === 'months'">Months</option>
                                <option value="years" t-att-selected="state.snapshot_retention_unit === 'years'">Years</option>
                            </select>
                            <span t-if="state.savedSnapRetention" class="input-group-text text-success bg-white border-success">✓</span>
                        </div>
                        <small class="text-muted d-block mt-2">Old End-Workday summary images are cleared automatically
                            (the day's stats are kept). <b>0 = keep forever.</b></small>

                        <label class="form-label fw-semibold mt-4">Keep generated report PDFs for</label>
                        <div class="input-group" style="max-width:280px;">
                            <input type="number" min="0" class="form-control"
                                   t-model.number="state.report_retention_number"
                                   t-on-change="() => this.saveReportRetention()"/>
                            <select class="form-select" t-on-change="(ev) => this.saveReportRetentionUnit(ev)">
                                <option value="days" t-att-selected="state.report_retention_unit === 'days'">Days</option>
                                <option value="months" t-att-selected="state.report_retention_unit === 'months'">Months</option>
                                <option value="years" t-att-selected="state.report_retention_unit === 'years'">Years</option>
                            </select>
                            <span t-if="state.savedReportRetention" class="input-group-text text-success bg-white border-success">✓</span>
                        </div>
                        <small class="text-muted d-block mt-2">Reports stay viewable and downloadable until deleted.
                            <b>0 = keep forever.</b></small>
                    </div>
                </div>

                <!-- The "Urgent-pause recipients" card (extra WhatsApp numbers) was removed:
                     those numbers had no user account, so they could only ever be reached over
                     WhatsApp — and task WhatsApp is now off by default. Urgent goes to
                     owner + coordinators in the app instead, re-nudged until read. -->

                <!-- Developers -->
                <div class="card shadow-sm mb-4 border-0" style="border-left: 4px solid #6366f1 !important; border-left-style: solid;">
                    <div class="card-header bg-white fw-bold d-flex align-items-center">
                        <i class="fa fa-users me-2 text-primary"></i> Developers — Multi-task &amp; WhatsApp
                    </div>
                    <div class="card-body">
                        <p class="text-muted small">Multi-task ON lets a developer run more than one task at once (default OFF).
                            The WhatsApp number identifies them in Urgent / auto-away messages (falls back to their partner phone).</p>
                        <table class="table table-hover align-middle mb-0">
                            <thead class="table-light">
                                <tr>
                                    <th>Developer</th>
                                    <th class="text-center" style="width:110px;">Multi-task</th>
                                    <th style="width:430px;">Country &amp; WhatsApp number</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr t-foreach="state.developers" t-as="dev" t-key="dev.id">
                                    <td>
                                        <div class="fw-semibold" t-esc="dev.name"/>
                                        <small class="text-muted" t-esc="dev.login"/>
                                    </td>
                                    <td class="text-center">
                                        <div class="form-check form-switch d-inline-block">
                                            <input type="checkbox" class="form-check-input" role="switch"
                                                   t-att-checked="dev.allow_multitask" t-on-change="() => this.toggleDev(dev)"/>
                                        </div>
                                    </td>
                                    <td>
                                        <select class="form-select form-select-sm mb-1" style="max-width:260px;"
                                                title="Country code for this developer"
                                                t-on-change="(ev) => this.saveDevCountry(dev, ev)">
                                            <option value="" t-att-selected="!dev.country_id">Default (+<t t-esc="state.dial"/>)</option>
                                            <t t-foreach="state.countries" t-as="co" t-key="co.id">
                                                <option t-att-value="co.id" t-att-selected="co.id === dev.country_id" t-esc="co.name + ' (+' + co.phone_code + ')'"/>
                                            </t>
                                        </select>
                                        <div class="input-group input-group-sm" style="max-width:260px;">
                                            <span class="input-group-text">+<t t-esc="dev.dial || state.dial"/></span>
                                            <input type="tel" inputmode="numeric" class="form-control"
                                                   t-att-placeholder="(dev.mobile_length || state.mobileLength) + ' digits'"
                                                   t-att-maxlength="dev.mobile_length || state.mobileLength"
                                                   t-att-value="this.localPart(dev)"
                                                   t-on-input="(ev) => this.onDevWaInput(dev, ev)"
                                                   t-on-change="(ev) => this.saveDevWa(dev, ev)"/>
                                            <span t-if="dev._saved" class="input-group-text text-success bg-white border-success">✓</span>
                                        </div>
                                        <small t-if="dev._savedCountry" class="text-success">✓ Country saved</small>
                                        <small t-if="dev._invalid" class="text-danger">Enter <t t-esc="dev.mobile_length || state.mobileLength"/> digits</small>
                                    </td>
                                </tr>
                                <tr t-if="!state.developers.length"><td colspan="3" class="text-muted">No developers found.</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </t>
        </div>`;

    setup() {
        this.state = useState({
            away_after_minutes: 5,
            // Workflow gate timers (same res.company fields the mobile app edits).
            // Nothing about these windows is hard-coded anywhere — the crons read
            // res.company on every tick, so a change here takes effect within a
            // minute with no restart or upgrade.
            admin_accept_minutes: 5,
            client_approval_minutes: 5,
            queue_nudge_minutes: 30,
            urgent_nudge_minutes: 5,
            developers: [],
            loading: true,
            error: "",
            savedAway: false,
            savedAdminAccept: false,
            savedClientApproval: false,
            savedQueueNudge: false,
            savedUrgentNudge: false,
            // Country / mobile format
            country_id: false,
            dial: "91",
            mobileLength: 10,
            countries: [],
            savedCountry: false,
            // Daily task report schedule + snapshot/report retention.
            daily_report_enabled: true,
            daily_report_time: "10:00",
            daily_report_coverage: "yesterday",
            savedDailyReport: false,
            snapshot_retention_number: 3,
            snapshot_retention_unit: "months",
            savedSnapRetention: false,
            report_retention_number: 3,
            report_retention_unit: "months",
            savedReportRetention: false,
        });
        onWillStart(async () => {
            try {
                const cfg = await rpc("/kpi_config/get", {});
                if (cfg?.status) {
                    if (cfg.away_after_minutes != null) this.state.away_after_minutes = cfg.away_after_minutes;
                    if (cfg.admin_accept_minutes != null) this.state.admin_accept_minutes = cfg.admin_accept_minutes;
                    if (cfg.client_approval_minutes != null) this.state.client_approval_minutes = cfg.client_approval_minutes;
                    if (cfg.queue_nudge_minutes != null) this.state.queue_nudge_minutes = cfg.queue_nudge_minutes;
                    if (cfg.urgent_nudge_minutes != null) this.state.urgent_nudge_minutes = cfg.urgent_nudge_minutes;
                    this.state.country_id = cfg.country_id || false;
                    this.state.dial = String(cfg.country_dial_code || "91");
                    this.state.mobileLength = Number(cfg.mobile_length) || 10;
                    this.state.countries = cfg.countries || [];
                    // Daily report + retention.
                    if (cfg.daily_report_enabled != null) this.state.daily_report_enabled = !!cfg.daily_report_enabled;
                    if (cfg.daily_report_hour != null) this.state.daily_report_time = this.hourToTime(cfg.daily_report_hour);
                    if (cfg.daily_report_coverage) this.state.daily_report_coverage = cfg.daily_report_coverage;
                    if (cfg.snapshot_retention_number != null) this.state.snapshot_retention_number = cfg.snapshot_retention_number;
                    if (cfg.snapshot_retention_unit) this.state.snapshot_retention_unit = cfg.snapshot_retention_unit;
                    if (cfg.report_retention_number != null) this.state.report_retention_number = cfg.report_retention_number;
                    if (cfg.report_retention_unit) this.state.report_retention_unit = cfg.report_retention_unit;
                }
                const devs = await rpc("/kpi_multitask/list", {});
                if (devs?.status) this.state.developers = devs.developers;
            } catch (e) { this.state.error = e?.data?.message || e?.message || "Failed to load configuration."; }
            finally { this.state.loading = false; }
        });
    }

    // Show only the local part (strip a leading dial code) of a developer's
    // stored number, using THAT developer's own dial/length.
    localPart(dev) {
        const len = dev.mobile_length || this.state.mobileLength;
        const dial = dev.dial || this.state.dial;
        let v = String(dev.wa_number || "").replace(/[^\d]/g, "");
        if (dial && v.length > len && v.startsWith(dial)) {
            v = v.slice(dial.length);
        }
        return v.slice(0, len);
    }

    // Digit-only + hard-cap to the developer's country length while typing.
    onDevWaInput(dev, ev) {
        const len = dev.mobile_length || this.state.mobileLength;
        const v = (ev.target.value || "").replace(/[^\d]/g, "").slice(0, len);
        if (ev.target.value !== v) ev.target.value = v;
    }

    // NOTE: toLocalList / urgentPlaceholder / onUrgentInput were removed along
    // with the "Urgent-pause recipients" field — they only existed to format
    // those bare WhatsApp numbers, which are no longer used anywhere.

    async saveCountry(ev) {
        const cid = ev?.target?.value ? parseInt(ev.target.value) : false;
        this.state.country_id = cid;
        try {
            const res = await rpc("/kpi_config/set_country", { country_id: cid });
            if (res?.status) {
                this.state.dial = String(res.dial || "91");
                this.state.mobileLength = Number(res.mobile_length) || 10;
                this._flash(this.state, "savedCountry");
            } else alert(res?.message || "Not authorized.");
        } catch (e) { alert(e?.data?.message || "Failed to save."); }
    }

    _flash(obj, key) {
        obj[key] = true;
        setTimeout(() => { try { obj[key] = false; } catch (e) { /* unmounted */ } }, 1500);
    }

    async saveAway() {
        const val = Math.max(1, parseInt(this.state.away_after_minutes) || 5);
        this.state.away_after_minutes = val;
        try { await rpc("/kpi_config/set_away", { minutes: val }); this._flash(this.state, "savedAway"); }
        catch (e) { alert(e?.data?.message || "Failed to save."); }
    }

    // Drives admin_accept_deadline_at (kpi_workflow.py _admin_accept_minutes) —
    // how long a task waits for a human Accept before the cron does it.
    // Clamped at 0, not 1: 0 is the documented switch that turns auto-accept off
    // entirely, so it must stay reachable from this screen.
    async saveAdminAccept() {
        const parsed = parseInt(this.state.admin_accept_minutes);
        const val = Math.max(0, isNaN(parsed) ? 5 : parsed);
        this.state.admin_accept_minutes = val;
        try { await rpc("/kpi_config/set_admin_accept", { minutes: val }); this._flash(this.state, "savedAdminAccept"); }
        catch (e) { alert(e?.data?.message || "Failed to save."); }
    }

    // Drives pre_approval_release_at (kpi_workflow.py _client_approval_minutes) —
    // i.e. the live countdown the client sees on their approval card in the app,
    // and the point at which the task is released for work.
    async saveClientApproval() {
        const val = Math.max(1, parseInt(this.state.client_approval_minutes) || 5);
        this.state.client_approval_minutes = val;
        try { await rpc("/kpi_config/set_client_approval", { minutes: val }); this._flash(this.state, "savedClientApproval"); }
        catch (e) { alert(e?.data?.message || "Failed to save."); }
    }

    async saveQueueNudge() {
        const val = Math.max(1, parseInt(this.state.queue_nudge_minutes) || 30);
        this.state.queue_nudge_minutes = val;
        try { await rpc("/kpi_config/set_queue_nudge", { minutes: val }); this._flash(this.state, "savedQueueNudge"); }
        catch (e) { alert(e?.data?.message || "Failed to save."); }
    }

    async saveUrgentNudge() {
        const val = Math.max(1, parseInt(this.state.urgent_nudge_minutes) || 5);
        this.state.urgent_nudge_minutes = val;
        try { await rpc("/kpi_config/set_urgent_nudge", { minutes: val }); this._flash(this.state, "savedUrgentNudge"); }
        catch (e) { alert(e?.data?.message || "Failed to save."); }
    }

    async toggleDev(dev) {
        const next = !dev.allow_multitask;
        try {
            const res = await rpc("/kpi_multitask/set", { user_id: dev.id, allow: next });
            if (res.status) dev.allow_multitask = next; else alert(res.message || "Not authorized.");
        } catch (e) { alert(e?.data?.message || "Failed to save."); }
    }

    async saveDevWa(dev, ev) {
        // Keep only digits, capped to the DEVELOPER's country length; strip a
        // pasted dial code.
        const len = dev.mobile_length || this.state.mobileLength;
        const dial = dev.dial || this.state.dial;
        let val = (ev?.target?.value || "").replace(/[^\d]/g, "");
        if (dial && val.length > len && val.startsWith(dial)) {
            val = val.slice(dial.length);
        }
        val = val.slice(0, len);
        if (ev?.target) ev.target.value = val;

        // Flag (but don't block) an incomplete number.
        dev._invalid = val.length > 0 && val.length !== len;

        try {
            const res = await rpc("/kpi_multitask/set_wa", { user_id: dev.id, wa_number: val });
            if (res.status) { dev.wa_number = res.wa_number || val; this._flash(dev, "_saved"); }
            else alert(res.message || "Not authorized.");
        } catch (e) { alert(e?.data?.message || "Failed to save."); }
    }

    // Set this developer's country code (Oman +968 / India +91 / …). Shares the
    // per-person route with Login Management and re-normalizes their WhatsApp
    // number to the new dial. Empty = the company default.
    async saveDevCountry(dev, ev) {
        const cid = ev?.target?.value ? parseInt(ev.target.value) : false;
        try {
            const res = await rpc("/kpi_user_access/set_country", { user_id: dev.id, country_id: cid });
            if (res?.status) {
                dev.country_id = res.country_id || false;
                dev.dial = res.dial || this.state.dial;
                dev.mobile_length = res.mobile_length || this.state.mobileLength;
                if (res.wa_number !== undefined) dev.wa_number = res.wa_number;
                dev._invalid = false;
                this._flash(dev, "_savedCountry");
            } else { alert(res?.message || "Not authorized."); if (ev?.target) ev.target.value = dev.country_id || ""; }
        } catch (e) { alert(e?.data?.message || "Failed to save."); if (ev?.target) ev.target.value = dev.country_id || ""; }
    }

    // ---- Daily report schedule ------------------------------------------
    // Stored server-side as a float hour (10.5 = 10:30); the picker is HH:MM.
    hourToTime(h) {
        const f = Number(h) || 0;
        const H = Math.floor(f);
        const M = Math.round((f - H) * 60);
        const pad = (n) => String(n).padStart(2, "0");
        return `${pad(H)}:${pad(M % 60)}`;
    }
    timeToHour(t) {
        const [H, M] = String(t || "10:00").split(":").map((x) => parseInt(x) || 0);
        return H + M / 60;
    }

    async saveDailyReport() {
        try {
            await rpc("/kpi_config/set_daily_report", {
                enabled: this.state.daily_report_enabled,
                hour: this.timeToHour(this.state.daily_report_time),
                coverage: this.state.daily_report_coverage,
            });
            this._flash(this.state, "savedDailyReport");
        } catch (e) { alert(e?.data?.message || "Failed to save."); }
    }
    toggleDailyReport() {
        this.state.daily_report_enabled = !this.state.daily_report_enabled;
        this.saveDailyReport();
    }
    saveDailyReportTime(ev) {
        this.state.daily_report_time = ev.target.value || "10:00";
        this.saveDailyReport();
    }
    saveDailyReportCoverage(ev) {
        this.state.daily_report_coverage = ev.target.value || "yesterday";
        this.saveDailyReport();
    }

    // ---- Retention (number + Days/Months/Years unit) --------------------
    async saveSnapshotRetention() {
        const number = Math.max(0, parseInt(this.state.snapshot_retention_number) || 0);
        this.state.snapshot_retention_number = number;
        try {
            await rpc("/kpi_config/set_snapshot_retention", { number, unit: this.state.snapshot_retention_unit });
            this._flash(this.state, "savedSnapRetention");
        } catch (e) { alert(e?.data?.message || "Failed to save."); }
    }
    saveSnapshotRetentionUnit(ev) {
        this.state.snapshot_retention_unit = ev.target.value || "months";
        this.saveSnapshotRetention();
    }
    async saveReportRetention() {
        const number = Math.max(0, parseInt(this.state.report_retention_number) || 0);
        this.state.report_retention_number = number;
        try {
            await rpc("/kpi_config/set_report_retention", { number, unit: this.state.report_retention_unit });
            this._flash(this.state, "savedReportRetention");
        } catch (e) { alert(e?.data?.message || "Failed to save."); }
    }
    saveReportRetentionUnit(ev) {
        this.state.report_retention_unit = ev.target.value || "months";
        this.saveReportRetention();
    }
}

registry.category("actions").add("kpi_configuration", KpiConfiguration);
