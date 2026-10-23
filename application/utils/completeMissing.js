// What a full Complete still lacks, in the words shown to the person.
//
// Driven by the task's own rules (meta.completion_rules from /kra_kpi/task/details,
// built by the server's kpi_workflow._completion_rules): what is required depends
// on the task type — a Module needs the manual + GitHub, a Database task the four
// database details, a Bug fix only the summary. Shared by the detail screen's
// "Complete This Task" card and the board's Complete popup so both list the same
// gaps in the same order and wording. Partial Finish needs only the summary, so
// callers only run this for a full Complete.

export const MISSING_SUMMARY = 'A progress summary';

// Friendlier wording than the rule's short label, where the label alone is vague.
const MISSING_TEXT = {
  summary: MISSING_SUMMARY,
  manual: 'The user manual (a PDF, DOC or DOCX file, or a link)',
  github: 'The GitHub link + branch (this is a Module / App task)',
  app_link: 'The app link',
  website_url: 'The website URL',
  db_url: 'The database URL',
  db_name: 'The database name',
  db_user: 'The username',
  db_password: 'The password',
};

// Rules that can be filled in right on the Complete form, and the field each
// one is sent as to /kra_kpi/task/complete. The manual file and GitHub are
// added in their own sections, so they are not here.
export const COMPLETE_FIELDS = {
  app_link: { param: 'app_link', placeholder: 'Play Store / App Store / download link' },
  manual: { param: 'user_manual_url', placeholder: 'Or a link to the user manual' },
  website_url: { param: 'website_url', placeholder: 'https://…' },
  db_url: { param: 'provision_url', placeholder: 'https://…' },
  db_name: { param: 'provision_db_name', placeholder: 'Database name' },
  db_user: { param: 'provision_username', placeholder: 'Username' },
  db_password: { param: 'provision_password', placeholder: 'Password', secure: true },
};

const typed = (v) => !!String(v || '').trim();

// rules: [{ key, label, required, done }]. hasSummary: a summary is saved or
// being sent with this Complete. filled: { [rule key]: text typed on the form }.
export function completeMissing(rules, { hasSummary, filled = {} } = {}) {
  const list = rules && rules.length ? rules : [{ key: 'summary', label: 'Progress summary', required: true }];
  return list
    .filter((r) => r.required && !r.done && !(r.key === 'summary' ? hasSummary : typed(filled[r.key])))
    .map((r) => MISSING_TEXT[r.key] || r.label);
}

// Recommended but not added (rules with `warn`: the user manual, the GitHub
// link). Complete still goes through; the confirm popup lists these.
export function completeWarnings(rules, { filled = {} } = {}) {
  return (rules || [])
    .filter((r) => r.warn && !r.done && !typed(filled[r.key]))
    .map((r) => r.label);
}

// The confirm popup's lines, the same on every screen:
//   ⚠️ Not added — you can still complete:
//   • GitHub link — needed
//   • User manual — needed
export function warningText(warns) {
  return `⚠️ Not added — you can still complete:\n${warns.map((w) => `• ${w} — needed`).join('\n')}`;
}

// The typed values as /kra_kpi/task/complete parameters (empty ones left out).
export function completeExtras(filled = {}) {
  const out = {};
  Object.keys(COMPLETE_FIELDS).forEach((k) => {
    if (typed(filled[k])) out[COMPLETE_FIELDS[k].param] = String(filled[k]).trim();
  });
  return out;
}

export default completeMissing;
