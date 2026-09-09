/** @odoo-module **/
import { Component, xml, useState, onWillStart, useRef, useExternalListener, useEffect } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";

/**
 * One palette for the Requirement / Update / Bug badge, so the web table, the
 * PDF and the spreadsheet cannot drift apart. `cls` is the class the web uses;
 * `rgb` / `text` drive jsPDF; `argb` / `fg` drive ExcelJS.
 *
 * The fills are the values Odoo's BACKEND THEME actually compiles these classes
 * to, read out of web.assets_web.min.css — not Bootstrap's defaults. Odoo
 * repaints .bg-primary as its own purple RGB(113,99,158) rather than #0D6EFD,
 * and .bg-secondary as a pale RGB(222,226,230), so using the Bootstrap palette
 * here would have made every exported REQ badge the wrong colour.
 * Text colours are chosen for contrast on those fills.
 */
const TYPE_STYLES = {
    REQ: { cls: 'bg-primary', rgb: [113, 99, 158], text: [255, 255, 255], argb: 'FF71639E', fg: 'FFFFFFFF' },
    UPT: { cls: 'bg-warning text-dark', rgb: [255, 193, 7], text: [0, 0, 0], argb: 'FFFFC107', fg: 'FF000000' },
    UPD: { cls: 'bg-warning text-dark', rgb: [255, 193, 7], text: [0, 0, 0], argb: 'FFFFC107', fg: 'FF000000' },
    BUG: { cls: 'bg-danger', rgb: [220, 53, 69], text: [255, 255, 255], argb: 'FFDC3545', fg: 'FFFFFFFF' },
};
const TYPE_STYLE_DEFAULT = {
    cls: 'bg-secondary', rgb: [222, 226, 230], text: [33, 37, 41], argb: 'FFDEE2E6', fg: 'FF212529',
};

function typeStyle(taskType) {
    return TYPE_STYLES[(taskType || '').toUpperCase()] || TYPE_STYLE_DEFAULT;
}

// Spreadsheet palette, mirroring the PDF so the two documents read as the same
// report: the detail table is slate-headed with grey stripes, the project
// summary green-headed with faint green stripes.
const HEAD_FILL = 'FF343A40';         // [52,58,64]    detail header
const HEAD_FILL_SUMMARY = 'FF218838'; // [33,136,56]   project-summary header
const BAND_FILL = 'FFF5F5F5';         // [245,245,245] detail stripe
const BAND_FILL_SUMMARY = 'FFF0F8F0'; // [240,248,240] summary stripe
const TOTAL_FILL = 'FFECF0F1';        // [236,240,241] totals

function paintHeader(row, fill = HEAD_FILL) {
    row.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        cell.alignment = { vertical: 'middle', wrapText: true };
    });
    return row;
}

// Applied before any per-cell fill (the Type badge), so the badge wins.
function paintBand(row, index, fill) {
    if (index % 2 === 1) {
        row.eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        });
    }
    return row;
}

function paintTotal(row) {
    row.eachCell((cell) => {
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_FILL } };
    });
    return row;
}

/**
 * One checkbox dropdown, shared by the KRA / Employee / Type / State filters.
 *
 * Options are plain {id, name} dicts. `level` indents the row and marks it with
 * a ↳; `task_count` shows as a muted badge — which is the only thing telling
 * apart the 21 KRA pairs where a root and its child carry the identical name
 * (Internal oman > Internal oman, Nexgennpos > Nexgennpos, ...).
 *
 * The ⊘ exclude column renders only when onToggleExcept is supplied, so KRA
 * keeps its exclusions while the other three stay plain include-lists.
 */
export class MultiSelectPicker extends Component {
    static props = {
        options: { type: Array },
        selected: { type: Array },
        excluded: { type: Array, optional: true },
        emptyLabel: { type: String },
        hint: { type: String, optional: true },
        allOption: { type: Boolean, optional: true },
        onToggle: { type: Function },
        onToggleExcept: { type: Function, optional: true },
        onClear: { type: Function },
    };

    static template = xml/* xml */`
        <div class="o_kra_picker" t-ref="root">
            <button type="button" class="form-select text-start o_kra_picker_toggle"
                    t-on-click="toggleOpen">
                <t t-esc="label()"/>
            </button>
            <div class="o_kra_picker_panel shadow" t-if="state.open">
                <div class="o_kra_picker_actions">
                    <span class="text-muted small" t-esc="props.hint || 'Tick to select'"/>
                    <button type="button" class="btn btn-sm btn-link p-0"
                            t-on-click="() => this.props.onClear()">Clear</button>
                </div>
                <div class="o_kra_picker_row" t-if="props.allOption">
                    <div class="o_kra_picker_name fw-bold" t-on-click="() => this.props.onClear()">
                        <i class="fa me-2"
                           t-att-class="props.selected.length ? 'fa-square-o text-muted' : 'fa-check-square-o text-primary'"/>
                        <t t-esc="props.emptyLabel"/>
                    </div>
                </div>
                <t t-foreach="props.options" t-as="opt" t-key="opt.id">
                    <div class="o_kra_picker_row"
                         t-att-class="{'is-excluded': isExcluded(opt.id), 'is-empty': isEmpty(opt)}">
                        <div class="o_kra_picker_name"
                             t-att-style="'padding-left: ' + ((opt.level || 0) * 20) + 'px'"
                             t-on-click="() => this.onRowClick(opt)">
                            <i class="fa me-2"
                               t-att-class="isSelected(opt.id) ? 'fa-check-square-o text-primary' : 'fa-square-o text-muted'"/>
                            <t t-if="opt.level">↳ </t>
                            <t t-esc="opt.name"/>
                        </div>
                        <span class="badge o_kra_picker_count"
                              t-if="opt.task_count !== undefined"
                              t-esc="opt.task_count"/>
                        <button type="button" class="btn btn-sm o_kra_picker_except"
                                t-if="props.onToggleExcept"
                                t-att-class="isExcluded(opt.id) ? 'btn-danger' : 'btn-outline-danger'"
                                t-att-title="isExcluded(opt.id) ? 'Excluded — click to put back' : 'Exclude this and everything under it'"
                                t-on-click="() => this.props.onToggleExcept(opt.id)">⊘</button>
                    </div>
                </t>
            </div>
        </div>
    `;

    setup() {
        this.state = useState({ open: false });
        this.rootRef = useRef("root");
        useExternalListener(window, "click", (ev) => {
            const el = this.rootRef.el;
            if (this.state.open && el && !el.contains(ev.target)) {
                this.state.open = false;
            }
        });
    }

    get excludedIds() {
        return this.props.excluded || [];
    }

    isSelected(id) {
        return this.props.selected.includes(id);
    }

    isExcluded(id) {
        return this.excludedIds.includes(id);
    }

    /**
     * An option that would return nothing under the other filters. A SELECTED
     * option is never treated as empty — otherwise, once its count fell to 0,
     * there would be no way to untick it.
     */
    isEmpty(opt) {
        return opt.task_count === 0 && !this.isSelected(opt.id);
    }

    onRowClick(opt) {
        if (!this.isEmpty(opt)) {
            this.props.onToggle(opt.id);
        }
    }

    toggleOpen() {
        this.state.open = !this.state.open;
    }

    nameOf(id) {
        const opt = this.props.options.find((o) => o.id === id);
        return opt ? opt.name : '';
    }

    label() {
        const selected = this.props.selected;
        let text = this.props.emptyLabel;
        if (selected.length) {
            const names = selected.slice(0, 2).map((id) => this.nameOf(id)).join(', ');
            text = selected.length > 2 ? `${names} +${selected.length - 2}` : names;
        }
        if (this.excludedIds.length) {
            text += `  − ${this.excludedIds.length} excluded`;
        }
        return text;
    }
}

export class KpiKraReport extends Component {
    static components = { MultiSelectPicker };

    static template = xml/* xml */`
        <div class="o_kpi_kra_report p-4">
            <!-- Header -->
            <div class="d-flex justify-content-between align-items-center mb-4">
                <h2 class="fw-bold">
                    <i class="fa fa-sitemap me-2 text-primary"></i>
                    KRA Report
                </h2>
                <div>
                    <!-- ZIP always carries the project + per-task PDFs; the
                         dropdown decides which whole-report files ride along. -->
                    <span class="o_kra_zip_menu me-2" t-if="state.reportGenerated" t-ref="zipMenu">
                        <button class="btn btn-warning"
                                t-on-click="toggleZipMenu"
                                t-att-disabled="isStale"
                                t-att-title="isStale ? 'Filters changed — click Generate Report first' : 'Bundle the per-task PDFs, plus the full report files you choose'">
                            <i class="fa fa-file-archive-o me-2"></i>Download ZIP
                            <i class="fa fa-caret-down ms-2"></i>
                        </button>
                        <div class="o_kra_zip_panel shadow" t-if="state.zipMenuOpen">
                            <div class="o_kra_zip_hint">What should the archive contain?</div>
                            <button type="button" class="o_kra_zip_item"
                                    t-on-click="() => this.downloadZip({ pdf: true })">
                                <i class="fa fa-file-pdf-o me-2 text-danger"></i>PDF pack
                                <span class="text-muted small d-block ms-4">full report + one PDF per task</span>
                            </button>
                            <button type="button" class="o_kra_zip_item"
                                    t-on-click="() => this.downloadZip({ excel: true })">
                                <i class="fa fa-file-excel-o me-2 text-success"></i>Excel pack
                                <span class="text-muted small d-block ms-4">full report + one workbook per project</span>
                            </button>
                            <button type="button" class="o_kra_zip_item"
                                    t-on-click="() => this.downloadZip({ pdf: true, excel: true })">
                                <i class="fa fa-files-o me-2 text-secondary"></i>Both packs
                                <span class="text-muted small d-block ms-4">everything above, in one archive</span>
                            </button>
                        </div>
                    </span>
                    <button class="btn btn-success me-2"
                            t-on-click="downloadPDF"
                            t-if="state.reportGenerated"
                            t-att-disabled="isStale"
                            t-att-title="isStale ? 'Filters changed — click Generate Report first' : 'Download report as PDF'">
                        <i class="fa fa-file-pdf-o me-2"></i>Download PDF
                    </button>
                    <button class="btn btn-info me-2"
                            t-on-click="downloadExcel"
                            t-if="state.reportGenerated"
                            t-att-disabled="isStale"
                            t-att-title="isStale ? 'Filters changed — click Generate Report first' : 'Download report as Excel'">
                        <i class="fa fa-file-excel-o me-2"></i>Download Excel
                    </button>
                    <button class="btn btn-secondary" t-on-click="backToDashboard">
                        ← Back
                    </button>
                </div>
            </div>

            <!-- Filters Card -->
            <div class="card p-4 mb-4 shadow-sm">
                <h5 class="fw-bold mb-3">
                    <i class="fa fa-filter me-2 text-secondary"></i>
                    Report Filters
                </h5>
                <div class="row g-3">
                    <!-- Time Frame Quick Select -->
                    <div class="col-md-2">
                        <label class="form-label fw-bold">Quick Select</label>
                        <select class="form-select" t-model="state.filters.time_frame" t-on-change="onTimeFrameChange">
                            <option value="">Custom</option>
                            <option value="today">Today</option>
                            <option value="yesterday">Yesterday</option>
                            <option value="last_month">Last Month</option>
                            <option value="last_year">Last Year</option>
                        </select>
                    </div>
                    <!-- From Date -->
                    <div class="col-md-2">
                        <label class="form-label fw-bold">From Date</label>
                        <input type="date" class="form-control" t-model="state.filters.from_date"/>
                    </div>
                    <!-- To Date -->
                    <div class="col-md-2">
                        <label class="form-label fw-bold">To Date</label>
                        <input type="date" class="form-control" t-model="state.filters.to_date"/>
                    </div>
                    <!-- KRA Filter: multi include + multi exclude -->
                    <div class="col-md-4">
                        <label class="form-label fw-bold">KRA</label>
                        <MultiSelectPicker
                            options="state.kras"
                            selected="state.filters.kra_ids"
                            excluded="state.filters.excluded_kra_ids"
                            emptyLabel="'All KRAs'"
                            hint="'Tick to include, ⊘ to exclude'"
                            onToggle="(id) => this.toggleKra(id)"
                            onToggleExcept="(id) => this.toggleKraException(id)"
                            onClear="() => this.clearKraSelection()"/>
                    </div>
                    <!-- Employee Filter -->
                    <div class="col-md-2">
                        <label class="form-label fw-bold">Employee</label>
                        <MultiSelectPicker
                            options="state.employees"
                            selected="state.filters.employee_ids"
                            emptyLabel="'All Employees'"
                            onToggle="(id) => this.toggleEmployee(id)"
                            onClear="() => this.clearList('employee_ids')"/>
                    </div>
                </div>
                <div class="row g-3 mt-0">
                    <!-- Task Type: the external_ref prefix (REQ / UPT / BUG / ...) -->
                    <div class="col-md-3">
                        <label class="form-label fw-bold">Type</label>
                        <MultiSelectPicker
                            options="state.taskTypes"
                            selected="state.filters.task_types"
                            emptyLabel="'All Types'"
                            allOption="true"
                            onToggle="(id) => this.toggleTaskType(id)"
                            onClear="() => this.clearList('task_types')"/>
                    </div>
                    <!-- Task State -->
                    <div class="col-md-3">
                        <label class="form-label fw-bold">State</label>
                        <MultiSelectPicker
                            options="state.taskStates"
                            selected="state.filters.task_states"
                            emptyLabel="'All States'"
                            allOption="true"
                            onToggle="(id) => this.toggleTaskState(id)"
                            onClear="() => this.clearList('task_states')"/>
                    </div>
                </div>
                <div class="mt-3 d-flex gap-2">
                    <button class="btn btn-primary" t-on-click="generateReport" t-att-disabled="state.isLoading">
                        <i class="fa fa-refresh me-2" t-att-class="{'fa-spin': state.isLoading}"></i>
                        <t t-if="state.isLoading">Generating...</t>
                        <t t-else="">Generate Report</t>
                    </button>
                    <button class="btn btn-outline-secondary" t-on-click="resetFilters">
                        <i class="fa fa-times me-2"></i>Reset
                    </button>
                </div>
            </div>

            <!-- Filters moved on since these results were fetched. Downloads are
                 blocked rather than warned about: an export that disagrees with
                 the boxes above it reaches a client as a finished document. -->
            <t t-if="isStale">
                <div class="alert alert-warning d-flex align-items-center gap-2">
                    <i class="fa fa-exclamation-triangle"></i>
                    <div>
                        Filters changed — click <b>Generate Report</b> to apply them.
                        Downloads stay disabled until you do, so an export can never
                        disagree with the filters above.
                    </div>
                </div>
            </t>

            <!-- Report Results -->
            <t t-if="state.reportGenerated">
                <!-- What the numbers below actually cover. Until now this only
                     existed in the PDF header, so a stale table looked correct. -->
                <div class="text-muted small mb-3">
                    <i class="fa fa-filter me-1"></i>
                    Showing <b t-esc="state.appliedFilters.kra_name || 'All KRAs'"/>
                    · <t t-esc="state.appliedFilters.employee_name || 'All Employees'"/>
                    · <t t-esc="state.appliedFilters.task_type_name || 'All Types'"/>
                    · <t t-esc="state.appliedFilters.task_state_name || 'All States'"/>
                    · <t t-esc="state.appliedFilters.from_date"/> → <t t-esc="state.appliedFilters.to_date"/>
                    <t t-if="state.searchQuery.trim()">
                        · matching "<t t-esc="state.searchQuery.trim()"/>"
                    </t>
                    <t t-if="state.removedRowIds.length">
                        · <span class="text-danger"><t t-esc="state.removedRowIds.length"/> rows removed</span>
                    </t>
                </div>

                <!-- Trimmed rows. Worded "from this report" so nobody reads it
                     as having deleted actual work. -->
                <t t-if="state.removedRowIds.length">
                    <div class="alert alert-secondary py-2 d-flex align-items-center gap-2">
                        <i class="fa fa-scissors"></i>
                        <div>
                            <b t-esc="state.removedRowIds.length"/> row(s) removed from this report —
                            the tasks themselves are untouched.
                            <button type="button" class="btn btn-sm btn-link p-0 align-baseline"
                                    t-on-click="restoreRows">Restore all</button>
                        </div>
                    </div>
                </t>

                <!-- Summary Cards -->
                <div class="row mb-4">
                    <div class="col-md-4">
                        <div class="card bg-primary text-white p-3 shadow-sm">
                            <div class="d-flex justify-content-between align-items-center">
                                <div>
                                    <h6 class="mb-0 opacity-75">Total Tasks</h6>
                                    <h3 class="mb-0 fw-bold" t-esc="getFilteredData().length"/>
                                </div>
                                <i class="fa fa-tasks fa-2x opacity-50"></i>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-4">
                        <div class="card bg-success text-white p-3 shadow-sm">
                            <div class="d-flex justify-content-between align-items-center">
                                <div>
                                    <h6 class="mb-0 opacity-75">Total Time Worked</h6>
                                    <h3 class="mb-0 fw-bold" t-esc="getTotalTimeWorked()"/>
                                </div>
                                <i class="fa fa-clock-o fa-2x opacity-50"></i>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-4">
                        <div class="card bg-warning text-dark p-3 shadow-sm">
                            <div class="d-flex justify-content-between align-items-center">
                                <div>
                                    <h6 class="mb-0 opacity-75">Employees</h6>
                                    <h3 class="mb-0 fw-bold" t-esc="getUniqueEmployeeCount()"/>
                                </div>
                                <i class="fa fa-users fa-2x opacity-50"></i>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Data Table -->
                <div class="card p-4 shadow-sm">
                    <div class="d-flex justify-content-between align-items-center mb-3">
                        <h5 class="fw-bold mb-0">
                            <i class="fa fa-table me-2 text-secondary"></i>
                            KRA Details
                        </h5>
                        <div class="input-group" style="max-width: 300px;">
                            <span class="input-group-text"><i class="fa fa-search"></i></span>
                            <input type="text" class="form-control" placeholder="Search..." 
                                   t-model="state.searchQuery" t-on-input="onSearchChange"/>
                        </div>
                    </div>
                    
                    <t t-if="getFilteredData().length > 0">
                        <div class="table-responsive">
                            <table class="table table-bordered table-hover table-sm">
                                <thead class="table-dark">
                                    <tr>
                                        <th class="text-center" style="width: 64px; white-space: nowrap;">#</th>
                                        <th style="min-width: 280px;">
                                            <i class="fa fa-sitemap me-1"></i>
                                            KRA Hierarchy Path
                                        </th>
                                        <th style="min-width: 150px;">
                                            <i class="fa fa-bookmark me-1"></i>
                                            Sub KRA
                                        </th>
                                        <th style="min-width: 200px;">
                                            <i class="fa fa-flag me-1"></i>
                                            Task Name
                                        </th>
                                        <th style="min-width: 150px;">
                                            <i class="fa fa-user me-1"></i>
                                            Employee
                                        </th>
                                        <th class="text-center" style="width: 90px;">
                                            <i class="fa fa-tag me-1"></i>
                                            Type
                                        </th>
                                        <th style="min-width: 140px;">
                                            <i class="fa fa-info-circle me-1"></i>
                                            State
                                        </th>
                                        <th class="text-center" style="width: 120px;">
                                            <i class="fa fa-clock-o me-1"></i>
                                            Time Worked
                                        </th>
                                        <th class="text-center" style="width: 44px;"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <t t-foreach="getFilteredData()" t-as="row" t-key="row.id">
                                        <tr>
                                            <td class="text-center text-muted" t-esc="row_index + 1"/>
                                            <td>
                                                <span class="badge bg-light text-dark border" 
                                                      style="font-size: 0.95rem; white-space: normal; text-align: left; padding: 8px 12px;">
                                                    <t t-esc="row.kra_path"/>
                                                </span>
                                            </td>
                                            <td>
                                                <t t-if="row.sub_kra !== '-'">
                                                    <span class="badge bg-secondary" style="font-size: 0.9rem;" t-esc="row.sub_kra"/>
                                                </t>
                                                <t t-else="">
                                                    <span class="text-muted">-</span>
                                                </t>
                                            </td>
                                            <td class="fw-bold text-primary" t-esc="row.kpi_name"/>
                                            <td>
                                                <i class="fa fa-user-circle me-1 text-muted"></i>
                                                <t t-esc="row.employee_name"/>
                                            </td>
                                            <td class="text-center">
                                                <t t-if="row.task_type">
                                                    <span class="badge" t-att-class="taskTypeClass(row.task_type)" t-esc="row.task_type"/>
                                                </t>
                                                <t t-else="">
                                                    <span class="text-muted">—</span>
                                                </t>
                                            </td>
                                            <td>
                                                <span class="badge bg-light text-dark border" t-esc="row.task_state_label || '—'"/>
                                            </td>
                                            <td class="text-center">
                                                <span class="badge bg-info" t-esc="row.time_worked_display"/>
                                            </td>
                                            <td class="text-center">
                                                <button type="button" class="btn btn-sm btn-outline-danger py-0 px-1"
                                                        title="Remove this row from the report (the task itself is not deleted)"
                                                        t-on-click="() => this.removeRow(row.id)">✕</button>
                                            </td>
                                        </tr>
                                    </t>
                                </tbody>
                                <tfoot class="table-light fw-bold">
                                    <tr>
                                        <td class="text-center">-</td>
                                        <td colspan="6">Total</td>
                                        <td class="text-center">
                                            <span class="badge bg-success" t-esc="getTotalTimeWorked()"/>
                                        </td>
                                        <td></td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    </t>
                    <t t-else="">
                        <div class="alert alert-info text-center">
                            <i class="fa fa-info-circle me-2"></i>
                            No data found matching your filters.
                        </div>
                    </t>
                </div>

                <!-- KRA Summary Section. Built client-side from getProjectSummary()
                     rather than the server's payload, so it follows the search box
                     and any removed rows instead of quietly showing the full set. -->
                <t t-if="getProjectSummary().length > 0">
                    <div class="card p-4 mt-4 shadow-sm">
                        <h5 class="fw-bold mb-3">
                            <i class="fa fa-bar-chart me-2 text-secondary"></i>
                            KRA Summary
                        </h5>
                        <div class="table-responsive">
                            <table class="table table-bordered table-sm">
                                <thead class="table-secondary">
                                    <tr>
                                        <th>KRA Path</th>
                                        <th class="text-center">Task Count</th>
                                        <th class="text-center">Total Time</th>
                                        <th class="text-center">Employees</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <t t-foreach="getProjectSummary()" t-as="summary" t-key="summary.kra_path">
                                        <tr>
                                            <td style="font-size: 0.95rem;" t-esc="summary.kra_path"/>
                                            <td class="text-center">
                                                <span class="badge bg-primary" t-esc="summary.task_count"/>
                                            </td>
                                            <td class="text-center">
                                                <span class="badge bg-info" t-esc="summary.total_display"/>
                                            </td>
                                            <td class="text-center">
                                                <span class="badge bg-secondary" t-esc="summary.employee_count"/>
                                            </td>
                                        </tr>
                                    </t>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </t>
            </t>

            <!-- Initial State -->
            <t t-if="!state.reportGenerated and !state.isLoading">
                <div class="card p-5 text-center shadow-sm">
                    <i class="fa fa-sitemap fa-4x text-muted mb-3"></i>
                    <h4 class="text-muted">Select filters and click "Generate Report"</h4>
                    <p class="text-muted mb-0">
                        This report shows tasks organized by their hierarchical KRA structure with time tracking.
                    </p>
                </div>
            </t>
        </div>
    `;

    setup() {
        this.actionService = useService("action");
        
        const today = new Date().toISOString().split('T')[0];
        
        this.state = useState({
            isLoading: false,
            reportGenerated: false,
            filters: {
                from_date: today,
                to_date: today,
                employee_ids: [],
                kra_ids: [],
                excluded_kra_ids: [],
                task_types: [],
                task_states: [],
                time_frame: '',
            },
            kras: [],
            employees: [],
            taskTypes: [],
            taskStates: [],
            reportData: [],
            searchQuery: '',
            // Rows trimmed out of THIS report before sending it. The kra.kpi
            // records are untouched and return on the next Generate.
            removedRowIds: [],
            appliedFilters: {},
            zipMenuOpen: false,
            // Signature of the filters that produced state.reportData, so we can
            // tell when the boxes have moved on since the last Generate.
            generatedSignature: '',
        });

        this.zipMenuRef = useRef("zipMenu");
        useExternalListener(window, "click", (ev) => {
            const el = this.zipMenuRef.el;
            if (this.state.zipMenuOpen && el && !el.contains(ev.target)) {
                this.state.zipMenuOpen = false;
            }
        });

        // Counts follow whatever the filters currently say. Keyed on the same
        // signature the stale-results guard uses, so it fires for the date
        // inputs and Quick Select too — not just the pickers.
        this._countsTimer = null;
        useEffect(
            () => { this.scheduleCountRefresh(); },
            () => [this.filtersSignature()]
        );

        onWillStart(async () => {
            await this.loadFilterOptions();
            await this.refreshFilterCounts();
        });
    }

    // ---- Live filter counts --------------------------------------------- //

    scheduleCountRefresh() {
        clearTimeout(this._countsTimer);
        this._countsTimer = setTimeout(() => this.refreshFilterCounts(), 250);
    }

    async refreshFilterCounts() {
        const issuedFor = this.filtersSignature();
        try {
            const result = await rpc('/kpi_reports/kra/filter_counts', {
                from_date: this.state.filters.from_date,
                to_date: this.state.filters.to_date,
                employee_ids: this.state.filters.employee_ids,
                kra_ids: this.state.filters.kra_ids,
                excluded_kra_ids: this.state.filters.excluded_kra_ids,
                task_types: this.state.filters.task_types,
                task_states: this.state.filters.task_states,
            });
            // A slower earlier reply must not overwrite a newer one.
            if (!result.status || issuedFor !== this.filtersSignature()) {
                return;
            }
            this.applyCounts(this.state.kras, result.kras);
            this.applyCounts(this.state.employees, result.employees);
            this.applyCounts(this.state.taskTypes, result.task_types);
            this.applyCounts(this.state.taskStates, result.task_states);
        } catch (error) {
            console.error('Error refreshing filter counts:', error);
        }
    }

    /** Absent from the reply means nothing matched, so 0 rather than "unknown". */
    applyCounts(options, counts) {
        const byId = counts || {};
        for (const opt of options) {
            opt.task_count = byId[opt.id] || 0;
        }
    }

    // ---- Stale-results guard -------------------------------------------- //

    /**
     * Identity of the current filter selection.
     *
     * The id arrays are sorted so that ticking A-then-B and B-then-A read as the
     * same filter rather than a spurious change. time_frame is deliberately left
     * out: it is only a shortcut that writes from_date / to_date, and those are
     * already compared — including it would flag "Today" as changed even when the
     * dates it set are identical.
     */
    filtersSignature() {
        const f = this.state.filters;
        return JSON.stringify({
            from_date: f.from_date,
            to_date: f.to_date,
            employee_ids: [...f.employee_ids].sort((a, b) => a - b),
            kra_ids: [...f.kra_ids].sort((a, b) => a - b),
            excluded_kra_ids: [...f.excluded_kra_ids].sort((a, b) => a - b),
            task_types: [...f.task_types].sort(),
            task_states: [...f.task_states].sort(),
        });
    }

    get isStale() {
        return this.state.reportGenerated
            && this.filtersSignature() !== this.state.generatedSignature;
    }

    // ---- Filter selections ---------------------------------------------- //

    /** Add or remove a value from one of the filter arrays, in place. */
    _toggleIn(list, value) {
        const at = list.indexOf(value);
        if (at === -1) {
            list.push(value);
        } else {
            list.splice(at, 1);
        }
    }

    clearList(name) {
        this.state.filters[name] = [];
    }

    toggleKra(kraId) {
        this._toggleIn(this.state.filters.kra_ids, kraId);
        if (this.state.filters.kra_ids.includes(kraId)) {
            // Including a KRA cancels any exception on it.
            this.state.filters.excluded_kra_ids =
                this.state.filters.excluded_kra_ids.filter((id) => id !== kraId);
        }
    }

    toggleKraException(kraId) {
        this._toggleIn(this.state.filters.excluded_kra_ids, kraId);
        if (this.state.filters.excluded_kra_ids.includes(kraId)) {
            // Exclude wins over include, so drop it from the include list.
            this.state.filters.kra_ids =
                this.state.filters.kra_ids.filter((id) => id !== kraId);
        }
    }

    clearKraSelection() {
        this.state.filters.kra_ids = [];
        this.state.filters.excluded_kra_ids = [];
    }

    toggleEmployee(userId) {
        this._toggleIn(this.state.filters.employee_ids, userId);
    }

    toggleTaskType(prefix) {
        this._toggleIn(this.state.filters.task_types, prefix);
    }

    toggleTaskState(code) {
        this._toggleIn(this.state.filters.task_states, code);
    }

    // ---- Trimming rows out of this report -------------------------------- //

    removeRow(rowId) {
        if (!this.state.removedRowIds.includes(rowId)) {
            this.state.removedRowIds.push(rowId);
        }
    }

    restoreRows() {
        this.state.removedRowIds = [];
    }

    async loadFilterOptions() {
        try {
            const result = await rpc('/kpi_reports/kra/get_filters', {});
            if (result.status) {
                this.state.kras = result.kras || [];
                this.state.employees = result.employees || [];
                this.state.taskTypes = result.task_types || [];
                this.state.taskStates = result.task_states || [];
            }
        } catch (error) {
            console.error('Error loading filter options:', error);
        }
    }

    onTimeFrameChange() {
        const timeFrame = this.state.filters.time_frame;
        const today = new Date();
        
        if (timeFrame === 'today') {
            const todayStr = today.toISOString().split('T')[0];
            this.state.filters.from_date = todayStr;
            this.state.filters.to_date = todayStr;
        } else if (timeFrame === 'yesterday') {
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = yesterday.toISOString().split('T')[0];
            this.state.filters.from_date = yesterdayStr;
            this.state.filters.to_date = yesterdayStr;
        } else if (timeFrame === 'last_month') {
            const firstDay = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            const lastDay = new Date(today.getFullYear(), today.getMonth(), 0);
            this.state.filters.from_date = firstDay.toISOString().split('T')[0];
            this.state.filters.to_date = lastDay.toISOString().split('T')[0];
        } else if (timeFrame === 'last_year') {
            const lastYear = today.getFullYear() - 1;
            this.state.filters.from_date = `${lastYear}-01-01`;
            this.state.filters.to_date = `${lastYear}-12-31`;
        }
    }

    async generateReport() {
        this.state.isLoading = true;
        this.state.reportGenerated = false;
        
        try {
            const result = await rpc('/kpi_reports/kra/generate', {
                from_date: this.state.filters.from_date,
                to_date: this.state.filters.to_date,
                employee_ids: this.state.filters.employee_ids,
                kra_ids: this.state.filters.kra_ids,
                excluded_kra_ids: this.state.filters.excluded_kra_ids,
                task_types: this.state.filters.task_types,
                task_states: this.state.filters.task_states,
                time_frame: this.state.filters.time_frame || false,
            });
            
            if (result.status) {
                this.state.reportData = result.data || [];
                this.state.appliedFilters = result.filters || {};
                // Only on success: a failed run must leave the previous results
                // marked stale rather than blessing them as current.
                this.state.removedRowIds = [];
                this.state.generatedSignature = this.filtersSignature();
                this.state.reportGenerated = true;
            } else {
                alert('Error generating report: ' + (result.message || 'Unknown error'));
            }
        } catch (error) {
            console.error('Error generating report:', error);
            alert('Error generating report. Please try again.');
        } finally {
            this.state.isLoading = false;
        }
    }

    resetFilters() {
        const today = new Date().toISOString().split('T')[0];
        this.state.filters = {
            from_date: today,
            to_date: today,
            employee_ids: [],
            kra_ids: [],
            excluded_kra_ids: [],
            task_types: [],
            task_states: [],
            time_frame: '',
        };
        this.state.removedRowIds = [];
        this.state.searchQuery = '';
    }

    onSearchChange() {
        // Search is reactive through getFilteredData()
    }

    /**
     * The rows every number on this screen is derived from — the cards, the
     * table footer, the KRA Summary, the PDF, the spreadsheet and the ZIP all
     * read through here, so a removed row can never leave a stale total behind.
     */
    getFilteredData() {
        const removed = this.state.removedRowIds;
        const kept = removed.length
            ? this.state.reportData.filter(row => !removed.includes(row.id))
            : this.state.reportData;

        if (!this.state.searchQuery.trim()) {
            return kept;
        }

        const query = this.state.searchQuery.toLowerCase().trim();
        return kept.filter(row =>
            row.kra_path.toLowerCase().includes(query) ||
            row.sub_kra.toLowerCase().includes(query) ||
            row.kpi_name.toLowerCase().includes(query) ||
            row.employee_name.toLowerCase().includes(query) ||
            (row.task_type || '').toLowerCase().includes(query) ||
            (row.task_state_label || '').toLowerCase().includes(query)
        );
    }

    /**
     * Colour for the Requirement / Update / Bug badge, matching the palette the
     * Accept dialog uses so the same task reads the same way in both screens.
     */
    taskTypeClass(taskType) {
        return typeStyle(taskType).cls;
    }

    getTotalTimeWorked() {
        const totalSeconds = this.getFilteredData().reduce((sum, row) => sum + (row.time_worked_seconds || 0), 0);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        return `${hours}h ${minutes}m`;
    }

    getUniqueKraCount() {
        const uniqueKras = new Set(this.getFilteredData().map(row => row.kra_path));
        return uniqueKras.size;
    }

    getUniqueEmployeeCount() {
        const uniqueEmployees = new Set(this.getFilteredData().map(row => row.employee_id).filter(id => id));
        return uniqueEmployees.size;
    }

    // Group the current filtered rows by KRA hierarchy path so the PDF/Excel
    // can render a "project summary" block above the task-detail list.
    getProjectSummary() {
        const buckets = new Map();
        for (const row of this.getFilteredData()) {
            const key = row.kra_path || row.sub_kra || 'Unassigned';
            if (!buckets.has(key)) {
                buckets.set(key, {
                    kra_path: key,
                    root_kra: row.root_kra || '',
                    sub_kra: row.sub_kra || '',
                    task_count: 0,
                    total_seconds: 0,
                    employees: new Set(),
                });
            }
            const b = buckets.get(key);
            b.task_count += 1;
            b.total_seconds += (row.time_worked_seconds || 0);
            if (row.employee_name) b.employees.add(row.employee_name);
        }
        const fmt = (sec) => {
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            return `${h}h ${m}m`;
        };
        return Array.from(buckets.values())
            .map(b => ({
                kra_path: b.kra_path,
                root_kra: b.root_kra,
                sub_kra: b.sub_kra,
                task_count: b.task_count,
                employee_count: b.employees.size,
                employees: Array.from(b.employees).sort().join(', '),
                total_seconds: b.total_seconds,
                total_hours: +(b.total_seconds / 3600).toFixed(2),
                total_display: fmt(b.total_seconds),
            }))
            .sort((a, b) => a.kra_path.localeCompare(b.kra_path));
    }

    getStatusBadgeClass(status) {
        const classes = {
            'completed': 'badge bg-success',
            'in_progress': 'badge bg-primary',
            'paused': 'badge bg-warning text-dark',
            'partially_completed': 'badge bg-info',
            'assigned': 'badge bg-secondary',
            'urgent': 'badge bg-danger',
            'important': 'badge bg-warning text-dark',
            'regular': 'badge bg-light text-dark border',
        };
        return classes[status] || 'badge bg-secondary';
    }

    formatStatus(status) {
        const labels = {
            'completed': 'Completed',
            'in_progress': 'In Progress',
            'paused': 'Paused',
            'partially_completed': 'Pending Approval',
            'assigned': 'Assigned',
            'urgent': 'Urgent',
            'important': 'Important',
            'regular': 'Regular',
        };
        return labels[status] || status || 'Unknown';
    }

    backToDashboard() {
        window.history.back();
    }

    // Helper function to convert arrow symbols to PDF-safe format
    formatKraPathForPdf(path) {
        // Replace → with > for PDF compatibility
        return path.replace(/→/g, '>');
    }

    // Safe filename: strip characters illegal on Windows/Unix and collapse whitespace.
    _safeFilename(s) {
        return String(s || 'untitled')
            .replace(/[\\/:*?"<>|]+/g, '-')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
    }

    // Build a single per-project summary PDF (jsPDF Blob).
    _buildProjectSummaryPdf(projectKey, projectRows) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF('p', 'mm', 'a4');
        const filterFrom = this.state.filters.from_date || '';
        const filterTo   = this.state.filters.to_date || '';

        // Header band
        doc.setFillColor(33, 136, 56);
        doc.rect(0, 0, 210, 24, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(15);
        doc.setFont(undefined, 'bold');
        doc.text(this.formatKraPathForPdf(projectKey), 14, 12);
        doc.setFontSize(9);
        doc.setFont(undefined, 'normal');
        doc.text(`Period: ${filterFrom}  to  ${filterTo}`, 14, 19);

        // Aggregate user totals across this project's rows
        const userTotals = new Map();
        let totalSec = 0;
        for (const row of projectRows) {
            totalSec += row.time_worked_seconds || 0;
            for (const ub of (row.user_breakdown || [])) {
                const cur = userTotals.get(ub.user_name) || 0;
                userTotals.set(ub.user_name, cur + (ub.seconds || 0));
            }
        }
        const fmt = (sec) => {
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            return `${h}h ${m}m`;
        };

        doc.setTextColor(0, 0, 0);
        doc.setFontSize(10);
        doc.text(`Total tasks: ${projectRows.length}`, 14, 32);
        doc.text(`Total time: ${fmt(totalSec)}`, 80, 32);
        doc.text(`Contributors: ${userTotals.size}`, 145, 32);

        // Contributor breakdown table
        const ubBody = Array.from(userTotals.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([name, sec]) => [name, fmt(sec), ((sec * 100) / (totalSec || 1)).toFixed(1) + '%']);
        doc.autoTable({
            head: [['Contributor', 'Time Worked', 'Share']],
            body: ubBody,
            startY: 38,
            styles: { fontSize: 9, cellPadding: 2 },
            headStyles: { fillColor: [33, 136, 56], textColor: 255, fontStyle: 'bold' },
            columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
        });

        // Task list table
        const startY = (doc.lastAutoTable && doc.lastAutoTable.finalY ? doc.lastAutoTable.finalY : 38) + 8;
        doc.setFont(undefined, 'bold');
        doc.text('Task list', 14, startY);

        const taskBody = projectRows.map((r, i) => [
            i + 1,
            r.external_ref || '—',
            r.kpi_name,
            r.employee_name,
            r.time_worked_display,
        ]);
        taskBody.push(['', 'TOTAL', `${projectRows.length} tasks`, '', fmt(totalSec)]);

        doc.autoTable({
            head: [['#', 'Ref', 'Task Name', 'Primary Assignee', 'Time Worked']],
            body: taskBody,
            startY: startY + 2,
            styles: { fontSize: 8.5, cellPadding: 2, overflow: 'linebreak' },
            headStyles: { fillColor: [52, 58, 64], textColor: 255, fontStyle: 'bold' },
            alternateRowStyles: { fillColor: [245, 245, 245] },
            // Pin only the narrow fixed-content columns; the text columns are
            // left auto so autoTable distributes the rest of the printable
            // width. Hand-tuned millimetres drifted past the page edge before.
            columnStyles: {
                0: { cellWidth: 12, halign: 'center', overflow: 'visible' },
                1: { cellWidth: 22 },
                4: { cellWidth: 26, halign: 'right' },
            },
            didParseCell: (cd) => {
                if (cd.row.index === taskBody.length - 1) {
                    cd.cell.styles.fillColor = [236, 240, 241];
                    cd.cell.styles.fontStyle = 'bold';
                }
            },
        });

        return doc.output('blob');
    }

    // Build a per-task detail PDF (jsPDF Blob).
    _buildTaskDetailPdf(row) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF('p', 'mm', 'a4');

        doc.setFillColor(52, 58, 64);
        doc.rect(0, 0, 210, 22, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(13);
        doc.setFont(undefined, 'bold');
        doc.text(this.formatKraPathForPdf(row.kpi_name || 'Task'), 14, 12);
        doc.setFontSize(9);
        doc.setFont(undefined, 'normal');
        doc.text(`Ref: ${row.external_ref || '—'}    State: ${row.task_state_label || row.task_state || '—'}`, 14, 18);

        doc.setTextColor(0, 0, 0);
        doc.setFontSize(10);
        doc.autoTable({
            head: [['Field', 'Value']],
            body: [
                ['KRA Hierarchy', this.formatKraPathForPdf(row.kra_path || '')],
                ['Sub-KRA', row.sub_kra || '—'],
                ['External Ref', row.external_ref || '—'],
                ['Type', row.task_type || '—'],
                ['Priority', row.priority || '—'],
                ['Task State', row.task_state_label || row.task_state || '—'],
                ['Deadline', row.deadline || '—'],
                ['Primary Assignee', row.employee_name || '—'],
                ['Total Time Worked', row.time_worked_display || '0h 0m'],
            ],
            startY: 28,
            styles: { fontSize: 9.5, cellPadding: 2.5 },
            headStyles: { fillColor: [52, 58, 64], textColor: 255, fontStyle: 'bold' },
            // Label pinned, value auto — so a long KRA path can never push the
            // table past the right margin.
            columnStyles: { 0: { cellWidth: 50, fontStyle: 'bold' } },
        });

        // User-breakdown table
        const yStart = (doc.lastAutoTable && doc.lastAutoTable.finalY ? doc.lastAutoTable.finalY : 28) + 8;
        doc.setFont(undefined, 'bold');
        doc.setFontSize(11);
        doc.text('Who worked on this task', 14, yStart);

        const ub = row.user_breakdown || [];
        const totalSec = ub.reduce((s, u) => s + (u.seconds || 0), 0) || (row.time_worked_seconds || 1);
        const body = ub.map((u, i) => [
            i + 1,
            u.user_name,
            u.display,
            ((u.seconds * 100) / totalSec).toFixed(1) + '%',
        ]);
        if (body.length === 0) {
            body.push(['—', row.employee_name || 'Unassigned', row.time_worked_display, '100.0%']);
        }

        doc.autoTable({
            head: [['#', 'User', 'Time Logged', 'Share of task']],
            body,
            startY: yStart + 2,
            styles: { fontSize: 9.5, cellPadding: 2.5 },
            headStyles: { fillColor: [33, 136, 56], textColor: 255, fontStyle: 'bold' },
            columnStyles: {
                0: { cellWidth: 12, halign: 'center', overflow: 'visible' },
                2: { cellWidth: 38, halign: 'right' },
                3: { cellWidth: 38, halign: 'right' },
            },
        });

        return doc.output('blob');
    }

    toggleZipMenu() {
        this.state.zipMenuOpen = !this.state.zipMenuOpen;
    }

    /**
     * @param {{pdf?: boolean, excel?: boolean}} include - whole-report files to
     *   add at the top level. The project + per-task PDFs are always included:
     *   they are the reason the ZIP exists.
     */
    async downloadZip(include = {}) {
        this.state.zipMenuOpen = false;
        try {
            if (!window.JSZip) {
                alert('JSZip not loaded yet. Refresh the page and try again.');
                return;
            }
            if (!window.jspdf || !window.jspdf.jsPDF) {
                alert('jsPDF not loaded yet. Refresh the page and try again.');
                return;
            }

            const rows = this.getFilteredData();
            if (!rows.length) {
                alert('No tasks to export.');
                return;
            }

            // Group rows by project (sub-KRA / kra_path) so each project becomes
            // its own summary PDF + folder of per-task PDFs.
            const groups = new Map();
            for (const r of rows) {
                const key = r.sub_kra && r.sub_kra !== '-' ? r.sub_kra : (r.root_kra || r.kra_path || 'Project');
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(r);
            }

            const zip = new window.JSZip();

            const fromLabel = this.state.filters.from_date || 'all';
            const toLabel = this.state.filters.to_date || 'all';

            // The menu picks the FLAVOUR of the archive, not just extras. Asking
            // for Excel used to still bury one workbook under 400+ per-task PDFs.
            // Whole-report files come from the same builders the standalone
            // buttons use, so the ZIP copy can never differ from a direct one.
            if (include.pdf) {
                zip.file(`KRA_Report_${fromLabel}_to_${toLabel}_full.pdf`,
                         this._buildFullReportPdf().output('blob'));

                for (const [projectName, projectRows] of groups.entries()) {
                    const safeProject = this._safeFilename(projectName);
                    // 1 summary PDF per project
                    zip.file(`${safeProject}.pdf`,
                             this._buildProjectSummaryPdf(projectName, projectRows));

                    // 1 folder per project, 1 PDF per task inside
                    const folder = zip.folder(safeProject);
                    projectRows.forEach((r, idx) => {
                        const refPart = r.external_ref ? `${r.external_ref} ` : `${String(idx + 1).padStart(3, '0')} `;
                        const fname = this._safeFilename(refPart + (r.kpi_name || 'task')) + '.pdf';
                        folder.file(fname, this._buildTaskDetailPdf(r));
                    });
                }
            }

            if (include.excel) {
                zip.file(`KRA_Report_${fromLabel}_to_${toLabel}_full.xlsx`,
                         await this._buildWorkbook().xlsx.writeBuffer());

                // One workbook per project — the Excel counterpart of the
                // per-project PDFs, written by the same sheet writer.
                for (const [projectName, projectRows] of groups.entries()) {
                    const buffer = await this._buildProjectWorkbook(projectName, projectRows)
                        .xlsx.writeBuffer();
                    zip.file(`${this._safeFilename(projectName)}.xlsx`, buffer);
                }
            }

            const fromDate = this.state.filters.from_date || 'all';
            const toDate = this.state.filters.to_date || 'all';
            const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `KRA_Report_${fromDate}_to_${toDate}.zip`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('Error generating ZIP:', err);
            alert('Error generating ZIP. See browser console for details.');
        }
    }

    /**
     * The full report as a jsPDF doc. Split out from downloadPDF so the ZIP can
     * embed exactly the same document rather than building a second one.
     */
    _buildFullReportPdf() {
        {
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF('l', 'mm', 'a4'); // Landscape for more columns
            
            const fromDate = this.state.filters.from_date;
            const toDate = this.state.filters.to_date;
            const filterKra = this.state.appliedFilters.kra_name || 'All KRAs';
            const filterEmployee = this.state.appliedFilters.employee_name || 'All Employees';
            // The search box narrows the exported rows too, so the file has to
            // say so — otherwise a client gets a partial report that looks whole.
            const search = this.state.searchQuery.trim();
            const filterSearch = search ? ` | Search: "${search}"` : '';
            // A trimmed report must never be mistaken for a complete one.
            const trimmed = this.state.removedRowIds.length
                ? ` | ${this.state.removedRowIds.length} rows removed`
                : '';
            
            // Header
            doc.setFillColor(52, 58, 64);
            doc.rect(0, 0, 297, 25, 'F');
            
            doc.setTextColor(255, 255, 255);
            doc.setFontSize(18);
            doc.setFont(undefined, 'bold');
            doc.text('KRA Report', 14, 15);
            
            doc.setFontSize(10);
            doc.setFont(undefined, 'normal');
            doc.text(`Generated: ${new Date().toLocaleString()}`, 200, 10);
            doc.text(`Period: ${fromDate} to ${toDate}`, 200, 15);
            doc.text(`KRA: ${filterKra} | Employee: ${filterEmployee}${filterSearch}`, 200, 20);
            doc.text(`Type: ${this.state.appliedFilters.task_type_name || 'All Types'}`
                     + ` | State: ${this.state.appliedFilters.task_state_name || 'All States'}`
                     + trimmed, 200, 25);
            
            // Summary Stats
            doc.setTextColor(0, 0, 0);
            doc.setFontSize(11);
            doc.setFont(undefined, 'bold');
            doc.text('Summary', 14, 35);
            
            const summaryY = 40;
            doc.setFontSize(9);
            doc.setFont(undefined, 'normal');
            doc.text(`Total Tasks: ${this.getFilteredData().length}`, 14, summaryY);
            doc.text(`Total Time Worked: ${this.getTotalTimeWorked()}`, 100, summaryY);
            doc.text(`Employees: ${this.getUniqueEmployeeCount()}`, 200, summaryY);
            
            // -------- SECTION A: Project-wise summary --------
            doc.setFontSize(11);
            doc.setFont(undefined, 'bold');
            doc.text('Project-wise Summary', 14, 50);

            const summaryHeaders = [[
                '#', 'KRA Hierarchy Path', 'Tasks', 'Employees', 'Total Time'
            ]];
            const projectSummary = this.getProjectSummary();
            const summaryRows = projectSummary.map((g, i) => [
                i + 1,
                this.formatKraPathForPdf(g.kra_path),
                g.task_count,
                g.employees || `${g.employee_count}`,
                g.total_display,
            ]);
            summaryRows.push([
                '-',
                'GRAND TOTAL',
                projectSummary.reduce((s, g) => s + g.task_count, 0),
                this.getUniqueEmployeeCount(),
                this.getTotalTimeWorked(),
            ]);

            doc.autoTable({
                head: summaryHeaders,
                body: summaryRows,
                startY: 53,
                styles: { fontSize: 9, cellPadding: 3, overflow: 'linebreak' },
                headStyles: { fillColor: [33, 136, 56], textColor: 255, fontStyle: 'bold' },
                alternateRowStyles: { fillColor: [240, 248, 240] },
                columnStyles: {
                    0: { cellWidth: 12, halign: 'center', overflow: 'visible' },
                    2: { cellWidth: 18, halign: 'right' },
                    4: { cellWidth: 30, halign: 'right' },
                },
                didParseCell: (cellData) => {
                    if (cellData.row.index === summaryRows.length - 1) {
                        cellData.cell.styles.fillColor = [236, 240, 241];
                        cellData.cell.styles.fontStyle = 'bold';
                    }
                },
            });

            const detailStartY = (doc.lastAutoTable && doc.lastAutoTable.finalY ? doc.lastAutoTable.finalY : 53) + 10;
            doc.setFontSize(11);
            doc.setFont(undefined, 'bold');
            doc.text('Task-wise Details', 14, detailStartY - 2);

            // -------- SECTION B: Task-level detail (existing flat list) --------
            const headers = [[
                '#',
                'KRA Hierarchy Path',
                'Sub KRA',
                'Task Name',
                'Employee',
                'Type',
                'State',
                'Time Worked'
            ]];

            // Table data (use > instead of → for PDF)
            const data = this.getFilteredData().map((row, index) => [
                index + 1,
                this.formatKraPathForPdf(row.kra_path),
                row.sub_kra,
                row.kpi_name,
                row.employee_name,
                row.task_type || '-',
                row.task_state_label || '-',
                row.time_worked_display
            ]);

            // Add totals row
            data.push([
                '-',
                'TOTAL',
                '-',
                `${this.getFilteredData().length} Tasks`,
                `${this.getUniqueEmployeeCount()} Employees`,
                '-',
                '-',
                this.getTotalTimeWorked()
            ]);

            // Generate table
            doc.autoTable({
                head: headers,
                body: data,
                startY: detailStartY,
                styles: {
                    fontSize: 9,
                    cellPadding: 3,
                    overflow: 'linebreak',
                },
                headStyles: {
                    fillColor: [52, 58, 64],
                    textColor: 255,
                    fontStyle: 'bold',
                },
                alternateRowStyles: {
                    fillColor: [245, 245, 245]
                },
                columnStyles: {
                    0: { cellWidth: 12, halign: 'center', overflow: 'visible' },  // # — never wrap a serial
                    5: { cellWidth: 16, halign: 'center' },  // Type
                    7: { cellWidth: 24, halign: 'right' },   // Time
                    // Path / Sub KRA / Task Name / Employee / State stay auto.
                },
                didParseCell: (cellData) => {
                    const isTotals = cellData.row.index === data.length - 1;
                    // Bold the totals row
                    if (isTotals) {
                        cellData.cell.styles.fillColor = [236, 240, 241];
                        cellData.cell.styles.fontStyle = 'bold';
                        return;
                    }
                    // Type column, coloured to match the web badges. Body rows
                    // only — the header keeps the table's own dark fill.
                    if (cellData.section === 'body' && cellData.column.index === 5) {
                        const raw = cellData.cell.raw;
                        if (raw && raw !== '-') {
                            const style = typeStyle(raw);
                            cellData.cell.styles.fillColor = style.rgb;
                            cellData.cell.styles.textColor = style.text;
                            cellData.cell.styles.fontStyle = 'bold';
                        }
                    }
                }
            });
            
            // Footer
            const pageCount = doc.internal.getNumberOfPages();
            for (let i = 1; i <= pageCount; i++) {
                doc.setPage(i);
                doc.setTextColor(150, 150, 150);
                doc.setFontSize(8);
                doc.text('Generated by KRA/KPI Management System', 14, 200);
                doc.text(`Page ${i} of ${pageCount}`, 260, 200);
            }
            
            return doc;
        }
    }

    async downloadPDF() {
        try {
            const doc = this._buildFullReportPdf();
            const fromDate = this.state.filters.from_date;
            const toDate = this.state.filters.to_date;
            doc.save(`KRA_Report_${fromDate}_to_${toDate}.pdf`);
        } catch (error) {
            console.error('Error generating PDF:', error);
            alert('Error generating PDF. Please try again.');
        }
    }

    /**
     * The full report as an ExcelJS workbook. Split out from downloadExcel so
     * the ZIP can embed the identical spreadsheet.
     *
     * TWO sheets, not one stacked sheet: the summary table has 7 columns and the
     * detail table has 9, and a worksheet carries a single set of column widths —
     * so one sheet could never fit both. It also keeps each freeze small. An
     * earlier single-sheet version froze at the detail header (~row 32), which
     * made the frozen block taller than the window and left nothing to scroll.
     */
    _buildWorkbook() {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'KRA / KPI Management System';
        workbook.created = new Date();

        const rows = this.getFilteredData();
        const totalHours = +(rows.reduce((s, r) => s + (r.time_worked_seconds || 0), 0) / 3600).toFixed(2);

        // What this export actually covers. Kept on both tabs so neither can be
        // forwarded on its own and read as the complete picture.
        const search = this.state.searchQuery.trim();
        const removed = this.state.removedRowIds.length;
        const scope = `Period ${this.state.filters.from_date} to ${this.state.filters.to_date}`
            + ` | KRA: ${this.state.appliedFilters.kra_name || 'All KRAs'}`
            + ` | Employee: ${this.state.appliedFilters.employee_name || 'All Employees'}`
            + ` | Type: ${this.state.appliedFilters.task_type_name || 'All Types'}`
            + ` | State: ${this.state.appliedFilters.task_state_name || 'All States'}`
            + (search ? ` | Search: "${search}"` : '')
            + (removed ? ` | ${removed} rows removed` : '');

        // ================= Sheet 1: Summary =================
        const s1 = workbook.addWorksheet('Summary');
        s1.columns = [{ width: 6 }, { width: 52 }, { width: 10 }, { width: 12 },
                      { width: 46 }, { width: 14 }, { width: 16 }];

        s1.addRow(['KRA Report']).font = { bold: true, size: 14 };
        s1.addRow([`Period: ${this.state.filters.from_date} to ${this.state.filters.to_date}`]);
        s1.addRow([`KRA: ${this.state.appliedFilters.kra_name || 'All KRAs'}`]);
        s1.addRow([`Employee: ${this.state.appliedFilters.employee_name || 'All Employees'}`]);
        s1.addRow([`Type: ${this.state.appliedFilters.task_type_name || 'All Types'}`
            + ` | State: ${this.state.appliedFilters.task_state_name || 'All States'}`]);
        // The same headline figures the PDF prints above its project table, from
        // the same three helpers the on-screen cards use — so the spreadsheet,
        // the PDF and the screen can never quote different totals.
        s1.addRow([`Total Tasks: ${rows.length}`
            + ` | Total Time Worked: ${this.getTotalTimeWorked()}`
            + ` | Employees: ${this.getUniqueEmployeeCount()}`]).font = { bold: true };
        if (search) {
            s1.addRow([`Search: "${search}"`]);
        }
        if (removed) {
            s1.addRow([`${removed} rows removed from this report`]).font = { bold: true };
        }
        // The task rows live on the other tab, and that tab has been missed
        // more than once — say so, with the count, so this sheet can never be
        // taken for the whole report.
        const pointer = s1.addRow([`→ Task-wise details (${rows.length} rows) are on the "Task Details" tab`]);
        pointer.font = { bold: true, color: { argb: HEAD_FILL } };
        s1.addRow([]);

        const s1Header = paintHeader(s1.addRow(['#', 'KRA Hierarchy Path', 'Tasks',
            'Employees', 'Employee Names', 'Total Hours', 'Total Time']), HEAD_FILL_SUMMARY);

        const projectSummary = this.getProjectSummary();
        projectSummary.forEach((g, i) => {
            const row = s1.addRow([i + 1, g.kra_path, g.task_count, g.employee_count,
                                   g.employees, g.total_hours, g.total_display]);
            paintBand(row, i, BAND_FILL_SUMMARY);
            row.getCell(6).numFmt = '0.00';
        });
        const s1Total = paintTotal(s1.addRow(['', 'GRAND TOTAL',
            projectSummary.reduce((s, g) => s + g.task_count, 0),
            this.getUniqueEmployeeCount(), '', totalHours, this.getTotalTimeWorked()]));
        s1Total.getCell(6).numFmt = '0.00';

        // Small enough to always leave a scrollable region below it.
        s1.views = [{ state: 'frozen', ySplit: s1Header.number }];

        // ================= Sheet 2: Task Details =================
        this._writeTaskDetailsSheet(workbook.addWorksheet('Task Details'), rows, scope);

        return workbook;
    }

    /**
     * Writes the task-wise detail table onto `sheet`. Shared by the main
     * workbook and the per-project workbooks in the ZIP, so their colours,
     * widths, freeze and filter cannot drift apart.
     */
    _writeTaskDetailsSheet(sheet, rows, scopeLine) {
        sheet.columns = [{ width: 6 }, { width: 46 }, { width: 24 }, { width: 44 },
                         { width: 20 }, { width: 10 }, { width: 26 }, { width: 14 }, { width: 14 }];

        sheet.addRow([scopeLine]).font = { italic: true, color: { argb: 'FF6C757D' } };
        const header = paintHeader(sheet.addRow(['#', 'KRA Hierarchy Path', 'Sub KRA', 'Task Name',
            'Employee', 'Type', 'State', 'Total Hours', 'Time Worked']));
        const TYPE_COL = 6;

        const employees = new Set();
        let seconds = 0;
        rows.forEach((row, index) => {
            const added = sheet.addRow([
                index + 1, row.kra_path, row.sub_kra, row.kpi_name, row.employee_name,
                row.task_type || '-', row.task_state_label || '-',
                row.time_worked_hours, row.time_worked_display,
            ]);
            paintBand(added, index, BAND_FILL);
            added.getCell(8).numFmt = '0.00';
            // Type badge, same palette as the web table and the PDF. Set after
            // the band so the badge colour wins on striped rows.
            if (row.task_type) {
                const style = typeStyle(row.task_type);
                const cell = added.getCell(TYPE_COL);
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: style.argb } };
                cell.font = { bold: true, color: { argb: style.fg } };
                cell.alignment = { horizontal: 'center' };
            }
            if (row.employee_id) employees.add(row.employee_id);
            seconds += (row.time_worked_seconds || 0);
        });

        const hours = +(seconds / 3600).toFixed(2);
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const total = paintTotal(sheet.addRow(['', 'TOTAL', '', `${rows.length} Tasks`,
            `${employees.size} Employees`, '', '', hours, `${h}h ${m}m`]));
        total.getCell(8).numFmt = '0.00';

        // Header only: two frozen rows can never swallow the viewport.
        sheet.views = [{ state: 'frozen', ySplit: header.number }];
        sheet.autoFilter = {
            from: { row: header.number, column: 1 },
            to: { row: header.number, column: 9 },
        };
        return sheet;
    }

    /** Excel sheet names: no []:*?/\ and 31 characters maximum. */
    _safeSheetName(name) {
        const cleaned = String(name || '').replace(/[[\]:*?/\\]/g, '-').trim().slice(0, 31);
        return cleaned || 'Tasks';
    }

    /** One project's tasks as a standalone workbook, for the Excel ZIP. */
    _buildProjectWorkbook(projectName, projectRows) {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'KRA / KPI Management System';
        workbook.created = new Date();
        const sheet = workbook.addWorksheet(this._safeSheetName(projectName));
        this._writeTaskDetailsSheet(sheet, projectRows,
            `${projectName} — ${this.state.filters.from_date} to ${this.state.filters.to_date}`);
        return workbook;
    }

    async downloadExcel() {
        try {
            const workbook = this._buildWorkbook();
            const buffer = await workbook.xlsx.writeBuffer();
            const blob = new Blob([buffer], {
                type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            });
            const link = document.createElement('a');
            const url = URL.createObjectURL(blob);

            const fromDate = this.state.filters.from_date;
            const toDate = this.state.filters.to_date;

            link.setAttribute('href', url);
            link.setAttribute('download', `KRA_Report_${fromDate}_to_${toDate}.xlsx`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);

        } catch (error) {
            console.error('Error generating Excel:', error);
            alert('Error generating Excel. Please try again.');
        }
    }
}

registry.category("actions").add("kpi_kra_report", KpiKraReport);
