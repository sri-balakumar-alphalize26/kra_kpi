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

        <!-- New invoice card (admin only) -->
        <div t-if="!state.isPortal" class="card p-3 mb-4 shadow-sm">
            <h5 class="fw-bold mb-3">
                <i class="fa fa-plus-circle me-2 text-success"/>
                Create New Invoice
            </h5>
            <div class="row g-3 align-items-end">
                <div class="col-md-4">
                    <label class="form-label fw-bold">Client</label>
                    <select class="form-select"
                            t-model="state.newInvoice.client_kra_id"
                            t-on-change="onClientChange">
                        <option value="">-- Select Client --</option>
                        <t t-foreach="state.clients" t-as="c" t-key="c.id">
                            <option t-att-value="c.id">
                                <t t-esc="c.parent_name ? c.parent_name + ' > ' + c.name : c.name"/>
                            </option>
                        </t>
                    </select>
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
                <div class="col-md-3">
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
                <!-- Task-type checkboxes — defaults to all 3 checked.  Empty = include all. -->
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
                    <button class="btn btn-primary w-100 mt-2" t-on-click="createInvoice">
                        <i class="fa fa-plus me-1"/> Create Invoice
                    </button>
                </div>

            </div>

            <!-- Sub-KRA (project) filter — appears once a client is chosen. -->
            <div t-if="state.scopeSubKras.length > 0" class="row g-3 mt-2">
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

            <!-- Optional filters: developer + task. Populated after client selection. -->
            <div t-if="state.scopeUsers.length > 0 or state.scopeKpis.length > 0" class="row g-3 mt-2">
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
                <div class="col-md-6">
                    <label class="form-label fw-bold">
                        <i class="fa fa-tasks me-1 text-muted"/> Filter: Tasks
                        <span class="text-muted small">(optional — leave empty for all)</span>
                    </label>
                    <div class="border rounded p-2" style="max-height:160px; overflow-y:auto;">
                        <t t-foreach="state.scopeKpis" t-as="k" t-key="k.id">
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox"
                                       t-att-id="'kpi_' + k.id"
                                       t-att-checked="isFilterSelected('filter_kpi_ids', k.id)"
                                       t-on-change="() => this.toggleFilter('filter_kpi_ids', k.id)"/>
                                <label class="form-check-label" t-att-for="'kpi_' + k.id">
                                    <t t-esc="k.name"/>
                                    <span t-if="k.kra_name" class="text-muted">  (<t t-esc="k.kra_name"/>)</span>
                                </label>
                            </div>
                        </t>
                    </div>
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
                        t-on-click="() => this.setStatusFilter('due')">
                    <i class="fa fa-exclamation-circle me-1"/> Payment Due
                    <span class="badge bg-light text-dark ms-1" t-esc="state.counts.due || 0"/>
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
                                <t t-else="">
                                    <span class="badge bg-danger">
                                        <i class="fa fa-clock-o me-1"/> Due
                                    </span>
                                </t>
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
                        <button t-if="state.invoice.state === 'finalized' and state.invoice.payment_status !== 'paid'"
                                class="btn btn-outline-secondary"
                                t-on-click="resetDraft">
                            <i class="fa fa-undo me-1"/> Reset to Draft
                        </button>
                    </t>
                </div>
            </div>
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
        </div>

        <!-- Notes -->
        <div class="card p-3 shadow-sm">
            <h5 class="fw-bold mb-2">
                <i class="fa fa-sticky-note-o me-2 text-warning"/> Overall Notes
            </h5>
            <textarea t-if="!state.isPortal and state.invoice.state === 'draft'"
                      class="form-control"
                      rows="4"
                      t-att-value="state.notesText"
                      t-on-input="(ev) => state.notesText = ev.target.value"
                      t-on-blur="saveNotes"/>
            <div t-else="" class="border rounded p-2 bg-light"
                 t-out="state.invoice.notes or '(no notes)'"/>
        </div>
    </t>
</div>
`;

class _BaseInvoiceComponent extends Component {
    static template = TEMPLATE;
    setup() {
        this.isPortal = false;  // overridden by subclasses
        this.state = useState({
            view: 'list',                  // 'list' | 'detail'
            isPortal: this.isPortal,
            clients: [],
            currencies: [],
            invoices: [],
            statusFilter: 'all',           // 'all' | 'draft' | 'finalized' | 'sent' | 'due' | 'paid'
            counts: { all: 0, draft: 0, finalized: 0, sent: 0, due: 0, paid: 0 },
            invoice: null,                 // current detail invoice
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
                range_preset: 'this_month',
                include_req: true,
                include_upt: true,
                include_bug: true,
                filter_user_ids: [],
                filter_kpi_ids: [],
                filter_sub_kra_ids: [],
            },
        });
        onWillStart(async () => {
            // Default new-invoice dates: first of current month → today
            const today = new Date();
            const first = new Date(today.getFullYear(), today.getMonth(), 1);
            this.state.newInvoice.from_date = this._fmt(first);
            this.state.newInvoice.to_date = this._fmt(today);
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
                        if (pre.client_kra_id) {
                            this.state.newInvoice.client_kra_id = String(pre.client_kra_id);
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
    async markPaidPrompt(inv) {
        const note = prompt(
            `Mark invoice ${inv.name} as PAID?\n\nOptional note (e.g. cheque #, UPI ref):`,
            ""
        );
        if (note === null) return;  // cancelled
        const r = await rpc('/kpi_client_invoice/mark_paid', {
            invoice_id: inv.id, paid: true, note: note || '',
        });
        if (r && r.status) {
            await this.refreshList();
            // If we're in detail view, refresh that too
            if (this.state.view === 'detail' && this.state.invoice && this.state.invoice.id === inv.id) {
                this.state.invoice = r.data;
            }
        } else {
            alert("Mark paid failed: " + ((r && r.message) || 'unknown'));
        }
    }
    async markUnpaidPrompt(inv) {
        const reason = prompt(
            `Revert invoice ${inv.name} from PAID back to DUE?\n\nReason (will be appended to payment notes):`,
            ""
        );
        if (reason === null) return;
        const r = await rpc('/kpi_client_invoice/mark_paid', {
            invoice_id: inv.id, paid: false, note: reason || '',
        });
        if (r && r.status) {
            await this.refreshList();
            if (this.state.view === 'detail' && this.state.invoice && this.state.invoice.id === inv.id) {
                this.state.invoice = r.data;
            }
        } else {
            alert("Revert failed: " + ((r && r.message) || 'unknown'));
        }
    }
    // ----- Date-range preset helpers ----- //
    setRangePreset(preset) {
        const ni = this.state.newInvoice;
        ni.range_preset = preset;
        if (preset === 'custom') return;        // user fills From/To manually
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
        const ni = this.state.newInvoice;
        if (!ni.client_kra_id || !ni.from_date || !ni.to_date) {
            alert('Please pick a client and both dates.');
            return;
        }
        // Block creation if user un-ticked ALL three types — would produce empty invoice silently.
        if (this._selectedTaskTypes().length === 0) {
            alert('Pick at least one task type (REQ / UPT / BUG).');
            return;
        }
        // Per Task: create straight away, then the admin prices each task
        // individually in the invoice detail (saved live).
        await this._doCreate();
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
            filter_kpi_ids: ni.filter_kpi_ids,
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
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        this.state.invoice = r.data;
        this.state.notesText = this.state.invoice.notes || '';
        this.state.expanded = {};
        this.state.view = 'detail';
    }
    async downloadPdf(invoiceId) {
        const r = await rpc('/kpi_client_invoice/pdf_data', { invoice_id: invoiceId });
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
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
            alert('jsPDF library not loaded.'); return;
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
        const payLabel = inv.state === 'draft'
            ? '' : (inv.payment_status === 'paid' ? 'PAID' : 'UNPAID');

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
        doc.text(`Invoice #: ${inv.name}${payLabel ? '   —   ' + payLabel : ''}`, M, y);
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
        // Reset filter selections when client changes
        this.state.newInvoice.filter_user_ids = [];
        this.state.newInvoice.filter_kpi_ids = [];
        this.state.newInvoice.filter_sub_kra_ids = [];
        this.state.scopeUsers = [];
        this.state.scopeKpis = [];
        this.state.scopeSubKras = [];
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
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
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
        if (!r.status) { alert('Save failed: ' + (r.message || 'unknown')); return; }
        // Refresh totals
        await this.openInvoice(this.state.invoice.id);
    }
    async addAdjustment() {
        const desc = prompt('Adjustment description?');
        if (!desc) return;
        const hrsStr = prompt('Hours (use negative for deductions):', '0');
        if (hrsStr === null) return;
        const hours = parseFloat(hrsStr);
        if (Number.isNaN(hours)) { alert('Invalid number.'); return; }
        const r = await rpc('/kpi_client_invoice/add_adjustment', {
            invoice_id: this.state.invoice.id,
            description: desc,
            quoted_hours: hours,
        });
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        await this.openInvoice(this.state.invoice.id);
    }
    async removeLine(lineId) {
        if (!confirm('Remove this line?')) return;
        const r = await rpc('/kpi_client_invoice/remove_line', { line_id: lineId });
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        await this.openInvoice(this.state.invoice.id);
    }
    async saveHeader(field, value) {
        const payload = { invoice_id: this.state.invoice.id };
        payload[field] = value;
        const r = await rpc('/kpi_client_invoice/save_header', payload);
        if (!r.status) { alert('Save failed: ' + (r.message || 'unknown')); return; }
        this.state.invoice = r.data;
    }
    async saveNotes() {
        await rpc('/kpi_client_invoice/save_notes', {
            invoice_id: this.state.invoice.id,
            notes: this.state.notesText || '',
        });
    }
    async finalizeInvoice() {
        if (!confirm('Finalize this invoice? It will be locked and visible to the client.')) return;
        const r = await rpc('/kpi_client_invoice/finalize', { invoice_id: this.state.invoice.id });
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        this.state.invoice = r.data;
    }
    async sendInvoice() {
        const r = await rpc('/kpi_client_invoice/send', { invoice_id: this.state.invoice.id });
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        this.state.invoice = r.data;
    }
    async resetDraft() {
        if (!confirm('Reset to Draft? Client will lose visibility until you re-finalize.')) return;
        const r = await rpc('/kpi_client_invoice/reset_draft', { invoice_id: this.state.invoice.id });
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        this.state.invoice = r.data;
    }
}

export class KpiClientInvoiceAdmin extends _BaseInvoiceComponent {
    setup() { this.isPortal = false; super.setup(); }
}

export class KpiClientInvoicePortal extends _BaseInvoiceComponent {
    setup() { this.isPortal = true; super.setup(); }
}

registry.category("actions").add("kpi_client_invoice_admin", KpiClientInvoiceAdmin);
registry.category("actions").add("kpi_client_invoice_portal", KpiClientInvoicePortal);
