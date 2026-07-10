/** @odoo-module **/

import { Component, xml, useState, onWillStart, useRef } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

export class KpiCompanySettings extends Component {

    static template = xml/* xml */`
        <div class="o_kpi_company_settings p-4">
            <h2 class="fw-bold mb-3">
                <i class="fa fa-building me-2 text-primary"></i> Company Branding
            </h2>
            <p class="text-muted">
                Shown at the top of every generated invoice PDF + quotation + completion certificate.
            </p>

            <div class="card p-4 shadow-sm" style="max-width: 760px;">

                <div class="mb-3">
                    <label class="form-label fw-bold">Company Name</label>
                    <input type="text" class="form-control"
                           t-model="state.name"
                           placeholder="e.g. 369ai.Biz"/>
                </div>

                <div class="mb-3">
                    <label class="form-label fw-bold">Company Logo</label>
                    <div class="d-flex align-items-center gap-3">
                        <div style="width:140px; height:140px; border:1px dashed #ced4da; display:flex; align-items:center; justify-content:center; background:#f8f9fa; border-radius:6px;">
                            <img t-if="state.logo_b64"
                                 t-att-src="'data:image/png;base64,' + state.logo_b64"
                                 style="max-width:100%; max-height:100%; object-fit:contain;"/>
                            <i t-else="" class="fa fa-image fa-3x text-muted"></i>
                        </div>
                        <div class="flex-fill">
                            <input type="file" accept="image/png,image/jpeg,image/svg+xml"
                                   class="form-control"
                                   t-ref="logoInput"
                                   t-on-change="onLogoChange"/>
                            <button t-if="state.logo_b64"
                                    class="btn btn-sm btn-outline-danger mt-2"
                                    t-on-click="clearLogo">
                                <i class="fa fa-trash me-1"></i> Remove logo
                            </button>
                            <p class="small text-muted mt-2 mb-0">
                                PNG / JPEG / SVG · max 1 MB · square or wide layout works best.
                            </p>
                        </div>
                    </div>
                </div>

                <div class="mt-3 d-flex align-items-center gap-2">
                    <button class="btn btn-primary"
                            t-on-click="save"
                            t-att-disabled="state.saving">
                        <t t-if="state.saving">
                            <i class="fa fa-spinner fa-spin me-1"></i> Saving...
                        </t>
                        <t t-else="">
                            <i class="fa fa-check me-1"></i> Save Branding
                        </t>
                    </button>
                    <span t-if="state.lastSaved" class="text-success small">
                        <i class="fa fa-check-circle me-1"/>
                        Saved at <t t-esc="state.lastSaved"/>. Generate any invoice to see it.
                    </span>
                </div>
            </div>

            <p class="text-muted small mt-3" style="max-width: 760px;">
                <i class="fa fa-info-circle me-1"></i>
                This updates the Odoo company record (<b>res.company</b>).
                Same field used by every other Odoo invoice / report in the system.
            </p>
        </div>
    `;

    setup() {
        this.state = useState({
            name:      "",
            logo_b64:  "",
            saving:    false,
            lastSaved: "",
        });
        this.logoInput = useRef("logoInput");

        onWillStart(async () => {
            try {
                const r = await rpc("/kra_kpi/company/get", {});
                if (r && r.status) {
                    this.state.name     = r.name     || "";
                    this.state.logo_b64 = r.logo_b64 || "";
                }
            } catch (e) {
                console.warn("Could not load company branding", e);
            }
        });
    }

    onLogoChange(ev) {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        if (file.size > 1024 * 1024) {
            alert("Please pick a logo smaller than 1 MB.");
            ev.target.value = "";
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = String(reader.result || "");
            const b64 = dataUrl.split(",")[1] || "";
            this.state.logo_b64 = b64;
        };
        reader.onerror = () => alert("Failed to read the file.");
        reader.readAsDataURL(file);
    }

    clearLogo() {
        this.state.logo_b64 = "";
        if (this.logoInput && this.logoInput.el) this.logoInput.el.value = "";
    }

    async save() {
        const name = (this.state.name || "").trim();
        if (!name) {
            alert("Company name is required.");
            return;
        }
        this.state.saving = true;
        try {
            const r = await rpc("/kra_kpi/company/save", {
                name:     name,
                logo_b64: this.state.logo_b64 || "",
            });
            if (r && r.status) {
                this.state.lastSaved = new Date().toLocaleTimeString();
            } else {
                alert("Save failed: " + ((r && r.message) || "unknown error"));
            }
        } catch (e) {
            alert("Save request failed: " + ((e && e.message) || e));
        } finally {
            this.state.saving = false;
        }
    }
}

registry.category("actions").add("kpi_company_settings", KpiCompanySettings);
