/* What can be done to a task, by whom, from where — the one place the board
   cards, the task panel and drag-and-drop agree on. Everything here mirrors
   the mobile board's buttons; the server re-checks every rule. */
import { estimateSeconds, laneForTask, PRIORITY_LANES } from "@/lib/services/kpiActions";
import { gateLabel } from "@/lib/liveTime";

export const isMine = (task, me) => !!me && task.user_id === me.uid;
export const canManage = (me) => me?.role === "admin";

/* The buttons for a card/panel, in display order: [{key, label, kind, icon, dialog?, disabled, reason, card?}].
   Like the Odoo board (getButtonsForState), Start / Pause / Resume / Complete
   follow the task's STATE, not the lane it sits in: a self-created task that
   was sent back sits in Pending review but is paused, so it gets Resume.
   `card: true` marks the main buttons that also show on the board card. */
const NOT_STARTABLE = ["in_progress", "paused", "partially_completed", "awaiting_client", "completed"];
export function actionsFor(task, me, { workdayLocked = false } = {}) {
  if (!task) return [];
  const lane = laneForTask(task);
  const st = task.task_state;
  const admin = canManage(me);
  const mine = isMine(task, me);
  const out = [];
  const add = (a) => out.push(a);
  const locked = workdayLocked && !admin;
  const gate = gateLabel(task);
  const lockReason = locked ? "Start your workday first" : gate;
  /* Start / Pause / Complete / Resume log time to whoever presses them, so only
     the assignee (or anyone, on an unassigned task) may. An admin still sees
     them on someone else's task, greyed out with the reason. */
  const actor = mine || !task.user_id;
  const who = task.user_name || "the assignee";
  const notYours = (verb) => `Only ${who} can ${verb} this task`;

  if (lane === "pending_review" && admin) {
    add({ key: "accept_self", label: "Accept", kind: "primary", icon: "check", dialog: "accept", card: true });
    add({ key: "sendback_self", label: "Send back", kind: "ghost", icon: "swap", dialog: "sendback" });
  }
  if (!NOT_STARTABLE.includes(st)) {
    if (actor) add({ key: "start", label: "Start", kind: "primary", icon: "play", dialog: "start", disabled: locked || task.can_start === false, reason: lockReason, card: true });
    else if (admin) add({ key: "start", label: "Start", kind: "primary", icon: "play", disabled: true, reason: notYours("start"), card: true });
  }
  if (st === "in_progress") {
    if (actor) {
      add({ key: "pause", label: "Pause", kind: "default", icon: "pause", dialog: "pause", disabled: locked, card: true });
      add({ key: "complete", label: "Complete", kind: "ok", icon: "check", dialog: "complete", disabled: locked, card: true });
    } else if (admin) {
      add({ key: "pause", label: "Pause", kind: "default", icon: "pause", disabled: true, reason: notYours("pause"), card: true });
      add({ key: "complete", label: "Complete", kind: "ok", icon: "check", disabled: true, reason: notYours("complete"), card: true });
    }
    if (mine) add({ key: "switch", label: "Switch to…", kind: "ghost", icon: "swap", dialog: "switch", disabled: locked });
  }
  if (st === "paused") {
    /* Resume runs the timer as whoever presses it, so only the assignee can.
       An admin still sees it, greyed out with the reason, instead of nothing. */
    if (actor) add({ key: "resume", label: "Resume", kind: "primary", icon: "play", dialog: task.self_needs_resume_reason ? "resume_reason" : "resume", disabled: locked || task.can_start === false, reason: lockReason, card: true });
    else if (admin) add({ key: "resume", label: "Resume", kind: "primary", icon: "play", disabled: true, reason: notYours("resume"), card: true });
    if (actor) add({ key: "complete", label: "Complete", kind: "ok", icon: "check", dialog: "complete", disabled: locked, card: true });
    else if (admin) add({ key: "complete", label: "Complete", kind: "ok", icon: "check", disabled: true, reason: notYours("complete"), card: true });
  }
  if (task.can_undo_start && (mine || admin)) {
    add({ key: "undo_start", label: "Undo start", kind: "ghost", icon: "swap", dialog: "undo_start" });
  }
  if (lane === "approvals" && admin) {
    add({ key: "approve", label: "Approve", kind: "ok", icon: "check", dialog: "approve", card: true });
    add({ key: "reject", label: "Send back", kind: "danger", icon: "x", dialog: "reject" });
  }
  if (lane === "awaiting_client" && admin) {
    add({ key: "revert_signoff", label: "Revert sign-off", kind: "ghost", icon: "swap", dialog: "revert" });
  }
  if (canAddTime(task, mine, admin)) {
    add({ key: "add_time", label: "Add time", kind: "ghost", icon: "clock", dialog: "add_time" });
  }
  if (admin && st !== "completed") {
    add({ key: "reassign", label: "Reassign", kind: "ghost", icon: "people", dialog: "reassign" });
    if (PRIORITY_LANES.includes(lane)) add({ key: "priority", label: "Priority", kind: "ghost", icon: "flag", dialog: "priority" });
  }
  if (admin && task.can_admin_delete) add({ key: "delete", label: "Delete", kind: "danger", icon: "trash", dialog: "delete" });
  return out;
}

/* Odoo's canAddTime: only on a started task (running or paused), for its
   owner or an admin, once 80% of the estimate is used (or there is none). */
function canAddTime(task, mine, admin) {
  if (!["in_progress", "paused"].includes(task.task_state) || !(mine || admin)) return false;
  const est = estimateSeconds(task);
  if (!est) return true;
  const running = task.task_state === "in_progress" && task.timer_start_datetime;
  const spent = (task.timer_total_seconds || 0) + (running ? Math.max(0, (Date.now() - Date.parse(String(task.timer_start_datetime).replace(" ", "T") + (String(task.timer_start_datetime).endsWith("Z") ? "" : "Z"))) / 1000) : 0);
  return spent >= est * 0.8;
}

/* Drag-and-drop: which lanes a card may be dropped on, and what that means.
   Returns { [laneKey]: { action, dialog? } } for the allowed targets only. */
export function dropTargets(task, me, { workdayLocked = false } = {}) {
  const from = laneForTask(task);
  const admin = canManage(me);
  const mine = isMine(task, me);
  const actor = mine || !task.user_id; /* start/pause/resume/complete: the assignee only (see actionsFor) */
  const t = {};
  if (workdayLocked && !admin) return t;
  const own = task.priority === "urgent" ? "urgent" : task.priority === "important" ? "important" : "regular";

  if (["regular", "important", "urgent"].includes(from)) {
    if (actor && task.can_start !== false) t.in_progress = { action: "start", dialog: "start" };
    if (admin) for (const p of PRIORITY_LANES) if (p !== from) t[p] = { action: "priority", priority: p };
  }
  if (from === "pending_review" && admin) {
    for (const p of PRIORITY_LANES) t[p] = { action: "accept_self", dialog: "accept", priority: p };
  }
  if (from === "in_progress") {
    if (actor) {
      t.paused = { action: "pause", dialog: "pause" };
      t.approvals = { action: "complete", dialog: "complete" };
    }
    if ((mine || admin) && task.can_undo_start) t[own] = { action: "undo_start", dialog: "undo_start" };
  }
  if (from === "paused" || (from === "pending_review" && task.task_state === "paused")) {
    if (actor && task.can_start !== false) t.in_progress = { action: "resume", dialog: task.self_needs_resume_reason ? "resume_reason" : "resume" };
    if (actor) t.approvals = { action: "complete", dialog: "complete" };
    if ((mine || admin) && task.can_undo_start) t[own] = { action: "undo_start", dialog: "undo_start" };
  }
  if (from === "approvals" && admin) {
    t.completed = { action: "approve", dialog: "approve" };
    t[own] = { action: "reject", dialog: "reject" };
  }
  return t;
}
