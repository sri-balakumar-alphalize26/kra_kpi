// The running-task widget's numbers, held against the board's own counters.

const {
  shapeTaskWidget, emptyTaskWidgetState, presenceSecondsAt, productiveSecondsAt,
} = require('../taskWidgetState');
const { presenceLive, productiveLive } = require('../liveTime');

const T = (hhmm) => `2026-08-19T${hhmm}:00Z`;
const at = (hhmm) => Date.parse(T(hhmm));
const H = 3600;

const task = (over = {}) => ({
  id: 42, name: 'Invoice API', timer_start: T('10:00'), timer_total_seconds: 900, task_state: 'in_progress', ...over,
});

const live = (over = {}) => ({
  status: true, workday_open: true,
  active_task: false, active_tasks: [], active_break: false, nontask: false,
  login_raw: T('09:30'), productive_base: 1800, is_paused: false, paused_base: 0, paused_since: false,
  ...over,
});

describe('a running task', () => {
  it('maps the first task, the count and the button target', () => {
    const s = shapeTaskWidget(live({ active_tasks: [task(), task({ id: 43, name: 'Other', timer_start: T('10:20') })] }));
    expect(s.running).toBe(true);
    expect(s.task_name).toBe('Invoice API');
    expect(s.task_count).toBe(2);
    expect(s.started_at_ms).toBe(at('10:00'));
    expect(s.base_seconds).toBe(900);
    expect(s.kpi_id).toBe(42);
    expect(s.resume_kpi_id).toBe(0);
    expect(s.running_started_at_ms).toEqual([at('10:00'), at('10:20')]);
    expect(s.workday_open).toBe(true);
  });

  it('falls back to active_task on an older server', () => {
    const s = shapeTaskWidget(live({ active_task: task() }));
    expect(s.running).toBe(true);
    expect(s.task_count).toBe(1);
  });

  it('shifts every anchor by the clock skew, device minus server', () => {
    const s = shapeTaskWidget(live({ active_tasks: [task()] }), { skewMs: 65000 });
    expect(s.started_at_ms).toBe(at('10:00') + 65000);
    expect(s.login_raw_ms).toBe(at('09:30') + 65000);
    expect(s.running_started_at_ms).toEqual([at('10:00') + 65000]);
  });
});

describe('a break taken from a task', () => {
  const onBreak = live({
    active_break: {
      id: 7, type: 'break', type_label: 'Break', start_raw: T('11:00'), start_display: '11:00',
      source_task_id: 42, source_task_name: 'Invoice API', reason_note: '',
    },
  });

  it('offers Resume for the task the break came from, and shows the away row', () => {
    const s = shapeTaskWidget(onBreak);
    expect(s.running).toBe(false);
    expect(s.kpi_id).toBe(0);
    expect(s.resume_kpi_id).toBe(42);
    expect(s.resume_task_name).toBe('Invoice API');
    expect(s.away_label).toBe('Break');
    expect(s.away_started_at_ms).toBe(at('11:00'));
  });

  it('never offers Resume while a timer is running', () => {
    const s = shapeTaskWidget({ ...onBreak, active_tasks: [task({ id: 9 })] });
    expect(s.kpi_id).toBe(9);
    expect(s.resume_kpi_id).toBe(0);
  });
});

describe('a declared meeting with no task', () => {
  it('shows the block as the away row, with nothing to resume', () => {
    const s = shapeTaskWidget(live({ nontask: { reason: 'meeting', seq: 1, reason_label: 'Meeting 1', start_raw: T('14:00'), start_display: '14:00' } }));
    expect(s.away_label).toBe('Meeting 1');
    expect(s.away_started_at_ms).toBe(at('14:00'));
    expect(s.resume_kpi_id).toBe(0);
  });
});

describe('the empty state', () => {
  it('is what a signed-out device or an ended workday writes', () => {
    const s = emptyTaskWidgetState();
    expect(s).toMatchObject({
      running: false, task_name: '', task_count: 0, started_at_ms: 0, workday_open: false,
      kpi_id: 0, resume_kpi_id: 0, login_raw_ms: 0, away_label: '', running_started_at_ms: [],
    });
  });

  it('is also what garbage produces', () => {
    expect(shapeTaskWidget(undefined).running).toBe(false);
    expect(shapeTaskWidget({ active_tasks: [{ id: 1, name: 'x', timer_start: 'not a date' }] }).running).toBe(false);
  });
});

describe('the widget agrees with the board', () => {
  // Same payload, same instant: the anchors the widget ticks from must give the
  // seconds presenceLive / productiveLive give the Action Board.
  const cases = {
    'plain day': live({ active_tasks: [task()] }),
    'multitasking': live({ active_tasks: [task(), task({ id: 43, timer_start: T('10:20') })] }),
    'earlier pause banked': live({ active_tasks: [task()], paused_base: 20 * 60 }),
    'workday paused now': live({ is_paused: true, paused_base: 10 * 60, paused_since: T('12:00') }),
    'on a break': live({ active_break: { type_label: 'Lunch', start_raw: T('13:00'), source_task_id: 42, source_task_name: 'Invoice API' } }),
  };
  for (const [name, payload] of Object.entries(cases)) {
    it(name, () => {
      const now = at('13:30');
      const s = shapeTaskWidget(payload);
      expect(presenceSecondsAt(s, now)).toBeCloseTo(presenceLive(payload, now), 6);
      expect(productiveSecondsAt(s, now)).toBeCloseTo(productiveLive(payload, now), 6);
    });
  }

  it('a paused workday freezes presence', () => {
    const s = shapeTaskWidget(live({ is_paused: true, paused_since: T('12:00') }));
    expect(presenceSecondsAt(s, at('12:00'))).toBe(2.5 * H);
    expect(presenceSecondsAt(s, at('15:00'))).toBe(2.5 * H);
  });
});
