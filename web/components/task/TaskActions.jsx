"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useFlags } from "@/components/ui";
import { useMe } from "@/lib/me";
import { invalidate } from "@/lib/api";
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
   (window event "kpi:create"). */
const Ctx = createContext(null);
export const useTaskActions = () => useContext(Ctx);

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

  const refreshAll = useCallback(() => {
    for (const p of REFRESH_PREFIXES) invalidate(p);
    workday.refresh(); live.refresh();
    window.dispatchEvent(new CustomEvent("kpi:refresh"));
  }, [workday, live]);

  const openTask = useCallback((id) => {
    const sp = new URLSearchParams(params.toString());
    if (id) sp.set("task", String(id)); else sp.delete("task");
    router.replace(`${pathname}${sp.toString() ? "?" + sp.toString() : ""}`, { scroll: false });
  }, [params, pathname, router]);
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
    revert_signoff: "Sign-off reverted.", delete: "Task deleted.", undo_start: "Start undone.", add_time: "Estimate extended.",
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
    resume_reason: "resume", sendback: "sendback_self", undo_start: "undo_start", add_time: "add_time", reassign: "reassign", switch: "switch", accept: "accept_self", priority: "priority", pause_all: "pause_all" };
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
  const pauseAll = useCallback(() => {
    const running = live.data?.active_tasks?.length ? live.data.active_tasks : live.data?.active_task ? [live.data.active_task] : [];
    return openDialog("pause_all", { id: 0, external_ref: `${running.length} running` }, { tasks: running });
  }, [live.data, openDialog]);

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
  const value = useMemo(() => ({ perform, run, openDialog, openTask, pauseAll, refreshAll, workday, live, workdayOpen, workdayLocked, canCreate, busy }),
    [perform, run, openDialog, openTask, pauseAll, refreshAll, workday, live, workdayOpen, workdayLocked, canCreate, busy]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {dialog && <TaskDialog dialog={dialog.dialog} task={dialog.task} extra={dialog.extra} busy={busy} onClose={onClose} onConfirm={onConfirm} />}
      <CreateTaskDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={refreshAll} />
      {openId && <TaskPanel id={+openId} onClose={() => openTask(null)} />}
      <TaskAlerts />
    </Ctx.Provider>
  );
}
