"use client";
/* Deadline + reminder alerts, the web port of the Odoo board's
   checkRemindersAndDeadlines. Every 30 s it looks at the caller's own RUNNING
   tasks (S.alertDue):
     - deadline reached and deadline_alert_shown still false → one alert, ever;
     - a reminder interval set (days/hours/minutes) and that long since the last
       reminder (or since the timer started) → "Continue working" reminder.
   Dismissing tells the server (/kra_kpi/update_deadline_alert_shown,
   /kra_kpi/update_reminder_shown) so it shows once, on every client. The local
   `seen` map covers the gap until the next board read carries the new value. */
import { useEffect, useRef, useState } from "react";
import { Button, Icon, Modal } from "@/components/ui";
import { useMe } from "@/lib/me";
import { invalidate } from "@/lib/api";
import { useIsPolled, useResource } from "@/lib/useFetch";
import { useNow, liveFromAnchor } from "@/lib/liveTime";
import * as S from "@/lib/services/kpiActions";

/* Rejection alert (Odoo checkForRejectedTasks): the caller's own paused tasks
   whose paused_reason carries the "🔴 REJECTED" marker an admin's Reject
   writes. Each is shown once per page session, like the Odoo board. */
const seenRejections = new Set();
const BOARD_PARAMS = { my_tasks_only: false };
const MINE_PARAMS = { my_tasks_only: true };
const REJECT_MARK = "🔴 REJECTED";
const rejectionText = (r) => String(r || "").replace("🔴 REJECTED - Manager Feedback: ", "").replace("🔴 REJECTED -", "").replace("Manager Feedback:", "").trim();

export default function TaskAlerts() {
  const [rejected, setRejected] = useState(null); /* tasks to show */
  const { me } = useMe();
  /* Only the caller's own tasks matter here. While a screen is polling the
     full board (Board, List, Your work), read its copy; otherwise poll just
     my tasks, instead of the whole board, on every work page. */
  const boardPolled = useIsPolled(S.TASKS_PATH, BOARD_PARAMS);
  const shared = useResource(S.TASKS_PATH, BOARD_PARAMS, { enabled: false });
  const own = useResource(S.TASKS_PATH, MINE_PARAMS, { enabled: !boardPolled, pollMs: 60000 });
  const board = boardPolled ? shared : own;
  const now = useNow(true, 30000);
  const [alert, setAlert] = useState(null); /* { kind, task } */
  const seen = useRef({}); /* "deadline:<id>" → true, "reminder:<id>" → ms dismissed */

  useEffect(() => {
    if (rejected || !me?.uid) return;
    const fresh = (board.data?.tasks || []).filter((t) => t.user_id === me.uid && t.task_state === "paused" && String(t.paused_reason || "").includes(REJECT_MARK) && !seenRejections.has(t.id));
    if (fresh.length) { fresh.forEach((t) => seenRejections.add(t.id)); setRejected(fresh); }
  }, [board.data, me?.uid, rejected]);

  useEffect(() => {
    if (alert || rejected || !me?.uid) return;
    for (const t of board.data?.tasks || []) {
      const kind = S.alertDue(t, me.uid, now);
      if (!kind) continue;
      if (kind === "deadline" && seen.current[`deadline:${t.id}`]) continue;
      if (kind === "reminder" && now - (seen.current[`reminder:${t.id}`] || 0) < S.reminderIntervalMs(t)) continue;
      setAlert({ kind, task: t });
      return;
    }
  }, [board.data, now, me?.uid, alert, rejected]);

  if (rejected) {
    return (
      <Modal open onClose={() => setRejected(null)} title="Task rejection alert" width={560}
        footer={<Button kind="primary" icon="check" onClick={() => setRejected(null)} autoFocus>OK, I understand</Button>}>
        <div className="callout" style={{ background: "var(--lz-paused-bg)", borderColor: "var(--pri-important)", color: "var(--lz-paused)" }}><Icon n="warn" size={16} /><b>You have {rejected.length} rejected task{rejected.length === 1 ? "" : "s"}</b></div>
        {rejected.map((t) => (
          <div key={t.id} className="cardbox" style={{ gap: 6, padding: 12, borderColor: "var(--danger)" }}>
            <b style={{ color: "var(--navy)" }}>{t.external_ref ? `${t.external_ref} · ` : ""}{t.name}</b>
            <span className="mini">Priority {S.priorityLabel(t.priority)} · Time spent {S.fmtHM(t.timer_total_seconds)}</span>
            <b style={{ color: "var(--danger)", fontSize: 13 }}>Manager feedback</b>
            <div className="callout" style={{ background: "var(--over-bg)", borderColor: "var(--danger)", color: "var(--over)", whiteSpace: "pre-wrap" }}>{rejectionText(t.paused_reason)}</div>
            <span className="mini">This task is now <b>Paused</b>. Press <b>Resume</b> to start working on the corrections.</span>
          </div>
        ))}
      </Modal>
    );
  }
  if (!alert) return null;
  const t = alert.task;
  const dismiss = () => {
    if (alert.kind === "deadline") { seen.current[`deadline:${t.id}`] = true; S.markDeadlineAlertShown(t.id); }
    else { seen.current[`reminder:${t.id}`] = Date.now(); S.markReminderShown(t.id); }
    invalidate(S.TASKS_PATH);
    setAlert(null);
  };
  const deadline = alert.kind === "deadline";
  return (
    <Modal open onClose={dismiss} title={deadline ? "Deadline reached" : "Task reminder"} width={440}
      footer={<Button kind={deadline ? "danger" : "primary"} icon="check" onClick={dismiss} autoFocus>{deadline ? "I understand" : "Continue working"}</Button>}>
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
        <span className="icbox" style={{ background: deadline ? "var(--over-bg)" : "var(--lz-paused-bg)", color: deadline ? "var(--over)" : "var(--lz-paused)", width: 44, height: 44, flex: "none" }}><Icon n={deadline ? "warn" : "alarm"} size={22} /></span>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <b style={{ color: "var(--navy)", fontSize: 15 }}>{t.external_ref ? `${t.external_ref} · ` : ""}{t.name}</b>
          {deadline
            ? <span>This task has reached its deadline: <b>{t.deadline}</b>.</span>
            : <>
              <span>This is your scheduled reminder for this task.</span>
              <span className="mini">Time spent {S.fmtHM(liveFromAnchor(t.timer_start_datetime, t.timer_total_seconds, Date.now()))} · reminder every {S.fmtReminder(t)}</span>
            </>}
        </div>
      </div>
    </Modal>
  );
}
