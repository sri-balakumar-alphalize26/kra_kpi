"use client";
import { useMemo, useState } from "react";
import { ErrorState, Icon, Lozenge, PageHeader, Skeleton, Tabs } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import * as M from "@/lib/services/more";
import { localDay } from "@/lib/services/kpiActions";

/* My workday: one row per day (in/out, presence, productive, paused, tasks),
   expanding into the tasks worked. Data: /kpi_reports/my_workday, which gives
   per day: date, presence_display, productive_display, paused_seconds/_display,
   session_count, task_count, tasks[{ref,name,hours_display}] and — on newer
   modules — presence / productive (seconds) and started_at / ended_at (HH:MM,
   user tz). Older modules lack those, so every read of them falls back. */
const ymd = (d) => localDay(d.getTime()); /* the user's calendar day, not UTC's */
const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
function range(key) {
  const now = new Date(), day = now.getDay() || 7;
  const mon = new Date(now); mon.setDate(now.getDate() - day + 1);
  if (key === "week") return [ymd(mon), ymd(now)];
  if (key === "lastweek") { const a = new Date(mon); a.setDate(mon.getDate() - 7); const b = new Date(mon); b.setDate(mon.getDate() - 1); return [ymd(a), ymd(b)]; }
  if (key === "month") return [ymd(new Date(now.getFullYear(), now.getMonth(), 1)), ymd(now)];
  return [ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), ymd(new Date(now.getFullYear(), now.getMonth(), 0))];
}

export default function MyWorkday() {
  const [period, setPeriod] = useState("week");
  const [custom, setCustom] = useState(null);
  const [open, setOpen] = useState(null);
  const [from, to] = custom || range(period);
  const rep = useResource(M.WORKDAY_REPORT_PATH, { from_date: from, to_date: to }, { ttl: 30000 });
  const days = rep.data?.days || [];
  const totals = useMemo(() => days.reduce((a, d) => {
    const prod = num(d.productive);
    return {
      present: a.present + ((d.session_count || 0) > 0 || d.started_at || (num(d.presence) || 0) > 0 ? 1 : 0),
      prod: a.prod + (prod || 0),
      hasProd: a.hasProd || prod != null,
      paused: a.paused + (num(d.paused_seconds) || 0),
      tasks: a.tasks + (d.task_count || 0),
    };
  }, { present: 0, prod: 0, hasProd: false, paused: 0, tasks: 0 }), [days]);
  const hm = (s) => { const h = Math.floor((s || 0) / 3600), m = Math.floor(((s || 0) % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };

  return (
    <>
      <PageHeader crumbs={[{ label: "Your work" }, { label: "My workday" }]} title="My workday">
        <Tabs items={[{ key: "week", label: "This week" }, { key: "lastweek", label: "Last week" }, { key: "month", label: "This month" }, { key: "lastmonth", label: "Last month" }]} value={custom ? "" : period} onChange={(k) => { setCustom(null); setPeriod(k); }} />
        <span className="input" style={{ height: 32 }}><Icon n="cal" size={16} /><input type="date" value={from} max={to} onChange={(e) => setCustom([e.target.value, to])} style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: 130 }} /><span className="mini">to</span><input type="date" value={to} min={from} onChange={(e) => setCustom([from, e.target.value])} style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: 130 }} /></span>
      </PageHeader>
      <div className="page">
        <div className="stats">
          <div className="stat"><small>Days present</small><b>{rep.data ? totals.present : "…"}</b><span>of {days.length} day{days.length === 1 ? "" : "s"} with activity</span></div>
          <div className="stat"><small>Productive time</small><b>{rep.data ? (totals.hasProd || !days.length ? hm(totals.prod) : "—") : "…"}</b><span>{totals.hasProd && totals.present ? `avg ${hm(totals.prod / totals.present)} per day` : ""}</span></div>
          <div className="stat"><small>Paused</small><b>{rep.data ? hm(totals.paused) : "…"}</b><span>breaks, lunch, meetings</span></div>
          <div className="stat"><small>Tasks worked</small><b>{rep.data ? totals.tasks : "…"}</b><span>task-days</span></div>
        </div>
        {rep.error && !rep.data && <ErrorState error={rep.error} onRetry={rep.refresh} />}
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {!rep.data && !rep.error ? <div style={{ padding: 16 }}><Skeleton rows={5} /></div> : (
            <table className="table">
              <thead><tr><th style={{ width: 28 }}></th><th>Day</th><th>In</th><th>Out</th><th className="num">Presence</th><th className="num">Productive</th><th className="num">Paused</th><th className="num">Tasks</th></tr></thead>
              <tbody>
                {days.map((d) => <Row key={d.date} d={d} hm={hm} open={open === d.date} onToggle={() => setOpen(open === d.date ? null : d.date)} />)}
                {!days.length && <tr><td colSpan={8} className="empty">No workdays in this range.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function Row({ d, hm, open, onToggle }) {
  const label = new Date(d.date + "T00:00:00").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  const isToday = d.date === localDay(Date.now());
  const absent = !(d.session_count > 0) && !d.started_at;
  return (
    <>
      <tr className={open ? "sel" : ""} style={{ cursor: "pointer" }} onClick={onToggle}>
        <td><Icon n={open ? "chev" : "cright"} size={14} /></td>
        <td><b>{label}</b> {isToday && <Lozenge tone="done">Today</Lozenge>}{absent && <Lozenge tone="todo">No workday</Lozenge>}</td>
        <td>{d.started_at || "—"}</td><td>{d.ended_at || (isToday && d.started_at ? "Still on" : "—")}</td>
        <td className="num">{d.presence_display || hm(num(d.presence))}</td><td className="num">{d.productive_display || hm(num(d.productive))}</td><td className="num">{d.paused_display || hm(num(d.paused_seconds))}</td><td className="num">{d.task_count ?? (d.tasks || []).length}</td>
      </tr>
      {open && (
        <tr><td colSpan={8} style={{ background: "var(--hover)", padding: "10px 14px" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(d.tasks || []).map((t, i) => <span key={i} className="chip-sm" style={{ background: "var(--surface)", color: "var(--navy)" }}><span className="ref">{t.ref || ""}</span>{t.name} · {t.hours_display || "0h"}</span>)}
            {!(d.tasks || []).length && <span className="mini">No tasks logged this day.</span>}
          </div>
        </td></tr>
      )}
    </>
  );
}
