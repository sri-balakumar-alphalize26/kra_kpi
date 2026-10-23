// What the running-task home-screen widget should show, given a live_status
// payload. Pure — no React Native imports — and unit-tested, for the same reason
// utils/liveTrackingWidgetState.js is: a widget has no error state a person can
// read, so a wrong field here is a wrong number on somebody's home screen with
// nothing anywhere saying why. utils/taskWidget.js only writes the file;
// plugins/withTaskWidget.js (Kotlin) reads every field named below.
//
// TIMESTAMPS ARE DEVICE-CLOCK MILLISECONDS. The widget ticks with Android's own
// clock (a Chronometer), so every server anchor is shifted by the measured clock
// skew before it is written — otherwise a tablet 65 s fast (one of ours) shows a
// timer 65 s ahead of the app, which corrects for the same skew through
// serverNow(). `skewMs` is api/odooApi's clockSkewMs(): device minus server.

import { presenceLive, productiveLive } from './liveTime';

function toDeviceMs(isoZ, skewMs) {
  if (!isoZ) return 0;
  const t = Date.parse(isoZ);
  return Number.isNaN(t) ? 0 : t + (skewMs || 0);
}

function runningTasks(live) {
  if (live?.active_tasks?.length) return live.active_tasks;
  return live?.active_task ? [live.active_task] : [];
}

/**
 * @param {object|null} live   the /kpi_action/live_status payload
 * @param {{skewMs?: number}} opts
 * @returns {object} the widget's state file (see plugins/withTaskWidget.js)
 */
export function shapeTaskWidget(live, { skewMs = 0 } = {}) {
  const running = runningTasks(live);
  const first = running[0];
  const startedAtMs = first?.timer_start ? toDeviceMs(first.timer_start, skewMs) : 0;
  const isRunning = !!(first && startedAtMs);

  // What Resume would resume: the task a break was taken FROM, and only while
  // nothing is running — with a timer going, the button is Pause.
  const brk = live?.active_break || null;
  const resumeId = (!isRunning && brk?.source_task_id) ? Number(brk.source_task_id) || 0 : 0;

  // The "away" row: a declared break/lunch/meeting, whether it came from pausing
  // a task (active_break) or from declaring it with no task (nontask block).
  const nontask = live?.nontask || null;
  const away = brk
    ? { label: brk.type_label || 'Break', startRaw: brk.start_raw }
    : (nontask ? { label: nontask.reason_label || nontask.reason || 'Away', startRaw: nontask.start_raw } : null);

  return {
    running: isRunning,
    task_name: first?.name || '',
    task_count: running.length,
    started_at_ms: startedAtMs,
    base_seconds: Math.max(0, Math.round(first?.timer_total_seconds || 0)),
    workday_open: !!live?.workday_open,

    // For the widget's button (plugins/withTaskWidget.js → krakpi://widget/home).
    kpi_id: isRunning ? Number(first.id) || 0 : 0,
    resume_kpi_id: resumeId,
    resume_task_name: resumeId ? (brk.source_task_name || '') : '',

    // Day counters, as anchors the widget ticks from itself.
    login_raw_ms: toDeviceMs(live?.login_raw, skewMs),
    paused_base_s: Math.max(0, Math.round(live?.paused_base || 0)),
    paused_since_ms: live?.is_paused ? toDeviceMs(live?.paused_since, skewMs) : 0,
    is_paused: !!live?.is_paused,
    productive_base_s: Math.max(0, Math.round(live?.productive_base || 0)),
    // Every running timer's start, so Productive ticks at the right rate while
    // multitasking (the board sums them all too — see productiveLive).
    running_started_at_ms: running
      .map((t) => (t?.timer_start ? toDeviceMs(t.timer_start, skewMs) : 0))
      .filter(Boolean),
    away_label: away?.label || '',
    away_started_at_ms: away ? toDeviceMs(away.startRaw, skewMs) : 0,
  };
}

/** The file's contents when nobody is signed in or the workday has ended. */
export function emptyTaskWidgetState() {
  return shapeTaskWidget(null);
}

// The arithmetic the Kotlin provider does with the anchors above, written once
// in JS so a test can hold it against presenceLive / productiveLive — the board's
// own counters — and prove the widget and the app agree to the second.

/** Presence (time at work) in seconds at `nowMs`, from a state file. */
export function presenceSecondsAt(state, nowMs) {
  if (!state?.login_raw_ms) return 0;
  const openPause = state.paused_since_ms ? Math.max(0, (nowMs - state.paused_since_ms) / 1000) : 0;
  const paused = (state.paused_base_s || 0) + openPause;
  return Math.max(0, (nowMs - state.login_raw_ms) / 1000 - paused);
}

/** Productive seconds at `nowMs`, from a state file. */
export function productiveSecondsAt(state, nowMs) {
  const starts = Array.isArray(state?.running_started_at_ms) ? state.running_started_at_ms : [];
  return starts.reduce(
    (sum, t) => sum + Math.max(0, (nowMs - t) / 1000),
    state?.productive_base_s || 0,
  );
}

export { presenceLive, productiveLive };
