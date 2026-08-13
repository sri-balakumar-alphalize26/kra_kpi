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

describe('rejects a note that says nothing', () => {
  test.each([['a full stop', '.'], ['digits', '123'], ['dashes', '----'],
             ['ellipsis', '...'], ['punctuation', '+ + +'], ['one letter', 'a'],
             ['a single word', 'done']])(
    'rejects %s', (_label, input) => {
      const r = validateWorkdayNote(input);
      expect(r.ok).toBe(false);
      expect(r.reason).toBeTruthy();
    });
});

describe('accepts anything with two real words', () => {
  test.each([['plain', 'fixed the invoice bug'],
             ['with digits', 'found 4 errors'],
             ['punctuation heavy', '->Van sale doc (needs screenshots)'],
             ['mixed', 'KRA KPI + billing checked']])(
    'accepts %s', (_label, input) => {
      expect(validateWorkdayNote(input).ok).toBe(true);
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
