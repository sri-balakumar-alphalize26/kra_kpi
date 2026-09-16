// What the Live Tracking widget says, given the route's payload.
//
// A widget has no error state anybody can read. If this picks the wrong people or
// loses the counts, the result is a blank-looking card on an admin's home screen
// and nothing, anywhere, says why — so the decisions are pinned here.

const { shapeLiveTracking, signedOutState } = require('../liveTrackingWidgetState');

// One row in the shape /kpi_owner/live_tracking sends.
const person = (over = {}) => ({
  user_id: 1, name: 'Ravi', attendance: 'present', arrival: '09:20',
  started: true, active: false, activity_kind: 'idle', activity_label: '',
  elapsed_seconds: 0, elapsed_display: '', ...over,
});

const payload = (over = {}) => ({
  status: true, as_of: '09:41', total: 4,
  present_count: 3, active_count: 2, absent_count: 1,
  rows: [], ...over,
});

describe('the counts line', () => {
  it('reads "3/4 present · 2 active"', () => {
    const s = shapeLiveTracking(payload({ rows: [person()] }));
    expect(s.ok).toBe(true);
    expect(s.summary).toBe('3/4 present · 2 active');
    expect(s.as_of).toBe('09:41');
  });

  it('drops the active half rather than saying "0 active"', () => {
    // Early morning, nobody started yet. "0 active" on a home screen reads as a
    // failure; saying only what is true does not.
    const s = shapeLiveTracking(payload({ active_count: 0, rows: [person()] }));
    expect(s.summary).toBe('3/4 present');
  });
});

describe('who gets the three rows', () => {
  it('puts people actually working first', () => {
    const s = shapeLiveTracking(payload({
      rows: [
        person({ name: 'Absent', attendance: 'absent', started: false, activity_kind: 'offline' }),
        person({ name: 'Idle' }),
        person({ name: 'Working', active: true, activity_kind: 'task',
          activity_label: 'Fix login bug', elapsed_display: '3h 4min' }),
      ],
    }));
    expect(s.rows.map((r) => r.name)).toEqual(['Working', 'Idle', 'Absent']);
  });

  it('ranks someone on a break above someone who never started', () => {
    const s = shapeLiveTracking(payload({
      rows: [
        person({ name: 'NeverStarted', started: false, attendance: 'absent' }),
        person({ name: 'OnBreak', activity_kind: 'break', activity_label: 'Break',
          elapsed_display: '15 min' }),
      ],
    }));
    expect(s.rows[0].name).toBe('OnBreak');
  });

  it('keeps the server order among equals, so it does not reshuffle between refreshes', () => {
    const rows = ['A', 'B', 'C'].map((n) => person({ name: n }));
    expect(shapeLiveTracking(payload({ rows })).rows.map((r) => r.name))
      .toEqual(['A', 'B', 'C']);
  });

  it('shows three and counts the rest as more', () => {
    const rows = ['A', 'B', 'C', 'D', 'E'].map((n) => person({ name: n }));
    const s = shapeLiveTracking(payload({ rows }));
    expect(s.rows).toHaveLength(3);
    expect(s.more).toBe(2);
  });
});

describe('what each row says', () => {
  it('uses the server wording when there is any', () => {
    const s = shapeLiveTracking(payload({
      rows: [person({ active: true, activity_kind: 'task',
        activity_label: 'Fix login bug', elapsed_display: '3h 4min' })],
    }));
    expect(s.rows[0]).toMatchObject({ what: 'Fix login bug', time: '3h 4min' });
  });

  it('says "Day ended" for someone who finished, even with a stale label', () => {
    const s = shapeLiveTracking(payload({
      rows: [person({ day_done: true, activity_label: 'Fix login bug' })],
    }));
    expect(s.rows[0].what).toBe('Day ended');
  });

  it('fills the blank the server leaves for idle and offline rows', () => {
    const idle = shapeLiveTracking(payload({ rows: [person()] }));
    expect(idle.rows[0].what).toBe('Idle');

    const off = shapeLiveTracking(payload({
      rows: [person({ started: false, attendance: 'absent', activity_kind: 'offline' })],
    }));
    expect(off.rows[0].what).toBe('Absent');
  });

  it('shows no elapsed time next to someone who is not working', () => {
    // A duration beside "Absent" invites the reader to believe it means something.
    const s = shapeLiveTracking(payload({
      rows: [person({ attendance: 'absent', started: false, activity_kind: 'offline',
        elapsed_display: '3h 4min' })],
    }));
    expect(s.rows[0].time).toBe('');
  });
});

describe('the states that must not look like a bug', () => {
  it('says so when the route refused', () => {
    const s = shapeLiveTracking({ status: false, message: 'nope' });
    expect(s.ok).toBe(false);
    expect(s.message).toBeTruthy();
    expect(s.rows).toEqual([]);
  });

  it('says so when there is no payload at all', () => {
    expect(shapeLiveTracking(null).ok).toBe(false);
    expect(shapeLiveTracking(undefined).ok).toBe(false);
  });

  it('says so when the team list is empty, rather than drawing an empty card', () => {
    const s = shapeLiveTracking(payload({ rows: [] }));
    expect(s.ok).toBe(false);
    expect(s.message).toMatch(/Nobody/i);
  });

  it('has a signed-out state that carries no team data', () => {
    const s = signedOutState();
    expect(s.ok).toBe(false);
    expect(s.rows).toEqual([]);
    expect(s.message).toMatch(/Sign in/i);
  });
});
