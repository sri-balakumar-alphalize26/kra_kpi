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

export const deliverableLabel = (code) =>
  (DELIVERABLE_TYPES.find((t) => t.code === code) || {}).label || '';

export const DELIVERABLE_REQUIRED_MSG = 'Pick a type — Module, App or EXE.';
