// Why a task's Start button is dimmed, in the SERVER's words — the one place
// the app turns a start_block_reason into a line of text.
//
// A direct port of the web board's gateLabel (kpi_action.js) so the two boards
// explain a blocked task identically. The reason itself comes from
// kra.kpi._start_block, shipped on every task as can_start /
// start_block_reason / start_block_message. NOTHING here re-derives it from
// task_state — that re-derivation is exactly how the app and the server drifted
// apart before, offering a Start the server would refuse.
//
// Kept PURE with zero React Native / Expo imports, for the same reason as
// utils/workdayState.js: it is a whole decision on its own and unit-tests under
// plain `jest` with no device, emulator or RN preset. CommonJS so jest requires
// it natively, while the app imports it through Metro's interop.

// "at 14:35" for a server UTC timestamp, in the device's local zone. Built from
// the captured parts rather than passed to Date(): 'YYYY-MM-DD HH:MM:SS' is not
// a format JS is required to parse, and both Hermes and iOS return Invalid Date
// for it. Returns '' when there is nothing usable, so callers fall back to their
// undated wording instead of printing "at Invalid Date".
function fmtWhen(serverTs) {
  if (!serverTs) return '';
  const m = String(serverTs).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  if (Number.isNaN(d.getTime())) return '';
  return 'at ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// '' means "show no badge" — either the task can start, or the reason is not
// worth stating. Never returns a bare "blocked" with no explanation.
function gateLabel(task) {
  if (!task || task.can_start !== false) return '';
  // Finished work has nothing to wait for. can_start is false for a COMPLETED
  // task too — you cannot start it because it is done — and the server still
  // reports the last gate it evaluated, which for a completed task is the
  // client one. Verified against live: REQ-042, task_state 'completed', comes
  // back reason='client', message="waiting for the client to approve". Without
  // this guard that lands on finished cards, which is simply untrue.
  if (['completed', 'awaiting_client', 'partially_completed'].includes(task.task_state)) return '';
  // These two are about the VIEWER, not the task, so they are checked before
  // the approval gates: otherwise a developer who has not started their own day
  // is told the client is holding them up.
  if (task.start_block_reason === 'workday') return 'Start your workday to work on tasks';
  // Paused is a different fix from never-started — the button they need says
  // Resume, so "start your workday" sends them hunting for one that isn't there.
  if (task.start_block_reason === 'workday_paused') return 'Resume your workday to work on tasks';
  // Also about the viewer rather than the task: they already have something
  // running and multi-task is off for them. Without this branch it fell through
  // to "Waiting for the client to approve", which blames the wrong party
  // entirely for a limit the developer can clear themselves.
  if (task.start_block_reason === 'multitask') return 'Pause your running task first';
  // Nothing is accepted or released automatically (module 19.0.8.6): say where
  // the approval stands (approval_stage_label, e.g. "Waiting for approval —
  // Level 1: Manager (Ravi)"), never a countdown.
  if (task.start_block_reason === 'admin') return task.approval_stage_label || 'Waiting for approval';
  if (task.pre_approval_held) return 'Client put approval on hold';
  return task.approval_stage_label || 'Waiting for client approval';
}

module.exports = { gateLabel, fmtWhen };
