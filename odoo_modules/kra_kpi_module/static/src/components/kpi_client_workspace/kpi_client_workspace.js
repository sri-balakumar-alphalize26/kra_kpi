/** @odoo-module **/
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

export class KpiClientWorkspace extends Component {
    static template = xml/* xml */`
    <div class="o_kpi_client_workspace p-4">
        <h2 class="fw-bold mb-4">
            <i class="fa fa-folder-open me-2 text-primary"/> Generate Client Files
        </h2>

        <div class="card p-4 mb-4 shadow-sm">
            <p class="text-muted mb-3">
                Pick a client (and optionally a project) and download a ZIP containing
                <strong>3 XLSX files in your format</strong> — one for Requirements, one for
                Updates / Amendments, and one for Bug Reports. The files are pre-titled with
                the client name so you can email them to your client to fill in.
            </p>

            <div class="row g-3 align-items-end">
                <div class="col-md-4">
                    <label class="form-label fw-bold">Client <span class="text-danger">*</span></label>
                    <select class="form-select" t-model="state.client_kra_id" t-on-change="onClientChange">
                        <option value="">-- Select Client --</option>
                        <t t-foreach="state.clients" t-as="c" t-key="c.id">
                            <option t-att-value="c.id" t-esc="c.name"/>
                        </t>
                    </select>
                </div>
                <div class="col-md-4">
                    <label class="form-label fw-bold">Project (optional)</label>
                    <select class="form-select" t-model="state.project_kra_id">
                        <option value="">-- (whole client) --</option>
                        <t t-foreach="state.subKras" t-as="s" t-key="s.id">
                            <option t-att-value="s.id" t-esc="s.display"/>
                        </t>
                    </select>
                </div>
                <div class="col-md-2">
                    <label class="form-label fw-bold">Version</label>
                    <input type="text" class="form-control" t-model="state.version"
                           placeholder="v1.0"/>
                </div>
                <div class="col-md-2 d-flex align-items-end pb-1">
                    <div class="form-check">
                        <input class="form-check-input" type="checkbox" id="incdata"
                               t-model="state.include_data"/>
                        <label class="form-check-label small" for="incdata">
                            Include existing tasks as data
                        </label>
                    </div>
                </div>
            </div>

            <div class="mt-4 d-flex justify-content-end">
                <a class="btn btn-success btn-lg"
                   t-att-class="!state.client_kra_id ? 'disabled' : ''"
                   t-att-href="downloadUrl()" target="_blank">
                    <i class="fa fa-file-archive-o me-2"/>
                    Generate &amp; Download ZIP
                </a>
            </div>
        </div>

        <div class="card p-3 bg-light shadow-sm">
            <h6 class="fw-bold"><i class="fa fa-info-circle me-1"/> What you'll receive</h6>
            <ul class="mb-0 small">
                <li>
                    <strong>{ClientName}_Requirements_{ver}.xlsx</strong> —
                    columns: Req ID · Module · Description · Acceptance Criteria · Priority · Delivery · Notes
                </li>
                <li>
                    <strong>{ClientName}_Updates_{ver}.xlsx</strong> —
                    columns: Update ID · Linked Req · Description · Reason · Priority · Requested Delivery · Notes
                </li>
                <li>
                    <strong>{ClientName}_Bugs_{ver}.xlsx</strong> —
                    columns: Bug ID · Linked Req · Module · Description · Steps · Expected · Actual · Severity · Priority · Status · ...
                </li>
            </ul>
            <p class="small text-muted mt-2 mb-0">
                Tip: extract the ZIP into <code>Documents/{ClientName}/</code> and you have a
                dedicated folder for that client's documents. Email these to the client to fill in.
                Once filled, drop them into the matching <em>Upload Requirements / Updates / Bug Reports</em>
                screen to bulk-create tasks.
            </p>
        </div>
    </div>
    `;

    setup() {
        this.state = useState({
            client_kra_id: '',
            project_kra_id: '',
            version: 'v1.0',
            include_data: false,
            clients: [],
            subKras: [],
        });
        onWillStart(async () => {
            const r = await rpc('/kpi_client_invoice/get_filters', {});
            if (r && r.status) this.state.clients = r.clients || [];
        });
    }

    async onClientChange() {
        this.state.project_kra_id = '';
        this.state.subKras = [];
        if (!this.state.client_kra_id) return;
        const r = await rpc('/kpi_completion_cert/get_sub_kras', {
            client_kra_id: this.state.client_kra_id,
        });
        if (r && r.status) this.state.subKras = r.kras || [];
    }

    downloadUrl() {
        if (!this.state.client_kra_id) return '#';
        const params = new URLSearchParams({
            client_kra_id: this.state.client_kra_id,
            version: this.state.version || 'v1.0',
            include_data: this.state.include_data ? '1' : '0',
        });
        if (this.state.project_kra_id) {
            params.set('project_kra_id', this.state.project_kra_id);
        }
        return `/kpi_client_workspace/generate_zip?${params.toString()}`;
    }
}

registry.category("actions").add("kpi_client_workspace", KpiClientWorkspace);
