/** @odoo-module **/

// Landing page for the KRA / KPI app menu.
//
// Why this exists: the root "KRA / KPI" menu had NO action of its own, and when
// an app menu has no action Odoo promotes the first visible child's action to be
// the app's (web/models/ir_ui_menu.py — it walks children[0] until it finds one).
// That made the landing page whatever the user's role happened to see first —
// "Task Related Documents" for most people. Giving the root menu this action
// short-circuits that promotion for every role.
//
// Deliberately has NO rpc and NO state: it is the first thing anyone sees after
// clicking the app, so it must never fail, spin, or depend on the server.
//
// The look is NOT new — `.o_kra_dashboard` (animated gradient) and
// `.alphalize-watermark` (the centered logo) are the same classes the KRA / KPI
// Master page uses (see components/dashboard/dashboard.js + css/kra_style.scss).
import { Component, xml } from "@odoo/owl";
import { registry } from "@web/core/registry";

export class KpiWelcome extends Component {
    // position:relative is set HERE rather than on the shared .o_kra_dashboard
    // rule: the watermark is position:absolute, so it needs a positioned
    // ancestor — and editing the shared rule would move the watermark on the
    // KRA/KPI Master page too.
    //
    // NO inline min-height. It used to say 70vh, and an inline style BEATS the
    // class — so it overrode .o_kra_dashboard's min-height:100vh and the animated
    // gradient stopped at 70% of the viewport, leaving a bare white band below.
    // Sizing lives in the scoped .o_kra_welcome rule (css/kra_style.scss) instead,
    // where it can't silently outrank the shared one.
    static template = xml/* xml */`
        <div class="o_kra_welcome o_kra_dashboard p-3">
            <div class="alphalize-watermark"></div>

            <div class="o_kra_welcome_body d-flex flex-column align-items-center justify-content-center text-center">
                <h1 class="fw-bold mb-2" style="letter-spacing: 0.5px;">Welcome to KRA / KPI</h1>
                <p class="text-muted mb-0" style="max-width: 520px;">
                    Pick a section from the menu above to get started.
                </p>
            </div>
        </div>
    `;
}

registry.category("actions").add("kra_kpi_welcome", KpiWelcome);
