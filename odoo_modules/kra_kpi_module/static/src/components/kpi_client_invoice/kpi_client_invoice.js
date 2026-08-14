/** @odoo-module **/
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

// Shared template — used by both Admin and Portal entry points.
// Admin/portal differences are controlled by `state.isPortal`.
const TEMPLATE = xml/* xml */`
<div class="o_kpi_client_invoice p-4">

    <!-- ─── Header ─── -->
    <div class="d-flex justify-content-between align-items-center mb-4">
        <h2 class="fw-bold">
            <i class="fa fa-file-text-o me-2 text-primary"/>
            <t t-if="state.isPortal">My Invoices</t>
            <t t-else="">Client Invoices</t>
        </h2>
        <div>
            <button t-if="state.view === 'detail'"
                    class="btn btn-secondary"
                    t-on-click="backToList">← Back to List</button>
        </div>
    </div>

    <!-- ─── LIST VIEW ─── -->
    <t t-if="state.view === 'list'">

        <!-- New invoice card (admin only). Collapsed by default: raising an invoice is
             occasional, but this form sat permanently above the list of existing ones,
             which is what the screen is usually opened to read. -->
        <div t-if="!state.isPortal" class="card p-3 mb-4 shadow-sm">
            <h5 class="fw-bold mb-0" style="cursor:pointer;"
                t-on-click="() => state.showCreate = !state.showCreate">
                <i t-att-class="'fa me-2 ' + (state.showCreate ? 'fa-caret-down' : 'fa-caret-right')"/>
                <i class="fa fa-plus-circle me-2 text-success"/>
                Create New Invoice
                <span t-if="!state.showCreate" class="text-muted small fw-normal ms-2">
                    — click to open
                </span>
            </h5>
            <div t-if="state.showCreate" class="row g-3 align-items-end mt-0">
                <div class="col-md-4">
                    <label class="form-label fw-bold">
                        Client <span class="text-danger">*</span>
                    </label>
                    <select t-att-class="'form-select' + (state.missingClient ? ' is-invalid border-danger' : '')"
                            t-model="state.newInvoice.client_kra_id"
                            t-on-change="onClientChange">
                        <option value="">-- Select Client --</option>
                        <!-- Grouped so the clients you can actually invoice today are not
                             buried among ones with nothing outstanding. optgroup, so the
                             headings are real and unselectable rather than styled options. -->
                        <t t-foreach="clientGroups()" t-as="g" t-key="g.key">
                            <optgroup t-if="g.clients.length" t-att-label="g.label + ' (' + g.clients.length + ')'">
                                <t t-foreach="g.clients" t-as="c" t-key="c.id">
                                    <option t-att-value="c.id">
                                        <t t-esc="c.parent_name ? c.parent_name + ' > ' + c.name : c.name"/>
                                        <t t-if="c.billable_count"> — <t t-esc="c.billable_count"/> to bill</t>
                                        <t t-elif="c.invoiced_count"> — all invoiced</t>
                                        <t t-if="c.has_client_user === false"> · no client user assigned</t>
                                    </option>
                                </t>
                            </optgroup>
                        </t>
                    </select>
                    <div t-if="state.missingClient" class="invalid-feedback d-block">
                        Choose the client this invoice is for.
                    </div>
                </div>
                <div class="col-md-4">
                    <label class="form-label fw-bold">Invoice Title <span class="text-muted small">(optional)</span></label>
                    <input type="text" class="form-control"
                           placeholder="e.g. Monthly Services - May 2026"
                           t-model="state.newInvoice.invoice_title"/>
                </div>
                <!-- Date range with quick presets. Clicking a preset auto-fills From/To. -->
                <div class="col-12">
                    <label class="form-label fw-bold">
                        <i class="fa fa-calendar me-1 text-muted"/> Date Range
                    </label>
                    <div class="btn-group mb-2 w-100" role="group" aria-label="Date range preset">
                        <button type="button"
                                t-att-class="'btn btn-sm ' + (state.newInvoice.range_preset === 'all' ? 'btn-success' : 'btn-outline-success')"
                                t-on-click="() => this.setRangePreset('all')"
                                title="Bill everything the client has signed off that isn't already invoiced">All unbilled</button>
                        <button type="button"
                                t-att-class="'btn btn-sm ' + (state.newInvoice.range_preset === 'today' ? 'btn-primary' : 'btn-outline-primary')"
                                t-on-click="() => this.setRangePreset('today')">Today</button>
                        <button type="button"
                                t-att-class="'btn btn-sm ' + (state.newInvoice.range_preset === 'yesterday' ? 'btn-primary' : 'btn-outline-primary')"
                                t-on-click="() => this.setRangePreset('yesterday')">Yesterday</button>
                        <button type="button"
                                t-att-class="'btn btn-sm ' + (state.newInvoice.range_preset === 'this_week' ? 'btn-primary' : 'btn-outline-primary')"
                                t-on-click="() => this.setRangePreset('this_week')">This Week</button>
                        <button type="button"
                                t-att-class="'btn btn-sm ' + (state.newInvoice.range_preset === 'this_month' ? 'btn-primary' : 'btn-outline-primary')"
                                t-on-click="() => this.setRangePreset('this_month')">This Month</button>
                        <button type="button"
                                t-att-class="'btn btn-sm ' + (state.newInvoice.range_preset === 'last_month' ? 'btn-primary' : 'btn-outline-primary')"
                                t-on-click="() => this.setRangePreset('last_month')">Last Month</button>
                        <button type="button"
                                t-att-class="'btn btn-sm ' + (state.newInvoice.range_preset === 'custom' ? 'btn-primary' : 'btn-outline-primary')"
                                t-on-click="() => this.setRangePreset('custom')">Custom</button>
                    </div>
                </div>
                <div class="col-md-3">
                    <label class="form-label fw-bold">From</label>
                    <input type="date" class="form-control"
                           t-model="state.newInvoice.from_date"
                           t-on-change="() => this.markCustomRange()"/>
                </div>
                <div class="col-md-3">
                    <label class="form-label fw-bold">To</label>
                    <input type="date" class="form-control"
                           t-model="state.newInvoice.to_date"
                           t-on-change="() => this.markCustomRange()"/>
                </div>
                <!-- Billing method: Per Hour (rate) vs Per Task by Type (prices set in a popup). -->
                <div class="col-12">
                    <label class="form-label fw-bold">
                        <i class="fa fa-money me-1 text-muted"/> Billing Method
                    </label>
                    <div class="btn-group w-100" role="group" aria-label="Billing method">
                        <button type="button"
                                t-att-class="'btn btn-sm ' + (state.newInvoice.billing_method === 'hourly' ? 'btn-primary' : 'btn-outline-primary')"
                                t-on-click="() => state.newInvoice.billing_method = 'hourly'">
                            <i class="fa fa-clock-o me-1"/> Per Hour
                        </button>
                        <button type="button"
                                t-att-class="'btn btn-sm ' + (state.newInvoice.billing_method === 'per_task' ? 'btn-primary' : 'btn-outline-primary')"
                                t-on-click="() => state.newInvoice.billing_method = 'per_task'">
                            <i class="fa fa-tasks me-1"/> Per Task by Type
                        </button>
                    </div>
                </div>
                <!-- Per Hour Rate — hourly mode only. In per_task mode the per-type
                     prices are declared in a popup before billing. -->
                <div class="col-md-3" t-if="state.newInvoice.billing_method === 'hourly'">
                    <label class="form-label fw-bold">Per Hour Rate <span class="text-muted small">(0 = time-only)</span></label>
                    <input type="number" step="0.01" class="form-control"
                           placeholder="0.00"
                           t-model.number="state.newInvoice.hourly_rate"/>
                </div>
                <div class="col-md-3" t-if="state.showAdvanced">
                    <label class="form-label fw-bold">Currency</label>
                    <select class="form-select" t-model="state.newInvoice.currency_id">
                        <option value="">-- default --</option>
                        <t t-foreach="state.currencies" t-as="cur" t-key="cur.id">
                            <option t-att-value="cur.id">
                                <t t-esc="cur.name"/> <t t-if="cur.symbol">(<t t-esc="cur.symbol"/>)</t>
                            </option>
                        </t>
                    </select>
                </div>
                <div class="col-md-6" t-if="state.newInvoice.billing_method === 'per_task'">
                    <div class="alert alert-secondary py-2 mb-0 small mt-4">
                        <i class="fa fa-info-circle me-1"/>
                        After you click <b>Create Invoice</b>, you'll set a price for
                        <b>each task individually</b> in the invoice.
                    </div>
                </div>
                <!-- Task-type checkboxes — defaults to all 3 checked.  Empty = include all.
                     Deliberately NOT behind the Advanced toggle: it renders above the
                     toggle and reads as an ordinary field, so collapsing Advanced looked
                     like the task types had vanished on their own. -->
                <div class="col-12">
                    <label class="form-label fw-bold">
                        <i class="fa fa-tags me-1 text-muted"/> Include Task Types
                    </label>
                    <div class="d-flex gap-3 flex-wrap">
                        <div class="form-check">
                            <input class="form-check-input" type="checkbox" id="inv_chk_req"
                                   t-model="state.newInvoice.include_req"/>
                            <label class="form-check-label" for="inv_chk_req">
                                <span class="badge bg-primary">REQ</span> Requirements
                            </label>
                        </div>
                        <div class="form-check">
                            <input class="form-check-input" type="checkbox" id="inv_chk_upt"
                                   t-model="state.newInvoice.include_upt"/>
                            <label class="form-check-label" for="inv_chk_upt">
                                <span class="badge bg-info">UPT</span> Updates / Amendments
                            </label>
                        </div>
                        <div class="form-check">
                            <input class="form-check-input" type="checkbox" id="inv_chk_bug"
                                   t-model="state.newInvoice.include_bug"/>
                            <label class="form-check-label" for="inv_chk_bug">
                                <span class="badge bg-danger">BUG</span> Bug Fixes
                            </label>
                        </div>
                    </div>
                </div>
                <div class="col-12">
                    <!-- Live currency-aware preview before the user commits. -->
                    <div class="alert alert-info py-2 mb-0 small"
                         t-if="state.newInvoice.billing_method === 'hourly' and state.newInvoice.hourly_rate > 0">
                        <i class="fa fa-calculator me-1"/>
                        Rate: <b t-esc="getRatePreview()"/>
                        — final invoice total = (grand total hours) × (rate above).
                        Currency: <b t-esc="getCurrencyPreview()"/>.
                    </div>
                </div>

            </div>

            <!-- Sub-KRA (project) filter — appears once a client is chosen. -->
            <!-- Advanced toggle. Everything behind it already has a correct default —
                 currency from the client KRA, all three task types, empty filters
                 meaning "everything" — so the everyday path is client + period + Create. -->
            <div t-if="state.showCreate" class="mt-3">
                <button type="button" class="btn btn-sm btn-link px-0 text-decoration-none"
                        t-on-click="() => state.showAdvanced = !state.showAdvanced">
                    <i t-att-class="'fa me-1 ' + (state.showAdvanced ? 'fa-caret-down' : 'fa-caret-right')"/>
                    Advanced options
                    <span class="text-muted small">(currency, filters)</span>
                </button>
            </div>

            <div t-if="state.showCreate and state.showAdvanced and state.scopeSubKras.length > 0" class="row g-3 mt-2">
                <div class="col-12">
                    <label class="form-label fw-bold">
                        <i class="fa fa-sitemap me-1 text-muted"/> Filter: Sub-KRA / Project
                        <span class="text-muted small">(optional — leave empty to invoice the whole client)</span>
                    </label>
                    <div class="border rounded p-2" style="max-height:160px; overflow-y:auto;">
                        <t t-foreach="state.scopeSubKras" t-as="s" t-key="s.id">
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox"
                                       t-att-id="'sub_' + s.id"
                                       t-att-checked="isFilterSelected('filter_sub_kra_ids', s.id)"
                                       t-on-change="() => this.toggleSubKra(s.id)"/>
                                <label class="form-check-label" t-att-for="'sub_' + s.id" t-esc="s.name"/>
                            </div>
                        </t>
                    </div>
                </div>
            </div>

            <!-- Optional filter: developer. Populated after client selection. -->
            <div t-if="state.showCreate and state.showAdvanced and state.scopeUsers.length > 0" class="row g-3 mt-2">
                <div class="col-md-6">
                    <label class="form-label fw-bold">
                        <i class="fa fa-user me-1 text-muted"/> Filter: Developers
                        <span class="text-muted small">(optional — leave empty for all)</span>
                    </label>
                    <div class="border rounded p-2" style="max-height:160px; overflow-y:auto;">
                        <t t-foreach="state.scopeUsers" t-as="u" t-key="u.id">
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox"
                                       t-att-id="'usr_' + u.id"
                                       t-att-checked="isFilterSelected('filter_user_ids', u.id)"
                                       t-on-change="() => this.toggleFilter('filter_user_ids', u.id)"/>
                                <label class="form-check-label" t-att-for="'usr_' + u.id" t-esc="u.name"/>
                            </div>
                        </t>
                    </div>
                </div>
            </div>

            <!-- Tasks get the full width and two boxes. One mixed list meant tickable and
                 untickable rows sat together, and a tick on an already-invoiced row
                 narrowed the invoice down to work that cannot be billed — an empty
                 invoice raised from a form where you had just ticked three things. -->
            <div t-if="state.showCreate and state.showAdvanced and state.scopeKpis.length > 0" class="row g-3 mt-2">
                <div class="col-12">
                    <label class="form-label fw-bold">
                        <i class="fa fa-tasks me-1 text-muted"/> Filter: Tasks
                        <span class="text-muted small">(optional — leave empty for all)</span>
                    </label>
                    <div class="row g-2">
                        <div class="col-md-6">
                            <div class="small fw-bold text-success mb-1">
                                <i class="fa fa-check-square-o me-1"/>
                                Available to bill
                                <span class="badge bg-success-subtle text-success ms-1"
                                      t-esc="leftScopeKpis().length"/>
                            </div>
                            <div class="border rounded p-2" style="max-height:190px; overflow-y:auto;">
                                <t t-foreach="leftScopeKpis()" t-as="k" t-key="k.id">
                                    <div class="form-check">
                                        <!-- Only billable rows get a box. On the others it
                                             could be ticked but never meant anything. -->
                                        <input t-if="k.billable !== false"
                                               class="form-check-input" type="checkbox"
                                               t-att-id="'kpi_' + k.id"
                                               t-att-checked="isFilterSelected('filter_kpi_ids', k.id)"
                                               t-on-change="() => this.toggleFilter('filter_kpi_ids', k.id)"/>
                                        <label t-att-for="'kpi_' + k.id"
                                               t-att-class="'form-check-label' + (k.billable === false ? ' text-muted' : '')">
                                            <t t-esc="k.name"/>
                                            <span t-if="k.kra_name" class="text-muted">  (<t t-esc="k.kra_name"/>)</span>
                                            <span t-if="k.billable === false"
                                                  t-att-class="'badge ms-1 ' + billBadgeClass(k)"
                                                  t-esc="k.not_billable_reason"/>
                                        </label>
                                    </div>
                                </t>
                                <div t-if="leftScopeKpis().length === 0" class="text-muted small p-1">
                                    <i class="fa fa-info-circle me-1"/>
                                    <t t-esc="emptyBillableMessage()"/>
                                </div>
                            </div>
                            <!-- An invoice can only bill signed-off work, so unsigned tasks
                                 are noise here — but hiding them silently would leave an
                                 empty box with no explanation. -->
                            <button t-if="unsignedScopeKpis().length > 0"
                                    type="button" class="btn btn-sm btn-link px-0 text-muted text-decoration-none"
                                    t-on-click="() => state.showUnsignedTasks = !state.showUnsignedTasks">
                                <i t-att-class="'fa me-1 ' + (state.showUnsignedTasks ? 'fa-caret-down' : 'fa-caret-right')"/>
                                <t t-esc="unsignedScopeKpis().length"/> task(s) hidden — not signed off yet
                            </button>
                        </div>
                        <div class="col-md-6">
                            <div class="small fw-bold text-secondary mb-1">
                                <i class="fa fa-lock me-1"/>
                                Already invoiced
                                <span class="badge bg-secondary-subtle text-secondary ms-1"
                                      t-esc="invoicedScopeKpis().length"/>
                            </div>
                            <div class="border rounded p-2 bg-light" style="max-height:190px; overflow-y:auto;">
                                <t t-foreach="invoicedScopeKpis()" t-as="k" t-key="k.id">
                                    <div class="form-check">
                                        <label class="form-check-label text-muted">
                                            <t t-esc="k.name"/>
                                            <span t-if="k.kra_name" class="text-muted">  (<t t-esc="k.kra_name"/>)</span>
                                            <span t-att-class="'badge ms-1 ' + billBadgeClass(k)"
                                                  t-esc="k.not_billable_reason"/>
                                        </label>
                                    </div>
                                </t>
                                <div t-if="invoicedScopeKpis().length === 0" class="text-muted small p-1">
                                    <i class="fa fa-info-circle me-1"/>
                                    No invoiced tasks yet.
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Create sits LAST so the form reads top-to-bottom. It used to render
                 above the three filters, which asked you to submit before you had
                 seen the rest of the form. -->
            <div t-if="state.showCreate" class="row g-3 mt-2">
                <div class="col-12">
                    <button class="btn btn-primary w-100" t-on-click="createInvoice"
                            t-att-disabled="state.creating">
                        <t t-if="state.creating">
                            <i class="fa fa-spinner fa-spin me-1"/> Creating…
                        </t>
                        <t t-else="">
                            <i class="fa fa-plus me-1"/> Create Invoice
                        </t>
                    </button>
                </div>
            </div>
        </div>

        <!-- Invoices list -->
        <div class="card p-3 shadow-sm">
            <h5 class="fw-bold mb-3">
                <i class="fa fa-list me-2 text-secondary"/>
                <t t-if="state.isPortal">Invoices for you</t>
                <t t-else="">All Invoices</t>
                <span class="badge bg-secondary ms-2" t-esc="state.invoices.length"/>
            </h5>
            <!-- Client's own chips. Same filters and same counts as the admin's, in the
                 client's words: "Payment Due" is the biller's term for it, and to the
                 person who owes the money it is simply Unpaid. Drafts never appear under
                 any of them — the record rule keeps a client to finalized/sent, and both
                 search and search_count run as the logged-in user. -->
            <div t-if="state.isPortal" class="mb-3 d-flex flex-wrap gap-2">
                <button type="button"
                        t-att-class="'btn btn-sm ' + (state.statusFilter === 'all' ? 'btn-primary' : 'btn-outline-primary')"
                        t-on-click="() => this.setStatusFilter('all')">
                    All
                    <span class="badge bg-light text-dark ms-1" t-esc="state.counts.all || 0"/>
                </button>
                <button type="button"
                        t-att-class="'btn btn-sm ' + (state.statusFilter === 'due' ? 'btn-danger' : 'btn-outline-danger')"
                        t-on-click="() => this.setStatusFilter('due')"
                        title="Invoices you still owe">
                    <i class="fa fa-exclamation-circle me-1"/> Unpaid
                    <span class="badge bg-light text-dark ms-1" t-esc="state.counts.due || 0"/>
                </button>
                <button type="button"
                        t-att-class="'btn btn-sm ' + (state.statusFilter === 'claimed' ? 'btn-warning' : 'btn-outline-warning')"
                        t-on-click="() => this.setStatusFilter('claimed')"
                        title="You reported paying these — we're confirming the money arrived">
                    <i class="fa fa-hourglass-half me-1"/> Claimed
                    <span class="badge bg-light text-dark ms-1" t-esc="state.counts.claimed || 0"/>
                </button>
                <button type="button"
                        t-att-class="'btn btn-sm ' + (state.statusFilter === 'paid' ? 'btn-success' : 'btn-outline-success')"
                        t-on-click="() => this.setStatusFilter('paid')">
                    <i class="fa fa-check-circle me-1"/> Paid
                    <span class="badge bg-light text-dark ms-1" t-esc="state.counts.paid || 0"/>
                </button>
            </div>
            <!-- Status filter chips (admin only) -->
            <div t-if="!state.isPortal" class="mb-3 d-flex flex-wrap gap-2">
                <button type="button"
                        t-att-class="'btn btn-sm ' + (state.statusFilter === 'all' ? 'btn-primary' : 'btn-outline-primary')"
                        t-on-click="() => this.setStatusFilter('all')">
                    All
                    <span class="badge bg-light text-dark ms-1" t-esc="state.counts.all || 0"/>
                </button>
                <button type="button"
                        t-att-class="'btn btn-sm ' + (state.statusFilter === 'draft' ? 'btn-secondary' : 'btn-outline-secondary')"
                        t-on-click="() => this.setStatusFilter('draft')">
                    Draft
                    <span class="badge bg-light text-dark ms-1" t-esc="state.counts.draft || 0"/>
                </button>
                <button type="button"
                        t-att-class="'btn btn-sm ' + (state.statusFilter === 'finalized' ? 'btn-warning' : 'btn-outline-warning')"
                        t-on-click="() => this.setStatusFilter('finalized')">
                    Finalized
                    <span class="badge bg-light text-dark ms-1" t-esc="state.counts.finalized || 0"/>
                </button>
                <button type="button"
                        t-att-class="'btn btn-sm ' + (state.statusFilter === 'sent' ? 'btn-info' : 'btn-outline-info')"
                        t-on-click="() => this.setStatusFilter('sent')">
                    Sent
                    <span class="badge bg-light text-dark ms-1" t-esc="state.counts.sent || 0"/>
                </button>
                <button type="button"
                        t-att-class="'btn btn-sm ' + (state.statusFilter === 'due' ? 'btn-danger' : 'btn-outline-danger')"
                        t-on-click="() => this.setStatusFilter('due')"
                        title="Billed to the client and still unpaid, with no payment claim outstanding">
                    <i class="fa fa-exclamation-circle me-1"/> Payment Due
                    <span class="badge bg-light text-dark ms-1" t-esc="state.counts.due || 0"/>
                </button>
                <!-- Sits between Due and Paid because that is where the money is: the
                     client says it has left their account, you have not confirmed it
                     arrived. Amber matches the row and detail badges for the same state. -->
                <button type="button"
                        t-att-class="'btn btn-sm ' + (state.statusFilter === 'claimed' ? 'btn-warning' : 'btn-outline-warning')"
                        t-on-click="() => this.setStatusFilter('claimed')"
                        title="The client reported paying these — confirm the money arrived, or clear the claim">
                    <i class="fa fa-hourglass-half me-1"/> Payment Claimed
                    <span class="badge bg-light text-dark ms-1" t-esc="state.counts.claimed || 0"/>
                </button>
                <button type="button"
                        t-att-class="'btn btn-sm ' + (state.statusFilter === 'paid' ? 'btn-success' : 'btn-outline-success')"
                        t-on-click="() => this.setStatusFilter('paid')">
                    <i class="fa fa-check-circle me-1"/> Paid
                    <span class="badge bg-light text-dark ms-1" t-esc="state.counts.paid || 0"/>
                </button>
            </div>
            <div t-if="state.invoices.length === 0" class="text-center text-muted p-4">
                <i class="fa fa-inbox fa-3x mb-2 d-block"/>
                No invoices yet.
            </div>
            <table t-if="state.invoices.length > 0" class="table table-hover align-middle">
                <thead class="table-light">
                    <tr>
                        <th>Invoice #</th>
                        <th>Client</th>
                        <th>Period</th>
                        <th>Invoice Date</th>
                        <th>Status</th>
                        <th>Payment</th>
                        <th class="text-end">Quoted</th>
                        <th class="text-end">Adjust</th>
                        <th class="text-end">Total Hrs</th>
                        <th>&#160;</th>
                    </tr>
                </thead>
                <tbody>
                    <t t-foreach="state.invoices" t-as="inv" t-key="inv.id">
                        <tr>
                            <td class="fw-bold">
                                <t t-esc="inv.name"/>
                                <span t-if="inv.state === 'draft'" class="badge bg-secondary ms-2">Draft</span>
                                <span t-elif="inv.payment_status === 'paid'" class="badge bg-success ms-2">Paid</span>
                                <span t-else="" class="badge bg-danger ms-2">Unpaid</span>
                            </td>
                            <td>
                                <span t-if="inv.parent_name" class="text-muted small">
                                    <t t-esc="inv.parent_name"/> &gt;
                                </span>
                                <t t-esc="inv.client_name"/>
                            </td>
                            <td><t t-esc="inv.from_date"/> → <t t-esc="inv.to_date"/></td>
                            <td t-esc="inv.invoice_date"/>
                            <td>
                                <span class="badge"
                                      t-att-class="{
                                          'bg-secondary': inv.state === 'draft',
                                          'bg-warning text-dark': inv.state === 'finalized',
                                          'bg-info': inv.state === 'sent',
                                      }"
                                      t-esc="inv.state"/>
                            </td>
                            <td>
                                <t t-if="inv.state === 'draft'">
                                    <span class="text-muted small">—</span>
                                </t>
                                <t t-elif="inv.payment_status === 'paid'">
                                    <span class="badge bg-success">
                                        <i class="fa fa-check me-1"/> Paid
                                    </span>
                                </t>
                                <!-- The client says they paid and nobody has checked yet.
                                     Amber, between Due and Paid, and NOT a payment_status
                                     value: nothing is part-settled, the full amount is
                                     claimed and unverified. -->
                                <t t-elif="inv.client_paid_claim">
                                    <span class="badge bg-warning text-dark"
                                          title="The client reported paying this. Confirm it to close the invoice.">
                                        <i class="fa fa-hourglass-half me-1"/> Claimed
                                    </span>
                                </t>
                                <t t-else="">
                                    <span class="badge bg-danger">
                                        <i class="fa fa-clock-o me-1"/> Due
                                    </span>
                                </t>
                                <!-- A settled invoice that went back to Due. Called out on
                                     the row itself because the whole point is that the
                                     client should not have to open it to find out why. -->
                                <div t-if="inv.unpaid_reason" class="small text-danger fw-bold mt-1"
                                     t-att-title="inv.unpaid_reason">
                                    <i class="fa fa-undo me-1"/>Payment reversed
                                </div>
                            </td>
                            <td class="text-end" t-esc="inv.total_quoted_hours + 'h'"/>
                            <td class="text-end" t-esc="inv.total_adjusted_hours + 'h'"/>
                            <td class="text-end fw-bold" t-esc="inv.grand_total_hours + 'h'"/>
                            <td>
                                <button class="btn btn-sm btn-outline-primary me-1"
                                        t-on-click="() => this.openInvoice(inv.id)">
                                    <i class="fa fa-eye me-1"/> Open
                                </button>
                                <button class="btn btn-sm btn-outline-success me-1"
                                        t-on-click="() => this.downloadPdf(inv.id)">
                                    <i class="fa fa-download me-1"/> PDF
                                </button>
                                <!-- Payment toggle (admin only) -->
                                <t t-if="!state.isPortal and inv.state !== 'draft'">
                                    <t t-if="inv.payment_status !== 'paid'">
                                        <button class="btn btn-sm btn-success"
                                                title="Record payment received"
                                                t-on-click="() => this.markPaidPrompt(inv)">
                                            <i class="fa fa-check me-1"/> Mark Paid
                                        </button>
                                    </t>
                                    <t t-else="">
                                        <button class="btn btn-sm btn-outline-warning"
                                                title="Revert to Due (payment bounced / wrong entry)"
                                                t-on-click="() => this.markUnpaidPrompt(inv)">
                                            <i class="fa fa-undo me-1"/> Revert
                                        </button>
                                    </t>
                                </t>
                                <!-- CLIENT's own "I've paid". A claim, not a settlement:
                                     it notifies the admins, who confirm. Once claimed the
                                     button is replaced, so they can't submit twice. -->
                                <t t-if="state.isPortal and inv.state !== 'draft' and inv.payment_status !== 'paid'">
                                    <button t-if="!inv.client_paid_claim"
                                            class="btn btn-sm btn-success"
                                            title="Tell us you've paid this invoice"
                                            t-on-click="() => this.clientPaidPrompt(inv)">
                                        <i class="fa fa-check me-1"/> I've paid
                                    </button>
                                    <span t-else="" class="text-muted small">
                                        <i class="fa fa-hourglass-half me-1"/> Awaiting confirmation
                                    </span>
                                </t>
                            </td>
                        </tr>
                    </t>
                </tbody>
            </table>
        </div>
    </t>

    <!-- ─── DETAIL VIEW ─── -->
    <t t-if="state.view === 'detail' and state.invoice">

        <!-- Status banner + actions -->
        <div class="card p-3 mb-3 shadow-sm">
            <div class="d-flex justify-content-between align-items-center flex-wrap">
                <div>
                    <h4 class="mb-1">
                        <span class="text-muted me-2">Invoice</span>
                        <span class="fw-bold" t-esc="state.invoice.name"/>
                        <span t-if="state.invoice.state === 'draft'" class="badge bg-secondary ms-2 align-middle">Draft</span>
                        <span t-elif="state.invoice.payment_status === 'paid'" class="badge bg-success ms-2 align-middle">Paid</span>
                        <span t-elif="state.invoice.client_paid_claim" class="badge bg-warning text-dark ms-2 align-middle">Payment claimed</span>
                        <span t-else="" class="badge bg-danger ms-2 align-middle">Unpaid</span>
                    </h4>
                    <div class="text-muted">
                        <strong>Client:</strong>
                        <t t-if="state.invoice.parent_name">
                            <t t-esc="state.invoice.parent_name"/> &gt;
                        </t>
                        <t t-esc="state.invoice.client_name"/>
                        &#160;|&#160;
                        <strong>Period:</strong>
                        <t t-esc="state.invoice.from_date"/> → <t t-esc="state.invoice.to_date"/>
                        &#160;|&#160;
                        <strong>Status:</strong>
                        <span class="badge ms-1"
                              t-att-class="{
                                  'bg-secondary': state.invoice.state === 'draft',
                                  'bg-warning text-dark': state.invoice.state === 'finalized',
                                  'bg-success': state.invoice.state === 'sent',
                              }"
                              t-esc="state.invoice.state"/>
                    </div>
                </div>
                <div>
                    <!-- Hide every price/amount for a clean CEO/client view + download. -->
                    <div class="form-check form-switch d-inline-flex align-items-center me-3">
                        <input class="form-check-input me-2" type="checkbox" id="inv_show_amounts"
                               t-att-checked="state.showAmounts"
                               t-on-change="(ev) => state.showAmounts = ev.target.checked"/>
                        <label class="form-check-label small text-nowrap" for="inv_show_amounts">Show amounts</label>
                    </div>
                    <button class="btn btn-outline-success me-2"
                            t-on-click="() => this.downloadPdf(state.invoice.id)">
                        <i class="fa fa-download me-1"/> Download PDF
                    </button>
                    <t t-if="!state.isPortal">
                        <button t-if="state.invoice.state === 'draft'"
                                class="btn btn-warning me-2"
                                t-on-click="finalizeInvoice">
                            <i class="fa fa-lock me-1"/> Finalize
                        </button>
                        <button t-if="state.invoice.state === 'finalized'"
                                class="btn btn-success me-2"
                                t-on-click="sendInvoice">
                            <i class="fa fa-paper-plane me-1"/> Mark Sent
                        </button>
                        <!-- Reduce a finalized invoice: reason → draft → edit → finalize.
                             Finalized only. Not sent (the client has that document), not
                             paid (the money arrived), and not while a payment claim is
                             open — the client has already sent money against this figure,
                             so it must not move under them. The server refuses all three.
                             Reset to Draft is locked on the same terms: it is the same
                             escape hatch by another name. -->
                        <button t-if="canEditFinalized()"
                                class="btn btn-outline-primary me-2"
                                title="Reopen to reduce the amount, then re-finalize"
                                t-on-click="reviseInvoice">
                            <i class="fa fa-pencil me-1"/> Revise
                        </button>
                        <button t-if="canEditFinalized()"
                                class="btn btn-outline-secondary"
                                t-on-click="resetDraft">
                            <i class="fa fa-undo me-1"/> Reset to Draft
                        </button>
                        <!-- Say why the buttons are gone; an unexplained absence reads as
                             a broken screen. The claim banner below carries the way out. -->
                        <span t-if="state.invoice.state === 'finalized' and state.invoice.payment_status !== 'paid' and state.invoice.client_paid_claim"
                              class="text-muted small fst-italic">
                            <i class="fa fa-lock me-1"/>
                            Revise is locked while the client's payment claim is open —
                            confirm it, or clear it if the money never arrived.
                        </span>
                        <!-- Draft only. A finalized invoice is a record the client has
                             seen, so it stays. Deleting a draft frees any task it was
                             holding back from future invoices. -->
                        <button t-if="state.invoice.state === 'draft'"
                                class="btn btn-outline-danger ms-2"
                                t-on-click="deleteInvoice">
                            <i class="fa fa-trash me-1"/> Delete Draft
                        </button>
                    </t>
                </div>
            </div>
        </div>

        <!-- Payment reversed. Shown to BOTH sides and in the loudest style on the page:
             the client had this invoice settled and now owes it again, which they must
             not have to discover by noticing a badge changed colour. -->
        <div t-if="state.invoice.unpaid_reason" class="alert alert-danger py-2 mb-3">
            <i class="fa fa-undo me-1"/>
            <strong t-if="state.isPortal">This payment was reversed — the invoice is due again.</strong>
            <strong t-else="">Payment reverted to Due.</strong>
            <div class="mt-1" style="white-space:pre-wrap;">
                <t t-esc="state.invoice.unpaid_reason"/>
            </div>
            <div t-if="state.invoice.unpaid_on" class="small text-muted mt-1">
                Reverted <t t-esc="state.invoice.unpaid_on"/>
            </div>
        </div>

        <!-- Revised: shown to BOTH sides. The client may be holding a PDF with the old
             figure, and a total that changes with no explanation is how disputes start. -->
        <div t-if="state.invoice.revised_on" class="alert alert-info py-2 mb-3">
            <i class="fa fa-pencil me-1"/>
            <strong>Revised</strong> on <t t-esc="state.invoice.revised_on"/>
            <t t-if="state.invoice.revision_reason"> — <t t-esc="state.invoice.revision_reason"/></t>
            <span t-if="state.invoice.revision_count > 1" class="text-muted small ms-2">
                (revised <t t-esc="state.invoice.revision_count"/> times)
            </span>
        </div>

        <!-- The client's payment claim. Admin gets Confirm / Not received; the client
             sees the same details read-only, so they know the claim registered. -->
        <div t-if="state.invoice.client_paid_claim" class="alert alert-warning d-flex flex-wrap align-items-center gap-2 py-2 mb-3">
            <div class="flex-grow-1">
                <i class="fa fa-hourglass-half me-1"/>
                <strong t-if="state.isPortal">You reported paying this invoice.</strong>
                <strong t-else="">The client reported paying this invoice.</strong>
                <span class="ms-1">
                    <t t-if="state.invoice.client_paid_method_label">
                        Method: <strong t-esc="state.invoice.client_paid_method_label"/>.
                    </t>
                    <t t-if="state.invoice.client_paid_claim_date">
                        Reported <t t-esc="state.invoice.client_paid_claim_date"/>.
                    </t>
                </span>
                <div t-if="state.invoice.client_paid_notes" class="small mt-1" style="white-space:pre-wrap;"
                     t-esc="state.invoice.client_paid_notes"/>
                <div t-if="state.isPortal" class="small text-muted mt-1">
                    Awaiting confirmation — we'll mark it paid once the payment is checked.
                </div>
            </div>
            <div t-if="!state.isPortal" class="text-nowrap">
                <button class="btn btn-sm btn-success me-2"
                        t-on-click="() => this.markPaidPrompt(state.invoice)">
                    <i class="fa fa-check me-1"/> Confirm payment
                </button>
                <button class="btn btn-sm btn-outline-secondary"
                        title="The payment never arrived — clear the claim"
                        t-on-click="clearPaidClaim">
                    Not received
                </button>
            </div>
        </div>

        <!-- Admin's own payment record. Never rendered in portal mode, and the server
             also withholds these fields from a client's payload. -->
        <div t-if="!state.isPortal and state.invoice.payment_status === 'paid'" class="alert alert-success py-2 mb-3">
            <i class="fa fa-check-circle me-1"/>
            <strong>Paid</strong>
            <t t-if="state.invoice.payment_method_label"> by <t t-esc="state.invoice.payment_method_label"/></t>
            <t t-if="state.invoice.payment_date"> on <t t-esc="state.invoice.payment_date"/></t>
            <t t-if="state.invoice.paid_by"> — recorded by <t t-esc="state.invoice.paid_by"/></t>
            <div t-if="state.invoice.payment_notes" class="small mt-1" style="white-space:pre-wrap;"
                 t-esc="state.invoice.payment_notes"/>
        </div>

        <!-- Editable header fields (draft only, admin only) -->
        <div t-if="!state.isPortal and state.invoice.state === 'draft'" class="card p-3 mb-3 shadow-sm">
            <div class="row g-3">
                <div class="col-md-8">
                    <label class="form-label fw-bold">Invoice Title</label>
                    <input type="text" class="form-control"
                           placeholder="e.g. Monthly Services - May 2026"
                           t-att-value="state.invoice.invoice_title"
                           t-on-blur="(ev) => this.saveHeader('invoice_title', ev.target.value)"/>
                </div>
                <div class="col-md-4" t-if="state.invoice.billing_method !== 'per_task' and state.showAmounts">
                    <label class="form-label fw-bold">Hourly Rate <span class="text-muted small">(0 = time-only)</span></label>
                    <input type="number" step="0.01" class="form-control"
                           t-att-value="state.invoice.hourly_rate"
                           t-on-blur="(ev) => this.saveHeader('hourly_rate', parseFloat(ev.target.value) || 0)"/>
                </div>
            </div>
        </div>

        <!-- Read-only header info (when not editing) -->
        <div t-if="state.isPortal or state.invoice.state !== 'draft'" class="card p-3 mb-3 shadow-sm">
            <div class="row">
                <div t-if="state.invoice.invoice_title" class="col-md-8">
                    <strong>Title:</strong> <t t-esc="state.invoice.invoice_title"/>
                </div>
                <div t-if="state.invoice.hourly_rate > 0 and state.showAmounts" class="col-md-4 text-end">
                    <strong>Rate:</strong> <t t-esc="state.invoice.hourly_rate.toFixed(2)"/> / hour
                </div>
            </div>
        </div>

        <!-- Totals strip -->
        <div class="row g-3 mb-3">
            <div class="col-md-3">
                <div class="card p-3 text-center bg-light">
                    <div class="small text-muted">Project Quoted (KRA)</div>
                    <div class="fw-bold fs-4" t-esc="state.invoice.project_quoted_hours + 'h'"/>
                </div>
            </div>
            <div class="col-md-3">
                <div class="card p-3 text-center bg-light">
                    <div class="small text-muted">Sum of KPI Quoted</div>
                    <div class="fw-bold fs-4" t-esc="state.invoice.total_quoted_hours + 'h'"/>
                </div>
            </div>
            <div t-if="!state.isPortal" class="col-md-3">
                <div class="card p-3 text-center bg-light">
                    <div class="small text-muted">Sum of Actual</div>
                    <div class="fw-bold fs-4 text-muted" t-esc="state.invoice.total_actual_hours + 'h'"/>
                </div>
            </div>
            <div class="col-md-3">
                <div class="card p-3 text-center bg-primary text-white">
                    <div class="small">Grand Total (Bill)</div>
                    <div class="fw-bold fs-4" t-esc="state.invoice.grand_total_hours + 'h'"/>
                    <div t-if="state.showAmounts" class="small mt-1">
                        Amount: <t t-esc="state.invoice.total_amount.toFixed(2)"/>
                    </div>
                </div>
            </div>
        </div>

        <!-- Lines table -->
        <div class="card p-3 mb-3 shadow-sm">
            <div class="d-flex justify-content-between align-items-center mb-2">
                <h5 class="fw-bold mb-0">
                    <i class="fa fa-tasks me-2 text-info"/> Invoice Lines
                </h5>
                <button t-if="!state.isPortal and state.invoice.state === 'draft'"
                        class="btn btn-outline-success btn-sm"
                        t-on-click="addAdjustment">
                    <i class="fa fa-plus me-1"/> Add Adjustment
                </button>
            </div>

            <div t-if="state.invoice.billing_method === 'per_task' and state.showAmounts and !state.isPortal and state.invoice.state === 'draft'"
                 class="alert alert-info py-2 small mb-2">
                <i class="fa fa-info-circle me-1"/>
                Set a <b>Price</b> for each task below — it saves as you go and the total updates live.
            </div>
            <div t-if="state.invoice.billing_method === 'hourly' and state.showAmounts and !state.isPortal and state.invoice.state === 'draft'"
                 class="alert alert-info py-2 small mb-2">
                <i class="fa fa-info-circle me-1"/>
                Set the <b>Hours</b> for each task — Amount = hours × rate, and the total updates live.
            </div>

            <table class="table table-sm align-middle">
                <thead class="table-light">
                    <tr>
                        <th style="width: 30px">&#160;</th>
                        <th>Type</th>
                        <th>Description</th>
                        <th class="text-end" style="width: 120px">Quoted (h)</th>
                        <th t-if="!state.isPortal" class="text-end" style="width: 110px">Actual (h)</th>
                        <th t-if="state.invoice.billing_method === 'per_task' and state.showAmounts" class="text-end" style="width: 130px">Price</th>
                        <th t-if="state.invoice.billing_method === 'hourly' and state.showAmounts" class="text-end" style="width: 130px">Amount</th>
                        <th t-if="!state.isPortal and state.invoice.state === 'draft'" style="width: 50px">&#160;</th>
                    </tr>
                </thead>
                <tbody>
                    <t t-foreach="state.invoice.lines" t-as="line" t-key="line.id">
                        <tr t-att-class="line.already_invoiced ? 'table-danger' : (line.line_type === 'adjustment' ? 'table-warning' : '')">
                            <td>
                                <button t-if="line.line_type === 'kpi' and !state.isPortal and line.contributors and line.contributors.length > 0"
                                        class="btn btn-sm btn-link p-0"
                                        t-on-click="() => this.toggleExpand(line.id)">
                                    <i class="fa"
                                       t-att-class="state.expanded[line.id] ? 'fa-caret-down' : 'fa-caret-right'"/>
                                </button>
                            </td>
                            <td>
                                <span class="badge"
                                      t-att-class="line.line_type === 'kpi' ? 'bg-info' : 'bg-warning text-dark'"
                                      t-esc="line.line_type"/>
                                <span t-if="state.invoice.billing_method === 'per_task' and line.task_kind"
                                      class="badge ms-1"
                                      t-att-class="{'bg-primary': line.task_kind === 'req', 'bg-info': line.task_kind === 'upt', 'bg-danger': line.task_kind === 'bug'}"
                                      t-esc="line.task_kind.toUpperCase()"/>
                            </td>
                            <td>
                                <input t-if="!state.isPortal and state.invoice.state === 'draft' and !line.already_invoiced"
                                       type="text" class="form-control form-control-sm"
                                       t-att-value="line.description"
                                       t-on-blur="(ev) => this.saveLineField(line.id, 'description', ev.target.value)"/>
                                <span t-else="" t-esc="line.description"/>
                                <span t-if="line.already_invoiced" class="badge bg-danger ms-2">
                                    <i class="fa fa-lock me-1"/> Billed on <t t-esc="line.invoiced_on"/>
                                </span>
                                <!-- What the client wrote when they signed this task off.
                                     It lived only on the task, so at the moment someone is
                                     checking what they are charging for, the client's own
                                     words about the work were nowhere on the invoice. -->
                                <div t-if="line.client_signoff_notes" class="small text-muted mt-1"
                                     style="white-space:pre-wrap;">
                                    <i class="fa fa-quote-left me-1"/><t t-esc="line.client_signoff_notes"/>
                                    <span t-if="line.client_signed_by" class="fst-italic">
                                        — <t t-esc="line.client_signed_by"/>
                                    </span>
                                </div>
                            </td>
                            <td class="text-end">
                                <input t-if="!state.isPortal and state.invoice.state === 'draft'"
                                       type="number" step="0.25"
                                       class="form-control form-control-sm text-end"
                                       t-att-value="line.quoted_hours"
                                       t-att-disabled="line.already_invoiced"
                                       t-on-blur="(ev) => this.saveLineField(line.id, 'quoted_hours', ev.target.value)"/>
                                <span t-else="" t-esc="line.quoted_hours + 'h'"/>
                            </td>
                            <td t-if="!state.isPortal" class="text-end text-muted">
                                <span t-if="line.line_type === 'kpi'" t-esc="line.actual_hours + 'h'"/>
                                <span t-else="">—</span>
                            </td>
                            <td t-if="state.invoice.billing_method === 'per_task' and state.showAmounts" class="text-end">
                                <input t-if="!state.isPortal and state.invoice.state === 'draft'"
                                       type="number" step="0.01"
                                       class="form-control form-control-sm text-end"
                                       t-att-value="line.unit_price"
                                       t-att-disabled="line.already_invoiced"
                                       t-on-blur="(ev) => this.saveLineField(line.id, 'unit_price', ev.target.value)"/>
                                <span t-else="" t-esc="line.unit_price.toFixed(2)"/>
                            </td>
                            <td t-if="state.invoice.billing_method === 'hourly' and state.showAmounts" class="text-end fw-bold">
                                <t t-esc="(line.quoted_hours * (state.invoice.hourly_rate || 0)).toFixed(2)"/>
                            </td>
                            <td t-if="!state.isPortal and state.invoice.state === 'draft'">
                                <button t-if="line.line_type === 'adjustment'"
                                        class="btn btn-sm btn-outline-danger"
                                        t-on-click="() => this.removeLine(line.id)"
                                        title="Remove adjustment line">
                                    <i class="fa fa-times"/>
                                </button>
                            </td>
                        </tr>
                        <!-- Contributor sub-rows (admin only) -->
                        <t t-if="state.expanded[line.id] and line.line_type === 'kpi' and !state.isPortal">
                            <t t-foreach="line.contributors" t-as="ct" t-key="ct.user_id">
                                <tr class="table-light">
                                    <td/>
                                    <td/>
                                    <td class="ps-4 text-muted">
                                        <i class="fa fa-user me-1"/> <t t-esc="ct.name"/>
                                    </td>
                                    <td/>
                                    <td class="text-end text-muted" t-esc="ct.hours + 'h'"/>
                                    <td t-if="state.invoice.billing_method === 'per_task' and state.showAmounts"/>
                                    <td t-if="state.invoice.billing_method === 'hourly' and state.showAmounts"/>
                                    <td t-if="state.invoice.state === 'draft'"/>
                                </tr>
                            </t>
                        </t>
                    </t>
                    <tr t-if="state.invoice.lines.length === 0">
                        <td colspan="6" class="text-center text-muted">No lines yet.</td>
                    </tr>
                </tbody>
            </table>

            <!-- An empty invoice is the confusing case. The server already knows which
                 gate rejected every task, so say it plainly rather than leaving the
                 admin staring at "No lines yet." with nothing to act on. -->
            <div t-if="state.invoice.lines.length === 0 and (state.invoice.empty_reasons or []).length > 0"
                 class="alert alert-warning mb-0">
                <div class="fw-bold mb-2">
                    <i class="fa fa-info-circle me-1"/> Nothing to bill for this period
                </div>
                <ul class="mb-2 ps-3">
                    <t t-foreach="state.invoice.empty_reasons" t-as="reason" t-key="reason_index">
                        <li t-esc="reason"/>
                    </t>
                </ul>
                <div class="small text-muted">
                    Work becomes billable only once the client has signed it off in their
                    portal. You can delete this draft and create it again after they do.
                </div>
            </div>
        </div>

        <!-- Notes -->
        <div class="card p-3 shadow-sm">
            <h5 class="fw-bold mb-2">
                <i class="fa fa-sticky-note-o me-2 text-warning"/> Overall Notes
            </h5>
            <div t-if="!state.isPortal and state.invoice.state === 'draft'" class="small text-muted mb-1">
                The client reads this on their copy of the invoice. Saved as you type.
            </div>
            <textarea t-if="!state.isPortal and state.invoice.state === 'draft'"
                      class="form-control"
                      rows="8"
                      placeholder="Anything the client should know about this invoice — scope, adjustments, payment terms…"
                      t-att-value="state.notesText"
                      t-on-input="(ev) => state.notesText = ev.target.value"
                      t-on-blur="saveNotes"/>
            <!-- t-esc, not t-out: the server now sends plain text, and t-out would only
                 render markup if it were flagged as such — which is why the client was
                 reading the <p> tags. pre-wrap keeps the typed paragraphs. -->
            <div t-else="" class="border rounded p-2 bg-light"
                 style="white-space:pre-wrap;"
                 t-esc="state.invoice.notes or '(no notes)'"/>
        </div>
    </t>

    <!-- Result / error banner — replaces alert(). -->
    <div t-if="state.toast.show"
         t-att-class="'alert alert-dismissible d-flex align-items-center gap-2 alert-' + state.toast.kind"
         style="position:sticky;top:0;z-index:1080;">
        <i t-att-class="state.toast.kind === 'danger' ? 'fa fa-exclamation-circle' : 'fa fa-check-circle'"/>
        <div class="flex-grow-1" style="white-space:pre-wrap;" t-esc="state.toast.text"/>
        <button type="button" class="btn-close" t-on-click="() => this.state.toast.show = false"/>
    </div>

    <!-- ─── IN-APP DIALOG ─── replaces window.prompt / confirm.
         Same shape as the client dashboard's approval modal so the module has one
         dialog, not a browser one on payment screens and a styled one elsewhere. -->
    <div t-if="state.dlg.open" class="modal d-block" tabindex="-1" style="background: rgba(0,0,0,0.5);">
        <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
                <div t-att-class="'modal-header ' + state.dlg.headerClass">
                    <h5 class="modal-title">
                        <i t-if="state.dlg.icon" t-att-class="'fa me-2 ' + state.dlg.icon"/>
                        <t t-esc="state.dlg.title"/>
                    </h5>
                    <button type="button"
                            t-att-class="'btn-close' + (state.dlg.headerClass.includes('text-white') ? ' btn-close-white' : '')"
                            t-on-click="dlgCancel"/>
                </div>
                <div class="modal-body">
                    <p t-if="state.dlg.message" class="mb-3" style="white-space:pre-wrap;" t-esc="state.dlg.message"/>
                    <!-- Naming the records a warning is about, without making the dialog
                         a wall of text when there are thirty of them. -->
                    <div t-if="state.dlg.items.length" class="mb-3">
                        <button type="button" class="btn btn-sm btn-link px-0 text-decoration-none"
                                t-on-click="() => state.dlg.itemsOpen = !state.dlg.itemsOpen">
                            <i t-att-class="'fa me-1 ' + (state.dlg.itemsOpen ? 'fa-caret-down' : 'fa-caret-right')"/>
                            <t t-esc="state.dlg.itemsLabel"/>
                        </button>
                        <div t-if="state.dlg.itemsOpen" class="border rounded p-2 bg-light"
                             style="max-height:180px; overflow-y:auto;">
                            <div t-foreach="state.dlg.items" t-as="it" t-key="it_index"
                                 class="small border-bottom py-1" t-esc="it"/>
                        </div>
                    </div>
                    <t t-foreach="state.dlg.fields" t-as="f" t-key="f.key">
                        <div class="mb-3">
                            <label class="form-label fw-bold">
                                <t t-esc="f.label"/>
                                <span t-if="f.required" class="text-danger">*</span>
                            </label>
                            <!-- Radios, not a numbered prompt: the options are a fixed,
                                 short set and picking one should be a single click. -->
                            <t t-if="f.type === 'radio'">
                                <div t-foreach="f.options" t-as="o" t-key="o.value" class="form-check">
                                    <input class="form-check-input" type="radio"
                                           t-att-name="f.key" t-att-id="f.key + '_' + o.value"
                                           t-att-checked="state.dlg.values[f.key] === o.value"
                                           t-on-change="() => this.dlgSet(f.key, o.value)"/>
                                    <label class="form-check-label" t-att-for="f.key + '_' + o.value" t-esc="o.label"/>
                                </div>
                            </t>
                            <textarea t-elif="f.type === 'textarea'" class="form-control" rows="3"
                                      t-att-value="state.dlg.values[f.key]"
                                      t-att-placeholder="f.placeholder or ''"
                                      t-on-input="(ev) => this.dlgSet(f.key, ev.target.value)"/>
                            <input t-else="" type="text" class="form-control"
                                   t-att-value="state.dlg.values[f.key]"
                                   t-att-placeholder="f.placeholder or ''"
                                   t-on-input="(ev) => this.dlgSet(f.key, ev.target.value)"/>
                            <div t-if="f.hint" class="form-text" t-esc="f.hint"/>
                        </div>
                    </t>
                    <div t-if="state.dlg.error" class="alert alert-danger py-2 mb-0" t-esc="state.dlg.error"/>
                </div>
                <div class="modal-footer">
                    <button t-if="!state.dlg.okOnly" type="button" class="btn btn-secondary"
                            t-on-click="dlgCancel">Cancel</button>
                    <button type="button" t-att-class="'btn ' + state.dlg.okClass"
                            t-on-click="dlgOk" t-esc="state.dlg.okLabel"/>
                </div>
            </div>
        </div>
    </div>
</div>
`;

class _BaseInvoiceComponent extends Component {
    static template = TEMPLATE;
    // Default; each exported subclass overrides it. Never assign this.isPortal here —
    // that is what silently wiped the portal flag and showed clients the admin screen.
    static isPortal = false;
    setup() {
        this.isPortal = this.constructor.isPortal;
        this.state = useState({
            view: 'list',                  // 'list' | 'detail'
            isPortal: this.isPortal,
            // One in-app dialog, driven by state, replacing window.prompt/confirm.
            // Those are the browser's chrome, not ours: they cannot show a radio
            // group, they cannot be styled, and on a payment screen they look like
            // something has gone wrong rather than like part of the product.
            dlg: {
                open: false, title: '', message: '', okLabel: 'OK',
                okClass: 'btn-primary', fields: [], values: {}, error: '',
                headerClass: 'bg-primary text-white', icon: '', okOnly: false,
                items: [], itemsLabel: '', itemsOpen: false,
                resolve: null,
            },
            missingClient: false,          // red highlight on the Client picker
            // Replaces alert() for results and errors. A banner inside the page,
            // dismissible, rather than a modal the user has to acknowledge before
            // they can even see what changed behind it.
            toast: { show: false, text: '', kind: 'success' },
            clients: [],
            currencies: [],
            invoices: [],
            statusFilter: 'all',           // 'all' | 'draft' | 'finalized' | 'sent' | 'due' | 'claimed' | 'paid'
            counts: { all: 0, draft: 0, finalized: 0, sent: 0, due: 0, claimed: 0, paid: 0 },
            invoice: null,                 // current detail invoice
            creating: false,               // in-flight guard — blocks duplicate drafts
            showCreate: false,             // the builder folds away; the list is what you came for
            showAdvanced: false,           // currency / filters — all defaulted
            showUnsignedTasks: false,      // reveal the not-yet-signed-off tasks in the picker
            expanded: {},                  // {line_id: bool}
            showAmounts: true,             // detail toggle — off = clean, cost-free view + PDF
            notesText: '',
            scopeUsers: [],                // filter dropdown — developers in selected client
            scopeKpis: [],                 // filter dropdown — KPIs in selected client
            scopeSubKras: [],              // filter dropdown — direct children of the selected client
            newInvoice: {
                client_kra_id: '',
                invoice_title: '',
                billing_method: 'hourly',      // 'hourly' | 'per_task'
                hourly_rate: 0,
                price_req: 0,
                price_upt: 0,
                price_bug: 0,
                currency_id: '',
                from_date: '',
                to_date: '',
                // "All unbilled" by default: sign-off, not the calendar, decides what
                // is billable, so a month window mostly just hides work.
                range_preset: 'all',
                include_req: true,
                include_upt: true,
                include_bug: true,
                filter_user_ids: [],
                filter_kpi_ids: [],
                filter_sub_kra_ids: [],
            },
        });
        onWillStart(async () => {
            // Defaults to "All unbilled" — see setRangePreset('all').
            this.setRangePreset('all');
            if (!this.isPortal) {
                const r = await rpc('/kpi_client_invoice/get_filters', {});
                if (r && r.status) this.state.clients = r.clients || [];
                const rc = await rpc('/kpi_client_invoice/get_currencies', {});
                if (rc && rc.status) this.state.currencies = rc.currencies || [];
                // Honor prefill from Owner Dashboard "Invoice this project" navigation.
                try {
                    const raw = sessionStorage.getItem('kpi_invoice_prefill');
                    if (raw) {
                        sessionStorage.removeItem('kpi_invoice_prefill');
                        const pre = JSON.parse(raw);
                        if (pre.range_preset) this.setRangePreset(pre.range_preset);
                        if (pre.client_kra_id) {
                            this.state.newInvoice.client_kra_id = String(pre.client_kra_id);
                            // Arrived here from "Invoice this project" — they came to
                            // raise one, so the folded form would just be in the way.
                            this.state.showCreate = true;
                            await this.onClientChange();
                            if (Array.isArray(pre.sub_kra_ids) && pre.sub_kra_ids.length) {
                                this.state.newInvoice.filter_sub_kra_ids = pre.sub_kra_ids.map(Number);
                                await this._refreshScopeForSubKras();
                            }
                        }
                    }
                } catch (e) { /* ignore malformed prefill */ }
            }
            await this.refreshList();
        });
    }
    _fmt(d) {
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${m}-${day}`;
    }
    async refreshList() {
        const r = await rpc('/kpi_client_invoice/list', {
            status_filter: this.state.statusFilter || 'all',
        });
        if (r && r.status) {
            this.state.invoices = r.invoices || [];
            if (r.counts) this.state.counts = r.counts;
        }
    }
    async setStatusFilter(s) {
        this.state.statusFilter = s;
        await this.refreshList();
    }
    // Bank Transfer / Cash / Cheque / Card / Other — must match PAYMENT_METHODS in
    // models/kpi_client_invoice.py, which is what validates them.
    get paymentMethods() {
        return [
            { value: 'bank_transfer', label: 'Bank Transfer' },
            { value: 'cash', label: 'Cash' },
            { value: 'cheque', label: 'Cheque' },
            { value: 'card', label: 'Card' },
            { value: 'other', label: 'Other' },
        ];
    }

    // ── the one dialog ────────────────────────────────────────────────────────
    // Returns a Promise of the entered values, or null if cancelled — so callers
    // read like the prompt() they replace, without the browser chrome.
    _dialog({ title, message = '', fields = [], okLabel = 'OK', okClass = 'btn-primary',
              headerClass = 'bg-primary text-white', icon = '', okOnly = false,
              items = [], itemsLabel = '' }) {
        const d = this.state.dlg;
        d.title = title;
        d.message = message;
        d.fields = fields;
        d.okLabel = okLabel;
        d.okClass = okClass;
        d.headerClass = headerClass;
        d.icon = icon;
        d.okOnly = okOnly;
        d.items = items;
        d.itemsLabel = itemsLabel;
        d.itemsOpen = false;
        d.error = '';
        d.values = {};
        for (const f of fields) d.values[f.key] = f.value !== undefined ? f.value : '';
        d.open = true;
        return new Promise((resolve) => { d.resolve = resolve; });
    }
    _confirm(title, message, okLabel = 'OK', okClass = 'btn-primary') {
        return this._dialog({ title, message, fields: [], okLabel, okClass });
    }
    // A blocking warning with one button. Used where the toast banner was too easy
    // to miss: the Create button sits at the bottom of a long form, and a message
    // that appears at the top reads as nothing happening at all.
    _warn(title, message) {
        return this._dialog({
            title, message,
            okLabel: 'Got it', okClass: 'btn-warning',
            headerClass: 'bg-warning text-dark', icon: 'fa-exclamation-triangle',
            okOnly: true,
        });
    }
    _toast(text, kind = 'success') {
        this.state.toast = { show: true, text, kind };
        // Successes clear themselves; errors stay until dismissed, because an error
        // that vanishes before it is read is the same as no error at all.
        if (kind !== 'danger') {
            setTimeout(() => { this.state.toast.show = false; }, 4000);
        }
    }
    dlgSet(key, val) { this.state.dlg.values[key] = val; this.state.dlg.error = ''; }
    dlgCancel() {
        const d = this.state.dlg;
        d.open = false;
        const r = d.resolve; d.resolve = null;
        if (r) r(null);
    }
    dlgOk() {
        const d = this.state.dlg;
        // Required fields are enforced here rather than by disabling OK, so the
        // reason a click did nothing is stated instead of left to be guessed.
        for (const f of d.fields) {
            if (f.required && !String(d.values[f.key] || '').trim()) {
                d.error = `${f.label} is required.`;
                return;
            }
        }
        const vals = { ...d.values };
        d.open = false;
        const r = d.resolve; d.resolve = null;
        if (r) r(vals);
    }

    async markPaidPrompt(inv) {
        const vals = await this._dialog({
            title: `Mark ${inv.name} as paid`,
            message: 'Record how the payment arrived. The note is internal — the client never sees it.',
            okLabel: 'Mark Paid',
            okClass: 'btn-success',
            fields: [
                { key: 'method', label: 'How was it paid?', type: 'radio',
                  options: this.paymentMethods, value: 'bank_transfer', required: true },
                { key: 'note', label: 'Note (optional)', type: 'textarea',
                  placeholder: 'e.g. cheque #4417, transfer ref…',
                  hint: 'Internal only — not shown to the client.' },
            ],
        });
        if (!vals) return;
        const { method, note } = vals;
        const r = await rpc('/kpi_client_invoice/mark_paid', {
            invoice_id: inv.id, paid: true, note: note || '', method,
        });
        if (r && r.status) {
            await this.refreshList();
            // If we're in detail view, refresh that too
            if (this.state.view === 'detail' && this.state.invoice && this.state.invoice.id === inv.id) {
                this.state.invoice = r.data;
            }
        } else {
            this._toast((r && r.message) || 'Could not mark it paid.', 'danger');
        }
    }
    async markUnpaidPrompt(inv) {
        const vals = await this._dialog({
            title: `Revert ${inv.name} to Due`,
            message: 'Use this when a payment bounced or was recorded in error. '
                   + 'Any tasks this invoice archived come back.',
            okLabel: 'Revert to Due',
            okClass: 'btn-warning',
            fields: [
                // Required, and the client reads it — so it is written for them, not
                // as an internal shorthand.
                { key: 'reason', label: 'Reason', type: 'textarea', required: true,
                  placeholder: 'e.g. cheque returned unpaid by the bank',
                  hint: 'The client is shown this on their invoice.' },
            ],
        });
        if (!vals) return;
        const reason = vals.reason;
        const r = await rpc('/kpi_client_invoice/mark_paid', {
            invoice_id: inv.id, paid: false, note: reason || '',
        });
        if (r && r.status) {
            await this.refreshList();
            if (this.state.view === 'detail' && this.state.invoice && this.state.invoice.id === inv.id) {
                this.state.invoice = r.data;
            }
        } else {
            this._toast((r && r.message) || 'Could not revert it.', 'danger');
        }
    }
    // ----- Date-range preset helpers ----- //
    setRangePreset(preset) {
        const ni = this.state.newInvoice;
        ni.range_preset = preset;
        if (preset === 'custom') return;        // user fills From/To manually
        if (preset === 'all') {
            // "Everything not yet billed". Billability is driven by client sign-off,
            // not the calendar — work done in July but signed in August falls outside
            // a July invoice, which is the trap that made invoices come back empty.
            // Safe because double-billing is prevented elsewhere: populate skips any
            // task already on another invoice line. Same range the Owner Dashboard
            // has always used for "invoice everything certified".
            const ni2 = this.state.newInvoice;
            ni2.from_date = '2000-01-01';
            ni2.to_date = '2099-12-31';
            return;
        }
        const today = new Date();
        let from, to;
        if (preset === 'today') {
            from = to = today;
        } else if (preset === 'yesterday') {
            from = to = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
        } else if (preset === 'this_week') {
            const day = today.getDay() || 7;     // Mon=1 .. Sun=7
            from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (day - 1));
            to   = today;
        } else if (preset === 'this_month') {
            from = new Date(today.getFullYear(), today.getMonth(), 1);
            to   = today;
        } else if (preset === 'last_month') {
            from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            to   = new Date(today.getFullYear(), today.getMonth(), 0);  // last day of prev month
        }
        if (from && to) {
            ni.from_date = this._fmt(from);
            ni.to_date   = this._fmt(to);
        }
    }
    markCustomRange() {
        // User typed in From/To manually → flip the preset chip to "custom".
        this.state.newInvoice.range_preset = 'custom';
    }
    getRatePreview() {
        const ni = this.state.newInvoice;
        const r  = Number(ni.hourly_rate || 0);
        if (!r) return '—';
        const cur = (this.state.currencies || []).find(c => String(c.id) === String(ni.currency_id));
        const sym = (cur && cur.symbol) || (cur && cur.name) || '';
        return (sym ? sym + ' ' : '') + r.toFixed(2) + ' / hour';
    }
    getCurrencyPreview() {
        const ni = this.state.newInvoice;
        const cur = (this.state.currencies || []).find(c => String(c.id) === String(ni.currency_id));
        if (!cur) return 'default (system)';
        return cur.name + (cur.symbol ? ' (' + cur.symbol + ')' : '');
    }
    _selectedTaskTypes() {
        const ni = this.state.newInvoice;
        const out = [];
        if (ni.include_req) out.push('REQ');
        if (ni.include_upt) out.push('UPT');
        if (ni.include_bug) out.push('BUG');
        return out;
    }

    async createInvoice() {
        // In-flight guard. Without it a double-click created two or three identical
        // drafts, and since populate skips tasks already on another invoice line, the
        // extras then held those tasks back and every later invoice came back empty.
        if (this.state.creating) return;
        const ni = this.state.newInvoice;
        // Each miss is named on its own. "Pick a client and both dates" left you
        // hunting for which of the three was actually empty.
        this.state.missingClient = !ni.client_kra_id;
        if (!ni.client_kra_id) {
            await this._warn(
                'Choose a client first',
                'Every invoice is raised against one client — it decides whose signed-off '
                + 'work gets billed and who receives the invoice.\n\n'
                + 'Pick one from the Client dropdown at the top of the form, then press '
                + 'Create Invoice again.');
            // Put the cursor where the fix is; the button is far below the field.
            const sel = document.querySelector('.o_kpi_client_invoice select.is-invalid');
            if (sel) { sel.scrollIntoView({ block: 'center' }); sel.focus(); }
            return;
        }
        if (!ni.from_date || !ni.to_date) {
            await this._warn('Set the date range',
                'Choose the period this invoice covers — either a preset button '
                + '(All unbilled, This Month, …) or both From and To dates.');
            return;
        }
        // Block creation if user un-ticked ALL three types — would produce empty invoice silently.
        if (this._selectedTaskTypes().length === 0) {
            await this._warn('Pick at least one task type',
                'REQ, UPT and BUG are all unticked, so there is nothing left to bill. '
                + 'Tick at least one under Include Task Types.');
            return;
        }
        // An hourly invoice at rate 0 totals zero however many hours it carries. A
        // deliberate 0 is legitimate — the field's own hint calls it "time-only" — so
        // this asks rather than blocks. Per-task is NOT checked here: its prices are
        // set after creation, so there is nothing to check yet.
        if (ni.billing_method === 'hourly' && !(Number(ni.hourly_rate) > 0)) {
            const go = await this._confirm(
                'Per-hour rate is 0',
                'This invoice will total 0 no matter how many hours it bills.\n\n'
                + 'That is right for a time-only record you are sending for information. '
                + 'If you meant to charge for this work, set a rate first.',
                'Create it anyway', 'btn-warning');
            if (!go) return;
        }
        this.state.creating = true;
        try {
            // Per Task: create straight away, then the admin prices each task
            // individually in the invoice detail (saved live).
            await this._doCreate();
        } finally {
            this.state.creating = false;
        }
    }
    async _doCreate() {
        const ni = this.state.newInvoice;
        const types = this._selectedTaskTypes();
        // create() sets billing_method + type prices BEFORE populating, so each
        // KPI line's unit_price is seeded by its task type server-side.
        const r = await rpc('/kpi_client_invoice/create', {
            client_kra_id: ni.client_kra_id,
            from_date: ni.from_date,
            to_date: ni.to_date,
            filter_user_ids: ni.filter_user_ids,
            // Only ids still on screen and still tickable. Untick BUG after picking a
            // BUG task and it would otherwise stay silently selected, narrowing the
            // invoice to work the type filter has already thrown out — an empty invoice
            // caused by a tick you can no longer see.
            filter_kpi_ids: this._tickedBillableIds(),
            filter_sub_kra_ids: ni.filter_sub_kra_ids,
            // If all 3 are ticked we send no filter (treat as "all").
            task_types: (types.length < 3) ? types : [],
            billing_method: ni.billing_method,
            hourly_rate: ni.hourly_rate || 0,
            price_req: ni.price_req || 0,
            price_upt: ni.price_upt || 0,
            price_bug: ni.price_bug || 0,
            invoice_title: ni.invoice_title || '',
            currency_id: ni.currency_id || false,
        });
        if (!r.status) { this._toast(r.message || 'Something went wrong.', 'danger'); return; }
        this.state.invoice = r.data;
        this.state.notesText = this.state.invoice.notes || '';
        this.state.expanded = {};
        this.state.view = 'detail';
    }
    async downloadPdf(invoiceId) {
        const r = await rpc('/kpi_client_invoice/pdf_data', { invoice_id: invoiceId });
        if (!r.status) { this._toast(r.message || 'Something went wrong.', 'danger'); return; }
        const pdf = r.data;
        const inv = pdf.invoice;
        // Already-billed (locked) lines are excluded from the total, so drop them from the
        // printed line items too — otherwise the PDF rows wouldn't sum to the stated total.
        const pdfLines = (inv.lines || []).filter(l => !l.already_invoiced);
        const showMoney = this.state.showAmounts !== false;   // toggle OFF = cost-free PDF
        const hasRate = pdf.has_rate;
        const rate = inv.hourly_rate || 0;
        const cur = pdf.currency || { name: '', symbol: '', position: 'after', decimal_places: 2 };
        const dp = cur.decimal_places != null ? cur.decimal_places : 2;
        // jsPDF's default Helvetica font only covers Latin-1.  Glyphs like ₹
        // (U+20B9, INR), ر.ع. (Arabic, OMR), or any other non-ASCII symbol
        // render as `&X&Y&Z` garbage.  Replace with the ASCII currency code
        // (INR / OMR / etc.) when the symbol isn't safe.
        const isAsciiSafe = (str) => {
            if (!str) return false;
            for (let i = 0; i < str.length; i++) {
                if (str.charCodeAt(i) > 0x7F) return false;
            }
            return true;
        };
        const safeCurToken = isAsciiSafe(cur.symbol) ? cur.symbol : (cur.name || '');
        const fmtMoney = (n) => {
            const s = (n || 0).toFixed(dp);
            if (safeCurToken) {
                return cur.position === 'before' ? `${safeCurToken}${s}` : `${s} ${safeCurToken}`;
            }
            return s;
        };
        if (!window.jspdf) {
            this._toast('The PDF library did not load — reload the page and try again.', 'danger'); return;
        }
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: 'pt', format: 'a4' });
        doc.setFont('times', 'normal');            // Times New Roman throughout
        const pageW = doc.internal.pageSize.getWidth();
        const pageH = doc.internal.pageSize.getHeight();
        const M = 48;                              // uniform page margin
        let y = M;

        // Logo data + true aspect ratio (avoid stretching the 369 logo).
        const logoData = pdf.company_logo_b64 ? ('data:image/png;base64,' + pdf.company_logo_b64) : '';
        let logoRatio = 1;   // width / height
        if (logoData) {
            try {
                const p = doc.getImageProperties(logoData);
                if (p && p.width && p.height) logoRatio = p.width / p.height;
            } catch (e) { /* keep 1:1 */ }
        }
        // Payment status shown next to the invoice number (and in the filename).
        //
        // NOTE: this invoice has TWO renderers — this one (jsPDF, in the browser, behind
        // the PDF button) and _build_invoice_pdf in kpi_reports_api.py (reportlab, used
        // by the mobile app). They must agree. This branch knew only paid/unpaid, so a
        // claimed invoice printed as UNPAID while every screen called it Claimed.
        // Same order and same wording as the server version.
        const payLabel = inv.state === 'draft'
            ? ''
            : (inv.payment_status === 'paid'
                ? 'PAID'
                : (inv.client_paid_claim ? 'CLAIMED' : 'UNPAID'));
        // Red owed, amber claimed, green settled — the colours the screens already use,
        // so a printed copy carries the same signal as the list it came from.
        const payColor = payLabel === 'PAID' ? [21, 128, 61]
            : (payLabel === 'CLAIMED' ? [180, 83, 9] : [185, 28, 28]);

        // ── Header: logo left, company + INVOICE right ──
        if (logoData) {
            try {
                const h = 56, w = Math.min(h * logoRatio, 150);
                doc.addImage(logoData, 'PNG', M, y, w, h);
            } catch (e) { /* ignore bad image */ }
        }
        doc.setFont('times', 'bold'); doc.setFontSize(22);
        doc.text(pdf.company_name || '', pageW - M, y + 22, { align: 'right' });
        doc.setFont('times', 'normal'); doc.setFontSize(12);
        doc.text('INVOICE', pageW - M, y + 44, { align: 'right' });
        y += 72;
        doc.setDrawColor(190); doc.setLineWidth(0.8);
        doc.line(M, y, pageW - M, y);
        y += 22;

        // ── Meta: Invoice # (+ Paid/Unpaid) left, date right ──
        doc.setFontSize(11);
        doc.setFont('times', 'bold');
        doc.text(`Invoice #: ${inv.name}`, M, y);
        if (payLabel) {
            // Drawn separately so it can carry its own colour without tinting the number.
            const numW = doc.getTextWidth(`Invoice #: ${inv.name}`);
            doc.setTextColor(payColor[0], payColor[1], payColor[2]);
            doc.text(`   —   ${payLabel}`, M + numW, y);
            doc.setTextColor(0, 0, 0);
        }
        doc.setFont('times', 'normal');
        doc.text(`Date: ${inv.invoice_date}`, pageW - M, y, { align: 'right' });
        y += 17;
        if (inv.invoice_title) {
            doc.setFont('times', 'bold');
            doc.text(inv.invoice_title, M, y);
            doc.setFont('times', 'normal');
            y += 17;
        }
        doc.text(`Period: ${inv.from_date} to ${inv.to_date}`, M, y);
        if (showMoney && cur.name) {
            const symBit = isAsciiSafe(cur.symbol) ? ` (${cur.symbol})` : '';
            doc.text(`Currency: ${cur.name}${symBit}`, pageW - M, y, { align: 'right' });
        }
        y += 24;

        // ── Bill To (= root KRA) + Project (= sub-KRA) ──
        doc.setFont('times', 'bold'); doc.text('Bill To:', M, y);
        doc.setFont('times', 'normal'); y += 15;
        doc.setFont('times', 'bold'); doc.setFontSize(12);
        doc.text(pdf.bill_to_name || pdf.client_name || '', M, y);
        doc.setFont('times', 'normal'); doc.setFontSize(11);
        y += 15;
        if (pdf.project_name) {
            doc.text(`Project: ${pdf.project_name}`, M, y);
            y += 15;
        }
        y += 10;
        // Line items table — per_task shows a Type + Price column; hourly shows
        // Hours × Rate = Amount (the original layout).
        const isPerTask = inv.billing_method === 'per_task';
        const hasAmount = showMoney;   // "Show amounts" ON ⇒ money is shown (even at rate 0)
        let head, body;
        if (!showMoney) {
            // Clean, cost-free delivery sheet — tasks + hours (or type), no money.
            if (isPerTask) {
                head = [['Description', 'Type']];
                body = pdfLines.map(l => {
                    const desc = (l.line_type === 'adjustment' ? '[Adjustment] ' : '') + (l.description || '');
                    const kind = (l.task_kind || '').toUpperCase() || (l.line_type === 'adjustment' ? 'ADJ' : '—');
                    return [desc, kind];
                });
            } else {
                head = [['Description', 'Hours']];
                body = pdfLines.map(l => {
                    const desc = (l.line_type === 'adjustment' ? '[Adjustment] ' : '') + (l.description || '');
                    return [desc, (l.quoted_hours || 0).toFixed(2)];
                });
            }
        } else if (isPerTask) {
            head = [['Description', 'Type', 'Price']];
            body = pdfLines.map(l => {
                const desc = (l.line_type === 'adjustment' ? '[Adjustment] ' : '') + (l.description || '');
                const kind = (l.task_kind || '').toUpperCase() || (l.line_type === 'adjustment' ? 'ADJ' : '—');
                return [desc, kind, fmtMoney(l.unit_price || 0)];
            });
        } else {
            // Hourly + amounts on → always show Hours · Rate · Amount (rate may be 0).
            const rateHeader = `Rate (${fmtMoney(rate)})`;
            head = [['Description', 'Hours', rateHeader, 'Amount']];
            body = pdfLines.map(l => {
                const desc = (l.line_type === 'adjustment' ? '[Adjustment] ' : '') + (l.description || '');
                const hours = (l.quoted_hours || 0).toFixed(2);
                const amt = fmtMoney((l.quoted_hours || 0) * rate);
                return [desc, hours, fmtMoney(rate), amt];
            });
        }
        // ── Line-items table — Description left/wide, every other column right-aligned. ──
        const colStyles = { 0: { halign: 'left', cellWidth: 'auto' } };
        for (let c = 1; c < head[0].length; c++) colStyles[c] = { halign: 'right', cellWidth: 92 };
        if (doc.autoTable) {
            doc.autoTable({
                startY: y,
                head: head,
                body: body,
                margin: { left: M, right: M },
                styles: { font: 'times', fontSize: 10, cellPadding: 6, lineColor: [225, 225, 225], lineWidth: 0.5, overflow: 'linebreak' },
                headStyles: { font: 'times', fontStyle: 'bold', fillColor: [56, 56, 92], textColor: 255, halign: 'left' },
                columnStyles: colStyles,
                alternateRowStyles: { fillColor: [247, 247, 251] },
            });
            y = doc.lastAutoTable.finalY + 18;
        } else {
            doc.setFont('times', 'bold');
            doc.text(head[0].join('   |   '), M, y); y += 14;
            doc.setFont('times', 'normal');
            body.forEach(row => { doc.text(row.join('   |   '), M, y); y += 14; });
            y += 8;
        }

        // ── Totals (right-aligned to the same edge as the table) ──
        doc.setFont('times', 'bold'); doc.setFontSize(11);
        if (!isPerTask) {
            doc.text(`Total Hours: ${(inv.grand_total_hours || 0).toFixed(2)}`, pageW - M, y, { align: 'right' });
            y += 16;
        }
        if (hasAmount) {
            doc.setFontSize(13);
            const totalAmt = isPerTask ? (inv.total_amount || 0) : (inv.total_amount || (inv.grand_total_hours * rate));
            doc.text(`Total Amount: ${fmtMoney(totalAmt)}`, pageW - M, y, { align: 'right' });
            doc.setFontSize(11);
            y += 20;
        }

        // ── Notes ──
        if (inv.notes) {
            const plainNotes = (inv.notes || '').replace(/<[^>]+>/g, '').trim();
            if (plainNotes) {
                doc.setFont('times', 'bold'); doc.text('Notes:', M, y); y += 14;
                doc.setFont('times', 'normal');
                doc.text(doc.splitTextToSize(plainNotes, pageW - 2 * M), M, y);
            }
        }

        // ── Watermark: faint 369 logo, centred on every page (drawn last, low opacity). ──
        if (logoData) {
            try {
                let wmW = pageW * 0.55, wmH = wmW / (logoRatio || 1);
                if (wmH > pageH * 0.5) { wmH = pageH * 0.5; wmW = wmH * (logoRatio || 1); }
                const wmX = (pageW - wmW) / 2, wmY = (pageH - wmH) / 2;
                const pageCount = doc.internal.getNumberOfPages();
                for (let p = 1; p <= pageCount; p++) {
                    doc.setPage(p);
                    if (doc.GState) { doc.saveGraphicsState(); doc.setGState(new doc.GState({ opacity: 0.08 })); }
                    doc.addImage(logoData, 'PNG', wmX, wmY, wmW, wmH);
                    if (doc.GState) doc.restoreGraphicsState();
                }
            } catch (e) { /* watermark is best-effort */ }
        }

        doc.save(`${inv.name.replace(/\//g, '_')}${payLabel ? '_' + payLabel : ''}.pdf`);
    }
    async onClientChange() {
        this.state.missingClient = false;
        // Reset filter selections when client changes
        this.state.newInvoice.filter_user_ids = [];
        this.state.newInvoice.filter_kpi_ids = [];
        this.state.newInvoice.filter_sub_kra_ids = [];
        this.state.scopeUsers = [];
        this.state.scopeKpis = [];
        this.state.scopeSubKras = [];
        this.state.showUnsignedTasks = false;   // a new client starts collapsed again
        if (!this.state.newInvoice.client_kra_id) return;
        const [users, subs] = await Promise.all([
            rpc('/kpi_client_invoice/get_client_users_and_kpis', {
                client_kra_id: this.state.newInvoice.client_kra_id,
            }),
            rpc('/kpi_client_invoice/get_sub_kras_for_client', {
                client_kra_id: this.state.newInvoice.client_kra_id,
            }),
        ]);
        if (users && users.status) {
            this.state.scopeUsers = users.users || [];
            this.state.scopeKpis = users.kpis || [];
        }
        if (subs && subs.status) {
            this.state.scopeSubKras = subs.sub_kras || [];
        }
    }
    async onSubKraSelect(ev) {
        const selected = Array.from(ev.target.selectedOptions).map(o => parseInt(o.value, 10));
        this.state.newInvoice.filter_sub_kra_ids = selected;
        // Narrow Filter-Users and Filter-Tasks to the selected sub-tree.
        await this._refreshScopeForSubKras();
        // Reset previously chosen user/task filters since the option set just changed.
        this.state.newInvoice.filter_user_ids = [];
        this.state.newInvoice.filter_kpi_ids = [];
    }
    async _refreshScopeForSubKras() {
        if (!this.state.newInvoice.client_kra_id) return;
        const r = await rpc('/kpi_client_invoice/get_client_users_and_kpis', {
            client_kra_id: this.state.newInvoice.client_kra_id,
            sub_kra_ids: this.state.newInvoice.filter_sub_kra_ids,
        });
        if (r && r.status) {
            this.state.scopeUsers = r.users || [];
            this.state.scopeKpis = r.kpis || [];
        }
    }
    onMultiSelect(ev, field) {
        const selected = Array.from(ev.target.selectedOptions).map(o => parseInt(o.value, 10));
        this.state.newInvoice[field] = selected;
    }
    // Checkbox-style filters — tap a row to toggle it in the array (clear tick,
    // survives re-render). Replaces the old <select multiple> boxes.
    isFilterSelected(field, id) {
        return (this.state.newInvoice[field] || []).includes(id);
    }
    toggleFilter(field, id) {
        const arr = this.state.newInvoice[field] || [];
        this.state.newInvoice[field] = arr.includes(id)
            ? arr.filter(x => x !== id)
            : [...arr, id];
    }
    // Three buckets, in the order you would work through them: what can be billed now,
    // what is settled, and what has not produced any work yet. A client with tasks that
    // are all still in progress lands in "nothing to bill yet" — true, and it keeps the
    // top group honest about what is actionable.
    clientGroups() {
        const all = this.state.clients || [];
        return [
            { key: 'ready', label: 'Ready to bill',
              clients: all.filter(c => (c.billable_count || 0) > 0) },
            { key: 'done', label: 'Nothing left to bill',
              clients: all.filter(c => !(c.billable_count || 0) && (c.task_count || 0) > 0) },
            { key: 'empty', label: 'No tasks yet',
              clients: all.filter(c => !(c.task_count || 0)) },
        ];
    }
    // Mirrors the server's own task-type rule (_populate matches the external_ref
    // prefix). All three ticked sends no filter at all, so everything passes —
    // including BRAND-, TST- and tasks with no reference. Narrow the tick and only
    // those prefixes pass. If the picker used a stricter rule it would offer work the
    // invoice then refused to bill, or hide work the invoice would have included.
    _typeAllowed(k) {
        const types = this._selectedTaskTypes();
        if (types.length >= 3) return true;
        return types.includes((k.task_type || '').toUpperCase());
    }
    _scopeKpisInType() {
        return (this.state.scopeKpis || []).filter(k => this._typeAllowed(k));
    }
    // Signed off = billable now, or billable once and already on an invoice.
    _isSignedOff(k) {
        return k.billable !== false || k.not_billable_code === 'invoiced';
    }
    // Left box: what you can actually tick, plus the not-signed-off ones once the
    // hidden count is expanded (greyed, and boxless — they cannot be billed either).
    leftScopeKpis() {
        const inType = this._scopeKpisInType();
        return inType.filter(k => k.billable !== false
            || (this.state.showUnsignedTasks && !this._isSignedOff(k)));
    }
    // Right box: billed already. Kept on screen so it is clear a task was invoiced
    // rather than mysteriously missing.
    invoicedScopeKpis() {
        return this._scopeKpisInType().filter(k => k.not_billable_code === 'invoiced');
    }
    unsignedScopeKpis() {
        return this._scopeKpisInType().filter(k => !this._isSignedOff(k));
    }
    // The selection as it stands on screen: ticked, billable, and still in the ticked
    // task types. Anything else was either never tickable or has since been filtered out.
    _tickedBillableIds() {
        const picked = new Set(this.state.newInvoice.filter_kpi_ids || []);
        return this._scopeKpisInType()
            .filter(k => k.billable !== false && picked.has(k.id))
            .map(k => k.id);
    }
    // An empty left box has two very different causes, and saying "no signed-off work"
    // when the truth is "you unticked BUG" sends someone hunting for a missing task.
    emptyBillableMessage() {
        const types = this._selectedTaskTypes();
        if (types.length < 3 && (this.state.scopeKpis || []).some(k => k.billable !== false)) {
            return `No ${types.join(' / ') || 'matching'} work available to bill — `
                 + 'check Include Task Types above.';
        }
        return 'No signed-off work waiting to be billed.';
    }
    // Colour by what the tag means, not by "not billable": amber is the client's
    // move, blue is the team still working, grey is settled. The old
    // bg-light/text-secondary was near-invisible on the white card.
    billBadgeClass(k) {
        return {
            signoff: 'bg-warning text-dark',
            invoiced: 'bg-secondary text-white',
        }[k.not_billable_code] || 'bg-info text-dark';
    }
    async toggleSubKra(id) {
        this.toggleFilter('filter_sub_kra_ids', id);
        // Sub-KRA choice narrows which developers/tasks are in scope; refresh then
        // clear any now-stale dev/task picks (same logic the old handler used).
        await this._refreshScopeForSubKras();
        this.state.newInvoice.filter_user_ids = [];
        this.state.newInvoice.filter_kpi_ids = [];
    }
    async openInvoice(id) {
        const r = await rpc('/kpi_client_invoice/get', { invoice_id: id });
        if (!r.status) { this._toast(r.message || 'Something went wrong.', 'danger'); return; }
        this.state.invoice = r.data;
        this.state.notesText = r.data.notes || '';
        this.state.expanded = {};
        this.state.view = 'detail';
    }
    backToList() {
        this.state.view = 'list';
        this.state.invoice = null;
        this.refreshList();
    }
    toggleExpand(lineId) {
        this.state.expanded[lineId] = !this.state.expanded[lineId];
    }
    async saveLineField(lineId, field, value) {
        const payload = { line_id: lineId };
        payload[field] = value;
        const r = await rpc('/kpi_client_invoice/save_line', payload);
        if (!r.status) { this._toast('Could not save: ' + (r.message || 'unknown'), 'danger'); return; }
        // Refresh totals
        await this.openInvoice(this.state.invoice.id);
    }
    async addAdjustment() {
        const vals = await this._dialog({
            title: 'Add an adjustment',
            message: 'A positive figure adds hours, a negative one deducts them.',
            okLabel: 'Add',
            fields: [
                { key: 'desc', label: 'Description', required: true,
                  placeholder: 'e.g. agreed discount' },
                { key: 'hours', label: 'Hours', value: '0',
                  placeholder: '-2', hint: 'Use a minus sign to deduct.' },
            ],
        });
        if (!vals) return;
        const desc = vals.desc;
        const hours = parseFloat(vals.hours);
        if (Number.isNaN(hours)) { this._toast('That is not a number.', 'danger'); return; }
        const r = await rpc('/kpi_client_invoice/add_adjustment', {
            invoice_id: this.state.invoice.id,
            description: desc,
            quoted_hours: hours,
        });
        if (!r.status) { this._toast(r.message || 'Something went wrong.', 'danger'); return; }
        await this.openInvoice(this.state.invoice.id);
    }
    async removeLine(lineId) {
        if (!await this._confirm('Remove this line?', 'It comes off the invoice and the total updates.', 'Remove', 'btn-danger')) return;
        const r = await rpc('/kpi_client_invoice/remove_line', { line_id: lineId });
        if (!r.status) { this._toast(r.message || 'Something went wrong.', 'danger'); return; }
        await this.openInvoice(this.state.invoice.id);
    }
    async saveHeader(field, value) {
        const payload = { invoice_id: this.state.invoice.id };
        payload[field] = value;
        const r = await rpc('/kpi_client_invoice/save_header', payload);
        if (!r.status) { this._toast('Could not save: ' + (r.message || 'unknown'), 'danger'); return; }
        this.state.invoice = r.data;
    }
    async saveNotes() {
        await rpc('/kpi_client_invoice/save_notes', {
            invoice_id: this.state.invoice.id,
            notes: this.state.notesText || '',
        });
    }
    // Tasks on a per-task invoice that were never given a price. Finalize is the point
    // of no return — after it the figure is the client's — so this is where an unpriced
    // line has to be caught, not at creation when no price could exist yet.
    unpricedLines() {
        const inv = this.state.invoice;
        if (!inv || inv.billing_method !== 'per_task') return [];
        return (inv.lines || []).filter(l => l.line_type === 'kpi' && !(Number(l.unit_price) > 0));
    }
    async finalizeInvoice() {
        const unpriced = this.unpricedLines();
        if (unpriced.length) {
            const total = (this.state.invoice.lines || []).filter(l => l.line_type === 'kpi').length;
            const go = await this._dialog({
                title: 'Some tasks have no price',
                message: `${unpriced.length} of ${total} tasks on this invoice are still `
                       + 'priced at 0, so they will be billed as free. Finalizing locks that in.',
                items: unpriced.map(l => l.description || `Line ${l.id}`),
                itemsLabel: `Show the ${unpriced.length} unpriced task(s)`,
                okLabel: 'Finalize anyway', okClass: 'btn-warning',
                headerClass: 'bg-warning text-dark', icon: 'fa-exclamation-triangle',
            });
            if (!go) return;
        }
        if (!await this._confirm('Finalize this invoice?', 'It is locked from further edits and becomes visible to the client.', 'Finalize', 'btn-warning')) return;
        const r = await rpc('/kpi_client_invoice/finalize', { invoice_id: this.state.invoice.id });
        if (!r.status) { this._toast(r.message || 'Something went wrong.', 'danger'); return; }
        this.state.invoice = r.data;
    }
    async sendInvoice() {
        const r = await rpc('/kpi_client_invoice/send', { invoice_id: this.state.invoice.id });
        if (!r.status) { this._toast(r.message || 'Something went wrong.', 'danger'); return; }
        this.state.invoice = r.data;
    }
    async resetDraft() {
        if (!await this._confirm('Reset to Draft?', 'The client loses sight of it until you finalize again.', 'Reset to Draft', 'btn-secondary')) return;
        const r = await rpc('/kpi_client_invoice/reset_draft', { invoice_id: this.state.invoice.id });
        if (!r.status) { this._toast(r.message || 'Something went wrong.', 'danger'); return; }
        this.state.invoice = r.data;
    }

    // Can this finalized invoice still have its figure changed? Not once it is paid,
    // and not while the client has a payment claim outstanding against it.
    canEditFinalized() {
        const inv = this.state.invoice;
        return !!inv && inv.state === 'finalized'
            && inv.payment_status !== 'paid'
            && !inv.client_paid_claim;
    }
    // Reduce a finalized invoice. The reason is required because the client is told the
    // figure changed — and the server refuses without one anyway.
    async reviseInvoice() {
        const inv = this.state.invoice;
        const vals = await this._dialog({
            title: `Revise ${inv.name}`,
            message: 'It goes back to Draft so you can change the amount, then Finalize again. '
                   + 'The client is told it was revised, and sees the reason.',
            okLabel: 'Revise',
            okClass: 'btn-primary',
            fields: [
                { key: 'reason', label: 'Why is it being revised?', type: 'textarea',
                  required: true, placeholder: 'e.g. agreed discount on the reporting work' },
            ],
        });
        if (!vals) return;
        const reason = vals.reason;
        const r = await rpc('/kpi_client_invoice/revise', { invoice_id: inv.id, reason });
        if (!r.status) { this._toast(r.message || 'Something went wrong.', 'danger'); return; }
        this.state.invoice = r.data;
        await this.refreshList();
    }

    // The claimed payment never arrived. Without this the flag sticks forever: the client
    // can't claim twice, and the only other thing that cleared it was marking the invoice
    // paid — the exact thing you don't want to do to correct a false claim.
    async clearPaidClaim() {
        const inv = this.state.invoice;
        if (!await this._confirm(
            `Clear the payment claim on ${inv.name}?`,
            'Use this when the payment never arrived. The invoice stays Unpaid and the '
            + 'client can report paying again.',
            'Clear claim', 'btn-secondary')) return;
        const r = await rpc('/kpi_client_invoice/clear_paid_claim', { invoice_id: inv.id });
        if (!r.status) { this._toast(r.message || 'Something went wrong.', 'danger'); return; }
        this.state.invoice = r.data;
        await this.refreshList();
    }

    // CLIENT side: "I've paid". A claim only — it notifies the admins, who confirm.
    async clientPaidPrompt(inv) {
        const vals = await this._dialog({
            title: `Report payment for ${inv.name}`,
            message: "Tell us how you paid. We'll confirm it once the payment is checked.",
            okLabel: "I've paid",
            okClass: 'btn-success',
            fields: [
                { key: 'method', label: 'How did you pay?', type: 'radio',
                  options: this.paymentMethods, value: 'bank_transfer', required: true },
                { key: 'note', label: 'Reference or note (optional)', type: 'textarea',
                  placeholder: 'e.g. transfer reference…' },
            ],
        });
        if (!vals) return;
        const r = await rpc('/kpi_client_invoice/client_mark_paid', {
            invoice_id: inv.id, method: vals.method, note: vals.note || '',
        });
        if (!r.status) { this._toast(r.message || 'Something went wrong.', 'danger'); return; }
        this._toast('Thank you — we have been told, and will confirm the payment.');
        await this.refreshList();
        if (this.state.view === 'detail' && this.state.invoice && this.state.invoice.id === inv.id) {
            this.state.invoice = r.data;
        }
    }
    async deleteInvoice() {
        const inv = this.state.invoice;
        if (!await this._confirm(
            `Delete draft ${inv.name}?`,
            'Any tasks it is holding are freed for a future invoice. This cannot be undone.',
            'Delete', 'btn-danger')) return;
        const r = await rpc('/kpi_client_invoice/delete', { invoice_id: inv.id });
        if (!r.status) { this._toast(r.message || 'Something went wrong.', 'danger'); return; }
        if (r.freed_tasks) {
            this._toast(`${r.name} deleted. ${r.freed_tasks} task(s) are free to bill again.`);
        }
        this.backToList();
    }
}

// Which mode each action runs in. A STATIC, not an instance assignment in setup():
// the subclasses used to do `setup() { this.isPortal = true; super.setup(); }`, and the
// base's own setup then reassigned this.isPortal = false before building state — so the
// portal flag was destroyed a line after it was set, state.isPortal was ALWAYS false,
// and all 23 `t-if="!state.isPortal"` guards fell open. A client opening My Invoices got
// the whole admin screen: the Create Invoice form, Finalize, Send, Mark Paid, editable
// lines. The server still refused every one of those, so nothing could actually be
// changed, but the buttons were there and failed confusingly when pressed.
// Read via this.constructor.isPortal, so no ordering between base and subclass can break it.
export class KpiClientInvoiceAdmin extends _BaseInvoiceComponent {
    static isPortal = false;
}

export class KpiClientInvoicePortal extends _BaseInvoiceComponent {
    static isPortal = true;
}

registry.category("actions").add("kpi_client_invoice_admin", KpiClientInvoiceAdmin);
registry.category("actions").add("kpi_client_invoice_portal", KpiClientInvoicePortal);
