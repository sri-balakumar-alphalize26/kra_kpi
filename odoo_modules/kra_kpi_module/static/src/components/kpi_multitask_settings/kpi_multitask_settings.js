/** @odoo-module **/
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

export class KpiMultitaskSettings extends Component {
    static template = xml/* xml */`
        <div class="o_kpi_multitask_settings p-4">
            <h2 class="mb-1">Multi-task Settings</h2>
            <p class="text-muted">
                Turn <b>ON</b> to let a developer work on more than one task at the same time.
                Default is <b>OFF</b> — one task at a time.
            </p>
            <t t-if="state.loading"><div class="text-muted">Loading developers…</div></t>
            <t t-elif="state.error"><div class="alert alert-danger" t-esc="state.error"/></t>
            <t t-else="">
                <table class="table table-striped" style="max-width:640px;">
                    <thead>
                        <tr><th>Developer</th><th class="text-center" style="width:140px;">Multi-task</th></tr>
                    </thead>
                    <tbody>
                        <tr t-foreach="state.developers" t-as="dev" t-key="dev.id">
                            <td><span t-esc="dev.name"/><small class="text-muted d-block" t-esc="dev.login"/></td>
                            <td class="text-center">
                                <input type="checkbox" class="form-check-input"
                                       t-att-checked="dev.allow_multitask"
                                       t-on-change="() => this.toggle(dev)"/>
                            </td>
                        </tr>
                        <tr t-if="!state.developers.length"><td colspan="2" class="text-muted">No developers found.</td></tr>
                    </tbody>
                </table>
            </t>
        </div>`;

    setup() {
        this.state = useState({ developers: [], loading: true, error: "" });
        onWillStart(async () => {
            try {
                const res = await rpc("/kpi_multitask/list", {});
                if (res.status) { this.state.developers = res.developers; }
                else { this.state.error = res.message || "Failed to load developers."; }
            } catch (e) {
                this.state.error = e?.data?.message || e?.message || "Failed to load developers.";
            } finally { this.state.loading = false; }
        });
    }

    async toggle(dev) {
        const next = !dev.allow_multitask;
        try {
            const res = await rpc("/kpi_multitask/set", { user_id: dev.id, allow: next });
            if (res.status) { dev.allow_multitask = next; }
            else { alert(res.message || "Not authorized."); }
        } catch (e) {
            alert(e?.data?.message || e?.message || "Failed to save. Please try again.");
        }
    }
}

registry.category("actions").add("kpi_multitask_settings", KpiMultitaskSettings);
