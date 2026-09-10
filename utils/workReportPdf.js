// The Work Report PDF, built ON THE DEVICE.
//
// A port of downloadPdf() in the Odoo web screen
// (static/src/components/kpi_period_report/kpi_period_report.js), for the same
// reasons as utils/invoicePdf.js and utils/kraExport.js — and here it also fixes
// two things at once that the server-rendered copy could not do:
//
//   1. It builds from the RESULT, never from the live filter state. The app used
//      to post the current filters to /period_work/pdf, so changing the preset
//      after Generate exported a different window than the badges on screen
//      showed. Here there is nothing to desync from: you pass the generated
//      payload, and that is the only thing drawn.
//
//   2. It honours "Show hours". The server renderer always prints hours
//      (kpi_reports_api.py), so the hours-free copy an admin sends a client
//      could not be produced from the phone at all — the switch changed the
//      list on screen and nothing else.
//
// As everywhere else, only the last step differs from the web: doc.save(name)
// becomes base64 and the caller writes the file.

import { jsPDF } from 'jspdf';
import 'jspdf-autotable';           // patches the jsPDF prototype; no export of its own

function docToB64(doc) {
  const uri = doc.output('datauristring');
  return uri.slice(uri.indexOf(',') + 1);
}

// `res` is the payload from /kpi_reports/period_work/generate, exactly as the
// screen already holds it: tasks, clients, total_tasks, total_hours_display,
// from_date, to_date, company_name, company_logo_b64, group_by.
export function buildWorkReportPdf(res, showHours = true) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setFont('times', 'normal');
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 48;
  let y = M;
  const clientWise = res.group_by === 'client';
  const logo = res.company_logo_b64 ? ('data:image/png;base64,' + res.company_logo_b64) : '';
  let logoRatio = 1;
  if (logo) { try { const p = doc.getImageProperties(logo); if (p.width && p.height) logoRatio = p.width / p.height; } catch (e) { /* keep 1:1 */ } }

  if (logo) { try { const h = 56, w = Math.min(h * logoRatio, 150); doc.addImage(logo, 'PNG', M, y, w, h); } catch (e) { /* ignore bad image */ } }
  doc.setFont('times', 'bold'); doc.setFontSize(22);
  doc.text(res.company_name || '', pageW - M, y + 22, { align: 'right' });
  doc.setFont('times', 'normal'); doc.setFontSize(12);
  doc.text('WORK REPORT', pageW - M, y + 44, { align: 'right' });
  y += 72;
  doc.setDrawColor(190); doc.setLineWidth(0.8); doc.line(M, y, pageW - M, y); y += 22;

  doc.setFontSize(11);
  doc.text(`Period: ${res.from_date} to ${res.to_date}`, M, y);
  doc.text(`Completed tasks: ${res.total_tasks}`, pageW - M, y, { align: 'right' });
  y += 16;
  if (showHours) { doc.text(`Total hours: ${res.total_hours_display}`, pageW - M, y, { align: 'right' }); }
  y += 12;

  const head = clientWise
    ? [showHours ? ['Ref', 'Task', 'Project', 'Assignee', 'Completed', 'Hours'] : ['Ref', 'Task', 'Project', 'Assignee', 'Completed']]
    : [showHours ? ['Ref', 'Task', 'Client', 'Project', 'Assignee', 'Completed', 'Hours'] : ['Ref', 'Task', 'Client', 'Project', 'Assignee', 'Completed']];
  const rowOf = (t) => {
    const r = clientWise
      ? [t.ref, t.name, t.project_name, t.assignee, t.completion_date]
      : [t.ref, t.name, t.client_name, t.project_name, t.assignee, t.completion_date];
    if (showHours) r.push(t.hours_display);
    return r;
  };
  const colStyles = { 0: { cellWidth: 55 } };
  if (showHours) colStyles[head[0].length - 1] = { halign: 'right', cellWidth: 55 };
  const tableOpts = {
    margin: { left: M, right: M },
    styles: { font: 'times', fontSize: 9, cellPadding: 5, lineColor: [225, 225, 225], lineWidth: 0.5, overflow: 'linebreak' },
    headStyles: { font: 'times', fontStyle: 'bold', fillColor: [56, 56, 92], textColor: 255, halign: 'left' },
    columnStyles: colStyles,
    alternateRowStyles: { fillColor: [247, 247, 251] },
  };

  if (clientWise) {
    for (const c of (res.clients || [])) {
      y += 6;
      // Keep the client label with its table: near the page bottom, start a
      // fresh page so the label never orphans above the margin.
      if (y > pageH - 80) { doc.addPage(); y = M; }
      doc.setFont('times', 'bold'); doc.setFontSize(11);
      const label = showHours
        ? `${c.client_name}  —  ${c.task_count} tasks, ${c.total_display}`
        : `${c.client_name}  —  ${c.task_count} tasks`;
      doc.text(label, M, y); y += 4;
      doc.autoTable({ ...tableOpts, startY: y + 4, head, body: (c.tasks || []).map(rowOf) });
      y = doc.lastAutoTable.finalY + 14;
    }
  } else {
    doc.autoTable({ ...tableOpts, startY: y, head, body: (res.tasks || []).map(rowOf) });
  }

  // Watermark on every page — best-effort, as on the web.
  if (logo) {
    try {
      let wmW = pageW * 0.55, wmH = wmW / (logoRatio || 1);
      if (wmH > pageH * 0.5) { wmH = pageH * 0.5; wmW = wmH * (logoRatio || 1); }
      const wmX = (pageW - wmW) / 2, wmY = (pageH - wmH) / 2;
      const pc = doc.internal.getNumberOfPages();
      for (let p = 1; p <= pc; p++) {
        doc.setPage(p);
        if (doc.GState) { doc.saveGraphicsState(); doc.setGState(new doc.GState({ opacity: 0.08 })); }
        doc.addImage(logo, 'PNG', wmX, wmY, wmW, wmH);
        if (doc.GState) doc.restoreGraphicsState();
      }
    } catch (e) { /* watermark is best-effort */ }
  }

  return doc;
}

// Same shape as makeReportPdf / makeInvoicePdf, so the screen's save and share
// paths take it unchanged.
export function makeWorkReportPdf(res, showHours = true) {
  return {
    status: true,
    file_name: `Work_Report_${res.from_date}_to_${res.to_date}.pdf`,
    mimeType: 'application/pdf',
    data_b64: docToB64(buildWorkReportPdf(res, showHours)),
  };
}
