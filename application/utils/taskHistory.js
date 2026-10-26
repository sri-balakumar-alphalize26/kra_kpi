// KPI Details › History ("Everything on this task", /kpi_action/history): the
// work on one task in one list, newest first, by day — the same filters as the
// web's TaskTimeline and Odoo's KPI Details › History. Activity (pauses,
// renames, pushes …) is its own filter and is left out of All, so it does not
// bury the work itself. Pure; tested in utils/__tests__/taskHistory.test.js.

export const HISTORY_FILTERS = [
  { key: 'all', label: 'All', kinds: null },
  { key: 'talks', label: 'Questions', kinds: ['question'] },
  { key: 'progress', label: 'Progress', kinds: ['progress'] },
  { key: 'meetings', label: 'Meetings', kinds: ['meeting'] },
  { key: 'code', label: 'Code', kinds: ['code'] },
  { key: 'documents', label: 'Documents', kinds: ['document'] },
  { key: 'activity', label: 'Activity', kinds: ['activity'] },
];

export const HISTORY_ICON = {
  question: 'help-circle-outline',
  progress: 'create-outline',
  meeting: 'calendar-outline',
  code: 'logo-github',
  document: 'document-attach-outline',
  activity: 'time-outline',
};

// The items one filter shows. All = everything but the activity trail.
export function filterHistory(items, key) {
  const f = HISTORY_FILTERS.find((x) => x.key === key) || HISTORY_FILTERS[0];
  return (items || []).filter((i) => (f.kinds ? f.kinds.includes(i.kind) : i.kind !== 'activity'));
}

// The server's UTC 'YYYY-MM-DD HH:MM:SS' as a local Date, or null.
export function historyDate(at) {
  if (!at) return null;
  const d = new Date(`${String(at).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// "Today" / "Yesterday" / "12 Oct 2026", in the phone's time zone.
export function historyDayLabel(d, now = new Date()) {
  if (!d) return 'No date';
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (day === today) return 'Today';
  if (day === new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Consecutive items of one local day together, in the order given (newest first):
// [{ label, items }].
export function groupHistoryByDay(items, now = new Date()) {
  const days = [];
  for (const it of items || []) {
    const label = historyDayLabel(historyDate(it.at), now);
    if (!days.length || days[days.length - 1].label !== label) days.push({ label, items: [] });
    days[days.length - 1].items.push(it);
  }
  return days;
}
