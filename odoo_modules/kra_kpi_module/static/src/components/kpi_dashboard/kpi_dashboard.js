/** @odoo-module **/
import { Component, xml, useState, onMounted, onPatched, onWillUnmount } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";
import { KpiAiAssistant } from "@kra_kpi_module/components/kpi_ai_assistant/kpi_ai_assistant";
import { hm, ST, TS, statusOf, cardText, pauseWhy, since, liveRow, timerLevel, STATUS_ORDER, initials, hue, avatarUrl, ymd, dmy, loadLs, saveLs } from "./employee_status";
import { DbSkel, DbClientTilePopup, DbEmployeePopup } from "./kpi_dashboard_popups";

/**
 * Dashboard — the Odoo twin of the web Dashboard page (web/components/admin/Dashboard.jsx
 * + DashboardTop.jsx). The 369 AI Assistant is docked on the left and tucks away
 * behind an arrow tab (closed by default, the choice remembered per browser); on
 * the right only two boxes:
 *   Client details   /kpi_owner/client_summary for one client: switch off = Auto (this
 *                    month to date, live), on = Week / Month / Custom. Each tile opens
 *                    the rows behind its number (kpi_dashboard_popups.js).
 *   Employees today  live status cards from the rows the page polls; a card opens a
 *                    4-tab popup (Overview, Today, Workload, History).
 * Reads: /kpi_owner/certified_by_client (client list), /kpi_owner/live_tracking
 * (every 30 s), /kra_kpi/dashboard/overview (per-person hours, every 60 s).
 * Owner / Coordinator / System (the routes check it). Keep in step with the web.
 */

/* ---------------- Client details ---------------- */
function range(period, from, to) {
    const t = new Date();
    if (period === "week") { const mon = new Date(t); mon.setDate(t.getDate() - ((t.getDay() + 6) % 7)); return [ymd(mon), ymd(t)]; }
    if (period === "month") return [ymd(new Date(t.getFullYear(), t.getMonth(), 1)), ymd(t)];
    return [from, to];
}
function periodLabel(on, period, from, to) {
    if (!on) return "Auto · live, this month to date";
    const [a, b] = range(period, from, to);
    return `${{ week: "This week", month: "This month", custom: "Custom" }[period]} · ${dmy(a)} – ${dmy(b)}`;
}
const INV_STATE = { draft: "Draft", finalized: "Finalized", sent: "Sent" };

class DbClientDetails extends Component {
    static props = { clients: { optional: true }, onTile: Function };
    static components = { DbSkel };
    static template = xml/* xml */`
        <section class="d3-card" aria-labelledby="d3-clients-h">
            <div class="d3-head">
                <div class="d3-l">
                    <h2 id="d3-clients-h">Client details</h2>
                    <span t-if="list.length > 1" class="d3-pick"><span class="d3-lbl">Client</span>
                        <select class="d3-select" aria-label="Client" t-on-change="onClient">
                            <option t-foreach="list" t-as="c" t-key="c.id" t-att-value="c.id" t-att-selected="c.id === clientId ? 'selected' : undefined" t-esc="c.name"/>
                        </select>
                    </span>
                </div>
                <div class="d3-ctrls">
                    <button type="button" class="d3-switch" role="switch" t-att-aria-checked="st.on ? 'true' : 'false'" aria-label="Filter by period" t-on-click="() => this.set({ on: !st.on })"><span class="d3-track"><span class="d3-knob"/></span>Filter</button>
                    <span t-if="!st.on" class="d3-auto"><i/>Auto</span>
                    <div t-att-class="'d3-seg' + (st.on ? '' : ' off')" role="group" aria-label="Period">
                        <button t-foreach="PERIODS" t-as="pp" t-key="pp[0]" type="button" t-att-disabled="!st.on" t-att-class="st.on and st.period === pp[0] ? 'on' : ''"
                                t-att-aria-pressed="st.on and st.period === pp[0] ? 'true' : 'false'" t-on-click="() => this.set({ period: pp[0] })" t-esc="pp[1]"/>
                    </div>
                </div>
            </div>
            <div t-if="st.on and st.period === 'custom'" class="d3-custom">
                <label for="d3-from">From</label><input id="d3-from" type="date" t-att-value="st.from" t-att-max="st.to" t-on-change="(e) => this.set({ from: e.target.value })"/>
                <label for="d3-to">To</label><input id="d3-to" type="date" t-att-value="st.to" t-att-min="st.from" t-on-change="(e) => this.set({ to: e.target.value })"/>
            </div>

            <DbSkel t-if="!props.clients" n="4"/>
            <div t-elif="!list.length" class="d3-empty">No clients yet. Add one in KRA / KPI Master.</div>
            <t t-else="">
                <div class="d3-cbar" t-att-aria-busy="s.busy ? 'true' : undefined">
                    <div class="d3-who">
                        <span class="db-cav lg" t-att-style="'--h:' + hue(clientId)" t-esc="initials(clientName)"/>
                        <div><div class="d3-cname" t-esc="clientName"/>
                            <div class="d3-csub" t-esc="d ? d.open + ' open request' + (d.open === 1 ? '' : 's') + ' · ' + d.in_progress + ' in progress' : 'Loading…'"/></div>
                    </div>
                    <div class="d3-plabel"><t t-esc="label"/><span t-if="s.busy" class="d3-spin" aria-label="Loading"/></div>
                </div>
                <div t-if="s.err" class="d3-err" role="alert" t-esc="s.err"/>
                <div t-att-class="'d3-tiles' + (s.busy ? ' is-busy' : '')">
                    <t t-foreach="tiles" t-as="tl" t-key="tl.kind">
                        <div t-att-class="'d3-tile' + (d ? ' is-link' : '')" t-att-role="d ? 'button' : undefined" t-att-tabindex="d ? 0 : undefined"
                             t-att-aria-label="d ? tl.t + ': show the list' : undefined" t-on-click="() => this.open(tl.kind)" t-on-keydown="(e) => this.key(e, tl.kind)">
                            <div class="t"><t t-esc="tl.t"/><span t-if="d" class="d3-more" aria-hidden="true">›</span></div>
                            <t t-if="tl.kind === 'hours'">
                                <div t-att-class="'v' + (hours.over ? ' d3-bad' : '')"><t t-esc="d ? hours.used + 'h' : '—'"/> <small>/ <t t-esc="d ? hours.quoted + 'h' : '—'"/></small></div>
                                <div class="d3-bar"><i t-att-class="hours.over ? 'd3-bad' : ''" t-att-style="'width:' + (hours.over ? 100 : hours.pct) + '%'"/></div>
                                <div t-att-class="'n' + (hours.over ? ' d3-bad' : '')" style="margin-top:4px" t-esc="d ? hours.note : ''"/>
                            </t>
                            <t t-elif="tl.kind === 'billing'">
                                <div class="v small" t-esc="d ? billing.state : '—'"/>
                                <div t-att-class="'n' + (d and d.overdue ? ' d3-bad' : '')" style="margin-top:4px" t-esc="d ? billing.due : ''"/>
                            </t>
                            <t t-else="">
                                <div t-att-class="'v ' + (tl.tone || '')" t-esc="tl.v == null ? '—' : tl.v"/>
                                <div class="n" t-esc="tl.n"/>
                            </t>
                        </div>
                    </t>
                </div>
            </t>
        </section>`;

    setup() {
        Object.assign(this, { hue, initials, PERIODS: [["week", "Week"], ["month", "Month"], ["custom", "Custom"]] });
        const t = new Date();
        this.st = useState(loadLs("kpi.db.client", { clientId: 0, on: false, period: "week", from: ymd(new Date(t.getFullYear(), t.getMonth(), 1)), to: ymd(t) }));
        this.s = useState({ data: null, err: "", busy: false });
        this.seq = 0;
        this.lastKey = "";
        onMounted(() => this.load());
        /* The client list arrives after mount: load once it is there. */
        onPatched(() => this.ensureLoaded());
    }
    set(patch) { Object.assign(this.st, patch); saveLs("kpi.db.client", { ...this.st }); this.load(); }
    onClient(e) { this.set({ clientId: Number(e.target.value) }); }
    get list() { return (this.props.clients || []).map((c) => ({ id: c.client_id, name: c.client_name })); }
    get clientId() { const l = this.list; return l.some((c) => c.id === this.st.clientId) ? this.st.clientId : l[0] && l[0].id; }
    get clientName() { const d = this.d; return (d && d.client && d.client.name) || ((this.list.find((c) => c.id === this.clientId) || {}).name) || ""; }
    get label() { return periodLabel(this.st.on, this.st.period, this.st.from, this.st.to); }
    get rng() { return this.st.on ? range(this.st.period, this.st.from, this.st.to) : null; }
    get d() { const x = this.s.data; return x && x.client && x.client.id === this.clientId ? x : null; }

    async load() {
        const id = this.clientId;
        if (!id) return;
        const rg = this.rng;
        if (this.st.on && (!rg[0] || !rg[1])) return;
        const key = `${id}|${rg ? rg.join("|") : "auto"}`;
        this.lastKey = key;
        const seq = ++this.seq;
        this.s.busy = true;
        try {
            const r = await rpc("/kpi_owner/client_summary", { client_kra_id: id, ...(rg ? { from_date: rg[0], to_date: rg[1] } : {}) });
            if (seq !== this.seq) return;
            if (r && r.status === false) this.s.err = r.message || "Couldn't load this client.";
            else { this.s.data = r; this.s.err = ""; }
        } catch (e) {
            if (seq === this.seq) this.s.err = (e && (e.data?.message || e.message)) || "Couldn't load this client.";
        } finally { if (seq === this.seq) this.s.busy = false; }
    }
    /* Reload only when the client or the period actually changed. */
    ensureLoaded() {
        const rg = this.rng;
        const key = `${this.clientId}|${rg ? rg.join("|") : "auto"}`;
        if (this.clientId && key !== this.lastKey) this.load();
    }

    get hours() {
        const d = this.d, used = (d && d.hours_used) || 0, quoted = (d && d.hours_quoted) || 0;
        const over = quoted > 0 && used > quoted;
        const pct = quoted > 0 ? Math.min(100, Math.round((used / quoted) * 100)) : 0;
        const note = !quoted ? (used ? "no quote on the tasks worked" : "no time logged in this period")
            : over ? `${Math.round((used / quoted - 1) * 100)}% over quote` : `${Math.round((quoted - used) * 10) / 10}h left on quote`;
        return { used, quoted, over, pct, note };
    }
    get billing() {
        const d = this.d;
        if (!d) return {};
        const sym = (d.currency && d.currency.symbol) || "", inv = d.last_invoice;
        const state = inv ? `${inv.name} · ${inv.payment_status === "paid" ? "Paid" : INV_STATE[inv.state] || inv.state}` : "No invoice yet";
        const due = d.amount_due > 0
            ? `${sym}${Number(d.amount_due).toLocaleString("en-IN", { maximumFractionDigits: 0 })} due${d.due_date ? ` on ${dmy(d.due_date)}` : ""}`
            : "Nothing due";
        return { state, due: `${due}${d.overdue ? " · overdue" : ""}` };
    }
    get tiles() {
        const d = this.d;
        return [
            { kind: "open", t: "Open requests", v: d && d.open, n: `${(d && d.new_need_estimate) || 0} new, need estimate` },
            { kind: "in_progress", t: "In progress", v: d && d.in_progress, tone: "d3-prog", n: "tasks being worked on" },
            { kind: "waiting", t: "Waiting sign-off", v: d && d.waiting_signoff, tone: "d3-wait", n: "delivered, client to approve" },
            { kind: "certified", t: "Certified", v: d && d.certified, tone: "d3-ok", n: "signed off in period" },
            { kind: "hours", t: "Hours used / quoted" },
            { kind: "billing", t: "Billing" },
        ];
    }
    open(kind) { const d = this.d; if (d) this.props.onTile({ kind, client: d.client, range: this.rng, period: this.label }); }
    key(e, kind) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.open(kind); } }
}

/* ---------------- Employees today ---------------- */
class DbEmployeesToday extends Component {
    static props = { people: { optional: true }, arrived: Number, onOpen: Function };
    static components = { DbSkel };
    static template = xml/* xml */`
        <section class="d3-card" aria-labelledby="d3-emp-h">
            <div class="d3-head">
                <h2 id="d3-emp-h">Employees <small>today · live task details</small></h2>
                <span t-if="props.people" class="d3-lbl">Showing <t t-esc="shown.length"/> of <t t-esc="rows.length"/></span>
            </div>
            <DbSkel t-if="!props.people" n="5"/>
            <div t-else="" class="d3-ebody">
                <div class="d3-egrid">
                    <article t-foreach="cards" t-as="p" t-key="p.user_id" t-att-class="'d3-emp s-' + p._s + (p._lvl ? ' t-' + p._lvl : '')" role="button" tabindex="0"
                             t-att-aria-label="openLabel(p)" t-on-click="() => this.props.onOpen(p.user_id)" t-on-keydown="(e) => this.key(e, p.user_id)">
                        <div class="d3-etop">
                            <span class="d3-av"><img class="db-av" t-att-src="avatarUrl(p.user_id)" alt="" loading="lazy"/><i/></span>
                            <div style="min-width:0"><div class="d3-ename" t-esc="p.name"/><div class="d3-erole"><t t-esc="p.role || 'Developer'"/> · <t t-esc="p._since"/></div></div>
                            <span class="d3-badge" t-esc="ST[p._s]"/>
                        </div>
                        <div class="d3-strip"><b t-esc="p._line"/><small t-if="p._sub" t-esc="p._sub"/></div>
                        <div class="d3-tasks">
                            <t t-foreach="p.top_tasks || []" t-as="t" t-key="t.id">
                                <div class="d3-task"><span class="code" t-esc="t.ref || ('#' + t.id)"/><span class="ttl" t-att-title="t.name" t-esc="t.name"/><span t-att-class="'st t-' + t.state" t-esc="TS[t.state] || t.state"/></div>
                                <div t-if="t.state === 'paused' and pauseWhy(t)" class="d3-task-why" t-att-title="pauseWhy(t)">⏸ <t t-esc="pauseWhy(t)"/></div>
                            </t>
                            <div t-if="!(p.top_tasks || []).length" class="d3-task none">No open tasks</div>
                        </div>
                        <div class="d3-efoot" title="Productive time today, out of an 8-hour day">
                            <span>Today <t t-esc="hm(p.productive_today)"/></span>
                            <div class="d3-bar"><i t-att-style="'width:' + p._pct + '%'"/></div>
                            <span><t t-esc="p.done_week || 0"/> done this week</span>
                        </div>
                    </article>
                    <div t-if="compact" class="d3-absent" t-att-aria-label="absentees.length + ' absent'">
                        <span class="d3-absent-h">Absent <em t-esc="absentees.length"/></span>
                        <div class="d3-absent-list">
                            <button t-foreach="absentees" t-as="p" t-key="p.user_id" type="button" class="d3-absent-p" t-att-title="absentTitle(p)" t-on-click="() => this.props.onOpen(p.user_id)">
                                <img class="db-av xs" t-att-src="avatarUrl(p.user_id)" alt="" loading="lazy"/><span t-esc="p.name"/>
                            </button>
                        </div>
                    </div>
                    <div t-if="!shown.length" class="d3-empty">No employees match this filter.</div>
                </div>
                <aside class="d3-filter" aria-label="Employee filter">
                    <div class="t">Status</div>
                    <div class="d3-schips">
                        <button t-foreach="STATUSES" t-as="k" t-key="k" type="button" t-att-class="'d3-schip' + (f.status === k ? ' on' : '')" t-att-aria-pressed="f.status === k ? 'true' : 'false'"
                                t-on-click="() => this.setFilter({ status: k, emp: 'all' })"><t t-esc="k === 'all' ? 'All' : ST[k]"/> <t t-esc="counts[k] || 0"/></button>
                    </div>
                    <div class="t">Employees</div>
                    <div class="d3-elist">
                        <button type="button" t-att-class="'d3-eopt' + (f.emp === 'all' ? ' on' : '')" t-on-click="() => this.setFilter({ emp: 'all', status: 'all' })"><i class="s-all"/><span>All employees</span><em t-esc="rows.length"/></button>
                        <button t-foreach="rows" t-as="p" t-key="p.user_id" type="button" t-att-class="'d3-eopt' + (f.emp === p.user_id ? ' on' : '')" t-on-click="() => this.setFilter({ emp: p.user_id, status: 'all' })">
                            <i t-att-class="'s-' + p._s"/><span t-esc="p.name"/><em t-esc="ST[p._s]"/>
                        </button>
                    </div>
                </aside>
            </div>
        </section>`;

    setup() {
        Object.assign(this, { ST, TS, hm, pauseWhy, avatarUrl, STATUSES: ["all", "working", "break", "lunch", "absent"] });
        this.f = useState(loadLs("kpi.db.emp", { emp: "all", status: "all" }));
        /* Live timers: re-render every minute and add the time since the poll. */
        this.tick = useState({ now: Date.now() });
        onMounted(() => { this.timer = setInterval(() => { this.tick.now = Date.now(); }, 60000); });
        onWillUnmount(() => clearInterval(this.timer));
    }
    setFilter(n) { Object.assign(this.f, n); saveLs("kpi.db.emp", { ...this.f }); }
    get rows() {
        const since0 = this.tick.now - this.props.arrived;
        return (this.props.people || []).map((p) => {
            const r = liveRow(p, since0), s = statusOf(r), [line, sub] = cardText(r, s);
            return { ...r, _s: s, _lvl: timerLevel(r, s), _line: line, _sub: sub, _since: since(r), _pct: Math.min(100, ((r.productive_today || 0) / (8 * 3600)) * 100) };
        }).sort((a, b) => STATUS_ORDER[a._s] - STATUS_ORDER[b._s] || (a.name || "").localeCompare(b.name || ""));
    }
    get counts() { return this.rows.reduce((c, p) => ({ ...c, [p._s]: (c[p._s] || 0) + 1 }), { all: this.rows.length }); }
    get shown() { const f = this.f; return this.rows.filter((p) => (f.emp === "all" || p.user_id === f.emp) && (f.status === "all" || p._s === f.status)); }
    /* Three or more absent: one compact row of faces instead of full cards. */
    get absentees() { return this.shown.filter((p) => p._s === "absent"); }
    get compact() { return this.absentees.length >= 3; }
    get cards() { return this.compact ? this.shown.filter((p) => p._s !== "absent") : this.shown; }
    openLabel(p) { return `Open ${p.name}'s details`; }
    absentTitle(p) { return `${p.name} · ${p.day_done ? "workday ended" : p.attendance === "pending" ? "not checked in yet" : "no workday started"}`; }
    key(e, id) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.props.onOpen(id); } }
}

/* ---------------- the page ---------------- */
export class KpiDashboard extends Component {
    static props = { "*": true };
    static components = { KpiAiAssistant, DbClientDetails, DbEmployeesToday, DbClientTilePopup, DbEmployeePopup };
    static template = xml/* xml */`
    <div t-att-class="'o_kpi_db' + (shown ? '' : ' ai-closed')">
        <div class="o_kpi_db_ai" id="db-ai" t-att-aria-hidden="shown ? 'false' : 'true'" t-att-inert="shown ? undefined : ''"><KpiAiAssistant docked="true"/></div>
        <button type="button" class="db-aitab" t-att-aria-expanded="state.aiOpen ? 'true' : 'false'" aria-controls="db-ai" t-on-click="toggleAi"
                t-att-title="state.aiOpen ? 'Hide the AI Assistant' : 'Show the AI Assistant'">
            <span class="db-aiarrow" aria-hidden="true" t-esc="state.aiOpen ? '◀' : '▶'"/>
            <span class="db-ailabel">AI Assistant</span>
        </button>
        <section class="db-det" aria-label="Clients and employees">
            <div t-if="liveErr" class="d3-err db-error"><span t-esc="liveErr"/><button type="button" class="btn btn-sm btn-secondary" t-on-click="() => this.loadLive()">Try again</button></div>
            <div class="d3-top">
                <DbClientDetails clients="state.clients" onTile="onTile"/>
                <DbEmployeesToday people="people" arrived="state.arrived" onOpen="onOpenPerson"/>
            </div>
        </section>
        <DbClientTilePopup t-if="state.tile" kind="state.tile.kind" client="state.tile.client" range="state.tile.range" period="state.tile.period"
                           onClose="closeTile" onOpen="openAct" onOpenRecord="openRecordFn"/>
        <DbEmployeePopup t-if="openPerson" person="openPerson" onClose="closePerson" onChanged="refreshFn" onOpen="openAct" onOpenRecord="openRecordFn"/>
    </div>`;

    setup() {
        this.action = useService("action");
        this.notification = useService("notification");
        let ai = false;
        try { ai = localStorage.getItem("kpi.db.ai") === "1"; } catch (e) { /* private mode */ }
        this.state = useState({ ov: null, live: null, liveFail: "", clients: null, arrived: Date.now(), aiOpen: ai, narrow: false, tile: null, openId: null });
        this.onTile = (t) => { this.state.tile = t; };
        this.closeTile = () => { this.state.tile = null; };
        this.onOpenPerson = (id) => { this.state.openId = id; };
        this.closePerson = () => { this.state.openId = null; };
        this.refreshFn = () => { this.loadLive(); this.loadOv(); };
        this.openAct = (xmlid) => this.open(xmlid);
        this.openRecordFn = (model, id, fallback) => this.openRecord(model, id, fallback);

        /* Phones stack the page and have no tab: the panel is always there. */
        this.mq = window.matchMedia("(max-width: 900px)");
        this.onMq = () => { this.state.narrow = this.mq.matches; };
        onMounted(() => {
            this.onMq(); this.mq.addEventListener("change", this.onMq);
            this.loadOv(); this.loadLive(); this.loadClients();
            this.ovTimer = setInterval(() => { if (!document.hidden) this.loadOv(); }, 60000);
            this.liveTimer = setInterval(() => { if (!document.hidden) this.loadLive(); }, 30000);
        });
        onWillUnmount(() => {
            this.mq.removeEventListener("change", this.onMq);
            clearInterval(this.ovTimer); clearInterval(this.liveTimer);
        });
    }

    get shown() { return this.state.aiOpen || this.state.narrow; }
    toggleAi() {
        const v = !this.state.aiOpen;
        this.state.aiOpen = v;
        try { localStorage.setItem("kpi.db.ai", v ? "1" : "0"); } catch (e) { /* private mode */ }
    }

    /* ---------------- data */
    async loadOv() {
        try {
            const r = await rpc("/kra_kpi/dashboard/overview", {});
            if (r && r.status) this.state.ov = r;
        } catch (_) { /* per-person hours just stay as they were */ }
    }
    async loadLive() {
        try {
            const r = await rpc("/kpi_owner/live_tracking", {});
            if (r && r.status) { this.state.live = r; this.state.arrived = Date.now(); this.state.liveFail = ""; }
            else this.state.liveFail = (r && r.message) || "Could not load the employees.";
        } catch (e) {
            this.state.liveFail = (e && (e.data?.message || e.message)) || "Could not load the employees.";
        }
    }
    async loadClients() {
        try {
            const r = await rpc("/kpi_owner/certified_by_client", {});
            if (r && r.status) this.state.clients = r.clients || [];
        } catch (_) { /* the rest of the page still shows */ }
    }
    get liveErr() { return this.state.live ? "" : this.state.liveFail; }

    /* Live tracking rows merged with the overview's per-person numbers
       (productive_today, done_week), working people first. */
    get people() {
        const lt = this.state.live, o = this.state.ov;
        if (!lt) return null;
        const stats = new Map(((o && o.people) || []).map((p) => [p.user_id, p]));
        const rank = (r) => (r.activity_kind === "task" ? 0 : r.started ? 1 : r.attendance === "present" || r.attendance === "late" ? 2 : 3);
        return (lt.rows || []).map((r) => ({ ...r, ...(stats.get(r.user_id) || {}), user_id: r.user_id }))
            .sort((a, b) => rank(a) - rank(b) || (a.name || "").localeCompare(b.name || ""));
    }
    /* The live row is looked up on every render, so the popup's header follows the
       30 s poll while it is open. */
    get openPerson() {
        const id = this.state.openId;
        if (!id) return null;
        const p = (this.people || []).find((x) => x.user_id === id);
        return p ? liveRow(p, Date.now() - this.state.arrived) : null;
    }

    open(xmlid) {
        if (!xmlid) return;
        Promise.resolve(this.action.doAction(xmlid)).catch(() => {
            this.notification.add("That screen isn't available for your login.", { type: "warning" });
        });
    }
    openRecord(model, id, fallback) {
        Promise.resolve(this.action.doAction({ type: "ir.actions.act_window", res_model: model, res_id: id, views: [[false, "form"]], target: "current" }))
            .catch(() => this.open(fallback));
    }
}

registry.category("actions").add("kpi_dashboard", KpiDashboard);
