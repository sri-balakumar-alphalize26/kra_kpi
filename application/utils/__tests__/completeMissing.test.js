import { completeMissing, completeExtras, MISSING_SUMMARY } from '../completeMissing';

const rule = (key, label, required, done = false) => ({ key, label, required, done });

const MODULE = [
  rule('summary', 'Progress summary', true),
  rule('manual', 'User manual', true),
  rule('github', 'GitHub link', true),
];
const DATABASE = [
  rule('summary', 'Progress summary', false),
  rule('db_url', 'URL', true, true),
  rule('db_name', 'Database name', true, true),
  rule('db_user', 'Username', true, true),
  rule('db_password', 'Password', true),
];
const BUG = [rule('summary', 'Progress summary', true)];

describe('completeMissing', () => {
  it('lists every required item still missing, in rule order', () => {
    expect(completeMissing(MODULE, {})).toEqual([
      MISSING_SUMMARY,
      'The user manual (a PDF, DOC or DOCX file, or a link)',
      'The GitHub link + branch (this is a Module / App task)',
    ]);
  });

  it('counts a summary being sent and a manual link typed on the form', () => {
    expect(completeMissing(MODULE, { hasSummary: true, filled: { manual: 'https://x.io/m.pdf' } }))
      .toEqual(['The GitHub link + branch (this is a Module / App task)']);
  });

  it('a bug fix needs only the summary', () => {
    expect(completeMissing(BUG, { hasSummary: true })).toEqual([]);
    expect(completeMissing(BUG, {})).toEqual([MISSING_SUMMARY]);
  });

  it('a database task needs the four details, not the summary', () => {
    expect(completeMissing(DATABASE, {})).toEqual(['The password']);
    expect(completeMissing(DATABASE, { filled: { db_password: 'secret' } })).toEqual([]);
    expect(completeMissing(DATABASE, { filled: { db_password: '   ' } })).toEqual(['The password']);
  });

  it('falls back to the summary alone when the rules are not known', () => {
    expect(completeMissing([], {})).toEqual([MISSING_SUMMARY]);
    expect(completeMissing(undefined, { hasSummary: true })).toEqual([]);
  });
});

describe('completeExtras', () => {
  it('maps typed values to the server fields and drops empty ones', () => {
    expect(completeExtras({ db_password: ' secret ', db_url: '', manual: 'https://x.io', github: 'x' }))
      .toEqual({ provision_password: 'secret', user_manual_url: 'https://x.io' });
  });
});
