"use client";
import { useEffect, useMemo } from "react";
import Link from "next/link";
import { Avatar, Button, ErrorState, Icon, Lozenge, PageHeader, Skeleton, stateTone } from "@/components/ui";
import { useMe } from "@/lib/me";
import { useResource } from "@/lib/useFetch";
import * as S from "@/lib/services/kpiActions";
import { fmtHM, laneForTask } from "@/lib/services/kpiActions";
import { fmtClock, secsSince, liveFromAnchor, productiveLive, presenceLive } from "@/lib/liveTime";
import LiveTick from "@/components/task/LiveTick";
import { WorkdayButton, WorkdayPausedBanner } from "@/components/work/WorkdayButton";
import { actionsFor } from "@/components/task/actions";
import { useTaskActions } from "@/components/task/TaskActions";

const EMPTY = [];

/* Your work — the app's Home: running task, today's numbers, what was worked
   on today, quick actions. */
export default function YourWork() {
  const { me } = useMe();
  const acts = useTaskActions();
  const admin = me.role === "admin";
  const board = useResource(S.TASKS_PATH, { my_tasks_only: false }, { pollMs: 30000 });
  const boardRefresh = board.refresh;
  useEffect(() => { const on = () => boardRefresh(); window.addEventListener("kpi:refresh", on); return () => window.removeEventListener("kpi:refresh", on); }, [boardRefresh]);
  const tasks = board.data?.tasks || EMPTY;
  const live = acts.live.data;
  const workdayOpen = acts.workdayOpen;

  const mineTasks = useMemo(() => tasks.filter((t) => t.user_id === me.uid), [tasks, me.uid]);
  const scope = admin ? tasks : mineTasks;
  const lanes = useMemo(() => S.groupIntoLanes(scope), [scope]);
  const running = useMemo(() => mineTasks.filter((t) => t.task_state === "in_progress"), [mineTasks]);
  const today = useMemo(() => scope.filter(S.isTodayTask).sort((a, b) => (b.today_seconds || 0) - (a.today_seconds || 0)), [scope]);
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  const stats = admin
    ? [
      { label: "Open tasks", n: scope.filter((t) => !["completed"].includes(t.task_state)).length, sub: `${lanes.in_progress.length} running now`, bg: "var(--tint-blue-bg)", fg: "var(--tint-blue)", icon: "board", href: "/board" },
      { label: "Pending review", n: lanes.pending_review.length, sub: "self-created, need accept", bg: "var(--tint-violet-bg)", fg: "var(--tint-violet)", icon: "inbox", href: "/board" },
      { label: "Pending approvals", n: lanes.approvals.length, sub: "done by developers", bg: "var(--tint-amber-bg)", fg: "var(--tint-amber)", icon: "check", href: "/board" },
      { label: "Awaiting client", n: lanes.awaiting_client.length, sub: "sign-off requested", bg: "var(--tint-cyan-bg)", fg: "var(--tint-cyan)", icon: "flag", href: "/board" },
    ]
    : [
      { label: "Today's tasks", n: today.length, sub: `${fmtHM(today.reduce((s, t) => s + (t.today_seconds || 0), 0))} logged today`, bg: "var(--tint-blue-bg)", fg: "var(--tint-blue)", icon: "board", href: "/board" },
      { label: "In progress", n: lanes.in_progress.length, sub: running[0] ? `${running[0].external_ref || ""} running` : "nothing running", bg: "var(--tint-green-bg)", fg: "var(--tint-green)", icon: "play", href: "/board" },
      { label: "Paused", n: lanes.paused.length, sub: "waiting to be resumed", bg: "var(--tint-amber-bg)", fg: "var(--tint-amber)", icon: "pause", href: "/board" },
      { label: "To do", n: lanes.regular.length + lanes.important.length + lanes.urgent.length, sub: `${lanes.urgent.length} urgent`, bg: "var(--tint-violet-bg)", fg: "var(--tint-violet)", icon: "list", href: "/board" },
    ];

  return (
    <>
      <PageHeader crumbs={[{ label: "Your work" }]} title={`${greet}, ${me.name.split(" ")[0]}`}>
        {workdayOpen && live && <span className="chip"><span className="pulse" /><LiveTick fn={(n) => `Workday ${fmtClock(presenceLive(live, n))} · productive ${fmtClock(productiveLive(live, n))}`} /></span>}
      </PageHeader>
      <div className="page">
        <WorkdayPausedBanner />
        {board.error && !board.data && <ErrorState error={board.error} onRetry={board.refresh} />}
        <div className="stats">
          {stats.map((s) => (
            <Link key={s.label} href={s.href} className="stat" style={{ textDecoration: "none" }}>
              <small>{s.label}</small><b>{board.data ? s.n : "…"}</b><span>{s.sub}</span>
              <span className="ic" style={{ background: s.bg, color: s.fg }}><Icon n={s.icon} size={18} /></span>
            </Link>
          ))}
        </div>
        <div className="g21">
          {running.length > 0 ? <RunningCard task={running[0]} more={running.length - 1} /> : (
            <div className="cardbox" style={{ justifyContent: "center", minHeight: 150 }}>
              {!workdayOpen && !admin
                ? <><b style={{ color: "var(--navy)", fontSize: 16 }}>Your workday hasn't started</b><span className="mini">Start it to work on tasks. Presence and productive time count from then.</span><div><WorkdayButton /></div></>
                : <><b style={{ color: "var(--navy)", fontSize: 16 }}>Nothing running</b><span className="mini">Pick a task on the board and press Start.</span><div><Link className="btn btn-primary" href="/board">Open board</Link></div></>}
            </div>
          )}
          <div className="cardbox">
            <h2>Quick actions</h2>
            <div className="qa" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
              <Link href="/board" style={{ background: "var(--tint-blue-bg)" }}><span className="icbox" style={{ color: "var(--tint-blue)" }}><Icon n="board" size={18} /></span>Action board</Link>
              {admin ? <Link href="/people" style={{ background: "var(--tint-blue-bg)" }}><span className="icbox" style={{ color: "var(--tint-blue)" }}><Icon n="live" size={18} /></span>Live Tracking</Link>
                : <Link href="/your-work/timeline" style={{ background: "var(--tint-violet-bg)" }}><span className="icbox" style={{ color: "var(--tint-violet)" }}><Icon n="timeline" size={18} /></span>My workday</Link>}
              <Link href="/reminders" style={{ background: "var(--tint-amber-bg)" }}><span className="icbox" style={{ color: "var(--tint-amber)" }}><Icon n="alarm" size={18} /></span>Reminders</Link>
              <Link href="/documents" style={{ background: "var(--tint-green-bg)" }}><span className="icbox" style={{ color: "var(--tint-green)" }}><Icon n="doc" size={18} /></span>Documents</Link>
              {admin ? <Link href="/queue" style={{ background: "var(--tint-orange-bg)" }}><span className="icbox" style={{ color: "var(--tint-orange)" }}><Icon n="inbox" size={18} /></span>Client queue</Link>
                : <Link href="/your-work/snapshots" style={{ background: "var(--tint-cyan-bg)" }}><span className="icbox" style={{ color: "var(--tint-cyan)" }}><Icon n="camera" size={18} /></span>My snapshots</Link>}
              <Link href="/manual" style={{ background: "var(--tint-pink-bg)" }}><span className="icbox" style={{ color: "var(--tint-pink)" }}><Icon n="book" size={18} /></span>User manual</Link>
            </div>
          </div>
        </div>
        <div className="cardbox" style={{ overflowX: "auto" }}>
          <h2>Worked on today <small>{new Date().toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}</small><span className="right"><Link href="/board" className="mini" style={{ fontWeight: 700 }}>Open board →</Link></span></h2>
          {!board.data ? <Skeleton rows={3} /> : today.length === 0 ? <span className="mini">Nothing logged yet today.</span> : (
            <table className="table">
              <thead><tr><th>Ref</th><th>Task</th><th>Client</th>{admin && <th>Developer</th>}<th className="num">Time today</th><th>Status</th></tr></thead>
              <tbody>
                {today.slice(0, 8).map((t) => {
                  const lane = laneForTask(t);
                  const [tone, label] = lane === "approvals" ? ["review", "In review"] : stateTone(t.task_state);
                  return (
                    <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => acts.openTask(t.id)}>
                      <td><span className="ref">{t.external_ref || `#${t.id}`}</span></td><td><b>{t.name}</b></td><td>{t.client_name || "—"}</td>
                      {admin && <td><Avatar name={t.user_name} id={t.user_id} size={22} /> {t.user_name}</td>}
                      <td className="num">{t.task_state === "in_progress" && t.timer_start_datetime ? <LiveTick fn={(n) => fmtHM((t.today_seconds || 0) + secsSince(t.timer_start_datetime, n))} /> : fmtHM(t.today_seconds)}</td>
                      <td><Lozenge tone={tone}>{t.task_state === "in_progress" ? "Running" : label}</Lozenge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function RunningCard({ task: t, more }) {
  const { me } = useMe();
  const acts = useTaskActions();
  const actions = actionsFor(t, me, { workdayLocked: acts.workdayLocked }).filter((a) => ["pause", "complete", "switch", "add_time"].includes(a.key));
  return (
    <div className="run">
      <small>Running now{more > 0 ? ` · +${more} more` : ""}</small>
      <b>{t.external_ref ? `${t.external_ref} · ` : ""}{t.name}</b>
      <span style={{ fontSize: 12.5, opacity: .85, fontWeight: 600 }}>{t.client_name || ""}{t.project_name ? ` · ${t.project_name}` : ""} · {t.priority} · estimate {t.estimate_display}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}><span className="big"><LiveTick fn={(n) => fmtClock(secsSince(t.timer_start_datetime, n))} /></span><span style={{ fontSize: 12.5, opacity: .85, fontWeight: 600 }}><LiveTick fn={(n) => fmtHM(liveFromAnchor(t.timer_start_datetime, t.timer_total_seconds, n))} /> logged in total</span></div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {actions.map((a, i) => <button key={a.key} className={`btn ${i === 0 ? "w" : ""}`} onClick={() => acts.run(a, t)}>{a.label}</button>)}
        {more > 0 && <button className="btn" onClick={() => acts.pauseAll()}>Pause all ({more + 1})</button>}
        <a href="#" onClick={(e) => { e.preventDefault(); acts.openTask(t.id); }} style={{ marginLeft: "auto", color: "#fff", fontWeight: 700, fontSize: 13 }}>Open task →</a>
      </div>
    </div>
  );
}
