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
                            <input type="text" class="form-control"
                                   placeholder="919876543210, 919812345678"
                                   t-model="state.urgent_recipients" t-on-change="() => this.saveUrgent()"/>
                            <span t-if="state.savedUrgent" class="input-group-text text-success bg-white border-success">✓</span>
                        </div>
                        <small class="text-muted d-block mt-2">Comma-separated. When a developer taps the 🚨 <b>Urgent</b>
                            button in the Pause dialog, their note is sent to these numbers. The owner is always included too.</small>
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
                                            <span class="input-group-text"><i class="fa fa-whatsapp text-success"></i></span>
                                            <input type="text" class="form-control"
                                                   placeholder="9198…  (country code + number)"
                                                   t-att-value="dev.wa_number"
                                                   t-on-change="(ev) => this.saveDevWa(dev, ev)"/>
                                            <span t-if="dev._saved" class="input-group-text text-success bg-white border-success">✓ Saved</span>
                                        </div>
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
        });
        onWillStart(async () => {
            try {
                const cfg = await rpc("/kpi_config/get", {});
                if (cfg?.status) {
                    if (cfg.away_after_minutes != null) this.state.away_after_minutes = cfg.away_after_minutes;
                    this.state.urgent_recipients = cfg.urgent_recipients || "";
                }
                const devs = await rpc("/kpi_multitask/list", {});
                if (devs?.status) this.state.developers = devs.developers;
            } catch (e) { this.state.error = e?.data?.message || e?.message || "Failed to load configuration."; }
            finally { this.state.loading = false; }
        });
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
        try { await rpc("/kpi_config/set_urgent", { recipients: this.state.urgent_recipients || "" }); this._flash(this.state, "savedUrgent"); }
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
        // Make the field easy: accept pasted "+91 98…" etc. and keep only digits.
        let val = (ev?.target?.value || "").replace(/[^\d]/g, "");
        if (ev?.target) ev.target.value = val;
        try {
            const res = await rpc("/kpi_multitask/set_wa", { user_id: dev.id, wa_number: val });
            if (res.status) { dev.wa_number = val; this._flash(dev, "_saved"); }
            else alert(res.message || "Not authorized.");
        } catch (e) { alert(e?.data?.message || "Failed to save."); }
    }
}

registry.category("actions").add("kpi_configuration", KpiConfiguration);
