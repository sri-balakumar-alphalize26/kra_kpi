/** @odoo-module **/
import { Component, xml, useState, useRef, onMounted, onWillUnmount, onWillUpdateProps } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";
import { user } from "@web/core/user";
import { KpiAiAssistant, buildPdf, buildDocx, saveBlob, stamp } from "@kra_kpi_module/components/kpi_ai_assistant/kpi_ai_assistant";

/**
 * Dashboard — the Odoo twin of the web Dashboard page (web/components/admin/Dashboard.jsx),
 * the owner's one page in plain words. The 369 AI Assistant is docked on the left
 * and stays put while the details on the right scroll. Every number says in a
 * sentence what it means; charts carry their own labels. Three reads:
 *   /kra_kpi/dashboard/overview      counts and short lists for every area
 *   /kpi_owner/live_tracking         presence and what each person is doing now
 *   /kpi_owner/certified_by_client   per-client sign-off, hours and invoices
 * An answer from the assistant highlights the card it is about. Tiles, alerts and
 * rows open the matching Odoo screens. Owner / Coordinator / System (the routes check it).
 * Keep the texts and green / amber / red rules in step with Dashboard.jsx.
 */

const P = {
    board: "M3 4h5v16H3zM10 4h5v10h-5zM17 4h4v13h-4z", check: "M9 11l3 3 8-8M20 12v6a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h9",
    queue: "M4 4h16v6H4zM4 14h16v6H4z", shield: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z", cash: "M3 6h18v13H3zM3 10h18M7 15h4",
    sign: "M5 12l4 4L19 6", clock: "M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0", live: "M3 12h4l3-8 4 16 3-8h4",
    cal: "M3 5h18v16H3zM3 10h18M8 3v4M16 3v4", bell: "M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 003.4 0",
    doc: "M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5", cert: "M12 15a6 6 0 100-12 6 6 0 000 12zM8.5 13.5L7 22l5-3 5 3-1.5-8.5",
    chart: "M4 20V10M10 20V4M16 20v-7M22 20H2", chat: "M21 12a8 8 0 01-12 7l-6 2 2-5.5A8 8 0 1121 12z",
    refresh: "M3 12a9 9 0 0115-6.7L21 8M21 3v5h-5", download: "M12 3v12M7 10l5 5 5-5M5 21h14",
};

/* Where each tile, alert, row and "›" link goes in Odoo (the web page's routes). */
const ACT = {
    kpi: "kra_kpi_module.action_kpi_action_screen",
    appr: "kra_kpi_module.action_kpi_approval",
    queue: "kra_kpi_module.action_kpi_pending_queue",
    pre: "kra_kpi_module.action_kpi_task_approval",
    bill: "kra_kpi_module.action_kpi_owner_dashboard",
    inv: "kra_kpi_module.action_kpi_client_invoice_admin",
    live: "kra_kpi_module.action_kpi_live_tracking",
    meet: "kra_kpi_module.action_kpi_meeting",
    rem: "kra_kpi_module.action_kpi_reminders",
    docs: "kra_kpi_module.action_task_documents",
    cert: "kra_kpi_module.action_kpi_completion_certificate",
    rep: "kra_kpi_module.action_kpi_period_report",
    wa: "whatsapp_neonize.action_whatsapp_session",
};

const reduceMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
const n0 = (v) => Number(v || 0).toLocaleString("en-IN");
const hm = (secs) => { const m = Math.round((secs || 0) / 60); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`; };
const mins = (secs) => { const m = Math.round((secs || 0) / 60); return m < 60 ? `${m} min` : hm(secs); };
const hours = (secs) => Math.round((secs || 0) / 3600);
const money = (list) => (list || []).map((x) => `${x.symbol || ""}${Number(x.amount || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`).join(" + ");
const amount = (x) => `${x.symbol || ""}${Number(x.amount || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const dayName = (iso, opts = { weekday: "short" }) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", opts);
const shortDate = (iso) => (iso ? dayName(iso, { day: "numeric", month: "short" }) : "");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isAre = (n) => (n === 1 ? "is" : "are");
const taskLabel = (t) => `${t.ref ? `${t.ref} · ` : ""}${t.name}`;
function whenLabel(iso, today) {
    if (!iso) return "";
    if (iso === today) return "Today";
    const t = new Date(`${today}T00:00:00`); t.setDate(t.getDate() + 1);
    const tomorrow = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    return iso === tomorrow ? "Tomorrow" : dayName(iso, { weekday: "short", day: "numeric", month: "short" });
}
const STATUS_WORD = { ok: "All good", warn: "Look soon", bad: "Act now" };
const initials = (name) => String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("") || "?";
const hue = (id) => (Number(id || 0) * 47) % 360;

/* Which card an assistant answer is about (cardFor in Dashboard.jsx). */
function cardFor(res, question) {
    const q = String(question || "").toLowerCase();
    const st = (res && res.context && res.context.statuses) || [];
    if (st.includes("partially_completed") || q.includes("approv")) return "k3";
    if (q.includes("invoice") || q.includes("unpaid")) return "money";
    if (q.includes("client") || q.includes("quote")) return "clients";
    switch (res && res.intent) {
        case "workday": case "leaderboard": case "over_estimate": return "emp";
        case "overdue": return "deadlines";
        case "alerts": return "att";
        case "summary": return "kpis";
        default: break;
    }
    return st.length ? "pipe" : null;
}

/* A number that counts up the first time it arrives (not on every poll). */
class DbCount extends Component {
    static props = { value: { optional: true } };
    static template = xml`<span t-esc="text"/>`;
    setup() {
        this.s = useState({ shown: this.props.value ?? 0 });
        this.done = false;
        onMounted(() => this.go(this.props.value));
        onWillUpdateProps((np) => this.go(np.value));
        onWillUnmount(() => cancelAnimationFrame(this.raf));
    }
    go(value) {
        if (value == null) return;
        if (this.done || reduceMotion()) { cancelAnimationFrame(this.raf); this.s.shown = value; return; }
        this.done = true;
        const t0 = performance.now(), dur = 1100;
        const step = (t) => {
            const p = Math.min(1, (t - t0) / dur);
            this.s.shown = Math.round(value * (1 - Math.pow(1 - p, 3)));
            if (p < 1) this.raf = requestAnimationFrame(step);
        };
        this.raf = requestAnimationFrame(step);
    }
    get text() { return n0(this.s.shown); }
}

class DbIcon extends Component {
    static props = { d: String, size: { type: Number, optional: true } };
    static template = xml`<svg class="db-ic" viewBox="0 0 24 24" t-att-width="props.size || 16" t-att-height="props.size || 16" aria-hidden="true"><path t-att-d="props.d"/></svg>`;
}

/* Grey placeholder lines while a read is on its way. */
class DbSkel extends Component {
    static props = { n: { type: Number, optional: true } };
    static template = xml`<div class="db-skel" aria-hidden="true"><i t-foreach="rows" t-as="r" t-key="r" t-att-style="'width:' + (92 - (r % 3) * 18) + '%'"/></div>`;
    get rows() { return [...Array(this.props.n || 3).keys()]; }
}

const AGES = ["Today", "1 day", "2 days", "3 days", "4+ days"];
const PIPE = [
    ["not_started", "Not started yet", "var(--db-todo)"], ["running", "Being worked on", "var(--db-run)"], ["paused", "Paused", "var(--db-pause)"],
    ["on_hold", "On hold or sent back", "var(--db-hold)"], ["pending_approval", "Waiting for your approval", "var(--db-review)"],
    ["awaiting_client", "Waiting for client sign-off", "var(--db-client)"], ["completed_month", "Completed this month", "var(--db-done)"],
];
const ACTIVITY = { break: "On a break", lunch: "At lunch", meeting: "In a meeting", no_tasks: "No task to work on", idle: "Idle" };

export class KpiDashboard extends Component {
    static props = { "*": true };
    static components = { KpiAiAssistant, DbCount, DbIcon, DbSkel };
    static template = xml/* xml */`
    <div class="o_kpi_db">
        <div class="o_kpi_db_ai"><KpiAiAssistant docked="true" onAnswer="onAnswer"/></div>

        <section class="db-det" aria-label="Business details">
            <div class="db-greet">
                <div>
                    <h1 t-esc="greeting"/>
                    <div class="db-presence">
                        <t t-esc="todayText"/>
                        <span t-if="state.ov and state.ov.as_of" class="db-asof">· numbers as of <t t-esc="state.ov.as_of"/></span>
                        <t t-if="state.live">
                            <span class="db-tag in"><i/><t t-esc="state.live.present_count"/> present</span>
                            <span t-if="state.live.absent_count" class="db-tag out"><i/><t t-esc="state.live.absent_count"/> absent</span>
                            <span t-if="state.live.late_count" class="db-tag late"><i/><t t-esc="state.live.late_count"/> late</span>
                            <span t-if="notInYet" class="db-tag out"><i/><t t-esc="notInYet"/> not in yet</span>
                        </t>
                    </div>
                </div>
                <div class="db-gbtns">
                    <button type="button" class="btn btn-secondary" t-att-class="{ 'db-spin': state.refreshing }" t-att-aria-busy="state.refreshing ? 'true' : undefined" t-on-click="refreshAll"><DbIcon d="P.refresh" size="14"/> Refresh</button>
                    <span class="db-dlwrap" t-ref="dl">
                        <button type="button" class="btn btn-primary" t-att-disabled="!state.ov" t-att-aria-expanded="state.dlOpen ? 'true' : 'false'" t-on-click="toggleDl">
                            <DbIcon d="P.download" size="14"/> Download report
                        </button>
                        <span t-if="state.dlOpen" class="db-dlmenu" role="menu">
                            <button type="button" role="menuitem" t-att-disabled="state.dlBusy" t-on-click="() => this.report('pdf')" t-esc="state.dlBusy === 'pdf' ? 'Preparing…' : 'PDF'"/>
                            <button type="button" role="menuitem" t-att-disabled="state.dlBusy" t-on-click="() => this.report('docx')" t-esc="state.dlBusy === 'docx' ? 'Preparing…' : 'Word (.docx)'"/>
                            <small t-if="state.dlErr" class="db-err" t-esc="state.dlErr"/>
                        </span>
                    </span>
                </div>
            </div>

            <div t-if="state.ovErr" class="db-card db-error">
                <span t-esc="state.ovErr"/>
                <button type="button" class="btn btn-sm btn-secondary" t-on-click="loadOv">Try again</button>
            </div>

            <!-- headline numbers: number, a plain sentence, a labelled chart -->
            <div class="db-kpis" t-ref="kpis" t-att-class="{ 'is-lit': state.lit === 'kpis' }">
                <div class="db-card db-stat" style="animation-delay:.04s">
                    <div class="db-lbl">Completed this week</div>
                    <div class="db-val">
                        <t t-if="h1.has"><DbCount value="h1.week"/></t><t t-else="">…</t><em>tasks</em>
                        <span t-if="h1.delta" t-att-class="'db-delta' + (h1.delta.down ? ' down' : '')" t-esc="h1.delta.text"/>
                    </div>
                    <p t-if="h1.has" class="db-say" t-esc="h1.say"/>
                    <div class="db-spark" aria-hidden="true">
                        <i t-foreach="h1.bars" t-as="b" t-key="b.key" t-att-class="b.cls" t-att-style="b.style" t-att-title="b.title"/>
                    </div>
                    <div class="db-cap">Last 4 weeks, day by day · this week in blue</div>
                </div>
                <div class="db-card db-stat" style="animation-delay:.1s">
                    <div class="db-lbl">Client sign-off waiting</div>
                    <div class="db-val"><t t-if="h2.has"><DbCount value="h2.waiting"/></t><t t-else="">…</t><em>tasks</em></div>
                    <p t-if="h2.has" class="db-say" t-esc="h2.say"/>
                    <div class="db-bar2" aria-hidden="true"><i class="ok" t-att-style="h2.fill"/></div>
                    <div t-if="h2.has" class="db-cap split"><span t-esc="h2.left"/><span t-esc="h2.right"/></div>
                </div>
                <div class="db-card db-stat" style="animation-delay:.16s" t-ref="k3" t-att-class="{ 'is-lit': state.lit === 'k3' }">
                    <div class="db-lbl">Waiting for your approval</div>
                    <div class="db-val"><t t-if="h3.has"><DbCount value="h3.count"/></t><t t-else="">…</t><em>tasks</em></div>
                    <p t-if="h3.has" class="db-say" t-esc="h3.say"/>
                    <div class="db-bar2 stack" aria-hidden="true">
                        <i t-foreach="h3.parts" t-as="s" t-key="s.i" t-att-class="'a' + s.i" t-att-style="s.style" t-att-title="s.title"/>
                    </div>
                    <div class="db-cap ages"><span t-foreach="h3.legend" t-as="l" t-key="l.i"><i t-att-class="'a' + l.i"/><t t-esc="l.label"/> <b t-esc="l.v"/></span></div>
                </div>
                <div class="db-card db-stat" style="animation-delay:.22s">
                    <div class="db-lbl">Team hours this week</div>
                    <div class="db-val"><t t-if="h4.has"><DbCount value="h4.prod"/></t><t t-else="">…</t><em>hours on tasks</em></div>
                    <p t-if="h4.has" class="db-say" t-esc="h4.say"/>
                    <div class="db-bar2" aria-hidden="true"><i class="brand" t-att-style="h4.fill"/></div>
                    <div t-if="h4.has" class="db-cap split"><span>On tasks <t t-esc="h4.pct"/>%</span><span>Not on tasks <t t-esc="100 - h4.pct"/>%</span></div>
                </div>
            </div>

            <!-- every area at a glance -->
            <div class="db-card db-areas" style="animation-delay:.24s">
                <div class="db-ttlrow">
                    <div class="db-ttl">Everything at a glance</div>
                    <div class="db-akey"><span class="db-pill ok">All good</span><span class="db-pill warn">Look soon</span><span class="db-pill bad">Act now</span></div>
                </div>
                <p class="db-intro">Every part of the app in one line. Tap a tile to open it.</p>
                <div t-if="state.ov" class="db-agrid">
                    <button t-foreach="areas" t-as="a" t-key="a.key" type="button" class="db-area" t-att-title="'Open ' + a.title" t-on-click="() => this.open(a.act)">
                        <div class="db-ahead">
                            <span class="db-aic" t-att-style="'--c:' + a.color"><DbIcon d="a.icon" size="14"/></span>
                            <span class="db-aname" t-esc="a.title"/>
                        </div>
                        <div class="db-anumrow">
                            <div class="db-anum"><t t-esc="a.num"/><em t-if="a.unit" t-esc="a.unit"/></div>
                            <span t-att-class="'db-pill ' + a.status" t-esc="STATUS_WORD[a.status]"/>
                        </div>
                        <div class="db-atxt" t-esc="a.text"/>
                    </button>
                </div>
                <DbSkel t-else="" n="4"/>
            </div>

            <!-- trend + pipeline -->
            <div class="db-row2">
                <div class="db-card db-weekly" style="animation-delay:.26s">
                    <div class="db-ttlrow">
                        <div class="db-ttl">Tasks completed per day</div>
                        <div class="db-seg2" role="group" aria-label="Period">
                            <button type="button" t-att-class="state.range === 7 ? 'on' : ''" t-att-aria-pressed="state.range === 7 ? 'true' : 'false'" t-on-click="() => this.setRange(7)">7 days</button>
                            <button type="button" t-att-class="state.range === 28 ? 'on' : ''" t-att-aria-pressed="state.range === 28 ? 'true' : 'false'" t-on-click="() => this.setRange(28)">4 weeks</button>
                        </div>
                    </div>
                    <div class="db-sub"><t t-if="state.ov"><DbCount value="weekly.sum"/></t><t t-else="">…</t><em t-esc="weekly.note"/></div>
                    <div class="db-chart">
                        <div class="db-ylab"><span t-esc="weekly.max"/><span t-esc="weekly.max / 2"/><span>0</span></div>
                        <div t-att-class="'db-bars' + (weekly.wide ? ' wide' : '')" t-on-mouseleave="() => this.state.act = null">
                            <button t-foreach="weekly.bars" t-as="b" t-key="b.date" type="button" t-att-class="'db-bar' + (b.on ? ' act' : '')"
                                    t-on-mouseenter="() => this.state.act = b_index" t-on-focus="() => this.state.act = b_index" t-on-click="() => this.state.act = b_index" t-att-aria-label="b.label">
                                <b t-att-style="b.style"><span t-if="b.on" t-att-class="'db-tip ' + b.tipCls" t-esc="b.tip"/></b>
                                <em t-esc="b.day"/>
                            </button>
                        </div>
                    </div>
                </div>
                <div class="db-card db-pipe" style="animation-delay:.3s" t-ref="pipe" t-att-class="{ 'is-lit': state.lit === 'pipe' }">
                    <div class="db-ttl">Where all tasks stand</div>
                    <p t-if="pipe.has" class="db-intro" t-esc="pipe.say"/>
                    <div t-if="pipe.has" class="db-pbody">
                        <div class="db-donut">
                            <svg viewBox="0 0 300 300" role="img" aria-label="Where all tasks stand">
                                <path t-foreach="pipe.segs" t-as="s" t-key="s.k" t-att-d="s.d" pathLength="1" class="db-seg" t-att-stroke="s.c" t-att-style="s.style"><title t-esc="s.l + ': ' + s.v"/></path>
                            </svg>
                            <div class="db-center"><div><DbCount value="pipe.open"/></div><small>open tasks</small></div>
                        </div>
                        <div class="db-plist">
                            <div t-foreach="pipe.rows" t-as="r" t-key="r.k"><i t-att-style="'background:' + r.c"/><b t-att-title="r.l" t-esc="r.l"/><span t-esc="r.vText"/></div>
                        </div>
                    </div>
                    <DbSkel t-else="" n="5"/>
                </div>
            </div>

            <!-- deadlines -->
            <div class="db-card" style="animation-delay:.32s" t-ref="deadlines" t-att-class="{ 'is-lit': state.lit === 'deadlines' }">
                <div class="db-ttlrow">
                    <div class="db-ttl">Deadlines</div>
                    <a class="db-link" href="#" t-on-click.prevent="() => this.open(ACT.kpi)">Open KPI Actions ›</a>
                </div>
                <p class="db-intro">Work that is late, due soon, or urgent and not yet begun. Tap a task to open it.</p>
                <DbSkel t-if="!state.ov" n="3"/>
                <p t-elif="!deadlineCols" class="db-muted">Deadlines could not be read.</p>
                <div t-else="" class="db-dgrid">
                    <div t-foreach="deadlineCols" t-as="col" t-key="col.key" class="db-dcol">
                        <div t-att-class="'db-dhead' + (col.count ? ' ' + col.tone : '')"><b t-esc="col.countText"/><t t-esc="col.title"/></div>
                        <p class="db-say" t-esc="col.say"/>
                        <button t-foreach="col.rows" t-as="t" t-key="t.id" type="button" class="db-trow" t-on-click="() => this.openTask(t.id)">
                            <span class="db-tname" t-att-title="t.label" t-esc="t.label"/>
                            <small t-esc="t.sub"/>
                        </button>
                        <small t-if="col.more" class="db-more">+<t t-esc="col.more"/> more</small>
                    </div>
                </div>
            </div>

            <!-- employees -->
            <div class="db-card db-emp" style="animation-delay:.34s" t-ref="emp" t-att-class="{ 'is-lit': state.lit === 'emp' }">
                <div class="db-ttlrow">
                    <div class="db-ttl">Employees <small t-if="state.live">as of <t t-esc="state.live.as_of"/></small></div>
                    <a class="db-link" href="#" t-on-click.prevent="() => this.open(ACT.live)">Open Live Tracking ›</a>
                </div>
                <p class="db-intro">What each person is doing right now, and how their work stands.</p>
                <DbSkel t-if="!people" n="5"/>
                <p t-elif="!people.length" class="db-muted">Nobody on the team roster yet.</p>
                <t t-else="">
                    <div class="db-tablewrap">
                        <table class="db-grid">
                            <thead><tr><th>Person</th><th>Doing right now</th><th>Their tasks</th><th class="num">Hours on tasks today</th><th class="num">This week</th><th class="num" title="Their open tasks: hours estimated vs hours already spent">Open tasks: estimated vs spent</th></tr></thead>
                            <tbody>
                                <tr t-foreach="people" t-as="p" t-key="p.user_id">
                                    <td><div class="db-person">
                                        <span class="db-ini"><img class="db-av" t-att-src="'/web/image/res.users/' + p.user_id + '/avatar_128'" alt="" loading="lazy"/><span t-att-class="'db-pd ' + p.dot"/></span>
                                        <div><t t-esc="p.name"/><small t-esc="p.status"/></div>
                                    </div></td>
                                    <td><div class="db-now">
                                        <t t-if="p.now === 'task'"><b>▶ Working on</b> <t t-esc="p.taskNames"/><span t-if="p.forText" class="db-muted"> · for <t t-esc="p.forText"/></span></t>
                                        <t t-elif="p.now === 'pause'"><b class="pause">⏸ <t t-esc="p.pauseLabel"/></b><t t-if="p.forText"> · for <t t-esc="p.forText"/></t><t t-if="p.pauseNote"> · <t t-esc="p.pauseNote"/></t></t>
                                        <span t-elif="p.now === 'ended'" class="db-muted">Workday ended</span>
                                        <span t-else="" class="db-muted">Has not started the workday</span>
                                    </div></td>
                                    <td class="db-tasks">
                                        <span t-if="p.running" class="db-lz run"><t t-esc="p.running"/> running</span>
                                        <span t-if="p.paused" class="db-lz pause"><t t-esc="p.paused"/> paused</span>
                                        <span t-if="p.todo" class="db-lz todo"><t t-esc="p.todo"/> to do</span>
                                        <span t-if="p.approval" class="db-lz appr"><t t-esc="p.approval"/> approval</span>
                                        <span class="db-lz done" title="Finished in the last 7 days"><t t-esc="p.done_week"/> done</span>
                                    </td>
                                    <td class="num" title="Out of an 8-hour day"><t t-esc="p.hours"/><span class="db-hb"><i t-att-style="p.bar"/></span></td>
                                    <td class="num" t-esc="p.week"/>
                                    <td t-att-class="'num db-est' + (p.over ? ' db-over' : '')"><t t-esc="p.est"/>h estimated<small><t t-esc="p.spent"/>h spent<t t-if="p.over"> ▲ over</t></small></td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <p class="db-legend">
                        <span class="db-lz run">running</span> working on it now · <span class="db-lz pause">paused</span> stopped for now ·
                        <span class="db-lz todo">to do</span> not started · <span class="db-lz appr">approval</span> waiting for your OK ·
                        <span class="db-lz done">done</span> finished in the last 7 days · <b class="db-over">red hours</b> more time spent than estimated
                    </p>
                </t>
            </div>

            <!-- clients + attention -->
            <div class="db-row3">
                <div class="db-card db-clients" style="animation-delay:.4s" t-ref="clients" t-att-class="{ 'is-lit': state.lit === 'clients' }">
                    <div class="db-ttlrow">
                        <div class="db-ttl">Clients <small t-if="state.clients"><t t-esc="state.clients.length"/> active</small></div>
                        <a class="db-link" href="#" t-on-click.prevent="() => this.open(ACT.bill)">Open Client Billing ›</a>
                    </div>
                    <p class="db-intro">Clients with the most delivered work waiting for their sign-off come first.</p>
                    <DbSkel t-if="!state.clients" n="5"/>
                    <p t-elif="!state.clients.length" class="db-muted">No clients yet.</p>
                    <div t-else="" class="db-tablewrap">
                        <table class="db-grid db-cgrid">
                            <thead><tr><th>Client · last invoice</th><th class="num">Waiting sign-off</th><th class="num">Signed off</th><th class="num">Open</th><th class="num">Hours used of quoted</th></tr></thead>
                            <tbody>
                                <tr t-foreach="clientRows" t-as="c" t-key="c.client_id">
                                    <td><div class="db-person"><span class="db-cav" t-att-style="'--h:' + c.hue" t-esc="c.ini"/>
                                        <div class="db-cname"><span t-att-title="c.client_name" t-esc="c.client_name"/><small t-esc="c.invoice"/></div></div></td>
                                    <td class="num"><b t-esc="c.awaiting_client_count"/></td>
                                    <td class="num" t-esc="c.completed_count"/>
                                    <td class="num" t-esc="c.in_progress_count"/>
                                    <td t-att-class="'num' + (c.over ? ' db-over' : '')" t-att-title="c.over ? 'More hours used than the client was quoted' : ''" t-esc="c.hoursText"/>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <div class="db-card db-att" style="animation-delay:.44s" t-ref="att" t-att-class="{ 'is-lit': state.lit === 'att' }">
                    <div class="db-ttl">Needs your attention</div>
                    <DbSkel t-if="!state.ov" n="3"/>
                    <p t-elif="!alerts.length" class="db-muted">Nothing needs you right now.</p>
                    <div t-else="" class="db-alist">
                        <button t-foreach="alerts" t-as="a" t-key="a.key" type="button" t-att-class="'db-al ' + a.tone" t-on-click="() => this.open(a.act)">
                            <b t-esc="a.title"/><small t-if="a.text" t-esc="a.text"/><span class="db-act"><t t-esc="a.action"/> ›</span>
                        </button>
                    </div>
                    <div class="db-ttl" style="margin-top:4px">Upcoming meetings</div>
                    <DbSkel t-if="!state.ov" n="2"/>
                    <p t-elif="!meetings.length" class="db-muted">No meetings booked.</p>
                    <t t-else="">
                        <button t-foreach="meetings" t-as="m" t-key="m.id" type="button" class="db-meet" t-on-click="() => this.openMeeting(m.id)">
                            <span class="db-ci"><DbIcon d="P.cal"/></span>
                            <div><h4 t-esc="m.name"/><small t-esc="m.when"/></div>
                        </button>
                    </t>
                </div>
            </div>

            <!-- money + waiting on clients -->
            <div class="db-row3">
                <div class="db-card" style="animation-delay:.48s" t-ref="money" t-att-class="{ 'is-lit': state.lit === 'money' }">
                    <div class="db-ttlrow">
                        <div class="db-ttl">Unpaid invoices</div>
                        <a class="db-link" href="#" t-on-click.prevent="() => this.open(ACT.inv)">Open invoices ›</a>
                    </div>
                    <p class="db-intro" t-esc="unpaid.say"/>
                    <DbSkel t-if="!state.ov" n="4"/>
                    <div t-elif="unpaid.rows.length" class="db-list">
                        <button t-foreach="unpaid.rows" t-as="r" t-key="r.id" type="button" class="db-lrow" t-on-click="() => this.open(ACT.inv)">
                            <span><b t-esc="r.client || '—'"/><small><t t-esc="r.name"/> · sent <t t-esc="r.sent"/></small></span>
                            <span class="db-lr"><b t-esc="r.amt"/><small t-att-class="r.days > 30 ? 'db-over' : ''">open <t t-esc="r.open"/></small></span>
                        </button>
                    </div>
                    <small t-if="unpaid.more" class="db-more">+<t t-esc="unpaid.more"/> more</small>
                </div>
                <div class="db-card" style="animation-delay:.5s">
                    <div class="db-ttl">Waiting on clients</div>
                    <p class="db-intro">New requests to estimate, and estimates the clients have not answered.</p>
                    <DbSkel t-if="!state.ov" n="4"/>
                    <p t-elif="!waiting" class="db-muted">Could not be read.</p>
                    <t t-else="">
                        <div class="db-subh"><span>New requests</span><a class="db-link" href="#" t-on-click.prevent="() => this.open(ACT.queue)">Open the queue ›</a></div>
                        <p t-if="!waiting.queue.length" class="db-muted">No new requests.</p>
                        <div t-else="" class="db-list">
                            <button t-foreach="waiting.queue" t-as="t" t-key="t.id" type="button" class="db-lrow" t-on-click="() => this.open(ACT.queue)">
                                <span><b t-att-title="t.label" t-esc="t.label"/><small t-esc="t.client"/></span><span class="db-lr"><small t-esc="t.when"/></span>
                            </button>
                        </div>
                        <div class="db-subh"><span>Estimates waiting for a reply</span><a class="db-link" href="#" t-on-click.prevent="() => this.open(ACT.pre)">Open ›</a></div>
                        <p t-if="!waiting.pre.length" class="db-muted">No estimates waiting.</p>
                        <div t-else="" class="db-list">
                            <button t-foreach="waiting.pre" t-as="t" t-key="t.id" type="button" class="db-lrow" t-on-click="() => this.open(ACT.pre)">
                                <span><b t-att-title="t.label" t-esc="t.label"/><small t-esc="t.client"/></span><span class="db-lr"><small t-att-class="t.overdue ? 'db-over' : ''" t-esc="t.when"/></span>
                            </button>
                        </div>
                    </t>
                </div>
            </div>
        </section>
    </div>`;

    setup() {
        this.P = P; this.ACT = ACT; this.STATUS_WORD = STATUS_WORD;
        this.action = useService("action");
        this.notification = useService("notification");
        this.state = useState({ ov: null, live: null, clients: null, ovErr: "", grown: false, liveGrown: false, range: 7, act: null, lit: null, dlOpen: false, dlBusy: "", dlErr: "", refreshing: false });
        this.refs = Object.fromEntries(["kpis", "k3", "pipe", "deadlines", "emp", "clients", "att", "money"].map((k) => [k, useRef(k)]));
        this.dlRef = useRef("dl");

        /* Highlight the card an answer is about, and bring it into view. */
        this.onAnswer = (res, question) => {
            const key = cardFor(res, question);
            const ref = key && this.refs[key];
            const el = ref && ref.el;
            if (!el) return;
            this.state.lit = null;
            clearTimeout(this.litT);
            requestAnimationFrame(() => {
                this.state.lit = key;
                this.litT = setTimeout(() => { this.state.lit = null; }, 1800);
            });
            el.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "nearest" });
        };
        this.onDown = (e) => { if (this.state.dlOpen && this.dlRef.el && !this.dlRef.el.contains(e.target)) this.state.dlOpen = false; };

        onMounted(() => {
            this.loadOv(); this.loadLive(); this.loadClients();
            this.ovTimer = setInterval(() => { if (!document.hidden) this.loadOv(); }, 60000);
            this.liveTimer = setInterval(() => { if (!document.hidden) this.loadLive(); }, 30000);
            window.addEventListener("pointerdown", this.onDown);
        });
        onWillUnmount(() => {
            clearInterval(this.ovTimer); clearInterval(this.liveTimer); clearTimeout(this.litT);
            window.removeEventListener("pointerdown", this.onDown);
        });
    }

    /* ---------------- data */
    async loadOv() {
        try {
            const r = await rpc("/kra_kpi/dashboard/overview", {});
            if (r && r.status) {
                this.state.ov = r; this.state.ovErr = "";
                if (!this.state.grown) setTimeout(() => { this.state.grown = true; }, 60);
            } else this.state.ovErr = (r && r.message) || "Could not load the dashboard.";
        } catch (e) {
            if (!this.state.ov) this.state.ovErr = (e && (e.data?.message || e.message)) || "Could not load the dashboard.";
        }
    }
    async loadLive() {
        try {
            const r = await rpc("/kpi_owner/live_tracking", {});
            if (r && r.status) {
                this.state.live = r;
                if (!this.state.liveGrown) setTimeout(() => { this.state.liveGrown = true; }, 60);
            }
        } catch (_) { /* the rest of the page still shows */ }
    }
    async loadClients() {
        try {
            const r = await rpc("/kpi_owner/certified_by_client", {});
            if (r && r.status) this.state.clients = r.clients || [];
        } catch (_) { /* the rest of the page still shows */ }
    }
    /* The icon spins until all three reads are back (at least 500 ms, so a
       fast reload still shows); a click while it spins is ignored. */
    async refreshAll() {
        if (this.state.refreshing) return;
        this.state.refreshing = true;
        const t0 = Date.now();
        await Promise.allSettled([this.loadOv(), this.loadLive(), this.loadClients()]);
        setTimeout(() => { this.state.refreshing = false; }, Math.max(0, 500 - (Date.now() - t0)));
    }
    toggleDl() { this.state.dlOpen = !this.state.dlOpen; this.state.dlErr = ""; }
    setRange(n) { this.state.range = n; this.state.act = null; }

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
    openMeeting(id) { this.openRecord("kpi.meeting", id, ACT.meet); }
    openTask(id) { this.openRecord("kra.kpi", id, ACT.kpi); }

    /* ---------------- greeting */
    get greeting() {
        const hour = new Date().getHours();
        const hello = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
        const first = ((user && user.name) || "").trim().split(" ")[0];
        return first ? `${hello}, ${first}` : hello;
    }
    get todayText() { return new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }); }
    get notInYet() { const lv = this.state.live; return lv ? Math.max(0, lv.total - lv.present_count - lv.absent_count) : 0; }

    /* ---------------- headline cards */
    get h1() {
        const c = this.state.ov && this.state.ov.completed, g = this.state.grown;
        const days = (c && c.days) || [];
        const max = Math.max(4, ...days.map((d) => d.count));
        const delta = c && c.prev_week ? Math.round((c.week / c.prev_week - 1) * 100) : null;
        return {
            has: !!c, week: c ? c.week : 0,
            delta: delta == null ? null : { down: delta < 0, text: `${delta < 0 ? "▼" : "▲"} ${Math.abs(delta)}%` },
            say: !c ? "" : `Finished in the last 7 days, ${c.today} of them today.${delta != null ? ` ${delta < 0 ? "Down" : "Up"} ${Math.abs(delta)}% on the week before.` : ""}${c.month != null ? ` ${n0(c.month)} this month, ${n0(c.prev_month)} last month.` : ""}`,
            bars: days.map((d, i) => ({
                key: d.date, title: `${shortDate(d.date)}: ${d.count}`,
                cls: i === days.length - 1 ? "today" : i >= days.length - 7 ? "hi" : "",
                style: `height:${g ? Math.max(6, (d.count / max) * 100) : 0}%;transition-delay:${i * 16}ms`,
            })),
        };
    }
    get h2() {
        const c = this.state.ov && this.state.ov.clients, g = this.state.grown;
        const total = c ? c.signoff_waiting + c.certified : 0;
        const pct = total ? Math.round((c.certified / total) * 100) : 0;
        return {
            has: !!c, waiting: c ? c.signoff_waiting : 0, fill: `width:${g ? pct : 0}%`,
            say: c ? `Delivered work waiting for the client to sign it off. ${n0(c.certified)} tasks are already signed.` : "",
            left: c ? `${n0(c.certified)} signed (${pct}%)` : "", right: c ? `${n0(c.signoff_waiting)} waiting` : "",
        };
    }
    get h3() {
        const a = this.state.ov && this.state.ov.approvals, g = this.state.grown;
        const ages = (a && a.by_age) || [0, 0, 0, 0, 0];
        const total = ages.reduce((s, v) => s + v, 0) || 1;
        const old = (ages[3] || 0) + (ages[4] || 0);
        return {
            has: !!a, count: a ? a.count : 0,
            say: !a ? "" : a.count
                ? `Finished work waiting for you to check and approve. ${old ? `${old} ${isAre(old)} 3 days old or more; the oldest is ${a.oldest_ref || "a task"} (${plural(a.oldest_days, "day")}).` : "None is older than 2 days."}`
                : "Nothing is waiting for your OK.",
            parts: ages.map((v, i) => ({ i, v, title: `${AGES[i]}: ${v}`, style: `width:${g ? (v / total) * 100 : 0}%` })).filter((s) => s.v > 0),
            legend: AGES.map((label, i) => ({ i, label, v: ages[i] || 0 })),
        };
    }
    get h4() {
        const h = this.state.ov && this.state.ov.hours, g = this.state.grown;
        const pct = h && h.week_presence ? Math.round((h.week_productive / h.week_presence) * 100) : 0;
        return {
            has: !!h, prod: h ? hours(h.week_productive) : 0, pct, fill: `width:${g ? pct : 0}%`,
            say: h ? `The whole team, last 7 days: ${pct}% of the ${hours(h.week_presence)}h they were signed in. Today so far: ${hm(h.today_productive)}.` : "",
        };
    }

    /* ---------------- trend + pipeline */
    get weekly() {
        const o = this.state.ov, g = this.state.grown, range = this.state.range, wide = range > 7;
        const days = ((o && o.completed && o.completed.days) || []).slice(-range);
        const top = Math.max(4, ...days.map((d) => d.count));
        const max = Math.ceil(top / 4) * 4;
        const act = this.state.act;
        const shown = act != null && act < days.length ? act : days.length - 1;
        const last = days.length - 1, edge = wide ? 4 : 1;
        const sum = days.reduce((s, d) => s + d.count, 0);
        const best = days.reduce((b, d) => (d.count > (b ? b.count : -1) ? d : b), null);
        return {
            sum, max, wide,
            note: `${wide ? "in the last 4 weeks" : "in the last 7 days"}${best && best.count > 0 ? ` · best day: ${dayName(best.date, wide ? { day: "numeric", month: "short" } : { weekday: "long" })} with ${best.count}` : ""}`,
            bars: days.map((d, i) => ({
                date: d.date, on: i === shown,
                day: wide ? (i % 7 === 6 || i === 0 ? shortDate(d.date) : "") : dayName(d.date),
                label: `${dayName(d.date, { weekday: "long", day: "numeric", month: "short" })}: ${d.count} completed`,
                style: `height:${g ? (d.count / max) * 100 : 0}%;transition-delay:${i * (wide ? 20 : 80)}ms`,
                tip: `${d.count} completed · ${i === last ? "today" : shortDate(d.date)}`,
                tipCls: i >= days.length - edge ? "end" : i < edge ? "start" : "",
            })),
        };
    }
    get pipe() {
        const p = this.state.ov && this.state.ov.pipeline, g = this.state.grown;
        if (!p) return { has: false, segs: [], rows: [], open: 0, say: "" };
        const rows = PIPE.map(([k, l, c]) => ({ k, l, c, v: p[k] || 0 }));
        const total = rows.reduce((s, r) => s + r.v, 0) || 1;
        const open = rows.filter((r) => r.k !== "completed_month").reduce((s, r) => s + r.v, 0);
        const shownRows = rows.filter((r) => r.v > 0);
        const gap = shownRows.length > 1 ? 10 : 0;
        const pt = (a) => [150 + 108 * Math.cos(((a - 90) * Math.PI) / 180), 150 + 108 * Math.sin(((a - 90) * Math.PI) / 180)];
        let a0 = gap / 2;
        const segs = shownRows.map((r, i) => {
            const span = Math.min(359.9, Math.max(4, (r.v / total) * (360 - gap * shownRows.length)));
            const a1 = a0 + span, [x1, y1] = pt(a0), [x2, y2] = pt(a1);
            const d = `M${x1.toFixed(1)} ${y1.toFixed(1)} A108 108 0 ${span > 180 ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
            a0 = a1 + gap;
            return { ...r, d, style: `stroke-dashoffset:${g ? 0 : 1};transition-delay:${300 + i * 120}ms` };
        });
        return {
            has: true, open, segs, rows: rows.map((r) => ({ ...r, vText: n0(r.v) })),
            say: `${n0(open)} tasks are still open; ${n0(p.completed_month)} were completed this month.`,
        };
    }

    /* ---------------- deadlines */
    get deadlineCols() {
        const d = this.state.ov && this.state.ov.deadlines;
        if (!d) return null;
        const col = (key, title, data, say, empty, tone, extra) => ({
            key, title, tone, count: (data && data.count) || 0, countText: data ? n0(data.count) : "…",
            say: data ? (data.count ? say(data.count) : empty) : "",
            rows: ((data && data.rows) || []).map((t) => ({ id: t.id, label: taskLabel(t), sub: `${t.person} · ${extra(t)}` })),
            more: data && data.count > (data.rows || []).length ? data.count - data.rows.length : 0,
        });
        return [
            col("late", "overdue", d.overdue, (n) => `${plural(n, "task")} ${isAre(n)} past the deadline and not finished.`, "No overdue tasks.", "bad", (t) => `${plural(t.days, "day")} late`),
            col("soon", "due in the next 7 days", d.due_week, (n) => `${plural(n, "task")} must be finished within a week.`, "Nothing is due in the next 7 days.", "warn", (t) => `due ${shortDate(t.due)}`),
            col("urgent", "urgent, not started", d.urgent, (n) => `${plural(n, "urgent task")} ${n === 1 ? "has" : "have"} not been started yet.`, "Every urgent task has been started.", "bad", (t) => `waiting ${plural(t.days, "day")}`),
        ];
    }

    /* ---------------- employees: Live Tracking's roster joined with the overview's
       per-person counts. Working people first, then present, then the rest. */
    get rawPeople() {
        const lv = this.state.live, o = this.state.ov;
        if (!lv) return null;
        const stats = new Map(((o && o.people) || []).map((p) => [p.user_id, p]));
        const rank = (r) => (r.activity_kind === "task" ? 0 : r.started ? 1 : r.attendance === "present" || r.attendance === "late" ? 2 : 3);
        return (lv.rows || []).map((r) => ({ ...r, ...(stats.get(r.user_id) || {}), user_id: r.user_id }))
            .sort((a, b) => rank(a) - rank(b) || (a.name || "").localeCompare(b.name || ""));
    }
    get people() {
        const raw = this.rawPeople, g = this.state.liveGrown;
        if (!raw) return null;
        return raw.map((p) => {
            const pct = Math.min(100, ((p.productive_today || 0) / (8 * 3600)) * 100);
            return {
                user_id: p.user_id, name: p.name,
                status: p.attendance === "present" ? `In since ${p.arrival}` : p.attendance === "late" ? `Late · in at ${p.arrival}` : p.attendance === "absent" ? "Absent today" : "Not in yet",
                dot: { present: "in", late: "late" }[p.attendance] || "out",
                now: p.activity_kind === "task" ? "task" : p.started ? "pause" : p.day_done ? "ended" : "none",
                taskNames: (p.active_tasks || []).map((t) => t.name).join(", "), forText: p.elapsed_seconds ? mins(p.elapsed_seconds) : "",
                pauseLabel: ACTIVITY[p.activity_kind] || p.activity_label || "Paused", pauseNote: p.activity_note || "",
                running: p.running || 0, paused: p.paused || 0, todo: p.todo || 0, approval: p.approval || 0, done_week: p.done_week || 0,
                hours: hm(p.productive_today), week: hm(p.productive_week), bar: `width:${g ? pct : 0}%`,
                est: p.est_hours || 0, spent: p.spent_hours || 0, over: p.est_hours > 0 && p.spent_hours > p.est_hours,
            };
        });
    }

    /* ---------------- clients */
    get overQuote() {
        return (this.state.clients || []).filter((c) => c.total_quoted_hours > 0 && c.total_actual_hours > c.total_quoted_hours)
            .sort((a, b) => b.total_actual_hours / b.total_quoted_hours - a.total_actual_hours / a.total_quoted_hours);
    }
    get sortedClients() {
        return (this.state.clients || []).slice().sort((a, b) => b.awaiting_client_count - a.awaiting_client_count || b.completed_count - a.completed_count);
    }
    get clientRows() {
        return this.sortedClients.slice(0, 8).map((c) => {
            const over = c.total_quoted_hours > 0 && c.total_actual_hours > c.total_quoted_hours;
            return {
                ...c, over, ini: initials(c.client_name), hue: hue(c.client_id),
                hoursText: `${Math.round(c.total_actual_hours)}h of ${Math.round(c.total_quoted_hours)}h${over ? ` ▲${Math.round((c.total_actual_hours / c.total_quoted_hours - 1) * 100)}% over` : ""}`,
                invoice: c.last_invoice_name ? `${c.last_invoice_name} · ${c.last_invoice_state}` : "No invoice yet",
            };
        });
    }

    /* ---------------- money + waiting on clients */
    get unpaid() {
        const b = this.state.ov && this.state.ov.billing;
        const rows = (b && b.unpaid_rows) || [];
        const count = ((b && b.unpaid) || []).reduce((s, x) => s + x.count, 0);
        return {
            say: !b ? "" : count ? `${plural(count, "invoice")} not paid yet, ${money(b.unpaid)} in all. Oldest first.` : "Every invoice is paid.",
            rows: rows.map((r) => ({ ...r, sent: shortDate(r.date), amt: amount(r), open: plural(r.days, "day") })),
            more: count > rows.length ? count - rows.length : 0,
        };
    }
    get waiting() {
        const o = this.state.ov, w = o && o.waiting_on_clients;
        if (!w) return null;
        return {
            queue: (w.queue || []).map((t) => ({ id: t.id, label: taskLabel(t), client: t.client || "No client", when: whenLabel(t.date, o.today) })),
            pre: (w.pre_approvals || []).map((t) => ({ id: t.id, label: taskLabel(t), client: t.client || "No client", overdue: !!t.overdue,
                when: t.reply_by ? `${t.overdue ? "reply was due" : "reply by"} ${shortDate(t.reply_by)}` : "no reply date" })),
        };
    }

    /* ---------------- areas + alerts */
    get areas() {
        const o = this.state.ov, lv = this.state.live;
        if (!o) return [];
        const today = o.today;
        const p = o.pipeline || {}, c = o.clients || {}, a = o.approvals || {}, h = o.hours || {}, b = o.billing || {}, m = o.meetings || {};
        const unpaid = (b.unpaid || []).reduce((s, x) => s + x.count, 0);
        const onBreak = lv ? (lv.rows || []).filter((r) => r.started && r.activity_kind !== "task").length : 0;
        const working = lv ? (lv.rows || []).filter((r) => r.activity_kind === "task").length : 0;
        const prodPct = h.week_presence ? Math.round((h.week_productive / h.week_presence) * 100) : 0;
        const open = (p.not_started || 0) + (p.running || 0) + (p.paused || 0) + (p.on_hold || 0);
        const next = m.upcoming && m.upcoming[0];
        const wa = o.whatsapp || {};
        return [
            { key: "kpi", title: "KPI Actions", icon: P.board, color: "#1E40AF", act: ACT.kpi, num: n0(open), unit: "open tasks",
                text: `${p.running || 0} being worked on now, ${p.paused || 0} paused, ${(o.completed && o.completed.today) ?? 0} finished today.`, status: p.paused > 0 ? "warn" : "ok" },
            { key: "appr", title: "Approvals", icon: P.check, color: "#6D28D9", act: ACT.appr, num: n0(a.count), unit: "waiting",
                text: a.count ? `Finished tasks waiting for you to check and approve. The oldest has waited ${plural(a.oldest_days, "day")}.` : "Nothing is waiting for your OK.",
                status: a.oldest_days >= 3 ? "bad" : a.count ? "warn" : "ok" },
            { key: "queue", title: "Client Task Queue", icon: P.queue, color: "#0891B2", act: ACT.queue, num: n0(c.queue), unit: "new requests",
                text: c.queue ? "New requests from clients need an estimate before work can start." : "No new client requests.", status: c.queue ? "warn" : "ok" },
            { key: "pre", title: "Client Pre-Approvals", icon: P.shield, color: "#0F766E", act: ACT.pre, num: n0(c.pre_approvals), unit: "estimates out",
                text: c.pre_approvals ? "Estimates sent to clients. They have not replied yet." : "No estimate is waiting for a client's reply.", status: "ok" },
            { key: "bill", title: "Client Billing", icon: P.cash, color: "#16A34A", act: ACT.bill, num: money(b.month) || "0", unit: "invoiced this month",
                text: `${(b.prev_month || []).length ? `${money(b.prev_month)} last month. ` : ""}${unpaid ? `${money(b.unpaid)} is still unpaid on ${plural(unpaid, "invoice")}.` : "Every invoice is paid."}`, status: unpaid ? "warn" : "ok" },
            { key: "sign", title: "Client sign-off", icon: P.sign, color: "#0891B2", act: ACT.bill, num: n0(c.signoff_waiting), unit: "waiting",
                text: "Delivered tasks waiting for the client to sign them off.", status: c.signoff_waiting ? "warn" : "ok" },
            { key: "att", title: "Attendance", icon: P.clock, color: "#16A34A", act: ACT.live, num: lv ? `${lv.present_count} of ${lv.total}` : "…", unit: "in today",
                text: lv ? `${lv.absent_count} absent and ${lv.late_count} came in late today.` : "Loading…", status: lv && lv.absent_count ? "warn" : "ok" },
            { key: "live", title: "Live Tracking", icon: P.live, color: "#2563EB", act: ACT.live, num: lv ? String(working) : "…", unit: "working now",
                text: `${plural(working, "person", "people")} on a task right now. ${onBreak} on a break or idle.`, status: "ok" },
            { key: "meet", title: "Meetings", icon: P.cal, color: "#D97706", act: ACT.meet, num: n0(m.today), unit: "today",
                text: next ? `Next: ${next.name}, ${whenLabel(next.date, today).toLowerCase()} at ${next.time}.` : "No meetings booked.", status: "ok" },
            { key: "rem", title: "Reminders", icon: P.bell, color: "#DC2626", act: ACT.rem, num: o.reminders_today == null ? "—" : n0(o.reminders_today), unit: "due today",
                text: o.reminders_today ? "Reminders set by the team that ring today." : "No reminders ring today.", status: o.reminders_today ? "warn" : "ok" },
            { key: "docs", title: "Documents", icon: P.doc, color: "#1E40AF", act: ACT.docs, num: o.documents_week == null ? "—" : n0(o.documents_week), unit: "this week",
                text: "Files uploaded to tasks in the last 7 days.", status: "ok" },
            { key: "cert", title: "Certificates", icon: P.cert, color: "#6D28D9", act: ACT.cert, num: n0(c.certificates_week), unit: "signed this week",
                text: "Completion certificates signed by clients in the last 7 days.", status: "ok" },
            { key: "rep", title: "Time on tasks", icon: P.chart, color: "#0F766E", act: ACT.rep, num: `${prodPct}%`, unit: "this week",
                text: "Share of the team's signed-in time this week that went on tasks.", status: h.week_presence && prodPct < 50 ? "warn" : "ok" },
            { key: "wa", title: "WhatsApp", icon: P.chat, color: "#16A34A", act: ACT.wa, num: wa.connected == null ? "—" : wa.connected ? "Connected" : "Not connected", unit: "",
                text: wa.connected === false ? "Messages to clients won't go out until it is connected." : `${plural(wa.client_groups || 0, "client group")} linked.`, status: wa.connected === false ? "bad" : "ok" },
        ];
    }
    get alerts() {
        const o = this.state.ov, lv = this.state.live;
        if (!o) return [];
        const out = [];
        const late = o.deadlines && o.deadlines.overdue;
        if (late && late.count) out.push({ key: "late", tone: "bad", act: ACT.kpi, action: "See overdue tasks",
            title: `${plural(late.count, "task")} ${isAre(late.count)} past the deadline`, text: late.rows && late.rows[0] ? `Most late: ${taskLabel(late.rows[0])} · ${plural(late.rows[0].days, "day")}` : "" });
        const overQuote = this.overQuote;
        const top = overQuote[0];
        if (top) out.push({ key: "quote", tone: "bad", act: ACT.bill, action: "Open Client Billing",
            title: `${top.client_name} has used ${Math.round((top.total_actual_hours / top.total_quoted_hours - 1) * 100)}% more hours than quoted`,
            text: `${Math.round(top.total_actual_hours)}h used of ${Math.round(top.total_quoted_hours)}h quoted${overQuote.length > 1 ? ` · ${overQuote.length - 1} more client${overQuote.length > 2 ? "s" : ""} over quote` : ""}` });
        const a = o.approvals;
        if (a && a.count) out.push({ key: "appr", tone: a.oldest_days >= 3 ? "bad" : "rev", act: ACT.appr, action: "Approve now",
            title: `${plural(a.count, "finished task")} ${isAre(a.count)} waiting for your approval`, text: `Oldest: ${a.oldest_ref || "a task"}, waiting ${plural(a.oldest_days, "day")}` });
        if (o.doubts_open) out.push({ key: "doubts", tone: "rev", act: ACT.appr, action: "Answer",
            title: `${plural(o.doubts_open, "developer question")} ${o.doubts_open === 1 ? "waits" : "wait"} for an answer`, text: "Asked to a manager and not answered yet" });
        const urgent = o.deadlines && o.deadlines.urgent;
        if (urgent && urgent.count) out.push({ key: "urgent", tone: "bad", act: ACT.kpi, action: "See urgent tasks",
            title: `${plural(urgent.count, "urgent task")} not started`, text: urgent.rows && urgent.rows[0] ? taskLabel(urgent.rows[0]) : "" });
        const p = o.paused;
        if (p && p.count) out.push({ key: "paused", tone: "warn", act: ACT.kpi, action: "See paused tasks",
            title: `${plural(p.count, "task")} ${isAre(p.count)} paused${p.two_days ? `, ${p.two_days} of them for 2 days or more` : ""}`, text: p.top_person ? `Most are with ${p.top_person} (${p.top_count})` : "" });
        if (lv && lv.absent_count) {
            const names = (lv.rows || []).filter((r) => r.attendance === "absent").map((r) => r.name);
            out.push({ key: "absent", tone: "warn", act: ACT.live, action: "See attendance",
                title: `${plural(lv.absent_count, "person", "people")} ${lv.absent_count === 1 ? "has" : "have"} not started the workday`,
                text: names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "") });
        }
        if (o.clients && o.clients.queue) out.push({ key: "queue", tone: "rev", act: ACT.queue, action: "Open the queue",
            title: `${plural(o.clients.queue, "client request")} ${o.clients.queue === 1 ? "needs" : "need"} an estimate`, text: "In the Client Task Queue" });
        return out.slice(0, 5);
    }
    get meetings() {
        const o = this.state.ov;
        return ((o && o.meetings && o.meetings.upcoming) || []).map((m) => ({
            id: m.id, name: m.name,
            when: `${whenLabel(m.date, o.today)} · ${m.time}${m.people && m.people.length ? ` · ${m.people.join(", ")}` : ""}`,
        }));
    }

    /* ---------------- download (same PDF / Word builder as the assistant) */
    reportBlocks() {
        const o = this.state.ov, lv = this.state.live, people = this.rawPeople, clientRows = this.sortedClients, alerts = this.alerts;
        const h = o.hours || {};
        const blocks = [{ type: "stats", items: [
            { label: "Completed this week", value: (o.completed && o.completed.week) ?? 0 },
            { label: "Completed this month", value: (o.completed && o.completed.month) ?? 0 },
            { label: "Waiting for your approval", value: (o.approvals && o.approvals.count) ?? 0 },
            { label: "Client sign-off waiting", value: (o.clients && o.clients.signoff_waiting) ?? 0 },
            { label: "In today", value: lv ? `${lv.present_count} of ${lv.total}` : "-" },
            { label: "Hours on tasks this week", value: `${hours(h.week_productive)}h` },
        ] }];
        if (alerts.length) blocks.push({ type: "list", title: "Needs your attention", items: alerts.map((a) => `${a.title}${a.text ? ` - ${a.text}` : ""}`) });
        const p = o.pipeline || {};
        blocks.push({ type: "table", title: "Where all tasks stand", columns: [{ key: "l", label: "Status" }, { key: "v", label: "Tasks", kind: "num" }],
            rows: PIPE.map(([k, l]) => ({ l, v: p[k] || 0 })) });
        const d = o.deadlines;
        const dl = [...((d && d.overdue && d.overdue.rows) || []).map((t) => ({ ...t, kind: "Overdue", when: `${plural(t.days, "day")} late` })),
            ...((d && d.due_week && d.due_week.rows) || []).map((t) => ({ ...t, kind: "Due this week", when: shortDate(t.due) })),
            ...((d && d.urgent && d.urgent.rows) || []).map((t) => ({ ...t, kind: "Urgent, not started", when: `waiting ${plural(t.days, "day")}` }))];
        if (dl.length) blocks.push({ type: "table", title: "Deadlines", columns: [{ key: "kind", label: "What" }, { key: "task", label: "Task" }, { key: "person", label: "Person" }, { key: "when", label: "When" }],
            rows: dl.map((t) => ({ ...t, task: taskLabel(t) })) });
        if (people && people.length) blocks.push({ type: "table", title: "Employees", columns: [
            { key: "name", label: "Person" }, { key: "att", label: "Today" }, { key: "running", label: "Running", kind: "num" }, { key: "paused", label: "Paused", kind: "num" },
            { key: "todo", label: "To do", kind: "num" }, { key: "done_week", label: "Done (7 days)", kind: "num" }, { key: "hrs", label: "Hours today", kind: "num" }, { key: "wk", label: "Hours this week", kind: "num" },
        ], rows: people.map((x) => ({ ...x, att: x.arrival ? `${x.attendance} ${x.arrival}` : x.attendance, hrs: hm(x.productive_today), wk: hm(x.productive_week),
            running: x.running || 0, paused: x.paused || 0, todo: x.todo || 0, done_week: x.done_week || 0 })) });
        if (clientRows.length) blocks.push({ type: "table", title: "Clients", columns: [
            { key: "client_name", label: "Client" }, { key: "awaiting_client_count", label: "Waiting sign-off", kind: "num" }, { key: "completed_count", label: "Signed off", kind: "num" },
            { key: "in_progress_count", label: "Open", kind: "num" }, { key: "hrs", label: "Hours used of quoted", kind: "num" },
        ], rows: clientRows.map((c) => ({ ...c, hrs: `${Math.round(c.total_actual_hours)}h of ${Math.round(c.total_quoted_hours)}h` })) });
        const unpaid = (o.billing && o.billing.unpaid_rows) || [];
        if (unpaid.length) blocks.push({ type: "table", title: "Unpaid invoices", columns: [{ key: "name", label: "Invoice" }, { key: "client", label: "Client" }, { key: "amt", label: "Amount", kind: "num" }, { key: "open", label: "Open for" }],
            rows: unpaid.map((r) => ({ ...r, amt: amount(r), open: plural(r.days, "day") })) });
        return blocks;
    }
    async report(kind) {
        if (!this.state.ov || this.state.dlBusy) return;
        this.state.dlBusy = kind; this.state.dlErr = "";
        try {
            const title = `Dashboard - ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`;
            const sections = [{ question: "Dashboard", res: { title, blocks: this.reportBlocks(), intent: "summary" } }];
            const meta = { user: user && user.name, subtitle: "Dashboard report", name: "dashboard" };
            const blob = kind === "pdf" ? buildPdf(sections, meta) : await buildDocx(sections, meta);
            saveBlob(blob, `369-AI-dashboard-${stamp()}.${kind}`);
            this.state.dlOpen = false;
        } catch (e) {
            this.state.dlErr = (e && e.message) || "Download failed.";
        } finally { this.state.dlBusy = ""; }
    }
}

registry.category("actions").add("kpi_dashboard", KpiDashboard);
