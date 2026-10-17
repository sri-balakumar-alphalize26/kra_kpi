/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { FormController } from "@web/views/form/form_controller";
import { rpc } from "@web/core/network/rpc";
import { onMounted, onWillUnmount } from "@odoo/owl";

const POLL_INTERVAL_MS = 5000;

patch(FormController.prototype, {
    setup() {
        super.setup(...arguments);

        // Attach polling only on the WhatsApp session form view.
        // Do NOT register OWL hooks for other models — would bloat memory.
        if (this.props?.resModel !== "whatsapp.session") {
            return;
        }

        this._waPollingId = null;
        this._waLastQrHead = null;
        this._waReloading = false;

        onMounted(() => this._waStartPolling());
        onWillUnmount(() => this._waStopPolling());
    },

    async _waPollOnce() {
        // Defensive: model/record may not be ready yet during route transitions
        let record;
        try {
            record = this.model && this.model.root;
        } catch (_) {
            return;
        }
        if (!record || !record.data) return;

        const sessionId = record.resId;
        const status = record.data.status;
        if (!sessionId) return;

        // Already connected — nothing more to poll for
        if (status === "connected") {
            this._waStopPolling();
            return;
        }

        // Skip polling if not in a state where a QR could be coming
        if (status !== "waiting_qr" && status !== "disconnected") {
            return;
        }

        let result;
        try {
            result = await rpc(`/whatsapp/qr/status/${sessionId}`, {});
        } catch (e) {
            // Network blip — try again next interval
            console.debug("WhatsApp QR poll error:", e);
            return;
        }
        if (!result) return;

        // Session has just connected → refresh the form, then stop polling
        if (result.status === "connected") {
            this._waStopPolling();
            await this._waReloadRecord(sessionId);
            return;
        }

        // QR is present and has rotated → refresh the form so the visible QR
        // image stays current. Neonize rotates the QR every ~30 seconds; the
        // old code only reloaded on 'connected' so users saw stale QRs.
        if (result.status === "waiting_qr" && result.qr_image) {
            const head = String(result.qr_image).slice(0, 64);
            if (head !== this._waLastQrHead) {
                this._waLastQrHead = head;
                await this._waReloadRecord(sessionId);
            }
        }
    },

    async _waReloadRecord(sessionId) {
        // Guard against overlapping reloads
        if (this._waReloading) return;
        this._waReloading = true;
        try {
            const root = this.model && this.model.root;
            if (root && typeof root.load === "function") {
                await root.load();
            } else if (this.model && typeof this.model.load === "function") {
                await this.model.load({ resId: sessionId });
            }
        } catch (e) {
            console.debug("WhatsApp record reload failed:", e);
        } finally {
            this._waReloading = false;
        }
    },

    _waStartPolling() {
        if (this._waPollingId) return;
        // Poll once immediately so the page doesn't wait 5s for the first QR
        this._waPollOnce();
        this._waPollingId = setInterval(() => {
            this._waPollOnce();
        }, POLL_INTERVAL_MS);
    },

    _waStopPolling() {
        if (this._waPollingId) {
            clearInterval(this._waPollingId);
            this._waPollingId = null;
        }
    },
});
