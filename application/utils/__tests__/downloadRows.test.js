// The Download-options row selection.
//
// Worth its own tests because the web's equivalent is broken in a way no one
// would see from reading it: `_isoWeek` is defined twice there, the later
// object-returning version wins, and the dialog compares that object to another
// object with `===`. It never matches, so the web's "A week" download silently
// returns zero rows and hands you an empty report. These pin that the app's
// version actually selects something, and that every clause narrows rather than
// widens.

const { selectDownloadRows, weekKey } = require('../kraExport');

// A row's date is its DEADLINE, falling back to the report's from_date — the
// rule rowDate() has always used and the ZIP files its folders by. Row 2 carries
// none, so it exercises that fallback here as well.
//
// 2026-08-31 is a Monday: 08-31 and 09-01 share an ISO week, 09-07 is the next.
const ROWS = [
  {
    id: 1, kpi_name: 'Beta task', kra_path: 'Z > deep', employee_id: 3, employee_name: 'Ravi',
    time_worked_seconds: 3600, deadline: '2026-09-01',
  },
  {
    id: 2, kpi_name: 'Alpha task', kra_path: 'A > shallow', employee_id: 4, employee_name: 'Priya',
    time_worked_seconds: 0, deadline: '',            // → falls back to 2026-08-31
  },
  {
    id: 3, kpi_name: 'Gamma task', kra_path: 'M > middle', employee_id: 3, employee_name: 'Ravi',
    time_worked_seconds: 1800, deadline: '2026-09-07',
  },
];
const ids = (rows) => rows.map((r) => r.id);

describe('selectDownloadRows', () => {
  test('no options changes nothing', () => {
    expect(ids(selectDownloadRows(ROWS, {}, '2026-08-31'))).toEqual([1, 2, 3]);
  });

  test('a week actually selects rows — the bug the web still has', () => {
    const key = weekKey('2026-08-31');
    expect(key).toBeTruthy();
    const got = selectDownloadRows(ROWS, { period: 'week', week: key }, '2026-08-31');
    // Monday 08-31 and Tuesday 09-01 are the same ISO week; 09-07 is the next.
    expect(ids(got)).toEqual([1, 2]);
  });

  test('a day and a month each narrow to their own rows', () => {
    expect(ids(selectDownloadRows(ROWS, { period: 'day', day: '2026-09-01' }, '2026-08-31'))).toEqual([1]);
    // Row 2 has no deadline, so it files under the report's from_date — August.
    expect(ids(selectDownloadRows(ROWS, { period: 'month', month: '2026-09' }, '2026-08-31'))).toEqual([1, 3]);
    expect(ids(selectDownloadRows(ROWS, { period: 'month', month: '2026-08' }, '2026-08-31'))).toEqual([2]);
  });

  test('who narrows to the chosen people', () => {
    const got = selectDownloadRows(ROWS, { scope: 'employee', employeeIds: [3] }, '2026-08-31');
    expect(ids(got)).toEqual([1, 3]);
    // scope 'employee' with nobody chosen must not silently empty the report.
    expect(ids(selectDownloadRows(ROWS, { scope: 'employee', employeeIds: [] }, '2026-08-31'))).toEqual([1, 2, 3]);
  });

  test('worked-only drops the zero row', () => {
    expect(ids(selectDownloadRows(ROWS, { workedOnly: true }, '2026-08-31'))).toEqual([1, 3]);
  });

  test('sorting reorders without mutating the caller', () => {
    const before = ids(ROWS);
    expect(ids(selectDownloadRows(ROWS, { sort: 'name' }, '2026-08-31'))).toEqual([2, 1, 3]);
    expect(ids(selectDownloadRows(ROWS, { sort: 'kra' }, '2026-08-31'))).toEqual([2, 3, 1]);
    expect(ids(selectDownloadRows(ROWS, { sort: 'time' }, '2026-08-31'))).toEqual([1, 3, 2]);
    // Undated deadlines sort LAST, not first where they would bury the real ones.
    expect(ids(selectDownloadRows(ROWS, { sort: 'deadline' }, '2026-08-31'))).toEqual([1, 3, 2]);
    expect(ids(ROWS)).toEqual(before);
  });

  test('clauses combine, and every one of them narrows', () => {
    const got = selectDownloadRows(
      ROWS, { scope: 'employee', employeeIds: [3], workedOnly: true, sort: 'time' }, '2026-08-31',
    );
    expect(ids(got)).toEqual([1, 3]);
    expect(got.length).toBeLessThanOrEqual(ROWS.length);
  });
});
