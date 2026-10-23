"use client";
import { useEffect, useState } from "react";
import { Avatar, Button, Icon, IconButton, Lozenge, Skeleton, stateTone } from "@/components/ui";
import { isAdmin, useMe } from "@/lib/me";
import * as S from "@/lib/services/kpiActions";
import { fmtHM, estimateSeconds, laneForTask, refPrefix, TYPE_TILE } from "@/lib/services/kpiActions";
import { liveFromAnchor, fmtClock, secsSince, useNow } from "@/lib/liveTime";
import LiveTick from "./LiveTick";
import { actionsFor } from "./actions";
import DbHandover from "./DbHandover";
import TaskMeetings from "@/components/talks/TaskMeetings";
import { OldDbBadge } from "./Legacy";
import { useTaskActions } from "./TaskActions";
import ClientTab, { hasClientTab, useClientSends } from "./ClientTab";
import { ChatTab, ClientProgress, FinishBox, SendBackHistory, ClientWording, EditHeadingDialog, FilesTab, HistoryTab, ManagerQuestions, NotStartedNote, ProgressComposer, ProgressList, TaskTimeline } from "./TaskExtras";

/* Odoo's has_started states (kra_api.py /kpi_action/details). */
const STARTED_STATES = ["in_progress", "paused", "partially_completed", "awaiting_client", "completed"];

/* The Jira-style side panel for one task: everything /kra_kpi/task/details
   returns, plus the same actions as the card. */
export default function TaskPanel({ id, onClose }) {
  const { me } = useMe();
  const acts = useTaskActions();
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  /* The section picked on the icon rail: overview | chat | client | updates | files | history. */
  const [tab, setTab] = useState("overview");
  const [editing, setEditing] = useState(false);
  /* What the client sent (Client section): shown only when there is something. */
  const [sends] = useClientSends(id);
  const showClient = hasClientTab(sends);
  useEffect(() => { if (tab === "client" && sends && !showClient) setTab("overview"); }, [sends]); // eslint-disable-line react-hooks/exhaustive-deps
  /* Timers tick inside LiveTick; the deadline flag needs only a one-minute clock. */
  const now = useNow(!!d?.task && d.task.task_state !== "completed", 60000);

  /* /kpi_action/details: the flags and low-signal fields the Odoo detail pane
     shows (mandatory, service KPI, reviews, warehouse, next KPI, task file…). */
  const [info, setInfo] = useState(null);
  /* 💬 Client messages waiting for the team -- the count on the Chat tab, as
     Odoo's "💬 Chat with client" badge. */
  const [chatWaiting, setChatWaiting] = useState(0);
  const loadChatCount = () => S.fetchChat(id).then((r) => setChatWaiting(r?.status === false ? 0 : (r?.waiting || 0))).catch(() => setChatWaiting(0));
  const load = () => {
    S.fetchActionDetails(id).then(setInfo).catch(() => setInfo(null));
    loadChatCount();
    return S.fetchTaskDetails(id).then((r) => { if (r.ok) { setD(r); setErr(""); } else setErr(r.message); }).catch((e) => setErr(e.message));
  };
  useEffect(() => { setD(null); setInfo(null); setTab("overview"); load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  /* A client waiting for a reply: open straight on the Chat, once per task
     (only if nobody picked a section yet). */
  const [chatOpened, setChatOpened] = useState(null);
  useEffect(() => {
    if (chatWaiting > 0 && chatOpened !== id) { setChatOpened(id); setTab((s) => (s === "overview" ? "chat" : s)); }
  }, [chatWaiting, id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const on = () => load();
    window.addEventListener("kpi:refresh", on);
    return () => window.removeEventListener("kpi:refresh", on);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    /* An open dialog (edit heading, a confirm) takes Escape for itself. */
    const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".modal")) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  /* While the panel is open the page behind it must not scroll. Lock the
     page, and pad for the scrollbar that disappears so nothing jumps sideways. */
  useEffect(() => {
    const html = document.documentElement;
    const gap = window.innerWidth - html.clientWidth;
    const prev = { overflow: html.style.overflow, paddingRight: html.style.paddingRight };
    html.style.overflow = "hidden";
    if (gap > 0) html.style.paddingRight = `${gap}px`;
    return () => { html.style.overflow = prev.overflow; html.style.paddingRight = prev.paddingRight; };
  }, []);

  const t = d?.task;
  const meta = d?.meta || {};
  const lane = t ? laneForTask(t) : null;
  const [tone, label] = t ? (lane === "pending_review" ? ["review", "Pending review"] : lane === "approvals" ? ["review", "Pending approval"] : stateTone(t.task_state)) : [];
  const actions = t ? actionsFor(t, me, { workdayLocked: acts.workdayLocked }) : [];
  const running = t?.task_state === "in_progress" && t.timer_start_datetime;
  const spentAt = (n) => (t ? (running ? liveFromAnchor(t.timer_start_datetime, t.timer_total_seconds, n) : t.timer_total_seconds || 0) : 0);
  const est = t ? estimateSeconds(t) : 0;
  const [tileLetter, tileColor] = TYPE_TILE[refPrefix(t?.external_ref || meta.external_ref)] || TYPE_TILE.TASK;

  /* refreshAll fires kpi:refresh, which reloads this panel too. */
  const changed = acts.refreshAll;
  const late = t ? S.deadlinePassed(t, now) : false;
  /* Client rows (what the client attached when raising the task) sit in their
     own "From the client" block, never among the team's updates. */
  const teamProgress = (d?.progress || []).filter((p) => !p.from_client);
  const clientProgress = (d?.progress || []).filter((p) => p.from_client);
  const fileCount = (d?.files?.length || 0) +(d?.github?.length || 0) + (d?.manuals?.length || 0) + (d?.links?.length || 0);
  /* Updates, files, manuals and GitHub links are added only once the task has
     been started, as on the Odoo board. /kpi_action/details says so (has_started:
     the task's STATE only, for everyone, admins included. Time logged earlier
     does not count, so a Rework / On Hold task back in the Regular, Important or
     Urgent lane stays closed until it is started again). Until that has loaded,
     the same rule from the task row. */
  const started = t ? (typeof info?.has_started === "boolean" ? info.has_started
    : STARTED_STATES.includes(t.task_state)) : false;
  /* Signed off by the client: nothing more can be added or changed (admins excepted; the server refuses too). */
  const locked = t?.details_locked || info?.details_locked || "";

  return (
    <>
      <div className="panel-scrim" onClick={onClose} />
      <aside className="panel" aria-label={t ? `Task ${t.external_ref || t.id}` : "Task"}>
        <div className="panel-h">
          <span className="type" style={{ background: tileColor }}>{tileLetter}</span>
          <span>{t?.external_ref || meta.external_ref || `#${id}`}{meta.kra ? ` · ${meta.kra}` : t?.client_name ? ` · ${t.client_name}` : ""}</span>
          <span className="spacer" />
          {meta.is_manager && t && <IconButton icon="pen" label="Edit heading (name, type, project)" size={18} onClick={() => setEditing(true)} />}
          <a className="icon-btn" href={`/browse/${id}`} title="Open as a page" aria-label="Open as a page"><Icon n="link" size={18} /></a>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>
        {(err || !t) && (
          <div className="panel-b">
            {err && <div className="callout" style={{ background: "var(--over-bg)", borderColor: "var(--danger)", color: "var(--over)" }}><Icon n="warn" size={18} /><span style={{ flex: 1 }}>{err}</span><Button size="sm" onClick={load}>Retry</Button></div>}
            {!t && !err && <Skeleton rows={6} />}
          </div>
        )}
        {t && !err && (
          <>
            {/* Name and status stay on top whatever section is open. */}
            <div className="tp-top">
              <h2>{t.name}</h2>
              <div className="row" style={{ flexWrap: "wrap" }}>
                <Lozenge tone={tone} style={{ height: 24, padding: "0 8px" }}>{label}</Lozenge>
                {running && <span className="timer"><span className="pulse" /><LiveTick fn={(n) => fmtClock(secsSince(t.timer_start_datetime, n))} /> running</span>}
                {t.paused_reason && lane === "paused" && <Lozenge tone="paused">{t.paused_reason}</Lozenge>}
                {t.self_needs_resume_reason && <Lozenge tone="danger">Sent back</Lozenge>}
                {t.decline_count > 0 && <Lozenge tone="danger">Declined {t.decline_count}×</Lozenge>}
                {late && <Lozenge tone="danger">Deadline passed</Lozenge>}
                {t.pre_approval_auto_released && !t.pre_approval_decision && <Lozenge tone="neutral" style={{ textTransform: "none" }} title="The client did not reply within the approval window, so work was released. This is not their approval — sign-off is still required before billing.">Released — no client reply</Lozenge>}
                {t.admin_accepted_auto && <Lozenge tone="neutral" style={{ textTransform: "none" }} title="No admin actioned this within the accept window, so it was accepted automatically.">Auto-accepted</Lozenge>}
              </div>
              {t.reverted_from && (
                <div className="callout" style={{ background: "var(--lz-paused-bg)", borderColor: "var(--pri-important)", color: "var(--lz-paused)", alignItems: "flex-start" }}>
                  <Icon n="swap" size={16} /><span style={{ flex: 1 }}><b>Reverted from Awaiting Client.</b>{t.revert_reason ? <span style={{ display: "block", whiteSpace: "pre-wrap", color: "var(--text)" }}>{t.revert_reason}</span> : null}</span>
                </div>
              )}
              {t.is_self_created && !t.admin_accepted && (t.self_review_note || t.self_resume_note) && (
                <div className="sec" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {t.self_review_note && <span style={{ whiteSpace: "pre-wrap", fontSize: 13, color: me.role === "admin" ? "var(--pri-regular)" : "var(--danger)" }}><Icon n="swap" size={12} /> <b>{t.self_review_by || "Admin"}:</b> {t.self_review_note}</span>}
                  {t.self_resume_note && <span style={{ whiteSpace: "pre-wrap", fontSize: 13, color: me.role === "admin" ? "var(--danger)" : "var(--pri-regular)" }}><Icon n="user" size={12} /> <b>{t.self_resume_by || "Developer"}:</b> {t.self_resume_note}</span>}
                </div>
              )}
            </div>

            <div className="tp-body">
              {/* Every section one click away; the red number on Chat is how many
                  client messages are waiting for the team. */}
              <nav className="tp-rail" role="tablist" aria-label="Task sections">
                {[
                  ["overview", "Overview", "info", 0],
                  ["chat", "Chat", "chat", chatWaiting, true],
                  ...(showClient ? [["client", "Client", "user", 0]] : []),
                  ["updates", "Updates", "pen", teamProgress.length],
                  ["files", "Files", "paperclip", fileCount],
                  ["history", "History", "clock", 0],
                ].map(([k, l, ic, n, urgent]) => (
                  <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                    <Icon n={ic} size={20} />{l}
                    {n > 0 && <span className={`n${urgent ? "" : " soft"}`} aria-label={urgent ? `${n} waiting` : `${n}`}>{n}</span>}
                  </button>
                ))}
              </nav>

              <div className="tp-main">
                {tab === "overview" && (
                  <>
                    <div className="tp-facts">
                      <div className="tp-fact"><small>Assignee</small><b>{t.user_name ? <><Avatar name={t.user_name} uid={t.user_id} size={20} />{t.user_name}</> : <span className="mini">Unassigned</span>}</b></div>
                      <div className="tp-fact"><small>Client · project</small><b>{t.client_name || "—"}{(meta.kra || t.project_name) && (meta.kra || t.project_name) !== t.client_name ? ` · ${meta.kra || t.project_name}` : ""}</b></div>
                      <div className="tp-fact"><small>Time</small><LiveTick active={!!running} fn={(n) => { const spent = spentAt(n); return <><b>{fmtHM(spent)} of {fmtHM(est)}</b><span className="bar" style={{ flex: "none" }}><i style={{ width: `${est ? Math.min(100, (spent / est) * 100) : 0}%`, background: est && spent > est ? "var(--danger)" : "var(--brand)" }} /></span></>; }} /></div>
                      <div className="tp-fact"><small>Under task</small><b>{t.parent_ref || t.legacy_req_link ? <>{t.parent_ref}<OldDbBadge t={t} /></> : "—"}</b></div>
                      <div className="tp-fact"><small>Type</small><b>{meta.kind || refPrefix(t.external_ref) || "Task"}{t.deliverable_type ? ` · ${S.taskDeliverableLabel(t)}` : ""}</b>{t.is_self_created && !t.admin_accepted && t.requested_doc_type ? <span className="mini">asked: {t.requested_doc_type}</span> : null}</div>
                      <div className="tp-fact"><small>Priority</small><b style={{ color: t.priority === "urgent" ? "var(--pri-urgent)" : t.priority === "important" ? "var(--pri-important)" : "var(--pri-regular)" }}>{t.priority === "urgent" ? "▲▲ Urgent" : t.priority === "important" ? "▲ Important" : "– Regular"}</b>{t.requested_priority && t.requested_priority !== t.priority ? <span className="mini">developer asked for {S.priorityLabel(t.requested_priority)}</span> : null}</div>
                    </div>

                    {t.description && <div className="sec"><h3>About</h3><p style={{ whiteSpace: "pre-wrap" }}>{t.description}</p></div>}
                    {clientProgress.length > 0 && <ClientProgress progress={clientProgress} />}
                    <SendBackHistory task={t} />
                    <FinishBox task={t} isAdmin={isAdmin(me)} canFinish={isAdmin(me) || (t && me && t.user_id === me.uid)} onChanged={changed} />
                    <ClientWording key={`cw${id}`} kpiId={id} />
                    {(t.request_category === "new_database" || t.request_category === "db_disconnect") && <DbHandover key={`dbh${id}`} kpiId={id} canEdit={!!(meta.is_manager || meta.is_assignee)} onChanged={changed} />}
                    {String(meta.guidelines || "").trim() && <div className="sec"><h3>Guidelines</h3><p style={{ whiteSpace: "pre-wrap" }}>{meta.guidelines}</p></div>}
                    {/* meta.checklist is the task's plain-text checklist field, not a list. */}
                    {String(meta.checklist || "").trim() && <div className="sec"><h3>Checklist</h3><p style={{ whiteSpace: "pre-wrap" }}>{meta.checklist}</p></div>}
                    <TaskMeetings key={`tm${id}`} kpiId={id} />
                    <TaskTimeline key={`tl${id}`} kpiId={id} />

                    {/* The rest of the facts, only those that have a value. */}
                    {(t.estimate_extension_count > 0 || (t.time_by_user || []).length > 0 || t.today_seconds > 0 || t.deadline || S.reminderIntervalMs(t) > 0 || t.completion_date || t.approval_date || meta.points != null || (t.coordinator_review_started_at && t.task_state === "partially_completed")) && (
                      <dl className="details">
                        {t.estimate_extension_count > 0 && <><dt>Estimate</dt><dd>{fmtHM(est)}<span className="mini"> · extended {t.estimate_extension_count}×{t.estimate_extended_by_name ? ` by ${t.estimate_extended_by_name}` : ""} {t.estimate_extend_reason ? `— ${t.estimate_extend_reason}` : ""}</span></dd></>}
                        {(t.time_by_user || []).length > 0 && <><dt>Time by person</dt><dd style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}>{t.time_by_user.map((u) => <span key={u.user_id}>{u.user_name}{u.is_current ? <span className="mini" style={{ color: "var(--pri-regular)" }}> (current)</span> : null} — <b>{u.display}</b></span>)}</dd></>}
                        {t.today_seconds > 0 && <><dt>Today</dt><dd>{fmtHM(t.today_seconds)}</dd></>}
                        {t.deadline && <><dt>Deadline</dt><dd style={late ? { color: "var(--danger)", fontWeight: 800 } : undefined}>{t.deadline}{late ? " · passed" : ""}</dd></>}
                        {S.reminderIntervalMs(t) > 0 && <><dt>Reminder</dt><dd>Every {S.fmtReminder(t)}{t.last_reminder_shown ? <span className="mini"> · last {t.last_reminder_shown}</span> : null}</dd></>}
                        {t.completion_date && <><dt>Completed</dt><dd>{t.completion_date}{t.completed_by_name ? ` · ${t.completed_by_name}` : ""}</dd></>}
                        {t.coordinator_review_started_at && t.task_state === "partially_completed" && <><dt>Review started</dt><dd>{t.coordinator_review_started_at}{t.coordinator_review_started_by_name ? ` · ${t.coordinator_review_started_by_name}` : ""}</dd></>}
                        {t.approval_date && <><dt>Approved</dt><dd>{t.approval_date}{t.approved_by_name ? ` · ${t.approved_by_name}` : ""}</dd></>}
                        {meta.points != null && <><dt>Points</dt><dd>{meta.points}</dd></>}
                      </dl>
                    )}
                    {info && <ExtraDetails info={info} />}
                  </>
                )}
                {tab === "updates" && (
                  <div className="sec" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {locked ? <div className="callout" style={{ background: "var(--hover)", borderColor: "var(--border)" }}>🔒 {locked}</div>
                      : lane !== "completed" && (started ? <ProgressComposer kpiId={id} d={d} onChanged={changed} /> : <NotStartedNote />)}
                    {/* Questions go to the manager, never the client: the assignee (and
                        admins) can ask; everyone on the task sees the answers. */}
                    <ManagerQuestions key={`mq${id}`} kpiId={id} canAsk={!!(meta.is_assignee || meta.is_manager) && lane !== "completed"} />
                    <ProgressList progress={teamProgress} onChanged={changed} />
                    {!teamProgress.length && <span className="mini">No updates yet.</span>}
                  </div>
                )}
                {tab === "files" && <FilesTab kpiId={id} d={d} canAdd={started && !locked} canManageGithub={!!(meta.is_manager || meta.is_assignee)} onChanged={changed} />}
                {tab === "client" && showClient && <ClientTab kpiId={id} res={sends} onSaved={changed} />}
                {tab === "chat" && <ChatTab key={`chat${id}`} kpiId={id} onSeen={loadChatCount} taskRef={t?.external_ref || meta.external_ref} />}
                {tab === "history" && <HistoryTab key={id} kpiId={id} d={d} />}
              </div>
            </div>

            {/* Start / Pause / Complete / Add time: always in the same place. */}
            {actions.length > 0 && (
              <div className="tp-foot">
                <div className="actions">
                  {actions.map((a) => <Button key={a.key} kind={a.kind} icon={a.icon} disabled={a.disabled} title={a.reason || a.label} onClick={() => acts.run(a, t)}>{a.label}</Button>)}
                </div>
                {/* A greyed-out Start reads as broken unless it says why. */}
                {(() => { const off = actions.find((a) => a.disabled && a.reason); return off ? <span className="mini" style={{ display: "flex", alignItems: "center", gap: 5 }}><Icon n="info" size={13} />{off.reason}</span> : null; })()}
              </div>
            )}
          </>
        )}
      </aside>
      {editing && t && <EditHeadingDialog task={t} onClose={() => setEditing(false)} onSaved={changed} />}
    </>
  );
}

/* Odoo's detail pane: one chip per flag that is on, the task's own file and
   links, and the low-signal fields folded under "More details" (only when
   one of them has a value). */
const FLAGS = [["is_mandatory", "Mandatory", "danger"], ["service_kpi", "Service KPI", "review"], ["manager_review", "Coordinator review", "progress"], ["customer_review", "Customer review", "neutral"], ["auto_assign", "Auto-assign", "done"], ["auto_estimated", "Auto-estimated", "done"], ["is_permanent", "Permanent", "todo"], ["is_meeting", "Meeting", "paused"]];
function ExtraDetails({ info }) {
  const flags = FLAGS.filter(([k]) => info[k]);
  const links = S.parseLinks(info.related_links);
  const rem = info.reminder_days ? info.reminder_days + " day" + (info.reminder_days === 1 ? "" : "s") : "";
  const rows = [["Points", info.points || ""], ["User group", info.user_group], ["Reminder interval", rem], ["Next KPI", info.next_kpi], ["Warehouse", info.warehouse], ["File name", info.file_name], ["Actions", info.actions && info.actions !== "-" ? info.actions : ""]].filter(([, v]) => v);
  if (!flags.length && !rows.length && !info.file_url && !links.length) return null;
  return (
    <div className="sec" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {flags.length > 0 && <div className="pillset">{flags.map(([k, l, tone]) => <Lozenge key={k} tone={tone} style={{ textTransform: "none" }}>{l}</Lozenge>)}</div>}
      {info.file_url && <a className="btn" style={{ alignSelf: "flex-start" }} href={info.file_url} download={info.file_name || "file"}><Icon n="download" size={15} /> Download task file</a>}
      {links.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 2 }}><b style={{ fontSize: 12.5 }}>Related links</b>{links.map((l, i) => <a key={i} href={l} target="_blank" rel="noreferrer" className="mini" style={{ color: "var(--brand)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><Icon n="link" size={12} /> {l}</a>)}</div>}
      {rows.length > 0 && (
        <details>
          <summary className="mini" style={{ cursor: "pointer" }}>More details</summary>
          <dl className="details" style={{ marginTop: 6 }}>{rows.map(([k, v]) => <span key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{v}</dd></span>)}</dl>
        </details>
      )}
    </div>
  );
}
