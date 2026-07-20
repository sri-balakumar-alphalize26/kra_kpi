// The one place that decides what the Workday button says and does — shared by
// the Action Board button and the Home read-only bar so they can never disagree.
//
// Kept as a PURE function with zero React Native / Expo imports on purpose: it is
// the whole start/continue/end decision, and it unit-tests under plain `jest`
// without a device, an emulator, or the RN test preset. Written as CommonJS so
// `jest` requires it natively (no babel transform), while the app imports it with
// `import { workdayButtonState }` through Metro's CJS interop.
//
// Inputs (all booleans):
//   locked      — the developer is NOT paired (read-only board). = workdayLocked.
//   workdayOpen — the server has an OPEN kpi.work.session for today.
//   dayDone     — today was ENDED explicitly (End Workday); no restart allowed.
//                 Auto-close (idle / midnight) is NOT dayDone — those still restart.
//
// The states, in priority order:
//   paired + open           → "End Workday"              (action 'end')
//   done for today          → "Workday ended for today"  (disabled, action 'none')
//   locked + open           → "Continue Workday"         (action 'pair' → resume PIN)
//   locked + not open       → "Start Workday"            (action 'pair' → start PIN)
//   paired + not open       → "Start Workday"            (action 'start' → open directly)
//
//   action: 'end'   → open the End-Workday summary popup
//           'pair'  → route to the PIN screen (pairing opens/continues the workday)
//           'start' → open the workday directly (already paired, session not open — an edge)
//           'none'  → no-op (button is disabled)

function workdayButtonState({ locked, workdayOpen, dayDone } = {}) {
  // Paired and working → the only way forward is End.
  if (!locked && workdayOpen) {
    return { label: 'End Workday', action: 'end', disabled: false };
  }
  // Ended today (explicit End Workday) → one-per-day rule: no restart until tomorrow.
  // Checked before the open/continue cases so a lingering state can't offer a restart.
  if (dayDone) {
    return { label: 'Workday ended for today', action: 'none', disabled: true };
  }
  // Session still open but this device is unpaired (tab closed / auto-away) → the
  // day is already running; re-pairing CONTINUES it, it doesn't start a new one.
  if (locked && workdayOpen) {
    return { label: 'Continue Workday', action: 'pair', disabled: false };
  }
  // Locked, nothing open → a fresh start, which for an unpaired device means pairing.
  if (locked) {
    return { label: 'Start Workday', action: 'pair', disabled: false };
  }
  // Already paired but no open session (rare edge) → open the workday directly.
  return { label: 'Start Workday', action: 'start', disabled: false };
}

module.exports = { workdayButtonState };
module.exports.default = workdayButtonState;
