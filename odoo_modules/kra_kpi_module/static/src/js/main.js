/** Main JS = register all components so Odoo can use them */
/** @odoo-module **/
import { registry } from "@web/core/registry";
import { patch } from "@web/core/utils/patch";
import { FormController } from "@web/views/form/form_controller";
import { onMounted, onWillUnmount } from "@odoo/owl";

// Components
import { KraKpiRouter } from "./router";
import { Dashboard } from "../components/dashboard/dashboard";
import { KraTree } from "../components/kra_tree/kra_tree";
import { KraCreate } from "../components/kra_create/kra_create";
import { KpiCreate } from "../components/kpi_create/kpi_create";
import { KpiView } from "../components/kpi_view/kpi_view";
import { KpiAction } from "../components/kpi_action/kpi_action";
import { KpiUnitReport } from "../components/kpi_unit_report/kpi_unit_report";
import { KpiPerformanceReport } from "../components/kpi_performance_report/kpi_performance_report";
import { KpiAttentionReport } from "../components/kpi_attention_report/kpi_attention_report";
import { TaskDocuments } from "../components/task_documents/task_documents";

// XML Templates
import "../components/dashboard/dashboard.xml";
import "../components/kra_tree/kra_tree.xml";
import "../components/kra_create/kra_create.xml";
import "../components/kpi_create/kpi_create.xml";
import "../components/kpi_action/kpi_action.xml";

/** Register for debug (optional) */
registry.category("main_components").add("kra_kpi_router", KraKpiRouter);
registry.category("main_components").add("kra_tree", KraTree);
registry.category("main_components").add("kra_create", KraCreate);
registry.category("main_components").add("kpi_create", KpiCreate);
registry.category("main_components").add("kpi_view", KpiView);


/**
 * UX: when a number field (estimate hours/minutes, etc.) gains focus anywhere
 * in the KRA/KPI module, select its whole value so a single click/tab lets the
 * user overwrite it instead of having to clear the existing "0". Scoped to the
 * module's own components + its modal container so it doesn't affect other apps.
 * The setTimeout defers the select() past the click's caret placement so it sticks.
 */
if (!window.__kpiNumberSelectAll) {
    window.__kpiNumberSelectAll = true;
    document.addEventListener("focusin", (ev) => {
        const el = ev.target;
        if (el && el.tagName === "INPUT" && el.type === "number"
            && el.closest('[class*="o_kpi"], [class*="o_kra"], #modalContainer')) {
            setTimeout(() => { try { el.select(); } catch (e) { /* ignore */ } }, 0);
        }
    });
}

/** Register client actions */
registry.category("actions").add("kra_kpi_dashboard", KraKpiRouter);
registry.category("actions").add("kra_kpi_actions", KpiAction);
registry.category("actions").add("kpi_unit_report", KpiUnitReport);
registry.category("actions").add("kpi_performance_report", KpiPerformanceReport);
registry.category("actions").add("kpi_attention_report", KpiAttentionReport);
registry.category("actions").add("task_documents_view", TaskDocuments);


/**
 * 🆕 WhatsApp QR auto-refresh (fix for "QR not coming").
 *
 * The whatsapp_neonize session form shows a `qr_image` that the neonize
 * background thread writes to the DB ~1s AFTER you click "Connect WhatsApp"
 * (and re-writes every ~20s as each QR expires). The form never reloaded to
 * pick it up — and whatsapp_neonize's own qr_refresh.js was (a) never
 * registered in its manifest `assets` and (b) used the removed
 * `useService("rpc")`. Since kra_kpi_module depends on whatsapp_neonize, we
 * patch FormController here to reload the record every few seconds WHILE the
 * session status is 'waiting_qr' — so the QR appears, refreshes as it
 * regenerates, and the flip to 'connected' is picked up automatically.
 * Guarded to whatsapp.session forms only, so no other form is affected.
 */
patch(FormController.prototype, {
    setup() {
        super.setup(...arguments);
        this._waQrTimer = null;
        onMounted(() => this._waQrStart());
        onWillUnmount(() => this._waQrStop());
    },
    _waQrStart() {
        const root = this.model && this.model.root;
        if (!root || root.resModel !== "whatsapp.session") {
            return;
        }
        this._waQrTimer = setInterval(async () => {
            const r = this.model && this.model.root;
            if (!r || !r.resId || r.data.status !== "waiting_qr") {
                return;  // only refresh while waiting for the scan
            }
            try {
                await this.model.load();
            } catch (e) {
                console.debug("WhatsApp QR refresh error:", e);
            }
        }, 4000);
    },
    _waQrStop() {
        if (this._waQrTimer) {
            clearInterval(this._waQrTimer);
            this._waQrTimer = null;
        }
    },
});