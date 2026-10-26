// What a task builds: an Odoo Module, a mobile App, a desktop EXE, a Website, a
// Database, or Other (a short free-text name, e.g. Plugin). A second axis next to
// REQ / UPT / BUG (what KIND of work it is), stored on the server as
// kra.kpi.deliverable_type (+ deliverable_other for Other's text). Every create
// form asks for it; the server only refuses values outside this list, or Other
// with no text, so older builds that never send it still work.
//
// Same codes, labels and order as the server's DELIVERABLE_TYPES (models/kpi.py)
// and the web's DELIVERABLES — the order is the one the server stores them in.

export const DELIVERABLE_TYPES = [
  { code: 'module', label: 'Module' },
  { code: 'app', label: 'App' },
  { code: 'exe', label: 'EXE' },
  { code: 'website', label: 'Website' },
  { code: 'database', label: 'Database' },
  { code: 'other', label: 'Other' },
];

export const isDeliverableType = (code) => DELIVERABLE_TYPES.some((t) => t.code === code);

// Every type by name, for form labels: "Module / App / EXE / Website / Database / Other".
export const DELIVERABLE_NAMES = DELIVERABLE_TYPES.map((t) => t.label).join(' / ');

// The longest Other text the server keeps, and the hint shown in its box.
// Website is a type of its own, so the hint no longer suggests it.
export const DELIVERABLE_OTHER_MAX = 40;
export const DELIVERABLE_OTHER_PLACEHOLDER = 'What is it? e.g. Plugin, Report';

// A task can build several; the server stores them as 'module,app', which reads
// "Module + App". Other reads as its typed text ('module,other' + 'Plugin' →
// "Module + Plugin"), or plain "Other" when there is none yet.
export const deliverableLabel = (code, other) =>
  String(code || '')
    .split(',')
    .map((c) => (c === 'other'
      ? (String(other || '').trim() || 'Other')
      : (DELIVERABLE_TYPES.find((t) => t.code === c) || {}).label))
    .filter(Boolean)
    .join(' + ');

// What to show for a task the server sent: its own label when it made one,
// else built from the codes.
export const taskDeliverableLabel = (task) =>
  (task && task.deliverable_label) || deliverableLabel(task && task.deliverable_type, task && task.deliverable_other);

// Multi-select: one task can build several, held as 'module,app'.
const codesOf = (value) => String(value || '').split(',').filter(Boolean);

export const hasDeliverable = (value, code) => codesOf(value).includes(code);

// Other is picked, so its text box shows and must be filled in.
export const needsOtherText = (value) => hasDeliverable(value, 'other');

// Other picked but its text left blank — the server refuses this.
export const missingOtherText = (value, other) => needsOtherText(value) && !String(other || '').trim();

// Tick or untick one type. Always returns the codes in DELIVERABLE_TYPES order —
// the same order the server stores them in, so 'app,module' never reaches it.
export const toggleDeliverable = (value, code) => {
  const on = new Set(codesOf(value));
  if (on.has(code)) on.delete(code); else on.add(code);
  return DELIVERABLE_TYPES.map((t) => t.code).filter((c) => on.has(c)).join(',');
};

export const DELIVERABLE_REQUIRED_MSG = 'Pick a type — Module, App, EXE, Website, Database or Other.';
// Word for word the server's refusal (models/kpi.py clean_deliverable).
export const DELIVERABLE_OTHER_REQUIRED_MSG = 'Type what the Other type is (e.g. Plugin, Website).';
