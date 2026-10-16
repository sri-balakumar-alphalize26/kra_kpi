/* KRA report exports — a port of the Odoo kpi_kra_report builders, so the
   PDF, the two-sheet workbook and the ZIP pack come out the same as Odoo's.

   Every builder takes the rows to print plus `ctx`:
     { from, to, applied: {kra_name, employee_name, task_type_name, task_state_name},
       search, removedCount }
   Rows must already carry the report's display names (renames applied). */
import { loadExcel, loadPdf, loadZip } from "./exportLibs";

/* Requirement / Update / Bug badge palette (Odoo's compiled backend colours). */
const TYPE_STYLES = {
  REQ: { rgb: [113, 99, 158], text: [255, 255, 255], argb: "FF71639E", fg: "FFFFFFFF" },
  UPT: { rgb: [255, 193, 7], text: [0, 0, 0], argb: "FFFFC107", fg: "FF000000" },
  UPD: { rgb: [255, 193, 7], text: [0, 0, 0], argb: "FFFFC107", fg: "FF000000" },
  BUG: { rgb: [220, 53, 69], text: [255, 255, 255], argb: "FFDC3545", fg: "FFFFFFFF" },
};
const TYPE_STYLE_DEFAULT = { rgb: [222, 226, 230], text: [33, 37, 41], argb: "FFDEE2E6", fg: "FF212529" };
export const typeStyle = (t) => TYPE_STYLES[(t || "").toUpperCase()] || TYPE_STYLE_DEFAULT;

const HEAD_FILL = "FF343A40";
const HEAD_FILL_SUMMARY = "FF218838";
const BAND_FILL = "FFF5F5F5";
const BAND_FILL_SUMMARY = "FFF0F8F0";
const TOTAL_FILL = "FFECF0F1";

function paintHeader(row, fill = HEAD_FILL) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  return row;
}
function paintBand(row, index, fill) {
  if (index % 2 === 1) row.eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } }; });
  return row;
}
function paintTotal(row) {
  row.eachCell((cell) => { cell.font = { bold: true }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTAL_FILL } }; });
  return row;
}

export const fmtSec = (sec) => `${Math.floor((sec || 0) / 3600)}h ${Math.floor(((sec || 0) % 3600) / 60)}m`;
const pdfPath = (p) => String(p || "").replace(/→/g, ">");
export const safeFilename = (s) => String(s || "untitled").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 120);
const safeSheetName = (name) => String(name || "").replace(/[[\]:*?/\\]/g, "-").trim().slice(0, 31) || "Tasks";

export const totalSeconds = (rows) => rows.reduce((s, r) => s + (r.time_worked_seconds || 0), 0);
export const uniqueEmployees = (rows) => new Set(rows.map((r) => r.employee_id).filter(Boolean)).size;

/* Rows grouped by KRA path (the KRA Summary on screen, and the PDF/Excel summary). */
export function projectSummary(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const key = row.kra_path || row.sub_kra || "Unassigned";
    if (!buckets.has(key)) buckets.set(key, { kra_path: key, root_kra: row.root_kra || "", sub_kra: row.sub_kra || "", task_count: 0, total_seconds: 0, employees: new Set() });
    const b = buckets.get(key);
    b.task_count += 1;
    b.total_seconds += row.time_worked_seconds || 0;
    if (row.employee_name) b.employees.add(row.employee_name);
  }
  return [...buckets.values()].map((b) => ({
    kra_path: b.kra_path, root_kra: b.root_kra, sub_kra: b.sub_kra, task_count: b.task_count,
    employee_count: b.employees.size, employees: [...b.employees].sort().join(", "),
    total_seconds: b.total_seconds, total_hours: +(b.total_seconds / 3600).toFixed(2), total_display: fmtSec(b.total_seconds),
  })).sort((a, b) => a.kra_path.localeCompare(b.kra_path));
}

/* ---------------- PDF ---------------- */

function fullReportPdf(P, rows, ctx) {
  const doc = P.make("l", "mm", "a4");
  const a = ctx.applied || {};
  const filterSearch = ctx.search ? ` | Search: "${ctx.search}"` : "";
  const trimmed = ctx.removedCount ? ` | ${ctx.removedCount} rows removed` : "";
  const totalTime = fmtSec(totalSeconds(rows));
  const emps = uniqueEmployees(rows);

  doc.setFillColor(52, 58, 64); doc.rect(0, 0, 297, 25, "F");
  doc.setTextColor(255, 255, 255); doc.setFontSize(18); doc.setFont(undefined, "bold");
  doc.text("KRA Report", 14, 15);
  doc.setFontSize(10); doc.setFont(undefined, "normal");
  doc.text(`Generated: ${new Date().toLocaleString()}`, 200, 10);
  doc.text(`Period: ${ctx.from} to ${ctx.to}`, 200, 15);
  doc.text(`KRA: ${a.kra_name || "All KRAs"} | Employee: ${a.employee_name || "All Employees"}${filterSearch}`, 200, 20);
  doc.text(`Type: ${a.task_type_name || "All Types"} | State: ${a.task_state_name || "All States"}${trimmed}`, 200, 25);

  doc.setTextColor(0, 0, 0); doc.setFontSize(11); doc.setFont(undefined, "bold");
  doc.text("Summary", 14, 35);
  doc.setFontSize(9); doc.setFont(undefined, "normal");
  doc.text(`Total Tasks: ${rows.length}`, 14, 40);
  doc.text(`Total Time Worked: ${totalTime}`, 100, 40);
  doc.text(`Employees: ${emps}`, 200, 40);

  doc.setFontSize(11); doc.setFont(undefined, "bold");
  doc.text("Project-wise Summary", 14, 50);
  const ps = projectSummary(rows);
  const summaryRows = ps.map((g, i) => [i + 1, pdfPath(g.kra_path), g.task_count, g.employees || `${g.employee_count}`, g.total_display]);
  summaryRows.push(["-", "GRAND TOTAL", ps.reduce((s, g) => s + g.task_count, 0), emps, totalTime]);
  doc.autoTable({
    head: [["#", "KRA Hierarchy Path", "Tasks", "Employees", "Total Time"]], body: summaryRows, startY: 53,
    styles: { fontSize: 9, cellPadding: 3, overflow: "linebreak" },
    headStyles: { fillColor: [33, 136, 56], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [240, 248, 240] },
    columnStyles: { 0: { cellWidth: 12, halign: "center", overflow: "visible" }, 2: { cellWidth: 18, halign: "right" }, 4: { cellWidth: 30, halign: "right" } },
    didParseCell: (cd) => { if (cd.row.index === summaryRows.length - 1) { cd.cell.styles.fillColor = [236, 240, 241]; cd.cell.styles.fontStyle = "bold"; } },
  });

  const detailStartY = (doc.lastAutoTable?.finalY || 53) + 10;
  doc.setFontSize(11); doc.setFont(undefined, "bold");
  doc.text("Task-wise Details", 14, detailStartY - 2);
  const data = rows.map((row, i) => [i + 1, pdfPath(row.kra_path), row.sub_kra, row.kpi_name, row.employee_name, row.task_type || "-", row.task_state_label || "-", row.time_worked_display]);
  data.push(["-", "TOTAL", "-", `${rows.length} Tasks`, `${emps} Employees`, "-", "-", totalTime]);
  doc.autoTable({
    head: [["#", "KRA Hierarchy Path", "Sub KRA", "Task Name", "Employee", "Type", "State", "Time Worked"]], body: data, startY: detailStartY,
    styles: { fontSize: 9, cellPadding: 3, overflow: "linebreak" },
    headStyles: { fillColor: [52, 58, 64], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [245, 245, 245] },
    columnStyles: { 0: { cellWidth: 12, halign: "center", overflow: "visible" }, 5: { cellWidth: 16, halign: "center" }, 7: { cellWidth: 24, halign: "right" } },
    didParseCell: (cd) => {
      if (cd.row.index === data.length - 1) { cd.cell.styles.fillColor = [236, 240, 241]; cd.cell.styles.fontStyle = "bold"; return; }
      if (cd.section === "body" && cd.column.index === 5) {
        const raw = cd.cell.raw;
        if (raw && raw !== "-") { const st = typeStyle(raw); cd.cell.styles.fillColor = st.rgb; cd.cell.styles.textColor = st.text; cd.cell.styles.fontStyle = "bold"; }
      }
    },
  });

  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i); doc.setTextColor(150, 150, 150); doc.setFontSize(8);
    doc.text("Generated by KRA/KPI Management System", 14, 200);
    doc.text(`Page ${i} of ${pages}`, 260, 200);
  }
  return doc;
}

function projectSummaryPdf(P, projectKey, projectRows, ctx) {
  const doc = P.make("p", "mm", "a4");
  doc.setFillColor(33, 136, 56); doc.rect(0, 0, 210, 24, "F");
  doc.setTextColor(255, 255, 255); doc.setFontSize(15); doc.setFont(undefined, "bold");
  doc.text(pdfPath(projectKey), 14, 12);
  doc.setFontSize(9); doc.setFont(undefined, "normal");
  doc.text(`Period: ${ctx.from || ""}  to  ${ctx.to || ""}`, 14, 19);

  const userTotals = new Map();
  let totalSec = 0;
  for (const row of projectRows) {
    totalSec += row.time_worked_seconds || 0;
    for (const ub of row.user_breakdown || []) userTotals.set(ub.user_name, (userTotals.get(ub.user_name) || 0) + (ub.seconds || 0));
  }
  doc.setTextColor(0, 0, 0); doc.setFontSize(10);
  doc.text(`Total tasks: ${projectRows.length}`, 14, 32);
  doc.text(`Total time: ${fmtSec(totalSec)}`, 80, 32);
  doc.text(`Contributors: ${userTotals.size}`, 145, 32);
  doc.autoTable({
    head: [["Contributor", "Time Worked", "Share"]],
    body: [...userTotals.entries()].sort((a, b) => b[1] - a[1]).map(([name, sec]) => [name, fmtSec(sec), ((sec * 100) / (totalSec || 1)).toFixed(1) + "%"]),
    startY: 38, styles: { fontSize: 9, cellPadding: 2 },
    headStyles: { fillColor: [33, 136, 56], textColor: 255, fontStyle: "bold" },
    columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } },
  });
  const startY = (doc.lastAutoTable?.finalY || 38) + 8;
  doc.setFont(undefined, "bold");
  doc.text("Task list", 14, startY);
  const taskBody = projectRows.map((r, i) => [i + 1, r.external_ref || "-", r.kpi_name, r.employee_name, r.time_worked_display]);
  taskBody.push(["", "TOTAL", `${projectRows.length} tasks`, "", fmtSec(totalSec)]);
  doc.autoTable({
    head: [["#", "Ref", "Task Name", "Primary Assignee", "Time Worked"]], body: taskBody, startY: startY + 2,
    styles: { fontSize: 8.5, cellPadding: 2, overflow: "linebreak" },
    headStyles: { fillColor: [52, 58, 64], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [245, 245, 245] },
    columnStyles: { 0: { cellWidth: 12, halign: "center", overflow: "visible" }, 1: { cellWidth: 22 }, 4: { cellWidth: 26, halign: "right" } },
    didParseCell: (cd) => { if (cd.row.index === taskBody.length - 1) { cd.cell.styles.fillColor = [236, 240, 241]; cd.cell.styles.fontStyle = "bold"; } },
  });
  return doc.output("arraybuffer");
}

function taskDetailPdf(P, row) {
  const doc = P.make("p", "mm", "a4");
  doc.setFillColor(52, 58, 64); doc.rect(0, 0, 210, 22, "F");
  doc.setTextColor(255, 255, 255); doc.setFontSize(13); doc.setFont(undefined, "bold");
  doc.text(pdfPath(row.kpi_name || "Task"), 14, 12);
  doc.setFontSize(9); doc.setFont(undefined, "normal");
  doc.text(`Ref: ${row.external_ref || "-"}    State: ${row.task_state_label || row.task_state || "-"}`, 14, 18);
  doc.setTextColor(0, 0, 0); doc.setFontSize(10);
  doc.autoTable({
    head: [["Field", "Value"]],
    body: [
      ["KRA Hierarchy", pdfPath(row.kra_path || "")], ["Sub-KRA", row.sub_kra || "-"], ["External Ref", row.external_ref || "-"],
      ["Type", row.task_type || "-"], ["Priority", row.priority || "-"], ["Task State", row.task_state_label || row.task_state || "-"],
      ["Deadline", row.deadline || "-"], ["Primary Assignee", row.employee_name || "-"], ["Total Time Worked", row.time_worked_display || "0h 0m"],
    ],
    startY: 28, styles: { fontSize: 9.5, cellPadding: 2.5 },
    headStyles: { fillColor: [52, 58, 64], textColor: 255, fontStyle: "bold" },
    columnStyles: { 0: { cellWidth: 50, fontStyle: "bold" } },
  });
  const yStart = (doc.lastAutoTable?.finalY || 28) + 8;
  doc.setFont(undefined, "bold"); doc.setFontSize(11);
  doc.text("Who worked on this task", 14, yStart);
  const ub = row.user_breakdown || [];
  const tot = ub.reduce((s, u) => s + (u.seconds || 0), 0) || row.time_worked_seconds || 1;
  const body = ub.map((u, i) => [i + 1, u.user_name, u.display, (((u.seconds || 0) * 100) / tot).toFixed(1) + "%"]);
  if (!body.length) body.push(["-", row.employee_name || "Unassigned", row.time_worked_display, "100.0%"]);
  doc.autoTable({
    head: [["#", "User", "Time Logged", "Share of task"]], body, startY: yStart + 2,
    styles: { fontSize: 9.5, cellPadding: 2.5 },
    headStyles: { fillColor: [33, 136, 56], textColor: 255, fontStyle: "bold" },
    columnStyles: { 0: { cellWidth: 12, halign: "center", overflow: "visible" }, 2: { cellWidth: 38, halign: "right" }, 3: { cellWidth: 38, halign: "right" } },
  });
  return doc.output("arraybuffer");
}

/* ---------------- Excel ---------------- */

function writeTaskDetailsSheet(sheet, rows, scopeLine) {
  sheet.columns = [{ width: 6 }, { width: 46 }, { width: 24 }, { width: 44 }, { width: 20 }, { width: 10 }, { width: 26 }, { width: 14 }, { width: 14 }];
  sheet.addRow([scopeLine]).font = { italic: true, color: { argb: "FF6C757D" } };
  const header = paintHeader(sheet.addRow(["#", "KRA Hierarchy Path", "Sub KRA", "Task Name", "Employee", "Type", "State", "Total Hours", "Time Worked"]));
  const employees = new Set();
  let seconds = 0;
  rows.forEach((row, index) => {
    const added = sheet.addRow([index + 1, row.kra_path, row.sub_kra, row.kpi_name, row.employee_name, row.task_type || "-", row.task_state_label || "-", row.time_worked_hours, row.time_worked_display]);
    paintBand(added, index, BAND_FILL);
    added.getCell(8).numFmt = "0.00";
    if (row.task_type) {
      const st = typeStyle(row.task_type);
      const cell = added.getCell(6);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: st.argb } };
      cell.font = { bold: true, color: { argb: st.fg } };
      cell.alignment = { horizontal: "center" };
    }
    if (row.employee_id) employees.add(row.employee_id);
    seconds += row.time_worked_seconds || 0;
  });
  const total = paintTotal(sheet.addRow(["", "TOTAL", "", `${rows.length} Tasks`, `${employees.size} Employees`, "", "", +(seconds / 3600).toFixed(2), fmtSec(seconds)]));
  total.getCell(8).numFmt = "0.00";
  sheet.views = [{ state: "frozen", ySplit: header.number }];
  sheet.autoFilter = { from: { row: header.number, column: 1 }, to: { row: header.number, column: 9 } };
  return sheet;
}

function fullWorkbook(ExcelJS, rows, ctx) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "KRA / KPI Management System"; wb.created = new Date();
  const a = ctx.applied || {};
  const totalTime = fmtSec(totalSeconds(rows));
  const totalHours = +(totalSeconds(rows) / 3600).toFixed(2);
  const scope = `Period ${ctx.from} to ${ctx.to}`
    + ` | KRA: ${a.kra_name || "All KRAs"} | Employee: ${a.employee_name || "All Employees"}`
    + ` | Type: ${a.task_type_name || "All Types"} | State: ${a.task_state_name || "All States"}`
    + (ctx.search ? ` | Search: "${ctx.search}"` : "") + (ctx.removedCount ? ` | ${ctx.removedCount} rows removed` : "");

  const s1 = wb.addWorksheet("Summary");
  s1.columns = [{ width: 6 }, { width: 52 }, { width: 10 }, { width: 12 }, { width: 46 }, { width: 14 }, { width: 16 }];
  s1.addRow(["KRA Report"]).font = { bold: true, size: 14 };
  s1.addRow([`Period: ${ctx.from} to ${ctx.to}`]);
  s1.addRow([`KRA: ${a.kra_name || "All KRAs"}`]);
  s1.addRow([`Employee: ${a.employee_name || "All Employees"}`]);
  s1.addRow([`Type: ${a.task_type_name || "All Types"} | State: ${a.task_state_name || "All States"}`]);
  s1.addRow([`Total Tasks: ${rows.length} | Total Time Worked: ${totalTime} | Employees: ${uniqueEmployees(rows)}`]).font = { bold: true };
  if (ctx.search) s1.addRow([`Search: "${ctx.search}"`]);
  if (ctx.removedCount) s1.addRow([`${ctx.removedCount} rows removed from this report`]).font = { bold: true };
  s1.addRow([`→ Task-wise details (${rows.length} rows) are on the "Task Details" tab`]).font = { bold: true, color: { argb: HEAD_FILL } };
  s1.addRow([]);
  const s1Header = paintHeader(s1.addRow(["#", "KRA Hierarchy Path", "Tasks", "Employees", "Employee Names", "Total Hours", "Total Time"]), HEAD_FILL_SUMMARY);
  const ps = projectSummary(rows);
  ps.forEach((g, i) => {
    const row = s1.addRow([i + 1, g.kra_path, g.task_count, g.employee_count, g.employees, g.total_hours, g.total_display]);
    paintBand(row, i, BAND_FILL_SUMMARY);
    row.getCell(6).numFmt = "0.00";
  });
  const s1Total = paintTotal(s1.addRow(["", "GRAND TOTAL", ps.reduce((s, g) => s + g.task_count, 0), uniqueEmployees(rows), "", totalHours, totalTime]));
  s1Total.getCell(6).numFmt = "0.00";
  s1.views = [{ state: "frozen", ySplit: s1Header.number }];

  writeTaskDetailsSheet(wb.addWorksheet("Task Details"), rows, scope);
  return wb;
}

function projectWorkbook(ExcelJS, projectName, projectRows, ctx) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "KRA / KPI Management System"; wb.created = new Date();
  writeTaskDetailsSheet(wb.addWorksheet(safeSheetName(projectName)), projectRows, `${projectName} — ${ctx.from} to ${ctx.to}`);
  return wb;
}

/* ---------------- ZIP folders: Month / Week / Person ---------------- */

const rowDate = (row, ctx) => (row.deadline || "").slice(0, 10) || ctx.from || "";
function isoWeekInfo(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(d.getTime())) return { year: 0, week: 0, start: "", end: "" };
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  firstThursday.setDate(firstThursday.getDate() - ((firstThursday.getDay() + 6) % 7) + 3);
  const week = 1 + Math.round((target - firstThursday) / (7 * 24 * 3600 * 1000));
  const monday = new Date(d.valueOf()); monday.setDate(monday.getDate() - dayNr);
  const sunday = new Date(monday.valueOf()); sunday.setDate(sunday.getDate() + 6);
  const dd = (x) => String(x.getDate()).padStart(2, "0");
  return { year: target.getFullYear(), week, start: dd(monday), end: dd(sunday) };
}
/* "YYYY-Www", what <input type="week"> gives back. */
export function isoWeek(dateStr) {
  const w = isoWeekInfo(dateStr);
  return w.week ? `${w.year}-W${String(w.week).padStart(2, "0")}` : "";
}
export const rowDateOf = rowDate;
function monthFolder(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(d.getTime())) return "Undated";
  return `${dateStr.slice(0, 7)} ${d.toLocaleString(undefined, { month: "long" })}`;
}
function treePath(row, ctx) {
  const date = rowDate(row, ctx);
  const w = isoWeekInfo(date);
  const month = safeFilename(monthFolder(date));
  const week = safeFilename(w.week ? `Week ${w.week} (${w.start}-${w.end})` : "Undated");
  const who = safeFilename(row.employee_name || "Unassigned");
  return `${month}/${week}/${who}`;
}

/* ---------------- public builders → { blob, fileName } ---------------- */

export async function buildKraPdf(rows, ctx) {
  const P = await loadPdf();
  return { blob: fullReportPdf(P, rows, ctx).output("blob"), fileName: `KRA_Report_${ctx.from}_to_${ctx.to}.pdf` };
}

export async function buildKraExcel(rows, ctx) {
  const ExcelJS = await loadExcel();
  const buf = await fullWorkbook(ExcelJS, rows, ctx).xlsx.writeBuffer();
  return { blob: new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), fileName: `KRA_Report_${ctx.from}_to_${ctx.to}.xlsx` };
}

/* include: {pdf, excel} — which flavour of pack. */
export async function buildKraZip(rows, ctx, include = {}) {
  const JSZip = await loadZip();
  const groups = new Map();
  for (const r of rows) {
    const key = r.sub_kra && r.sub_kra !== "-" ? r.sub_kra : (r.root_kra || r.kra_path || "Project");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const zip = new JSZip();
  const fromLabel = ctx.from || "all", toLabel = ctx.to || "all";
  if (include.pdf) {
    const P = await loadPdf();
    zip.file(`KRA_Report_${fromLabel}_to_${toLabel}_full.pdf`, fullReportPdf(P, rows, ctx).output("arraybuffer"));
    for (const [name, pr] of groups.entries()) zip.file(`${safeFilename(name)}.pdf`, projectSummaryPdf(P, name, pr, ctx));
    let seq = 0;
    for (const r of rows) {
      seq += 1;
      const refPart = r.external_ref ? `${r.external_ref} ` : `${String(seq).padStart(3, "0")} `;
      const fname = safeFilename(refPart + (r.kpi_name || "task") + (r.is_local ? " (report only)" : "")) + ".pdf";
      zip.folder(treePath(r, ctx)).file(fname, taskDetailPdf(P, r));
    }
  }
  if (include.excel) {
    const ExcelJS = await loadExcel();
    zip.file(`KRA_Report_${fromLabel}_to_${toLabel}_full.xlsx`, await fullWorkbook(ExcelJS, rows, ctx).xlsx.writeBuffer());
    for (const [name, pr] of groups.entries()) zip.file(`${safeFilename(name)}.xlsx`, await projectWorkbook(ExcelJS, name, pr, ctx).xlsx.writeBuffer());
  }
  /* Built as bytes and wrapped here: JSZip's own Blob output depends on the bundle. */
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const blob = new Blob([bytes], { type: "application/zip" });
  return { blob, fileName: `KRA_Report_${fromLabel}_to_${toLabel}.zip` };
}
