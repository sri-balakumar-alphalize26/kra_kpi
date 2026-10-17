"use client";
import { useState } from "react";
import { Avatar, Button, ErrorState, Icon, Lozenge, PageHeader, Skeleton, Select } from "@/components/ui";
import CopyLink from "@/components/ui/CopyLink";
import { useResource } from "@/lib/useFetch";
import { href } from "@/lib/api";
import * as M from "@/lib/services/more";
import { useTaskActions } from "@/components/task/TaskActions";

/* Odoo's task_documents.js filters, same options and the same rules (all
   client-side over /task_documents/list, which is already scoped per user). */
const PRIORITIES = [["urgent", "Urgent"], ["important", "Important"], ["regular", "Regular"]];
const PRI_TONE = { urgent: "danger", important: "paused", regular: "neutral" };
const ATTACH = [["yes", "With attachments"], ["no", "No attachments"]];
const DOC_TYPES = [
  ["task_docs", "Has task documents", "task_doc_count"], ["files", "Has files", "doc_count"],
  ["drive", "Has Drive / Cloud", "drive_count"], ["links", "Has links", "link_count"],
  ["github", "Has GitHub repos", "github_count"], ["manuals", "Has manuals", "manual_count"],
];
const NO_FILTERS = { assignee: "", priority: "", attach: "", docType: "" };
/* The server classifies each link URL; these two kinds are the "Drive & Cloud" group. */
const isDrive = (l) => l?.kind === "Google Drive" || l?.kind === "Cloud Storage";
const selStyle = { border: 0, background: "none", outline: 0, font: "inherit", color: "inherit" };

function applyFilters(all, q, f) {
  let tasks = all;
  const query = q.trim().toLowerCase();
  if (query) tasks = tasks.filter((t) => `${t.external_ref || ""} ${t.name || ""} ${t.assignee || ""} ${t.priority || ""}`.toLowerCase().includes(query));
  if (f.assignee) tasks = tasks.filter((t) => t.assignee_id === Number(f.assignee));
  if (f.priority) tasks = tasks.filter((t) => t.priority === f.priority);
  if (f.attach === "yes") tasks = tasks.filter((t) => t.has_attachments === true);
  else if (f.attach === "no") tasks = tasks.filter((t) => t.has_attachments === false);
  if (f.docType) { const key = DOC_TYPES.find(([k]) => k === f.docType)?.[2]; if (key) tasks = tasks.filter((t) => (t[key] || 0) > 0); }
  return tasks;
}

/* Task documents: every task you're on with file counts; a row expands into
   the task's context and its grouped documents, files, links, repos and manuals. */
export default function Documents({ portal = false }) {
  const acts = useTaskActions?.() || null;
  const [q, setQ] = useState("");
  const [f, setF] = useState(NO_FILTERS);
  const [open, setOpen] = useState(null);
  /* Unfiltered on purpose: the server builds `assignees` from the tasks it
     returns, so filtering there would shrink the dropdown to one name. Odoo
     filters by assignee in the browser too. */
  const list = useResource(M.DOCS_PATH, {});
  const all = list.data?.tasks || [];
  const tasks = applyFilters(all, q, f);
  const assignees = list.data?.assignees || [];
  const active = !!q.trim() || Object.values(f).some(Boolean);
  const set = (k) => (e) => setF((cur) => ({ ...cur, [k]: e.target.value }));
  const clearAll = () => { setQ(""); setF(NO_FILTERS); };
  const chip = (label, onClear) => (
    <span className="lz" style={{ background: "var(--hover)", color: "var(--text)", display: "inline-flex", alignItems: "center", gap: 4 }}>
      {label}<button type="button" aria-label={`Remove ${label}`} onClick={onClear} style={{ border: 0, background: "none", padding: 0, cursor: "pointer", color: "inherit", display: "inline-flex" }}><Icon n="x" size={12} /></button>
    </span>
  );

  return (
    <>
      <PageHeader crumbs={[{ label: portal ? "Portal" : "Your work" }, { label: "Documents" }]} title="Task documents"
        meta={list.data ? `Showing ${tasks.length} of ${all.length} tasks` : undefined}>
        <label className="search" style={{ margin: 0, width: 240 }}><Icon n="search" size={16} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, assignee or priority" aria-label="Search" style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: "100%" }} /></label>
      </PageHeader>
      <div className="page">
        {list.error && !list.data && <ErrorState error={list.error} onRetry={list.refresh} />}
        <div className="cardbox" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <Icon n="filter" size={16} />
          {assignees.length > 0 && (
            <span className="input" style={{ height: 32 }}><Select aria-label="Assignee" value={f.assignee} onChange={set("assignee")} style={selStyle}><option value="">All assignees</option>{assignees.map((a) => <option key={a.id} value={String(a.id)}>{a.name}</option>)}</Select></span>
          )}
          <span className="input" style={{ height: 32 }}><Select aria-label="Priority" value={f.priority} onChange={set("priority")} style={selStyle}><option value="">All priorities</option>{PRIORITIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></span>
          <span className="input" style={{ height: 32 }}><Select aria-label="Attachments" value={f.attach} onChange={set("attach")} style={selStyle}><option value="">All tasks</option>{ATTACH.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></span>
          <span className="input" style={{ height: 32 }}><Select aria-label="Document type" value={f.docType} onChange={set("docType")} style={selStyle}><option value="">All document types</option>{DOC_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></span>
          <span style={{ flex: 1 }} />
          {active ? (
            <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <span className="mini">Active:</span>
              {q.trim() && chip(`"${q.trim()}"`, () => setQ(""))}
              {f.assignee && chip(assignees.find((a) => String(a.id) === f.assignee)?.name || "Assignee", () => setF({ ...f, assignee: "" }))}
              {f.priority && chip(PRIORITIES.find(([k]) => k === f.priority)?.[1], () => setF({ ...f, priority: "" }))}
              {f.attach && chip(ATTACH.find(([k]) => k === f.attach)?.[1], () => setF({ ...f, attach: "" }))}
              {f.docType && chip(DOC_TYPES.find(([k]) => k === f.docType)?.[1], () => setF({ ...f, docType: "" }))}
              <Button size="sm" kind="ghost" icon="x" onClick={clearAll}>Clear all</Button>
            </span>
          ) : <span className="mini" style={{ fontStyle: "italic" }}>No filters applied</span>}
        </div>
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {!list.data && !list.error ? <div style={{ padding: 16 }}><Skeleton rows={5} /></div> : (
            <table className="table">
              <thead><tr><th style={{ width: 28 }}></th><th>Task</th><th>Assignee</th><th className="num">Files</th><th className="num">Links</th><th className="num">Drive</th><th className="num">GitHub</th><th className="num">Manuals</th><th className="num">Task docs</th></tr></thead>
              <tbody>
                {tasks.map((t) => (
                  <Row key={t.id} t={t} open={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} onOpenTask={acts ? () => acts.openTask(t.id) : null} />
                ))}
                {!tasks.length && (
                  <tr><td colSpan={9} className="empty">
                    {all.length ? <>No tasks match your filters. {active && <Button size="sm" onClick={clearAll}>Clear all filters</Button>}</> : "No tasks with documents."}
                  </td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

const fmtDate = (s) => (s ? String(s).replace(/:\d{2}$/, "") : "");
const by = (who, when) => [who, fmtDate(when)].filter(Boolean).join(" · ");

/* One document line: name + who/when, with View / Download where Odoo offers them. */
function DocLine({ icon = "doc", badge, title, sub, note, viewUrl, downloadUrl, external }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "7px 0", borderTop: "1px solid var(--border)" }}>
      <Icon n={icon} size={15} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, wordBreak: "break-word" }}>{badge && <Lozenge tone="progress" style={{ marginRight: 6 }}>{badge}</Lozenge>}{title}</div>
        {note && <div className="mini" style={{ whiteSpace: "pre-wrap" }}>{note}</div>}
        {sub && <div className="mini">{sub}</div>}
      </div>
      <span style={{ display: "inline-flex", gap: 6, flex: "none" }}>
        {external && viewUrl && <CopyLink url={viewUrl} />}
        {viewUrl && <a className="btn" style={{ height: 26, fontSize: 12 }} href={viewUrl} target="_blank" rel="noreferrer"><Icon n={external ? "link" : "eye"} size={14} />{external ? "Open" : "View"}</a>}
        {downloadUrl && <a className="btn" style={{ height: 26, fontSize: 12 }} href={downloadUrl}><Icon n="download" size={14} />Download</a>}
      </span>
    </div>
  );
}
function Group({ title, icon, count, children }) {
  if (!count) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <p className="mini" style={{ margin: "0 0 2px", fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}><Icon n={icon} size={14} />{title} ({count})</p>
      {children}
    </div>
  );
}

function Row({ t, open, onToggle, onOpenTask }) {
  const [d, setD] = useState(null);
  const toggle = () => { onToggle(); if (!d) M.fetchTaskDocumentDetails(t.id).then((r) => setD(r || { status: false })).catch((e) => setD({ status: false, message: e.message })); };
  const docs = d?.documents || {};
  const task = d?.task || {};
  const links = docs.links || [];
  const drive = links.filter(isDrive);
  const other = links.filter((l) => !isDrive(l));
  const total = (docs.files?.length || 0) + links.length + (docs.github?.length || 0) + (docs.manuals?.length || 0) + (docs.task_docs?.length || 0);
  const pri = t.priority || "regular";
  return (
    <>
      <tr className={open ? "sel" : ""} style={{ cursor: "pointer" }} onClick={toggle}>
        <td><Icon n={open ? "chev" : "cright"} size={14} /></td>
        <td>
          <span className="ref">{t.external_ref || `#${t.id}`}</span> <b>{t.name}</b>
          {" "}<Lozenge tone={PRI_TONE[pri] || "neutral"}>{PRIORITIES.find(([k]) => k === pri)?.[1] || pri}</Lozenge>
          {!t.has_attachments && <> <Lozenge tone="danger">No attachments</Lozenge></>}
          {onOpenTask && <button className="btn" style={{ height: 24, fontSize: 11.5, marginLeft: 8 }} onClick={(e) => { e.stopPropagation(); onOpenTask(); }}>Open task</button>}
        </td>
        <td>{t.assignee_id ? <><Avatar name={t.assignee} id={t.assignee_id} size={22} /> {t.assignee}</> : (t.assignee || "Unassigned")}</td>
        <td className="num">{t.doc_count || 0}</td><td className="num">{t.link_count || 0}</td><td className="num">{t.drive_count || 0}</td><td className="num">{t.github_count || 0}</td><td className="num">{t.manual_count || 0}</td><td className="num">{t.task_doc_count || 0}</td>
      </tr>
      {open && (
        <tr><td colSpan={9} style={{ background: "var(--hover)", padding: "12px 14px", whiteSpace: "normal" }}>
          {!d ? <Skeleton rows={2} /> : d.status === false ? <span className="mini">{d.message || "Could not load documents."}</span> : (
            <>
              {/* Task context, as Odoo's detail header: ref, linked requirement, delivery version, description. */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 6 }}>
                {task.external_ref && <Lozenge tone="progress">{task.external_ref}</Lozenge>}
                {task.related_req_ref && <Lozenge tone="neutral">Linked to {task.related_req_ref}</Lozenge>}
                {task.delivery_version && <Lozenge tone="review">{task.delivery_version}</Lozenge>}
                <span className="mini">Assignee: {t.assignee || "Unassigned"} · Priority: {pri}</span>
              </div>
              {task.description && <p className="mini" style={{ margin: "0 0 10px", whiteSpace: "pre-wrap" }}>{task.description}</p>}
              {!total ? <span className="mini">No documents found for this task yet.</span> : (
                <>
                  <Group title="Task documents" icon="paperclip" count={docs.task_docs?.length}>
                    {docs.task_docs.map((x, i) => <DocLine key={`t${i}`} badge={x.kind} title={x.file_name || "document"} note={x.note} downloadUrl={href(x.download_url)} />)}
                  </Group>
                  <Group title="Attached files" icon="doc" count={docs.files?.length}>
                    {docs.files.map((x) => <DocLine key={x.id} title={x.file_name || "file"} sub={by(x.uploaded_by, x.upload_date)} viewUrl={x.view_url ? href(x.view_url) : null} downloadUrl={x.download_url ? href(x.download_url) : null} />)}
                  </Group>
                  <Group title="Drive & Cloud" icon="upload" count={drive.length}>
                    {drive.map((l, i) => <DocLine key={`d${i}`} icon="link" badge={l.kind} title={l.url} sub={by(l.added_by, l.added_date)} viewUrl={l.url} external />)}
                  </Group>
                  <Group title="Other links" icon="link" count={other.length}>
                    {other.map((l, i) => <DocLine key={`o${i}`} icon="link" title={l.url || String(l)} sub={[l.kind && l.kind !== "Other" ? l.kind : "", by(l.added_by, l.added_date)].filter(Boolean).join(" · ")} viewUrl={l.url || String(l)} external />)}
                  </Group>
                  <Group title="GitHub repositories" icon="swap" count={docs.github?.length}>
                    {docs.github.map((g) => <DocLine key={g.id} icon="link" title={g.github_url} note={g.branch_name ? `Branch: ${g.branch_name}` : ""} sub={by(g.uploaded_by, g.upload_date)} viewUrl={g.github_url} external />)}
                  </Group>
                  <Group title="User manuals" icon="book" count={docs.manuals?.length}>
                    {docs.manuals.map((m) => <DocLine key={m.id} icon="book" title={m.file_name || "manual"} note={m.description} sub={by(m.uploaded_by, m.upload_date)} viewUrl={href(m.view_url || `/kpi/manual/view/${m.id}`)} downloadUrl={href(m.download_url || `/kpi/manual/download/${m.id}`)} />)}
                  </Group>
                </>
              )}
            </>
          )}
        </td></tr>
      )}
    </>
  );
}
