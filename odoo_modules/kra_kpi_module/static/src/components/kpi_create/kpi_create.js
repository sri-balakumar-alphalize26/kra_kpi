/** @odoo-module **/
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

export class KpiCreate extends Component {
    static template = xml/* xml */`
        <div class="o_kpi_form p-2 p-md-4" style="max-width: 100%; height: 100vh; overflow-y: auto; overflow-x: hidden;">
            
            <!-- ============================================ -->
            <!-- 🆕 NEW: KRA QUICK CREATE MODAL -->
            <!-- ============================================ -->
            <t t-if="state.showKraModal">
                <div class="modal fade show d-block" style="background: rgba(0,0,0,0.5); z-index: 9999;">
                    <div class="modal-dialog modal-dialog-centered">
                        <div class="modal-content">
                            <div class="modal-header">
                                <h5 class="modal-title">Quick Create KRA</h5>
                                <button type="button" class="btn-close" t-on-click="closeKraModal"></button>
                            </div>
                            <div class="modal-body">
                                <div class="mb-3">
                                    <label class="form-label">KRA Name *</label>
                                    <input type="text" class="form-control" t-model="state.newKraName" placeholder="Enter KRA name"/>
                                </div>
                                <div class="form-check mb-3">
                                    <input type="checkbox" class="form-check-input" id="quickKraSub" t-model="state.newKraIsSub"/>
                                    <label class="form-check-label" for="quickKraSub">Is Sub-KRA?</label>
                                </div>
                                <t t-if="state.newKraIsSub">
                                    <div class="mb-3">
                                        <label class="form-label">Parent KRA</label>
                                        <select class="form-select" t-model="state.newKraParentId">
                                            <option value="">Select Parent</option>
                                            <t t-foreach="state.kra_list" t-as="k" t-key="k.id">
                                                <option t-att-value="k.id" t-esc="k.name"/>
                                            </t>
                                        </select>
                                    </div>
                                </t>
                            </div>
                            <div class="modal-footer">
                                <button type="button" class="btn btn-secondary" t-on-click="closeKraModal">Cancel</button>
                                <button type="button" class="btn btn-primary" t-on-click="saveQuickKra">Create KRA</button>
                            </div>
                        </div>
                    </div>
                </div>
            </t>

            <!-- ============================================ -->
            <!-- 🆕 NEW: ACTION CONFIG QUICK CREATE MODAL -->
            <!-- ============================================ -->
            <t t-if="state.showActionModal">
                <div class="modal fade show d-block" style="background: rgba(0,0,0,0.5); z-index: 9999;">
                    <div class="modal-dialog modal-dialog-centered">
                        <div class="modal-content">
                            <div class="modal-header">
                                <h5 class="modal-title">Quick Create Action Configuration</h5>
                                <button type="button" class="btn-close" t-on-click="closeActionModal"></button>
                            </div>
                            <div class="modal-body">
                                <div class="mb-3">
                                    <label class="form-label">Screen Name *</label>
                                    <input type="text" class="form-control" t-model="state.newActionName" placeholder="Enter screen name"/>
                                </div>
                                <div class="mb-3">
                                    <label class="form-label">Screen URL *</label>
                                    <input type="text" class="form-control" t-model="state.newActionUrl" placeholder="Enter screen URL"/>
                                </div>
                            </div>
                            <div class="modal-footer">
                                <button type="button" class="btn btn-secondary" t-on-click="closeActionModal">Cancel</button>
                                <button type="button" class="btn btn-primary" t-on-click="saveQuickAction">Create Action</button>
                            </div>
                        </div>
                    </div>
                </div>
            </t>

            <!-- ============================================ -->
            <!-- 🔄 UPDATED: WAREHOUSE QUICK CREATE MODAL -->
            <!-- ============================================ -->
            <t t-if="state.showWarehouseModal">
                <div class="modal fade show d-block" style="background: rgba(0,0,0,0.5); z-index: 9999;">
                    <div class="modal-dialog modal-dialog-centered">
                        <div class="modal-content">
                            <div class="modal-header">
                                <h5 class="modal-title">Quick Create Warehouse</h5>
                                <button type="button" class="btn-close" t-on-click="closeWarehouseModal"></button>
                            </div>
                            <div class="modal-body">
                                <div class="mb-3">
                                    <label class="form-label">Warehouse Name *</label>
                                    <input type="text" class="form-control" t-model="state.newWarehouseName" placeholder="Enter warehouse name"/>
                                </div>
                                
                                <!-- 🆕 NEW: Phone Number with Country Code -->
                                <div class="mb-3">
                                    <label class="form-label">Phone Number</label>
                                    <div class="input-group">
                                        <select class="form-select" style="max-width: 100px;" t-model="state.newWarehouseCountryCode">
                                            <option value="+1">🇺🇸 +1</option>
                                            <option value="+44">🇬🇧 +44</option>
                                            <option value="+91">🇮🇳 +91</option>
                                            <option value="+86">🇨🇳 +86</option>
                                            <option value="+81">🇯🇵 +81</option>
                                            <option value="+49">🇩🇪 +49</option>
                                            <option value="+33">🇫🇷 +33</option>
                                            <option value="+39">🇮🇹 +39</option>
                                            <option value="+7">🇷🇺 +7</option>
                                            <option value="+61">🇦🇺 +61</option>
                                            <option value="+55">🇧🇷 +55</option>
                                            <option value="+52">🇲🇽 +52</option>
                                            <option value="+34">🇪🇸 +34</option>
                                            <option value="+82">🇰🇷 +82</option>
                                            <option value="+971">🇦🇪 +971</option>
                                            <option value="+966">🇸🇦 +966</option>
                                            <option value="+65">🇸🇬 +65</option>
                                            <option value="+60">🇲🇾 +60</option>
                                            <option value="+66">🇹🇭 +66</option>
                                            <option value="+62">🇮🇩 +62</option>
                                        </select>
                                        <input type="tel" class="form-control" t-model="state.newWarehousePhone" placeholder="Enter phone number"/>
                                    </div>
                                </div>
                                
                                <!-- 🆕 NEW: Transaction Number -->
                                <div class="mb-3">
                                    <label class="form-label">Transaction Number</label>
                                    <input type="text" class="form-control" t-model="state.newWarehouseTransaction" placeholder="Enter transaction number"/>
                                </div>
                                
                                <div class="mb-3">
                                    <label class="form-label">Address</label>
                                    <textarea class="form-control" rows="2" t-model="state.newWarehouseAddress" placeholder="Enter address"></textarea>
                                </div>
                                
                                <!-- 🆕 NEW: Company (Text Input) -->
                                <div class="mb-3">
                                    <label class="form-label">Company</label>
                                    <input type="text" class="form-control" t-model="state.newWarehouseCompany" placeholder="Enter company name"/>
                                </div>
                            </div>
                            <div class="modal-footer">
                                <button type="button" class="btn btn-secondary" t-on-click="closeWarehouseModal">Cancel</button>
                                <button type="button" class="btn btn-primary" t-on-click="saveQuickWarehouse">Create Warehouse</button>
                            </div>
                        </div>
                    </div>
                </div>
            </t>

            <!-- ============================================ -->
            <!-- 🆕 NEW: USER GROUP QUICK CREATE MODAL -->
            <!-- ============================================ -->
            <t t-if="state.showUserGroupModal">
                <div class="modal fade show d-block" style="background: rgba(0,0,0,0.5); z-index: 9999;">
                    <div class="modal-dialog modal-dialog-centered">
                        <div class="modal-content">
                            <div class="modal-header">
                                <h5 class="modal-title">Quick Create User Group</h5>
                                <button type="button" class="btn-close" t-on-click="closeUserGroupModal"></button>
                            </div>
                            <div class="modal-body">
                                <div class="mb-3">
                                    <label class="form-label">Group Name *</label>
                                    <input type="text" class="form-control" t-model="state.newUserGroupName" placeholder="Enter group name"/>
                                </div>
                                <div class="alert alert-info mb-0">
                                    <small><strong>Note:</strong> This will create a new user group that can be assigned access rights later from Settings → Users &amp; Companies → Groups.</small>
                                </div>
                            </div>
                            <div class="modal-footer">
                                <button type="button" class="btn btn-secondary" t-on-click="closeUserGroupModal">Cancel</button>
                                <button type="button" class="btn btn-primary" t-on-click="saveQuickUserGroup">Create Group</button>
                            </div>
                        </div>
                    </div>
                </div>
            </t>
            <!-- ============================================ -->
            <!-- 🆕 NEW: EMPLOYEE QUICK CREATE MODAL -->
            <!-- ============================================ -->
            <t t-if="state.showEmployeeModal">
                <div class="modal fade show d-block" style="background: rgba(0,0,0,0.5); z-index: 9999;">
                    <div class="modal-dialog modal-dialog-centered">
                        <div class="modal-content">
                            <div class="modal-header">
                                <h5 class="modal-title">Quick Create Employee</h5>
                                <button type="button" class="btn-close" t-on-click="closeEmployeeModal"></button>
                            </div>
                            <div class="modal-body">
                                <div class="mb-3">
                                    <label class="form-label">Employee Name *</label>
                                    <input type="text" class="form-control" t-model="state.newEmployeeName" placeholder="Enter full name"/>
                                </div>
                                <div class="mb-3">
                                    <label class="form-label">Email *</label>
                                    <input type="email" class="form-control" t-model="state.newEmployeeEmail" placeholder="Enter email address"/>
                                </div>
                                <div class="mb-3">
                                    <label class="form-label">Login (Username) *</label>
                                    <input type="text" class="form-control" t-model="state.newEmployeeLogin" placeholder="Enter login username"/>
                                </div>
                                <div class="alert alert-info mb-0">
                                    <small><strong>Note:</strong> This will create a new user account. Make sure to set a password later from Settings → Users.</small>
                                </div>
                            </div>
                            <div class="modal-footer">
                                <button type="button" class="btn btn-secondary" t-on-click="closeEmployeeModal">Cancel</button>
                                <button type="button" class="btn btn-primary" t-on-click="saveQuickEmployee">Create Employee</button>
                            </div>
                        </div>
                    </div>
                </div>
            </t>

            <!-- ============================================ -->
            <!-- 🆕 NEW: CHECKLIST LIBRARY MODAL -->
            <!-- ============================================ -->
            <t t-if="state.showChecklistModal">
                <div class="modal fade show d-block" style="background: rgba(0,0,0,0.5); z-index: 9999;">
                    <div class="modal-dialog modal-dialog-centered modal-lg">
                        <div class="modal-content">
                            <div class="modal-header">
                                <h5 class="modal-title">Checklist Library</h5>
                                <button type="button" class="btn-close" t-on-click="closeChecklistModal"></button>
                            </div>
                            <div class="modal-body">
                                <!-- Add New Checklist Item -->
                                <div class="mb-3">
                                    <label class="form-label fw-bold">Add New Checklist Item</label>
                                    <div class="input-group">
                                        <input type="text" class="form-control" t-model="state.newChecklistItem" placeholder="Enter checklist item"/>
                                        <button type="button" class="btn btn-primary" t-on-click="addChecklistItem">
                                            <i class="fa fa-plus"/> Add
                                        </button>
                                    </div>
                                </div>
                                
                                <hr/>
                                
                                <!-- Existing Checklist Items -->
                                <div class="mb-3">
                                    <label class="form-label fw-bold">Select from Existing Items</label>
                                    <div style="max-height: 300px; overflow-y: auto; border: 1px solid #ddd; padding: 10px; border-radius: 5px;">
                                        <t t-if="state.checklistItems.length > 0">
                                            <t t-foreach="state.checklistItems" t-as="item" t-key="item.id">
                                                <div class="form-check mb-2">
                                                    <input class="form-check-input" type="checkbox" 
                                                        t-att-id="'checklist_' + item.id"
                                                        t-att-checked="state.selectedChecklists.includes(item.id)"
                                                        t-on-change="() => this.toggleChecklistItem(item.id)"/>
                                                    <label class="form-check-label" t-att-for="'checklist_' + item.id">
                                                        <t t-esc="item.name"/>
                                                    </label>
                                                </div>
                                            </t>
                                        </t>
                                        <t t-else="">
                                            <div class="text-muted">No checklist items available</div>
                                        </t>
                                    </div>
                                </div>
                            </div>
                            <div class="modal-footer">
                                <button type="button" class="btn btn-secondary" t-on-click="closeChecklistModal">Cancel</button>
                                <button type="button" class="btn btn-primary" t-on-click="applyChecklists">Apply Selected</button>
                            </div>
                        </div>
                    </div>
                </div>
            </t>

            <!-- ============================================ -->
            <!-- 🆕 NEW: GUIDELINE LIBRARY MODAL -->
            <!-- ============================================ -->
            <t t-if="state.showGuidelineModal">
                <div class="modal fade show d-block" style="background: rgba(0,0,0,0.5); z-index: 9999;">
                    <div class="modal-dialog modal-dialog-centered modal-lg">
                        <div class="modal-content">
                            <div class="modal-header">
                                <h5 class="modal-title">Guideline Library</h5>
                                <button type="button" class="btn-close" t-on-click="closeGuidelineModal"></button>
                            </div>
                            <div class="modal-body">
                                <!-- Add New Guideline Item -->
                                <div class="mb-3">
                                    <label class="form-label fw-bold">Add New Guideline Item</label>
                                    <div class="input-group">
                                        <input type="text" class="form-control" t-model="state.newGuidelineItem" placeholder="Enter guideline item"/>
                                        <button type="button" class="btn btn-primary" t-on-click="addGuidelineItem">
                                            <i class="fa fa-plus"/> Add
                                        </button>
                                    </div>
                                </div>
                                
                                <hr/>
                                
                                <!-- Existing Guideline Items -->
                                <div class="mb-3">
                                    <label class="form-label fw-bold">Select from Existing Items</label>
                                    <div style="max-height: 300px; overflow-y: auto; border: 1px solid #ddd; padding: 10px; border-radius: 5px;">
                                        <t t-if="state.guidelineItems.length > 0">
                                            <t t-foreach="state.guidelineItems" t-as="item" t-key="item.id">
                                                <div class="form-check mb-2">
                                                    <input class="form-check-input" type="checkbox" 
                                                        t-att-id="'guideline_' + item.id"
                                                        t-att-checked="state.selectedGuidelines.includes(item.id)"
                                                        t-on-change="() => this.toggleGuidelineItem(item.id)"/>
                                                    <label class="form-check-label" t-att-for="'guideline_' + item.id">
                                                        <t t-esc="item.name"/>
                                                    </label>
                                                </div>
                                            </t>
                                        </t>
                                        <t t-else="">
                                            <div class="text-muted">No guideline items available</div>
                                        </t>
                                    </div>
                                </div>
                            </div>
                            <div class="modal-footer">
                                <button type="button" class="btn btn-secondary" t-on-click="closeGuidelineModal">Cancel</button>
                                <button type="button" class="btn btn-primary" t-on-click="applyGuidelines">Apply Selected</button>
                            </div>
                        </div>
                    </div>
                </div>
            </t>
            

            <h3 class="fw-bold mb-3">Create KPI</h3>
            <div class="card p-3 o-kpi-card">
                <!-- KPI Name -->
                <div class="mb-3">
                    <label class="form-label fw-bold">KPI Name</label>
                    <input type="text" class="form-control" t-model="state.name"/>
                </div>

                <!-- ============================================ -->
                <!-- 🔄 UPDATED: Parent KRA with + button -->
                <!-- ============================================ -->
                <div class="mb-3">
                    <label class="form-label fw-bold">Select KRA</label>
                    <div class="d-flex gap-2">
                        <select class="form-select" t-model="state.kra_id">
                            <option value="">Select KRA</option>
                            <t t-foreach="state.kra_list" t-as="k" t-key="k.id">
                                <option t-att-value="k.id" t-esc="k.name"/>
                            </t>
                        </select>
                        <button type="button" class="btn btn-outline-secondary" t-on-click="openKraForm">
                            +
                        </button>
                    </div>
                </div>

                <!-- Basic Fields Row -->
                <div class="row g-3">
                    <!-- Estimate Time (Hours:Minutes) -->
                    <div class="mb-3">
                        <label class="form-label fw-bold">Estimate Time</label>
                        <div class="row g-2">
                            <div class="col-6">
                                <div class="input-group">
                                    <input type="number" 
                                        class="form-control" 
                                        t-model="state.estimate_hours"
                                        min="0"
                                        placeholder="Hours"/>
                                    <span class="input-group-text">hrs</span>
                                </div>
                            </div>
                            <div class="col-6">
                                <div class="input-group">
                                    <input type="number" 
                                        class="form-control" 
                                        t-model="state.estimate_minutes"
                                        min="0"
                                        max="59"
                                        placeholder="Minutes"/>
                                    <span class="input-group-text">min</span>
                                </div>
                            </div>
                        </div>
                        <small class="text-muted">Example: 2 hours 30 minutes</small>
                    </div>
                </div>

                <!-- Priority -->
                <div class="mb-3">
                    <label class="form-label fw-bold">Priority</label>
                    <select class="form-select" t-model="state.priority">
                        <option t-att-value="'regular'">Regular</option>
                        <option t-att-value="'important'">Important</option>
                        <option t-att-value="'urgent'">Urgent</option>
                    </select>
                </div>

                <!-- User Group & Assignee Row -->
                <div class="row g-3">
                    <div class="col-12 col-sm-6">
                        <!-- ============================================ -->
                        <!-- 🔄 UPDATED: User Group with + button -->
                        <!-- ============================================ -->
                        <div class="mb-3">
                            <label class="form-label fw-bold">User Group</label>
                            <div class="d-flex gap-2">
                                <select class="form-select" t-model="state.user_group_id">
                                    <option value="">Select User Group</option>
                                    <t t-foreach="state.groups" t-as="g" t-key="g.id">
                                        <option t-att-value="g.id" t-esc="g.name"/>
                                    </t>
                                </select>
                                <button type="button" class="btn btn-outline-secondary" t-on-click="openUserGroupForm">
                                    +
                                </button>
                            </div>
                        </div>
                    </div>
                    <div class="col-12 col-sm-6">
                        <!-- 🔄 UPDATED: Assignee with + button -->
                        <div class="mb-3">
                            <label class="form-label fw-bold">Assignee</label>
                            <div class="d-flex gap-2">
                                <select class="form-select" t-model="state.user_id">
                                    <option value="">Select Assignee</option>
                                    <t t-foreach="state.users" t-as="u" t-key="u.id">
                                        <option t-att-value="u.id" t-esc="u.name"/>
                                    </t>
                                </select>
                                <button type="button" class="btn btn-outline-secondary" t-on-click="openEmployeeForm">
                                    +
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Deadline & Reminder Row -->
                <div class="row g-3">
                    <div class="col-12 col-sm-6">
                        <!-- Deadline -->
                        <div class="mb-3">
                            <label class="form-label fw-bold">Deadline</label>
                            <input type="date" class="form-control" t-model="state.deadline"/>
                        </div>
                    </div>
                    <div class="col-12 col-sm-6">
                        <!-- Reminder Interval -->
                        <div class="mb-3">
                            <label class="form-label fw-bold">Reminder Interval</label>
                            <div class="d-flex gap-2">
                                <div class="input-group input-group-sm">
                                    <input type="number" min="0" class="form-control form-control-sm" t-model="state.reminder_days" placeholder="0"/>
                                    <span class="input-group-text">d</span>
                                </div>
                                <div class="input-group input-group-sm">
                                    <input type="number" min="0" max="23" class="form-control form-control-sm" t-model="state.reminder_hours" placeholder="0"/>
                                    <span class="input-group-text">h</span>
                                </div>
                                <div class="input-group input-group-sm">
                                    <input type="number" min="0" max="59" class="form-control form-control-sm" t-model="state.reminder_minutes" placeholder="0"/>
                                    <span class="input-group-text">m</span>
                                </div>
                            </div>
                            <small class="text-muted">Reminder popup interval for in-progress tasks</small>
                        </div>
                    </div>
                </div>

                <!-- Actions & Next KPI Row -->
                <div class="row g-3">
                    <!-- ============================================ -->
                    <!-- 🔄 UPDATED: Actions with + button -->
                    <!-- ============================================ -->
                    <div class="col-12 col-sm-6">
                        <div class="mb-3">
                            <label class="form-label fw-bold">Actions</label>
                            <div class="d-flex gap-2">
                                <select class="form-select" t-model="state.action_config_id">
                                    <option value="">Select Action</option>
                                    <t t-foreach="state.action_config_list" t-as="action" t-key="action.id">
                                        <option t-att-value="action.id" t-esc="action.name"/>
                                    </t>
                                </select>
                                <button type="button" class="btn btn-outline-secondary" t-on-click="openActionConfigForm">
                                    +
                                </button>
                            </div>
                        </div>
                    </div>
                    <div class="col-12 col-sm-6">
                        <!-- Next KPI -->
                        <div class="mb-3">
                            <label class="form-label fw-bold">Next KPI</label>
                            <select class="form-select" t-model="state.next_kpi_id">
                                <option value="">Select Next KPI</option>
                                <t t-foreach="state.kpi_list" t-as="kp" t-key="kp.id">
                                    <option t-att-value="kp.id" t-esc="kp.name"/>
                                </t>
                            </select>
                        </div>
                    </div>
                </div>

                <!-- Warehouse & File Name Row -->
                <div class="row g-3">
                    <!-- ============================================ -->
                    <!-- 🔄 UPDATED: Warehouse with + button -->
                    <!-- ============================================ -->
                    <div class="col-12 col-sm-6">
                        <div class="mb-3">
                            <label class="form-label fw-bold">Warehouse</label>
                            <div class="d-flex gap-2">
                                <select class="form-select" t-model="state.warehouse_id">
                                    <option value="">Select Warehouse</option>
                                    <t t-foreach="state.warehouses" t-as="w" t-key="w.id">
                                        <option t-att-value="w.id" t-esc="w.name"/>
                                    </t>
                                </select>
                                <button type="button" class="btn btn-outline-secondary" t-on-click="openWarehouseForm">
                                    +
                                </button>
                            </div>
                        </div>
                    </div>
                    <div class="col-12 col-sm-6">
                        <!-- File Name -->
                        <div class="mb-3">
                            <label class="form-label fw-bold">File Name</label>
                            <input type="text" class="form-control" t-model="state.file_name"/>
                        </div>
                        <div class="mb-3">
                            <label class="form-label fw-bold">Upload File</label>
                            <input type="file" class="form-control" t-on-change="handleFileUpload"/>
                        </div>
                    </div>
                </div>
                <!-- 🆕 NEW: Related Links Section -->
                <div class="mb-3">
                    <label class="form-label fw-bold">Related Links</label>
                    <p class="text-muted small">Add reference links, documentation URLs, or related resources</p>
                    
                    <!-- Input for adding new link -->
                    <div class="input-group mb-2">
                        <input type="url" 
                            class="form-control" 
                            t-model="state.link_input"
                            placeholder="Enter URL (e.g., https://example.com/docs)"/>
                        <button type="button" class="btn btn-outline-primary" t-on-click="addRelatedLink">
                            <i class="fa fa-plus"/> Add
                        </button>
                    </div>
                    
                    <!-- Display added links -->
                    <t t-if="state.related_links.length > 0">
                        <div class="list-group">
                            <t t-foreach="state.related_links" t-as="link" t-key="link_index">
                                <div class="list-group-item d-flex justify-content-between align-items-center py-2">
                                    <div class="d-flex align-items-center">
                                        <i class="fa fa-link text-primary me-2"/>
                                        <a t-att-href="link" target="_blank" class="text-truncate" style="max-width: 400px;" t-esc="link"/>
                                    </div>
                                    <button type="button" class="btn btn-sm btn-outline-danger" t-on-click="() => this.removeRelatedLink(link_index)">
                                        <i class="fa fa-times"/>
                                    </button>
                                </div>
                            </t>
                        </div>
                    </t>
                    <t t-else="">
                        <div class="text-muted small">No links added yet</div>
                    </t>
                </div>

                <!-- Description -->
                <div class="mb-3">
                    <label class="form-label fw-bold">KPI Description</label>
                    <textarea class="form-control" rows="3" t-model="state.description"></textarea>
                </div>

                <!-- Checklist -->
                <div class="mb-3">
                    <label class="form-label fw-bold">Checklist</label>
                    <div class="d-flex gap-2 mb-2">
                        <button type="button" class="btn btn-sm btn-outline-primary" t-on-click="openChecklistModal">
                            <i class="fa fa-plus"/> Add Checklists
                        </button>
                    </div>
                    <textarea class="form-control" rows="4" t-model="state.checklist"></textarea>
                </div>

                <!-- Guidelines -->
                <div class="mb-3">
                    <label class="form-label fw-bold">Guidelines</label>
                    <div class="d-flex gap-2 mb-2">
                        <button type="button" class="btn btn-sm btn-outline-primary" t-on-click="openGuidelineModal">
                            <i class="fa fa-plus"/> Add Guidelines
                        </button>
                    </div>
                    <textarea class="form-control" rows="4" t-model="state.guidelines"></textarea>
                </div>

                <!-- Flags Section -->
                <div class="mb-3">
                    <label class="form-label fw-bold">Additional Settings</label>
                    <div class="row g-2">
                        <div class="col-12 col-sm-6">
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" t-model="state.is_mandatory" id="is_mandatory"/>
                                <label class="form-check-label" for="is_mandatory">Is Mandatory</label>
                            </div>
                        </div>
                        <div class="col-12 col-sm-6">
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" t-model="state.auto_assign" id="auto_assign"/>
                                <label class="form-check-label" for="auto_assign">Auto Assign</label>
                            </div>
                        </div>
                        <div class="col-12 col-sm-6">
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" t-model="state.auto_estimated" id="auto_estimated"/>
                                <label class="form-check-label" for="auto_estimated">Auto Estimated</label>
                            </div>
                        </div>
                        <div class="col-12 col-sm-6">
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" t-model="state.is_permanent" id="is_permanent"/>
                                <label class="form-check-label" for="is_permanent">Is Permanent</label>
                            </div>
                        </div>
                        <div class="col-12 col-sm-6">
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" t-model="state.service_kpi" id="service_kpi"/>
                                <label class="form-check-label" for="service_kpi">Service KPI</label>
                            </div>
                        </div>
                        <div class="col-12 col-sm-6">
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" t-model="state.is_meeting" id="is_meeting"/>
                                <label class="form-check-label" for="is_meeting">Is Meeting</label>
                            </div>
                        </div>
                        <div class="col-12 col-sm-6">
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" t-model="state.is_manager_review_needed" id="is_manager_review_needed"/>
                                <label class="form-check-label" for="is_manager_review_needed">Coordinator Review</label>
                            </div>
                        </div>
                        <div class="col-12 col-sm-6">
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" t-model="state.is_customer_review_needed" id="is_customer_review_needed"/>
                                <label class="form-check-label" for="is_customer_review_needed">Customer Review</label>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="d-flex justify-content-end mt-4 gap-2">
                    <button class="btn btn-light" t-on-click="cancel">Cancel</button>
                    <button class="btn btn-primary" t-on-click="save">Save</button>
                </div>
            </div>
        </div>
    `;

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.notification = useService("notification");

        // ============================================
        // 🔄 UPDATED: Added warehouse fields with company and transaction
        // ============================================
        this.state = useState({
            name: "",
            kra_id: "",
            estimate_hours: 0,
            estimate_minutes: 0,        
            kra_list: [],
            priority: 'regular',
            user_group_id: '',
            user_id: '',
            action_config_id: "",
            action_config_list: [],
            next_kpi_id: '',
            warehouse_id: '',
            warehouse_list: [],
            description: '',
            checklist: '',
            guidelines: '',
            deadline: '',
            reminder_days: 0,
            reminder_hours: 0,
            reminder_minutes: 0,
            points: 0,
            is_mandatory: false,
            auto_assign: false,
            auto_estimated: false,
            is_permanent: false,
            service_kpi: false,
            is_meeting: false,
            is_manager_review_needed: false,
            is_customer_review_needed: false,
            file_name: '',
            uploaded_file: null,
            related_links: [],
            link_input: '',
            kpi_list: [],
            users: [],
            groups: [],
            warehouses: [],
            
            // 🆕 NEW: Modal control states
            showKraModal: false,
            showActionModal: false,
            showWarehouseModal: false,
            showUserGroupModal: false,
            // 🆕 NEW: Employee Quick Create Modal
            showEmployeeModal: false,
            newEmployeeName: '',
            newEmployeeEmail: '',
            newEmployeeLogin: '',
            
            // 🆕 NEW: Quick create form fields
            newKraName: '',
            newKraIsSub: false,
            newKraParentId: '',
            newActionName: '',
            newActionUrl: '',
            newWarehouseName: '',
            newWarehousePhone: '',
            newWarehouseAddress: '',
            newWarehouseCountryCode: '+91',    // 🆕 NEW
            newWarehouseCompany: '',            // 🆕 NEW
            newWarehouseTransaction: '',        // 🆕 NEW
            newUserGroupName: '',
            // 🆕 NEW: Checklist/Guideline Modal states
            showChecklistModal: false,
            showGuidelineModal: false,
            checklistItems: [],
            guidelineItems: [],
            selectedChecklists: [],
            selectedGuidelines: [],
            newChecklistItem: '',
            newGuidelineItem: '',
        });

        onWillStart(async () => {
            await Promise.all([
                this.loadParentKras(),
                this.loadUsersAndGroups(),
                this.loadKpiList(),
                this.loadWarehouses(),
                this.loadActionConfig(),
                this.loadChecklistItems(),
                this.loadGuidelineItems(),      
            ]);
        });
    }

    async loadParentKras() {
        try {
            const result = await this.orm.call("kra.master", "get_parent_kras", []);
            this.state.kra_list = result;
        } catch (e) {
            console.error("Error fetching KRA list:", e);
        }
    }

    async loadUsersAndGroups() {
        try {
            const users = await this.orm.searchRead('res.users', [], ['id', 'name']);
            const groups = await this.orm.searchRead('res.groups', [], ['id', 'name']);
            this.state.users = users;
            this.state.groups = groups;
        } catch (e) {
            console.error('Error loading users/groups', e);
        }
    }

    async loadKpiList() {
        try {
            const kpis = await this.orm.searchRead('kra.kpi', [], ['id', 'name']);
            this.state.kpi_list = kpis;
        } catch (e) {
            console.error('Error loading KPI list', e);
        }
    }

    async loadActionConfig() {
        try {
            const result = await this.orm.searchRead(
                "kpi.config.screen",
                [],
                ["id", "name"]
            );
            this.state.action_config_list = result;
        } catch (e) {
            console.error("Error loading KPI config", e);
        }
    }

    async loadWarehouses() {
        try {
            const warehouses = await this.orm.searchRead(
                "kra.warehouse",
                [],
                ["id", "name"]
            );
            this.state.warehouses = warehouses;
        } catch (e) {
            console.error("Error loading warehouses", e);
        }
    }

    handleFileUpload(event) {
        const file = event.target.files[0];
        if (file) {
            this.state.file_name = file.name;
            const reader = new FileReader();
            reader.onload = () => {
                this.state.uploaded_file = reader.result.split(',')[1];
            };
            reader.readAsDataURL(file);
        }
    }
    // 🆕 NEW: Related Links Methods
    addRelatedLink() {
        const link = this.state.link_input.trim();
        
        if (!link) {
            this.notification.add("Please enter a link", { type: "warning" });
            return;
        }
        
        // Basic URL validation
        try {
            new URL(link);
        } catch (e) {
            this.notification.add("Please enter a valid URL (e.g., https://example.com)", { type: "warning" });
            return;
        }
        
        // Check for duplicates
        if (this.state.related_links.includes(link)) {
            this.notification.add("This link is already added", { type: "warning" });
            return;
        }
        
        this.state.related_links.push(link);
        this.state.link_input = '';
    }

    removeRelatedLink(index) {
        this.state.related_links.splice(index, 1);
    }

    // ============================================
    // 🔄 UPDATED: Modal open/close functions
    // ============================================
    openWarehouseForm() {
        this.state.showWarehouseModal = true;
        this.state.newWarehouseName = '';
        this.state.newWarehousePhone = '';
        this.state.newWarehouseAddress = '';
        this.state.newWarehouseCountryCode = '+91';    // 🆕 NEW
        this.state.newWarehouseCompany = '';            // 🆕 NEW
        this.state.newWarehouseTransaction = '';        // 🆕 NEW
    }

    openKraForm() {
        this.state.showKraModal = true;
        this.state.newKraName = '';
        this.state.newKraIsSub = false;
        this.state.newKraParentId = '';
    }

    openActionConfigForm() {
        this.state.showActionModal = true;
        this.state.newActionName = '';
        this.state.newActionUrl = '';
    }

    openUserGroupForm() {
        this.state.showUserGroupModal = true;
        this.state.newUserGroupName = '';
    }
    openEmployeeForm() {
        this.state.showEmployeeModal = true;
        this.state.newEmployeeName = '';
        this.state.newEmployeeEmail = '';
        this.state.newEmployeeLogin = '';
    }
    closeEmployeeModal() {
        this.state.showEmployeeModal = false;
    }

    closeKraModal() {
        this.state.showKraModal = false;
    }

    closeActionModal() {
        this.state.showActionModal = false;
    }

    closeWarehouseModal() {
        this.state.showWarehouseModal = false;
    }

    closeUserGroupModal() {
        this.state.showUserGroupModal = false;
    }

    // ============================================
    // 🆕 NEW: Quick create save functions
    // ============================================
    async saveQuickKra() {
        if (!this.state.newKraName) {
            alert('KRA Name is required');
            return;
        }

        try {
            const newId = await this.orm.call("kra.master", "create_kra", [{
                name: this.state.newKraName,
                is_sub: this.state.newKraIsSub,
                parent_id: this.state.newKraParentId || false,
            }]);

            await this.loadParentKras();
            this.state.kra_id = newId;
            this.state.showKraModal = false;
            alert('KRA created successfully!');
        } catch (e) {
            console.error('Error creating KRA:', e);
            alert('Error creating KRA');
        }
    }

    async saveQuickAction() {
        if (!this.state.newActionName || !this.state.newActionUrl) {
            alert('Screen Name and URL are required');
            return;
        }

        try {
            const newAction = await this.orm.create("kpi.config.screen", [{
                name: this.state.newActionName,
                url: this.state.newActionUrl,
                active: true,
            }]);

            await this.loadActionConfig();
            this.state.action_config_id = newAction[0];
            this.state.showActionModal = false;
            alert('Action Configuration created successfully!');
        } catch (e) {
            console.error('Error creating action config:', e);
            alert('Error creating action configuration');
        }
    }

    // 🔄 UPDATED: Save warehouse with company and transaction
    async saveQuickWarehouse() {
        if (!this.state.newWarehouseName) {
            alert('Warehouse Name is required');
            return;
        }

        try {
            const fullPhone = this.state.newWarehousePhone 
                ? `${this.state.newWarehouseCountryCode} ${this.state.newWarehousePhone}`
                : '';
            
            const newWarehouse = await this.orm.create("kra.warehouse", [{
                name: this.state.newWarehouseName,
                phone: fullPhone,
                address: this.state.newWarehouseAddress || '',
                company: this.state.newWarehouseCompany || '',
                transaction_number: this.state.newWarehouseTransaction || '',
            }]);

            await this.loadWarehouses();
            this.state.warehouse_id = newWarehouse[0];
            this.state.showWarehouseModal = false;
            alert('Warehouse created successfully!');
        } catch (e) {
            console.error('Error creating warehouse:', e);
            alert('Error creating warehouse');
        }
    }

    async saveQuickUserGroup() {
        if (!this.state.newUserGroupName) {
            alert('Group Name is required');
            return;
        }

        try {
            const newGroup = await this.orm.create("res.groups", [{
                name: this.state.newUserGroupName,
            }]);

            await this.loadUsersAndGroups();
            this.state.user_group_id = newGroup[0];
            this.state.showUserGroupModal = false;
            alert('User Group created successfully!');
        } catch (e) {
            console.error('Error creating user group:', e);
            alert('Error creating user group');
        }
    }
    async saveQuickEmployee() {
        if (!this.state.newEmployeeName || !this.state.newEmployeeEmail || !this.state.newEmployeeLogin) {
            alert('Employee Name, Email, and Login are required');
            return;
        }

        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(this.state.newEmployeeEmail)) {
            alert('Please enter a valid email address');
            return;
        }

        try {
            const newUser = await this.orm.create("res.users", [{
                name: this.state.newEmployeeName,
                login: this.state.newEmployeeLogin,
                email: this.state.newEmployeeEmail,
            }]);

            await this.loadUsersAndGroups();
            this.state.user_id = newUser[0];
            this.state.showEmployeeModal = false;
            alert('Employee created successfully! Please set a password from Settings → Users.');
        } catch (e) {
            console.error('Error creating employee:', e);
            alert('Error creating employee: ' + (e.message || 'Please try again'));
        }
    }
    // ============================================
    // 🆕 NEW: CHECKLIST LIBRARY METHODS
    // ============================================
    async loadChecklistItems() {
        try {
            const items = await this.orm.searchRead(
                'kpi.checklist.master',
                [],
                ['id', 'name', 'sequence'],
                { order: 'sequence, name' }
            );
            this.state.checklistItems = items;
        } catch (e) {
            console.error('Error loading checklist items:', e);
        }
    }

    openChecklistModal() {
        this.state.showChecklistModal = true;
        this.state.newChecklistItem = '';
        // Pre-select items that are already in the textarea
        this.preselectChecklistItems();
    }

    closeChecklistModal() {
        this.state.showChecklistModal = false;
        this.state.selectedChecklists = [];
    }

    preselectChecklistItems() {
        // Parse existing checklist text and pre-select matching items
        const existingText = this.state.checklist || '';
        const lines = existingText.split('\n').filter(l => l.trim());
        
        this.state.selectedChecklists = [];
        lines.forEach(line => {
            // Remove numbering (1., 2., etc.)
            const cleanLine = line.replace(/^\d+\.\s*/, '').trim();
            const matchingItem = this.state.checklistItems.find(item => 
                item.name.trim() === cleanLine
            );
            if (matchingItem) {
                this.state.selectedChecklists.push(matchingItem.id);
            }
        });
    }

    toggleChecklistItem(itemId) {
        const index = this.state.selectedChecklists.indexOf(itemId);
        if (index > -1) {
            this.state.selectedChecklists.splice(index, 1);
        } else {
            this.state.selectedChecklists.push(itemId);
        }
    }

    async addChecklistItem() {
        const itemName = this.state.newChecklistItem.trim();
        
        if (!itemName) {
            this.notification.add('Please enter a checklist item', { type: 'warning' });
            return;
        }
        
        try {
            const newItem = await this.orm.create('kpi.checklist.master', [{
                name: itemName,
            }]);
            
            await this.loadChecklistItems();
            this.state.selectedChecklists.push(newItem[0]);
            this.state.newChecklistItem = '';
            
            this.notification.add('Checklist item added successfully', { type: 'success' });
        } catch (e) {
            console.error('Error creating checklist item:', e);
            this.notification.add('Error adding checklist item', { type: 'danger' });
        }
    }

    applyChecklists() {
        // Get selected items in order
        const selectedItems = this.state.checklistItems.filter(item =>
            this.state.selectedChecklists.includes(item.id)
        );
        
        // Format with numbering
        const formattedText = selectedItems
            .map((item, index) => `${index + 1}. ${item.name}`)
            .join('\n');
        
        this.state.checklist = formattedText;
        this.closeChecklistModal();
        
        this.notification.add('Checklist items applied', { type: 'success' });
    }

    // ============================================
    // 🆕 NEW: GUIDELINE LIBRARY METHODS
    // ============================================
    async loadGuidelineItems() {
        try {
            const items = await this.orm.searchRead(
                'kpi.guideline.master',
                [],
                ['id', 'name', 'sequence'],
                { order: 'sequence, name' }
            );
            this.state.guidelineItems = items;
        } catch (e) {
            console.error('Error loading guideline items:', e);
        }
    }

    openGuidelineModal() {
        this.state.showGuidelineModal = true;
        this.state.newGuidelineItem = '';
        // Pre-select items that are already in the textarea
        this.preselectGuidelineItems();
    }

    closeGuidelineModal() {
        this.state.showGuidelineModal = false;
        this.state.selectedGuidelines = [];
    }

    preselectGuidelineItems() {
        // Parse existing guideline text and pre-select matching items
        const existingText = this.state.guidelines || '';
        const lines = existingText.split('\n').filter(l => l.trim());
        
        this.state.selectedGuidelines = [];
        lines.forEach(line => {
            // Remove numbering (1., 2., etc.)
            const cleanLine = line.replace(/^\d+\.\s*/, '').trim();
            const matchingItem = this.state.guidelineItems.find(item => 
                item.name.trim() === cleanLine
            );
            if (matchingItem) {
                this.state.selectedGuidelines.push(matchingItem.id);
            }
        });
    }

    toggleGuidelineItem(itemId) {
        const index = this.state.selectedGuidelines.indexOf(itemId);
        if (index > -1) {
            this.state.selectedGuidelines.splice(index, 1);
        } else {
            this.state.selectedGuidelines.push(itemId);
        }
    }

    async addGuidelineItem() {
        const itemName = this.state.newGuidelineItem.trim();
        
        if (!itemName) {
            this.notification.add('Please enter a guideline item', { type: 'warning' });
            return;
        }
        
        try {
            const newItem = await this.orm.create('kpi.guideline.master', [{
                name: itemName,
            }]);
            
            await this.loadGuidelineItems();
            this.state.selectedGuidelines.push(newItem[0]);
            this.state.newGuidelineItem = '';
            
            this.notification.add('Guideline item added successfully', { type: 'success' });
        } catch (e) {
            console.error('Error creating guideline item:', e);
            this.notification.add('Error adding guideline item', { type: 'danger' });
        }
    }

    applyGuidelines() {
        // Get selected items in order
        const selectedItems = this.state.guidelineItems.filter(item =>
            this.state.selectedGuidelines.includes(item.id)
        );
        
        // Format with numbering
        const formattedText = selectedItems
            .map((item, index) => `${index + 1}. ${item.name}`)
            .join('\n');
        
        this.state.guidelines = formattedText;
        this.closeGuidelineModal();
        
        this.notification.add('Guideline items applied', { type: 'success' });
    }

    // ============================================
    // EXISTING FUNCTIONS (unchanged)
    // ============================================
    async save() {
        if (!this.state.name) {
            this.notification.add("KPI Name is required", { type: "warning" });
            return;
        }
        if (!this.state.kra_id) {
            this.notification.add("Select KRA", { type: "warning" });
            return;
        }
        if (!this.state.user_id) {
            this.notification.add("Assignee is required", { type: "warning" });
            return;
        }
         // ✅ ADD THIS NEW VALIDATION HERE
        if (this.state.estimate_hours === 0 && this.state.estimate_minutes === 0) {
            this.notification.add("Estimate Time is required. Please enter hours and/or minutes.", { type: "warning" });
            return;
        }
        if (this.state.estimate_minutes < 0 || this.state.estimate_minutes > 59) {
            this.notification.add("Minutes must be between 0 and 59", { type: "warning" });
            return;
        }

        try {
            await this.orm.call("kra.kpi", "create_kpi", [{
                name: this.state.name,
                kra_id: parseInt(this.state.kra_id),
                estimate_hours: parseInt(this.state.estimate_hours) || 0,
                estimate_minutes: parseInt(this.state.estimate_minutes) || 0,
                priority: this.state.priority,
                user_group_id: this.state.user_group_id || false,
                user_id: this.state.user_id || false,
                action_config_id: this.state.action_config_id ? parseInt(this.state.action_config_id) : false,
                next_kpi_id: this.state.next_kpi_id || false,
                warehouse_id: this.state.warehouse_id ? parseInt(this.state.warehouse_id) : false,
                description: this.state.description,
                checklist: this.state.checklist,
                guidelines: this.state.guidelines,
                deadline: this.state.deadline || false,
                reminder_days: parseInt(this.state.reminder_days) || 0,
                reminder_hours: parseInt(this.state.reminder_hours) || 0,
                reminder_minutes: parseInt(this.state.reminder_minutes) || 0,
                points: this.state.points || 0,
                is_mandatory: this.state.is_mandatory,
                auto_assign: this.state.auto_assign,
                auto_estimated: this.state.auto_estimated,
                is_permanent: this.state.is_permanent,
                service_kpi: this.state.service_kpi,
                is_meeting: this.state.is_meeting,
                is_manager_review_needed: this.state.is_manager_review_needed,
                is_customer_review_needed: this.state.is_customer_review_needed,
                file_name: this.state.file_name,
                uploaded_file: this.state.uploaded_file,
                related_links: JSON.stringify(this.state.related_links),
            }]);

            this.notification.add("KPI created successfully", { type: "success" });
            window.location.hash = "/";
        } catch (e) {
            console.error("Error creating KPI:", e);
            let errorMsg = "Error creating KPI";
            
            if (e.data && e.data.message) {
                errorMsg = e.data.message;
            } else if (e.message) {
                errorMsg = e.message;
            }
            
            this.notification.add(errorMsg, { type: "danger" });
        }
    }

    cancel() {
        window.location.hash = "/";
    }
}