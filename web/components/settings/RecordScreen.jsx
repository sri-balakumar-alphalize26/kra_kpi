"use client";
/* One list + form screen for the Odoo Setup models that have no web screen of
   their own (Servers, Databases, Decline reasons, WhatsApp groups…). A page
   passes a config naming the model, the list columns, the form fields and the
   buttons — the same ones Odoo's own list/form views show. Labels, types,
   choices and required/read-only come from Odoo itself (fields_get), so the
   page cannot drift from the model. Every call is plain call_kw: Odoo's
   access rules decide, and its error text is what the person reads.

   config = {
     model, title, meta, crumb,                    page header
     list:   ["field", ...],                       columns
     form:   ["field" | {section: "Title"}, ...],  form fields, in order
     order, domain, tabs: [{key, label, domain}],
     create, del, archive (has an `active` field), readonly (no editing at all)
     onOpen: "method"                              @api.model method run on open (Odoo's menu does)
     secret: ["field"]                             shown as password boxes
     actions: [{method, label, danger, confirm, list, show(rec), wizard}]
     children: {model, field, label, list: [...]}  read-only sub-list in the form
               (or a list of them, one tab each; edit: {field: relation} makes
               those columns editable per row)
     system: true                                  System administrators only
     search: ["field", ...]                        Odoo's search fields (ilike, any of them)
     filters: [{key, label, group, domain | () => domain}]  Odoo's search filters:
               OR inside one group, AND across groups
     groupBy: [{key, label, field}]                Odoo's "Group by" choices
     bulk: true                                    tick rows; actions with bulk: true run on all ticked
     alerts: [{show(rec), tone, text}]             the form's alert boxes
     hideIf: {field: (rec) => bool}, requiredIf, readonlyIf   Odoo's invisible= / required= / readonly=
   } */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, ErrorState, Field, IconButton, Input, Lozenge, Modal, PageHeader, Select, Skeleton, Tabs, useDialogs, useFlags } from "@/components/ui";
import { callKw } from "@/lib/api";
import { useMe } from "@/lib/me";
import { local, m2o, notice } from "@/lib/services/sysadmin";
import SettingsNav from "./SettingsNav";
import SystemOnly from "./SystemOnly";

const ATTRS = ["string", "type", "required", "readonly", "selection", "relation", "help"];
/* Odoo's alert-warning / alert-danger / alert-info boxes. */
const ALERT = {
  warn: { background: "var(--lz-paused-bg)", borderColor: "var(--pri-important)" },
  danger: { background: "var(--over-bg)", borderColor: "var(--danger)", color: "var(--over)" },
  info: { background: "var(--lz-prog-bg)", borderColor: "var(--lz-prog)" },
};
const idOf = (r) => (Array.isArray(r) ? r[0] : r);

export default function RecordScreen({ config, embedded = false }) {
  const body = <Screen config={config} embedded={embedded} />;
  return config.system ? <SystemOnly title={config.title}>{body}</SystemOnly> : body;
}

function Screen({ config: c, embedded }) {
  const flags = useFlags();
  const dlg = useDialogs();
  const { me } = useMe();
  const [meta, setMeta] = useState(null);
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState(c.tabs?.[0]?.key || "");
  const [archived, setArchived] = useState(false);
  const [edit, setEdit] = useState(null);     /* the record in the form ({} = new) */
  const [opts, setOpts] = useState({});       /* many2one choices per relation */
  const [busy, setBusy] = useState("");
  const [wizard, setWizard] = useState(null); /* {act, rec, ctx} */
  const [records, setRecords] = useState(null); /* {act, title, rows} */
  const [q, setQ] = useState("");             /* the search box, applied */
  const [qDraft, setQDraft] = useState("");
  const [onFilters, setOnFilters] = useState([]); /* filter keys switched on */
  const [groupBy, setGroupBy] = useState("");
  const [picked, setPicked] = useState([]);   /* ticked row ids (bulk) */

  const fields = useMemo(() => [...new Set([...(c.list || []), ...(c.form || []).filter((f) => typeof f === "string"), ...(c.archive ? ["active"] : []), ...(c.extraFields || [])])], [c]);
  /* Odoo's search: the box matches any search field; filters OR inside their
     group and AND across groups. */
  const domain = useMemo(() => {
    const d = [...(c.domain || []), ...(c.tabs?.find((t) => t.key === tab)?.domain || [])];
    const words = q.trim();
    if (words && c.search?.length) {
      for (let i = 1; i < c.search.length; i++) d.push("|");
      for (const f of c.search) d.push([f, "ilike", words]);
    }
    const groups = {};
    for (const f of c.filters || []) if (onFilters.includes(f.key)) (groups[f.group || f.key] ||= []).push(typeof f.domain === "function" ? f.domain({ uid: me?.uid }) : f.domain);
    for (const doms of Object.values(groups)) {
      for (let i = 1; i < doms.length; i++) d.push("|");
      for (const dom of doms) { if (dom.length > 1) for (let i = 1; i < dom.length; i++) d.push("&"); d.push(...dom); }
    }
    return d;
  }, [c, tab, q, onFilters, me?.uid]);

  const load = useCallback(async () => {
    try {
      const m = meta || await callKw(c.model, "fields_get", [], { attributes: ATTRS });
      if (!meta) setMeta(m);
      const read = fields.filter((f) => m[f] && m[f].type !== "one2many");
      const r = await callKw(c.model, "search_read", [domain], { fields: read, order: c.order || "id desc", limit: 500, context: c.archive && archived ? { active_test: false } : {} });
      setRows(r || []); setErr(null);
    } catch (e) { setErr(e); }
  }, [c, meta, fields, domain, archived]);

  /* Odoo's menu runs these on open (import the WhatsApp groups, snapshot the
     databases); do the same, quietly — a failure must not hide the list. */
  useEffect(() => {
    let gone = false;
    (async () => { if (c.onOpen) { try { await callKw(c.model, c.onOpen, []); } catch (e) {} } if (!gone) load(); })();
    return () => { gone = true; };
  }, [tab, archived]); // eslint-disable-line react-hooks/exhaustive-deps
  /* ?id=<record> opens that record once the list has loaded (Approvals › Open). */
  const [urlId] = useState(() => { try { return Number(new URLSearchParams(window.location.search).get("id")) || null; } catch { return null; } });
  useEffect(() => { if (meta && urlId) open({ id: urlId }); }, [meta, urlId]); // eslint-disable-line react-hooks/exhaustive-deps
  /* Search / filters: just reload (the onOpen import ran already). */
  useEffect(() => { if (meta) { setPicked([]); load(); } }, [q, onFilters]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Choices for every many2one the form edits, and every many2many on the
     screen (the list shows their names). */
  useEffect(() => {
    if (!meta) return;
    const m2m = fields.filter((f) => meta[f]?.type === "many2many");
    const m2o = edit ? (c.form || []).filter((f) => typeof f === "string" && meta[f]?.type === "many2one" && !ro(f)) : [];
    const rels = [...new Set([...m2o, ...m2m].map((f) => meta[f].relation))];
    rels.filter((rel) => !opts[rel]).forEach((rel) => callKw(rel, "name_search", [], { name: "", limit: 300, ...(rel === "res.users" ? { domain: [["share", "=", false]] } : {}) })
      .then((r) => setOpts((o) => ({ ...o, [rel]: r || [] }))).catch(() => setOpts((o) => ({ ...o, [rel]: [] }))));
  }, [meta, edit]); // eslint-disable-line react-hooks/exhaustive-deps

  const ro = (f) => c.readonly || !!meta?.[f]?.readonly || !!(edit && c.readonlyIf?.[f]?.(edit));
  const hidden = (f) => !!(edit && c.hideIf?.[f]?.(edit));
  const needed = (f) => !!meta?.[f]?.required || !!(edit && c.requiredIf?.[f]?.(edit));
  const label = (f) => meta?.[f]?.string || f;
  const show = (f, v) => {
    const t = meta?.[f]?.type;
    if (v === false || v == null || v === "") return t === "boolean" ? "—" : "";
    if (t === "boolean") return v ? "✓" : "—";
    if (t === "many2one") return m2o(v);
    if (t === "many2many") { const names = new Map(opts[meta[f].relation] || []); return (v || []).map((id) => names.get(id) || `#${id}`).join(", "); }
    if (t === "selection") return (meta[f].selection || []).find(([k]) => k === v)?.[1] || v;
    if (t === "datetime") return local(v, { date: true });
    if (t === "html") return String(v).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return String(v);
  };

  /* ---- save / delete ---- */
  const save = async () => {
    const vals = {};
    for (const f of c.form || []) {
      if (typeof f !== "string" || !meta[f] || ro(f) || meta[f].type === "one2many") continue;
      let v = edit[f];
      if (meta[f].type === "many2many") {
        const ids = [...(v || [])].map(Number).sort((a, b) => a - b);
        if (edit.id && JSON.stringify(ids) === JSON.stringify([...(edit._orig?.[f] || [])].map(Number).sort((a, b) => a - b))) continue;
        vals[f] = [[6, 0, ids]];
        continue;
      }
      if (meta[f].type === "many2one") v = idOf(v) ? Number(idOf(v)) : false;
      else if (meta[f].type === "integer") v = v === "" || v == null ? 0 : parseInt(v, 10) || 0;
      else if (meta[f].type === "float") v = v === "" || v == null ? 0 : parseFloat(v) || 0;
      else if (meta[f].type === "boolean") v = !!v;
      else if (v === "" || v == null) v = false;
      if (edit.id && JSON.stringify(v) === JSON.stringify(edit._orig?.[f])) continue;
      vals[f] = v;
    }
    const empty = (f) => (f in vals ? vals[f] === false || vals[f] === "" : !edit[f]);
    const missing = (c.form || []).find((f) => typeof f === "string" && needed(f) && !hidden(f) && !ro(f) && empty(f) && !(edit.id && !(f in vals) && !c.requiredIf?.[f]));
    if (missing) { flags.err(`${label(missing)} is required.`); return; }
    setBusy("save");
    try {
      if (edit.id) { if (Object.keys(vals).length) await callKw(c.model, "write", [[edit.id], vals]); }
      else await callKw(c.model, "create", [[vals]]);
      flags.ok(edit.id ? "Saved." : "Added."); setEdit(null); load();
    } catch (e) { flags.err(e.message); } finally { setBusy(""); }
  };
  const del = async (r) => {
    if (!(await dlg.confirm({ title: "Delete?", text: `"${r.display_name || r.name || r[c.list?.[0]] || r.id}" will be deleted.${c.archive ? " Archiving keeps it instead." : ""}`, confirmLabel: "Delete", danger: true }))) return;
    try { await callKw(c.model, "unlink", [[r.id]]); flags.ok("Deleted."); setEdit(null); load(); } catch (e) { flags.err(e.message); }
  };
  const archive = async (r) => { try { await callKw(c.model, "write", [[r.id], { active: !r.active }]); flags.ok(r.active ? "Archived." : "Restored."); load(); } catch (e) { flags.err(e.message); } };

  /* ---- buttons (Odoo object buttons) ---- */
  /* `ids` runs the button on several ticked rows at once, as Odoo's list does. */
  const run = async (act, rec, ids) => {
    if (act.confirm && !(await dlg.confirm({ title: act.label, text: act.confirm, confirmLabel: act.label, danger: !!act.danger }))) return;
    setBusy(act.method + (ids ? "bulk" : rec.id));
    try {
      const r = await callKw(c.model, act.method, [ids || [rec.id]]);
      if (ids) {
        if (r?.type === "ir.actions.act_window" && r.target === "new" && act.wizard) { setWizard({ act, rec, ids, ctx: r.context || {}, vals: { ...(act.wizard.defaults || {}) } }); return; }
        flags.ok(notice(r) || act.done || `${act.label}: done.`); setPicked([]); load();
        return;
      }
      if (r?.type === "ir.actions.act_window" && r.target === "new" && act.wizard) { setWizard({ act, rec, ctx: r.context || {}, vals: { ...(act.wizard.defaults || {}) } }); return; }
      if (r?.type === "ir.actions.act_window" && act.href) { location.href = act.href(rec); return; }
      /* A button that opens a list in Odoo (e.g. "See the tasks"): read the
         same model with the action's own domain and context, shown in a dialog. */
      if (r?.type === "ir.actions.act_window" && act.records) {
        const rows = await callKw(r.res_model, "search_read", [r.domain || []], { fields: act.records.fields, order: act.records.order || "id desc", limit: 500, context: r.context || {} });
        setRecords({ act, title: r.name || act.label, rows: rows || [] });
        return;
      }
      flags.ok(notice(r) || act.done || `${act.label}: done.`);
      if (edit?.id === rec.id) reopen(rec.id);
      load();
    } catch (e) { flags.err(e.message); } finally { setBusy(""); }
  };
  const applyWizard = async () => {
    const { act, rec, ctx, vals } = wizard;
    const missing = (act.wizard.fields || []).find((f) => f.required && !String(vals[f.name] ?? "").trim());
    if (missing) { flags.err(`${missing.label} is required.`); return; }
    setBusy("wizard");
    try {
      const id = await callKw(act.wizard.model, "create", [[vals]], { context: ctx });
      const r = await callKw(act.wizard.model, act.wizard.apply, [[idOf(id)]], { context: ctx });
      flags.ok(notice(r) || act.done || `${act.label}: done.`);
      setWizard(null);
      if (wizard.ids) setPicked([]);
      else if (edit?.id === rec.id) reopen(rec.id);
      load();
    } catch (e) { flags.err(e.message); } finally { setBusy(""); }
  };

  const open = async (r) => {
    const f = fields.filter((x) => meta[x] && meta[x].type !== "one2many");
    try {
      const [full] = await callKw(c.model, "read", [[r.id], f], { context: { active_test: false } });
      setEdit({ ...full, _orig: full });
    } catch (e) { flags.err(e.message); }
  };
  const reopen = (id) => open({ id });

  const visibleActs = (rec, where) => (c.actions || []).filter((a) => (where === "list" ? a.list : true) && (!a.show || a.show(rec)));
  const shown = (rows || []).filter((r) => !c.archive || archived || r.active !== false);
  /* Odoo's "Group by": a header row per value, in the list's order. */
  const gb = c.groupBy?.find((g) => g.key === groupBy);
  const groups = useMemo(() => {
    if (!gb) return [{ key: "", rows: shown }];
    const out = new Map();
    for (const r of shown) { const k = show(gb.field, r[gb.field]) || "None"; if (!out.has(k)) out.set(k, []); out.get(k).push(r); }
    return [...out.entries()].sort(([a], [b]) => (a === "None") - (b === "None") || a.localeCompare(b)).map(([key, rs]) => ({ key, rows: rs }));
  }, [gb, shown]); // eslint-disable-line react-hooks/exhaustive-deps
  const bulkActs = (c.actions || []).filter((a) => a.bulk);
  const pickedRows = shown.filter((r) => picked.includes(r.id));
  const cols = (c.list || []).length + (c.archive ? 1 : 0) + 1 + (c.bulk ? 1 : 0);
  const flip = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const toolbar = (c.search?.length || c.filters?.length || c.groupBy?.length || (c.bulk && pickedRows.length > 0)) && (
    <div className="toolbar" style={{ flexWrap: "wrap", gap: 8 }}>
      {c.search?.length > 0 && (
        <Input icon="search" type="search" value={qDraft} placeholder="Search…" aria-label="Search" style={{ width: 240 }}
          onChange={(e) => setQDraft(e.target.value)} onBlur={() => setQ(qDraft)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setQ(qDraft); } }} />
      )}
      {(c.filters || []).map((f) => {
        const on = onFilters.includes(f.key);
        return <button key={f.key} type="button" className={`pill${on ? " on" : ""}`} aria-pressed={on} onClick={() => setOnFilters((o) => (on ? o.filter((k) => k !== f.key) : [...o, f.key]))}>{f.label}</button>;
      })}
      {c.groupBy?.length > 0 && (
        <span className="input" style={{ width: 180 }}><Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={{ border: 0, background: "none", width: "100%" }} aria-label="Group by">
          <option value="">Group by…</option>{c.groupBy.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
        </Select></span>
      )}
      {c.bulk && pickedRows.length > 0 && (
        <span className="right" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span className="mini">{pickedRows.length} selected</span>
          {bulkActs.map((a) => <Button key={a.method} size="sm" kind={a.danger ? "danger" : "default"} busy={busy === `${a.method}bulk`} onClick={() => run(a, pickedRows[0], pickedRows.map((r) => r.id))}>{a.label}</Button>)}
          <Button size="sm" kind="ghost" onClick={() => setPicked([])}>Clear</Button>
        </span>
      )}
    </div>
  );

  const table = (
    <div className="cardbox table-scroll" style={{ padding: 0 }}>
      {err && !rows && <div style={{ padding: 16 }}><ErrorState error={err} onRetry={load} /></div>}
      {!rows && !err ? <div style={{ padding: 16 }}><Skeleton rows={5} /></div> : rows && (
        <table className="table">
          <thead><tr>{c.bulk && <th style={{ width: 28 }}><input type="checkbox" aria-label="Select all" checked={shown.length > 0 && pickedRows.length === shown.length} onChange={(e) => setPicked(e.target.checked ? shown.map((r) => r.id) : [])} /></th>}{(c.list || []).map((f) => <th key={f}>{label(f)}</th>)}{c.archive && <th>Status</th>}<th></th></tr></thead>
          <tbody>
            {groups.map((g) => [
              gb && <tr key={`g${g.key}`}><td colSpan={cols} style={{ background: "var(--hover)", fontWeight: 700 }}>{g.key} <span className="mini">({g.rows.length})</span></td></tr>,
              ...g.rows.map((r) => (
              <tr key={r.id} onClick={() => open(r)} style={{ cursor: "pointer" }}>
                {c.bulk && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label="Select" checked={picked.includes(r.id)} onChange={() => flip(r.id)} /></td>}
                {(c.list || []).map((f, i) => <td key={f}>{i === 0 ? <b>{show(f, r[f])}</b> : show(f, r[f])}</td>)}
                {c.archive && <td>{r.active === false ? <Lozenge tone="todo">Archived</Lozenge> : <Lozenge tone="done">Active</Lozenge>}</td>}
                <td className="num" onClick={(e) => e.stopPropagation()}><span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                  {visibleActs(r, "list").map((a) => <Button key={a.method} size="sm" kind={a.danger ? "danger" : "default"} busy={busy === a.method + r.id} onClick={() => run(a, r)}>{a.label}</Button>)}
                  {!c.readonly && <IconButton icon="pen" label="Edit" size={15} onClick={() => open(r)} />}
                  {c.archive && !c.readonly && <IconButton icon={r.active === false ? "eye" : "eyeoff"} label={r.active === false ? "Restore" : "Archive"} size={15} onClick={() => archive(r)} />}
                  {c.del && !c.readonly && <IconButton icon="trash" label="Delete" size={15} onClick={() => del(r)} />}
                </span></td>
              </tr>
            ))])}
            {!shown.length && <tr><td colSpan={cols} className="empty">{c.empty || "Nothing here yet."}</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  );

  return (
    <>
      {!embedded && (
        <PageHeader crumbs={[{ label: c.crumb || "Setup" }, { label: c.title }]} title={c.title} meta={c.meta}>
          {c.archive && <label className="chk"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} />Show archived</label>}
          {c.create && !c.readonly && meta && <Button kind="primary" icon="plus" onClick={() => setEdit({ active: true, _orig: {} })}>New</Button>}
        </PageHeader>
      )}
      {!embedded && c.settingsNav && <SettingsNav />}
      <div className="page" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {embedded && c.create && !c.readonly && meta && <div className="row" style={{ justifyContent: "flex-end" }}><Button kind="primary" icon="plus" onClick={() => setEdit({ active: true, _orig: {} })}>New {c.noun || ""}</Button></div>}
        {c.tabs && <Tabs items={c.tabs.map((t) => ({ key: t.key, label: t.label }))} value={tab} onChange={setTab} />}
        {c.intro && <p className="note" style={{ margin: 0 }}>{c.intro}</p>}
        {toolbar}
        {table}
      </div>

      {edit && meta && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? (edit.display_name || edit.name || c.title) : `New ${c.noun || "record"}`} width={c.formWidth || 620}
          footer={<>
            {edit.id && c.del && !c.readonly && <Button kind="ghost" onClick={() => del(edit)} style={{ marginRight: "auto", color: "var(--danger)" }}>Delete</Button>}
            {edit.id && visibleActs(edit, "form").map((a) => <Button key={a.method} kind={a.danger ? "danger" : "default"} busy={busy === a.method + edit.id} onClick={() => run(a, edit)}>{a.label}</Button>)}
            <Button kind="ghost" onClick={() => setEdit(null)}>{c.readonly ? "Close" : "Cancel"}</Button>
            {!c.readonly && <Button kind="primary" busy={busy === "save"} onClick={save}>{edit.id ? "Save" : "Add"}</Button>}
          </>}>
          {(c.alerts || []).filter((a) => a.show(edit)).map((a, i) => (
            <div key={i} className="callout" style={ALERT[a.tone] || ALERT.warn}><span>{a.text}</span></div>
          ))}
          <div className="rs-form">
            {(c.form || []).map((f, i) => typeof f === "string"
              ? (meta[f] && !hidden(f) && <FieldInput key={f} name={f} m={needed(f) ? { ...meta[f], required: true } : meta[f]} value={edit[f]} readOnly={ro(f) || (!!edit.id && c.lockOnEdit?.includes(f))} secret={c.secret?.includes(f)} options={opts[meta[f].relation]} show={show}
                  onChange={(v) => setEdit((e) => ({ ...e, [f]: v }))} />)
              : (!f.hideIf?.(edit) && <h3 key={`s${i}`} className="rs-section">{f.section}</h3>))}
          </div>
          {edit.id && c.children && <ChildTabs list={(Array.isArray(c.children) ? c.children : [c.children]).filter((cfg) => !cfg.hideIf?.(edit))} parentId={edit.id} parentModel={c.model} />}
        </Modal>
      )}

      {records && (
        <Modal open onClose={() => setRecords(null)} title={records.title} width={760}>
          {records.rows.length ? (
            <div className="table-scroll">
              <table className="table">
                <thead><tr>{records.act.records.columns.map((col) => <th key={col.key}>{col.label}</th>)}</tr></thead>
                <tbody>{records.rows.map((row) => (
                  <tr key={row.id} onClick={records.act.records.href ? () => { location.href = records.act.records.href(row); } : undefined} style={records.act.records.href ? { cursor: "pointer" } : undefined}>
                    {records.act.records.columns.map((col) => <td key={col.key}>{col.render ? col.render(row) : (Array.isArray(row[col.key]) ? m2o(row[col.key]) : row[col.key] || "—")}</td>)}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <p className="note" style={{ margin: 0 }}>Nothing here yet.</p>}
        </Modal>
      )}

      {wizard && (
        <Modal open onClose={() => setWizard(null)} title={wizard.act.wizard.title || wizard.act.label} width={480}
          footer={<><Button kind="ghost" onClick={() => setWizard(null)}>Cancel</Button><Button kind={wizard.act.danger ? "danger" : "primary"} busy={busy === "wizard"} onClick={applyWizard}>{wizard.act.wizard.confirmLabel || "Confirm"}</Button></>}>
          {wizard.act.wizard.text && <p className="note" style={{ marginTop: 0 }}>{wizard.act.wizard.text(wizard.rec)}</p>}
          {(wizard.act.wizard.fields || []).map((f) => f.type === "boolean"
            ? <label key={f.name} className="chk"><input type="checkbox" checked={!!wizard.vals[f.name]} onChange={(e) => setWizard((w) => ({ ...w, vals: { ...w.vals, [f.name]: e.target.checked } }))} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} />{f.label}</label>
            : <Field key={f.name} label={f.label} required={f.required}><span className="input ta" style={{ height: 84 }}><textarea value={wizard.vals[f.name] || ""} onChange={(e) => setWizard((w) => ({ ...w, vals: { ...w.vals, [f.name]: e.target.value } }))} style={{ border: 0, background: "none", outline: 0, resize: "none", width: "100%", height: "100%", font: "inherit", color: "inherit" }} /></span></Field>)}
        </Modal>
      )}
    </>
  );
}

export function FieldInput({ name, m, value, readOnly, secret, options, show, onChange }) {
  const [reveal, setReveal] = useState(false);
  const plain = { border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: "100%" };
  const wide = m.type === "text" || m.type === "html";
  if (readOnly) {
    if (m.type === "html") return <Field label={m.string}><div className="rs-html" dangerouslySetInnerHTML={{ __html: value || "" }} /></Field>;
    return <Field label={m.string} className={wide ? "rs-wide" : ""}><span className="rs-ro">{show(name, value) || "—"}</span></Field>;
  }
  if (m.type === "boolean") return <label className="chk rs-bool" title={m.help || undefined}><input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} />{m.string}</label>;
  if (m.type === "text") return <Field label={m.string} required={m.required} hint={m.help} className="rs-wide"><span className="input ta" style={{ height: 84 }}><textarea value={value || ""} onChange={(e) => onChange(e.target.value)} style={{ ...plain, resize: "vertical", height: "100%" }} /></span></Field>;
  if (m.type === "selection") return <Field label={m.string} required={m.required}><span className="input"><Select value={value || ""} onChange={(e) => onChange(e.target.value || false)} style={plain}>{!m.required && <option value="">—</option>}{(m.selection || []).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></span></Field>;
  if (m.type === "many2many") {
    const on = new Set((value || []).map(Number));
    const flip = (id) => { const n = new Set(on); if (n.has(id)) n.delete(id); else n.add(id); onChange([...n]); };
    return (
      <Field label={m.string} required={m.required} hint={m.help} className="rs-wide">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 180, overflowY: "auto", padding: 6, border: "1px solid var(--border)", borderRadius: 8 }}>
          {!options && <span className="mini">Loading…</span>}
          {(options || []).map(([id, n]) => (
            <label key={id} className="chk" style={{ display: "inline-flex", gap: 6, alignItems: "center", padding: "2px 8px", borderRadius: 999, border: "1px solid var(--border)", background: on.has(id) ? "var(--hover)" : undefined, cursor: "pointer", fontSize: 13 }}>
              <input type="checkbox" checked={on.has(id)} onChange={() => flip(id)} style={{ accentColor: "var(--brand)" }} />{n}
            </label>
          ))}
        </div>
      </Field>
    );
  }
  if (m.type === "many2one") return <Field label={m.string} required={m.required}><span className="input"><Select value={String(idOf(value) || "")} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : false)} placeholder={options ? "—" : "Loading…"} style={plain}><option value="">—</option>{(options || []).map(([id, n]) => <option key={id} value={String(id)}>{n}</option>)}</Select></span></Field>;
  const type = m.type === "integer" || m.type === "float" ? "number" : m.type === "date" ? "date" : secret && !reveal ? "password" : "text";
  return (
    <Field label={m.string} required={m.required} hint={m.type === "char" ? undefined : m.help}>
      <Input type={type} value={value === false || value == null ? "" : value} autoComplete={secret ? "off" : undefined} onChange={(e) => onChange(e.target.value)}
        right={secret ? <button type="button" className="icon-btn" style={{ width: 26, height: 26 }} aria-label={reveal ? "Hide" : "Show"} onClick={() => setReveal((s) => !s)}>{reveal ? "🙈" : "👁"}</button> : null} />
    </Field>
  );
}

/* Sub-lists in the form, one tab each when there are several (Odoo's notebook pages). */
function ChildTabs({ list, parentId, parentModel }) {
  const [tab, setTab] = useState(0);
  if (!list.length) return null;
  if (list.length === 1) return <Children cfg={list[0]} parentId={parentId} parentModel={parentModel} />;
  const cur = list[Math.min(tab, list.length - 1)];
  return (
    <div style={{ marginTop: 14 }}>
      <Tabs items={list.map((cfg, i) => ({ key: i, label: cfg.label }))} value={Math.min(tab, list.length - 1)} onChange={setTab} />
      {cur.note && <p className="note" style={{ margin: "8px 0 0" }}>{cur.note}</p>}
      <Children key={tab} cfg={cur} parentId={parentId} parentModel={parentModel} bare />
    </div>
  );
}

/* Sub-list (members of a group, messages of a chat). `edit: {field: relation}`
   makes those columns editable per row, saved at once (Odoo's editable list). */
function Children({ cfg, parentId, parentModel, bare }) {
  const flags = useFlags();
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState(null);
  const [opts, setOpts] = useState({});
  const [openRow, setOpenRow] = useState(null); /* cfg.expand: the row whose long field shows */
  useEffect(() => {
    /* `ids: "field"` lists the records a (computed) x2many on the parent holds. */
    const dom = cfg.ids
      ? callKw(parentModel, "read", [[parentId], [cfg.ids]]).then((r) => [["id", "in", r?.[0]?.[cfg.ids] || []]])
      : Promise.resolve([[cfg.field, "=", parentId]]);
    Promise.all([
      callKw(cfg.model, "fields_get", [], { attributes: ["string", "type", "selection"] }),
      dom.then((d) => callKw(cfg.model, "search_read", [d], { fields: [...cfg.list, ...(cfg.expand ? [cfg.expand] : [])], order: cfg.order || "id", limit: 500, context: cfg.ids ? { active_test: false } : {} })),
    ]).then(([m, r]) => { setMeta(m); setRows(r || []); }).catch(() => setRows([]));
    for (const rel of new Set(Object.values(cfg.edit || {}))) {
      callKw(rel, "name_search", [], { name: "", limit: 300 }).then((r) => setOpts((o) => ({ ...o, [rel]: r || [] }))).catch(() => {});
    }
  }, [cfg, parentId, parentModel]);
  const setCell = async (row, f, id) => {
    try {
      await callKw(cfg.model, "write", [[row.id], { [f]: id || false }]);
      const name = (opts[cfg.edit[f]] || []).find(([x]) => x === id)?.[1];
      setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, [f]: id ? [id, name] : false } : r)));
      flags.ok("Saved.");
    } catch (e) { flags.err(e.message); }
  };
  const show = (f, v) => {
    const t = meta?.[f]?.type;
    if (v === false || v == null) return t === "boolean" ? "—" : "";
    if (t === "boolean") return v ? "✓" : "—";
    if (t === "many2one") return m2o(v);
    if (t === "selection") return (meta[f].selection || []).find(([k]) => k === v)?.[1] || v;
    if (t === "datetime") return local(v, { date: true });
    return String(v);
  };
  return (
    <div style={{ marginTop: bare ? 8 : 14 }}>
      {!bare && <h3 className="rs-section">{cfg.label}{rows ? ` (${rows.length})` : ""}</h3>}
      {!rows ? <Skeleton rows={3} /> : (
        <div className="table-scroll" style={{ maxHeight: 280 }}>
          <table className="table">
            <thead><tr>{cfg.list.map((f) => <th key={f}>{cfg.labels?.[f] || meta?.[f]?.string || f}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => [
                <tr key={r.id} onClick={cfg.expand && r[cfg.expand] ? () => setOpenRow((o) => (o === r.id ? null : r.id)) : undefined} style={cfg.expand && r[cfg.expand] ? { cursor: "pointer" } : undefined}>{cfg.list.map((f) => <td key={f} style={cfg.pre?.includes(f) ? { whiteSpace: "pre-wrap" } : undefined}>
                {cfg.edit?.[f]
                  ? <span className="input" style={{ height: 30, minWidth: 160 }} onClick={(e) => e.stopPropagation()}><Select value={String(idOf(r[f]) || "")} onChange={(e) => setCell(r, f, e.target.value ? Number(e.target.value) : false)} style={{ border: 0, background: "none", width: "100%" }}><option value="">—</option>{(opts[cfg.edit[f]] || []).map(([id, n]) => <option key={id} value={String(id)}>{n}</option>)}</Select></span>
                  : show(f, r[f])}
              </td>)}</tr>,
                cfg.expand && openRow === r.id && <tr key={`x${r.id}`}><td colSpan={cfg.list.length}><div className="rs-html" dangerouslySetInnerHTML={{ __html: r[cfg.expand] || "" }} /></td></tr>,
              ])}
              {!rows.length && <tr><td colSpan={cfg.list.length} className="empty">{cfg.empty || "None."}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
