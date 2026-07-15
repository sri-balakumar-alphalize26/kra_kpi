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

                <!-- Country & Mobile Format -->
                <div class="card shadow-sm mb-4 border-0" style="border-left: 4px solid #16a34a !important; border-left-style: solid;">
                    <div class="card-header bg-white fw-bold d-flex align-items-center">
                        <i class="fa fa-globe me-2 text-success"></i> Country &amp; Mobile Format
                    </div>
                    <div class="card-body">
                        <div class="row g-3 align-items-end">
                            <div class="col-md-6">
                                <label class="form-label fw-semibold">Country</label>
                                <select class="form-select" t-on-change="(ev) => this.saveCountry(ev)">
                                    <option value="" t-att-selected="!state.country_id">— Select —</option>
                                    <t t-foreach="state.countries" t-as="co" t-key="co.id">
                                        <option t-att-value="co.id"
                                                t-att-selected="co.id === state.country_id"
                                                t-esc="co.name + ' (+' + co.phone_code + ')'"/>
                                    </t>
                                </select>
                            </div>
                            <div class="col-md-3">
                                <label class="form-label fw-semibold">Dial code</label>
                                <div class="input-group">
                                    <span class="input-group-text">+</span>
                                    <input type="text" class="form-control bg-light" readonly="readonly"
                                           t-att-value="state.dial"/>
                                </div>
                            </div>
                            <div class="col-md-3">
                                <label class="form-label fw-semibold">Digits</label>
                                <input type="text" class="form-control bg-light" readonly="readonly"
                                       t-att-value="state.mobileLength"/>
                                <span t-if="state.savedCountry" class="text-success small">✓ Saved</span>
                            </div>
                        </div>
                        <small class="text-muted d-block mt-2">Applies to every WhatsApp number below —
                            the <b>+<t t-esc="state.dial"/></b> prefix is added automatically and numbers are
                            limited to <b><t t-esc="state.mobileLength"/> digits</b>.</small>
                    </div>
                </div>

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

                        <label class="form-label fw-semibold mt-4">Client approval window (minutes)</label>
                        <div class="input-group" style="max-width:180px;">
                            <input type="number" min="1" class="form-control"
                                   t-model.number="state.client_approval_minutes"
                                   t-on-change="() => this.saveClientApproval()"/>
                            <span class="input-group-text">min</span>
                            <span t-if="state.savedClientApproval" class="input-group-text text-success bg-white border-success">✓</span>
                        </div>
                        <small class="text-muted d-block mt-2">How long a client has to approve the developer
                            assigned to their task before it is auto-approved. Drives the countdown the client
                            sees in the app.</small>

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
                                    <th style="width:280px;">WhatsApp number</th>
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
                                        <div class="input-group input-group-sm">
                                            <span class="input-group-text">+<t t-esc="state.dial"/></span>
                                            <input type="tel" inputmode="numeric" class="form-control"
                                                   t-att-placeholder="state.mobileLength + ' digits'"
                                                   t-att-maxlength="state.mobileLength"
                                                   t-att-value="this.localPart(dev.wa_number)"
                                                   t-on-input="(ev) => this.onDevWaInput(ev)"
                                                   t-on-change="(ev) => this.saveDevWa(dev, ev)"/>
                                            <span t-if="dev._saved" class="input-group-text text-success bg-white border-success">✓ Saved</span>
                                        </div>
                                        <small t-if="dev._invalid" class="text-danger">Enter <t t-esc="state.mobileLength"/> digits</small>
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
            // Client-workflow timers (same res.company fields the mobile app edits).
            client_approval_minutes: 5,
            queue_nudge_minutes: 30,
            urgent_nudge_minutes: 5,
            developers: [],
            loading: true,
            error: "",
            savedAway: false,
            savedClientApproval: false,
            savedQueueNudge: false,
            savedUrgentNudge: false,
            // Country / mobile format
            country_id: false,
            dial: "91",
            mobileLength: 10,
            countries: [],
            savedCountry: false,
        });
        onWillStart(async () => {
            try {
                const cfg = await rpc("/kpi_config/get", {});
                if (cfg?.status) {
                    if (cfg.away_after_minutes != null) this.state.away_after_minutes = cfg.away_after_minutes;
                    if (cfg.client_approval_minutes != null) this.state.client_approval_minutes = cfg.client_approval_minutes;
                    if (cfg.queue_nudge_minutes != null) this.state.queue_nudge_minutes = cfg.queue_nudge_minutes;
                    if (cfg.urgent_nudge_minutes != null) this.state.urgent_nudge_minutes = cfg.urgent_nudge_minutes;
                    this.state.country_id = cfg.country_id || false;
                    this.state.dial = String(cfg.country_dial_code || "91");
                    this.state.mobileLength = Number(cfg.mobile_length) || 10;
                    this.state.countries = cfg.countries || [];
                }
                const devs = await rpc("/kpi_multitask/list", {});
                if (devs?.status) this.state.developers = devs.developers;
            } catch (e) { this.state.error = e?.data?.message || e?.message || "Failed to load configuration."; }
            finally { this.state.loading = false; }
        });
    }

    // Show only the local part (strip a leading dial code) of a stored number.
    localPart(waNumber) {
        let v = String(waNumber || "").replace(/[^\d]/g, "");
        const dial = this.state.dial;
        if (dial && v.length > this.state.mobileLength && v.startsWith(dial)) {
            v = v.slice(dial.length);
        }
        return v.slice(0, this.state.mobileLength);
    }

    // Digit-only + hard-cap to the country's length while typing.
    onDevWaInput(ev) {
        const v = (ev.target.value || "").replace(/[^\d]/g, "").slice(0, this.state.mobileLength);
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

    // Drives pre_approval_deadline_at (kpi_workflow.py _client_approval_minutes) —
    // i.e. the live countdown the client sees on their approval card in the app.
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
        // Keep only digits, capped to the country length; strip a pasted dial code.
        let val = (ev?.target?.value || "").replace(/[^\d]/g, "");
        if (this.state.dial && val.length > this.state.mobileLength && val.startsWith(this.state.dial)) {
            val = val.slice(this.state.dial.length);
        }
        val = val.slice(0, this.state.mobileLength);
        if (ev?.target) ev.target.value = val;

        // Flag (but don't block) an incomplete number.
        dev._invalid = val.length > 0 && val.length !== this.state.mobileLength;

        try {
            const res = await rpc("/kpi_multitask/set_wa", { user_id: dev.id, wa_number: val });
            if (res.status) { dev.wa_number = res.wa_number || val; this._flash(dev, "_saved"); }
            else alert(res.message || "Not authorized.");
        } catch (e) { alert(e?.data?.message || "Failed to save."); }
    }
}

registry.category("actions").add("kpi_configuration", KpiConfiguration);
