// Live elapsed-time helpers, shared by the Action Board and the Home card.
//
// These lived as module-local functions inside KpiActionBoard.js. Home needs the
// same three, and a second copy is how two screens start disagreeing about what
// time it is -- the board would say 01:24:07 and Home 01:24:05 and nobody would
// know which to believe. One definition, imported twice.
//
// Every caller passes `nowMs` from serverNow() (api/odooApi), never Date.now():
// the timers are anchored to server timestamps, so a device clock that is a few
// minutes out would show a task running since before it started.

// Seconds elapsed since an ISO anchor (UTC "...Z"), for live counters.
export function secsSince(isoZ, nowMs) {
  if (!isoZ) return 0;
  const t = Date.parse(isoZ);
  return Number.isNaN(t) ? 0 : Math.max(0, (nowMs - t) / 1000);
}

// Running task time = accrued base + live since timer_start.
// The base matters: a task paused and resumed three times has most of its time
// in timer_total_seconds, and counting only from the current timer_start would
// restart the clock at zero every resume.
export function liveFromAnchor(startIso, base, nowMs) {
  return (base || 0) + secsSince(startIso, nowMs);
}

export function fmtHMS(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h}h ${m}m ${r}s`;
}

// Compact mm:ss / h:mm:ss for the Home card, where a full "1h 24m 7s" competes
// with the task name for one line of width.
export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

// The two day-level counters, from a live_status payload. They lived in
// KpiActionBoard.js; the home-screen widget (utils/taskWidgetState.js) needs the
// same definitions, and a second copy is how the board and the widget would start
// disagreeing about the same day. The board re-exports them unchanged.

// Productive = finished-log base + every RUNNING task's live seconds.
//
// This used to add only `active_task`, which is just the first of them, so a
// developer multitasking two timers watched Productive tick at half the rate the
// two task clocks above it were ticking — the same numbers on the same screen
// disagreeing. The server counts every active log, so summing them all is what
// makes the live figure converge on the one it will be replaced by.
export function productiveLive(live, nowMs) {
  const base = live?.productive_base || 0;
  const running = live?.active_tasks?.length
    ? live.active_tasks
    : (live?.active_task ? [live.active_task] : []);
  return running.reduce(
    (sum, at) => sum + (at?.timer_start ? secsSince(at.timer_start, nowMs) : 0),
    base,
  );
}

// Live Presence — TIME AT WORK: the clock since login MINUS whatever the
// workday has been paused for. Matches the server's presence_seconds exactly
// (kpi.work.session._compute_totals), which takes off the same two pieces.
//
// BOTH halves of the pause are needed. paused_base holds the COMPLETED pauses;
// paused_since is the one currently open, which the server deliberately never
// folds into paused_seconds. Read only the base and this clock would run straight
// through the freeze — the exact thing pausing exists to stop.
//
// The `· paused` marker beside this is what says why it has stopped, so a
// deliberately frozen clock cannot read as a stuck display.
export function presenceLive(live, nowMs) {
  if (!live?.login_raw) return 0;
  const paused = (live.paused_base || 0)
    + (live.paused_since ? secsSince(live.paused_since, nowMs) : 0);
  return Math.max(0, secsSince(live.login_raw, nowMs) - paused);
}
