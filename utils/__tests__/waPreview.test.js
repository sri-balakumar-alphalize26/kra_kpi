import { renderWaTemplate, splitBold } from '../waPreview';

// The shipped defaults, copied from models/kpi_wa_group_event.py. If these drift,
// the app preview stops matching what the group actually receives.
const START = '🟢 *Workday started*\n{dev}\n{time} · {date}';
const END = '🔴 *Workday ended*\n{dev}\n{time} · {date} · {hours} logged\n{tasks}\n📝 "{note}"';

const FULL = {
  dev: '@919876543210', time: '06:15 PM', date: 'Mon 17 Aug', hours: '8h 30m',
  tasks: '5 task(s) touched · 3 completed', note: 'finished the invoice screen',
};

describe('renderWaTemplate', () => {
  it('renders the start default exactly as the server does', () => {
    expect(renderWaTemplate(START, { dev: '@919876543210', time: '09:02 AM', date: 'Mon 17 Aug' }))
      .toBe('🟢 *Workday started*\n@919876543210\n09:02 AM · Mon 17 Aug');
  });

  it('renders a full end-of-day exactly as the server does', () => {
    expect(renderWaTemplate(END, FULL)).toBe(
      '🔴 *Workday ended*\n@919876543210\n06:15 PM · Mon 17 Aug · 8h 30m logged\n'
      + '5 task(s) touched · 3 completed\n📝 "finished the invoice screen"');
  });

  // The bug this rule exists for: an empty note must not leave a bare 📝 "".
  it('drops a line whose tokens all resolved to empty, decoration included', () => {
    expect(renderWaTemplate(END, { ...FULL, tasks: '', note: '' })).toBe(
      '🔴 *Workday ended*\n@919876543210\n06:15 PM · Mon 17 Aug · 8h 30m logged');
  });

  it('keeps a line when only SOME of its tokens are empty', () => {
    expect(renderWaTemplate('{dev} logged {hours}', { dev: 'Ramesh', hours: '' }))
      .toBe('Ramesh logged');
  });

  it('always keeps a line that contains no tokens', () => {
    expect(renderWaTemplate('---\n{dev}', { dev: 'Ramesh' })).toBe('---\nRamesh');
  });

  it('leaves unknown tokens as literal text rather than silently dropping them', () => {
    expect(renderWaTemplate('Hi {dev} {nope}', { dev: 'Ramesh' })).toBe('Hi Ramesh {nope}');
  });

  // A hand-written template must never be able to throw: the same text is
  // rendered server-side while a workday is being closed, and closing is one-way.
  it.each([
    'Hi {dev} {unknown} { stray',
    '{{dev}}',
    '100% done {dev} 50%s',
    '',
    null,
    undefined,
  ])('survives malformed template %p', (tpl) => {
    expect(() => renderWaTemplate(tpl, { dev: 'Ramesh' })).not.toThrow();
  });

  it('survives a null values object', () => {
    expect(() => renderWaTemplate('{dev}', null)).not.toThrow();
  });
});

describe('splitBold', () => {
  it('marks paired asterisks as bold and leaves the rest alone', () => {
    expect(splitBold('a *b* c')).toEqual([
      { text: 'a ', bold: false },
      { text: 'b', bold: true },
      { text: ' c', bold: false },
    ]);
  });

  it('treats an unmatched asterisk as ordinary text', () => {
    expect(splitBold('5 * 3 = 15')).toEqual([{ text: '5 * 3 = 15', bold: false }]);
  });

  it('does not span a line break', () => {
    const parts = splitBold('*a\nb*');
    expect(parts.every((p) => !p.bold)).toBe(true);
  });

  it('handles empty input', () => {
    expect(splitBold('')).toEqual([]);
  });
});
