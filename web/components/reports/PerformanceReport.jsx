"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Avatar, Button, ErrorState, Field, Input, Lozenge, Modal, PageHeader, Select, Skeleton, Tabs, useDialogs, useFlags } from "@/components/ui";
import * as R from "@/lib/services/reports";
import ReportsNav from "./ReportsNav";
import ReportFilters from "./ReportFilters";
import { loadPdf } from "./exportLibs";

/* KPI Performance report (port of the OWL kpi_performance_report) plus the
   Employee Salary Master it reads (kpi.employee.salary.config). 1 unit = 0.01 h;
   deviation = estimated units − productivity units (positive = ahead). */
const n2 = (v) => Number(v || 0).toFixed(2);
const hm = R.hmFromHours;
const remarkTone = (r) => (/excellent/i.test(r) ? "done" : /low/i.test(r) ? "danger" : /not started/i.test(r) ? "progress" : "paused");
const devColor = (v) => (v > 0 ? "var(--lz-done)" : v < 0 ? "var(--over)" : undefined);
/* "90 mins (1.50hrs)", as the Odoo report and its PDF print hours. */
const minsHrs = (h) => (!h || h <= 0 ? "0 mins (0.00hrs)" : `${Math.round(h * 60)} mins (${Number(h).toFixed(2)}hrs)`);
const STATUS_LABEL = { completed: "Completed", in_progress: "In Progress", paused: "Paused", not_started: "Not Started", reassigned: "Reassigned" };
const countRemark = (rows, r) => rows.filter((x) => x.remarks === r).length;
const f2 = (v) => Number(v || 0).toFixed(2);
/* Row tint, as the Odoo table colours each remark. */
const rowBg = (r) => (r.remarks === "No Tasks Assigned" ? "var(--lz-paused-bg)" : r.remarks === "Not Started" ? "var(--lz-prog-bg)" : r.performance_deviation > 0 ? "var(--lz-done-bg)" : "var(--over-bg)");

/* The main report PDF (port of downloadMainReportPDF). */
async function mainReportPdf(rows, from, to) {
  const P = await loadPdf();
  const doc = P.make("l", "mm", "a4");
  doc.setFontSize(18); doc.setFont(undefined, "bold");
  doc.text("KPI Performance Report", 14, 15);
  doc.setFontSize(10); doc.setFont(undefined, "normal");
  doc.text(`Period: ${from} to ${to}`, 14, 23);
  doc.text(`Generated: ${new Date().toLocaleDateString()}`, 14, 28);
  const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const avg = (k) => (rows.length ? sum(k) / rows.length : 0);
  const data = rows.map((r, i) => [i + 1, r.employee_name, f2(r.salary), r.working_days, minsHrs(r.estimated_hours), f2(r.estimated_units), minsHrs(r.actual_hours), f2(r.productivity_units), f2(r.performance_deviation), f2(r.available_units), Number(r.unit_cost || 0).toFixed(4), f2(r.productivity_cost), f2(r.productivity_cost_pct) + "%", r.remarks]);
  data.push(["-", "Total / Average", f2(sum("salary")), sum("working_days"), minsHrs(sum("estimated_hours")), f2(sum("estimated_units")), minsHrs(sum("actual_hours")), f2(sum("productivity_units")), f2(avg("performance_deviation")), f2(sum("available_units")), avg("unit_cost").toFixed(4), f2(sum("productivity_cost")), f2(avg("productivity_cost_pct")) + "%", "-"]);
  doc.autoTable({
    head: [["S.No", "Employee Name", "Salary", "Working Days", "Est. Hrs", "Est. Units", "Actual Hrs", "Prod. Units", "Perf. Dev", "Avail. Units", "Unit Cost", "Prod. Cost", "Prod. Cost %", "Remarks"]],
    body: data, startY: 35,
    styles: { fontSize: 7, cellPadding: 1.5, overflow: "linebreak", cellWidth: "wrap" },
    headStyles: { fillColor: [66, 139, 202], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [245, 245, 245] },
    columnStyles: { 0: { cellWidth: 10 }, 1: { cellWidth: 25 }, 2: { cellWidth: 15 }, 3: { cellWidth: 15 }, 13: { cellWidth: 25 } },
    didParseCell: (d) => {
      const ri = d.row.index, ci = d.column.index;
      if (d.section !== "body") return;
      if (ri === rows.length) { d.cell.styles.fillColor = [236, 240, 241]; d.cell.styles.fontStyle = "bold"; return; }
      const row = rows[ri];
      if (ci === 13) {
        d.cell.styles.fontStyle = "bold";
        d.cell.styles.textColor = { "Excellent Performance": [40, 167, 69], "Low Performance": [220, 53, 69], "Not Started": [13, 110, 253], "No Tasks Assigned": [255, 193, 7] }[row.remarks] || d.cell.styles.textColor;
      }
      if (ci === 8) {
        if (row.remarks === "Not Started" || row.remarks === "No Tasks Assigned") { d.cell.styles.textColor = [13, 110, 253]; d.cell.styles.fontStyle = "bold"; }
        else if (row.performance_deviation > 0) { d.cell.styles.textColor = [40, 167, 69]; d.cell.styles.fontStyle = "bold"; }
        else if (row.performance_deviation < 0) { d.cell.styles.textColor = [220, 53, 69]; d.cell.styles.fontStyle = "bold"; }
      }
    },
  });
  const y = doc.lastAutoTable.finalY + 10;
  doc.setFontSize(12); doc.setFont(undefined, "bold"); doc.text("Summary Statistics", 14, y);
  doc.setFontSize(9); doc.setFont(undefined, "normal");
  doc.setTextColor(40, 167, 69); doc.text(`+ Excellent Performers: ${countRemark(rows, "Excellent Performance")} employees (Positive Deviation)`, 14, y + 7);
  doc.setTextColor(220, 53, 69); doc.text(`- Low Performers: ${countRemark(rows, "Low Performance")} employees (Negative Deviation)`, 14, y + 12);
  doc.setTextColor(13, 110, 253); doc.text(`o Not Started: ${countRemark(rows, "Not Started")} employees (Tasks Assigned)`, 14, y + 17);
  doc.setTextColor(255, 193, 7); doc.text(`o No Tasks Assigned: ${countRemark(rows, "No Tasks Assigned")} employees (Idle)`, 14, y + 22);
  doc.setTextColor(150, 150, 150); doc.setFontSize(8);
  doc.text("Generated by KRA/KPI Management System", 14, 200);
  doc.text("Page 1 of 1", 260, 200);
  doc.save(`KPI_Performance_Report_${from}_to_${to}.pdf`);
}

/* One employee's task breakdown (port of downloadEmployeeDetailPDF). */
async function employeeDetailPdf(name, tasks, from, to) {
  const P = await loadPdf();
  const doc = P.make("l", "mm", "a4");
  const tot = (k) => tasks.reduce((s, t) => s + (Number(t[k]) || 0), 0).toFixed(2);
  const pos = tasks.filter((t) => t.performance_deviation > 0).length;
  const neg = tasks.filter((t) => t.performance_deviation < 0).length;
  const zero = tasks.filter((t) => t.performance_deviation === 0).length;
  doc.setFontSize(16); doc.setFont(undefined, "bold");
  doc.text(`Individual Performance Report - ${name}`, 14, 15);
  doc.setFontSize(10); doc.setFont(undefined, "normal");
  doc.text(`Period: ${from} to ${to}`, 14, 23);
  doc.text(`Generated: ${new Date().toLocaleDateString()}`, 14, 28);
  const sy = 35;
  const box = (x, fill, label, value, dark) => {
    doc.setFillColor(...fill); doc.rect(x, sy, 50, 12, "F");
    doc.setTextColor(...(dark ? [0, 0, 0] : [255, 255, 255])); doc.setFont(undefined, "bold");
    doc.setFontSize(9); doc.text(label, x + 2, sy + 5);
    doc.setFontSize(14); doc.text(String(value), x + 2, sy + 10);
  };
  box(14, [13, 110, 253], "Total Tasks", tasks.length);
  box(68, [40, 167, 69], "Excellent", pos);
  box(122, [220, 53, 69], "Low Performance", neg);
  box(176, [255, 193, 7], "On Target", zero, true);
  doc.setTextColor(0, 0, 0); doc.setFontSize(11); doc.setFont(undefined, "bold");
  doc.text("Task Details", 14, sy + 20);
  const data = tasks.map((t, i) => [i + 1, t.task_name + (t.kra_name ? `\n[${t.kra_name}]` : ""), STATUS_LABEL[t.status] || t.status, f2(t.estimated_hrs), f2(t.estimated_units), f2(t.actual_hrs), f2(t.productivity_units), f2(t.performance_deviation), t.assignment_type]);
  data.push(["-", "Totals", "-", tot("estimated_hrs"), tot("estimated_units"), tot("actual_hrs"), tot("productivity_units"), tot("performance_deviation"), "-"]);
  doc.autoTable({
    head: [["#", "Task Name", "Status", "Estimated Hrs", "Estimated Units", "Actual Hrs", "Productivity Units", "Performance Deviation", "Assignment Type"]],
    body: data, startY: sy + 25,
    styles: { fontSize: 8, cellPadding: 2, overflow: "linebreak" },
    headStyles: { fillColor: [52, 58, 64], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [245, 245, 245] },
    columnStyles: { 0: { cellWidth: 10 }, 1: { cellWidth: 60 }, 2: { cellWidth: 20 }, 8: { cellWidth: 35 } },
    didParseCell: (d) => {
      if (d.section !== "body") return;
      const ri = d.row.index;
      if (ri === tasks.length) { d.cell.styles.fillColor = [236, 240, 241]; d.cell.styles.fontStyle = "bold"; return; }
      if (d.column.index === 7) {
        const t = tasks[ri];
        if (t.actual_hrs === 0 && t.estimated_hrs > 0) { d.cell.styles.textColor = [13, 110, 253]; d.cell.styles.fontStyle = "bold"; }
        else if (t.performance_deviation > 0) { d.cell.styles.textColor = [40, 167, 69]; d.cell.styles.fontStyle = "bold"; }
        else if (t.performance_deviation < 0) { d.cell.styles.textColor = [220, 53, 69]; d.cell.styles.fontStyle = "bold"; }
      }
    },
  });
  const y = doc.lastAutoTable.finalY + 10;
  doc.setFontSize(11); doc.setFont(undefined, "bold"); doc.setTextColor(0, 0, 0);
  doc.text(`Performance Summary for ${name}`, 14, y);
  doc.setFontSize(9); doc.setFont(undefined, "normal");
  doc.text(`- Total Tasks Assigned: ${tasks.length}`, 14, y + 6);
  doc.text(`- Total Estimated Hours: ${tot("estimated_hrs")} hrs`, 14, y + 11);
  doc.text(`- Total Actual Hours: ${tot("actual_hrs")} hrs`, 14, y + 16);
  doc.text(`- Overall Deviation: ${tot("performance_deviation")} units`, 14, y + 21);
  doc.setTextColor(150, 150, 150); doc.setFontSize(8);
  doc.text("Generated by KRA/KPI Management System", 14, 200);
  doc.text("Page 1 of 1", 260, 200);
  doc.save(`Employee_Performance_${String(name).replace(/\s+/g, "_")}_${from}_to_${to}.pdf`);
}

export default function PerformanceReport() {
  const [tab, setTab] = useState("report");
  const [staff, setStaff] = useState([]);
  const [prefill, setPrefill] = useState(null);
  useEffect(() => { R.fetchStaff().then(setStaff).catch(() => {}); }, []);
  return (
    <>
      <PageHeader crumbs={[{ label: "Reports" }, { label: "Performance" }]} title="Performance report" meta="1 unit = 0.01 hour" />
      <div className="page">
        <ReportsNav />
        <Tabs items={[{ key: "report", label: "Performance analysis" }, { key: "salary", label: "Employee salary master" }]} value={tab} onChange={setTab} />
        {tab === "report" ? <Report staff={staff} onConfigure={(emp) => { setPrefill(emp); setTab("salary"); }} /> : <SalaryMaster staff={staff} prefill={prefill} onPrefillUsed={() => setPrefill(null)} />}
      </div>
    </>
  );
}

function Report({ staff, onConfigure }) {
  const flags = useFlags();
  const [f, setF] = useState(() => { const r = R.presetRange("this_month"); return { from: r[0], to: r[1], employeeId: "", timeFrame: "" }; });
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState(null);
  const [pdfBusy, setPdfBusy] = useState("");
  const generate = async () => {
    setBusy(true);
    try { const r = R.assertOk(await R.generatePerformance(f), "Could not build the report."); setRes({ rows: r.data || [], missing: r.missing_employees || [], from: f.from, to: f.to }); }
    catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  const openDetail = async (row) => {
    setDetail({ name: row.employee_name, tasks: null });
    try { const r = R.assertOk(await R.fetchPerformanceDetail({ employeeId: row.employee_id, from: f.from, to: f.to }), "Could not load the tasks."); setDetail({ name: r.employee_name || row.employee_name, tasks: r.tasks || [], from: f.from, to: f.to }); }
    catch (e) { flags.err(e.message); setDetail(null); }
  };
  const rows = res?.rows || [];
  const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const avg = (k) => (rows.length ? sum(k) / rows.length : 0);
  const exportCsv = () => R.downloadText(R.csv(rows, [
    { key: "employee_name", label: "Name" }, { key: "department", label: "Department" }, { key: "salary", label: "Salary" }, { key: "working_days", label: "Working days" },
    { key: "estimated_hours", label: "Estimated hrs" }, { key: "estimated_units", label: "Estimated units" }, { key: "actual_hours", label: "Actual hrs" }, { key: "productivity_units", label: "Productivity units" },
    { key: "performance_deviation", label: "Performance deviation" }, { key: "available_units", label: "Available units" }, { key: "unit_cost", label: "Unit cost" },
    { key: "productivity_cost", label: "Productivity cost" }, { key: "productivity_cost_pct", label: "Productivity cost %" }, { key: "remarks", label: "Remarks" },
  ]), `Performance_report_${f.from}_${f.to}.csv`);

  return (
    <>
      <ReportFilters value={f} onChange={setF} employees={staff} onGenerate={generate} busy={busy}>
        <Button icon="download" busy={pdfBusy === "main"} onClick={async () => { setPdfBusy("main"); try { await mainReportPdf(rows, res.from, res.to); } catch (e) { flags.err(e.message || "Could not build the PDF."); } finally { setPdfBusy(""); } }} disabled={!res}>PDF</Button>
        <Button icon="download" onClick={exportCsv} disabled={!rows.length}>CSV</Button>
      </ReportFilters>
      {res?.missing?.length > 0 && (
        <div className="callout" style={{ background: "var(--lz-paused-bg)", borderColor: "var(--pri-important)", color: "var(--lz-paused)", flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 240 }}><b>No salary / working days set for {res.missing.length} employee(s)</b> — they are left out of the report until they are in the salary master.</span>
          <span className="chips">{res.missing.map((m) => <button key={m.id} type="button" className="pill" style={{ height: 28, fontSize: 12 }} onClick={() => onConfigure(m)} title="Set salary">{m.name} +</button>)}</span>
        </div>
      )}
      <div className="cardbox table-scroll" style={{ padding: 0 }}>
        {!res && !busy && <div className="empty">Set the filters and press Generate report.</div>}
        {busy && !res && <div style={{ padding: 16 }}><Skeleton rows={6} /></div>}
        {res && (
          <table className="table">
            <thead><tr><th>#</th><th>Name</th><th className="num">Salary</th><th className="num">Working days</th><th className="num">Est. hrs</th><th className="num">Est. units</th><th className="num">Actual hrs</th><th className="num">Productivity units</th><th className="num">Deviation</th><th className="num">Available units</th><th className="num">Unit cost</th><th className="num">Productivity cost</th><th className="num">Cost %</th><th>Remarks</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.employee_id} style={{ cursor: "pointer", background: rowBg(r) }} onClick={() => openDetail(r)}>
                  <td>{i + 1}</td><td><Avatar name={r.employee_name} id={r.employee_id} size={22} /> <b>{r.employee_name}</b>{r.department && <div className="mini">{r.department}</div>}</td>
                  <td className="num">{n2(r.salary)}</td><td className="num">{r.working_days}</td><td className="num">{hm(r.estimated_hours)}</td><td className="num">{n2(r.estimated_units)}</td>
                  <td className="num">{hm(r.actual_hours)}</td><td className="num">{n2(r.productivity_units)}</td><td className="num" style={{ color: devColor(r.performance_deviation), fontWeight: 800 }}>{n2(r.performance_deviation)}</td>
                  <td className="num">{n2(r.available_units)}</td><td className="num">{Number(r.unit_cost || 0).toFixed(4)}</td><td className="num">{n2(r.productivity_cost)}</td><td className="num">{n2(r.productivity_cost_pct)}%</td>
                  <td><Lozenge tone={remarkTone(r.remarks)}>{r.remarks}</Lozenge></td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={14} className="empty">No employees with a salary set have tasks in this period.</td></tr>}
            </tbody>
            {rows.length > 0 && (
              <tfoot><tr style={{ fontWeight: 900 }}>
                <td /><td style={{ color: "var(--navy)" }}>Total / average</td><td className="num">{n2(sum("salary"))}</td><td className="num">{sum("working_days")}</td><td className="num">{hm(sum("estimated_hours"))}</td><td className="num">{n2(sum("estimated_units"))}</td>
                <td className="num">{hm(sum("actual_hours"))}</td><td className="num">{n2(sum("productivity_units"))}</td><td className="num">{n2(avg("performance_deviation"))}</td><td className="num">{n2(sum("available_units"))}</td>
                <td className="num">{avg("unit_cost").toFixed(4)}</td><td className="num">{n2(sum("productivity_cost"))}</td><td className="num">{n2(avg("productivity_cost_pct"))}%</td><td />
              </tr></tfoot>
            )}
          </table>
        )}
      </div>
      {res && rows.length > 0 && (
        <div className="stats">
          <div className="stat" style={{ background: "var(--lz-done-bg)" }}><small>Excellent performer</small><b style={{ color: "var(--lz-done)" }}>{countRemark(rows, "Excellent Performance")}</b><span>employees (positive deviation)</span></div>
          <div className="stat" style={{ background: "var(--over-bg)" }}><small>Low performer</small><b style={{ color: "var(--over)" }}>{countRemark(rows, "Low Performance")}</b><span>employees (negative deviation)</span></div>
          <div className="stat" style={{ background: "var(--lz-prog-bg)" }}><small>Not started</small><b style={{ color: "var(--lz-prog)" }}>{countRemark(rows, "Not Started")}</b><span>employees (task assigned)</span></div>
          <div className="stat" style={{ background: "var(--lz-paused-bg)" }}><small>No tasks assigned</small><b style={{ color: "var(--lz-paused)" }}>{countRemark(rows, "No Tasks Assigned")}</b><span>employees (idle)</span></div>
        </div>
      )}
      {res && (
        <div className="cardbox">
          <h2>Performance metrics</h2>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: "21px" }}>
            <li><b>Unit calculation:</b> 1 hour = 100 units</li>
            <li><b>Available hours:</b> Working days × Attendance hours/day</li>
            <li><b>Available units:</b> Available hours × 100</li>
            <li><b>Estimated unit:</b> Estimated hours × 100</li>
            <li><b>Productivity units:</b> Actual hours × 100</li>
            <li><b>Performance deviation:</b> Estimated units − Productivity units</li>
            <li><b>Unit cost:</b> Salary / Available units</li>
            <li><b>Productivity cost:</b> Productivity units × Unit cost</li>
            <li><b>Productivity cost %:</b> (Actual hours / Available hours) × 100</li>
          </ul>
          <b style={{ fontSize: 13, color: "var(--navy)" }}>Performance categories</b>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: "21px" }}>
            <li><b style={{ color: "var(--lz-done)" }}>Excellent performance:</b> positive deviation (completed work faster than estimated)</li>
            <li><b style={{ color: "var(--over)" }}>Low performance:</b> negative deviation (took longer than estimated)</li>
            <li><b style={{ color: "var(--lz-prog)" }}>Not started:</b> task assigned but work hasn&apos;t begun yet</li>
            <li><b style={{ color: "var(--lz-paused)" }}>No tasks assigned:</b> employee is idle with no tasks</li>
          </ul>
        </div>
      )}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `Individual performance report — ${detail.name}` : ""} width={1040}
        footer={<>{detail?.tasks && <Button icon="download" busy={pdfBusy === "emp"} onClick={async () => { setPdfBusy("emp"); try { await employeeDetailPdf(detail.name, detail.tasks, detail.from, detail.to); } catch (e) { flags.err(e.message || "Could not build the PDF."); } finally { setPdfBusy(""); } }}>Download PDF</Button>}<Button kind="ghost" onClick={() => setDetail(null)}>Close</Button></>}>
        {detail && !detail.tasks && <Skeleton rows={5} />}
        {detail?.tasks && (
          <>
            <div className="stats">
              <div className="stat"><small>Tasks</small><b>{detail.tasks.length}</b></div>
              <div className="stat"><small>Excellent</small><b style={{ color: "var(--lz-done)" }}>{detail.tasks.filter((t) => t.performance_deviation > 0).length}</b></div>
              <div className="stat"><small>Low performance</small><b style={{ color: "var(--over)" }}>{detail.tasks.filter((t) => t.performance_deviation < 0).length}</b></div>
              <div className="stat"><small>On target</small><b>{detail.tasks.filter((t) => !t.performance_deviation).length}</b></div>
            </div>
            <div className="table-scroll" style={{ maxHeight: "55vh" }}>
              <table className="table">
                <thead><tr><th>#</th><th>Task</th><th>Status</th><th className="num">Est. hrs</th><th className="num">Est. units</th><th className="num">Actual hrs</th><th className="num">Productivity units</th><th className="num">Deviation</th><th>Assignment</th></tr></thead>
                <tbody>
                  {detail.tasks.map((t, i) => (
                    <tr key={`${t.task_id}-${t.assignment_type}-${i}`}>
                      <td>{i + 1}</td><td><b>{t.task_name}</b>{t.kra_name && <div className="mini">{t.kra_name}</div>}</td>
                      <td><Lozenge tone={t.status === "reassigned" ? "review" : t.status === "completed" ? "done" : t.status === "in_progress" ? "progress" : "todo"}>{String(t.status || "").replace(/_/g, " ")}</Lozenge></td>
                      <td className="num">{n2(t.estimated_hrs)}</td><td className="num">{n2(t.estimated_units)}</td><td className="num">{n2(t.actual_hrs)}</td><td className="num">{n2(t.productivity_units)}</td>
                      <td className="num" style={{ color: devColor(t.performance_deviation), fontWeight: 800 }}>{n2(t.performance_deviation)}</td>
                      <td className="mini">{t.assignment_type}</td>
                    </tr>
                  ))}
                  {!detail.tasks.length && <tr><td colSpan={9} className="empty">No tasks in this period.</td></tr>}
                </tbody>
                {detail.tasks.length > 0 && <tfoot><tr style={{ fontWeight: 900 }}><td /><td>Total</td><td /><td className="num">{n2(detail.tasks.reduce((s, t) => s + (t.estimated_hrs || 0), 0))}</td><td className="num">{n2(detail.tasks.reduce((s, t) => s + (t.estimated_units || 0), 0))}</td><td className="num">{n2(detail.tasks.reduce((s, t) => s + (t.actual_hrs || 0), 0))}</td><td className="num">{n2(detail.tasks.reduce((s, t) => s + (t.productivity_units || 0), 0))}</td><td className="num">{n2(detail.tasks.reduce((s, t) => s + (t.performance_deviation || 0), 0))}</td><td /></tr></tfoot>}
              </table>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}

/* ---- Employee Salary Master ---- */
const EMPTY = { id: null, employee_id: "", salary: "", working_days: 25, attendance_hours_per_day: 8 };
function SalaryMaster({ staff, prefill, onPrefillUsed }) {
  const flags = useFlags();
  const dialogs = useDialogs();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => R.fetchSalaryConfigs().then((r) => { setRows(r); setErr(null); }).catch(setErr), []);
  useEffect(() => { load(); }, [load]);
  const configured = useMemo(() => new Set((rows || []).map((r) => r.employee_id?.[0])), [rows]);
  useEffect(() => {
    if (!prefill || !rows) return;
    const have = rows.find((r) => r.employee_id?.[0] === prefill.id);
    setForm(have ? toForm(have) : { ...EMPTY, employee_id: String(prefill.id) });
    onPrefillUsed();
  }, [prefill, rows, onPrefillUsed]);

  const save = async () => {
    if (!form.id && !form.employee_id) { flags.err("Choose an employee."); return; }
    if (!(Number(form.working_days) > 0)) { flags.err("Working days must be more than 0."); return; }
    setBusy(true);
    try { await R.saveSalaryConfig(form); flags.ok("Saved."); setForm(null); await load(); }
    catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  const remove = async (r) => {
    if (!(await dialogs.confirm({ title: `Remove ${r.employee_id?.[1]}?`, text: "They drop out of the performance report until a salary is set again.", confirmLabel: "Remove", danger: true }))) return;
    try { await R.deleteSalaryConfig(r.id); flags.ok("Removed."); await load(); } catch (e) { flags.err(e.message); }
  };
  const avH = (Number(form?.working_days) || 0) * (Number(form?.attendance_hours_per_day) || 0);
  const avU = avH * 100;

  return (
    <>
      <div className="toolbar">
        <span className="mini" style={{ flex: 1 }}>Salary and working days per employee. Available hours = working days × hours/day; unit cost = salary ÷ (available hours × 100).</span>
        <Button kind="primary" icon="plus" onClick={() => setForm({ ...EMPTY })}>Add employee</Button>
      </div>
      {err && !rows && <ErrorState error={err} onRetry={load} />}
      <div className="cardbox table-scroll" style={{ padding: 0 }}>
        {!rows && !err ? <div style={{ padding: 16 }}><Skeleton rows={5} /></div> : rows && (
          <table className="table">
            <thead><tr><th>Employee</th><th className="num">Monthly salary</th><th className="num">Working days</th><th className="num">Hours / day</th><th className="num">Available hours</th><th className="num">Available units</th><th className="num">Unit cost</th><th>Last updated</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><Avatar name={r.employee_id?.[1]} id={r.employee_id?.[0]} size={22} /> <b>{r.employee_id?.[1] || "—"}</b></td>
                  <td className="num">{n2(r.salary)}</td><td className="num">{r.working_days}</td><td className="num">{n2(r.attendance_hours_per_day)}</td>
                  <td className="num">{n2(r.available_hours)}</td><td className="num">{n2(r.available_units)}</td><td className="num">{Number(r.unit_cost || 0).toFixed(4)}</td>
                  <td className="mini">{r.last_updated || "—"}</td>
                  <td><span style={{ display: "inline-flex", gap: 4 }}><Button size="sm" onClick={() => setForm(toForm(r))}>Edit</Button><Button size="sm" kind="ghost" onClick={() => remove(r)}>Remove</Button></span></td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={9} className="empty">No salaries set yet. The performance report needs one per employee.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? `Edit ${form.name || "salary"}` : "Add employee salary"} width={480}
        footer={<><Button kind="ghost" onClick={() => setForm(null)}>Cancel</Button><Button kind="primary" busy={busy} onClick={save}>Save</Button></>}>
        {form && (
          <>
            {!form.id && (
              <Field label="Employee">
                <span className="input"><Select value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}>
                  <option value="">Choose an employee</option>
                  {staff.filter((s) => !configured.has(s.id) || String(s.id) === String(form.employee_id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select></span>
              </Field>
            )}
            <Field label="Monthly salary"><Input type="number" min="0" step="1" value={form.salary} onChange={(e) => setForm({ ...form, salary: e.target.value })} autoFocus={!!form.id} /></Field>
            <div className="grid2">
              <Field label="Working days"><Input type="number" min="1" step="1" value={form.working_days} onChange={(e) => setForm({ ...form, working_days: e.target.value })} /></Field>
              <Field label="Hours per day"><Input type="number" min="0" step="0.5" value={form.attendance_hours_per_day} onChange={(e) => setForm({ ...form, attendance_hours_per_day: e.target.value })} /></Field>
            </div>
            <p className="mini" style={{ margin: 0 }}>Available {n2(avH)} h · {n2(avU)} units · unit cost {avU > 0 ? ((Number(form.salary) || 0) / avU).toFixed(4) : "—"}</p>
          </>
        )}
      </Modal>
    </>
  );
}
function toForm(r) {
  return { id: r.id, name: r.employee_id?.[1] || "", employee_id: String(r.employee_id?.[0] || ""), salary: r.salary, working_days: r.working_days, attendance_hours_per_day: r.attendance_hours_per_day };
}
