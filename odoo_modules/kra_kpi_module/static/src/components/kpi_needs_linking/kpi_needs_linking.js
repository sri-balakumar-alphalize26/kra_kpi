/** @odoo-module **/
import { Component, xml, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

/**
 * Needs Linking — bugs / updates raised "From the old system" that still wait
 * for the old requirement's Request ID (/kra_kpi/legacy/pending, oldest first),
 * grouped by client. Link saves the Request ID (and a name) through
 * /kra_kpi/legacy/save, which renumbers the task under that requirement and
 * marks it Confirmed with client, so it leaves this list.
 * Same screen as the web's Work ▸ Needs Linking (web/components/admin/NeedsLinking.jsx).
 */
const REF_RE = /^REQ-?(\d{1,6})$/i;
// "req12" / "REQ 012" → "REQ-012"; anything else as typed.
const normalizeRef = (v) => {
    const s = String(v || '').trim().replace(/\s+/g, '');
    const m = REF_RE.exec(s);
    return m ? 'REQ-' + m[1].padStart(3, '0') : s;
};

export class KpiNeedsLinking extends Component {
    static template = xml/* xml */`
    <div class="o_kpi_needs_linking p-4">
        <div class="d-flex justify-content-between align-items-center mb-1 flex-wrap gap-2">
            <h2 class="fw-bold mb-0">🗄️ Needs Linking
                <span t-if="state.loaded" class="badge bg-warning text-dark ms-2 fs-6" t-esc="state.tasks.length + ' waiting'"/>
            </h2>
            <div class="d-flex gap-2">
                <select t-if="clients().length > 1" class="form-select" style="width:220px" t-model="state.client">
                    <option value="">All clients</option>
                    <t t-foreach="clients()" t-as="c" t-key="c[0]">
                        <option t-att-value="c[0]" t-esc="c[1]"/>
                    </t>
                </select>
                <button class="btn btn-outline-primary" t-on-click="load"><i class="fa fa-refresh me-1"/> Refresh</button>
            </div>
        </div>
        <p class="text-muted mb-3">Bugs and updates about an old-DB requirement, waiting for its Request ID.</p>

        <div t-if="state.msg" t-att-class="'alert alert-' + state.msg.kind" t-esc="state.msg.text"/>
        <div t-if="!state.loaded" class="text-muted">Loading…</div>
        <div t-elif="!state.tasks.length" class="card p-4 text-center text-muted">
            Nothing to link. Every old-DB bug and update has its Request ID.
        </div>
        <div t-else="" class="table-responsive card">
            <table class="table table-sm align-top mb-0">
                <thead class="table-light">
                    <tr><th>Ref</th><th style="width:36%">Request</th><th>Database</th><th>Raised</th><th style="width:300px">Link to the old requirement</th></tr>
                </thead>
                <tbody>
                    <t t-foreach="groups()" t-as="g" t-key="g.key">
                        <tr class="table-secondary"><td colspan="5" class="fw-bold" t-esc="g.client + ' · ' + g.rows.length + ' waiting'"/></tr>
                        <t t-foreach="g.rows" t-as="t" t-key="t.id">
                            <tr>
                                <td>
                                    <b class="text-primary" t-esc="t.ref or ('#' + t.id)"/>
                                    <div><span class="badge text-bg-warning mt-1">Pending</span></div>
                                </td>
                                <td style="white-space:normal">
                                    <b t-esc="t.name"/>
                                    <div t-if="t.legacy_name" class="small text-muted mt-1">Old task: <b t-esc="t.legacy_name"/></div>
                                    <div t-if="t.note" class="mt-1" style="white-space:pre-wrap" t-esc="t.note"/>
                                    <div t-if="t.transcript" class="small text-muted mt-1" style="white-space:pre-wrap"><b>Transcript:</b> <t t-esc="t.transcript"/></div>
                                    <t t-foreach="t.voice_notes or []" t-as="v" t-key="v.url">
                                        <div class="mt-1 small">🎤 <t t-esc="v.name"/>
                                            <audio controls="controls" preload="none" t-att-src="v.url" style="height:30px;vertical-align:middle;max-width:100%"/>
                                        </div>
                                    </t>
                                </td>
                                <td t-esc="t.db or '—'"/>
                                <td class="small text-muted"><t t-esc="t.by or '—'"/><br/><t t-esc="t.date"/></td>
                                <td>
                                    <input type="text" class="form-control form-control-sm mb-1" placeholder="Request ID, e.g. REQ-012"
                                           t-att-value="field(t.id, 'ref')"
                                           t-on-input="(ev) => this.setField(t.id, 'ref', ev.target.value)"
                                           t-on-change="(ev) => this.setField(t.id, 'ref', normalize(ev.target.value))"
                                           t-on-keydown="(ev) => ev.key === 'Enter' and this.save(t)"/>
                                    <input type="text" class="form-control form-control-sm mb-1"
                                           t-att-placeholder="t.legacy_name ? 'Task name (' + t.legacy_name + ')' : 'Task name (optional)'"
                                           t-att-value="field(t.id, 'name')"
                                           t-on-input="(ev) => this.setField(t.id, 'name', ev.target.value)"/>
                                    <button class="btn btn-primary btn-sm" t-att-disabled="!field(t.id, 'ref').trim() or state.busy === t.id"
                                            t-on-click="() => this.save(t)">
                                        <t t-if="state.busy === t.id">Linking…</t><t t-else="">Link</t>
                                    </button>
                                </td>
                            </tr>
                        </t>
                    </t>
                </tbody>
            </table>
        </div>
    </div>`;

    setup() {
        this.state = useState({ tasks: [], loaded: false, client: '', link: {}, busy: 0, msg: null });
        onWillStart(() => this.load());
    }

    async load() {
        const r = await rpc('/kra_kpi/legacy/pending', {});
        this.state.loaded = true;
        if (!r || !r.status) {
            this.state.tasks = [];
            this.state.msg = { kind: 'danger', text: (r && r.message) || 'Could not load the list.' };
            return;
        }
        this.state.tasks = r.tasks || [];
    }

    clients() {
        const m = new Map();
        for (const t of this.state.tasks) m.set(String(t.client_id || ''), t.client || '—');
        return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    }
    groups() {
        const m = new Map();
        for (const t of this.state.tasks) {
            const k = String(t.client_id || '');
            if (this.state.client && k !== this.state.client) continue;
            if (!m.has(k)) m.set(k, { key: k, client: t.client || '—', rows: [] });
            m.get(k).rows.push(t);
        }
        return [...m.values()].sort((a, b) => a.client.localeCompare(b.client));
    }

    normalize(v) { return normalizeRef(v); }
    field(id, key) { return (this.state.link[id] || {})[key] || ''; }
    setField(id, key, value) {
        this.state.link[id] = { ...(this.state.link[id] || {}), [key]: value };
    }

    async save(t) {
        const ref = normalizeRef(this.field(t.id, 'ref'));
        if (!ref) {
            this.state.msg = { kind: 'warning', text: 'Type the Request ID, e.g. REQ-012.' };
            return;
        }
        this.state.busy = t.id;
        try {
            // The message stays as it is; an empty name keeps the one the client gave.
            const r = await rpc('/kra_kpi/legacy/save', {
                kpi_id: t.id, ref, name: this.field(t.id, 'name').trim() || t.legacy_name, note: t.note,
            });
            if (!r || !r.status) {
                this.state.msg = { kind: 'danger', text: (r && r.message) || 'Could not link it.' };
                return;
            }
            this.state.msg = { kind: 'success', text: `${t.ref || 'Task'} linked${r.ref ? ' — now ' + r.ref : ''}.` };
            delete this.state.link[t.id];
            await this.load();
        } finally {
            this.state.busy = 0;
        }
    }
}

registry.category("actions").add("kpi_needs_linking", KpiNeedsLinking);
