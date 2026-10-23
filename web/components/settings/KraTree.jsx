"use client";
import { useEffect, useMemo, useState } from "react";
import { Avatar, Button, ErrorState, Field, Icon, IconButton, Input, Lozenge, Modal, PageHeader, Skeleton, stateTone, useDialogs, useFlags, Select } from "@/components/ui";
import * as S from "@/lib/services/settings";
import * as P from "@/lib/services/approvals";
import { getIntakeUsers, fileToBase64 } from "@/lib/services/admin";
import { href } from "@/lib/api";
import { PRIORITIES, DELIVERABLES, TASK_TYPES, DELIVERABLE_OTHER_REQUIRED, deliverableOtherValue, findNameMatches } from "@/lib/services/kpiActions";
import { useTaskActions } from "@/components/task/TaskActions";
import OtherTypeInput from "@/components/task/OtherTypeInput";
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
  const [detailsId, setDetailsId] = useState(null); /* KPI Details (Odoo kpi_view) */
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
          {tree && <div className="tree">{tree.filter(matches).map((n) => <Node key={n.id} n={n} depth={0} open={open} toggle={toggle} onAdd={(node, kind) => setDialog({ kind, parent: node })} onRename={(node, isKpi) => setDialog({ kind: "rename", node, isKpi })} onDelete={del} onClients={(node) => setDialog({ kind: "clients", node })} onManager={(node) => setDialog({ kind: "manager", node })} mgr={mgr} onOpenTask={(id) => acts.openTask(id)} onManual={openManual} onDetails={setDetailsId} q={q} />)}{!tree.length && <div className="empty">No KRAs yet. Create the first client above.</div>}</div>}
        </div>
      </div>
      {dialog && (dialog.kind === "clients" ? <ClientsDialog node={dialog.node} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); load(); }} flags={flags} />
        : dialog.kind === "manager" ? <ManagerDialog node={dialog.node} current={mgr[dialog.node.id]} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); loadManagers(); }} flags={flags} />
        : <EditDialog d={dialog} busy={busy} onClose={() => setDialog(null)} onRun={run} />)}
      {detailsId && <KpiDetails id={detailsId} onClose={() => setDetailsId(null)} onEdit={(id) => { setDetailsId(null); acts.openTask(id); }} />}
    </>
  );
}

/* Odoo's KPI Details screen (kpi_view.js, /kra_kpi/get_kpi_detail): every
   field of the KPI, read-only. Edit opens the task, where the web edits it. */
function KpiDetails({ id, onClose, onEdit }) {
  const [k, setK] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    S.fetchKpiDetail(id).then((r) => { if (!r?.status) throw new Error(r?.message || "Failed to load KPI."); setK(r.kpi); }).catch(setErr);
  }, [id]);
  const links = (() => { try { const p = JSON.parse(k?.related_links || "[]"); return Array.isArray(p) ? p : []; } catch { return []; } })();
  const rem = k && [k.reminder_days && `${k.reminder_days}d`, k.reminder_hours && `${k.reminder_hours}h`, k.reminder_minutes && `${k.reminder_minutes}m`].filter(Boolean).join(" ");
  const yes = (v) => (v ? "Yes" : "No");
  const rows = k ? [
    ["Name", k.name], ["KRA", k.kra_name], ["Priority", k.priority], ["Estimate", k.estimate_display], ["Points", k.points],
    ["Assignee", k.user_name], ["User Group", k.user_group_name], ["Deadline", k.deadline],
    ["Reminder Interval", rem || <span className="mini">Not set</span>], ["Next KPI", k.next_kpi_name], ["Warehouse", k.warehouse], ["File Name", k.file_name],
    ["Uploaded File", k.file_content ? <a className="btn btn-ghost" style={{ height: 28, fontSize: 12.5 }} href={`data:application/octet-stream;base64,${k.file_content}`} download={k.file_name || "download"}>Download File</a> : <span className="mini">No file uploaded</span>],
    ["Related Links", links.length ? <div>{links.map((l) => <div key={l}><a href={l} target="_blank" rel="noreferrer">{l}</a></div>)}</div> : <span className="mini">No links added</span>],
    ["Actions", k.actions || "-"], ["Description", k.description], ["Checklist", k.checklist], ["Guidelines", k.guidelines],
    ["Is Mandatory", yes(k.is_mandatory)], ["Auto Estimated", yes(k.auto_estimated)], ["Service KPI", yes(k.service_kpi)], ["Coordinator Review", yes(k.is_manager_review_needed)],
    ["Auto Assign", yes(k.auto_assign)], ["Is Permanent", yes(k.is_permanent)], ["Is Meeting", yes(k.is_meeting)], ["Customer Review", yes(k.is_customer_review_needed)],
  ] : [];
  return (
    <Modal open onClose={onClose} title="KPI Details" width={680}
      footer={<><Button kind="ghost" onClick={onClose}>Back</Button>{k && <Button kind="primary" onClick={() => onEdit(k.id)}>Edit</Button>}</>}>
      {err && <ErrorState error={err} />}
      {!k && !err && <Skeleton rows={8} />}
      {k && rows.map(([label, v]) => (
        <div key={label} className="kv"><span className="lbl">{label}</span><span className="val" style={{ whiteSpace: "pre-wrap" }}>{v === "" || v == null ? "—" : v}</span></div>
      ))}
    </Modal>
  );
}

function Node({ n, depth, open, toggle, onAdd, onRename, onDelete, onClients, onManager, mgr = {}, onOpenTask, onManual, onDetails, q }) {
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
      {isOpen && kids.map((c) => <Node key={c.id} n={c} depth={depth + 1} open={open} toggle={toggle} onAdd={onAdd} onRename={onRename} onDelete={onDelete} onClients={onClients} onManager={onManager} mgr={mgr} onOpenTask={onOpenTask} onManual={onManual} onDetails={onDetails} q={q} />)}
      {isOpen && kpis.map((k) => (
        <div key={`k${k.id}`} className={`tr d${Math.min(depth + 1, 3)}`} style={{ fontWeight: 500 }}>
          <span className="ref" style={{ cursor: "pointer" }} onClick={() => onOpenTask(k.id)}>{k.external_ref || `#${k.id}`}</span>
          <span style={{ cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} onClick={() => onOpenTask(k.id)}>{k.name}</span>
          {k.task_state && (() => { const [tone, label] = stateTone(k.task_state); return <Lozenge tone={tone}>{label === k.task_state ? k.task_state.replace(/_/g, " ") : label}</Lozenge>; })()}
          {k.has_user_manual && <button type="button" onClick={() => onManual(k)} title={`Open the user manual${k.manual_count > 1 ? ` (${k.manual_count})` : ""}`} style={{ border: 0, background: "none", padding: 0, cursor: "pointer" }}><Lozenge tone="neutral" style={{ textTransform: "none" }}><Icon n="book" size={12} /> manual{k.manual_count > 1 ? ` · ${k.manual_count}` : ""}</Lozenge></button>}
          <span className="cnt">{k.user_name ? <><Avatar name={k.user_name} uid={k.user_id} size={18} /> {k.user_name}</> : k.task_state ? <span className="mini">unassigned</span> : ""}</span>
          <span className="act"><IconButton icon="info" label="KPI details" size={15} onClick={() => onDetails(k.id)} /><IconButton icon="pen" label="Rename" size={15} onClick={() => onRename(k, true)} /><IconButton icon="trash" label="Delete" size={15} onClick={() => onDelete(k, true)} /></span>
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
          {(users || []).map((u) => <label key={u.id}><input type="checkbox" checked={picked.has(u.id)} onChange={(e) => tick(u.id, e.target.checked)} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} /><Avatar name={u.name} uid={u.id} size={22} />{u.name}<span className="mini" style={{ marginLeft: "auto" }}>{u.login || u.email || ""}</span></label>)}
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
  const dlg = useDialogs();
  const [f, setF] = useState({
    name: "", estimateHours: "1", estimateMinutes: "0", priority: "regular", docType: "", deliverable: [], deliverableOther: "", userId: "", deadline: "",
    reminderDays: "0", reminderHours: "0", reminderMinutes: "0", description: "", checklist: "", guidelines: "", points: "0", flags: {},
    userGroupId: "", actionConfigId: "", nextKpiId: "", warehouseId: "", fileName: "", uploadedFile: "", relatedLinks: [],
  });
  const [users, setUsers] = useState([]);
  const [lib, setLib] = useState({ checklist: [], guidelines: [] });
  const [opts, setOpts] = useState({ groups: [], actions: [], kpis: [], warehouses: [] });
  const [libOpen, setLibOpen] = useState(null); /* "checklist" | "guidelines" */
  const [linkInput, setLinkInput] = useState("");
  const [matches, setMatches] = useState([]);
  const loadLib = () => Promise.all([S.fetchChecklistLibrary(), S.fetchGuidelineLibrary()]).then(([c, g]) => setLib({ checklist: c || [], guidelines: g || [] }));
  const loadOpts = () => Promise.all([S.fetchUserGroups(), S.fetchActionConfigs(), S.fetchKpiPickList(), S.fetchWarehouses()])
    .then(([groups, actions, kpis, warehouses]) => setOpts({ groups, actions, kpis, warehouses }));
  useEffect(() => {
    getIntakeUsers().then(setUsers).catch(() => {});
    loadLib(); loadOpts();
  }, []);
  /* Odoo onNameTyped: tasks under this KRA that already use the name. A heads-up only. */
  useEffect(() => {
    const name = f.name.trim();
    if (!name) { setMatches([]); return; }
    const t = setTimeout(() => findNameMatches(name, parent.id).then((r) => setMatches(r?.matches || [])), 350);
    return () => clearTimeout(t);
  }, [f.name, parent.id]);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const toggleDeliv = (code) => set("deliverable", f.deliverable.includes(code) ? f.deliverable.filter((c) => c !== code) : [...f.deliverable, code]);
  /* The "+" next to each pick list (Odoo saveQuick*): create, reload the list, select the new one. */
  const quick = async (title, fields, create, key, reload) => {
    const v = await dlg.form({ title, fields, confirmLabel: "Create" });
    if (!v) return;
    try { const id = await create(v); await reload(); if (key) set(key, String(id)); flags.ok(`${title.replace(/^New /, "")} created.`); }
    catch (e) { flags.err(e.message); }
  };
  const addGroup = () => quick("New user group", [{ key: "name", label: "Group name", value: "" }], (v) => S.quickCreateUserGroup(v.name), "userGroupId", loadOpts);
  const addEmployee = () => quick("New employee", [{ key: "name", label: "Employee name", value: "" }, { key: "email", label: "Email", value: "", type: "email" }, { key: "login", label: "Login", value: "" }],
    async (v) => {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) throw new Error("Please enter a valid email address.");
      const id = await S.quickCreateEmployee(v);
      flags.ok("Please set a password from Settings → Users.");
      return id;
    }, "userId", () => getIntakeUsers().then(setUsers));
  const addAction = () => quick("New action", [{ key: "name", label: "Screen name", value: "" }, { key: "url", label: "URL", value: "" }], S.quickCreateAction, "actionConfigId", loadOpts);
  const addWarehouse = () => quick("New warehouse", [{ key: "name", label: "Warehouse name", value: "" }, { key: "countryCode", label: "Country code", value: "+91", required: false },
    { key: "phone", label: "Phone", value: "", required: false }, { key: "address", label: "Address", value: "", required: false },
    { key: "company", label: "Company", value: "", required: false }, { key: "transaction", label: "Transaction number", value: "", required: false }], S.quickCreateWarehouse, "warehouseId", loadOpts);
  const pickFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const b64 = await fileToBase64(file);
    setF((x) => ({ ...x, fileName: file.name, uploadedFile: b64 }));
  };
  /* Odoo addRelatedLink: a real URL, no duplicates. */
  const addLink = () => {
    const link = linkInput.trim();
    if (!link) return flags.warn("Please enter a link.");
    try { new URL(link); } catch { return flags.warn("Please enter a valid URL (e.g., https://example.com)."); }
    if (f.relatedLinks.includes(link)) return flags.warn("This link is already added.");
    set("relatedLinks", [...f.relatedLinks, link]); setLinkInput("");
  };
  const h = Math.max(0, Math.floor(+f.estimateHours || 0)), m = Math.floor(+f.estimateMinutes || 0);
  const go = () => {
    if (!f.name.trim()) return flags.warn("KPI name is required.");
    if (!f.deliverable.length) return flags.warn("Please choose a type: Module, App, EXE or Other.");
    const deliverableOther = deliverableOtherValue(f.deliverable, f.deliverableOther);
    if (f.deliverable.includes("other") && !deliverableOther) return flags.warn(DELIVERABLE_OTHER_REQUIRED);
    if (!f.userId) return flags.warn("Assignee is required.");
    if (m < 0 || m > 59) return flags.warn("Minutes must be between 0 and 59.");
    if (!h && !m) return flags.warn("Estimate time is required. Enter hours and/or minutes.");
    /* Canonical order module,app,exe,other, whatever order the pills were tapped in. */
    const deliverable = DELIVERABLES.map((d) => d.code).filter((c) => f.deliverable.includes(c));
    onRun(() => S.createKpi({ ...f, deliverable, deliverableOther, kraId: parent.id, estimateHours: h, estimateMinutes: m }), "KPI created.");
  };
  const num = (k, max) => <Input type="number" min="0" max={max} value={f[k]} onChange={(e) => set(k, e.target.value)} />;
  return (
    <Modal open onClose={onClose} title={`New KPI under ${parent.name}`} width={720} footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} disabled={!f.name.trim()} onClick={go}>Create</Button></>}>
      <Field label="KPI name" required><Input value={f.name} autoFocus onChange={(e) => set("name", e.target.value)} /></Field>
      {matches.length > 0 && (
        <div className="callout" style={{ background: "var(--lz-paused-bg)", borderColor: "var(--pri-important)" }}>
          <span>{matches.length} task(s) under this KRA already use this name:
            {matches.map((m) => <div key={m.id} style={{ marginLeft: 12 }}>{m.external_ref && <Lozenge tone="neutral" style={{ marginRight: 4 }}>{m.external_ref}</Lozenge>}{m.name}{m.assignee ? <span className="mini"> · {m.assignee}</span> : null}</div>)}
            <div className="mini">You can still save — this is only a heads-up.</div></span>
        </div>
      )}
      <div className="grid3">
        <Field label="Estimate" required><span style={{ display: "flex", gap: 6 }}><Input type="number" min="0" value={f.estimateHours} onChange={(e) => set("estimateHours", e.target.value)} right={<span className="ph">h</span>} /><Input type="number" min="0" max="59" value={f.estimateMinutes} onChange={(e) => set("estimateMinutes", e.target.value)} right={<span className="ph">m</span>} /></span></Field>
        <Field label="Priority"><span className="input"><Select value={f.priority} onChange={(e) => set("priority", e.target.value)} style={SEL}>{PRIORITIES.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}</Select></span></Field>
        <Field label="Assignee" required><span style={{ display: "flex", gap: 6 }}><span className="input" style={{ flex: 1 }}><Select value={f.userId} onChange={(e) => set("userId", e.target.value)} style={SEL} placeholder="Choose a person"><option value="">Choose a person</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></span><Button kind="ghost" onClick={addEmployee} title="New employee">+</Button></span></Field>
      </div>
      <div className="grid2">
        <PickPlus label="User group" value={f.userGroupId} onChange={(v) => set("userGroupId", v)} items={opts.groups} placeholder="Select user group" onAdd={addGroup} />
        <PickPlus label="Actions" value={f.actionConfigId} onChange={(v) => set("actionConfigId", v)} items={opts.actions} placeholder="Select action" onAdd={addAction} />
        <PickPlus label="Next KPI" value={f.nextKpiId} onChange={(v) => set("nextKpiId", v)} items={opts.kpis} placeholder="Select next KPI" />
        <PickPlus label="Warehouse" value={f.warehouseId} onChange={(v) => set("warehouseId", v)} items={opts.warehouses} placeholder="Select warehouse" onAdd={addWarehouse} />
        <Field label="File name"><Input value={f.fileName} onChange={(e) => set("fileName", e.target.value)} /></Field>
        <Field label="Upload file"><input type="file" onChange={pickFile} /></Field>
      </div>
      <Field label="Related links" hint="Add reference links, documentation URLs, or related resources">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ display: "flex", gap: 6 }}><Input type="url" value={linkInput} onChange={(e) => setLinkInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLink(); } }} placeholder="Enter URL (e.g., https://example.com/docs)" /><Button onClick={addLink}>Add</Button></span>
          {f.relatedLinks.length ? f.relatedLinks.map((l, i) => (
            <span key={l} className="row" style={{ gap: 8 }}><a href={l} target="_blank" rel="noreferrer" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 520 }}>{l}</a>
              <Button size="sm" kind="ghost" onClick={() => set("relatedLinks", f.relatedLinks.filter((_, j) => j !== i))}>Remove</Button></span>
          )) : <span className="mini">No links added yet</span>}
        </div>
      </Field>
      <div className="grid3">
        <div className="field"><span>Type<span className="req" aria-hidden="true"> *</span></span><span className="pillset">{DELIVERABLES.map((d) => <button key={d.code} type="button" className={`pill ${f.deliverable.includes(d.code) ? "on" : ""}`} aria-pressed={f.deliverable.includes(d.code)} onClick={() => toggleDeliv(d.code)}>{d.label}</button>)}</span>{f.deliverable.includes("other") ? <OtherTypeInput bare value={f.deliverableOther} onChange={(v) => set("deliverableOther", v)} autoFocus /> : <small className="mini">Module, App, EXE and/or Other</small>}</div>
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
          <span><Button size="sm" kind="ghost" onClick={() => setLibOpen(k)}>+ Add {label}</Button></span>
          <span className="input ta" style={{ height: "auto" }}><textarea rows={3} value={f[k]} onChange={(e) => set(k, e.target.value)} placeholder={"1. …\n2. …"} style={TA} /></span>
        </div>
      ))}
      <div className="field">Flags<span style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0 14px" }}>
        {S.KPI_FLAGS.map(([k, label]) => <label key={k} className="chk"><input type="checkbox" checked={!!f.flags[k]} onChange={(e) => set("flags", { ...f.flags, [k]: e.target.checked })} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} />{label}</label>)}
      </span></div>
      {libOpen && (
        <LibraryDialog title={libOpen === "checklist" ? "Checklist Library" : "Guideline Library"} noun={libOpen === "checklist" ? "checklist" : "guideline"}
          items={lib[libOpen]} text={f[libOpen]} onClose={() => setLibOpen(null)}
          onAdd={async (name) => { const id = await (libOpen === "checklist" ? S.addChecklistLibraryItem(name) : S.addGuidelineLibraryItem(name)); await loadLib(); return id; }}
          onApply={(text) => { set(libOpen, text); flags.ok(libOpen === "checklist" ? "Checklist items applied." : "Guideline items applied."); setLibOpen(null); }} />
      )}
    </Modal>
  );
}

/* A pick list with Odoo's "+" quick-create button beside it. */
function PickPlus({ label, value, onChange, items, placeholder, onAdd }) {
  return (
    <Field label={label}>
      <span style={{ display: "flex", gap: 6 }}>
        <span className="input" style={{ flex: 1 }}><Select value={value} onChange={(e) => onChange(e.target.value)} style={SEL} placeholder={placeholder}><option value="">{placeholder}</option>{items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></span>
        {onAdd && <Button kind="ghost" onClick={onAdd} title={`New ${label.toLowerCase()}`}>+</Button>}
      </span>
    </Field>
  );
}

/* Odoo's Checklist / Guideline Library modal: add a new item to the library,
   tick items (the ones already in the text start ticked), Apply Selected
   writes them as "1. …" lines in library order. */
function LibraryDialog({ title, noun, items, text, onAdd, onApply, onClose }) {
  const flags = useFlags();
  const [picked, setPicked] = useState(() => {
    const lines = (text || "").split("\n").map((l) => l.replace(/^\d+\.\s*/, "").trim()).filter(Boolean);
    return items.filter((x) => lines.includes(x.name)).map((x) => x.id);
  });
  const [neu, setNeu] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!neu.trim()) return flags.warn(`Please enter a ${noun} item.`);
    setBusy(true);
    try { const id = await onAdd(neu); setPicked((p) => [...p, id]); setNeu(""); flags.ok(`${noun[0].toUpperCase()}${noun.slice(1)} item added successfully.`); }
    catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  const apply = () => onApply(items.filter((x) => picked.includes(x.id)).map((x, i) => `${i + 1}. ${x.name}`).join("\n"));
  return (
    <Modal open onClose={onClose} title={title} width={620}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" onClick={apply}>Apply Selected</Button></>}>
      <Field label={`Add new ${noun} item`}>
        <span style={{ display: "flex", gap: 6 }}><Input value={neu} onChange={(e) => setNeu(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} placeholder={`Enter ${noun} item`} /><Button kind="primary" busy={busy} onClick={add}>+ Add</Button></span>
      </Field>
      <Field label="Select from existing items">
        <div style={{ maxHeight: 300, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: 10 }}>
          {items.length ? items.map((x) => (
            <label key={x.id} className="chk"><input type="checkbox" checked={picked.includes(x.id)} onChange={() => setPicked((p) => (p.includes(x.id) ? p.filter((y) => y !== x.id) : [...p, x.id]))} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} />{x.name}</label>
          )) : <span className="mini">No {noun} items available</span>}
        </div>
      </Field>
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
        {(users || []).map((u) => <label key={u.id}><input type="checkbox" checked={picked.has(u.id)} onChange={(e) => setPicked((s) => { const n = new Set(s); e.target.checked ? n.add(u.id) : n.delete(u.id); return n; })} style={{ width: 15, height: 15, accentColor: "var(--brand)" }} /><Avatar name={u.name} uid={u.id} size={22} />{u.name}<span className="mini" style={{ marginLeft: "auto" }}>{u.login || u.email || ""}</span></label>)}
        {users && !users.length && <span className="mini" style={{ padding: 8 }}>No client accounts yet.</span>}
      </div>
    </Modal>
  );
}
