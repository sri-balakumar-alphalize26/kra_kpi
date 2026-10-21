"use client";
import { useEffect, useMemo, useState } from "react";
import { Avatar, Button, ErrorState, Icon, Lozenge, PageHeader, Skeleton, Tabs, useFlags, Select } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import * as R from "@/lib/services/reports";
import { refPrefix } from "@/lib/services/kpiActions";
import ReportsNav from "./ReportsNav";
import { loadPdf } from "./exportLibs";

/* Completed tasks for a period, task-wise or client-wise.
   "Show hours" (as on the Odoo screen) hides every hour figure — on screen and
   in the PDF. With hours on, the PDF is the server's branded one
   (period_work/pdf). That route has no show_hours switch yet, so a PDF without
   hours is built here instead, with the Odoo screen's own jsPDF layout. */
const ymd = R.ymd; /* local date, not toISOString's UTC one */
const presets = () => { const n = new Date(); const m0 = new Date(n.getFullYear(), n.getMonth(), 1); const lm0 = new Date(n.getFullYear(), n.getMonth() - 1, 1); const lm1 = new Date(n.getFullYear(), n.getMonth(), 0); const day = n.getDay() || 7; const mon = new Date(n); mon.setDate(n.getDate() - day + 1); return { today: [ymd(n), ymd(n)], week: [ymd(mon), ymd(n)], month: [ymd(m0), ymd(n)], lastmonth: [ymd(lm0), ymd(lm1)] }; };

/* Port of kpi_period_report.downloadPdf (Times, logo + watermark). */
async function clientPdf(d, showHours) {
  const { make } = await loadPdf();
  const doc = make({ unit: "pt", format: "a4" });
  doc.setFont("times", "normal");
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 48;
  let y = M;
  const clientWise = d.group_by === "client";
  const logo = d.company_logo_b64 ? `data:image/png;base64,${d.company_logo_b64}` : "";
  let ratio = 1;
  if (logo) { try { const p = doc.getImageProperties(logo); if (p.width && p.height) ratio = p.width / p.height; } catch (e) { /* no logo */ } }
  if (logo) { try { const h = 56, w = Math.min(h * ratio, 150); doc.addImage(logo, "PNG", M, y, w, h); } catch (e) { /* no logo */ } }
  doc.setFont("times", "bold"); doc.setFontSize(22);
  doc.text(d.company_name || "", pageW - M, y + 22, { align: "right" });
  doc.setFont("times", "normal"); doc.setFontSize(12);
  doc.text("WORK REPORT", pageW - M, y + 44, { align: "right" });
  y += 72;
  doc.setDrawColor(190); doc.setLineWidth(0.8); doc.line(M, y, pageW - M, y); y += 22;
  doc.setFontSize(11);
  doc.text(`Period: ${d.from_date} to ${d.to_date}`, M, y);
  doc.text(`Completed tasks: ${d.total_tasks}`, pageW - M, y, { align: "right" });
  y += 16;
  if (showHours) doc.text(`Total hours: ${d.total_hours_display}`, pageW - M, y, { align: "right" });
  y += 12;
  const head = clientWise
    ? [showHours ? ["Ref", "Task", "Project", "Assignee", "Completed", "Hours"] : ["Ref", "Task", "Project", "Assignee", "Completed"]]
    : [showHours ? ["Ref", "Task", "Client", "Project", "Assignee", "Completed", "Hours"] : ["Ref", "Task", "Client", "Project", "Assignee", "Completed"]];
  const rowOf = (t) => { const r = clientWise ? [t.ref, t.name, t.project_name, t.assignee, t.completion_date] : [t.ref, t.name, t.client_name, t.project_name, t.assignee, t.completion_date]; if (showHours) r.push(t.hours_display); return r; };
  const colStyles = { 0: { cellWidth: 55 } };
  if (showHours) colStyles[head[0].length - 1] = { halign: "right", cellWidth: 55 };
  const opts = {
    margin: { left: M, right: M },
    styles: { font: "times", fontSize: 9, cellPadding: 5, lineColor: [225, 225, 225], lineWidth: 0.5, overflow: "linebreak" },
    headStyles: { font: "times", fontStyle: "bold", fillColor: [56, 56, 92], textColor: 255, halign: "left" },
    columnStyles: colStyles, alternateRowStyles: { fillColor: [247, 247, 251] },
  };
  if (clientWise) {
    for (const c of d.clients || []) {
      y += 6;
      if (y > pageH - 80) { doc.addPage(); y = M; }
      doc.setFont("times", "bold"); doc.setFontSize(11);
      doc.text(showHours ? `${c.client_name}  —  ${c.task_count} tasks, ${c.total_display}` : `${c.client_name}  —  ${c.task_count} tasks`, M, y); y += 4;
      doc.autoTable({ ...opts, startY: y + 4, head, body: (c.tasks || []).map(rowOf) });
      y = doc.lastAutoTable.finalY + 14;
    }
  } else {
    doc.autoTable({ ...opts, startY: y, head, body: (d.tasks || []).map(rowOf) });
  }
  if (logo) {
    try {
      let wmW = pageW * 0.55, wmH = wmW / (ratio || 1);
      if (wmH > pageH * 0.5) { wmH = pageH * 0.5; wmW = wmH * (ratio || 1); }
      const pc = doc.internal.getNumberOfPages();
      for (let p = 1; p <= pc; p++) {
        doc.setPage(p);
        if (doc.GState) { doc.saveGraphicsState(); doc.setGState(new doc.GState({ opacity: 0.08 })); }
        doc.addImage(logo, "PNG", (pageW - wmW) / 2, (pageH - wmH) / 2, wmW, wmH);
        if (doc.GState) doc.restoreGraphicsState();
      }
    } catch (e) { /* watermark is decoration */ }
  }
  doc.save(`Work_Report_${d.from_date}_to_${d.to_date}.pdf`);
}

export default function WorkReport() {
  const flags = useFlags();
  const [preset, setPreset] = useState("month");
  const [range, setRange] = useState(() => presets().month);
  const [groupBy, setGroupBy] = useState("task");
  const [client, setClient] = useState("");
  const [clients, setClients] = useState([]);
  const [showHours, setShowHours] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => { R.fetchWorkReportClients().then(setClients).catch(() => {}); }, []);
  const params = useMemo(() => ({ from_date: range[0], to_date: range[1], group_by: groupBy, ...(client ? { client_kra_id: +client } : {}) }), [range, groupBy, client]);
  const rep = useResource(R.WORK_PATH, params, { ttl: 30000 });
  /* The route answers {status:false, message} when refused; treat that as an error. */
  const failed = rep.data?.status === false;
  const d = failed ? null : rep.data;
  const repErr = rep.error || (failed ? new Error(rep.data.message || "Could not load the work report.") : null);
  const tasks = d?.tasks || [];
  const byClient = d?.clients || [];
  const pdf = async () => {
    setBusy(true);
    try {
      if (showHours) { const r = await R.workReportPdf(params); R.assertOk(r, "Could not build the PDF."); R.downloadB64(r.data_b64 || r.data, r.file_name || "Work_Report.pdf", r.mimetype || "application/pdf"); }
      else await clientPdf(d, false);
      flags.ok("PDF downloaded.");
    }
    catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader crumbs={[{ label: "Reports" }, { label: "Work report" }]} title="Work report">
        <label className="chk" style={{ fontSize: 12.5 }}><span className={`toggle ${showHours ? "on" : ""}`} role="switch" aria-checked={showHours} tabIndex={0} onClick={() => setShowHours((v) => !v)} onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); setShowHours((v) => !v); } }} style={{ cursor: "pointer" }} />Show hours</label>
        <Button kind="primary" icon="download" busy={busy} onClick={pdf} disabled={!d || !d.total_tasks}>Download PDF</Button>
      </PageHeader>
      <div className="page">
        <ReportsNav />
        <div className="toolbar">
          <Tabs items={[{ key: "today", label: "Today" }, { key: "week", label: "This week" }, { key: "month", label: "This month" }, { key: "lastmonth", label: "Last month" }]} value={preset} onChange={(k) => { setPreset(k); setRange(presets()[k]); }} />
          <span className="input" style={{ height: 32 }}><Icon n="cal" size={16} /><input type="date" value={range[0]} max={range[1]} onChange={(e) => { setPreset(""); setRange([e.target.value, range[1]]); }} style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: 130 }} /><span className="mini">to</span><input type="date" value={range[1]} min={range[0]} onChange={(e) => { setPreset(""); setRange([range[0], e.target.value]); }} style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: 130 }} /></span>
          <Tabs items={[{ key: "task", label: "Task-wise" }, { key: "client", label: "Client-wise" }]} value={groupBy} onChange={setGroupBy} />
          <span className="input" style={{ height: 32 }}><Select value={client} onChange={(e) => setClient(e.target.value)} style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit" }}><option value="">All clients</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></span>
          <span className="right mini">{d ? `${d.total_tasks} tasks${showHours ? ` · ${d.total_hours_display}` : ""}` : ""}</span>
        </div>
        {repErr && !d && <ErrorState error={repErr} onRetry={rep.refresh} />}
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {!d && !repErr ? <div style={{ padding: 16 }}><Skeleton rows={6} /></div> : !d ? null : groupBy === "client" ? (
            <table className="table">
              <thead><tr><th>Client</th><th className="num">Tasks</th>{showHours && <th className="num">Hours</th>}</tr></thead>
              <tbody>{byClient.map((c, i) => (
                <GroupRow key={c.client_id || i} c={c} showHours={showHours} />
              ))}{!byClient.length && <tr><td colSpan={showHours ? 3 : 2} className="empty">Nothing completed in this period.</td></tr>}</tbody>
            </table>
          ) : (
            <table className="table">
              <thead><tr><th>Done on</th><th>Ref</th><th>Task</th><th>Client / project</th><th>Developer</th><th>Type</th>{showHours && <th className="num">Hours</th>}</tr></thead>
              <tbody>{tasks.map((t) => (
                <tr key={t.task_id || t.ref}><td>{t.completion_date || ""}</td><td><span className="ref">{t.ref}</span></td><td><b>{t.name}</b></td><td>{t.client_name || t.client}{t.project_name ? ` · ${t.project_name}` : ""}</td><td>{t.assignee ? <><Avatar name={t.assignee} size={22} /> {t.assignee}</> : "—"}</td><td><Lozenge tone={/bug/i.test(t.ref) ? "danger" : /up/i.test(t.ref) ? "done" : "progress"}>{refPrefix(t.ref)}</Lozenge></td>{showHours && <td className="num">{t.hours_display}</td>}</tr>
              ))}{!tasks.length && <tr><td colSpan={showHours ? 7 : 6} className="empty">Nothing completed in this period.</td></tr>}</tbody>
              {tasks.length > 0 && <tfoot><tr><td colSpan={showHours ? 6 : 6} style={{ fontWeight: 800, color: "var(--navy)" }}>Total · {d.total_tasks} tasks</td>{showHours && <td className="num" style={{ fontWeight: 800 }}>{d.total_hours_display}</td>}</tr></tfoot>}
            </table>
          )}
        </div>
      </div>
    </>
  );
}
function GroupRow({ c, showHours }) {
  const [open, setOpen] = useState(false);
  const tasks = c.tasks || [];
  return (
    <>
      <tr style={{ cursor: "pointer" }} onClick={() => setOpen((o) => !o)}><td><Icon n={open ? "chev" : "cright"} size={14} /> <b>{c.client_name || c.client || c.name}</b></td><td className="num">{c.task_count ?? tasks.length}</td>{showHours && <td className="num">{c.total_display}</td>}</tr>
      {open && tasks.map((t) => <tr key={t.task_id || t.ref}><td style={{ paddingLeft: 36 }}><span className="ref">{t.ref}</span> {t.name}{t.project_name ? <span className="mini"> · {t.project_name}</span> : null}<span className="mini"> · {t.assignee}</span></td><td className="num">{t.completion_date}</td>{showHours && <td className="num">{t.hours_display}</td>}</tr>)}
    </>
  );
}
