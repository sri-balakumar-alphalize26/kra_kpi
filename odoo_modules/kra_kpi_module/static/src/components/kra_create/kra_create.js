/** @odoo-module **/
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { rpc } from "@web/core/network/rpc";

export class KraCreate extends Component {
    static template = xml/* xml */`
        <div class="o_kra_form p-4">

            <h3 class="fw-bold mb-3">Create KRA</h3>

            <!-- FORM -->
            <div class="card p-3">

                <!-- KRA NAME -->
                <div class="mb-3">
                    <label class="form-label fw-bold">KRA Name</label>
                    <input type="text"
                           class="form-control"
                           t-model="state.name"/>
                </div>

                <!-- IS SUB KRA -->
                <div class="form-check mb-3">
                    <input type="checkbox"
                           class="form-check-input"
                           id="checkSub"
                           t-model="state.is_sub"/>
                    <label for="checkSub" class="form-check-label">Is Sub-KRA?</label>
                </div>

                <!-- PARENT KRA DROPDOWN -->
                <t t-if="state.is_sub">
                    <div class="mb-3">
                        <label class="form-label fw-bold">Parent KRA</label>
                        <select class="form-select" t-model="state.parent_id">
                            <option value="">Select Parent</option>
                            <t t-foreach="state.kra_list" t-as="k" t-key="k.id">
                                <option t-att-value="k.id"
                                        t-esc="k.name"/>
                            </t>
                        </select>
                    </div>
                </t>

                <!-- CLIENT USERS — only for main (root / level-2 client) KRAs.
                     Sub-KRAs inherit from their ancestor client KRA. -->
                <t t-if="!state.is_sub">
                    <div class="mb-3">
                        <label class="form-label fw-bold text-danger">
                            <i class="fa fa-users me-1"></i> Client Users
                            <span class="text-muted small fw-normal">
                                (tick the portal users who should see this KRA + its tasks)
                            </span>
                        </label>
                        <div class="border rounded p-2 bg-light" style="max-height: 220px; overflow-y: auto;">
                            <t t-if="state.client_users.length === 0">
                                <div class="text-muted small p-2">
                                    No client portal users exist yet.
                                    Create a user in <b>Settings → Users</b> under the
                                    <i>KRA / KPI Client (Portal)</i> group first,
                                    or use the green 👥 icon on the tree after saving.
                                </div>
                            </t>
                            <t t-else="">
                                <div class="d-flex justify-content-between mb-1">
                                    <span class="small text-muted">
                                        Selected: <b t-esc="state.selected_client_ids.length"/>
                                        / <t t-esc="state.client_users.length"/>
                                    </span>
                                    <div>
                                        <button type="button" class="btn btn-sm btn-link p-0 me-2"
                                                t-on-click="() => this.selectAll()">Select all</button>
                                        <button type="button" class="btn btn-sm btn-link p-0"
                                                t-on-click="() => this.selectNone()">Clear</button>
                                    </div>
                                </div>
                                <t t-foreach="state.client_users" t-as="u" t-key="u.id">
                                    <div class="form-check py-1">
                                        <input class="form-check-input"
                                               type="checkbox"
                                               t-att-id="'cu_' + u.id"
                                               t-att-checked="state.selected_client_ids.includes(u.id) ? 'checked' : ''"
                                               t-on-change="() => this.toggleClient(u.id)"/>
                                        <label class="form-check-label" t-att-for="'cu_' + u.id">
                                            <b t-esc="u.name"/>
                                            <span class="text-muted small ms-2" t-esc="u.login"/>
                                        </label>
                                    </div>
                                </t>
                            </t>
                        </div>
                    </div>
                </t>

                <!-- BUTTONS -->
                <div class="d-flex justify-content-end mt-3">
                    <button class="btn btn-light me-2" t-on-click="cancel">Cancel</button>
                    <button class="btn btn-primary" t-on-click="save">Save</button>
                </div>

            </div>
        </div>
    `;

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");

        this.state = useState({
            name: "",
            is_sub: false,
            parent_id: "",
            kra_list: [],
            client_users: [],          // [{id, name, login}]
            selected_client_ids: [],   // [id, ...] — toggled by checkboxes
        });

        onWillStart(async () => {
            await this.loadParentKras();
            await this.loadClientUsers();
        });
    }

    async loadParentKras() {
        try {
            const result = await this.orm.call("kra.master", "get_parent_kras", []);
            this.state.kra_list = result;
        } catch (e) {
            console.error("Error loading parent KRAs", e);
        }
    }

    async loadClientUsers() {
        try {
            const r = await rpc("/kra_kpi/kra/get_client_users", {});
            if (r && r.status) {
                this.state.client_users = r.users || [];
            }
        } catch (e) {
            console.warn("Error loading client portal users", e);
        }
    }

    toggleClient(id) {
        const ix = this.state.selected_client_ids.indexOf(id);
        if (ix >= 0) {
            this.state.selected_client_ids.splice(ix, 1);
        } else {
            this.state.selected_client_ids.push(id);
        }
    }
    selectAll() {
        this.state.selected_client_ids = this.state.client_users.map(u => u.id);
    }
    selectNone() {
        this.state.selected_client_ids = [];
    }

    async save() {
        if (!this.state.name || !this.state.name.trim()) {
            this.notification.add("KRA Name is required", { type: "warning" });
            return;
        }

        try {
            await this.orm.call("kra.master", "create_kra", [{
                name: this.state.name.trim(),
                is_sub: this.state.is_sub,
                parent_id: this.state.parent_id || false,
                client_user_ids: this.state.is_sub ? [] : this.state.selected_client_ids,
            }]);

            this.notification.add("KRA created successfully", { type: "success" });
            window.location.hash = "/";
        } catch (e) {
            console.error("Error creating KRA:", e);

            // Extract error message from the exception
            let errorMsg = "Error creating KRA";
            if (e.data && e.data.message) {
                errorMsg = e.data.message;
            } else if (e.message) {
                errorMsg = e.message;
            }

            this.notification.add(errorMsg, { type: "danger" });
        }
    }

    cancel() {
        window.location.hash = "/";
    }
}