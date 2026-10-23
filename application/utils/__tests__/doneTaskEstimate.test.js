const { estimateFromWorked } = require('../doneTaskEstimate');

const H = 3600;
const M = 60;
const low = () => 0;       // 20% extra
const high = () => 0.999;  // ~40% extra

describe('estimateFromWorked', () => {
  it('lands 5h of work between 6h and 7h', () => {
    expect(estimateFromWorked(5 * H, 'module', low)).toBe(6 * H);
    expect(estimateFromWorked(5 * H, 'module', high)).toBe(7 * H);
  });

  it('caps the extra at 2h for a Module or EXE', () => {
    expect(estimateFromWorked(10 * H, 'module', high)).toBe(12 * H);
    expect(estimateFromWorked(10 * H, 'exe', high)).toBe(12 * H);
  });

  it('allows up to 3h extra when an App is among the types', () => {
    expect(estimateFromWorked(10 * H, 'app', high)).toBe(13 * H);
    expect(estimateFromWorked(10 * H, 'module,app', high)).toBe(13 * H);
  });

  it('is always at least 15 minutes more, on a quarter hour', () => {
    for (const w of [M, 10 * M, 59 * M, H, 2 * H + 20 * M]) {
      for (const r of [low, high, Math.random]) {
        const est = estimateFromWorked(w, '', r);
        expect(est).toBeGreaterThanOrEqual(w + 15 * M);
        expect(est % (15 * M)).toBe(0);
      }
    }
  });
});
