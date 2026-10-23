"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Avatar, Button, ErrorState, Field, Icon, IconButton, Input, Lozenge, PageHeader, Select, Skeleton, StaleBar } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import * as A from "@/lib/services/admin";
import { useTaskActions } from "@/components/task/TaskActions";
import PeopleNav from "./PeopleNav";

/* The per-task audit trail (kpi.action.log): start / pause / resume / complete,
   approvals, pre-approvals, notifications sent or failed. /kpi_owner/action_log,
   filtered by person and a date range (the server compares the event's UTC
   time, so a late-evening event can fall on the next UTC day). */
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const pretty = (ev) => (ev || "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const local = (e) => { const t = e.when_raw ? new Date(e.when_raw) : null; return t && !Number.isNaN(+t) ? t.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : e.when || "—"; };

export default function ActionLog() {
  const acts = useTaskActions();
  const sp = useSearchParams();
  const today = ymd(new Date());
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState(sp.get("user") || "");
  const [from, setFrom] = useState(sp.get("from") || today);
  const [to, setTo] = useState(sp.get("to") || today);
  const [limit, setLimit] = useState("500");
  const [q, setQ] = useState("");
  const [onlyFailed, setOnlyFailed] = useState(false);
  /* Odoo search filters: source channel (Web / WhatsApp / Cron / System) and Successful. */
  const [sources, setSources] = useState([]);
  const [onlyOk, setOnlyOk] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const [groupBy, setGroupBy] = useState(""); /* "" | event | source | task (Odoo list view group-bys) */
  useEffect(() => { A.getIntakeUsers().then(setUsers).catch(() => {}); }, []);

  const params = A.actionLogParams({ userId, kpiId: sp.get("task"), fromDate: from, toDate: to, limit: +limit });
  const log = useResource(A.ACTION_LOG_PATH, params, { ttl: 15000, deps: [] });
  const refused = log.data?.status === false;
  const entries = log.data?.entries || [];
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return entries.filter((e) => (!onlyFailed || !e.success) && (!onlyOk || e.success) && (!sources.length || sources.includes(e.source)) && (!s || [e.event, e.task_ref, e.task_name, e.actor, e.source_label].some((v) => (v || "").toLowerCase().includes(s))));
  }, [entries, q, onlyFailed, onlyOk, sources]);
  /* Groups keep the newest-first order of their first entry. */
  const groups = useMemo(() => {
    if (!groupBy) return [{ key: "", label: "", rows: shown }];
    const keyOf = (e) => (groupBy === "event" ? e.event || "" : groupBy === "source" ? e.source_label || "" : e.kpi_id ? String(e.kpi_id) : "");
    const labelOf = (e) => (groupBy === "event" ? pretty(e.event) || "No event" : groupBy === "source" ? e.source_label || "No source" : e.kpi_id ? `${e.task_ref || "#" + e.kpi_id} ${e.task_name || ""}`.trim() : "No task");
    const m = new Map();
    for (const e of shown) { const k = keyOf(e); if (!m.has(k)) m.set(k, { key: k, label: labelOf(e), rows: [] }); m.get(k).rows.push(e); }
    return [...m.values()];
  }, [shown, groupBy]);
  const toggle = (id) => setOpen((x) => { const n = new Set(x); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const preset = (days) => { const d = new Date(); d.setDate(d.getDate() - days); setFrom(ymd(d)); setTo(today); };
  const failed = entries.filter((e) => !e.success).length;

  return (
    <>
      <PageHeader crumbs={[{ label: "People" }, { label: "Action log" }]} title="Action log" meta="Every task action and notification, newest first">
        <Button icon="swap" kind="ghost" onClick={log.refresh} busy={log.loading && !!log.data}>Refresh</Button>
      </PageHeader>
      <PeopleNav />
      <div className="page">
        <div className="cardbox" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", gap: 12 }}>
          <Field label="Person"><span className="input" style={{ minWidth: 200 }}><Select value={userId} onChange={(e) => setUserId(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}><option value="">Everyone</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></span></Field>
          <Field label="From"><Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></Field>
          <span className="pillset" style={{ paddingBottom: 4 }}>
            <button type="button" className={`pill ${from === today && to === today ? "on" : ""}`} onClick={() => preset(0)}>Today</button>
            <button type="button" className="pill" onClick={() => preset(6)}>7 days</button>
            <button type="button" className="pill" onClick={() => preset(29)}>30 days</button>
          </span>
          <Field label="Show up to"><span className="input" style={{ width: 110 }}><Select value={limit} onChange={(e) => setLimit(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}><option value="200">200</option><option value="500">500</option><option value="2000">2000</option></Select></span></Field>
          <Field label="Search"><Input icon="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Event, task, person…" /></Field>
          <Field label="Group by"><span className="input" style={{ width: 130 }}><Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}><option value="">None</option><option value="event">Event</option><option value="source">Source</option><option value="task">Task</option></Select></span></Field>
          <span className="pillset" style={{ paddingBottom: 4 }}>
            {[["web", "Web"], ["whatsapp", "WhatsApp"], ["cron", "Cron"], ["system", "System"]].map(([k, l]) => {
              const on = sources.includes(k);
              return <button key={k} type="button" className={`pill ${on ? "on" : ""}`} aria-pressed={on} onClick={() => setSources((x) => (on ? x.filter((y) => y !== k) : [...x, k]))}>{l}</button>;
            })}
            <button type="button" className={`pill ${onlyOk ? "on" : ""}`} aria-pressed={onlyOk} onClick={() => { setOnlyOk((v) => !v); setOnlyFailed(false); }}>Successful</button>
          </span>
          <label className="mini" style={{ display: "inline-flex", alignItems: "center", gap: 6, paddingBottom: 8, cursor: "pointer" }}><input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} style={{ accentColor: "var(--brand)" }} />Failed only{failed ? ` (${failed})` : ""}</label>
          {sp.get("task") && <Lozenge tone="review" style={{ textTransform: "none", marginBottom: 8 }}>Task #{sp.get("task")} only</Lozenge>}
        </div>
        {refused && <ErrorState error={{ message: log.data.message }} onRetry={log.refresh} />}
        {log.error && !log.data && <ErrorState error={log.error} onRetry={log.refresh} />}
        {log.stale && <StaleBar error={log.error} onRetry={log.refresh} />}
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {!log.data && !log.error ? <div style={{ padding: 16 }}><Skeleton rows={8} /></div> : (
            <table className="table">
              <thead><tr><th style={{ width: 28 }}></th><th>When</th><th>Event</th><th>Task</th><th>By</th><th>Source</th><th>Result</th><th>Device IP</th></tr></thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={`g${g.key}`}>
                    {groupBy && <tr className="group"><td colSpan={8}>{g.label} · {g.rows.length} entr{g.rows.length === 1 ? "y" : "ies"}{g.rows.some((e) => !e.success) ? ` · ${g.rows.filter((e) => !e.success).length} failed` : ""}</td></tr>}
                    {g.rows.map((e) => {
                  const has = (e.payload && Object.keys(e.payload).length > 0) || !!e.user_agent || !!e.contact;
                  const isOpen = open.has(e.id);
                  return (
                    <Fragment key={e.id}>
                      <tr className={isOpen ? "sel" : ""}>
                        <td>{has && <IconButton icon={isOpen ? "chev" : "cright"} label={isOpen ? "Hide details" : "Show details"} size={14} onClick={() => toggle(e.id)} />}</td>
                        <td className="mini" title={e.when}>{local(e)}</td>
                        <td><b>{pretty(e.event)}</b></td>
                        <td style={{ whiteSpace: "normal", maxWidth: 320 }}>{e.kpi_id ? <><span className="ref">{e.task_ref}</span> <a href={`/board?task=${e.kpi_id}`} onClick={(ev) => { ev.preventDefault(); acts.openTask(e.kpi_id); }}>{e.task_name}</a></> : <span className="mini">—</span>}</td>
                        <td>{e.actor ? <>{e.actor_user_id && <Avatar name={e.actor} uid={e.actor_user_id} size={22} />} {e.actor}</> : <span className="mini">system</span>}</td>
                        <td className="mini">{e.source_label || "—"}</td>
                        <td>{e.success ? <Lozenge tone="done">OK</Lozenge> : <Lozenge tone="danger">Failed</Lozenge>}</td>
                        <td className="mini">{e.device_ip || "—"}</td>
                      </tr>
                      {isOpen && (
                        <tr className="sel"><td></td><td colSpan={7} style={{ whiteSpace: "normal" }}>
                          {(e.contact || e.user_agent) && <div className="mini" style={{ marginBottom: 6 }}>{e.contact && <>Contact: <b>{e.contact}</b>{e.user_agent ? " · " : ""}</>}{e.user_agent && <>User agent: {e.user_agent}</>}</div>}
                          <pre style={{ margin: 0, fontSize: 12, lineHeight: "17px", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--subtle)" }}>{JSON.stringify(e.payload, null, 2)}</pre>
                        </td></tr>
                      )}
                    </Fragment>
                  );
                })}
                  </Fragment>
                ))}
                {!shown.length && <tr><td colSpan={8} className="empty">{entries.length ? "Nothing matches the search." : "No actions logged in this range."}</td></tr>}
              </tbody>
            </table>
          )}
        </div>
        {log.data && !refused && <span className="mini"><Icon n="info" size={12} /> {entries.length} entr{entries.length === 1 ? "y" : "ies"}{entries.length >= +limit ? ` — the newest ${limit}; narrow the range to see older ones` : ""}.</span>}
      </div>
    </>
  );
}
