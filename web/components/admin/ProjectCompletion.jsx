"use client";
import { Fragment, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Empty, ErrorState, Field, Icon, Lozenge, PageHeader, Select, Skeleton, StaleBar, stateTone } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import * as A from "@/lib/services/admin";
import { useTaskActions } from "@/components/task/TaskActions";
import IntakeNav from "./IntakeNav";

/* Is a project done? Every task under a project (sub-KRA), grouped as
   requirement › its updates and bugs (linked by related_req_ref), with
   done / total per kind. /kpi_project/completion_status. */
const sel = { border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" };
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

export default function ProjectCompletion() {
  const acts = useTaskActions();
  const sp = useSearchParams();
  const [clients, setClients] = useState([]);
  const [client, setClient] = useState(sp.get("client") || "");
  const [kras, setKras] = useState([]);
  const [project, setProject] = useState(sp.get("project") || "");
  useEffect(() => { A.getClients().then(setClients).catch(() => {}); }, []);
  useEffect(() => { setKras([]); if (client) A.getSubKras(+client).then(setKras).catch(() => setKras([])); }, [client]);

  const st = useResource(A.PROJECT_COMPLETION_PATH, { project_kra_id: Number(project) || 0 }, { enabled: !!project, ttl: 15000 });
  const d = project ? st.data : null;
  const refused = d?.status === false;
  const t = d?.totals;
  const all = t ? t.requirements_total + t.updates_total + t.bugs_total : 0;
  const done = t ? t.requirements_done + t.updates_done + t.bugs_done : 0;

  return (
    <>
      <PageHeader crumbs={[{ label: "Intake" }, { label: "Project completion" }]} title="Project completion" meta="Requirements, updates and bugs of one project, and what is still open" />
      <IntakeNav />
      <div className="page" style={{ overflow: "auto" }}>
        <div className="cardbox" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", gap: 12 }}>
          <Field label="Client"><span className="input" style={{ minWidth: 240 }}><Select value={client} onChange={(e) => { setClient(e.target.value); setProject(""); }} style={sel}><option value="">Choose a client</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.parent_name ? `${c.parent_name} › ${c.name}` : c.name}</option>)}</Select></span></Field>
          <Field label="Project"><span className="input" style={{ minWidth: 300 }}><Select value={project} disabled={!kras.length} onChange={(e) => setProject(e.target.value)} style={sel}><option value="">Choose a project</option>{kras.map((k) => <option key={k.id} value={k.id}>{k.display || k.name}</option>)}</Select></span></Field>
        </div>
        {!project && <div className="cardbox"><Empty icon="check" title="Pick a project" text="Choose the client and the project to see how much of it is done." /></div>}
        {project && refused && <ErrorState error={{ message: d.message }} onRetry={st.refresh} />}
        {project && st.error && !st.data && <ErrorState error={st.error} onRetry={st.refresh} />}
        {project && st.stale && <StaleBar error={st.error} onRetry={st.refresh} />}
        {project && !d && !st.error && <div className="cardbox"><Skeleton rows={6} /></div>}
        {t && (
          <>
            <div className="stats">
              <div className="stat"><small>Project</small><b style={{ fontSize: 18 }}>{d.project?.name}</b><span>{t.project_complete ? <Lozenge tone="done">✓ Complete</Lozenge> : all ? <Lozenge tone="paused">{all - done} open</Lozenge> : <Lozenge tone="todo">No tasks</Lozenge>}</span></div>
              <Tile label="Requirements" a={t.requirements_done} b={t.requirements_total} />
              <Tile label="Updates" a={t.updates_done} b={t.updates_total} />
              <Tile label="Bugs" a={t.bugs_done} b={t.bugs_total} />
            </div>
            <div className="cardbox table-scroll" style={{ padding: 0, flex: "none" }}>
              <table className="table">
                <thead><tr><th>Ref</th><th>Task</th><th>State</th><th>Assignee</th><th className="num">Estimate</th><th className="num">Actual</th><th>Deadline</th><th>Completed</th><th>Signed cert</th></tr></thead>
                <tbody>
                  {(d.requirements || []).map((g) => (
                    <Fragment key={g.ref}>
                      {g.req ? <Row k={g.req} kind="REQ" onOpen={acts.openTask} strong /> : <tr className="group"><td colSpan={9}>{g.ref} · requirement not found in this project</td></tr>}
                      {g.updates.map((u) => <Row key={u.id} k={u} kind="UPT" onOpen={acts.openTask} indent />)}
                      {g.bugs.map((b) => <Row key={b.id} k={b} kind="BUG" onOpen={acts.openTask} indent />)}
                    </Fragment>
                  ))}
                  {(d.orphan_updates || []).length > 0 && <tr className="group"><td colSpan={9}>Updates not linked to a requirement</td></tr>}
                  {(d.orphan_updates || []).map((u) => <Row key={u.id} k={u} kind="UPT" onOpen={acts.openTask} />)}
                  {(d.orphan_bugs || []).length > 0 && <tr className="group"><td colSpan={9}>Bugs not linked to a requirement</td></tr>}
                  {(d.orphan_bugs || []).map((b) => <Row key={b.id} k={b} kind="BUG" onOpen={acts.openTask} />)}
                  {!all && <tr><td colSpan={9} className="empty">This project has no tasks yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Tile({ label, a, b }) {
  const p = pct(a, b);
  return (
    <div className="stat"><small>{label}</small><b>{a}<span className="mini" style={{ fontSize: 14 }}> / {b}</span></b>
      <span style={{ display: "block", height: 6, borderRadius: 99, background: "var(--hover)", overflow: "hidden", marginTop: 4 }}><span style={{ display: "block", height: "100%", width: `${p}%`, background: p === 100 ? "var(--pri-regular)" : "var(--brand)" }} /></span>
      <span>{b ? `${p}% done` : "none"}</span>
    </div>
  );
}

function Row({ k, kind, onOpen, strong, indent }) {
  const [tone, label] = stateTone(k.task_state);
  return (
    <tr>
      <td style={{ paddingLeft: indent ? 28 : undefined }}>{indent && <span className="mini">↳ </span>}<span className="ref">{k.external_ref || `#${k.id}`}</span> <span className="mini">{kind}</span></td>
      <td style={{ whiteSpace: "normal", minWidth: 220 }}><a href={`/board?task=${k.id}`} onClick={(e) => { e.preventDefault(); onOpen(k.id); }} style={{ fontWeight: strong ? 700 : 500 }}>{k.name}</a></td>
      <td><Lozenge tone={tone}>{label}</Lozenge></td>
      <td>{k.primary_assignee || <span className="mini">—</span>}</td>
      <td className="num">{k.estimate_hours ? `${k.estimate_hours}h` : "—"}</td>
      <td className="num" style={{ color: k.estimate_hours && k.actual_hours > k.estimate_hours ? "var(--danger)" : undefined }}>{k.actual_hours ? `${k.actual_hours}h` : "—"}</td>
      <td className="mini">{k.deadline || "—"}</td>
      <td className="mini">{k.completion_date || "—"}</td>
      <td>{k.has_signed_cert ? <span style={{ color: "var(--pri-regular)", fontWeight: 700 }}><Icon n="check" size={14} /> Signed</span> : <span className="mini">—</span>}</td>
    </tr>
  );
}
