// Calendar maths for the hand-rolled date pickers.
//
// Deliberately dependency-free: the app ships no date library (no dayjs, no
// date-fns, no @react-native-community/datetimepicker) and adding one to render
// a month grid is not worth the install size or the native-module risk.
//
// Pure functions, no React — so the fiddly parts (leap years, month lengths,
// week alignment) can be unit-tested without rendering anything.

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Monday-first, NOT Sunday-first. This has to agree with presetRange('this_week')
// in the screens, which computes the week start as (getDay() + 6) % 7. A
// Sunday-first grid would put the highlighted "This Week" range one column out.
export const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** Date -> 'YYYY-MM-DD' in LOCAL time. */
export function fmtYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 'YYYY-MM-DD' -> Date at local midnight, or null if unparseable.
 *
 * Explicitly NOT `new Date(str)`: the ES spec parses a bare date-only string as
 * UTC, so east of Greenwich `new Date('2026-07-30')` is the 29th at 19:00 local
 * and the grid highlights the wrong day. Building from parts keeps it local.
 */
export function parseYMD(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || '').trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const out = new Date(y, mo - 1, d);
  // Rejects real-looking but impossible dates (2026-02-30 would roll into
  // March). Comparing back is cheaper than special-casing leap years.
  if (out.getFullYear() !== y || out.getMonth() !== mo - 1 || out.getDate() !== d) return null;
  return out;
}

/**
 * Cells for one month, Monday-first.
 *
 * Returns leading blanks ({ day: null }) so the 1st lands under its weekday,
 * then one cell per day. No trailing blanks — the grid wraps, so they would
 * only add empty rows.
 */
export function monthGrid(year, month) {
  const cells = [];
  // getDay() is 0=Sunday; +6 %7 rotates it to 0=Monday.
  const lead = (new Date(year, month, 1).getDay() + 6) % 7;
  for (let i = 0; i < lead; i++) cells.push({ key: `blank-${i}`, day: null, iso: '' });
  // Day 0 of the NEXT month is the last day of this one — avoids a leap-year table.
  const days = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= days; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ key: iso, day: d, iso });
  }
  return cells;
}

/** Step a {year, month} cursor, rolling the year over. `month` is 0-based. */
export function shiftMonth(year, month, delta) {
  const total = year * 12 + month + delta;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

/** 'July 2026' — built from MONTH_NAMES, not toLocaleDateString, so the label
 *  does not change with the device locale while the ISO values stay en-US. */
export function monthTitle(year, month) {
  return `${MONTH_NAMES[month]} ${year}`;
}
