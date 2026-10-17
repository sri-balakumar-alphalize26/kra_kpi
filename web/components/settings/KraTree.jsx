"use client";
import { useEffect, useMemo, useState } from "react";
import { Avatar, Button, ErrorState, Field, Icon, IconButton, Input, Lozenge, Modal, PageHeader, Skeleton, stateTone, useDialogs, useFlags, Select } from "@/components/ui";
import * as S from "@/lib/services/settings";
import * as P from "@/lib/services/approvals";
import { getIntakeUsers } from "@/lib/services/admin";
import { href } from "@/lib/api";
import { PRIORITIES, DELIVERABLES, TASK_TYPES } from "@/lib/services/kpiActions";
import { useTaskActions } from "@/components/task/TaskActions";
import SettingsNav from "./SettingsNav";

/* The KRA / KPI master: Clients (root KRAs) › projects › versions › KPIs.
   Inline add / rename / delete, and "client users" for a client root.
   kra.master.get_kra_tree gives each KPI {id, name, external_ref, task_state,
   user_id, user_name, has_user_manual, manual_count}; an older server sends
   only id/name, so the ref falls back to #id and the rest is left out. */
const kpiHit = (k, ql) => (k.name || "").toLowerCase().includes(ql) || (k.external_ref || "").toLowerCase().includes(ql) || (k.user_name || "").toLowerCase().includes(ql);
export default function KraTree() {
  const flags = useFlags();
  const dlg = useDialogs();
  const acts = useTaskActions();
  const [tree, setTree] = useState(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(() => new Set());
  const [q, setQ] = useState("");
  const [dialog, setDialog] = useState(null); /* {kind:'kra'|'kpi'|'rename'|'clients', node, parent} */
  const [busy, setBusy] = useState(false);
  /* Who manages each client (kra.master.manager_user_id): the person who
     approves for that client. Read alongside the tree, which doesn't carry it. */
  const [mgr, setMgr] = useState({});
  const loadManagers = () => P.clientManagers().then((rows) => setMgr(Object.fromEntries((rows || []).map((r) => [r.id, r])))).catch(() => {});
  /* Everything starts closed; rows open only when clicked, and any number can be open at once. */
  const load = () => { loadManagers(); return S.fetchKraTree().then((t) => { setTree(t); setErr(""); }).catch((e) => setErr(e.message)); };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => {
    let kras = 0, subs = 0, kpis = 0, clientUsers = 0;
    const walk = (n, depth) => { if (depth === 0) kras++; else subs++; kpis += (n.kpi_ids || []).length; clientUsers += (n.client_user_ids || []).length; (n.child_ids || []).forEach((c) => walk(c, depth + 1)); };
    (tree || []).forEach((n) => walk(n, 0));
    return { kras, subs, kpis, clientUsers };
  }, [tree]);
  const toggle = (id) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const matches = (n) => !q || n.name.toLowerCase().includes(q.toLowerCase()) || (n.kpi_ids || []).some((k) => kpiHit(k, q.toLowerCase())) || (n.child_ids || []).some(matches);

  const run = async (fn, ok) => { setBusy(true); try { const r = await fn(); if (r && r.status === false) throw new Error(r.message || "Refused."); flags.ok(ok); setDialog(null); load(); } catch (e) { flags.err(e.message); } finally { setBusy(false); } };
  const del = async (node, isKpi) => {
    if (!(await dlg.confirm({ title: `Delete ${isKpi ? "KPI" : "KRA"}?`, text: `"${node.name}" will be deleted.${isKpi ? "" : " Everything under it must be empty first."}`, confirmLabel: "Delete", danger: true }))) return;
    run(() => (isKpi ? S.deleteKpi(node.id) : S.deleteKra(node.id)), "Deleted.");
  };
  /* The manual badge opens the manual (kra_node.js): one → straight to it, several → pick one. */
  const openManual = async (k) => {
    try {
      const ms = await S.listKpiManuals(k.id);
      if (!ms.length) { flags.warn("No user manuals found for this KPI."); return; }
      let id = ms[0].id;
      if (ms.length > 1) {
        const v = await dlg.form({ title: "Which manual?", text: `${ms.length} manuals are available for this KPI.`, fields: [{ key: "id", label: "Manual", value: String(ms[0].id), options: ms.map((m) => ({ value: String(m.id), label: `${m.file_name || "Manual"}${m.description ? ` — ${m.description}` : ""}` })) }], confirmLabel: "Open" });
        if (!v) return;
        id = +v.id;
      }
      if (!window.open(href(`/kpi/manual/view/${id}`), "_blank")) flags.warn("The browser blocked the new tab. Allow pop-ups for this site and try again.");
    } catch (e) { flags.err(e.message); }
  };

  return (
    <>
      <PageHeader crumbs={[{ label: "Settings" }, { label: "KRA / KPI master" }]} title="KRA / KPI master" meta="Clients › projects › versions › KPIs">
        <label className="search" style={{ margin: 0, width: 220 }}><Icon n="search" size={16} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a KRA, KPI or ref" aria-label="Find" style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: "100%" }} /></label>
        <Button kind="primary" icon="plus" onClick={() => setDialog({ kind: "kra", parent: null })}>New client (root KRA)</Button>
      </PageHeader>
      <SettingsNav />
      <div className="page">
        <div className="stats">
          <div className="stat"><small>Clients / roots</small><b>{tree ? stats.kras : "…"}</b><span>root KRAs</span></div>
          <div className="stat"><small>Projects / versions</small><b>{tree ? stats.subs : "…"}</b><span>sub-KRAs</span></div>
          <div className="stat"><small>KPIs</small><b>{tree ? stats.kpis : "…"}</b><span>tasks in the tree</span></div>
          <div className="stat"><small>Client users</small><b>{tree ? stats.clientUsers : "…"}</b><span>with portal access</span></div>
        </div>
        {err && <ErrorState error={{ message: err }} onRetry={load} />}
        <div className="cardbox" style={{ padding: "10px 8px" }}>
          {!tree && !err && <div style={{ padding: 8 }}><Skeleton rows={6} /></div>}
          {tree && <div className="tree">{tree.filter(matches).map((n) => <Node key={n.id} n={n} depth={0} open={open} toggle={toggle} onAdd={(node, kind) => setDialog({ kind, parent: node })} onRename={(node, isKpi) => setDialog({ kind: "rename", node, isKpi })} onDelete={del} onClients={(node) => setDialog({ kind: "clients", node })} onManager={(node) => setDialog({ kind: "manager", node })} mgr={mgr} onOpenTask={(id) => acts.openTask(id)} onManual={openManual} q={q} />)}{!tree.length && <div className="empty">No KRAs yet. Create the first client above.</div>}</div>}
        </div>
      </div>
      {dialog && (dialog.kind === "clients" ? <ClientsDialog node={dialog.node} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); load(); }} flags={flags} />
        : dialog.kind === "manager" ? <ManagerDialog node={dialog.node} current={mgr[dialog.node.id]} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); loadManagers(); }} flags={flags} />
        : <EditDialog d={dialog} busy={busy} onClose={() => setDialog(null)} onRun={run} />)}
    </>
  );
}

function Node({ n, depth, open, toggle, onAdd, onRename, onDelete, onClients, onManager, mgr = {}, onOpenTask, onManual, q }) {
  const m = depth === 0 ? mgr[n.id] : null;
  const manager = m && Array.isArray(m.manager_user_id) ? m.manager_user_id[1] : "";
  const isOpen = open.has(n.id) || !!q;
  const kids = (n.child_ids || []);
  const kpis = (n.kpi_ids || []).filter((k) => !q || kpiHit(k, q.toLowerCase()) || n.name.toLowerCase().includes(q.toLowerCase()));
  const count = (node) => (node.kpi_ids || []).length + (node.child_ids || []).reduce((s, c) => s + count(c), 0);
  return (
    <>
      <div className={`tr d${Math.min(depth, 3)}`}>
        <span role="button" tabIndex={0} aria-expanded={isOpen} onClick={() => toggle(n.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(n.id); } }} style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon n={isOpen ? "chev" : "cright"} size={14} className="c" />
          {depth === 0 && <span className="proj-tile" style={{ width: 24, height: 24, fontSize: 10, background: n.is_client ? "var(--proj)" : "var(--subtlest)" }}>{n.name.slice(0, 2).toUpperCase()}</span>}
          <b style={{ fontWeight: depth === 0 ? 800 : 600 }}>{n.name}</b>
        </span>
        {n.is_client && <Lozenge tone="progress" style={{ textTransform: "none" }}>Client · {(n.client_user_ids || []).length} user{(n.client_user_ids || []).length === 1 ? "" : "s"}</Lozenge>}
        {depth === 0 && m && (manager
          ? <Lozenge tone={m.manager_ready ? "done" : "paused"} style={{ textTransform: "none" }} title={m.manager_ready ? "Approves for this client" : "Approves for this client, but has no WhatsApp number to reach them on"}>Manager · {manager}</Lozenge>
          : <Lozenge tone="paused" style={{ textTransform: "none" }} title="Approvals for this client go to every coordinator">No manager</Lozenge>)}
        <span className="cnt">{kids.length ? `${kids.length} sub · ` : ""}{count(n)} KPIs</span>
        <span className="act">
          {depth === 0 && <IconButton icon="people" label="Client users" size={15} onClick={() => onClients(n)} />}
          {depth === 0 && <IconButton icon="user" label="Manager (approves for this client)" size={15} onClick={() => onManager(n)} />}
          <IconButton icon="plus" label="Add sub-KRA" size={15} onClick={() => onAdd(n, "kra")} />
          <IconButton icon="board" label="Add KPI" size={15} onClick={() => onAdd(n, "kpi")} />
          <IconButton icon="pen" label="Rename" size={15} onClick={() => onRename(n, false)} />
          <IconButton icon="trash" label="Delete" size={15} onClick={() => onDelete(n, false)} />
        </span>
      </div>
      {isOpen && kids.map((c) => <Node key={c.id} n={c} depth={depth + 1} open={open} toggle={toggle} onAdd={onAdd} onRename={onRename} onDelete={onDelete} onClients={onClients} onManager={onManager} mgr={mgr} onOpenTask={onOpenTask} onManual={onManual} q={q} />)}
      {isOpen && kpis.map((k) => (
        <div key={`k${k.id}`} className={`tr d${Math.min(depth + 1, 3)}`} style={{ fontWeight: 500 }}>
          <span className="ref" style={{ cursor: "pointer" }} onClick={() => onOpenTask(k.id)}>{k.external_ref || `#${k.id}`}</span>
          <span style={{ cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} onClick={() => onOpenTask(k.id)}>{k.name}</span>
          {k.task_state && (() => { const [tone, label] = stateTone(k.task_state); return <Lozenge tone={tone}>{label === k.task_state ? k.task_state.replace(/_/g, " ") : label}</Lozenge>; })()}
          {k.has_user_manual && <button type="button" onClick={() => onManual(k)} title={`Open the user manual${k.manual_count > 1 ? ` (${k.manual_count})` : ""}`} style={{ border: 0, background: "none", padding: 0, cursor: "pointer" }}><Lozenge tone="neutral" style={{ textTransform: "none" }}><Icon n="book" size={12} /> manual{k.manual_count > 1 ? ` · ${k.manual_count}` : ""}</Lozenge></button>}
          <span className="cnt">{k.user_name ? <><Avatar name={k.user_name} id={k.user_id} size={18} /> {k.user_name}</> : k.task_state ? <span className="mini">unassigned</span> : ""}</span>
          <span className="act"><IconButton icon="pen" label="Rename" size={15} onClick={() => onRename(k, true)} /><IconButton icon="trash" label="Delete" size={15} onClick={() => onDelete(k, true)} /></span>
        </div>
      ))}
    </>
  );
}

/* Who approves for this client: Odoo accepts only a coordinator, owner or
   System user, so only they are offered; anything else it refuses is shown. */
function ManagerDialog({ node, current, onClose, onSaved, flags }) {
  const [users, setUsers] = useState(null);
  const [pick, setPick] = useState(current && Array.isArray(current.manager_user_id) ? String(current.manager_user_id[0]) : "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { P.coordinators().then(setUsers).catch((e) => { flags.err(e.message); setUsers([]); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    setBusy(true);
    try { await P.setManager(node.id, pick ? Number(pick) : false); flags.ok(pick ? "Manager set." : "Manager removed."); onSaved(); }
    catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Manager for ${node.name}`} width={460}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} disabled={!users} onClick={save}>Save</Button></>}>
      <p className="note" style={{ margin: 0 }}>The manager approves everything for this client — new requests, databases, switch-offs, meetings and finished work — and is the only one who talks to the client. With nobody set, it goes to every coordinator.</p>
      <Field label="Manager"><span className="input"><Select value={pick} onChange={(e) => setPick(e.target.value)} style={SEL} placeholder={users ? "— none —" : "Loading…"}><option value="">— none —</option>{(users || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></span></Field>
      <span className="mini">Only coordinators, owners and System admins can manage a client.</span>
    </Modal>
  );
}

function EditDialog({ d, busy, onClose, onRun }) {
  if (d.kind === "kpi") return <KpiDialog parent={d.parent} busy={busy} onClose={onClose} onRun={onRun} />;
  return <NameDialog d={d} busy={busy} onClose={onClose} onRun={onRun} />;
}

const SEL = { border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" };
const TA = { border: 0, background: "none", outline: 0, resize: "vertical", width: "100%", minHeight: 64, font: "inherit", color: "inherit" };

/* Rename, new sub-KRA, or new client (root KRA). A new client can be given its
   portal users straight away, as Odoo's Create KRA form does (client_user_ids). */
function NameDialog({ d, busy, onClose, onRun }) {
  const flags = useFlags();
  const [name, setName] = useState(d.kind === "rename" ? d.node.name : "");
  const root = d.kind === "kra" && !d.parent;
  const [users, setUsers] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  useEffect(() => { if (root) S.fetchClientUsers().then(setUsers).catch((e) => { flags.err(e.message); setUsers([]); }); }, [root, flags]);
  const title = d.kind === "rename" ? `Rename ${d.isKpi ? "KPI" : "KRA"}` : d.parent ? `New sub-KRA under ${d.parent.name}` : "New client (root KRA)";
  const go = () => {
    if (!name.trim()) return;
    if (d.kind === "rename") return onRun(() => (d.isKpi ? S.renameKpi(d.node.id, name) : S.updateKra(d.node.id, name)), "Renamed.");
    return onRun(() => S.createKra({ name, parentId: d.parent?.id, clientUserIds: root ? [...picked] : [] }), d.parent ? "Sub-KRA created." : "Client created.");
  };
  const tick = (id, on) => setPicked((s) => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; });
  return (
    <Modal open onClose={onClose} title={title} width={root ? 540 : 460} footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} disabled={!name.trim()} onClick={go}>{d.kind === "rename" ? "Save" : "Create"}</Button></>}>
      <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === "Enter") go(); }} /></Field>
      {root && <>
        <p className="mini" style={{ margin: 0 }}>A root KRA is a client. Tick the portal users who should see it and its tasks. Projects and versions go underneath; sub-KRAs take their client's users.</p>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <b style={{ fontSize: 13 }}>Client users</b>
          <span className="mini">Selected {picked.size} / {(users || []).length}</span>
          {(users || []).length > 0 && <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}><Button size="sm" kind="ghost" onClick={() => setPicked(new Set(users.map((u) => u.id)))}>Select all</Button><Button size="sm" kind="ghost" onClick={() => setPicked(new Set())}>Clear</Button></span>}
        </div>
        <div className="people" style={{ maxHeight: 220, overflowY: "auto" }}>
          {!users && <span className="mini" style={{ padding: 8 }}>Loading…</span>}
          {(users || []).map((u) => <label key={u.id}><input type="checkbox" checked={picked.has(u.id)} onChange={(e) => tick(u.id, e.target.checked)} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} /><Avatar name={u.name} id={u.id} size={22} />{u.name}<span className="mini" style={{ marginLeft: "auto" }}>{u.login || u.email || ""}</span></label>)}
          {users && !users.length && <span className="mini" style={{ padding: 8 }}>No client portal users yet. Create one with "Client users" on the tree after saving.</span>}
        </div>
      </>}
    </Modal>
  );
}

/* Odoo's Create KPI form (kpi_create.js): the same fields and the same checks
   (name, type, assignee and an estimate are required; minutes 0–59), saved
   through kra.kpi.create_kpi. */
function KpiDialog({ parent, busy, onClose, onRun }) {
  const flags = useFlags();
  const [f, setF] = useState({
    name: "", estimateHours: "1", estimateMinutes: "0", priority: "regular", docType: "", deliverable: [], userId: "", deadline: "",
    reminderDays: "0", reminderHours: "0", reminderMinutes: "0", description: "", checklist: "", guidelines: "", points: "0", flags: {},
  });
  const [users, setUsers] = useState([]);
  const [lib, setLib] = useState({ checklist: [], guidelines: [] });
  useEffect(() => {
    getIntakeUsers().then(setUsers).catch(() => {});
    Promise.all([S.fetchChecklistLibrary(), S.fetchGuidelineLibrary()]).then(([c, g]) => setLib({ checklist: c || [], guidelines: g || [] }));
  }, []);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const toggleDeliv = (code) => set("deliverable", f.deliverable.includes(code) ? f.deliverable.filter((c) => c !== code) : [...f.deliverable, code]);
  /* Library pick: appended as the next numbered line, like Odoo's "apply" does. */
  const addLine = (k, text) => { if (!text) return; const lines = f[k].split("\n").map((l) => l.replace(/^\d+\.\s*/, "").trim()).filter(Boolean); if (lines.includes(text)) return; set(k, [...lines, text].map((l, i) => `${i + 1}. ${l}`).join("\n")); };
  const h = Math.max(0, Math.floor(+f.estimateHours || 0)), m = Math.floor(+f.estimateMinutes || 0);
  const go = () => {
    if (!f.name.trim()) return flags.warn("KPI name is required.");
    if (!f.deliverable.length) return flags.warn("Please choose a type: Module, App or EXE.");
    if (!f.userId) return flags.warn("Assignee is required.");
    if (m < 0 || m > 59) return flags.warn("Minutes must be between 0 and 59.");
    if (!h && !m) return flags.warn("Estimate time is required. Enter hours and/or minutes.");
    onRun(() => S.createKpi({ ...f, kraId: parent.id, estimateHours: h, estimateMinutes: m }), "KPI created.");
  };
  const num = (k, max) => <Input type="number" min="0" max={max} value={f[k]} onChange={(e) => set(k, e.target.value)} />;
  return (
    <Modal open onClose={onClose} title={`New KPI under ${parent.name}`} width={720} footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} disabled={!f.name.trim()} onClick={go}>Create</Button></>}>
      <Field label="KPI name" required><Input value={f.name} autoFocus onChange={(e) => set("name", e.target.value)} /></Field>
      <div className="grid3">
        <Field label="Estimate" required><span style={{ display: "flex", gap: 6 }}><Input type="number" min="0" value={f.estimateHours} onChange={(e) => set("estimateHours", e.target.value)} right={<span className="ph">h</span>} /><Input type="number" min="0" max="59" value={f.estimateMinutes} onChange={(e) => set("estimateMinutes", e.target.value)} right={<span className="ph">m</span>} /></span></Field>
        <Field label="Priority"><span className="input"><Select value={f.priority} onChange={(e) => set("priority", e.target.value)} style={SEL}>{PRIORITIES.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}</Select></span></Field>
        <Field label="Assignee" required><span className="input"><Select value={f.userId} onChange={(e) => set("userId", e.target.value)} style={SEL} placeholder="Choose a person"><option value="">Choose a person</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></span></Field>
      </div>
      <div className="grid3">
        <div className="field"><span>Type<span className="req" aria-hidden="true"> *</span></span><span className="pillset">{DELIVERABLES.map((d) => <button key={d.code} type="button" className={`pill ${f.deliverable.includes(d.code) ? "on" : ""}`} aria-pressed={f.deliverable.includes(d.code)} onClick={() => toggleDeliv(d.code)}>{d.label}</button>)}</span><small className="mini">Module, App and/or EXE</small></div>
        <Field label="Request type" hint="Gives it a REQ / UPT / BUG ref"><span className="input"><Select value={f.docType} onChange={(e) => set("docType", e.target.value)} style={SEL}><option value="">None</option>{TASK_TYPES.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}</Select></span></Field>
        <Field label="Deadline"><Input type="date" value={f.deadline} onChange={(e) => set("deadline", e.target.value)} /></Field>
      </div>
      <div className="grid3">
        <Field label="Reminder every" hint="days · hours · minutes"><span style={{ display: "flex", gap: 6 }}>{num("reminderDays")}{num("reminderHours", 23)}{num("reminderMinutes", 59)}</span></Field>
        <Field label="KPI points"><Input type="number" min="0" step="0.5" value={f.points} onChange={(e) => set("points", e.target.value)} /></Field>
      </div>
      <Field label="Description"><span className="input ta" style={{ height: "auto" }}><textarea rows={3} value={f.description} onChange={(e) => set("description", e.target.value)} style={TA} /></span></Field>
      {[["checklist", "Checklist"], ["guidelines", "Guidelines"]].map(([k, label]) => (
        <div key={k} className="field">{label}
          {lib[k].length > 0 && <span className="input" style={{ height: 30 }}><Select value="" onChange={(e) => addLine(k, lib[k].find((x) => String(x.id) === e.target.value)?.name)} style={SEL} placeholder={`Add from the ${label.toLowerCase()} library…`}><option value="">{`Add from the ${label.toLowerCase()} library…`}</option>{lib[k].map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></span>}
          <span className="input ta" style={{ height: "auto" }}><textarea rows={3} value={f[k]} onChange={(e) => set(k, e.target.value)} placeholder={"1. …\n2. …"} style={TA} /></span>
        </div>
      ))}
      <div className="field">Flags<span style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0 14px" }}>
        {S.KPI_FLAGS.map(([k, label]) => <label key={k} className="chk"><input type="checkbox" checked={!!f.flags[k]} onChange={(e) => set("flags", { ...f.flags, [k]: e.target.checked })} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} />{label}</label>)}
      </span></div>
    </Modal>
  );
}

function ClientsDialog({ node, onClose, onSaved, flags }) {
  const [users, setUsers] = useState(null);
  const [picked, setPicked] = useState(() => new Set((node.client_user_ids || []).map((u) => (typeof u === "object" ? u.id : u))));
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [nu, setNu] = useState({ name: "", login: "", phone: "", password: "" });
  const [created, setCreated] = useState(null); /* {name, login, password} — shown once */
  const loadUsers = () => S.fetchClientUsers().then(setUsers).catch((e) => { flags.err(e.message); setUsers([]); });
  useEffect(() => { loadUsers(); }, [flags]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => { setBusy(true); try { S.assertOk(await S.assignKraClients(node.id, [...picked]), "Could not save."); flags.ok("Client users saved."); onSaved(); } catch (e) { flags.err(e.message); } finally { setBusy(false); } };
  const create = async () => {
    setBusy(true);
    try {
      const r = S.assertOk(await S.createClientUser(nu), "Could not create the login.");
      flags.ok(r.message || "Client login created.");
      setCreated({ name: r.name, login: r.login, password: r.generated_password ? r.password : "" });
      setPicked((s) => new Set(s).add(r.user_id)); /* ticked; Save assigns it to this KRA */
      setNu({ name: "", login: "", phone: "", password: "" }); setAdding(false);
      await loadUsers();
    } catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  const copy = (t) => { try { navigator.clipboard.writeText(t); flags.ok("Copied."); } catch (_) {} };
  return (
    <Modal open onClose={onClose} title={`Client users — ${node.name}`} width={560} footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} onClick={save}>Save</Button></>}>
      <p className="note" style={{ margin: 0 }}>These people see {node.name}'s tasks in the client portal and get WhatsApp approvals. Tick who belongs to this client, or create a new client login below.</p>
      {created && (
        <div className="callout ok" style={{ alignItems: "flex-start" }}>
          <Icon n="check" size={18} />
          <span style={{ flex: 1 }}>
            <b>{created.name}</b> can sign in as <b>{created.login}</b>.
            {created.password ? <> Password: <code style={{ fontWeight: 800, fontSize: 14 }}>{created.password}</code> — shown only now, copy it before closing.</> : " They use the password you set."}
            <span className="mini" style={{ display: "block", marginTop: 4 }}>Ticked below — press Save to assign them to {node.name}.</span>
          </span>
          {created.password && <Button size="sm" onClick={() => copy(`${created.login} / ${created.password}`)}>Copy</Button>}
        </div>
      )}
      {!adding ? <Button size="sm" icon="plus" style={{ alignSelf: "flex-start" }} onClick={() => { setCreated(null); setAdding(true); }}>New client login</Button> : (
        <div className="cardbox" style={{ boxShadow: "none", padding: 12, gap: 10 }}>
          <div className="grid2">
            <Field label="Name" required><Input value={nu.name} autoFocus onChange={(e) => setNu({ ...nu, name: e.target.value })} /></Field>
            <Field label="Login" required><Input value={nu.login} placeholder="e.g. name@client.com" onChange={(e) => setNu({ ...nu, login: e.target.value })} /></Field>
            <Field label="WhatsApp phone (optional)" hint="Digits with country code, no +"><Input value={nu.phone} inputMode="tel" onChange={(e) => setNu({ ...nu, phone: e.target.value })} /></Field>
            <Field label="Password (optional)" hint="Blank → a 6-digit one is generated"><Input value={nu.password} type="text" autoComplete="new-password" onChange={(e) => setNu({ ...nu, password: e.target.value })} /></Field>
          </div>
          <span style={{ display: "inline-flex", gap: 8 }}>
            <Button size="sm" kind="primary" busy={busy} disabled={!nu.name.trim() || !nu.login.trim() || (nu.password && nu.password.length < 4)} onClick={create}>Create login</Button>
            <Button size="sm" kind="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          </span>
        </div>
      )}
      <div className="people">
        {!users && <span className="mini" style={{ padding: 8 }}>Loading…</span>}
        {(users || []).map((u) => <label key={u.id}><input type="checkbox" checked={picked.has(u.id)} onChange={(e) => setPicked((s) => { const n = new Set(s); e.target.checked ? n.add(u.id) : n.delete(u.id); return n; })} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} /><Avatar name={u.name} id={u.id} size={22} />{u.name}<span className="mini" style={{ marginLeft: "auto" }}>{u.login || u.email || ""}</span></label>)}
        {users && !users.length && <span className="mini" style={{ padding: 8 }}>No client accounts yet.</span>}
      </div>
    </Modal>
  );
}
