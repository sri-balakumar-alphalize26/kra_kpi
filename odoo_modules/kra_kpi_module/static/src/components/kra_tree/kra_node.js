/** @odoo-module **/
import { Component, xml, useState } from "@odoo/owl";
import { rpc } from "@web/core/network/rpc";


export class KraNode extends Component {
    static template = xml/* xml */`
        <div class="mb-2">
        <div t-if="state.dlg.open" class="modal d-block" tabindex="-1" style="background: rgba(0,0,0,0.5); z-index:2000;">
            <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content">
                    <div t-att-class="'modal-header ' + (state.dlg.okClass === 'btn-danger' ? 'bg-danger text-white' : 'bg-primary text-white')">
                        <h5 class="modal-title" t-esc="state.dlg.title"/>
                        <button type="button" class="btn-close btn-close-white" t-on-click="dlgCancel"/>
                    </div>
                    <div class="modal-body">
                        <p t-if="state.dlg.message" style="white-space:pre-wrap;" t-esc="state.dlg.message"/>
                        <div t-if="state.dlg.input" class="mb-2">
                            <label class="form-label fw-bold">
                                <t t-esc="state.dlg.inputLabel"/>
                                <span t-if="state.dlg.required" class="text-danger">*</span>
                            </label>
                            <textarea class="form-control" rows="3"
                                      t-att-placeholder="state.dlg.placeholder"
                                      t-att-value="state.dlg.value"
                                      t-on-input="(ev) => this.dlgSet(ev.target.value)"/>
                        </div>
                        <div t-if="state.dlg.choices.length" class="list-group">
                            <button t-foreach="state.dlg.choices" t-as="ch" t-key="ch_index"
                                    type="button" class="list-group-item list-group-item-action"
                                    t-on-click="() => this.dlgPick(ch.value)">
                                <div class="fw-bold" t-esc="ch.label"/>
                                <div t-if="ch.hint" class="small text-muted" t-esc="ch.hint"/>
                            </button>
                        </div>
                        <div t-if="state.dlg.error" class="alert alert-danger py-2 mb-0 small mt-2" t-esc="state.dlg.error"/>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" t-on-click="dlgCancel">Cancel</button>
                        <button t-if="!state.dlg.choices.length" type="button"
                                t-att-class="'btn ' + state.dlg.okClass"
                                t-on-click="dlgOk" t-esc="state.dlg.okLabel"/>
                    </div>
                </div>
            </div>
        </div>

        <div t-if="state.toast.show"
             t-att-class="'alert alert-dismissible d-flex align-items-start gap-2 alert-' + state.toast.kind"
             style="position:sticky; top:0; z-index:1080; white-space:pre-wrap;">
            <i t-att-class="'fa mt-1 ' + (state.toast.kind === 'success' ? 'fa-check-circle' : (state.toast.kind === 'danger' ? 'fa-exclamation-circle' : 'fa-info-circle'))"/>
            <div class="flex-grow-1" t-esc="state.toast.text"/>
            <button type="button" class="btn-close" t-on-click="dismissToast"/>
        </div>


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
                                  t-on-click="(ev) => this.deleteKpi(kpi.id, ev)"
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
            // Promise-driven in-page dialog, replacing window.confirm/prompt.
            // Those are the browser's chrome, not ours: unstyleable, and on a work
            // screen they read as something having gone wrong.
            dlg: { open: false, title: '', message: '', okLabel: 'OK', okClass: 'btn-primary',
                   input: false, inputLabel: '', placeholder: '', required: false,
                   value: '', error: '', choices: [], resolve: null },
            toast: { show: false, text: '', kind: 'warning' },
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
            this._toast("KRA name cannot be empty!", 'warning');
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
                this._toast("KRA name updated successfully!", 'success');
                window.location.reload();
            } else {
                this._toast("Error updating KRA: " + (res && res.message ? res.message : "Unknown error"), 'danger');
            }
        } catch (error) {
            console.error("Error updating KRA:", error);
            this._toast("Failed to update KRA name. Please try again.", 'danger');
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
            this._toast("Could not load client list. " + (err && err.message || ''), 'danger');
            return;
        }
        const users = (res && res.users) || [];
        const assigned = new Set((this.props.kra.client_user_ids || []).map(u => u.id));
        if (users.length === 0) {
            this._toast("No client portal users exist yet. Create a user in the 'KRA / KPI Client' group first.", 'warning');
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
                    this._toast(r.message || 'Saved.', 'warning');
                    window.location.reload();
                } else {
                    this._toast("Save failed: " + ((r && r.message) || 'unknown'), 'danger');
                }
            } catch (err) {
                this._toast("Save request failed: " + (err && err.message || err), 'danger');
            }
        });
    }

    async deleteKra(ev) {
        if (ev) {
            ev.stopPropagation();
        }

        const ok = await this._confirm('Delete this KRA?', 'Everything under it goes with it. This cannot be undone.', 'Delete', 'btn-danger');
        if (!ok) {
            return;
        }

        const res = await rpc("/kra_kpi/delete_kra", { kra_id: this.props.kra.id });

        if (res && res.status) {
            this._toast("KRA deleted successfully.", 'success');
            window.location.reload();
        } else {
            this._toast("Error deleting KRA: " + (res && res.message ? res.message : "Unknown error"), 'danger');
        }
    }

    async deleteKpi(id, ev) {
        if (ev) {
            ev.stopPropagation();
        }

        const ok = await this._confirm('Delete this KPI?', 'This cannot be undone.', 'Delete', 'btn-danger');
        if (!ok) {
            return;
        }

        const res = await rpc("/kra_kpi/delete_kpi", { kpi_id: id });

        if (res && res.status) {
            this._toast("KPI deleted successfully.", 'success');
            window.location.reload();
        } else {
            this._toast("Error deleting KPI: " + (res && res.message ? res.message : "Unknown error"), 'danger');
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
                this._toast('No user manuals found for this KPI.', 'warning');
                return;
            }

            if (result.manuals.length === 1) {
                const manualId = result.manuals[0].id;
                const viewUrl = `/kpi/manual/view/${manualId}`;
                window.open(viewUrl, '_blank');
                return;
            }

            const picked = await this._dialog({
                title: 'Which manual?',
                message: `${result.manuals.length} manuals are available for this KRA.`,
                choices: result.manuals.map((m) => ({
                    value: m.id, label: m.file_name, hint: m.description || '',
                })),
            });
            if (picked === null) { return; }
            const selectedManual = result.manuals.find((m) => m.id === picked);
            if (!selectedManual) { return; }
            const viewUrl = `/kpi/manual/view/${selectedManual.id}`;
            window.open(viewUrl, '_blank');

        } catch (error) {
            console.error("Error viewing user manuals:", error);
            this._toast("Failed to load user manuals. Please try again.", 'danger');
        }
    }

    // Errors stay until dismissed — an error that vanishes before it is read is the
    // same as no error at all. Anything else clears itself.
    _toast(text, kind = 'warning') {
        this.state.toast = { show: true, text: String(text == null ? '' : text), kind };
        if (kind !== 'danger') {
            setTimeout(() => { this.state.toast.show = false; }, 4500);
        }
    }
    dismissToast() { this.state.toast.show = false; }


    _dialog({ title, message = '', okLabel = 'OK', okClass = 'btn-primary',
              input = false, inputLabel = '', placeholder = '', required = false,
              choices = [] }) {
        Object.assign(this.state.dlg, {
            open: true, title, message, okLabel, okClass,
            input, inputLabel, placeholder, required, value: '', error: '', choices,
        });
        return new Promise((resolve) => { this.state.dlg.resolve = resolve; });
    }
    _confirm(title, message, okLabel = 'OK', okClass = 'btn-primary') {
        return this._dialog({ title, message, okLabel, okClass });
    }
    dlgSet(v) { this.state.dlg.value = v; this.state.dlg.error = ''; }
    // Choosing from a list is a click, not a number typed into a text box.
    dlgPick(val) {
        const r = this.state.dlg.resolve;
        this.state.dlg.open = false; this.state.dlg.resolve = null;
        if (r) r(val);
    }
    dlgCancel() {
        const r = this.state.dlg.resolve;
        this.state.dlg.open = false; this.state.dlg.resolve = null;
        if (r) r(null);
    }
    dlgOk() {
        const d = this.state.dlg;
        // Stated rather than enforced by disabling OK, so a click that does nothing
        // always says why.
        if (d.input && d.required && !String(d.value || '').trim()) {
            d.error = (d.inputLabel || 'This') + ' is required.';
            return;
        }
        const val = d.input ? d.value : true;
        const r = d.resolve;
        d.open = false; d.resolve = null;
        if (r) r(val);
    }

}