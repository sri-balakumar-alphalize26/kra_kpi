import {
  completeMissing, MISSING_SUMMARY, MISSING_MANUAL, MISSING_GITHUB, MISSING_TICK,
} from '../completeMissing';

const ALL_OK = { hasSummary: true, hasManual: true, githubRequired: true, hasGithub: true, anyTicked: true };

describe('completeMissing', () => {
  it('returns nothing when everything is in place', () => {
    expect(completeMissing(ALL_OK)).toEqual([]);
  });

  it('uses the exact wording shown to the user', () => {
    expect(MISSING_SUMMARY).toBe('A progress summary');
    expect(MISSING_MANUAL).toBe('The user manual (PDF, DOC or DOCX)');
    expect(MISSING_GITHUB).toBe('The GitHub link + branch (this is a Module / App task)');
    expect(MISSING_TICK).toBe('At least one ticked checkbox');
  });

  it('lists every gap at once, in a fixed order', () => {
    expect(completeMissing({ githubRequired: true })).toEqual([
      MISSING_SUMMARY, MISSING_MANUAL, MISSING_GITHUB, MISSING_TICK,
    ]);
  });

  it('flags each item on its own', () => {
    expect(completeMissing({ ...ALL_OK, hasSummary: false })).toEqual([MISSING_SUMMARY]);
    expect(completeMissing({ ...ALL_OK, hasManual: false })).toEqual([MISSING_MANUAL]);
    expect(completeMissing({ ...ALL_OK, hasGithub: false })).toEqual([MISSING_GITHUB]);
    expect(completeMissing({ ...ALL_OK, anyTicked: false })).toEqual([MISSING_TICK]);
  });

  it('does not ask for GitHub when the task type does not need it', () => {
    expect(completeMissing({ ...ALL_OK, githubRequired: false, hasGithub: false })).toEqual([]);
  });

  it('treats a missing argument as everything missing (GitHub not required)', () => {
    expect(completeMissing()).toEqual([MISSING_SUMMARY, MISSING_MANUAL, MISSING_TICK]);
  });
});
