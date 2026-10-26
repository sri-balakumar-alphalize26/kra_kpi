// "Undo start" — take back a Start made by mistake. The rule lives on the server
// (kra.kpi._can_undo_start_cheap, sent as can_undo_start): the assignee's own
// start today, or — for an admin — any start today, while the task is still
// running or paused. The app only reads the flag, so an older server that never
// sends it simply shows no button.

const UNDO_STATES = ['in_progress', 'paused'];

export function canOfferUndoStart(task, { readOnly = false } = {}) {
  return !readOnly && !!task && task.can_undo_start === true && UNDO_STATES.includes(task.task_state);
}

// The confirmation the popup shows. It deletes today's time on the task, which
// cannot be put back, so it says exactly what goes and where the task lands.
//
// `keeps` is the server's line on what STAYS (/kra_kpi/task/undo_start_info —
// today's updates, links, files, manuals and GitHub links are real work and are
// never removed), shown last as the web's confirm does. Optional: '' or an older
// server leaves it off, and the rest of the message reads the same.
export function undoStartConfirm(task, fmtHMS, keeps = '') {
  const label = [task.external_ref, task.name].filter(Boolean).join(' ');
  // today_seconds is the VIEWER's time today — an admin undoing a developer's
  // start has none, so the figure is only quoted when there is one.
  const secs = Math.max(0, Math.round(task.today_seconds || 0));
  const back = task.undo_start_prev_state_label || 'where it was before today';
  const time = secs > 0 ? `the ${fmtHMS(secs)} logged on it today` : 'the time logged on it today';
  const by = task.undo_start_by ? ` (started by ${task.undo_start_by})` : '';
  const kept = String(keeps || '').trim();
  return {
    title: 'Undo starting this task?',
    message: `${label}${by}\n\n`
      + `It goes back to ${back}, and ${time} is removed. `
      + 'It leaves the Today list, and that time may show as idle on the Workday Map.\n\n'
      + 'This cannot be undone.'
      + (kept ? `\n\n✅ ${kept}` : ''),
    confirmLabel: 'Undo start',
  };
}
