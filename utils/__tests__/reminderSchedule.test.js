const { parseServerUtc, armableReminders } = require('../reminderSchedule');

describe('parseServerUtc', () => {
  // The whole point of the function. Odoo sends 'YYYY-MM-DD HH:MM:SS' with no
  // zone; read as local at +05:30 it lands 5h30m early, which is the bug this
  // exists to prevent.
  test('reads the naive server string as UTC, not local', () => {
    expect(parseServerUtc('2026-09-12 19:30:00')).toBe(Date.UTC(2026, 8, 12, 19, 30, 0));
  });

  test('agrees with the equivalent explicit-Z timestamp', () => {
    expect(parseServerUtc('2026-01-05 04:00:00')).toBe(Date.parse('2026-01-05T04:00:00Z'));
  });

  test('midnight is not mistaken for a missing value', () => {
    expect(parseServerUtc('2026-03-01 00:00:00')).toBe(Date.UTC(2026, 2, 1, 0, 0, 0));
  });

  test.each([null, undefined, '', false, 'not a date'])('unparseable → null (%p)', (v) => {
    expect(parseServerUtc(v)).toBeNull();
  });
});

describe('armableReminders', () => {
  const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);
  const at = (h) => new Date(NOW + h * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  test('a future, enabled reminder is armed', () => {
    const out = armableReminders([{ id: 7, name: 'Call the client', enabled: true, next_trigger: at(2) }], NOW);
    expect(out).toEqual([{ id: '7', at: NOW + 2 * 3600 * 1000, name: 'Call the client' }]);
  });

  // enabled is not in the server's compute depends, so a disabled reminder still
  // carries a valid future trigger. Missing this rings reminders people switched
  // off.
  test('a disabled reminder is never armed, even with a future trigger', () => {
    expect(armableReminders([{ id: 7, name: 'x', enabled: false, next_trigger: at(2) }], NOW)).toEqual([]);
  });

  // A one-off nobody completed keeps its old trigger; arming it would fire the
  // instant the app opened.
  test('a past-due one-off reminder is not armed', () => {
    expect(armableReminders([{ id: 7, name: 'x', enabled: true, next_trigger: at(-1) }], NOW)).toEqual([]);
    expect(armableReminders([{ id: 7, name: 'x', enabled: true, repeat: 'none', next_trigger: at(-1) }], NOW)).toEqual([]);
  });

  // The server advances a repeat only when it is completed, so an uncompleted
  // daily reminder used to ring once and never again.
  test('a past-due DAILY reminder is armed for the next occurrence after now', () => {
    const out = armableReminders([{ id: 7, name: 'x', enabled: true, repeat: 'daily', next_trigger: at(-1) }], NOW);
    expect(out).toEqual([{ id: '7', at: NOW + 23 * 3600 * 1000, name: 'x' }]);
  });

  test('a repeat several periods behind rolls all the way forward, keeping the time of day', () => {
    const out = armableReminders([{ id: 7, name: 'x', enabled: true, repeat: 'weekly', next_trigger: at(-24 * 10) }], NOW);
    expect(out[0].at).toBe(NOW + 4 * 24 * 3600 * 1000);
  });

  test('a future repeat is armed as it stands', () => {
    const out = armableReminders([{ id: 7, name: 'x', enabled: true, repeat: 'daily', next_trigger: at(2) }], NOW);
    expect(out[0].at).toBe(NOW + 2 * 3600 * 1000);
  });

  test('one due within the skew window is not armed', () => {
    const almost = new Date(NOW + 400).toISOString().replace('T', ' ').slice(0, 19);
    expect(armableReminders([{ id: 7, name: 'x', enabled: true, next_trigger: almost }], NOW)).toEqual([]);
  });

  test('rows with no id or no trigger are skipped, not crashed on', () => {
    const rows = [
      { name: 'no id', enabled: true, next_trigger: at(1) },
      { id: 9, name: 'no trigger', enabled: true, next_trigger: false },
      null,
      { id: 11, name: 'good', enabled: true, next_trigger: at(3) },
    ];
    expect(armableReminders(rows, NOW).map((r) => r.id)).toEqual(['11']);
  });

  // `enabled` absent (an older server, or a partial write) must not be read as
  // disabled — only an explicit false switches a reminder off.
  test('a missing enabled flag counts as on', () => {
    expect(armableReminders([{ id: 3, name: 'x', next_trigger: at(1) }], NOW)).toHaveLength(1);
  });

  test.each([null, undefined, []])('no rows → nothing armed (%p)', (rows) => {
    expect(armableReminders(rows, NOW)).toEqual([]);
  });
});
