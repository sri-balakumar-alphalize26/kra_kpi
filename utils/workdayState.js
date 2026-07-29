// The one place that decides what the Workday button says and does — shared by
// the Action Board button and the Home read-only bar so they can never disagree.
//
// Kept as a PURE function with zero React Native / Expo imports on purpose: it is
// the whole start/end decision, and it unit-tests under plain `jest` without a
// device, an emulator, or the RN test preset. Written as CommonJS so `jest`
// requires it natively (no babel transform), while the app imports it with
// `import { workdayButtonState }` through Metro's CJS interop.
//
// Inputs (all booleans):
//   workdayOpen — the server has an OPEN kpi.work.session for today.
//   dayDone     — today was ENDED explicitly (End Workday); no restart allowed.
//                 Auto-close (midnight) is NOT dayDone — those still restart.
//
// The states, in priority order:
//   open              → "End Workday"              (action 'end')
//   done for today    → "Workday ended for today"  (disabled, action 'none')
//   otherwise         → "Start Workday"            (action 'start')
//
// There used to be a third input, `locked`, meaning "this device is not paired",
// and a fourth action, 'pair', which routed to a PIN screen. Both are gone with
// the PIN itself. Read-only is now decided by the workday: a developer is locked
// out of acting until they press Start Workday, and locked again once they End
// it — so `locked` was just `!workdayOpen` spelled a second way, and keeping both
// only created the chance for them to disagree.

function workdayButtonState({ workdayOpen, dayDone } = {}) {
  // Working → the only way forward is End.
  if (workdayOpen) {
    return { label: 'End Workday', action: 'end', disabled: false };
  }
  // Ended today (explicit End Workday) → one-per-day rule: no restart until
  // tomorrow. Checked before the start case so a lingering flag can't offer one.
  if (dayDone) {
    return { label: 'Workday ended for today', action: 'none', disabled: true };
  }
  // Nothing open, nothing ended → start the day.
  return { label: 'Start Workday', action: 'start', disabled: false };
}

module.exports = { workdayButtonState };
module.exports.default = workdayButtonState;
