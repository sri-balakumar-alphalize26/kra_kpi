/** @odoo-module **/
import { Component, xml, useState, onWillStart, markup } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";

export class KpiConfiguration extends Component {
    async loadTiers() {
        try {
            const rows = await this.orm.searchRead("kpi.escalation.tier", [],
                ["name", "sequence", "minutes", "use_task_manager", "user_ids"], { order: "sequence, id" });
            if (!this.state.staff.length) {
                const staff = await this.orm.searchRead("res.users", [["share", "=", false]],
                    ["name", "kpi_wa_number", "kpi_mobile_number"], { order: "name" });
                this.state.staff = staff.map((u) => ({ id: u.id, name: u.name, number: u.kpi_wa_number || u.kpi_mobile_number || "" }));
            }
            this.state.tiers = rows.map((r) => ({ ...r, saved: false }));
        } catch (e) { this.state.tiers = []; }
    }
    userName(id) { return (this.state.staff.find((u) => u.id === id) || {}).name || "#" + id; }
    userNumber(id) { return (this.state.staff.find((u) => u.id === id) || {}).number || ""; }
    async saveTier(t, vals) {
        if ("name" in vals && !String(vals.name || "").trim()) { await this.loadTiers(); return; }
        Object.assign(t, vals);
        await this.orm.write("kpi.escalation.tier", [t.id], vals);
        t.saved = true;
        setTimeout(() => { t.saved = false; }, 1500);
    }
    async addPerson(t, ev) {
        const id = parseInt(ev.target.value, 10);
        ev.target.value = "";
        if (!id || t.user_ids.includes(id)) return;
        t.user_ids = [...t.user_ids, id];
        await this.orm.write("kpi.escalation.tier", [t.id], { user_ids: [[4, id]] });
        t.saved = true;
        setTimeout(() => { t.saved = false; }, 1500);
    }
    async removePerson(t, id) {
        t.user_ids = t.user_ids.filter((x) => x !== id);
        await this.orm.write("kpi.escalation.tier", [t.id], { user_ids: [[3, id]] });
        t.saved = true;
        setTimeout(() => { t.saved = false; }, 1500);
    }
    async moveTier(i, dir) {
        const list = [...this.state.tiers];
        const j = i + dir;
        if (j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        // Re-number every step 10, 20, 30… so the order is exactly what is shown.
        await Promise.all(list.map((t, k) => this.orm.write("kpi.escalation.tier", [t.id], { sequence: (k + 1) * 10 })));
        await this.loadTiers();
    }
    async addTier() {
        const last = this.state.tiers[this.state.tiers.length - 1];
        await this.orm.create("kpi.escalation.tier", [{ name: "New step", minutes: 5,
            sequence: (last ? last.sequence : 0) + 10 }]);
        await this.loadTiers();
    }
    deleteTier(t) {
        this.dialog.add(ConfirmationDialog, {
            title: "Delete this step?",
            body: `"${t.name}" is removed from the approval chain.`,
            confirmLabel: "Delete",
            confirm: async () => { await this.orm.unlink("kpi.escalation.tier", [t.id]); await this.loadTiers(); },
            cancel: () => {},
        });
    }

    static template = xml/* xml */`
        <div class="o_kpi_configuration p-4" style="max-width: 860px; margin: 0 auto;">
            <div class="d-flex align-items-center justify-content-between mb-1">
                <h2 class="mb-0"><i class="fa fa-cog me-2 text-secondary"></i> Configuration</h2>
                <span class="badge bg-light text-muted border">Changes save automatically</span>
            </div>
            <p class="text-muted small mb-4">Approval timers, urgent-pause recipients, and per-developer WhatsApp numbers.</p>

            <t t-if="state.loading"><div class="text-muted">Loading…</div></t>
            <t t-elif="state.error"><div class="alert alert-danger" t-esc="state.error"/></t>
            <t t-else="">

                <!-- Timers -->
                <div class="card shadow-sm mb-4 border-0" style="border-left: 4px solid #0ea5e9 !important; border-left-style: solid;">
                    <div class="card-header bg-white fw-bold d-flex align-items-center">
                        <i class="fa fa-clock-o me-2 text-info"></i> Timers
                    </div>
                    <div class="card-body">
                        <!-- "Away after (minutes)" used to lead this card. Idle
                             auto-pause is retired — a sleeping machine is not evidence
                             that someone stopped working — so there is nothing left to
                             configure for it. -->
                        <label class="form-label fw-semibold">Admin accept window (minutes)</label>
                        <div class="input-group" style="max-width:180px;">
                            <input type="number" min="0" class="form-control"
                                   t-model.number="state.admin_accept_minutes"
                                   t-on-change="() => this.saveAdminAccept()"/>
                            <span class="input-group-text">min</span>
                            <span t-if="state.savedAdminAccept" class="input-group-text text-success bg-white border-success">✓</span>
                        </div>
                        <small class="text-muted d-block mt-2">How long a new task waits for a coordinator to
                            <b>Accept</b> it before it is accepted automatically and sent to the client for
                            approval. You keep every power afterwards — re-categorise (Requirement / Update /
                            Bug) or reject it. This only stops an un-triaged task blocking its developer.
                            <b>Set 0</b> to switch auto-accept off and require a human Accept.</small>

                        <label class="form-label fw-semibold mt-4">Client approval window (minutes)</label>
                        <div class="input-group" style="max-width:180px;">
                            <input type="number" min="1" class="form-control"
                                   t-model.number="state.client_approval_minutes"
                                   t-on-change="() => this.saveClientApproval()"/>
                            <span class="input-group-text">min</span>
                            <span t-if="state.savedClientApproval" class="input-group-text text-success bg-white border-success">✓</span>
                        </div>
                        <small class="text-muted d-block mt-2">How long a client has to approve the developer
                            assigned to their task before the task is <b>released</b> for work. Drives the
                            countdown the client sees in the app. Releasing is not approving: the client can
                            still object, and nothing is billable until they sign off at completion.</small>

                        <label class="form-label fw-semibold mt-4">Queue re-nudge gap (minutes)</label>
                        <div class="input-group" style="max-width:180px;">
                            <input type="number" min="1" class="form-control"
                                   t-model.number="state.queue_nudge_minutes"
                                   t-on-change="() => this.saveQueueNudge()"/>
                            <span class="input-group-text">min</span>
                            <span t-if="state.savedQueueNudge" class="input-group-text text-success bg-white border-success">✓</span>
                        </div>
                        <small class="text-muted d-block mt-2">Gap between re-notifying admins about a client task
                            still sitting in the Client Task Queue with no developer.</small>

                        <label class="form-label fw-semibold mt-4">Urgent re-nudge gap (minutes)</label>
                        <div class="input-group" style="max-width:180px;">
                            <input type="number" min="1" class="form-control"
                                   t-model.number="state.urgent_nudge_minutes"
                                   t-on-change="() => this.saveUrgentNudge()"/>
                            <span class="input-group-text">min</span>
                            <span t-if="state.savedUrgentNudge" class="input-group-text text-success bg-white border-success">✓</span>
                        </div>
                        <small class="text-muted d-block mt-2">When a developer taps 🚨 <b>Urgent</b> in the Pause
                            dialog, the owner + coordinators are notified in the app and re-nudged this often
                            <b>until one of them reads it</b> (also stops when the task resumes).</small>
                    </div>
                </div>

                <!-- Approval chain: who decides a new client request, in order (kpi.escalation.tier).
                     Everything is edited right here: name, minutes, people, order. -->
                <div class="card shadow-sm mb-4 border-0" style="border-left: 4px solid #f59e0b !important; border-left-style: solid;">
                    <div class="card-header bg-white fw-bold d-flex align-items-center">
                        <i class="fa fa-sitemap me-2" style="color:#f59e0b;"></i> Approval Chain
                        <button class="btn btn-sm btn-outline-primary ms-auto" t-on-click="() => this.addTier()">
                            <i class="fa fa-plus me-1"/>Add step</button>
                    </div>
                    <div class="card-body">
                        <p class="text-muted small mb-3">A new client request goes to step 1. If nobody there decides
                            within its minutes, the next step is asked, and so on. After the last step it keeps waiting
                            and the last step is reminded every 30 minutes. <b>Nothing is accepted automatically.</b>
                            Each person gets a private WhatsApp link on the number shown under their name.</p>
                        <t t-if="!state.tiers.length"><div class="text-muted small">No steps — every manager is asked at once.</div></t>
                        <t t-foreach="state.tiers" t-as="tier" t-key="tier.id">
                            <div class="border rounded p-2 mb-2">
                                <div class="d-flex align-items-center gap-2 flex-wrap">
                                    <span class="badge bg-light text-dark border" t-esc="tier_index + 1"/>
                                    <input class="form-control form-control-sm fw-bold" style="max-width:180px;"
                                           t-model="tier.name" t-on-change="() => this.saveTier(tier, {name: tier.name})"/>
                                    <div class="input-group input-group-sm" style="max-width:130px;">
                                        <input type="number" min="1" class="form-control" t-model.number="tier.minutes"
                                               t-on-change="() => this.saveTier(tier, {minutes: Math.max(1, parseInt(tier.minutes, 10) || 1)})"/>
                                        <span class="input-group-text">min</span>
                                    </div>
                                    <label class="small d-flex align-items-center gap-1 mb-0" title="Also ask the task's own manager">
                                        <input type="checkbox" t-att-checked="tier.use_task_manager"
                                               t-on-change="(e) => this.saveTier(tier, {use_task_manager: e.target.checked})"/>
                                        Task's manager
                                    </label>
                                    <span t-if="tier.saved" class="text-success small">✓ saved</span>
                                    <span class="ms-auto d-flex gap-1">
                                        <button class="btn btn-sm btn-light border" title="Move up" t-att-disabled="tier_first"
                                                t-on-click="() => this.moveTier(tier_index, -1)"><i class="fa fa-arrow-up"/></button>
                                        <button class="btn btn-sm btn-light border" title="Move down" t-att-disabled="tier_last"
                                                t-on-click="() => this.moveTier(tier_index, 1)"><i class="fa fa-arrow-down"/></button>
                                        <button class="btn btn-sm btn-light border text-danger" title="Delete step"
                                                t-on-click="() => this.deleteTier(tier)"><i class="fa fa-trash"/></button>
                                    </span>
                                </div>
                                <div class="d-flex flex-wrap gap-2 mt-2 align-items-stretch">
                                    <t t-foreach="tier.user_ids" t-as="uid" t-key="uid">
                                        <div class="border rounded px-2 py-1 d-flex align-items-start gap-2" style="background:#fffbeb;">
                                            <div class="lh-sm">
                                                <div class="fw-semibold small" t-esc="userName(uid)"/>
                                                <div class="text-muted" style="font-size:11.5px;" t-esc="userNumber(uid) or 'no WhatsApp number'"/>
                                            </div>
                                            <button class="btn btn-link btn-sm p-0 text-danger" title="Remove"
                                                    t-on-click="() => this.removePerson(tier, uid)"><i class="fa fa-times"/></button>
                                        </div>
                                    </t>
                                    <div t-if="tier.use_task_manager or !tier.user_ids.length"
                                         class="border rounded px-2 py-1 lh-sm text-muted small" style="border-style:dashed !important;">
                                        the task's manager<div style="font-size:11.5px;">from the task</div>
                                    </div>
                                    <select class="form-select form-select-sm" style="max-width:220px; align-self:center;"
                                            t-on-change="(e) => this.addPerson(tier, e)">
                                        <option value="">+ Add person…</option>
                                        <t t-foreach="state.staff" t-as="u" t-key="u.id">
                                            <option t-if="!tier.user_ids.includes(u.id)" t-att-value="u.id"
                                                    t-esc="u.name + (u.number ? ' · ' + u.number : '')"/>
                                        </t>
                                    </select>
                                </div>
                            </div>
                        </t>
                    </div>
                </div>

                <!-- 369 AI Assistant: API keys (ir.config_parameter, write-only) -->
                <div class="card shadow-sm mb-4 border-0" style="border-left: 4px solid #8b5cf6 !important; border-left-style: solid;">
                    <div class="card-header bg-white fw-bold d-flex align-items-center">
                        <i class="fa fa-magic me-2" style="color:#8b5cf6;"></i> 369 AI Assistant
                        <t t-if="!state.aiError">
                            <span t-if="aiOn()" class="badge bg-success ms-2">AI on</span>
                            <span t-else="" class="badge bg-light text-muted border ms-2">AI off</span>
                        </t>
                    </div>
                    <div class="card-body">
                        <t t-if="state.aiError"><div class="text-muted small" t-esc="state.aiError"/></t>
                        <t t-else="">
                            <p class="text-muted small mb-3">With a key, the assistant on the Dashboard answers any
                                question in plain words, remembers the conversation, and adds a short summary to
                                its answers. Names and numbers always come from the live board. Without a key it
                                still answers the questions it knows, from its built-in rules. If more than one
                                key is saved they are tried in this order, and the next one takes over when one
                                fails. A saved key is never shown again.</p>
                            <t t-foreach="state.ai" t-as="p" t-key="p.provider">
                                <div class="border rounded p-3 mb-2">
                                    <div class="d-flex align-items-center flex-wrap gap-2 mb-2">
                                        <b t-esc="AI_LABEL[p.provider]"/>
                                        <span t-if="p.key_set" class="badge bg-white text-success border border-success">Key saved ✓</span>
                                        <span t-else="" class="badge bg-light text-muted border">Not set</span>
                                    </div>
                                    <div class="d-flex gap-2 flex-wrap">
                                        <input type="password" class="form-control form-control-sm" style="max-width:340px;"
                                               autocomplete="new-password" spellcheck="false"
                                               t-att-placeholder="p.key_set ? 'Paste a new key to replace it' : 'Paste the API key'"
                                               t-model="p.keyInput"
                                               t-on-keydown="(e) => e.key === 'Enter' and this.aiSaveKey(p)"/>
                                        <button class="btn btn-sm btn-primary" t-att-disabled="!p.keyInput or p.busy"
                                                t-on-click="() => this.aiSaveKey(p)">Save key</button>
                                        <button class="btn btn-sm btn-outline-secondary" t-att-disabled="!p.key_set or p.busy"
                                                t-on-click="() => this.aiTest(p)">
                                            <i t-if="p.testing" class="fa fa-circle-o-notch fa-spin me-1"/>Test</button>
                                        <button class="btn btn-sm btn-outline-danger" t-att-disabled="!p.key_set or p.busy"
                                                t-on-click="() => this.aiRemove(p)">Remove</button>
                                    </div>
                                    <div class="d-flex align-items-center gap-2 mt-2">
                                        <span class="small text-muted">Model</span>
                                        <input type="text" class="form-control form-control-sm" style="max-width:260px;"
                                               spellcheck="false" t-att-placeholder="p.default_model + ' (default)'"
                                               t-model="p.model" t-on-change="() => this.aiSaveModel(p)"/>
                                        <span t-if="p.savedModel" class="text-success small">✓</span>
                                    </div>
                                    <div t-if="p.msg" t-att-class="'small mt-2 ' + (p.msgOk ? 'text-success' : 'text-danger')" t-esc="p.msg"/>
                                </div>
                            </t>
                            <small class="text-muted d-block mt-2">Keys come from the provider's console:
                                Google AI Studio (Gemini), console.groq.com (Groq) or console.anthropic.com (Claude).
                                The module's other AI features use the same keys.</small>
                        </t>
                    </div>
                </div>

                <!-- Daily Task Report & Retention -->
                <div class="card shadow-sm mb-4 border-0" style="border-left: 4px solid #f59e0b !important; border-left-style: solid;">
                    <div class="card-header bg-white fw-bold d-flex align-items-center">
                        <i class="fa fa-file-text-o me-2 text-warning"></i> Daily Task Report &amp; Retention
                    </div>
                    <div class="card-body">
                        <div class="form-check form-switch mb-2">
                            <input type="checkbox" class="form-check-input" role="switch"
                                   t-att-checked="state.daily_report_enabled"
                                   t-on-change="() => this.toggleDailyReport()"/>
                            <label class="form-check-label fw-semibold">Send daily employee task report (PDF) to admins</label>
                            <span t-if="state.savedDailyReport" class="text-success small ms-2">✓ Saved</span>
                        </div>
                        <div class="row g-3" t-if="state.daily_report_enabled">
                            <div class="col-md-4">
                                <label class="form-label fw-semibold">Send time (IST)</label>
                                <input type="time" class="form-control" style="max-width:160px;"
                                       t-att-value="state.daily_report_time"
                                       t-on-change="(ev) => this.saveDailyReportTime(ev)"/>
                            </div>
                            <div class="col-md-5">
                                <label class="form-label fw-semibold">Report covers</label>
                                <select class="form-select" style="max-width:200px;"
                                        t-on-change="(ev) => this.saveDailyReportCoverage(ev)">
                                    <option value="yesterday" t-att-selected="state.daily_report_coverage === 'yesterday'">Previous day</option>
                                    <option value="today" t-att-selected="state.daily_report_coverage === 'today'">Same day</option>
                                </select>
                            </div>
                        </div>
                        <small class="text-muted d-block mt-2">One PDF with every employee's task details for the day,
                            delivered to admins in-app at the time above. Previous day suits a morning send (everyone has
                            ended their workday).</small>

                        <hr class="my-4"/>

                        <label class="form-label fw-semibold">Keep workday snapshot images for</label>
                        <div class="input-group" style="max-width:280px;">
                            <input type="number" min="0" class="form-control"
                                   t-model.number="state.snapshot_retention_number"
                                   t-on-change="() => this.saveSnapshotRetention()"/>
                            <select class="form-select" t-on-change="(ev) => this.saveSnapshotRetentionUnit(ev)">
                                <option value="days" t-att-selected="state.snapshot_retention_unit === 'days'">Days</option>
                                <option value="months" t-att-selected="state.snapshot_retention_unit === 'months'">Months</option>
                                <option value="years" t-att-selected="state.snapshot_retention_unit === 'years'">Years</option>
                            </select>
                            <span t-if="state.savedSnapRetention" class="input-group-text text-success bg-white border-success">✓</span>
                        </div>
                        <small class="text-muted d-block mt-2">Old End-Workday summary images are cleared automatically
                            (the day's stats are kept). <b>0 = keep forever.</b></small>

                        <label class="form-label fw-semibold mt-4">Keep generated report PDFs for</label>
                        <div class="input-group" style="max-width:280px;">
                            <input type="number" min="0" class="form-control"
                                   t-model.number="state.report_retention_number"
                                   t-on-change="() => this.saveReportRetention()"/>
                            <select class="form-select" t-on-change="(ev) => this.saveReportRetentionUnit(ev)">
                                <option value="days" t-att-selected="state.report_retention_unit === 'days'">Days</option>
                                <option value="months" t-att-selected="state.report_retention_unit === 'months'">Months</option>
                                <option value="years" t-att-selected="state.report_retention_unit === 'years'">Years</option>
                            </select>
                            <span t-if="state.savedReportRetention" class="input-group-text text-success bg-white border-success">✓</span>
                        </div>
                        <small class="text-muted d-block mt-2">Reports stay viewable and downloadable until deleted.
                            <b>0 = keep forever.</b></small>

                        <!-- Presets rather than the bare number+unit above, because
                             this is the setting people actually reach for: these are
                             the largest files the module keeps, and "30 days" is a
                             decision, not an arithmetic exercise. Custom still exposes
                             the same two fields underneath. -->
                        <label class="form-label fw-semibold mt-4">Keep downloaded KRA reports for</label>
                        <div class="input-group" style="max-width:280px;">
                            <select class="form-select" t-on-change="(ev) => this.saveDownloadPreset(ev)">
                                <option value="7" t-att-selected="downloadPreset() === '7'">7 days</option>
                                <option value="30" t-att-selected="downloadPreset() === '30'">30 days</option>
                                <option value="45" t-att-selected="downloadPreset() === '45'">45 days</option>
                                <option value="60" t-att-selected="downloadPreset() === '60'">60 days</option>
                                <option value="90" t-att-selected="downloadPreset() === '90'">90 days</option>
                                <option value="0" t-att-selected="downloadPreset() === '0'">Keep forever</option>
                                <option value="custom" t-att-selected="downloadPreset() === 'custom'">Custom…</option>
                            </select>
                            <span t-if="state.savedDownloadRetention" class="input-group-text text-success bg-white border-success">✓</span>
                        </div>
                        <t t-if="downloadPreset() === 'custom'">
                            <div class="input-group mt-2" style="max-width:280px;">
                                <input type="number" min="0" class="form-control"
                                       t-model.number="state.download_retention_number"
                                       t-on-change="() => this.saveDownloadRetention()"/>
                                <select class="form-select" t-on-change="(ev) => this.saveDownloadRetentionUnit(ev)">
                                    <option value="days" t-att-selected="state.download_retention_unit === 'days'">Days</option>
                                    <option value="months" t-att-selected="state.download_retention_unit === 'months'">Months</option>
                                    <option value="years" t-att-selected="state.download_retention_unit === 'years'">Years</option>
                                </select>
                            </div>
                        </t>
                        <small class="text-muted d-block mt-2">Copies of the ZIP/PDF/Excel packs an admin
                            downloads from the KRA Report. These are the largest files the module stores.
                            <b>Keep forever will grow without limit.</b></small>
                    </div>
                </div>

                <!-- The "Urgent-pause recipients" card (extra WhatsApp numbers) was removed:
                     those numbers had no user account, so they could only ever be reached over
                     WhatsApp — and task WhatsApp is now off by default. Urgent goes to
                     owner + coordinators in the app instead, re-nudged until read. -->

                <!-- Developers -->
                <div class="card shadow-sm mb-4 border-0" style="border-left: 4px solid #6366f1 !important; border-left-style: solid;">
                    <div class="card-header bg-white fw-bold d-flex align-items-center">
                        <i class="fa fa-users me-2 text-primary"></i> Developers — Multi-task &amp; WhatsApp
                    </div>
                    <div class="card-body">
                        <p class="text-muted small">Multi-task ON lets a developer run more than one task at once (default OFF).
                            The WhatsApp number identifies them in Urgent / auto-away messages (falls back to their partner phone).</p>
                        <table class="table table-hover align-middle mb-0">
                            <thead class="table-light">
                                <tr>
                                    <th>Developer</th>
                                    <th class="text-center" style="width:110px;">Multi-task</th>
                                    <th style="width:430px;">Country &amp; WhatsApp number</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr t-foreach="state.developers" t-as="dev" t-key="dev.id">
                                    <td>
                                        <div class="fw-semibold" t-esc="dev.name"/>
                                        <small class="text-muted" t-esc="dev.login"/>
                                    </td>
                                    <td class="text-center">
                                        <div class="form-check form-switch d-inline-block">
                                            <input type="checkbox" class="form-check-input" role="switch"
                                                   t-att-checked="dev.allow_multitask" t-on-change="() => this.toggleDev(dev)"/>
                                        </div>
                                    </td>
                                    <td>
                                        <select class="form-select form-select-sm mb-1" style="max-width:260px;"
                                                title="Country code for this developer"
                                                t-on-change="(ev) => this.saveDevCountry(dev, ev)">
                                            <option value="" t-att-selected="!dev.country_id">Default (+<t t-esc="state.dial"/>)</option>
                                            <t t-foreach="state.countries" t-as="co" t-key="co.id">
                                                <option t-att-value="co.id" t-att-selected="co.id === dev.country_id" t-esc="co.name + ' (+' + co.phone_code + ')'"/>
                                            </t>
                                        </select>
                                        <div class="input-group input-group-sm" style="max-width:260px;">
                                            <span class="input-group-text">+<t t-esc="dev.dial || state.dial"/></span>
                                            <input type="tel" inputmode="numeric" class="form-control"
                                                   t-att-placeholder="(dev.mobile_length || state.mobileLength) + ' digits'"
                                                   t-att-maxlength="dev.mobile_length || state.mobileLength"
                                                   t-att-value="this.localPart(dev)"
                                                   t-on-input="(ev) => this.onDevWaInput(dev, ev)"
                                                   t-on-change="(ev) => this.saveDevWa(dev, ev)"/>
                                            <span t-if="dev._saved" class="input-group-text text-success bg-white border-success">✓</span>
                                        </div>
                                        <small t-if="dev._savedCountry" class="text-success">✓ Country saved</small>
                                        <small t-if="dev._invalid" class="text-danger">Enter <t t-esc="dev.mobile_length || state.mobileLength"/> digits</small>
                                    </td>
                                </tr>
                                <tr t-if="!state.developers.length"><td colspan="3" class="text-muted">No developers found.</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- WhatsApp group reporting. Sits here because this screen already
                     owns the res.company settings, and because the developer numbers
                     the mentions depend on are edited in the table just above. -->
                <div class="card p-3 mb-3">
                    <h5 class="mb-1"><i class="fa fa-whatsapp me-2 text-success"></i> WhatsApp Group Reports</h5>
                    <p class="text-muted small mb-3">
                        Updates are posted to one group, with the developer @-mentioned. Choose which
                        updates get posted and word each one yourself, below. Leave the group unset
                        to post nothing at all.
                    </p>

                    <div t-if="state.waGroupJid" class="alert alert-success py-2 d-flex align-items-center gap-2">
                        <i class="fa fa-check-circle"></i>
                        <div class="flex-grow-1">
                            Reporting to <b t-esc="state.waGroupName || state.waGroupJid"/>
                            <div class="small text-muted" t-esc="state.waGroupJid"/>
                        </div>
                        <button class="btn btn-sm btn-outline-success" t-on-click="waTest">Send test</button>
                        <button class="btn btn-sm btn-outline-danger" t-on-click="waClear">Turn off</button>
                    </div>
                    <div t-else="" class="alert alert-secondary py-2">
                        <i class="fa fa-info-circle me-1"></i> No group set — nothing is posted.
                    </div>

                    <div t-if="state.waMsg" t-att-class="'alert py-2 small alert-' + state.waMsgKind" t-esc="state.waMsg"/>

                    <!-- The procedure that actually works on this gateway, stated as
                         steps rather than buried in a hint. Group LOOKUP is broken here
                         — GetJoinedGroups crashes the Go binary, GetGroupInfoFromLink
                         and join-by-link fail the same way — but incoming group messages
                         are captured, so the id arrives on its own. -->
                    <div class="alert alert-info py-2 small mb-3">
                        <div class="fw-bold mb-1">To connect a group:</div>
                        <div>1. Make sure this WhatsApp number is a member of the group</div>
                        <div>2. Find it in the list below and press <b>Use this</b></div>
                        <div class="text-muted mt-1">
                            If the phone is offline the list falls back to groups we have already
                            seen a message from — post any message in the group, then Refresh.
                        </div>
                    </div>

                    <div class="row g-3">
                            <div class="col-md-8">
                                <label class="form-label fw-bold small">Groups we have seen a message from</label>
                                <!-- WhatsApp does not hand us a group's name on this gateway, so a
                                     captured row is an opaque id until a human labels it. Showing
                                     who last posted and when is what makes an unlabelled row
                                     recognisable. This matters: a bare id presented as though it
                                     were a name is how a client group once got picked as the
                                     reporting destination and posted to. -->
                                <div class="alert alert-warning py-2 small">
                                    <i class="fa fa-exclamation-triangle me-1"></i>
                                    Odoo cannot tell which group an id belongs to. Name a group before
                                    selecting it — everything posted there is visible to everyone in it.
                                </div>
                                <div t-if="!state.waGroups.length" class="form-text mb-2">
                                    No groups yet. If the phone is offline, post any message in the
                                    group you want and press Refresh.
                                </div>
                                <!-- This number is in dozens of groups, so the list is only
                                     usable with a filter. -->
                                <input t-if="state.waGroups.length > 8" type="search"
                                       class="form-control form-control-sm mb-2"
                                       placeholder="Filter groups by name…" t-model="state.waFilter"/>
                                <div style="max-height: 22rem; overflow-y: auto;">
                                <div t-foreach="waVisibleGroups" t-as="g" t-key="g.jid" class="border rounded p-2 mb-2">
                                    <div class="d-flex gap-2 align-items-center">
                                        <input type="text" class="form-control form-control-sm"
                                               t-att-value="g.name"
                                               placeholder="Unnamed — name it before using it"
                                               t-on-change="(ev) => this.waRename(g.jid, ev.target.value)"/>
                                        <!-- Unnamed groups cannot be selected. The guard is the
                                             point: naming forces a moment of "which group is
                                             this?" before anything can be posted to it. -->
                                        <button class="btn btn-sm btn-primary text-nowrap"
                                                t-att-disabled="!g.named"
                                                t-on-click="() => this.waSelect(g.jid)">Use this</button>
                                    </div>
                                    <div class="small text-muted mt-1">
                                        <t t-if="g.members"><b t-esc="g.members"/> members · </t>
                                        <span t-esc="g.jid"/>
                                        <t t-if="g.last_sender"> · last posted by <b t-esc="g.last_sender"/></t>
                                        <t t-if="g.last_seen"> · <t t-esc="g.last_seen"/> UTC</t>
                                    </div>
                                </div>
                                </div>
                                <button class="btn btn-sm btn-outline-secondary"
                                        t-att-disabled="state.waBusy" t-on-click="waRefresh">Refresh</button>
                                <div class="form-text">
                                    A group appears here as soon as anyone posts in it, once this
                                    WhatsApp number is a member.
                                </div>
                            </div>

                            <!-- Which updates get posted, and in what words. One block per
                                 event: switch, live preview, editable wording, insert
                                 buttons, reset and its own test send. Modelled on the
                                 reset-message editor in Login Management, which reads as
                                 plain writing rather than as a template language. -->
                            <div class="col-12 mt-2">
                                <label class="form-label fw-bold small">What gets posted</label>
                                <div t-foreach="state.waEvents" t-as="ev" t-key="ev.event"
                                     class="border rounded p-2 mb-2">
                                    <div class="form-check form-switch d-flex align-items-center gap-2 mb-0">
                                        <input type="checkbox" class="form-check-input" role="switch"
                                               t-att-checked="ev.enabled"
                                               t-on-change="() => this.waToggleEvent(ev)"/>
                                        <label class="form-check-label fw-semibold mb-0" t-esc="ev.label"/>
                                        <span class="text-muted small" t-esc="ev.help"/>
                                        <span t-if="ev._saved" class="text-success small">✓ Saved</span>
                                    </div>

                                    <!-- Hidden while off: a live preview of something that will
                                         never be sent is just noise. -->
                                    <div t-if="ev.enabled" class="mt-2 ps-4">
                                        <small class="text-muted d-block mb-1">
                                            <i class="fa fa-whatsapp me-1 text-success"/>Preview — what the group sees:
                                        </small>
                                        <div style="background:#dcf8c6; border-radius:12px; padding:10px 12px; max-width:440px; white-space:pre-wrap; font-size:14px; line-height:1.5; box-shadow:0 1px 2px rgba(0,0,0,0.12); color:#111;"
                                             t-out="ev._preview"/>

                                        <div class="d-flex flex-wrap gap-1 mt-2">
                                            <span class="text-muted small me-1">Insert:</span>
                                            <t t-foreach="ev.tokens" t-as="tok" t-key="tok">
                                                <button class="btn btn-sm btn-outline-secondary py-0 px-2"
                                                        style="font-size:11px;"
                                                        t-on-click="() => this.waInsertToken(ev, tok)"
                                                        t-esc="tok"/>
                                            </t>
                                        </div>

                                        <textarea class="form-control mt-2" rows="4" style="font-family: inherit;"
                                                  t-att-id="'watmpl-' + ev.event"
                                                  t-att-value="ev.template"
                                                  t-on-input="(e) => this.waTemplateInput(ev, e)"
                                                  t-on-change="(e) => this.waSaveTemplate(ev, e)"/>
                                        <div class="d-flex gap-2 mt-1">
                                            <button class="btn btn-sm btn-outline-secondary"
                                                    t-on-click="() => this.waResetTemplate(ev)">
                                                <i class="fa fa-undo me-1"/>Reset to default</button>
                                            <button class="btn btn-sm btn-outline-success"
                                                    t-att-disabled="!state.waGroupJid"
                                                    t-on-click="() => this.waTestEvent(ev)">Send test</button>
                                        </div>
                                        <small class="text-muted d-block mt-1">
                                            Write it in plain English. The name, times and task details are
                                            filled in automatically — the preview above shows exactly what
                                            the group gets.
                                        </small>
                                    </div>
                                </div>
                            </div>
                    <details class="mt-3">
                        <summary class="small text-muted" style="cursor:pointer;">
                            Advanced — invite link or a pasted id (both unavailable on this gateway)
                        </summary>
                        <div class="mt-2">
                    <!-- Two ways in, because group LOOKUP is broken in the installed
                         neonize build: GetJoinedGroups crashes the Go binary and
                         GetGroupInfoFromLink cannot parse its own reply. Joining by
                         link uses neither — it returns the JID directly — and it also
                         puts the number in the group, which is required to post there
                         at all. SENDING was never affected. -->
                    <label class="form-label fw-bold small">Invite link</label>
                    <div class="d-flex gap-2 mb-1" style="max-width:520px;">
                        <input type="text" class="form-control form-control-sm"
                               placeholder="https://chat.whatsapp.com/…"
                               t-model="state.waLink"/>
                        <button class="btn btn-sm btn-success text-nowrap"
                                t-att-disabled="!state.waLink or state.waBusy"
                                t-on-click="waJoin">Join and use</button>
                    </div>
                    <div class="form-text mb-3">
                        Joins the group with this WhatsApp number and saves the group id in
                        one step — members will see the number join. Copy the link
                        <b>in full</b>; a truncated code is rejected as bad-request.
                    </div>

                    <label class="form-label fw-bold small">…or paste the group id, if you have it</label>
                    <div class="d-flex gap-2" style="max-width:520px;">
                        <input type="text" class="form-control form-control-sm"
                               placeholder="120363041234567890@g.us"
                               t-model="state.waJid"/>
                        <button class="btn btn-sm btn-primary text-nowrap"
                                t-att-disabled="!state.waJid" t-on-click="waUseJid">Use</button>
                    </div>
                    <div class="form-text mb-3">
                        Open the group in WhatsApp Web — the id is the
                        <code>120363…@g.us</code> part of the address bar. Then use
                        <b>Send test</b> to confirm it works.
                    </div>                        </div>
                    </details>

                    </div>
                </div>
            </t>
        </div>`;

    setup() {
        this.dialog = useService("dialog");
        this.orm = useService("orm");
        this.action = useService("action");
        this.state = useState({
            // Workflow gate timers (same res.company fields the mobile app edits).
            // Nothing about these windows is hard-coded anywhere — the crons read
            // res.company on every tick, so a change here takes effect within a
            // minute with no restart or upgrade.
            admin_accept_minutes: 5,
            client_approval_minutes: 5,
            queue_nudge_minutes: 30,
            urgent_nudge_minutes: 5,
            developers: [],
            // WhatsApp group reporting
            waGroupJid: "", waGroupName: "",
            waGroups: [], waFilter: "", waEvents: [], waSamples: {},
            waPick: "", waLink: "", waPeek: null, waJid: "",
            waBusy: false, waMsg: "", waMsgKind: "info",
            loading: true,
            error: "",
            savedAdminAccept: false,
            savedClientApproval: false,
            savedQueueNudge: false,
            savedUrgentNudge: false,
            // Country / mobile format
            country_id: false,
            dial: "91",
            mobileLength: 10,
            countries: [],
            savedCountry: false,
            // Daily task report schedule + snapshot/report retention.
            daily_report_enabled: true,
            daily_report_time: "10:00",
            daily_report_coverage: "yesterday",
            savedDailyReport: false,
            snapshot_retention_number: 3,
            snapshot_retention_unit: "months",
            savedSnapRetention: false,
            report_retention_number: 3,
            report_retention_unit: "months",
            savedReportRetention: false,
            download_retention_number: 30,
            download_retention_unit: "days",
            savedDownloadRetention: false,
            // 369 AI Assistant keys: [{provider, key_set, model, default_model,
            // keyInput, busy, testing, msg, msgOk, savedModel}] in cascade order.
            ai: [],
            aiError: "",
            // Approval chain rows: [{id, name, minutes, use_task_manager, people: [names], saved}]
            tiers: [],
            staff: [],   // internal users for "+ Add person": [{id, name, number}]
        });
        this.AI_LABEL = { gemini: "Google Gemini", groq: "Groq (Llama)", anthropic: "Anthropic Claude" };
        onWillStart(async () => {
            await this.loadTiers();
            // Admins only; anyone else sees a note instead of the card's fields.
            try { this._aiFill(await rpc("/kpi_config/ai_get", {})); }
            catch (e) { this.state.aiError = "Could not load the AI settings."; }
            try {
                const cfg = await rpc("/kpi_config/get", {});
                if (cfg?.status) {
                    if (cfg.admin_accept_minutes != null) this.state.admin_accept_minutes = cfg.admin_accept_minutes;
                    if (cfg.client_approval_minutes != null) this.state.client_approval_minutes = cfg.client_approval_minutes;
                    if (cfg.queue_nudge_minutes != null) this.state.queue_nudge_minutes = cfg.queue_nudge_minutes;
                    if (cfg.urgent_nudge_minutes != null) this.state.urgent_nudge_minutes = cfg.urgent_nudge_minutes;
                    this.state.country_id = cfg.country_id || false;
                    this.state.dial = String(cfg.country_dial_code || "91");
                    this.state.mobileLength = Number(cfg.mobile_length) || 10;
                    this.state.countries = cfg.countries || [];
                    // Read from /kpi_config/get, not the group route: the current
                    // destination must be visible with the gateway offline.
                    this.state.waGroupJid = cfg.wa_group_jid || "";
                    this.state.waGroupName = cfg.wa_group_name || "";
                    // Daily report + retention.
                    if (cfg.daily_report_enabled != null) this.state.daily_report_enabled = !!cfg.daily_report_enabled;
                    if (cfg.daily_report_hour != null) this.state.daily_report_time = this.hourToTime(cfg.daily_report_hour);
                    if (cfg.daily_report_coverage) this.state.daily_report_coverage = cfg.daily_report_coverage;                    if (cfg.snapshot_retention_number != null) this.state.snapshot_retention_number = cfg.snapshot_retention_number;
                    if (cfg.snapshot_retention_unit) this.state.snapshot_retention_unit = cfg.snapshot_retention_unit;
                    if (cfg.report_retention_number != null) this.state.report_retention_number = cfg.report_retention_number;
                    if (cfg.report_retention_unit) this.state.report_retention_unit = cfg.report_retention_unit;
                    if (cfg.download_retention_number != null) this.state.download_retention_number = cfg.download_retention_number;
                    if (cfg.download_retention_unit) this.state.download_retention_unit = cfg.download_retention_unit;
                }
                const devs = await rpc("/kpi_multitask/list", {});
                if (devs?.status) this.state.developers = devs.developers;
                // Fill the group list on open. Deliberately silent: a group being
                // unreadable (gateway offline) is a normal state this screen has to
                // survive, and the current destination above already came from
                // /kpi_config/get. Without this the dropdown sits empty until
                // someone thinks to press Refresh — which reads as "we know of no
                // groups" at exactly the moment we do know of one.
                try {
                    const g = await rpc("/kpi_wa_group/list", {});
                    if (g?.status) this.state.waGroups = g.groups || [];
                } catch (e) { /* offline is fine — Refresh is still there */ }
                // Which updates get posted, and their wording. Needs no gateway
                // at all — it is pure configuration, so it must load even with
                // the phone offline.
                try { await this.waLoadEvents(); }
                catch (e) { /* leaves the list empty rather than breaking the screen */ }
            } catch (e) { this.state.error = e?.data?.message || e?.message || "Failed to load configuration."; }
            finally { this.state.loading = false; }
        });
    }

    // Show only the local part (strip a leading dial code) of a developer's
    // stored number, using THAT developer's own dial/length.
    localPart(dev) {
        const len = dev.mobile_length || this.state.mobileLength;
        const dial = dev.dial || this.state.dial;
        let v = String(dev.wa_number || "").replace(/[^\d]/g, "");
        if (dial && v.length > len && v.startsWith(dial)) {
            v = v.slice(dial.length);
        }
        return v.slice(0, len);
    }

    // Digit-only + hard-cap to the developer's country length while typing.
    onDevWaInput(dev, ev) {
        const len = dev.mobile_length || this.state.mobileLength;
        const v = (ev.target.value || "").replace(/[^\d]/g, "").slice(0, len);
        if (ev.target.value !== v) ev.target.value = v;
    }

    // NOTE: toLocalList / urgentPlaceholder / onUrgentInput were removed along
    // with the "Urgent-pause recipients" field — they only existed to format
    // those bare WhatsApp numbers, which are no longer used anywhere.

    async saveCountry(ev) {
        const cid = ev?.target?.value ? parseInt(ev.target.value) : false;
        this.state.country_id = cid;
        try {
            const res = await rpc("/kpi_config/set_country", { country_id: cid });
            if (res?.status) {
                this.state.dial = String(res.dial || "91");
                this.state.mobileLength = Number(res.mobile_length) || 10;
                this._flash(this.state, "savedCountry");
            } else alert(res?.message || "Not authorized.");
        } catch (e) { alert(e?.data?.message || "Failed to save."); }
    }

    _flash(obj, key) {
        obj[key] = true;
        setTimeout(() => { try { obj[key] = false; } catch (e) { /* unmounted */ } }, 1500);
    }

    // ---- 369 AI Assistant keys. A key is write-only: the server only ever
    // says whether one is saved, so the input is cleared after saving.
    _aiFill(res) {
        if (!res?.status) { this.state.aiError = res?.message === "Not authorized" ? "Only admins can change the AI keys." : (res?.message || "Could not load the AI settings."); return; }
        const old = Object.fromEntries(this.state.ai.map((p) => [p.provider, p]));
        this.state.aiError = "";
        this.state.ai = (res.providers || []).map((p) => ({
            keyInput: "", busy: false, testing: false, msg: "", msgOk: false, savedModel: false,
            ...(old[p.provider] || {}), ...p,
        }));
    }
    aiOn() { return this.state.ai.some((p) => p.key_set); }
    async _aiSet(p, args, okMsg) {
        p.busy = true; p.msg = "";
        try {
            const res = await rpc("/kpi_config/set_ai", { provider: p.provider, ...args });
            if (!res?.status) { p.msg = res?.message || "Not authorized."; p.msgOk = false; return false; }
            this._aiFill(res);
            const fresh = this.state.ai.find((x) => x.provider === p.provider);
            if (fresh && okMsg) { fresh.msg = okMsg; fresh.msgOk = true; }
            return true;
        } catch (e) { p.msg = e?.data?.message || "Failed to save."; p.msgOk = false; return false; }
        finally { const fresh = this.state.ai.find((x) => x.provider === p.provider); if (fresh) fresh.busy = false; }
    }
    async aiSaveKey(p) {
        const key = (p.keyInput || "").trim();
        if (!key || p.busy) return;
        if (await this._aiSet(p, { key }, "Key saved. Press Test to check it works.")) {
            const fresh = this.state.ai.find((x) => x.provider === p.provider);
            if (fresh) fresh.keyInput = "";
        }
    }
    async aiSaveModel(p) {
        if (await this._aiSet(p, { model: (p.model || "").trim() }, "")) {
            const fresh = this.state.ai.find((x) => x.provider === p.provider);
            if (fresh) this._flash(fresh, "savedModel");
        }
    }
    aiRemove(p) {
        this.dialog.add(ConfirmationDialog, {
            title: "Remove the key?",
            body: `Remove the ${this.AI_LABEL[p.provider]} key? The assistant then uses the other saved keys, or its built-in rules if none is left.`,
            confirmLabel: "Remove",
            confirm: () => this._aiSet(p, { key: "" }, "Key removed."),
            cancel: () => {},
        });
    }
    async aiTest(p) {
        p.busy = true; p.testing = true; p.msg = "";
        try {
            const res = await rpc("/kpi_config/test_ai", { provider: p.provider });
            p.msgOk = !!res?.status;
            p.msg = res?.status ? `Works: the AI answered in ${((res.ms || 0) / 1000).toFixed(1)} s.` : (res?.message || "The test failed.");
        } catch (e) { p.msgOk = false; p.msg = e?.data?.message || "The test failed."; }
        finally { p.busy = false; p.testing = false; }
    }


    // Drives admin_accept_deadline_at (kpi_workflow.py _admin_accept_minutes) —
    // how long a task waits for a human Accept before the cron does it.
    // Clamped at 0, not 1: 0 is the documented switch that turns auto-accept off
    // entirely, so it must stay reachable from this screen.
    async saveAdminAccept() {
        const parsed = parseInt(this.state.admin_accept_minutes);
        const val = Math.max(0, isNaN(parsed) ? 5 : parsed);
        this.state.admin_accept_minutes = val;
        try { await rpc("/kpi_config/set_admin_accept", { minutes: val }); this._flash(this.state, "savedAdminAccept"); }
        catch (e) { alert(e?.data?.message || "Failed to save."); }
    }

    // Drives pre_approval_release_at (kpi_workflow.py _client_approval_minutes) —
    // i.e. the live countdown the client sees on their approval card in the app,
    // and the point at which the task is released for work.
    async saveClientApproval() {
        const val = Math.max(1, parseInt(this.state.client_approval_minutes) || 5);
        this.state.client_approval_minutes = val;
        try { await rpc("/kpi_config/set_client_approval", { minutes: val }); this._flash(this.state, "savedClientApproval"); }
        catch (e) { alert(e?.data?.message || "Failed to save."); }
    }

    async saveQueueNudge() {
        const val = Math.max(1, parseInt(this.state.queue_nudge_minutes) || 30);
        this.state.queue_nudge_minutes = val;
        try { await rpc("/kpi_config/set_queue_nudge", { minutes: val }); this._flash(this.state, "savedQueueNudge"); }
        catch (e) { alert(e?.data?.message || "Failed to save."); }
    }

    async saveUrgentNudge() {
        const val = Math.max(1, parseInt(this.state.urgent_nudge_minutes) || 5);
        this.state.urgent_nudge_minutes = val;
        try { await rpc("/kpi_config/set_urgent_nudge", { minutes: val }); this._flash(this.state, "savedUrgentNudge"); }
        catch (e) { alert(e?.data?.message || "Failed to save."); }
    }

    async toggleDev(dev) {
        const next = !dev.allow_multitask;
        try {
            const res = await rpc("/kpi_multitask/set", { user_id: dev.id, allow: next });
            if (res.status) dev.allow_multitask = next; else alert(res.message || "Not authorized.");
        } catch (e) { alert(e?.data?.message || "Failed to save."); }
    }

    async saveDevWa(dev, ev) {
        // Keep only digits, capped to the DEVELOPER's country length; strip a
        // pasted dial code.
        const len = dev.mobile_length || this.state.mobileLength;
        const dial = dev.dial || this.state.dial;
        let val = (ev?.target?.value || "").replace(/[^\d]/g, "");
        if (dial && val.length > len && val.startsWith(dial)) {
            val = val.slice(dial.length);
        }
        val = val.slice(0, len);
        if (ev?.target) ev.target.value = val;

        // Flag (but don't block) an incomplete number.
        dev._invalid = val.length > 0 && val.length !== len;

        try {
            const res = await rpc("/kpi_multitask/set_wa", { user_id: dev.id, wa_number: val });
            if (res.status) { dev.wa_number = res.wa_number || val; this._flash(dev, "_saved"); }
            else alert(res.message || "Not authorized.");
        } catch (e) { alert(e?.data?.message || "Failed to save."); }
    }

    // "Ravi's WhatsApp number and app-login mobile were cleared because the
    // country code changed." Both numbers hang off the one per-person country,
    // and BOTH screens call the same route, so the server says which ones it
    // actually wiped — changing it here also clears their app-login mobile.
    _clearedMsg(name, res) {
        const what = { whatsapp: "WhatsApp number", mobile: "app-login mobile" };
        const list = (res.cleared || []).map((k) => what[k] || k).join(" and ");
        const verb = (res.cleared || []).length > 1 ? "were" : "was";
        return `${name}'s ${list} ${verb} cleared because the country code changed.\n\n`
             + `Please enter the new ${res.mobile_length}-digit number (+${res.dial}).`;
    }

    // Set this developer's country code (Oman +968 / India +91 / …). Shares the
    // per-person route with Login Management. The server clears both stored
    // numbers — digits issued under the old dial code don't belong to the new
    // country — so empty the box and say so. Empty = the company default.
    async saveDevCountry(dev, ev) {
        const cid = ev?.target?.value ? parseInt(ev.target.value) : false;
        try {
            const res = await rpc("/kpi_user_access/set_country", { user_id: dev.id, country_id: cid });
            if (res?.status) {
                dev.country_id = res.country_id || false;
                dev.dial = res.dial || this.state.dial;
                dev.mobile_length = res.mobile_length || this.state.mobileLength;
                dev.wa_number = "";
                // The input binds with t-att-value, which sets the ATTRIBUTE —
                // once it has been typed in, its value property is dirty and no
                // longer follows that attribute, so state alone leaves the old
                // digits on screen. ev.target is the <select>, not the box, so
                // reach across to the one input in this cell.
                const box = ev.target?.closest("td")?.querySelector("input");
                if (box) box.value = "";
                dev._invalid = false;     // don't flag the now-empty box
                this._flash(dev, "_savedCountry");
                if ((res.cleared || []).length) alert(this._clearedMsg(dev.name, res));
            } else { alert(res?.message || "Not authorized."); if (ev?.target) ev.target.value = dev.country_id || ""; }
        } catch (e) { alert(e?.data?.message || "Failed to save."); if (ev?.target) ev.target.value = dev.country_id || ""; }
    }

    // ---- Daily report schedule ------------------------------------------
    // Stored server-side as a float hour (10.5 = 10:30); the picker is HH:MM.
    hourToTime(h) {
        const f = Number(h) || 0;
        const H = Math.floor(f);
        const M = Math.round((f - H) * 60);
        const pad = (n) => String(n).padStart(2, "0");
        return `${pad(H)}:${pad(M % 60)}`;
    }
    timeToHour(t) {
        const [H, M] = String(t || "10:00").split(":").map((x) => parseInt(x) || 0);
        return H + M / 60;
    }

    async saveDailyReport() {
        try {
            await rpc("/kpi_config/set_daily_report", {
                enabled: this.state.daily_report_enabled,
                hour: this.timeToHour(this.state.daily_report_time),
                coverage: this.state.daily_report_coverage,
            });
            this._flash(this.state, "savedDailyReport");
        } catch (e) { alert(e?.data?.message || "Failed to save."); }
    }
    toggleDailyReport() {
        this.state.daily_report_enabled = !this.state.daily_report_enabled;
        this.saveDailyReport();
    }
    saveDailyReportTime(ev) {
        this.state.daily_report_time = ev.target.value || "10:00";
        this.saveDailyReport();
    }
    saveDailyReportCoverage(ev) {
        this.state.daily_report_coverage = ev.target.value || "yesterday";
        this.saveDailyReport();
    }

    // ---- Retention (number + Days/Months/Years unit) --------------------
    async saveSnapshotRetention() {
        const number = Math.max(0, parseInt(this.state.snapshot_retention_number) || 0);
        this.state.snapshot_retention_number = number;
        try {
            await rpc("/kpi_config/set_snapshot_retention", { number, unit: this.state.snapshot_retention_unit });
            this._flash(this.state, "savedSnapRetention");
        } catch (e) { alert(e?.data?.message || "Failed to save."); }
    }
    saveSnapshotRetentionUnit(ev) {
        this.state.snapshot_retention_unit = ev.target.value || "months";
        this.saveSnapshotRetention();
    }
    async saveReportRetention() {
        const number = Math.max(0, parseInt(this.state.report_retention_number) || 0);
        this.state.report_retention_number = number;
        try {
            await rpc("/kpi_config/set_report_retention", { number, unit: this.state.report_retention_unit });
            this._flash(this.state, "savedReportRetention");
        } catch (e) { alert(e?.data?.message || "Failed to save."); }
    }
    saveReportRetentionUnit(ev) {
        this.state.report_retention_unit = ev.target.value || "months";
        this.saveReportRetention();
    }

    /**
     * Which entry the preset dropdown should show for the stored pair.
     *
     * Anything that is not one of the presets — including a value set before this
     * dropdown existed, or by the older number+unit convention — comes back as
     * Custom with its real value visible, rather than being silently rounded to
     * the nearest preset.
     */
    downloadPreset() {
        const n = parseInt(this.state.download_retention_number) || 0;
        const u = this.state.download_retention_unit || "days";
        if (n === 0) return "0";
        if (u === "days" && [7, 30, 45, 60, 90].includes(n)) return String(n);
        return "custom";
    }

    saveDownloadPreset(ev) {
        const v = ev.target.value;
        if (v === "custom") {
            // Seed the custom boxes with something sane rather than 0, which the
            // dropdown would immediately read back as "Keep forever" and the
            // Custom fields would vanish again.
            if (this.downloadPreset() !== "custom") {
                this.state.download_retention_number = 30;
                this.state.download_retention_unit = "months";
                this.saveDownloadRetention();
            }
            return;
        }
        this.state.download_retention_number = parseInt(v) || 0;
        this.state.download_retention_unit = "days";
        this.saveDownloadRetention();
    }

    async saveDownloadRetention() {
        const number = Math.max(0, parseInt(this.state.download_retention_number) || 0);
        this.state.download_retention_number = number;
        try {
            await rpc("/kpi_config/set_download_retention",
                      { number, unit: this.state.download_retention_unit });
            this._flash(this.state, "savedDownloadRetention");
        } catch (e) { alert(e?.data?.message || "Failed to save."); }
    }
    saveDownloadRetentionUnit(ev) {
        this.state.download_retention_unit = ev.target.value || "days";
        this.saveDownloadRetention();
    }

    _waSay(msg, kind = "info") {
        this.state.waMsg = msg;
        this.state.waMsgKind = kind;
    }

    async waRefresh() {
        this.state.waBusy = true;
        this._waSay("");
        try {
            const r = await rpc("/kpi_wa_group/list", {});
            if (!r || !r.status) {
                // Almost always "gateway not connected", which is a real answer and
                // not an error in this screen — say it plainly rather than as a failure.
                this.state.waGroups = [];
                this._waSay((r && r.message) || "Could not read groups.", "warning");
                return;
            }
            this.state.waGroups = r.groups || [];
            if (!this.state.waGroups.length) {
                // Invite links are dead on this gateway, so pointing at them was
                // sending people down a path that cannot work. Capture is the way.
                this._waSay("No groups captured yet. Post any message in the group you want, then press Refresh.", "info");
            }
        } finally {
            this.state.waBusy = false;
        }
    }

    async waUseJid() {
        const jid = (this.state.waJid || "").trim();
        const r = await rpc("/kpi_wa_group/select", { jid, name: "" });
        if (!r || !r.status) { this._waSay((r && r.message) || "Could not save.", "danger"); return; }
        this.state.waGroupJid = r.jid || "";
        this.state.waGroupName = "";
        this.state.waJid = "";
        this._waSay("Saved. Use Send test to confirm the group accepts it.", "success");
    }

    /** Promise<boolean> from Odoo's own confirm dialog.
     *
     * Not window.confirm: this dialog names the destination group, and a native
     * prompt renders the id as an unreadable run-on. `browser` (from
     * @web/core/browser/browser) has no confirm() — that was a real bug here.
     * Dismissing without choosing resolves false, so an ignored dialog can never
     * be read as consent to post.
     */
    _waConfirm(title, body) {
        return new Promise((resolve) => {
            this.dialog.add(ConfirmationDialog, {
                title, body,
                confirm: () => resolve(true),
                cancel: () => resolve(false),
            }, { onClose: () => resolve(false) });
        });
    }

    /** Fill the sample values and render WhatsApp *bold*, so the preview is what
     *  the group actually receives rather than the raw wording. Escape first,
     *  then add the <b> — the other order would let typed HTML through.
     *  Same approach as renderPreview() on the Login Management screen. */
    waRenderPreview(tpl) {
        const samples = this.state.waSamples || {};
        // Line by line, mirroring the server's rule: a line whose tokens ALL
        // resolved to empty is dropped, decoration and all. If this diverged the
        // preview would be lying about the one thing it exists to show.
        const lines = [];
        for (const line of String(tpl || "").split("\n")) {
            let filled = line;
            const resolved = [];
            for (const [k, v] of Object.entries(samples)) {
                const tok = `{${k}}`;
                if (filled.includes(tok)) {
                    const val = v == null ? "" : String(v);
                    resolved.push(val.trim());
                    filled = filled.split(tok).join(val);
                }
            }
            if (resolved.length && !resolved.some(Boolean)) continue;
            lines.push(filled);
        }
        let s = lines.join("\n").trim();
        s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        s = s.replace(/\*([^*\n]+)\*/g, "<b>$1</b>");   // WhatsApp bold → <b>
        return markup(s);
    }

    async waLoadEvents() {
        const r = await rpc("/kpi_wa_group/events", {});
        if (!r || !r.status) return;
        this.state.waSamples = r.samples || {};
        this.state.waEvents = (r.events || []).map((e) => ({
            ...e, _preview: this.waRenderPreview(e.template), _saved: false,
        }));
    }

    async _waSaveEvent(ev, vals) {
        const r = await rpc("/kpi_wa_group/set_event", { event: ev.event, ...vals });
        if (!r || !r.status) { this._waSay((r && r.message) || "Could not save.", "danger"); return false; }
        ev.enabled = r.enabled;
        ev.template = r.template;
        ev._preview = this.waRenderPreview(r.template);
        this._flash(ev, "_saved");
        return true;
    }

    waToggleEvent(ev) {
        return this._waSaveEvent(ev, { enabled: !ev.enabled });
    }

    waTemplateInput(ev, e) {
        // Preview only — saving happens on blur, exactly like the OTP editor.
        ev._preview = this.waRenderPreview(e.target.value || "");
    }

    waSaveTemplate(ev, e) {
        return this._waSaveEvent(ev, { template: e.target.value || "" });
    }

    /** Empty string means "use the built-in default" on the server, so Reset
     *  never has to know what the default text is. */
    waResetTemplate(ev) {
        return this._waSaveEvent(ev, { template: "" });
    }

    waInsertToken(ev, tok) {
        const el = document.getElementById(`watmpl-${ev.event}`);
        const tag = `{${tok}}`;
        if (!el) { return this._waSaveEvent(ev, { template: (ev.template || "") + tag }); }
        // Drop it where the cursor is, not at the end — otherwise inserting into
        // the middle of a sentence means retyping it.
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        el.value = el.value.slice(0, start) + tag + el.value.slice(end);
        el.focus();
        el.selectionStart = el.selectionEnd = start + tag.length;
        ev._preview = this.waRenderPreview(el.value);
        return this._waSaveEvent(ev, { template: el.value });
    }

    async waTestEvent(ev) {
        const jid = this.state.waGroupJid;
        if (!jid) { this._waSay("No group selected yet.", "warning"); return; }
        const label = this.state.waGroupName || jid;
        const ok = await this._waConfirm(
            `Send a test "${ev.label}" message?`,
            `"${label}"\n${jid}\n\nEveryone in that group will see it. ` +
            `It is marked as a test, and no real activity is implied.`);
        if (!ok) return;
        const r = await rpc("/kpi_wa_group/test_event", { event: ev.event, confirm_jid: jid });
        this._waSay((r && r.message) || "No response.", r && r.status ? "success" : "warning");
    }

    get waVisibleGroups() {
        const q = (this.state.waFilter || "").trim().toLowerCase();
        const all = this.state.waGroups || [];
        if (!q) return all;
        // Match the id too — pasting a jid from a log should find its group.
        return all.filter((g) =>
            (g.name || "").toLowerCase().includes(q) || (g.jid || "").toLowerCase().includes(q));
    }

    async waRename(jid, name) {
        const label = (name || "").trim();
        const r = await rpc("/kpi_wa_group/rename", { jid, name: label });
        if (!r || !r.status) { this._waSay((r && r.message) || "Could not rename.", "danger"); return; }
        const g = (this.state.waGroups || []).find((x) => x.jid === jid);
        // `named` is what unlocks "Use this", so it has to move with the label.
        if (g) { g.name = r.name || ""; g.named = !!r.name; }
        if (this.state.waGroupJid === jid) this.state.waGroupName = r.name || "";
        this._waSay(label ? `Named "${r.name}".` : "Name cleared.", "info");
    }

    async waSelect(jid) {
        const g = (this.state.waGroups || []).find((x) => x.jid === jid);
        // Named-only is enforced on the button too, but a stale list could get
        // here — and selecting a group nobody has identified is the exact mistake
        // that put a test message in a client group.
        if (!g || !g.named) { this._waSay("Name the group first, so it is clear which one it is.", "warning"); return; }
        const ok = await this._waConfirm(
            "Send workday reports here?",
            `"${g.name}"${g.members ? ` — ${g.members} members` : ""}\n${jid}\n\n` +
            `Everyone in that group will see every workday start and end message.`);
        if (!ok) return;
        const r = await rpc("/kpi_wa_group/select", { jid, name: g.name });
        if (!r || !r.status) { this._waSay((r && r.message) || "Could not save.", "danger"); return; }
        this.state.waGroupJid = r.jid || "";
        this.state.waGroupName = r.name || g.name;
        this._waSay(`Saved — reports will go to "${this.state.waGroupName}".`, "success");
    }

    async waClear() {
        const r = await rpc("/kpi_wa_group/select", { jid: "" });
        if (!r || !r.status) { this._waSay((r && r.message) || "Could not clear.", "danger"); return; }
        this.state.waGroupJid = "";
        this.state.waGroupName = "";
        this._waSay("Turned off — nothing will be posted.", "info");
    }

    async waPeek() {
        this.state.waBusy = true;
        this.state.waPeek = null;
        this._waSay("");
        try {
            // Read-only on purpose: joining is visible to the whole group, so the
            // name is shown for confirmation before anything happens.
            const r = await rpc("/kpi_wa_group/peek", { link: this.state.waLink });
            if (!r || !r.status) { this._waSay((r && r.message) || "Could not read that link.", "warning"); return; }
            this.state.waPeek = { name: r.name || r.jid, size: r.size || 0, jid: r.jid };
        } finally {
            this.state.waBusy = false;
        }
    }

    async waJoin() {
        this.state.waBusy = true;
        try {
            const r = await rpc("/kpi_wa_group/join", {
                link: this.state.waLink, select: true,
                name: this.state.waPeek ? this.state.waPeek.name : "",
            });
            if (!r || !r.status) { this._waSay((r && r.message) || "Could not join.", "danger"); return; }
            this.state.waGroupJid = r.jid || "";
            this.state.waGroupName = this.state.waPeek ? this.state.waPeek.name : "";
            this.state.waPeek = null;
            this.state.waLink = "";
            this._waSay("Joined — reports will go to this group.", "success");
        } finally {
            this.state.waBusy = false;
        }
    }

    async waTest() {
        const jid = this.state.waGroupJid;
        if (!jid) { this._waSay("No group selected yet.", "warning"); return; }
        const label = this.state.waGroupName || jid;
        const ok = await this._waConfirm(
            "Post a test message?",
            `"${label}"\n${jid}\n\nEveryone in that group will see it.`);
        if (!ok) return;
        // confirm_jid is checked server-side as well — the destination is an opaque
        // id, and the route refuses to post anywhere the caller cannot name.
        const r = await rpc("/kpi_wa_group/test", { confirm_jid: jid });
        this._waSay((r && r.message) || "No response.", r && r.status ? "success" : "warning");
    }

}

registry.category("actions").add("kpi_configuration", KpiConfiguration);
