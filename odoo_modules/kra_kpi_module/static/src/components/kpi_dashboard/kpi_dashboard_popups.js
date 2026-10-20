/** @odoo-module **/
/* The Dashboard's popups (kpi_dashboard.js), ported from the web page:
     DbClientTilePopup  web/components/admin/ClientTilePopup.jsx
     DbEmployeePopup    web/components/admin/EmployeePopup.jsx
     DbDaySummary       DaySummary in web/components/admin/EmployeeDay.jsx
   Same reads, texts and rules; buttons open the matching Odoo screens instead
   of web routes. Keep the two in step. */
import { Component, xml, useState, useRef, onMounted, onWillUnmount, onWillUpdateProps, markup } from "@odoo/owl";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";
import { renderTimelineHtml } from "@kra_kpi_module/components/kpi_workday_timeline/workday_timeline";
import { ST, TS, ACT, cardText, clock, hm, statusOf, timerLevel, avatarUrl, ymd, dmy } from "./employee_status";

/* Outline icons, one stroke style for every action button (no emoji). */
const PATH = {
    phone: "M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2",
    chat: "M21 12a8 8 0 01-12 7l-6 2 2-5.5A8 8 0 1121 12z",
    bell: "M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 003.4 0",
    undo: "M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3",
    key: "M15 7a4 4 0 11-3.9 5H8v3H5v-3H3v-3h8.1A4 4 0 0115 7z",
    x: "M6 6l12 12M18 6L6 18",
};
export class DbIc extends Component {
    static props = { n: String, size: { type: Number, optional: true } };
    static template = xml`<svg class="ep-ic" viewBox="0 0 24 24" t-att-width="props.size || 15" t-att-height="props.size || 15" aria-hidden="true"><path t-att-d="PATH[props.n]"/></svg>`;
    setup() { this.PATH = PATH; }
}

/* Grey placeholder lines while a read is on its way. */
export class DbSkel extends Component {
    static props = { n: { type: Number, optional: true } };
    static template = xml`<div class="db-skel" aria-hidden="true"><i t-foreach="rows" t-as="r" t-key="r" t-att-style="'width:' + (92 - (r % 3) * 18) + '%'"/></div>`;
    get rows() { return [...Array(this.props.n || 3).keys()]; }
}

/* State → [tone, label] for a task lozenge (stateTone in the web UI kit). */
export function stateTone(state) {
    switch (state) {
        case "in_progress": return ["progress", "In progress"];
        case "paused": return ["paused", "Paused"];
        case "partially_completed": return ["review", "In review"];
        case "awaiting_client": return ["review", "Awaiting client"];
        case "completed": return ["done", "Done"];
        case "rework": return ["danger", "Rework"];
        case "pending_review": return ["review", "Pending review"];
        case "urgent": return ["danger", "Urgent"];
        case "important": return ["paused", "Important"];
        case "regular": return ["todo", "To do"];
        default: return ["todo", state || "—"];
    }
}

/* ---------------------------------------------------------------- modal
   Backdrop, title bar with ✕, Esc closes (unless props.locked: a form inside
   owns Escape), focus moves in on open and back out on close. */
export class DbModal extends Component {
    static props = {
        title: String, sub: { type: String, optional: true }, width: { type: Number, optional: true },
        onClose: Function, locked: { type: Boolean, optional: true }, slots: { type: Object, optional: true },
    };
    static template = xml/* xml */`
        <div class="dbm-scrim" t-on-click.self="close">
            <div class="dbm" role="dialog" aria-modal="true" t-att-aria-label="props.title" t-att-style="'max-width:' + (props.width || 860) + 'px'" t-ref="box" tabindex="-1">
                <div class="dbm-head">
                    <span class="ep-title"><t t-esc="props.title"/><small t-if="props.sub" t-esc="props.sub"/></span>
                    <button type="button" class="ep-x" aria-label="Close" title="Close (Esc)" t-on-click="close"><DbIc n="'x'" size="18"/></button>
                </div>
                <div class="dbm-body"><t t-slot="default"/></div>
                <div t-if="props.slots and props.slots.footer" class="dbm-foot"><t t-slot="footer"/></div>
            </div>
        </div>`;
    static components = { DbIc };
    setup() {
        this.box = useRef("box");
        this.onKey = (e) => { if (e.key === "Escape" && !this.props.locked) { e.stopPropagation(); this.close(); } };
        onMounted(() => {
            this.prev = document.activeElement;
            window.addEventListener("keydown", this.onKey, true);
            if (this.box.el) this.box.el.focus();
        });
        onWillUnmount(() => {
            window.removeEventListener("keydown", this.onKey, true);
            if (this.prev && this.prev.focus) this.prev.focus();
        });
    }
    close() { if (!this.props.locked) this.props.onClose(); }
}

/* A small form on top of a popup (Nudge note, Reopen reason, Reset PIN). */
class DbAsk extends Component {
    static props = { ask: Object, onDone: Function };
    static template = xml/* xml */`
        <div class="dba-scrim">
            <form class="dba" role="alertdialog" aria-modal="true" t-att-aria-label="props.ask.title" t-on-submit.prevent="ok">
                <b t-esc="props.ask.title"/>
                <p t-if="props.ask.text" t-esc="props.ask.text"/>
                <label t-if="props.ask.field" class="dba-f">
                    <span><t t-esc="props.ask.field"/><t t-if="!props.ask.required"> (optional)</t></span>
                    <textarea t-ref="inp" rows="3" t-model="s.value" maxlength="300"/>
                </label>
                <small t-if="s.err" class="db-err" t-esc="s.err"/>
                <div class="dba-btns">
                    <button type="button" class="btn btn-secondary" t-on-click="() => this.props.onDone(null)">Cancel</button>
                    <button type="submit" t-att-class="'btn ' + (props.ask.danger ? 'btn-danger' : 'btn-primary')" t-ref="go" t-esc="props.ask.confirm"/>
                </div>
            </form>
        </div>`;
    setup() {
        this.s = useState({ value: "", err: "" });
        this.inp = useRef("inp"); this.go = useRef("go");
        this.onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); this.props.onDone(null); } };
        onMounted(() => { window.addEventListener("keydown", this.onKey, true); (this.inp.el || this.go.el)?.focus(); });
        onWillUnmount(() => window.removeEventListener("keydown", this.onKey, true));
    }
    ok() {
        const v = this.s.value.trim();
        if (this.props.ask.required && !v) { this.s.err = "Please write a reason."; return; }
        this.props.onDone({ value: v });
    }
}

/* ---------------------------------------------------------------- one day
   /kpi_owner/employee_day rendered like the End Workday summary. */
const AWAY = [["break", "Break"], ["lunch", "Lunch"], ["meeting", "Meeting"], ["no_tasks", "No tasks"], ["other", "Other"], ["away", "Away (system)"], ["other_idle", "Other / Idle"]];
const hhmm = (ts) => (ts ? String(ts).slice(11, 16) || ts : "—");

export class DbDaySummary extends Component {
    static props = { d: Object, onOpenTask: Function };
    static template = xml/* xml */`
        <div class="ewd">
            <div t-if="d.auto_closed" class="ewd-call">Auto-closed by the system.</div>
            <section t-if="missing.length" class="ewd-box warn">
                <h3><t t-esc="missing.length"/> task<t t-if="missing.length !== 1">s</t> worked today <t t-esc="missing.length === 1 ? 'has' : 'have'"/> no progress update</h3>
                <div t-foreach="missing" t-as="m" t-key="m.kpi_id" class="mini"><span class="ref" t-esc="m.external_ref || ('#' + m.kpi_id)"/> <t t-esc="m.name"/></div>
            </section>
            <div class="ewd-stats">
                <div class="stat"><small>Login</small><b t-esc="hhmm(d.login_at)"/><span t-esc="d.session_date || ''"/></div>
                <div class="stat"><small>Productive</small><b class="ok" t-esc="d.productive_display || '0h 0m'"/><span>task time</span></div>
                <div class="stat"><small>Presence</small><b t-att-class="d.met_standard ? 'ok' : 'bad'" t-esc="d.presence_display || '0h 0m'"/><span><t t-esc="d.met_standard ? '✓' : '▾'"/> <t t-esc="d.standard_display"/> standard</span></div>
                <div class="stat"><small>Accounted</small><b t-esc="d.accounted_display || '0h 0m'"/><span>task + meeting + lunch + break + no-tasks + paused</span></div>
                <div t-if="d.paused_seconds" class="stat"><small>Workday paused</small><b t-esc="d.paused_display"/><span>paused time</span></div>
            </div>
            <section t-if="sessions.length" class="ewd-box">
                <h3>Start / end log <span t-att-class="'db-lzt ' + (d.late ? 'paused' : 'done')">First start <t t-esc="d.first_login || '—'"/> · <t t-esc="d.late ? 'Late' : 'On time'"/></span></h3>
                <table class="db-tbl"><tbody>
                    <tr t-foreach="sessions" t-as="x" t-key="x.n">
                        <td class="mini" style="width:24px" t-esc="x.n"/>
                        <td class="wrap"><b><t t-esc="x.login"/> → <t t-esc="x.open ? 'now' : (x.logout || '—')"/></b><span class="mini"> · <t t-esc="x.duration_display"/></span>
                            <div t-if="x.reopened" class="mini amber">↩ Reopened <t t-esc="x.reopened_at"/><t t-if="x.reopened_by"> by <t t-esc="x.reopened_by"/></t><t t-if="x.reopen_reason"> — <t t-esc="x.reopen_reason"/></t></div></td>
                        <td class="num"><span t-if="x.open" class="db-lzt progress">● Open</span><span t-elif="x.auto_closed" class="db-lzt paused">Auto-closed</span><span t-else="" class="db-lzt todo">Ended</span></td>
                    </tr>
                </tbody></table>
            </section>
            <section class="ewd-box">
                <h3>Away time <span class="mini">(inside Presence — never Productive)</span></h3>
                <div t-if="away.length" class="ewd-away"><span t-foreach="away" t-as="a" t-key="a[0]" class="ewd-tag"><b t-esc="d[a[0] + '_display']"/><t t-esc="a[1]"/></span></div>
                <span t-else="" class="mini">No away time.</span>
                <ul t-if="(d.away_events || []).length" class="ewd-events">
                    <li t-foreach="d.away_events" t-as="e" t-key="e_index"><span class="ewd-tag sm" t-esc="e.label"/><t t-esc="e.start"/> – <t t-esc="e.end"/> (<t t-esc="e.duration_display"/>)<t t-if="e.from"> · from "<t t-esc="e.from"/>"</t><t t-if="e.with"> · with <t t-esc="e.with"/></t><t t-if="e.note"> — <t t-esc="e.note"/></t></li>
                </ul>
            </section>
            <section t-if="(d.timeline || []).length" class="ewd-box">
                <h3>Workday map <span class="mini">(<t t-esc="d.dev || 'their'"/> day in order)</span></h3>
                <t t-out="timeline"/>
            </section>
            <section class="ewd-box">
                <h3>Tasks worked (<t t-esc="taskCount"/>)</h3>
                <table t-if="tasks.length" class="db-tbl">
                    <thead><tr><th>Ref</th><th>Task</th><th class="num">Time</th></tr></thead>
                    <tbody>
                        <tr t-foreach="tasks" t-as="t" t-key="t.kpi_id" t-att-class="t.concurrent ? 'conc' : ''">
                            <td><span class="ref" t-esc="t.ref || ('#' + t.kpi_id)"/></td>
                            <td class="wrap"><t t-if="t.concurrent">⚡ </t><a href="#" t-on-click.prevent="() => this.props.onOpenTask(t.kpi_id)" t-esc="t.name"/>
                                <small t-if="t.concurrent" class="mini blk"><t t-esc="t.solo_display"/> alone · <t t-esc="t.shared_display"/> shared</small></td>
                            <td class="num" t-esc="t.duration_display"/>
                        </tr>
                    </tbody>
                </table>
                <span t-else="" class="mini">No task time logged.</span>
                <p t-if="multi" class="mini" style="margin:6px 0 0">⚡ ran at the same time as another task.</p>
            </section>
        </div>`;
    setup() { this.hhmm = hhmm; }
    get d() { return this.props.d; }
    get missing() { return this.d.missing_progress || []; }
    get sessions() { return this.d.sessions || []; }
    get tasks() { return this.d.tasks || []; }
    get away() { return AWAY.filter(([k]) => (this.d[`${k}_seconds`] || 0) > 0); }
    get taskCount() { return this.d.task_count != null ? this.d.task_count : this.tasks.length; }
    get multi() { return this.d.allow_multitask || this.tasks.some((t) => t.concurrent); }
    get timeline() { return markup(renderTimelineHtml(this.d.timeline || [], Date.now())); }
}

/* Today (polled every 15 s while shown) or one past day (read once). */
export class DbDay extends Component {
    static props = { userId: Number, name: String, date: { type: String, optional: true }, onNudge: { type: Function, optional: true }, onOpenTask: Function };
    static components = { DbDaySummary, DbSkel, DbIc };
    static template = xml/* xml */`
        <div class="ep-dayw">
            <div t-if="s.err and !s.d" class="ewd-call bad" t-esc="s.err"/>
            <DbSkel t-elif="!s.d" n="6"/>
            <t t-elif="s.d.started === false">
                <div t-if="!props.date" class="ep-empty">
                    <b>Not started yet</b>
                    <span><t t-esc="props.name"/> hasn't started a workday today.</span>
                    <button t-if="props.onNudge" type="button" class="btn btn-primary ep-act" t-on-click="() => this.props.onNudge()"><DbIc n="'bell'"/>Nudge to start workday</button>
                </div>
                <div t-else="" class="ep-empty"><b>No workday</b><span><t t-esc="props.name"/> didn't start a workday on <t t-esc="dateLabel"/>.</span></div>
            </t>
            <t t-else="">
                <p t-if="!props.date" class="mini" style="margin:0 0 8px">Today so far · updates every 15 s</p>
                <DbDaySummary d="s.d" onOpenTask="props.onOpenTask"/>
            </t>
        </div>`;
    setup() {
        this.s = useState({ d: null, err: "" });
        this.seq = 0;
        onMounted(() => {
            this.load();
            if (!this.props.date) this.timer = setInterval(() => { if (!document.hidden) this.load(); }, 15000);
        });
        onWillUpdateProps((np) => { if (np.date !== this.props.date || np.userId !== this.props.userId) { this.s.d = null; this.s.err = ""; this.load(np); } });
        onWillUnmount(() => { clearInterval(this.timer); this.seq++; });
    }
    async load(p = this.props) {
        const seq = ++this.seq;
        try {
            const r = await rpc("/kpi_owner/employee_day", p.date ? { user_id: p.userId, date: p.date } : { user_id: p.userId });
            if (seq !== this.seq) return;
            if (r && r.status === false) { if (!this.s.d) this.s.err = r.message || "Could not load that day."; }
            else { this.s.d = r; this.s.err = ""; }
        } catch (e) {
            if (seq === this.seq && !this.s.d) this.s.err = (e && (e.data?.message || e.message)) || "Could not load that day.";
        }
    }
    get dateLabel() { return dmy(this.props.date, { weekday: "short", day: "numeric", month: "short" }); }
}

/* ---------------------------------------------------------------- client tile popup */
export const TILE = {
    open: { title: "Open requests", note: "Every task for this client that is not completed. “New” ones still need an estimate in the Client Task Queue.",
        go: [{ act: ACT.queue, label: "Open Client Task Queue", primary: true }, { act: ACT.board, label: "Open KPI Actions" }] },
    in_progress: { title: "In progress", note: "Tasks being worked on now (running or paused).",
        go: [{ act: ACT.board, label: "Open KPI Actions", primary: true }, { act: ACT.live, label: "Live Tracking" }] },
    waiting: { title: "Waiting sign-off", note: "Delivered work the client has not approved yet.",
        go: [{ act: ACT.cert, label: "Open Completion Certificates", primary: true }, { act: ACT.appr, label: "Approvals" }] },
    certified: { title: "Certified", note: "Tasks the client signed off in this period.",
        go: [{ act: ACT.cert, label: "Open Completion Certificates", primary: true }, { act: ACT.bill, label: "Client Billing" }] },
    hours: { title: "Hours used", note: "Time logged in this period, per task and person, against each task's quote.",
        go: [{ act: ACT.work, label: "Open Work Report", primary: true }, { act: ACT.bill, label: "Client Billing" }] },
    billing: { title: "Billing", note: "This client's invoices, newest first.",
        go: [{ act: ACT.inv, label: "Open Client Invoices", primary: true }, { act: ACT.bill, label: "Client Billing" }] },
};
const INV_STATE = { draft: "Draft", finalized: "Finalized", sent: "Sent" };

export class DbClientTilePopup extends Component {
    static props = { kind: String, client: Object, range: { optional: true }, period: String, onClose: Function, onOpen: Function, onOpenRecord: Function };
    static components = { DbModal, DbSkel };
    static template = xml/* xml */`
        <DbModal title="title" sub="props.client.name + ' · ' + props.period" width="860" onClose="props.onClose">
            <p class="mini" style="margin:0 0 10px" t-esc="t.note"/>
            <div t-if="s.err" class="ewd-call bad" t-esc="s.err"/>
            <DbSkel t-if="!s.rows and !s.err" n="5"/>
            <div t-if="s.rows and !s.rows.length" class="d3-empty">Nothing here for this <t t-esc="emptyWhat"/>.</div>
            <div t-if="s.rows and s.rows.length" class="db-tscroll">
                <table t-if="props.kind === 'billing'" class="db-tbl">
                    <thead><tr><th>Invoice</th><th>Date</th><th>Status</th><th>Payment</th><th class="num">Amount</th></tr></thead>
                    <tbody><tr t-foreach="s.rows" t-as="r" t-key="r.id">
                        <td><a href="#" t-on-click.prevent="() => this.props.onOpenRecord('kpi.client.invoice', r.id, ACT.inv)"><b t-esc="r.name"/></a></td>
                        <td class="mini" t-esc="dmyY(r.date)"/>
                        <td><span t-att-class="'db-lzt ' + (r.state === 'draft' ? 'todo' : r.state === 'sent' ? 'progress' : 'review')" t-esc="INV_STATE[r.state] || r.state"/></td>
                        <td><span t-att-class="'db-lzt ' + (r.payment_status === 'paid' ? 'done' : 'danger')" t-esc="r.payment_status === 'paid' ? 'Paid' : 'Unpaid'"/></td>
                        <td class="num" t-esc="money(r)"/>
                    </tr></tbody>
                </table>
                <table t-elif="props.kind === 'hours'" class="db-tbl">
                    <thead><tr><th>Ref</th><th>Task</th><th>Person</th><th class="num">Hours</th><th class="num">Quote</th></tr></thead>
                    <tbody>
                        <tr t-foreach="s.rows" t-as="r" t-key="r.id + '-' + r.person_id + '-' + r_index">
                            <td><span class="ref" t-esc="r.ref || ('#' + r.id)"/></td>
                            <td class="wrap"><a href="#" t-on-click.prevent="() => this.openTask(r.id)" t-esc="r.name"/><small class="mini blk" t-esc="r.project"/></td>
                            <td><t t-if="r.person"><img class="db-av sm" t-att-src="avatarUrl(r.person_id)" alt=""/><t t-esc="r.person"/></t><t t-else="">—</t></td>
                            <td t-att-class="'num' + (r.quoted_h and r.hours > r.quoted_h ? ' d3-bad' : '')"><t t-esc="r.hours.toFixed(1)"/>h</td>
                            <td class="num mini" t-esc="r.quoted_h ? r.quoted_h + 'h' : '—'"/>
                        </tr>
                        <tr><td colspan="3"><b>Total</b></td><td class="num"><b><t t-esc="hoursTotal"/>h</b></td><td/></tr>
                    </tbody>
                </table>
                <table t-else="" class="db-tbl">
                    <thead><tr><th>Ref</th><th>Task</th><th>Project</th><th>Assignee</th><th>State</th><th t-esc="props.kind === 'certified' ? 'Signed' : 'Deadline'"/></tr></thead>
                    <tbody><tr t-foreach="s.rows" t-as="r" t-key="r.id">
                        <td><span class="ref" t-esc="r.ref || ('#' + r.id)"/></td>
                        <td class="wrap"><a href="#" t-on-click.prevent="() => this.openTask(r.id)" t-esc="r.name"/><t t-if="r.is_new"> <span class="db-lzt fresh">New · needs estimate</span></t></td>
                        <td class="mini" t-esc="r.project || '—'"/>
                        <td><t t-if="r.assignee"><img class="db-av sm" t-att-src="avatarUrl(r.assignee_id)" alt=""/><t t-esc="r.assignee"/></t><span t-else="" class="mini">Unassigned</span></td>
                        <td><span t-att-class="'db-lzt ' + tone(r.state)[0]" t-att-title="r.state_label" t-esc="tone(r.state)[1]"/></td>
                        <td class="mini" t-esc="props.kind === 'certified' ? r.signed : (r.deadline ? dmyY(r.deadline) : '—')"/>
                    </tr></tbody>
                </table>
            </div>
            <t t-set-slot="footer">
                <button t-foreach="t.go" t-as="g" t-key="g.act" type="button" t-att-class="'btn ' + (g.primary ? 'btn-primary' : 'btn-secondary')" t-on-click="() => this.go(g.act)"><t t-esc="g.label"/> →</button>
                <button type="button" class="btn btn-light" t-on-click="() => this.props.onClose()">Close</button>
            </t>
        </DbModal>`;
    setup() {
        this.ACT = ACT; this.INV_STATE = INV_STATE; this.avatarUrl = avatarUrl; this.tone = stateTone;
        this.s = useState({ rows: null, err: "" });
        onMounted(async () => {
            const rg = this.props.range;
            try {
                const r = await rpc("/kpi_owner/client_summary_items", { client_kra_id: this.props.client.id, kind: this.props.kind, ...(rg && rg[0] && rg[1] ? { from_date: rg[0], to_date: rg[1] } : {}) });
                if (r && r.status === false) this.s.err = r.message || "Could not load."; else this.s.rows = (r && r.rows) || [];
            } catch (e) { this.s.err = (e && (e.data?.message || e.message)) || "Could not load."; }
        });
    }
    get t() { return TILE[this.props.kind]; }
    get title() { return `${this.t.title}${this.s.rows ? ` (${this.s.rows.length})` : ""}`; }
    get emptyWhat() { return ["open", "in_progress", "waiting"].includes(this.props.kind) ? "client right now" : "period"; }
    get hoursTotal() { return (this.s.rows || []).reduce((s, r) => s + r.hours, 0).toFixed(1); }
    dmyY(s) { return dmy(s, { day: "numeric", month: "short", year: "numeric" }); }
    money(r) { return `${r.currency || ""}${Number(r.amount || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }
    go(act) { this.props.onClose(); this.props.onOpen(act); }
    openTask(id) { this.props.onClose(); this.props.onOpenRecord("kra.kpi", id, ACT.board); }
}

/* ---------------------------------------------------------------- employee popup
     header    one status line (from the live row the page polls), Call / WhatsApp /
               Nudge, Reopen workday
     Overview  the day and the workload in numbers, and the contact card
     Today     today's summary (refreshed every 15 s)
     Workload  every open task, questions waiting on a manager, today's meetings
     History   any earlier day and the last 30 days' attendance (working days only)
   The PIN is never shown — only whether it is still the default. */
const TONE = { running: "progress", paused: "paused", todo: "todo", hold: "danger", approval: "review", done: "done" };
const ATT = { on_time: "On time", late: "Late", absent: "Absent", off: "Weekend", holiday: "Holiday", before_join: "Before joining", pending: "Not yet" };

export class DbEmployeePopup extends Component {
    static props = { person: Object, onClose: Function, onChanged: { type: Function, optional: true }, onOpen: Function, onOpenRecord: Function };
    static components = { DbModal, DbAsk, DbSkel, DbDay, DbIc };
    static template = xml/* xml */`
        <DbModal title="p.name" sub="(c and c.role) || p.role || 'Developer'" width="920" onClose="props.onClose" locked="!!s.ask">
            <div class="ep">
                <div t-att-class="'ep-head s-' + st + (level ? ' t-' + level : '')">
                    <span class="d3-av"><img class="db-av lg" t-att-src="avatarUrl(p.user_id)" alt=""/><i/></span>
                    <div class="ep-now">
                        <b t-esc="head"/>
                        <small t-if="second" t-esc="second"/>
                        <small t-if="p.activity_note and st === 'working'">“<t t-esc="p.activity_note"/>”</small>
                        <small t-if="(p.active_tasks || []).length > 1"><t t-esc="p.active_tasks.length"/> tasks running at once</small>
                        <small t-if="p.reopened_reason" class="ep-warn">Reopened<t t-if="p.reopened_by"> by <t t-esc="p.reopened_by"/></t>: <t t-esc="p.reopened_reason"/></small>
                    </div>
                    <div class="ep-acts">
                        <a t-if="c and c.mobile" class="btn btn-light ep-act" t-att-href="'tel:+' + c.dial + c.mobile" t-att-title="'Call +' + c.dial + ' ' + c.mobile"><DbIc n="'phone'"/>Call</a>
                        <a t-if="c and c.whatsapp" class="btn btn-light ep-act" t-att-href="'https://wa.me/' + c.whatsapp" target="_blank" rel="noopener noreferrer" t-att-title="'WhatsApp +' + c.whatsapp"><DbIc n="'chat'"/>WhatsApp</a>
                        <button type="button" class="btn btn-light ep-act" t-att-disabled="s.busy === 'nudge'" t-on-click="nudge"><DbIc n="'bell'"/><t t-esc="absent ? 'Nudge: start workday' : 'Nudge'"/></button>
                        <button t-if="p.day_done" type="button" class="btn btn-primary ep-act" t-att-disabled="s.busy === 'reopen'" t-on-click="reopen"><DbIc n="'undo'"/>Reopen workday</button>
                    </div>
                </div>

                <div class="ep-tabs" role="tablist">
                    <button t-foreach="tabs" t-as="tb" t-key="tb.key" type="button" role="tab" t-att-aria-selected="s.tab === tb.key ? 'true' : 'false'" t-att-class="s.tab === tb.key ? 'on' : ''" t-on-click="() => this.s.tab = tb.key">
                        <t t-esc="tb.label"/><em t-if="tb.count != null" t-esc="tb.count"/>
                    </button>
                </div>

                <div class="ep-body">
                    <div t-if="s.profErr and (s.tab === 'overview' or s.tab === 'workload')" class="ewd-call bad" t-esc="s.profErr"/>

                    <!-- Overview -->
                    <t t-if="s.tab === 'overview'">
                        <DbSkel t-if="!prof" n="6"/>
                        <div t-else="" class="ep-grid">
                            <div class="ep-tiles">
                                <div class="d3-tile"><div class="t">Productive today</div><div class="v" t-esc="hm(p.productive_today)"/><div class="d3-bar"><i t-att-style="'width:' + todayPct + '%'"/></div><div class="n" style="margin-top:4px">of an 8-hour day</div></div>
                                <div class="d3-tile"><div class="t">Done</div><div class="v d3-ok"><t t-esc="w.done_today"/> <small>today</small></div><div class="n"><t t-esc="w.done_week"/> this week · <t t-esc="w.done_month"/> this month</div></div>
                                <div class="d3-tile"><div class="t">Open tasks</div><div class="v" t-esc="w.open"/><div class="n"><t t-esc="w.counts.running"/> running · <t t-esc="w.counts.paused"/> paused · <t t-esc="w.counts.todo"/> to do · <t t-esc="w.counts.approval"/> approval</div></div>
                                <div class="d3-tile"><div class="t">Deadlines</div><div t-att-class="'v' + (w.overdue ? ' d3-bad' : '')" t-esc="w.overdue"/><div t-att-class="'n' + (w.overdue ? ' d3-bad' : '')">overdue · <t t-esc="w.due_week"/> due this week</div></div>
                                <div class="d3-tile"><div class="t">Estimate vs spent</div><div t-att-class="'v' + (w.est_total and w.spent_total > w.est_total ? ' d3-bad' : '')"><t t-esc="w.spent_total"/>h <small>/ <t t-esc="w.est_total"/>h</small></div><div class="n">on open tasks</div></div>
                                <div class="d3-tile"><div class="t">Attendance · 30 days</div><div class="v"><t t-esc="attT.on_time || 0"/><small> on time</small></div>
                                    <div class="n"><t t-esc="attT.late || 0"/> late · <t t-esc="attT.absent || 0"/> absent · of <t t-esc="attT.working_days || 0"/> working day<t t-if="attT.working_days !== 1">s</t></div></div>
                            </div>
                            <section class="ep-box">
                                <h3>Contact &amp; login</h3>
                                <dl class="ep-dl">
                                    <dt>Login mobile</dt><dd><t t-esc="c.mobile ? '+' + c.dial + ' ' + c.mobile : '—'"/><t t-if="c.country"> · <t t-esc="c.country"/></t></dd>
                                    <dt>WhatsApp</dt><dd><t t-if="c.whatsapp">+<t t-esc="c.whatsapp"/></t><span t-else="" class="d3-bad">no number — they can't be messaged</span></dd>
                                    <dt>App login</dt><dd class="ep-pin"><t t-if="c.app_login_enabled">On</t><span t-else="" class="d3-bad">Off</span>
                                        <t t-if="c.pin_is_default"><span class="ep-amber">Default PIN – not changed</span>
                                            <button type="button" class="btn btn-light ep-act sm" t-att-disabled="s.busy === 'pin'" t-on-click="resetPin"><DbIc n="'key'" size="13"/>Reset PIN</button></t></dd>
                                    <dt>Last sign-in</dt><dd t-esc="c.last_app_login ? c.last_app_login + (c.last_device ? ' · ' + c.last_device : '') : 'never'"/>
                                    <dt>ERP login</dt><dd t-esc="c.login"/>
                                    <dt>Multitask</dt><dd t-esc="c.allow_multitask ? 'May run several tasks at once' : 'One task at a time'"/>
                                </dl>
                            </section>
                            <section t-if="prof.questions.length or prof.meetings_today.length" class="ep-box">
                                <h3>Waiting on</h3>
                                <p t-if="prof.questions.length" class="mini" style="margin:0"><t t-esc="prof.questions.length"/> question<t t-if="prof.questions.length !== 1">s</t> to a manager, oldest <t t-esc="oldestQ"/> day(s)</p>
                                <p t-foreach="prof.meetings_today" t-as="m" t-key="m.id" class="mini" style="margin:4px 0 0"><t t-esc="m.time"/> <t t-esc="m.name"/> · <t t-esc="m.state"/></p>
                            </section>
                        </div>
                    </t>

                    <!-- Today -->
                    <DbDay t-if="s.tab === 'today'" userId="p.user_id" name="p.name" onNudge="nudgeFn" onOpenTask="openTaskFn"/>

                    <!-- Workload -->
                    <t t-if="s.tab === 'workload'">
                        <DbSkel t-if="!prof" n="6"/>
                        <div t-else="" class="ep-grid">
                            <div t-if="w.open > 0 or w.done_month > 0" class="ep-chips">
                                <span t-foreach="['running', 'paused', 'todo', 'hold', 'approval']" t-as="k" t-key="k" t-att-class="'db-lzt ' + (w.counts[k] ? TONE[k] : 'neutral ep-zero')"><t t-esc="TS[k]"/> <t t-esc="w.counts[k] || 0"/></span>
                                <span t-att-class="'db-lzt ' + (w.done_month ? 'done' : 'neutral ep-zero')">Done <t t-esc="w.done_today"/> today · <t t-esc="w.done_week"/> this week · <t t-esc="w.done_month"/> this month</span>
                                <span t-if="w.overdue > 0" class="db-lzt danger"><t t-esc="w.overdue"/> overdue</span>
                                <span t-if="w.due_week > 0" class="db-lzt paused"><t t-esc="w.due_week"/> due this week</span>
                            </div>
                            <section class="ep-box">
                                <h3>Open tasks (<t t-esc="w.open"/>)</h3>
                                <div t-if="w.tasks.length" class="db-tscroll" style="max-height:340px">
                                    <table class="db-tbl">
                                        <thead><tr><th>Ref</th><th>Task</th><th>Client</th><th>State</th><th>Deadline</th><th class="num">Spent / est.</th></tr></thead>
                                        <tbody><tr t-foreach="w.tasks" t-as="t" t-key="t.id">
                                            <td><span class="ref" t-esc="t.ref || ('#' + t.id)"/></td>
                                            <td class="wrap"><a href="#" t-on-click.prevent="() => this.openTask(t.id)" t-esc="t.name"/></td>
                                            <td class="mini" t-esc="t.client || '—'"/>
                                            <td><span t-att-class="'db-lzt ' + TONE[t.state]" t-att-title="t.state_label" t-esc="TS[t.state]"/></td>
                                            <td t-att-class="t.overdue ? 'd3-bad' : t.due_week ? '' : 'mini'"><t t-esc="t.deadline ? dmy(t.deadline) : '—'"/><t t-if="t.overdue"> · overdue</t></td>
                                            <td t-att-class="'num' + (t.estimate_h and t.spent_h > t.estimate_h ? ' d3-bad' : '')"><t t-esc="t.spent_h"/>h / <t t-esc="t.estimate_h || '—'"/><t t-if="t.estimate_h">h</t></td>
                                        </tr></tbody>
                                    </table>
                                </div>
                                <span t-else="" class="mini">No open tasks.</span>
                            </section>
                            <section class="ep-box">
                                <h3>Questions waiting on a manager (<t t-esc="prof.questions.length"/>)</h3>
                                <t t-if="prof.questions.length"><div t-foreach="prof.questions" t-as="q" t-key="q.id" class="ep-q"><span class="ref" t-esc="q.ref || '—'"/> <span t-esc="q.question"/> <span class="mini">· <t t-esc="q.days ? q.days + ' day' + (q.days === 1 ? '' : 's') : 'today'"/></span></div></t>
                                <span t-else="" class="mini">None.</span>
                            </section>
                            <section class="ep-box">
                                <h3>Meetings today (<t t-esc="prof.meetings_today.length"/>)</h3>
                                <t t-if="prof.meetings_today.length"><div t-foreach="prof.meetings_today" t-as="m" t-key="m.id" class="ep-q"><b t-esc="m.time"/> <t t-esc="m.name"/> <span class="mini">· <t t-esc="m.state"/></span><t t-if="m.join_url"> · <a t-att-href="m.join_url" target="_blank" rel="noopener noreferrer">Join</a></t></div></t>
                                <span t-else="" class="mini">None.</span>
                            </section>
                        </div>
                    </t>

                    <!-- History -->
                    <div t-if="s.tab === 'history'" class="ep-grid">
                        <section class="ep-box">
                            <h3>Attendance · last 30 days <span t-if="att" class="mini">(working days only · late after <t t-esc="clock(att.cutoff)"/><t t-if="att.joined"> · joined <t t-esc="dmy(att.joined)"/></t>)</span></h3>
                            <DbSkel t-if="!att" n="2"/>
                            <t t-else="">
                                <div class="ep-att" role="list">
                                    <button t-foreach="att.days" t-as="d" t-key="d.date" type="button" role="listitem" t-att-class="'ep-day a-' + d.status + (d.date === s.date ? ' on' : '')"
                                            t-att-title="dayTitle(d)" t-att-disabled="d.date >= today" t-on-click="() => this.pickDay(d.date)">
                                        <span t-esc="dayNum(d.date)"/>
                                    </button>
                                </div>
                                <div class="ep-chips" style="margin-top:8px">
                                    <span class="db-lzt done">On time <t t-esc="att.totals.on_time"/></span>
                                    <span class="db-lzt paused">Late <t t-esc="att.totals.late"/></span>
                                    <span class="db-lzt danger">Absent <t t-esc="att.totals.absent"/></span>
                                    <span class="mini">of <t t-esc="att.totals.working_days"/> working days · click a day to see it below · <a href="#" t-on-click.prevent="() => this.openAct(ACT.snap)">Workday snapshots</a></span>
                                </div>
                            </t>
                        </section>
                        <section class="ep-box">
                            <h3 class="ep-dh"><t t-esc="dmy(s.date, { weekday: 'long', day: 'numeric', month: 'long' })"/>
                                <input type="date" class="ep-date" aria-label="Day" t-att-value="s.date" t-att-max="yesterday" t-on-change="onDate"/></h3>
                            <DbDay userId="p.user_id" name="p.name" date="s.date" onOpenTask="openTaskFn"/>
                        </section>
                    </div>
                </div>
            </div>
            <DbAsk t-if="s.ask" ask="s.ask" onDone="s.ask.done"/>
        </DbModal>`;

    setup() {
        Object.assign(this, { ACT, TS, TONE, hm, clock, dmy, avatarUrl });
        this.notification = useService("notification");
        const y = new Date(); y.setDate(y.getDate() - 1);
        this.s = useState({ tab: "overview", prof: null, profErr: "", busy: "", ask: null, date: ymd(y) });
        this.nudgeFn = () => this.nudge();
        this.openTaskFn = (id) => this.openTask(id);
        onMounted(() => this.loadProfile());
        onWillUpdateProps((np) => { if (np.person.user_id !== this.props.person.user_id) { this.s.prof = null; this.loadProfile(np.person.user_id); } });
    }
    async loadProfile(uid = this.props.person.user_id) {
        try {
            const r = await rpc("/kpi_owner/employee_profile", { user_id: Number(uid) });
            if (r && r.status === false) this.s.profErr = r.message || "Could not load."; else { this.s.prof = r; this.s.profErr = ""; }
        } catch (e) { this.s.profErr = (e && (e.data?.message || e.message)) || "Could not load."; }
    }

    get p() { return this.props.person; }
    get prof() { return this.s.prof; }
    get c() { return this.prof && this.prof.contact; }
    get w() { return this.prof && this.prof.workload; }
    get att() { return this.prof && this.prof.attendance; }
    get attT() { return (this.att && this.att.totals) || {}; }
    get st() { return statusOf(this.p); }
    get level() { return timerLevel(this.p, this.st); }
    get absent() { return this.st === "absent" && !this.p.day_done; }
    get lines() { return cardText(this.p, this.st); }
    /* "Working on REQ-068 · 1h 20m" → "Working · on REQ-068 · 1h 20m"; "Absent" →
       "Absent · no workday started today": the status is said once. */
    get head() {
        const [line, sub] = this.lines, s = this.st, p = this.p;
        if (s === "absent") return `${p.day_done ? "Workday ended" : "Absent"} · ${(p.day_done ? sub : sub || "no workday started today").toLowerCase()}`;
        const detail = line.replace(new RegExp(`^${ST[s]}\\s*`, "i"), "").replace(/^·\s*/, "");
        return `${ST[s]} · ${detail || line}`;
    }
    get second() { return this.st === "absent" ? "" : this.lines[1]; }
    get todayPct() { return Math.min(100, ((this.p.productive_today || 0) / (8 * 3600)) * 100); }
    get oldestQ() { return Math.max(...this.prof.questions.map((q) => q.days)); }
    get tabs() { return [{ key: "overview", label: "Overview" }, { key: "today", label: "Today" }, { key: "workload", label: "Workload", count: this.w ? this.w.open : null }, { key: "history", label: "History" }]; }
    get today() { return ymd(new Date()); }
    get yesterday() { return ymd(new Date(Date.now() - 864e5)); }
    dayNum(d) { return new Date(`${d}T00:00:00`).getDate(); }
    dayTitle(d) { return `${dmy(d.date, { weekday: "short", day: "numeric", month: "short" })} · ${ATT[d.status] || d.status}${d.first_login ? ` · in ${clock(d.first_login)}` : ""}`; }
    pickDay(d) { if (d < this.today) this.s.date = d; }
    onDate(e) { const v = e.target.value; if (v && v < this.today) this.s.date = v; }

    openTask(id) { this.props.onClose(); this.props.onOpenRecord("kra.kpi", id, ACT.board); }
    openAct(act) { this.props.onClose(); this.props.onOpen(act); }

    ask(a) { return new Promise((resolve) => { this.s.ask = { ...a, done: (v) => { this.s.ask = null; resolve(v); } }; }); }
    err(e, fb) { this.notification.add((e && (e.data?.message || e.message)) || fb, { type: "danger" }); }
    async nudge() {
        const p = this.p, absent = this.absent;
        const v = await this.ask({ title: absent ? `Ask ${p.name} to start their workday` : `Nudge ${p.name}`,
            text: absent ? "They get a notification asking them to start their workday." : "They get a notification that you are checking in.",
            field: "Note", required: false, confirm: "Send nudge" });
        if (!v) return;
        this.s.busy = "nudge";
        try {
            const r = await rpc("/kpi_owner/nudge_user", { user_id: p.user_id, note: v.value.slice(0, 300) });
            if (r && r.status === false) throw new Error(r.message || "Could not nudge.");
            this.notification.add(`Nudged ${p.name}.`, { type: "success" });
        } catch (e) { this.err(e, "Could not nudge."); } finally { this.s.busy = ""; }
    }
    async reopen() {
        const p = this.p;
        const v = await this.ask({ title: `Reopen ${p.name}'s workday`, text: "Their day was ended. Reopening lets them continue today; the reason is recorded.",
            field: "Reason", required: true, confirm: "Reopen" });
        if (!v) return;
        this.s.busy = "reopen";
        try {
            const r = await rpc("/kpi_workday/revert", { user_id: p.user_id, reason: v.value });
            if (r && r.status === false) throw new Error(r.message || "Could not reopen.");
            this.notification.add(`${p.name}'s workday reopened.`, { type: "success" });
            if (this.props.onChanged) this.props.onChanged();
        } catch (e) { this.err(e, "Could not reopen."); } finally { this.s.busy = ""; }
    }
    async resetPin() {
        const p = this.p;
        const v = await this.ask({ title: `Reset ${p.name}'s PIN?`, text: "Their app PIN goes back to the default and they must choose a new one the next time they sign in.",
            confirm: "Reset PIN", danger: true });
        if (!v) return;
        this.s.busy = "pin";
        try {
            const r = await rpc("/kpi_user_access/reset_password", { user_id: p.user_id });
            if (r && r.status === false) throw new Error(r.message || "Could not reset the PIN.");
            this.notification.add(`${p.name}'s PIN was reset — they set a new one at next sign-in.`, { type: "success" });
            this.loadProfile();
        } catch (e) { this.err(e, "Could not reset the PIN."); } finally { this.s.busy = ""; }
    }
}
