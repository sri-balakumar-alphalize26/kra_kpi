// What a task builds: an Odoo Module, a mobile App or a desktop EXE. A second
// axis next to REQ / UPT / BUG (what KIND of work it is), stored on the server as
// kra.kpi.deliverable_type. Every create form asks for it; the server only
// refuses values outside this list, so older builds that never send it still work.

export const DELIVERABLE_TYPES = [
  { code: 'module', label: 'Module' },
  { code: 'app', label: 'App' },
  { code: 'exe', label: 'EXE' },
];

export const isDeliverableType = (code) => DELIVERABLE_TYPES.some((t) => t.code === code);

// A task can build several; the server stores them as 'module,app', which reads
// "Module + App".
export const deliverableLabel = (code) =>
  String(code || '')
    .split(',')
    .map((c) => (DELIVERABLE_TYPES.find((t) => t.code === c) || {}).label)
    .filter(Boolean)
    .join(' + ');

// Multi-select: one task can build several, held as 'module,app'.
const codesOf = (value) => String(value || '').split(',').filter(Boolean);

export const hasDeliverable = (value, code) => codesOf(value).includes(code);

// Tick or untick one type. Always returns the codes in DELIVERABLE_TYPES order —
// the same order the server stores them in, so 'app,module' never reaches it.
export const toggleDeliverable = (value, code) => {
  const on = new Set(codesOf(value));
  if (on.has(code)) on.delete(code); else on.add(code);
  return DELIVERABLE_TYPES.map((t) => t.code).filter((c) => on.has(c)).join(',');
};

export const DELIVERABLE_REQUIRED_MSG = 'Pick a type — Module, App or EXE.';
