"use client";
import { useState } from "react";
import { Avatar, ErrorState, Icon, IconButton, Lozenge, PageHeader, Skeleton, Tabs } from "@/components/ui";
import { useMe } from "@/lib/me";
import { useResource } from "@/lib/useFetch";
import PeopleNav from "./PeopleNav";

/* Attendance lives in a separate bridge module (kra_kpi_attendance_bridge,
   controllers/kra_attendance_api.py). When it is not installed the route is
   unknown (404) and the page says so instead of failing. Its answers:
     /mine  {status, enabled, has_employee, message?, today, week, month, days:[row]}
     /team  {status, date, label, counts, rows:[row + user_id, name], not_in_hr:[{user_id,name}]}
     status:false → {message} (switched off in Configuration, or not authorized)
   A row carries check_in_office_time / check_out_office_time (office clock),
   worked_display, status + status_label (+ status_display, the long form). */
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const TONE = { present: "done", late: "paused", half_day: "paused", absent: "danger", leave: "review", day_off: "todo", not_checked_in: "todo", none: "todo", upcoming: "todo" };

export default function Attendance() {
  const { me } = useMe();
  const admin = me.role === "admin";
  const [tab, setTab] = useState(admin ? "team" : "me");
  const [date, setDate] = useState(() => ymd(new Date()));
  const mine = useResource("/kpi_attendance/mine", { days: 31 }, { enabled: tab === "me", ttl: 60000 });
  const team = useResource("/kpi_attendance/team", { date }, { enabled: tab === "team", ttl: 30000 });
  const src = tab === "me" ? mine : team;
  const d = src.data;
  const notInstalled = src.error?.status === 404;
  /* status:false is a real answer with a reason (attendance switched off, not authorized). */
  const refused = d?.status === false ? (d.message || d.error || "Attendance is not available.") : "";
  const noEmployee = tab === "me" && d?.status !== false && d?.has_employee === false;
  const ready = d && !refused && !noEmployee;
  const rows = (tab === "me" ? d?.days : d?.rows) || [];
  const notInHr = tab === "team" ? d?.not_in_hr || [] : [];
  const shift = (n) => { const x = new Date(date + "T00:00:00"); x.setDate(x.getDate() + n); setDate(ymd(x)); };

  return (
    <>
      <PageHeader crumbs={[{ label: "People" }, { label: "Attendance" }]} title="Attendance">
        {admin && <Tabs items={[{ key: "me", label: "Me" }, { key: "team", label: "Team" }]} value={tab} onChange={setTab} />}
        {tab === "team" && <span className="input" style={{ height: 32 }}><IconButton icon="cleft" label="Previous day" size={14} onClick={() => shift(-1)} />{new Date(date + "T00:00:00").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" })}<IconButton icon="cright" label="Next day" size={14} onClick={() => shift(1)} /></span>}
      </PageHeader>
      {admin && <PeopleNav />}
      <div className="page">
        {notInstalled && <div className="cardbox"><b style={{ color: "var(--navy)" }}>Attendance isn't enabled on this server</b><span className="mini">The attendance bridge module is not installed, so there is nothing to show here. Start Workday still marks presence on Live Tracking.</span></div>}
        {!notInstalled && src.error && !d && <ErrorState error={src.error} onRetry={src.refresh} />}
        {!notInstalled && !d && !src.error && <div className="cardbox"><Skeleton rows={5} /></div>}
        {refused && <div className="cardbox"><b style={{ color: "var(--navy)" }}>Attendance isn't available</b><span className="mini">{refused}</span></div>}
        {noEmployee && <div className="cardbox"><b style={{ color: "var(--navy)" }}>No employee record</b><span className="mini">{d.message || "Your login is not linked to an HR employee yet. Ask your admin to link it in Employees."}</span></div>}
        {ready && (
          <div className="cardbox table-scroll" style={{ padding: 0 }}>
            <table className="table">
              <thead><tr><th>{tab === "team" ? "Developer" : "Date"}</th><th>Check in</th><th>Check out</th><th>Status</th><th className="num">Worked</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.user_id || r.date || i}>
                    <td>{tab === "team" ? <><Avatar name={r.name} id={r.user_id} size={22} /> <b>{r.name}</b></> : <b>{r.label || r.date}</b>}</td>
                    <td>{r.check_in_office_time || "—"}{r.late_minutes_display && <span className="mini"> · {r.late_minutes_display} late</span>}</td>
                    <td>{r.check_out_office_time || (r.open ? <span className="mini">still in</span> : "—")}</td>
                    <td><span title={r.status_display || ""}><Lozenge tone={TONE[r.status] || "todo"}>{r.status_label || r.status || "—"}</Lozenge></span>{r.is_wfh && <span className="mini"> · WFH</span>}</td>
                    <td className="num">{r.worked_display || "—"}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={5} className="empty">No attendance records.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        {ready && notInHr.length > 0 && (
          <div className="callout"><Icon n="info" size={16} /><span>Not linked to an HR employee, so no attendance: {notInHr.map((u) => u.name).join(", ")}.</span></div>
        )}
      </div>
    </>
  );
}
