/** @odoo-module **/
// KRA / KPI › Client Talks: 💬 Discussions · 📅 Meetings · ❓ Questions.
// Routes: controllers/kpi_talks_api.py, which also groups the talk by date and
// into sessions (a new session after more than 60 minutes of quiet).
// KpiMeetingCard is shared with KPI details (kpi_action.js › 📅 Meetings).
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";

// One colour per session in a day, in turn: blue, amber, green, violet.
export const TALK_COLOURS = [
    { bar: "#2F6FDB", band: "#EAF1FD", text: "#1D4FA8" },
    { bar: "#B45309", band: "#FDF3E4", text: "#8A4108" },
    { bar: "#15803D", band: "#E8F6EE", text: "#0F5E2D" },
    { bar: "#7C3AED", band: "#F1EBFD", text: "#5B21B6" },
];
const STATE_BADGE = {
    requested: "text-bg-warning", confirmed: "text-bg-primary", live: "text-bg-danger",
    done: "text-bg-success", cancelled: "text-bg-secondary",
};

// Where the Meetings screen remembers Full / Compact (this browser only).
const VIEW_KEY = "kpi_talks_meetings_view";

function colour(i) {
    return TALK_COLOURS[i % TALK_COLOURS.length];
}

// Open a task's KPI details on the board, or a General chat (hidden GEN task).
function openOnBoard(action, row) {
    const ctx = row.is_general
        ? { open_chat_kpi_id: row.kpi_id, open_chat_ref: row.ref, open_chat_client: row.client }
        : { open_kpi_id: row.kpi_id };
    return action.doAction("kra_kpi_module.action_kpi_action_screen", { additionalContext: ctx });
}

// ---------------------------------------------------------------------------
// One meeting with everything saved on it.
// ---------------------------------------------------------------------------
export class KpiMeetingCard extends Component {
    static props = { meeting: Object, onOpen: { type: Function, optional: true }, colour: { type: Object, optional: true },
                     dayLabel: { type: String, optional: true }, startOpen: { type: Boolean, optional: true } };
    static template = xml`
        <div class="border rounded-3 bg-white px-3 py-2 mb-2" t-att-style="'box-shadow: inset 5px 0 0 ' + (props.colour ? props.colour.bar : '#7C3AED') + ';'">
            <t t-set="m" t-value="props.meeting"/>
            <!-- Closed by default: date, time, task and status; tap to see everything. -->
            <div class="d-flex align-items-center flex-wrap gap-2" t-att-class="ui.open ? 'mb-2' : ''" style="cursor:pointer;"
                 role="button" t-att-aria-expanded="ui.open ? 'true' : 'false'" t-on-click="() => { this.ui.open = !this.ui.open; }">
                <i t-att-class="'fa ' + (ui.open ? 'fa-chevron-down' : 'fa-chevron-right') + ' text-muted'"/>
                <b t-if="props.dayLabel" class="fs-6" t-esc="props.dayLabel"/>
                <b class="fs-6" t-esc="m.when"/>
                <span t-if="m.minutes" class="small text-muted">· <t t-esc="m.minutes"/> min</span>
                <span t-if="m.ref" class="badge text-bg-light border" t-esc="m.ref"/>
                <b class="small" t-esc="m.title or m.name"/>
                <span t-if="m.title and m.name !== m.title" class="small text-muted">· <t t-esc="m.name"/></span>
                <span t-att-class="'badge ' + (state_badge[m.state] or 'text-bg-light')" t-esc="m.state_label"/>
                <span t-if="m.internal" class="badge text-bg-dark">Internal</span>
                <span class="ms-auto d-flex gap-2">
                    <button t-if="m.can_join" class="btn btn-sm btn-primary" t-on-click.stop="() => this.join()">
                        <i class="fa fa-video-camera me-1"/>Join meeting</button>
                    <button t-if="props.onOpen and m.kpi_id" class="btn btn-sm btn-link p-0" t-on-click.stop="() => props.onOpen(m)">
                        <t t-if="m.is_general">💬 Open chat</t><t t-else="">↗ Open task</t></button>
                </span>
            </div>
            <div t-if="ui.error" class="alert alert-warning py-1 small mt-2" t-esc="ui.error"/>
            <div t-if="ui.open" class="row g-3">
                <div class="col-lg-4">
                    <div class="small text-muted mb-2">
                        <t t-if="m.local_when"><t t-esc="m.local_when"/><br/></t>
                        Organizer <b class="text-body" t-esc="m.organizer or 'nobody yet'"/><br/>
                        <t t-if="m.asked_by">Asked by <t t-esc="m.asked_by"/> (client)<br/></t>
                        <t t-if="m.client">Client <t t-esc="m.client"/><t t-if="m.db"> · <t t-esc="m.db"/></t><br/></t>
                        <t t-if="m.booked">Booked <t t-esc="m.booked"/></t>
                    </div>
                    <div class="border rounded overflow-hidden">
                        <div class="bg-light px-2 py-1 small fw-semibold text-muted">👥 Attendance</div>
                        <div t-if="!m.attendance.length" class="px-2 py-1 small text-muted">Nobody joined yet.</div>
                        <div t-foreach="m.attendance" t-as="p" t-key="p_index" class="d-flex px-2 py-1 small border-top">
                            <span><t t-esc="p.name"/><t t-if="!p.staff"> (client)</t></span>
                            <span class="ms-auto text-muted">
                                <t t-if="p.absent">❌ absent</t>
                                <t t-else=""><t t-if="p.joined"><t t-esc="p.joined"/> – <t t-esc="p.left or 'now'"/> · </t><t t-esc="p.minutes"/> min<t t-if="p.removed"> ⚠️</t></t>
                            </span>
                        </div>
                    </div>
                </div>
                <div class="col-lg-4">
                    <div class="bg-light rounded p-2 small mb-2" style="white-space: pre-wrap;"><b>📝 Summary</b><br/><t t-if="m.summary" t-esc="m.summary"/><span t-else="" class="text-muted">No summary yet.</span></div>
                    <div class="bg-light rounded p-2 small" style="white-space: pre-wrap;"><b>✅ Action items</b><br/><t t-if="m.action_items" t-esc="m.action_items"/><span t-else="" class="text-muted">None written.</span></div>
                    <div t-if="m.notes" class="small text-muted mt-2" style="white-space: pre-wrap;">🔒 <t t-esc="m.notes"/></div>
                </div>
                <div class="col-lg-4">
                    <div class="border rounded p-2 mb-2">
                        <b class="small">🎧 Recording</b>
                        <div t-if="!m.recordings.length" class="small text-muted">No recording.</div>
                        <div t-foreach="m.recordings" t-as="r" t-key="r.id" class="mt-1">
                            <audio controls="controls" preload="none" class="w-100" t-att-src="r.url"/>
                            <a class="small" t-att-href="r.url + '?download=true'" t-esc="r.name"/>
                        </div>
                    </div>
                    <div class="border rounded p-2 small">
                        <b>💬 Transcript</b>
                        <div t-if="!m.transcript" class="text-muted">No transcript.</div>
                        <t t-else="">
                            <div t-att-style="ui.full ? 'white-space: pre-wrap; max-height: 360px; overflow:auto;' : 'white-space: pre-wrap; max-height: 4.5em; overflow:hidden;'" t-esc="m.transcript"/>
                            <button class="btn btn-link btn-sm p-0" t-on-click="() => { this.ui.full = !this.ui.full; }"
                                    t-esc="ui.full ? '▴ Show less' : '▸ Show full transcript'"/>
                        </t>
                    </div>
                </div>
            </div>
        </div>`;

    setup() {
        this.ui = useState({ open: !!this.props.startOpen, full: false, error: "" });
        this.state_badge = STATE_BADGE;
    }

    async join() {
        this.ui.error = "";
        try {
            const r = await rpc("/kpi_meeting/my_link", { meeting_id: this.props.meeting.id });
            if (r && r.status && r.url) {
                window.open(r.url, "_blank");
            } else {
                this.ui.error = (r && r.message) || "Could not open the meeting.";
            }
        } catch (e) {
            this.ui.error = "Could not open the meeting.";
        }
    }
}

// Meetings grouped by date: shared by Client Talks › Meetings and KPI details.
export class KpiMeetingDays extends Component {
    static components = { KpiMeetingCard };
    static props = { days: Array, onOpen: { type: Function, optional: true }, compact: { type: Boolean, optional: true } };
    static template = xml`
        <div>
            <t t-foreach="props.days" t-as="day" t-key="day.date">
                <div class="d-flex align-items-center gap-2 small fw-semibold text-muted my-2">
                    <span class="flex-grow-1 border-top"/><t t-esc="day.label"/><t t-if="day.upcoming"> · upcoming</t><span class="flex-grow-1 border-top"/>
                </div>
                <t t-foreach="day.meetings" t-as="m" t-key="m.id">
                    <KpiMeetingCard meeting="m" onOpen="props.onOpen" colour="colourOf(m_index)" dayLabel="day.label" startOpen="!props.compact"/>
                </t>
            </t>
        </div>`;
    colourOf(i) {
        return colour(i + 3);
    }
}

// The chat of one task, by date, then coloured sessions.
export class KpiTalkThread extends Component {
    static props = { days: Array };
    static template = xml`
        <div>
            <!-- A tapped photo opens here, over the page, as in the task chat. -->
            <div t-if="photo.f" class="position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center"
                 style="background:rgba(11,20,26,.94); z-index:2200;" t-on-click.self="() => this.closePhoto()">
                <div class="position-absolute top-0 start-0 end-0 d-flex align-items-center gap-3 px-3 py-2 text-white">
                    <div class="flex-grow-1 small" style="min-width:0;">
                        <div class="fw-bold text-truncate" t-esc="photo.who or photo.f.name"/>
                        <div t-if="photo.time" class="opacity-75" t-esc="photo.time"/>
                    </div>
                    <a t-att-href="photo.f.url" target="_blank" class="text-white fs-4 text-decoration-none" title="Open / download">⤓</a>
                    <button type="button" class="btn btn-link text-white fs-4 p-0 text-decoration-none" title="Close"
                            t-on-click="() => this.closePhoto()">✕</button>
                </div>
                <img t-att-src="photo.f.url" t-att-alt="photo.f.name"
                     style="max-width:96vw; max-height:86vh; object-fit:contain; border-radius:4px;"/>
                <div t-if="photo.body" class="position-absolute bottom-0 start-0 end-0 text-white text-center px-4 pb-4 pt-3"
                     style="background:linear-gradient(transparent, rgba(0,0,0,.75)); white-space:pre-wrap; word-break:break-word; max-height:30vh; overflow:auto; font-size:15px;"
                     t-esc="photo.body"/>
            </div>
            <t t-foreach="props.days" t-as="day" t-key="day.date">
                <!-- Each date is closed until tapped. -->
                <button type="button" class="btn w-100 text-start d-flex align-items-center gap-2 border rounded-2 bg-light px-3 py-2 mb-2"
                        t-att-aria-expanded="isOpen(day) ? 'true' : 'false'" t-on-click="() => this.toggle(day)">
                    <i t-att-class="'fa ' + (isOpen(day) ? 'fa-chevron-down' : 'fa-chevron-right') + ' text-muted'"/>
                    <b t-esc="day.label"/>
                    <span class="small text-muted"><t t-esc="day.sessions.length"/> talk<t t-if="day.sessions.length !== 1">s</t> · <t t-esc="dayCount(day)"/> message<t t-if="dayCount(day) !== 1">s</t></span>
                    <span t-if="dayWaiting(day)" class="ms-auto small fw-semibold" style="color:#B42318;">● waiting</span>
                </button>
                <t t-if="isOpen(day)" t-foreach="day.sessions" t-as="s" t-key="s.n">
                    <div t-if="s.gap_min" class="d-flex align-items-center gap-2 my-1" style="font-size:11px; color:#8A939E;">
                        <span class="flex-grow-1" style="border-top:1px dashed #C9CED4;"/><t t-esc="gapLabel(s.gap_min)"/> gap<span class="flex-grow-1" style="border-top:1px dashed #C9CED4;"/>
                    </div>
                    <t t-set="c" t-value="colourOf(s_index)"/>
                    <div class="rounded-2 p-2 mb-2 d-flex flex-column gap-2" t-att-style="'background:' + c.band + '; box-shadow: inset 4px 0 0 ' + c.bar + ';'">
                        <div class="d-flex small fw-semibold" t-att-style="'color:' + c.text">
                            <span>Talk <t t-esc="s.n"/> · <t t-esc="s.start"/><t t-if="s.end !== s.start"> – <t t-esc="s.end"/></t> · <t t-esc="s.count"/> message<t t-if="s.count !== 1">s</t></span>
                            <span t-if="s.status === 'answered'" class="ms-auto" style="color:#0F5E2D;">✓ answered<t t-if="s.by"> by <t t-esc="s.by"/></t></span>
                            <span t-elif="s.status === 'waiting'" class="ms-auto" style="color:#B42318;">● waiting for the team</span>
                        </div>
                        <div t-foreach="s.messages" t-as="msg" t-key="msg.id"
                             t-att-class="'rounded-2 px-2 py-1 ' + (msg.side === 'team' ? 'align-self-end' : 'align-self-start')"
                             t-att-style="'max-width:75%; background:' + (msg.side === 'team' ? '#D9FDD3' : '#FFFFFF') + ';'">
                            <div class="d-flex gap-2" style="font-size:12px;">
                                <b t-att-style="'color:' + (msg.side === 'team' ? '#1D4FA8' : '#B45309')"><t t-esc="msg.who"/><t t-if="msg.side === 'client'"> · client</t></b>
                                <span class="ms-auto text-muted" t-esc="msg.time"/>
                            </div>
                            <div t-if="msg.body" style="white-space: pre-wrap;" t-esc="msg.body"/>
                            <div t-foreach="msg.files" t-as="f" t-key="f.id" class="my-1">
                                <img t-if="f.kind === 'image'" t-att-src="f.url" t-att-alt="f.name" loading="lazy" t-att-title="f.name"
                                     style="display:block; max-width:260px; max-height:260px; border-radius:6px; cursor:zoom-in;"
                                     t-on-click="() => this.openPhoto(f, msg)"/>
                                <video t-elif="f.kind === 'video'" t-att-src="f.url" controls="" preload="metadata"
                                       style="display:block; max-width:300px; max-height:260px; border-radius:6px;"/>
                                <a t-elif="f.kind === 'document'" t-att-href="f.url" target="_blank" rel="noopener"
                                   class="d-flex gap-2 align-items-center px-2 py-2 rounded text-reset text-decoration-none"
                                   style="background:rgba(0,0,0,.05); min-width:200px; word-break:break-all;">
                                    <span>📄</span><b t-esc="f.name"/></a>
                                <audio t-else="" t-att-src="f.url" controls="" preload="metadata" style="display:block; width:260px;"/>
                            </div>
                        </div>
                    </div>
                </t>
            </t>
        </div>`;
    setup() {
        this.open = useState({});
        this.photo = useState({ f: null, who: "", time: "", body: "" });
    }
    openPhoto(f, msg) {
        Object.assign(this.photo, { f, who: msg.side === "client" ? msg.who + " · client" : msg.who,
                                    time: msg.time, body: msg.body || "" });
    }
    closePhoto() {
        this.photo.f = null;
    }
    isOpen(day) {
        return !!this.open[day.date];
    }
    toggle(day) {
        this.open[day.date] = !this.open[day.date];
    }
    dayCount(day) {
        return day.sessions.reduce((n, s) => n + s.count, 0);
    }
    dayWaiting(day) {
        return day.sessions.some((s) => s.status === "waiting");
    }
    colourOf(i) {
        return colour(i);
    }
    gapLabel(min) {
        return min >= 60 ? Math.floor(min / 60) + " h" + (min % 60 ? " " + (min % 60) + " min" : "") : min + " min";
    }
}

const TABS = `
    <div class="d-flex gap-1 border-bottom mb-3">
        <button t-att-class="'btn btn-link text-decoration-none rounded-0 ' + (state.tab === 'task' ? 'fw-bold border-bottom border-3 border-primary' : 'text-muted')"
                t-on-click="() => this.setTab('task')">📌 Task-oriented <t t-if="state.counts.task">(<t t-esc="state.counts.task"/>)</t></button>
        <button t-att-class="'btn btn-link text-decoration-none rounded-0 ' + (state.tab === 'general' ? 'fw-bold border-bottom border-3 border-primary' : 'text-muted')"
                t-on-click="() => this.setTab('general')">🌐 General <t t-if="state.counts.general">(<t t-esc="state.counts.general"/>)</t></button>
    </div>`;

// ---------------------------------------------------------------------------
// 💬 Discussions
// ---------------------------------------------------------------------------
export class KpiTalksDiscussions extends Component {
    static components = { KpiTalkThread };
    static template = xml`
        <div class="o_kpi_talks p-4" style="max-width:1400px; margin:0 auto;">
            <div class="d-flex align-items-center flex-wrap gap-2 mb-3">
                <h2 class="fw-bold mb-0">💬 Discussions</h2>
                <span t-if="waitingCount()" class="badge text-bg-danger"><t t-esc="waitingCount()"/> waiting</span>
                <div class="ms-auto d-flex gap-2">
                    <input class="form-control form-control-sm" style="width:260px;" placeholder="🔍 Search client, REQ, words"
                           t-att-value="state.search" t-on-change="(ev) => this.setSearch(ev.target.value)"/>
                    <button t-att-class="'btn btn-sm ' + (state.filter === 'waiting' ? 'btn-primary' : 'btn-outline-secondary')" t-on-click="() => this.setFilter('waiting')">Waiting</button>
                    <button t-att-class="'btn btn-sm ' + (state.filter === 'all' ? 'btn-primary' : 'btn-outline-secondary')" t-on-click="() => this.setFilter('all')">All</button>
                </div>
            </div>
            ${TABS}
            <div t-if="state.error" class="alert alert-warning" t-esc="state.error"/>
            <div class="row g-3">
                <div class="col-lg-4">
                    <div t-if="state.loading" class="text-muted small"><i class="fa fa-spinner fa-spin me-1"/>Loading…</div>
                    <div t-elif="!state.rows.length" class="text-muted small p-3 border rounded bg-white">
                        <t t-if="state.tab === 'general'">No general questions yet. When a client picks "Something else" in WhatsApp 💬 Discuss, it shows here.</t>
                        <t t-else="">No task chats<t t-if="state.filter === 'waiting'"> waiting for a reply</t>.</t>
                    </div>
                    <button t-foreach="state.rows" t-as="r" t-key="r.kpi_id" type="button"
                            t-att-class="'w-100 text-start border rounded-2 p-2 mb-2 ' + (state.open and state.open.kpi_id === r.kpi_id ? 'border-primary bg-primary-subtle' : 'bg-white')"
                            t-on-click="() => this.openThread(r)">
                        <div class="d-flex align-items-center gap-2">
                            <span t-if="!r.is_general" class="badge text-bg-light border" t-esc="r.ref"/>
                            <b class="text-truncate small" t-esc="r.is_general ? r.client : r.title"/>
                            <span t-if="r.waiting" class="ms-auto badge rounded-pill text-bg-danger" t-esc="r.waiting"/>
                        </div>
                        <div class="small text-truncate" t-att-class="r.waiting ? 'fw-semibold' : 'text-muted'"><t t-esc="r.last_who"/>: <t t-esc="r.last"/></div>
                        <div class="d-flex small text-muted"><span t-esc="r.at_label"/><span t-if="!r.is_general" class="ms-2">· <t t-esc="r.client"/></span><span class="ms-auto"><t t-esc="r.count"/> msgs</span></div>
                    </button>
                </div>
                <div class="col-lg-8">
                    <div t-if="!state.open" class="text-muted small p-4 border rounded bg-white text-center">Pick a chat on the left: all its messages show here, by date and talk.</div>
                    <div t-else="" class="border rounded bg-white">
                        <div class="d-flex align-items-center gap-2 px-3 py-2 border-bottom">
                            <span t-if="!state.open.is_general" class="badge text-bg-light border" t-esc="state.open.ref"/>
                            <b t-esc="state.open.is_general ? '🌐 General · ' + state.open.client : state.open.title"/>
                            <span class="small text-muted"><t t-if="!state.open.is_general"><t t-esc="state.open.client"/> · </t><t t-esc="state.open.count"/> messages</span>
                            <button class="btn btn-sm btn-link ms-auto" t-on-click="() => this.openBoard(state.open)">
                                <t t-if="state.open.is_general">💬 Open chat</t><t t-else="">↗ Open task</t></button>
                        </div>
                        <div class="p-3">
                            <div t-if="state.threadLoading" class="text-muted small"><i class="fa fa-spinner fa-spin me-1"/>Loading…</div>
                            <KpiTalkThread t-else="" t-key="state.open.kpi_id" days="state.open.days or []"/>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;

    setup() {
        this.action = useService("action");
        this.state = useState({ tab: "task", filter: "all", search: "", rows: [], counts: {}, loading: true,
                                error: "", open: null, threadLoading: false });
        onWillStart(() => this.load());
    }
    waitingCount() {
        const c = this.state.counts || {};
        return (c.waiting_task || 0) + (c.waiting_general || 0);
    }
    async load() {
        this.state.loading = true;
        try {
            const r = await rpc("/kpi_action/talks/discussions",
                { tab: this.state.tab, filter: this.state.filter, search: this.state.search });
            if (r && r.status) {
                this.state.rows = r.rows;
                this.state.counts = r.counts;
                this.state.error = "";
            } else {
                this.state.error = (r && r.message) || "Could not load the discussions.";
            }
        } finally {
            this.state.loading = false;
        }
    }
    setTab(t) { this.state.tab = t; this.state.open = null; this.load(); }
    setFilter(f) { this.state.filter = f; this.load(); }
    setSearch(v) { this.state.search = v; this.load(); }
    async openThread(row) {
        this.state.open = Object.assign({}, row, { days: [] });
        this.state.threadLoading = true;
        try {
            const r = await rpc("/kpi_action/talks/thread", { kpi_id: row.kpi_id });
            if (r && r.status) {
                this.state.open = r;
            } else {
                this.state.error = (r && r.message) || "Could not load the chat.";
            }
        } finally {
            this.state.threadLoading = false;
        }
    }
    openBoard(row) { return openOnBoard(this.action, row); }
}

// ---------------------------------------------------------------------------
// 📅 Meetings
// ---------------------------------------------------------------------------
export class KpiTalksMeetings extends Component {
    static components = { KpiMeetingDays };
    static template = xml`
        <div class="o_kpi_talks p-4" style="max-width:1400px; margin:0 auto;">
            <div class="d-flex align-items-center flex-wrap gap-2 mb-3">
                <h2 class="fw-bold mb-0">📅 Meetings</h2>
                <span t-if="state.counts.upcoming" class="badge text-bg-primary"><t t-esc="state.counts.upcoming"/> upcoming</span>
                <div class="ms-auto d-flex gap-2">
                    <!-- Full: every meeting open. Compact: one closed row each. The choice is remembered. -->
                    <div class="btn-group btn-group-sm" role="group" aria-label="View">
                        <button t-att-class="'btn ' + (state.view === 'full' ? 'btn-dark' : 'btn-outline-dark')" title="Show every meeting in full"
                                t-on-click="() => this.setView('full')"><i class="fa fa-th-large me-1"/>Full</button>
                        <button t-att-class="'btn ' + (state.view === 'compact' ? 'btn-dark' : 'btn-outline-dark')" title="One row per meeting; tap to open"
                                t-on-click="() => this.setView('compact')"><i class="fa fa-list me-1"/>Compact</button>
                    </div>
                    <input class="form-control form-control-sm" style="width:300px;" placeholder="🔍 Search client, REQ, words in summary"
                           t-att-value="state.search" t-on-change="(ev) => this.setSearch(ev.target.value)"/>
                    <button t-foreach="filters" t-as="f" t-key="f[0]"
                            t-att-class="'btn btn-sm ' + (state.filter === f[0] ? 'btn-primary' : 'btn-outline-secondary')"
                            t-on-click="() => this.setFilter(f[0])" t-esc="f[1]"/>
                </div>
            </div>
            ${TABS}
            <div t-if="state.error" class="alert alert-warning" t-esc="state.error"/>
            <div t-if="state.loading" class="text-muted small"><i class="fa fa-spinner fa-spin me-1"/>Loading…</div>
            <div t-elif="!state.days.length" class="text-muted small p-3 border rounded bg-white">
                <t t-if="state.tab === 'general'">No general meetings. They are the ones a client asked for without picking a task ("Common, whole server" or "Other / a new topic").</t>
                <t t-else="">No meetings here.</t>
            </div>
            <KpiMeetingDays t-else="" t-key="state.view" days="state.days" compact="state.view === 'compact'" onOpen="(m) => this.openBoard(m)"/>
        </div>`;

    setup() {
        this.action = useService("action");
        this.filters = [["upcoming", "Upcoming"], ["past", "Past"], ["all", "All"]];
        this.state = useState({ tab: "task", filter: "all", search: "", days: [], counts: {}, loading: true, error: "",
                                view: this.savedView() });
        onWillStart(() => this.load());
    }
    savedView() {
        try {
            return window.localStorage.getItem(VIEW_KEY) === "compact" ? "compact" : "full";
        } catch (e) {
            return "full";
        }
    }
    setView(v) {
        this.state.view = v;
        try { window.localStorage.setItem(VIEW_KEY, v); } catch (e) { /* not remembered, still switches */ }
    }
    async load() {
        this.state.loading = true;
        try {
            const r = await rpc("/kpi_action/talks/meetings",
                { tab: this.state.tab, filter: this.state.filter, search: this.state.search });
            if (r && r.status) {
                this.state.days = r.days;
                this.state.counts = r.counts;
                this.state.error = "";
            } else {
                this.state.error = (r && r.message) || "Could not load the meetings.";
            }
        } finally {
            this.state.loading = false;
        }
    }
    setTab(t) { this.state.tab = t; this.load(); }
    setFilter(f) { this.state.filter = f; this.load(); }
    setSearch(v) { this.state.search = v; this.load(); }
    openBoard(m) { return openOnBoard(this.action, m); }
}

// ---------------------------------------------------------------------------
// ❓ Questions
// ---------------------------------------------------------------------------
export class KpiTalksQuestions extends Component {
    static template = xml`
        <div class="o_kpi_talks p-4" style="max-width:1400px; margin:0 auto;">
            <div class="d-flex align-items-center flex-wrap gap-2 mb-3">
                <h2 class="fw-bold mb-0">❓ Questions</h2>
                <span class="small text-muted">Developer questions, meeting requests and client Discuss questions, and who they are with now</span>
                <div class="ms-auto d-flex gap-2">
                    <input class="form-control form-control-sm" style="width:240px;" placeholder="🔍 Search"
                           t-att-value="state.search" t-on-change="(ev) => this.setSearch(ev.target.value)"/>
                    <button t-att-class="'btn btn-sm ' + (state.filter === 'open' ? 'btn-primary' : 'btn-outline-secondary')" t-on-click="() => this.setFilter('open')">Open <t t-if="state.counts.open">(<t t-esc="state.counts.open"/>)</t></button>
                    <button t-att-class="'btn btn-sm ' + (state.filter === 'answered' ? 'btn-primary' : 'btn-outline-secondary')" t-on-click="() => this.setFilter('answered')">Answered</button>
                    <button t-att-class="'btn btn-sm ' + (state.filter === 'all' ? 'btn-primary' : 'btn-outline-secondary')" t-on-click="() => this.setFilter('all')">All</button>
                </div>
            </div>
            <div t-if="state.error" class="alert alert-warning" t-esc="state.error"/>
            <div t-if="state.loading" class="text-muted small"><i class="fa fa-spinner fa-spin me-1"/>Loading…</div>
            <div t-elif="!state.rows.length" class="text-muted small p-3 border rounded bg-white">Nothing here.</div>
            <div t-else="" class="border rounded bg-white overflow-auto">
                <table class="table table-sm align-middle mb-0">
                    <thead class="table-light small text-muted">
                        <tr><th>Task</th><th>Kind</th><th>Question</th><th>Raised by</th><th>With now</th><th>Step</th><th>Waiting</th><th/></tr>
                    </thead>
                    <tbody>
                        <tr t-foreach="state.rows" t-as="q" t-key="q.id" t-att-class="q.open ? '' : 'table-light'">
                            <td><span class="badge text-bg-light border" t-esc="q.is_general ? 'General' : q.ref"/></td>
                            <td class="small text-nowrap" t-esc="kindIcon(q.kind) + ' ' + q.kind_label"/>
                            <td class="small">
                                <div t-esc="q.question"/>
                                <div t-if="!q.open and q.answer" class="text-muted">↳ <t t-esc="q.answer"/></div>
                            </td>
                            <td class="small" t-esc="q.raised_by or (q.is_general ? q.client : '')"/>
                            <td class="small" t-esc="q.with_now"/>
                            <td class="small">
                                <span t-if="q.open" class="badge text-bg-warning" t-esc="q.step"/>
                                <span t-else="" class="badge text-bg-success">✓ <t t-esc="q.state_label"/></span>
                            </td>
                            <td t-att-class="'small text-nowrap ' + (q.age_min >= 10 ? 'text-danger fw-semibold' : 'text-muted')" t-esc="q.open ? ageLabel(q.age_min) : '—'"/>
                            <td class="text-nowrap">
                                <button class="btn btn-sm btn-link p-0" t-on-click="() => this.openRow(q)">
                                    <t t-if="q.meeting_id">📅 Open meeting</t><t t-elif="q.is_general">💬 Open chat</t><t t-else="">↗ Open task</t></button>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>`;

    setup() {
        this.action = useService("action");
        this.state = useState({ filter: "open", search: "", rows: [], counts: {}, loading: true, error: "" });
        onWillStart(() => this.load());
    }
    async load() {
        this.state.loading = true;
        try {
            const r = await rpc("/kpi_action/talks/questions", { filter: this.state.filter, search: this.state.search });
            if (r && r.status) {
                this.state.rows = r.rows;
                this.state.counts = r.counts;
                this.state.error = "";
            } else {
                this.state.error = (r && r.message) || "Could not load the questions.";
            }
        } finally {
            this.state.loading = false;
        }
    }
    setFilter(f) { this.state.filter = f; this.load(); }
    setSearch(v) { this.state.search = v; this.load(); }
    kindIcon(k) {
        return { client_msg: "💬", client_meet: "📅", meet_admin: "📅", meet_client: "📅", escalation: "⬆️" }[k] || "🙋";
    }
    ageLabel(min) {
        if (min < 60) return min + " min";
        if (min < 1440) return Math.floor(min / 60) + " h";
        return Math.floor(min / 1440) + " d";
    }
    openRow(q) {
        if (q.meeting_id) {
            return this.action.doAction({
                type: "ir.actions.act_window", res_model: "kpi.meeting", res_id: q.meeting_id,
                views: [[false, "form"]], target: "current",
            });
        }
        return openOnBoard(this.action, q);
    }
}

registry.category("actions").add("kpi_talks_discussions", KpiTalksDiscussions);
registry.category("actions").add("kpi_talks_meetings", KpiTalksMeetings);
registry.category("actions").add("kpi_talks_questions", KpiTalksQuestions);
