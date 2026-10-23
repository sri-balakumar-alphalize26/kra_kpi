/** @odoo-module **/
// Setup › Databases › Database name: once a Server is chosen, a dropdown of the
// databases that server's Odoo lists (kpi.server.databases_for_pick, the same
// /web/database/list the app's Connect screen and the web sign-in read). Typing
// a name is still allowed: a database being created for a New-DB request does
// not exist on the server yet.
import { Component, xml, useState, onWillStart, onWillUpdateProps } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { standardFieldProps } from "@web/views/fields/standard_field_props";

let seq = 0;

export class KpiDbPickField extends Component {
    static template = xml`
        <span t-if="props.readonly" t-esc="props.record.data[props.name] or ''"/>
        <div t-else="" class="d-flex flex-column w-100">
            <input class="o_input" type="text" autocomplete="off"
                   t-att-list="listId" t-att-value="props.record.data[props.name] or ''"
                   t-att-placeholder="state.loading ? 'Loading the server databases...' : (state.names.length ? 'Pick or type a database' : 'Database name')"
                   t-on-change="onChange"/>
            <datalist t-att-id="listId">
                <t t-foreach="state.names" t-as="n" t-key="n">
                    <option t-att-value="n" t-att-label="state.added.includes(n) ? 'already added' : ''"/>
                </t>
            </datalist>
            <small t-if="state.error" class="text-danger" t-esc="state.error"/>
            <small t-elif="state.names.length" class="text-muted">
                <t t-esc="state.names.length"/> on this server
            </small>
        </div>`;
    static props = { ...standardFieldProps };

    setup() {
        this.orm = useService("orm");
        this.listId = "kpi_db_pick_" + ++seq;
        this.state = useState({ names: [], added: [], error: "", loading: false });
        this.loadedFor = null;
        onWillStart(() => this.load(this.props));
        onWillUpdateProps((p) => this.load(p));
    }

    serverId(p) {
        const v = p.record.data.server_id;
        return v ? (Array.isArray(v) ? v[0] : v.id) : false;
    }

    async load(p) {
        const id = this.serverId(p);
        if (id === this.loadedFor) return;
        this.loadedFor = id;
        Object.assign(this.state, { names: [], added: [], error: "" });
        if (!id || p.readonly) return;
        this.state.loading = true;
        try {
            const r = await this.orm.call("kpi.server", "databases_for_pick", [id]);
            if (this.loadedFor !== id) return;
            Object.assign(this.state, { names: r.names || [], added: r.added || [], error: r.error || "" });
        } catch (e) {
            this.state.error = "Could not read the server's databases.";
        } finally {
            this.state.loading = false;
        }
    }

    onChange(ev) {
        this.props.record.update({ [this.props.name]: (ev.target.value || "").trim() });
    }
}

registry.category("fields").add("kpi_db_pick", {
    component: KpiDbPickField,
    supportedTypes: ["char"],
});
