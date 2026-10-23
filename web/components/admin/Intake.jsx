"use client";
import { useEffect, useState } from "react";
import { watchUploads } from "@/lib/api";
import { useRouter } from "next/navigation";
import { Button, Field, Icon, Input, PageHeader, Tabs, useFlags, Select } from "@/components/ui";
import { useMe } from "@/lib/me";
import * as A from "@/lib/services/admin";
import IntakeNav from "./IntakeNav";
import { PRIORITIES, DELIVERABLES, DELIVERABLE_OTHER_REQUIRED, deliverableLabel, deliverableOtherValue } from "@/lib/services/kpiActions";
import OtherTypeInput from "@/components/task/OtherTypeInput";
import * as L from "@/lib/services/legacy";

/* Upload requirements / updates / bug reports (Odoo's kpi_requirements_upload):
   destination → source (a source document attached to every task, plus an
   XLSX / CSV task list, or pasted text → AI suggestions) → review rows →
   create all. The same component serves the client portal's "New request"
   bulk path: in client mode (Odoo's is_client_only) hours, minutes, priority
   and developer are hidden, and the type (Module / App / EXE) starts blank and
   must be chosen. Update / Bug rows can name the requirement they belong to
   ("Linked Req"), or, ticked "Old DB", one from the old database: its Request
   ID, its name or a message about it (no voice notes here, so one of those). */
const SEL = { border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" };
const CELL = { border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" };
const SOURCE_ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt";
const OLD_MISSING = "Add the old requirement's Request ID, its name or a message about it.";
/* '' when an Old DB row says enough (the server's rule, without files). */
const oldProblem = (r) => {
  if (!r.legacy_on) return "";
  const p = L.legacyProblem({ ref: r.legacy_ref, name: r.legacy_name, note: r.legacy_note, files: [] });
  return p === L.LEGACY_MISSING ? OLD_MISSING : p;
};

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
  const [defHours, setDefHours] = useState(1); const [defMinutes, setDefMinutes] = useState(0);
  /* Photos / video (Odoo step 3b): picked for one named row, each with a reason,
     uploaded once the tasks exist. attachments: [{rowIndex, kind, data, name, size, preview, reason, status, pct, kpiId}] */
  const [mediaOpen, setMediaOpen] = useState(false);
  const [mediaRow, setMediaRow] = useState("");
  const [mediaKind, setMediaKind] = useState("image");
  const [mediaPicked, setMediaPicked] = useState(null);
  const [mediaReason, setMediaReason] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [defDelivOther, setDefDelivOther] = useState(""); /* the default's "Other" text */
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

  const blank = () => ({ name: "", external_ref: "", related_req_ref: "", legacy_on: false, legacy_ref: "", legacy_name: "", legacy_note: "", estimate_hours: staff ? (Number(defHours) || 0) : 0, estimate_minutes: staff ? (Number(defMinutes) || 0) : 0, priority: defPri, deliverable_type: defDeliv, deliverable_other: "", primary_user_id: defUser, description: "" });
  /* A row's own "Other" text, else the default's when the default is Other too. */
  const rowOther = (r) => deliverableOtherValue(r.deliverable_type || defDeliv, (r.deliverable_other || "").trim() || (defDeliv === "other" ? defDelivOther : ""));
  const defOther = deliverableOtherValue(defDeliv, defDelivOther);
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
    if (untyped.length) { flags.err(`Choose a type (Module, App, EXE or Other) for: ${untyped.map((r) => r.name.trim()).join(", ")}`); return; }
    if (defDeliv === "other" && !defOther) { flags.err(DELIVERABLE_OTHER_REQUIRED); return; }
    const noOther = valid.filter((r) => (r.deliverable_type || defDeliv) === "other" && !rowOther(r));
    if (noOther.length) { flags.err(`${DELIVERABLE_OTHER_REQUIRED} Missing for: ${noOther.map((r) => r.name.trim()).join(", ")}`); return; }
    const oldBad = linked ? valid.filter((r) => oldProblem(r)) : [];
    if (oldBad.length) { flags.err(`Old DB: ${oldProblem(oldBad[0])} Missing for: ${oldBad.map((r) => r.name.trim()).join(", ")}`); return; }
    setBusy("create");
    try {
      const tasks = valid.map((r) => { const row = { ...r, deliverable_other: rowOther(r), legacy_on: linked && !!r.legacy_on }; return staff ? A.buildTaskRow(row) : { ...A.buildTaskRow(row), estimate_hours: 0, estimate_minutes: 0, priority: "regular", primary_user_id: false }; });
      const r = await A.createBulkTasks({ subKraId: +kra, docType: type, tasks, deliverableType: defDeliv, deliverableOther: defOther, fileData: source?.b64 || "", fileName: source?.name || "", requirementVersion: version });
      A.assertOk(r, "Task creation failed.");
      flags.ok(`${r.created_count || valid.length} task${(r.created_count || valid.length) === 1 ? "" : "s"} created.`);
      /* Attachments: the tasks exist now, so each file hangs off its task. One at
         a time so the % means something; the tasks are never rolled back. */
      const ids = r.kpi_ids || [];
      const namedIdx = new Map(); let k = 0;
      rows.forEach((row, i) => { if (row.name?.trim()) namedIdx.set(i, k++); });
      const queued = attachments.map((a) => ({ ...a, kpiId: namedIdx.has(a.rowIndex) ? ids[namedIdx.get(a.rowIndex)] || null : null }));
      const failed = queued.length ? await sendAttachments(queued) : [];
      setRows([]); setSource(null); setListName("");
      if (failed.length) {
        setAttachments(failed);
        flags.err(`Your ${r.created_count || valid.length} task(s) were created. But these files did not upload: ${failed.map((a) => a.name).join(", ")}. Use "Retry failed uploads" to send them again.`);
        return;
      }
      setAttachments([]); setMediaOpen(false);
      router.push(portal ? "/portal/requests" : staff ? "/queue" : "/board");
    } catch (ex) { flags.err(ex.message); } finally { setBusy(""); }
  };
  /* Upload each queued file to its task; the % comes from the upload tracker,
     which names the file. Answers the ones that failed (they keep their kpiId). */
  const sendAttachments = async (list) => {
    setUploading(true);
    const failed = [];
    const set = (idx, patch) => setAttachments((l) => l.map((a, j) => (j === idx ? { ...a, ...patch } : a)));
    setAttachments(list);
    for (let idx = 0; idx < list.length; idx++) {
      const att = list[idx];
      if (att.status === "done") continue;
      if (!att.kpiId) { set(idx, { status: "failed" }); failed.push({ ...att, status: "failed" }); continue; }
      set(idx, { status: "uploading", pct: 0 });
      const stop = watchUploads((live) => { const e = live.find((u) => u.label === att.name); if (e && e.total) set(idx, { pct: Math.min(100, Math.round((e.loaded / e.total) * 100)) }); });
      try { const res = await A.attachIntakeMedia(att.kpiId, att); A.assertOk(res, "Upload failed"); set(idx, { status: "done", pct: 100 }); }
      catch { set(idx, { status: "failed" }); failed.push({ ...att, status: "failed" }); }
      finally { stop(); }
    }
    setUploading(false);
    return failed;
  };
  const retryFailed = async () => {
    const still = await sendAttachments(attachments);
    if (still.length) { setAttachments(still); flags.err(`Still could not upload: ${still.map((a) => a.name).join(", ")}`); return; }
    setAttachments([]); setMediaOpen(false); flags.ok("All files uploaded.");
  };
  /* Only NAMED rows can be attached to: the name is what identifies the task. */
  const namedRows = rows.map((r, i) => ({ i, name: (r.name || "").trim() })).filter((r) => r.name);
  const mediaReady = !!mediaPicked && mediaRow !== "" && mediaReason.trim().length > 0;
  const pickMedia = async (e) => {
    const file = e.target.files?.[0]; e.target.value = "";
    if (!file) return;
    const isVideo = mediaKind === "video";
    /* Refuse at pick time, never mid-upload. */
    if (isVideo && file.size > A.MAX_INTAKE_VIDEO_BYTES) { flags.err(`That video is ${A.humanSize(file.size)} — the limit is ${A.humanSize(A.MAX_INTAKE_VIDEO_BYTES)}. Record a shorter clip, or use a photo instead.`); return; }
    const data = await A.fileToBase64(file);
    setMediaPicked({ data, name: file.name, size: file.size, kind: mediaKind, preview: isVideo ? "" : URL.createObjectURL(file) });
  };
  const addAttachment = () => {
    if (!mediaReady) return;
    setAttachments((l) => [...l, { rowIndex: Number(mediaRow), ...mediaPicked, reason: mediaReason.trim(), status: "idle", pct: 0, kpiId: null }]);
    setMediaPicked(null); setMediaReason("");
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
            <Field label="Client" required><span className="input"><Select value={client} onChange={(e) => setClient(e.target.value)} style={SEL}><option value="">Choose a client</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.parent_name ? ` · ${c.parent_name}` : ""}</option>)}</Select></span></Field>
            <Field label="Project / sub-KRA" required><span className="input"><Select value={kra} onChange={(e) => setKra(e.target.value)} disabled={!kras.length} style={SEL}>{kras.map((k) => <option key={k.id} value={k.id}>{k.display || k.name}</option>)}{!kras.length && <option value="">{client ? "No projects under this client" : "—"}</option>}</Select></span></Field>
            <div className="grid2">
              <Field label="Version (optional)"><Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="v2.3" /></Field>
              <Field label="Next ref"><span className="input" style={{ color: "var(--brand)", fontWeight: 800 }}>{refOf(0)}</span></Field>
            </div>
            <Field label={staff ? "Default type (Module / App / EXE / Other)" : "Type for every row (or choose per row)"}><span className="input"><Select value={defDeliv} onChange={(e) => setDefDeliv(e.target.value)} style={SEL}><option value="">Choose…</option>{DELIVERABLES.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}</Select></span></Field>
            {defDeliv === "other" && <OtherTypeInput label="Default Other type" value={defDelivOther} onChange={setDefDelivOther} />}
            {staff && <div className="grid2">
              <Field label="Default developer"><span className="input"><Select value={defUser} onChange={(e) => setDefUser(e.target.value)} style={SEL}><option value="">Unassigned</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></span></Field>
              <Field label="Default priority"><span className="input"><Select value={defPri} onChange={(e) => setDefPri(e.target.value)} style={SEL}>{PRIORITIES.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}</Select></span></Field>
              <Field label="Default hours"><Input type="number" min="0" value={defHours} onChange={(e) => setDefHours(e.target.value)} /></Field>
              <Field label="Default minutes"><Input type="number" min="0" max="59" value={defMinutes} onChange={(e) => setDefMinutes(e.target.value)} /></Field>
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
          <MediaCard open={mediaOpen} setOpen={setMediaOpen} namedRows={namedRows} row={mediaRow} setRow={setMediaRow} kind={mediaKind}
            setKind={(k) => { setMediaKind(k); setMediaPicked(null); }} picked={mediaPicked} onPick={pickMedia} reason={mediaReason} setReason={setMediaReason}
            ready={mediaReady} onAdd={addAttachment} attachments={attachments} rows={rows} uploading={uploading}
            onRemove={(i) => setAttachments((l) => l.filter((_, j) => j !== i))} onRetry={retryFailed} />
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
                    {linked && <td style={{ verticalAlign: "top" }}>
                      <label className="mini" style={{ display: "flex", gap: 4, alignItems: "center", cursor: "pointer", marginBottom: 4, whiteSpace: "nowrap" }} title="The requirement is in the old database, not in this one"><input type="checkbox" checked={!!r.legacy_on} onChange={(e) => upd(i, { legacy_on: e.target.checked })} />🗄️ Old DB</label>
                      {r.legacy_on ? (
                        <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 170 }} title={oldProblem(r) || L.ENOUGH}>
                          <span className="input" style={{ height: 32, borderColor: r.name?.trim() && oldProblem(r) ? "var(--danger)" : undefined }}><input value={r.legacy_ref || ""} aria-label="Old Request ID" onChange={(e) => upd(i, { legacy_ref: e.target.value })} onBlur={(e) => upd(i, { legacy_ref: L.normalizeRef(e.target.value) })} placeholder="Request ID, e.g. REQ-012" style={CELL} /></span>
                          <span className="input" style={{ height: 32 }}><input value={r.legacy_name || ""} aria-label="Old task name" onChange={(e) => upd(i, { legacy_name: e.target.value })} placeholder="Task name" style={CELL} /></span>
                          <span className="input ta" style={{ height: 56 }}><textarea value={r.legacy_note || ""} aria-label="About the old requirement" onChange={(e) => upd(i, { legacy_note: e.target.value })} placeholder="Message about it" style={{ ...CELL, resize: "none", height: "100%" }} /></span>
                        </span>
                      ) : <span className="input" style={{ height: 32, width: 96 }}><input value={r.related_req_ref || ""} onChange={(e) => upd(i, { related_req_ref: e.target.value })} placeholder="REQ-001" style={CELL} /></span>}
                    </td>}
                    <td><span className="input" style={{ height: 32 }}><input value={r.name} onChange={(e) => upd(i, { name: e.target.value })} placeholder="What needs doing" style={CELL} /></span></td>
                    {staff && <>
                      <td><span className="input" style={{ height: 32, width: 56 }}><input type="number" min="0" value={r.estimate_hours} onChange={(e) => upd(i, { estimate_hours: e.target.value })} style={CELL} /></span></td>
                      <td><span className="input" style={{ height: 32, width: 60 }}><input type="number" min="0" max="59" value={r.estimate_minutes} onChange={(e) => upd(i, { estimate_minutes: e.target.value })} style={CELL} /></span></td>
                      <td><span className="input" style={{ height: 32 }}><Select value={r.priority} onChange={(e) => upd(i, { priority: e.target.value })} style={SEL}>{PRIORITIES.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}</Select></span></td>
                    </>}
                    <td><span className="input" style={{ height: 32, borderColor: r.name?.trim() && !r.deliverable_type && !defDeliv ? "var(--danger)" : undefined }}><Select value={r.deliverable_type || ""} onChange={(e) => upd(i, { deliverable_type: e.target.value })} style={SEL}><option value="">{defDeliv ? `Default (${deliverableLabel(defDeliv, defOther)})` : "Choose…"}</option>{DELIVERABLES.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}</Select></span>
                      {r.deliverable_type === "other" && <OtherTypeInput bare value={r.deliverable_other} onChange={(v) => upd(i, { deliverable_other: v })} style={{ height: 32, marginTop: 4, minWidth: 140, ...(r.name?.trim() && !rowOther(r) ? { borderColor: "var(--danger)" } : null) }} />}</td>
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

/* Step 3b: Photos / video, hidden behind ONE button (Odoo kpi_requirements_upload.js).
   Pick a task by the name typed above, Photo (the default) or Video, the file,
   and why it is attached; "Add attachment" queues it until the tasks exist. */
function MediaCard({ open, setOpen, namedRows, row, setRow, kind, setKind, picked, onPick, reason, setReason, ready, onAdd, attachments, rows, uploading, onRemove, onRetry }) {
  if (!open) {
    return <button type="button" className="cardbox" onClick={() => setOpen(true)} style={{ borderStyle: "dashed", cursor: "pointer", textAlign: "center", font: "inherit", color: "var(--brand)", fontWeight: 600 }}>📎 Add photos / video</button>;
  }
  return (
    <div className="cardbox">
      <h2>📎 Photos / video<span className="right"><button type="button" className="icon-btn" aria-label="Close" style={{ width: 26, height: 26 }} onClick={() => setOpen(false)}><Icon n="up" size={14} /></button></span></h2>
      {!namedRows.length ? <span className="mini">Type a task name above first — attachments are added to a task.</span> : (
        <>
          <div className="grid2">
            <Field label="Which task?" required><span className="input"><Select value={row} onChange={(e) => setRow(e.target.value)} style={SEL}><option value="">— select a task —</option>{namedRows.map((r) => <option key={r.i} value={r.i}>{`#${r.i + 1}  ${r.name}`}</option>)}</Select></span></Field>
            <Field label="Type"><span style={{ display: "inline-flex", gap: 6 }}>
              <Button size="sm" kind={kind === "image" ? "primary" : "ghost"} onClick={() => setKind("image")}>🖼️ Photo</Button>
              <Button size="sm" kind={kind === "video" ? "danger" : "ghost"} onClick={() => setKind("video")}>🎥 Video</Button>
            </span></Field>
          </div>
          <Field label={kind === "video" ? "Choose a video" : "Choose photo"}><input type="file" accept={kind === "video" ? "video/*" : "image/*"} onChange={onPick} /></Field>
          {kind === "video" && <div className="callout" style={{ background: "var(--over-bg)", borderColor: "var(--danger)", color: "var(--over)" }}><span>Only upload a video if it&apos;s <b>really needed</b> — a photo is usually enough, and videos are slow to upload. Limit: <b>{A.humanSize(A.MAX_INTAKE_VIDEO_BYTES)}</b>.</span></div>}
          {picked && (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {picked.preview ? <img src={picked.preview} alt="" style={{ height: 64, width: 64, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)" }} />
                : <span style={{ height: 64, width: 64, borderRadius: 8, background: "var(--hover)", display: "grid", placeItems: "center", fontSize: 26 }}>🎥</span>}
              <span><b>{picked.name}</b><br /><span className="mini">{A.humanSize(picked.size)}</span></span>
            </div>
          )}
          <Field label="Reason" required><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why are you attaching this?" /></Field>
          <div className="row"><Button size="sm" kind="primary" disabled={!ready} onClick={onAdd}>+ Add attachment</Button>{!ready && <span className="mini">Pick a task, choose a file, and give a reason.</span>}</div>
        </>
      )}
      {attachments.length > 0 && (
        <div>
          {attachments.map((a, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderTop: "1px solid var(--border)" }}>
              <span>{a.kind === "video" ? "🎥" : "🖼️"}</span>
              <div style={{ flex: 1, fontSize: 12.5 }}>
                <div><b>{a.name}</b><span className="mini"> · {A.humanSize(a.size)}</span>{rows[a.rowIndex] && <span className="mini"> → {rows[a.rowIndex].name}</span>}</div>
                <div className="mini">{a.reason}</div>
                {a.status === "uploading" && <><span className="bar" style={{ display: "block", marginTop: 4 }}><i style={{ width: `${a.pct}%`, background: "var(--brand)" }} /></span><span style={{ fontSize: 11, fontWeight: 700, color: "var(--brand)" }}>{A.humanSize(a.size)} · {a.pct}%</span></>}
                {a.status === "failed" && <span style={{ fontSize: 11, fontWeight: 700, color: "var(--danger)" }}>Upload failed</span>}
              </div>
              {a.status === "done" && <span style={{ color: "var(--lz-done)" }}>✓</span>}
              {a.status === "idle" && <button type="button" className="icon-btn" aria-label="Remove" style={{ width: 24, height: 24 }} onClick={() => onRemove(i)}><Icon n="x" size={12} /></button>}
            </div>
          ))}
          {attachments.some((x) => x.status === "failed") && <Button size="sm" kind="danger" disabled={uploading} onClick={onRetry}>↻ Retry failed uploads</Button>}
        </div>
      )}
    </div>
  );
}
