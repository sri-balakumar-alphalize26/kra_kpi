"use client";
import { useEffect, useState } from "react";
import { Avatar, Button, Icon, Lozenge, Modal, PageHeader, Skeleton, stateTone, useFlags } from "@/components/ui";
import * as R from "@/lib/services/reports";
import ReportsNav from "./ReportsNav";
import ReportFilters from "./ReportFilters";
import { loadPdf } from "./exportLibs";

/* KRA Employee report (port of the OWL kpi_employee_report): per employee —
   task counts, estimated vs actual, ahead/behind — with each task's daily work
   breakdown. The PDF is built from /employee/pdf_data and downloaded as a file. */
const perf = (p) => (!p || p.status === "neutral" ? "N/A" : `${p.is_positive ? "+" : "-"}${p.display}`);

export default function EmployeeReport() {
  const flags = useFlags();
  const [emps, setEmps] = useState([]);
  const [f, setF] = useState(() => { const r = R.presetRange("today"); return { from: r[0], to: r[1], employeeId: "", timeFrame: "today" }; });
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [openEmp, setOpenEmp] = useState(() => new Set());
  const [task, setTask] = useState(null); /* {row, detail} */
  useEffect(() => { R.fetchEmployeeReportEmployees().then(setEmps).catch(() => {}); }, []);

  const generate = async () => {
    setBusy(true);
    try {
      const r = R.assertOk(await R.generateEmployeeReport(f), "Could not build the report.");
      const data = r.data || [];
      setRows(data); setOpenEmp(new Set(data.length === 1 ? [data[0].employee_id] : []));
    } catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  const toggle = (id) => setOpenEmp((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const openTask = async (t) => {
    setTask({ row: t, detail: null });
    try { const r = R.assertOk(await R.fetchEmployeeTaskDetails({ taskId: t.id, from: f.from, to: f.to }), "Could not load the task."); setTask({ row: t, detail: r }); }
    catch (e) { setTask({ row: t, detail: { error: e.message } }); }
  };
  const pdf = async () => {
    setPdfBusy(true);
    try { const r = R.assertOk(await R.employeeReportPdfData(f), "Could not build the PDF."); await savePdf(r.pdf_data || {}); }
    catch (e) { flags.err(e.message); } finally { setPdfBusy(false); }
  };

  const list = rows || [];
  const totalTasks = list.reduce((s, e) => s + (e.total_tasks || 0), 0);
  const est = list.reduce((s, e) => s + (e.total_estimated_hours || 0), 0);
  const act = list.reduce((s, e) => s + (e.total_actual_hours || 0), 0);

  return (
    <>
      <PageHeader crumbs={[{ label: "Reports" }, { label: "Employee report" }]} title="Employee report">
        <Button icon="download" busy={pdfBusy} onClick={pdf} disabled={!list.length}>PDF</Button>
      </PageHeader>
      <div className="page">
        <ReportsNav />
        <ReportFilters value={f} onChange={setF} employees={emps} onGenerate={generate} busy={busy} frames={["today", "yesterday", "last_week", "last_month", "last_year"]} />
        {rows && (
          <div className="stats">
            <div className="stat"><small>Employees</small><b>{list.length}</b></div>
            <div className="stat"><small>Tasks</small><b>{totalTasks}</b></div>
            <div className="stat"><small>Estimated</small><b>{R.hmFromHours(est)}</b></div>
            <div className="stat"><small>Actual</small><b>{R.hmFromHours(act)}</b></div>
          </div>
        )}
        {!rows && !busy && <div className="cardbox"><div className="empty">Set the filters and press Generate report.</div></div>}
        {busy && !rows && <div className="cardbox"><Skeleton rows={6} /></div>}
        {rows && !list.length && <div className="cardbox"><div className="empty">No tasks for these filters.</div></div>}
        {list.map((e) => {
          const p = e.overall_performance || {};
          const isOpen = openEmp.has(e.employee_id);
          return (
            <div key={e.employee_id} className="cardbox" style={{ padding: 0 }}>
              <div style={{ padding: "12px 16px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", cursor: "pointer" }} onClick={() => toggle(e.employee_id)}>
                <Icon n={isOpen ? "chev" : "cright"} size={14} />
                <Avatar name={e.employee_name} uid={e.employee_id} size={30} />
                <span style={{ display: "flex", flexDirection: "column" }}><b style={{ color: "var(--navy)" }}>{e.employee_name}</b>{e.employee_email && <span className="mini">{e.employee_email}</span>}</span>
                <span className="pillset" style={{ marginLeft: "auto" }}>
                  <Lozenge tone="todo">{e.total_tasks} tasks</Lozenge><Lozenge tone="done">{e.completed_tasks} done</Lozenge><Lozenge tone="progress">{e.in_progress_tasks} in progress</Lozenge><Lozenge tone="neutral">{e.pending_tasks} pending</Lozenge>
                </span>
                <span className="mini">Est. <b>{e.total_estimated_hours_display}</b> · Actual <b>{e.total_actual_hours_display}</b> · <b style={{ color: p.status === "neutral" ? undefined : p.is_positive ? "var(--lz-done)" : "var(--over)" }}>{p.status === "neutral" ? "N/A" : `${p.is_positive ? "+" : "-"}${p.display} ${p.is_positive ? "ahead" : "behind"}`}</b></span>
              </div>
              {isOpen && (
                <div className="table-scroll">
                  <table className="table">
                    <thead><tr><th>#</th><th>Task</th><th>KRA</th><th>Assigned</th><th>Started</th><th className="num">Estimated</th><th className="num">Actual</th><th className="num">Performance</th><th>Status</th><th /></tr></thead>
                    <tbody>
                      {(e.tasks || []).map((t, i) => { const [tone] = stateTone(t.task_state); return (
                        <tr key={t.id}>
                          <td>{i + 1}</td><td><b>{t.name}</b></td><td className="mini">{t.parent_kra_name ? `${t.parent_kra_name} › ` : ""}{t.kra_name || "—"}</td>
                          <td className="mini">{t.assigned_date_display}</td><td className="mini">{t.started_date_display}</td>
                          <td className="num">{t.estimated_hours_display}</td><td className="num">{t.actual_hours_display}</td>
                          <td className="num" style={{ color: t.performance?.status === "neutral" ? undefined : t.performance?.is_positive ? "var(--lz-done)" : "var(--over)", fontWeight: 700 }}>{perf(t.performance)}</td>
                          <td><Lozenge tone={tone}>{t.task_state_display || t.task_state}</Lozenge></td>
                          <td><Button size="sm" onClick={() => openTask(t)}>Work log</Button></td>
                        </tr>
                      ); })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Modal open={!!task} onClose={() => setTask(null)} title={task ? task.row.name : ""} width={900} footer={<Button kind="ghost" onClick={() => setTask(null)}>Close</Button>}>
        {task && <TaskBody row={task.row} detail={task.detail} />}
      </Modal>
    </>
  );
}

function TaskBody({ row, detail }) {
  const d = detail?.task || {};
  const days = row.daily_progress || [];
  return (
    <>
      <div className="grid2" style={{ gap: 6 }}>
        {[["KRA", row.kra_name || "—"], ["Assigned", row.assigned_date_display], ["Started", row.started_date_display], ["Deadline", row.deadline_display], ["Estimated", row.estimated_hours_display], ["Actual", row.actual_hours_display], ["Performance", perf(row.performance)], ["Status", row.task_state_display],
          ...(d.completed_by ? [["Completed", `${d.completed_by} · ${d.completion_date}`]] : []), ...(d.approved_by ? [["Approved", `${d.approved_by} · ${d.approval_date}`]] : []), ...(d.paused_reason ? [["Paused because", d.paused_reason]] : [])]
          .map(([k, v]) => <div key={k} className="kv" style={{ padding: "4px 0" }}><span className="lbl" style={{ minWidth: 110 }}>{k}</span><span className="val">{v}</span></div>)}
      </div>
      {row.description && <p style={{ margin: 0, fontSize: 13.5, whiteSpace: "pre-wrap" }}>{row.description}</p>}
      <b style={{ color: "var(--navy)" }}>Daily work</b>
      {days.length ? (
        <table className="table">
          <thead><tr><th>Date</th><th>Day</th><th className="num">Hours</th><th style={{ width: "55%" }}>Progress</th></tr></thead>
          <tbody>{days.map((day) => <tr key={day.date}><td><b>{day.date_display}</b></td><td>{day.day_name}</td><td className="num"><b>{day.total_time_display}</b></td><td style={{ whiteSpace: "normal" }}>{(day.summaries || []).map((s) => <div key={s.id}><span className="mini">[{s.time}]</span> {s.summary}{s.has_attachment && <span className="mini"> · {s.file_name}</span>}</div>)}{!(day.summaries || []).length && <span className="mini">—</span>}</td></tr>)}</tbody>
        </table>
      ) : <span className="mini">No progress entries in this period.</span>}
      {!detail && <Skeleton rows={2} />}
      {detail?.error && <span className="mini" style={{ color: "var(--danger)" }}>{detail.error}</span>}
    </>
  );
}

/* The PDF, laid out exactly as the Odoo screen's generatePDFDocument does it
   (task table + daily work breakdown per employee), saved as a file. */
async function savePdf(data) {
  const { make } = await loadPdf();
  const doc = make("p", "mm", "a4");
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  const m = 15;
  const cw = pw - 2 * m;
  let y = m;
  const checkPage = (sp = 25) => { if (y > ph - sp) { doc.addPage(); y = m; return true; } return false; };
  const cut = (s, n) => { const t = String(s || ""); return t.length > n ? t.substring(0, n) + "..." : t; };

  doc.setFontSize(22); doc.setFont("helvetica", "bold"); doc.setTextColor(44, 62, 80);
  doc.text("KRA Employee Report", pw / 2, y, { align: "center" });
  y += 12;
  doc.setDrawColor(44, 62, 80); doc.setLineWidth(0.5); doc.line(m, y, pw - m, y);
  y += 8;
  doc.setFontSize(10); doc.setTextColor(0, 0, 0);
  doc.setFont("helvetica", "bold"); doc.text("From Date:", m, y);
  doc.setFont("helvetica", "normal"); doc.text(String(data.from_date || ""), m + 25, y);
  doc.setFont("helvetica", "bold"); doc.text("To Date:", pw / 2, y);
  doc.setFont("helvetica", "normal"); doc.text(String(data.to_date || ""), pw / 2 + 20, y);
  y += 6;
  doc.setFont("helvetica", "bold"); doc.text("Generated:", m, y);
  doc.setFont("helvetica", "normal"); doc.text(String(data.generated_on || ""), m + 25, y);
  y += 12;

  for (const emp of data.employees || []) {
    const tasks = emp.tasks || [];
    const perfO = emp.overall_performance || {};
    checkPage(60);
    doc.setFillColor(41, 128, 185); doc.roundedRect(m, y, cw, 12, 2, 2, "F");
    doc.setFontSize(12); doc.setFont("helvetica", "bold"); doc.setTextColor(255, 255, 255);
    doc.text(String(emp.employee_name || ""), m + 5, y + 8);
    y += 16;
    doc.setFillColor(236, 240, 241); doc.roundedRect(m, y, cw, 10, 2, 2, "F");
    doc.setFontSize(9); doc.setFont("helvetica", "bold"); doc.setTextColor(44, 62, 80);
    const col = cw / 4;
    doc.text("Total Tasks: " + emp.total_tasks, m + 5, y + 7);
    doc.text("Estimated: " + (emp.total_estimated_hours_display || ""), m + col, y + 7);
    doc.text("Actual: " + (emp.total_actual_hours_display || ""), m + col * 2, y + 7);
    if (perfO.is_positive) { doc.setTextColor(39, 174, 96); doc.text("Performance: +" + perfO.display + " ahead", m + col * 3, y + 7); }
    else { doc.setTextColor(231, 76, 60); doc.text("Performance: -" + (perfO.display || "") + " behind", m + col * 3, y + 7); }
    y += 14;

    doc.setTextColor(0, 0, 0); doc.setFont("helvetica", "bold"); doc.setFontSize(10);
    doc.text("Task Details:", m, y + 4);
    y += 8;
    doc.setFillColor(52, 73, 94); doc.rect(m, y, cw, 8, "F");
    doc.setFontSize(8); doc.setTextColor(255, 255, 255);
    const taskCols = [35, 25, 25, 22, 22, 25, 26];
    let tx = m + 2;
    ["Task Name", "Assigned", "Started", "Estimated", "Actual", "Performance", "Status"].forEach((h, i) => { doc.text(h, tx, y + 5.5); tx += taskCols[i]; });
    y += 10;
    doc.setTextColor(0, 0, 0); doc.setFont("helvetica", "normal");
    tasks.forEach((task, idx) => {
      checkPage(12);
      if (idx % 2 === 0) { doc.setFillColor(249, 249, 249); doc.rect(m, y, cw, 8, "F"); }
      tx = m + 2; doc.setFontSize(8);
      doc.text(cut(task.name, 18), tx, y + 5.5); tx += taskCols[0];
      doc.text(task.assigned_date_display || "-", tx, y + 5.5); tx += taskCols[1];
      doc.text(task.started_date_display || "-", tx, y + 5.5); tx += taskCols[2];
      doc.text(String(task.estimated_hours_display || ""), tx, y + 5.5); tx += taskCols[3];
      doc.text(String(task.actual_hours_display || ""), tx, y + 5.5); tx += taskCols[4];
      const p = task.performance || {};
      if (p.is_positive) { doc.setTextColor(39, 174, 96); doc.text("+" + p.display, tx, y + 5.5); }
      else if (p.status === "neutral") { doc.setTextColor(127, 140, 141); doc.text("N/A", tx, y + 5.5); }
      else { doc.setTextColor(231, 76, 60); doc.text("-" + (p.display || ""), tx, y + 5.5); }
      doc.setTextColor(0, 0, 0); tx += taskCols[5];
      doc.text(String(task.task_state_display || ""), tx, y + 5.5);
      y += 8;
    });
    doc.setDrawColor(200, 200, 200);
    doc.rect(m, y - 8 * tasks.length - 10, cw, 8 * tasks.length + 10, "S");
    y += 6;

    checkPage(30);
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(0, 0, 0);
    doc.text("Daily Work Breakdown:", m, y + 4);
    y += 8;
    const entries = [];
    tasks.forEach((task) => (task.daily_progress || []).forEach((day) => {
      (day.summaries || []).forEach((e) => entries.push({ date: day.date, date_display: day.date_display, day_name: day.day_name, task_name: task.name, hours: day.total_time_display, summary: e.summary || "" }));
      if (!(day.summaries || []).length && day.total_time_seconds > 0) entries.push({ date: day.date, date_display: day.date_display, day_name: day.day_name, task_name: task.name, hours: day.total_time_display, summary: "" });
    }));
    entries.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (entries.length) {
      doc.setFillColor(52, 73, 94); doc.rect(m, y, cw, 8, "F");
      doc.setFontSize(8); doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold");
      const dailyCols = [25, 22, 35, 22, cw - 104];
      let dx = m + 2;
      ["Date", "Day", "Task Name", "Hours", "Progress Summary"].forEach((h, i) => { doc.text(h, dx, y + 5.5); dx += dailyCols[i]; });
      y += 10;
      doc.setTextColor(0, 0, 0); doc.setFont("helvetica", "normal");
      entries.forEach((e, idx) => {
        checkPage(12);
        if (idx % 2 === 0) { doc.setFillColor(249, 249, 249); doc.rect(m, y, cw, 8, "F"); }
        dx = m + 2; doc.setFontSize(8);
        doc.setTextColor(41, 128, 185); doc.setFont("helvetica", "bold"); doc.text(String(e.date_display || ""), dx, y + 5.5); dx += dailyCols[0];
        doc.setTextColor(0, 0, 0); doc.setFont("helvetica", "normal"); doc.text(String(e.day_name || ""), dx, y + 5.5); dx += dailyCols[1];
        doc.text(cut(e.task_name, 18), dx, y + 5.5); dx += dailyCols[2];
        doc.setTextColor(39, 174, 96); doc.setFont("helvetica", "bold"); doc.text(String(e.hours || ""), dx, y + 5.5); dx += dailyCols[3];
        doc.setTextColor(60, 60, 60); doc.setFont("helvetica", "normal"); doc.text(cut(e.summary, 50), dx, y + 5.5);
        y += 8;
      });
    } else {
      doc.setFontSize(9); doc.setTextColor(127, 140, 141); doc.setFont("helvetica", "italic");
      doc.text("No daily breakdown available for this period", m + 5, y + 4);
      y += 8;
    }
    y += 10;
  }

  doc.setFontSize(8); doc.setTextColor(150, 150, 150); doc.setFont("helvetica", "italic");
  doc.text("Generated by KRA/KPI Management System", pw / 2, ph - 10, { align: "center" });
  doc.save(`KRA_Employee_Report_${data.from_date}_to_${data.to_date}.pdf`);
}
