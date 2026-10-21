// What a full Complete still lacks, in the words shown to the person.
//
// Shared by the detail screen's "Complete This Task" card and the board's finish
// modal so both list the same gaps in the same order and wording. Mirrors the
// server's own refusals: a progress summary, a user manual, a GitHub link on a
// Module / App task, and at least one ticked checklist box. Partial Finish needs
// none of these except the summary, so callers only run this for a full Complete.

export const MISSING_SUMMARY = 'A progress summary';
export const MISSING_MANUAL = 'The user manual (PDF, DOC or DOCX)';
export const MISSING_GITHUB = 'The GitHub link + branch (this is a Module / App task)';
export const MISSING_TICK = 'At least one ticked checkbox';

export function completeMissing({ hasSummary, hasManual, githubRequired, hasGithub, anyTicked } = {}) {
  const out = [];
  if (!hasSummary) out.push(MISSING_SUMMARY);
  if (!hasManual) out.push(MISSING_MANUAL);
  if (githubRequired && !hasGithub) out.push(MISSING_GITHUB);
  if (!anyTicked) out.push(MISSING_TICK);
  return out;
}

export default completeMissing;
