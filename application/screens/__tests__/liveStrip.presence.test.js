// The live strip's three figures, and the rule that Pause Workday changed:
// Presence is TIME AT WORK, so it stops while the day is frozen. Productive stops
// too, but for a different reason — the server closes every timer, so there is
// nothing left for the client to tick.
//
// These are pinned here because the arithmetic is duplicated three times over
// (this file, kpi_work_session._compute_totals, and the OWL board's
// livePresenceDisplay) and the three must agree. A drift here is a screen
// disagreeing with the summary it leads into, which is exactly the class of bug
// the paired Presence/Accounted box exists to make visible.

// The screen pulls in the whole app graph just to reach three pure functions.
// AsyncStorage is the only piece that actually throws in Node (via utils/haptics),
// and the package ships its own jest mock for exactly this; the rest is stubbed
// so nothing here touches the network.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../api/session', () => ({ getConnection: jest.fn() }));
jest.mock('../../api/odooApi', () => ({ jsonRpc: jest.fn(), httpUpload: jest.fn() }));

const { presenceLive, productiveLive, presenceFootnote } = require('../KpiActionBoard');

// 09:30:00Z, and a `now` two hours later. Real ISO+Z strings, because that is
// what live_status emits and Date.parse is what the strip runs on.
const LOGIN = '2026-08-19T09:30:00Z';
const at = (hhmmss) => Date.parse(`2026-08-19T${hhmmss}Z`);
const H = 3600;

describe('presenceLive — time at work', () => {
  test('no pause → the raw clock since login', () => {
    expect(presenceLive({ login_raw: LOGIN }, at('11:30:00'))).toBe(2 * H);
  });

  test('completed pauses come off it', () => {
    // 2h on the clock, 20m of it banked as a finished pause.
    expect(presenceLive({ login_raw: LOGIN, paused_base: 20 * 60 }, at('11:30:00')))
      .toBe(2 * H - 20 * 60);
  });

  // The one that matters: paused_seconds on the row never holds the OPEN pause,
  // so a client reading only paused_base would keep counting through the freeze.
  test('an open pause freezes the clock', () => {
    const live = { login_raw: LOGIN, paused_base: 0, paused_since: '2026-08-19T10:30:00Z' };
    // Paused at 10:30. One hour in, Presence must still read the 1h it had then.
    expect(presenceLive(live, at('10:30:00'))).toBe(1 * H);
    expect(presenceLive(live, at('11:30:00'))).toBe(1 * H);
    expect(presenceLive(live, at('15:30:00'))).toBe(1 * H);
  });

  test('both halves are counted — a second pause on top of a banked one', () => {
    const live = {
      login_raw: LOGIN,
      paused_base: 30 * 60,                       // an earlier, closed pause
      paused_since: '2026-08-19T12:00:00Z',       // and one open now
    };
    // 09:30→13:00 is 3h30m on the clock; 30m banked + 1h open = 2h off it.
    expect(presenceLive(live, at('13:00:00'))).toBe(3.5 * H - 1.5 * H);
  });

  test('never negative, and safe on a missing payload', () => {
    expect(presenceLive({ login_raw: LOGIN, paused_base: 99 * H }, at('11:30:00'))).toBe(0);
    expect(presenceLive(null, at('11:30:00'))).toBe(0);
    expect(presenceLive({}, at('11:30:00'))).toBe(0);
  });
});

describe('productiveLive — stops because nothing is running', () => {
  // Pause Workday closes every timer, so active_tasks comes back empty and the
  // figure lands on the base the server measured. It is NOT gated on is_paused:
  // if a timer somehow survived a pause, this keeps ticking and says so, rather
  // than hiding it behind a flag.
  test('paused day with no timers → the finished-log base, unchanged', () => {
    const live = { productive_base: 4000, active_tasks: [], is_paused: true };
    expect(productiveLive(live, at('11:30:00'))).toBe(4000);
    expect(productiveLive(live, at('15:30:00'))).toBe(4000);
  });

  test('every running timer is added, not just the first', () => {
    const live = {
      productive_base: 100,
      active_tasks: [
        { id: 1, timer_start: '2026-08-19T11:00:00Z' },
        { id: 2, timer_start: '2026-08-19T11:00:00Z' },
      ],
    };
    expect(productiveLive(live, at('11:30:00'))).toBe(100 + 2 * 1800);
  });
});

describe('presenceFootnote — reconciling Presence with the day stamps', () => {
  test('silent when nothing was paused — Presence equals the stamps', () => {
    expect(presenceFootnote({ paused_seconds: 0, login_at: '2026-08-19 09:30:00' })).toBe('');
    expect(presenceFootnote(null)).toBe('');
  });

  test('open day (no logout yet) → start time only, no dangling dash', () => {
    const out = presenceFootnote({
      paused_seconds: 4800, paused_display: '1h 20m',
      login_at: '2026-08-19 09:30:00', logout_at: '',
    });
    expect(out).toBe('09:30 · 1h 20m paused');
    expect(out).not.toContain('–');
  });

  test('closed day → the full range', () => {
    expect(presenceFootnote({
      paused_seconds: 4800, paused_display: '1h 20m',
      login_at: '2026-08-19 09:30:00', logout_at: '2026-08-19 18:15:00',
    })).toBe('09:30–18:15 · 1h 20m paused');
  });
});
