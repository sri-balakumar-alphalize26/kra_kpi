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
//   todayClosed — a session for today was closed, by the cron or by an End. Only
//                 meaningful when dayDone is false, i.e. the cron closed it and a
//                 restart IS allowed. It changes the words, never the action.
//   reopened    — an admin reopened an explicitly-ended day (/kpi_workday/revert).
//                 Optional: omit it and todayClosed keeps its old wording, which
//                 is why adding it broke no caller. Only read when todayClosed.
//
// The states, in priority order:
//   open              → "End Workday"              (action 'end')
//   done for today    → "Workday ended for today"  (disabled, action 'none')
//   reopened by admin → "Reopen and Continue Workday" (action 'start')
//   auto-closed       → "Start New Workday Session" (action 'start')
//   otherwise         → "Start Workday"            (action 'start')
//
// There used to be a third input, `locked`, meaning "this device is not paired",
// and a fourth action, 'pair', which routed to a PIN screen. Both are gone with
// the PIN itself. Read-only is now decided by the workday: a developer is locked
// out of acting until they press Start Workday, and locked again once they End
// it — so `locked` was just `!workdayOpen` spelled a second way, and keeping both
// only created the chance for them to disagree.

function workdayButtonState({ workdayOpen, dayDone, todayClosed, reopened } = {}) {
  // Working → the only way forward is End.
  if (workdayOpen) {
    return { label: 'End Workday', action: 'end', disabled: false };
  }
  // Ended today (explicit End Workday) → one-per-day rule: no restart until
  // tomorrow. Checked before the start case so a lingering flag can't offer one.
  if (dayDone) {
    return { label: 'Workday ended for today', action: 'none', disabled: true };
  }
  // A session today was closed but not BY the developer, so the cron closed it —
  // most often at midnight on a day left running. Same action, different words:
  // "Start Workday" on a day that has already had one reads as though nothing has
  // happened yet, which is how a developer discovers their day was cut only from
  // the hours being wrong later.
  // An admin reopened an ended day. Same action again, different words again —
  // and this is a DIFFERENT cause from the cron, which is why it needs its own
  // branch: todayClosed is true either way, so one label was serving both. The
  // developer is looking at a banner that says "Workday reopened by X: <reason>"
  // and a button that says "Start New Workday Session", which reads as though
  // the reopen never happened. The push they already got says "press Resume to
  // carry on", so the button should not be the one thing calling it a new day.
  //
  // At the data layer a second kpi.work.session IS created for the same date
  // (action_revert_day leaves the ended row closed, and the day's totals
  // aggregate across sessions). "Continue" describes what the person is doing,
  // which is what a button is for; "Reopen" ties it to the banner above it.
  if (todayClosed && reopened) {
    return { label: 'Reopen and Continue Workday', action: 'start', disabled: false };
  }
  if (todayClosed) {
    return { label: 'Start New Workday Session', action: 'start', disabled: false };
  }
  // Nothing open, nothing ended → start the day.
  return { label: 'Start Workday', action: 'start', disabled: false };
}

module.exports = { workdayButtonState };
module.exports.default = workdayButtonState;
