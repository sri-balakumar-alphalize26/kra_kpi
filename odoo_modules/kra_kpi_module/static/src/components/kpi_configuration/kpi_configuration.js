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
                    </div>
                </div>

                <!-- Urgent-pause recipients -->
                <div class="card shadow-sm mb-4 border-0" style="border-left: 4px solid #dc3545 !important; border-left-style: solid;">
                    <div class="card-header bg-white fw-bold d-flex align-items-center">
                        <span class="me-2">🚨</span> Urgent-pause recipients
                    </div>
                    <div class="card-body">
                        <label class="form-label fw-semibold">Extra WhatsApp numbers</label>
                        <div class="input-group">
                            <span class="input-group-text"><i class="fa fa-whatsapp text-success"></i></span>
                            <span class="input-group-text">+<t t-esc="state.dial"/></span>
                            <input type="text" class="form-control" inputmode="numeric"
                                   t-att-placeholder="this.urgentPlaceholder()"
                                   t-att-value="state.urgent_recipients"
                                   t-on-input="(ev) => this.onUrgentInput(ev)"
                                   t-on-change="() => this.saveUrgent()"/>
                            <span t-if="state.savedUrgent" class="input-group-text text-success bg-white border-success">✓</span>
                        </div>
                        <small class="text-muted d-block mt-2">Comma-separated local numbers (<b><t t-esc="state.mobileLength"/> digits</b>
                            each) — the <b>+<t t-esc="state.dial"/></b> code is added automatically on save. When a developer taps
                            the 🚨 <b>Urgent</b> button in the Pause dialog, their note is sent to these numbers. The owner is
                            always included too.</small>
                    </div>
                </div>

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
            urgent_recipients: "",
            developers: [],
            loading: true,
            error: "",
            savedAway: false,
            savedUrgent: false,
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
                    this.state.country_id = cfg.country_id || false;
                    this.state.dial = String(cfg.country_dial_code || "91");
                    this.state.mobileLength = Number(cfg.mobile_length) || 10;
                    this.state.countries = cfg.countries || [];
                    // Show urgent numbers as clean local parts (dial code is the badge).
                    this.state.urgent_recipients = this.toLocalList(cfg.urgent_recipients || "");
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

    // Convert a stored/comma list of numbers into clean LOCAL parts (strip the
    // dial code) for display in the urgent-recipients field.
    toLocalList(raw) {
        const dial = this.state.dial;
        const len = this.state.mobileLength;
        return String(raw || "")
            .split(/[,\n;]+/)
            .map((p) => {
                let d = p.replace(/[^\d]/g, "");
                if (!d) return "";
                if (dial && d.length > len && d.startsWith(dial)) d = d.slice(dial.length);
                return d;
            })
            .filter(Boolean)
            .join(", ");
    }

    urgentPlaceholder() {
        const n = this.state.mobileLength;
        const ex = "9".repeat(n);
        return `${ex}, ${ex}`;
    }

    // Live sanitize: digits + comma separators only, each number capped to the
    // country's local length. Keeps a trailing ", " so the next number can start.
    onUrgentInput(ev) {
        const raw = ev.target.value || "";
        const len = this.state.mobileLength;
        const cleaned = raw.split(",")
            .map((p) => p.replace(/[^\d]/g, "").slice(0, len))
            .join(", ")
            .replace(/\s*,\s*/g, ", ");
        const trailing = /[,\s]$/.test(raw) && !/[,\s]$/.test(cleaned) ? ", " : "";
        const val = cleaned + trailing;
        ev.target.value = val;
        this.state.urgent_recipients = val;
    }

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

    async saveUrgent() {
        try {
            const res = await rpc("/kpi_config/set_urgent", { recipients: this.state.urgent_recipients || "" });
            // Server stores <dial><local>; show clean local parts back in the field.
            if (res?.recipients != null) this.state.urgent_recipients = this.toLocalList(res.recipients);
            this._flash(this.state, "savedUrgent");
        } catch (e) { alert(e?.data?.message || "Failed to save."); }
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
