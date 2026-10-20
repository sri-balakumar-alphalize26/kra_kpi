"use client";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Avatar, Button, ErrorState, Field, Icon, Lozenge, Modal, PageHeader, Skeleton, StaleBar, useFlags } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import * as A from "@/lib/services/admin";
import { fmtHM } from "@/lib/services/kpiActions";
import { useTaskActions } from "@/components/task/TaskActions";
import PeopleNav from "./PeopleNav";
import EmployeeDay from "./EmployeeDay";

/* Who is doing what right now. /kpi_owner/live_tracking every 15 s; the
   elapsed clocks tick locally between fetches. */
export default function LiveTracking() {
  const flags = useFlags();
  const acts = useTaskActions();
  const sp = useSearchParams();
  const live = useResource(A.LIVE_TRACKING_PATH, {}, { pollMs: 15000, ttl: 5000 });
  const fetchedAt = useRef(Date.now());
  useEffect(() => { fetchedAt.current = Date.now(); }, [live.data]);
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((t) => t + 1), 1000); return () => clearInterval(id); }, []);
  const [nudge, setNudge] = useState(null); /* row */
  const [revert, setRevert] = useState(null);
  const [note, setNote] = useState(""); const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("all");
  const [dayOf, setDayOf] = useState(null); /* row whose day is open */
  /* {status:false, message} (not authorized) is a failure, not an empty team. */
  const refused = live.data?.status === false ? { message: live.data.message || live.data.error || "Could not load live tracking." } : null;
  const d = refused ? null : live.data;
  const liveErr = refused || live.error;
  const extra = Math.floor((Date.now() - fetchedAt.current) / 1000);
  const rows = (d?.rows || []).filter((r) => filter === "all" || (filter === "working" ? r.active : filter === "idle" ? (r.started && !r.active) : !r.started));
  const focus = +sp.get("focus");

  const doNudge = async () => {
    setBusy(true);
    try { A.assertOk(await A.nudgeUser(nudge.user_id, note), "Could not nudge."); flags.ok(`Nudged ${nudge.name}.`); setNudge(null); setNote(""); }
    catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  const doRevert = async () => {
    setBusy(true);
    try { A.assertOk(await A.revertWorkday(revert.user_id, note), "Could not reopen."); flags.ok(`${revert.name}'s workday reopened.`); setRevert(null); setNote(""); live.refresh(); }
    catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  const KIND = { task: ["done", "● Working"], break: ["paused", "■ Break"], lunch: ["paused", "■ Lunch"], meeting: ["review", "▲ Meeting"], idle: ["todo", "○ Idle"], offline: ["todo", "○ Not started"], no_tasks: ["review", "▲ No tasks"] };

  return (
    <>
      <PageHeader crumbs={[{ label: "People" }, { label: "Live Tracking" }]} title="Live Tracking">
        {d && <span className="chip"><span className="pulse" />Live · as of {d.as_of || "now"} · refreshes every 15 s</span>}
        <div className="tabs"><span className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")} style={{ cursor: "pointer" }}>All</span><span className={filter === "working" ? "on" : ""} onClick={() => setFilter("working")} style={{ cursor: "pointer" }}>Working</span><span className={filter === "idle" ? "on" : ""} onClick={() => setFilter("idle")} style={{ cursor: "pointer" }}>Idle / break</span><span className={filter === "off" ? "on" : ""} onClick={() => setFilter("off")} style={{ cursor: "pointer" }}>Not started</span></div>
      </PageHeader>
      <PeopleNav />
      <div className="page">
        <div className="stats s5">
          <div className="stat"><small>Team</small><b>{d?.total ?? "…"}</b><span>developers</span></div>
          <div className="stat"><small>Working now</small><b style={{ color: "var(--pri-regular)" }}>{d?.active_count ?? "…"}</b><span>on a task</span></div>
          <div className="stat"><small>Present</small><b>{d?.present_count ?? "…"}</b><span>{d?.late_count ? `${d.late_count} late` : "workday started"}</span></div>
          <div className="stat"><small>Absent / not started</small><b style={{ color: "var(--subtlest)" }}>{d?.absent_count ?? "…"}</b><span>{d?.cutoff_display ? `late after ${d.cutoff_display}` : ""}</span></div>
          <div className="stat"><small>On break / meeting</small><b style={{ color: "var(--pri-important)" }}>{d ? (d.rows || []).filter((r) => r.started && !r.active && r.activity_kind && !["idle", "offline"].includes(r.activity_kind)).length : "…"}</b><span>paused</span></div>
        </div>
        {liveErr && !d && <ErrorState error={liveErr} onRetry={live.refresh} />}
        {live.stale && <StaleBar error={live.error} onRetry={live.refresh} />}
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {!d ? (liveErr ? null : <div style={{ padding: 16 }}><Skeleton rows={6} /></div>) : (
            <table className="table">
              <thead><tr><th>Developer</th><th>Activity</th><th>Current task</th><th className="num">Elapsed</th><th>Attendance</th><th className="num">Tasks</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const [tone, label] = KIND[r.activity_kind] || ["todo", r.activity_label || "—"];
                  const el = r.elapsed_seconds ? r.elapsed_seconds + (r.active || ["break", "lunch", "meeting", "no_tasks"].includes(r.activity_kind) ? extra : 0) : 0;
                  return (
                    <tr key={r.user_id} className={focus === r.user_id || dayOf?.user_id === r.user_id ? "sel" : ""} onClick={() => setDayOf(r)} style={{ cursor: "pointer" }} title={`See ${r.name}'s day`}>
                      <td><button type="button" onClick={() => setDayOf(r)} title={`Open ${r.name}'s day`} style={{ border: 0, background: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left" }}><Avatar name={r.name} uid={r.user_id} size={24} /> <b style={{ textDecoration: "underline", textDecorationColor: "var(--border)", textUnderlineOffset: 3 }}>{r.name}</b></button>{r.day_done && <> <Lozenge tone="todo">Ended</Lozenge></>}{(r.reopened_by || r.reopened_reason) && <> <Lozenge tone="review" style={{ textTransform: "none" }}>Reopened{r.reopened_by ? ` by ${r.reopened_by}` : ""}</Lozenge></>}
                        {r.reopened_reason && <div className="mini" style={{ marginTop: 3, whiteSpace: "normal", color: "var(--lz-paused)" }} title="Why this day was reopened">↩ {r.reopened_reason}</div>}</td>
                      <td><Lozenge tone={tone}>{label}</Lozenge>{r.activity_note && <div className="mini" style={{ marginTop: 3 }}>"{r.activity_note}"</div>}</td>
                      <td>{r.activity_kind === "task" ? (
                        <span>{(r.active_tasks || [{ id: null, name: r.activity_label }]).map((t, i) => <span key={t.id || i} style={{ display: "block" }}>{t.id ? <a href={`/board?task=${t.id}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); acts.openTask(t.id); }}>{t.name}</a> : t.name}{r.active_tasks?.length > 1 ? <span className="mini"> · {t.elapsed_display}</span> : null}</span>)}</span>
                      ) : <span className="mini">{r.activity_label || (r.started ? "No task running" : "Workday not started")}</span>}</td>
                      <td className="num"><b>{el ? fmtHM(el) : "—"}</b></td>
                      <td>{r.attendance === "present" ? <Lozenge tone="done">Present {r.arrival}</Lozenge> : r.attendance === "late" ? <Lozenge tone="paused">Late {r.arrival}</Lozenge> : r.attendance === "absent" ? <Lozenge tone="danger">Absent</Lozenge> : <Lozenge tone="todo">Yet to start</Lozenge>}</td>
                      <td className="num">{r.active_task_count ?? (r.active_tasks?.length || "—")}</td>
                      <td onClick={(e) => e.stopPropagation()}><span style={{ display: "inline-flex", gap: 6 }}>
                        <Button size="sm" kind="ghost" onClick={() => setDayOf(r)}>Day</Button>
                        {!r.active && <Button size="sm" onClick={() => { setNote(""); setNudge(r); }}>Nudge</Button>}
                        {r.day_done && <Button size="sm" kind="ghost" onClick={() => { setNote(""); setRevert(r); }}>Reopen workday</Button>}
                      </span></td>
                    </tr>
                  );
                })}
                {!rows.length && <tr><td colSpan={7} className="empty">Nobody in this filter.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {dayOf && <EmployeeDay person={dayOf} onClose={() => setDayOf(null)} onOpenTask={(id) => { setDayOf(null); acts.openTask(id); }} />}
      <Modal open={!!nudge} onClose={() => setNudge(null)} title={nudge ? `Nudge ${nudge.name}` : ""} width={460}
        footer={<><Button kind="ghost" onClick={() => setNudge(null)}>Cancel</Button><Button kind="primary" busy={busy} onClick={doNudge}>Send nudge</Button></>}>
        <p className="note" style={{ margin: 0 }}>{nudge?.started ? "They'll get \"is checking in on you\" as a notification on their phone and here." : "They'll get \"asks you to start your workday\" as a notification. One nudge per person every 10 minutes."}</p>
        <Field label="Note (optional)"><span className="input"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. Client demo at 3 — please start" style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }} /></span></Field>
      </Modal>
      <Modal open={!!revert} onClose={() => setRevert(null)} title={revert ? `Reopen ${revert.name}'s workday` : ""} width={460}
        footer={<><Button kind="ghost" onClick={() => setRevert(null)}>Cancel</Button><Button kind="primary" busy={busy} disabled={!note.trim()} onClick={doRevert}>Reopen</Button></>}>
        <p className="note" style={{ margin: 0 }}>They ended today already. Reopening lets them press "Reopen and continue workday"; the reason is shown to them.</p>
        <Field label="Reason" required><span className="input"><input value={note} onChange={(e) => setNote(e.target.value)} autoFocus style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }} /></span></Field>
      </Modal>
    </>
  );
}
