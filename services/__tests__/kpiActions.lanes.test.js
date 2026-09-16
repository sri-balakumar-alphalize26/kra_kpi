// The board's lane model, and specifically the one lane that breaks the model's
// central assumption: `today`.
//
// Every other lane owns its tasks — a task is in exactly one of them, which is
// what laneForTask means and what every count on the board relies on. Today is a
// SECOND membership laid over that: the same task, in two places, on purpose.
// These tests pin the three things that can quietly go wrong as a result —
// tasks vanishing from their real lane, counts inflating, and the lane failing
// to empty when the server stops reporting today.
//
// The network layer is mocked out because none of it is exercised here: LANES,
// laneForTask, isTodayTask and groupIntoLanes are pure, and importing the module
// would otherwise drag session storage and the RPC client in with them.
jest.mock('../../api/session', () => ({ getConnection: jest.fn() }));
jest.mock('../../api/odooApi', () => ({ jsonRpc: jest.fn(), httpUpload: jest.fn() }));
jest.mock('../kraKpi', () => ({ getKraTree: jest.fn() }));

const { LANES, laneForTask, isTodayTask, groupIntoLanes } = require('../kpiActions');

// Minimal task in the shape /kra_kpi/tasks/get sends.
const task = (over = {}) => ({
  id: 1, name: 'A task', priority: 'regular', task_state: 'assigned',
  user_id: 3, user_name: 'dev', timer_total_seconds: 0, timer_start_datetime: null,
  is_self_created: false, admin_accepted: true, ...over,
});

describe('the Today lane', () => {
  it('is first, so picking work back up never means scrolling', () => {
    expect(LANES[0].key).toBe('today');
  });

  it('is never returned by laneForTask — Today is not a status', () => {
    // The status filter, the notification scroll-to and the Home stat cards all
    // ask laneForTask which lane OWNS a task. If it ever answered 'today', the
    // task would disappear from the lane it really lives in.
    const worked = task({ task_state: 'paused', today_seconds: 900 });
    expect(laneForTask(worked)).toBe('paused');
  });

  it('holds a task WITHOUT removing it from its status lane', () => {
    const lanes = groupIntoLanes([task({ id: 7, task_state: 'paused', today_seconds: 900 })]);
    expect(lanes.today.map((t) => t.id)).toEqual([7]);
    expect(lanes.paused.map((t) => t.id)).toEqual([7]);
  });
});

describe('hold and rework', () => {
  // They lane by PRIORITY, matching the module — kpi_action.js has no branch for
  // either, so both fall through to `key = t.priority`.
  it('lane by priority, not with paused', () => {
    expect(laneForTask(task({ task_state: 'hold', priority: 'urgent' }))).toBe('urgent');
    expect(laneForTask(task({ task_state: 'rework', priority: 'important' }))).toBe('important');
    expect(laneForTask(task({ task_state: 'hold', priority: 'regular' }))).toBe('regular');
  });

  // The one thing NOT copied from the web, which pushes only `if (groups[key])`
  // and so shows such a task in no lane at all. Whatever the priority says, the
  // task stays on the board.
  it('still lands somewhere when the priority is not a lane', () => {
    expect(laneForTask(task({ task_state: 'rework', priority: 'blocker' }))).toBe('regular');
    const lanes = groupIntoLanes([task({ id: 9, task_state: 'hold', priority: 'blocker' })]);
    const everywhere = Object.values(lanes).flat().map((t) => t.id);
    expect(everywhere).toContain(9);
  });

  it('orders by time spent today, most first', () => {
    const lanes = groupIntoLanes([
      task({ id: 1, task_state: 'paused', today_seconds: 60 }),
      task({ id: 2, task_state: 'paused', today_seconds: 3600 }),
      task({ id: 3, task_state: 'in_progress', today_seconds: 900 }),
    ]);
    expect(lanes.today.map((t) => t.id)).toEqual([2, 3, 1]);
  });

  it('excludes tasks with no time today, and payloads from an older server', () => {
    const lanes = groupIntoLanes([
      task({ id: 1, task_state: 'paused', today_seconds: 0 }),
      task({ id: 2, task_state: 'paused' }),               // field absent entirely
      task({ id: 3, task_state: 'paused', today_seconds: 5 }),
    ]);
    expect(lanes.today.map((t) => t.id)).toEqual([3]);
    // The status lane is untouched either way — an older server must leave the
    // board behaving exactly as it did before Today existed.
    expect(lanes.paused.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(isTodayTask(task({}))).toBe(false);
  });

  it('does not inflate the board count', () => {
    // The web board had to teach getTotalTaskCount to skip this lane, or a
    // 40-task board reported 43 the moment somebody worked on three of them.
    // Same arithmetic, asserted here: every lane EXCEPT today must still add up
    // to exactly the number of tasks that came in.
    const tasks = [
      task({ id: 1, task_state: 'paused', today_seconds: 900 }),
      task({ id: 2, task_state: 'in_progress', today_seconds: 60 }),
      task({ id: 3, task_state: 'completed', today_seconds: 30 }),
      task({ id: 4, task_state: 'assigned' }),
    ];
    const lanes = groupIntoLanes(tasks);
    const counted = LANES
      .filter((l) => l.key !== 'today')
      .reduce((n, l) => n + lanes[l.key].length, 0);
    expect(counted).toBe(tasks.length);
    expect(lanes.today).toHaveLength(3);
  });

  it('empties at midnight and leaves the status lanes exactly as they were', () => {
    // The server decides this: today_seconds is derived from kpi.time.log's
    // work_date in the developer's timezone, so at midnight the date stops
    // matching and the field comes back 0 — no cron, nothing to reset. What the
    // CLIENT owes is that the rollover costs nothing but the lane itself.
    const yesterday = [
      task({ id: 1, task_state: 'paused', today_seconds: 900 }),
      task({ id: 2, task_state: 'in_progress', today_seconds: 60 }),
    ];
    const afterMidnight = yesterday.map((t) => ({ ...t, today_seconds: 0 }));

    const before = groupIntoLanes(yesterday);
    const after = groupIntoLanes(afterMidnight);

    expect(before.today).toHaveLength(2);
    expect(after.today).toHaveLength(0);
    for (const l of LANES.filter((x) => x.key !== 'today')) {
      expect(after[l.key].map((t) => t.id)).toEqual(before[l.key].map((t) => t.id));
    }
  });
});

describe('lane ordering by last activity', () => {
  // The reported bug: "yesterday I used a task, so when today I go and search,
  // in Paused it will be at last." kra.kpi declares no _order, so the server
  // falls back to id ASC and every lane reads oldest-at-top.
  it('puts the task worked yesterday above a newer one nobody has touched since', () => {
    // id 1 is the OLD task — created long ago, worked yesterday. id 900 is newer
    // by creation but was last touched a month back. This is the exact case that
    // sorting by id (either direction) cannot fix: ascending buries id 1 at the
    // bottom, descending buries it just as surely, because id is creation order
    // and the complaint is about ACTIVITY.
    const lanes = groupIntoLanes([
      task({ id: 1, task_state: 'paused', last_activity: '2026-09-10T14:00:00Z' }),
      task({ id: 900, task_state: 'paused', last_activity: '2026-08-11T09:00:00Z' }),
    ]);
    expect(lanes.paused.map((t) => t.id)).toEqual([1, 900]);
  });

  it('sorts a task never worked on last, not first', () => {
    const lanes = groupIntoLanes([
      task({ id: 1, task_state: 'paused', last_activity: false }),
      task({ id: 2, task_state: 'paused', last_activity: '2026-09-01T09:00:00Z' }),
      task({ id: 3, task_state: 'paused' }),                // field absent entirely
      task({ id: 4, task_state: 'paused', last_activity: '2026-09-10T09:00:00Z' }),
    ]);
    expect(lanes.paused.map((t) => t.id)).toEqual([4, 2, 1, 3]);
  });

  it('leaves the board exactly as it was when the server sends no last_activity', () => {
    // An older server talking to this build reports the field on nothing, so the
    // comparator must be a no-op rather than a scramble — every lane keeps the
    // order the server sent.
    const tasks = [
      task({ id: 5, task_state: 'paused' }),
      task({ id: 2, task_state: 'paused' }),
      task({ id: 9, task_state: 'paused' }),
    ];
    expect(groupIntoLanes(tasks).paused.map((t) => t.id)).toEqual([5, 2, 9]);
  });

  it('orders every status lane, not just one', () => {
    const lanes = groupIntoLanes([
      task({ id: 1, task_state: 'in_progress', last_activity: '2026-09-01T09:00:00Z' }),
      task({ id: 2, task_state: 'in_progress', last_activity: '2026-09-10T09:00:00Z' }),
      task({ id: 3, task_state: 'completed', last_activity: '2026-09-02T09:00:00Z' }),
      task({ id: 4, task_state: 'completed', last_activity: '2026-09-09T09:00:00Z' }),
    ]);
    expect(lanes.in_progress.map((t) => t.id)).toEqual([2, 1]);
    expect(lanes.completed.map((t) => t.id)).toEqual([4, 3]);
  });

  it('does NOT reorder Today, which sorts by time worked instead', () => {
    // Today answers "what was I last deep in" — how MUCH was worked today. A
    // task given five minutes at 16:00 must not outrank the one that took the
    // whole morning, so recency deliberately does not apply to this lane.
    const lanes = groupIntoLanes([
      task({ id: 1, task_state: 'paused', today_seconds: 7200,
             last_activity: '2026-09-11T09:30:00Z' }),   // all morning, touched earlier
      task({ id: 2, task_state: 'paused', today_seconds: 300,
             last_activity: '2026-09-11T16:00:00Z' }),   // five minutes, touched last
    ]);
    expect(lanes.today.map((t) => t.id)).toEqual([1, 2]);
    // ...while the status lane the same two tasks live in DOES use recency.
    expect(lanes.paused.map((t) => t.id)).toEqual([2, 1]);
  });
});

describe('the fresh (red card) age window', () => {
  const { isWithinFreshWindow, FRESH_MAX_AGE_MS } = require('../kpiActions');
  const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);   // 2026-09-11 12:00 UTC

  it('counts a task created this morning as fresh', () => {
    expect(isWithinFreshWindow({ create_date: '2026-09-11T09:00:00Z' }, NOW)).toBe(true);
  });

  it('expires a task created more than a day ago', () => {
    // The reported case: a card that has shouted red for far too long.
    expect(isWithinFreshWindow({ create_date: '2026-09-09T09:00:00Z' }, NOW)).toBe(false);
  });

  it('holds right up to the boundary and drops immediately after', () => {
    const justInside = new Date(NOW - FRESH_MAX_AGE_MS + 1000).toISOString();
    const justOutside = new Date(NOW - FRESH_MAX_AGE_MS - 1000).toISOString();
    expect(isWithinFreshWindow({ create_date: justInside }, NOW)).toBe(true);
    expect(isWithinFreshWindow({ create_date: justOutside }, NOW)).toBe(false);
  });

  it('reads the space-separated server format as UTC, not local time', () => {
    // `new Date('2026-09-11 09:00:00')` is LOCAL in most engines, which would
    // shift the age by the device's offset — +5:30 here, enough to move a card
    // across the boundary. Both spellings must agree.
    const spaced = isWithinFreshWindow({ create_date: '2026-09-10 13:00:00' }, NOW);
    const isoZ = isWithinFreshWindow({ create_date: '2026-09-10T13:00:00Z' }, NOW);
    expect(spaced).toBe(isoZ);
    expect(spaced).toBe(true);
  });

  it('treats a missing create_date as still fresh, so an older server changes nothing', () => {
    expect(isWithinFreshWindow({}, NOW)).toBe(true);
    expect(isWithinFreshWindow({ create_date: false }, NOW)).toBe(true);
    expect(isWithinFreshWindow({ create_date: 'not a date' }, NOW)).toBe(true);
  });
});

describe('board search', () => {
  const { taskMatchesQuery } = require('../kpiActions');
  const t = task({ name: 'R client reject', user_name: 'Adithyan', external_ref: 'TASK-014' });

  it('finds a task by its ref however the hyphen is typed', () => {
    for (const q of ['task014', 'TASK-014', 'task-014', 'TASK 014', '014', 'Task014']) {
      expect(taskMatchesQuery(t, q)).toBe(true);
    }
  });

  it('still matches name and assignee the way it always did', () => {
    expect(taskMatchesQuery(t, 'client')).toBe(true);
    expect(taskMatchesQuery(t, 'adithyan')).toBe(true);
    expect(taskMatchesQuery(t, 'nothing here')).toBe(false);
  });

  it('does not let punctuation-only input match every reffed task', () => {
    // '-' normalises to '', and ''.includes('') is true — so without the guard
    // this would return the whole board.
    expect(taskMatchesQuery(t, '-')).toBe(false);
  });

  it('does not match a ref against a task that has none', () => {
    expect(taskMatchesQuery(task({ name: 'No ref here' }), 'task014')).toBe(false);
  });

  it('treats an empty query as matching everything', () => {
    expect(taskMatchesQuery(t, '')).toBe(true);
    expect(taskMatchesQuery(t, '   ')).toBe(true);
  });

  it('leaves hyphenated NAMES alone — only the ref is normalised', () => {
    // Normalising names too would quietly change old behaviour.
    const hy = task({ name: 'client-flow test', external_ref: '' });
    expect(taskMatchesQuery(hy, 'client-flow')).toBe(true);
    expect(taskMatchesQuery(hy, 'clientflow')).toBe(false);
  });
});

// byRecency was a local const inside groupIntoLanes, so the switch picker could
// not reach it and went on sorting alphabetically by reference — creation order
// in practice — long after the lanes were fixed. It is exported now, which means
// two callers depend on its exact behaviour, so pin it directly rather than only
// through the lanes.
describe('byRecency, now that the lanes and the switch picker share it', () => {
  const { byRecency } = require('../kpiActions');
  const at = (last_activity) => ({ last_activity });

  it('puts the most recently worked task first', () => {
    const older = at('2026-09-10T09:00:00Z');
    const newer = at('2026-09-16T09:00:00Z');
    expect(byRecency(newer, older)).toBeLessThan(0);
    expect(byRecency(older, newer)).toBeGreaterThan(0);
  });

  it('sorts a real list newest to oldest', () => {
    const rows = [
      at('2026-08-11T09:00:00Z'),
      at('2026-09-16T09:00:00Z'),
      at('2026-09-10T14:00:00Z'),
    ];
    expect([...rows].sort(byRecency).map((r) => r.last_activity)).toEqual([
      '2026-09-16T09:00:00Z',
      '2026-09-10T14:00:00Z',
      '2026-08-11T09:00:00Z',
    ]);
  });

  it('sends never-started tasks to the BOTTOM, not the top', () => {
    // A task nobody has ever touched has no claim on the top of the list — and
    // `false` is what the server actually sends, not null or undefined.
    const never = at(false);
    const worked = at('2026-09-16T09:00:00Z');
    expect(byRecency(never, worked)).toBeGreaterThan(0);
    expect(byRecency(worked, never)).toBeLessThan(0);
  });

  it('is a no-op when NOTHING reports activity', () => {
    // An older app against a newer server, or the reverse. Returning 0 leaves the
    // server's order alone instead of scrambling it into something arbitrary.
    expect(byRecency(at(false), at(false))).toBe(0);
    expect(byRecency(at(undefined), at(null))).toBe(0);
  });

  it('reports a tie so a caller can add its own second key', () => {
    // The switch picker relies on this: equal recency falls through to the
    // reference, which is the predictable order it has always had.
    const same = '2026-09-16T09:00:00Z';
    expect(byRecency(at(same), at(same))).toBe(0);

    const tie = [
      { last_activity: false, external_ref: 'REQ-116' },
      { last_activity: false, external_ref: 'REQ-068' },
    ];
    const sorted = [...tie].sort((a, b) => byRecency(a, b)
      || String(a.external_ref).localeCompare(String(b.external_ref)));
    expect(sorted.map((t) => t.external_ref)).toEqual(['REQ-068', 'REQ-116']);
  });
});
