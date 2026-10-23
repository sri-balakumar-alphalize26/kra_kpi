const { validateWorkdayNote, wordCount, NOTE_MAX } = require('../workdayNote');

// The real note this feature was specified from — 396 chars, 15 lines, using
// - > ( ) + / and digits. If a rule ever rejects THIS, the rule is wrong.
const REAL_NOTE = `Blurring content

Module documents
->Signage scan module doc

App documents
->Tools rental management doc
->Restaurant app doc
->Van sale doc
->Price checker doc(Need to add screenshots)

Chats server connecting issue + Dark/light mode switch bug + Build taken for testing

KRA KPI checked for client side invoice generate + When checking found 4 error or bugs fixed + New functionalities added`;

describe('the note is optional', () => {
  // End Workday is one-way. Nothing here may stop someone closing their day.
  test.each([['empty', ''], ['spaces only', '   '], ['newlines only', '\n\n'],
             ['undefined', undefined], ['null', null]])(
    'accepts %s and sends nothing', (_label, input) => {
      const r = validateWorkdayNote(input);
      expect(r.ok).toBe(true);
      expect(r.value).toBe('');
    });
});

describe('the real note survives untouched', () => {
  test('is accepted', () => {
    expect(validateWorkdayNote(REAL_NOTE).ok).toBe(true);
  });

  test('is not altered — every arrow, bracket, plus and digit intact', () => {
    const { value } = validateWorkdayNote(REAL_NOTE);
    expect(value).toBe(REAL_NOTE.trim());
    for (const ch of ['->', '+', '(', ')', '/', '4']) expect(value).toContain(ch);
  });

  test('keeps its line structure', () => {
    // 14, not the 15 the raw file measured: trim() drops the trailing newline.
    // The blank lines BETWEEN sections are what matter, and they survive.
    const lines = validateWorkdayNote(REAL_NOTE).value.split('\n');
    expect(lines).toHaveLength(14);
    expect(lines.filter((l) => l === '')).toHaveLength(4);
  });
});

// The note is OPTIONAL, and optional has to mean it. A thin note used to be
// refused, which made a box labelled "(optional)" compulsory the moment anything
// was typed into it — empty ended the day, "Finished" did not — and the refusal
// rendered far above the button, so the button simply looked broken. Ending a day
// is one-way and the server has never refused one over its note; this is the
// client agreeing. What survives is a hint, and a hint must never block.
describe('never blocks the day over its note', () => {
  test.each([['a full stop', '.'], ['digits', '123'], ['dashes', '----'],
             ['ellipsis', '...'], ['punctuation', '+ + +'], ['one letter', 'a'],
             ['a single word', 'done']])(
    'accepts %s, with a hint', (_label, input) => {
      const r = validateWorkdayNote(input);
      expect(r.ok).toBe(true);
      expect(r.reason).toBe('');
      expect(r.hint).toBeTruthy();
    });

  test('an empty note is accepted with no hint at all', () => {
    const r = validateWorkdayNote('');
    expect(r.ok).toBe(true);
    expect(r.hint).toBe('');
    expect(r.value).toBe('');
  });
});

describe('a real note passes with nothing to say about it', () => {
  test.each([['plain', 'fixed the invoice bug'],
             ['with digits', 'found 4 errors'],
             ['punctuation heavy', '->Van sale doc (needs screenshots)'],
             ['mixed', 'KRA KPI + billing checked']])(
    'accepts %s and offers no hint', (_label, input) => {
      const r = validateWorkdayNote(input);
      expect(r.ok).toBe(true);
      expect(r.hint).toBe('');
    });
});

describe('length', () => {
  test('clamps past the cap rather than erroring', () => {
    const long = 'word '.repeat(NOTE_MAX);
    const r = validateWorkdayNote(long);
    expect(r.ok).toBe(true);
    expect(r.value.length).toBeLessThanOrEqual(NOTE_MAX);
  });

  test('the real note is comfortably inside the cap', () => {
    expect(REAL_NOTE.length).toBeLessThan(NOTE_MAX);
  });
});

describe('wordCount', () => {
  test('counts letter runs, not digits', () => {
    expect(wordCount('found 4 errors')).toBe(2);
    expect(wordCount('123 456')).toBe(0);
  });
});
