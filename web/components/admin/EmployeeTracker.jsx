"use client";
import { useEffect, useMemo, useState } from "react";
import { Avatar, ErrorState, Icon, Lozenge, PageHeader, Skeleton, Tabs, Select } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import * as A from "@/lib/services/admin";
import PeopleNav from "./PeopleNav";
import { fmtHM } from "@/lib/services/kpiActions";

/* Presence and productive time per employee per period — a viewer over
   /kpi_reports/developer_summary (never recomputed here). "All developers"
   (user_id null, Odoo's default) lists one row per person per period. */
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/* Session login_at / logout_at are naive UTC ("YYYY-MM-DD HH:MM:SS"); shown on this machine's clock. */
const utc = (s) => (s ? new Date(s.replace(" ", "T") + "Z") : null);
const clock = (s, withDay) => { const d = utc(s); if (!d || Number.isNaN(+d)) return ""; const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); return withDay ? `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${t}` : t; };
/* First login and last logout of a period, across its sessions. Out is empty while a session is still open. */
function span(p) {
  const ss = p.sessions || [];
  const ins = ss.map((x) => x.login_at).filter(Boolean).sort();
  const outs = ss.map((x) => x.logout_at).filter(Boolean).sort();
  const open = ss.some((x) => !x.logout_at);
  return { in: ins[0] || "", out: open ? "" : outs[outs.length - 1] || "", open, autoClosed: ss.filter((x) => x.auto_closed).length };
}
export default function EmployeeTracker() {
  const [employees, setEmployees] = useState([]);
  const [userId, setUserId] = useState(0); /* 0 = all developers */
  const [frame, setFrame] = useState("daily");
  const [from, setFrom] = useState(() => ymd(new Date(Date.now() - 13 * 86400000)));
  const [to, setTo] = useState(() => ymd(new Date()));
  const [open, setOpen] = useState(null);
  const [empErr, setEmpErr] = useState(null);
  useEffect(() => { A.fetchTrackerEmployees().then(setEmployees).catch((e) => setEmpErr(e)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const rep = useResource(A.SUMMARY_PATH, A.summaryParams({ timeFrame: frame, userId: userId || null, fromDate: from, toDate: to }), { ttl: 30000 });
  const periods = rep.data?.periods || [];
  const totals = useMemo(() => periods.reduce((a, p) => ({ presence: a.presence + (p.presence_seconds || 0), prod: a.prod + (p.productive_seconds || 0), paused: a.paused + (p.paused_seconds || 0), tasks: a.tasks + (p.task_count || 0), days: a.days + (new Set((p.sessions || []).map((x) => x.session_date)).size || (p.presence_seconds ? 1 : 0)) }), { presence: 0, prod: 0, paused: 0, tasks: 0, days: 0 }), [periods]);
  const who = employees.find((e) => e.id === userId);

  return (
    <>
      <PageHeader crumbs={[{ label: "People" }, { label: "Employee Tracker" }]} title="Employee Tracker">
        <span className="input" style={{ height: 32 }}>{who && <Avatar name={who.name} uid={who.id} size={20} />}<Select value={userId} onChange={(e) => setUserId(+e.target.value)} style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit" }}><option value={0}>All developers</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></span>
        <Tabs items={A.TIME_FRAMES} value={frame} onChange={setFrame} />
        <span className="input" style={{ height: 32 }}><Icon n="cal" size={16} /><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: 130 }} /><span className="mini">to</span><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: 130 }} /></span>
      </PageHeader>
      <PeopleNav />
      <div className="page">
        <div className="stats">
          <div className="stat"><small>Presence</small><b>{rep.data ? fmtHM(totals.presence) : "…"}</b><span>{totals.days} {frame === "daily" ? "days" : "periods"}</span></div>
          <div className="stat"><small>Productive</small><b>{rep.data ? fmtHM(totals.prod) : "…"}</b><span>{totals.presence ? `${Math.round((totals.prod / totals.presence) * 100)} % of presence` : ""}</span></div>
          <div className="stat"><small>Paused</small><b>{rep.data ? fmtHM(totals.paused) : "…"}</b><span>breaks, lunch, meetings</span></div>
          <div className="stat"><small>Tasks worked</small><b>{rep.data ? totals.tasks : "…"}</b><span>in range</span></div>
        </div>
        {empErr && !employees.length && <ErrorState error={empErr} title="Couldn't load the people list" />}
        {rep.error && !rep.data && <ErrorState error={rep.error} onRetry={rep.refresh} />}
        {rep.data?.status === false && <ErrorState error={{ message: rep.data.message || "Could not load the summary." }} onRetry={rep.refresh} />}
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {!rep.data && !rep.error ? <div style={{ padding: 16 }}><Skeleton rows={6} /></div> : rep.data?.status === false || !rep.data ? null : (
            <table className="table">
              <thead><tr><th style={{ width: 28 }}></th><th>{frame === "daily" ? "Day" : frame === "weekly" ? "Week" : "Month"}</th>{!userId && <th>Developer</th>}<th>In</th><th>Out</th><th className="num">Presence</th><th className="num">Productive</th><th className="num">Paused</th><th className="num">Tasks</th><th></th></tr></thead>
              <tbody>
                {periods.map((p, i) => {
                  const key = `${p.user_id || ""}|${p.period_key || p.label || i}`;
                  const isOpen = open === key;
                  return (
                    <PeriodRows key={key} p={p} all={!userId} multiDay={frame !== "daily"} isOpen={isOpen} onToggle={() => setOpen(isOpen ? null : key)} />
                  );
                })}
                {!periods.length && <tr><td colSpan={userId ? 9 : 10} className="empty">No sessions for this range.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function PeriodRows({ p, all, multiDay, isOpen, onToggle }) {
  const sp = span(p);
  return (
    <>
      <tr className={isOpen ? "sel" : ""} style={{ cursor: "pointer" }} onClick={onToggle}>
        <td><Icon n={isOpen ? "chev" : "cright"} size={14} /></td>
        <td><b>{p.label || p.period_key}</b>{sp.autoClosed > 0 && <> <Lozenge tone="paused">{multiDay && sp.autoClosed > 1 ? `${sp.autoClosed} auto-closed` : "Auto-closed"}</Lozenge></>}</td>
        {all && <td>{p.user_name ? <><Avatar name={p.user_name} uid={p.user_id} size={20} /> {p.user_name}</> : "—"}</td>}
        <td>{clock(sp.in, multiDay) || "—"}</td><td>{sp.open ? <span className="mini">still in</span> : clock(sp.out, multiDay) || "—"}</td>
        <td className="num">{fmtHM(p.presence_seconds)}</td><td className="num"><b>{fmtHM(p.productive_seconds)}</b></td><td className="num">{fmtHM(p.paused_seconds)}</td><td className="num">{p.task_count ?? (p.tasks || []).length}</td>
        <td><span className="prog" style={{ width: 90 }}><i style={{ width: `${p.presence_seconds ? Math.min(100, ((p.productive_seconds || 0) / p.presence_seconds) * 100) : 0}%` }} /></span></td>
      </tr>
      {isOpen && (
        <tr><td colSpan={all ? 10 : 9} style={{ background: "var(--hover)", padding: "10px 14px" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(p.tasks || []).map((t, i) => <span key={i} className="chip-sm" style={{ background: "var(--surface)", color: "var(--navy)" }}><span className="ref">{t.ref || ""}</span>{t.name} · {fmtHM(t.duration_seconds || t.seconds)}</span>)}
            {(p.sessions || []).length > 1 && <span className="mini">{p.sessions.length} sessions: {[...p.sessions].sort((a, b) => (a.login_at < b.login_at ? -1 : 1)).map((x) => `${clock(x.login_at, multiDay)}–${x.logout_at ? clock(x.logout_at, multiDay) : "now"}${x.auto_closed ? " (auto-closed)" : ""}`).join(" · ")}</span>}
            {!(p.tasks || []).length && <span className="mini">No tasks in this period.</span>}
          </div>
        </td></tr>
      )}
    </>
  );
}
