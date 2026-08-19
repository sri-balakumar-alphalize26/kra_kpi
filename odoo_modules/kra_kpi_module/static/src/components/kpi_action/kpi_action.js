/** @odoo-module **/

import { Component, xml, useState, onWillStart, onMounted, onWillUnmount, useRef } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";
import { session } from "@web/session";
import { uploadWithProgress } from "@kra_kpi_module/utils/upload_with_progress";

// Mirrors NOTE_MAX in models/kpi_nontask_block.py and IDLE_NOTE_MAX in the app's
// services/kpiActions.js. A pause note is one line on the Workday Map, not a
// paragraph. The route clamps it too — this is the courtesy, that is the rule.
const PAUSE_NOTE_MAX = 60;

// The only pause reasons that need words typed. Every other code IS its own
// explanation — asking for one taught people to type "break" into a box beside a
// button already labelled Break. Urgent keeps it because that text becomes the
// body of the 🚨 alert; Meeting because "Meeting" alone says nothing about what
// it cost the day. Mirrors noteRequiredFor in the app's KpiActionBoard, and is
// shared by BOTH pause dialogs here so single-pause and pause-all cannot drift.
const PAUSE_NOTE_CODES = ['other', 'urgent', 'meeting'];

// Work already started and stopped. Mirrors the app's PAUSED_STATES and the
// canResume triple, so "shows Resume" and "counts as paused" stay one idea.
const PAUSED_STATES = ['paused', 'hold', 'rework'];

// ONE colour per away/non-task type, used by BOTH the Workday Map chips and the
// Away-time list. They used to be defined twice and disagreed — the Map drew
// "away" slate while the list drew it Bootstrap bg-dark (black).
// 'no_tasks' is deliberately teal, not red: having nothing assigned is not the
// developer's fault and must not be coloured like a warning.
const AWAY_COLORS = {
    break:    '#f59e0b',
    lunch:    '#10b981',
    meeting:  '#3b82f6',
    away:     '#6b7280',
    leave:    '#8b5cf6',
    urgent:   '#ef4444',
    no_tasks: '#0891b2',
    other:    '#f59e0b',
};
const awayColor = (t) => AWAY_COLORS[t] || '#f59e0b';

// Why nothing is running. Mirrors IDLE_REASONS in the app's services/kpiActions.js.
// All three are recorded on the Workday Map; only "no tasks" reaches the admins,
// because only that one is theirs to fix.
// Mirrors NONTASK_REASONS in models/kpi_nontask_block.py — keep them in step.
// Lunch is its own reason, not a Break: it has its own Away bucket, colour and Map
// label, so folding it into Break left the Lunch box reading 0m for anyone who ate
// without a task running.
const IDLE_REASONS = [
    { code: 'meeting',  emoji: '👥', text: 'In a meeting',    label: '👥 In a meeting',
      note: 'Recorded on your Workday Map. Admins are not notified.', alert: false },
    { code: 'break',    emoji: '☕', text: 'On a break',      label: '☕ On a break',
      note: 'Recorded on your Workday Map. Admins are not notified.', alert: false },
    { code: 'lunch',    emoji: '🍽', text: 'Lunch',           label: '🍽 Lunch',
      note: 'Recorded on your Workday Map. Admins are not notified.', alert: false },
    { code: 'no_tasks', emoji: '📭', text: 'I have no tasks', label: '📭 I have no tasks',
      note: 'Recorded on your Workday Map, and your admins are told right away so they can assign you work.',
      alert: true },
];
// "Not now" buys this long before the popup asks again — enough to find and click
// a task's Start button, too short to duck the question all day.
const IDLE_SNOOZE_MS = 60000;

export class KpiAction extends Component {

    static template = xml/* xml */`
        <div class="o_kpi_action_wrapper">
        <!-- Activity, in its own centred popup. It was inline and capped at 50, which
             pushed the rest of the detail pane off screen on a task with real history.
             Grouped by day with a caret per day, the same idiom as the customer_support
             gallery, so a long list is navigable instead of a wall. -->
        <div t-if="state.activityOpen" class="modal d-block" tabindex="-1"
             style="background: rgba(0,0,0,0.5); z-index:2100;">
            <div class="modal-dialog modal-lg modal-dialog-centered">
                <div class="modal-content">
                    <div class="modal-header bg-secondary text-white">
                        <h5 class="modal-title">
                            <i class="fa fa-history me-2"/>Activity
                        </h5>
                        <button type="button" class="btn-close btn-close-white"
                                t-on-click="() => state.activityOpen = false"/>
                    </div>
                    <div class="modal-body" style="max-height:60vh; overflow-y:auto;">
                        <!-- Says plainly when this is a slice, so the list is never
                             mistaken for the task's whole history. -->
                        <div t-if="state.detailData.activity_total > (state.detailData.activity_log || []).length"
                             class="small text-muted fst-italic mb-2">
                            <t t-esc="state.detailData.activity_total"/> entries —
                            showing the most recent <t t-esc="state.detailData.activity_log.length"/>.
                        </div>
                        <t t-foreach="activityGroups()" t-as="g" t-key="g.date">
                            <div class="d-flex align-items-center border-bottom py-2"
                                 style="cursor:pointer;"
                                 t-on-click="() => this.toggleActivityDate(g.date)">
                                <i t-att-class="'fa me-2 ' + (isActivityDateOpen(g.date) ? 'fa-caret-down' : 'fa-caret-right')"/>
                                <span class="fw-bold" t-esc="g.label"/>
                                <span class="badge bg-light text-dark ms-auto" t-esc="g.entries.length"/>
                            </div>
                            <div t-if="isActivityDateOpen(g.date)" class="ps-4 pb-2">
                                <div t-foreach="g.entries" t-as="ev" t-key="ev.id"
                                     class="d-flex gap-2 small border-bottom py-1">
                                    <div class="text-muted" style="min-width:52px;" t-esc="ev.time"/>
                                    <div class="fw-bold" style="min-width:150px;" t-esc="ev.label"/>
                                    <div class="text-muted flex-grow-1" style="word-break:break-word;"
                                         t-esc="activityDetail(ev)"/>
                                    <div class="text-muted text-nowrap" t-esc="ev.actor"/>
                                </div>
                            </div>
                        </t>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary"
                                t-on-click="() => state.activityOpen = false">Close</button>
                    </div>
                </div>
            </div>
        </div>

        <div t-if="state.dlg.open" class="modal d-block" tabindex="-1" style="background: rgba(0,0,0,0.5); z-index:2000;">
            <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content">
                    <div t-att-class="'modal-header ' + (state.dlg.okClass === 'btn-danger' ? 'bg-danger text-white' : 'bg-primary text-white')">
                        <h5 class="modal-title" t-esc="state.dlg.title"/>
                        <button type="button" class="btn-close btn-close-white" t-on-click="dlgCancel"/>
                    </div>
                    <div class="modal-body">
                        <p t-if="state.dlg.message" style="white-space:pre-wrap;" t-esc="state.dlg.message"/>
                        <div t-if="state.dlg.nums.length" class="d-flex gap-2 mb-2">
                            <div t-foreach="state.dlg.nums" t-as="n" t-key="n.key">
                                <label class="form-label fw-bold small mb-0" t-esc="n.label"/>
                                <input type="number" class="form-control" min="0"
                                       t-att-value="state.dlg.numVals[n.key]"
                                       t-on-input="(ev) => this.dlgNum(n.key, ev.target.value)"/>
                            </div>
                        </div>
                        <!-- Recomputed on every keystroke, so the arithmetic that used to
                             have to be done in your head is on screen before you commit. -->
                        <div t-if="state.dlg.ctx" t-att-class="'small mb-2 fw-bold ' + dlgLiveNote().cls">
                            <t t-esc="dlgLiveNote().text"/>
                        </div>
                        <div t-if="state.dlg.footNote" class="small text-muted mb-2"
                             t-esc="state.dlg.footNote"/>
                        <div t-if="state.dlg.input" class="mb-2">
                            <label class="form-label fw-bold">
                                <t t-esc="state.dlg.inputLabel"/>
                                <span t-if="state.dlg.required" class="text-danger">*</span>
                            </label>
                            <textarea class="form-control" rows="3"
                                      t-att-placeholder="state.dlg.placeholder"
                                      t-att-value="state.dlg.value"
                                      t-on-input="(ev) => this.dlgSet(ev.target.value)"/>
                        </div>
                        <div t-if="state.dlg.error" class="alert alert-danger py-2 mb-0 small" t-esc="state.dlg.error"/>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" t-on-click="dlgCancel">Cancel</button>
                        <button type="button" t-att-class="'btn ' + state.dlg.okClass"
                                t-on-click="dlgOk" t-esc="state.dlg.okLabel"/>
                    </div>
                </div>
            </div>
        </div>

        <div t-if="state.toast.show"
             t-att-class="'alert alert-dismissible d-flex align-items-start gap-2 alert-' + state.toast.kind"
             style="position:sticky; top:0; z-index:1080; white-space:pre-wrap;">
            <i t-att-class="'fa mt-1 ' + (state.toast.kind === 'success' ? 'fa-check-circle' : (state.toast.kind === 'danger' ? 'fa-exclamation-circle' : 'fa-info-circle'))"/>
            <div class="flex-grow-1" t-esc="state.toast.text"/>
            <button type="button" class="btn-close" t-on-click="dismissToast"/>
        </div>

            
            <!-- Show Detail View if detailKpiId is set -->
            <t t-if="state.view === 'detail' and state.detailKpiId">
                <div class="o_kpi_detail_wrapper p-4" style="max-height: 85vh; overflow-y: auto;">
                    
                    <t t-if="state.detailLoaded and state.detailData.name">
                        <div class="d-flex justify-content-between align-items-center mb-3">
                            <button class="btn btn-secondary" t-on-click="backToList">
                                ← Back to KPI Actions
                            </button>
                            <div t-if="state.detailData.is_manager">
                                <t t-if="!state.metaEdit.editing">
                                    <button class="btn btn-outline-primary btn-sm" t-on-click="beginMetaEdit">
                                        <i class="fa fa-pencil me-1"/> Edit Type / Project / Name
                                    </button>
                                </t>
                                <t t-else="">
                                    <button class="btn btn-success btn-sm me-2" t-on-click="saveMetaEdit"
                                            t-att-disabled="state.metaEdit.saving">
                                        <i class="fa fa-save me-1"/>
                                        <t t-if="state.metaEdit.saving">Saving...</t>
                                        <t t-else="">Save changes</t>
                                    </button>
                                    <button class="btn btn-outline-secondary btn-sm" t-on-click="cancelMetaEdit">
                                        Cancel
                                    </button>
                                </t>
                            </div>
                        </div>

                        <h3 class="fw-bold mb-3">KPI Details</h3>

                        <div class="card p-4 mb-3">
                            <div class="row">
                                <!-- Left Column -->
                                <div class="col-md-6">
                                    <table class="table table-borderless">
                                        <tbody>

                                        <tr>
                                            <td style="width:40%;"><b>Name</b></td>
                                            <td>
                                                <input t-if="state.metaEdit.editing"
                                                       type="text" class="form-control form-control-sm"
                                                       t-model="state.metaEdit.name"/>
                                                <span t-else="" t-esc="state.detailData.name"/>
                                            </td>
                                        </tr>
                                        <tr t-if="state.detailData.is_manager">
                                            <td><b>Type</b></td>
                                            <td>
                                                <select t-if="state.metaEdit.editing"
                                                        class="form-select form-select-sm"
                                                        t-model="state.metaEdit.type">
                                                    <option value="requirement">Requirement</option>
                                                    <option value="update">Update / Amendment</option>
                                                    <option value="bug">Bug</option>
                                                </select>
                                                <span t-else="" class="badge"
                                                      t-att-class="state.detailData.type === 'bug' ? 'bg-danger' : (state.detailData.type === 'update' ? 'bg-warning text-dark' : 'bg-primary')"
                                                      t-esc="state.detailData.type"/>
                                            </td>
                                        </tr>
                                        <tr>
                                            <td><b>KRA</b></td>
                                            <td>
                                                <select t-if="state.metaEdit.editing"
                                                        class="form-select form-select-sm"
                                                        t-model="state.metaEdit.kra_id">
                                                    <t t-foreach="state.detailData.available_kras or []" t-as="k" t-key="k.id">
                                                        <option t-att-value="k.id" t-esc="k.display"/>
                                                    </t>
                                                </select>
                                                <span t-else="" t-esc="state.detailData.kra"/>
                                            </td>
                                        </tr>
                                            <tr><td><b>Priority</b></td><td>
                                                <span t-att-class="'badge ' + priorityBadgeClass(state.detailData.priority)" t-esc="priorityLabel(state.detailData.priority)"/>
                                            </td></tr>
                                            <tr>
                                                <td><b>Estimate</b></td>
                                                <td>
                                                    <t t-esc="state.detailData.estimate"/>
                                                    <!-- The chain, not just the total. A bare "02:00"
                                                         is indistinguishable from an estimate that was
                                                         always 02:00, which is what caused the
                                                         "where did my 62h go" confusion. -->
                                                    <div t-if="(state.detailData.estimate_history || []).length"
                                                         class="mt-1 ps-2 border-start">
                                                        <div t-foreach="state.detailData.estimate_history" t-as="h" t-key="h.seq"
                                                             class="small">
                                                            <t t-if="h.kind === 'original'">
                                                                <span class="text-muted">
                                                                    <t t-esc="h.value"/> — original
                                                                </span>
                                                            </t>
                                                            <t t-else="">
                                                                <span class="text-info fw-bold" t-esc="h.value"/>
                                                                <span t-if="h.running_total" class="text-muted">
                                                                    → <t t-esc="h.running_total"/>
                                                                </span>
                                                                <span t-if="h.reason" class="fst-italic">
                                                                    · "<t t-esc="h.reason"/>"
                                                                </span>
                                                                <span class="text-muted">
                                                                    — <t t-esc="h.actor"/><t t-if="h.at">, <t t-esc="h.at"/></t>
                                                                </span>
                                                            </t>
                                                        </div>
                                                    </div>
                                                </td>
                                            </tr>
                                            <tr><td><b>Assignee</b></td><td t-esc="state.detailData.assignee"/></tr>
                                            <tr><td><b>Deadline</b></td><td t-esc="state.detailData.deadline or '—'"/></tr>
                                            <!-- Uploaded file only when present -->
                                            <tr t-if="state.detailData.file_url">
                                                <td><b>Uploaded File</b></td>
                                                <td>
                                                    <a class="btn btn-primary btn-sm"
                                                       t-att-href="state.detailData.file_url"
                                                       t-att-download="state.detailData.file_name || 'file'">
                                                        ⬇ Download File
                                                    </a>
                                                </td>
                                            </tr>
                                            <!-- Related links only when present -->
                                            <t t-set="parsedLinks" t-value="parseRelatedLinks(state.detailData.related_links)"/>
                                            <tr t-if="parsedLinks.length > 0">
                                                <td><b>Related Links</b></td>
                                                <td>
                                                    <ul class="list-unstyled mb-0">
                                                        <t t-foreach="parsedLinks" t-as="link" t-key="link_index">
                                                            <li class="mb-1">
                                                                <i class="fa fa-external-link text-primary me-1"/>
                                                                <a t-att-href="link" target="_blank" class="text-truncate" style="max-width: 300px; display: inline-block; vertical-align: bottom;" t-esc="link"/>
                                                            </li>
                                                        </t>
                                                    </ul>
                                                </td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                                
                                <!-- Right Column -->
                                <div class="col-md-6">
                                    <table class="table table-borderless mb-0">
                                        <tbody>
                                            <tr><td style="width:40%;"><b>Description</b></td><td style="white-space:pre-wrap;" t-esc="state.detailData.description || '—'"/></tr>
                                            <tr><td><b>Checklist</b></td><td style="white-space:pre-wrap;" t-esc="state.detailData.checklist || '—'"/></tr>
                                            <tr><td><b>Guidelines</b></td><td style="white-space:pre-wrap;" t-esc="state.detailData.guidelines || '—'"/></tr>
                                        </tbody>
                                    </table>
                                    <!-- Flag chips — one badge per flag, only when TRUE -->
                                    <t t-if="state.detailData.is_mandatory or state.detailData.service_kpi or state.detailData.manager_review or state.detailData.customer_review or state.detailData.auto_assign or state.detailData.auto_estimated or state.detailData.is_permanent or state.detailData.is_meeting">
                                        <div class="d-flex flex-wrap gap-1 mb-2">
                                            <span t-if="state.detailData.is_mandatory" class="badge bg-danger">Mandatory</span>
                                            <span t-if="state.detailData.service_kpi" class="badge bg-info text-dark">Service KPI</span>
                                            <span t-if="state.detailData.manager_review" class="badge bg-primary">Coordinator review</span>
                                            <span t-if="state.detailData.customer_review" class="badge bg-secondary">Customer review</span>
                                            <span t-if="state.detailData.auto_assign" class="badge bg-success">Auto-assign</span>
                                            <span t-if="state.detailData.auto_estimated" class="badge bg-success">Auto-estimated</span>
                                            <span t-if="state.detailData.is_permanent" class="badge bg-dark">Permanent</span>
                                            <span t-if="state.detailData.is_meeting" class="badge bg-warning text-dark">Meeting</span>
                                        </div>
                                    </t>
                                    <!-- Low-signal scalars, collapsed — only when at least one has a value -->
                                    <t t-if="state.detailData.points or state.detailData.user_group or state.detailData.reminder_days or state.detailData.next_kpi or state.detailData.warehouse or state.detailData.file_name or (state.detailData.actions and state.detailData.actions != '-')">
                                        <details class="mt-2">
                                            <summary class="text-muted" style="cursor:pointer;">More details</summary>
                                            <table class="table table-borderless table-sm mb-0 mt-2">
                                                <tbody>
                                                    <tr t-if="state.detailData.points"><td style="width:45%;"><b>Points</b></td><td t-esc="state.detailData.points"/></tr>
                                                    <tr t-if="state.detailData.user_group"><td><b>User Group</b></td><td t-esc="state.detailData.user_group"/></tr>
                                                    <tr t-if="state.detailData.reminder_days"><td><b>Reminder Interval</b></td><td t-esc="formatReminderDisplay(state.detailData)"/></tr>
                                                    <tr t-if="state.detailData.next_kpi"><td><b>Next KPI</b></td><td t-esc="state.detailData.next_kpi"/></tr>
                                                    <tr t-if="state.detailData.warehouse"><td><b>Warehouse</b></td><td t-esc="state.detailData.warehouse"/></tr>
                                                    <tr t-if="state.detailData.file_name"><td><b>File Name</b></td><td t-esc="state.detailData.file_name"/></tr>
                                                    <tr t-if="state.detailData.actions and state.detailData.actions != '-'"><td><b>Actions</b></td><td t-esc="state.detailData.actions"/></tr>
                                                </tbody>
                                            </table>
                                        </details>
                                    </t>
                                </div>
                            </div>
                        </div>

                        <!-- 🆕 NEW: Reassignment History Section -->
                        <t t-if="state.reassignmentHistory.length > 0">
                            <div class="card p-4 mb-3 bg-light">
                                <h4 class="fw-bold mb-3">🔄 Reassignment History</h4>
                                <div class="table-responsive">
                                    <table class="table table-bordered table-sm">
                                        <thead class="table-secondary">
                                            <tr>
                                                <th>Date</th>
                                                <th>From</th>
                                                <th>To</th>
                                                <th>By</th>
                                                <th>Previous State</th>
                                                <th>Time Spent</th>
                                                <th>Reason</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <t t-foreach="state.reassignmentHistory" t-as="hist" t-key="hist.id">
                                                <tr>
                                                    <td t-esc="formatDate(hist.reassignment_date)"/>
                                                    <td t-esc="hist.previous_assignee"/>
                                                    <td t-esc="hist.new_assignee"/>
                                                    <td t-esc="hist.reassigned_by"/>
                                                    <td>
                                                        <span class="badge bg-info" t-esc="hist.previous_state"/>
                                                    </td>
                                                    <td t-esc="hist.time_spent"/>
                                                    <td>
                                                        <t t-esc="hist.reason"/>
                                                        <t t-if="hist.was_paused">
                                                            <br/><small class="text-danger">Was paused: <t t-esc="hist.pause_reason"/></small>
                                                        </t>
                                                    </td>
                                                </tr>
                                            </t>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </t>
                        

                        <!-- ============================================ -->
                        <!-- 📚 UPDATED: Multiple User Manuals Section -->
                        <!-- ============================================ -->
                        <div class="card p-4 mb-3 bg-light">
                            <h4 class="fw-bold mb-3">📖 User Manual / Documentation</h4>
                            <p class="text-muted">Upload comprehensive guides or documentation for this task</p>
                            
                            <!-- Show existing manuals -->
                            <t t-if="state.manualsList.length > 0">
                                <div class="mb-3">
                                    <h5 class="fw-bold">Uploaded Manuals (<t t-esc="state.manualsList.length"/>)</h5>
                                    <div class="list-group">
                                        <t t-foreach="state.manualsList" t-as="manual" t-key="manual.id">
                                            <div class="list-group-item">
                                                <div class="d-flex justify-content-between align-items-start">
                                                    <div class="flex-grow-1">
                                                        <div class="d-flex align-items-center mb-2">
                                                            <i class="fa fa-file-pdf text-danger me-2" style="font-size: 1.5rem;"></i>
                                                            <div>
                                                                <strong t-esc="manual.file_name"/>
                                                                <div class="small text-muted">
                                                                    Uploaded by: <t t-esc="manual.uploaded_by"/> | 
                                                                    Date: <t t-esc="formatDate(manual.upload_date)"/>
                                                                </div>
                                                            </div>
                                                        </div>
                                                        
                                                        <!-- Description -->
                                                        <t t-if="manual.description">
                                                            <p class="mb-2 text-muted">
                                                                <i class="fa fa-info-circle"></i> <t t-esc="manual.description"/>
                                                            </p>
                                                        </t>
                                                        
                                                        <!-- Related Links -->
                                                        <t t-if="manual.links and manual.links.length > 0">
                                                            <div class="mb-2">
                                                                <strong class="text-primary">🔗 Related Links:</strong>
                                                                <ul class="list-unstyled ms-3 mt-1">
                                                                    <t t-foreach="manual.links" t-as="link" t-key="link">
                                                                        <li>
                                                                            <a t-att-href="link" target="_blank" class="text-decoration-none">
                                                                                <i class="fa fa-external-link"></i> <t t-esc="link"/>
                                                                            </a>
                                                                        </li>
                                                                    </t>
                                                                </ul>
                                                            </div>
                                                        </t>
                                                    </div>
                                                    
                                                    <!-- Action Buttons -->
                                                    <div class="d-flex gap-2">
                                                        <a class="btn btn-info btn-sm"
                                                        t-att-href="'/kpi/manual/view/' + manual.id"
                                                        target="_blank">
                                                            <i class="fa fa-eye"></i> View
                                                        </a>
                                                        <a class="btn btn-success btn-sm"
                                                        t-att-href="'/kpi/manual/download/' + manual.id"
                                                        target="_blank">
                                                            <i class="fa fa-download"></i> Download
                                                        </a>
                                                        <button class="btn btn-danger btn-sm"
                                                                t-on-click="() => this.deleteManual(manual.id)">
                                                            <i class="fa fa-trash"></i>
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        </t>
                                    </div>
                                </div>
                                <hr/>
                            </t>
                            
                            <!-- Upload New Manual Form -->
                            <div>
                                <button class="btn btn-primary mb-3" 
                                        t-on-click="() => this.state.showManualUpload = !this.state.showManualUpload">
                                    <i class="fa fa-plus"></i> Add New Manual
                                </button>
                                
                                <t t-if="state.showManualUpload">
                                    <div class="border rounded p-3 bg-white">
                                        <div class="mb-3">
                                            <label class="form-label fw-bold">Upload Manual File *</label>
                                            <input type="file" 
                                                class="form-control" 
                                                t-on-change="handleManualUpload"
                                                accept=".pdf,.doc,.docx"/>
                                            <small class="text-muted">Supported: PDF, DOC, DOCX</small>
                                        </div>
                                        
                                        <t t-if="state.manualForm.error">
                                            <div class="alert alert-danger py-2">
                                                <i class="fa fa-exclamation-triangle me-1"></i><t t-esc="state.manualForm.error"/>
                                            </div>
                                        </t>
                                        <t t-if="state.manualForm.file_name">
                                            <div class="alert alert-info">
                                                <i class="fa fa-file"></i> Selected: <t t-esc="state.manualForm.file_name"/>
                                                <span t-if="state.manualForm.size_display" class="text-muted ms-1">
                                                    (<t t-esc="state.manualForm.size_display"/>)
                                                </span>
                                            </div>
                                        </t>
                                        <!-- Real transfer progress: percent, bytes moved, live speed and
                                             a time remaining. A bar alone cannot distinguish "slow" from
                                             "stalled", which is the actual question on a 20 MB upload. -->
                                        <t t-if="state.manualForm.uploading">
                                            <div class="progress mb-1" style="height:20px;">
                                                <div class="progress-bar progress-bar-striped progress-bar-animated"
                                                     t-att-style="'width:' + state.manualForm.percent + '%'">
                                                    <t t-esc="state.manualForm.percent"/>%
                                                </div>
                                            </div>
                                            <div class="d-flex justify-content-between align-items-center small text-muted mb-3">
                                                <span>
                                                    <t t-esc="state.manualForm.sent_display"/>
                                                    <t t-if="state.manualForm.speed_display">
                                                        · <t t-esc="state.manualForm.speed_display"/>
                                                    </t>
                                                    <t t-if="state.manualForm.eta_display">
                                                        · <t t-esc="state.manualForm.eta_display"/> left
                                                    </t>
                                                </span>
                                                <button class="btn btn-sm btn-link text-danger p-0"
                                                        t-on-click="cancelManualUpload">Cancel</button>
                                            </div>
                                        </t>

                                        <div class="mb-3">
                                            <label class="form-label fw-bold">Description (optional)</label>
                                            <textarea class="form-control" 
                                                    rows="2"
                                                    t-model="state.manualForm.description"
                                                    placeholder="Brief description of this manual"></textarea>
                                        </div>
                                        
                                        <div class="mb-3">
                                            <label class="form-label fw-bold">🔗 Related Links (optional)</label>
                                            <div class="input-group mb-2">
                                                <input type="url" 
                                                    class="form-control" 
                                                    t-model="state.manualForm.link_input"
                                                    placeholder="https://docs.google.com/..."/>
                                                <button class="btn btn-outline-primary" 
                                                        type="button"
                                                        t-on-click="addManualLink">
                                                    <i class="fa fa-plus"></i> Add Link
                                                </button>
                                            </div>
                                            
                                            <t t-if="state.manualForm.related_links.length > 0">
                                                <ul class="list-group mt-2">
                                                    <t t-foreach="state.manualForm.related_links" t-as="link" t-key="link_index">
                                                        <li class="list-group-item d-flex justify-content-between align-items-center">
                                                            <a t-att-href="link" target="_blank" class="text-truncate">
                                                                <i class="fa fa-link"></i> <t t-esc="link"/>
                                                            </a>
                                                            <button class="btn btn-sm btn-danger" 
                                                                    t-on-click="() => this.removeManualLink(link_index)">
                                                                <i class="fa fa-times"></i>
                                                            </button>
                                                        </li>
                                                    </t>
                                                </ul>
                                            </t>
                                        </div>
                                        
                                        <div class="d-flex gap-2">
                                            <!-- Gated on the File itself, which is set the instant the
                                                 picker closes. It used to gate on file_data, which only
                                                 appeared once an async FileReader finished, so on a
                                                 large file the button sat disabled with nothing on
                                                 screen to say why. -->
                                            <button class="btn btn-primary"
                                                    t-on-click="submitUserManual"
                                                    t-att-disabled="!state.manualForm.file or state.manualForm.uploading">
                                                <t t-if="state.manualForm.uploading">
                                                    <i class="fa fa-spinner fa-spin"></i> Uploading…
                                                </t>
                                                <t t-else="">
                                                    <i class="fa fa-upload"></i> Upload Manual
                                                </t>
                                            </button>
                                            <button class="btn btn-secondary"
                                                    t-att-disabled="state.manualForm.uploading"
                                                    t-on-click="() => this.state.showManualUpload = false">
                                                Cancel
                                            </button>
                                        </div>
                                    </div>
                                </t>
                            </div>
                        </div>

                        

                       <!-- Progress Updates Section -->
                        <div class="card p-4 mb-3">
                            <h4 class="fw-bold mb-3">Submit Progress Update</h4>
                            
                            <div class="mb-3">
                                <label class="form-label fw-bold">Progress Summary *</label>
                                <textarea id="progressSummary" class="form-control" rows="4"
                                          t-model="state.progressForm.summary"
                                          placeholder="Describe the work done, issues faced, next steps..."></textarea>
                            </div>

                            <!-- 🆕 NEW: Related Links Section -->
                            <div class="mb-3">
                                <label class="form-label fw-bold">🔗 Related Links (optional)</label>
                                <div class="input-group mb-2">
                                    <input type="url" 
                                           class="form-control" 
                                           t-model="state.progressForm.link_input"
                                           placeholder="https://github.com/repo or https://drive.google.com/..."/>
                                    <button class="btn btn-outline-primary" 
                                            type="button"
                                            t-on-click="addLink">
                                        <i class="fa fa-plus"></i> Add Link
                                    </button>
                                </div>
                                <small class="text-muted">Add GitHub repos, Google Drive, websites, or any related links</small>
                                
                                <!-- Display added links -->
                                <t t-if="state.progressForm.related_links.length > 0">
                                    <div class="mt-2">
                                        <strong>Added Links:</strong>
                                        <ul class="list-group mt-2">
                                            <t t-foreach="state.progressForm.related_links" t-as="link" t-key="link_index">
                                                <li class="list-group-item d-flex justify-content-between align-items-center">
                                                    <a t-att-href="link" target="_blank" class="text-truncate" style="max-width: 80%;">
                                                        <i class="fa fa-link"></i> <t t-esc="link"/>
                                                    </a>
                                                    <button class="btn btn-sm btn-danger" 
                                                            t-on-click="() => this.removeLink(link_index)">
                                                        <i class="fa fa-times"></i>
                                                    </button>
                                                </li>
                                            </t>
                                        </ul>
                                    </div>
                                </t>
                            </div>
                            <div class="mb-3">
                                <label class="form-label fw-bold">Attach File (optional)</label>
                                <input type="file" class="form-control"
                                       t-on-change="handleProgressFileUpload"/>
                                <div class="text-danger small mt-1">⚠ Large files take time — keep this tab open until 100%. Max 50 MB. For bigger files, add a Drive or GitHub link instead.</div>
                                <div t-if="state.uploadState.error" class="text-danger small mt-1 fw-bold" t-esc="state.uploadState.error"/>
                            </div>

                            <!-- Part F: circular %-ring while uploading -->
                            <t t-if="state.uploadState.active">
                                <div class="d-flex align-items-center gap-3 mb-3 p-2 border rounded bg-light">
                                    <svg width="72" height="72" viewBox="0 0 72 72">
                                        <circle cx="36" cy="36" r="30" fill="none" stroke="#e5e7eb" stroke-width="8"/>
                                        <circle cx="36" cy="36" r="30" fill="none" stroke="#2563eb" stroke-width="8"
                                                stroke-linecap="round"
                                                t-att-stroke-dasharray="uploadCircumference()"
                                                t-att-stroke-dashoffset="uploadDashOffset()"
                                                transform="rotate(-90 36 36)"/>
                                        <text x="36" y="41" text-anchor="middle" font-size="15" font-weight="bold" fill="#2563eb">
                                            <t t-esc="state.uploadState.percent"/>%
                                        </text>
                                    </svg>
                                    <div class="flex-grow-1">
                                        <div class="fw-bold">Uploading…</div>
                                        <div class="small text-muted" t-esc="uploadMbText()"/>
                                    </div>
                                    <button class="btn btn-outline-danger btn-sm" t-on-click="cancelUpload">Cancel</button>
                                </div>
                            </t>

                            <button class="btn btn-primary" t-if="!state.uploadState.active" t-on-click="submitProgressUpdate">
                                <i class="fa fa-upload"></i> Submit Update
                            </button>
                        </div>

                        <!-- Part B: GitHub branch — its own card, URL + Branch side by side -->
                        <div class="card p-4 mb-3">
                            <h4 class="fw-bold mb-3"><i class="fa fa-github"></i> Link a GitHub branch
                                <span class="text-muted fw-normal small">(optional)</span></h4>
                            <div class="row g-2">
                                <div class="col-md-6 mb-2">
                                    <label class="form-label fw-bold">Repository URL</label>
                                    <input type="url" class="form-control"
                                           t-model="state.progressForm.github_url"
                                           placeholder="https://github.com/username/repository"/>
                                    <small class="text-muted">Only GitHub repository URLs are accepted</small>
                                </div>
                                <div class="col-md-6 mb-2">
                                    <label class="form-label fw-bold">🌿 Branch</label>
                                    <input type="text" class="form-control"
                                           t-model="state.progressForm.branch_name"
                                           placeholder="main, feature/new-module, ..."/>
                                    <small class="text-muted">Branch name or short description</small>
                                </div>
                            </div>
                            <div class="mt-2">
                                <button class="btn btn-success" type="button" t-on-click="addGithubLink">
                                    <i class="fa fa-github"></i> Add GitHub Link
                                </button>
                            </div>
                        </div>

                        <!-- 🆕 Part B: Complete This Task (enforced summary + checklist) -->
                        <t t-if="(state.detailData.task_state === 'in_progress' or state.detailData.task_state === 'paused') and (state.detailData.is_assignee or state.detailData.is_manager)">
                            <div class="card p-4 mb-3 border-danger" id="kpiCompletePanel">
                                <h4 class="fw-bold mb-3 text-danger"><i class="fa fa-check-circle"></i> Complete This Task</h4>
                                <div t-if="state.progressUpdates.length === 0" class="alert alert-warning py-2">
                                    <i class="fa fa-info-circle"></i> Submit a <strong>Progress Summary</strong> above before you can complete this task.
                                </div>
                                <p class="text-muted mb-2">Tick everything that applies — at least one is needed to send this for approval. Your manager sees exactly which:</p>
                                <div class="form-check mb-2">
                                    <input class="form-check-input" type="checkbox" id="cc_github" t-model="state.completeChecklist.verify_github"/>
                                    <label class="form-check-label" for="cc_github"><strong>1. Verify GitHub URL</strong><small class="d-block text-muted">All code pushed to the correct repository</small></label>
                                </div>
                                <div class="form-check mb-2">
                                    <input class="form-check-input" type="checkbox" id="cc_deploy" t-model="state.completeChecklist.deployed_task"/>
                                    <label class="form-check-label" for="cc_deploy"><strong>2. Deployed the Task</strong><small class="d-block text-muted">Deployed to staging/production</small></label>
                                </div>
                                <div class="form-check mb-2">
                                    <input class="form-check-input" type="checkbox" id="cc_manual" t-model="state.completeChecklist.user_manual"/>
                                    <label class="form-check-label" for="cc_manual"><strong>3. User Manual Uploaded</strong><small class="d-block text-muted">Documentation uploaded and accessible</small></label>
                                </div>
                                <div class="form-check mb-2">
                                    <input class="form-check-input" type="checkbox" id="cc_docs" t-model="state.completeChecklist.documentation"/>
                                    <label class="form-check-label" for="cc_docs"><strong>4. Documentation Submission</strong><small class="d-block text-muted">Technical documentation complete</small></label>
                                </div>
                                <div class="form-check mb-3">
                                    <input class="form-check-input" type="checkbox" id="cc_tested" t-model="state.completeChecklist.tested_code"/>
                                    <label class="form-check-label" for="cc_tested"><strong>5. Manually Tested the Code</strong><small class="d-block text-muted">All features tested and working</small></label>
                                </div>
                                <button class="btn btn-danger"
                                        t-att-disabled="!canCompleteDetail()"
                                        t-on-click="confirmCompleteFromDetail">
                                    <t t-if="state.completeSubmitting"><i class="fa fa-spinner fa-spin"></i> Submitting...</t>
                                    <t t-else=""><i class="fa fa-paper-plane"></i> Complete &amp; Send for Approval</t>
                                </button>
                                <div t-if="state.progressUpdates.length > 0 and !canCompleteDetail() and !state.completeSubmitting" class="text-muted small mt-2">
                                    Tick at least one item to enable completion.
                                </div>
                            </div>
                        </t>

                        <!-- 🆕 NEW: Attached Files Section -->
                        <t t-if="state.attachedFiles.length > 0">
                            <div class="card p-4 mb-3 bg-light border-primary">
                                <h4 class="fw-bold mb-3">📎 Attached Files</h4>
                                <div class="list-group">
                                    <t t-foreach="state.attachedFiles" t-as="file" t-key="file.id">
                                        <div class="list-group-item d-flex justify-content-between align-items-center">
                                            <div>
                                                <i class="fa fa-file text-primary me-2"></i>
                                                <strong t-esc="file.file_name"/>
                                                <div class="small text-muted mt-1">
                                                    <span>Uploaded by: <t t-esc="file.employee_name"/></span><br/>
                                                    <span>Date: <t t-esc="formatDate(file.create_date)"/></span>
                                                </div>
                                            </div>
                                            <div class="d-flex gap-2">
                                                <button t-if="file.summary" class="btn btn-sm btn-outline-secondary"
                                                        t-on-click="() => this.scrollToNote(file.id)"
                                                        title="Jump to this file's progress note">
                                                    📝 View note
                                                </button>
                                                <a class="btn btn-sm btn-info"
                                                    t-att-href="file.view_url"
                                                    target="_blank">
                                                    <i class="fa fa-eye"></i> View
                                                </a>
                                                <a class="btn btn-sm btn-primary"
                                                    t-att-href="file.download_url"
                                                    download="">
                                                    <i class="fa fa-download"></i> Download
                                                </a>
                                            </div>
                                        </div>
                                    </t>
                                </div>
                            </div>
                        </t>
                        <!-- 🆕 NEW: GitHub Links Section -->
                        <t t-if="state.githubLinks.length > 0">
                            <div class="card p-4 mb-3 bg-light border-info">
                                <h4 class="fw-bold mb-3">🔗 GitHub Repository Links</h4>
                                <div class="list-group">
                                    <t t-foreach="state.githubLinks" t-as="git" t-key="git.id">
                                        <div class="list-group-item">
                                            <div class="d-flex justify-content-between align-items-start">
                                                <div class="flex-grow-1">
                                                    <div class="mb-2">
                                                        <i class="fa fa-github text-dark me-2" style="font-size: 1.5rem;"></i>
                                                        <a t-att-href="git.github_url" 
                                                        target="_blank" 
                                                        class="fw-bold text-primary">
                                                            <t t-esc="git.github_url"/>
                                                        </a>
                                                    </div>
                                                    <div class="mb-2">
                                                        <strong class="text-success">🌿 Branch:</strong>
                                                        <code class="ms-2 bg-light px-2 py-1 rounded" 
                                                            style="white-space: pre-wrap;" 
                                                            t-esc="git.branch_name"/>
                                                    </div>
                                                    <div class="small text-muted">
                                                        <span>👤 Uploaded by: <t t-esc="git.employee_name"/></span> | 
                                                        <span>📅 <t t-esc="formatDate(git.create_date)"/></span>
                                                    </div>
                                                </div>
                                                <div>
                                                    <button class="btn btn-sm btn-danger" 
                                                            t-on-click="() => this.deleteGithubLink(git.id)">
                                                        <i class="fa fa-trash"></i>
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    </t>
                                </div>
                            </div>
                        </t>

                        <!-- Part E: consolidated sortable resource sections -->
                        <div class="row g-3 mb-3">
                            <div class="col-12">
                                <div class="card p-3">
                                    <div class="d-flex justify-content-between align-items-center mb-2">
                                        <h5 class="fw-bold mb-0"><i class="fa fa-github"></i> GitHub</h5>
                                        <select class="form-select form-select-sm" style="width:auto;" t-model="state.resSort.github">
                                            <option value="newest">Newest</option>
                                            <option value="oldest">Oldest</option>
                                            <option value="name">Name</option>
                                        </select>
                                    </div>
                                    <t t-if="sortedGithub().length">
                                        <div class="list-group">
                                            <t t-foreach="sortedGithub()" t-as="g" t-key="g.id">
                                                <div class="list-group-item">
                                                    <a t-att-href="g.github_url" target="_blank" class="fw-bold text-primary text-truncate d-inline-block" style="max-width:100%;" t-esc="g.github_url"/>
                                                    <div class="small text-muted">🌿 <t t-esc="g.branch_name"/> · <t t-esc="g.uploaded_by"/> · <t t-esc="g.upload_date"/></div>
                                                </div>
                                            </t>
                                        </div>
                                    </t>
                                    <t t-else=""><div class="text-muted small">— No repositories yet —</div></t>
                                </div>
                            </div>
                            <div class="col-md-6">
                                <div class="card p-3 h-100">
                                    <div class="d-flex justify-content-between align-items-center mb-2">
                                        <h5 class="fw-bold mb-0">📄 Documents</h5>
                                        <select class="form-select form-select-sm" style="width:auto;" t-model="state.resSort.documents">
                                            <option value="newest">Newest</option>
                                            <option value="oldest">Oldest</option>
                                            <option value="name">Name</option>
                                        </select>
                                    </div>
                                    <t t-if="sortedDocuments().length">
                                        <div class="list-group">
                                            <t t-foreach="sortedDocuments()" t-as="doc" t-key="doc._kind + '-' + doc.id">
                                                <div class="list-group-item d-flex justify-content-between align-items-center">
                                                    <div class="text-truncate" style="max-width:58%;">
                                                        <i class="fa fa-file me-1"></i><span t-esc="doc.file_name"/>
                                                        <div class="small text-muted"><t t-esc="doc.uploaded_by"/> · <t t-esc="doc.upload_date"/></div>
                                                    </div>
                                                    <div class="d-flex gap-1">
                                                        <a class="btn btn-sm btn-info" t-att-href="doc.view_url" target="_blank">View</a>
                                                        <a class="btn btn-sm btn-primary" t-att-href="doc.download_url">Download</a>
                                                    </div>
                                                </div>
                                            </t>
                                        </div>
                                    </t>
                                    <t t-else=""><div class="text-muted small">— No documents yet —</div></t>
                                </div>
                            </div>
                            <div class="col-md-6">
                                <div class="card p-3 h-100">
                                    <div class="d-flex justify-content-between align-items-center mb-2">
                                        <h5 class="fw-bold mb-0">🔗 Drive &amp; Links</h5>
                                        <select class="form-select form-select-sm" style="width:auto;" t-model="state.resSort.drive">
                                            <option value="newest">Newest</option>
                                            <option value="oldest">Oldest</option>
                                            <option value="name">Name</option>
                                        </select>
                                    </div>
                                    <t t-if="sortedDrive().length">
                                        <div class="list-group">
                                            <t t-foreach="sortedDrive()" t-as="lk" t-key="lk_index">
                                                <div class="list-group-item">
                                                    <a t-att-href="lk.url" target="_blank" class="text-truncate d-inline-block" style="max-width:100%;" t-esc="lk.url"/>
                                                    <div class="small text-muted"><t t-esc="lk.added_by"/> · <t t-esc="lk.added_date"/></div>
                                                </div>
                                            </t>
                                        </div>
                                    </t>
                                    <t t-else=""><div class="text-muted small">— No links yet —</div></t>
                                </div>
                            </div>
                        </div>

                        <!-- Activity: the audit trail this task has been writing all along
                             (started, paused, switched, estimate extended). Collapsed by
                             default and capped server-side, because a task worked over
                             months carries hundreds of entries and the pane still has to
                             open quickly. -->
                        <div t-if="(state.detailData.activity_log || []).length" class="mb-3">
                            <button class="btn btn-outline-secondary" t-on-click="openActivity">
                                <i class="fa fa-history me-2"/>
                                Activity
                                <span class="badge bg-secondary ms-2" t-esc="state.detailData.activity_total"/>
                            </button>
                        </div>

                        <!-- Progress History -->
                        <div class="card p-4">
                            <h4 class="fw-bold mb-3">Progress History</h4>
                            
                            <t t-if="state.progressUpdates.length">
                                <div class="timeline">
                                    <t t-foreach="state.progressUpdates" t-as="update" t-key="update.id">
                                        <div class="timeline-entry" t-att-id="'prog-' + update.id">
                                            <div class="timeline-head small text-muted mb-1">
                                                <i class="fa fa-user-circle me-1"></i>
                                                <strong t-esc="update.employee_name"/>
                                                <span class="mx-1">•</span>
                                                <span t-esc="formatDate(update.create_date)"/>
                                            </div>
                                            <div class="timeline-summary" style="white-space: pre-wrap;" t-esc="update.summary"/>
                                            <details t-if="update.summary and update.summary.length > 180" class="mt-1">
                                                <summary class="small text-primary" style="cursor:pointer;">Show more</summary>
                                                <div class="mt-1" style="white-space: pre-wrap;" t-esc="update.summary"/>
                                            </details>
                                            <t t-if="update.links and update.links.length > 0">
                                                <div class="mt-2">
                                                    <strong class="text-primary small">🔗 Related Links:</strong>
                                                    <ul class="list-unstyled mt-1 ms-3 mb-0">
                                                        <t t-foreach="update.links" t-as="link" t-key="link">
                                                            <li>
                                                                <a t-att-href="link" target="_blank" class="text-decoration-none small">
                                                                    <i class="fa fa-external-link"></i> <t t-esc="link"/>
                                                                </a>
                                                            </li>
                                                        </t>
                                                    </ul>
                                                </div>
                                            </t>
                                            <t t-if="update.has_file">
                                                <a t-att-href="'/kpi/progress/download?progress_id=' + update.id"
                                                   class="btn btn-sm btn-outline-primary mt-2"
                                                   target="_blank">
                                                    <i class="fa fa-download"></i> <t t-esc="update.file_name"/>
                                                </a>
                                            </t>
                                        </div>
                                    </t>
                                </div>
                            </t>
                            <t t-else="">
                                <div class="alert alert-info">
                                    No progress updates yet. Submit your first update above!
                                </div>
                            </t>
                        </div>
                    </t>
                    
                    <t t-elif="state.detailError">
                        <div class="alert alert-danger">
                            <h4>Error Loading KPI</h4>
                            <p t-esc="state.detailError"/>
                            <button class="btn btn-secondary" t-on-click="backToList">
                                Back to Action Board
                            </button>
                        </div>
                    </t>
                    
                    <t t-else="">
                        <div class="alert alert-info">
                            <span class="spinner-border spinner-border-sm me-2"></span>
                            Loading KPI details...
                        </div>
                    </t>
                </div>
            </t>

            <!-- Show List View (default) -->
            <t t-else="">
                <div class="o_kpi_action p-4">
                    
                    <!-- "Not on a task?" — raised by the 10-min check, the strip
                         button, or ending a meeting with no task to follow.
                         Meeting/Break are silent to admins; only "no tasks"
                         escalates, because only that one is theirs to fix. -->
                    <t t-if="state.idleModalOpen">
                        <div class="modal-backdrop fade show"></div>
                        <div class="modal d-block" tabindex="-1">
                            <div class="modal-dialog modal-dialog-centered">
                                <div class="modal-content shadow">
                                    <div class="modal-header bg-warning">
                                        <h5 class="modal-title"><i class="fa fa-question-circle me-2"></i> Not on a task?</h5>
                                        <button type="button" class="btn-close" t-on-click="closeIdleModal"></button>
                                    </div>
                                    <div class="modal-body">
                                        <p class="text-muted mb-3">
                                            Nothing is running. Tell us why so your time is recorded correctly.
                                        </p>
                                        <!-- Says which button is for what. Red because
                                             getting this wrong is what puts a wrong
                                             record on someone's day. -->
                                        <div class="alert alert-danger py-2 px-3 mb-3" style="font-size:.8rem;">
                                            <div>• Meeting before your task? Click <b>In a meeting</b>.</div>
                                            <div>• Nothing assigned yet? Click <b>I have no tasks</b>.</div>
                                            <div>• Ready to work? Close this (✕) and press <b>Start</b> on your task.</div>
                                        </div>
                                        <t t-foreach="allReasons()" t-as="r" t-key="r.code">
                                            <button class="w-100 text-start mb-2 d-flex align-items-center gap-2"
                                                    t-att-class="r.alert ? 'btn btn-outline-danger w-100 text-start mb-2 d-flex align-items-center gap-2' : 'btn btn-outline-secondary w-100 text-start mb-2 d-flex align-items-center gap-2'"
                                                    t-att-disabled="state.idleBusy"
                                                    t-on-click="() => this.chooseIdleReason(r.code)">
                                                <span style="font-size:1.3rem;"><t t-esc="r.emoji"/></span>
                                                <span>
                                                    <span class="fw-bold d-block"><t t-esc="r.text"/></span>
                                                    <small class="text-muted"><t t-esc="r.note"/></small>
                                                </span>
                                            </button>
                                        </t>
                                        <!-- Optional note. Capped because it is drawn
                                             inside a Workday Map chip. -->
                                        <input type="text" class="form-control mt-3" maxlength="60"
                                               placeholder="Optional note (e.g. sprint planning)…"
                                               t-att-disabled="state.idleBusy"
                                               t-model="state.idleNote"/>
                                        <div class="small text-danger mt-1">
                                            Keep it short (max 60) — this shows on your Workday Map.
                                        </div>
                                    </div>
                                    <div class="modal-footer">
                                        <!-- Closable on purpose: this modal covers the board, so with
                                             no way out, pressing Start — the very thing that answers
                                             it — would be impossible. It re-asks after 60s. -->
                                        <button class="btn btn-link text-muted" t-att-disabled="state.idleBusy"
                                                t-on-click="closeIdleModal">I have a task — let me start it</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </t>

                    <!-- Switching ends the running block and starts another. Show the
                         hand-off rather than a bare "are you sure": the fear is that
                         ending a meeting loses it. It doesn't, and this says so. -->
                    <t t-if="state.switchTo">
                        <div class="modal-backdrop fade show"></div>
                        <div class="modal d-block" tabindex="-1">
                            <div class="modal-dialog modal-dialog-centered modal-sm">
                                <div class="modal-content shadow">
                                    <div class="modal-header">
                                        <h5 class="modal-title">
                                            <i class="fa fa-exchange me-2"></i>
                                            Switch to <t t-esc="state.switchTo.text"/>?
                                        </h5>
                                        <button type="button" class="btn-close" t-on-click="cancelSwitch"></button>
                                    </div>
                                    <div class="modal-body">
                                        <div class="border rounded p-2 mb-2" style="background:#f8fafc;">
                                            <div class="d-flex align-items-center gap-2">
                                                <span style="font-size:1.1rem;">⏸</span>
                                                <span class="flex-grow-1">
                                                    <b t-if="currentBlock()" t-esc="currentBlock().reason_label"/>
                                                    <div class="text-muted" style="font-size:.72rem;"
                                                         t-if="currentBlock()">
                                                        started <t t-esc="currentBlock().start_display"/>
                                                        · <t t-esc="nontaskDisplay()"/>
                                                    </div>
                                                </span>
                                                <span class="text-muted" style="font-size:.72rem;">ends now</span>
                                            </div>
                                            <div class="text-center text-muted my-1"><i class="fa fa-arrow-down"></i></div>
                                            <div class="d-flex align-items-center gap-2">
                                                <span style="font-size:1.1rem;"><t t-esc="state.switchTo.emoji"/></span>
                                                <span class="flex-grow-1"><b t-esc="state.switchTo.text"/></span>
                                                <span class="text-success" style="font-size:.72rem;">starts now</span>
                                            </div>
                                        </div>
                                        <div class="text-muted" style="font-size:.78rem;">
                                            <t t-if="currentBlock()"><t t-esc="currentBlock().reason_label"/></t>
                                            is saved to your Workday Map. Nothing is lost.
                                        </div>
                                        <div class="text-danger fw-bold mt-2" style="font-size:.78rem;"
                                             t-if="state.switchTo.code === 'no_tasks'">
                                            Your admins will be told straight away.
                                        </div>
                                    </div>
                                    <div class="modal-footer">
                                        <button class="btn btn-secondary btn-sm" t-att-disabled="state.idleBusy"
                                                t-on-click="cancelSwitch">Cancel</button>
                                        <button class="btn btn-primary btn-sm" t-att-disabled="state.idleBusy"
                                                t-on-click="() => this.chooseIdleReason(state.switchTo.code)">
                                            Yes, switch
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </t>

                    <!-- ✅ REJECTION NOTIFICATION MODAL -->
                    <t t-if="state.showRejectionModal">
                        <div class="modal-backdrop fade show"></div>
                        <div class="modal d-block" tabindex="-1">
                            <div class="modal-dialog modal-lg modal-dialog-centered">
                                <div class="modal-content border-danger">
                                    <div class="modal-header bg-danger text-white">
                                        <h5 class="modal-title">
                                            <i class="fa fa-exclamation-triangle me-2"></i>
                                            Task Rejection Alert
                                        </h5>
                                    </div>
                                    <div class="modal-body">
                                        <div class="alert alert-warning mb-3">
                                            <strong>⚠️ You have <t t-esc="state.rejectedTasks.length"/> rejected task(s)</strong>
                                        </div>
                                        
                                        <t t-foreach="state.rejectedTasks" t-as="task" t-key="task.id">
                                            <div class="card mb-3 border-danger">
                                                <div class="card-header bg-light">
                                                    <h6 class="mb-0">
                                                        <i class="fa fa-tasks text-danger me-2"></i>
                                                        <strong t-esc="task.name"/>
                                                    </h6>
                                                </div>
                                                <div class="card-body">
                                                    <div class="mb-2">
                                                        <strong>Priority:</strong> 
                                                        <span class="badge bg-warning" t-esc="task.priority"/>
                                                    </div>
                                                    <div class="mb-2">
                                                        <strong>Time Spent:</strong> 
                                                        <t t-esc="formatTime(task.timer_total_seconds)"/>
                                                    </div>
                                                    <div class="mb-3">
                                                        <strong class="text-danger">Manager Feedback:</strong>
                                                        <div class="alert alert-danger mt-2 mb-0" style="white-space: pre-wrap;" 
                                                             t-esc="extractRejectionReason(task.paused_reason)"/>
                                                    </div>
                                                    <div class="text-muted small">
                                                        <i class="fa fa-info-circle"></i> 
                                                        This task is now in <strong>"Paused"</strong> state. 
                                                        Click <strong>"Resume"</strong> button to start working on corrections.
                                                    </div>
                                                </div>
                                            </div>
                                        </t>
                                    </div>
                                    <div class="modal-footer">
                                        <button class="btn btn-primary btn-lg w-100" 
                                                t-on-click="closeRejectionModal">
                                            <i class="fa fa-check me-2"></i> OK, I Understand
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </t>
                    
                    <!-- Header Section with Title and Count -->
                    <div class="d-flex justify-content-between align-items-center mb-3">
                        <div class="d-flex align-items-center">
                            <h2 class="fw-bold mb-0">KPI Action Board</h2>
                            
                            <!-- Toggle Buttons for Admin/Manager Users -->
                            <t t-if="state.isAdmin">
                                <div class="btn-group ms-3" role="group" aria-label="Task view toggle">
                                    <button type="button" 
                                            t-att-class="'btn btn-sm ' + (state.showMyTasksOnly ? 'btn-outline-primary' : 'btn-primary')"
                                            t-on-click="() => this.setTaskFilter(false)">
                                        <i class="fa fa-users me-1"></i> All Tasks
                                    </button>
                                    <button type="button" 
                                            t-att-class="'btn btn-sm ' + (state.showMyTasksOnly ? 'btn-primary' : 'btn-outline-primary')"
                                            t-on-click="() => this.setTaskFilter(true)">
                                        <i class="fa fa-user me-1"></i> My Tasks
                                    </button>
                                </div>
                                <span t-att-class="'badge ms-2 ' + (state.showMyTasksOnly ? 'bg-info' : 'bg-success')"
                                      t-esc="state.showMyTasksOnly ? 'Showing My Tasks Only' : 'Coordinator View - All Tasks'"/>
                            </t>
                            <t t-else="">
                                <span class="badge bg-info ms-3">My Tasks</span>
                            </t>
                        </div>
                        
                        <!-- Results Count Badge + Workday Start/End button -->
                        <div class="d-flex align-items-center gap-3">
                            <span class="badge" style="background-color: #e5e7eb; color: #374151; font-size: 0.85rem; padding: 0.5rem 1rem; font-weight: 500;">
                                Showing <strong t-esc="getTotalFilteredCount()"/> of <strong t-esc="getTotalTaskCount()"/> tasks
                            </span>
                            <!-- ➕ New Task — any developer can create their own task; it lands in
                                 the Pending Review lane (workable now) until an admin accepts it.
                                 Hidden for a developer whose workday isn't open: creating a task is
                                 work, which is exactly what the read-only day withholds — the app
                                 has always hidden it, and the web offering it was the odd one out.
                                 Admins keep it, because they file work for other people. -->
                            <button t-if="state.isAdmin or state.workdayOpen"
                                    class="btn btn-sm btn-primary fw-bold"
                                    title="Create a task (goes to Pending Review)"
                                    t-on-click="() => this.openNewTaskModal()">
                                <i class="fa fa-plus me-1"></i> New Task
                            </button>
                            <!-- Admin: count of self-created tasks awaiting Accept -->
                            <span t-if="state.isAdmin and state.selfPendingCount"
                                  class="badge bg-warning text-dark"
                                  title="Self-created tasks awaiting your Accept">
                                <i class="fa fa-clock-o me-1"></i> Pending Review: <t t-esc="state.selfPendingCount"/>
                            </span>
                            <!-- No open session: either a fresh/auto-closed day (green
                                 Start) or the developer ENDED today themselves (one
                                 start + one end per day → disabled "ended" button). -->
                            <t t-if="!state.workdayOpen">
                                <button t-if="state.dayDone"
                                        class="btn btn-sm btn-secondary fw-bold" disabled="disabled"
                                        title="One workday per day — start a new one tomorrow">
                                    <i class="fa fa-check-circle me-1"></i> Workday ended for today
                                </button>
                                <!-- The one way back from an explicit End Workday, and only
                                     for an admin. Sits next to the disabled button it undoes,
                                     because that button is where someone stands when they
                                     realise the day was ended by mistake. -->
                                <button t-if="state.dayDone and state.isAdmin"
                                        class="btn btn-sm btn-outline-warning fw-bold"
                                        title="Reopen this ended workday (admin only)"
                                        t-on-click="() => this.revertWorkday()">
                                    <i class="fa fa-undo me-1"></i> Reopen Workday
                                </button>
                                <!-- GREEN Start Workday — a fresh day, or a restart after an
                                     AUTO-close (idle/midnight). An explicit End is final for the day.
                                     CONDITION IS EXPLICIT ON PURPOSE. This was t-else="", which OWL
                                     binds to the previous sibling carrying a t-if — and that sibling is
                                     the admin-only Reopen button (dayDone and isAdmin), not the
                                     "Workday ended" button above it. So for a DEVELOPER (isAdmin false)
                                     the else evaluated true and the green button came back right after
                                     End Workday, on top of the disabled "ended" one. It was dead too:
                                     /kpi_workday/ping refuses with day_done. Positional chaining breaks
                                     the moment anything is inserted between; !state.dayDone cannot.
                                     Never put a backtick in this comment: it sits inside the
                                     tagged template literal that holds the whole template, so a
                                     backtick ends the literal and breaks the entire JS bundle. -->
                                <button t-if="!state.dayDone"
                                        class="btn btn-sm btn-success fw-bold"
                                        title="Start your workday + notify owner + coordinator"
                                        t-on-click="() => this.startWorkday()">
                                    <i class="fa fa-play-circle me-1"></i>
                                    <t t-if="state.workdayClosed">Start New Workday Session</t>
                                    <t t-else="">Start Workday</t>
                                </button>
                            </t>
                            <!-- Directly under the workday button, because that is where
                                 someone stands when they wonder why the day reopened.
                                 It was only on Live Tracking and the snapshot before —
                                 neither of which is this screen. -->
                            <div t-if="state.reopenReason" class="small text-warning mt-1"
                                 style="max-width:420px;white-space:pre-wrap;">
                                <i class="fa fa-unlock me-1"/>Workday reopened<t t-if="state.reopenedBy"> by <t t-esc="state.reopenedBy"/></t>:
                                <span class="text-muted" t-esc="state.reopenReason"/>
                            </div>
                            <!-- Pause / Resume the whole day. Sits with End Workday
                                 because it is the same decision made softer: End
                                 buries the date (one start + one end), Pause freezes
                                 it so you can come back the same day. -->
                            <!-- Only RESUME lives in the header. Pause sits inside the
                                 End Workday dialog, where the choice between "stop for
                                 now" and "stop for good" is actually made. Resume has
                                 to be here instead: when the day is frozen it is the
                                 one thing you need, and burying it behind End Workday
                                 would mean opening an "end my day" dialog to carry on
                                 working. -->
                            <button t-if="state.workdayOpen and state.workdayPaused"
                                    class="btn btn-sm btn-success fw-bold"
                                    title="Start the clock again"
                                    t-on-click="() => this.resumeWorkday()">
                                <i class="fa fa-play-circle me-1"></i> Resume Workday
                            </button>
                            <!-- RED End Workday button — visible while session is open. -->
                            <button t-if="state.workdayOpen"
                                    class="btn btn-sm btn-outline-danger"
                                    title="End workday, send daily summary, and log out"
                                    t-on-click="() => openEndWorkdayModal()">
                                <i class="fa fa-power-off me-1"></i> End Workday
                            </button>
                        </div>
                    </div>

                    <!-- ============================================ -->
                    <!-- 🆕 Part C: LIVE ACTIVITY STRIP + auto-away banner -->
                    <!-- ============================================ -->
                    <t t-if="state.workdayOpen">
                        <!-- Sticky: with 85 tasks the strip used to scroll away exactly
                             when you needed it — the running timer, Presence/Productive
                             and Switch are all most useful while you are looking down
                             the board, not at the top of it. -->
                        <div class="kpi-live-strip card mb-2"
                             style="border:1px solid #d1d5db; position:sticky; top:0; z-index:1020;">
                            <div class="card-body py-2 px-3">
                                <div class="d-flex align-items-center flex-wrap gap-3">
                                    <span class="badge bg-danger"><i class="fa fa-circle me-1" style="font-size:.5rem;vertical-align:middle;"></i> LIVE</span>
                                    <!-- Running task(s). Every one of them, not just the
                                         first: with multitask on, two timers run at once
                                         and showing one made the other look stopped. -->
                                    <t t-if="getActiveTask()">
                                        <span class="text-success fw-bold" t-if="getActiveTasks().length > 1">
                                            <i class="fa fa-bolt me-1"></i>
                                            Multi-tasking <t t-esc="getActiveTasks().length"/> tasks:
                                        </span>
                                        <t t-foreach="getActiveTasks()" t-as="at" t-key="at.id">
                                            <span class="text-success fw-bold">
                                                <i class="fa fa-play me-1"></i> Working: "<t t-esc="at.name"/>"
                                                <span class="ms-1 font-monospace"><t t-esc="getDisplayTime(at)"/></span>
                                            </span>
                                        </t>
                                    </t>
                                    <t t-else="">
                                        <span class="text-muted"><i class="fa fa-pause me-1"></i> No task running</span>
                                        <!-- Say so up front. Without this a 9:31 meeting could only be
                                             declared by waiting to be asked at 9:40.
                                             Hidden while a break is active: they paused a task WITH a
                                             reason, so they have already said why — asking again is
                                             noise, and the badge beside this already says it. -->
                                        <t t-if="(!state.liveStatus or !state.liveStatus.nontask) and !state.liveBreak">
                                            <button class="btn btn-sm btn-outline-primary py-0 px-2"
                                                    style="font-size:.75rem;"
                                                    t-on-click="openIdleModal">Not on a task?</button>
                                        </t>
                                    </t>
                                    <!-- The open Meeting / Break / No-tasks block, with the
                                         OTHER two reasons right beside it: switching IS how a
                                         block ends. "Morning meeting over, I have no tasks" is
                                         one click — the meeting closes and no-tasks begins,
                                         both landing on the Workday Map. The third way out is
                                         a task's own Start button, which already closes the
                                         block on the tick the timer starts. -->
                                    <t t-if="state.liveStatus and state.liveStatus.nontask and !getActiveTask()">
                                        <span class="badge d-inline-flex align-items-center gap-2"
                                              style="background:#EDE9FE; color:#4C1D95; font-size:.8rem;">
                                            <span>
                                                <i class="fa fa-pause-circle me-1"></i>
                                                <t t-esc="state.liveStatus.nontask.reason_label"/>
                                                · started <t t-esc="state.liveStatus.nontask.start_display"/>
                                                · <span class="font-monospace"><t t-esc="nontaskDisplay()"/></span>
                                            </span>
                                        </span>
                                        <t t-foreach="otherReasons()" t-as="r" t-key="r.code">
                                            <button class="btn btn-sm py-0 px-2"
                                                    t-att-class="r.code === 'no_tasks' ? 'btn btn-sm btn-outline-danger py-0 px-2' : 'btn btn-sm btn-outline-primary py-0 px-2'"
                                                    style="font-size:.72rem;"
                                                    t-att-disabled="state.idleBusy"
                                                    t-on-click="() => this.askSwitch(r)">
                                                <t t-esc="r.label"/>
                                            </button>
                                        </t>
                                        <!-- No End button on purpose: nothing it could do that these
                                             buttons and Start don't already. Every exit closes this
                                             block — Start (at the timer's tick), another reason
                                             (splits), End Workday, or the midnight cron — so a block
                                             cannot leak. -->
                                        <span class="text-muted" style="font-size:.7rem;">
                                            starting a task, or another reason, ends this automatically
                                        </span>
                                    </t>
                                    <!-- Active break / lunch / meeting / other / away -->
                                    <t t-if="state.liveBreak">
                                        <span class="badge bg-warning text-dark" style="font-size:.8rem;">
                                            <i class="fa fa-coffee me-1"></i><t t-esc="state.liveBreak.type_label"/>
                                            <t t-if="state.liveBreak.source_task_name"> (from "<t t-esc="state.liveBreak.source_task_name"/>")</t>
                                            · started <t t-esc="state.liveBreak.start_display"/>
                                            · <span class="font-monospace"><t t-esc="liveBreakDisplay()"/></span>
                                        </span>
                                    </t>
                                    <!-- Move to the next task in one action. Only offered
                                         while something is actually running — with nothing
                                         running there is nothing to switch FROM, and the
                                         normal Start button is the right control. -->
                                    <!-- No Switch button here. It lives on the task card
                                         instead: the card names WHICH task is handing over,
                                         which a single strip button cannot when two tasks
                                         are running.
                                         Pause all IS here, because it is the one action that
                                         is genuinely about all of them at once — and it only
                                         appears when there is more than one to pause. -->
                                    <t t-if="getActiveTasks().length > 1">
                                        <button class="btn btn-sm btn-outline-warning py-0 px-2"
                                                style="font-size:.75rem;"
                                                t-on-click="() => this.openPauseAll()"
                                                title="Stop every running task at once, with one reason">
                                            <i class="fa fa-pause me-1"></i> Pause all (<t t-esc="getActiveTasks().length"/>)
                                        </button>
                                    </t>
                                    <!-- Day totals (live) -->
                                    <span class="ms-auto small text-muted">
                                        Presence <span class="fw-bold text-primary font-monospace"><t t-esc="livePresenceDisplay()"/></span>
                                        · Productive <span class="fw-bold text-success font-monospace"><t t-esc="liveProductiveDisplay()"/></span>
                                    </span>
                                </div>
                            </div>
                        </div>
                        <!-- Reminder while a task is in progress.
                             It used to threaten an auto-pause after
                             state.awayAfterMinutes. Idle auto-pause is retired, so
                             with the setting at 0 it was reading "auto-pauses after
                             0 min" — a warning about something that no longer
                             happens, stating a nonsense number. The honest risk now
                             is the opposite one: nothing stops your timer for you. -->
                        <t t-if="getActiveTask()">
                            <div class="alert alert-warning py-1 px-3 mb-2 small d-flex align-items-center" role="alert">
                                <i class="fa fa-clock-o me-2"></i>
                                A task is running. It keeps counting until you Pause, Complete,
                                <b class="mx-1">Switch task</b> or End Workday — closing this tab
                                will not stop it.
                            </div>
                        </t>
                        <!-- Paused: say so loudly. The board looks normal but nothing
                             will start, and without this the refusals look like a bug. -->
                        <t t-if="state.workdayPaused">
                            <div class="alert alert-secondary py-2 px-3 mb-2 small d-flex align-items-center" role="alert">
                                <i class="fa fa-pause-circle me-2"></i>
                                <span>
                                    <b>Your workday is paused.</b> Tasks cannot be started, and
                                    paused time will not count as worked time. Press
                                    <b>Resume Workday</b> when you're back.
                                </span>
                            </div>
                        </t>
                    </t>

                    <!-- ============================================ -->
                    <!-- 🆕 COMPACT FILTER BAR -->
                    <!-- ============================================ -->
                    <div class="task-filter-bar card mb-2" style="border: 1px solid #e5e7eb; background: #f9fafb;">
                        <div class="card-body py-2 px-3">
                            <!-- Single Row: Search + Filters + Clear -->
                            <div class="d-flex align-items-center gap-2 flex-wrap">
                                <!-- Search Input -->
                                <div class="position-relative" style="min-width: 200px; flex: 1; max-width: 280px;">
                                    <i class="fa fa-search" style="position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: #9ca3af; font-size: 0.8rem;"></i>
                                    <input type="text" 
                                           class="form-control form-control-sm" 
                                           placeholder="Search..."
                                           style="padding-left: 30px; height: 32px; font-size: 0.85rem;"
                                           t-att-value="state.searchQuery"
                                           t-on-input="onSearchInput"/>
                                    <t t-if="state.searchQuery">
                                        <button class="btn btn-link p-0" 
                                                style="position: absolute; right: 6px; top: 50%; transform: translateY(-50%); color: #9ca3af;"
                                                t-on-click="clearSearch">
                                            <i class="fa fa-times" style="font-size: 0.75rem;"></i>
                                        </button>
                                    </t>
                                </div>
                                
                                <!-- Assignee Filter -->
                                <select class="form-select form-select-sm" 
                                        style="width: auto; min-width: 130px; height: 32px; font-size: 0.85rem;"
                                        t-on-change="onAssigneeChange">
                                    <option value="">All Assignees</option>
                                    <t t-foreach="state.assignees" t-as="assignee" t-key="assignee.id">
                                        <option t-att-value="assignee.id" 
                                                t-att-selected="isAssigneeSelected(assignee.id)"
                                                t-esc="assignee.name"/>
                                    </t>
                                </select>
                                
                                <!-- Priority Filter -->
                                <select class="form-select form-select-sm" 
                                        style="width: auto; min-width: 120px; height: 32px; font-size: 0.85rem;"
                                        t-on-change="onPriorityChange">
                                    <option value="">All Priorities</option>
                                    <option value="urgent" t-att-selected="state.filters.priority === 'urgent'">🔴 Urgent</option>
                                    <option value="important" t-att-selected="state.filters.priority === 'important'">🟡 Important</option>
                                    <option value="regular" t-att-selected="state.filters.priority === 'regular'">⚪ Regular</option>
                                </select>
                                
                                <!-- Status Filter -->
                                <select class="form-select form-select-sm" 
                                        style="width: auto; min-width: 140px; height: 32px; font-size: 0.85rem;"
                                        t-on-change="onStatusChange">
                                    <option value="">All Statuses</option>
                                    <option value="self_pending" t-att-selected="state.filters.status === 'self_pending'">🆕 Pending Review</option>
                                    <option value="regular" t-att-selected="state.filters.status === 'regular'">📋 Regular</option>
                                    <option value="important" t-att-selected="state.filters.status === 'important'">⚠️ Important</option>
                                    <option value="urgent" t-att-selected="state.filters.status === 'urgent'">🚨 Urgent</option>
                                    <option value="in_progress" t-att-selected="state.filters.status === 'in_progress'">🔄 In Progress</option>
                                    <option value="paused" t-att-selected="state.filters.status === 'paused'">⏸️ Paused</option>
                                    <option value="partially_completed" t-att-selected="state.filters.status === 'partially_completed'">⏳ Pending</option>
                                    <option value="awaiting_client" t-att-selected="state.filters.status === 'awaiting_client'">📤 Awaiting Client</option>
                                    <option value="completed" t-att-selected="state.filters.status === 'completed'">✅ Completed</option>
                                </select>
                                
                                <!-- Clear All Button (only shows when filters active) -->
                                <t t-if="hasActiveFilters()">
                                    <button class="btn btn-outline-secondary btn-sm"
                                            style="height: 32px; font-size: 0.8rem;"
                                            t-on-click="clearAllFilters">
                                        <i class="fa fa-times me-1"></i> Clear
                                    </button>
                                </t>
                            </div>

                            <!-- Active filter chips. The dropdowns alone don't say what is
                                 in force: scroll the board and the selects are off screen,
                                 leaving a filtered list that looks like the whole list —
                                 which reads as "tasks are missing". Each chip names one
                                 filter and drops it on its own; Clear drops them all.
                                 clearAssigneeFilter / clearPriorityFilter /
                                 clearStatusFilter already existed for exactly this. -->
                            <t t-if="hasActiveFilters()">
                                <div class="d-flex align-items-center flex-wrap gap-2 mt-2">
                                    <span class="text-muted" style="font-size: 0.8rem; font-weight: 500;">Active filters:</span>

                                    <t t-if="state.searchQuery">
                                        <span class="badge d-inline-flex align-items-center gap-1"
                                              style="background:#dbeafe; color:#1e40af; border-radius:9999px; padding:.35rem .65rem; font-size:.78rem;">
                                            <i class="fa fa-search" style="font-size:.7rem;"></i>
                                            "<t t-esc="state.searchQuery"/>"
                                            <button class="btn btn-link p-0 ms-1" style="color:#1e40af; font-size:.72rem; text-decoration:none;"
                                                    t-on-click="clearSearch"><i class="fa fa-times"></i></button>
                                        </span>
                                    </t>

                                    <t t-if="state.filters.assignee">
                                        <span class="badge d-inline-flex align-items-center gap-1"
                                              style="background:#dcfce7; color:#166534; border-radius:9999px; padding:.35rem .65rem; font-size:.78rem;">
                                            <i class="fa fa-user" style="font-size:.7rem;"></i>
                                            <t t-esc="getAssigneeName(state.filters.assignee)"/>
                                            <button class="btn btn-link p-0 ms-1" style="color:#166534; font-size:.72rem; text-decoration:none;"
                                                    t-on-click="clearAssigneeFilter"><i class="fa fa-times"></i></button>
                                        </span>
                                    </t>

                                    <t t-if="state.filters.priority">
                                        <span class="badge d-inline-flex align-items-center gap-1"
                                              style="background:#fef3c7; color:#92400e; border-radius:9999px; padding:.35rem .65rem; font-size:.78rem;">
                                            <i class="fa fa-flag" style="font-size:.7rem;"></i>
                                            <t t-esc="priorityLabel(state.filters.priority)"/>
                                            <button class="btn btn-link p-0 ms-1" style="color:#92400e; font-size:.72rem; text-decoration:none;"
                                                    t-on-click="clearPriorityFilter"><i class="fa fa-times"></i></button>
                                        </span>
                                    </t>

                                    <t t-if="state.filters.status">
                                        <span class="badge d-inline-flex align-items-center gap-1"
                                              style="background:#e0e7ff; color:#3730a3; border-radius:9999px; padding:.35rem .65rem; font-size:.78rem;">
                                            <i class="fa fa-list-ul" style="font-size:.7rem;"></i>
                                            <t t-esc="filterStatusLabel(state.filters.status)"/>
                                            <button class="btn btn-link p-0 ms-1" style="color:#3730a3; font-size:.72rem; text-decoration:none;"
                                                    t-on-click="clearStatusFilter"><i class="fa fa-times"></i></button>
                                        </span>
                                    </t>
                                </div>
                            </t>
                        </div>
                    </div>

                    <!-- Top scrollbar mirror — synced with the kanban row below so admin can
                         scroll horizontally without going to the bottom of the page. -->
                    <div class="kpi-scrolltop" t-ref="kpiScrollTop">
                        <div class="kpi-scrolltop-inner" t-ref="kpiScrollTopInner"></div>
                    </div>

                    <div class="row g-3" t-ref="kpiKanbanRow">
                        <t t-foreach="columns" t-as="col" t-key="col.key">
                            <div class="col kpi-lane">
                                <div class="kpi-column-card h-100" t-att-class="'kpi-' + col.key">
                                    
                                    <div class="kpi-header" t-att-class="'kpi-' + col.key">
                                        <span t-esc="col.label"/>
                                        <span class="badge bg-white text-dark ms-2" style="font-size: 0.75rem;"
                                              t-esc="col.key === 'paid' ? state.paidTasks.length : getFilteredTasksByState(col.key).length"/>
                                    </div>

                                    <!-- Paid is an archive, not a workload: the tasks are settled,
                                         there is nothing to act on, and they are filed away
                                         (active=False) so they reach the board by their own route.
                                         Read-only cards, and outside the search/assignee/priority
                                         pipeline the working lanes run through. -->
                                    <div t-if="col.key === 'paid'" class="kpi-task-list kpi-paid">
                                        <t t-if="state.paidTasks.length">
                                            <t t-foreach="state.paidTasks" t-as="pt" t-key="pt.id">
                                                <div class="kpi-task">
                                                    <div class="fw-bold">
                                                        <span t-if="pt.external_ref"
                                                              class="badge bg-secondary me-1" t-esc="pt.external_ref"/>
                                                        <t t-esc="pt.name"/>
                                                    </div>
                                                    <div t-if="pt.user_name" class="text-muted small text-truncate"
                                                         t-att-title="pt.user_name">
                                                        <i class="fa fa-user me-1"/><t t-esc="pt.user_name"/>
                                                    </div>
                                                    <div class="small">
                                                        <span t-att-class="paidOverEstimate(pt) ? 'text-danger fw-bold' : 'text-muted'">
                                                            <i class="fa fa-clock-o me-1"/>
                                                            <t t-esc="formatTime(pt.timer_total_seconds)"/>
                                                        </span>
                                                        <!-- No estimate is not a zero estimate — saying
                                                             "est 00:00" would read as a target that was
                                                             blown on every task that never had one. -->
                                                        <span t-if="pt.estimate_hours or pt.estimate_minutes"
                                                              class="text-muted">
                                                            · est <t t-esc="pt.estimate_display"/>
                                                        </span>
                                                        <span t-else="" class="text-muted">· no estimate</span>
                                                    </div>
                                                    <!-- Rate 0 is a time-only invoice, so no amount
                                                         beats a 0.00 that looks like free work. -->
                                                    <div t-if="pt.amount" class="small fw-bold text-success">
                                                        <t t-esc="pt.currency"/> <t t-esc="pt.amount.toFixed(2)"/>
                                                    </div>
                                                    <div class="small text-muted">
                                                        <t t-if="pt.client_paid_on">
                                                            client <t t-esc="pt.client_paid_on.slice(0, 11)"/> →
                                                        </t>
                                                        confirmed <t t-esc="(pt.paid_on || '').slice(0, 11) || '—'"/>
                                                    </div>
                                                    <div t-if="pt.client_name" class="text-muted small text-truncate"
                                                         t-att-title="pt.client_name">
                                                        <i class="fa fa-building-o me-1"/><t t-esc="pt.client_name"/>
                                                    </div>
                                                </div>
                                            </t>
                                            <div t-if="state.paidTruncated" class="text-muted small p-2 fst-italic">
                                                Showing the most recent <t t-esc="state.paidTasks.length"/> only.
                                            </div>
                                        </t>
                                        <div t-else="" class="text-muted small p-2">
                                            Nothing paid yet.
                                        </div>
                                    </div>

                                    <div t-else="" class="kpi-task-list" t-att-class="'kpi-' + col.key">
                                        <t t-set="filteredTasks" t-value="getFilteredTasksByState(col.key)"/>
                                        <t t-if="filteredTasks.length">
                                            <t t-foreach="filteredTasks" t-as="task" t-key="task.id">
                                                <div class="kpi-task">
                                                    <!-- Once it is with the client the developer
                                                         has nothing left to do on it, and the
                                                         detail pane is all edit affordances — so
                                                         the name stops being a link and reads as
                                                         plain text. Admins keep the link: they
                                                         still have to review and invoice it. -->
                                                    <div t-if="state.isAdmin or task.task_state !== 'awaiting_client'"
                                                        class="fw-bold text-primary"
                                                        style="cursor:pointer;"
                                                        t-on-click="() => this.openKpiDetail(task.id)"
                                                        t-esc="task.name"/>
                                                    <div t-else="" class="fw-bold" t-esc="task.name"/>

                                                    <div class="small mb-1">
                                                        <span t-att-class="'badge ' + priorityBadgeClass(task.priority)">
                                                            <t t-esc="priorityLabel(task.priority)"/>
                                                        </span>
                                                    </div>
                                                    <!-- Who the work is for. With several clients in flight the
                                                         lanes were a wall of titles with no way to tell them
                                                         apart without opening each task. Own line, truncated:
                                                         the lane is narrow and client names are long. -->
                                                    <t t-if="task.client_name">
                                                        <div class="text-muted small mb-1 text-truncate"
                                                             t-att-title="task.client_name">
                                                            <i class="fa fa-building-o me-1"/><t t-esc="task.client_name"/>
                                                        </div>
                                                    </t>
                                                    <!-- What the task is actually for. The payload has carried
                                                         the description all along; the card just never read it,
                                                         so whatever the developer typed on New Task was invisible
                                                         until someone opened the detail pane. Clamped to two
                                                         lines so a long one can't push the buttons off the card
                                                         — the detail pane still shows it in full. -->
                                                    <t t-if="task.description">
                                                        <div class="text-muted small mb-1"
                                                             style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;"
                                                             t-att-title="task.description"
                                                             t-esc="task.description"/>
                                                    </t>
                                                    <t t-if="task.time_by_user and task.time_by_user.length">
                                                        <div t-foreach="task.time_by_user" t-as="tu" t-key="tu.user_id" class="text-muted small">
                                                            <i class="fa fa-user me-1"/><t t-esc="tu.user_name"/><t t-if="tu.is_current"> <span class="text-success fw-semibold">(currently working)</span></t> — <span class="fw-semibold" t-esc="tu.display"/>
                                                        </div>
                                                    </t>
                                                    <t t-else="">
                                                        <div class="text-muted small">
                                                            <i class="fa fa-user me-1"/>Developer: <t t-esc="task.user_name"/>
                                                        </div>
                                                    </t>
                                                    <t t-if="task.is_self_created and !task.admin_accepted">
                                                        <div class="mt-1">
                                                            <span class="badge bg-info text-dark">Self-Created · Pending Review</span>
                                                        </div>
                                                    </t>
                                                    <!-- What the developer asked for, shown while it still
                                                         differs from what is set. Once an admin agrees (or
                                                         never changes it) the two match and this is noise,
                                                         so it hides itself. -->
                                                    <!-- Why this finished task is back in the developer's
                                                         lane. Without it, work they believed was done
                                                         simply reappears with no explanation. -->
                                                    <t t-if="task.reverted_from">
                                                        <div class="mt-1">
                                                            <!-- White with a dark border rather than solid
                                                                 black: this badge lands on the amber Paused
                                                                 card, and dark-on-dark hid the text it
                                                                 exists to show. White reads on every lane
                                                                 colour, which is the point of a badge that
                                                                 can appear anywhere. -->
                                                            <span class="badge bg-white text-dark border border-2 border-warning">
                                                                <i class="fa fa-undo me-1"/>Reverted from Awaiting Client
                                                            </span>
                                                            <div t-if="task.revert_reason" class="text-muted small mt-1" style="white-space:pre-wrap;">
                                                                <t t-esc="task.revert_reason"/>
                                                            </div>
                                                        </div>
                                                    </t>
                                                    <t t-if="task.requested_priority and task.requested_priority !== task.priority">
                                                        <div class="text-muted small mt-1">
                                                            <i class="fa fa-flag me-1"/>Developer asked for
                                                            <b><t t-esc="priorityLabel(task.requested_priority)"/></b>
                                                        </div>
                                                    </t>
                                                    <!-- Why Start is greyed out, and when it will un-grey.
                                                         Without this the button is simply dead with no
                                                         explanation, which is what made the old workflow
                                                         feel broken rather than merely slow. -->
                                                    <!-- Driven by the LABEL, not by can_start: gateLabel
                                                         returns '' for finished work, and gating on
                                                         can_start alone rendered an empty badge there. -->
                                                    <t t-if="gateLabel(task)">
                                                        <div class="mt-1">
                                                            <span class="badge bg-warning text-dark">
                                                                <i class="fa fa-hourglass-half me-1"/><t t-esc="gateLabel(task)"/>
                                                            </span>
                                                        </div>
                                                    </t>
                                                    <!-- Released on silence, NOT approved. Say so on the card:
                                                         the developer may work, but the client never agreed and
                                                         the task is not billable until they sign off. -->
                                                    <t t-if="task.pre_approval_auto_released and !task.pre_approval_decision">
                                                        <div class="mt-1">
                                                            <span class="badge bg-secondary"
                                                                  title="The client did not reply within the approval window, so work was released. This is not their approval — they can still object, and sign-off is still required before billing.">
                                                                <i class="fa fa-unlock me-1"/>Released — no client reply
                                                            </span>
                                                        </div>
                                                    </t>
                                                    <t t-if="task.admin_accepted_auto">
                                                        <div class="mt-1">
                                                            <span class="badge bg-light text-dark border"
                                                                  title="No admin actioned this within the accept window, so it was accepted automatically. You can still re-categorise or reject it.">
                                                                <i class="fa fa-clock-o me-1"/>Auto-accepted
                                                            </span>
                                                        </div>
                                                    </t>
                                                    <!-- Send-back conversation: YOUR note is green, the OTHER person's is red -->
                                                    <t t-if="task.is_self_created and !task.admin_accepted and task.self_review_note">
                                                        <div t-att-class="(state.isAdmin ? 'text-success' : 'text-danger') + ' small mt-1'" style="white-space: pre-wrap;">
                                                            <i class="fa fa-reply"></i> <b><t t-esc="task.self_review_by or 'Admin'"/>:</b> <t t-esc="task.self_review_note"/>
                                                        </div>
                                                    </t>
                                                    <t t-if="task.is_self_created and !task.admin_accepted and task.self_resume_note">
                                                        <div t-att-class="(state.isAdmin ? 'text-danger' : 'text-success') + ' small mt-1'" style="white-space: pre-wrap;">
                                                            <i class="fa fa-user"></i> <b><t t-esc="task.self_resume_by or 'Developer'"/>:</b> <t t-esc="task.self_resume_note"/>
                                                        </div>
                                                    </t>
                                                    <div t-att-class="'small ' + (task.task_state === 'in_progress' ? 'text-success fw-bold' : 'text-muted')">
                                                        <t t-if="task.task_state === 'in_progress'">
                                                            <i class="fa fa-clock-o"></i> 
                                                        </t>
                                                        Time: <t t-esc="getDisplayTime(task)"/>
                                                    </div>
                                                    <div class="text-muted small">
                                                        Estimate: <t t-esc="task.estimate_display"/>
                                                        <span t-if="task.estimate_extension_count"
                                                              class="badge bg-info-subtle text-dark ms-1"
                                                              t-att-title="'Extended ' + task.estimate_extension_count + ' time(s) by ' + (task.estimate_extended_by_name || 'someone')">
                                                            <i class="fa fa-arrow-up"/> extended <t t-esc="task.estimate_extension_count"/>
                                                        </span>
                                                    </div>
                                                    <!-- The reason lives on the card, not buried in the audit log:
                                                         an estimate that grew without explanation reads exactly like
                                                         an estimate that was wrong. -->
                                                    <div t-if="task.estimate_extend_reason"
                                                         class="small text-muted fst-italic text-truncate"
                                                         t-att-title="task.estimate_extend_reason">
                                                        <i class="fa fa-sticky-note-o me-1"/>
                                                        <t t-esc="task.estimate_extend_reason"/>
                                                    </div>
                                                    <!-- Why this task is stopped, on the card itself. The payload
                                                         has always carried paused_reason, but the web only ever
                                                         showed it inside the Resume dialog — so the board could
                                                         not answer "why is this paused?" without opening each one.
                                                         The app has shown it on the card all along; this is the
                                                         web catching up.
                                                         Limited to the paused-ish states because the same field
                                                         also stores rejection and revert text, which have their
                                                         own badges and would otherwise appear twice. -->
                                                    <t t-if="task.paused_reason and ['paused', 'hold', 'rework'].includes(task.task_state)">
                                                        <div class="mt-1">
                                                            <span class="badge bg-warning-subtle text-dark border border-warning d-inline-block text-truncate mw-100"
                                                                  t-att-title="task.paused_reason">
                                                                <i class="fa fa-pause-circle me-1"></i><t t-esc="task.paused_reason"/>
                                                            </span>
                                                        </div>
                                                    </t>
                                                    <!-- Show completion info for partially completed tasks -->
                                                    <t t-if="col.key === 'partially_completed'">
                                                        <div class="text-success small mt-2">
                                                            <i class="fa fa-check-circle"></i> Completed by: <t t-esc="task.completed_by_name"/>
                                                        </div>
                                                        <div class="text-muted small">
                                                            <i class="fa fa-calendar"></i> <t t-esc="formatDate(task.completion_date)"/>
                                                        </div>
                                                        <t t-if="task.coordinator_review_started_at">
                                                            <div class="text-info small">
                                                                <i class="fa fa-eye"></i> Review started: <t t-esc="formatDate(task.coordinator_review_started_at)"/>
                                                                <t t-if="task.coordinator_review_started_by_name"> by <t t-esc="task.coordinator_review_started_by_name"/></t>
                                                            </div>
                                                        </t>
                                                    </t>
                                                    <t t-if="task.progress_count > 0">
                                                        <div class="text-success small">
                                                            <i class="fa fa-check-circle"></i> <t t-esc="task.progress_count"/> updates
                                                        </div>
                                                    </t>

                                                   <div class="mt-2 d-flex flex-wrap gap-2 align-items-center">
                                                        <t t-set="btns" t-value="getButtonsForState(task)"/>
                                                        <button class="btn btn-sm btn-primary"
                                                                t-if="btns.start"
                                                                t-att-disabled="btns.startDisabled"
                                                                t-att-title="btns.startTitle"
                                                                t-on-click="() => openStartModal(task)">Start</button>
                                                        <button class="btn btn-sm btn-warning"
                                                                t-if="btns.pause"
                                                                t-on-click="() => openPauseModal(task)">Pause</button>
                                                        <!-- Hand THIS task over to another one. Sits next to
                                                             Pause because it is the same decision made
                                                             differently: stop this, and say what you moved to.
                                                             Per-card on purpose — with multitask running, only
                                                             this task pauses and the others carry on. -->
                                                        <button class="btn btn-sm btn-outline-primary"
                                                                t-if="btns.pause"
                                                                title="Pause this and start another task — anything else you're running keeps going"
                                                                t-on-click="() => openSwitchTask(task)">
                                                            <i class="fa fa-exchange me-1"/>Switch
                                                        </button>
                                                        <button class="btn btn-sm btn-success"
                                                                t-if="btns.resume"
                                                                t-att-disabled="btns.resumeDisabled"
                                                                t-att-title="btns.resumeTitle"
                                                                t-on-click="() => openResumeModal(task)">Resume</button>
                                                        <button class="btn btn-sm btn-danger"
                                                                t-if="btns.complete"
                                                                t-on-click="() => openCompleteFromCard(task)">
                                                            <i class="fa fa-check-circle"></i> Complete
                                                        </button>
                                                        <button class="btn btn-sm kpi-btn-partial"
                                                                t-if="btns.complete"
                                                                t-on-click="() => openPartialFinishModal(task)"
                                                                title="Send a summary now and finish this task without the full checklist">
                                                            <i class="fa fa-flag-checkered"></i> Partial Finish
                                                        </button>
                                                        <!-- Not on finished work. Reassigning a COMPLETED task
                                                             moves whose name is on work that is already done
                                                             and signed off — it rewrites history rather than
                                                             changing who does something. -->
                                                        <button class="btn btn-sm btn-secondary"
                                                                t-if="state.isAdmin and task.task_state !== 'completed'"
                                                                t-on-click="() => openReassignModal(task)">Reassign</button>
                                                        <!-- 🆕 NEW: Manager-only approval buttons -->
                                                        <t t-if="state.isAdmin and col.key === 'partially_completed'">
                                                            <button class="btn btn-sm btn-success"
                                                                    t-on-click="() => openApproveModal(task)">
                                                                <i class="fa fa-check"></i> Approve
                                                            </button>
                                                            <button class="btn btn-sm btn-danger"
                                                                    t-on-click="() => openRejectModal(task)">
                                                                <i class="fa fa-times"></i> Reject
                                                            </button>
                                                        </t>
                                                        <!-- Add time lives with the other actions, not wedged into the
                                                             Estimate text line where it read as part of the number
                                                             rather than as something you press. Only while the task is
                                                             live and near its estimate; the server enforces the same
                                                             rule, so this only keeps the button honest. -->
                                                        <button t-if="canAddTime(task)" type="button"
                                                                class="btn btn-sm kpi-btn-addtime"
                                                                title="Add time to this estimate"
                                                                t-on-click="() => this.addTimePrompt(task)">
                                                            <i class="fa fa-hourglass-half"></i> Add time
                                                        </button>
                                                        <!-- Admin: remove a task nobody has worked on. can_admin_delete
                                                             is the SERVER's answer (kra.kpi._may_admin_delete), never
                                                             re-derived here, so the button can't offer what the route
                                                             would refuse. -->
                                                        <button class="btn btn-sm btn-outline-danger"
                                                                t-if="task.can_admin_delete"
                                                                t-on-click="() => this.adminDeleteTask(task)"
                                                                title="Delete this task — only possible while no time has been logged against it">
                                                            <i class="fa fa-trash"></i> Delete
                                                        </button>
                                                        <!-- Pull a task back off the client's desk. Admin only,
                                                             and only while it is actually waiting on the client:
                                                             a task the client has already signed is the basis of
                                                             an invoice and is not revertable here. -->
                                                        <t t-if="state.isAdmin and task.task_state === 'awaiting_client'">
                                                            <!-- Amber, not black: this sits on the blue
                                                                 Awaiting-Client card, where a solid dark
                                                                 button swallowed its own label. Amber also
                                                                 reads as "send back", distinct from the
                                                                 red destructive actions. -->
                                                            <button class="btn btn-sm btn-warning text-dark fw-semibold"
                                                                    title="Send this back to the developer — the client stops seeing it"
                                                                    t-on-click="() => this.openRevertSignoff(task)">
                                                                <i class="fa fa-undo"></i> Revert
                                                            </button>
                                                        </t>
                                                        <!-- Self-created Pending Review: admin Accept / send back -->
                                                        <t t-if="state.isAdmin and col.key === 'self_pending'">
                                                            <button class="btn btn-sm btn-success"
                                                                    t-on-click="() => this.acceptSelfTask(task)">
                                                                <i class="fa fa-check"></i> Accept
                                                            </button>
                                                            <button class="btn btn-sm btn-outline-danger"
                                                                    t-on-click="() => this.rejectSelfTask(task)">
                                                                <i class="fa fa-times"></i> Reject
                                                            </button>
                                                        </t>
                                                    </div>
                                                </div>
                                            </t>
                                        </t>
                                        <t t-if="!filteredTasks.length">
                                            <div class="text-center text-muted small py-4">
                                                <i class="fa fa-inbox d-block mb-2" style="font-size:1.8rem; opacity:.35;"></i>
                                                Nothing here yet
                                            </div>
                                        </t>
                                    </div>
                                </div>
                            </div>
                        </t>
                    </div>

                    <!-- Modal Container -->
                    <div id="modalContainer"></div>
                </div>
            </t>
        </div>
    `;

    // Kanban columns shown on the board.  The working buckets are visible to
    // every role — developers see Pending Approvals / Awaiting Client /
    // Completed for visibility into their tasks' downstream state, but action
    // buttons on those columns remain admin/manager-only.
    //
    // Paid is the exception: it is billing history, its tasks are archived out
    // of the developer's world entirely, and the route behind it refuses anyone
    // who is not an admin — so the lane would only ever render empty for them.
    get columns() {
        if (this.state.isAdmin) return this._allColumns;
        return this._allColumns.filter(c => c.key !== 'paid');
    }
    // Extending an estimate is for work still in flight. Once the client has signed
    // off, that number is what they accepted — and may be what they were billed on —
    // so those states get no button. The server enforces the same list; this only
    // stops the button appearing where it would be refused.
    // Offered on work that is actually being done — In Progress and Paused — and only
    // once it is near or past its estimate. Presentation only: the server still allows
    // any state the client does not own, because the mobile app may offer the action
    // from somewhere else and a stricter server would break it.
    //
    // A task with NO estimate (00:00) is past 80% from its first second, so the button
    // shows immediately there. That is intended — a task being worked with no estimate
    // is exactly the one that needs a number.
    canAddTime(task) {
        if (!['in_progress', 'paused'].includes(task.task_state)) return false;
        if (!(this.state.isAdmin || task.user_id === this.state.currentUserId)) return false;
        const estSec = ((task.estimate_hours || 0) * 3600) + ((task.estimate_minutes || 0) * 60);
        if (estSec <= 0) return true;
        return (task.timer_total_seconds || 0) >= estSec * 0.8;
    }
    // "02:10", and the shortfall/remainder against an estimate, for the dialog.
    _hhmm(totalMinutes) {
        const m = Math.max(0, Math.round(totalMinutes));
        return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    }
    _humanMins(mins) {
        const m = Math.round(mins);
        if (m < 60) return `${m}m`;
        const h = Math.floor(m / 60), r = m % 60;
        return r ? `${h}h ${r}m` : `${h}h`;
    }
    // What the estimate becomes, and — the number that actually matters — how much is
    // left to work once it does. Adding an hour when you are already ten minutes over
    // buys fifty more minutes, not sixty, because the addition applies to the estimate
    // rather than to the clock from now. That caught you out; now it is on screen.
    // The log stores raw JSON; the row shows the human half of it. Falls back to the
    // raw payload rather than blanking, so an event type this does not know about is
    // still legible instead of silently empty.
    // Buckets the log by day, newest first. The server already sends `at` as
    // "YYYY-MM-DD HH:MM:SS" in the user's timezone, so the split is positional and there
    // is no second date format to keep in step with the rest of the screens.
    activityGroups() {
        const rows = this.state.detailData.activity_log || [];
        const byDate = new Map();
        for (const ev of rows) {
            const date = String(ev.at || '').slice(0, 10) || 'unknown';
            if (!byDate.has(date)) byDate.set(date, []);
            byDate.get(date).push({ ...ev, time: String(ev.at || '').slice(11, 16) });
        }
        return [...byDate.entries()]
            .sort((a, b) => (a[0] < b[0] ? 1 : -1))
            .map(([date, entries]) => ({ date, entries, label: this._dayLabel(date) }));
    }
    _dayLabel(date) {
        const d = new Date(date + 'T00:00:00');
        if (isNaN(d)) return date;
        return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
    }
    toggleActivityDate(d) {
        this.state.activityExpanded[d] = !this.state.activityExpanded[d];
    }
    isActivityDateOpen(d) {
        return !!this.state.activityExpanded[d];
    }
    openActivity() {
        // Newest day open, the rest folded: opening fully collapsed means a click before
        // you can read anything, and fully expanded is the wall the popup exists to avoid.
        // Reset each time, so it never reopens in a half-open state from last visit.
        const groups = this.activityGroups();
        this.state.activityExpanded = groups.length ? { [groups[0].date]: true } : {};
        this.state.activityOpen = true;
    }
    activityDetail(ev) {
        let p = {};
        try { p = JSON.parse(ev.detail || '{}'); } catch (e) { return ev.detail || ''; }
        if (ev.event === 'estimate_extended') {
            return `${p.from} → ${p.to}` + (p.reason ? ` · "${p.reason}"` : '');
        }
        if (p.reason) return String(p.reason);
        if (p.note) return String(p.note);
        const bits = Object.entries(p).filter(([k]) => k !== 'kpi_id')
            .map(([k, v]) => `${k}: ${v}`).join(' · ');
        return bits.slice(0, 160);
    }
    dlgLiveNote() {
        const c = this.state.dlg.ctx;
        if (!c) return { text: '', cls: '' };
        const added = ((this.state.dlg.numVals.hours || 0) * 60)
                    + (this.state.dlg.numVals.minutes || 0);
        const newEst = c.estMin + added;
        const left = newEst - c.workedMin;
        if (added <= 0) return { text: 'Enter how much to add.', cls: 'text-muted' };
        if (left <= 0) {
            return { text: `New estimate ${this._hhmm(newEst)} · still `
                         + `${this._humanMins(-left)} over`, cls: 'text-danger' };
        }
        return { text: `New estimate ${this._hhmm(newEst)} · ${this._humanMins(left)} left`,
                 cls: 'text-success' };
    }
    async addTimePrompt(task) {
        const estMin = ((task.estimate_hours || 0) * 60) + (task.estimate_minutes || 0);
        const workedMin = Math.round((task.timer_total_seconds || 0) / 60);
        const over = workedMin - estMin;
        const worked = `${this._hhmm(workedMin)}`
            + (estMin > 0 && over > 0 ? `   ⚠ ${this._humanMins(over)} over` : '');
        const vals = await this._dialog({
            title: `Add time — ${task.name}`,
            message: `Current estimate   ${task.estimate_display || '00:00'}\n`
                   + `Worked so far      ${worked}\n\n`
                   + 'This is ADDED to the estimate, not a new total.',
            nums: [{ key: 'hours', label: 'Hours', value: 0 },
                   { key: 'minutes', label: 'Minutes', value: 0 }],
            ctx: { estMin, workedMin },
            footNote: 'The reason shows on the task card, so write it for whoever reads the board.',
            input: true, inputLabel: 'Reason', required: true,
            placeholder: 'e.g. client added two more screens',
            okLabel: 'Add time', okClass: 'btn-primary',
        });
        if (!vals) return;
        const r = await rpc('/kra_kpi/task/add_time', {
            kpi_id: task.id,
            hours: vals.hours || 0,
            minutes: vals.minutes || 0,
            reason: vals.text || '',
        });
        if (!r || !r.status) {
            this._toast((r && r.message) || 'Could not add time.', 'danger');
            return;
        }
        this._toast(r.message, 'success');
        await this.refresh();
    }
    async _loadPaidTasks() {
        try {
            const r = await rpc('/kra_kpi/tasks/paid', {});
            if (r && r.status) {
                this.state.paidTasks = r.tasks || [];
                this.state.paidTruncated = !!r.truncated;
            }
        } catch (e) {
            // A failed archive lane must never take the working board down with it.
            console.warn('paid lane unavailable', e);
        }
    }
    // Worked longer than it was estimated at. No estimate means no target, so
    // nothing is "over" — otherwise every unestimated task would flag red.
    paidOverEstimate(pt) {
        const est = ((pt.estimate_hours || 0) * 3600) + ((pt.estimate_minutes || 0) * 60);
        return est > 0 && (pt.timer_total_seconds || 0) > est;
    }

    setup() {
        // Action service — used to bounce back to the PIN gate when the device
        // gets un-paired (auto-away) so an unpaired board is never shown.
        this.actionService = useService("action");
        this.state = useState({
            // Promise-driven in-page dialog, replacing window.confirm/prompt.
            // Those are the browser's chrome, not ours: unstyleable, and on a work
            // screen they read as something having gone wrong.
            dlg: { open: false, title: '', message: '', okLabel: 'OK', okClass: 'btn-primary',
                   input: false, inputLabel: '', placeholder: '', required: false,
                   value: '', error: '', resolve: null,
                   // Optional numeric fields, e.g. the hours/minutes on Add time.
                   nums: [], numVals: {}, footNote: '', ctx: null },
            // Replaces alert(). A browser alert blocks the whole tab and hides the
            // screen it is talking about; this sits in the page and can be ignored.
            toast: { show: false, text: '', kind: 'warning' },
            view: 'list',
            detailKpiId: null,
            detailData: {},
            detailLoaded: false,
            detailError: null,
            tasksByState: {},
            activityOpen: false,      // the Activity popup
            activityExpanded: {},     // which day sections are open, keyed by date
            paidTasks: [],        // settled work, admin-only Paid lane (own route — archived)
            paidTruncated: false, // more paid tasks exist than the lane shows
            allTasks: [],  // 🆕 NEW: Store all tasks for filtering
            assignees: [], // 🆕 NEW: Store unique assignees for filter dropdown
            isAdmin: false,
            selfPendingCount: 0,  // 🆕 Self-created tasks awaiting admin Accept
            currentUserId: null,  // 🆕 NEW: Store current user ID from API
            showMyTasksOnly: false,  // 🆕 NEW: Toggle for My Tasks filter
            workdayOpen:    false,   // green Start Workday button visible while false
            workdayPaused:  false,   // open but frozen — Presence stopped, tasks blocked
            workdayClosed:  false,   // a closed session today with no open one (e.g. cron auto-closed)
            dayDone:        false,   // developer ENDED today themselves → one start + one end per day (no restart)
            reopenReason:   '',      // an admin reopened this day — shown under the workday button
            reopenedBy:     '',
            // 🆕 NEW: Filter state variables
            searchQuery: '',
            filters: {
                assignee: '',
                priority: '',
                status: '',
            },
            progressUpdates: [],
            showRejectionModal: false,
            rejectedTasks: [],
            seenRejectionIds: [],  // 🆕 NEW: Track which rejected tasks we've already shown
            progressForm: {
                summary: '',
                uploaded_file: null,
                file_name: '',
                related_links: [],  // 🆕 NEW
                link_input: '',
                github_url: '',
                branch_name: '',
            },
            githubLinks: [],
            manualsList: [],
            
            manualForm: {
                file: null,           // the File itself — posted as multipart
                file_data: null,      // legacy base64 slot, no longer written
                file_name: '',
                size_display: '',
                description: '',
                related_links: [],    // 🆕 NEW: For user manual links
                link_input: '',
                uploading: false,
                percent: 0,
                sent_display: '',     // "3.2 MB / 12.0 MB"
                speed_display: '',    // "1.4 MB/s"
                eta_display: '',      // "12s"
                error: '',
                xhr: null,            // kept so Cancel can abort
            },
            showManualUpload: false,
            selectedKpi: null,
            selectedUser: '',
            assigneesList: [],
            pauseReason: '',
            reassignReason: '',  // 🆕 NEW
            rejectionReason: '',  // 🆕 NEW
            reassignmentHistory: [],  // 🆕 NEW
            attachedFiles: [],
            // Part E: consolidated sortable resource sections
            docSections: { github: [], documents: [], drive: [] },
            resSort: { github: 'newest', documents: 'newest', drive: 'newest' },
            // Part F: live file upload progress
            uploadState: { active: false, percent: 0, loaded: 0, total: 0, error: '', xhr: null },
            currentTime: Date.now(),  // 🆕 NEW: For real-time timer updates
            metaEdit: { editing: false, saving: false, name: '', type: '', kra_id: '' },
            // 🆕 Part B: in-detail "Complete This Task" checklist + submit lock
            completeChecklist: {
                verify_github: false, deployed_task: false, user_manual: false,
                documentation: false, tested_code: false,
            },
            completeSubmitting: false,
            // 🆕 Part C: live activity strip + auto-away
            liveStatus: null,       // {active_task, login_raw, productive_base, workday_open, nontask, idle_prompt}
            liveBreak: null,        // active break {type, start_raw, start_display, source_task_name, reason_note}
            awayAfterMinutes: 5,    // company setting; drives the banner text
            // "Not on a task?" — Meeting / Break / No tasks.
            idleModalOpen: false,
            idleBusy: '',           // the reason code in flight
            idleNote: '',           // optional, shows on the Workday Map
            nontaskBusy: false,
            // Switching ENDS the running block and starts another — a real edit to
            // the day, and a mis-click would cut a meeting short. Confirm first.
            switchTo: null,         // an IDLE_REASONS entry, or null
        });

        // Which idle prompt (1..3) has already been shown. The server asks via a
        // notification that carries no kpi_id, so it can't be clicked through —
        // the board raises the popup instead. Keyed on the prompt NUMBER, not a
        // boolean: dismissing #1 must not swallow #2 and #3, or the cap-of-3
        // would silently become a cap-of-1. Not in state — no re-render needed.
        this._idleAskedSeq = 0;
        
        // 🆕 NEW: Timer interval reference for cleanup
        this.timerInterval = null;

        // Master column list — kept as an instance constant so loops in refresh()
        // can iterate every bucket key (including hidden ones) and route tasks
        // into the correct group even when the developer view filters columns.
        this._allColumns = [
            // First on purpose. The problem it solves is finding something again:
            // start task 1, pause, task 2, pause, task 3 — then going back to task 1
            // meant hunting through every paused task, where one paused ten minutes
            // ago looks identical to one paused three weeks ago. A lane you have to
            // scroll to would not have fixed that.
            //
            // Tasks here are ALSO in their status column; see the grouping loop.
            { key: "today",        label: "🕒 Today" },
            { key: "self_pending", label: "🆕 Pending Review" },
            { key: "regular",     label: "Regular" },
            { key: "important",   label: "Important" },
            { key: "urgent",      label: "Urgent" },
            { key: "in_progress", label: "In Progress" },
            { key: "paused",      label: "Paused" },
            { key: "partially_completed", label: "Pending Approvals" },
            { key: "awaiting_client", label: "Awaiting Client Sign-off" },  // admin approved, client to sign
            { key: "completed",   label: "Completed" },
            // Billed and settled. Admin-only — see the `columns` getter.
            { key: "paid",        label: "Paid" },
        ];

        this.refresh = this.refresh.bind(this);
        this.formatTime = this.formatTime.bind(this);
        this.getDisplayTime = this.getDisplayTime.bind(this);  // 🆕 NEW: Bind real-time timer method
        this.formatDate = this.formatDate.bind(this);
        
        // Modal methods
        this.openStartModal = this.openStartModal.bind(this);
        this.openPauseModal = this.openPauseModal.bind(this);
        this.openResumeModal = this.openResumeModal.bind(this);
        this.openCompleteModal = this.openCompleteModal.bind(this);
        this.openReassignModal = this.openReassignModal.bind(this);
        this.openApproveModal = this.openApproveModal.bind(this);  // 🆕 NEW
        this.openRejectModal = this.openRejectModal.bind(this);    // 🆕 NEW
        this.openEndWorkdayModal = this.openEndWorkdayModal.bind(this); // End Workday popup
        this.closeModal = this.closeModal.bind(this);
        this.closeRejectionModal = this.closeRejectionModal.bind(this);
        this.checkForRejectedTasks = this.checkForRejectedTasks.bind(this);
        this.extractRejectionReason = this.extractRejectionReason.bind(this);
        
        // Action methods
        this.confirmStart = this.confirmStart.bind(this);
        this.confirmPause = this.confirmPause.bind(this);
        this.confirmResume = this.confirmResume.bind(this);
        this.confirmComplete = this.confirmComplete.bind(this);
        // Switch task. Bound like every other template-invoked method: OWL calls
        // these off the context, so an unbound one arrives with `this` undefined
        // and dies on the first this.* it touches.
        this.openSwitchTask = this.openSwitchTask.bind(this);
        // 🆕 Part B: wrap-up actions
        this.openCompleteFromCard = this.openCompleteFromCard.bind(this);
        this.openPartialFinishModal = this.openPartialFinishModal.bind(this);
        this.confirmPartialFinish = this.confirmPartialFinish.bind(this);
        this.confirmCompleteFromDetail = this.confirmCompleteFromDetail.bind(this);
        this.confirmReassign = this.confirmReassign.bind(this);
        this.confirmApprove = this.confirmApprove.bind(this);  // 🆕 NEW
        this.confirmReject = this.confirmReject.bind(this);    // 🆕 NEW
        
        this.openKpiDetail = this.openKpiDetail.bind(this);
        this.backToList = this.backToList.bind(this);
        this.loadKpiDetail = this.loadKpiDetail.bind(this);
        this.loadProgressUpdates = this.loadProgressUpdates.bind(this);
        this.loadReassignmentHistory = this.loadReassignmentHistory.bind(this);  // 🆕 NEW
        this.handleProgressFileUpload = this.handleProgressFileUpload.bind(this);
        this.submitProgressUpdate = this.submitProgressUpdate.bind(this);
        this.yesNo = this.yesNo.bind(this);
        this.loadUserManualInfo = this.loadUserManualInfo.bind(this);
        this.handleManualUpload = this.handleManualUpload.bind(this);
        this.submitUserManual = this.submitUserManual.bind(this);
        this.addLink = this.addLink.bind(this);
        this.removeLink = this.removeLink.bind(this);
        this.addManualLink = this.addManualLink.bind(this);
        this.removeManualLink = this.removeManualLink.bind(this);
        // 🆕 NEW: Bind GitHub-related methods
        this.addGithubLink = this.addGithubLink.bind(this);
        this.loadGithubLinks = this.loadGithubLinks.bind(this);
        this.deleteGithubLink = this.deleteGithubLink.bind(this);
        this.isValidGithubUrl = this.isValidGithubUrl.bind(this);
        // 🆕 NEW: Bind task filter toggle method
        this.setTaskFilter = this.setTaskFilter.bind(this);
        
        // 🆕 NEW: Bind filter methods
        this.onSearchInput = this.onSearchInput.bind(this);
        this.onAssigneeChange = this.onAssigneeChange.bind(this);
        this.onPriorityChange = this.onPriorityChange.bind(this);
        this.onStatusChange = this.onStatusChange.bind(this);
        this.clearSearch = this.clearSearch.bind(this);
        this.clearAssigneeFilter = this.clearAssigneeFilter.bind(this);
        this.clearPriorityFilter = this.clearPriorityFilter.bind(this);
        this.clearStatusFilter = this.clearStatusFilter.bind(this);
        this.clearAllFilters = this.clearAllFilters.bind(this);
        this.hasActiveFilters = this.hasActiveFilters.bind(this);
        this.getFilteredTasksByState = this.getFilteredTasksByState.bind(this);
        this.getAssigneeName = this.getAssigneeName.bind(this);
        this.getPriorityLabel = this.getPriorityLabel.bind(this);
        this.getStatusLabel = this.getStatusLabel.bind(this);
        this.getTotalFilteredCount = this.getTotalFilteredCount.bind(this);
        this.getTotalTaskCount = this.getTotalTaskCount.bind(this);

        onWillStart(async () => {
            await this.refresh();
        });

        // Refs for the top-scrollbar sync (kanban-scrolls-horizontally pattern)
        this.kpiScrollTop = useRef('kpiScrollTop');
        this.kpiScrollTopInner = useRef('kpiScrollTopInner');
        this.kpiKanbanRow = useRef('kpiKanbanRow');

        onMounted(() => {
            // Read the workday session state (DOES NOT create one).  This
            // drives whether we render the green Start Workday button or the
            // red End Workday button in the header.
            this._loadWorkdayStatus();

            // Sync the top scrollbar with the kanban row
            this._setupTopScrollSync();

            // 🆕 UPDATED: Real-time timer update every second
            this.timerInterval = setInterval(() => {
                if (this.state.view === 'list') {
                    // Update currentTime to trigger re-render for running timers
                    this.state.currentTime = Date.now();
                }
            }, 1000);
            
            // Refresh data every 30 seconds (reduced from 5 seconds since timers are now real-time)
            this.refreshInterval = setInterval(() => {
                if (this.state.view === 'list') {
                    this.refresh();
                }
            }, 30000);
            
            // 🆕 NEW: Reminder and deadline check interval (every 30 seconds)
            this.reminderInterval = setInterval(() => {
                if (this.state.view === 'list') {
                    this.checkRemindersAndDeadlines();
                }
            }, 30000);
            
            // Initial reminder check after 2 seconds
            setTimeout(() => {
                this.checkRemindersAndDeadlines();
            }, 2000);

            // 🆕 Part C: live status + heartbeat + auto-away.
            this.loadLiveStatus();
            this.sendHeartbeat();
            rpc('/kpi_config/get', {}).then((r) => {
                if (r && r.status && r.away_after_minutes != null) {
                    this.state.awayAfterMinutes = r.away_after_minutes;
                }
            }).catch(() => {});
            // Heartbeat every 15s keeps the session "alive": drives the auto-away
            // cron AND lets the app return to the PIN screen ~30s after the tab is
            // closed (kpi.pair heartbeat grace). Frequent enough that a page
            // refresh's brief gap never trips the 30s grace.
            this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), 15000);
            // Refresh the live strip data (active break, anchors) every 30s.
            this.liveStatusInterval = setInterval(() => {
                if (this.state.view === 'list') { this.loadLiveStatus(); }
            }, 30000);
            // Warn before CLOSING or RELOADING the tab (browser's native "Leave
            // site?") while a task is running, so nobody walks away from a live
            // timer by accident. It is only a warning now — closing the tab no
            // longer pauses anything or un-pairs anything, so coming back just
            // shows the board again exactly as it was.
            this._beforeUnloadHandler = (e) => {
                if (this.getActiveTask() || this.state.workdayOpen) {
                    e.preventDefault();
                    e.returnValue = '';
                    return '';
                }
            };
            window.addEventListener('beforeunload', this._beforeUnloadHandler);
        });

        // 🆕 NEW: Cleanup intervals when component is destroyed
        onWillUnmount(() => {
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
            }
            if (this.refreshInterval) {
                clearInterval(this.refreshInterval);
            }
            if (this.reminderInterval) {
                clearInterval(this.reminderInterval);
            }
            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
            }
            if (this.liveStatusInterval) {
                clearInterval(this.liveStatusInterval);
            }
            if (this._beforeUnloadHandler) {
                window.removeEventListener('beforeunload', this._beforeUnloadHandler);
            }
            // Navigating away used to fire a 'leaving' beacon that paused the task
            // and un-paired the device. Both are gone: leaving the board is not a
            // statement about whether you are working.
            if (this._scrollResizeHandler) {
                window.removeEventListener('resize', this._scrollResizeHandler);
            }
            if (this._scrollObserver) {
                this._scrollObserver.disconnect();
            }
        });
    }
    // 🆕 NEW: Approve Modal
    openApproveModal(task) {
        this.state.selectedKpi = task;
        // Stamp coordinator review-started (idempotent + state-gated server-side).
        this._markReviewStarted(task);

        // Initialize manager checklist state
        this.state.managerChecklist = {
            task_reviewed: false,
            manual_reviewed: false,
            testing_completed: false,
            github_verified: false,
            tested_successfully: false,
            docs_approved: false,
        };
        
        const modalHTML = `
            <div class="modal-backdrop fade show"></div>
            <div class="modal d-block" tabindex="-1">
                <div class="modal-dialog modal-lg">
                    <div class="modal-content">
                        <div class="modal-header bg-success text-white">
                            <h5 class="modal-title">✅ Approve Task - Coordinator Review</h5>
                            <button type="button" class="btn-close btn-close-white" id="closeModalBtn"></button>
                        </div>
                        <div class="modal-body" style="max-height: 70vh; overflow-y: auto;">
                            <p><strong>Task:</strong> ${task.name}</p>
                            <p><strong>Completed By:</strong> ${task.completed_by_name || 'Unknown'}</p>
                            <p><strong>Completion Date:</strong> ${this.formatDate(task.completion_date)}</p>
                            <p class="text-muted"><strong>Time Spent:</strong> ${this.formatTime(task.timer_total_seconds)}</p>
                            
                            <hr/>
                            
                            <!-- Employee Checklist Display -->
                            <div class="card p-3 mb-3 bg-light" id="employeeChecklistDisplay">
                                <h6 class="fw-bold mb-3">📝 Employee Checklist (Submitted):</h6>
                                <div class="text-muted text-center">
                                    <span class="spinner-border spinner-border-sm"></span> Loading employee checklist...
                                </div>
                            </div>
                            
                            <!-- Manager Approval Checklist -->
                            <div class="card p-3 mb-3 border-success">
                                <h6 class="fw-bold mb-3 text-success">✅ Coordinator Approval Checklist:</h6>
                                
                                <div class="form-check mb-2">
                                    <input class="form-check-input" type="checkbox" id="mgr_task_reviewed">
                                    <label class="form-check-label" for="mgr_task_reviewed">
                                        <strong>1. Task Reviewed</strong>
                                        <small class="d-block text-muted">I have reviewed all task deliverables</small>
                                    </label>
                                </div>
                                
                                <div class="form-check mb-2">
                                    <input class="form-check-input" type="checkbox" id="mgr_manual_reviewed">
                                    <label class="form-check-label" for="mgr_manual_reviewed">
                                        <strong>2. User Manual Reviewed</strong>
                                        <small class="d-block text-muted">Documentation quality is acceptable</small>
                                    </label>
                                </div>
                                
                                <div class="form-check mb-2">
                                    <input class="form-check-input" type="checkbox" id="mgr_testing_completed">
                                    <label class="form-check-label" for="mgr_testing_completed">
                                        <strong>3. Testing Completed</strong>
                                        <small class="d-block text-muted">All test scenarios have been executed</small>
                                    </label>
                                </div>
                                
                                <div class="form-check mb-2">
                                    <input class="form-check-input" type="checkbox" id="mgr_github_verified">
                                    <label class="form-check-label" for="mgr_github_verified">
                                        <strong>4. Verified Github Repositories</strong>
                                        <small class="d-block text-muted">Code is properly committed and pushed</small>
                                    </label>
                                </div>
                                
                                <div class="form-check mb-2">
                                    <input class="form-check-input" type="checkbox" id="mgr_tested_successfully">
                                    <label class="form-check-label" for="mgr_tested_successfully">
                                        <strong>5. Task Tested Successfully</strong>
                                        <small class="d-block text-muted">All features work as expected</small>
                                    </label>
                                </div>
                                
                                <div class="form-check mb-2">
                                    <input class="form-check-input" type="checkbox" id="mgr_docs_approved">
                                    <label class="form-check-label" for="mgr_docs_approved">
                                        <strong>6. Documentation Approved</strong>
                                        <small class="d-block text-muted">All documentation meets standards</small>
                                    </label>
                                </div>
                            </div>
                            
                            <div class="alert alert-success">
                                <i class="fa fa-check-circle"></i> <strong>Approve this task?</strong>
                                <p class="mb-0 mt-2">This will mark the task as fully completed and move it to the Completed column.</p>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button class="btn btn-secondary" id="cancelModalBtn">Cancel</button>
                            <button class="btn btn-success" id="confirmModalBtn">
                                <i class="fa fa-check"></i> Approve Task
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        this._renderModal(modalHTML, this.confirmApprove);
        
        // Load employee checklist after modal is rendered
        setTimeout(() => this.loadTaskChecklists(task.id), 100);
    }

    // 🆕 NEW: Reject Modal
    openRejectModal(task) {
        this.state.selectedKpi = task;
        this.state.rejectionReason = '';
        // Stamp coordinator review-started (idempotent + state-gated server-side).
        this._markReviewStarted(task);
        const modalHTML = `
            <div class="modal-backdrop fade show"></div>
            <div class="modal d-block" tabindex="-1">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header bg-danger text-white">
                            <h5 class="modal-title">❌ Reject Task</h5>
                            <button type="button" class="btn-close btn-close-white" id="closeModalBtn"></button>
                        </div>
                        <div class="modal-body">
                            <p><strong>Task:</strong> ${task.name}</p>
                            <p><strong>Completed By:</strong> ${task.completed_by_name || 'Unknown'}</p>
                            
                            <div class="alert alert-warning">
                                <i class="fa fa-exclamation-triangle"></i> <strong>Rejecting this task will:</strong>
                                <ul class="mb-0 mt-2">
                                    <li>Send the task to <strong>"Paused"</strong> state</li>
                                    <li>Show your feedback to the employee</li>
                                    <li>Employee must click <strong>"Resume"</strong> to continue</li>
                                    <li>Timer will remain stopped until employee resumes</li>
                                </ul>
                            </div>
                            
                            <div class="mb-3">
                                <label for="rejectionReason" class="form-label fw-bold">Reason for Rejection (required):</label>
                                <textarea id="rejectionReason" class="form-control" rows="3" 
                                          placeholder="Please explain what needs to be improved or corrected..."></textarea>
                                <small class="text-danger">This will be shown to the employee</small>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button class="btn btn-secondary" id="cancelModalBtn">Cancel</button>
                            <button class="btn btn-danger" id="confirmModalBtn">
                                <i class="fa fa-times"></i> Reject & Send Back
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        this._renderModal(modalHTML, this.confirmReject);
    }

    // 🆕 NEW: Confirm Approve
    async confirmApprove() {
        // Collect manager checklist values
        const managerChecklist = {
            task_reviewed: document.getElementById("mgr_task_reviewed")?.checked || false,
            manual_reviewed: document.getElementById("mgr_manual_reviewed")?.checked || false,
            testing_completed: document.getElementById("mgr_testing_completed")?.checked || false,
            github_verified: document.getElementById("mgr_github_verified")?.checked || false,
            tested_successfully: document.getElementById("mgr_tested_successfully")?.checked || false,
            docs_approved: document.getElementById("mgr_docs_approved")?.checked || false,
        };
        
        // Count checked items
        const checkedCount = Object.values(managerChecklist).filter(v => v).length;
        
        // Require all items to be checked for approval
        if (checkedCount < 6) {
            this._toast(`⚠️ Cannot approve: You must complete all 6 checklist items.\n\n` +
                `Currently completed: ${checkedCount}/6 items\n\n` +
                `Please verify all items before approving the task.`, 'warning');
            return; // Don't proceed with approval
        }
        
        const kpi_id = this.state.selectedKpi.id;
        this.closeModal();
        
        try {
            const result = await rpc("/kra_kpi/task/approve", { 
                kpi_id: kpi_id,
                manager_checklist: managerChecklist
            });
            
            if (result.status) {
                this._toast(`✅ Task approved successfully!\n\nAll ${checkedCount} review items completed.\n\nThe task has moved to "Awaiting Client Sign-off". The client will now see it in their portal for the final signature.`, 'success');
                await this.refresh();
            } else {
                this._toast("❌ Error: " + result.message, 'danger');
            }
        } catch (error) {
            console.error("Error approving task:", error);
            this._toast("Failed to approve task. Please try again.", 'danger');
        }
    }

    // 🆕 NEW: Confirm Reject
    async confirmReject() {
        const reason = document.getElementById("rejectionReason")?.value?.trim();
        
        if (!reason) {
            this._toast("Please enter a reason for rejecting the task.", 'warning');
            return;
        }
        
        if (reason.length < 10) {
            this._toast("Please provide a more detailed reason (at least 10 characters).", 'warning');
            return;
        }
        
        const kpi_id = this.state.selectedKpi.id;
        const task_name = this.state.selectedKpi.name;
        this.closeModal();
        
        try {
            const result = await rpc("/kra_kpi/task/reject", { 
                kpi_id: kpi_id,
                reason: reason
            });
            
            if (result.status) {
                this._toast(`✅ Task "${task_name}" has been rejected.\n\nThe task is now in "Paused" state with your feedback.\nThe employee must click "Resume" to continue working.`, 'success');
                await this.refresh();
            } else {
                this._toast("❌ Error: " + result.message, 'danger');
            }
        } catch (error) {
            console.error("Error rejecting task:", error);
            this._toast("Failed to reject task. Please try again.", 'danger');
        }
    }
    openCompleteModal(task) {
        this.state.selectedKpi = task;
        
        // Initialize employee checklist state
        this.state.employeeChecklist = {
            verify_github: false,
            deployed_task: false,
            user_manual: false,
            documentation: false,
            tested_code: false,
        };
        
        const modalHTML = `
            <div class="modal-backdrop fade show"></div>
            <div class="modal d-block" tabindex="-1">
                <div class="modal-dialog modal-lg">
                    <div class="modal-content">
                        <div class="modal-header bg-info text-white">
                            <h5 class="modal-title">✅ Complete Task - Employee Checklist</h5>
                            <button type="button" class="btn-close btn-close-white" id="closeModalBtn"></button>
                        </div>
                        <div class="modal-body">
                            <p><strong>Task:</strong> ${task.name}</p>
                            
                            <div class="alert alert-info">
                                <i class="fa fa-info-circle"></i> <strong>Before submitting:</strong>
                                <p class="mb-0 mt-2">Please confirm you have completed the following checklist items. Your task will be sent to your manager for approval.</p>
                            </div>
                            
                            <div class="card p-3 mb-3">
                                <h6 class="fw-bold mb-3">📋 Employee Completion Checklist:</h6>
                                
                                <div class="form-check mb-2">
                                    <input class="form-check-input" type="checkbox" id="check_verify_github">
                                    <label class="form-check-label" for="check_verify_github">
                                        <strong>1. Verify Github URL</strong>
                                        <small class="d-block text-muted">Confirmed all code is pushed to the correct repository</small>
                                    </label>
                                </div>
                                
                                <div class="form-check mb-2">
                                    <input class="form-check-input" type="checkbox" id="check_deployed_task">
                                    <label class="form-check-label" for="check_deployed_task">
                                        <strong>2. Deployed the Task</strong>
                                        <small class="d-block text-muted">Task has been deployed to staging/production</small>
                                    </label>
                                </div>
                                
                                <div class="form-check mb-2">
                                    <input class="form-check-input" type="checkbox" id="check_user_manual">
                                    <label class="form-check-label" for="check_user_manual">
                                        <strong>3. User Manual Uploaded</strong>
                                        <small class="d-block text-muted">Documentation is uploaded and accessible</small>
                                    </label>
                                </div>
                                
                                <div class="form-check mb-2">
                                    <input class="form-check-input" type="checkbox" id="check_documentation">
                                    <label class="form-check-label" for="check_documentation">
                                        <strong>4. Documentation Submission</strong>
                                        <small class="d-block text-muted">All technical documentation is complete</small>
                                    </label>
                                </div>
                                
                                <div class="form-check mb-2">
                                    <input class="form-check-input" type="checkbox" id="check_tested_code">
                                    <label class="form-check-label" for="check_tested_code">
                                        <strong>5. Manually Tested the Code</strong>
                                        <small class="d-block text-muted">All features tested and working as expected</small>
                                    </label>
                                </div>
                            </div>
                            
                            <p class="text-muted"><small><i class="fa fa-clock-o"></i> Time Spent: ${this.formatTime(task.timer_total_seconds)}</small></p>
                        </div>
                        <div class="modal-footer">
                            <button class="btn btn-secondary" id="cancelModalBtn">Cancel</button>
                            <button class="btn btn-danger" id="confirmModalBtn">
                                <i class="fa fa-paper-plane"></i> Submit for Approval
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        this._renderModal(modalHTML, this.confirmComplete);
    }

    async confirmComplete() {
        // Collect checklist values from checkboxes
        const employeeChecklist = {
            verify_github: document.getElementById("check_verify_github")?.checked || false,
            deployed_task: document.getElementById("check_deployed_task")?.checked || false,
            user_manual: document.getElementById("check_user_manual")?.checked || false,
            documentation: document.getElementById("check_documentation")?.checked || false,
            tested_code: document.getElementById("check_tested_code")?.checked || false,
        };
        
        // Count checked items
        const checkedCount = Object.values(employeeChecklist).filter(v => v).length;
        
        // Optional: Warn if not all items are checked
        if (checkedCount < 5) {
            const proceed = await this._confirm(
                'Checklist incomplete',
                `You have checked ${checkedCount} of 5 items.

`
                + 'You can send it for approval anyway, but the reviewer sees which '
                + 'items you skipped.',
                'Send anyway', 'btn-warning');
            if (!proceed) {
                return; // Don't close modal, let them check more items
            }
        }
        
        const kpi_id = this.state.selectedKpi.id;
        this.closeModal();
        
        try {
            const result = await rpc("/kra_kpi/task/complete", { 
                kpi_id: kpi_id,
                employee_checklist: employeeChecklist
            });
            
            if (result.status) {
                this._toast(`✅ Task marked as complete and sent for approval!\n\nChecklist completed: ${checkedCount}/5 items`, 'success');
                await this.refresh();
            } else {
                this._toast("❌ Error: " + result.message, 'danger');
            }
        } catch (error) {
            console.error("Error completing task:", error);
            this._toast("Failed to complete task. Please try again.", 'danger');
        }
    }

    // =========================================================
    // 🆕 Part B — Wrap-up actions
    //   • Partial Finish: submit a summary only → task goes to review, no checklist.
    //   • Complete: redirect to Details view and enforce summary + full checklist.
    // =========================================================

    // Card "Complete" → open the Details view where the enforced checklist lives.
    async openCompleteFromCard(task) {
        this.state.completeChecklist = {
            verify_github: false, deployed_task: false, user_manual: false,
            documentation: false, tested_code: false,
        };
        this.state.completeSubmitting = false;
        await this.openKpiDetail(task.id);
        // Auto-tick items we can already infer from what's attached.
        const c = this.state.completeChecklist;
        if ((this.state.githubLinks || []).length > 0) c.verify_github = true;
        if ((this.state.attachedFiles || []).length > 0) { c.user_manual = true; c.documentation = true; }
        // Nudge the user toward the Complete panel at the bottom of the detail.
        setTimeout(() => {
            const el = document.getElementById("kpiCompletePanel");
            if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 350);
    }

    // Card "Partial Finish" → single required summary, then finish as partial.
    openPartialFinishModal(task) {
        this.state.selectedKpi = task;
        const safeName = (task.name || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const modalHTML = `
            <div class="modal-backdrop fade show"></div>
            <div class="modal d-block" tabindex="-1">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header bg-warning">
                            <h5 class="modal-title">🏁 Partial Finish</h5>
                            <button type="button" class="btn-close" id="closeModalBtn"></button>
                        </div>
                        <div class="modal-body">
                            <p class="mb-2"><strong>Task:</strong> ${safeName}</p>
                            <div class="alert alert-warning py-2 mb-3">
                                <i class="fa fa-info-circle"></i>
                                This finishes the task <strong>as-is</strong> and sends it for review with just your
                                summary — no full checklist. Use <strong>Complete</strong> for fully-done work.
                            </div>
                            <label class="form-label fw-bold">Progress Summary <span class="text-danger">*</span></label>
                            <textarea id="partialSummary" class="form-control" rows="4"
                                      placeholder="What was done, what's left, why you're finishing now..."></textarea>
                            <div id="partialSummaryErr" class="text-danger small mt-1" style="display:none;">
                                Please enter a short summary before finishing.
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button class="btn btn-secondary" id="cancelModalBtn">Cancel</button>
                            <button class="btn btn-warning" id="confirmModalBtn">
                                <i class="fa fa-flag-checkered"></i> Finish &amp; Send for Review
                            </button>
                        </div>
                    </div>
                </div>
            </div>`;
        this._renderModal(modalHTML, this.confirmPartialFinish);
    }

    async confirmPartialFinish() {
        const el = document.getElementById("partialSummary");
        const summary = (el?.value || "").trim();
        if (!summary) {
            const err = document.getElementById("partialSummaryErr");
            if (err) err.style.display = "block";
            if (el) el.focus();
            return; // keep the modal open so they can add a summary
        }
        const task = this.state.selectedKpi;
        const kpi_id = task.id;
        this.closeModal();
        try {
            const pr = await rpc('/kpi/progress/create', {
                kpi_id: kpi_id,
                summary: summary,
                related_links: JSON.stringify([]),
            });
            if (!pr.status) {
                this._showAlert(pr.message || "Could not save your summary.", "Partial Finish failed", "danger");
                return;
            }
            const result = await rpc('/kra_kpi/task/complete', {
                kpi_id: kpi_id,
                partial: true,
                employee_checklist: {},
            });
            if (result.status) {
                await this.refresh();
                this._showAlert("Task finished and sent for review. Your summary was recorded.", "Partial Finish ✓", "success");
            } else {
                this._showAlert(result.message || "Could not finish the task.", "Partial Finish failed", "danger");
            }
        } catch (error) {
            console.error("Partial finish error:", error);
            this._showAlert(error?.data?.message || error?.message || "Something went wrong. Please try again.", "Partial Finish failed", "danger");
        }
    }

    // In-detail Complete is allowed only with a submitted summary + all 5 items ticked.
    canCompleteDetail() {
        const hasSummary = (this.state.progressUpdates || []).length > 0;
        const c = this.state.completeChecklist || {};
        // ONE tick is enough, not all five.
        //
        // Requiring every box meant a task with no user manual to upload, or
        // nothing to deploy, could not be completed at all — the developer either
        // ticked boxes that weren't true, or used Partial Finish to get around it.
        // A checklist people are forced to lie to is worse than no checklist: the
        // stored flags are what the manager reviews.
        //
        // Each box is still recorded individually, so "deployed but not
        // documented" stays visible to whoever approves it.
        const anyTicked = !!(c.verify_github || c.deployed_task || c.user_manual
                             || c.documentation || c.tested_code);
        return !!(hasSummary && anyTicked && !this.state.completeSubmitting);
    }

    async confirmCompleteFromDetail() {
        if (!this.canCompleteDetail()) return;
        const kpi_id = this.state.detailKpiId;
        const employee_checklist = { ...this.state.completeChecklist };
        this.state.completeSubmitting = true;
        try {
            const result = await rpc("/kra_kpi/task/complete", {
                kpi_id: kpi_id,
                partial: false,
                employee_checklist: employee_checklist,
            });
            if (result.status) {
                this.backToList();
                this._showAlert("Task completed and sent to your manager for approval.", "Completed ✓", "success");
            } else {
                this._showAlert(result.message || "Could not complete the task.", "Complete failed", "danger");
            }
        } catch (error) {
            console.error("Complete error:", error);
            this._showAlert(error?.data?.message || error?.message || "Something went wrong. Please try again.", "Complete failed", "danger");
        } finally {
            this.state.completeSubmitting = false;
        }
    }

    // MODAL RENDERING METHODS
    
    openStartModal(task) {
        this.state.selectedKpi = task;
        const modalHTML = `
            <div class="modal-backdrop fade show"></div>
            <div class="modal d-block" tabindex="-1">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Start Task</h5>
                            <button type="button" class="btn-close" id="closeModalBtn"></button>
                        </div>
                        <div class="modal-body">
                            <p><strong>Task:</strong> ${task.name}</p>
                            <p class="text-info">Please agree to the guidelines before starting.</p>
                            <p>Do you agree to follow all task guidelines and requirements?</p>
                        </div>
                        <div class="modal-footer">
                            <button class="btn btn-secondary" id="cancelModalBtn">Cancel</button>
                            <button class="btn btn-primary" id="confirmModalBtn">I Agree - Start Task</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        this._renderModal(modalHTML, this.confirmStart);
    }

    openPauseModal(task) {
        this.state.selectedKpi = task;
        this.state.pauseReason = '';
        const modalHTML = `
            <div class="modal-backdrop fade show"></div>
            <div class="modal d-block" tabindex="-1">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Pause Task</h5>
                            <button type="button" class="btn-close" id="closeModalBtn"></button>
                        </div>
                        <div class="modal-body">
                            <p><strong>Task:</strong> ${task.name}</p>
                            <div class="mb-2">
                                <label class="form-label">Why are you pausing?</label>
                                <div class="d-flex flex-wrap gap-2 mb-2 align-items-center">
                                    <!-- First, because it is the commonest reason a developer
                                         pauses: they have not stopped working, they have moved
                                         to a different task. It was buried in the dropdown as
                                         "Another Priority Task", so people reached for Break —
                                         which files real work time under a break on the
                                         Workday Map and makes the day read wrong. -->
                                    <button type="button" class="btn btn-sm btn-outline-primary pause-quick" data-code="priority_task"
                                            title="You're still working — just on something else">🔀 Moved to another task</button>
                                    <button type="button" class="btn btn-sm btn-outline-secondary pause-quick" data-code="break">☕ Break</button>
                                    <button type="button" class="btn btn-sm btn-outline-secondary pause-quick" data-code="lunch">🍽 Lunch</button>
                                    <button type="button" class="btn btn-sm btn-outline-secondary pause-quick" data-code="meeting">👥 Meeting</button>
                                    <button type="button" class="btn btn-sm btn-outline-secondary pause-quick" data-code="other">✍ Other</button>
                                    <button type="button" class="btn btn-sm btn-danger pause-quick ms-auto" data-code="urgent"
                                            title="Pause and immediately notify the owner / configured recipients with your note">🚨 Urgent</button>
                                </div>
                                <select id="pauseReasonCode" class="form-select form-select-sm mb-2">
                                    <option value="priority_task">🔀 Moved to another task</option>
                                    <option value="break">Break</option>
                                    <option value="lunch">Lunch</option>
                                    <option value="meeting">Meeting</option>
                                    <!-- Stopping for the day. Labels the pause only; the workday
                                         stays open until End Workday, which is irreversible. -->
                                    <option value="day_end">🌙 Day End</option>
                                    <option value="awaiting_approval">Waiting for Approval</option>
                                    <option value="technical_issue">Technical Issue</option>
                                    <option value="leave">Leave</option>
                                    <option value="other">Other</option>
                                    <option value="urgent">🚨 Urgent — notify now</option>
                                </select>
                                <!-- Only Other and Urgent ask for words. Every other reason IS its
                                     own explanation - "Break" needs no elaboration - and demanding
                                     one taught people to type "break" into a box next to a button
                                     already labelled Break. Urgent keeps it because that text is
                                     the body of the alert the owner receives. Hidden by default
                                     since the modal opens on a quick-pick, not on Other. -->
                                <!-- Meeting only: who it is with. Includes CLIENTS, which is
                                     why it uses /kra_kpi/get_people rather than the assignee
                                     list. Checkbox rows in a scrolling box, matching the
                                     Assign Clients picker in kra_node.js. Sits ABOVE the note
                                     box, which Meeting also shows — "who" then "what about". -->
                                <div id="pauseMeetWrap" style="display:none;">
                                    <label class="form-label fw-bold mt-2 mb-1">Who is it with?</label>
                                    <input type="text" id="pauseMeetSearch" class="form-control form-control-sm mb-1"
                                           placeholder="Search people…" autocomplete="off"/>
                                    <div id="pauseMeetList" class="border rounded p-2"
                                         style="max-height:170px; overflow-y:auto; background:#fbfcfe;">
                                        <div class="text-muted small">Loading…</div>
                                    </div>
                                    <div id="pauseMeetCount" class="small text-muted mt-1">Optional — pick anyone who is in it.</div>
                                </div>
                                <div id="pauseNoteWrap" style="display:none;">
                                    <label id="pauseNoteLabel" class="form-label fw-bold mt-2 mb-1" style="display:none;">What is it about?</label>
                                    <textarea id="pauseReason" class="form-control" rows="2" maxlength="60"
                                              placeholder="Why? (required)"></textarea>
                                    <div class="small text-danger mt-1">
                                        Keep it short (max 60) — this shows on your Workday Map.
                                    </div>
                                </div>
                                <div id="pauseUrgentHint" class="small text-danger mt-1" style="display:none;">
                                    <i class="fa fa-bullhorn me-1"></i> This note will be sent immediately to the owner and any configured recipients.
                                </div>
                                <small class="text-muted d-block mt-1">Every pause reason is tracked as away-time in your day summary — never counted as productive.</small>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button class="btn btn-secondary" id="cancelModalBtn">Cancel</button>
                            <button class="btn btn-warning" id="confirmModalBtn">Confirm Pause</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        this._renderModal(modalHTML, this.confirmPause);
        // ONE place that reacts to the chosen code, called by both the quick
        // buttons and the dropdown. They used to disagree: the dropdown had no
        // listener at all, so picking Urgent from it never showed the "this is
        // sent immediately" warning.
        // Meeting participants, held here rather than in component state because
        // this whole dialog is imperative DOM.
        this._pauseMeetWith = new Set();
        const applyPauseCode = (code, focus) => {
            const wrap = document.getElementById('pauseNoteWrap');
            const noteEl = document.getElementById('pauseReason');
            const noteLabel = document.getElementById('pauseNoteLabel');
            const urgentHint = document.getElementById('pauseUrgentHint');
            const meetWrap = document.getElementById('pauseMeetWrap');
            const isMeeting = (code === 'meeting');
            // Meeting asks for words too — a short "what about" — on top of who.
            const needsNote = PAUSE_NOTE_CODES.includes(code);
            if (wrap) wrap.style.display = needsNote ? 'block' : 'none';
            if (noteLabel) noteLabel.style.display = isMeeting ? 'block' : 'none';
            if (noteEl) noteEl.placeholder = isMeeting
                ? 'Short — e.g. sprint planning' : 'Why? (required)';
            if (urgentHint) urgentHint.style.display = (code === 'urgent') ? 'block' : 'none';
            if (meetWrap) meetWrap.style.display = isMeeting ? 'block' : 'none';
            // Drop anything typed under a reason that no longer asks for it, so a
            // note written for Other cannot be filed against Lunch.
            if (!needsNote && noteEl) noteEl.value = '';
            if (!isMeeting) this._pauseMeetWith = new Set();
            if (isMeeting) this._loadPauseMeetPeople();
            if (needsNote && focus && noteEl) noteEl.focus();
        };
        const selEl = document.getElementById('pauseReasonCode');
        if (selEl) selEl.addEventListener('change', () => applyPauseCode(selEl.value, true));
        document.querySelectorAll('.pause-quick').forEach((btn) => {
            btn.addEventListener('click', () => {
                const code = btn.dataset.code;
                const sel = document.getElementById('pauseReasonCode');
                if (sel) sel.value = code;
                // Tapping a reason ONLY selects it (highlight) — the task pauses
                // only when the user clicks "Confirm Pause". No direct/one-tap pause.
                document.querySelectorAll('.pause-quick').forEach((b) => {
                    const on = (b === btn);
                    b.classList.toggle('active', on);
                    // Keep the red Urgent button red; only swap outline<->solid on the grey ones.
                    if (b.dataset.code !== 'urgent') {
                        b.classList.toggle('btn-secondary', on);
                        b.classList.toggle('btn-outline-secondary', !on);
                    }
                });
                applyPauseCode(code, true);
            });
        });
        // Reflect whatever the select opens on (priority_task), so the box is not
        // visible for a reason that does not want one.
        applyPauseCode(selEl ? selEl.value : 'priority_task', false);
    }

    openResumeModal(task) {
        this.state.selectedKpi = task;
        // Sent-back self-created task -> require a "what I changed" response before resuming.
        if (task.is_self_created && task.self_needs_resume_reason) {
            const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const safeNote = esc(task.self_review_note);
            const safeBy = esc(task.self_review_by || 'Admin');
            const html = `
                <div class="modal fade show" tabindex="-1" style="display:block; background:rgba(0,0,0,0.5);">
                  <div class="modal-dialog modal-dialog-centered">
                    <div class="modal-content border-success shadow">
                      <div class="modal-header bg-success text-white">
                        <h5 class="modal-title"><i class="fa fa-reply me-2"></i> Respond &amp; Resume</h5>
                        <button type="button" class="btn-close btn-close-white" id="closeModalBtn"></button>
                      </div>
                      <div class="modal-body">
                        <div class="alert alert-warning mb-3">
                          <b>${safeBy}</b> sent this back:
                          <div class="mt-1 fst-italic">"${safeNote}"</div>
                        </div>
                        <label class="form-label fw-bold">What did you change / your response? <span class="text-danger">*</span></label>
                        <textarea id="rsReason" class="form-control" rows="3" placeholder="Describe what you fixed…"></textarea>
                        <small class="text-muted">Required — the admin will see this on the card.</small>
                      </div>
                      <div class="modal-footer">
                        <button class="btn btn-secondary" id="cancelModalBtn">Cancel</button>
                        <button class="btn btn-success" id="confirmModalBtn"><i class="fa fa-play me-1"></i> Resume</button>
                      </div>
                    </div>
                  </div>
                </div>`;
            this._renderModal(html, () => this.confirmResumeWithReason());
            return;
        }
        const safeName = (task.name || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeReason = (task.paused_reason || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const modalHTML = `
            <div class="modal-backdrop fade show"></div>
            <div class="modal d-block" tabindex="-1">
                <div class="modal-dialog modal-dialog-centered">
                    <div class="modal-content border-success shadow">
                        <div class="modal-header bg-success text-white">
                            <h5 class="modal-title"><i class="fa fa-play-circle me-2"></i> Resume Task</h5>
                            <button type="button" class="btn-close btn-close-white" id="closeModalBtn"></button>
                        </div>
                        <div class="modal-body">
                            <p class="mb-2"><strong>Task:</strong> ${safeName}</p>
                            <div class="alert alert-success d-flex align-items-center py-2 mb-2">
                                <i class="fa fa-clock-o me-2" style="font-size:1.2rem;"></i>
                                <div>Your timer will start again and this task moves back to <strong>In Progress</strong>.</div>
                            </div>
                            ${safeReason ? `<p class="text-muted mb-0"><small><i class="fa fa-pause me-1"></i><strong>Previous pause reason:</strong> ${safeReason}</small></p>` : ''}
                        </div>
                        <div class="modal-footer">
                            <button class="btn btn-outline-secondary" id="cancelModalBtn">Cancel</button>
                            <button class="btn btn-success" id="confirmModalBtn"><i class="fa fa-play me-1"></i> Resume Task</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        this._renderModal(modalHTML, this.confirmResume);
    }

    // 🆕 UPDATED: Reassign Modal with Reason Field
    async openReassignModal(task) {
        this.state.selectedKpi = task;
        this.state.selectedUser = task.user_id ? task.user_id : '';
        this.state.reassignReason = '';
        
        try {
            const result = await rpc("/kra_kpi/get_users", {});
            this.state.assigneesList = result;
            
            const modalHTML = `
                <div class="modal-backdrop fade show"></div>
                <div class="modal d-block" tabindex="-1">
                    <div class="modal-dialog">
                        <div class="modal-content">
                            <div class="modal-header bg-warning">
                                <h5 class="modal-title">🔄 Reassign KPI Task</h5>
                                <button type="button" class="btn-close" id="closeModalBtn"></button>
                            </div>
                            <div class="modal-body">
                                <div class="alert alert-info">
                                    <strong>⚠️ Important:</strong> Reassigning will reset the task state to <strong>${task.priority}</strong> and clear the timer. All progress will be recorded in history.
                                </div>
                                
                                <p><strong>Task:</strong> ${task.name}</p>
                                <p><strong>Current Assignee:</strong> ${task.user_name || "Not assigned"}</p>
                                <p><strong>Current State:</strong> <span class="badge bg-info">${task.task_state}</span></p>
                                <p><strong>Time Spent:</strong> ${this.formatTime(task.timer_total_seconds)}</p>
                                
                                <hr/>
                                
                                <div class="mb-3">
                                    <label for="newAssignee" class="form-label fw-bold">Select New Assignee: *</label>
                                    <select id="newAssignee" class="form-select">
                                        <option value="">-- Select Assignee --</option>
                                        ${this.state.assigneesList.map(user => `
                                            <option value="${user.id}" ${user.id === this.state.selectedUser ? 'selected' : ''}>
                                                ${user.name}
                                            </option>
                                        `).join('')}
                                    </select>
                                    <small class="text-muted">You can reassign to the same employee to reset the task</small>
                                    <div id="reassignAssigneeErr" class="text-danger small mt-1" style="display:none;"><i class="fa fa-exclamation-circle me-1"></i><span>Please select a new assignee.</span></div>
                                </div>
                                
                                <div class="mb-3">
                                    <label for="reassignReason" class="form-label fw-bold">Reason for Reassignment: *</label>
                                    <textarea id="reassignReason" class="form-control" rows="3" 
                                              placeholder="Please explain why you are reassigning this task (e.g., workload balancing, employee availability, skill match, etc.)"></textarea>
                                    <div id="reassignReasonErr" class="text-danger small mt-1" style="display:none;"><i class="fa fa-exclamation-circle me-1"></i><span>This field is mandatory.</span></div>
                                </div>
                            </div>
                            <div class="modal-footer">
                                <button class="btn btn-secondary" id="cancelModalBtn">Cancel</button>
                                <button class="btn btn-warning" id="confirmModalBtn">
                                    <i class="fa fa-refresh"></i> Confirm Reassignment
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            this._renderModal(modalHTML, this.confirmReassign);
        } catch (error) {
            console.error("Error fetching users:", error);
            this._toast("Failed to load users. Please try again.", 'danger');
        }
    }

    _renderModal(html, confirmCallback) {
        const container = document.getElementById("modalContainer");
        container.innerHTML = html;
        
        document.getElementById("closeModalBtn").addEventListener("click", () => this.closeModal());
        document.getElementById("cancelModalBtn").addEventListener("click", () => this.closeModal());
        document.getElementById("confirmModalBtn").addEventListener("click", confirmCallback);
    }

    closeModal() {
        document.getElementById("modalContainer").innerHTML = "";
        this.state.pauseReason = '';
        this.state.reassignReason = '';
    }

    // A styled in-page banner for board messages. Predates the toast added alongside
    // the popup sweep and does the same job by injecting DOM; left in place because
    // several callers position it deliberately.
    _showAlert(message, title = "Heads up", variant = "warning") {
        const safe = (message || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const icon = variant === 'danger' ? 'exclamation-triangle' : 'exclamation-circle';
        const container = document.getElementById("modalContainer");
        if (!container) { this._toast(message, 'warning'); return; }
        container.innerHTML = `
            <div class="modal fade show" tabindex="-1" style="display:block; background:rgba(0,0,0,0.5);">
              <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content border-${variant} shadow">
                  <div class="modal-header bg-${variant} text-white">
                    <h5 class="modal-title"><i class="fa fa-${icon} me-2"></i> ${title}</h5>
                    <button type="button" class="btn-close btn-close-white" id="closeModalBtn"></button>
                  </div>
                  <div class="modal-body"><p class="mb-0" style="white-space:pre-wrap;">${safe}</p></div>
                  <div class="modal-footer">
                    <button class="btn btn-${variant}" id="confirmModalBtn">OK</button>
                  </div>
                </div>
              </div>
            </div>`;
        document.getElementById("closeModalBtn").addEventListener("click", () => this.closeModal());
        document.getElementById("confirmModalBtn").addEventListener("click", () => this.closeModal());
    }

    // ------------------------------------------------------------------ //
    // Start Workday — explicit green-button entry point.  Opens today's
    // session via /kpi_workday/ping (which also fires workday_started WA
    // to owner + coordinator), then swaps the button to End Workday.
    // ------------------------------------------------------------------ //
    // The ONE place the four workday flags are written from the server. Every
    // handler used to set them by hand from what it believed it had just done,
    // which is how End Workday left dayDone=false and the green Start button
    // came straight back: the server was right, the header had simply never
    // asked it again. refresh() calls this, so the header re-syncs on every
    // poll and a handler that forgets a flag can no longer strand the UI.
    async _loadWorkdayStatus() {
        try {
            const res = await rpc("/kpi_workday/status", {});
            if (res && res.status) {
                this.state.workdayOpen   = !!res.is_open;
                this.state.workdayClosed = !!res.today_closed;
                this.state.dayDone       = !!res.day_done;
                this.state.workdayPaused = !!res.is_paused;
                // Why this day was reopened, shown under the workday button. Set from
                // here so it survives a refresh — the reason lives on the session, not
                // in whatever happened to be on screen when Reopen was pressed.
                this.state.reopenReason  = res.reopened_reason || '';
                this.state.reopenedBy    = res.reopened_by || '';
            }
        } catch (e) {
            // Leave the last known state alone — a dropped poll must not make
            // the header claim the day is over, nor offer to restart it.
        }
    }

    // Freeze the day without ending it: tasks stop, Presence stops, and it can be
    // resumed the same date. End Workday can only be undone by an admin
    // (action_revert_day), which is why this exists separately.
    async pauseWorkday() {
        try {
            const res = await rpc('/kpi_workday/pause', {});
            if (res && res.status) {
                this.state.workdayPaused = true;
                await this.refresh();
                await this.loadLiveStatus();
            } else {
                this._toast((res && res.message) || 'Could not pause your workday.', 'danger');
            }
        } catch (err) {
            this._toast('Pause Workday failed: ' + ((err && err.message) || err), 'danger');
        }
    }

    async resumeWorkday() {
        try {
            const res = await rpc('/kpi_workday/resume', {});
            if (res && res.status) {
                this.state.workdayPaused = false;
                await this.refresh();
                await this.loadLiveStatus();
            } else {
                this._toast((res && res.message) || 'Could not resume your workday.', 'danger');
            }
        } catch (err) {
            this._toast('Resume Workday failed: ' + ((err && err.message) || err), 'danger');
        }
    }

    // Admin-only undo of an explicit End Workday. Asks for a reason first: the
    // day's summary has already been delivered to the owner and coordinator, and
    // they are about to be told it no longer stands — "why" is the useful half
    // of that message. Cancelling the prompt cancels the revert.
    async revertWorkday() {
        const reason = await this._dialog({
            title: 'Reopen this workday?',
            message: 'The reason is sent to the developer word for word — it is the only '
                   + 'thing that explains why their day suddenly reopened. Everyone who '
                   + "received the day's summary is told too.

The paused task stays "
                   + 'paused; they press Resume to pick it back up.',
            input: true, inputLabel: 'Reason', required: true,
            placeholder: 'e.g. forgot to log the afternoon site visit',
            okLabel: 'Reopen workday', okClass: 'btn-warning',
        });
        if (reason === null) { return; }        // cancelled
        if (!reason.trim()) {
            this._showAlert(
                'A reason is required to reopen a workday — the developer is told, in your words.',
                'Reason required', 'warning');
            return;
        }
        try {
            const res = await rpc('/kpi_workday/revert', { reason });
            if (res && res.status) {
                await this._loadWorkdayStatus();
                await this.refresh();
            } else {
                this._toast((res && res.message) || 'Could not reopen the workday.', 'danger');
            }
        } catch (err) {
            this._toast('Reopen Workday failed: ' + ((err && err.message) || err), 'danger');
        }
    }

    async startWorkday() {
        try {
            const res = await rpc("/kpi_workday/ping", {});
            if (res && res.status) {
                this.state.workdayOpen = true;
                this.state.workdayClosed = false;
                this.state.dayDone = false;
                this.state.workdayPaused = false;
                // Refresh task list so any newly-pending items show up at top.
                if (typeof this.refresh === 'function') {
                    await this.refresh();
                }
            } else if (res && res.day_done) {
                // One start + one end per day: already ended today → reflect it.
                this.state.dayDone = true;
                this.state.workdayOpen = false;
            } else {
                this._toast("Could not start workday: " + ((res && res.message) || 'unknown error'), 'danger');
            }
        } catch (err) {
            this._toast("Start Workday request failed: " + ((err && err.message) || err), 'danger');
        }
    }

    // ------------------------------------------------------------------ //
    // End Workday — modal showing today's tasks + totals + Logout / Continue
    // ------------------------------------------------------------------ //
    async openEndWorkdayModal() {
        let data;
        try {
            data = await rpc("/kpi_workday/today_summary", {});
        } catch (err) {
            this._toast("Could not load today's workday summary. " + (err && err.message || ''), 'danger');
            return;
        }
        if (!data || data.status === false) {
            this._toast(data && data.message ? data.message : "Failed to fetch today's summary.", 'danger');
            return;
        }
        const anyConcurrent = (data.tasks || []).some(t => t.concurrent);
        // "09:30–18:15 · 1h 20m paused" — the line under Presence that
        // reconciles it with the day's own stamps. Presence stops while the workday
        // is frozen, so it no longer equals logout - login, and an unexplained
        // mismatch between a figure and the timestamps beside it is exactly what
        // made the raw clock the definition before this. Mirrors presenceFootnote()
        // in screens/KpiActionBoard.js — the two must not drift.
        //
        // logout_at is empty while the day is still open (this popup is a PREVIEW
        // until End Workday is actually pressed), so the range degrades to just
        // the start rather than printing a dangling dash.
        const presenceFoot = (() => {
            if (!(data.paused_seconds > 0)) return '';
            // HH:MM, not HH:MM:SS — same trim the app and the PNG header use.
            const hm = (s) => ((s || '').split(' ')[1] || s || '').slice(0, 5);
            const from = hm(data.login_at), to = hm(data.logout_at);
            const span = from ? (to ? from + '–' + to : from) : '';
            return (span ? span + ' · ' : '') + (data.paused_display || '0m') + ' paused';
        })();
        const tasksHTML = (data.tasks && data.tasks.length)
            ? data.tasks.map(t => `
                <tr${t.concurrent ? ' style="border-left:4px solid #f59e0b;"' : ''}>
                    <td><b>${t.concurrent ? '⚡ ' : ''}${t.ref || ''}</b></td>
                    <td>${(t.name || '').replace(/</g,'&lt;')}</td>
                    <td class="text-end">
                        ${t.duration_display || '0m'}
                        ${t.concurrent && t.solo_seconds > 0
                            ? `<div class="text-muted" style="font-size:.72rem;">${t.solo_display} alone · ${t.shared_display} shared</div>`
                            : ''}
                    </td>
                </tr>
            `).join('')
            : `<tr><td colspan="3" class="text-muted text-center">No task time logged yet today.</td></tr>`;
        const autoNote = data.auto_closed
            ? `<div class="alert alert-warning small mt-2">Auto-closed earlier by cron.</div>`
            : '';
        // 🗺 Workday Map — render the day's flow as chips: start → task → break → … → end.
        // Server sends a ready-to-render `timeline` list; each task chip shows its
        // outcome + the last reason/note typed underneath (in brackets).
        const tlEsc = (x) => (x == null ? '' : x.toString()).replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const tlChip = (n) => {
            const icon = n.icon || '';
            const label = tlEsc(n.label || '');
            const time = tlEsc(n.time || '');
            let border = '#cbd5e1', sub = '', note = '';
            if (n.kind === 'start' || n.kind === 'end') {
                border = '#94a3b8';
                if (time) sub = `<div style="font-size:11px;color:#6b7280;">${time}</div>`;
            } else if (n.kind === 'break') {
                border = awayColor(n.break_type);
                const dur = n.duration_display ? ` · ${tlEsc(n.duration_display)}` : '';
                sub = `<div style="font-size:11px;color:#6b7280;">${time}${dur}</div>`;
                // The typed note + a live marker. This branch used to drop n.reason
                // entirely, so a note saved against a meeting/break was stored and
                // never shown — while the saved PNG printed it, leaving the image and
                // this popup disagreeing about the same day.
                const bparts = [];
                if (n.running) bparts.push('▶ In progress');
                if (n['with']) bparts.push('with ' + tlEsc(n['with']));
                if (n.reason) bparts.push(tlEsc(n.reason));
                if (bparts.length) note = `<div style="font-size:11px;color:#374151;font-style:italic;line-height:1.3;">(${bparts.join(' — ')})</div>`;
            } else { // task
                const oc = { completed:'#16a34a', submitted:'#0d9488', paused:'#f59e0b', active:'#3b82f6', worked:'#64748b', moved:'#f97316' };
                border = oc[n.outcome] || '#3b82f6';
                if (time) sub = `<div style="font-size:11px;color:#6b7280;">${time}</div>`;
                const ocLabel = { completed:'✓ Completed', submitted:'◑ Verification pending', paused:'⏸ Paused', active:'▶ In progress', worked:'', moved:'↪ Moved' }[n.outcome] || '';
                const parts = [];
                if (ocLabel) parts.push(ocLabel);
                if (n.reason) parts.push(tlEsc(n.reason));
                if (parts.length) note = `<div style="font-size:11px;color:#374151;font-style:italic;line-height:1.3;">(${parts.join(' — ')})</div>`;
            }
            return `<div style="display:inline-flex;flex-direction:column;min-width:104px;max-width:190px;border:1px solid ${border};border-top:3px solid ${border};border-radius:10px;padding:6px 10px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.06);">`
                + `<div style="font-weight:600;font-size:13px;line-height:1.25;">${icon} ${label}</div>${sub}${note}</div>`;
        };
        const timelineInner = (data.timeline && data.timeline.length)
            ? data.timeline.map(tlChip).join('<span style="align-self:center;color:#9ca3af;font-size:16px;">→</span>')
            : '<span class="text-muted small">No activity recorded yet today.</span>';
        const timelineSection = `
            <div class="border rounded p-3 mb-3" style="background:#f8fafc;">
                <div class="fw-bold mb-2">🗺 Workday Map <span class="text-muted fw-normal small">(your day in order — each task shows the last reason/note typed)</span></div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:stretch;">${timelineInner}</div>
            </div>`;
        const modalHTML = `
            <div class="modal-backdrop fade show"></div>
            <div class="modal d-block" tabindex="-1">
                <div class="modal-dialog modal-lg">
                    <div class="modal-content">
                        <div class="modal-header bg-danger text-white">
                            <h5 class="modal-title">
                                <i class="fa fa-power-off"></i> End Workday — ${data.dev || ''}
                            </h5>
                            <button type="button" class="btn-close btn-close-white" id="closeModalBtn"></button>
                        </div>
                        <div class="modal-body" style="max-height: 70vh; overflow-y: auto;">
                            <div class="mb-3" style="display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:.75rem;">
                                <div class="p-3 border rounded">
                                    <div class="text-muted small">Login</div>
                                    <div class="fw-bold">${data.login_at || '-'}</div>
                                </div>
                                <div class="p-3 border rounded">
                                    <div class="text-muted small">Productive (task time)</div>
                                    <div class="fw-bold text-success" style="font-size:1.3rem;">${data.productive_display || '0m'}</div>
                                </div>
                                <!-- Presence and Accounted share ONE box, split by a rule.
                                     They are the pair that has to be read together:
                                     Presence is time at work (the pause is OFF it),
                                     Accounted is the whole day explained (the pause is IN
                                     it), so the gap between the two IS the pause.
                                     span 2 keeps them ADJACENT without claiming a row of
                                     their own: 1/-1 forced a line break and dropped the
                                     pair below Login and Productive, which pushed the two
                                     headline figures off the top of the popup. Spanning
                                     two cells is all the box needs — they still cannot
                                     be split across lines, because it is one element. -->
                                <div class="border rounded" style="grid-column:span 2; display:flex;">
                                    <div class="p-3" style="flex:1;">
                                        <div class="text-muted small">Presence (at work)</div>
                                        <!-- Green at/over the standard day, red under it. met_standard is
                                             decided server-side so the web popup, the app and the saved
                                             image can never disagree on the verdict. -->
                                        <div class="fw-bold ${data.met_standard ? 'text-success' : 'text-danger'}" style="font-size:1.3rem;">${data.presence_display || '0m'}</div>
                                        ${data.standard_display ? `<div class="small fw-bold ${data.met_standard ? 'text-success' : 'text-danger'}">${data.met_standard ? '✓' : '▾'} ${data.standard_display} standard</div>` : ''}
                                        ${presenceFoot ? `<div class="small text-muted">${presenceFoot}</div>` : ''}
                                    </div>
                                    <div style="width:1px; background:#dee2e6; margin:.5rem 0;"></div>
                                    <!-- One figure for the whole day's accounted time, so
                                         "is my day explained?" doesn't mean adding five
                                         boxes up by eye. Accounted + Other/Idle = the CLOCK,
                                         not Presence, now that the pause sits outside it. -->
                                    <div class="p-3" style="flex:1;">
                                        <div class="text-muted small">Accounted</div>
                                        <div class="fw-bold text-primary" style="font-size:1.3rem;">${data.accounted_display || '0m'}</div>
                                        <div class="small text-muted">task + meeting + lunch + break + no-tasks + paused</div>
                                    </div>
                                </div>
                                ${(data.paused_seconds || 0) > 0 ? `
                                <!-- OUTSIDE Presence: Presence stops while the day is frozen,
                                     so paused time is no longer in it — it is in Accounted
                                     instead, which makes this figure exactly the gap between
                                     those two numbers. Shown on its own line so a long gap
                                     reads as a deliberate pause rather than as missing data. -->
                                <div class="p-3 border rounded">
                                    <div class="text-muted small">Workday paused</div>
                                    <div class="fw-bold" style="font-size:1.3rem; color:#B45309;">${data.paused_display || '0m'}</div>
                                    <div class="small text-muted">outside Presence, not worked time</div>
                                </div>` : ''}
                            </div>
                            ${(data.break_seconds || data.lunch_seconds || data.meeting_seconds || data.other_seconds || data.away_seconds || data.no_tasks_seconds || data.other_idle_seconds || (data.away_events && data.away_events.length)) ? `
                            <div class="border rounded p-2 mb-3" style="background:#fff8e1;">
                                <div class="fw-bold mb-2"><i class="fa fa-coffee me-1"></i> Away time <span class="text-muted fw-normal small">(inside Presence — never counted as Productive)</span></div>
                                <div class="mb-2" style="display:grid; grid-template-columns:repeat(auto-fit,minmax(96px,1fr)); gap:.5rem;">
                                    <div class="p-2 border rounded bg-white text-center"><div class="text-muted small">Break</div><div class="fw-bold">${data.break_display || '0m'}</div></div>
                                    <div class="p-2 border rounded bg-white text-center"><div class="text-muted small">Lunch</div><div class="fw-bold">${data.lunch_display || '0m'}</div></div>
                                    <div class="p-2 border rounded bg-white text-center"><div class="text-muted small">Meeting</div><div class="fw-bold">${data.meeting_display || '0m'}</div></div>
                                    <div class="p-2 border rounded bg-white text-center"><div class="text-muted small">No tasks</div><div class="fw-bold">${data.no_tasks_display || '0m'}</div></div>
                                    <div class="p-2 border rounded bg-white text-center"><div class="text-muted small">Other</div><div class="fw-bold">${data.other_display || '0m'}</div></div>
                                    <div class="p-2 border rounded bg-white text-center"><div class="text-muted small">Away (system)</div><div class="fw-bold">${data.away_display || '0m'}</div></div>
                                    <div class="p-2 border rounded bg-white text-center"><div class="text-muted small">Other / Idle</div><div class="fw-bold">${data.other_idle_display || '0m'}</div></div>
                                </div>
                                ${(data.away_events && data.away_events.length) ? `<ul class="list-unstyled mb-0 small">${data.away_events.map(e => {
                                    // Same colour the Map chip uses for this type — one source,
                                    // so the list and the Map can never disagree again.
                                    const bg = awayColor(e.type);
                                    const from = e.from ? ` <span class="text-muted">from "${(e.from||'').replace(/</g,'&lt;')}"</span>` : '';
                                    // Who a meeting was with, before the note — "with Priya, Arun — sprint planning".
                                    const who = e['with'] ? ` <span class="text-muted">with ${(e['with']||'').replace(/</g,'&lt;')}</span>` : '';
                                    const note = e.note ? ` <span class="text-muted fst-italic">— ${(e.note||'').replace(/</g,'&lt;')}</span>` : '';
                                    return `<li class="mb-1"><span class="badge me-1" style="background:${bg};color:#fff;">${e.label}</span> ${e.start} – ${e.end} <span class="text-muted">(${e.duration_display})</span>${from}${who}${note}</li>`;
                                }).join('')}</ul>` : ''}
                            </div>` : ''}
                            ${timelineSection}
                            <div class="small text-danger mb-2"><i class="fa fa-exclamation-circle me-1"></i> Use <b>Complete</b> for finished tasks — Pause is only for breaks/interruptions.</div>
                            <h6 class="mt-3">Tasks worked today (${data.task_count || 0})</h6>
                            <table class="table table-sm table-striped">
                                <thead><tr><th>Ref</th><th>Title</th><th class="text-end">Time</th></tr></thead>
                                <tbody>${tasksHTML}</tbody>
                            </table>
                            ${(data.allow_multitask || anyConcurrent) ? `<div class="small text-warning mb-2"><b>⚡ = multi-tasked together</b> — the ⚡ tasks (amber line) ran at the same time, so Productive can exceed Presence (expected).</div>` : ''}
                            <!-- Was 2 rows, capped at 500, labelled only "Optional" — and it
                                 showed: 3 notes in 213 sessions, the longest 51 characters.
                                 A real day's summary runs ~400 characters over a dozen lines.
                                 Still optional; just big enough to write in, and it now says
                                 where the note ends up. -->
                            <label class="form-label mt-2">
                                What did you work on today? <span class="text-muted">(optional)</span>
                            </label>
                            <!-- The example is a real note from this team, kept in their own
                                 shorthand (-> bullets, + to chain items). People copy the
                                 shape of whatever example you show them, so showing polished
                                 prose here would just make the box feel like homework. -->
                            <textarea id="endWorkdayNote" class="form-control" rows="6" maxlength="2000"
                                      placeholder="Module documents&#10;->Signage scan module doc&#10;&#10;App documents&#10;->Van sale doc&#10;->Price checker doc(Need to add screenshots)&#10;&#10;Chats server connecting issue + Dark/light mode switch bug + Build taken for testing&#10;&#10;KRA KPI checked for client side invoice generate + found 4 bugs fixed"></textarea>
                            <div class="form-text">Saved with your workday snapshot and sent in the daily summary.</div>
                            <div id="endWorkdayNoteErr" class="small text-danger mt-1 d-none"></div>
                            ${autoNote}
                            <p class="text-muted small mt-2 mb-0">
                                Clicking <b>Logout</b> finalises this session, sends a WhatsApp summary to
                                the owner + coordinator, and logs you out. <b>Continue</b> dismisses this
                                dialog and keeps your session open.
                            </p>
                        </div>
                        <!-- Pause lives HERE, next to End, because they are the two
                             ways to stop for the day and the choice between them is
                             the thing people get wrong. Ending is final for the date
                             (one start + one end); pausing is not. Offering Pause at
                             the moment someone reaches for End is what stops a 4am
                             finish from burying the day.
                             NOT to be confused with "Pause all" on the live strip,
                             which stops the TASKS and leaves the workday running. -->
                        ${this.state.workdayPaused ? '' : `
                        <div class="alert alert-warning py-2 px-3 mx-3 mb-0 small d-flex align-items-center justify-content-between gap-2">
                            <span>
                                <i class="fa fa-pause-circle me-1"></i>
                                Coming back later today? <b>Pause</b> instead — your day stays
                                open, and the time away will not count as worked time.
                            </span>
                            <button type="button" class="btn btn-sm btn-warning text-dark fw-semibold flex-shrink-0"
                                    id="pauseWorkdayBtn">
                                <i class="fa fa-pause me-1"></i> Pause Workday
                            </button>
                        </div>`}
                        <div class="modal-footer">
                            <button type="button" class="btn btn-outline-secondary" id="continueWorkdayBtn">
                                <i class="fa fa-arrow-left me-1"></i> Continue Working
                            </button>
                            <button type="button" class="btn btn-danger" id="endWorkdayConfirmBtn">
                                <i class="fa fa-sign-out me-1"></i> End Workday &amp; Send Summary
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.getElementById("modalContainer").innerHTML = modalHTML;
        document.getElementById("closeModalBtn").addEventListener("click", () => this.closeModal());
        document.getElementById("continueWorkdayBtn").addEventListener("click", () => this.closeModal());
        // Optional chaining because the button is not rendered on an already
        // paused day -- without it this throws and every listener wired AFTER it
        // (End Workday included) is silently never attached.
        document.getElementById("pauseWorkdayBtn")?.addEventListener("click", async () => {
            this.closeModal();
            await this.pauseWorkday();
        });
        document.getElementById("endWorkdayConfirmBtn").addEventListener("click", async () => {
            const note = document.getElementById("endWorkdayNote")?.value || '';
            // Same rule as utils/workdayNote.js in the mobile app — kept in step by hand
            // because the Odoo asset bundle and the Metro bundle share no code. If you
            // change one, change the other.
            //
            // The note is OPTIONAL: empty always passes. This only catches a note that was
            // typed but says nothing ("." / "123" / "----"). Punctuation and digits are
            // fine — real notes are full of "->", "+" and numbers.
            const typed = note.trim();
            if (typed && (typed.match(/[A-Za-z]{2,}/g) || []).length < 2) {
                const err = document.getElementById("endWorkdayNoteErr");
                if (err) {
                    err.textContent = 'Please write a few words about what you did today, or leave it empty.';
                    err.classList.remove('d-none');
                }
                document.getElementById("endWorkdayNote")?.focus();
                return;
            }
            const btn = document.getElementById("endWorkdayConfirmBtn");
            if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa fa-spinner fa-spin me-1"></i> Sending...'; }
            try {
                const res = await rpc("/kpi_workday/end", { note });
                if (res && res.status) {
                    // Workday ended → close the modal and refresh in place. The
                    // header must read "Workday ended for today", which needs
                    // dayDone as well as workdayOpen — setting only the latter
                    // put the green Start button straight back on screen. Both
                    // are set here for an instant flip, and refresh() re-reads
                    // all four from the server so this can't drift again.
                    this.closeModal();
                    this.state.workdayOpen = false;
                    this.state.workdayPaused = false;
                    this.state.workdayClosed = false;
                    this.state.dayDone = true;
                    await this.refresh();
                } else {
                    this._toast("End-workday failed: " + (res && res.message || 'unknown error'), 'danger');
                    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa fa-sign-out me-1"></i> End Workday &amp; Send Summary'; }
                }
            } catch (err) {
                this._toast("End-workday request failed: " + (err && err.message || err), 'danger');
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa fa-sign-out me-1"></i> End Workday &amp; Send Summary'; }
            }
        });
    }

    // Fire-and-forget stamp of the coordinator review-started timestamp.
    // Server endpoint is idempotent + state-gated (only writes when
    // task_state == 'partially_completed' AND timestamp not yet set).
    // We don't await so it doesn't block opening the modal.
    _markReviewStarted(task) {
        if (!task || !task.id || task.task_state !== 'partially_completed') {
            return;
        }
        try {
            rpc("/kpi_review/mark_started", { kpi_id: task.id })
                .then((res) => {
                    if (res && res.status && !res.already_started && res.started_at) {
                        // Reflect the new timestamp on the in-memory task so the
                        // UI re-render shows "Review started: ..." without a full refresh.
                        task.coordinator_review_started_at = res.started_at;
                        task.coordinator_review_started_by_name = res.by;
                    }
                })
                .catch((err) => console.warn("mark_review_started rpc failed", err));
        } catch (err) {
            console.warn("mark_review_started invocation failed", err);
        }
    }

    // CONFIRMATION METHODS

    /** Fetch (once per session) and render meeting-participant checkboxes into
     *  the given container. Shared by the single Pause and Pause-all dialogs —
     *  the ids and the selection Set differ, nothing else does. */
    async _loadMeetPeople(listId, searchId, countId, picked) {
        const list = document.getElementById(listId);
        if (!list) return;
        if (!this._peopleCache) {
            try {
                const res = await rpc('/kra_kpi/get_people', {});
                this._peopleCache = Array.isArray(res) ? res : [];
            } catch (e) {
                list.innerHTML = '<div class="text-danger small">Could not load people.</div>';
                return;
            }
        }
        const esc = (x) => (x == null ? '' : String(x))
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const search = document.getElementById(searchId);
        const countEl = document.getElementById(countId);

        const draw = () => {
            const q = (search && search.value || '').trim().toLowerCase();
            const shown = this._peopleCache.filter(
                (u) => !q || String(u.name || '').toLowerCase().includes(q));
            if (!shown.length) {
                list.innerHTML = '<div class="text-muted small">No one matches.</div>';
                return;
            }
            list.innerHTML = shown.map((u) => `
                <div class="form-check d-flex align-items-center gap-2">
                  <input class="form-check-input" type="checkbox" id="${listId}_${u.id}" value="${u.id}"
                         ${picked.has(u.id) ? 'checked' : ''}/>
                  <label class="form-check-label flex-grow-1" for="${listId}_${u.id}">${esc(u.name)}</label>
                  <span class="badge bg-light text-muted border">${esc((u.role || '').toUpperCase())}</span>
                </div>`).join('');
            // Re-bound after every redraw: the rows are replaced wholesale on each
            // keystroke, so listeners on the old nodes die with them.
            list.querySelectorAll('input[type=checkbox]').forEach((box) => {
                box.addEventListener('change', () => {
                    const id = parseInt(box.value, 10);
                    if (box.checked) picked.add(id); else picked.delete(id);
                    if (countEl) {
                        countEl.textContent = picked.size
                            ? `${picked.size} selected`
                            : 'Optional — pick anyone who is in it.';
                    }
                });
            });
        };
        draw();
        if (search && !search._wired) { search._wired = true; search.addEventListener('input', draw); }
    }

    /** Single-Pause dialog wrapper — kept so its call site reads plainly. */
    async _loadPauseMeetPeople() {
        return this._loadMeetPeople('pauseMeetList', 'pauseMeetSearch', 'pauseMeetCount',
                                    this._pauseMeetWith);
    }


    async confirmStart() {
        const kpi_id = this.state.selectedKpi.id;
        this.closeModal();

        try {
            const res = await rpc("/kra_kpi/task/start", { kpi_id: kpi_id });
            // The route CATCHES the gate's ValidationError and returns
            // {status: False, message} over a successful JSON-RPC call, so rpc()
            // resolves and the catch below never runs. Without this check the
            // single-task limit (and every other gate) refused silently: the
            // modal closed, the board redrew, the task had not started, and
            // nothing on screen said why.
            if (res && res.status === false) {
                this._showAlert(res.message || "This task can't start yet.",
                                "Can't start this task", "warning");
                await this.refresh();
                return;
            }
            await this.refresh();
        } catch (error) {
            console.error("Error starting task:", error);
            this._showAlert(error?.data?.message || error?.message || "Failed to start task. Please try again.",
                            "Can't start this task", "warning");
        }
    }

    async confirmPause() {
        const codeEl = document.getElementById("pauseReasonCode");
        const reason_code = (codeEl && codeEl.value) || 'other';
        const reasonRaw = (document.getElementById("pauseReason")?.value || '').trim().slice(0, PAUSE_NOTE_MAX);
        // Only Other and Urgent need words; everything else is self-explanatory
        // and stores its own label. This used to demand a note for Day End,
        // Leave, Technical Issue and the rest, which is why people typed the
        // reason they had just picked from the list.
        const needsNote = PAUSE_NOTE_CODES.includes(reason_code);
        const reason = reasonRaw || (needsNote ? '' : (codeEl?.selectedOptions?.[0]?.text || reason_code));
        if (needsNote && !reason) {
            const msg = reason_code === 'urgent'
                ? "Please describe the issue — this note is sent to the owner / configured recipients."
                : reason_code === 'meeting'
                    ? "Please say what the meeting is about."
                    : "Please say what you're pausing for.";
            const errEl = document.getElementById("pauseUrgentHint");
            if (reason_code === 'urgent' && errEl) { errEl.style.display = 'block'; errEl.textContent = "⚠ " + msg; }
            else { this._toast(msg, 'warning'); }
            const noteEl = document.getElementById("pauseReason");
            if (noteEl) noteEl.focus();
            return;
        }
        
        const kpi_id = this.state.selectedKpi.id;
        this.closeModal();
        
        try {
            await rpc("/kra_kpi/task/pause", {
                kpi_id: kpi_id, reason: reason, reason_code: reason_code,
                meeting_with_ids: reason_code === 'meeting'
                    ? Array.from(this._pauseMeetWith || []) : [],
            });
            await this.refresh();
        } catch (error) {
            console.error("Error pausing task:", error);
            this._toast("Failed to pause task. Please try again.", 'danger');
        }
    }

    async confirmResume() {
        const kpi_id = this.state.selectedKpi.id;
        this.closeModal();

        try {
            // Same contract as confirmStart — the route converts the gate's
            // exception into a successful response, so a refusal has to be read
            // off the payload rather than caught.
            const res = await rpc("/kra_kpi/task/resume", { kpi_id: kpi_id });
            if (res && res.status === false) {
                this._showAlert(res.message || "This task can't resume yet.",
                                "Can't resume this task", "warning");
                await this.refresh();
                return;
            }
            await this.refresh();
        } catch (error) {
            console.error("Error resuming task:", error);
            this._showAlert(error?.data?.message || error?.message || "Failed to resume task. Please try again.",
                            "Can't resume this task", "warning");
        }
    }

    async confirmResumeWithReason() {
        const el = document.getElementById('rsReason');
        const reason = (el && el.value || '').trim();
        if (!reason) { this._toast('Please enter what you changed before resuming.', 'warning'); return; }
        const kpi_id = this.state.selectedKpi.id;
        try {
            const res = await rpc('/kra_kpi/task/resume_with_reason', { kpi_id, reason });
            if (res && res.status) {
                this.closeModal();
                await this.refresh();
            } else {
                this._toast((res && res.message) || 'Resume failed.', 'danger');
            }
        } catch (e) {
            this._toast('Resume failed: ' + ((e && e.message) || e), 'danger');
        }
    }


    // 🆕 UPDATED: Confirm Reassignment with Reason
    async confirmReassign() {
        const assigneeEl = document.getElementById("newAssignee");
        const reasonEl = document.getElementById("reassignReason");
        const selectedAssignee = assigneeEl?.value;
        const reason = reasonEl?.value?.trim();

        // Inline validation — no browser popups. Red field + message under it.
        const setErr = (el, errId, msg) => {
            if (el) { el.classList.add("is-invalid"); el.focus(); }
            const e = document.getElementById(errId);
            if (e) { const sp = e.querySelector("span"); if (sp) sp.textContent = msg; e.style.display = "block"; }
        };
        const clrErr = (el, errId) => {
            if (el) el.classList.remove("is-invalid");
            const e = document.getElementById(errId);
            if (e) e.style.display = "none";
        };
        clrErr(assigneeEl, "reassignAssigneeErr");
        clrErr(reasonEl, "reassignReasonErr");

        if (!selectedAssignee) {
            setErr(assigneeEl, "reassignAssigneeErr", "Please select a new assignee.");
            return;
        }
        if (!reason) {
            setErr(reasonEl, "reassignReasonErr", "Please enter a reason — this field is mandatory.");
            return;
        }
        if (reason.length < 10) {
            setErr(reasonEl, "reassignReasonErr", "Please give a bit more detail (at least 10 characters).");
            return;
        }
        
        const kpi_id = this.state.selectedKpi.id;
        const task_name = this.state.selectedKpi.name;
        
        this.closeModal();
        
        try {
            const response = await rpc("/kra_kpi/task/reassign", {
                kpi_id: kpi_id,
                user_id: selectedAssignee,
                reason: reason,
            });
            
            if (response.status) {
                this._toast(`✅ Task "${task_name}" has been successfully reassigned!\n\nNew State: ${response.new_state}\nNew Assignee: ${response.new_assignee}\n\nThe task has been reset and history has been recorded.`, 'success');
                await this.refresh();
            } else {
                this._toast("❌ Error: " + response.message, 'danger');
            }
        } catch (error) {
            console.error("Error reassigning task:", error);
            this._toast("Failed to reassign task. Please try again.", 'danger');
        }
    }

    // Progress Update Methods
    handleProgressFileUpload(event) {
        const file = event.target.files[0];
        this.state.uploadState.error = '';
        if (!file) {
            this.state.progressForm.fileObj = null;
            this.state.progressForm.file_name = '';
            return;
        }
        const MAX = 50 * 1024 * 1024;
        if (file.size > MAX) {
            this.state.uploadState.error = 'That file is ' + this._mb(file.size) +
                ' — over the 50 MB limit. Add a Drive or GitHub link instead.';
            this.state.progressForm.fileObj = null;
            this.state.progressForm.file_name = '';
            event.target.value = '';
            return;
        }
        this.state.progressForm.fileObj = file;
        this.state.progressForm.file_name = file.name;
        // keep base64 too for any legacy path that still reads uploaded_file
        const reader = new FileReader();
        reader.onload = () => { this.state.progressForm.uploaded_file = reader.result.split(',')[1]; };
        reader.readAsDataURL(file);
    }

    _mb(bytes) { return (bytes / (1024 * 1024)).toFixed(1) + ' MB'; }

    // Circular ring geometry (r = 30) + MB label.
    uploadCircumference() { return 2 * Math.PI * 30; }
    uploadDashOffset() {
        const c = this.uploadCircumference();
        return c * (1 - (this.state.uploadState.percent || 0) / 100);
    }
    uploadMbText() {
        const us = this.state.uploadState;
        return (us.loaded / (1024 * 1024)).toFixed(1) + ' / ' + (us.total / (1024 * 1024)).toFixed(1) + ' MB';
    }

    _resetProgressForm() {
        this.state.progressForm.summary = '';
        this.state.progressForm.uploaded_file = null;
        this.state.progressForm.file_name = '';
        this.state.progressForm.fileObj = null;
        this.state.progressForm.related_links = [];
        this.state.progressForm.link_input = '';
        this.state.uploadState = { active: false, percent: 0, loaded: 0, total: 0, error: '', xhr: null };
    }

    async _reloadProgressLists() {
        await this.loadProgressUpdates(this.state.detailKpiId);
        await this.loadAttachedFiles(this.state.detailKpiId);
        await this.loadResourceSections(this.state.detailKpiId);
    }

    cancelUpload() {
        const us = this.state.uploadState;
        if (us.xhr) { try { us.xhr.abort(); } catch (e) { /* ignore */ } }
        us.active = false; us.xhr = null; us.percent = 0;
    }

    async submitProgressUpdate() {
        if (!this.state.progressForm.summary.trim()) {
            // The styled modal, not a bare browser this._toast(, 'warning'): this was the one
            // validation message in the file that still used the OS dialog, so
            // the most common mistake on the screen got the ugliest response.
            this._showAlert(
                'Describe what you did before submitting — this is what your manager reads.',
                'Progress summary required', 'warning');
            const el = document.getElementById('progressSummary');
            if (el) el.focus();
            return;
        }
        // WITH a file → live multipart upload (circular %-ring).
        if (this.state.progressForm.fileObj) {
            return this._submitWithFile(this.state.progressForm.fileObj);
        }
        // No file → JSON create (unchanged path).
        try {
            const result = await rpc('/kpi/progress/create', {
                kpi_id: this.state.detailKpiId,
                summary: this.state.progressForm.summary,
                uploaded_file: this.state.progressForm.uploaded_file,
                file_name: this.state.progressForm.file_name,
                related_links: JSON.stringify(this.state.progressForm.related_links),
            });
            if (result.status) {
                this._resetProgressForm();
                await this._reloadProgressLists();
            } else {
                this._toast('Error: ' + result.message, 'danger');
            }
        } catch (error) {
            console.error('Error submitting progress:', error);
            this._toast('Failed to submit progress update', 'danger');
        }
    }

    async _submitWithFile(fileObj) {
        const us = this.state.uploadState;
        us.active = true; us.percent = 0; us.loaded = 0; us.total = fileObj.size; us.error = '';
        const fd = new FormData();
        fd.append('file', fileObj);
        fd.append('kpi_id', this.state.detailKpiId);
        fd.append('summary', this.state.progressForm.summary);
        fd.append('related_links', JSON.stringify(this.state.progressForm.related_links));
        const { promise, xhr } = uploadWithProgress('/kpi/progress/upload_file', fd, (p) => {
            us.percent = p.percent; us.loaded = p.loaded; us.total = p.total;
        });
        us.xhr = xhr;
        try {
            const result = await promise;
            us.active = false; us.xhr = null;
            if (result && result.status) {
                this._resetProgressForm();
                await this._reloadProgressLists();
            } else {
                us.error = (result && result.message) || 'Upload failed.';
            }
        } catch (e) {
            us.active = false; us.xhr = null;
            if ((e && e.message) !== 'aborted') {
                us.error = (e && e.message) || 'Upload failed.';
            }
        }
    }

    async loadProgressUpdates(kpi_id) {
        try {
            const result = await rpc('/kpi/progress/list', { kpi_id: kpi_id });
            if (result.status) {
                // Parse links for each update
                this.state.progressUpdates = result.updates.map(update => {
                    let links = [];
                    try {
                        links = JSON.parse(update.related_links || '[]');
                    } catch (e) {
                        links = [];
                    }
                    return {
                        ...update,
                        links: links  // 🆕 NEW
                    };
                });
            }
        } catch (error) {
            console.error('Error loading progress updates:', error);
        }
    }

    // 🆕 NEW: Load Reassignment History
    async loadReassignmentHistory(kpi_id) {
        try {
            const result = await rpc('/kra_kpi/reassignment_history', { kpi_id: kpi_id });
            if (result.status) {
                this.state.reassignmentHistory = result.history;
            }
        } catch (error) {
            console.error('Error loading reassignment history:', error);
        }
    }
    // 🆕 NEW: Load and display employee checklist
    async loadTaskChecklists(kpi_id) {
        try {
            const result = await rpc("/kra_kpi/task/checklists", { kpi_id: kpi_id });
            
            if (result.status) {
                const empChecklist = result.employee_checklist;
                
                // Count checked items
                const checkedCount = Object.values(empChecklist).filter(v => v).length;
                
                // Update the display
                const displayDiv = document.getElementById("employeeChecklistDisplay");
                if (displayDiv) {
                    displayDiv.innerHTML = `
                        <h6 class="fw-bold mb-3">📝 Employee Checklist (${checkedCount}/5 completed):</h6>
                        
                        <div class="form-check mb-2">
                            <input class="form-check-input" type="checkbox" ${empChecklist.verify_github ? 'checked' : ''} disabled>
                            <label class="form-check-label">
                                <strong>1. Verify Github URL</strong>
                                ${empChecklist.verify_github ? '<span class="badge bg-success ms-2">✓</span>' : '<span class="badge bg-secondary ms-2">✗</span>'}
                            </label>
                        </div>
                        
                        <div class="form-check mb-2">
                            <input class="form-check-input" type="checkbox" ${empChecklist.deployed_task ? 'checked' : ''} disabled>
                            <label class="form-check-label">
                                <strong>2. Deployed the Task</strong>
                                ${empChecklist.deployed_task ? '<span class="badge bg-success ms-2">✓</span>' : '<span class="badge bg-secondary ms-2">✗</span>'}
                            </label>
                        </div>
                        
                        <div class="form-check mb-2">
                            <input class="form-check-input" type="checkbox" ${empChecklist.user_manual ? 'checked' : ''} disabled>
                            <label class="form-check-label">
                                <strong>3. User Manual Uploaded</strong>
                                ${empChecklist.user_manual ? '<span class="badge bg-success ms-2">✓</span>' : '<span class="badge bg-secondary ms-2">✗</span>'}
                            </label>
                        </div>
                        
                        <div class="form-check mb-2">
                            <input class="form-check-input" type="checkbox" ${empChecklist.documentation ? 'checked' : ''} disabled>
                            <label class="form-check-label">
                                <strong>4. Documentation Submission</strong>
                                ${empChecklist.documentation ? '<span class="badge bg-success ms-2">✓</span>' : '<span class="badge bg-secondary ms-2">✗</span>'}
                            </label>
                        </div>
                        
                        <div class="form-check mb-2">
                            <input class="form-check-input" type="checkbox" ${empChecklist.tested_code ? 'checked' : ''} disabled>
                            <label class="form-check-label">
                                <strong>5. Manually Tested the Code</strong>
                                ${empChecklist.tested_code ? '<span class="badge bg-success ms-2">✓</span>' : '<span class="badge bg-secondary ms-2">✗</span>'}
                            </label>
                        </div>
                    `;
                }
            }
        } catch (error) {
            console.error("Error loading checklists:", error);
            const displayDiv = document.getElementById("employeeChecklistDisplay");
            if (displayDiv) {
                displayDiv.innerHTML = `
                    <div class="alert alert-warning">
                        <i class="fa fa-exclamation-triangle"></i> Could not load employee checklist
                    </div>
                `;
            }
        }
    }
    async loadAttachedFiles(kpi_id) {
        try {
            const result = await rpc('/kpi/progress/list', { kpi_id: kpi_id });
            if (result.status) {
                // Extract only updates that have files, in reverse order (latest first)
                this.state.attachedFiles = result.updates
                    .filter(update => update.has_file)
                    .map(update => ({
                        id: update.id,
                        file_name: update.file_name,
                        employee_name: update.employee_name,
                        create_date: update.create_date,
                        summary: update.summary || '',   // Part D: link back to the note
                        view_url: `/kpi/progress/view?progress_id=${update.id}`,
                        download_url: `/kpi/progress/download?progress_id=${update.id}`
                    }));
            }
        } catch (error) {
            console.error('Error loading attached files:', error);
        }
    }

    // Part D: jump from an attached file to its progress-history note (+ brief highlight).
    scrollToNote(id) {
        const el = document.getElementById('prog-' + id);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.remove('kpi-flash');
        void el.offsetWidth;  // restart the CSS animation
        el.classList.add('kpi-flash');
    }

    // Part E: consolidated sortable resource sections (reuse /task_documents/details).
    async loadResourceSections(kpi_id) {
        try {
            const res = await rpc('/task_documents/details', { task_id: kpi_id });
            const d = (res && res.documents) || {};
            const files = (d.files || []).map(f => ({ ...f, _kind: 'file' }));
            const manuals = (d.manuals || []).map(m => ({ ...m, _kind: 'manual' }));
            this.state.docSections = {
                github: d.github || [],
                documents: files.concat(manuals),
                drive: d.links || [],
            };
        } catch (e) {
            this.state.docSections = { github: [], documents: [], drive: [] };
        }
    }

    // Reusable sorter: newest/oldest by a date string, or by a name field.
    sortItems(arr, mode, dateKey, nameKey) {
        const out = (arr || []).slice();
        if (mode === 'name') {
            out.sort((a, b) => String(a[nameKey] || '').localeCompare(String(b[nameKey] || '')));
        } else {
            out.sort((a, b) => String(a[dateKey] || '').localeCompare(String(b[dateKey] || '')));
            if (mode === 'newest') out.reverse();
        }
        return out;
    }
    sortedGithub()    { return this.sortItems(this.state.docSections.github,    this.state.resSort.github,    'upload_date', 'github_url'); }
    sortedDocuments() { return this.sortItems(this.state.docSections.documents, this.state.resSort.documents, 'upload_date', 'file_name'); }
    sortedDrive()     { return this.sortItems(this.state.docSections.drive,     this.state.resSort.drive,     'added_date', 'url'); }

    // User Manual Methods
   async loadUserManualInfo(kpi_id) {
        try {
            const result = await rpc('/kpi/manual/list', { kpi_id: kpi_id });
            if (result.status) {
                this.state.manualsList = result.manuals.map(manual => {
                    let links = [];
                    try {
                        links = JSON.parse(manual.related_links || '[]');
                    } catch (e) {
                        links = [];
                    }
                    return {
                        ...manual,
                        links: links
                    };
                });
            }
        } catch (error) {
            console.error('Error loading user manuals:', error);
        }
    }

    // Same limits the server enforces, checked here so an obviously-wrong file is
    // refused before anyone waits for an upload. The server is still the rule.
    static MANUAL_MAX_BYTES = 25 * 1024 * 1024;
    static MANUAL_EXTENSIONS = ['.pdf', '.doc', '.docx'];

    handleManualUpload(event) {
        const file = event.target.files[0];
        this.state.manualForm.error = '';
        this.state.manualForm.file = null;
        this.state.manualForm.file_name = '';
        this.state.manualForm.size_display = '';
        if (!file) { return; }

        const name = (file.name || '').toLowerCase();
        if (!KpiAction.MANUAL_EXTENSIONS.some((ext) => name.endsWith(ext))) {
            this.state.manualForm.error = 'Only PDF, DOC and DOCX files can be uploaded as a manual.';
            event.target.value = '';
            return;
        }
        if (file.size > KpiAction.MANUAL_MAX_BYTES) {
            this.state.manualForm.error =
                `That file is ${this._fmtBytes(file.size)}. The limit is ` +
                `${KpiAction.MANUAL_MAX_BYTES / (1024 * 1024)} MB.`;
            event.target.value = '';
            return;
        }
        // Keep the File itself — the multipart upload posts it directly, so
        // there is no FileReader to wait on and the button enables immediately.
        this.state.manualForm.file = file;
        this.state.manualForm.file_name = file.name;
        this.state.manualForm.size_display = this._fmtBytes(file.size);
    }

    _fmtBytes(n) {
        if (n >= 1024 * 1024) { return (n / (1024 * 1024)).toFixed(1) + ' MB'; }
        if (n >= 1024) { return Math.round(n / 1024) + ' KB'; }
        return n + ' B';
    }

    /** Seconds → "45s" / "2m 05s". Rounded, because an ETA that claims
     *  precision it does not have reads as broken when it jumps. */
    _fmtEta(secs) {
        if (!isFinite(secs) || secs < 0) { return ''; }
        secs = Math.round(secs);
        if (secs < 60) { return secs + 's'; }
        const m = Math.floor(secs / 60);
        return m + 'm ' + String(secs % 60).padStart(2, '0') + 's';
    }

    /** Fresh rate tracker for one upload.
     *
     *  Smoothed over a short window rather than reported instantaneously: raw
     *  Δloaded/Δt between two progress events swings wildly enough to be
     *  unreadable, and a number that flickers between 200 KB/s and 8 MB/s is
     *  worse than none. Returns a function you feed {loaded,total} on every
     *  progress event; it hands back {percent, speed, eta, loaded, total}.
     */
    _makeRateTracker() {
        const samples = [];          // [{t, loaded}] over the last ~3s
        const WINDOW_MS = 3000;
        const start = Date.now();
        return ({ loaded, total }) => {
            const now = Date.now();
            samples.push({ t: now, loaded });
            while (samples.length > 2 && now - samples[0].t > WINDOW_MS) { samples.shift(); }
            const first = samples[0];
            const dt = (now - first.t) / 1000;
            const db = loaded - first.loaded;
            // Fall back to the whole-upload average until the window has filled,
            // so the very first events still show something sensible.
            const speed = dt > 0.25 ? db / dt : (loaded / Math.max(0.25, (now - start) / 1000));
            const remaining = Math.max(0, (total || 0) - loaded);
            return {
                loaded,
                total,
                percent: total ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
                speed,
                eta: speed > 0 ? remaining / speed : Infinity,
            };
        };
    }

    async submitUserManual() {
        const form = this.state.manualForm;
        if (!form.file) {
            form.error = 'Please select a file.';
            return;
        }
        form.error = '';
        form.uploading = true;
        form.percent = 0;
        form.speed_display = '';
        form.eta_display = '';
        form.sent_display = '';
        try {
            const fd = new FormData();
            fd.append('kpi_id', this.state.detailKpiId);
            fd.append('file', form.file, form.file.name);
            fd.append('description', form.description || '');
            fd.append('related_links', JSON.stringify(form.related_links || []));

            // uploadWithProgress has always handed over loaded+total; this only
            // ever kept `percent`, so a big upload showed a bar creeping along
            // with no way to tell whether it was moving at 5 MB/s or had stalled.
            const rate = this._makeRateTracker();
            const { promise, xhr } = uploadWithProgress('/kpi/manual/upload_file', fd, (p) => {
                const r = rate(p);
                form.percent = r.percent;
                form.sent_display = `${this._fmtBytes(r.loaded)} / ${this._fmtBytes(r.total)}`;
                form.speed_display = `${this._fmtBytes(r.speed)}/s`;
                form.eta_display = this._fmtEta(r.eta);
            });
            // Captured so Cancel can abort — the manual path never kept the xhr,
            // so a wrong 25 MB file could only be waited out.
            form.xhr = xhr;
            const result = await promise;

            if (result && result.status) {
                this.state.manualForm = this._blankManualForm();
                this.state.showManualUpload = false;
                await this.loadUserManualInfo(this.state.detailKpiId);
            } else {
                // The server's own reason — "Only PDF, DOC and DOCX…",
                // "Not authorized" — instead of one catch-all string that sent
                // people looking at their network connection.
                form.error = (result && result.message) || 'The server rejected the upload.';
            }
        } catch (error) {
            console.error('Error uploading user manual:', error);
            // An abort is the user's own doing, not a failure to report at them.
            form.error = (error && error.message === 'aborted')
                ? '' : ((error && error.message) || 'Failed to upload user manual.');
        } finally {
            form.uploading = false;
            form.xhr = null;
        }
    }

    /** Cancel an in-flight manual upload. */
    cancelManualUpload() {
        const form = this.state.manualForm;
        if (form.xhr) { try { form.xhr.abort(); } catch (e) { /* already gone */ } }
        form.uploading = false;
        form.percent = 0;
        form.xhr = null;
    }

    /** The manual form's empty state, in one place — it is reset from three
     *  different points and they had started to disagree about which keys exist. */
    _blankManualForm() {
        return {
            file: null,
            file_data: null,
            file_name: '',
            size_display: '',
            description: '',
            related_links: [],
            link_input: '',
            uploading: false,
            percent: 0,
            sent_display: '',
            speed_display: '',
            eta_display: '',
            error: '',
            xhr: null,
        };
    }
    async deleteManual(manual_id) {
        if (!await this._confirm('Delete this manual?', 'This cannot be undone.', 'Delete', 'btn-danger')) {
            return;
        }
        
        try {
            const result = await rpc('/kpi/manual/delete', { manual_id: manual_id });
            if (result.status) {
                this._toast('Manual deleted successfully', 'success');
                await this.loadUserManualInfo(this.state.detailKpiId);
            } else {
                this._toast('Error: ' + result.message, 'danger');
            }
        } catch (error) {
            console.error('Error deleting manual:', error);
            this._toast('Failed to delete manual', 'danger');
        }
    }
    addLink() {
        const link = this.state.progressForm.link_input.trim();
        
        if (!link) {
            this._toast('Please enter a link', 'warning');
            return;
        }
        
        // Basic URL validation
        try {
            new URL(link);
        } catch (e) {
            this._toast('Please enter a valid URL (e.g., https://example.com)', 'warning');
            return;
        }
        
        this.state.progressForm.related_links.push(link);
        this.state.progressForm.link_input = '';
    }
    
    removeLink(index) {
        this.state.progressForm.related_links.splice(index, 1);
    }
    // 🆕 NEW: Methods for User Manual Related Links
    addManualLink() {
        const link = this.state.manualForm.link_input.trim();
        
        if (!link) {
            this._toast('Please enter a link', 'warning');
            return;
        }
        
        // Basic URL validation
        try {
            new URL(link);
        } catch (e) {
            this._toast('Please enter a valid URL (e.g., https://example.com)', 'warning');
            return;
        }
        
        this.state.manualForm.related_links.push(link);
        this.state.manualForm.link_input = '';
    }

    removeManualLink(index) {
        this.state.manualForm.related_links.splice(index, 1);
    }

    formatDate(dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        return date.toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }
    // 🆕 NEW: Validate GitHub URL
    isValidGithubUrl(url) {
        if (!url || !url.trim()) {
            return false;
        }
        
        // Check if URL starts with github.com
        const githubPattern = /^https?:\/\/(www\.)?github\.com\/.+/i;
        return githubPattern.test(url.trim());
    }

    // 🆕 NEW: Add GitHub Link
    async addGithubLink() {
        const github_url = this.state.progressForm.github_url.trim();
        const branch_name = this.state.progressForm.branch_name.trim();
        
        // Validation
        if (!github_url) {
            this._toast('Please enter a GitHub URL', 'warning');
            return;
        }
        
        if (!this.isValidGithubUrl(github_url)) {
            this._toast('Please enter a valid GitHub URL (must start with https://github.com/)', 'warning');
            return;
        }
        
        if (!branch_name) {
            this._toast('Please enter a branch name', 'warning');
            return;
        }
        
        try {
            const result = await rpc('/kpi/github/add', {
                kpi_id: this.state.detailKpiId,
                github_url: github_url,
                branch_name: branch_name,
            });
            
            if (result.status) {
                this._toast('✅ GitHub link added successfully!', 'success');
                // Clear form
                this.state.progressForm.github_url = '';
                this.state.progressForm.branch_name = '';
                // Reload GitHub links
                await this.loadGithubLinks(this.state.detailKpiId);
            } else {
                this._toast('❌ Error: ' + result.message, 'danger');
            }
        } catch (error) {
            console.error('Error adding GitHub link:', error);
            this._toast('Failed to add GitHub link', 'danger');
        }
    }

    // 🆕 NEW: Load GitHub Links
    async loadGithubLinks(kpi_id) {
        try {
            const result = await rpc('/kpi/github/list', { kpi_id: kpi_id });
            if (result.status) {
                this.state.githubLinks = result.links;
            }
        } catch (error) {
            console.error('Error loading GitHub links:', error);
        }
    }

    // 🆕 NEW: Delete GitHub Link
    async deleteGithubLink(link_id) {
        if (!await this._confirm('Delete this GitHub link?', 'This cannot be undone.', 'Delete', 'btn-danger')) {
            return;
        }
        
        try {
            const result = await rpc('/kpi/github/delete', { link_id: link_id });
            if (result.status) {
                this._toast('GitHub link deleted successfully', 'success');
                await this.loadGithubLinks(this.state.detailKpiId);
            } else {
                this._toast('Error: ' + result.message, 'danger');
            }
        } catch (error) {
            console.error('Error deleting GitHub link:', error);
            this._toast('Failed to delete GitHub link', 'danger');
        }
    }

    async openKpiDetail(id) {
        console.log("Opening KPI detail for ID:", id);
        this.state.view = 'detail';
        this.state.detailKpiId = id;
        this.state.detailLoaded = false;
        this.state.detailError = null;
        this.state.progressForm.summary = '';
        this.state.progressForm.uploaded_file = null;
        this.state.progressForm.file_name = '';
        this.state.progressForm.related_links = [];  // 🆕 NEW
        this.state.progressForm.link_input = '';   // 🆕 NEW
        this.state.progressForm.github_url = '';      // 🆕 NEW
        this.state.progressForm.branch_name = '';     // 🆕 NEW
        this.state.githubLinks = [];                  // 🆕 NEW
        this.state.reassignmentHistory = [];  // 🆕 NEW
        this.state.manualForm.related_links = []; 
        this.state.manualForm.description = '';  // ✅ ADD this
        this.state.manualsList = [];             // ✅ ADD this // 
        this.state.manualForm.link_input = '';     // 🆕 NEW: Reset manual link input
        this.state.attachedFiles = [];  // 🆕 ADD THIS LINE
        this.state.docSections = { github: [], documents: [], drive: [] };  // Part E reset

        await this.loadKpiDetail(id);
        await this.loadProgressUpdates(id);
        await this.loadUserManualInfo(id);
        await this.loadReassignmentHistory(id);  // 🆕 NEW
        await this.loadAttachedFiles(id);  // 🆕 ADD THIS LINE
        await this.loadGithubLinks(id);  // 🆕 NEW
        await this.loadResourceSections(id);  // Part E: sortable resource sections
    }

    async loadKpiDetail(id) {
        try {
            const result = await rpc("/kpi_action/details", { id: parseInt(id) });
            
            if (result && result.name) {
                this.state.detailData = result;
                this.state.detailError = null;
            } else {
                this.state.detailError = "Failed to load KPI details";
            }
        } catch (error) {
            console.error("Error loading KPI details:", error);
            this.state.detailError = `Error: ${error.message || 'Failed to load KPI details'}`;
        } finally {
            this.state.detailLoaded = true;
        }
    }

    backToList() {
        this.state.view = 'list';
        this.state.detailKpiId = null;
        this.state.detailData = {};
        this.state.detailLoaded = false;
        this.state.detailError = null;
        this.state.progressUpdates = [];
        this.state.reassignmentHistory = [];  // 🆕 NEW
        this.state.metaEdit = { editing: false, saving: false, name: '', type: '', kra_id: '' };
        this.refresh();
    }

    beginMetaEdit() {
        const d = this.state.detailData || {};
        this.state.metaEdit = {
            editing: true,
            saving: false,
            name: d.name || '',
            type: d.type || 'requirement',
            kra_id: d.kra_id ? String(d.kra_id) : '',
        };
    }
    cancelMetaEdit() {
        this.state.metaEdit = { editing: false, saving: false, name: '', type: '', kra_id: '' };
    }
    async saveMetaEdit() {
        const e = this.state.metaEdit;
        const name = (e.name || '').trim();
        if (!name) { this._toast('Task name cannot be empty.', 'warning'); return; }
        if (!e.kra_id) { this._toast('Please pick a project.', 'warning'); return; }
        this.state.metaEdit.saving = true;
        try {
            const r = await rpc('/kpi_action/update_meta', {
                id: this.state.detailKpiId,
                name: name,
                type: e.type,
                kra_id: parseInt(e.kra_id, 10),
            });
            if (!r.status) { this._toast('Save failed: ' + (r.message || 'unknown'), 'danger'); return; }
            this.state.metaEdit = { editing: false, saving: false, name: '', type: '', kra_id: '' };
            await this.loadKpiDetail(this.state.detailKpiId);
        } finally {
            this.state.metaEdit.saving = false;
        }
    }

    yesNo(value) {
        return value ? "Yes" : "No";
    }
    parseRelatedLinks(linksJson) {
        try {
            if (!linksJson) return [];
            const parsed = JSON.parse(linksJson);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.error("Error parsing related links:", e);
            return [];
        }
    }

    getButtonsForState(task) {
        const state = task.task_state;
        // States with no developer action left. 'awaiting_client' belongs here:
        // the work is done and sitting on the client's desk, so there is nothing
        // to start. It used to fall through to the catch-all Start branch below
        // and render a permanently-disabled Start button, which reads as a task
        // you could pick up if only something were fixed. The admin's Revert is
        // the one action available here and it lives in the template.
        if (state === "completed" || state === "partially_completed" || state === "awaiting_client") {
            return { start: false, pause: false, resume: false, complete: false };
        }
        if (state === "in_progress") {
            return { start: false, pause: true, resume: false, complete: true };
        }
        if (state === "paused") {
            // Resume is gated exactly like Start. _start_block checks the workday
            // BEFORE its resumable-states early return, so resuming a paused task
            // with no workday open already raised server-side — the button simply
            // did not know, so it offered an action that could only fail after a
            // round-trip. This is the one Resume path in this method; 'rework' and
            // 'hold' fall through to the Start branch, which was already gated.
            //
            // Complete stays enabled on purpose: finishing is not starting work,
            // the server does not gate it on the workday, and someone who
            // finished before ending their day must still be able to submit.
            const resumeBlocked = task.can_start === false;
            return {
                start: false, pause: false, complete: true,
                resume: true,
                resumeDisabled: resumeBlocked,
                resumeTitle: resumeBlocked
                    ? (task.start_block_message || "This task can't resume yet.")
                    : "Pick this task back up",
            };
        }
        // Everything else offers Start — but DISABLED when the server says the
        // task isn't startable yet, with the server's own reason as the tooltip.
        // can_start comes from kra.kpi._start_block via /kra_kpi/tasks/get, so
        // this button can never again offer an action the server will refuse.
        // (Older payloads have no can_start; treat that as "allowed" so the
        // button behaves exactly as it did before rather than locking up.)
        const blocked = task.can_start === false;
        return {
            start: true,
            startDisabled: blocked,
            startTitle: blocked
                ? (task.start_block_message || "This task can't start yet.")
                : "Start working on this task",
            pause: false, resume: false, complete: false,
        };
    }

    /** Short "waiting on X" line for a task the server won't start yet. */
    gateLabel(task) {
        if (task.can_start !== false) return "";
        // Finished work has nothing to wait for. can_start is false for a
        // COMPLETED task too — you cannot start it because it is done — so this
        // used to fall through and stamp "Waiting for the client to approve" on
        // finished cards. The badge answers "why is Start greyed out?", which is
        // not a question anyone is asking about a completed task.
        if (["completed", "awaiting_client", "partially_completed"].includes(task.task_state)) {
            return "";
        }
        // Checked FIRST because it is about the viewer, not the task: without it
        // this fell through to "Waiting for the client to approve", which is
        // simply untrue when the real reason is that they haven't started their
        // own day. Blaming the client for the developer's own gate is the kind
        // of wrong message that generates a support question.
        if (task.start_block_reason === "workday") {
            return "Start your workday to work on tasks";
        }
        // Paused is a different fix from never-started: the button they need
        // says Resume, so telling them to "start" sends them hunting.
        if (task.start_block_reason === "workday_paused") {
            return "Resume your workday to work on tasks";
        }
        // Also about the viewer: something of theirs is already running and
        // multi-task is off. It fell through to the client message, which blames
        // the wrong party for a limit they can clear themselves.
        if (task.start_block_reason === "multitask") {
            return "Pause your running task first";
        }
        if (task.start_block_reason === "admin") {
            return task.admin_accept_deadline_at
                ? `Waiting on admin — accepts automatically ${this._fmtWhen(task.admin_accept_deadline_at)}`
                : "Waiting for an admin to accept this task";
        }
        if (task.pre_approval_held) return "Client put approval on hold";
        return task.pre_approval_release_at
            ? `Waiting on client — releases ${this._fmtWhen(task.pre_approval_release_at)}`
            : "Waiting for the client to approve";
    }

    /** "at 14:35" for a server UTC timestamp, rendered in the browser's zone. */
    _fmtWhen(serverTs) {
        if (!serverTs) return "";
        // Server sends 'YYYY-MM-DD HH:MM:SS' in UTC; Safari/iOS won't parse that
        // form, so build the Date explicitly rather than trusting the string.
        const m = String(serverTs).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
        if (!m) return "";
        const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
        return "at " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    // =========================================================
    // 🆕 Developer self-created tasks — "Pending Review" lane
    // =========================================================
    _flattenKras(nodes, prefix) {
        // Flatten the KRA tree from /kra_kpi/get_kra_list into {id, label} options.
        let out = [];
        for (const n of (nodes || [])) {
            out.push({ id: n.id, label: (prefix || '') + n.name });
            if (n.children && n.children.length) {
                out = out.concat(this._flattenKras(n.children, (prefix || '') + n.name + ' / '));
            }
        }
        return out;
    }

    async openNewTaskModal() {
        // Load the project (KRA) list for the dropdown, then render the modal.
        let kras = [];
        try {
            const res = await rpc("/kra_kpi/get_kra_list", {});
            kras = this._flattenKras(res && res.tree ? res.tree : [], '');
        } catch (e) {
            kras = [];
        }
        const options = kras.map(k =>
            `<option value="${k.id}">${(k.label || '').replace(/</g, '&lt;')}</option>`).join('');

        // Assignee picker — admins only. A developer filing their own task has
        // nobody else to choose, and the route enforces that too. Uses
        // /kra_kpi/get_users, which already excludes clients, portal users and
        // OdooBot; the unfiltered searchRead in kpi_create.js leaks all three.
        let userOptions = '';
        if (this.state.isAdmin) {
            let users = [];
            try {
                // Returns a bare [{id, name}] list, not a {status, users} envelope.
                const ures = await rpc("/kra_kpi/get_users", {});
                users = Array.isArray(ures) ? ures : [];
            } catch (e) {
                users = [];
            }
            // Default to the admin's own name, matching every other "who is this
            // for?" field in the product — you are the most likely answer.
            const me = this.state.currentUserId;
            userOptions = users.map(u =>
                `<option value="${u.id}"${u.id === me ? ' selected' : ''}>${(u.name || '').replace(/</g, '&lt;')}</option>`
            ).join('');
        }
        const assigneeBlock = this.state.isAdmin ? `
                    <div class="mb-2">
                      <label class="form-label fw-bold">Developer *</label>
                      <select id="ntUser" class="form-select">${userOptions}</select>
                      <small class="text-muted">Who this task is for. Defaults to you.</small>
                    </div>` : '';

        const html = `
            <div class="modal fade show" tabindex="-1" style="display:block; background:rgba(0,0,0,0.5);">
              <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content">
                  <div class="modal-header">
                    <h5 class="modal-title">➕ New Task — Pending Review</h5>
                    <button type="button" class="btn-close" id="closeModalBtn"></button>
                  </div>
                  <div class="modal-body">
                    <div class="mb-2">
                      <label class="form-label fw-bold">Task Name *</label>
                      <input id="ntName" class="form-control" placeholder="What needs doing?"/>
                    </div>
                    <div class="mb-2">
                      <label class="form-label fw-bold">Project (KRA) *</label>
                      <select id="ntKra" class="form-select"><option value="">— choose a project —</option>${options}</select>
                    </div>
                    ${assigneeBlock}
                    <div class="row">
                      <div class="col mb-2">
                        <label class="form-label fw-bold">Estimate Hours</label>
                        <input id="ntHours" type="number" min="0" value="0" class="form-control"/>
                      </div>
                      <div class="col mb-2">
                        <label class="form-label fw-bold">Minutes</label>
                        <input id="ntMinutes" type="number" min="0" max="59" value="0" class="form-control"/>
                      </div>
                    </div>
                    <div class="mb-2">
                      <label class="form-label fw-bold">Priority</label>
                      <select id="ntPriority" class="form-select">
                        <option value="regular">Regular</option>
                        <option value="important">Important</option>
                        <option value="urgent">Urgent</option>
                      </select>
                    </div>
                    <div class="mb-2">
                      <label class="form-label fw-bold">Type</label>
                      <select id="ntDocType" class="form-select">
                        <option value="requirement">Requirement</option>
                        <option value="update">Update</option>
                        <option value="bug">Bug</option>
                      </select>
                      <small class="text-muted">What you think this is. The admin sees your
                        answer when they accept it and makes the final call.</small>
                    </div>
                    <div class="mb-2">
                      <label class="form-label fw-bold">Description</label>
                      <textarea id="ntDesc" class="form-control" rows="3"></textarea>
                    </div>
                    <div class="alert alert-info small mb-0">
                      This goes to your <b>Pending Review</b> lane. <b>Start stays locked</b>
                      until an admin accepts it — which happens automatically if nobody acts
                      within the accept window. Your client is then asked to approve you, and
                      the task releases for work once they do (or automatically if they don't
                      reply in time). The card shows what it is waiting on.
                    </div>
                  </div>
                  <div class="modal-footer">
                    <button class="btn btn-secondary" id="cancelModalBtn">Cancel</button>
                    <button class="btn btn-primary" id="confirmModalBtn">Create Task</button>
                  </div>
                </div>
              </div>
            </div>`;
        this._renderModal(html, () => this.submitNewTask());
    }

    async submitNewTask() {
        const g = (id) => document.getElementById(id);
        const name = (g('ntName') && g('ntName').value || '').trim();
        const kra_id = g('ntKra') && g('ntKra').value || '';
        const estimate_hours = parseInt((g('ntHours') && g('ntHours').value) || '0', 10) || 0;
        const estimate_minutes = parseInt((g('ntMinutes') && g('ntMinutes').value) || '0', 10) || 0;
        const priority = (g('ntPriority') && g('ntPriority').value) || 'regular';
        const doc_type = (g('ntDocType') && g('ntDocType').value) || 'requirement';
        const description = (g('ntDesc') && g('ntDesc').value) || '';
        // Only present for admins; the route falls back to the caller when it is
        // absent, and refuses it outright from a non-admin.
        const user_id = parseInt((g('ntUser') && g('ntUser').value) || '0', 10) || 0;
        if (!name) { this._toast('Please enter a task name.', 'warning'); return; }
        if (!kra_id) { this._toast('Please choose a project (KRA).', 'warning'); return; }
        if (this.state.isAdmin && !user_id) { this._toast('Please choose a developer.', 'warning'); return; }
        // Estimate deliberately NOT required — same as the requirements upload.
        // The admin fills it in when accepting.
        try {
            const res = await rpc('/kra_kpi/task/self_create', {
                name, kra_id: parseInt(kra_id, 10),
                estimate_hours, estimate_minutes, priority, doc_type, description,
                user_id,
            });
            if (res && res.status) {
                this.closeModal();
                await this.refresh();
            } else {
                this._toast((res && res.message) || 'Could not create the task.', 'danger');
            }
        } catch (e) {
            this._toast('Create failed: ' + ((e && e.message) || e), 'danger');
        }
    }

    async acceptSelfTask(task) {
        // Ask the admin to categorize the task; the chosen type re-numbers its
        // provisional TASK-### ref into REQ / UPT / BUG.
        const safe = (task.name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // What the requester actually wrote. This modal is where an admin decides whether
        // to accept the task at all, and it showed only the title and the requested type —
        // the one screen where the detail matters most was the one screen without it.
        // Escaped the same way as the title: this is innerHTML, not a QWeb t-esc.
        const safeDesc = (task.description || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const container = document.getElementById("modalContainer");
        if (!container) return;
        container.innerHTML = `
            <div class="modal-backdrop fade show"></div>
            <div class="modal d-block" tabindex="-1">
              <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content">
                  <div class="modal-header bg-primary text-white">
                    <h5 class="modal-title"><i class="fa fa-check-circle me-2"></i> Accept task</h5>
                    <button type="button" class="btn-close btn-close-white" id="acceptTypeClose"></button>
                  </div>
                  <div class="modal-body">
                    <p class="mb-1">Accept <b>"${safe}"</b> into the main flow — what type is it?</p>
                    <p class="text-muted small mb-2">This sets its reference id — the current <b>${(task.external_ref || 'TASK-###')}</b> becomes REQ / UPT / BUG.</p>
                    ${safeDesc ? `
                      <div class="border rounded p-2 mb-3 bg-light">
                        <div class="text-muted small fw-bold mb-1"><i class="fa fa-file-text-o me-1"></i>Description</div>
                        <div class="small" style="white-space:pre-wrap;max-height:140px;overflow:auto;">${safeDesc}</div>
                      </div>` : ''}
                    ${task.requested_doc_type ? `
                      <div class="alert alert-light border small py-2 mb-3">
                        <i class="fa fa-user me-1"></i>
                        The developer said this is a <b>${this.docTypeLabel(task.requested_doc_type)}</b>.
                        Their choice is highlighted below — yours is what gets saved.
                      </div>` : ''}
                    <!-- The developer's own choice, shown so the admin decides
                         against it rather than blind. Pre-selected below, so
                         accepting without touching it honours their request. -->
                    <div class="mb-3">
                      <label class="form-label fw-bold mb-1">Priority</label>
                      ${task.requested_priority ? `
                        <div class="small text-muted mb-1">
                          Developer asked for <b>${this.priorityLabel(task.requested_priority)}</b>
                        </div>` : ''}
                      <select id="acceptPriority" class="form-select">
                        <option value="urgent">🔴 Urgent</option>
                        <option value="important">🟡 Important</option>
                        <option value="regular">⚪ Regular</option>
                      </select>
                    </div>
                    <!-- The developer's answer is highlighted (solid, not outline) so
                         the admin sees it without it being pre-clicked: the type is
                         only saved when the admin actually presses one. -->
                    <div class="d-grid gap-2">
                      <button class="btn ${task.requested_doc_type === 'requirement' ? 'btn-primary' : 'btn-outline-primary'}" data-type="requirement"><b>Requirement</b> <span class="small">→ REQ-###</span></button>
                      <button class="btn ${task.requested_doc_type === 'update' ? 'btn-warning' : 'btn-outline-warning'}" data-type="update"><b>Update</b> <span class="small">→ UPT-###</span></button>
                      <button class="btn ${task.requested_doc_type === 'bug' ? 'btn-danger' : 'btn-outline-danger'}" data-type="bug"><b>Bug Report</b> <span class="small">→ BUG-###</span></button>
                    </div>
                  </div>
                  <div class="modal-footer">
                    <button type="button" class="btn btn-light" id="acceptTypeCancel">Cancel</button>
                  </div>
                </div>
              </div>
            </div>`;
        const close = () => { container.innerHTML = ""; };
        document.getElementById("acceptTypeClose").addEventListener("click", close);
        document.getElementById("acceptTypeCancel").addEventListener("click", close);
        // Default the picker to what the developer asked for: accepting without
        // touching it honours their request, and changing it is a deliberate act.
        const prioSel = document.getElementById("acceptPriority");
        if (prioSel) prioSel.value = task.requested_priority || task.priority || 'regular';
        container.querySelectorAll('button[data-type]').forEach((btn) => {
            btn.addEventListener("click", async () => {
                const docType = btn.getAttribute("data-type");
                const priority = (prioSel && prioSel.value) || undefined;
                close();
                try {
                    const res = await rpc('/kra_kpi/task/accept_self_created', { kpi_id: task.id, doc_type: docType, priority });
                    if (res && res.status) {
                        await this.refresh();
                    } else {
                        this._toast((res && res.message) || 'Accept failed.', 'danger');
                    }
                } catch (e) {
                    this._toast('Accept failed: ' + ((e && e.message) || e), 'danger');
                }
            });
        });
    }

    async rejectSelfTask(task) {
        const safeName = (task.name || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const html = `
            <div class="modal fade show" tabindex="-1" style="display:block; background:rgba(0,0,0,0.5);">
              <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content border-danger shadow">
                  <div class="modal-header bg-danger text-white">
                    <h5 class="modal-title"><i class="fa fa-exclamation-triangle me-2"></i> Send task back to developer?</h5>
                    <button type="button" class="btn-close btn-close-white" id="closeModalBtn"></button>
                  </div>
                  <div class="modal-body">
                    <div class="alert alert-warning mb-3">
                      You're about to send <b>"${safeName}"</b> back for revision:
                      <ul class="mb-0 mt-2">
                        <li>The task is <b>paused</b> — the timer stops, but time logged so far is kept.</li>
                        <li>It stays in the developer's <b>Pending Review</b> lane — nothing is deleted.</li>
                        <li>The developer is notified and sees your reason on the card.</li>
                      </ul>
                    </div>
                    <label class="form-label fw-bold">Reason for sending back</label>
                    <textarea id="rjReason" class="form-control" rows="3"
                              placeholder="e.g. Please add more detail / wrong project…"></textarea>
                    <small class="text-muted">Optional — leave blank and the card shows "Please revise".</small>
                  </div>
                  <div class="modal-footer">
                    <button class="btn btn-secondary" id="cancelModalBtn">Cancel</button>
                    <button class="btn btn-danger" id="confirmModalBtn"><i class="fa fa-reply me-1"></i> Send Back</button>
                  </div>
                </div>
              </div>
            </div>`;
        this._renderModal(html, async () => {
            const el = document.getElementById('rjReason');
            const note = (el && el.value || '').trim();
            try {
                const res = await rpc('/kra_kpi/task/reject_self_created', { kpi_id: task.id, note });
                if (res && res.status) {
                    this.closeModal();
                    await this.refresh();
                } else {
                    this._toast((res && res.message) || 'Reject failed.', 'danger');
                }
            } catch (e) {
                this._toast('Reject failed: ' + ((e && e.message) || e), 'danger');
            }
        });
    }

    // Admin: permanently remove a task nobody has worked on. Deliberately
    // modal-with-a-reason rather than a bare confirm() — the developer and the
    // client who were waiting on the task are told, and the reason is what they
    // actually read. The server re-checks _may_admin_delete, so a stale board
    // (card rendered before someone started the task) is refused, not honoured.
    async adminDeleteTask(task) {
        const safeName = ((task.external_ref ? task.external_ref + ' ' : '') + (task.name || ''))
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const html = `
            <div class="modal fade show" tabindex="-1" style="display:block; background:rgba(0,0,0,0.5);">
              <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content border-danger shadow">
                  <div class="modal-header bg-danger text-white">
                    <h5 class="modal-title"><i class="fa fa-trash me-2"></i> Delete this task?</h5>
                    <button type="button" class="btn-close btn-close-white" id="closeModalBtn"></button>
                  </div>
                  <div class="modal-body">
                    <div class="alert alert-danger mb-3">
                      <b>"${safeName}"</b> will be permanently deleted.
                      <ul class="mb-0 mt-2">
                        <li>This cannot be undone.</li>
                        <li>Only possible because <b>no time has been logged</b> against it.</li>
                        <li>The assigned developer and the client who raised it are notified.</li>
                      </ul>
                    </div>
                    <label class="form-label fw-bold">Reason</label>
                    <textarea id="delReason" class="form-control" rows="3"
                              placeholder="e.g. Raised by mistake / duplicate of REQ-042…"></textarea>
                    <small class="text-muted">Optional — shown to whoever was waiting on this task.</small>
                  </div>
                  <div class="modal-footer">
                    <button class="btn btn-secondary" id="cancelModalBtn">Cancel</button>
                    <button class="btn btn-danger" id="confirmModalBtn"><i class="fa fa-trash me-1"></i> Delete</button>
                  </div>
                </div>
              </div>
            </div>`;
        this._renderModal(html, async () => {
            const el = document.getElementById('delReason');
            const reason = (el && el.value || '').trim();
            try {
                const res = await rpc('/kra_kpi/task/admin_delete', { kpi_id: task.id, reason });
                if (res && res.status) {
                    this.closeModal();
                    await this.refresh();
                } else {
                    this._toast((res && res.message) || 'Delete failed.', 'danger');
                }
            } catch (e) {
                this._toast('Delete failed: ' + ((e && e.message) || e), 'danger');
            }
        });
    }

    // "I'm moving on to the next thing": pick a task, the running one stops and
    // the chosen one starts — one action instead of pause → reason → find → start.
    //
    // The list is filtered on can_start, the SERVER's own answer (kra.kpi
    // ._start_block), so the picker never offers something the switch would then
    // refuse. Tasks already running are excluded — switching to what you are
    // already doing is a no-op worth not offering.
    // `fromTask` is the card the button was pressed on. With multitask running,
    // ONLY that task hands over — task 1 → task 3 leaves task 2 ticking without a
    // break. Called with no argument from the top strip, which means "switch
    // whatever I'm on" and is only offered when a single task is running.
    openSwitchTask(fromTask) {
        const running = new Set(this.getActiveTasks().map((t) => t.id));
        const options = (this.state.allTasks || [])
            .filter((t) => !running.has(t.id) && t.can_start !== false)
            .sort((a, b) => (a.external_ref || '').localeCompare(b.external_ref || ''));

        const esc = (x) => (x == null ? '' : String(x))
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // Full cards, same shape as the board — you are choosing what to work on
        // next, and a bare title is not enough to choose on. Every card is
        // read-only detail plus ONE action, so there is no way to accidentally
        // start/pause something from inside the picker.
        const card = (t) => `
                <div class="col-12 col-md-6">
                  <div class="card h-100 shadow-sm" style="border:1px solid #e5e7eb;">
                    <div class="card-body p-3">
                      <div class="d-flex justify-content-between align-items-start gap-2 mb-1">
                        <b class="text-primary">${esc(t.external_ref || '')}</b>
                        <span class="badge ${this.priorityBadgeClass(t.priority)}">${esc(this.priorityLabel(t.priority))}</span>
                      </div>
                      <div class="fw-semibold mb-2" style="line-height:1.3;">${esc(t.name || '')}</div>
                      <div class="small text-muted">
                        <div><i class="fa fa-user me-1"></i>${esc(t.user_name || 'Unassigned')}</div>
                        <div><i class="fa fa-clock-o me-1"></i>Time: ${esc(this.formatTime(t.timer_total_seconds || 0))}
                             · Est: ${esc(t.estimate_display || '—')}</div>
                        ${t.deadline ? `<div><i class="fa fa-calendar me-1"></i>Due ${esc(t.deadline)}</div>` : ''}
                        ${t.task_state ? `<div><i class="fa fa-tag me-1"></i>${esc(this.filterStatusLabel(t.task_state))}</div>` : ''}
                        ${(t.paused_reason && PAUSED_STATES.includes(t.task_state))
                            ? `<div class="text-warning-emphasis"><i class="fa fa-pause-circle me-1"></i>${esc(t.paused_reason)}</div>` : ''}
                      </div>
                      <button class="btn btn-sm btn-primary w-100 mt-3" data-switch-id="${t.id}">
                        <i class="fa fa-check me-1"></i> Select this task
                      </button>
                    </div>
                  </div>
                </div>`;

        // Paused work first. Switching is nearly always "back to the thing I
        // paused", and that used to sit mixed in with every never-started task.
        const renderRows = (list, query) => {
            if (!list.length) {
                return `<div class="text-muted text-center py-4">${query
                    ? `Nothing matches &quot;${esc(query)}&quot;.`
                    : `Nothing else is ready to start. A task has to be accepted and approved
                       before you can switch to it.`}</div>`;
            }
            const paused = list.filter((t) => PAUSED_STATES.includes(t.task_state));
            const fresh = list.filter((t) => !PAUSED_STATES.includes(t.task_state));
            const group = (title, arr) => arr.length
                ? `<h6 class="text-uppercase text-muted small fw-bold mt-2 mb-2">${title} (${arr.length})</h6>
                   <div class="row g-2">${arr.map(card).join('')}</div>` : '';
            return group('Paused — pick back up', paused) + group('Not started yet', fresh);
        };
        const rows = renderRows(options, '');

        const html = `
            <div class="modal fade show" tabindex="-1" style="display:block; background:rgba(0,0,0,0.5);">
              <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable modal-lg">
                <div class="modal-content shadow">
                  <div class="modal-header bg-primary text-white">
                    <h5 class="modal-title"><i class="fa fa-exchange me-2"></i> Switch to another task</h5>
                    <button type="button" class="btn-close btn-close-white" id="swClose"></button>
                  </div>
                  <div class="modal-body">
                    <p class="text-muted small">
                      ${fromTask
                        ? `<b>${esc(fromTask.external_ref || fromTask.name || 'This task')}</b> pauses as
                           <b>Another Priority Task</b> and the one you pick starts straight away.
                           Anything else you have running is left alone.`
                        : `Your current task pauses as <b>Another Priority Task</b> and the one you
                           pick starts straight away.`}
                      Time already logged is kept.
                    </p>
                    <div class="input-group input-group-sm mb-3">
                      <span class="input-group-text"><i class="fa fa-search"></i></span>
                      <input type="text" id="swSearch" class="form-control"
                             placeholder="Search by ref, name or developer…" autocomplete="off"/>
                    </div>
                    <div class="list-group" id="swRows">${rows}</div>
                  </div>
                  <div class="modal-footer">
                    <button type="button" class="btn btn-light" id="swCancel">Cancel</button>
                  </div>
                </div>
              </div>
            </div>`;

        const container = document.getElementById("modalContainer");
        if (!container) { this._toast("Could not open the task picker.", 'danger'); return; }
        container.innerHTML = html;
        const close = () => { container.innerHTML = ''; };
        document.getElementById('swClose').addEventListener('click', close);
        document.getElementById('swCancel').addEventListener('click', close);

        const doSwitch = async (id) => {
            close();
            try {
                const res = await rpc('/kra_kpi/task/switch', {
                    kpi_id: id,
                    from_kpi_id: fromTask ? fromTask.id : null,
                });
                if (res && res.status) {
                    await this.refresh();
                    await this.loadLiveStatus();
                } else {
                    this._toast((res && res.message) || 'Could not switch task.', 'danger');
                }
            } catch (e) {
                this._toast('Switch failed: ' + ((e && e.message) || e), 'danger');
            }
        };
        // Re-bound after every re-render: this modal is raw HTML replaced
        // wholesale on each keystroke, so listeners attached to the old nodes die
        // with them. Delegating from #swRows instead would survive, but the
        // per-button binding is what the rest of this file does.
        const bindCards = () => {
            container.querySelectorAll('button[data-switch-id]').forEach((btn) => {
                btn.addEventListener('click', () =>
                    doSwitch(parseInt(btn.getAttribute('data-switch-id'), 10)));
            });
        };
        bindCards();

        const searchEl = document.getElementById('swSearch');
        const rowsEl = document.getElementById('swRows');
        if (searchEl && rowsEl) {
            searchEl.addEventListener('input', () => {
                const q = searchEl.value.trim().toLowerCase();
                // Same fields the board's own search matches on.
                const shown = !q ? options : options.filter((t) =>
                    String(t.external_ref || '').toLowerCase().includes(q)
                    || String(t.name || '').toLowerCase().includes(q)
                    || String(t.user_name || '').toLowerCase().includes(q));
                rowsEl.innerHTML = renderRows(shown, searchEl.value.trim());
                bindCards();
            });
            searchEl.focus();
        }
    }

    // Stop every running timer at once, with ONE reason. Only offered while more
    // than one task is running — with a single task the ordinary Pause button on
    // its card is the same thing and says which task it is.
    // Called as `this.openPauseAll()` from the template, so no bind() is needed.
    async openPauseAll() {
        const tasks = this.getActiveTasks();
        if (!tasks.length) return;
        const esc = (x) => (x == null ? '' : String(x))
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const list = tasks.map((t) => `<li>${esc(t.external_ref || '')} ${esc(t.name || '')}</li>`).join('');
        const html = `
            <div class="modal fade show" tabindex="-1" style="display:block; background:rgba(0,0,0,0.5);">
              <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content shadow">
                  <div class="modal-header bg-warning">
                    <h5 class="modal-title"><i class="fa fa-pause me-2"></i> Pause all ${tasks.length} tasks</h5>
                    <button type="button" class="btn-close" id="paClose"></button>
                  </div>
                  <div class="modal-body">
                    <p class="text-muted small mb-2">One reason for all of them. Time logged so far is kept.</p>
                    <ul class="small mb-3">${list}</ul>
                    <label class="form-label fw-bold">Why are you pausing?</label>
                    <select id="paCode" class="form-select form-select-sm mb-2">
                      <option value="break">☕ Break</option>
                      <option value="lunch">🍽 Lunch</option>
                      <option value="meeting">👥 Meeting</option>
                      <option value="day_end">🌙 Day End</option>
                      <option value="priority_task">🔀 Moved to another task</option>
                      <option value="awaiting_approval">Waiting for Approval</option>
                      <option value="technical_issue">Technical Issue</option>
                      <option value="leave">Leave</option>
                      <option value="other">✍ Other</option>
                      <option value="urgent">🚨 Urgent — notify now</option>
                    </select>
                    <!-- Meeting: who it is with, exactly as the single-task dialog
                         asks. The break log keeps ONE active break per user, so the
                         names are recorded once however many timers are stopping. -->
                    <div id="paMeetWrap" style="display:none;">
                        <label class="form-label fw-bold mt-1 mb-1">Who is it with?</label>
                        <input type="text" id="paMeetSearch" class="form-control form-control-sm mb-1"
                               placeholder="Search people…" autocomplete="off"/>
                        <div id="paMeetList" class="border rounded p-2"
                             style="max-height:150px; overflow-y:auto; background:#fbfcfe;">
                            <div class="text-muted small">Loading…</div>
                        </div>
                        <div id="paMeetCount" class="small text-muted mt-1">Optional — pick anyone who is in it.</div>
                    </div>
                    <!-- Other / Urgent / Meeting, same rule as the single-task dialog.
                         This asked only for Other, so the same Meeting pause was
                         mandatory in one dialog and optional in the other. It also
                         had no maxlength at all — the one way left to put a
                         paragraph into paused_reason. -->
                    <div id="paNoteWrap" style="display:none;">
                      <label id="paNoteLabel" class="form-label fw-bold mt-1 mb-1" style="display:none;">What is it about?</label>
                      <textarea id="paNote" class="form-control" rows="2" maxlength="${PAUSE_NOTE_MAX}"
                                placeholder="Why? (required)"></textarea>
                      <div class="small text-muted mt-1">Max ${PAUSE_NOTE_MAX} characters.</div>
                    </div>
                    <div id="paUrgentHint" class="small text-danger mt-1" style="display:none;">
                        <i class="fa fa-bullhorn me-1"></i> This note is sent immediately to the owner and any configured recipients.
                    </div>
                    <div id="paErr" class="alert alert-danger py-2 px-2 mt-2 mb-0 small" style="display:none;"></div>
                  </div>
                  <div class="modal-footer">
                    <button type="button" class="btn btn-light" id="paCancel">Cancel</button>
                    <button type="button" class="btn btn-warning" id="paConfirm">
                      <i class="fa fa-pause me-1"></i> Pause all
                    </button>
                  </div>
                </div>
              </div>
            </div>`;
        const container = document.getElementById("modalContainer");
        if (!container) { this._toast('Could not open the pause dialog.', 'danger'); return; }
        container.innerHTML = html;
        const close = () => { container.innerHTML = ''; };
        document.getElementById('paClose').addEventListener('click', close);
        document.getElementById('paCancel').addEventListener('click', close);
        const paCodeEl = document.getElementById('paCode');
        const paWrap = document.getElementById('paNoteWrap');
        // Participants for a Pause-all meeting. Same shape as the single dialog.
        this._paMeetWith = new Set();
        const paErr = document.getElementById('paErr');
        const showPaErr = (msg) => {
            if (!paErr) { return; }
            paErr.textContent = msg;
            paErr.style.display = msg ? 'block' : 'none';
        };
        const paSync = () => {
            const code = paCodeEl.value;
            const isMeeting = code === 'meeting';
            const needs = PAUSE_NOTE_CODES.includes(code);
            paWrap.style.display = needs ? 'block' : 'none';
            document.getElementById('paMeetWrap').style.display = isMeeting ? 'block' : 'none';
            document.getElementById('paNoteLabel').style.display = isMeeting ? 'block' : 'none';
            document.getElementById('paUrgentHint').style.display = code === 'urgent' ? 'block' : 'none';
            document.getElementById('paNote').placeholder = isMeeting
                ? 'Short — e.g. sprint planning' : 'Why? (required)';
            if (!needs) document.getElementById('paNote').value = '';
            if (!isMeeting) this._paMeetWith = new Set();
            if (isMeeting) this._loadMeetPeople('paMeetList', 'paMeetSearch', 'paMeetCount', this._paMeetWith);
            showPaErr('');
        };
        paCodeEl.addEventListener('change', paSync);
        paSync();
        document.getElementById('paConfirm').addEventListener('click', async () => {
            const code = paCodeEl.value;
            const note = (document.getElementById('paNote').value || '').trim().slice(0, PAUSE_NOTE_MAX);
            if (PAUSE_NOTE_CODES.includes(code) && !note) {
                showPaErr(code === 'meeting'
                    ? '"Meeting" on its own does not explain the time — say what it is about.'
                    : "Please say what you're pausing for.");
                document.getElementById('paNote').focus();
                return;
            }
            close();
            try {
                const res = await rpc('/kra_kpi/task/pause_all', {
                    reason_code: code, reason: note,
                    meeting_with_ids: code === 'meeting' ? Array.from(this._paMeetWith) : [],
                });
                if (res && res.status) {
                    await this.refresh();
                    await this.loadLiveStatus();
                } else {
                    this._toast((res && res.message) || 'Could not pause your tasks.', 'danger');
                }
            } catch (e) {
                this._toast('Pause all failed: ' + ((e && e.message) || e), 'danger');
            }
        });
    }

    // Admin pulls a task back out of Awaiting Client Sign-off. The reason is
    // REQUIRED: this reopens work someone believed was finished, and "why is
    // this back?" with no answer is the thing that wastes everyone's time.
    // Invoked as `this.openRevertSignoff(...)` from the template, so no bind()
    // is needed — unlike a bare-named handler, which arrives with `this`
    // undefined (see openSwitchTask).
    async openRevertSignoff(task) {
        const safe = ((task.external_ref ? task.external_ref + ' ' : '') + (task.name || ''))
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const html = `
            <div class="modal fade show" tabindex="-1" style="display:block; background:rgba(0,0,0,0.5);">
              <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content shadow">
                  <div class="modal-header bg-warning">
                    <h5 class="modal-title text-dark"><i class="fa fa-undo me-2"></i> Revert from client sign-off?</h5>
                    <button type="button" class="btn-close" id="rvClose"></button>
                  </div>
                  <div class="modal-body">
                    <div class="alert alert-secondary mb-3">
                      <b>"${safe}"</b> goes back to the developer:
                      <ul class="mb-0 mt-2">
                        <li>The <b>client stops seeing it</b> straight away.</li>
                        <li>It returns to <b>Paused</b> with your reason on the card.</li>
                        <li>The developer is notified. Time already logged is kept.</li>
                        <li>Completing it again sends it through admin review, then the client.</li>
                      </ul>
                    </div>
                    <label class="form-label fw-bold">Why is it going back?</label>
                    <textarea id="rvReason" class="form-control" rows="3"
                              placeholder="e.g. Client reported the export is still wrong"></textarea>
                  </div>
                  <div class="modal-footer">
                    <button type="button" class="btn btn-light" id="rvCancel">Cancel</button>
                    <button type="button" class="btn btn-warning text-dark fw-semibold" id="rvConfirm">
                      <i class="fa fa-undo me-1"></i> Revert
                    </button>
                  </div>
                </div>
              </div>
            </div>`;
        const container = document.getElementById("modalContainer");
        if (!container) { this._toast('Could not open the revert dialog.', 'danger'); return; }
        container.innerHTML = html;
        const close = () => { container.innerHTML = ''; };
        document.getElementById('rvClose').addEventListener('click', close);
        document.getElementById('rvCancel').addEventListener('click', close);
        document.getElementById('rvConfirm').addEventListener('click', async () => {
            const el = document.getElementById('rvReason');
            const reason = (el && el.value || '').trim();
            if (!reason) { this._toast('Please say why it is going back.', 'warning'); return; }
            close();
            try {
                const res = await rpc('/kra_kpi/task/revert_signoff', { kpi_id: task.id, reason });
                if (res && res.status) {
                    await this.refresh();
                } else {
                    this._toast((res && res.message) || 'Could not revert this task.', 'danger');
                }
            } catch (e) {
                this._toast('Revert failed: ' + ((e && e.message) || e), 'danger');
            }
        });
    }

    formatTime(sec) {
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        return `${h}h ${m}m ${s}s`;
    }

    // Colored priority chip on cards (replaces plain "Priority: x" text).
    /** Human label for a REQ/UPT/BUG code (the developer's requested type). */
    docTypeLabel(t) {
        return ({ requirement: 'Requirement', update: 'Update', bug: 'Bug' })[t] || (t || '');
    }

    priorityLabel(p) {
        return ({ urgent: '🔴 Urgent', important: '🟡 Important', regular: '⚪ Regular' })[p] || (p || 'Regular');
    }
    priorityBadgeClass(p) {
        return ({ urgent: 'bg-danger', important: 'bg-warning text-dark', regular: 'bg-secondary' })[p] || 'bg-secondary';
    }

    // =========================================================
    // 🆕 Part C — live activity strip helpers + heartbeat / auto-away
    // =========================================================
    // EVERY running task. A developer with multitask enabled can have two
    // timers going, and the live strip used to show only getActiveTask() —
    // whichever the board happened to list first — so the second task was
    // invisible while it was being worked on.
    getActiveTasks() {
        return (this.state.tasksByState && this.state.tasksByState['in_progress']) || [];
    }
    getActiveTask() {
        const list = this.getActiveTasks();
        return list.length ? list[0] : null;
    }
    _elapsedSince(rawIso, base = 0) {
        if (!rawIso) return base;
        const start = new Date(rawIso).getTime();
        if (isNaN(start)) return base;
        const now = this.state.currentTime || Date.now();
        return Math.max(0, base + Math.floor((now - start) / 1000));
    }
    liveBreakDisplay() {
        const b = this.state.liveBreak;
        if (!b || !b.start_raw) return '0h 0m 0s';
        return this.formatTime(this._elapsedSince(b.start_raw, 0));
    }
    livePresenceDisplay() {
        const ls = this.state.liveStatus;
        if (!ls || !ls.login_raw) return this.formatTime(0);
        // TIME AT WORK: the clock since login MINUS whatever the workday has been
        // paused for, matching the server's presence_seconds (which takes off the
        // same two pieces) and the app's presenceLive().
        //
        // BOTH halves are needed. paused_base holds the COMPLETED pauses;
        // paused_since is the one currently open, which the server deliberately
        // never folds into paused_seconds. Read only the base and this clock runs
        // straight through the freeze, which is what pausing exists to stop.
        const paused = (ls.paused_base || 0)
            + (ls.paused_since ? this._elapsedSince(ls.paused_since, 0) : 0);
        return this.formatTime(
            Math.max(0, this._elapsedSince(ls.login_raw, 0) - paused));
    }
    liveProductiveDisplay() {
        const ls = this.state.liveStatus;
        const base = (ls && ls.productive_base) || 0;
        const task = this.getActiveTask();
        // Finished-log seconds (base) + the CURRENT running segment's live elapsed.
        // timer_total_seconds is NOT added — its finished segments are already in base.
        let running = 0;
        if (task && task.task_state === 'in_progress' && task.timer_start_datetime) {
            const start = new Date(task.timer_start_datetime).getTime();
            if (!isNaN(start)) {
                const now = this.state.currentTime || Date.now();
                running = Math.max(0, Math.floor((now - start) / 1000));
            }
        }
        return this.formatTime(base + running);
    }

    async loadLiveStatus() {
        try {
            const res = await rpc('/kpi_action/live_status', {});
            if (res && res.status) {
                this.state.liveStatus = res;
                this.state.liveBreak = res.active_break || null;
                // Nothing running and nothing declared → ask. Ask #1 exists from the
                // moment the workday opens (the server no longer waits for the
                // 10-min cron); each cron re-ask bumps the number, so a dismissed
                // #1 can't swallow #2 and #3.
                const seq = res.idle_prompt_seq || 0;
                const snoozed = Date.now() < (this._idleSnoozeUntil || 0);
                if (res.idle_prompt && !snoozed && seq > this._idleAskedSeq) {
                    this._idleAskedSeq = seq;
                    this.state.idleModalOpen = true;
                }
                // Answered — the server drops idle_prompt for a started task, a
                // declared block, or "no tasks". Reset so a later idle stretch
                // asks from the top.
                if (!res.idle_prompt) { this._idleAskedSeq = 0; this._idleSnoozeUntil = 0; }
            }
        } catch (e) { /* non-fatal */ }
    }

    // Live elapsed for the open Meeting/Break block — mirrors liveBreakDisplay so
    // both pills tick identically off the server's clock.
    nontaskDisplay() {
        const nt = this.state.liveStatus && this.state.liveStatus.nontask;
        if (!nt || !nt.start_raw) return '0h 0m 0s';
        return this.formatTime(this._elapsedSince(nt.start_raw, 0));
    }

    // Every reason — the popup shows them all (nothing is running yet).
    allReasons() { return IDLE_REASONS; }

    askSwitch(r) { this.state.switchTo = r; }
    cancelSwitch() { this.state.switchTo = null; }
    // What is running right now, for the confirm popup's "from" row.
    currentBlock() {
        return (this.state.liveStatus && this.state.liveStatus.nontask) || null;
    }

    // The reasons that AREN'T the one currently running — clicking any of them ends
    // the open block and starts the new one, in a single click.
    otherReasons() {
        const cur = (this.state.liveStatus && this.state.liveStatus.nontask
                     && this.state.liveStatus.nontask.reason) || '';
        return IDLE_REASONS.filter((r) => r.code !== cur);
    }

    openIdleModal() { this.state.idleModalOpen = true; }

    // Closing WITHOUT answering buys a short grace, then it asks again. The modal
    // covers the board, so it must stay closable — otherwise reaching a task's
    // Start button, the very thing that answers it, would be impossible. A
    // timestamp, not a flag: the escape has to expire or it's just a loophole.
    closeIdleModal() {
        this._idleSnoozeUntil = Date.now() + IDLE_SNOOZE_MS;
        this._idleAskedSeq = 0;         // let the SAME prompt re-open once it lapses
        this.state.idleNote = '';       // don't leak a typed note onto a later reason
        this.state.idleModalOpen = false;
    }

    async chooseIdleReason(code) {
        if (this.state.idleBusy) return;
        this.state.idleBusy = code;
        try {
            // The server clamps the note too — a maxlength is a courtesy, not a
            // guarantee, and this text has to fit a Workday Map chip.
            const note = (this.state.idleNote || '').trim().slice(0, 60);
            const res = await rpc('/kpi_workday/idle_reason', { reason: code, note });
            if (res && res.status === false) {
                this._toast((res && res.message) || "Couldn't save that.", 'danger');
                return;
            }
            this.state.idleModalOpen = false;
            this.state.switchTo = null;
            this.state.idleNote = '';
            // No need to touch _idleAskedSeq — the answer drops idle_prompt
            // server-side and loadLiveStatus resets from that.
            await this.loadLiveStatus();
        } catch (e) {
            this._toast("Couldn't save that: " + ((e && e.message) || e), 'danger');
        } finally {
            this.state.idleBusy = '';
        }
    }

    async endNonTaskBlock() {
        if (this.state.nontaskBusy) return;
        this.state.nontaskBusy = true;
        try {
            const res = await rpc('/kpi_workday/end_nontask', {});
            if (res && res.status === false) {
                this._toast((res && res.message) || "Couldn't end that.", 'danger');
                return;
            }
            await this.loadLiveStatus();
            // Meeting over with no task to start — the case starting a task can't
            // cover. Re-ask now so "I have no tasks" is one click, not a 10-min
            // wait. Needed even though loadLiveStatus raises the popup on a cron
            // prompt: a block declared from the strip button never had one, so
            // idle_prompt is false and nothing else would ask. Leave
            // _idleAskedSeq alone — it tracks cron prompts, and claiming one here
            // would swallow the real prompt #1.
            if (res && res.ask_again) this.state.idleModalOpen = true;
        } catch (e) {
            this._toast("Couldn't end that: " + ((e && e.message) || e), 'danger');
        } finally {
            this.state.nontaskBusy = false;
        }
    }

    // Keeps the workday session marked alive. It no longer decides whether the
    // board may stay on screen: the PIN gate is gone, so there is nothing to be
    // bounced back to, and a heartbeat can no longer take the board away from a
    // developer who is sitting right in front of it.
    async sendHeartbeat() {
        try {
            const res = await rpc('/kpi_action/heartbeat', {});
            if (res && res.was_away && res.awayed_task_id) {
                this._showAwayReturnNudge(res.awayed_task_id, res.awayed_task_name || 'your task');
                await this.refresh();
                await this.loadLiveStatus();
            }
        } catch (e) { /* offline / non-fatal */ }
    }

    _showAwayReturnNudge(taskId, taskName) {
        const safe = (taskName || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const container = document.getElementById("modalContainer");
        if (!container) return;
        container.innerHTML = `
            <div class="modal fade show" tabindex="-1" style="display:block; background:rgba(0,0,0,0.5);">
              <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content border-warning shadow">
                  <div class="modal-header bg-warning">
                    <h5 class="modal-title"><i class="fa fa-clock-o me-2"></i> Welcome back</h5>
                    <button type="button" class="btn-close" id="closeModalBtn"></button>
                  </div>
                  <div class="modal-body">
                    <p class="mb-1">You were away, so your task was auto-paused:</p>
                    <p class="fw-bold mb-2">"${safe}"</p>
                    <p class="text-muted small mb-0">That away time is logged as <b>Away</b> — never counted as Productive. Resume when you're ready.</p>
                  </div>
                  <div class="modal-footer">
                    <button class="btn btn-outline-secondary" id="awayDismissBtn">Not yet</button>
                    <button class="btn btn-success" id="awayResumeBtn"><i class="fa fa-play me-1"></i> Resume now</button>
                  </div>
                </div>
              </div>
            </div>`;
        const close = () => this.closeModal();
        document.getElementById("closeModalBtn").addEventListener("click", close);
        document.getElementById("awayDismissBtn").addEventListener("click", close);
        document.getElementById("awayResumeBtn").addEventListener("click", async () => {
            this.closeModal();
            await this.resumeAwayTask(taskId);
        });
    }

    async resumeAwayTask(taskId) {
        try {
            const res = await rpc('/kra_kpi/task/resume', { kpi_id: taskId });
            if (res && res.status) {
                await this.refresh();
                await this.loadLiveStatus();
            } else {
                this._showAlert((res && res.message) || "Could not resume the task.", "Resume failed", "danger");
            }
        } catch (error) {
            this._showAlert(error?.data?.message || error?.message || "Could not resume the task.", "Resume failed", "danger");
        }
    }


    // =========================================================
    // 🆕 NEW: REMINDER AND DEADLINE NOTIFICATION SYSTEM
    // =========================================================
    
    // Check for reminders and deadlines for in-progress tasks
    async checkRemindersAndDeadlines() {
        const now = new Date();
        const today = now.toISOString().split('T')[0]; // Get YYYY-MM-DD format
        
        // Use allTasks which contains all tasks from the API
        const tasks = this.state.allTasks || [];
        const currentUserId = this.state.currentUserId;
        
        console.log(`[Reminder System] Checking ${tasks.length} tasks at ${now.toLocaleTimeString()}, Current User ID: ${currentUserId}`);
        
        for (const task of tasks) {
            // Only check tasks that are in_progress
            if (task.task_state !== 'in_progress') continue;
            
            // Only show notifications to the ASSIGNEE of the task
            if (task.user_id !== currentUserId) {
                console.log(`[Reminder Check] Skipping task "${task.name}" - not assigned to current user (task.user_id: ${task.user_id}, currentUserId: ${currentUserId})`);
                continue;
            }
            
            console.log(`[Reminder Check] In-progress task found for current user: ${task.name}`);
            
            // Check deadline this._toast(one-time, 'warning') - compare date strings (YYYY-MM-DD)
            // Only show if deadline_alert_shown is false
            if (task.deadline && !task.deadline_alert_shown) {
                // task.deadline is already in YYYY-MM-DD format
                if (today >= task.deadline) {
                    console.log(`[Deadline Alert] Triggering for task: ${task.name}, deadline: ${task.deadline}, deadline_alert_shown: ${task.deadline_alert_shown}`);
                    this.showDeadlineAlert(task);
                }
            }
            
            // Check reminder (repeating based on reminder days/hours/minutes)
            const totalReminderMs = this.getReminderIntervalMs(task);
            console.log(`[Reminder Check] Task: ${task.name}, Reminder Interval: ${totalReminderMs}ms (${Math.round(totalReminderMs/60000)} minutes), Days: ${task.reminder_days}, Hours: ${task.reminder_hours}, Minutes: ${task.reminder_minutes}`);
            
            if (totalReminderMs > 0) {
                let lastReminder = task.last_reminder_shown ? new Date(task.last_reminder_shown) : null;
                let taskStartTime = task.timer_start_datetime ? new Date(task.timer_start_datetime) : null;
                
                // If no last reminder, use task start time as reference
                const referenceTime = lastReminder || taskStartTime;
                
                console.log(`[Reminder Check] Reference Time: ${referenceTime}, Last Reminder: ${lastReminder}, Task Start: ${taskStartTime}, timer_start_datetime raw: ${task.timer_start_datetime}`);
                
                if (referenceTime) {
                    const timeSinceReference = now - referenceTime;
                    console.log(`[Reminder Check] Time Since Reference: ${timeSinceReference}ms (${Math.round(timeSinceReference/1000)} seconds), Need: ${totalReminderMs}ms, Trigger: ${timeSinceReference >= totalReminderMs}`);
                    
                    if (timeSinceReference >= totalReminderMs) {
                        console.log(`[Reminder] ✅ TRIGGERING popup for task: ${task.name}`);
                        this.showReminderPopup(task);
                    }
                } else {
                    console.log(`[Reminder Check] ⚠️ No reference time found for task: ${task.name} - timer_start_datetime is missing`);
                }
            }
        }
    }
    
    // Calculate total reminder interval in milliseconds
    getReminderIntervalMs(task) {
        const days = task.reminder_days || 0;
        const hours = task.reminder_hours || 0;
        const minutes = task.reminder_minutes || 0;
        
        // Convert to milliseconds
        const totalMs = (days * 24 * 60 * 60 * 1000) + (hours * 60 * 60 * 1000) + (minutes * 60 * 1000);
        return totalMs;
    }
    
    // Format reminder interval for display
    formatReminderInterval(task) {
        const parts = [];
        if (task.reminder_days > 0) parts.push(`${task.reminder_days}d`);
        if (task.reminder_hours > 0) parts.push(`${task.reminder_hours}h`);
        if (task.reminder_minutes > 0) parts.push(`${task.reminder_minutes}m`);
        return parts.length > 0 ? parts.join(' ') : '0m';
    }
    
    // Format reminder display for detail view
    formatReminderDisplay(data) {
        if (!data) return 'Not set';
        const days = data.reminder_days || 0;
        const hours = data.reminder_hours || 0;
        const minutes = data.reminder_minutes || 0;
        
        if (days === 0 && hours === 0 && minutes === 0) {
            return 'Not set';
        }
        
        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        return parts.join(' ');
    }
    
    // Show deadline alert popup
    showDeadlineAlert(task) {
        // Don't show if there's already a deadline modal open
        if (document.getElementById('deadlineAlertModal')) {
            console.log('[Deadline Alert] Modal already exists, skipping');
            return;
        }
        
        // Immediately mark as shown in local state to prevent duplicate popups
        task.deadline_alert_shown = true;
        
        console.log('[Deadline Alert] Showing alert for task:', task.name);
        
        const modalHTML = `
            <div class="modal-backdrop fade show" style="z-index: 9998;"></div>
            <div class="modal d-block" tabindex="-1" style="z-index: 9999;">
                <div class="modal-dialog modal-dialog-centered">
                    <div class="modal-content border-danger">
                        <div class="modal-header bg-danger text-white">
                            <h5 class="modal-title">
                                <i class="fa fa-exclamation-triangle me-2"></i>
                                Deadline Alert!
                            </h5>
                        </div>
                        <div class="modal-body text-center py-4">
                            <div class="mb-3">
                                <i class="fa fa-clock-o fa-4x text-danger"></i>
                            </div>
                            <h4 class="text-danger fw-bold">${task.name}</h4>
                            <p class="text-muted mb-3">This task has reached its deadline!</p>
                            <p class="mb-0">
                                <strong>Deadline:</strong> ${this.formatDate(task.deadline)}
                            </p>
                        </div>
                        <div class="modal-footer justify-content-center">
                            <button class="btn btn-danger" id="dismissDeadlineBtn" type="button">
                                <i class="fa fa-check me-1"></i> I Understand
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // Add modal to DOM
        const modalContainer = document.createElement('div');
        modalContainer.id = 'deadlineAlertModal';
        modalContainer.innerHTML = modalHTML;
        document.body.appendChild(modalContainer);
        
        // Store reference to this for use in event handler
        const self = this;
        const taskId = task.id;
        
        // Handle dismiss - use setTimeout to ensure DOM is ready
        setTimeout(() => {
            const dismissBtn = document.getElementById('dismissDeadlineBtn');
            if (dismissBtn) {
                dismissBtn.onclick = async function() {
                    console.log('[Deadline Alert] Dismiss button clicked');
                    
                    // Remove modal first
                    const modal = document.getElementById('deadlineAlertModal');
                    if (modal) {
                        modal.remove();
                    }
                    
                    // Mark deadline alert as shown in backend (persists across refreshes)
                    try {
                        await rpc("/kra_kpi/update_deadline_alert_shown", { kpi_id: taskId });
                        console.log('[Deadline Alert] Backend updated successfully - will not show again');
                    } catch (e) {
                        console.error("Error updating deadline alert status:", e);
                    }
                };
            } else {
                console.error('[Deadline Alert] Dismiss button not found!');
            }
        }, 100);
    }
    
    // Show reminder popup
    showReminderPopup(task) {
        // Don't show if there's already a modal open
        if (document.getElementById('reminderPopupModal')) {
            console.log('[Reminder Popup] Modal already exists, skipping');
            return;
        }
        
        console.log('[Reminder Popup] Showing reminder for task:', task.name);
        
        const reminderText = this.formatReminderInterval(task);
        
        const modalHTML = `
            <div class="modal-backdrop fade show" style="z-index: 9998;"></div>
            <div class="modal d-block" tabindex="-1" style="z-index: 9999;">
                <div class="modal-dialog modal-dialog-centered">
                    <div class="modal-content border-warning">
                        <div class="modal-header bg-warning text-dark">
                            <h5 class="modal-title">
                                <i class="fa fa-bell me-2"></i>
                                Task Reminder
                            </h5>
                        </div>
                        <div class="modal-body text-center py-4">
                            <div class="mb-3">
                                <i class="fa fa-hourglass-half fa-4x text-warning"></i>
                            </div>
                            <h4 class="text-warning fw-bold">${task.name}</h4>
                            <p class="text-muted mb-3">This is your scheduled reminder for this task.</p>
                            <p class="mb-2">
                                <strong>Time Spent:</strong> ${this.getDisplayTime(task)}
                            </p>
                            <p class="text-muted small">
                                <i class="fa fa-repeat me-1"></i>
                                Reminder every ${reminderText}
                            </p>
                        </div>
                        <div class="modal-footer justify-content-center">
                            <button class="btn btn-warning" id="dismissReminderBtn" type="button">
                                <i class="fa fa-check me-1"></i> Continue Working
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // Add modal to DOM
        const modalContainer = document.createElement('div');
        modalContainer.id = 'reminderPopupModal';
        modalContainer.innerHTML = modalHTML;
        document.body.appendChild(modalContainer);
        
        // Store task id for use in event handler
        const taskId = task.id;
        
        // Handle dismiss - use setTimeout to ensure DOM is ready
        setTimeout(() => {
            const dismissBtn = document.getElementById('dismissReminderBtn');
            if (dismissBtn) {
                dismissBtn.onclick = async function() {
                    console.log('[Reminder Popup] Dismiss button clicked');
                    
                    // Remove modal first
                    const modal = document.getElementById('reminderPopupModal');
                    if (modal) {
                        modal.remove();
                    }
                    
                    // Update last reminder shown timestamp
                    try {
                        await rpc("/kra_kpi/update_reminder_shown", { kpi_id: taskId });
                        console.log('[Reminder Popup] Backend updated successfully');
                        // Update local state
                        task.last_reminder_shown = new Date().toISOString();
                    } catch (e) {
                        console.error("Error updating reminder timestamp:", e);
                    }
                };
            } else {
                console.error('[Reminder Popup] Dismiss button not found!');
            }
        }, 100);
    }
    
    // =========================================================
    // END REMINDER AND DEADLINE NOTIFICATION SYSTEM
    // =========================================================
    
    // 🆕 NEW: Get display time for a task (real-time for in_progress tasks)
    getDisplayTime(task) {
        if (!task) return this.formatTime(0);
        // For in_progress tasks with a start time, calculate real-time elapsed
        if (task.task_state === 'in_progress' && task.timer_start_datetime) {
            const startTime = new Date(task.timer_start_datetime).getTime();
            const now = this.state.currentTime;
            const elapsedSinceStart = Math.floor((now - startTime) / 1000);
            const totalSeconds = (task.timer_total_seconds || 0) + elapsedSinceStart;
            return this.formatTime(totalSeconds);
        }
        // For other tasks, just show the stored time
        return this.formatTime(task.timer_total_seconds || 0);
    }

    // 🆕 NEW: Toggle task filter between All Tasks and My Tasks
    async setTaskFilter(showMyTasksOnly) {
        this.state.showMyTasksOnly = showMyTasksOnly;
        await this.refresh();
    }

    _setupTopScrollSync() {
        const topEl = this.kpiScrollTop?.el;
        const innerEl = this.kpiScrollTopInner?.el;
        const rowEl = this.kpiKanbanRow?.el;
        if (!topEl || !innerEl || !rowEl) return;

        const updateWidth = () => {
            // Match the inner div's width to the kanban's total content width
            innerEl.style.width = rowEl.scrollWidth + 'px';
        };
        // Run once now and again shortly after to capture any late layout (icons / fonts / etc.)
        updateWidth();
        setTimeout(updateWidth, 200);

        // Bidirectional scroll sync — flag prevents recursive updates
        let syncing = false;
        topEl.addEventListener('scroll', () => {
            if (syncing) return;
            syncing = true;
            rowEl.scrollLeft = topEl.scrollLeft;
            requestAnimationFrame(() => { syncing = false; });
        });
        rowEl.addEventListener('scroll', () => {
            if (syncing) return;
            syncing = true;
            topEl.scrollLeft = rowEl.scrollLeft;
            requestAnimationFrame(() => { syncing = false; });
        });

        // Re-measure on window resize (column counts or layout changes)
        this._scrollResizeHandler = () => updateWidth();
        window.addEventListener('resize', this._scrollResizeHandler);
        // Also re-measure when tasks load (column heights/cards change scrollWidth)
        this._scrollObserver = new ResizeObserver(() => updateWidth());
        this._scrollObserver.observe(rowEl);
    }

    async refresh() {
        // Re-read the workday flags on every refresh. They used to be fetched
        // once in onMounted, so any handler that failed to update one by hand
        // left the header lying until a full page reload — which is exactly how
        // Start Workday reappeared after End Workday. Fired alongside the task
        // fetch rather than awaited before it: the tasks are what the user is
        // waiting for, and the header correcting itself a beat later is fine.
        this._loadWorkdayStatus();
        // 🆕 UPDATED: Pass filter parameter to backend
        const payload = await rpc("/kra_kpi/tasks/get", {
            my_tasks_only: this.state.showMyTasksOnly
        });
        // Bucket tasks against the full column list, not the role-filtered
        // `this.columns` getter — the template decides which buckets to render.
        const groups = {};
        for (const c of this._allColumns) {
            groups[c.key] = [];
        }
        if (payload?.status && Array.isArray(payload.tasks)) {
            this.state.isAdmin = payload.is_admin || false;
            this.state.currentUserId = payload.current_user_id || null;  // 🆕 NEW: Store current user ID
            this.state.selfPendingCount = payload.self_pending_count || 0;  // 🆕 Pending Review lane count

            // Paid work lives outside the board query — it is archived, so the main
            // fetch cannot see it. Only asked for once we know the viewer is an
            // admin; the route refuses anyone else anyway. Not awaited: the lane
            // filling a beat after the rest of the board is fine.
            if (this.state.isAdmin) {
                this._loadPaidTasks();
            } else {
                this.state.paidTasks = [];
                this.state.paidTruncated = false;
            }
            
            // 🆕 NEW: Store all tasks for filtering
            this.state.allTasks = payload.tasks;
            
            // 🆕 NEW: Extract unique assignees for filter dropdown
            const assigneeMap = {};
            for (const t of payload.tasks) {
                if (t.user_id && t.user_name) {
                    assigneeMap[t.user_id] = { id: t.user_id, name: t.user_name };
                }
            }
            this.state.assignees = Object.values(assigneeMap).sort((a, b) => a.name.localeCompare(b.name));
            
            for (const t of payload.tasks) {
                let key = null;
                if (t.is_self_created && !t.admin_accepted) {
                    // Self-created tasks awaiting admin acceptance live in their
                    // own "Pending Review" lane, regardless of task_state.
                    key = "self_pending";
                } else if (t.task_state === "partially_completed") {
                    key = "partially_completed";
                } else if (t.task_state === "awaiting_client") {
                    key = "awaiting_client";
                } else if (t.task_state === "in_progress") {
                    key = "in_progress";
                } else if (t.task_state === "paused") {
                    key = "paused";
                } else if (t.task_state === "completed") {
                    key = "completed";
                } else {
                    key = t.priority;
                }
                
                if (groups[key]) {
                    groups[key].push(t);
                }

                // Today is an ADDITIONAL membership, not an alternative one — the
                // push above has already happened and is left alone. A task worked
                // today appears here AND in its real column, because this lane is a
                // shortcut for picking work back up, not a new home for it: nothing
                // moves, and the Paused count stays true.
                //
                // Driven by today_seconds from the server, which counts kpi.time.log
                // rows whose work_date is today in the DEVELOPER's timezone. That is
                // also why the lane empties itself at midnight — the date stops
                // matching, so there is no cron and nothing to reset.
                if ((t.today_seconds || 0) > 0) {
                    groups.today.push(t);
                }
            }
            // Most time today first: someone coming back to the board is looking for
            // what they were last deep in, not whatever happens to sort first.
            groups.today.sort((a, b) => (b.today_seconds || 0) - (a.today_seconds || 0));
        }
        this.state.tasksByState = groups;
        // ✅ NEW: Check for rejected tasks after loading
        if (this.state.view === 'list') {
            this.checkForRejectedTasks();
        }
        // 🆕 Part C: keep the live strip (active break, anchors) in sync with actions.
        this.loadLiveStatus();
    }
    _renderModal(html, confirmCallback) {
        const container = document.getElementById("modalContainer");
        container.innerHTML = html;
        
        document.getElementById("closeModalBtn").addEventListener("click", () => this.closeModal());
        document.getElementById("cancelModalBtn").addEventListener("click", () => this.closeModal());
        document.getElementById("confirmModalBtn").addEventListener("click", confirmCallback);
    }

    closeModal() {
        document.getElementById("modalContainer").innerHTML = "";
        this.state.pauseReason = '';
        this.state.reassignReason = '';
        this.state.rejectionReason = '';
    }
    // ✅ NEW: Check for rejected tasks on load
    checkForRejectedTasks() {
        // ✅ Get current user ID from stored state (set by refresh from API)
        const currentUserId = this.state.currentUserId;
        
        console.log(`🔍 Checking for rejected tasks. Current User ID: ${currentUserId}`);
        
        // Safety check: make sure we have paused tasks
        if (!this.state.tasksByState['paused']) {
            console.log(`ℹ️ No paused tasks found`);
            return;
        }
        
        console.log(`📋 Found ${this.state.tasksByState['paused'].length} paused tasks total`);
        
        // Find paused tasks with rejection messages for current user
        const allRejectedTasks = this.state.tasksByState['paused'].filter(task => {
            const isCurrentUser = task.user_id === currentUserId;
            const hasRejection = task.paused_reason && task.paused_reason.includes('🔴 REJECTED');
            
            return isCurrentUser && hasRejection;
        });
        
        console.log(`✅ Found ${allRejectedTasks.length} rejected task(s) for current user`);
        
        // 🆕 NEW: Filter to only show NEW rejections (ones we haven't shown yet)
        const newRejections = allRejectedTasks.filter(task => 
            !this.state.seenRejectionIds.includes(task.id)
        );
        
        console.log(`🔔 New rejections (not seen before): ${newRejections.length}`);
        
        // If there are new rejected tasks, show the modal
        if (newRejections.length > 0) {
            console.log(`🎯 Showing rejection modal for ${newRejections.length} new task(s)`);
            this.state.rejectedTasks = newRejections;
            this.state.showRejectionModal = true;
            
            // 🆕 NEW: Mark these rejections as seen so they won't show again
            const newIds = newRejections.map(t => t.id);
            this.state.seenRejectionIds = [...this.state.seenRejectionIds, ...newIds];
            console.log(`📝 Marked ${newIds.length} rejection(s) as seen. Total seen: ${this.state.seenRejectionIds.length}`);
        } else if (allRejectedTasks.length > 0) {
            console.log(`ℹ️ All rejections already shown. Not showing again.`);
        }
    }

    // ✅ NEW: Close rejection modal
    closeRejectionModal() {
        console.log(`❌ User closed rejection modal`);
        this.state.showRejectionModal = false;
        this.state.rejectedTasks = [];
        // 🆕 NEW: Don't clear seenRejectionIds - we want to remember we showed this
    }

    // ✅ NEW: Extract clean rejection reason from paused_reason
    extractRejectionReason(pausedReason) {
        if (!pausedReason) return '';
        
        // Remove the "🔴 REJECTED - Manager Feedback: " prefix
        return pausedReason
            .replace('🔴 REJECTED - Manager Feedback: ', '')
            .replace('🔴 REJECTED -', '')
            .replace('Manager Feedback:', '')
            .trim();
    }

    // =========================================================
    // 🆕 NEW: FILTER METHODS
    // =========================================================
    
    // Get filtered tasks for a specific column/state
    getFilteredTasksByState(columnKey) {
        let tasks = this.state.tasksByState[columnKey] || [];
        
        // 1. Search Query Filter
        if (this.state.searchQuery && this.state.searchQuery.trim()) {
            const query = this.state.searchQuery.toLowerCase().trim();
            tasks = tasks.filter(task => {
                const nameMatch = (task.name || '').toLowerCase().includes(query);
                const assigneeMatch = (task.user_name || '').toLowerCase().includes(query);
                const priorityMatch = (task.priority || '').toLowerCase().includes(query);
                return nameMatch || assigneeMatch || priorityMatch;
            });
        }
        
        // 2. Assignee Filter
        if (this.state.filters.assignee) {
            const assigneeId = parseInt(this.state.filters.assignee);
            tasks = tasks.filter(task => task.user_id === assigneeId);
        }
        
        // 3. Priority Filter
        if (this.state.filters.priority) {
            tasks = tasks.filter(task => task.priority === this.state.filters.priority);
        }
        
        // 4. Status Filter - only show tasks in the filtered status column
        if (this.state.filters.status) {
            const statusKey = this.state.filters.status;
            // Map status filter value to column key. EVERY lane must appear here:
            // a value offered by the dropdown but missing from this map resolves
            // to undefined, never matches a column, and silently returns an empty
            // board — which is exactly what 'awaiting_client' was doing.
            const statusMapping = {
                'self_pending': 'self_pending',
                'regular': 'regular',
                'important': 'important',
                'urgent': 'urgent',
                'in_progress': 'in_progress',
                'paused': 'paused',
                'partially_completed': 'partially_completed',
                'awaiting_client': 'awaiting_client',
                'completed': 'completed',
            };
            if (statusMapping[statusKey] !== columnKey) {
                return []; // Return empty if this column doesn't match the status filter
            }
        }
        
        return tasks;
    }
    
    // Check if any filters are active
    hasActiveFilters() {
        return (
            (this.state.searchQuery && this.state.searchQuery.trim() !== '') ||
            this.state.filters.assignee !== '' ||
            this.state.filters.priority !== '' ||
            this.state.filters.status !== ''
        );
    }
    
    // Get total count of filtered tasks
    //
    // Skips `today`, because that lane holds the SAME tasks as the status lanes
    // rather than tasks of its own. Counting it would report a board of 40 tasks
    // as 43 the moment somebody had worked on three of them.
    getTotalFilteredCount() {
        let count = 0;
        for (const col of this.columns) {
            if (col.key === 'today') continue;
            count += this.getFilteredTasksByState(col.key).length;
        }
        return count;
    }
    
    // Get total count of all tasks — `today` excluded for the same reason as
    // getTotalFilteredCount above: it is a second view of tasks already counted.
    getTotalTaskCount() {
        let count = 0;
        for (const col of this.columns) {
            if (col.key === 'today') continue;
            count += (this.state.tasksByState[col.key] || []).length;
        }
        return count;
    }
    
    // Event Handlers
    onSearchInput(event) {
        this.state.searchQuery = event.target.value;
    }
    
    onAssigneeChange(event) {
        this.state.filters.assignee = event.target.value;
    }
    
    onPriorityChange(event) {
        this.state.filters.priority = event.target.value;
    }
    
    onStatusChange(event) {
        this.state.filters.status = event.target.value;
    }
    
    // Clear individual filters
    clearSearch() {
        this.state.searchQuery = '';
    }
    
    clearAssigneeFilter() {
        this.state.filters.assignee = '';
    }
    
    clearPriorityFilter() {
        this.state.filters.priority = '';
    }
    
    clearStatusFilter() {
        this.state.filters.status = '';
    }

    /** Human label for the status filter chip.
     *
     * Deliberately its own map rather than reusing the lane/column titles: the
     * Status dropdown offers values the kanban has no lane for (awaiting_client,
     * paused), so borrowing the lane titles would leave those chips blank —
     * a chip that says nothing is worse than no chip. Falls back to the raw
     * value so a status added to the <select> without touching this still
     * renders something readable.
     */
    filterStatusLabel(code) {
        return ({
            self_pending: '🆕 Pending Review',
            regular: '📋 Regular',
            important: '⚠️ Important',
            urgent: '🚨 Urgent',
            in_progress: '🔄 In Progress',
            paused: '⏸️ Paused',
            partially_completed: '⏳ Pending',
            awaiting_client: '📤 Awaiting Client',
            completed: '✅ Completed',
        })[code] || code;
    }
    
    clearAllFilters() {
        this.state.searchQuery = '';
        this.state.filters = {
            assignee: '',
            priority: '',
            status: '',
        };
    }
    
    // Helper methods for filter tags
    getAssigneeName(assigneeId) {
        const assignee = this.state.assignees.find(a => a.id === parseInt(assigneeId));
        return assignee ? assignee.name : 'Unknown';
    }
    
    getPriorityLabel(priority) {
        const labels = {
            'urgent': '🔴 Urgent',
            'important': '🟡 Important',
            'regular': '⚪ Regular',
        };
        return labels[priority] || priority;
    }
    
    getStatusLabel(status) {
        const labels = {
            'regular': 'Regular',
            'important': 'Important',
            'urgent': 'Urgent',
            'in_progress': 'In Progress',
            'paused': 'Paused',
            'partially_completed': 'Pending Approvals',
            'completed': 'Completed',
        };
        return labels[status] || status;
    }
    
    isAssigneeSelected(assigneeId) {
        return this.state.filters.assignee === String(assigneeId);
    }

    // Errors stay until dismissed — an error that vanishes before it is read is the
    // same as no error at all. Anything else clears itself.
    _toast(text, kind = 'warning') {
        this.state.toast = { show: true, text: String(text == null ? '' : text), kind };
        if (kind !== 'danger') {
            setTimeout(() => { this.state.toast.show = false; }, 4500);
        }
    }
    dismissToast() { this.state.toast.show = false; }


    _dialog({ title, message = '', okLabel = 'OK', okClass = 'btn-primary',
              input = false, inputLabel = '', placeholder = '', required = false,
              nums = [], footNote = '', ctx = null }) {
        const numVals = {};
        for (const n of nums) numVals[n.key] = n.value !== undefined ? n.value : 0;
        Object.assign(this.state.dlg, {
            open: true, title, message, okLabel, okClass,
            input, inputLabel, placeholder, required, value: '', error: '',
            nums, numVals, footNote, ctx,
        });
        return new Promise((resolve) => { this.state.dlg.resolve = resolve; });
    }
    _confirm(title, message, okLabel = 'OK', okClass = 'btn-primary') {
        return this._dialog({ title, message, okLabel, okClass });
    }
    dlgSet(v) { this.state.dlg.value = v; this.state.dlg.error = ''; }
    dlgNum(key, v) {
        this.state.dlg.numVals[key] = Math.max(0, parseInt(v, 10) || 0);
        this.state.dlg.error = '';
    }
    dlgCancel() {
        const r = this.state.dlg.resolve;
        this.state.dlg.open = false; this.state.dlg.resolve = null;
        if (r) r(null);
    }
    dlgOk() {
        const d = this.state.dlg;
        // Stated rather than enforced by disabling OK, so a click that does nothing
        // always says why.
        if (d.input && d.required && !String(d.value || '').trim()) {
            d.error = (d.inputLabel || 'This') + ' is required.';
            return;
        }
        // With numbers present the caller wants the whole set, not just the text.
        const val = d.nums.length ? { ...d.numVals, text: d.value }
                                  : (d.input ? d.value : true);
        const r = d.resolve;
        d.open = false; d.resolve = null;
        if (r) r(val);
    }

}
 
registry.category("actions").add("kra_kpi_actions", KpiAction);