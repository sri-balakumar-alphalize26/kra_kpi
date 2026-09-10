// KRA Report documents, built ON THE DEVICE.
//
// A near-line-for-line port of the builders in the Odoo web screen
// (static/src/components/kpi_kra_report/kpi_kra_report.js). The web loads jsPDF,
// jspdf-autotable, JSZip and ExcelJS from a CDN and this file imports the same
// four as npm packages; the drawing and styling code is deliberately identical,
// because the whole point is that a pack downloaded from the phone is the same
// document as one downloaded from the browser.
//
// What had to change is only ever the LAST step of each builder:
//
//   web                                   here
//   doc.output('blob')                    doc.output('datauristring') -> base64
//   doc.save(name)                        base64, caller writes the file
//   zip.generateAsync({type:'blob'})      {type:'base64'}
//   URL.createObjectURL + <a>.click()     the caller's SAF / share-sheet save
//
// React Native has no DOM, its Blob is a partial polyfill that JSZip and ExcelJS
// will not take as binary input, and `URL` has no blob-URL support. Base64 is the
// one currency every step here and every save path in the app already speaks.
//
// Node globals (Buffer, process) come from shims.js via metro.config.js. Without
// them this module bundles fine and then throws on the first workbook write.

import { jsPDF } from 'jspdf';
import 'jspdf-autotable';           // patches the jsPDF prototype; no export of its own
import JSZip from 'jszip';
import ExcelJS from 'exceljs';

// ── Palette ────────────────────────────────────────────────────────────────
// One palette for the Requirement / Update / Bug badge so the table, the PDF and
// the spreadsheet cannot drift apart. `rgb`/`text` drive jsPDF, `argb`/`fg` drive
// ExcelJS, `cls` is carried for the on-screen badge.
//
// These are the values Odoo's backend theme actually compiles to, not Bootstrap's
// defaults — Odoo repaints .bg-primary as its own purple RGB(113,99,158) rather
// than #0D6EFD, so the Bootstrap palette would make every exported REQ badge the
// wrong colour.
export const TYPE_STYLES = {
  REQ: { cls: 'req', rgb: [113, 99, 158], text: [255, 255, 255], argb: 'FF71639E', fg: 'FFFFFFFF' },
  UPT: { cls: 'upt', rgb: [255, 193, 7], text: [0, 0, 0], argb: 'FFFFC107', fg: 'FF000000' },
  UPD: { cls: 'upt', rgb: [255, 193, 7], text: [0, 0, 0], argb: 'FFFFC107', fg: 'FF000000' },
  BUG: { cls: 'bug', rgb: [220, 53, 69], text: [255, 255, 255], argb: 'FFDC3545', fg: 'FFFFFFFF' },
};
const TYPE_STYLE_DEFAULT = {
  cls: 'other', rgb: [222, 226, 230], text: [33, 37, 41], argb: 'FFDEE2E6', fg: 'FF212529',
};

export function typeStyle(taskType) {
  return TYPE_STYLES[(taskType || '').toUpperCase()] || TYPE_STYLE_DEFAULT;
}

// Spreadsheet palette, mirroring the PDF: detail table slate-headed with grey
// stripes, project summary green-headed with faint green stripes.
const HEAD_FILL = 'FF343A40';
const HEAD_FILL_SUMMARY = 'FF218838';
const BAND_FILL = 'FFF5F5F5';
const BAND_FILL_SUMMARY = 'FFF0F8F0';
const TOTAL_FILL = 'FFECF0F1';

function paintHeader(row, fill = HEAD_FILL) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  return row;
}

// Applied BEFORE any per-cell fill (the Type badge), so the badge wins.
function paintBand(row, index, fill) {
  if (index % 2 === 1) {
    row.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    });
  }
  return row;
}

function paintTotal(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_FILL } };
  });
  return row;
}

// ── Pure derivations, shared by the screen and every document ──────────────
// The screen reads through these too, so a removed row cannot leave a stale total
// behind in one place and not another.

export function fmtHM(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function totalSeconds(rows) {
  return (rows || []).reduce((sum, r) => sum + (r.time_worked_seconds || 0), 0);
}

export function totalTimeWorked(rows) {
  return fmtHM(totalSeconds(rows));
}

export function uniqueEmployeeCount(rows) {
  return new Set((rows || []).map((r) => r.employee_id).filter(Boolean)).size;
}

// Group the visible rows by KRA path for the "project summary" block.
//
// Deliberately NOT the server's own summary[]: that covers the whole report,
// where this covers exactly what is on screen after searching and row removal.
// Using the server's would let an exported summary disagree with its own table.
export function projectSummary(rows) {
  const buckets = new Map();
  for (const row of rows || []) {
    const key = row.kra_path || row.sub_kra || 'Unassigned';
    if (!buckets.has(key)) {
      buckets.set(key, {
        kra_path: key, root_kra: row.root_kra || '', sub_kra: row.sub_kra || '',
        task_count: 0, total_seconds: 0, employees: new Set(),
      });
    }
    const b = buckets.get(key);
    b.task_count += 1;
    b.total_seconds += (row.time_worked_seconds || 0);
    if (row.employee_name) b.employees.add(row.employee_name);
  }
  return Array.from(buckets.values())
    .map((b) => ({
      kra_path: b.kra_path,
      root_kra: b.root_kra,
      sub_kra: b.sub_kra,
      task_count: b.task_count,
      employee_count: b.employees.size,
      employees: Array.from(b.employees).sort().join(', '),
      total_seconds: b.total_seconds,
      total_hours: +(b.total_seconds / 3600).toFixed(2),
      total_display: fmtHM(b.total_seconds),
    }))
    .sort((a, b) => a.kra_path.localeCompare(b.kra_path));
}

// The arrow the server uses in a KRA path is not in jsPDF's standard font.
export function kraPathForPdf(path) {
  return String(path || '').replace(/→/g, '>');
}

// Illegal on Windows/Unix, plus collapsed whitespace.
export function safeFilename(s) {
  return String(s || 'untitled')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// Excel sheet names: no []:*?/\ and 31 characters maximum.
function safeSheetName(name) {
  const cleaned = String(name || '').replace(/[[\]:*?/\\]/g, '-').trim().slice(0, 31);
  return cleaned || 'Tasks';
}

// ── Where a task's PDF files inside the archive ────────────────────────────

// The date a row belongs to.
//
// Deliberately the row's OWN date and never "now": a September report pulled in
// October must file under September, or every folder in the archive is wrong in a
// way nobody notices until they go looking for last month's work. Falls back to
// the report's from_date, which is the period being reported on.
export function rowDate(row, fromDate) {
  return ((row && row.deadline) || '').slice(0, 10) || (fromDate || '');
}

// ISO week number, so week folders match how people actually count weeks: Monday
// starts the week, and its Thursday decides which year the week belongs to.
export function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return { year: 0, week: 0, start: '', end: '' };
  const dayNr = (d.getDay() + 6) % 7;                 // Mon = 0
  const target = new Date(d.valueOf());
  target.setDate(target.getDate() - dayNr + 3);       // that week's Thursday
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const firstDayNr = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNr + 3);
  const week = 1 + Math.round((target - firstThursday) / (7 * 24 * 3600 * 1000));
  const monday = new Date(d.valueOf());
  monday.setDate(monday.getDate() - dayNr);
  const sunday = new Date(monday.valueOf());
  sunday.setDate(sunday.getDate() + 6);
  const dd = (x) => String(x.getDate()).padStart(2, '0');
  return { year: target.getFullYear(), week, start: dd(monday), end: dd(sunday) };
}

export function monthFolder(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return 'Undated';
  return `${String(dateStr).slice(0, 7)} ${d.toLocaleString(undefined, { month: 'long' })}`;
}

// Month / Week / User, with EVERY segment sanitised — not just the leaf. A client
// or a person whose name contains a slash would otherwise silently create an extra
// folder level and scatter the archive.
export function treePath(row, fromDate) {
  const date = rowDate(row, fromDate);
  const w = isoWeek(date);
  const month = safeFilename(monthFolder(date));
  const week = safeFilename(w.week ? `Week ${w.week} (${w.start}-${w.end})` : 'Undated');
  // display_name, when the report carries a rename for this person, exactly as
  // the web files the folder under displayName(row). The sheets and the PDFs
  // still print the real employee_name — also as the web does.
  const who = safeFilename((row && (row.display_name || row.employee_name)) || 'Unassigned');
  return `${month}/${week}/${who}`;
}

// The rows a download should contain, after the Download-options dialog.
//
// Pure and exported so it can be tested, because the web's equivalent is a
// cautionary tale: `_isoWeek` is defined TWICE there, the later object-returning
// version wins, and the dialog then compares that object to another object with
// `===`. It never matches, so the web's "A week" download quietly returns zero
// rows. Same algorithm here, with a key that can actually be equal.
//
// Every clause NARROWS. `rows` is already the screen's filtered, trimmed,
// searched set, and nothing here can widen it — so a download is always a subset
// of what the person was looking at.
export function selectDownloadRows(rows, opts = {}, fromDate = '') {
  let out = rows || [];
  const d = opts || {};
  if (d.scope === 'employee' && (d.employeeIds || []).length) {
    out = out.filter((r) => d.employeeIds.includes(r.employee_id));
  }
  if (d.period === 'day' && d.day) {
    out = out.filter((r) => rowDate(r, fromDate) === d.day);
  } else if (d.period === 'week' && d.week) {
    out = out.filter((r) => {
      const w = isoWeek(rowDate(r, fromDate));
      return `${w.year}-${w.week}` === d.week;
    });
  } else if (d.period === 'month' && d.month) {
    out = out.filter((r) => rowDate(r, fromDate).slice(0, 7) === d.month);
  }
  if (d.workedOnly) out = out.filter((r) => (r.time_worked_seconds || 0) > 0);
  if (d.sort) {
    const by = {
      name: (a, b) => (a.kpi_name || '').localeCompare(b.kpi_name || ''),
      kra: (a, b) => (a.kra_path || '').localeCompare(b.kra_path || ''),
      employee: (a, b) => (a.employee_name || '').localeCompare(b.employee_name || ''),
      time: (a, b) => (b.time_worked_seconds || 0) - (a.time_worked_seconds || 0),
      // Undated rows last, not first, where they would push the real deadlines
      // out of view.
      deadline: (a, b) => (a.deadline || '9999-12-31').localeCompare(b.deadline || '9999-12-31'),
    }[d.sort];
    // Copy first: the caller's array is memoised, and sorting in place would
    // reorder the table under the person downloading.
    if (by) out = [...out].sort(by);
  }
  return out;
}

// The key the dialog stores for "a week", and the one selectDownloadRows
// compares against. A string, deliberately — see the note above.
export const weekKey = (ymd) => {
  const w = isoWeek(ymd);
  return w.week ? `${w.year}-${w.week}` : '';
};

// Group rows into projects, exactly as the ZIP does on the web.
export function groupByProject(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const key = r.sub_kra && r.sub_kra !== '-' ? r.sub_kra : (r.root_kra || r.kra_path || 'Project');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

// ── ctx ────────────────────────────────────────────────────────────────────
// Everything the documents need about the report, so no builder reaches for
// component state:
//   { rows, fromDate, toDate, applied: { kra_name, employee_name,
//     task_type_name, task_state_name }, search, removedCount }

const applied = (ctx, key, fallback) => (ctx.applied && ctx.applied[key]) || fallback;

// jsPDF hands back "data:application/pdf;filename=…;base64,XXXX"; everything
// downstream wants only the payload.
function docToB64(doc) {
  const uri = doc.output('datauristring');
  return uri.slice(uri.indexOf(',') + 1);
}

// ── The full report, as a jsPDF doc ────────────────────────────────────────
// Returns the DOC, not bytes, so the ZIP embeds exactly the document the
// standalone button produces rather than a second one that can drift.
export function buildFullReportPdf(ctx) {
  const rows = ctx.rows || [];
  const doc = new jsPDF('l', 'mm', 'a4');   // landscape: eight columns

  const filterSearch = ctx.search ? ` | Search: "${ctx.search}"` : '';
  // A trimmed report must never be mistaken for a complete one.
  const trimmed = ctx.removedCount ? ` | ${ctx.removedCount} rows removed` : '';

  doc.setFillColor(52, 58, 64);
  doc.rect(0, 0, 297, 25, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18);
  doc.setFont(undefined, 'bold');
  doc.text('KRA Report', 14, 15);

  doc.setFontSize(10);
  doc.setFont(undefined, 'normal');
  doc.text(`Generated: ${new Date().toLocaleString()}`, 200, 10);
  doc.text(`Period: ${ctx.fromDate} to ${ctx.toDate}`, 200, 15);
  doc.text(`KRA: ${applied(ctx, 'kra_name', 'All KRAs')} | Employee: ${applied(ctx, 'employee_name', 'All Employees')}${filterSearch}`, 200, 20);
  doc.text(`Type: ${applied(ctx, 'task_type_name', 'All Types')}`
    + ` | State: ${applied(ctx, 'task_state_name', 'All States')}${trimmed}`, 200, 25);

  doc.setTextColor(0, 0, 0);
  doc.setFontSize(11);
  doc.setFont(undefined, 'bold');
  doc.text('Summary', 14, 35);

  doc.setFontSize(9);
  doc.setFont(undefined, 'normal');
  doc.text(`Total Tasks: ${rows.length}`, 14, 40);
  doc.text(`Total Time Worked: ${totalTimeWorked(rows)}`, 100, 40);
  doc.text(`Employees: ${uniqueEmployeeCount(rows)}`, 200, 40);

  // ---- Section A: project-wise summary ----
  doc.setFontSize(11);
  doc.setFont(undefined, 'bold');
  doc.text('Project-wise Summary', 14, 50);

  const summary = projectSummary(rows);
  const summaryRows = summary.map((g, i) => [
    i + 1, kraPathForPdf(g.kra_path), g.task_count,
    g.employees || `${g.employee_count}`, g.total_display,
  ]);
  summaryRows.push([
    '-', 'GRAND TOTAL',
    summary.reduce((s, g) => s + g.task_count, 0),
    uniqueEmployeeCount(rows), totalTimeWorked(rows),
  ]);

  doc.autoTable({
    head: [['#', 'KRA Hierarchy Path', 'Tasks', 'Employees', 'Total Time']],
    body: summaryRows,
    startY: 53,
    styles: { fontSize: 9, cellPadding: 3, overflow: 'linebreak' },
    headStyles: { fillColor: [33, 136, 56], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [240, 248, 240] },
    columnStyles: {
      0: { cellWidth: 12, halign: 'center', overflow: 'visible' },
      2: { cellWidth: 18, halign: 'right' },
      4: { cellWidth: 30, halign: 'right' },
    },
    didParseCell: (cd) => {
      if (cd.row.index === summaryRows.length - 1) {
        cd.cell.styles.fillColor = [236, 240, 241];
        cd.cell.styles.fontStyle = 'bold';
      }
    },
  });

  const detailStartY = (doc.lastAutoTable && doc.lastAutoTable.finalY ? doc.lastAutoTable.finalY : 53) + 10;
  doc.setFontSize(11);
  doc.setFont(undefined, 'bold');
  doc.text('Task-wise Details', 14, detailStartY - 2);

  // ---- Section B: task-level detail ----
  const data = rows.map((row, index) => [
    index + 1, kraPathForPdf(row.kra_path), row.sub_kra, row.kpi_name,
    row.employee_name, row.task_type || '-', row.task_state_label || '-',
    row.time_worked_display,
  ]);
  data.push([
    '-', 'TOTAL', '-', `${rows.length} Tasks`,
    `${uniqueEmployeeCount(rows)} Employees`, '-', '-', totalTimeWorked(rows),
  ]);

  doc.autoTable({
    head: [['#', 'KRA Hierarchy Path', 'Sub KRA', 'Task Name', 'Employee', 'Type', 'State', 'Time Worked']],
    body: data,
    startY: detailStartY,
    styles: { fontSize: 9, cellPadding: 3, overflow: 'linebreak' },
    headStyles: { fillColor: [52, 58, 64], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [245, 245, 245] },
    columnStyles: {
      0: { cellWidth: 12, halign: 'center', overflow: 'visible' },  // # — never wrap a serial
      5: { cellWidth: 16, halign: 'center' },                        // Type
      7: { cellWidth: 24, halign: 'right' },                         // Time
    },
    didParseCell: (cd) => {
      if (cd.row.index === data.length - 1) {
        cd.cell.styles.fillColor = [236, 240, 241];
        cd.cell.styles.fontStyle = 'bold';
        return;
      }
      // Type column, coloured to match the badges. Body rows only — the header
      // keeps the table's own dark fill.
      if (cd.section === 'body' && cd.column.index === 5) {
        const raw = cd.cell.raw;
        if (raw && raw !== '-') {
          const st = typeStyle(raw);
          cd.cell.styles.fillColor = st.rgb;
          cd.cell.styles.textColor = st.text;
          cd.cell.styles.fontStyle = 'bold';
        }
      }
    },
  });

  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setTextColor(150, 150, 150);
    doc.setFontSize(8);
    doc.text('Generated by KRA/KPI Management System', 14, 200);
    doc.text(`Page ${i} of ${pageCount}`, 260, 200);
  }
  return doc;
}

// ── One project's summary PDF ──────────────────────────────────────────────
export function buildProjectSummaryPdfB64(ctx, projectKey, projectRows) {
  const doc = new jsPDF('p', 'mm', 'a4');

  doc.setFillColor(33, 136, 56);
  doc.rect(0, 0, 210, 24, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(15);
  doc.setFont(undefined, 'bold');
  doc.text(kraPathForPdf(projectKey), 14, 12);
  doc.setFontSize(9);
  doc.setFont(undefined, 'normal');
  doc.text(`Period: ${ctx.fromDate || ''}  to  ${ctx.toDate || ''}`, 14, 19);

  const userTotals = new Map();
  let totalSec = 0;
  for (const row of projectRows) {
    totalSec += row.time_worked_seconds || 0;
    for (const ub of (row.user_breakdown || [])) {
      userTotals.set(ub.user_name, (userTotals.get(ub.user_name) || 0) + (ub.seconds || 0));
    }
  }

  doc.setTextColor(0, 0, 0);
  doc.setFontSize(10);
  doc.text(`Total tasks: ${projectRows.length}`, 14, 32);
  doc.text(`Total time: ${fmtHM(totalSec)}`, 80, 32);
  doc.text(`Contributors: ${userTotals.size}`, 145, 32);

  doc.autoTable({
    head: [['Contributor', 'Time Worked', 'Share']],
    body: Array.from(userTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, sec]) => [name, fmtHM(sec), `${((sec * 100) / (totalSec || 1)).toFixed(1)}%`]),
    startY: 38,
    styles: { fontSize: 9, cellPadding: 2 },
    headStyles: { fillColor: [33, 136, 56], textColor: 255, fontStyle: 'bold' },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
  });

  const startY = (doc.lastAutoTable && doc.lastAutoTable.finalY ? doc.lastAutoTable.finalY : 38) + 8;
  doc.setFont(undefined, 'bold');
  doc.text('Task list', 14, startY);

  const taskBody = projectRows.map((r, i) => [
    i + 1, r.external_ref || '-', r.kpi_name, r.employee_name, r.time_worked_display,
  ]);
  taskBody.push(['', 'TOTAL', `${projectRows.length} tasks`, '', fmtHM(totalSec)]);

  doc.autoTable({
    head: [['#', 'Ref', 'Task Name', 'Primary Assignee', 'Time Worked']],
    body: taskBody,
    startY: startY + 2,
    styles: { fontSize: 8.5, cellPadding: 2, overflow: 'linebreak' },
    headStyles: { fillColor: [52, 58, 64], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [245, 245, 245] },
    // Pin only the narrow fixed-content columns and let autoTable distribute the
    // rest; hand-tuned millimetres drifted past the page edge.
    columnStyles: {
      0: { cellWidth: 12, halign: 'center', overflow: 'visible' },
      1: { cellWidth: 22 },
      4: { cellWidth: 26, halign: 'right' },
    },
    didParseCell: (cd) => {
      if (cd.row.index === taskBody.length - 1) {
        cd.cell.styles.fillColor = [236, 240, 241];
        cd.cell.styles.fontStyle = 'bold';
      }
    },
  });

  return docToB64(doc);
}

// ── One task's detail PDF ──────────────────────────────────────────────────
export function buildTaskDetailPdfB64(row) {
  const doc = new jsPDF('p', 'mm', 'a4');

  doc.setFillColor(52, 58, 64);
  doc.rect(0, 0, 210, 22, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(13);
  doc.setFont(undefined, 'bold');
  doc.text(kraPathForPdf(row.kpi_name || 'Task'), 14, 12);
  doc.setFontSize(9);
  doc.setFont(undefined, 'normal');
  doc.text(`Ref: ${row.external_ref || '-'}    State: ${row.task_state_label || row.task_state || '-'}`, 14, 18);

  doc.setTextColor(0, 0, 0);
  doc.setFontSize(10);
  doc.autoTable({
    head: [['Field', 'Value']],
    body: [
      ['KRA Hierarchy', kraPathForPdf(row.kra_path || '')],
      ['Sub-KRA', row.sub_kra || '-'],
      ['External Ref', row.external_ref || '-'],
      ['Type', row.task_type || '-'],
      ['Priority', row.priority || '-'],
      ['Task State', row.task_state_label || row.task_state || '-'],
      ['Deadline', row.deadline || '-'],
      ['Primary Assignee', row.employee_name || '-'],
      ['Total Time Worked', row.time_worked_display || '0h 0m'],
    ],
    startY: 28,
    styles: { fontSize: 9.5, cellPadding: 2.5 },
    headStyles: { fillColor: [52, 58, 64], textColor: 255, fontStyle: 'bold' },
    // Label pinned, value auto — a long KRA path can never push past the margin.
    columnStyles: { 0: { cellWidth: 50, fontStyle: 'bold' } },
  });

  const yStart = (doc.lastAutoTable && doc.lastAutoTable.finalY ? doc.lastAutoTable.finalY : 28) + 8;
  doc.setFont(undefined, 'bold');
  doc.setFontSize(11);
  doc.text('Who worked on this task', 14, yStart);

  const ub = row.user_breakdown || [];
  const totalSec = ub.reduce((s, u) => s + (u.seconds || 0), 0) || (row.time_worked_seconds || 1);
  const body = ub.map((u, i) => [
    i + 1, u.user_name, u.display, `${((u.seconds * 100) / totalSec).toFixed(1)}%`,
  ]);
  if (!body.length) {
    body.push(['-', row.employee_name || 'Unassigned', row.time_worked_display, '100.0%']);
  }

  doc.autoTable({
    head: [['#', 'User', 'Time Logged', 'Share of task']],
    body,
    startY: yStart + 2,
    styles: { fontSize: 9.5, cellPadding: 2.5 },
    headStyles: { fillColor: [33, 136, 56], textColor: 255, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 12, halign: 'center', overflow: 'visible' },
      2: { cellWidth: 38, halign: 'right' },
      3: { cellWidth: 38, halign: 'right' },
    },
  });

  return docToB64(doc);
}

// ── Workbooks ──────────────────────────────────────────────────────────────

function scopeLineOf(ctx) {
  return `Period ${ctx.fromDate} to ${ctx.toDate}`
    + ` | KRA: ${applied(ctx, 'kra_name', 'All KRAs')}`
    + ` | Employee: ${applied(ctx, 'employee_name', 'All Employees')}`
    + ` | Type: ${applied(ctx, 'task_type_name', 'All Types')}`
    + ` | State: ${applied(ctx, 'task_state_name', 'All States')}`
    + (ctx.search ? ` | Search: "${ctx.search}"` : '')
    + (ctx.removedCount ? ` | ${ctx.removedCount} rows removed` : '');
}

// Shared by the main workbook and every per-project workbook, so their colours,
// widths, freeze and filter cannot drift apart.
//
// It counts employees and seconds from THE ROWS IT WAS HANDED rather than from
// the whole report — the web version originally called the report-wide helpers,
// which printed the wrong TOTAL on every per-project sheet.
function writeTaskDetailsSheet(sheet, rows, scopeLine) {
  sheet.columns = [{ width: 6 }, { width: 46 }, { width: 24 }, { width: 44 },
    { width: 20 }, { width: 10 }, { width: 26 }, { width: 14 }, { width: 14 }];

  sheet.addRow([scopeLine]).font = { italic: true, color: { argb: 'FF6C757D' } };
  const header = paintHeader(sheet.addRow(['#', 'KRA Hierarchy Path', 'Sub KRA', 'Task Name',
    'Employee', 'Type', 'State', 'Total Hours', 'Time Worked']));
  const TYPE_COL = 6;

  const employees = new Set();
  let seconds = 0;
  rows.forEach((row, index) => {
    const added = sheet.addRow([
      index + 1, row.kra_path, row.sub_kra, row.kpi_name, row.employee_name,
      row.task_type || '-', row.task_state_label || '-',
      row.time_worked_hours, row.time_worked_display,
    ]);
    paintBand(added, index, BAND_FILL);
    added.getCell(8).numFmt = '0.00';
    // Set AFTER the band so the badge colour wins on striped rows.
    if (row.task_type) {
      const st = typeStyle(row.task_type);
      const cell = added.getCell(TYPE_COL);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: st.argb } };
      cell.font = { bold: true, color: { argb: st.fg } };
      cell.alignment = { horizontal: 'center' };
    }
    if (row.employee_id) employees.add(row.employee_id);
    seconds += (row.time_worked_seconds || 0);
  });

  const total = paintTotal(sheet.addRow(['', 'TOTAL', '', `${rows.length} Tasks`,
    `${employees.size} Employees`, '', '', +(seconds / 3600).toFixed(2), fmtHM(seconds)]));
  total.getCell(8).numFmt = '0.00';

  // Header only: two frozen rows can swallow the viewport on a small window.
  sheet.views = [{ state: 'frozen', ySplit: header.number }];
  sheet.autoFilter = {
    from: { row: header.number, column: 1 },
    to: { row: header.number, column: 9 },
  };
  return sheet;
}

// TWO sheets, not one stacked sheet: the summary table has 7 columns and the
// detail table 9, and a worksheet carries a single set of column widths.
export function buildWorkbook(ctx) {
  const rows = ctx.rows || [];
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'KRA / KPI Management System';
  workbook.created = new Date();

  const totalHours = +(totalSeconds(rows) / 3600).toFixed(2);
  const scope = scopeLineOf(ctx);

  const s1 = workbook.addWorksheet('Summary');
  s1.columns = [{ width: 6 }, { width: 52 }, { width: 10 }, { width: 12 },
    { width: 46 }, { width: 14 }, { width: 16 }];

  s1.addRow(['KRA Report']).font = { bold: true, size: 14 };
  s1.addRow([`Period: ${ctx.fromDate} to ${ctx.toDate}`]);
  s1.addRow([`KRA: ${applied(ctx, 'kra_name', 'All KRAs')}`]);
  s1.addRow([`Employee: ${applied(ctx, 'employee_name', 'All Employees')}`]);
  s1.addRow([`Type: ${applied(ctx, 'task_type_name', 'All Types')}`
    + ` | State: ${applied(ctx, 'task_state_name', 'All States')}`]);
  s1.addRow([`Total Tasks: ${rows.length}`
    + ` | Total Time Worked: ${totalTimeWorked(rows)}`
    + ` | Employees: ${uniqueEmployeeCount(rows)}`]).font = { bold: true };
  if (ctx.search) s1.addRow([`Search: "${ctx.search}"`]);
  if (ctx.removedCount) {
    s1.addRow([`${ctx.removedCount} rows removed from this report`]).font = { bold: true };
  }
  // The task rows live on the other tab, and that tab gets missed — say so, with
  // the count, so this sheet cannot be taken for the whole report.
  s1.addRow([`-> Task-wise details (${rows.length} rows) are on the "Task Details" tab`])
    .font = { bold: true, color: { argb: HEAD_FILL } };
  s1.addRow([]);

  const s1Header = paintHeader(s1.addRow(['#', 'KRA Hierarchy Path', 'Tasks',
    'Employees', 'Employee Names', 'Total Hours', 'Total Time']), HEAD_FILL_SUMMARY);

  const summary = projectSummary(rows);
  summary.forEach((g, i) => {
    const row = s1.addRow([i + 1, g.kra_path, g.task_count, g.employee_count,
      g.employees, g.total_hours, g.total_display]);
    paintBand(row, i, BAND_FILL_SUMMARY);
    row.getCell(6).numFmt = '0.00';
  });
  const s1Total = paintTotal(s1.addRow(['', 'GRAND TOTAL',
    summary.reduce((s, g) => s + g.task_count, 0),
    uniqueEmployeeCount(rows), '', totalHours, totalTimeWorked(rows)]));
  s1Total.getCell(6).numFmt = '0.00';
  s1.views = [{ state: 'frozen', ySplit: s1Header.number }];

  writeTaskDetailsSheet(workbook.addWorksheet('Task Details'), rows, scope);
  return workbook;
}

export function buildProjectWorkbook(ctx, projectName, projectRows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'KRA / KPI Management System';
  workbook.created = new Date();
  writeTaskDetailsSheet(
    workbook.addWorksheet(safeSheetName(projectName)),
    projectRows,
    `${projectName} - ${ctx.fromDate} to ${ctx.toDate}`,
  );
  return workbook;
}

// ── Deliverables: base64 + a filename, ready for the caller to save ────────

export function makeReportPdf(ctx) {
  return {
    filename: `KRA_Report_${ctx.fromDate}_to_${ctx.toDate}.pdf`,
    mimeType: 'application/pdf',
    data_b64: docToB64(buildFullReportPdf(ctx)),
  };
}

export async function makeReportExcel(ctx) {
  const buf = await buildWorkbook(ctx).xlsx.writeBuffer();
  return {
    filename: `KRA_Report_${ctx.fromDate}_to_${ctx.toDate}.xlsx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    data_b64: Buffer.from(buf).toString('base64'),
  };
}

// `include` picks the FLAVOUR of the archive, not merely extras: asking for Excel
// used to still bury one workbook under 400+ per-task PDFs.
//
// `onStep(done, total)` reports progress — a few hundred per-task PDFs takes far
// longer on a phone than in a browser, and a frozen screen reads as a crash.
export async function makeReportZip(ctx, include = {}, onStep) {
  const rows = ctx.rows || [];
  if (!rows.length) throw new Error('No tasks to export.');

  const groups = groupByProject(rows);
  const zip = new JSZip();
  const fromLabel = ctx.fromDate || 'all';
  const toLabel = ctx.toDate || 'all';

  // Counted so the caller's bar means something: a whole-report file, then per
  // project a summary plus one per task, for each flavour asked for.
  let total = 0;
  if (include.pdf) total += 1 + groups.size + rows.length;
  if (include.excel) total += 1 + groups.size;
  let done = 0;
  const step = () => { done += 1; onStep && onStep(done, total); };

  if (include.pdf) {
    zip.file(`KRA_Report_${fromLabel}_to_${toLabel}_full.pdf`,
      docToB64(buildFullReportPdf(ctx)), { base64: true });
    step();

    // One summary PDF per project, at the archive ROOT where it can be found
    // without walking into the tree.
    for (const [projectName, projectRows] of groups.entries()) {
      zip.file(`${safeFilename(projectName)}.pdf`,
        buildProjectSummaryPdfB64(ctx, projectName, projectRows), { base64: true });
      step();
    }

    // Per-task PDFs go into Month / Week / User rather than one folder per
    // project. A month of work under a single project folder is a flat list of
    // hundreds of files; this is how people actually look for them — whose work,
    // which week. The serial is global rather than per-project, so two tasks
    // landing in the same week folder cannot both come out as "001".
    let seq = 0;
    for (const r of rows) {
      seq += 1;
      const refPart = r.external_ref ? `${r.external_ref} ` : `${String(seq).padStart(3, '0')} `;
      // A hand-added row exists in this report and nowhere else — say so on the
      // file, so nobody goes looking for the task behind it. Same tag as the web.
      const localTag = r.is_local ? ' (report only)' : '';
      zip.folder(treePath(r, ctx.fromDate))
        .file(`${safeFilename(refPart + (r.kpi_name || 'task') + localTag)}.pdf`,
          buildTaskDetailPdfB64(r), { base64: true });
      step();
    }
  }

  if (include.excel) {
    // Uint8Array, not Blob: JSZip's Blob path leans on browser internals RN does
    // not have, and a partial polyfill is accepted silently and then written as
    // an empty entry.
    zip.file(`KRA_Report_${fromLabel}_to_${toLabel}_full.xlsx`,
      new Uint8Array(await buildWorkbook(ctx).xlsx.writeBuffer()));
    step();

    for (const [projectName, projectRows] of groups.entries()) {
      const buf = await buildProjectWorkbook(ctx, projectName, projectRows).xlsx.writeBuffer();
      zip.file(`${safeFilename(projectName)}.xlsx`, new Uint8Array(buf));
      step();
    }
  }

  return {
    filename: `KRA_Report_${fromLabel}_to_${toLabel}.zip`,
    mimeType: 'application/zip',
    data_b64: await zip.generateAsync({ type: 'base64', compression: 'DEFLATE' }),
  };
}
