const {
  HISTORY_FILTERS, filterHistory, historyDate, historyDayLabel, groupHistoryByDay,
} = require('../taskHistory');

// Shaped like /kpi_action/history on the test server (newest first, UTC).
const ITEMS = [
  { kind: 'activity', at: '2026-10-26 09:00:00', title: 'Final approved', key: 'a1' },
  { kind: 'progress', at: '2026-10-26 08:00:00', title: 'Progress update', key: 'p1' },
  { kind: 'meeting', at: '2026-10-25 10:00:00', title: 'Meeting · Demo', key: 'm1' },
  { kind: 'question', at: '2026-10-20 10:00:00', title: 'Question', key: 'd1' },
  { kind: 'code', at: '2026-10-20 09:00:00', title: 'GitHub branch linked', key: 'g1' },
  { kind: 'document', at: '2026-10-20 08:00:00', title: 'Manual uploaded', key: 'u1' },
];

describe('filterHistory', () => {
  it('has the web filters in order', () => {
    expect(HISTORY_FILTERS.map((f) => f.label)).toEqual(['All', 'Questions', 'Progress', 'Meetings', 'Code', 'Documents', 'Activity']);
  });
  it('All is the work only — the activity trail is its own filter', () => {
    expect(filterHistory(ITEMS, 'all').map((i) => i.key)).toEqual(['p1', 'm1', 'd1', 'g1', 'u1']);
    expect(filterHistory(ITEMS, 'activity').map((i) => i.key)).toEqual(['a1']);
    expect(filterHistory(ITEMS, 'code').map((i) => i.key)).toEqual(['g1']);
    expect(filterHistory(ITEMS, 'nope').length).toBe(5);
    expect(filterHistory(null, 'all')).toEqual([]);
  });
});

describe('days', () => {
  it('reads the server UTC stamp', () => {
    expect(historyDate('2026-10-26 08:00:00').toISOString()).toBe('2026-10-26T08:00:00.000Z');
    expect(historyDate('')).toBe(null);
    expect(historyDate('junk')).toBe(null);
  });
  it('labels today and yesterday by the phone day', () => {
    const now = new Date(2026, 9, 26, 15, 0, 0);
    expect(historyDayLabel(new Date(2026, 9, 26, 1, 0, 0), now)).toBe('Today');
    expect(historyDayLabel(new Date(2026, 9, 25, 23, 0, 0), now)).toBe('Yesterday');
    expect(historyDayLabel(new Date(2026, 9, 20, 12, 0, 0), now)).toMatch(/20 Oct 2026/);
    expect(historyDayLabel(null, now)).toBe('No date');
  });
  it('groups consecutive items of one day, keeping their order', () => {
    const now = new Date(Date.UTC(2026, 9, 26, 12, 0, 0));
    const days = groupHistoryByDay(filterHistory(ITEMS, 'all'), now);
    expect(days.map((d) => d.items.map((i) => i.key))).toEqual([['p1'], ['m1'], ['d1', 'g1', 'u1']]);
    expect(groupHistoryByDay([], now)).toEqual([]);
  });
});
