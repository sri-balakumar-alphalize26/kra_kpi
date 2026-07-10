/** @odoo-module **/

import { Component, xml } from "@odoo/owl";
import { KraTree } from "../kra_tree/kra_tree";

export class Dashboard extends Component {
    static template = xml/* xml */`
        <div class="o_kra_dashboard p-3">

            <!-- ✅ LOGO WATERMARK -->
            <div class="alphalize-watermark"></div>

            <!-- HEADER -->
            <div class="d-flex justify-content-between align-items-center mb-3">
                <h2 class="fw-bold">KRA / KPI Master</h2>

                <div>
                    <button class="btn btn-primary me-2"
                        t-on-click="openKraForm">
                        KRA +
                    </button>

                    <button class="btn btn-secondary"
                        t-on-click="openKpiForm">
                        KPI +
                    </button>
                </div>
            </div>

            <!-- KRA TREE LOADING HERE -->
            <KraTree />
        </div>
    `;

    static components = {
        KraTree,
    };

    // Open KRA Create Screen
    openKraForm() {
        window.location.hash = "/kra_create";
    }

    // Open KPI Create Screen
    openKpiForm() {
        window.location.hash = "/kpi_create";
    }
}