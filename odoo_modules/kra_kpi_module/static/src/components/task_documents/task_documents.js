/** @odoo-module **/

import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

export class TaskDocuments extends Component {
    static template = xml/* xml */`
        <div class="o_task_documents_wrapper p-4" style="max-height: 90vh; overflow-y: auto;">

            
            <!-- LIST VIEW: Show all tasks -->
            <t t-if="state.view === 'list'">
                <!-- Header Section -->
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <h2 class="fw-bold mb-0" style="color: #1f2937;">📂 Task Related Documents</h2>
                    
                    <!-- Results Count Badge -->
                    <div class="d-flex align-items-center gap-3">
                        <span class="badge task-count-badge" style="background-color: #e5e7eb; color: #374151; font-size: 0.85rem; padding: 0.5rem 1rem; font-weight: 500;">
                            Showing <strong t-esc="getFilteredTasks().length"/> of <strong t-esc="state.allTasks.length"/> tasks
                        </span>
                    </div>
                </div>
                
                <!-- ============================================ -->
                <!-- ADVANCED SEARCH & FILTER BAR -->
                <!-- ============================================ -->
                <div class="task-filter-bar card mb-4" style="border: 1px solid #e5e7eb; background: linear-gradient(135deg, #f9fafb 0%, #ffffff 100%); box-shadow: 0 2px 4px rgba(0,0,0,0.04);">
                    <div class="card-body p-3">
                        
                        <!-- Row 1: Search Bar -->
                        <div class="row mb-3">
                            <div class="col-12">
                                <div class="search-input-wrapper position-relative">
                                    <i class="fa fa-search search-icon" style="position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: #9ca3af; z-index: 2;"></i>
                                    <input type="text" 
                                           class="form-control search-input" 
                                           placeholder="Search by task name, assignee, or priority..."
                                           style="padding-left: 38px; border: 1px solid #d1d5db; border-radius: 0.5rem; height: 42px; font-size: 0.95rem;"
                                           t-att-value="state.searchQuery"
                                           t-on-input="onSearchInput"/>
                                    <t t-if="state.searchQuery">
                                        <button class="btn btn-link clear-search-btn" 
                                                style="position: absolute; right: 8px; top: 50%; transform: translateY(-50%); color: #9ca3af; padding: 0; border: none;"
                                                t-on-click="clearSearch">
                                            <i class="fa fa-times-circle"></i>
                                        </button>
                                    </t>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Row 2: Filter Dropdowns -->
                        <div class="row g-2 mb-3">
                            <!-- Assignee Filter -->
                            <div class="col-md-3 col-sm-6">
                                <label class="filter-label mb-1" style="font-size: 0.75rem; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">Assignee</label>
                                <select class="form-select filter-select" 
                                        style="border: 1px solid #d1d5db; border-radius: 0.375rem; font-size: 0.9rem; height: 38px;"
                                        t-on-change="onAssigneeChange">
                                    <option value="">All Assignees</option>
                                    <t t-foreach="state.assignees" t-as="assignee" t-key="assignee.id">
                                        <option t-att-value="assignee.id" 
                                                t-att-selected="isAssigneeSelected(assignee.id)"
                                                t-esc="assignee.name"/>
                                    </t>
                                </select>
                            </div>
                            
                            <!-- Priority Filter -->
                            <div class="col-md-3 col-sm-6">
                                <label class="filter-label mb-1" style="font-size: 0.75rem; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">Priority</label>
                                <select class="form-select filter-select" 
                                        style="border: 1px solid #d1d5db; border-radius: 0.375rem; font-size: 0.9rem; height: 38px;"
                                        t-on-change="onPriorityChange">
                                    <option value="">All Priorities</option>
                                    <option value="urgent" t-att-selected="state.filters.priority === 'urgent'">🔴 Urgent</option>
                                    <option value="important" t-att-selected="state.filters.priority === 'important'">🟡 Important</option>
                                    <option value="regular" t-att-selected="state.filters.priority === 'regular'">⚪ Regular</option>
                                </select>
                            </div>
                            
                            <!-- Attachments Filter -->
                            <div class="col-md-3 col-sm-6">
                                <label class="filter-label mb-1" style="font-size: 0.75rem; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">Attachments</label>
                                <select class="form-select filter-select" 
                                        style="border: 1px solid #d1d5db; border-radius: 0.375rem; font-size: 0.9rem; height: 38px;"
                                        t-on-change="onAttachmentsChange">
                                    <option value="">All Tasks</option>
                                    <option value="yes" t-att-selected="state.filters.hasAttachments === 'yes'">📎 With Attachments</option>
                                    <option value="no" t-att-selected="state.filters.hasAttachments === 'no'">❌ No Attachments</option>
                                </select>
                            </div>
                            
                            <!-- Document Type Filter -->
                            <div class="col-md-3 col-sm-6">
                                <label class="filter-label mb-1" style="font-size: 0.75rem; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">Document Type</label>
                                <select class="form-select filter-select" 
                                        style="border: 1px solid #d1d5db; border-radius: 0.375rem; font-size: 0.9rem; height: 38px;"
                                        t-on-change="onDocTypeChange">
                                    <option value="">All Types</option>
                                    <option value="task_docs" t-att-selected="state.filters.documentType === 'task_docs'">📁 Has Task Documents</option>
                                    <option value="files" t-att-selected="state.filters.documentType === 'files'">📄 Has Files</option>
                                    <option value="drive" t-att-selected="state.filters.documentType === 'drive'">☁️ Has Drive / Cloud</option>
                                    <option value="links" t-att-selected="state.filters.documentType === 'links'">🔗 Has Links</option>
                                    <option value="github" t-att-selected="state.filters.documentType === 'github'">🐙 Has GitHub Repos</option>
                                    <option value="manuals" t-att-selected="state.filters.documentType === 'manuals'">📚 Has Manuals</option>
                                </select>
                            </div>
                        </div>
                        
                        <!-- Row 3: Active Filters Tags & Clear All -->
                        <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
                            <!-- Active Filter Tags -->
                            <div class="active-filters d-flex flex-wrap gap-2 align-items-center">
                                <t t-if="hasActiveFilters()">
                                    <span class="text-muted me-2" style="font-size: 0.85rem; font-weight: 500;">Active Filters:</span>
                                    
                                    <!-- Search Query Tag -->
                                    <t t-if="state.searchQuery">
                                        <span class="filter-tag badge d-flex align-items-center gap-1" 
                                              style="background-color: #dbeafe; color: #1e40af; padding: 0.35rem 0.65rem; font-size: 0.8rem; font-weight: 500; border-radius: 9999px;">
                                            <i class="fa fa-search" style="font-size: 0.7rem;"></i>
                                            "<t t-esc="state.searchQuery"/>"
                                            <button class="btn btn-link p-0 ms-1" style="color: #1e40af; font-size: 0.75rem; text-decoration: none;" t-on-click="clearSearch">
                                                <i class="fa fa-times"></i>
                                            </button>
                                        </span>
                                    </t>
                                    
                                    <!-- Assignee Tag -->
                                    <t t-if="state.filters.assignee">
                                        <span class="filter-tag badge d-flex align-items-center gap-1" 
                                              style="background-color: #dcfce7; color: #166534; padding: 0.35rem 0.65rem; font-size: 0.8rem; font-weight: 500; border-radius: 9999px;">
                                            <i class="fa fa-user" style="font-size: 0.7rem;"></i>
                                            <t t-esc="getAssigneeName(state.filters.assignee)"/>
                                            <button class="btn btn-link p-0 ms-1" style="color: #166534; font-size: 0.75rem; text-decoration: none;" t-on-click="clearAssigneeFilter">
                                                <i class="fa fa-times"></i>
                                            </button>
                                        </span>
                                    </t>
                                    
                                    <!-- Priority Tag -->
                                    <t t-if="state.filters.priority">
                                        <span class="filter-tag badge d-flex align-items-center gap-1" 
                                              t-att-style="getPriorityTagStyle(state.filters.priority)">
                                            <t t-esc="getPriorityLabel(state.filters.priority)"/>
                                            <button class="btn btn-link p-0 ms-1" style="font-size: 0.75rem; text-decoration: none;" t-att-style="getPriorityButtonStyle(state.filters.priority)" t-on-click="clearPriorityFilter">
                                                <i class="fa fa-times"></i>
                                            </button>
                                        </span>
                                    </t>
                                    
                                    <!-- Attachments Tag -->
                                    <t t-if="state.filters.hasAttachments">
                                        <span class="filter-tag badge d-flex align-items-center gap-1" 
                                              style="background-color: #fef3c7; color: #92400e; padding: 0.35rem 0.65rem; font-size: 0.8rem; font-weight: 500; border-radius: 9999px;">
                                            <i class="fa fa-paperclip" style="font-size: 0.7rem;"></i>
                                            <t t-esc="getAttachmentsLabel(state.filters.hasAttachments)"/>
                                            <button class="btn btn-link p-0 ms-1" style="color: #92400e; font-size: 0.75rem; text-decoration: none;" t-on-click="clearAttachmentsFilter">
                                                <i class="fa fa-times"></i>
                                            </button>
                                        </span>
                                    </t>
                                    
                                    <!-- Document Type Tag -->
                                    <t t-if="state.filters.documentType">
                                        <span class="filter-tag badge d-flex align-items-center gap-1" 
                                              style="background-color: #e0e7ff; color: #3730a3; padding: 0.35rem 0.65rem; font-size: 0.8rem; font-weight: 500; border-radius: 9999px;">
                                            <i t-att-class="getDocTypeIcon(state.filters.documentType)" style="font-size: 0.7rem;"></i>
                                            <t t-esc="getDocTypeLabel(state.filters.documentType)"/>
                                            <button class="btn btn-link p-0 ms-1" style="color: #3730a3; font-size: 0.75rem; text-decoration: none;" t-on-click="clearDocTypeFilter">
                                                <i class="fa fa-times"></i>
                                            </button>
                                        </span>
                                    </t>
                                </t>
                                
                                <t t-else="">
                                    <span class="text-muted" style="font-size: 0.85rem; font-style: italic;">No filters applied</span>
                                </t>
                            </div>
                            
                            <!-- Clear All Button -->
                            <t t-if="hasActiveFilters()">
                                <button class="btn btn-outline-secondary btn-sm clear-all-btn" 
                                        style="border-color: #d1d5db; color: #6b7280; font-size: 0.85rem; padding: 0.35rem 0.75rem; border-radius: 0.375rem;"
                                        t-on-click="clearAllFilters">
                                    <i class="fa fa-times-circle"></i> Clear All Filters
                                </button>
                            </t>
                        </div>
                    </div>
                </div>
                
                <!-- ============================================ -->
                <!-- TASKS TABLE -->
                <!-- ============================================ -->
                <t t-if="state.loading">
                    <div class="text-center py-5">
                        <span class="spinner-border" style="color: #6b7280;"></span>
                        <p class="mt-2 text-muted">Loading tasks...</p>
                    </div>
                </t>
                
                <t t-elif="getFilteredTasks().length === 0">
                    <div class="alert d-flex flex-column align-items-center py-5" style="background-color: #f9fafb; border: 1px dashed #d1d5db; border-radius: 0.5rem;">
                        <i class="fa fa-search fa-3x mb-3" style="color: #9ca3af;"></i>
                        <h5 class="mb-2" style="color: #4b5563;">No tasks match your filters</h5>
                        <p class="text-muted mb-3">Try adjusting your search or filter criteria</p>
                        <button class="btn btn-primary btn-sm" t-on-click="clearAllFilters" style="background-color: #374151; border: none;">
                            <i class="fa fa-refresh"></i> Reset Filters
                        </button>
                    </div>
                </t>
                
                <t t-else="">
                    <div class="card task-table-card" style="border: 1px solid #e5e7eb; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);">
                        <div class="table-responsive">
                            <table class="table table-hover mb-0 align-middle">
                                <thead style="background-color: #f9fafb; border-bottom: 2px solid #e5e7eb;">
                                    <tr>
                                        <th style="width: 5%; color: #6b7280; font-weight: 600;">#</th>
                                        <th style="width: 40%; color: #6b7280; font-weight: 600;">Task Name</th>
                                        <th style="width: 20%; color: #6b7280; font-weight: 600;">Assignee</th>
                                        <th style="width: 25%; color: #6b7280; font-weight: 600;">Documents</th>
                                        <th style="width: 10%; color: #6b7280; font-weight: 600;">Action</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <t t-foreach="getFilteredTasks()" t-as="task" t-key="task.id">
                                        <tr class="task-row" style="border-bottom: 1px solid #f3f4f6; transition: background-color 0.15s ease;">
                                            <td class="text-muted" style="color: #9ca3af;" t-esc="task_index + 1"/>
                                            <td>
                                                <div class="d-flex flex-column">
                                                    <strong style="color: #111827; font-weight: 500;" t-esc="task.name"/>
                                                    <small class="mt-1">
                                                        <span t-if="task.priority === 'urgent'" 
                                                              class="badge priority-badge-urgent"
                                                              style="background-color: #fef2f2; color: #991b1b; border: 1px solid #fee2e2; font-size: 0.7rem; font-weight: 500; padding: 0.25rem 0.5rem;">
                                                            Urgent
                                                        </span>
                                                        <span t-elif="task.priority === 'important'" 
                                                              class="badge priority-badge-important"
                                                              style="background-color: #fffbeb; color: #92400e; border: 1px solid #fef3c7; font-size: 0.7rem; font-weight: 500; padding: 0.25rem 0.5rem;">
                                                            Important
                                                        </span>
                                                        <span t-else="" 
                                                              class="badge priority-badge-regular"
                                                              style="background-color: #f9fafb; color: #6b7280; border: 1px solid #e5e7eb; font-size: 0.7rem; font-weight: 500; padding: 0.25rem 0.5rem;">
                                                            Regular
                                                        </span>
                                                    </small>
                                                </div>
                                            </td>
                                            <td>
                                                <div class="d-flex align-items-center gap-2">
                                                    <i class="fa fa-user" style="color: #9ca3af;"></i>
                                                    <span style="color: #374151;" t-esc="task.assignee"/>
                                                </div>
                                            </td>
                                            <td>
                                                <!-- Show "No Attachments" if no documents -->
                                                <t t-if="!task.has_attachments">
                                                    <span class="badge" 
                                                          style="background-color: #fef2f2; color: #991b1b; border: 1px solid #fee2e2; padding: 0.35rem 0.65rem; font-size: 0.75rem; font-weight: 500;">
                                                        <i class="fa fa-ban"></i> No Attachments
                                                    </span>
                                                </t>
                                                <t t-else="">
                                                    <div class="d-flex flex-wrap gap-1">
                                                        <span t-if="task.doc_count > 0" 
                                                              class="badge doc-badge"
                                                              style="background-color: #f9fafb; color: #374151; border: 1px solid #e5e7eb; padding: 0.3rem 0.6rem; font-size: 0.75rem; font-weight: 500;">
                                                            <i class="fa fa-file-text-o"></i> <t t-esc="task.doc_count"/> Files
                                                        </span>
                                                        <span t-if="task.link_count > 0" 
                                                              class="badge doc-badge"
                                                              style="background-color: #f9fafb; color: #374151; border: 1px solid #e5e7eb; padding: 0.3rem 0.6rem; font-size: 0.75rem; font-weight: 500;">
                                                            <i class="fa fa-link"></i> <t t-esc="task.link_count"/> Links
                                                        </span>
                                                        <span t-if="task.github_count > 0" 
                                                              class="badge doc-badge"
                                                              style="background-color: #f9fafb; color: #374151; border: 1px solid #e5e7eb; padding: 0.3rem 0.6rem; font-size: 0.75rem; font-weight: 500;">
                                                            <i class="fa fa-github"></i> <t t-esc="task.github_count"/> Repos
                                                        </span>
                                                        <span t-if="task.manual_count > 0" 
                                                              class="badge doc-badge"
                                                              style="background-color: #f9fafb; color: #374151; border: 1px solid #e5e7eb; padding: 0.3rem 0.6rem; font-size: 0.75rem; font-weight: 500;">
                                                            <i class="fa fa-book"></i> <t t-esc="task.manual_count"/> Manuals
                                                        </span>
                                                    </div>
                                                </t>
                                            </td>
                                            <td>
                                                <button class="btn btn-sm view-btn" 
                                                        style="background-color: #374151; color: white; border: none; padding: 0.4rem 1rem; font-weight: 500; border-radius: 0.375rem; transition: all 0.2s;"
                                                        t-on-click="() => this.viewTaskDocuments(task.id)">
                                                    <i class="fa fa-eye"></i> View
                                                </button>
                                            </td>
                                        </tr>
                                    </t>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </t>
            </t>
            
            <!-- DETAIL VIEW: Show documents for selected task -->
            <t t-if="state.view === 'detail'">
                <button class="btn mb-3" 
                        style="background-color: #f3f4f6; color: #374151; border: 1px solid #d1d5db; padding: 0.5rem 1.25rem; font-weight: 500; border-radius: 0.375rem;"
                        t-on-click="backToList">
                    <i class="fa fa-arrow-left"></i> Back to Tasks
                </button>
                
                <t t-if="state.selectedTask">
                    <div class="card p-4 mb-3" style="background-color: #f9fafb; border: 1px solid #e5e7eb;">
                        <h3 class="fw-bold mb-2" style="color: #111827;">
                            <i class="fa fa-tasks"></i> <t t-esc="state.selectedTask.name"/>
                        </h3>
                        <!-- Ref / linked-req / version: without these you can't tell
                             WHICH task this is, only its name. -->
                        <div class="d-flex gap-2 flex-wrap mb-3">
                            <span t-if="state.task.external_ref" class="badge bg-primary">
                                <t t-esc="state.task.external_ref"/>
                            </span>
                            <span t-if="state.task.related_req_ref" class="badge bg-light text-dark border">
                                <i class="fa fa-link"></i> Linked to <t t-esc="state.task.related_req_ref"/>
                            </span>
                            <span t-if="state.task.delivery_version" class="badge bg-info text-dark">
                                <i class="fa fa-tag"></i> <t t-esc="state.task.delivery_version"/>
                            </span>
                        </div>
                        <div class="d-flex gap-4 flex-wrap" style="color: #4b5563;">
                            <div>
                                <strong>Assignee:</strong>
                                <span class="ms-2" t-esc="state.selectedTask.assignee"/>
                            </div>
                            <div>
                                <strong>Priority:</strong>
                                <span class="ms-2" t-esc="state.selectedTask.priority"/>
                            </div>
                        </div>
                        <p t-if="state.task.description" class="mb-0 mt-3 text-muted small"
                           style="white-space: pre-wrap;" t-esc="state.task.description"/>
                    </div>
                </t>
                
                <t t-if="state.detailLoading">
                    <div class="text-center py-5">
                        <span class="spinner-border" style="color: #6b7280;"></span>
                        <p class="mt-2 text-muted">Loading documents...</p>
                    </div>
                </t>
                
                <t t-else="">
                    <!-- The task's OWN documents (requirement / updates / signed
                         certificate). These live on the task record itself and were
                         never shown here before, so a task holding only a requirement
                         doc looked like it had no attachments at all. -->
                    <t t-if="state.documents.task_docs.length > 0">
                        <div class="card p-4 mb-3" style="border: 1px solid #e5e7eb; border-left: 3px solid #2563eb;">
                            <h4 class="fw-bold mb-3" style="color: #374151;">
                                <i class="fa fa-folder-open"></i> Task Documents (<t t-esc="state.documents.task_docs.length"/>)
                            </h4>
                            <div class="list-group">
                                <t t-foreach="state.documents.task_docs" t-as="td" t-key="td.kind">
                                    <div class="list-group-item border-0 mb-2" style="background-color: #f9fafb; border-radius: 0.5rem; border: 1px solid #e5e7eb;">
                                        <div class="d-flex justify-content-between align-items-start">
                                            <div class="flex-grow-1">
                                                <h6 class="mb-2 fw-bold" style="color: #111827;">
                                                    <span class="badge bg-primary me-2" t-esc="td.kind"/>
                                                    <t t-esc="td.file_name"/>
                                                </h6>
                                                <p t-if="td.note" class="mb-0 text-muted small" t-esc="td.note"/>
                                            </div>
                                            <a class="btn btn-sm btn-primary" t-att-href="td.download_url" target="_blank">
                                                <i class="fa fa-download"></i> Download
                                            </a>
                                        </div>
                                    </div>
                                </t>
                            </div>
                        </div>
                    </t>

                    <!-- Attached Files -->
                    <t t-if="state.documents.files.length > 0">
                        <div class="card p-4 mb-3" style="border: 1px solid #e5e7eb; border-left: 3px solid #6b7280;">
                            <h4 class="fw-bold mb-3" style="color: #374151;">
                                <i class="fa fa-file-text"></i> Attached Files (<t t-esc="state.documents.files.length"/>)
                            </h4>
                            <div class="list-group">
                                <t t-foreach="state.documents.files" t-as="file" t-key="file.id">
                                    <div class="list-group-item border-0 mb-2" style="background-color: #f9fafb; border-radius: 0.5rem; border: 1px solid #e5e7eb;">
                                        <div class="d-flex justify-content-between align-items-start">
                                            <div class="flex-grow-1">
                                                <h6 class="mb-2 fw-bold" style="color: #111827;">
                                                    <i class="fa fa-file-o" style="color: #6b7280;"></i> <t t-esc="file.file_name"/>
                                                </h6>
                                                <p class="mb-1 text-muted small">
                                                    <i class="fa fa-user"></i> <t t-esc="file.uploaded_by"/> • 
                                                    <i class="fa fa-calendar"></i> <t t-esc="formatDate(file.upload_date)"/>
                                                </p>
                                            </div>
                                            <div class="d-flex gap-2">
                                                <a class="btn btn-sm" 
                                                   style="background-color: #f3f4f6; color: #374151; border: 1px solid #d1d5db; font-weight: 500;"
                                                   t-att-href="file.view_url"
                                                   target="_blank">
                                                    <i class="fa fa-eye"></i> View
                                                </a>
                                                <a class="btn btn-sm" 
                                                   style="background-color: #374151; color: white; border: none; font-weight: 500;"
                                                   t-att-href="file.download_url">
                                                    <i class="fa fa-download"></i> Download
                                                </a>
                                            </div>
                                        </div>
                                    </div>
                                </t>
                            </div>
                        </div>
                    </t>
                    
                    <!-- Drive &amp; Cloud. Links carry no type in storage (a bare JSON
                         array of URLs), so the "kind" is worked out from the URL by
                         the server — see /task_documents/details.
                         NOTE: never use backticks in here — this whole template is a
                         backtick literal, so one would end it and break the bundle. -->
                    <t t-if="driveLinks.length > 0">
                        <div class="card p-4 mb-3" style="border: 1px solid #e5e7eb; border-left: 3px solid #16a34a;">
                            <h4 class="fw-bold mb-3" style="color: #374151;">
                                <i class="fa fa-cloud"></i> Drive &amp; Cloud (<t t-esc="driveLinks.length"/>)
                            </h4>
                            <div class="list-group">
                                <t t-foreach="driveLinks" t-as="link" t-key="link_index">
                                    <a t-att-href="link.url"
                                       target="_blank"
                                       class="list-group-item list-group-item-action border-0 mb-2"
                                       style="background-color: #f9fafb; border-radius: 0.5rem; border: 1px solid #e5e7eb; transition: all 0.2s;">
                                        <div class="d-flex justify-content-between align-items-center">
                                            <div class="flex-grow-1">
                                                <h6 class="mb-2 fw-bold" style="color: #111827;">
                                                    <span class="badge bg-success me-2" t-esc="link.kind"/>
                                                    <t t-esc="link.url"/>
                                                </h6>
                                                <p class="mb-0 text-muted small">
                                                    <i class="fa fa-user"></i> <t t-esc="link.added_by"/> •
                                                    <i class="fa fa-calendar"></i> <t t-esc="formatDate(link.added_date)"/>
                                                </p>
                                            </div>
                                            <i class="fa fa-arrow-right" style="color: #9ca3af;"></i>
                                        </div>
                                    </a>
                                </t>
                            </div>
                        </div>
                    </t>

                    <!-- Everything else -->
                    <t t-if="otherLinks.length > 0">
                        <div class="card p-4 mb-3" style="border: 1px solid #e5e7eb; border-left: 3px solid #6b7280;">
                            <h4 class="fw-bold mb-3" style="color: #374151;">
                                <i class="fa fa-link"></i> Other Links (<t t-esc="otherLinks.length"/>)
                            </h4>
                            <div class="list-group">
                                <t t-foreach="otherLinks" t-as="link" t-key="link_index">
                                    <a t-att-href="link.url"
                                       target="_blank"
                                       class="list-group-item list-group-item-action border-0 mb-2"
                                       style="background-color: #f9fafb; border-radius: 0.5rem; border: 1px solid #e5e7eb; transition: all 0.2s;">
                                        <div class="d-flex justify-content-between align-items-center">
                                            <div class="flex-grow-1">
                                                <h6 class="mb-2 fw-bold" style="color: #111827;">
                                                    <i class="fa fa-external-link" style="color: #6b7280;"></i> <t t-esc="link.url"/>
                                                </h6>
                                                <p class="mb-0 text-muted small">
                                                    <span t-if="link.kind and link.kind !== 'Other'"
                                                          class="badge bg-light text-dark border me-2" t-esc="link.kind"/>
                                                    <i class="fa fa-user"></i> <t t-esc="link.added_by"/> •
                                                    <i class="fa fa-calendar"></i> <t t-esc="formatDate(link.added_date)"/>
                                                </p>
                                            </div>
                                            <i class="fa fa-arrow-right" style="color: #9ca3af;"></i>
                                        </div>
                                    </a>
                                </t>
                            </div>
                        </div>
                    </t>
                    
                    <!-- GitHub Repositories -->
                    <t t-if="state.documents.github.length > 0">
                        <div class="card p-4 mb-3" style="border: 1px solid #e5e7eb; border-left: 3px solid #6b7280;">
                            <h4 class="fw-bold mb-3" style="color: #374151;">
                                <i class="fa fa-github"></i> GitHub Repositories (<t t-esc="state.documents.github.length"/>)
                            </h4>
                            <div class="list-group">
                                <t t-foreach="state.documents.github" t-as="git" t-key="git.id">
                                    <div class="list-group-item border-0 mb-2" style="background-color: #f9fafb; border-radius: 0.5rem; border: 1px solid #e5e7eb;">
                                        <div class="d-flex justify-content-between align-items-start">
                                            <div class="flex-grow-1">
                                                <h6 class="mb-2 fw-bold">
                                                    <i class="fa fa-github" style="color: #6b7280;"></i> 
                                                    <a t-att-href="git.github_url" target="_blank" class="text-decoration-none" style="color: #111827;">
                                                        <t t-esc="git.github_url"/>
                                                    </a>
                                                </h6>
                                                <p class="mb-2">
                                                    <span class="badge" style="background-color: #f3f4f6; color: #374151; border: 1px solid #d1d5db; font-weight: 500; padding: 0.35rem 0.75rem;">
                                                        🌿 Branch: <code style="background: transparent; color: #111827; font-weight: 600;" t-esc="git.branch_name"/>
                                                    </span>
                                                </p>
                                                <p class="mb-0 text-muted small">
                                                    <i class="fa fa-user"></i> <t t-esc="git.uploaded_by"/> • 
                                                    <i class="fa fa-calendar"></i> <t t-esc="formatDate(git.upload_date)"/>
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                </t>
                            </div>
                        </div>
                    </t>
                    
                    <!-- User Manuals -->
                    <t t-if="state.documents.manuals.length > 0">
                        <div class="card p-4 mb-3" style="border: 1px solid #e5e7eb; border-left: 3px solid #6b7280;">
                            <h4 class="fw-bold mb-3" style="color: #374151;">
                                <i class="fa fa-book"></i> User Manuals (<t t-esc="state.documents.manuals.length"/>)
                            </h4>
                            <div class="list-group">
                                <t t-foreach="state.documents.manuals" t-as="manual" t-key="manual.id">
                                    <div class="list-group-item border-0 mb-2" style="background-color: #f9fafb; border-radius: 0.5rem; border: 1px solid #e5e7eb;">
                                        <div class="d-flex justify-content-between align-items-start">
                                            <div class="flex-grow-1">
                                                <h6 class="mb-2 fw-bold" style="color: #111827;">
                                                    <i class="fa fa-file-pdf-o" style="color: #6b7280;"></i> <t t-esc="manual.file_name"/>
                                                </h6>
                                                <p class="mb-2 text-muted" t-if="manual.description">
                                                    <t t-esc="manual.description"/>
                                                </p>
                                                <p class="mb-0 text-muted small">
                                                    <i class="fa fa-user"></i> <t t-esc="manual.uploaded_by"/> • 
                                                    <i class="fa fa-calendar"></i> <t t-esc="formatDate(manual.upload_date)"/>
                                                </p>
                                            </div>
                                            <div class="d-flex gap-2">
                                                <a class="btn btn-sm" 
                                                   style="background-color: #f3f4f6; color: #374151; border: 1px solid #d1d5db; font-weight: 500;"
                                                   t-att-href="manual.view_url"
                                                   target="_blank">
                                                    <i class="fa fa-eye"></i> View
                                                </a>
                                                <a class="btn btn-sm" 
                                                   style="background-color: #374151; color: white; border: none; font-weight: 500;"
                                                   t-att-href="manual.download_url">
                                                    <i class="fa fa-download"></i> Download
                                                </a>
                                            </div>
                                        </div>
                                    </div>
                                </t>
                            </div>
                        </div>
                    </t>
                    
                    <!-- No Documents Message -->
                    <t t-if="state.documents.files.length === 0 and state.documents.links.length === 0 and state.documents.github.length === 0 and state.documents.manuals.length === 0">
                        <div class="alert" style="background-color: #f9fafb; border: 1px solid #e5e7eb; color: #4b5563; border-radius: 0.5rem;">
                            <i class="fa fa-info-circle"></i> No documents found for this task yet.
                        </div>
                    </t>
                </t>
            </t>
        </div>
    `;

    setup() {
        this.state = useState({
            view: 'list',
            loading: true,
            detailLoading: false,
            allTasks: [],
            tasks: [],
            selectedTask: null,
            // Header context for the detail view (ref / linked req / version /
            // description) — served by /task_documents/details.
            task: {},
            documents: {
                files: [],
                links: [],
                github: [],
                manuals: [],
                task_docs: [],
            },
            assignees: [],
            selectedAssignee: '',
            
            // Filter State
            searchQuery: '',
            filters: {
                assignee: '',
                priority: '',
                hasAttachments: '',
                documentType: '',
            },
        });

        // Bind all methods
        this.formatDate = this.formatDate.bind(this);
        this.viewTaskDocuments = this.viewTaskDocuments.bind(this);
        this.backToList = this.backToList.bind(this);
        this.filterByAssignee = this.filterByAssignee.bind(this);
        this.onSearchInput = this.onSearchInput.bind(this);
        this.clearSearch = this.clearSearch.bind(this);
        this.clearAllFilters = this.clearAllFilters.bind(this);
        this.getAssigneeName = this.getAssigneeName.bind(this);
        this.getPriorityLabel = this.getPriorityLabel.bind(this);
        this.getPriorityTagStyle = this.getPriorityTagStyle.bind(this);
        this.getPriorityButtonStyle = this.getPriorityButtonStyle.bind(this);
        this.getDocTypeIcon = this.getDocTypeIcon.bind(this);
        this.getDocTypeLabel = this.getDocTypeLabel.bind(this);
        this.getAttachmentsLabel = this.getAttachmentsLabel.bind(this);
        this.getFilteredTasks = this.getFilteredTasks.bind(this);
        this.hasActiveFilters = this.hasActiveFilters.bind(this);
        this.isAssigneeSelected = this.isAssigneeSelected.bind(this);
        this.onAssigneeChange = this.onAssigneeChange.bind(this);
        this.onPriorityChange = this.onPriorityChange.bind(this);
        this.onAttachmentsChange = this.onAttachmentsChange.bind(this);
        this.onDocTypeChange = this.onDocTypeChange.bind(this);
        this.clearAssigneeFilter = this.clearAssigneeFilter.bind(this);
        this.clearPriorityFilter = this.clearPriorityFilter.bind(this);
        this.clearAttachmentsFilter = this.clearAttachmentsFilter.bind(this);
        this.clearDocTypeFilter = this.clearDocTypeFilter.bind(this);
         
        onWillStart(async () => {
            await this.loadTasks();
        });
    }

    // =========================================================
    // LINK GROUPING
    // =========================================================
    // Links have no type in storage — the server works `kind` out from the URL
    // (see /task_documents/details). These two getters just split that one list
    // so Drive/cloud links get their own card instead of being buried among
    // every other URL.

    get driveLinks() {
        const links = (this.state.documents && this.state.documents.links) || [];
        return links.filter(l => l.kind === 'Google Drive' || l.kind === 'Cloud Storage');
    }

    get otherLinks() {
        const links = (this.state.documents && this.state.documents.links) || [];
        return links.filter(l => l.kind !== 'Google Drive' && l.kind !== 'Cloud Storage');
    }

    // =========================================================
    // FILTER LOGIC
    // =========================================================

    getFilteredTasks() {
        let tasks = [...this.state.allTasks];
        
        // 1. Search Query Filter
        if (this.state.searchQuery && this.state.searchQuery.trim()) {
            const query = this.state.searchQuery.toLowerCase().trim();
            tasks = tasks.filter(task => {
                const nameMatch = (task.name || '').toLowerCase().includes(query);
                const assigneeMatch = (task.assignee || '').toLowerCase().includes(query);
                const priorityMatch = (task.priority || '').toLowerCase().includes(query);
                return nameMatch || assigneeMatch || priorityMatch;
            });
        }
        
        // 2. Assignee Filter
        if (this.state.filters.assignee) {
            const assigneeId = parseInt(this.state.filters.assignee);
            tasks = tasks.filter(task => task.assignee_id === assigneeId);
        }
        
        // 3. Priority Filter
        if (this.state.filters.priority) {
            tasks = tasks.filter(task => task.priority === this.state.filters.priority);
        }
        
        // 4. Has Attachments Filter
        if (this.state.filters.hasAttachments === 'yes') {
            tasks = tasks.filter(task => task.has_attachments === true);
        } else if (this.state.filters.hasAttachments === 'no') {
            tasks = tasks.filter(task => task.has_attachments === false);
        }
        
        // 5. Document Type Filter
        if (this.state.filters.documentType) {
            const docType = this.state.filters.documentType;
            tasks = tasks.filter(task => {
                switch (docType) {
                    case 'files':
                        return (task.doc_count || 0) > 0;
                    case 'links':
                        return (task.link_count || 0) > 0;
                    case 'github':
                        return (task.github_count || 0) > 0;
                    case 'manuals':
                        return (task.manual_count || 0) > 0;
                    // Counted server-side by classifying each URL — see the list route.
                    case 'drive':
                        return (task.drive_count || 0) > 0;
                    // The task's own requirement / updates / signed certificate.
                    case 'task_docs':
                        return (task.task_doc_count || 0) > 0;
                    default:
                        return true;
                }
            });
        }
        
        return tasks;
    }
    
    hasActiveFilters() {
        return (
            (this.state.searchQuery && this.state.searchQuery.trim() !== '') ||
            this.state.filters.assignee !== '' ||
            this.state.filters.priority !== '' ||
            this.state.filters.hasAttachments !== '' ||
            this.state.filters.documentType !== ''
        );
    }
    
    isAssigneeSelected(assigneeId) {
        return this.state.filters.assignee === String(assigneeId);
    }

    // =========================================================
    // DATA LOADING
    // =========================================================
    
    async loadTasks() {
        try {
            const result = await rpc('/task_documents/list', {});
            
            if (result.status) {
                this.state.allTasks = result.tasks || [];
                this.state.tasks = result.tasks || [];
                this.state.assignees = result.assignees || [];
            }
        } catch (error) {
            console.error('Error loading tasks:', error);
        } finally {
            this.state.loading = false;
        }
    }

    // =========================================================
    // FILTER EVENT HANDLERS
    // =========================================================
    
    onSearchInput(event) {
        this.state.searchQuery = event.target.value;
    }
    
    onAssigneeChange(event) {
        this.state.filters.assignee = event.target.value;
    }
    
    onPriorityChange(event) {
        this.state.filters.priority = event.target.value;
    }
    
    onAttachmentsChange(event) {
        this.state.filters.hasAttachments = event.target.value;
    }
    
    onDocTypeChange(event) {
        this.state.filters.documentType = event.target.value;
    }
    
    clearSearch() {
        this.state.searchQuery = '';
    }
    
    clearAssigneeFilter() {
        this.state.filters.assignee = '';
    }
    
    clearPriorityFilter() {
        this.state.filters.priority = '';
    }
    
    clearAttachmentsFilter() {
        this.state.filters.hasAttachments = '';
    }
    
    clearDocTypeFilter() {
        this.state.filters.documentType = '';
    }
    
    clearAllFilters() {
        this.state.searchQuery = '';
        this.state.filters = {
            assignee: '',
            priority: '',
            hasAttachments: '',
            documentType: '',
        };
        this.state.selectedAssignee = '';
    }

    // =========================================================
    // HELPER METHODS
    // =========================================================
    
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
    
    getPriorityTagStyle(priority) {
        const styles = {
            'urgent': 'background-color: #fef2f2; color: #991b1b; padding: 0.35rem 0.65rem; font-size: 0.8rem; font-weight: 500; border-radius: 9999px;',
            'important': 'background-color: #fffbeb; color: #92400e; padding: 0.35rem 0.65rem; font-size: 0.8rem; font-weight: 500; border-radius: 9999px;',
            'regular': 'background-color: #f3f4f6; color: #374151; padding: 0.35rem 0.65rem; font-size: 0.8rem; font-weight: 500; border-radius: 9999px;',
        };
        return styles[priority] || styles['regular'];
    }
    
    getPriorityButtonStyle(priority) {
        const styles = {
            'urgent': 'color: #991b1b;',
            'important': 'color: #92400e;',
            'regular': 'color: #374151;',
        };
        return styles[priority] || styles['regular'];
    }
    
    getDocTypeIcon(docType) {
        const icons = {
            'task_docs': 'fa fa-folder-open',
            'files': 'fa fa-file-text-o',
            'drive': 'fa fa-cloud',
            'links': 'fa fa-link',
            'github': 'fa fa-github',
            'manuals': 'fa fa-book',
        };
        return icons[docType] || 'fa fa-file';
    }

    getDocTypeLabel(docType) {
        const labels = {
            'task_docs': 'Task Documents',
            'files': 'Files',
            'drive': 'Drive / Cloud',
            'links': 'Links',
            'github': 'GitHub',
            'manuals': 'Manuals',
        };
        return labels[docType] || docType;
    }
    
    getAttachmentsLabel(value) {
        return value === 'yes' ? 'With Attachments' : 'No Attachments';
    }

    // =========================================================
    // EXISTING METHODS
    // =========================================================
    
    async filterByAssignee(assigneeId) {
        this.state.filters.assignee = assigneeId;
        this.state.selectedAssignee = assigneeId;
    }

    async viewTaskDocuments(taskId) {
        this.state.detailLoading = true;
        this.state.view = 'detail';
        this.state.task = {};          // clear the previous task's header context

        this.state.selectedTask = this.state.allTasks.find(t => t.id === taskId);

        try {
            const result = await rpc('/task_documents/details', { task_id: taskId });

            if (result.status) {
                this.state.documents = result.documents;
                this.state.task = result.task || {};   // ref / linked req / version / description
            }
        } catch (error) {
            console.error('Error loading task documents:', error);
        } finally {
            this.state.detailLoading = false;
        }
    }

    backToList() {
        this.state.view = 'list';
        this.state.selectedTask = null;
        this.state.task = {};
        this.state.documents = {
            files: [],
            links: [],
            github: [],
            manuals: [],
            task_docs: [],   // must match the state shape, or the next task inherits this one's
        };
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
}

registry.category("actions").add("task_documents_view", TaskDocuments);