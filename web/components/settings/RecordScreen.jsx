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
     system: true                                  System administrators only
   } */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, ErrorState, Field, IconButton, Input, Lozenge, Modal, PageHeader, Select, Skeleton, Tabs, useDialogs, useFlags } from "@/components/ui";
import { callKw } from "@/lib/api";
import { local, m2o, notice } from "@/lib/services/sysadmin";
import SettingsNav from "./SettingsNav";
import SystemOnly from "./SystemOnly";

const ATTRS = ["string", "type", "required", "readonly", "selection", "relation", "help"];
const idOf = (r) => (Array.isArray(r) ? r[0] : r);

export default function RecordScreen({ config, embedded = false }) {
  const body = <Screen config={config} embedded={embedded} />;
  return config.system ? <SystemOnly title={config.title}>{body}</SystemOnly> : body;
}

function Screen({ config: c, embedded }) {
  const flags = useFlags();
  const dlg = useDialogs();
  const [meta, setMeta] = useState(null);
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState(c.tabs?.[0]?.key || "");
  const [archived, setArchived] = useState(false);
  const [edit, setEdit] = useState(null);     /* the record in the form ({} = new) */
  const [opts, setOpts] = useState({});       /* many2one choices per relation */
  const [busy, setBusy] = useState("");
  const [wizard, setWizard] = useState(null); /* {act, rec, ctx} */

  const fields = useMemo(() => [...new Set([...(c.list || []), ...(c.form || []).filter((f) => typeof f === "string"), ...(c.archive ? ["active"] : [])])], [c]);
  const domain = useMemo(() => [...(c.domain || []), ...(c.tabs?.find((t) => t.key === tab)?.domain || [])], [c, tab]);

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

  /* Choices for every many2one the form edits. */
  useEffect(() => {
    if (!meta || !edit) return;
    const rels = [...new Set((c.form || []).filter((f) => typeof f === "string" && meta[f]?.type === "many2one" && !ro(f)).map((f) => meta[f].relation))];
    rels.filter((rel) => !opts[rel]).forEach((rel) => callKw(rel, "name_search", [], { name: "", limit: 300 })
      .then((r) => setOpts((o) => ({ ...o, [rel]: r || [] }))).catch(() => setOpts((o) => ({ ...o, [rel]: [] }))));
  }, [meta, edit]); // eslint-disable-line react-hooks/exhaustive-deps

  const ro = (f) => c.readonly || !!meta?.[f]?.readonly;
  const label = (f) => meta?.[f]?.string || f;
  const show = (f, v) => {
    const t = meta?.[f]?.type;
    if (v === false || v == null || v === "") return t === "boolean" ? "—" : "";
    if (t === "boolean") return v ? "✓" : "—";
    if (t === "many2one") return m2o(v);
    if (t === "selection") return (meta[f].selection || []).find(([k]) => k === v)?.[1] || v;
    if (t === "datetime") return local(v, { date: true });
    if (t === "html") return String(v).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return String(v);
  };

  /* ---- save / delete ---- */
  const save = async () => {
    const vals = {};
    for (const f of c.form || []) {
      if (typeof f !== "string" || !meta[f] || ro(f) || meta[f].type === "one2many" || meta[f].type === "many2many") continue;
      let v = edit[f];
      if (meta[f].type === "many2one") v = idOf(v) ? Number(idOf(v)) : false;
      else if (meta[f].type === "integer") v = v === "" || v == null ? 0 : parseInt(v, 10) || 0;
      else if (meta[f].type === "float") v = v === "" || v == null ? 0 : parseFloat(v) || 0;
      else if (meta[f].type === "boolean") v = !!v;
      else if (v === "" || v == null) v = false;
      if (edit.id && JSON.stringify(v) === JSON.stringify(edit._orig?.[f])) continue;
      vals[f] = v;
    }
    const missing = (c.form || []).find((f) => typeof f === "string" && meta[f]?.required && !ro(f) && (vals[f] === false || vals[f] === "") && !(edit.id && !(f in vals)));
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
  const run = async (act, rec) => {
    if (act.confirm && !(await dlg.confirm({ title: act.label, text: act.confirm, confirmLabel: act.label, danger: !!act.danger }))) return;
    setBusy(act.method + rec.id);
    try {
      const r = await callKw(c.model, act.method, [[rec.id]]);
      if (r?.type === "ir.actions.act_window" && r.target === "new" && act.wizard) { setWizard({ act, rec, ctx: r.context || {}, vals: { ...(act.wizard.defaults || {}) } }); return; }
      if (r?.type === "ir.actions.act_window" && act.href) { location.href = act.href(rec); return; }
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
      if (edit?.id === rec.id) reopen(rec.id);
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

  const table = (
    <div className="cardbox table-scroll" style={{ padding: 0 }}>
      {err && !rows && <div style={{ padding: 16 }}><ErrorState error={err} onRetry={load} /></div>}
      {!rows && !err ? <div style={{ padding: 16 }}><Skeleton rows={5} /></div> : rows && (
        <table className="table">
          <thead><tr>{(c.list || []).map((f) => <th key={f}>{label(f)}</th>)}{c.archive && <th>Status</th>}<th></th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} onClick={() => open(r)} style={{ cursor: "pointer" }}>
                {(c.list || []).map((f, i) => <td key={f}>{i === 0 ? <b>{show(f, r[f])}</b> : show(f, r[f])}</td>)}
                {c.archive && <td>{r.active === false ? <Lozenge tone="todo">Archived</Lozenge> : <Lozenge tone="done">Active</Lozenge>}</td>}
                <td className="num" onClick={(e) => e.stopPropagation()}><span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                  {visibleActs(r, "list").map((a) => <Button key={a.method} size="sm" kind={a.danger ? "danger" : "default"} busy={busy === a.method + r.id} onClick={() => run(a, r)}>{a.label}</Button>)}
                  {!c.readonly && <IconButton icon="pen" label="Edit" size={15} onClick={() => open(r)} />}
                  {c.archive && !c.readonly && <IconButton icon={r.active === false ? "eye" : "eyeoff"} label={r.active === false ? "Restore" : "Archive"} size={15} onClick={() => archive(r)} />}
                  {c.del && !c.readonly && <IconButton icon="trash" label="Delete" size={15} onClick={() => del(r)} />}
                </span></td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={(c.list || []).length + 2} className="empty">{c.empty || "Nothing here yet."}</td></tr>}
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
          <div className="rs-form">
            {(c.form || []).map((f, i) => typeof f === "string"
              ? (meta[f] && <FieldInput key={f} name={f} m={meta[f]} value={edit[f]} readOnly={ro(f) || (!!edit.id && c.lockOnEdit?.includes(f))} secret={c.secret?.includes(f)} options={opts[meta[f].relation]} show={show}
                  onChange={(v) => setEdit((e) => ({ ...e, [f]: v }))} />)
              : <h3 key={`s${i}`} className="rs-section">{f.section}</h3>)}
          </div>
          {edit.id && c.children && <Children cfg={c.children} parentId={edit.id} />}
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
  if (m.type === "many2one") return <Field label={m.string} required={m.required}><span className="input"><Select value={String(idOf(value) || "")} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : false)} placeholder={options ? "—" : "Loading…"} style={plain}><option value="">—</option>{(options || []).map(([id, n]) => <option key={id} value={String(id)}>{n}</option>)}</Select></span></Field>;
  const type = m.type === "integer" || m.type === "float" ? "number" : m.type === "date" ? "date" : secret && !reveal ? "password" : "text";
  return (
    <Field label={m.string} required={m.required} hint={m.type === "char" ? undefined : m.help}>
      <Input type={type} value={value === false || value == null ? "" : value} autoComplete={secret ? "off" : undefined} onChange={(e) => onChange(e.target.value)}
        right={secret ? <button type="button" className="icon-btn" style={{ width: 26, height: 26 }} aria-label={reveal ? "Hide" : "Show"} onClick={() => setReveal((s) => !s)}>{reveal ? "🙈" : "👁"}</button> : null} />
    </Field>
  );
}

/* Read-only sub-list (members of a group, messages of a chat). */
function Children({ cfg, parentId }) {
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState(null);
  useEffect(() => {
    Promise.all([
      callKw(cfg.model, "fields_get", [], { attributes: ["string", "type", "selection"] }),
      callKw(cfg.model, "search_read", [[[cfg.field, "=", parentId]]], { fields: cfg.list, order: cfg.order || "id", limit: 500 }),
    ]).then(([m, r]) => { setMeta(m); setRows(r || []); }).catch(() => setRows([]));
  }, [cfg, parentId]);
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
    <div style={{ marginTop: 14 }}>
      <h3 className="rs-section">{cfg.label}{rows ? ` (${rows.length})` : ""}</h3>
      {!rows ? <Skeleton rows={3} /> : (
        <div className="table-scroll" style={{ maxHeight: 280 }}>
          <table className="table">
            <thead><tr>{cfg.list.map((f) => <th key={f}>{meta?.[f]?.string || f}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => <tr key={r.id}>{cfg.list.map((f) => <td key={f} style={cfg.pre?.includes(f) ? { whiteSpace: "pre-wrap" } : undefined}>{show(f, r[f])}</td>)}</tr>)}
              {!rows.length && <tr><td colSpan={cfg.list.length} className="empty">{cfg.empty || "None."}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
