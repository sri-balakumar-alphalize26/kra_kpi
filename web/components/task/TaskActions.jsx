"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useFlags } from "@/components/ui";
import { useMe } from "@/lib/me";
import { invalidate, mutate } from "@/lib/api";
import { useResource } from "@/lib/useFetch";
import * as S from "@/lib/services/kpiActions";
import TaskDialog, { CreateTaskDialog } from "./dialogs";
import TaskPanel from "./TaskPanel";
import TaskAlerts from "./TaskAlerts";

/* Shared by the board, the task panel and Your work:
     const { perform, openDialog, openTask, pauseAll, workday, live, refreshAll } = useTaskActions();
   `perform(key, task, payload)` runs the server call for an action key from
   actions.js, refreshes every read that could have changed, and reports with a
   flag. `openDialog(dialog, task, extra)` shows the matching dialog first.
   `openTask(id)` opens the side panel (?task=<id> in the URL, so it survives a
   reload and can be linked). The Create dialog listens for the top-nav button
   (window event "kpi:create").

   Two contexts underneath. The live and workday reads change every few
   seconds; putting them in the same value as the actions re-rendered every
   consumer (each board card) on every 5 s live poll. useTaskActs() is the
   stable half only: actions plus the workday flags. useTaskActions() is both. */
const ActsCtx = createContext(null);
const LiveCtx = createContext(null);
export const useTaskActs = () => useContext(ActsCtx);
export function useTaskActions() {
  const a = useContext(ActsCtx);
  const l = useContext(LiveCtx);
  return useMemo(() => (a ? { ...a, ...l } : null), [a, l]);
}

export const REFRESH_PREFIXES = ["/kra_kpi/tasks/get", "/kra_kpi/task/", "/kpi_action/live_status", "/kpi_workday/status", "/kpi_action/activity"];

export function TaskActionsProvider({ children }) {
  const { me } = useMe();
  const flags = useFlags();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [dialog, setDialog] = useState(null); /* { dialog, task, extra, resolve } */
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  /* Workday + live status, polled; every developer screen reads these. */
  const workday = useResource(S.WORKDAY_PATH, {}, { pollMs: 30000, ttl: 5000 });
  const live = useResource(S.LIVE_PATH, {}, { pollMs: 5000, ttl: 4000 });
  const workdayOpen = !!workday.data?.is_open;
  const workdayLocked = me.role === "developer" && !workdayOpen;

  /* Heartbeat while the workday is open (what Live Tracking and the auto-away
     cron read). Every 15 s like the Odoo board, and whether or not the tab is
     visible: a developer working in another window is still at work. */
  useEffect(() => {
    if (!workdayOpen) return;
    S.sendHeartbeat().catch(() => {});
    const id = setInterval(() => { S.sendHeartbeat().catch(() => {}); }, 15000);
    return () => clearInterval(id);
  }, [workdayOpen]);

  const workdayRefresh = workday.refresh, liveRefresh = live.refresh;
  const refreshAll = useCallback(() => {
    for (const p of REFRESH_PREFIXES) invalidate(p);
    workdayRefresh(); liveRefresh();
    window.dispatchEvent(new CustomEvent("kpi:refresh"));
  }, [workdayRefresh, liveRefresh]);

  /* After a create, fetch just THAT task and slot it into the cached board
     (Odoo _addTaskCard), instead of re-downloading every task. Anything else
     that changed meanwhile comes with the next poll. Falls back to the full
     refresh if the single read fails for any reason (/kra_kpi/task/get only
     answers admins, the assignee and notified users). */
  const addCreated = useCallback(async (res) => {
    liveRefresh();
    try {
      const task = res?.id ? await S.fetchTaskById(res.id) : null;
      if (!task || !task.id || !task.task_state) throw new Error("no task");
      /* task/get has no estimate_extended_by_name; the spread keeps a known one. */
      const put = (data) => {
        if (!data || !Array.isArray(data.tasks)) return undefined;
        const i = data.tasks.findIndex((x) => x.id === task.id);
        const tasks = i >= 0 ? data.tasks.map((x, j) => (j === i ? { ...x, ...task } : x)) : [...data.tasks, task];
        return { ...data, tasks, self_pending_count: tasks.filter((x) => x.is_self_created && !x.admin_accepted).length };
      };
      mutate(S.TASKS_PATH, { my_tasks_only: false }, put);
      if (task.user_id === me.uid) mutate(S.TASKS_PATH, { my_tasks_only: true }, put);
    } catch (e) {
      refreshAll();
    }
  }, [liveRefresh, refreshAll, me.uid]);

  /* Stable across URL changes: every card's onOpen holds it. */
  const nav = useRef(null);
  nav.current = { params, pathname, router };
  const openTask = useCallback((id) => {
    const { params: p, pathname: path, router: r } = nav.current;
    const sp = new URLSearchParams(p.toString());
    if (id) sp.set("task", String(id)); else sp.delete("task");
    r.replace(`${path}${sp.toString() ? "?" + sp.toString() : ""}`, { scroll: false });
  }, []);
  const openId = params.get("task");

  /* The server call for each action key. */
  const call = useCallback(async (key, task, p = {}) => {
    switch (key) {
      case "start": return S.startTask(task.id);
      case "resume": return p.reason ? S.resumeTaskWithReason(task.id, p.reason) : S.resumeTask(task.id);
      case "pause": return S.pauseTask(task.id, p.reason, p.reasonCode, p.meetingWithIds);
      case "complete": {
        if (p.summary) { const r = await S.createProgress(task.id, p.summary); S.assertOk(r, "Could not save the progress note."); }
        return S.completeTask(task.id, p.employeeChecklist, p.partial);
      }
      case "approve": return S.approveTask(task.id, p.managerChecklist);
      case "reject": return S.rejectTask(task.id, p.reason);
      case "revert_signoff": return S.revertSignoff(task.id, p.reason);
      case "delete": return S.adminDeleteTask(task.id, p.reason);
      case "undo_start": return S.undoTaskStart(task.id);
      case "add_time": return S.addTaskTime(task.id, p.hours, p.minutes, p.reason);
      case "reduce_prev": return S.reducePrevDay(task.id, p.hours, p.minutes, p.reasonCode, p.reasonText);
      case "reassign": return S.reassignTask(task.id, p.userId, p.reason);
      case "switch": return S.switchTask(p.toId, task.id, p.note);
      case "accept_self": return S.acceptSelfCreated(task.id, p.docType, p.priority);
      case "sendback_self": return S.rejectSelfCreated(task.id, p.note, p.discard);
      case "priority": return S.setPriority(task.id, p.priority);
      case "pause_all": return S.pauseAllTasks(p.reason, p.reasonCode, p.meetingWithIds);
      default: throw new Error(`Unknown action ${key}`);
    }
  }, []);

  const DONE = {
    start: "Started.", resume: "Resumed.", pause: "Paused.", complete: "Sent for review.", approve: "Approved.", reject: "Sent back.",
    revert_signoff: "Sign-off reverted.", delete: "Task deleted.", undo_start: "Start undone.", add_time: "Estimate extended.", reduce_prev: "Yesterday's time reduced.",
    reassign: "Reassigned.", switch: "Switched.", accept_self: "Accepted.", sendback_self: "Sent back.", priority: "Priority changed.",
    pause_all: "Paused all running tasks.",
  };

  const perform = useCallback(async (key, task, payload = {}) => {
    setBusy(true);
    try {
      const res = await call(key, task, payload);
      if (res?.needs_confirm) { setBusy(false); return res; }
      S.assertOk(res, "The server refused.");
      flags.ok(res?.message && key !== "start" ? res.message : DONE[key] || "Done.");
      refreshAll();
      return res;
    } catch (e) {
      flags.err(e.message || "Something went wrong.");
      throw e;
    } finally {
      setBusy(false);
    }
  }, [call, flags, refreshAll]);

  /* Dialog → perform. The action key for a dialog name. */
  const ACTION_FOR_DIALOG = { start: "start", resume: "resume", pause: "pause", complete: "complete", approve: "approve", reject: "reject", revert: "revert_signoff", delete: "delete",
    resume_reason: "resume", sendback: "sendback_self", undo_start: "undo_start", add_time: "add_time", reduce_prev: "reduce_prev", reassign: "reassign", switch: "switch", accept: "accept_self", priority: "priority", pause_all: "pause_all" };
  const openDialog = useCallback((name, task, extra) => new Promise((resolve) => setDialog({ dialog: name, task, extra, resolve })), []);
  const onConfirm = async (payload) => {
    const d = dialog;
    try {
      const res = await perform(ACTION_FOR_DIALOG[d.dialog], d.task, { ...(d.extra || {}), ...payload });
      setDialog(null); d.resolve?.(res);
    } catch (e) { /* flag shown; keep the dialog open */ }
  };
  const onClose = () => { dialog?.resolve?.(null); setDialog(null); };

  /* Run an action from actions.js: open its dialog if it has one, else perform. */
  const run = useCallback(async (a, task) => {
    if (a.disabled) { if (a.reason) flags.warn(a.reason); return null; }
    /* Like the Odoo board: opening Approve / Send back marks the review started
       (the card then shows "Review started" to the developer). */
    if (a.key === "approve" || a.key === "reject") S.markReviewStarted(task.id);
    if (a.dialog) return openDialog(a.dialog, task, a.extra);
    return perform(a.key, task, a.extra || {});
  }, [flags, openDialog, perform]);

  /* Pause every task the caller has running (multitask), one shared reason. The
     route takes no task id; the dialog gets a stand-in task for its title. */
  const liveData = useRef(null);
  liveData.current = live.data;
  const pauseAll = useCallback(() => {
    const d = liveData.current;
    const running = d?.active_tasks?.length ? d.active_tasks : d?.active_task ? [d.active_task] : [];
    return openDialog("pause_all", { id: 0, external_ref: `${running.length} running` }, { tasks: running });
  }, [openDialog]);

  /* Creating a task is work, so a developer needs an open workday (Odoo hides
     New Task until then, and /kra_kpi/task/self_create refuses). Admins keep it:
     they file work for other people. */
  useEffect(() => {
    const on = () => {
      if (workdayLocked) { flags.warn("Start your workday before creating a task."); return; }
      setCreateOpen(true);
    };
    window.addEventListener("kpi:create", on);
    return () => window.removeEventListener("kpi:create", on);
  }, [workdayLocked, flags]);

  /* canCreate: whether "+ Create" should show (the Shell's button can read it). */
  const canCreate = !workdayLocked;
  const acts = useMemo(() => ({ perform, run, openDialog, openTask, pauseAll, refreshAll, workdayOpen, workdayLocked, canCreate }),
    [perform, run, openDialog, openTask, pauseAll, refreshAll, workdayOpen, workdayLocked, canCreate]);
  const liveValue = useMemo(() => ({ workday, live, busy }), [workday, live, busy]);
  const closePanel = useCallback(() => openTask(null), [openTask]);

  return (
    <ActsCtx.Provider value={acts}>
      <LiveCtx.Provider value={liveValue}>
        {children}
        {dialog && <TaskDialog dialog={dialog.dialog} task={dialog.task} extra={dialog.extra} busy={busy} onClose={onClose} onConfirm={onConfirm} />}
        <CreateTaskDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={addCreated} />
        {openId && <TaskPanel id={+openId} onClose={closePanel} />}
        <TaskAlerts />
      </LiveCtx.Provider>
    </ActsCtx.Provider>
  );
}
