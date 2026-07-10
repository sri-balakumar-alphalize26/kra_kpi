/** Simple Router for KRA/KPI Module */
/** @odoo-module **/
import { registry } from "@web/core/registry";
import { Component, xml, useState, onMounted } from "@odoo/owl";

import { KpiCreate } from "../components/kpi_create/kpi_create";
import { KpiView } from "../components/kpi_view/kpi_view";
import { KraCreate } from "../components/kra_create/kra_create";
import { KraTree } from "../components/kra_tree/kra_tree";
import { Dashboard } from "../components/dashboard/dashboard";
import { KpiAction } from "../components/kpi_action/kpi_action";

export class KraKpiRouter extends Component {
    static template = xml/* xml */`
        <div>

            <!-- Dashboard -->
            <t t-if="state.route === '/'">
                <Dashboard />
            </t>

            <!-- KPI Action Board -->
            <t t-if="state.route === '/kpi_action'">
                <KpiAction />
            </t>

            <!-- Create KRA -->
            <t t-if="state.route === '/kra_create'">
                <KraCreate />
            </t>

            <!-- Create KPI -->
            <t t-if="state.route === '/kpi_create'">
                <KpiCreate />
            </t>

            <!-- View KPI -->
            <t t-if="state.route === '/kpi_view'">
                <KpiView t-props="{ kpiId: state.kpi_id }"/>
            </t>

        </div>
    `;

    static components = {
        Dashboard,
        KpiAction,
        KraCreate,
        KpiCreate,
        KpiView,
        KraTree,
    };

    setup() {

        /** Parse route from hash */
        const parseRoute = () => {
            const hash = window.location.hash.replace('#', '') || '/';
            
            console.log("Router - Full hash:", hash);

            // detect /kpi_view/<id>
            if (hash.includes('kpi_view')) {
                const parts = hash.split('/').filter(Boolean);
                console.log("Router - Detected kpi_view, parts:", parts);
                
                const id = parts[parts.length - 1];
                console.log("Router - Extracted KPI ID:", id);
                
                return { route: '/kpi_view', kpi_id: id };
            }

            // detect /kpi_action
            if (hash.includes('kpi_action')) {
                return { route: '/kpi_action', kpi_id: null };
            }

            // standard routes
            return { route: hash || '/', kpi_id: null };
        };

        /** Initialize Router State */
        const initial = parseRoute();
        console.log("Router - Initial state:", initial);
        
        this.state = useState({
            route: initial.route,
            kpi_id: initial.kpi_id
        });

        /** Router listener */
        window.onhashchange = () => {
            console.log("Router - Hash changed");
            const parsed = parseRoute();
            console.log("Router - New state:", parsed);
            this.state.route = parsed.route;
            this.state.kpi_id = parsed.kpi_id;
        };

        onMounted(() => {
            console.log("Router - Component mounted, current state:", this.state);
        });
    }
}

/** Register this as a client action */
registry.category("actions").add("kra_kpi_dashboard", KraKpiRouter);