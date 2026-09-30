// The KRA Report's New Task form: what must be filled in, and what to say when
// it is not.
//
// Pure and separate from the screen because the ORDER and the WORDING are the
// whole contract — this mirrors submitNewTask() in the Odoo web report
// (static/src/components/kpi_kra_report/kpi_kra_report.js), and a port that
// silently reorders the checks or softens a message is a port that has drifted.
//
// The SERVER requires only `name` (create_kpi in models/kpi.py raises for a blank
// one and checks nothing else), so every rule below is the client's. That is not
// belt-and-braces: without the estimate the task lands on the board un-estimated
// and blows every comparison, and without an assignee log_manual_time has nobody
// to file the hours against and refuses AFTER the task already exists.
//
// Deliberately NOT validated: Priority and Type (REQ / UPT / BUG). Both carry an
// asterisk on the web and neither is ever checked — they always hold a value, so
// the star is decorative. Do not add validation the web does not have.
//
// The Module / App / EXE type IS checked, last, on both: it starts blank, so the
// star is not decorative there.

import { DELIVERABLE_REQUIRED_MSG } from './deliverableType';

// hours + minutes as one figure, forgiving of '' and of text the way parseInt is.
export function toSeconds(hours, minutes) {
  return (parseInt(hours, 10) || 0) * 3600 + (parseInt(minutes, 10) || 0) * 60;
}

// Returns an error string, or '' when the form may be submitted. First failure
// wins, in this order — the same order the web checks in, so the same field is
// complained about first.
export function validateNewTask(t = {}) {
  if (!String(t.name || '').trim()) return 'Task name is required.';
  if (!t.kra_id) return 'Pick a project.';
  if (toSeconds(t.estimate_hours, t.estimate_minutes) <= 0) {
    return 'Estimate Time is required. Please enter hours and/or minutes.';
  }
  if (toSeconds(t.worked_hours, t.worked_minutes) <= 0) {
    return 'Time worked is required. Enter the hours and/or minutes already spent.';
  }
  if (!t.user_id) return 'Pick an assignee — time worked is recorded against a person.';
  if (!t.deliverable_type) return DELIVERABLE_REQUIRED_MSG;
  return '';
}

// The three Types, and the reference prefix each one mints. The prefix is not
// decoration: create_kpi turns doc_type into an `external_ref` of `REQ-001` etc,
// and the report's own Type filter matches on exactly that prefix — so a task
// created without a doc_type is invisible to the filter meant to find it.
// Mirrors REF_PREFIX_FOR_DOC_TYPE in models/kpi_workflow.py:62.
export const DOC_TYPES = [
  { code: 'requirement', label: 'Requirement', prefix: 'REQ' },
  { code: 'update', label: 'Update', prefix: 'UPT' },
  { code: 'bug', label: 'Bug', prefix: 'BUG' },
];

export const prefixForDocType = (code) => (DOC_TYPES.find((d) => d.code === code) || {}).prefix || '';
