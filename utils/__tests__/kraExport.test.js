// The KRA Report's documents, which the app builds itself.
//
// These are a port of the Odoo web builders, and the thing that makes a port
// dangerous is that it LOOKS right — a workbook with the wrong totals on one tab
// still opens cleanly, and a ZIP with the wrong contents still unzips. So these
// tests assert on the bytes: what is inside the archive, and what the numbers on
// a per-project sheet actually say.
//
// Two of them pin bugs the web version shipped and then fixed, which are exactly
// the bugs a port re-introduces:
//   - "Excel pack" burying one workbook under hundreds of per-task PDFs
//   - a per-project sheet printing the WHOLE report's totals

const ExcelJS = require('exceljs');
const JSZip = require('jszip');

const {
  makeReportPdf, makeReportExcel, makeReportZip,
  buildProjectWorkbook, projectSummary, totalTimeWorked, uniqueEmployeeCount,
  safeFilename, typeStyle, groupByProject,
} = require('../kraExport');

// Two projects, three tasks, two employees — the smallest shape that can expose
// a per-project total that has quietly borrowed the whole report's figures.
const ROWS = [
  {
    id: 1, kra_id: 10, kra_path: 'Nexgenn > Restaurant > App', root_kra: 'Nexgenn',
    sub_kra: 'App', kra_level: 2, kpi_name: 'Login screen', external_ref: 'REQ-001',
    task_type: 'REQ', task_state: 'completed', task_state_label: 'Completed',
    priority: 'regular', deadline: '2026-09-01', employee_id: 3, employee_name: 'Ravi',
    time_worked_seconds: 3600, time_worked_hours: 1.0, time_worked_display: '1h 0m',
    user_breakdown: [{ user_id: 3, user_name: 'Ravi', seconds: 3600, hours: 1.0, display: '1h 0m' }],
  },
  {
    id: 2, kra_id: 10, kra_path: 'Nexgenn > Restaurant > App', root_kra: 'Nexgenn',
    sub_kra: 'App', kra_level: 2, kpi_name: 'Signup screen', external_ref: 'BUG-002',
    task_type: 'BUG', task_state: 'in_progress', task_state_label: 'In Progress',
    priority: 'urgent', deadline: '', employee_id: 4, employee_name: 'Priya',
    time_worked_seconds: 1800, time_worked_hours: 0.5, time_worked_display: '0h 30m',
    user_breakdown: [{ user_id: 4, user_name: 'Priya', seconds: 1800, hours: 0.5, display: '0h 30m' }],
  },
  {
    id: 3, kra_id: 20, kra_path: 'Acme > Portal', root_kra: 'Acme',
    sub_kra: 'Portal', kra_level: 1, kpi_name: 'Invoice export', external_ref: 'UPT-003',
    task_type: 'UPT', task_state: 'paused', task_state_label: 'Paused',
    priority: 'important', deadline: '2026-09-20', employee_id: 3, employee_name: 'Ravi',
    time_worked_seconds: 7200, time_worked_hours: 2.0, time_worked_display: '2h 0m',
    user_breakdown: [{ user_id: 3, user_name: 'Ravi', seconds: 7200, hours: 2.0, display: '2h 0m' }],
  },
];

const CTX = {
  rows: ROWS,
  fromDate: '2026-09-01',
  toDate: '2026-09-09',
  applied: {
    kra_name: 'All KRAs', employee_name: 'All Employees',
    task_type_name: 'All Types', task_state_name: 'All States',
  },
  search: '',
  removedCount: 0,
};

const b64ToBuf = (b) => Buffer.from(b, 'base64');

describe('pure derivations', () => {
  it('totals and employee counts ignore repeats', () => {
    // Ravi appears on two rows; two distinct employees, not three.
    expect(uniqueEmployeeCount(ROWS)).toBe(2);
    expect(totalTimeWorked(ROWS)).toBe('3h 30m');
  });

  it('groups by KRA path, sorted, with per-project totals', () => {
    const s = projectSummary(ROWS);
    expect(s.map((g) => g.kra_path)).toEqual(['Acme > Portal', 'Nexgenn > Restaurant > App']);
    expect(s[0]).toMatchObject({ task_count: 1, employee_count: 1, total_display: '2h 0m', total_hours: 2 });
    expect(s[1]).toMatchObject({ task_count: 2, employee_count: 2, total_display: '1h 30m', total_hours: 1.5 });
  });

  it('groups the ZIP by sub-KRA, falling back when there is none', () => {
    expect([...groupByProject(ROWS).keys()].sort()).toEqual(['App', 'Portal']);
    // '-' is the server's "task hangs off a root" marker, not a project name.
    const rootOnly = [{ ...ROWS[0], sub_kra: '-', root_kra: 'Nexgenn' }];
    expect([...groupByProject(rootOnly).keys()]).toEqual(['Nexgenn']);
  });

  it('strips characters that are illegal in a filename', () => {
    expect(safeFilename('a/b:c*d?e"f<g>h|i')).toBe('a-b-c-d-e-f-g-h-i');
    expect(safeFilename('')).toBe('untitled');
  });

  it('uses Odoo theme colours for the type badge, not Bootstrap defaults', () => {
    // Odoo repaints .bg-primary as its own purple; #0D6EFD here would mean the
    // palette was taken from Bootstrap and every REQ badge would be wrong.
    expect(typeStyle('REQ').argb).toBe('FF71639E');
    expect(typeStyle('req').argb).toBe('FF71639E');
    expect(typeStyle('nonsense').argb).toBe('FFDEE2E6');
  });
});

describe('PDF', () => {
  it('produces a real PDF with the dates in its name', () => {
    const out = makeReportPdf(CTX);
    // The web shipped `KRA_Report__to_.pdf` for a while — the template
    // placeholders had been dropped. Pin the name, not just the bytes.
    expect(out.filename).toBe('KRA_Report_2026-09-01_to_2026-09-09.pdf');
    expect(out.mimeType).toBe('application/pdf');
    expect(b64ToBuf(out.data_b64).slice(0, 4).toString()).toBe('%PDF');
  });
});

describe('Excel', () => {
  it('writes two tabs, because the two tables have different column counts', async () => {
    const out = await makeReportExcel(CTX);
    expect(out.filename).toBe('KRA_Report_2026-09-01_to_2026-09-09.xlsx');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(b64ToBuf(out.data_b64));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Task Details']);
  });

  it('points at the other tab, with the row count', async () => {
    // The Task Details tab has been missed more than once; the Summary sheet must
    // not be forwardable as if it were the whole report.
    const out = await makeReportExcel(CTX);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(b64ToBuf(out.data_b64));
    const text = [];
    wb.getWorksheet('Summary').eachRow((r) => text.push(String(r.getCell(1).value || '')));
    expect(text.some((t) => t.includes('Task-wise details (3 rows)'))).toBe(true);
    expect(text.some((t) => t.includes('Total Tasks: 3') && t.includes('3h 30m'))).toBe(true);
  });

  it('freezes the header and filters the detail table', async () => {
    const out = await makeReportExcel(CTX);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(b64ToBuf(out.data_b64));
    const sh = wb.getWorksheet('Task Details');
    // Row 1 is the scope line, row 2 the header — freezing below the header, so
    // there is always something left to scroll.
    expect(sh.views[0]).toMatchObject({ state: 'frozen', ySplit: 2 });
    // Written as {from,to} but serialised into the file as a range string, which
    // is what comes back on load: row 2, columns A..I — all nine.
    expect(sh.autoFilter).toBe('A2:I2');
  });

  it('paints the type badge over the zebra stripe, not under it', async () => {
    const out = await makeReportExcel(CTX);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(b64ToBuf(out.data_b64));
    const sh = wb.getWorksheet('Task Details');
    // Row 3 is the first data row; column 6 is Type.
    expect(sh.getRow(3).getCell(6).fill.fgColor.argb).toBe(typeStyle('REQ').argb);
    // Row 4 is a striped row AND a BUG — the badge must still win.
    expect(sh.getRow(4).getCell(6).fill.fgColor.argb).toBe(typeStyle('BUG').argb);
  });

  it("a per-project sheet totals ITS OWN rows, not the whole report", async () => {
    // The bug the web fixed: the shared sheet writer used the report-wide helpers,
    // so a single-project sheet printed 3 tasks / 3h 30m / 2 employees.
    const appRows = ROWS.filter((r) => r.sub_kra === 'App');
    const buf = await buildProjectWorkbook(CTX, 'App', appRows).xlsx.writeBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(buf));
    const sh = wb.worksheets[0];
    const totalRow = sh.getRow(sh.rowCount);
    expect(totalRow.getCell(2).value).toBe('TOTAL');
    expect(totalRow.getCell(4).value).toBe('2 Tasks');
    expect(totalRow.getCell(5).value).toBe('2 Employees');
    expect(totalRow.getCell(9).value).toBe('1h 30m');
  });

  it('truncates a sheet name to what Excel accepts', async () => {
    const long = 'A very long project name that Excel will simply refuse to open';
    const buf = await buildProjectWorkbook(CTX, long, ROWS).xlsx.writeBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(buf));
    expect(wb.worksheets[0].name.length).toBeLessThanOrEqual(31);
  });
});

describe('ZIP', () => {
  it('the Excel pack carries NO per-task PDFs', async () => {
    // The actual bug: the menu only chose which whole-report file rode along, so
    // "Excel only" produced one workbook buried under a PDF per task.
    const out = await makeReportZip(CTX, { excel: true });
    const zip = await JSZip.loadAsync(out.data_b64, { base64: true });
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    expect(names.some((n) => n.endsWith('.pdf'))).toBe(false);
    expect(names).toContain('KRA_Report_2026-09-01_to_2026-09-09_full.xlsx');
    // One workbook per project, alongside the whole-report one.
    expect(names).toContain('App.xlsx');
    expect(names).toContain('Portal.xlsx');
    expect(names).toHaveLength(3);
  });

  it('the PDF pack carries the full report, a summary per project, and one PDF per task', async () => {
    const out = await makeReportZip(CTX, { pdf: true });
    const zip = await JSZip.loadAsync(out.data_b64, { base64: true });
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    expect(names.some((n) => n.endsWith('.xlsx'))).toBe(false);
    expect(names).toContain('KRA_Report_2026-09-01_to_2026-09-09_full.pdf');
    expect(names).toContain('App.pdf');
    expect(names).toContain('App/REQ-001 Login screen.pdf');
    expect(names).toContain('App/BUG-002 Signup screen.pdf');
    expect(names).toContain('Portal/UPT-003 Invoice export.pdf');
    // 1 full + 2 project summaries + 3 task PDFs
    expect(names).toHaveLength(6);
  });

  it('both packs together carry both, and every entry is real', async () => {
    const out = await makeReportZip(CTX, { pdf: true, excel: true });
    expect(out.filename).toBe('KRA_Report_2026-09-01_to_2026-09-09.zip');
    expect(out.mimeType).toBe('application/zip');

    const zip = await JSZip.loadAsync(out.data_b64, { base64: true });
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    expect(names).toHaveLength(9);

    // Not just present — actually the file type they claim to be. A Blob handed
    // to JSZip under React Native writes a silently EMPTY entry.
    for (const name of names) {
      const buf = await zip.file(name).async('nodebuffer');
      expect(buf.length).toBeGreaterThan(0);
      const magic = name.endsWith('.pdf') ? '%PDF' : 'PK';
      expect(buf.slice(0, magic.length).toString()).toBe(magic);
    }
  });

  it('reports progress so a few hundred task PDFs do not look like a hang', async () => {
    const steps = [];
    await makeReportZip(CTX, { pdf: true, excel: true }, (done, total) => steps.push([done, total]));
    expect(steps[0][1]).toBe(9);              // 1+2+3 pdf, 1+2 excel
    expect(steps[steps.length - 1]).toEqual([9, 9]);
  });

  it('refuses an empty report rather than writing an empty archive', async () => {
    await expect(makeReportZip({ ...CTX, rows: [] }, { pdf: true })).rejects.toThrow('No tasks');
  });

  it('names a task PDF by serial when it has no ref', async () => {
    const noRef = [{ ...ROWS[0], external_ref: '' }];
    const out = await makeReportZip({ ...CTX, rows: noRef }, { pdf: true });
    const zip = await JSZip.loadAsync(out.data_b64, { base64: true });
    expect(Object.keys(zip.files)).toContain('App/001 Login screen.pdf');
  });
});
