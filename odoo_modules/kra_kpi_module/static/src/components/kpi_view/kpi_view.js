/** @odoo-module **/

import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { rpc } from "@web/core/network/rpc";

export class KpiView extends Component {
    static template = xml/* xml */`
        <div class="o_kpi_view p-3" style="max-height: 85vh; overflow-y: auto;">

            <!-- KPI Loaded -->
            <t t-if="state.loaded and state.kpi">

                <div class="d-flex justify-content-between align-items-center mb-3">
                    <h3 class="m-0">KPI Details</h3>
                    <div>
                        <button class="btn btn-primary" t-on-click="editKpi">Edit</button>
                        <button class="btn btn-light" t-on-click="back">Back</button>
                    </div>
                </div>

                <div class="card p-3">
                    <div class="container-fluid">

                        <div class="row mb-2">
                            <div class="col-3 fw-bold">Name</div>
                            <div class="col-9" t-esc="state.kpi.name"/>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3 fw-bold">KRA</div>
                            <div class="col-9" t-esc="state.kpi.kra_name"/>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3 fw-bold">Priority</div>
                            <div class="col-9" t-esc="state.kpi.priority"/>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3 fw-bold">Estimate</div>
                            <div class="col-9" t-esc="state.kpi.estimate_display"/>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3 fw-bold">Points</div>
                            <div class="col-9" t-esc="state.kpi.points"/>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3 fw-bold">Assignee</div>
                            <div class="col-9" t-esc="state.kpi.user_name"/>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3 fw-bold">User Group</div>
                            <div class="col-9" t-esc="state.kpi.user_group_name"/>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3 fw-bold">Deadline</div>
                            <div class="col-9" t-esc="state.kpi.deadline"/>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3 fw-bold">Reminder Interval</div>
                            <div class="col-9">
                                <t t-if="state.kpi.reminder_days || state.kpi.reminder_hours || state.kpi.reminder_minutes">
                                    <t t-if="state.kpi.reminder_days"><t t-esc="state.kpi.reminder_days"/>d </t>
                                    <t t-if="state.kpi.reminder_hours"><t t-esc="state.kpi.reminder_hours"/>h </t>
                                    <t t-if="state.kpi.reminder_minutes"><t t-esc="state.kpi.reminder_minutes"/>m</t>
                                </t>
                                <t t-else="">
                                    <span class="text-muted">Not set</span>
                                </t>
                            </div>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3 fw-bold">Next KPI</div>
                            <div class="col-9" t-esc="state.kpi.next_kpi_name"/>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3 fw-bold">Warehouse</div>
                            <div class="col-9" t-esc="state.kpi.warehouse"/>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3 fw-bold">File Name</div>
                            <div class="col-9" t-esc="state.kpi.file_name"/>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3 fw-bold">Uploaded File</div>
                            <div class="col-9">
                                <t t-if="state.kpi.file_content">
                                    <a t-att-href="'data:application/octet-stream;base64,' + state.kpi.file_content"
                                    t-att-download="state.kpi.file_name || 'download'"
                                    class="btn btn-sm btn-primary">
                                    <i class="fa fa-download"/> Download File
                                    </a>
                                </t>
                                <t t-else="">
                                    <span class="text-muted">No file uploaded</span>
                                </t>
                            </div>
                        </div>

                        <!-- 🆕 NEW: Related Links Display -->
                        <div class="row mb-2">
                            <div class="col-3 fw-bold">Related Links</div>
                            <div class="col-9">
                                <t t-set="parsedLinks" t-value="parseRelatedLinks(state.kpi.related_links)"/>
                                <t t-if="parsedLinks.length > 0">
                                    <ul class="list-unstyled mb-0">
                                        <t t-foreach="parsedLinks" t-as="link" t-key="link_index">
                                            <li class="mb-1">
                                                <i class="fa fa-external-link text-primary me-1"/>
                                                <a t-att-href="link" target="_blank" t-esc="link"/>
                                            </li>
                                        </t>
                                    </ul>
                                </t>
                                <t t-else="">
                                    <span class="text-muted">No links added</span>
                                </t>
                            </div>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3 fw-bold">Actions</div>
                            <div class="col-9">
                                <t t-esc="state.kpi.actions || '-'"/>
                            </div>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3 fw-bold">Description</div>
                            <div class="col-9">
                                <t t-esc="state.kpi.description"/>
                            </div>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3 fw-bold">Checklist</div>
                            <div class="col-9">
                                <t t-esc="state.kpi.checklist"/>
                            </div>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3 fw-bold">Guidelines</div>
                            <div class="col-9">
                                <t t-esc="state.kpi.guidelines"/>
                            </div>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3">Is Mandatory</div>
                            <div class="col-9"><t t-esc="state.kpi.is_mandatory ? 'Yes' : 'No'"/></div>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3">Auto Estimated</div>
                            <div class="col-9"><t t-esc="state.kpi.auto_estimated ? 'Yes' : 'No'"/></div>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3">Service KPI</div>
                            <div class="col-9"><t t-esc="state.kpi.service_kpi ? 'Yes' : 'No'"/></div>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3">Coordinator Review</div>
                            <div class="col-9"><t t-esc="state.kpi.is_manager_review_needed ? 'Yes' : 'No'"/></div>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3">Auto Assign</div>
                            <div class="col-9"><t t-esc="state.kpi.auto_assign ? 'Yes' : 'No'"/></div>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3">Is Permanent</div>
                            <div class="col-9"><t t-esc="state.kpi.is_permanent ? 'Yes' : 'No'"/></div>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3">Is Meeting</div>
                            <div class="col-9"><t t-esc="state.kpi.is_meeting ? 'Yes' : 'No'"/></div>
                        </div>

                        <div class="row mb-2">
                            <div class="col-3">Customer Review</div>
                            <div class="col-9"><t t-esc="state.kpi.is_customer_review_needed ? 'Yes' : 'No'"/></div>
                        </div>

                    </div>
                </div>

            </t>

            <!-- Loading -->
            <t t-if="!state.loaded and !state.error">
                <div class="alert alert-info">Loading KPI...</div>
            </t>

            <!-- Error -->
            <t t-if="state.error">
                <div class="alert alert-danger mt-2" t-esc="state.error"/>
            </t>

        </div>
    `;

    setup() {
        this.state = useState({
            kpi: null,
            loaded: false,
            error: "",
        });

        this.back = this.back.bind(this);
        this.editKpi = this.editKpi.bind(this);
        this.loadKpi = this.loadKpi.bind(this);

        onWillStart(async () => {
            await this.loadKpi();
        });
    }

    async loadKpi() {
        try {
            console.log("KpiView - props:", this.props);
            
            // Try to get ID from props first
            let id = this.props?.kpiId;
            
            console.log("KpiView - ID from props:", id);

            // If no ID from props, try to get from URL hash
            if (!id) {
                const hash = window.location.hash.replace("#", "");
                console.log("KpiView - Full hash:", hash);
                
                const parts = hash.split("/").filter(Boolean);
                console.log("KpiView - Hash parts:", parts);
                
                id = parts[parts.length - 1];
            }

            id = Number(id);
            console.log("KpiView - Final ID:", id);

            if (!id || isNaN(id)) {
                this.state.error = "Invalid KPI ID.";
                this.state.loaded = true;
                return;
            }

            console.log("KpiView - Loading KPI with ID:", id);

            const payload = await rpc("/kra_kpi/get_kpi_detail", { kpi_id: id });

            console.log("KpiView - Response:", payload);

            if (!payload?.status) {
                this.state.error = payload?.message || "Failed to load KPI.";
            } else {
                this.state.kpi = payload.kpi;
                console.log("KpiView - KPI loaded successfully:", this.state.kpi);
            }

        } catch (err) {
            console.error("KpiView - Error:", err);
            this.state.error = "Error: " + err.message;
        }

        this.state.loaded = true;
    }

    back() {
        console.log("Going back to previous page");
        window.history.back();
    }

    editKpi() {
        const id = this.state.kpi?.id;
        console.log("Editing KPI:", id);
        if (id) {
            window.location.href = `/web#id=${id}&model=kra.kpi&view_type=form`;
        }    
    }
    parseRelatedLinks(linksJson) {
        try {
            if (!linksJson) return [];
            const parsed = JSON.parse(linksJson);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.error("Error parsing related links:", e);
            return [];
        }
    }
}