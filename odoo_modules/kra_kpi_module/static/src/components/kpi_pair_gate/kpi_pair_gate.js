/** @odoo-module **/
// PIN gate shown before the KPI Action Board on the web. The developer opens
// the board on their computer; this gate asks for the PIN generated on their
// mobile app. Entering the correct PIN pairs the devices AND opens the workday
// (so the heartbeat begins detecting "working"), then reveals the board.
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";

export class KpiPairGate extends Component {
    static template = xml/* xml */`
        <div class="o_kpi_pair_gate d-flex align-items-center justify-content-center" style="min-height: 80vh;">
            <t t-if="state.loading">
                <div class="text-muted">Loading…</div>
            </t>
            <t t-elif="state.dayDone">
                <div class="card shadow-sm border-0" style="max-width: 440px; width: 100%;">
                    <div class="card-body p-4 text-center">
                        <div style="font-size: 42px; line-height: 1;">✅</div>
                        <h3 class="mt-3 mb-1 fw-bold">Workday ended for today</h3>
                        <p class="text-muted small mb-0">You've already started and ended your workday
                            today. It's one workday per day — come back tomorrow to start a new one.</p>
                    </div>
                </div>
            </t>
            <t t-else="">
                <div class="card shadow-sm border-0" style="max-width: 440px; width: 100%;">
                    <div class="card-body p-4 text-center">
                        <div style="font-size: 42px; line-height: 1;">🔐</div>
                        <h3 class="mt-3 mb-1 fw-bold">
                            Enter your PIN to <t t-esc="state.mode === 'resume' ? 'continue' : 'start'"/> working
                        </h3>
                        <p class="text-muted small mb-4">
                            <t t-if="state.mode === 'resume'">You went away and your task was paused.
                                Open the KRA/KPI app on your phone, tap <b>Continue Working</b>, and type the
                                PIN it shows here to resume tracking on this computer.</t>
                            <t t-else="">Open the KRA/KPI app on your phone, tap <b>Start Working</b>, and type
                                the PIN it shows here. This starts your workday and begins tracking your task
                                time on this computer.</t>
                        </p>

                        <input type="text" inputmode="numeric" maxlength="4"
                               class="form-control form-control-lg text-center"
                               style="letter-spacing: 12px; font-size: 30px; font-weight: 800;"
                               placeholder="••••"
                               t-att-value="state.pin"
                               t-on-input="(ev) => this.onPinInput(ev)"
                               t-on-keyup="(ev) => this.onKey(ev)"/>

                        <t t-if="state.error">
                            <div class="text-danger small mt-2"><i class="fa fa-exclamation-circle me-1"/>
                                <t t-esc="state.error"/></div>
                        </t>

                        <button class="btn btn-primary btn-lg w-100 mt-4"
                                t-att-disabled="state.verifying || state.pin.length !== 4"
                                t-on-click="() => this.verify()">
                            <t t-if="state.verifying">Checking…</t>
                            <t t-else=""><t t-esc="state.mode === 'resume' ? 'Continue Working' : 'Start Working'"/></t>
                        </button>

                        <p class="text-muted mt-3 mb-0" style="font-size: 12px;">
                            No PIN? Open the app to generate one.</p>
                    </div>
                </div>
            </t>
        </div>`;

    setup() {
        this.action = useService("action");
        this.state = useState({ loading: true, pin: "", error: "", verifying: false, mode: "start", dayDone: false });
        onWillStart(async () => {
            try {
                const res = await rpc("/kpi_pair/status", {});
                // Admins (system / owner / coordinator) skip the PIN entirely.
                if (res?.bypass_gate) { this._openBoard(); return; }
                if (res?.paired) { this._openBoard(); return; }
                // Ended their own workday today → one start + one end per day: no
                // PIN, show the "ended for today" card instead.
                if (res?.day_done) { this.state.dayDone = true; this.state.loading = false; return; }
                if (res?.mode) this.state.mode = res.mode;
            } catch (e) { /* fall through to gate */ }
            this.state.loading = false;
        });
    }

    _openBoard() {
        // Reveal the real board action (replaces this gate in the breadcrumb so
        // browser-Back cannot return to the gate, and — once unpaired — the
        // board's own guard bounces back here).
        this.action.doAction("kra_kpi_module.action_kpi_action_screen", { clearBreadcrumbs: true });
    }

    onPinInput(ev) {
        const v = (ev.target.value || "").replace(/[^\d]/g, "").slice(0, 4);
        ev.target.value = v;
        this.state.pin = v;
        this.state.error = "";
        // Auto-submit the moment 4 digits are entered.
        if (v.length === 4 && !this.state.verifying) this.verify();
    }

    onKey(ev) {
        if (ev.key === "Enter" && this.state.pin.length === 4) this.verify();
    }

    async verify() {
        if (this.state.verifying || !this.state.pin) return;
        this.state.verifying = true;
        this.state.error = "";
        try {
            const res = await rpc("/kpi_pair/verify", { pin: this.state.pin });
            if (res?.ok) { this._openBoard(); return; }
            if (res?.day_done) { this.state.dayDone = true; return; }
            if (res?.reason === "mobile") {
                this.state.error = "Please open this on a computer's web browser — not a phone. Your PIN is still valid.";
                this.state.pin = "";
            } else {
                this.state.error = "Incorrect or expired PIN. Generate a new one in the app.";
            }
        } catch (e) {
            this.state.error = e?.data?.message || "Could not verify. Try again.";
        } finally {
            this.state.verifying = false;
        }
    }
}

registry.category("actions").add("kra_kpi_actions_gate", KpiPairGate);
