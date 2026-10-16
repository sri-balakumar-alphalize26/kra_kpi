// The estimate for an admin's "Add Done Task" — work that already happened, so
// the real number is the time worked and the estimate is what someone would
// plausibly have said up front.
//
// A random 20–40% over the time worked, on a quarter hour, at least 15 minutes
// more, and at most 2h more for a Module or EXE, 3h when an App is among the
// types: 5h worked gives 6h, 6h 15m … 7h. "Worked + 1 minute" read as made up.
//
// Same rule as _estimateFromWorked on the web board
// (odoo_modules/kra_kpi_module/static/src/components/kpi_action/kpi_action.js) —
// change both together.

const QUARTER = 15 * 60;

// deliverables: 'module,app' style. rand: injectable for tests.
export function estimateFromWorked(workedSeconds, deliverables, rand = Math.random) {
  const worked = Math.max(0, Number(workedSeconds) || 0);
  const hasApp = String(deliverables || '').split(',').includes('app');
  const maxExtra = (hasApp ? 3 : 2) * 3600;
  const extra = Math.round((worked * (0.2 + rand() * 0.2)) / QUARTER) * QUARTER;
  const est = worked + Math.min(Math.max(extra, QUARTER), maxExtra);
  return Math.ceil(est / QUARTER) * QUARTER;
}
