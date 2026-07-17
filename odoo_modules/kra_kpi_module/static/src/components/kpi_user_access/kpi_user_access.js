/** @odoo-module **/
// Login Management (Non-odoo) — admin manages the mobile-app login credentials:
// per-user mobile number, login on/off toggle, password reset, plus last login /
// last device, and the WhatsApp OTP sender number. Changes save automatically.
import { Component, xml, useState, onWillStart, onWillUnmount, markup } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

export class KpiUserAccess extends Component {
    static template = xml/* xml */`
        <div class="o_kpi_user_access p-4" style="max-width: 1000px; margin: 0 auto;">
            <div class="d-flex align-items-center justify-content-between mb-1">
                <h2 class="mb-0"><i class="fa fa-users-cog me-2 text-secondary"></i> Login Management <span class="text-muted fs-5">(Non-odoo)</span></h2>
                <span class="badge bg-light text-muted border">Changes save automatically</span>
            </div>
            <p class="text-muted small mb-4">Mobile-app logins: set each user's mobile number, turn login on/off,
                and reset passwords. Turning login OFF blocks that user everywhere (app AND Odoo).</p>

            <t t-if="state.loading"><div class="text-muted">Loading…</div></t>
            <t t-elif="state.error"><div class="alert alert-danger" t-esc="state.error"/></t>
            <t t-else="">
                <!-- OTP sender number -->
                <div class="card shadow-sm mb-4 border-0" style="border-left: 4px solid #16a34a !important;">
                    <div class="card-header bg-white fw-bold"><i class="fa fa-whatsapp me-2 text-success"></i> Password-reset sender (WhatsApp)</div>
                    <div class="card-body">
                        <!-- WhatsApp server connection (Neonize) -->
                        <label class="form-label fw-semibold d-block mb-2">WhatsApp server that sends the reset codes</label>

                        <!-- Connected -->
                        <t t-if="state.wa_state === 'connected'">
                            <div class="d-flex align-items-center gap-3 flex-wrap">
                                <span class="badge bg-success fs-6"><i class="fa fa-check-circle me-1"/>Connected<t t-if="state.wa_phone">: +<t t-esc="state.wa_phone"/></t></span>
                                <button class="btn btn-outline-danger btn-sm" t-att-disabled="state.wa_busy" t-on-click="() => this.deleteServer()">
                                    <i class="fa fa-trash me-1"/>Delete connection</button>
                            </div>
                            <small class="text-muted d-block mt-2">Password-reset codes are sent from this WhatsApp number.
                                Deleting logs it out of WhatsApp and removes it from the server.</small>
                        </t>

                        <!-- Waiting for the QR to be scanned -->
                        <t t-elif="state.wa_state === 'waiting_qr'">
                            <div class="d-flex align-items-start gap-3 flex-wrap">
                                <div style="background:#fff; padding:8px; border:1px solid #e5e7eb; border-radius:12px;">
                                    <t t-if="state.wa_qr">
                                        <img t-att-src="'data:image/png;base64,' + state.wa_qr" style="width:220px; height:220px; display:block;" alt="WhatsApp QR"/>
                                    </t>
                                    <t t-else="">
                                        <div style="width:220px; height:220px; display:flex; align-items:center; justify-content:center;" class="text-muted">Generating QR…</div>
                                    </t>
                                </div>
                                <div style="max-width:320px;">
                                    <div class="fw-semibold mb-1">Scan to connect</div>
                                    <ol class="text-muted small ps-3 mb-2">
                                        <li>Open WhatsApp on the phone that will send the codes.</li>
                                        <li>Go to <b>Settings → Linked Devices → Link a Device</b>.</li>
                                        <li>Scan this QR code.</li>
                                    </ol>
                                    <div class="d-flex align-items-center gap-2">
                                        <span class="spinner-border spinner-border-sm text-muted"/>
                                        <small class="text-muted">Waiting for you to scan…</small>
                                    </div>
                                    <button class="btn btn-sm btn-link text-danger px-0 mt-1" t-att-disabled="state.wa_busy" t-on-click="() => this.deleteServer()">Cancel</button>
                                </div>
                            </div>
                        </t>

                        <!-- Not connected -->
                        <t t-else="">
                            <button class="btn btn-success" t-att-disabled="state.wa_busy" t-on-click="() => this.connectServer()">
                                <i class="fa fa-whatsapp me-1"/>Connect a new WhatsApp server</button>
                            <small class="text-muted d-block mt-2">Connect the WhatsApp number that will send password-reset codes to users.</small>
                        </t>

                        <div t-if="state.wa_error" class="alert alert-warning py-1 px-2 mt-2 mb-0 small" t-esc="state.wa_error"/>

                        <!-- Reset message: live preview (normal English) + editable wording -->
                        <div class="mt-4">
                            <div class="d-flex align-items-center justify-content-between mb-1">
                                <label class="form-label fw-semibold mb-0">Reset message (WhatsApp)</label>
                                <button class="btn btn-sm btn-outline-secondary" t-on-click="() => this.resetOtpDefault()">
                                    <i class="fa fa-undo me-1"/>Reset to default</button>
                            </div>

                            <!-- What the user actually receives, in plain English -->
                            <small class="text-muted d-block mb-1"><i class="fa fa-whatsapp me-1 text-success"/>Preview — exactly what your team receives:</small>
                            <div style="background:#dcf8c6; border-radius:12px; padding:12px 14px; max-width:440px; white-space:pre-wrap; font-size:14px; line-height:1.5; box-shadow:0 1px 2px rgba(0,0,0,0.12); color:#111;"
                                 t-out="state.otp_preview"/>

                            <!-- Editable wording -->
                            <label class="form-label text-muted small mt-3 mb-1 d-block">Edit the wording:</label>
                            <textarea class="form-control" rows="7" style="font-family: inherit;"
                                      t-att-value="state.otp_template"
                                      t-on-input="(ev) => this.onOtpInput(ev)"
                                      t-on-change="(ev) => this.saveOtpMessage(ev)"/>
                            <small class="text-muted d-block mt-1">Write it in plain English. The person's name, their code and the
                                number of minutes are filled in automatically — the preview above shows exactly what they'll get.
                                <span t-if="state.savedOtp" class="text-success">✓ Saved</span></small>
                        </div>
                    </div>
                </div>

                <!-- Users table -->
                <div class="card shadow-sm border-0" style="border-left: 4px solid #6366f1 !important;">
                    <div class="card-header bg-white fw-bold d-flex align-items-center justify-content-between">
                        <span><i class="fa fa-user me-2 text-primary"></i> Team Members</span>
                        <select class="form-select form-select-sm" style="width:auto; min-width:150px;"
                                t-on-change="(ev) => this.setRoleFilter(ev)">
                            <option value="all" t-att-selected="state.roleFilter === 'all'">All roles</option>
                            <option value="admin" t-att-selected="state.roleFilter === 'admin'">Admin</option>
                            <option value="developer" t-att-selected="state.roleFilter === 'developer'">User</option>
                            <option value="client" t-att-selected="state.roleFilter === 'client'">Client</option>
                        </select>
                    </div>
                    <div class="card-body">
                        <table class="table table-hover align-middle mb-0">
                            <thead class="table-light">
                                <tr>
                                    <th>Name</th>
                                    <th style="width:130px;">Role</th>
                                    <th style="width:190px;">Mobile (login)</th>
                                    <th style="width:150px;">Last login</th>
                                    <th style="width:150px;">Last device</th>
                                    <th class="text-center" style="width:90px;">Login</th>
                                    <th style="width:130px;">Password</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr t-foreach="filteredUsers" t-as="u" t-key="u.id">
                                    <td>
                                        <div class="fw-semibold" t-esc="u.name"/>
                                        <small class="text-muted" t-esc="u.login"/>
                                    </td>
                                    <td>
                                        <select class="form-select form-select-sm" t-att-disabled="u.is_system"
                                                t-on-change="(ev) => this.saveRole(u, ev)">
                                            <option value="admin" t-att-selected="u.role === 'admin'">Admin</option>
                                            <option value="developer" t-att-selected="u.role === 'developer'">User</option>
                                            <option value="client" t-att-selected="u.role === 'client'">Client</option>
                                        </select>
                                        <span t-if="u._savedRole" class="text-success" style="font-size:11px;">✓ Saved</span>
                                    </td>
                                    <td style="min-width:230px;">
                                        <select class="form-select form-select-sm mb-1"
                                                title="Country code for this person"
                                                t-on-change="(ev) => this.saveCountry(u, ev)">
                                            <option value="" t-att-selected="!u.country_id">Default (+<t t-esc="state.dial"/>)</option>
                                            <t t-foreach="state.countries" t-as="co" t-key="co.id">
                                                <option t-att-value="co.id" t-att-selected="co.id === u.country_id"><t t-esc="co.name"/> (+<t t-esc="co.phone_code"/>)</option>
                                            </t>
                                        </select>
                                        <div class="input-group input-group-sm">
                                            <span class="input-group-text">+<t t-esc="u.dial || state.dial"/></span>
                                            <input type="text" class="form-control" inputmode="numeric"
                                                   placeholder="not set" t-att-maxlength="u.mobile_length || state.mobile_length"
                                                   t-att-value="u.mobile" t-on-change="(ev) => this.saveMobile(u, ev)"/>
                                        </div>
                                        <span t-if="u._savedMobile" class="text-success" style="font-size:11px;">✓ Saved</span>
                                        <span t-if="u._savedCountry" class="text-success" style="font-size:11px;"> ✓ Country</span>
                                    </td>
                                    <td><small t-esc="u.last_login or '—'"/></td>
                                    <td><small t-esc="u.last_device or '—'"/></td>
                                    <td class="text-center">
                                        <div class="form-check form-switch d-inline-block">
                                            <input type="checkbox" class="form-check-input" role="switch"
                                                   t-att-checked="u.enabled" t-on-change="() => this.toggle(u)"/>
                                        </div>
                                    </td>
                                    <td>
                                        <button class="btn btn-sm btn-outline-secondary" t-on-click="() => this.reset(u)">
                                            <i class="fa fa-key me-1"/>Reset</button>
                                        <div t-if="u._resetMsg" class="text-success" style="font-size:11px;" t-esc="u._resetMsg"/>
                                    </td>
                                </tr>
                                <tr t-if="!filteredUsers.length"><td colspan="7" class="text-muted">
                                    <t t-if="state.roleFilter !== 'all'">No users with this role.</t>
                                    <t t-else="">No users.</t>
                                </td></tr>
                            </tbody>
                        </table>
                        <small class="text-muted d-block mt-2">Reset sets the password to <b>1111</b> and forces the
                            user to choose a new one on next login. Leave a mobile blank to remove app login for that user.</small>
                    </div>
                </div>
            </t>
        </div>`;

    setup() {
        this.state = useState({
            loading: true, error: "", users: [],
            roleFilter: "all",
            connected_number: "",
            otp_template: "", otp_default: "", otp_preview: "", savedOtp: false,
            dial: "", mobile_length: 10, countries: [],
            app_name: "the app", otp_minutes: 5, sample_name: "Ravi",
            // WhatsApp server (Neonize) connection state
            wa_state: "none", wa_session_id: 0, wa_phone: "", wa_qr: "",
            wa_busy: false, wa_error: "",
        });
        this._waPoll = null;
        onWillStart(async () => {
            try {
                const res = await rpc("/kpi_user_access/get", {});
                if (res?.status) {
                    this.state.users = res.users || [];
                    this.state.dial = res.dial || "";
                    this.state.mobile_length = res.mobile_length || 10;
                    this.state.countries = res.countries || [];
                    this.state.app_name = res.app_name || "the app";
                    this.state.otp_minutes = res.otp_minutes || 5;
                    this.state.sample_name = (res.users && res.users[0] && res.users[0].name) || "Ravi";
                    this.state.connected_number = res.connected_number || "";
                    this.state.otp_template = res.otp_template || "";
                    this.state.otp_default = res.otp_default || "";
                    this.state.otp_preview = this.renderPreview(res.otp_template || "");
                    this.state.wa_session_id = res.wa_session_id || 0;
                    this.state.wa_state = res.wa_state || "none";
                    this.state.wa_phone = res.wa_phone || "";
                    if (this.state.wa_state === "waiting_qr") this.startWaPolling();
                } else {
                    this.state.error = res?.message || "Not authorized.";
                }
            } catch (e) { this.state.error = e?.data?.message || e?.message || "Failed to load."; }
            finally { this.state.loading = false; }
        });
        onWillUnmount(() => this.stopWaPolling());
    }

    // --- Role filter (Team Members card header) ------------------------- //
    // Rows shown in the table, narrowed to the selected role (all = everyone).
    get filteredUsers() {
        const f = this.state.roleFilter;
        if (!f || f === "all") return this.state.users;
        return this.state.users.filter((u) => u.role === f);
    }

    setRoleFilter(ev) { this.state.roleFilter = ev.target.value; }

    // --- WhatsApp server (Neonize) connect / poll / delete -------------- //
    startWaPolling() {
        this.stopWaPolling();
        const tick = async () => {
            try {
                const r = await rpc("/kpi_wa_server/status", { session_id: this.state.wa_session_id });
                if (r && r.status) {
                    this.state.wa_state = r.state;
                    this.state.wa_phone = r.phone_number || "";
                    this.state.wa_qr = r.qr_image || "";
                    this.state.wa_error = r.error || "";
                    if (["connected", "disconnected", "error", "none"].includes(r.state)) this.stopWaPolling();
                }
            } catch (e) { /* keep polling */ }
        };
        this._waPoll = setInterval(tick, 3000);
        tick();
    }

    stopWaPolling() { if (this._waPoll) { clearInterval(this._waPoll); this._waPoll = null; } }

    async connectServer() {
        this.state.wa_busy = true; this.state.wa_error = ""; this.state.wa_qr = "";
        try {
            const r = await rpc("/kpi_wa_server/connect", {});
            if (r && r.status) {
                this.state.wa_session_id = r.session_id;
                this.state.wa_state = r.state || "waiting_qr";
                this.startWaPolling();
            } else {
                this.state.wa_error = r?.message || "Could not start. Check the WhatsApp library is installed on the server.";
            }
        } catch (e) { this.state.wa_error = e?.data?.message || "Failed to connect."; }
        finally { this.state.wa_busy = false; }
    }

    async deleteServer() {
        if (!confirm("Delete this WhatsApp connection? It will be logged out of WhatsApp and removed from the server.")) return;
        this.state.wa_busy = true; this.state.wa_error = "";
        try {
            const r = await rpc("/kpi_wa_server/delete", { session_id: this.state.wa_session_id });
            if (r && r.status) {
                this.stopWaPolling();
                this.state.wa_session_id = 0; this.state.wa_state = "none";
                this.state.wa_phone = ""; this.state.wa_qr = "";
            } else {
                this.state.wa_error = r?.message || "Could not delete.";
            }
        } catch (e) { this.state.wa_error = e?.data?.message || "Failed to delete."; }
        finally { this.state.wa_busy = false; }
    }

    _flash(obj, key, val) {
        obj[key] = val === undefined ? true : val;
        setTimeout(() => { try { obj[key] = val === undefined ? false : ""; } catch (e) {} }, 1500);
    }

    // Fill the tokens with real example values, then render WhatsApp *bold* so
    // the preview shows exactly what the user receives (bold, not literal *).
    renderPreview(t) {
        let s = (t || "")
            .split("{name}").join(this.state.sample_name || "Ravi")
            .split("{code}").join("4821")
            .split("{minutes}").join(String(this.state.otp_minutes || 5))
            .split("{app}").join(this.state.app_name || "the app");
        s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        s = s.replace(/\*([^*\n]+)\*/g, "<b>$1</b>");   // WhatsApp bold → <b>
        return markup(s);
    }

    onOtpInput(ev) {
        this.state.otp_preview = this.renderPreview(ev.target.value || "");
    }

    async saveOtpMessage(ev) {
        const tmpl = ev.target.value || "";
        this.state.otp_template = tmpl;
        this.state.otp_preview = this.renderPreview(tmpl);
        try { await rpc("/kpi_user_access/set_otp_message", { template: tmpl }); this._flash(this.state, "savedOtp"); }
        catch (e) { alert(e?.data?.message || "Failed to save."); }
    }

    async resetOtpDefault() {
        this.state.otp_template = this.state.otp_default;
        this.state.otp_preview = this.renderPreview(this.state.otp_default);
        try { await rpc("/kpi_user_access/set_otp_message", { template: "" }); this._flash(this.state, "savedOtp"); }
        catch (e) { alert(e?.data?.message || "Failed to save."); }
    }

    async saveMobile(u, ev) {
        const cap = u.mobile_length || this.state.mobile_length || 15;
        const num = (ev.target.value || "").replace(/\D/g, "").slice(0, cap);
        ev.target.value = num;
        try {
            const res = await rpc("/kpi_user_access/set_mobile", { user_id: u.id, mobile: num });
            if (res.status) { u.mobile = res.mobile; this._flash(u, "_savedMobile"); }
            else alert(res.message || "Not authorized.");
        } catch (e) { alert(e?.data?.message || "Failed to save."); }
    }

    // Set this person's country code (Oman +968 / India +91 / …). Drives their
    // login mobile AND WhatsApp number; empty = the company default.
    async saveCountry(u, ev) {
        const cid = parseInt(ev.target.value, 10) || false;
        try {
            const res = await rpc("/kpi_user_access/set_country", { user_id: u.id, country_id: cid });
            if (res.status) {
                u.country_id = res.country_id || false;
                u.dial = res.dial || this.state.dial;
                u.mobile_length = res.mobile_length || this.state.mobile_length;
                this._flash(u, "_savedCountry");
            } else { alert(res.message || "Not authorized."); ev.target.value = u.country_id || ""; }
        } catch (e) { alert(e?.data?.message || "Failed to save."); ev.target.value = u.country_id || ""; }
    }

    async saveRole(u, ev) {
        const role = ev.target.value;
        try {
            const res = await rpc("/kpi_user_access/set_role", { user_id: u.id, role });
            if (res.status) { u.role = res.role; this._flash(u, "_savedRole"); }
            else { alert(res.message || "Not authorized."); ev.target.value = u.role; }
        } catch (e) { alert(e?.data?.message || "Failed to save."); ev.target.value = u.role; }
    }

    async toggle(u) {
        const next = !u.enabled;
        try {
            const res = await rpc("/kpi_user_access/toggle_login", { user_id: u.id, enabled: next });
            if (res.status) u.enabled = next; else alert(res.message || "Not authorized.");
        } catch (e) { alert(e?.data?.message || "Failed to save."); }
    }

    async reset(u) {
        if (!confirm(`Reset ${u.name}'s app password to 1111? They'll set a new one on next login.`)) return;
        try {
            const res = await rpc("/kpi_user_access/reset_password", { user_id: u.id });
            if (res.status) { u.has_password = true; this._flash(u, "_resetMsg", "✓ Reset to 1111"); }
            else alert(res.message || "Not authorized.");
        } catch (e) { alert(e?.data?.message || "Failed to save."); }
    }
}

registry.category("actions").add("kpi_user_access", KpiUserAccess);
