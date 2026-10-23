import {
  fmtYMD, parseYMD, monthGrid, shiftMonth, monthTitle, WEEKDAY_LABELS,
} from '../dateGrid';

describe('fmtYMD', () => {
  it('zero-pads month and day', () => {
    expect(fmtYMD(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('formats in local time, not UTC', () => {
    // 23:30 local on the 30th must stay the 30th. Using toISOString() here
    // would report the 31st (or the 29th) depending on the offset.
    expect(fmtYMD(new Date(2026, 6, 30, 23, 30))).toBe('2026-07-30');
  });
});

describe('parseYMD', () => {
  it('builds a local-midnight Date', () => {
    const d = parseYMD('2026-07-30');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6);
    expect(d.getDate()).toBe(30);
    expect(d.getHours()).toBe(0);
  });

  it('does not shift the day across timezones', () => {
    // The bug this guards: new Date('2026-07-30') parses as UTC midnight, which
    // is the 29th anywhere east of Greenwich.
    expect(fmtYMD(parseYMD('2026-07-30'))).toBe('2026-07-30');
  });

  it('round-trips every day of a leap February', () => {
    for (let d = 1; d <= 29; d++) {
      const iso = `2024-02-${String(d).padStart(2, '0')}`;
      expect(fmtYMD(parseYMD(iso))).toBe(iso);
    }
  });

  it('rejects malformed and impossible dates', () => {
    ['', null, undefined, 'not-a-date', '2026-7-30', '30-07-2026', '2026-13-01',
     '2026-00-10', '2026-02-30', '2023-02-29'].forEach((bad) => {
      expect(parseYMD(bad)).toBeNull();
    });
  });

  it('accepts a valid leap day', () => {
    expect(parseYMD('2024-02-29')).not.toBeNull();
  });
});

describe('monthGrid', () => {
  const days = (cells) => cells.filter((c) => c.day !== null);
  const blanks = (cells) => cells.filter((c) => c.day === null);

  it('is Monday-first: a month starting on Monday has no leading blanks', () => {
    // 1 June 2026 is a Monday.
    expect(blanks(monthGrid(2026, 5))).toHaveLength(0);
  });

  it('is Monday-first: a month starting on Sunday has six leading blanks', () => {
    // 1 February 2026 is a Sunday — the last column in a Monday-first week.
    // A Sunday-first grid would produce 0 here, which is the alignment bug.
    expect(blanks(monthGrid(2026, 1))).toHaveLength(6);
  });

  it('puts the 1st directly after the leading blanks', () => {
    const cells = monthGrid(2026, 6); // July 2026 starts on a Wednesday
    expect(blanks(cells)).toHaveLength(2);
    expect(cells[2]).toMatchObject({ day: 1, iso: '2026-07-01' });
  });

  it.each([
    ['31-day', 2026, 0, 31],
    ['30-day', 2026, 3, 30],
    ['28-day February', 2026, 1, 28],
    ['29-day leap February', 2024, 1, 29],
    ['century non-leap February', 1900, 1, 28],
    ['400-year leap February', 2000, 1, 29],
  ])('counts %s months correctly', (_label, y, m, expected) => {
    expect(days(monthGrid(y, m))).toHaveLength(expected);
  });

  it('emits contiguous days with matching ISO strings', () => {
    const cells = days(monthGrid(2026, 6));
    cells.forEach((c, i) => {
      expect(c.day).toBe(i + 1);
      expect(c.iso).toBe(`2026-07-${String(i + 1).padStart(2, '0')}`);
      expect(c.key).toBe(c.iso);
    });
  });

  it('gives every cell a unique key, blanks included', () => {
    const cells = monthGrid(2026, 1); // six leading blanks
    expect(new Set(cells.map((c) => c.key)).size).toBe(cells.length);
  });

  it('aligns each day under its real weekday', () => {
    // Column index in a Monday-first week must match the JS weekday.
    const cells = monthGrid(2026, 6);
    cells.forEach((c, i) => {
      if (!c.day) return;
      const jsDow = new Date(2026, 6, c.day).getDay();  // 0=Sun
      expect(i % 7).toBe((jsDow + 6) % 7);
    });
  });
});

describe('shiftMonth', () => {
  it('steps within a year', () => {
    expect(shiftMonth(2026, 5, 1)).toEqual({ year: 2026, month: 6 });
    expect(shiftMonth(2026, 5, -1)).toEqual({ year: 2026, month: 4 });
  });

  it('rolls the year over in both directions', () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
  });

  it('handles multi-year jumps', () => {
    expect(shiftMonth(2026, 0, -14)).toEqual({ year: 2024, month: 10 });
    expect(shiftMonth(2026, 6, 30)).toEqual({ year: 2029, month: 0 });
  });

  it('never returns a month outside 0-11', () => {
    for (let d = -40; d <= 40; d++) {
      const { month } = shiftMonth(2026, 5, d);
      expect(month).toBeGreaterThanOrEqual(0);
      expect(month).toBeLessThanOrEqual(11);
    }
  });
});

describe('monthTitle', () => {
  it('names the month and year', () => {
    expect(monthTitle(2026, 6)).toBe('July 2026');
    expect(monthTitle(2026, 0)).toBe('January 2026');
  });
});

describe('WEEKDAY_LABELS', () => {
  it('has seven entries starting on Monday', () => {
    expect(WEEKDAY_LABELS).toHaveLength(7);
    expect(WEEKDAY_LABELS[0]).toBe('M');
    expect(WEEKDAY_LABELS[6]).toBe('S');
  });
});
