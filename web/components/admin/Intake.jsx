"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Icon, Input, PageHeader, Tabs, useFlags, Select } from "@/components/ui";
import { useMe } from "@/lib/me";
import * as A from "@/lib/services/admin";
import IntakeNav from "./IntakeNav";
import { PRIORITIES, DELIVERABLES } from "@/lib/services/kpiActions";

/* Upload requirements / updates / bug reports (Odoo's kpi_requirements_upload):
   destination → source (a source document attached to every task, plus an
   XLSX / CSV task list, or pasted text → AI suggestions) → review rows →
   create all. The same component serves the client portal's "New request"
   bulk path: in client mode (Odoo's is_client_only) hours, minutes, priority
   and developer are hidden, and the type (Module / App / EXE) starts blank and
   must be chosen. Update / Bug rows can name the requirement they belong to
   ("Linked Req"). */
const SEL = { border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" };
const CELL = { border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" };
const SOURCE_ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt";

export default function Intake({ docType = "requirement", portal = false }) {
  const { me } = useMe();
  const flags = useFlags();
  const router = useRouter();
  const clientMode = portal || me.role === "client";
  const staff = !clientMode;
  const [type, setType] = useState(docType);
  const [clients, setClients] = useState([]); const [client, setClient] = useState("");
  const [kras, setKras] = useState([]); const [kra, setKra] = useState("");
  const [users, setUsers] = useState([]);
  const [defUser, setDefUser] = useState(""); const [defPri, setDefPri] = useState("regular"); const [defDeliv, setDefDeliv] = useState("");
  const [version, setVersion] = useState("");
  const [text, setText] = useState("");
  const [source, setSource] = useState(null); /* { name, b64 }: attached to every created task */
  const [listName, setListName] = useState(""); /* the task-list file last imported */
  const [rows, setRows] = useState([]);
  const [nextRef, setNextRef] = useState(null);
  const [busy, setBusy] = useState("");
  const linked = type !== "requirement";

  useEffect(() => { A.getClients().then((c) => { setClients(c); if (c.length === 1) setClient(String(c[0].id)); }).catch((e) => flags.err(e.message)); if (staff) A.getIntakeUsers().then(setUsers).catch(() => {}); }, [staff]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!client) { setKras([]); return; } A.getSubKras(+client).then((k) => { setKras(k); setKra(k[0] ? String(k[0].id) : ""); }).catch(() => setKras([])); }, [client]);
  useEffect(() => { A.peekNextRef(type).then(setNextRef).catch(() => {}); }, [type]);

  const blank = () => ({ name: "", external_ref: "", related_req_ref: "", estimate_hours: staff ? 1 : 0, estimate_minutes: 0, priority: defPri, deliverable_type: defDeliv, primary_user_id: defUser, description: "" });
  /* Merge imported / suggested rows; skip ones already in the table (same ref, or same name). */
  const addRows = (items) => setRows((r) => {
    const refs = new Set(r.map((x) => (x.external_ref || "").toLowerCase()).filter(Boolean));
    const names = new Set(r.map((x) => (x.name || "").toLowerCase()).filter(Boolean));
    const out = [...r];
    for (const it of items) {
      const o = typeof it === "string" ? { name: it } : it;
      const name = (o.name || "").trim(), ref = (o.external_ref || "").trim();
      if (name && (ref ? refs.has(ref.toLowerCase()) : names.has(name.toLowerCase()))) continue;
      if (ref) refs.add(ref.toLowerCase());
      if (name) names.add(name.toLowerCase());
      out.push({ ...blank(), ...o, name: o.name || "" });
    }
    return out;
  });

  const pickSource = async (e) => {
    const f = e.target.files?.[0]; e.target.value = "";
    if (!f) return;
    try { setSource({ name: f.name, b64: await A.fileToBase64(f) }); } catch (ex) { flags.err("Could not read that file."); }
  };
  const pickList = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    setBusy("file");
    try {
      const b64 = await A.fileToBase64(f);
      const r = await A.parseFile({ fileData: b64, fileName: f.name, docType: type });
      A.assertOk(r, "Could not read the file.");
      addRows(r.tasks || []);
      setListName(f.name);
      flags.ok(`${(r.tasks || []).length} rows read from ${f.name}${r.matched_column ? ` (column "${r.matched_column}")` : ""}.`);
    } catch (ex) { flags.err(ex.message); } finally { setBusy(""); e.target.value = ""; }
  };
  const suggest = async () => {
    if (!text.trim()) return;
    setBusy("ai");
    try { const r = await A.suggestTasks(text, type); A.assertOk(r, "Suggestion failed."); addRows(r.tasks || []); flags.ok(`${(r.tasks || []).length} tasks suggested (${r.source || "AI"}).`); setText(""); }
    catch (ex) { flags.err(ex.message); } finally { setBusy(""); }
  };
  const create = async () => {
    const valid = rows.filter((r) => r.name?.trim());
    if (!kra) { flags.err("Pick a client and project."); return; }
    if (!valid.length) { flags.err("Add at least one task."); return; }
    /* A blank row takes the default on the server, so only a row with neither is untyped. */
    const untyped = valid.filter((r) => !r.deliverable_type && !defDeliv);
    if (untyped.length) { flags.err(`Choose a type (Module, App or EXE) for: ${untyped.map((r) => r.name.trim()).join(", ")}`); return; }
    setBusy("create");
    try {
      const tasks = valid.map((r) => (staff ? A.buildTaskRow(r) : { ...A.buildTaskRow(r), estimate_hours: 0, estimate_minutes: 0, priority: "regular", primary_user_id: false }));
      const r = await A.createBulkTasks({ subKraId: +kra, docType: type, tasks, deliverableType: defDeliv, fileData: source?.b64 || "", fileName: source?.name || "", requirementVersion: version });
      A.assertOk(r, "Task creation failed.");
      flags.ok(`${r.created_count || valid.length} task${(r.created_count || valid.length) === 1 ? "" : "s"} created.`);
      setRows([]); setSource(null); setListName("");
      router.push(portal ? "/portal/requests" : staff ? "/queue" : "/board");
    } catch (ex) { flags.err(ex.message); } finally { setBusy(""); }
  };
  const total = rows.reduce((s, r) => s + (+r.estimate_hours || 0) * 60 + (+r.estimate_minutes || 0), 0);
  const upd = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const refOf = (i) => (nextRef ? `${nextRef.prefix}-${String((nextRef.next_number || 1) + i).padStart(3, "0")}` : "…");
  /* Admin: each tab is its own page (/intake/<type>). Portal: the tabs switch type in place. */
  const switchType = (k) => { setType(k); if (!portal) router.replace(`/intake/${k}`); };
  const cols = 4 + (linked ? 1 : 0) + (staff ? 4 : 0);
  const named = rows.filter((r) => r.name?.trim()).length;

  return (
    <>
      <PageHeader crumbs={[{ label: portal ? "Portal" : "Work" }, { label: "Upload " + (A.DOC_TYPES.find((d) => d.key === type)?.label.toLowerCase() || "") }]} title={portal ? "New requests" : "Upload requirements"}>
        <a className="btn btn-ghost" href={A.templateHref(type)} target="_blank" rel="noreferrer"><Icon n="download" size={16} />Blank template</a>
        <Tabs items={A.DOC_TYPES} value={type} onChange={switchType} />
      </PageHeader>
      {!portal && <IntakeNav />}
      <div className="g12" style={{ flex: 1, minHeight: 0, gridTemplateColumns: "minmax(0, 2fr) minmax(0, 3fr)" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="steps"><span className={client && kra ? "on" : ""}><b>1</b>Destination</span><span>›</span><span className={rows.length ? "on" : ""}><b>2</b>Source</span><span>›</span><span><b>3</b>Review &amp; create</span></div>
          <div className="cardbox"><h2>Destination</h2>
            <Field label="Client"><span className="input"><Select value={client} onChange={(e) => setClient(e.target.value)} style={SEL}><option value="">Choose a client</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.parent_name ? ` · ${c.parent_name}` : ""}</option>)}</Select></span></Field>
            <Field label="Project / sub-KRA"><span className="input"><Select value={kra} onChange={(e) => setKra(e.target.value)} disabled={!kras.length} style={SEL}>{kras.map((k) => <option key={k.id} value={k.id}>{k.display || k.name}</option>)}{!kras.length && <option value="">{client ? "No projects under this client" : "—"}</option>}</Select></span></Field>
            <div className="grid2">
              <Field label="Version (optional)"><Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="v2.3" /></Field>
              <Field label="Next ref"><span className="input" style={{ color: "var(--brand)", fontWeight: 800 }}>{refOf(0)}</span></Field>
            </div>
            <Field label={staff ? "Default type (Module / App / EXE)" : "Type for every row (or choose per row)"}><span className="input"><Select value={defDeliv} onChange={(e) => setDefDeliv(e.target.value)} style={SEL}><option value="">Choose…</option>{DELIVERABLES.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}</Select></span></Field>
            {staff && <div className="grid2">
              <Field label="Default developer"><span className="input"><Select value={defUser} onChange={(e) => setDefUser(e.target.value)} style={SEL}><option value="">Unassigned</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></span></Field>
              <Field label="Default priority"><span className="input"><Select value={defPri} onChange={(e) => setDefPri(e.target.value)} style={SEL}>{PRIORITIES.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}</Select></span></Field>
            </div>}
          </div>
          <div className="cardbox"><h2>Source</h2>
            <div className="field">Source document <span className="mini" style={{ fontWeight: 500 }}>attached to every created task (PDF, Word, Excel…)</span>
              <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <label className="btn" style={{ cursor: "pointer" }}><Icon n="doc" size={16} />{source ? "Replace" : "Choose a document"}<input type="file" accept={SOURCE_ACCEPT} hidden onChange={pickSource} /></label>
                {source && <span className="chip-sm" style={{ background: "var(--hover)", color: "var(--navy)" }}><Icon n="check" size={13} />{source.name}<button type="button" className="icon-btn" aria-label="Remove the source document" style={{ width: 20, height: 20 }} onClick={() => setSource(null)}><Icon n="x" size={12} /></button></span>}
              </span>
            </div>
            <label className="dropzone" style={{ cursor: "pointer" }}><b>{busy === "file" ? "Reading…" : listName ? `Imported ${listName} · add another` : "Import a task list (XLSX or CSV)"}</b>One task per row; a "Task" column is detected automatically.<input type="file" accept=".xlsx,.xls,.csv,.txt" hidden onChange={pickList} /></label>
            <Field label="…or paste the text"><span className="input ta" style={{ height: 110 }}><textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={"1. Happy hour pricing 4-7pm weekdays\n2. WhatsApp table reservation link"} style={{ ...CELL, resize: "none", height: "100%" }} /></span></Field>
            <div className="row"><Button kind="primary" busy={busy === "ai"} disabled={!text.trim()} onClick={suggest}>Suggest tasks with AI</Button><Button kind="ghost" onClick={() => addRows([""])}>+ Add a row</Button></div>
          </div>
        </div>
        <div className="cardbox" style={{ padding: 0, overflow: "hidden" }}>
          <h2 style={{ padding: "14px 16px 0" }}>Review <small>{rows.length} task{rows.length === 1 ? "" : "s"}{staff ? ` · ${Math.floor(total / 60)}h ${total % 60}m` : ""}</small><span className="right"><Button size="sm" onClick={() => addRows([""])}>+ Add row</Button>{rows.length > 0 && <Button size="sm" kind="ghost" onClick={() => setRows([])}>Clear</Button>}</span></h2>
          <div className="table-scroll" style={{ flex: 1 }}>
            <table className="table" style={{ marginTop: 8 }}>
              <thead><tr><th>Ref</th>{linked && <th title="The requirement this belongs to">Linked Req</th>}<th style={{ width: "34%" }}>Task</th>{staff && <><th>h</th><th>m</th><th>Priority</th></>}<th>Type *</th>{staff && <th>Developer</th>}<th></th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td><span className="ref" title="Assigned when created; the number can move if someone else adds tasks first">{refOf(i)}</span></td>
                    {linked && <td><span className="input" style={{ height: 32, width: 96 }}><input value={r.related_req_ref || ""} onChange={(e) => upd(i, { related_req_ref: e.target.value })} placeholder="REQ-001" style={CELL} /></span></td>}
                    <td><span className="input" style={{ height: 32 }}><input value={r.name} onChange={(e) => upd(i, { name: e.target.value })} placeholder="What needs doing" style={CELL} /></span></td>
                    {staff && <>
                      <td><span className="input" style={{ height: 32, width: 56 }}><input type="number" min="0" value={r.estimate_hours} onChange={(e) => upd(i, { estimate_hours: e.target.value })} style={CELL} /></span></td>
                      <td><span className="input" style={{ height: 32, width: 60 }}><input type="number" min="0" max="59" value={r.estimate_minutes} onChange={(e) => upd(i, { estimate_minutes: e.target.value })} style={CELL} /></span></td>
                      <td><span className="input" style={{ height: 32 }}><Select value={r.priority} onChange={(e) => upd(i, { priority: e.target.value })} style={SEL}>{PRIORITIES.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}</Select></span></td>
                    </>}
                    <td><span className="input" style={{ height: 32, borderColor: r.name?.trim() && !r.deliverable_type && !defDeliv ? "var(--danger)" : undefined }}><Select value={r.deliverable_type || ""} onChange={(e) => upd(i, { deliverable_type: e.target.value })} style={SEL}><option value="">{defDeliv ? `Default (${DELIVERABLES.find((d) => d.code === defDeliv)?.label})` : "Choose…"}</option>{DELIVERABLES.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}</Select></span></td>
                    {staff && <td><span className="input" style={{ height: 32 }}><Select value={r.primary_user_id || ""} onChange={(e) => upd(i, { primary_user_id: e.target.value })} style={SEL}><option value="">—</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></span></td>}
                    <td><button className="icon-btn" aria-label="Remove" style={{ width: 26, height: 26 }} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}><Icon n="x" size={14} /></button></td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={cols} className="empty">Nothing to review yet. Import a task list, paste text, or add a row.</td></tr>}
              </tbody>
            </table>
          </div>
          <div style={{ padding: "12px 16px", display: "flex", gap: 10, alignItems: "center", borderTop: "1px solid var(--border)" }}>
            <span className="mini">{portal ? "You'll get a WhatsApp message when each is estimated." : "Client pre-approval follows the Configuration switch."}{source ? ` ${source.name} is attached to each task.` : ""}</span>
            <span style={{ marginLeft: "auto" }}><Button kind="primary" busy={busy === "create"} disabled={!named || !kra} onClick={create}>Create {named || ""} task{named === 1 ? "" : "s"}</Button></span>
          </div>
        </div>
      </div>
    </>
  );
}
