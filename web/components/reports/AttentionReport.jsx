"use client";
import { useEffect, useMemo, useState } from "react";
import { Avatar, Button, Icon, Lozenge, PageHeader, Skeleton, useFlags } from "@/components/ui";
import { useTaskActions } from "@/components/task/TaskActions";
import * as R from "@/lib/services/reports";
import ReportsNav from "./ReportsNav";
import ReportFilters from "./ReportFilters";

/* Attention report (port of the OWL kpi_attention_report): paused tasks that
   carry a reason — what needs a manager. Dates are optional and filter on the
   task's last change (the server's proxy for when it was paused). Runs on open. */
const PRI = { urgent: "danger", important: "paused", regular: "todo" };

export default function AttentionReport() {
  const flags = useFlags();
  const acts = useTaskActions();
  const [staff, setStaff] = useState([]);
  const [f, setF] = useState({ from: "", to: "", employeeId: "", timeFrame: "" });
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");

  const generate = async (filters = f) => {
    setBusy(true);
    try { const r = R.assertOk(await R.generateAttention(filters), "Could not build the report."); setRows(r.data || []); }
    catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  useEffect(() => { R.fetchStaff().then(setStaff).catch(() => {}); generate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => (rows || []).filter((r) => !q || `${r.name} ${r.employee_name} ${r.paused_reason} ${r.kra_name}`.toLowerCase().includes(q.toLowerCase())), [rows, q]);
  const people = new Set(shown.map((r) => r.employee_id)).size;
  /* Odoo tiles: the oldest pause in whole days, and pauses in the last 7 days. */
  /* paused_datetime is the server's UTC time without a zone mark. */
  const pausedAt = (r) => { const v = String(r.paused_datetime || "").replace(" ", "T"); if (!v) return null; const t = new Date(/Z|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`); return Number.isNaN(+t) ? null : t; };
  const oldestDays = shown.reduce((mx, r) => { const t = pausedAt(r); return t ? Math.max(mx, Math.floor((Date.now() - t) / 864e5)) : mx; }, 0);
  const recent = shown.filter((r) => { const t = pausedAt(r); return t && t >= Date.now() - 7 * 864e5; }).length;
  /* Odoo "Clear Filters": no dates, everyone, no time frame; then run again. */
  const clear = () => { const blank = { from: "", to: "", employeeId: "", timeFrame: "" }; setF(blank); setQ(""); generate(blank); };
  const exportCsv = () => R.downloadText(R.csv(shown, [{ key: "seq_no", label: "Seq" }, { key: "name", label: "Task" }, { key: "kra_name", label: "KRA" }, { key: "employee_name", label: "Employee" }, { key: "paused_date", label: "Date paused" }, { key: "paused_time", label: "Time paused" }, { key: "paused_reason", label: "Reason" }, { key: "priority", label: "Priority" }, { key: "deadline", label: "Deadline" }]), "Attention_report.csv");

  return (
    <>
      <PageHeader crumbs={[{ label: "Reports" }, { label: "Attention" }]} title="Attention report" meta="Paused tasks waiting on a decision">
        <label className="search" style={{ margin: 0, width: 220 }}><Icon n="search" size={16} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Task, person or reason" aria-label="Search" style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: "100%" }} /></label>
        <Button kind="ghost" icon="x" onClick={clear}>Clear Filters</Button>
        <Button icon="download" onClick={exportCsv} disabled={!shown.length}>CSV</Button>
      </PageHeader>
      <div className="page">
        <ReportsNav />
        <ReportFilters value={f} onChange={setF} employees={staff} onGenerate={() => generate()} busy={busy} allowEmptyDates frames={["today", "yesterday", "last_week", "last_month"]} />
        {rows && (
          <div className="stats">
            <div className="stat"><small>Paused tasks</small><b style={{ color: shown.length ? "var(--pri-important)" : undefined }}>{shown.length}</b><span>with a reason</span></div>
            <div className="stat"><small>People</small><b>{people}</b><span>affected</span></div>
            <div className="stat"><small>Urgent</small><b style={{ color: "var(--over)" }}>{shown.filter((r) => r.priority === "urgent").length}</b><span>paused</span></div>
            <div className="stat"><small>Oldest pause</small><b style={{ color: oldestDays ? "var(--danger)" : undefined }}>{oldestDays}</b><span>days ago</span></div>
            <div className="stat"><small>Recent pauses</small><b>{recent}</b><span>in last 7 days</span></div>
          </div>
        )}
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {!rows ? <div style={{ padding: 16 }}><Skeleton rows={6} /></div> : (
            <table className="table">
              <thead><tr><th>No</th><th>Seq</th><th>Task</th><th>Employee</th><th>Date paused</th><th>Time paused</th><th style={{ width: "28%" }}>Reason</th><th>Priority</th></tr></thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => acts.openTask(r.id)}>
                    <td>{i + 1}</td><td><span className="ref">#{r.seq_no}</span></td><td><b>{r.name}</b>{r.kra_name && <div className="mini">{r.kra_name}</div>}</td>
                    <td>{r.employee_id ? <><Avatar name={r.employee_name} uid={r.employee_id} size={22} /> {r.employee_name}</> : <span className="mini">{r.employee_name}</span>}</td>
                    <td>{r.paused_date || "—"}</td><td>{r.paused_time || "—"}</td><td style={{ whiteSpace: "normal" }}>{r.paused_reason}</td>
                    <td><Lozenge tone={PRI[r.priority] || "neutral"}>{r.priority}</Lozenge>{r.deadline && <div className="mini">due {r.deadline}</div>}</td>
                  </tr>
                ))}
                {!shown.length && <tr><td colSpan={8} className="empty">Nothing paused needs attention.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
        <p className="mini" style={{ margin: 0 }}>Times are the task&apos;s last change as Odoo stores it (UTC).</p>
      </div>
    </>
  );
}
