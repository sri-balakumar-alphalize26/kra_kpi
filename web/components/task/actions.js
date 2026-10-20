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
  /* Start / Pause / Complete / Resume: the assignee, anyone on an unassigned
     task, or an admin on any task, the same rule as the server
     (_task_actor_or_refuse) and the Odoo board, which offers them to admins. */
  const actor = mine || !task.user_id || admin;

  if (lane === "pending_review" && admin) {
    add({ key: "accept_self", label: "Accept", kind: "primary", icon: "check", dialog: "accept", card: true });
    add({ key: "sendback_self", label: "Send back", kind: "ghost", icon: "swap", dialog: "sendback" });
  }
  if (!NOT_STARTABLE.includes(st)) {
    if (actor) add({ key: "start", label: "Start", kind: "primary", icon: "play", dialog: "start", disabled: locked || task.can_start === false, reason: lockReason, card: true });
  }
  if (st === "in_progress") {
    if (actor) {
      add({ key: "pause", label: "Pause", kind: "default", icon: "pause", dialog: "pause", disabled: locked, card: true });
      add({ key: "complete", label: "Complete", kind: "ok", icon: "check", dialog: "complete", disabled: locked, card: true });
    }
    if (mine) add({ key: "switch", label: "Switch to…", kind: "ghost", icon: "swap", dialog: "switch", disabled: locked });
  }
  if (st === "paused") {
    if (actor) add({ key: "resume", label: "Resume", kind: "primary", icon: "play", dialog: task.self_needs_resume_reason ? "resume_reason" : "resume", disabled: locked || task.can_start === false, reason: lockReason, card: true });
    if (actor) add({ key: "complete", label: "Complete", kind: "ok", icon: "check", dialog: "complete", disabled: locked, card: true });
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
  /* Admin only, and only when the task has time recorded YESTERDAY (the
     server sends prev_day_seconds to admins alone). Decrease only. */
  if (admin && (task.prev_day_seconds || 0) > 0) {
    add({ key: "reduce_prev", label: "Reduce yesterday", kind: "ghost", icon: "clock", dialog: "reduce_prev" });
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
   Returns { [laneKey]: { action, dialog?, hint } } for the allowed targets only.
   A drop never moves a card by itself: it runs the same action (and opens the
   same dialog, with its required fields) as the button would. `hint` is what
   the lane shows while the card is dragged over the board. */
const PRI_LABEL = { regular: "Regular", important: "Important", urgent: "Urgent" };
export function dropTargets(task, me, { workdayLocked = false } = {}) {
  const from = laneForTask(task);
  const admin = canManage(me);
  const mine = isMine(task, me);
  const actor = mine || !task.user_id || admin; /* start/pause/resume/complete: same rule as actionsFor */
  const t = {};
  if (workdayLocked && !admin) return t;
  const own = task.priority === "urgent" ? "urgent" : task.priority === "important" ? "important" : "regular";
  const complete = { action: "complete", dialog: "complete", hint: "Complete: checklist and progress note needed" };
  const undo = { action: "undo_start", dialog: "undo_start", hint: "Undo start" };

  /* No dragging between Regular / Important / Urgent: priority changes only
     through the task's Priority button, so a stray drag can't escalate a task. */
  if (["regular", "important", "urgent"].includes(from)) {
    if (actor && task.can_start !== false) t.in_progress = { action: "start", dialog: "start", hint: "Start this task" };
  }
  if (from === "pending_review" && admin) {
    for (const p of PRIORITY_LANES) t[p] = { action: "accept_self", dialog: "accept", priority: p, hint: `Accept as ${PRI_LABEL[p]}` };
  }
  if (from === "in_progress") {
    if (actor) {
      t.paused = { action: "pause", dialog: "pause", hint: "Pause: pick a reason" };
      t.approvals = complete;
    }
    if ((mine || admin) && task.can_undo_start) t[own] = undo;
  }
  if (from === "paused" || (from === "pending_review" && task.task_state === "paused")) {
    if (actor && task.can_start !== false) t.in_progress = task.self_needs_resume_reason
      ? { action: "resume", dialog: "resume_reason", hint: "Resume: say what you changed" }
      : { action: "resume", dialog: "resume", hint: "Resume this task" };
    if (actor) t.approvals = complete;
    if ((mine || admin) && task.can_undo_start) t[own] = undo;
  }
  if (from === "approvals" && admin) {
    t.completed = { action: "approve", dialog: "approve", hint: "Approve: review checklist needed" };
    t[own] = { action: "reject", dialog: "reject", hint: "Send back: reason needed" };
  }
  return t;
}

/* Why a card can't go to lane `to` (only asked when dropTargets has no entry
   for it), so a refused drop says what to do instead of just "not allowed". */
export function dropBlockedReason(task, me, to, { workdayLocked = false } = {}) {
  const from = laneForTask(task);
  const st = task.task_state;
  const admin = canManage(me);
  const actor = isMine(task, me) || !task.user_id || admin;
  if (workdayLocked && !admin) return "Start your workday first.";
  if (to === "completed") return "Only an admin approval moves a task to Completed.";
  if (to === "awaiting_client") return "A task goes to Awaiting client by itself once the admin approves it.";
  if (to === "pending_review") return "Pending review only holds new self-created tasks.";
  if (!actor && ["in_progress", "paused", "approvals"].includes(to)) return "Only the assignee or an admin can move this task.";
  if (to === "approvals") return "Start the task first. Only a running or paused task can be sent for approval.";
  if (to === "paused") return "Only a running task can be paused.";
  if (to === "in_progress") {
    if (task.can_start === false) return `${gateLabel(task) || "This task can't be started yet"}.`;
    if (["approvals", "awaiting_client", "completed"].includes(from)) return "This task is already finished. An admin can send it back from Pending approvals.";
    return "That move isn't allowed from here.";
  }
  if (PRIORITY_LANES.includes(to)) {
    if (PRIORITY_LANES.includes(from)) return admin ? "Priority can't be changed by dragging. Open the task and use Priority." : "Only an admin can change a task's priority.";
    if (!admin) return "Only an admin can change a task's priority.";
    if (st === "in_progress" || st === "paused") return "A started task keeps its priority. Use Undo start to move it back.";
    if (from === "approvals") return `To send it back, drop it on its own lane, ${PRI_LABEL[task.priority] || "Regular"}.`;
  }
  return "That move isn't allowed from here.";
}
