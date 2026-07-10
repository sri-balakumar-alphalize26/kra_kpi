/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { FormController } from "@web/views/form/form_controller";
import { useService } from "@web/core/utils/hooks";
import { onWillUnmount, onMounted } from "@odoo/owl";

/**
 * Patch FormController to add QR auto-refresh for whatsapp.session.
 *
 * When the session status is "waiting_qr", polls the server every 5s
 * to check whether the QR was scanned and status changed to "connected".
 * On connected, reloads the form automatically.
 */
patch(FormController.prototype, {
    setup() {
        super.setup(...arguments);

        this._waPollingId = null;
        this.rpc = useService("rpc");

        onMounted(() => {
            this._waStartPolling();
        });

        onWillUnmount(() => {
            this._waStopPolling();
        });
    },

    _waStartPolling() {
        const root = this.model.root;
        if (!root || root.resModel !== "whatsapp.session") {
            return;
        }

        this._waPollingId = setInterval(async () => {
            const record = this.model.root;
            if (!record || !record.data) return;

            const status = record.data.status;
            const sessionId = record.resId;

            // Only poll when waiting for QR scan
            if (!sessionId || status !== "waiting_qr") {
                return;
            }

            try {
                const result = await this.rpc(
                    `/whatsapp/qr/status/${sessionId}`,
                    {}
                );
                if (result && result.status === "connected") {
                    // Reload form to show connected state
                    await record.load();
                    this._waStopPolling();
                }
            } catch (e) {
                // Silently fail, will retry
                console.debug("WhatsApp QR poll error:", e);
            }
        }, 5000);
    },

    _waStopPolling() {
        if (this._waPollingId) {
            clearInterval(this._waPollingId);
            this._waPollingId = null;
        }
    },
});
