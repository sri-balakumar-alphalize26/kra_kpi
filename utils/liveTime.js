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
