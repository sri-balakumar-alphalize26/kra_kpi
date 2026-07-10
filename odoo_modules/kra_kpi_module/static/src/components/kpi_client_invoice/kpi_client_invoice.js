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
                <div class="col-md-3">
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
                    <div class="alert alert-info py-2 mb-0 small" t-if="state.newInvoice.hourly_rate > 0">
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
                    <select multiple="multiple" class="form-select" size="4"
                            t-on-change="(ev) => this.onSubKraSelect(ev)">
                        <t t-foreach="state.scopeSubKras" t-as="s" t-key="s.id">
                            <option t-att-value="s.id"
                                    t-att-selected="state.newInvoice.filter_sub_kra_ids.includes(s.id) ? 'selected' : ''"
                                    t-esc="s.name"/>
                        </t>
                    </select>
                </div>
            </div>

            <!-- Optional filters: developer + task. Populated after client selection. -->
            <div t-if="state.scopeUsers.length > 0 or state.scopeKpis.length > 0" class="row g-3 mt-2">
                <div class="col-md-6">
                    <label class="form-label fw-bold">
                        <i class="fa fa-user me-1 text-muted"/> Filter: Developers
                        <span class="text-muted small">(optional — leave empty for all)</span>
                    </label>
                    <select multiple="multiple" class="form-select" size="4"
                            t-on-change="(ev) => this.onMultiSelect(ev, 'filter_user_ids')">
                        <t t-foreach="state.scopeUsers" t-as="u" t-key="u.id">
                            <option t-att-value="u.id" t-esc="u.name"/>
                        </t>
                    </select>
                </div>
                <div class="col-md-6">
                    <label class="form-label fw-bold">
                        <i class="fa fa-tasks me-1 text-muted"/> Filter: Tasks
                        <span class="text-muted small">(optional — leave empty for all)</span>
                    </label>
                    <select multiple="multiple" class="form-select" size="4"
                            t-on-change="(ev) => this.onMultiSelect(ev, 'filter_kpi_ids')">
                        <t t-foreach="state.scopeKpis" t-as="k" t-key="k.id">
                            <option t-att-value="k.id">
                                <t t-esc="k.name"/>
                                <span t-if="k.kra_name" class="text-muted">  (<t t-esc="k.kra_name"/>)</span>
                            </option>
                        </t>
                    </select>
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
                            <td class="fw-bold" t-esc="inv.name"/>
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
                        <button t-if="state.invoice.state !== 'draft'"
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
                <div class="col-md-4">
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
                <div t-if="state.invoice.hourly_rate > 0" class="col-md-4 text-end">
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
                    <div t-if="state.invoice.hourly_rate > 0" class="small mt-1">
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

            <table class="table table-sm align-middle">
                <thead class="table-light">
                    <tr>
                        <th style="width: 30px">&#160;</th>
                        <th>Type</th>
                        <th>Description</th>
                        <th class="text-end" style="width: 120px">Quoted (h)</th>
                        <th t-if="!state.isPortal" class="text-end" style="width: 110px">Actual (h)</th>
                        <th t-if="!state.isPortal and state.invoice.state === 'draft'" style="width: 50px">&#160;</th>
                    </tr>
                </thead>
                <tbody>
                    <t t-foreach="state.invoice.lines" t-as="line" t-key="line.id">
                        <tr t-att-class="line.line_type === 'adjustment' ? 'table-warning' : ''">
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
                            </td>
                            <td>
                                <input t-if="!state.isPortal and state.invoice.state === 'draft'"
                                       type="text" class="form-control form-control-sm"
                                       t-att-value="line.description"
                                       t-on-blur="(ev) => this.saveLineField(line.id, 'description', ev.target.value)"/>
                                <span t-else="" t-esc="line.description"/>
                            </td>
                            <td class="text-end">
                                <input t-if="!state.isPortal and state.invoice.state === 'draft'"
                                       type="number" step="0.25"
                                       class="form-control form-control-sm text-end"
                                       t-att-value="line.quoted_hours"
                                       t-on-blur="(ev) => this.saveLineField(line.id, 'quoted_hours', ev.target.value)"/>
                                <span t-else="" t-esc="line.quoted_hours + 'h'"/>
                            </td>
                            <td t-if="!state.isPortal" class="text-end text-muted">
                                <span t-if="line.line_type === 'kpi'" t-esc="line.actual_hours + 'h'"/>
                                <span t-else="">—</span>
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
            notesText: '',
            scopeUsers: [],                // filter dropdown — developers in selected client
            scopeKpis: [],                 // filter dropdown — KPIs in selected client
            scopeSubKras: [],              // filter dropdown — direct children of the selected client
            newInvoice: {
                client_kra_id: '',
                invoice_title: '',
                hourly_rate: 0,
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
        const types = this._selectedTaskTypes();
        // Block creation if user un-ticked ALL three types — would produce empty invoice silently.
        if (types.length === 0) {
            alert('Pick at least one task type (REQ / UPT / BUG).');
            return;
        }
        const r = await rpc('/kpi_client_invoice/create', {
            client_kra_id: ni.client_kra_id,
            from_date: ni.from_date,
            to_date: ni.to_date,
            filter_user_ids: ni.filter_user_ids,
            filter_kpi_ids: ni.filter_kpi_ids,
            filter_sub_kra_ids: ni.filter_sub_kra_ids,
            // If all 3 are ticked we send no filter (treat as "all").
            task_types: (types.length < 3) ? types : [],
        });
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        // If user supplied a title/rate/currency, save them now via the header endpoint
        if (ni.invoice_title || (ni.hourly_rate && ni.hourly_rate > 0) || ni.currency_id) {
            const payload = {
                invoice_id: r.invoice_id,
                invoice_title: ni.invoice_title || '',
                hourly_rate: ni.hourly_rate || 0,
            };
            if (ni.currency_id) payload.currency_id = ni.currency_id;
            await rpc('/kpi_client_invoice/save_header', payload);
            // Re-fetch to pick up the changes
            const r2 = await rpc('/kpi_client_invoice/get', { invoice_id: r.invoice_id });
            this.state.invoice = r2.data;
        } else {
            this.state.invoice = r.data;
        }
        this.state.notesText = this.state.invoice.notes || '';
        this.state.expanded = {};
        this.state.view = 'detail';
    }
    async downloadPdf(invoiceId) {
        const r = await rpc('/kpi_client_invoice/pdf_data', { invoice_id: invoiceId });
        if (!r.status) { alert('Error: ' + (r.message || 'unknown')); return; }
        const pdf = r.data;
        const inv = pdf.invoice;
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
        const pageW = doc.internal.pageSize.getWidth();
        let y = 40;
        // Header: logo (left) + COMPANY (us) name on right
        if (pdf.company_logo_b64) {
            try {
                doc.addImage('data:image/png;base64,' + pdf.company_logo_b64, 'PNG', 40, y, 60, 60);
            } catch (e) { /* ignore bad image */ }
        }
        doc.setFontSize(20);
        doc.setFont(undefined, 'bold');
        doc.text(pdf.company_name || '', pageW - 40, y + 25, { align: 'right' });
        doc.setFontSize(11);
        doc.setFont(undefined, 'normal');
        doc.text('INVOICE', pageW - 40, y + 50, { align: 'right' });
        y += 90;
        // Invoice metadata
        doc.setFontSize(11);
        doc.text(`Invoice #: ${inv.name}`, 40, y);
        doc.text(`Invoice Date: ${inv.invoice_date}`, pageW - 40, y, { align: 'right' });
        y += 16;
        if (inv.invoice_title) {
            doc.setFont(undefined, 'bold');
            doc.text(inv.invoice_title, 40, y);
            doc.setFont(undefined, 'normal');
            y += 16;
        }
        doc.text(`Period: ${inv.from_date} to ${inv.to_date}`, 40, y);
        y += 16;
        doc.text(`Status: ${inv.state.toUpperCase()}`, 40, y);
        if (cur.name) {
            // Only include the symbol parenthetical when it's ASCII-safe.
            // Otherwise jsPDF mangles the WHOLE line into &X&Y&Z glyphs.
            const symBit = isAsciiSafe(cur.symbol) ? ` (${cur.symbol})` : '';
            doc.text(`Currency: ${cur.name}${symBit}`, pageW - 40, y, { align: 'right' });
        }
        y += 24;
        // Bill To (= root KRA) and Project (= sub-KRA, when present)
        doc.setFont(undefined, 'bold');
        doc.text('Bill To:', 40, y);
        doc.setFont(undefined, 'normal');
        y += 14;
        doc.setFont(undefined, 'bold');
        doc.text(pdf.bill_to_name || pdf.client_name || '', 40, y);
        doc.setFont(undefined, 'normal');
        y += 14;
        if (pdf.project_name) {
            doc.text(`Project: ${pdf.project_name}`, 40, y);
            y += 14;
        }
        y += 10;
        // Line items table
        const rateHeader = hasRate
            ? `Rate (${fmtMoney(rate)})`
            : 'Rate';
        const head = hasRate
            ? [['Description', 'Hours', rateHeader, 'Amount']]
            : [['Description', 'Hours']];
        const body = (inv.lines || []).map(l => {
            const desc = (l.line_type === 'adjustment' ? '[Adjustment] ' : '') + (l.description || '');
            const hours = (l.quoted_hours || 0).toFixed(2);
            if (hasRate) {
                const amt = fmtMoney((l.quoted_hours || 0) * rate);
                return [desc, hours, fmtMoney(rate), amt];
            }
            return [desc, hours];
        });
        // Use jsPDF autotable
        if (doc.autoTable) {
            doc.autoTable({
                startY: y,
                head: head,
                body: body,
                styles: { fontSize: 10 },
                headStyles: { fillColor: [108, 117, 125] },
            });
            y = doc.lastAutoTable.finalY + 16;
        } else {
            // Fallback: manual rows
            doc.setFont(undefined, 'bold');
            doc.text(head[0].join('   |   '), 40, y); y += 14;
            doc.setFont(undefined, 'normal');
            body.forEach(row => { doc.text(row.join('   |   '), 40, y); y += 14; });
            y += 8;
        }
        // Totals
        doc.setFont(undefined, 'bold');
        doc.text(`Total Hours: ${(inv.grand_total_hours || 0).toFixed(2)}`, pageW - 40, y, { align: 'right' });
        y += 16;
        if (hasRate) {
            doc.setFontSize(13);
            const totalAmt = inv.total_amount || (inv.grand_total_hours * rate);
            doc.text(`Total Amount: ${fmtMoney(totalAmt)}`, pageW - 40, y, { align: 'right' });
            y += 20;
        }
        // Notes
        if (inv.notes) {
            doc.setFontSize(11);
            doc.setFont(undefined, 'bold');
            doc.text('Notes:', 40, y); y += 14;
            doc.setFont(undefined, 'normal');
            const plainNotes = (inv.notes || '').replace(/<[^>]+>/g, '').trim();
            const lines = doc.splitTextToSize(plainNotes, pageW - 80);
            doc.text(lines, 40, y);
        }
        doc.save(`${inv.name.replace(/\//g, '_')}.pdf`);
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
