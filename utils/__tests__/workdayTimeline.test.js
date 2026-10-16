const {
  buildWorkdayTimeline, parseTs, fmtDuration, IDLE_MIN_MINUTES,
} = require('../workdayTimeline');

// A developer in IST (UTC+5:30): the server sends `time` in IST and *_ts in UTC.
// 09:30 IST = 04:00 UTC.
const day = [
  { kind: 'start', time: '09:30', ts: '2026-10-16 04:00:00' },
  { kind: 'task', task_id: 1, name: 'Login fix', ref: 'REQ-012', outcome: 'worked',
    time: '09:30-11:05', start_ts: '2026-10-16 04:00:00', end_ts: '2026-10-16 05:35:00',
    seconds: 5700, running: false, visit: 1 },
  // 11:05 → 11:25 nothing running (20 min idle), then Payment API.
  { kind: 'task', task_id: 2, name: 'Payment API', ref: 'REQ-020', outcome: 'paused',
    reason: 'waiting on keys', time: '11:25-12:40', start_ts: '2026-10-16 05:55:00',
    end_ts: '2026-10-16 07:10:00', seconds: 4500, running: false, visit: 1 },
  { kind: 'break', break_type: 'lunch', time: '12:40-13:20', start_ts: '2026-10-16 07:10:00',
    end_ts: '2026-10-16 07:50:00', seconds: 2400, running: false, reason: 'canteen' },
  { kind: 'task', task_id: 2, name: 'Payment API', ref: 'REQ-020', outcome: 'active',
    time: '13:20-', start_ts: '2026-10-16 07:50:00', end_ts: '', seconds: 1800,
    running: true, visit: 2 },
  { kind: 'end', label: 'Still working', time: '', ts: '' },
];
const NOW = parseTs('2026-10-16 08:20:00'); // 13:50 IST

describe('workdayTimeline', () => {
  it('parses server timestamps as UTC and formats durations', () => {
    expect(parseTs('2026-10-16 04:00:00')).toBe(Date.UTC(2026, 9, 16, 4, 0, 0));
    expect(parseTs('')).toBeNull();
    expect(fmtDuration(30)).toBe('<1m');
    expect(fmtDuration(2400)).toBe('40m');
    expect(fmtDuration(5700)).toBe('1h 35m');
    expect(fmtDuration(7200)).toBe('2h');
  });

  it('lays cards and the links between them in time order, in the developer\'s clock', () => {
    const t = buildWorkdayTimeline(day, NOW);
    expect(t.empty).toBe(false);
    expect(t.live).toBe(true);
    expect(t.startLabel).toBe('09:30');
    const kinds = t.items.map((i) => i.type);
    expect(kinds).toEqual(['card', 'link', 'card', 'link', 'card', 'link', 'card']);
    const cards = t.items.filter((i) => i.type === 'card');
    expect(cards.map((c) => [c.title, c.startLabel, c.endLabel, c.durationLabel])).toEqual([
      ['Login fix', '09:30', '11:05', '1h 35m'],
      ['Payment API', '11:25', '12:40', '1h 15m'],
      ['Lunch', '12:40', '13:20', '40m'],
      ['Payment API', '13:20', '', '30m'],
    ]);
    expect(cards[3].running).toBe(true);
    expect(cards[3].visitLabel).toBe('2nd time today');
    expect(cards[1].outcomeLabel).toBe('Paused');
  });

  it('says what changed, with idle time and what came next', () => {
    const links = buildWorkdayTimeline(day, NOW).items.filter((i) => i.type === 'link');
    expect(links[0].short).toBe('Idle 20m · Moved from Login fix to Payment API');
    expect(links[0].long).toContain('11:25 · Moved from Login fix to Payment API');
    expect(links[0].long).toContain('nothing running for 20m');
    expect(links[0].long).toContain('next: Lunch at 12:40');
    expect(links[1].short).toBe('Paused Payment API for lunch');
    expect(links[1].long).toContain('“canteen”');
    expect(links[2].short).toBe('Back from lunch to Payment API');
    expect(links[2].long).toContain('still going');
  });

  it('draws the day to scale, marks idle gaps and only legends what is there', () => {
    const t = buildWorkdayTimeline(day, NOW);
    const idle = t.strip.filter((s) => s.cat === 'idle');
    expect(idle).toHaveLength(1);
    expect(idle[0].label).toBe('Idle 20m (11:05–11:25)');
    // 09:30 → 13:50 is 260 min; Login fix is 95 of them.
    const login = t.strip.find((s) => s.label.startsWith('Login fix'));
    expect(login.leftPct).toBeCloseTo(0);
    expect(login.widthPct).toBeCloseTo((95 / 260) * 100, 1);
    expect(t.legend.map((l) => l.cat)).toEqual(['work', 'lunch', 'idle']);
    expect(t.ticks.map((k) => k.label)).toEqual(['10', '11', '12', '13']);
  });

  it('ignores gaps under the idle threshold', () => {
    const short = day.map((n) => (n.task_id === 2 && n.visit === 1
      ? { ...n, start_ts: '2026-10-16 05:37:00' } : n));
    const t = buildWorkdayTimeline(short, NOW);
    expect(IDLE_MIN_MINUTES).toBe(5);
    expect(t.strip.some((s) => s.cat === 'idle')).toBe(false);
    expect(t.items[1].short).toBe('Moved from Login fix to Payment API');
  });

  it('handles an ended day, a finished task and an empty day', () => {
    const ended = [
      { kind: 'start', time: '09:00', ts: '2026-10-16 03:30:00' },
      { kind: 'task', task_id: 1, name: 'A', outcome: 'completed', time: '09:00-10:00',
        start_ts: '2026-10-16 03:30:00', end_ts: '2026-10-16 04:30:00', seconds: 3600 },
      { kind: 'task', task_id: 2, name: 'B', outcome: 'worked', time: '10:00-11:00',
        start_ts: '2026-10-16 04:30:00', end_ts: '2026-10-16 05:30:00', seconds: 3600 },
      { kind: 'end', time: '11:00', ts: '2026-10-16 05:30:00' },
    ];
    const t = buildWorkdayTimeline(ended, NOW);
    expect(t.live).toBe(false);
    expect(t.endLabel).toBe('11:00');
    expect(t.items[1].short).toBe('Finished A, started B');
    expect(buildWorkdayTimeline([], NOW).empty).toBe(true);
    expect(buildWorkdayTimeline(null, NOW).empty).toBe(true);
  });
});
