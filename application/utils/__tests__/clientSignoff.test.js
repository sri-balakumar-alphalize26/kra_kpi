import {
  parseServerTs, formatLeft, reviewDueText, signerOptions, strokesToPath, autoFontSize, signoffReady,
} from '../clientSignoff';

describe('parseServerTs', () => {
  it('reads the server UTC stamp', () => {
    expect(parseServerTs('2026-10-29 07:26:58')).toBe(Date.UTC(2026, 9, 29, 7, 26, 58));
  });
  it('is null for empty / junk', () => {
    expect(parseServerTs('')).toBeNull();
    expect(parseServerTs(false)).toBeNull();
    expect(parseServerTs('soon')).toBeNull();
  });
});

describe('formatLeft', () => {
  const min = 60000;
  it('days and hours for a review window', () => {
    expect(formatLeft((2 * 1440 + 5 * 60 + 9) * min)).toBe('2d 5h');
    expect(formatLeft(3 * 1440 * min)).toBe('3d');
  });
  it('hours and minutes under a day', () => {
    expect(formatLeft((5 * 60 + 12) * min)).toBe('5h 12m');
    expect(formatLeft(60 * min)).toBe('1h');
    expect(formatLeft(12 * min)).toBe('12m');
  });
  it('never shows zero or negative', () => {
    expect(formatLeft(10000)).toBe('under a minute');
    expect(formatLeft(-5)).toBe('under a minute');
  });
});

describe('reviewDueText', () => {
  const now = Date.UTC(2026, 9, 26, 7, 0, 0);
  it('counts down to review_due_at', () => {
    const r = reviewDueText({ dueAt: '2026-10-29 07:26:58', days: 3, now });
    expect(r.due).toBe(false);
    expect(r.text).toMatch(/^⏳ Auto-approves in 3d · 29 Oct, \d\d:\d\d$/);
  });
  it('says it is happening once the time has passed', () => {
    expect(reviewDueText({ dueAt: '2026-10-25 07:00:00', now })).toEqual({ text: '⏳ Approving automatically…', due: true });
  });
  it('falls back to the rule, never to a guessed date', () => {
    expect(reviewDueText({ dueAt: '', days: 3, now }).text).toBe('⏳ No reply within 3 days of delivery approves it automatically');
    expect(reviewDueText({ days: 1, now }).text).toMatch(/within 1 day of/);
  });
  it('shows nothing when neither is known', () => {
    expect(reviewDueText({ days: 0, now })).toBeNull();
    expect(reviewDueText()).toBeNull();
  });
});

describe('signerOptions', () => {
  it('uses the server list of the client\'s people', () => {
    const out = signerOptions({
      signers: [{ key: 'u17', name: ' Asha ', sig: 'data:image/png;base64,AAA' }, { key: 'm3', name: '' }, null],
      userName: 'Me',
    });
    expect(out).toEqual([{ key: 'u17', name: 'Asha', sig: 'data:image/png;base64,AAA' }]);
  });
  it('falls back to the signed-in person', () => {
    expect(signerOptions({ signers: undefined, userName: 'Client User' })).toEqual([{ key: 'me', name: 'Client User', sig: '' }]);
  });
  it('is empty when nothing is known (the sheet then asks to type)', () => {
    expect(signerOptions({})).toEqual([]);
  });
});

describe('strokesToPath', () => {
  it('joins strokes into one path', () => {
    expect(strokesToPath([[{ x: 1, y: 2 }, { x: 3.04, y: 4.06 }], [{ x: 5, y: 6 }, { x: 7, y: 8 }]]))
      .toBe('M1 2 L3 4.1 M5 6 L7 8');
  });
  it('leaves a dot for a tap', () => {
    expect(strokesToPath([[{ x: 10, y: 10 }]])).toBe('M10 10 l0.1 0');
  });
  it('is empty with nothing drawn', () => {
    expect(strokesToPath([])).toBe('');
    expect(strokesToPath([[]])).toBe('');
  });
});

describe('autoFontSize', () => {
  it('shrinks long names to fit, within bounds', () => {
    const short = autoFontSize('Al', 300, 120);
    const long = autoFontSize('Alexandra Catherine Montgomery-Smith', 300, 120);
    expect(short).toBe(72);           // capped by the box height
    expect(long).toBeLessThan(short);
    expect(autoFontSize('x'.repeat(500), 300, 120)).toBe(14);
  });
});

describe('signoffReady', () => {
  const ticks = { delivered: true, works: true, authorized: true };
  it('needs all three ticks and a name', () => {
    expect(signoffReady({ ticks: { ...ticks, works: false }, name: 'A', mode: 'auto' })).toBe(false);
    expect(signoffReady({ ticks, name: '  ', mode: 'auto' })).toBe(false);
    expect(signoffReady({ ticks, name: 'A', mode: 'auto' })).toBe(true);
    expect(signoffReady({ ticks, name: 'A', mode: 'saved' })).toBe(true);
  });
  it('Draw needs ink', () => {
    expect(signoffReady({ ticks, name: 'A', mode: 'draw', inked: false })).toBe(false);
    expect(signoffReady({ ticks, name: 'A', mode: 'draw', inked: true })).toBe(true);
  });
});
