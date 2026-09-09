// The "since resume" second clock on a running card.
//
// The point of it is that it answers a DIFFERENT question from the Time row: not
// "what has this task cost" but "how long have I been back on it, and back from
// what". Everything it needs is already on the task, which is the fragile part —
// the distinction between a task that was STARTED and one that was RESUMED is
// inferred from banked time, not stated by the server. These tests pin that
// inference, because getting it wrong shows a resume clock on a fresh start
// (where there is nothing to be "since") or hides it on a real resume.
//
// Same mocks as the lanes test, and for the same reason: sinceResume is pure, and
// importing the module would otherwise drag session storage and the RPC client in.
jest.mock('../../api/session', () => ({ getConnection: jest.fn() }));
jest.mock('../../api/odooApi', () => ({ jsonRpc: jest.fn(), httpUpload: jest.fn() }));
jest.mock('../kraKpi', () => ({ getKraTree: jest.fn() }));

const { sinceResume, SINCE_RESUME_LABELS } = require('../kpiActions');

const START = '2026-09-09T10:00:00Z';
const running = (over = {}) => ({
  id: 1, task_state: 'in_progress', timer_start_datetime: START,
  timer_total_seconds: 3600, pause_reason_code: 'break', ...over,
});

describe('sinceResume', () => {
  it('returns the anchor and the wording for a resumed running task', () => {
    expect(sinceResume(running())).toEqual({ startIso: START, label: 'after break' });
  });

  it('gives back the ANCHOR, not a count — the screen ticks its own clock', () => {
    // A number computed here would be stale the moment it was rendered, and the
    // card already ticks off timer_start_datetime for the Time row.
    const r = sinceResume(running());
    expect(r.startIso).toBe(START);
    expect(r).not.toHaveProperty('seconds');
  });

  it('is silent on a FIRST start — no banked time means nothing to be "since"', () => {
    expect(sinceResume(running({ timer_total_seconds: 0 }))).toBeNull();
    expect(sinceResume(running({ timer_total_seconds: undefined }))).toBeNull();
  });

  it('is silent unless the task is actually running', () => {
    expect(sinceResume(running({ task_state: 'paused' }))).toBeNull();
    expect(sinceResume(running({ task_state: 'completed' }))).toBeNull();
  });

  it('is silent with no start anchor to count from', () => {
    expect(sinceResume(running({ timer_start_datetime: null }))).toBeNull();
  });

  it('still shows the clock when the reason has no wording, or none was sent', () => {
    // An older server sends no pause_reason_code at all. Losing the clock over a
    // missing label would be the wrong trade — the elapsed time is the useful half.
    expect(sinceResume(running({ pause_reason_code: undefined })).label).toBe('since resume');
    expect(sinceResume(running({ pause_reason_code: 'nonsense' })).label).toBe('since resume');
  });

  it('words every pause reason the picker can produce', () => {
    // PAUSE_REASONS codes that a task can be resumed FROM. 'day_end' is absent on
    // purpose: coming back from it is a new day, not a resume worth narrating.
    for (const code of ['break', 'lunch', 'meeting', 'leave', 'urgent',
                        'priority_task', 'technical_issue', 'awaiting_approval']) {
      expect(SINCE_RESUME_LABELS[code]).toBeTruthy();
      expect(sinceResume(running({ pause_reason_code: code })).label)
        .toBe(SINCE_RESUME_LABELS[code]);
    }
  });

  it('does not throw on a missing task', () => {
    expect(sinceResume(null)).toBeNull();
    expect(sinceResume(undefined)).toBeNull();
  });
});
