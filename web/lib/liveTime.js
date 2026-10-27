/* Live elapsed-time helpers (port of the app's utils/liveTime.js). Every
   caller passes `nowMs` from serverNow() (lib/api), never Date.now(): the
   timers are anchored to server timestamps. */

export function secsSince(isoZ, nowMs) {
  if (!isoZ) return 0;
  const t = Date.parse(isoZ);
  return Number.isNaN(t) ? 0 : Math.max(0, (nowMs - t) / 1000);
}

/* Running task time = accrued base + live since timer_start. */
export function liveFromAnchor(startIso, base, nowMs) {
  return (base || 0) + secsSince(startIso, nowMs);
}

export function fmtHMS(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${h}h ${m}m ${r}s`;
}

export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/* Productive = finished-log base + every RUNNING task's live seconds. */
export function productiveLive(live, nowMs) {
  const base = live?.productive_base || 0;
  const running = live?.active_tasks?.length ? live.active_tasks : (live?.active_task ? [live.active_task] : []);
  return running.reduce((sum, at) => sum + (at?.timer_start ? secsSince(at.timer_start, nowMs) : 0), base);
}

/* Presence = time since login minus completed pauses minus the open pause. */
export function presenceLive(live, nowMs) {
  if (!live?.login_raw) return 0;
  const paused = (live.paused_base || 0) + (live.paused_since ? secsSince(live.paused_since, nowMs) : 0);
  return Math.max(0, secsSince(live.login_raw, nowMs) - paused);
}

/* "at 14:35" for a server UTC timestamp, in the browser's zone. */
export function fmtWhen(serverTs) {
  if (!serverTs) return "";
  const m = String(serverTs).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  if (Number.isNaN(d.getTime())) return "";
  return "at " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* Why a task's Start button is dimmed, in the SERVER's words (utils/taskGate.js). */
export function gateLabel(task) {
  if (!task || task.can_start !== false) return "";
  if (["completed", "awaiting_client", "partially_completed"].includes(task.task_state)) return "";
  if (task.start_block_reason === "workday") return "Start your workday to work on tasks";
  if (task.start_block_reason === "workday_paused") return "Resume your workday to work on tasks";
  if (task.start_block_reason === "multitask") return "Pause your running task first";
  /* Nothing is accepted or released automatically (module 19.0.8.6): say where
     the approval stands (approval_stage_label), never a countdown. */
  if (task.start_block_reason === "admin") return task.approval_stage_label || "Waiting for approval";
  if (task.start_block_reason === "client" || (!task.start_block_reason && task.pre_approval_held)) {
    if (task.pre_approval_held) return "Client put approval on hold";
    return task.approval_stage_label || "Waiting for client approval";
  }
  /* Any other (or newer) reason: the server's own sentence (_gate_keys start_block_message). */
  return task.start_block_message || "This task can't be started right now";
}

/* What the Workday button says and does (utils/workdayState.js). */
export function workdayButtonState({ workdayOpen, dayDone, todayClosed, reopened } = {}) {
  if (workdayOpen) return { label: "End workday", action: "end", disabled: false };
  if (dayDone) return { label: "Workday ended for today", action: "none", disabled: true };
  if (todayClosed && reopened) return { label: "Reopen and continue workday", action: "start", disabled: false };
  if (todayClosed) return { label: "Start new workday session", action: "start", disabled: false };
  return { label: "Start workday", action: "start", disabled: false };
}

/* Relative "2h ago" / "yesterday" for server timestamps. `serverTs` is UTC
   (fields.Datetime.to_string / isoformat()+'Z'); pass { local: true } for a
   wall-clock string already in the user's zone (convert_to_user_tz). */
export function since(serverTs, nowMs = Date.now(), { local = false } = {}) {
  const m = String(serverTs || "").match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return "";
  const t = local
    ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime()
    : Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return sinceMs(t, nowMs);
}
export function sinceMs(t, nowMs = Date.now()) {
  if (t == null || Number.isNaN(t)) return "";
  const d = Math.max(0, nowMs - t) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 172800) return "yesterday";
  return new Date(t).toLocaleDateString([], { day: "numeric", month: "short" });
}

/* A React hook: a `now` that ticks every second from the server clock, paused
   while the tab is hidden. Every caller with the same interval shares ONE
   timer, so a board of running timers ticks together on one interval. */
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { serverNow } from "@/lib/api";
const clocks = new Map(); /* everyMs -> { now, subs, id } */
function subscribeClock(everyMs, cb) {
  let c = clocks.get(everyMs);
  if (!c) { c = { now: serverNow(), subs: new Set(), id: null }; clocks.set(everyMs, c); }
  c.subs.add(cb);
  if (!c.id) {
    c.tick = () => { if (document.visibilityState === "visible") { c.now = serverNow(); for (const f of [...c.subs]) f(); } };
    c.now = serverNow();
    c.id = setInterval(c.tick, everyMs);
    document.addEventListener("visibilitychange", c.tick);
  }
  return () => {
    c.subs.delete(cb);
    if (!c.subs.size && c.id) { clearInterval(c.id); c.id = null; document.removeEventListener("visibilitychange", c.tick); }
  };
}
const noop = () => () => {};
export function useNow(active = true, everyMs = 1000) {
  const [first] = useState(() => serverNow());
  const last = useRef(first);
  const subscribe = useCallback((cb) => subscribeClock(everyMs, cb), [everyMs]);
  const now = useSyncExternalStore(active ? subscribe : noop, () => {
    const c = active && clocks.get(everyMs);
    return c && c.id ? c.now : last.current;
  }, () => first);
  last.current = now;
  return now;
}
