/** @odoo-module **/
import { Component, xml, useState } from "@odoo/owl";
import { rpc } from "@web/core/network/rpc";


export class KraNode extends Component {
    static template = xml/* xml */`
        <div class="mb-2">

            <!-- MAIN ROW -->
            <div class="d-flex align-items-center">
                <span class="me-2" t-on-click="toggle" style="cursor: pointer;">
                    <t t-if="props.kra.child_ids.length > 0">
                        <i class="fa"
                           t-att-class="state.open ? 'fa-folder-open text-warning' : 'fa-folder text-warning'"
                           style="font-size: 18px; transition: transform 0.15s ease;">
                        </i>
                    </t>
                    <t t-else="">
                        <i class="fa fa-folder text-muted" style="font-size: 18px; cursor: pointer;"></i>
                    </t>
                </span>

                <!-- KRA Name (Editable when in edit mode) -->
                <t t-if="state.editing">
                    <input type="text"
                           class="form-control form-control-sm me-2"
                           style="width: 300px;"
                           t-model="state.editName"
                           t-on-keyup="handleKeyUp"/>
                    <button class="btn btn-sm btn-success me-1" 
                            t-on-click="saveEdit">
                        <i class="fa fa-check"></i>
                    </button>
                    <button class="btn btn-sm btn-secondary" 
                            t-on-click="cancelEdit">
                        <i class="fa fa-times"></i>
                    </button>
                </t>
                <t t-else="">
                    <span class="fw-bold" style="font-size: 15px;" t-esc="props.kra.name" />
                    <span t-if="props.kra.is_client" class="badge bg-info text-dark ms-2"
                          style="font-size: 9px; vertical-align: middle;" title="This KRA is a Client">Client</span>

                    <!-- ✏️ Edit KRA -->
                    <span class="ms-2 text-primary small"
                          t-on-click="startEdit"
                          title="Edit KRA name"
                          style="cursor: pointer;">
                        <i class="fa fa-pencil"></i>
                    </span>

                    <!-- 👥 Assign Clients — visible on CLIENT KRAs (is_client). Pick which
                         Client-role login users belong to this client (client_user_ids). -->
                    <t t-if="props.kra.is_client">
                        <span class="ms-2 text-success small"
                              t-on-click.stop="() => this.openAssignClients()"
                              t-att-title="'Assign client portal users (' + (props.kra.client_user_ids ? props.kra.client_user_ids.length : 0) + ' assigned)'"
                              style="cursor: pointer;">
                            <i class="fa fa-users"></i>
                            <t t-if="props.kra.client_user_ids and props.kra.client_user_ids.length > 0">
                                <span class="badge bg-success ms-1" style="font-size: 9px;"
                                      t-esc="props.kra.client_user_ids.length"/>
                            </t>
                        </span>
                    </t>

                    <!-- 🔥 Delete KRA -->
                    <span class="ms-2 text-danger small"
                          t-on-click.stop="() => this.deleteKra()"
                          title="Delete this KRA"
                          style="cursor: pointer;">
                        <i class="fa fa-trash"></i>
                    </span>
                </t>
            </div>

            <!-- CHILDREN -->
            <t t-if="state.open">
                <div class="ms-4">

                    <!-- SUB-KRA LOOP -->
                    <t t-foreach="props.kra.child_ids" t-as="child" t-key="child.id">
                        <KraNode kra="child"/>
                    </t>

                    <!-- KPI LIST -->
                    <t t-foreach="props.kra.kpi_ids" t-as="kpi" t-key="kpi.id">
                        <div class="ms-4 py-1 d-flex align-items-center">
                            <i class="fa fa-circle text-primary me-2" style="font-size: 8px;"></i>
                            <a t-att-href="'#/kpi_view/' + kpi.id" class="text-decoration-none" style="cursor: pointer; font-size: 14px;">
                                <span t-esc="kpi.name"></span>
                            </a>

                            <!-- 📖 Book icon with manual count badge -->
                            <t t-if="kpi.manual_count > 0">
                                <span class="ms-2 text-info position-relative"
                                      t-on-click="(ev) => viewUserManuals(kpi.id, ev)"
                                      title="View User Manuals"
                                      style="cursor: pointer;">
                                    <i class="fa fa-book"></i>
                                    <span class="badge bg-info" 
                                          style="font-size: 8px; position: absolute; top: -8px; right: -8px;">
                                        <t t-esc="kpi.manual_count"/>
                                    </span>
                                </span>
                            </t>

                            <!-- 🔥 Delete KPI -->
                            <span class="ms-2 text-danger small"
                                  t-on-click="(ev) => deleteKpi(kpi.id, ev)"
                                  title="Delete this KPI"
                                  style="cursor: pointer;">
                                <i class="fa fa-trash"></i>
                            </span>
                        </div>
                    </t>

                </div>
            </t>

        </div>
    `;

    static components = {
        KraNode, KraNode,
    };

    setup() {
        this.state = useState({ 
            open: false,
            editing: false,
            editName: ''
        });
    }

    toggle() {
        this.state.open = !this.state.open;
    }

    startEdit(ev) {
        if (ev) {
            ev.stopPropagation();
        }
        this.state.editing = true;
        this.state.editName = this.props.kra.name;
    }

    cancelEdit() {
        this.state.editing = false;
        this.state.editName = '';
    }

    handleKeyUp(ev) {
        if (ev.key === 'Enter') {
            this.saveEdit();
        } else if (ev.key === 'Escape') {
            this.cancelEdit();
        }
    }

    async saveEdit() {
        const newName = this.state.editName.trim();
        
        if (!newName) {
            alert("KRA name cannot be empty!");
            return;
        }

        if (newName === this.props.kra.name) {
            this.cancelEdit();
            return;
        }

        try {
            const res = await rpc("/kra_kpi/update_kra", { 
                kra_id: this.props.kra.id,
                name: newName
            });

            if (res && res.status) {
                alert("KRA name updated successfully!");
                window.location.reload();
            } else {
                alert("Error updating KRA: " + (res && res.message ? res.message : "Unknown error"));
            }
        } catch (error) {
            console.error("Error updating KRA:", error);
            alert("Failed to update KRA name. Please try again.");
        }
    }

    // ------------------------------------------------------------------ //
    // Assign Clients — opens a modal with a checkbox list of client portal
    // users.  Tick the ones who should see this KRA + its sub-KPIs.  Posts
    // to /kra_kpi/kra/assign_clients (replaces the full set).
    // ------------------------------------------------------------------ //
    async openAssignClients() {
        let res;
        try {
            res = await rpc("/kra_kpi/kra/get_client_users", {});
        } catch (err) {
            alert("Could not load client list. " + (err && err.message || ''));
            return;
        }
        const users = (res && res.users) || [];
        const assigned = new Set((this.props.kra.client_user_ids || []).map(u => u.id));
        if (users.length === 0) {
            alert("No client portal users exist yet. Create a user in the 'KRA / KPI Client' group first.");
            return;
        }
        const rows = users.map(u => `
            <div class="form-check py-1">
                <input class="form-check-input" type="checkbox"
                       id="assign_user_${u.id}"
                       value="${u.id}"
                       ${assigned.has(u.id) ? 'checked' : ''}/>
                <label class="form-check-label" for="assign_user_${u.id}">
                    <b>${(u.name || '').replace(/</g,'&lt;')}</b>
                    <span class="text-muted small ms-2">${(u.login || '').replace(/</g,'&lt;')}</span>
                </label>
            </div>
        `).join('');
        const kraName = (this.props.kra.name || '').replace(/</g,'&lt;');
        const modalHTML = `
            <div class="modal-backdrop fade show" id="kra_assign_backdrop" style="z-index:1040;"></div>
            <div class="modal d-block" tabindex="-1" id="kra_assign_modal" style="z-index:1050;">
                <div class="modal-dialog modal-lg">
                    <div class="modal-content">
                        <div class="modal-header bg-success text-white">
                            <h5 class="modal-title">
                                <i class="fa fa-users me-2"></i>
                                Assign Clients to: ${kraName}
                            </h5>
                            <button type="button" class="btn-close btn-close-white" id="kra_assign_close"></button>
                        </div>
                        <div class="modal-body" style="max-height: 65vh; overflow-y: auto;">
                            <p class="text-muted small">
                                Tick the client portal users who should see this KRA and its sub-KPIs in their portal.
                                Untick to revoke. Each client only sees the KRA(s) they're assigned to.
                            </p>
                            <!-- Inline create-new-client form (hidden by default) -->
                            <div class="d-flex justify-content-between align-items-center mb-2">
                                <span class="fw-bold small text-muted">Existing client portal users</span>
                                <button type="button" class="btn btn-sm btn-outline-primary" id="kra_assign_new_client_toggle">
                                    <i class="fa fa-plus me-1"></i> New Client
                                </button>
                            </div>
                            <div id="kra_assign_new_client_form" class="border rounded p-3 mb-3 bg-light" style="display:none;">
                                <h6 class="mb-3"><i class="fa fa-user-plus me-1 text-primary"></i> Create a new client portal user</h6>
                                <div class="row g-2">
                                    <div class="col-md-6">
                                        <label class="form-label small fw-bold">Name *</label>
                                        <input type="text" class="form-control form-control-sm" id="nc_name" placeholder="e.g. Ravi (POSCo)"/>
                                    </div>
                                    <div class="col-md-6">
                                        <label class="form-label small fw-bold">Login (email or unique id) *</label>
                                        <input type="text" class="form-control form-control-sm" id="nc_login" placeholder="e.g. ravi@posco"/>
                                    </div>
                                    <div class="col-md-6">
                                        <label class="form-label small fw-bold">Phone (WhatsApp, no +)</label>
                                        <input type="text" class="form-control form-control-sm" id="nc_phone" placeholder="e.g. 919000000000"/>
                                    </div>
                                    <div class="col-md-6">
                                        <label class="form-label small fw-bold">Password (leave blank → 6-digit auto)</label>
                                        <input type="text" class="form-control form-control-sm" id="nc_password" placeholder="auto-generate"/>
                                    </div>
                                    <div class="col-12 d-flex gap-2 mt-2">
                                        <button type="button" class="btn btn-sm btn-secondary" id="nc_cancel">Cancel</button>
                                        <button type="button" class="btn btn-sm btn-primary" id="nc_submit">
                                            <i class="fa fa-check me-1"></i> Create &amp; Tick
                                        </button>
                                    </div>
                                </div>
                                <div id="nc_result" class="alert alert-info small mt-2" style="display:none;"></div>
                            </div>
                            <div id="kra_assign_user_list">
                                ${rows}
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-outline-secondary" id="kra_assign_cancel">Cancel</button>
                            <button type="button" class="btn btn-success" id="kra_assign_save">
                                <i class="fa fa-check me-1"></i> Save Assignments
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        const host = document.createElement('div');
        host.innerHTML = modalHTML;
        document.body.appendChild(host);
        const cleanup = () => { host.remove(); };
        document.getElementById('kra_assign_close').addEventListener('click', cleanup);
        document.getElementById('kra_assign_cancel').addEventListener('click', cleanup);

        // Toggle the inline create-client form.
        const newForm = document.getElementById('kra_assign_new_client_form');
        document.getElementById('kra_assign_new_client_toggle').addEventListener('click', () => {
            newForm.style.display = (newForm.style.display === 'none') ? 'block' : 'none';
        });
        document.getElementById('nc_cancel').addEventListener('click', () => {
            newForm.style.display = 'none';
        });
        document.getElementById('nc_submit').addEventListener('click', async () => {
            const payload = {
                name:     document.getElementById('nc_name').value.trim(),
                login:    document.getElementById('nc_login').value.trim(),
                phone:    document.getElementById('nc_phone').value.trim(),
                password: document.getElementById('nc_password').value.trim(),
            };
            const result = document.getElementById('nc_result');
            result.style.display = 'none';
            if (!payload.name || !payload.login) {
                result.className = 'alert alert-danger small mt-2';
                result.textContent = 'Name and Login are required.';
                result.style.display = 'block';
                return;
            }
            try {
                const r = await rpc('/kra_kpi/kra/create_client_user', payload);
                if (!r || !r.status) {
                    result.className = 'alert alert-danger small mt-2';
                    result.textContent = (r && r.message) || 'Create failed.';
                    result.style.display = 'block';
                    return;
                }
                // Append the new user to the list + auto-tick.
                const list = document.getElementById('kra_assign_user_list');
                const row = document.createElement('div');
                row.className = 'form-check py-1';
                row.innerHTML = `
                    <input class="form-check-input" type="checkbox"
                           id="assign_user_${r.user_id}" value="${r.user_id}" checked/>
                    <label class="form-check-label" for="assign_user_${r.user_id}">
                        <b>${(r.name || '').replace(/</g,'&lt;')}</b>
                        <span class="text-muted small ms-2">${(r.login || '').replace(/</g,'&lt;')}</span>
                        <span class="badge bg-success ms-2">NEW</span>
                    </label>
                `;
                list.appendChild(row);
                // Show pretty result + password (if generated).
                result.className = 'alert alert-success small mt-2 mb-0';
                let msg = `✅ Created "${r.name}" (${r.login}).`;
                if (r.generated_password && r.password) {
                    msg += ` Auto-generated password: <b>${r.password}</b>. Share it with the client securely.`;
                }
                result.innerHTML = msg;
                result.style.display = 'block';
                // Clear the form (but leave the result + form visible briefly so the password can be copied).
                document.getElementById('nc_name').value = '';
                document.getElementById('nc_login').value = '';
                document.getElementById('nc_phone').value = '';
                document.getElementById('nc_password').value = '';
            } catch (err) {
                result.className = 'alert alert-danger small mt-2';
                result.textContent = 'Create request failed: ' + (err && err.message || err);
                result.style.display = 'block';
            }
        });
        document.getElementById('kra_assign_save').addEventListener('click', async () => {
            const checked = Array.from(
                document.querySelectorAll('#kra_assign_modal .form-check-input:checked'))
                .map(c => parseInt(c.value, 10))
                .filter(n => !isNaN(n));
            try {
                const r = await rpc("/kra_kpi/kra/assign_clients", {
                    kra_id:   this.props.kra.id,
                    user_ids: checked,
                });
                if (r && r.status) {
                    cleanup();
                    alert(r.message || 'Saved.');
                    window.location.reload();
                } else {
                    alert("Save failed: " + ((r && r.message) || 'unknown'));
                }
            } catch (err) {
                alert("Save request failed: " + (err && err.message || err));
            }
        });
    }

    async deleteKra(ev) {
        if (ev) {
            ev.stopPropagation();
        }

        const ok = confirm("Are you sure you want to delete the KRA?");
        if (!ok) {
            return;
        }

        const res = await rpc("/kra_kpi/delete_kra", { kra_id: this.props.kra.id });

        if (res && res.status) {
            alert("KRA deleted successfully.");
            window.location.reload();
        } else {
            alert("Error deleting KRA: " + (res && res.message ? res.message : "Unknown error"));
        }
    }

    async deleteKpi(id, ev) {
        if (ev) {
            ev.stopPropagation();
        }

        const ok = confirm("Are you sure you want to delete the KPI?");
        if (!ok) {
            return;
        }

        const res = await rpc("/kra_kpi/delete_kpi", { kpi_id: id });

        if (res && res.status) {
            alert("KPI deleted successfully.");
            window.location.reload();
        } else {
            alert("Error deleting KPI: " + (res && res.message ? res.message : "Unknown error"));
        }
    }

    async viewUserManuals(kpiId, ev) {
        if (ev) {
            ev.stopPropagation();
            ev.preventDefault();
        }

        try {
            const result = await rpc('/kpi/manual/list', { kpi_id: kpiId });
            
            if (!result.status || !result.manuals || result.manuals.length === 0) {
                alert('No user manuals found for this KPI.');
                return;
            }

            if (result.manuals.length === 1) {
                const manualId = result.manuals[0].id;
                const viewUrl = `/kpi/manual/view/${manualId}`;
                window.open(viewUrl, '_blank');
                return;
            }

            let message = 'Multiple user manuals available. Select one to view:\n\n';
            result.manuals.forEach((manual, index) => {
                message += `${index + 1}. ${manual.file_name}\n`;
                if (manual.description) {
                    message += `   Description: ${manual.description}\n`;
                }
                message += '\n';
            });
            message += '\nEnter the number (1-' + result.manuals.length + ') of the manual you want to view:';

            const choice = prompt(message);
            
            if (choice === null) {
                return;
            }

            const choiceNum = parseInt(choice);
            if (isNaN(choiceNum) || choiceNum < 1 || choiceNum > result.manuals.length) {
                alert('Invalid selection. Please enter a number between 1 and ' + result.manuals.length);
                return;
            }

            const selectedManual = result.manuals[choiceNum - 1];
            const viewUrl = `/kpi/manual/view/${selectedManual.id}`;
            window.open(viewUrl, '_blank');

        } catch (error) {
            console.error("Error viewing user manuals:", error);
            alert("Failed to load user manuals. Please try again.");
        }
    }
}