"use client";
import { useEffect, useRef, useState } from "react";
import { Avatar, Button, ErrorState, Field, Icon, IconButton, Input, Lozenge, Modal, PageHeader, Select, Skeleton, StaleBar, stateTone, useFlags } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import { invalidate } from "@/lib/api";
import * as A from "@/lib/services/admin";
import { DELIVERABLES, DELIVERABLE_OTHER_REQUIRED, deliverableOtherValue } from "@/lib/services/kpiActions";
import OtherTypeInput from "@/components/task/OtherTypeInput";
import IntakeNav from "./IntakeNav";

/* Completion certificates: tasks (completed by default) with their delivery
   version, requirement (V01) and updates (V02) documents, and the client-signed
   certificate. The certificate itself is drawn from /kpi_completion_cert/pdf_data
   into a print window (Save as PDF), as the Odoo screen draws it with jsPDF.
   Also: quick-create a task from a requirement document. */
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const CERT_VERSIONS = ["V01", "V02", "V03", "Final"];
const STATES = [{ v: "completed", l: "Completed" }, { v: "partially_completed", l: "Pending approval" }, { v: "all", l: "All states" }];
const sel = { border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" };

export default function Certificates() {
  const flags = useFlags();
  const now = new Date();
  const [f, setF] = useState(() => ({ client: "", from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now), state: "completed" }));
  const [clients, setClients] = useState([]);
  const [users, setUsers] = useState([]);
  const [certVer, setCertVer] = useState({}); /* kpi id -> V01… (local, as on the Odoo screen) */
  const [roles, setRoles] = useState(null); /* row being edited */
  const [busy, setBusy] = useState(""); /* `${id}:${what}` */
  const [showCreate, setShowCreate] = useState(false);
  useEffect(() => { A.getClients().then(setClients).catch(() => {}); A.getIntakeUsers().then(setUsers).catch(() => {}); }, []);

  const list = useResource(A.CERT_LIST_PATH, A.certListParams({ clientKraId: f.client, fromDate: f.from, toDate: f.to, state: f.state }), { ttl: 15000 });
  const refused = list.data?.status === false;
  const kpis = list.data?.kpis || [];
  const reload = () => { invalidate(A.CERT_LIST_PATH); list.refresh(); };

  const run = async (key, fn, ok) => {
    setBusy(key);
    try { A.assertOk(await fn(), "Could not save."); if (ok) flags.ok(ok); reload(); }
    catch (e) { flags.err(e.message); } finally { setBusy(""); }
  };
  const upload = (k, kind) => async (e) => {
    const file = e.target.files?.[0]; e.target.value = "";
    if (!file) return;
    if (file.size > 25 * 1048576) { flags.err("That file is over 25 MB."); return; }
    const fileData = await A.fileToBase64(file);
    if (kind === "signed") return run(`${k.id}:signed`, () => A.uploadSignedCert(k.id, { fileData, fileName: file.name, signedDate: ymd(new Date()) }), "Signed certificate uploaded.");
    return run(`${k.id}:${kind}`, () => A.uploadCertDoc(k.id, kind, { fileData, fileName: file.name }), "Document uploaded.");
  };
  const certificate = async (k) => {
    const w = window.open("", "_blank"); /* opened inside the click, so no popup block */
    if (!w) { flags.err("Allow pop-ups for this site to open the certificate."); return; }
    w.document.write("<p style=\"font:14px system-ui;padding:24px\">Preparing the certificate…</p>");
    try {
      const d = await A.fetchCertData(k.id);
      w.document.open(); w.document.write(certificateHtml(d, certVer[k.id] || "V01")); w.document.close();
      setTimeout(() => { try { w.focus(); w.print(); } catch (_) {} }, 400);
    } catch (e) { w.close(); flags.err(e.message); }
  };
  const viewSigned = async (k) => {
    const w = window.open("", "_blank");
    if (!w) { flags.err("Allow pop-ups for this site to view the certificate."); return; }
    try {
      const r = await A.fetchSignedCertB64(k.id);
      const bin = atob(r.data_b64); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      w.location.href = URL.createObjectURL(new Blob([bytes], { type: r.mimetype || "application/pdf" }));
    } catch (e) { w.close(); flags.err(e.message); }
  };

  return (
    <>
      <PageHeader crumbs={[{ label: "Intake" }, { label: "Completion certificates" }]} title="Completion certificates" meta="Documents, versions and the client-signed certificate per task">
        <Button icon="plus" onClick={() => setShowCreate((v) => !v)}>{showCreate ? "Hide quick create" : "Task from requirement doc"}</Button>
      </PageHeader>
      <IntakeNav />
      <div className="page" style={{ overflow: "auto" }}>
        {showCreate && <QuickCreate clients={clients} users={users} flags={flags} onCreated={() => { setShowCreate(false); reload(); }} />}
        <div className="cardbox" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", gap: 12 }}>
          <Field label="Client"><span className="input" style={{ minWidth: 220 }}><Select value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} style={sel}><option value="">All clients</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.parent_name ? `${c.parent_name} › ${c.name}` : c.name}</option>)}</Select></span></Field>
          <Field label="Completed from"><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="To"><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          <Field label="State"><span className="input" style={{ width: 180 }}><Select value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} style={sel}>{STATES.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}</Select></span></Field>
          <span className="mini" style={{ marginLeft: "auto", paddingBottom: 8 }}>Blank templates: <a href={A.templateHref("requirement")}>requirement</a> · <a href={A.templateHref("update")}>update</a> · <a href={A.templateHref("bug")}>bug report</a></span>
        </div>
        {refused && <ErrorState error={{ message: list.data.message }} onRetry={reload} />}
        {list.error && !list.data && <ErrorState error={list.error} onRetry={reload} />}
        {list.stale && <StaleBar error={list.error} onRetry={reload} />}
        <div className="cardbox table-scroll" style={{ padding: 0, flex: "none" }}>
          {!list.data && !list.error ? <div style={{ padding: 16 }}><Skeleton rows={6} /></div> : (
            <table className="table">
              <thead><tr><th>Task</th><th>Client › project</th><th>Assignee</th><th>Completed</th><th className="num">Hours</th><th>Delivery ver.</th><th>Requirement (V01)</th><th>Updates &amp; errors (V02)</th><th>Cert ver.</th><th>Signed certificate</th><th>State</th><th></th></tr></thead>
              <tbody>
                {kpis.map((k) => {
                  const [tone, label] = stateTone(k.task_state);
                  const b = (w) => busy === `${k.id}:${w}`;
                  return (
                    <tr key={k.id} style={{ verticalAlign: "top" }}>
                      <td style={{ whiteSpace: "normal", minWidth: 180 }}><b>{k.name}</b></td>
                      <td style={{ whiteSpace: "normal" }}>{k.client_name}{k.project_name ? <span className="mini"> › {k.project_name}</span> : ""}</td>
                      <td>{k.primary_assignee ? <><Avatar name={k.primary_assignee} size={22} /> {k.primary_assignee}</> : <span className="mini">—</span>}</td>
                      <td className="mini">{k.completion_date || "—"}</td>
                      <td className="num">{k.actual_hours}h</td>
                      <td><BlurInput value={k.delivery_version} placeholder="e.g. APK v1.0.5" width={130} onSave={(v) => run(`${k.id}:dv`, () => A.setDeliveryVersion(k.id, v), "Delivery version saved.")} /></td>
                      <td>
                        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          <BlurInput value={k.requirement_version} placeholder="v1.1" width={70} onSave={(v) => run(`${k.id}:rv`, () => A.setRequirementVersion(k.id, v), "Requirement version saved.")} />
                          <FilePick label="Upload requirement document" busy={b("requirement")} accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.png,.jpg,.jpeg" onChange={upload(k, "requirement")} />
                          {k.has_requirement_document && <a className="icon-btn" href={A.certDocHref(k.id, "requirement")} title={`Download ${k.requirement_document_name || "requirement"}`} aria-label="Download requirement document"><Icon n="download" size={16} /></a>}
                        </span>
                        {k.requirement_document_name && <div className="mini" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>{k.requirement_document_name}</div>}
                      </td>
                      <td>
                        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          <FilePick label="Upload updates document" busy={b("updates")} accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt" onChange={upload(k, "updates")} />
                          {k.has_updates_document && <a className="icon-btn" href={A.certDocHref(k.id, "updates")} title={`Download ${k.updates_document_name || "updates"}`} aria-label="Download updates document"><Icon n="download" size={16} /></a>}
                        </span>
                        {k.updates_document_name && <div className="mini" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>{k.updates_document_name}</div>}
                      </td>
                      <td><span className="input" style={{ height: 30, width: 96 }}><Select value={certVer[k.id] || "V01"} onChange={(e) => setCertVer((m) => ({ ...m, [k.id]: e.target.value }))} style={sel}>{CERT_VERSIONS.map((v) => <option key={v} value={v}>{v}</option>)}</Select></span></td>
                      <td>
                        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          <FilePick label="Upload signed certificate" busy={b("signed")} accept=".pdf,.png,.jpg,.jpeg" onChange={upload(k, "signed")} />
                          {k.has_signed_certificate && <IconButton icon="eye" label="View signed certificate" size={16} onClick={() => viewSigned(k)} />}
                          {k.has_signed_certificate && <a className="icon-btn" href={A.certDocHref(k.id, "signed")} title={`Download ${k.signed_certificate_name || "certificate"}`} aria-label="Download signed certificate"><Icon n="download" size={16} /></a>}
                        </span>
                        <div className="mini" style={{ color: k.has_signed_certificate ? "var(--pri-regular)" : "var(--pri-important)" }}>{k.has_signed_certificate ? `✓ Signed${k.signed_certificate_date ? ` on ${k.signed_certificate_date}` : ""}` : "Awaiting signature"}</div>
                      </td>
                      <td><Lozenge tone={tone}>{label}</Lozenge></td>
                      <td><span style={{ display: "inline-flex", gap: 6 }}>
                        <Button size="sm" kind="primary" icon="download" onClick={() => certificate(k)}>Certificate</Button>
                        <Button size="sm" kind="ghost" onClick={() => setRoles(k)}>Roles</Button>
                      </span></td>
                    </tr>
                  );
                })}
                {!kpis.length && <tr><td colSpan={12} className="empty">No tasks match these filters.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {roles && <RolesDialog k={roles} users={users} flags={flags} onClose={() => setRoles(null)} onSaved={() => { setRoles(null); reload(); }} />}
    </>
  );
}

function BlurInput({ value, onSave, placeholder, width }) {
  const [v, setV] = useState(value || "");
  useEffect(() => { setV(value || ""); }, [value]);
  return <span className="input" style={{ height: 30, width }}><input value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v.trim() !== (value || "")) onSave(v.trim()); }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }} /></span>;
}

function FilePick({ label, accept, onChange, busy }) {
  const ref = useRef(null);
  return (
    <>
      <input ref={ref} type="file" accept={accept} onChange={onChange} hidden />
      {busy ? <span className="spin" style={{ width: 14, height: 14, borderWidth: 2 }} aria-label="Uploading" /> : <IconButton icon="upload" label={label} size={16} onClick={() => ref.current?.click()} />}
    </>
  );
}

const ROLE_FIELDS = [["developer_ids", "Developers"], ["tester_ids", "Testers"], ["coordinator_ids", "Coordinators"], ["lead_ids", "Leads"]];
function RolesDialog({ k, users, flags, onClose, onSaved }) {
  const [vals, setVals] = useState(() => Object.fromEntries(ROLE_FIELDS.map(([f]) => [f, new Set(k[f] || [])])));
  const [tab, setTab] = useState(ROLE_FIELDS[0][0]);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { A.assertOk(await A.setCertRoles(k.id, Object.fromEntries(ROLE_FIELDS.map(([f]) => [f, [...vals[f]]]))), "Could not save roles."); flags.ok("Roles saved."); onSaved(); }
    catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Roles — ${k.name}`} width={520} footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} onClick={save}>Save</Button></>}>
      <p className="note" style={{ margin: 0 }}>Who is credited on the certificate, and in which role. Hours come from their logged time on the task.</p>
      <div className="tabs" role="tablist" style={{ alignSelf: "flex-start", flexWrap: "wrap" }}>
        {ROLE_FIELDS.map(([f, l]) => <span key={f} role="tab" tabIndex={0} aria-selected={tab === f} className={tab === f ? "on" : ""} onClick={() => setTab(f)} onKeyDown={(e) => { if (e.key === "Enter") setTab(f); }} style={{ cursor: "pointer" }}>{l}<em>{vals[f].size}</em></span>)}
      </div>
      <div className="people" style={{ maxHeight: 320, overflow: "auto" }}>
        {users.map((u) => <label key={u.id}><input type="checkbox" checked={vals[tab].has(u.id)} onChange={(e) => setVals((v) => { const n = new Set(v[tab]); e.target.checked ? n.add(u.id) : n.delete(u.id); return { ...v, [tab]: n }; })} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} /><Avatar name={u.name} uid={u.id} size={22} />{u.name}<span className="mini" style={{ marginLeft: "auto" }}>{u.login}</span></label>)}
        {!users.length && <span className="mini" style={{ padding: 8 }}>Loading people…</span>}
      </div>
    </Modal>
  );
}

function QuickCreate({ clients, users, flags, onCreated }) {
  const blank = { clientKraId: "", subKraId: "", taskName: "", requirementVersion: "", estimateHours: "0", estimateMinutes: "0", primaryUserId: "", deliverableType: "", deliverableOther: "", fileData: "", fileName: "" };
  const [t, setT] = useState(blank);
  const [kras, setKras] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setKras([]); if (t.clientKraId) A.getSubKras(+t.clientKraId).then(setKras).catch(() => setKras([])); }, [t.clientKraId]);
  const pick = async (e) => { const file = e.target.files?.[0]; if (!file) { setT((x) => ({ ...x, fileData: "", fileName: "" })); return; } const fileData = await A.fileToBase64(file); setT((x) => ({ ...x, fileData, fileName: file.name })); };
  const create = async () => {
    if (!t.clientKraId || !t.subKraId || !t.taskName.trim()) { flags.warn("Choose the client and project, and name the task."); return; }
    if (!t.deliverableType) { flags.warn("Choose a type — Module, App, Exe or Other."); return; }
    const deliverableOther = deliverableOtherValue(t.deliverableType, t.deliverableOther);
    if (t.deliverableType === "other" && !deliverableOther) { flags.warn(DELIVERABLE_OTHER_REQUIRED); return; }
    setBusy(true);
    try { const r = A.assertOk(await A.createTaskFromDoc({ ...t, deliverableOther }),"Could not create the task."); flags.ok(`Task created: ${r.name}`); setT(blank); onCreated(); }
    catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="cardbox"><h2>Quick create a task from a requirement document</h2>
      <div className="grid2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        <Field label="Client" required><span className="input"><Select value={t.clientKraId} onChange={(e) => setT({ ...t, clientKraId: e.target.value, subKraId: "" })} style={sel}><option value="">Choose a client</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.parent_name ? `${c.parent_name} › ${c.name}` : c.name}</option>)}</Select></span></Field>
        <Field label="Project" required><span className="input"><Select value={t.subKraId} disabled={!kras.length} onChange={(e) => setT({ ...t, subKraId: e.target.value })} style={sel}><option value="">Choose a project</option>{kras.map((k) => <option key={k.id} value={k.id}>{k.display || k.name}</option>)}</Select></span></Field>
        <Field label="Task name" required><Input value={t.taskName} placeholder="e.g. Discount option" onChange={(e) => setT({ ...t, taskName: e.target.value })} /></Field>
        <Field label="Requirement document"><span className="input"><input type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt" onChange={pick} style={{ font: "inherit", fontSize: 12.5, width: "100%" }} /></span></Field>
        <Field label="Requirement version"><Input value={t.requirementVersion} placeholder="v1.1" onChange={(e) => setT({ ...t, requirementVersion: e.target.value })} /></Field>
        <Field label="Estimate"><span style={{ display: "flex", gap: 6 }}><Input type="number" min="0" value={t.estimateHours} onChange={(e) => setT({ ...t, estimateHours: e.target.value })} right={<span className="ph">h</span>} /><Input type="number" min="0" max="59" value={t.estimateMinutes} onChange={(e) => setT({ ...t, estimateMinutes: e.target.value })} right={<span className="ph">m</span>} /></span></Field>
        <Field label="Primary developer"><span className="input"><Select value={t.primaryUserId} onChange={(e) => setT({ ...t, primaryUserId: e.target.value })} style={sel}><option value="">None</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></span></Field>
        <Field label="Type" required><span className="input"><Select value={t.deliverableType} onChange={(e) => setT({ ...t, deliverableType: e.target.value })} style={sel}><option value="">Choose…</option>{DELIVERABLES.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}</Select></span></Field>
        {t.deliverableType === "other" && <OtherTypeInput value={t.deliverableOther} onChange={(v) => setT({ ...t, deliverableOther: v })} autoFocus />}
      </div>
      <Button kind="primary" icon="plus" busy={busy} style={{ alignSelf: "flex-start" }} onClick={create}>Create task</Button>
    </div>
  );
}

/* ---- the certificate (print window → Save as PDF) ---- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const h2 = (n) => (Number(n) || 0).toFixed(2);
function certificateHtml(d, ver) {
  const k = d.kpi || {};
  const ROLE = { developer: "Developer", tester: "Tester", coordinator: "Coordinator", lead: "Lead" };
  const row = (l, v) => (v ? `<tr><th>${esc(l)}</th><td>${esc(v)}</td></tr>` : "");
  const roleRows = (d.role_totals || []).filter((r) => (r.hours || 0) > 0).map((r) => `<tr><td>${esc(r.label)}</td><td class="n">${h2(r.hours)} h</td></tr>`).join("");
  const people = (d.contributors || []).map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(ROLE[c.role] || c.role || "—")}</td><td class="n">${h2(c.hours)} h</td></tr>`).join("");
  const docs = [k.has_requirement_document && `Requirement${k.requirement_version ? ` (${esc(k.requirement_version)})` : ""}: ${esc(k.requirement_document_name)}`, k.has_updates_document && `Updates &amp; errors: ${esc(k.updates_document_name)}`].filter(Boolean);
  const title = `Completion_Certificate_${ver}_${(k.name || `KPI_${k.id}`).replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
  @page{size:A4;margin:18mm}*{box-sizing:border-box}body{font:12.5px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#111;margin:0;padding:24px}
  .top{display:flex;align-items:center;gap:16px}.top img{width:64px;height:64px;object-fit:contain}.top .co{margin-left:auto;text-align:right}.top .co b{font-size:20px;display:block}
  h1{text-align:center;font-size:24px;letter-spacing:.06em;margin:22px 0 2px}.ver{text-align:center;color:#4f4fc8;font-weight:600;margin-bottom:10px}hr{border:0;border-top:1px solid #999;margin:10px 0 16px}
  table{border-collapse:collapse;width:100%;margin:4px 0 14px}th{text-align:left;width:190px;vertical-align:top;padding:3px 0}td{padding:3px 0;vertical-align:top}
  table.g th,table.g td{border:1px solid #ccc;padding:5px 8px;width:auto}table.g thead th{background:#4c82af;color:#fff}.n{text-align:right}
  h3{font-size:13px;margin:14px 0 4px}.sig{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:40px}.sig div{border-top:1px solid #333;padding-top:6px}
  .foot{margin-top:30px;text-align:center;color:#888;font-size:10px}.desc{white-space:pre-wrap}@media print{body{padding:0}}</style></head><body>
  <div class="top">${d.company_logo_b64 ? `<img src="data:image/png;base64,${d.company_logo_b64}" alt="">` : ""}<div class="co"><b>${esc(d.company_name)}</b>Service Provider</div></div>
  <h1>COMPLETION CERTIFICATE</h1><div class="ver">(Certificate Version: ${esc(ver)})</div><hr>
  <table>${row("Issued to (client):", d.client_name || "—")}${row("Project:", d.project_name)}${row("Task / requirement:", k.name)}${row("Reference:", k.external_ref)}${row("Delivery version:", k.delivery_version)}${row("Priority:", (k.priority || "").toUpperCase())}${row("State:", (k.task_state || "").toUpperCase())}</table>
  ${k.description ? `<h3>Requirement details</h3><div class="desc">${esc(k.description)}</div>` : ""}
  <h3>Timeline</h3><table>${row("Assigned / started:", k.assigned_date || "—")}${row("Deadline:", k.deadline || "—")}${row("Completion date:", k.completion_date || "—")}${row("Approval date:", k.approval_date || "—")}</table>
  <h3>Effort / developer time</h3><table><tr><th>Estimated:</th><td>${h2(k.estimate_hours)} h</td><th>Actual total:</th><td>${h2(k.actual_hours)} h</td></tr></table>
  ${roleRows ? `<h3>Time by role</h3><table class="g"><thead><tr><th>Role</th><th class="n">Hours</th></tr></thead><tbody>${roleRows}</tbody></table>` : ""}
  ${people ? `<h3>Contributors</h3><table class="g"><thead><tr><th>Name</th><th>Role</th><th class="n">Hours</th></tr></thead><tbody>${people}</tbody></table>` : ""}
  ${docs.length ? `<h3>Source documents</h3><ul>${docs.map((x) => `<li>${x}</li>`).join("")}</ul>` : ""}
  ${k.client_signature_text ? `<h3>Client sign-off</h3><table>${row("Signed by:", k.client_signature_text)}${row("Signed on:", k.client_signed_datetime)}${row("Notes:", k.client_approval_notes)}</table>` : ""}
  <p>This certifies that the above task has been completed and delivered by ${esc(d.company_name || "(provider)")} to ${esc(d.client_name || "(client)")}. The work was carried out by the developer(s) listed above. The total developer time recorded for this task is ${h2(k.actual_hours)} hours. This is certificate version ${esc(ver)}.</p>
  <div class="sig"><div><b>For ${esc(d.company_name || "Service Provider")}</b><br>Date: ____________________${k.approved_by ? `<br>(Approved by: ${esc(k.approved_by)})` : ""}</div><div><b>Client: ${esc(d.client_name)}</b><br>Date: ____________________</div></div>
  <div class="foot">Generated on ${new Date().toISOString().slice(0, 10)} — KPI ID #${esc(k.id)}</div></body></html>`;
}
