/** KRA Tree Component - Clean Odoo Style */
/** @odoo-module **/
import { Component, xml, useState } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { KraNode } from "./kra_node";

export class KraTree extends Component {
    static template = xml/* xml */`
        <div>
            <t t-if="state.loading">
                <div class="text-center py-5">
                    <span class="spinner-border text-primary"></span>
                </div>
            </t>

            <t t-else="">
                <div class="ps-2">
                    <t t-foreach="state.kra_list" t-as="kra" t-key="kra.id">
                        <KraNode kra="kra"/>
                    </t>
                </div>
            </t>
        </div>
    `;

    static components = {
        KraNode,
    };

    setup() {
        this.orm = useService("orm");
        this.state = useState({
            loading: true,
            kra_list: []
        });

        this.loadKraTree();
    }

    async loadKraTree() {
        try {
            const result = await this.orm.call(
                "kra.master",
                "get_kra_tree",      // your python method
                []
            );

            this.state.kra_list = result;
        } catch (e) {
            console.error("Error loading KRA Tree:", e);
        }

        this.state.loading = false;
    }
}
