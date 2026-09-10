const { workdayButtonState } = require('../workdayState');

describe('workdayButtonState', () => {
  // Workday open → the only action is End.
  test('open → End Workday', () => {
    expect(workdayButtonState({ workdayOpen: true, dayDone: false }))
      .toEqual({ label: 'End Workday', action: 'end', disabled: false });
  });

  // Nothing open, nothing ended → start the day. With the PIN gone this opens
  // the workday directly instead of routing anywhere.
  test('not open → Start Workday (opens directly)', () => {
    expect(workdayButtonState({ workdayOpen: false, dayDone: false }))
      .toEqual({ label: 'Start Workday', action: 'start', disabled: false });
  });

  // Explicit End today → one-per-day: disabled "ended" state, no restart.
  test('dayDone → Workday ended for today (disabled)', () => {
    expect(workdayButtonState({ workdayOpen: false, dayDone: true, todayClosed: true }))
      .toEqual({ label: 'Workday ended for today', action: 'none', disabled: true });
  });

  // Closed by the cron, not by the developer: restart is still allowed, so the
  // ACTION is unchanged — only the words, so a day the system cut at midnight
  // does not read as a day that never started.
  test('todayClosed → Start New Workday Session (still startable)', () => {
    expect(workdayButtonState({ workdayOpen: false, dayDone: false, todayClosed: true }))
      .toEqual({ label: 'Start New Workday Session', action: 'start', disabled: false });
  });

  // dayDone is checked first, so an explicit End still wins over the cron flag —
  // both are true on a day that was ended by hand.
  test('dayDone beats todayClosed', () => {
    expect(workdayButtonState({ workdayOpen: false, dayDone: true, todayClosed: true }).action).toBe('none');
  });

  // The ordering that matters: a session flag left true after the day was ended
  // must not resurrect an End button, and must never offer a restart.
  test('open + dayDone → End wins (still working)', () => {
    expect(workdayButtonState({ workdayOpen: true, dayDone: true }))
      .toEqual({ label: 'End Workday', action: 'end', disabled: false });
  });

  // dayDone beats the default start case — the whole point of checking it second.
  test('dayDone beats the Start default', () => {
    expect(workdayButtonState({ workdayOpen: false, dayDone: true }).action).toBe('none');
    expect(workdayButtonState({ workdayOpen: false, dayDone: false }).action).toBe('start');
  });

  // 'pair' is gone with the PIN screen — no input may ever produce it again.
  test('never returns the retired pair action', () => {
    for (const workdayOpen of [true, false]) {
      for (const dayDone of [true, false]) {
        expect(workdayButtonState({ workdayOpen, dayDone }).action).not.toBe('pair');
      }
    }
  });

  // Defensive: missing/undefined inputs must not throw. Nothing open, nothing
  // done → the start case.
  test('no args → Start Workday (safe default)', () => {
    expect(workdayButtonState()).toEqual({ label: 'Start Workday', action: 'start', disabled: false });
    expect(workdayButtonState({})).toEqual({ label: 'Start Workday', action: 'start', disabled: false });
  });
});
