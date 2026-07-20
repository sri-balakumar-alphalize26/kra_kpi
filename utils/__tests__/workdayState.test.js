const { workdayButtonState } = require('../workdayState');

describe('workdayButtonState', () => {
  // Paired developer, workday open → the only action is End.
  test('paired + open → End Workday', () => {
    expect(workdayButtonState({ locked: false, workdayOpen: true, dayDone: false }))
      .toEqual({ label: 'End Workday', action: 'end', disabled: false });
  });

  // Unpaired but the server session is still OPEN (tab closed / auto-away):
  // this is the bug we fixed — it must read "Continue", never "Start".
  test('locked + open → Continue Workday', () => {
    expect(workdayButtonState({ locked: true, workdayOpen: true, dayDone: false }))
      .toEqual({ label: 'Continue Workday', action: 'pair', disabled: false });
  });

  // Fresh day, nothing open, nothing ended → Start.
  test('locked + not open → Start Workday', () => {
    expect(workdayButtonState({ locked: true, workdayOpen: false, dayDone: false }))
      .toEqual({ label: 'Start Workday', action: 'pair', disabled: false });
  });

  // Explicit End today → one-per-day: disabled "ended" state, no restart.
  test('dayDone → Workday ended for today (disabled)', () => {
    expect(workdayButtonState({ locked: true, workdayOpen: false, dayDone: true }))
      .toEqual({ label: 'Workday ended for today', action: 'none', disabled: true });
  });

  // dayDone wins over a stale/incoherent "open" flag so a restart is never offered.
  test('dayDone takes priority over a lingering open flag while locked', () => {
    expect(workdayButtonState({ locked: true, workdayOpen: true, dayDone: true }))
      .toEqual({ label: 'Workday ended for today', action: 'none', disabled: true });
  });

  // A paired + open session always ends first, even if dayDone somehow raced true.
  test('paired + open beats dayDone (still End)', () => {
    expect(workdayButtonState({ locked: false, workdayOpen: true, dayDone: true }))
      .toEqual({ label: 'End Workday', action: 'end', disabled: false });
  });

  // Already paired but no open session (rare edge) → open directly (action 'start').
  test('not locked + not open → Start Workday (direct open)', () => {
    expect(workdayButtonState({ locked: false, workdayOpen: false, dayDone: false }))
      .toEqual({ label: 'Start Workday', action: 'start', disabled: false });
  });

  // Defensive: missing/undefined inputs must not throw. Nothing locked/open →
  // the not-locked branch → direct 'start'.
  test('no args → Start Workday (safe default)', () => {
    expect(workdayButtonState()).toEqual({ label: 'Start Workday', action: 'start', disabled: false });
    expect(workdayButtonState({})).toEqual({ label: 'Start Workday', action: 'start', disabled: false });
  });
});
