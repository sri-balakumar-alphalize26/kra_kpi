/** @odoo-module **/
// Settings › Billing: the price list a bill is made from when a task is Full
// Complete (models/kpi_billing.py) and, per client, the WhatsApp group its
// invoices go to. Routes: controllers/kpi_billing_api.py (admins only).
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";

const FAR = "9999-12-31";

export class KpiBillingSettings extends Component {
    static template = xml`
        <div class="o_kpi_billing_settings p-4" style="max-width:1200px; margin:0 auto;">
            <h2 class="fw-bold mb-3">🧾 Billing</h2>
            <div t-if="state.bill.refused" class="alert alert-warning" role="alert" t-esc="state.bill.refused"/>
            <div t-elif="!state.bill.loaded" class="text-muted"><i class="fa fa-spinner fa-spin me-2"/>Loading…</div>
            <t t-else="">
                <div class="card shadow-sm mb-4 border-0" style="border-left: 4px solid #f59e0b !important; border-left-style: solid;">
                    <div class="card-header bg-white fw-bold d-flex align-items-center">
                        Prices
                        <button t-if="!state.bill.edit" class="btn btn-sm btn-primary ms-auto" t-on-click="() => this.billEdit()">
                            <i class="fa fa-plus me-1"/>Add price
                        </button>
                    </div>
                    <div class="card-body">
                        <small class="text-muted d-block mb-3">When a task is <b>Full Complete</b>, its bill is made from
                            this list: the client's own price if it has one, else the Default. <b>Per task</b> bills the
                            amount once; <b>Hourly</b> bills the client's quoted hours (or the time logged) × the amount.
                            Each client has one price per work type; one it doesn't have uses the Default.</small>
                        <!-- One section per client (the Default first), every work type in it:
                             its price, or red when no bill can be made for it. -->
                        <div t-if="billMissingCount()" class="alert alert-danger py-2 small" role="alert">
                            <i class="fa fa-exclamation-triangle me-1"/>
                            <b t-esc="billMissingCount()"/> price(s) missing: tasks of those types are fully completed but get <b>no bill</b>. Add them below.
                        </div>
                        <t t-foreach="billSections()" t-as="sec" t-key="sec.key">
                            <div class="border rounded mb-3">
                                <div class="d-flex align-items-center px-3 py-2 bg-light border-bottom">
                                    <b t-esc="sec.name"/>
                                    <span t-if="sec.isDefault" class="small text-muted ms-2">used for any client without its own price</span>
                                    <span t-if="sec.missing" class="badge text-bg-danger ms-2"><t t-esc="sec.missing"/> missing</span>
                                    <span t-elif="!sec.isDefault" class="badge text-bg-success ms-2">✓ complete</span>
                                    <!-- Each new bill goes to this client's invoice group while Send invoices is on. -->
                                    <div t-if="!sec.isDefault" class="ms-auto d-flex align-items-center gap-2 flex-wrap">
                                        <span class="small text-muted">Invoice group</span>
                                        <select class="form-select form-select-sm" style="width:auto; min-width:200px;"
                                                t-on-change="(ev) => this.billSetGroup(sec.client, ev.target.value)">
                                            <option value="" t-att-selected="!sec.client.invoice_group_jid">Choose a WhatsApp group…</option>
                                            <option t-if="sec.client.invoice_group_jid and !billGroupKnown(sec.client.invoice_group_jid)"
                                                    t-att-value="sec.client.invoice_group_jid" selected="selected"
                                                    t-esc="sec.client.invoice_group_name or sec.client.invoice_group_jid"/>
                                            <t t-foreach="state.bill.groups" t-as="g" t-key="g.jid">
                                                <option t-att-value="g.jid" t-att-selected="g.jid === sec.client.invoice_group_jid" t-esc="g.name or g.jid"/>
                                            </t>
                                        </select>
                                        <button class="btn btn-sm btn-link p-0" title="Refresh the group list" t-on-click="() => this.loadGroups()"><i class="fa fa-refresh"/></button>
                                        <div class="form-check form-switch m-0 d-flex align-items-center gap-1" t-att-title="sec.client.send_invoice ? 'On: each new bill is posted in the invoice group' : 'Off: invoices are not sent'">
                                            <input class="form-check-input" type="checkbox" role="switch" t-att-checked="sec.client.send_invoice"
                                                   t-on-change="(ev) => this.billSetSend(sec.client, ev.target.checked)"/>
                                            <span t-att-class="'small fw-semibold ' + (sec.client.send_invoice ? 'text-success' : 'text-muted')"
                                                  t-esc="sec.client.send_invoice ? 'Send invoices: on' : 'Send invoices: off'"/>
                                        </div>
                                    </div>
                                </div>
                                <div t-if="!sec.isDefault and sec.client.send_invoice and !sec.client.invoice_group_jid"
                                     class="px-3 py-1 small text-danger fw-semibold border-bottom" style="background:#fef2f2;">
                                    <i class="fa fa-exclamation-circle me-1"/>Send invoices is on, but no invoice group is picked: nothing will be sent.
                                </div>
                                <table class="table table-sm align-middle mb-0">
                                    <tbody>
                                        <t t-foreach="sec.types" t-as="ty" t-key="ty.key">
                                            <t t-if="ty.rates.length">
                                                <tr t-foreach="ty.rates" t-as="r" t-key="r.id"
                                                    t-att-class="state.bill.edit and state.bill.edit.id === r.id ? 'table-warning' : ''">
                                                    <td style="width:22%;" class="fw-semibold" t-esc="ty.label"/>
                                                    <td style="width:16%;" t-esc="r.method === 'hourly' ? 'Hourly' : 'Per task'"/>
                                                    <td style="width:16%;" class="text-end text-nowrap"><t t-esc="r.currency_symbol or r.currency"/> <t t-esc="r.amount.toFixed(2)"/><t t-if="r.method === 'hourly'"> /h</t></td>
                                                    <td style="width:18%;" class="text-nowrap small"><t t-if="r.always">Always</t><t t-else="" t-esc="r.range_label"/></td>
                                                    <td class="small text-muted" t-esc="r.note"/>
                                                    <td class="text-end text-nowrap">
                                                        <button class="btn btn-sm btn-link p-0 me-2" title="Edit" t-on-click="() => this.billEdit(r)"><i class="fa fa-pencil"/></button>
                                                        <button class="btn btn-sm btn-link text-danger p-0" title="Delete" t-on-click="() => this.billDelete(r)"><i class="fa fa-trash"/></button>
                                                    </td>
                                                </tr>
                                            </t>
                                            <tr t-elif="ty.fallback" style="background:#fffbeb;">
                                                <td class="fw-semibold" t-esc="ty.label"/>
                                                <td colspan="4" class="small" style="color:#92400e;">
                                                    Uses the Default: <t t-esc="ty.fallback.price_label"/>
                                                </td>
                                                <td class="text-end text-nowrap">
                                                    <button class="btn btn-sm btn-outline-secondary" t-on-click="() => this.billAddFor(sec.key, ty.key)">+ Own price</button>
                                                </td>
                                            </tr>
                                            <tr t-elif="sec.isDefault">
                                                <td class="fw-semibold text-muted" t-esc="ty.label"/>
                                                <td colspan="4" class="small text-muted">Not set (optional): a client without its own price gets no bill</td>
                                                <td class="text-end text-nowrap">
                                                    <button class="btn btn-sm btn-outline-secondary" t-on-click="() => this.billAddFor(sec.key, ty.key)">+ Add</button>
                                                </td>
                                            </tr>
                                            <tr t-else="" style="background:#fef2f2;">
                                                <td class="fw-semibold text-danger" t-esc="ty.label"/>
                                                <td colspan="4" class="small text-danger fw-semibold">
                                                    <i class="fa fa-exclamation-circle me-1"/>No price: no bill can be made
                                                </td>
                                                <td class="text-end text-nowrap">
                                                    <button class="btn btn-sm btn-danger" t-on-click="() => this.billAddFor(sec.key, ty.key)">+ Add</button>
                                                </td>
                                            </tr>
                                        </t>
                                    </tbody>
                                </table>
                            </div>
                        </t>

                        <!-- Add / edit: a form under the table, a label over each field. -->
                        <div t-if="state.bill.edit" class="o_kpi_billing_form border rounded p-3 mt-3" style="background:#fffbeb;">
                            <div class="fw-bold mb-2">
                                <t t-if="state.bill.edit.id">Editing the <t t-esc="billTypeLabel(state.bill.edit.work_type)"/> price of <t t-esc="billClientLabel(state.bill.edit.client_id)"/></t>
                                <t t-else="">New price</t>
                            </div>
                            <div t-if="state.bill.edit.id" class="small text-muted mb-2">Client and work type stay as they are. For another work type, Cancel and use <b>Add price</b>.</div>
                            <t t-set="dup" t-value="billDuplicate()"/>
                            <div class="row g-3">
                                <div class="col-md-4">
                                    <label class="form-label fw-semibold mb-1">Client</label>
                                    <select t-att-class="'form-select' + (dup ? ' is-invalid' : '')" t-model="state.bill.edit.client_id"
                                            t-att-disabled="state.bill.edit.id ? 'disabled' : undefined">
                                        <option value="">Default (every client)</option>
                                        <t t-foreach="state.bill.clients" t-as="c" t-key="c.id"><option t-att-value="c.id" t-att-selected="('' + c.id) === ('' + state.bill.edit.client_id)" t-esc="c.name"/></t>
                                    </select>
                                </div>
                                <div class="col-md-4">
                                    <label class="form-label fw-semibold mb-1">Work type</label>
                                    <select t-att-class="'form-select' + (dup ? ' is-invalid' : '')" t-model="state.bill.edit.work_type"
                                            t-att-disabled="state.bill.edit.id ? 'disabled' : undefined">
                                        <t t-foreach="state.bill.work_types" t-as="w" t-key="w.key"><option t-att-value="w.key" t-att-selected="w.key === state.bill.edit.work_type" t-esc="w.label"/></t>
                                    </select>
                                </div>
                                <div class="col-md-4">
                                    <label class="form-label fw-semibold mb-1">Method</label>
                                    <select class="form-select" t-model="state.bill.edit.method">
                                        <option value="per_task">Per task (fixed amount)</option>
                                        <option value="hourly">Hourly (amount × hours)</option>
                                    </select>
                                </div>
                                <div t-if="dup" class="col-12">
                                    <div class="text-danger fw-semibold small" role="alert">
                                        <i class="fa fa-exclamation-circle me-1"/>
                                        <t t-esc="dup.client_name or 'The Default'"/> already has a <t t-esc="dup.work_type_label"/> price
                                        (<t t-esc="dup.price_label"/><t t-if="!dup.always">, <t t-esc="dup.range_label"/></t>).
                                        <a href="#" class="text-danger text-decoration-underline ms-1" t-on-click.prevent="() => this.billEdit(dup)">Edit that one instead</a>
                                    </div>
                                </div>
                                <div class="col-md-4">
                                    <label class="form-label fw-semibold mb-1">Currency</label>
                                    <select class="form-select" t-model="state.bill.edit.currency_id">
                                        <optgroup label="In use">
                                            <t t-foreach="state.bill.currencies" t-as="cur" t-key="cur.id">
                                                <option t-if="cur.active" t-att-value="cur.id" t-att-selected="('' + cur.id) === ('' + state.bill.edit.currency_id)" t-esc="cur.name + (cur.symbol ? ' (' + cur.symbol + ')' : '')"/>
                                            </t>
                                        </optgroup>
                                        <optgroup label="All currencies">
                                            <t t-foreach="state.bill.currencies" t-as="cur" t-key="'all' + cur.id">
                                                <option t-if="!cur.active" t-att-value="cur.id" t-att-selected="('' + cur.id) === ('' + state.bill.edit.currency_id)" t-esc="cur.name + (cur.symbol ? ' (' + cur.symbol + ')' : '')"/>
                                            </t>
                                        </optgroup>
                                    </select>
                                </div>
                                <div class="col-md-4">
                                    <label class="form-label fw-semibold mb-1">
                                        Amount <span class="text-muted fw-normal" t-esc="state.bill.edit.method === 'hourly' ? '(per hour)' : '(per task)'"/>
                                    </label>
                                    <input type="number" min="0" step="0.01" class="form-control text-end" placeholder="0.00" t-model="state.bill.edit.amount"/>
                                </div>
                                <div class="col-md-4">
                                    <label class="form-label fw-semibold mb-1">Note <span class="text-muted fw-normal">(optional)</span></label>
                                    <input type="text" class="form-control" maxlength="200" t-model="state.bill.edit.note"/>
                                </div>
                                <div class="col-12">
                                    <a t-if="!state.bill.edit.showDates" href="#" class="small" t-on-click.prevent="() => { this.state.bill.edit.showDates = true; }">
                                        📅 Set dates (optional): only to plan a price change ahead
                                    </a>
                                    <div t-else="" class="row g-3">
                                        <div class="col-md-4">
                                            <label class="form-label fw-semibold mb-1">From <span class="text-muted fw-normal">(empty = always)</span></label>
                                            <input type="date" class="form-control" t-model="state.bill.edit.date_from"/>
                                        </div>
                                        <div class="col-md-4">
                                            <label class="form-label fw-semibold mb-1">To <span class="text-muted fw-normal">(empty = no end)</span></label>
                                            <input type="date" class="form-control" t-model="state.bill.edit.date_to"/>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div t-if="state.bill.error" class="text-danger fw-semibold small mt-3" role="alert">
                                <i class="fa fa-exclamation-circle me-1"/><t t-esc="state.bill.error"/>
                            </div>
                            <div class="d-flex gap-2 mt-3">
                                <button class="btn btn-success" t-att-disabled="state.bill.saving or dup" t-on-click="() => this.billSave()">Save</button>
                                <button class="btn btn-light border" t-on-click="() => { this.state.bill.edit = null; this.state.bill.error = ''; }">Cancel</button>
                            </div>
                        </div>
                    </div>
                </div>

            </t>
        </div>
    `;

    setup() {
        this.dialog = useService("dialog");
        this.state = useState({
            bill: { loaded: false, refused: "", rates: [], clients: [], currencies: [], work_types: [], companyCurrency: false,
                    groups: [], edit: null, saving: false, error: "" },
        });
        onWillStart(async () => { await this.loadBilling(); await this.loadGroups(); });
    }

    _flash(obj, key) {
        obj[key] = true;
        setTimeout(() => { try { obj[key] = false; } catch (e) { /* unmounted */ } }, 1500);
    }

    // Refused (not an admin): the page says so instead of showing the card.
    async loadBilling() {
        try {
            const r = await rpc("/kpi_billing/config", {});
            if (!r?.status) { this.state.bill.refused = r?.message || "Only an admin can change billing."; return; }
            const b = this.state.bill;
            b.rates = r.rates || [];
            b.clients = r.clients || [];
            b.currencies = r.currencies || [];
            b.work_types = r.work_types || [];
            b.companyCurrency = r.company_currency_id || false;
            b.loaded = true;
        } catch (e) { this.state.bill.refused = e?.data?.message || "Could not load billing."; }
    }

    // The price this one would clash with: same client (or Default), same work
    // type, overlapping days (no dates = always). The server refuses it too.
    billDuplicate() {
        const e = this.state.bill.edit;
        if (!e) return null;
        const from = e.date_from || "0000-01-01", to = e.date_to || FAR;
        return this.state.bill.rates.find((r) =>
            r.id !== e.id && String(r.client_id || "") === String(e.client_id || "") && r.work_type === e.work_type
            && (r.date_from || "0000-01-01") <= to && from <= (r.date_to || FAR)) || null;
    }

    // Sections: the Default, then every client, each with every work type.
    // A type with no price of its own falls back to the Default's; with
    // neither, no bill can be made (red).
    billSections() {
        const b = this.state.bill;
        const live = (r) => r.always || ((r.date_from || "0000-01-01") <= this._today() && this._today() <= (r.date_to || FAR));
        const ofClient = (id) => b.rates.filter((r) => String(r.client_id || "") === String(id || ""));
        const defaults = ofClient("");
        const build = (key, name, isDefault, client) => {
            const mine = ofClient(key);
            const types = b.work_types.map((w) => ({
                key: w.key, label: w.label,
                rates: mine.filter((r) => r.work_type === w.key),
                fallback: isDefault ? null : (defaults.find((r) => r.work_type === w.key && live(r)) || null),
            }));
            // The Default is optional: only a client's own gap is "missing".
            return { key, name, isDefault, client, types, own: mine.length,
                     missing: isDefault ? 0 : types.filter((t) => !t.rates.length && !t.fallback).length };
        };
        return [build("", "Default (every client)", true),
                ...b.clients.map((c) => build(String(c.id), c.name, false, c))];
    }
    billMissingCount() {
        return this.billSections().filter((s) => !s.isDefault).reduce((n, s) => n + s.missing, 0);
    }
    _today() {
        return new Date().toISOString().slice(0, 10);
    }
    // "+ Add" in a section: a new price for that client and work type.
    billAddFor(clientKey, workType) {
        this.state.bill.error = "";
        this.state.bill.edit = {
            id: false, client_id: clientKey || "", work_type: workType, method: "per_task", amount: "",
            currency_id: String(this._usualCurrency()), date_from: "", date_to: "", note: "", showDates: false,
        };
        setTimeout(() => {
            const el = document.querySelector('.o_kpi_billing_form');
            if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
            const amt = el && el.querySelector('input[type=number]');
            if (amt) { amt.focus(); }
        }, 50);
    }

    billEdit(r) {
        const b = this.state.bill;
        b.error = "";
        b.edit = r ? {
            id: r.id, client_id: r.client_id ? String(r.client_id) : "", work_type: r.work_type, method: r.method,
            amount: r.amount, currency_id: String(r.currency_id), date_from: r.date_from || "", date_to: r.date_to || "",
            note: r.note || "", showDates: !r.always,
        } : {
            // A new price starts on the first work type the Default has no price for yet.
            id: false, client_id: "", work_type: this._freeWorkType(""), method: "per_task",
            amount: "", currency_id: String(this._usualCurrency()),
            date_from: "", date_to: "", note: "", showDates: false,
        };
        if (r) { this._scrollToForm(); }
    }
    _scrollToForm() {
        setTimeout(() => {
            const el = document.querySelector('.o_kpi_billing_form');
            if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        }, 50);
    }

    _usualCurrency() {
        const b = this.state.bill;
        const newest = b.rates.reduce((a, r) => (!a || r.id > a.id ? r : a), null);
        return (newest && newest.currency_id) || b.companyCurrency || ((b.currencies[0] || {}).id || "");
    }
    _freeWorkType(clientId) {
        const b = this.state.bill;
        const used = new Set(b.rates.filter((r) => String(r.client_id || "") === String(clientId || "") && r.always).map((r) => r.work_type));
        const free = b.work_types.find((w) => !used.has(w.key));
        return (free || b.work_types[0] || {}).key || "requirement";
    }
    billTypeLabel(key) {
        return ((this.state.bill.work_types.find((w) => w.key === key)) || {}).label || key;
    }
    billClientLabel(id) {
        return id ? (((this.state.bill.clients.find((c) => String(c.id) === String(id))) || {}).name || "this client") : "the Default";
    }

    async billSave() {
        const b = this.state.bill, e = b.edit;
        if (!e || this.billDuplicate()) return;
        if (e.amount === "" || isNaN(parseFloat(e.amount))) { b.error = "Enter the amount."; return; }
        b.saving = true; b.error = "";
        try {
            const r = await rpc("/kpi_billing/rate/save", {
                id: e.id || null, client_id: e.client_id ? parseInt(e.client_id) : null, work_type: e.work_type,
                method: e.method, amount: e.amount, currency_id: e.currency_id ? parseInt(e.currency_id) : null,
                date_from: e.date_from || null, date_to: e.date_to || null, note: e.note || "",
            });
            if (!r?.status) { b.error = r?.message || "Could not save the price."; return; }
            b.edit = null;
            await this.loadBilling();
        } catch (err) {
            b.error = err?.data?.message || "Could not save the price.";
        } finally { b.saving = false; }
    }

    billDelete(r) {
        const what = (r.client_name || "Default") + " · " + r.work_type_label;
        this.dialog.add(ConfirmationDialog, {
            title: "Delete this price?",
            body: what + ". A price already used on a bill is kept for that bill and only hidden here.",
            confirmLabel: "Delete",
            confirm: async () => {
                try {
                    const res = await rpc("/kpi_billing/rate/delete", { id: r.id });
                    if (!res?.status) { this.state.bill.error = res?.message || "Could not delete."; return; }
                    if (this.state.bill.edit && this.state.bill.edit.id === r.id) this.state.bill.edit = null;
                    await this.loadBilling();
                } catch (e) { this.state.bill.error = e?.data?.message || "Could not delete."; }
            },
            cancel: () => {},
        });
    }

    // WhatsApp groups for the invoice group pickers (same list as Configuration's
    // group card). Silent when the gateway is offline: the chosen group still shows.
    async loadGroups() {
        try {
            const g = await rpc("/kpi_wa_group/list", {});
            if (g?.status !== false) {
                this.state.bill.groups = (g?.groups || []).filter((x) => x.jid && (x.jid + "").endsWith("@g.us"));
            }
        } catch (e) { /* gateway offline */ }
    }
    billGroupKnown(jid) {
        return this.state.bill.groups.some((g) => g.jid === jid);
    }
    async _billClientSet(client, vals) {
        try {
            const r = await rpc("/kpi_billing/client_invoice_set", { client_id: client.id, ...vals });
            if (!r?.status) { this.state.bill.error = r?.message || "Could not save."; return; }
            client.invoice_group_jid = r.invoice_group_jid;
            client.invoice_group_name = r.invoice_group_name;
            client.send_invoice = r.send_invoice;
        } catch (e) { this.state.bill.error = e?.data?.message || "Could not save."; }
    }
    billSetGroup(client, jid) {
        const g = this.state.bill.groups.find((x) => x.jid === jid);
        return this._billClientSet(client, { jid: jid || "", name: g ? (g.name || "") : "" });
    }
    billSetSend(client, on) {
        return this._billClientSet(client, { send: !!on });
    }
}

registry.category("actions").add("kpi_billing_settings", KpiBillingSettings);
