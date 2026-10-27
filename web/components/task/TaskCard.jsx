"use client";
import { memo } from "react";
import { Avatar, Button, Icon, Lozenge } from "@/components/ui";
import { useMe } from "@/lib/me";
import { serverNow } from "@/lib/api";
import { deadlinePassed, estimateSeconds, fmtHM, isFreshTask, laneForTask, PAUSED_STATES, priorityLabel, refPrefix, sinceResume, taskDeliverableLabel, TYPE_TILE } from "@/lib/services/kpiActions";
import { liveFromAnchor, fmtClock, secsSince, gateLabel, useNow } from "@/lib/liveTime";
import LiveTick from "./LiveTick";
import { OldDbBadge } from "./Legacy";
import { FinishBox, SendBackHistory } from "./TaskExtras";

const SETTLED = ["completed", "awaiting_client", "partially_completed"];

/* The issue card. Memoised: it re-renders only when its task (or a prop)
   changes. A running card's timer and spent time tick on their own
   (LiveTick); the "New" and "Past deadline" flags follow a shared one-minute
   clock, and only on cards where either can still flip.
   Carries what the Odoo board card shows (kpi_action.js): description, time per
   developer, deliverable, the send-back conversation, revert reason, release /
   auto-accept badges, requested priority, add-time reason, update count, and
   completed-by / review on cards waiting for approval. */
function TaskCard({ task: t, selected, onOpen, dragging, dragHandle, actions, onAction }) {
  const { me } = useMe();
  const admin = me?.role === "admin";
  const lane = laneForTask(t);
  const running = t.task_state === "in_progress" && t.timer_start_datetime;
  const est = estimateSeconds(t);
  const open = !SETTLED.includes(t.task_state);
  const at = serverNow();
  const now = useNow(open && (isFreshTask(t, at) || (!!t.deadline && !deadlinePassed(t, at))), 60000);
  /* A new task is a solid red card, as on the Odoo board (isFreshTask). */
  const fresh = isFreshTask(t, now);
  const [tileLetter, tileColor] = TYPE_TILE[refPrefix(t.external_ref)] || TYPE_TILE.TASK;
  const resume = sinceResume(t);
  const gate = gateLabel(t);
  const late = open && deadlinePassed(t, now);
  const pri = t.priority === "urgent" ? ["up2", "var(--pri-urgent)", "Urgent"] : t.priority === "important" ? ["up", "var(--pri-important)", "Important"] : ["dash1", "var(--pri-regular)", "Regular"];
  const pendingSelf = t.is_self_created && !t.admin_accepted;
  /* Send-back conversation: YOUR note reads green, the other side's red (Odoo). */
  const mineTone = (fromAdmin) => (fromAdmin === admin ? "var(--pri-regular)" : "var(--danger)");
  const byUser = t.time_by_user || [];

  return (
    <article
      className={`card ${fresh ? "fresh" : ""} ${selected ? "sel" : ""} ${dragging ? "dragging" : ""}`}
      onClick={() => onOpen?.(t)} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen?.(t); }}
      {...dragHandle}
    >
      <p>{t.name}</p>
      {t.description && <span className="cd-desc" title={t.description}>{t.description}</span>}
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {t.client_name && <Lozenge tone="todo">{t.client_name}</Lozenge>}
        {t.deliverable_type && <Lozenge tone="neutral" style={{ textTransform: "none" }}>{taskDeliverableLabel(t)}</Lozenge>}
        {running && <span className="timer"><span className="pulse" /><LiveTick fn={(n) => fmtClock(secsSince(t.timer_start_datetime, n))} />{resume ? ` ${resume.label}` : " running"}</span>}
        {/* A reason can be a sentence ("🔴 CLIENT REJECTED — …"). The lozenge's fixed
            16px height cut its second line in half: up to two whole lines here,
            the rest on hover and in the task panel. */}
        {t.paused_reason && PAUSED_STATES.includes(t.task_state) && <Lozenge tone="paused" title={t.paused_reason} style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, height: "auto", lineHeight: "16px", padding: "1px 6px", maxWidth: "100%", overflow: "hidden", overflowWrap: "anywhere", textTransform: "none" }}>{t.paused_reason}</Lozenge>}
        {lane === "paused" && !t.paused_reason && <Lozenge tone="paused">Paused</Lozenge>}
        {lane === "approvals" && <Lozenge tone="review">{t.coordinator_review_started_at ? "Review started" : "Awaiting admin"}</Lozenge>}
        {lane === "awaiting_client" && <Lozenge tone="review">Awaiting client</Lozenge>}
        {lane === "completed" && <Lozenge tone="done">{t.approved_by_name ? "Certified" : "Done"}</Lozenge>}
        {lane === "pending_review" && <Lozenge tone="review">Self-created · pending review</Lozenge>}
        {fresh && <Lozenge tone="fresh">New</Lozenge>}
        {t.self_needs_resume_reason && <Lozenge tone="danger">Sent back</Lozenge>}
        {t.decline_count > 0 && <Lozenge tone="danger" title={`The approver declined this ${t.decline_count} time(s); the client fixed it and sent it again.`}>Declined {t.decline_count}×</Lozenge>}
        {t.estimate_extension_count > 0 && <Lozenge tone="neutral" style={{ textTransform: "none" }} title={`Extended ${t.estimate_extension_count} time(s) by ${t.estimate_extended_by_name || "someone"}`}>+{t.estimate_extension_count} ext</Lozenge>}
        {late && <Lozenge tone="danger">Past deadline · {t.deadline}</Lozenge>}
        {t.pre_approval_auto_released && !t.pre_approval_decision && <Lozenge tone="neutral" style={{ textTransform: "none" }} title="The client did not reply within the approval window, so work was released. This is not their approval — they can still object, and sign-off is still required before billing.">Released — no client reply</Lozenge>}
        {/* Where the approval stands (approval chain → client), in place of the old
            auto-accept countdown. The Start hint below already says it when it is the gate. */}
        {t.approval_stage_label && t.approval_stage_label !== gate && <Lozenge tone={t.approval_stage_label.startsWith("Rejected") ? "danger" : "review"} title={t.approval_stage_label} style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, height: "auto", lineHeight: "16px", padding: "1px 6px", maxWidth: "100%", overflow: "hidden", overflowWrap: "anywhere", textTransform: "none" }}>{t.approval_stage_label}</Lozenge>}
      </div>
      {t.reverted_from && (
        <div className="cd-note warn">
          <b><Icon n="swap" size={12} /> Reverted from Awaiting Client</b>
          {t.revert_reason && <span>{t.revert_reason}</span>}
        </div>
      )}
      {t.requested_priority && t.requested_priority !== t.priority && <span className="mini"><Icon n="flag" size={12} /> Developer asked for <b>{priorityLabel(t.requested_priority)}</b></span>}
      {pendingSelf && t.self_review_note && <span className="cd-say" style={{ color: mineTone(true) }}><b>{t.self_review_by || "Admin"}:</b> {t.self_review_note}</span>}
      {pendingSelf && t.self_resume_note && <span className="cd-say" style={{ color: mineTone(false) }}><b>{t.self_resume_by || "Developer"}:</b> {t.self_resume_note}</span>}
      {gate && !running && lane !== "paused" && <span className="mini" title={gate} style={{ color: "var(--pri-important)" }}>{gate}</span>}
      {(byUser.length > 1 || (byUser.length === 1 && !byUser[0].is_current)) && (
        <div className="cd-users">
          {byUser.map((u) => <span key={u.user_id} title={`${u.user_name} — ${u.display}`}><Icon n="user" size={11} /> {u.user_name}{u.is_current ? <em> (current)</em> : null} — <b>{u.display}</b></span>)}
        </div>
      )}
      {t.estimate_extend_reason && <span className="cd-desc one" title={t.estimate_extend_reason}><Icon n="clock" size={11} /> {t.estimate_extend_reason}</span>}
      {lane === "approvals" && (t.completed_by_name || t.completion_date) && (
        <div className="cd-users">
          <span style={{ color: "var(--pri-regular)" }}><Icon n="check" size={11} /> Completed by {t.completed_by_name || "—"}{t.completion_date ? ` · ${t.completion_date}` : ""}</span>
          {t.coordinator_review_started_at && <span><Icon n="eye" size={11} /> Review started {t.coordinator_review_started_at}{t.coordinator_review_started_by_name ? ` by ${t.coordinator_review_started_by_name}` : ""}</span>}
        </div>
      )}
      <div className="row">
        <span className="key" style={t.parent_ref ? { fontSize: "0.85em" } : undefined} title={t.parent_ref ? `Under ${t.parent_ref}` : undefined}><span className="type" style={{ background: tileColor }}>{tileLetter}</span>{t.parent_ref ? "↳ " : ""}{t.external_ref || `#${t.id}`}</span>
        <span className="pri" style={{ color: pri[1] }} title={pri[2]}><Icon n={pri[0]} size={16} /></span>
        <OldDbBadge t={t} />
        {t.progress_count > 0 && <span className="mini" title={`${t.progress_count} progress update${t.progress_count === 1 ? "" : "s"}`}><Icon n="doc" size={12} />{t.progress_count}</span>}
        <LiveTick active={!!running} fn={(n) => {
          const spent = running ? liveFromAnchor(t.timer_start_datetime, t.timer_total_seconds, n) : (t.timer_total_seconds || 0);
          const over = est > 0 && spent > est;
          return <span className={`time ${over ? "over" : ""}`} title={`${fmtHM(spent)} spent of ${fmtHM(est)} estimated`}>{fmtHM(spent)} / {fmtHM(est)}</span>;
        }} />
        {t.user_name ? <Avatar name={t.user_name} uid={t.user_id} size={24} /> : <span className="avatar" style={{ width: 24, height: 24, background: "var(--border)", color: "var(--subtlest)", fontSize: 10 }} title="Unassigned">—</span>}
      </div>
      {/* Odoo card: every client send-back (closed until tapped), then the
          Full Complete prompt / the bill / Bill now. */}
      <SendBackHistory task={t} compact />
      {(t.full_complete_pending || t.full_complete_at) && (
        <div onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} style={{ fontSize: 12.5 }}>
          <FinishBox task={t} isAdmin={admin} canFinish={admin || (me && t.user_id === me.uid)} onChanged={() => window.dispatchEvent(new CustomEvent("kpi:refresh"))} />
        </div>
      )}
      {actions?.length > 0 && (
        /* The main buttons, inline like the Odoo board. They swallow the click
           and the pointer-down so the card neither opens nor starts dragging. */
        <div className="card-acts" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {actions.map((a) => <Button key={a.key} kind={a.kind} size="sm" icon={a.icon} disabled={a.disabled} title={a.reason || a.label} onClick={() => onAction?.(a, t)}>{a.label}</Button>)}
        </div>
      )}
    </article>
  );
}

export default memo(TaskCard);
