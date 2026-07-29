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
    expect(workdayButtonState({ workdayOpen: false, dayDone: true }))
      .toEqual({ label: 'Workday ended for today', action: 'none', disabled: true });
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
