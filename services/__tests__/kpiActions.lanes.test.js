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
