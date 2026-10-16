"use client";
import Link from "next/link";
import { Avatar, ErrorState, Icon, PageHeader, Skeleton } from "@/components/ui";
import { useMe } from "@/lib/me";
import { useResource } from "@/lib/useFetch";
import * as P from "@/lib/services/portal";
import { since } from "@/lib/liveTime";

/* The client's home: approvals needed, counts, how to raise a request, recent activity. */
export default function PortalHome() {
  const { me } = useMe();
  const dash = useResource(P.DASH_PATH, { state: "all" }, { pollMs: 60000, ttl: 10000 });
  const d = dash.data;
  const kpis = d?.kpis || [];
  /* pending_approvals are sign-off items; the go-ahead requests come from the pre-approval list. */
  const preRes = useResource(P.PRE_LIST_PATH, {}, { pollMs: 60000, ttl: 10000 });
  const pending = preRes.data?.kpis || [];
  const signIds = new Set([...(d?.pending_approvals || []).map((k) => k.id), ...kpis.filter((k) => k.task_state === "awaiting_client").map((k) => k.id)]);
  const signoffs = [...signIds];
  const need = pending.length + signoffs.length;
  const t = d?.totals || {};
  /* Time logged on accepted tasks: by_type.{requirement,update,bug}.hours (totals has no hours). */
  const hoursLogged = Object.values(d?.by_type || {}).reduce((s, b) => s + (Number(b?.hours) || 0), 0);
  const count = (states) => kpis.filter((k) => states.includes(k.task_state)).length;
  const recent = [...kpis].sort((a, b) => ((b.completion_date || "") > (a.completion_date || "") ? 1 : -1)).slice(0, 6);
  const clientName = d?.clients?.[0]?.name || d?.kpis?.[0]?.client_name || "";

  return (
    <>
      <PageHeader crumbs={[{ label: clientName || "Portal" }, { label: "Home" }]} title={`Welcome, ${me.name.split(" ")[0]}`} meta={d?.clients?.length ? d.clients.map((c) => c.name).join(" · ") : ""} />
      <div className="page" style={{ maxWidth: 1180 }}>
        {dash.error && !d && <ErrorState error={dash.error} onRetry={dash.refresh} />}
        {d && d.authorized === false && <div className="cardbox"><b style={{ color: "var(--navy)" }}>Your account isn't linked to a client yet</b><span className="mini">{d.message || "Ask your admin to add you under your company in Settings › KRA / KPI master."}</span></div>}
        {!d && !dash.error && <div className="cardbox"><Skeleton rows={4} /></div>}
        {d?.authorized !== false && d && (
          <>
            {need > 0 && (
              <div className="callout" style={{ background: "var(--lz-review-bg)", borderColor: "var(--tint-violet)", color: "var(--tint-violet-text)" }}>
                <Icon n="flag" size={20} />
                <span style={{ flex: 1 }}><b>{need} task{need === 1 ? "" : "s"} need{need === 1 ? "s" : ""} your approval</b> — {signoffs.length ? `${signoffs.length} ready for sign-off` : ""}{signoffs.length && pending.length ? ", " : ""}{pending.length ? `${pending.length} waiting for your go-ahead` : ""}.</span>
                <Link className="btn btn-primary" href="/portal/requests?tab=approval" style={{ height: 32 }}>Review now</Link>
              </div>
            )}
            <div className="stats">
              <Link href="/portal/requests?tab=approval" className="stat" style={{ textDecoration: "none" }}><small>Awaiting your approval</small><b style={{ color: "var(--tint-violet)" }}>{need}</b><span>sign-off {signoffs.length} · estimate {pending.length}</span></Link>
              <Link href="/portal/requests?tab=in_progress" className="stat" style={{ textDecoration: "none" }}><small>In progress</small><b style={{ color: "var(--tint-blue)" }}>{t.in_progress ?? count(["in_progress", "rework", "hold"])}</b><span>being built</span></Link>
              <Link href="/portal/requests?tab=queued" className="stat" style={{ textDecoration: "none" }}><small>Queued / paused</small><b style={{ color: "var(--pri-important)" }}>{(t.paused ?? count(["paused"])) + (t.open ?? count(["assigned", "pre_approval_pending", "pre_approval_approved"]))}</b><span>waiting to start</span></Link>
              <Link href="/portal/requests?tab=completed" className="stat" style={{ textDecoration: "none" }}><small>Completed</small><b style={{ color: "var(--pri-regular)" }}>{t.completed ?? count(["completed"])}</b><span>{hoursLogged ? `${Math.round(hoursLogged)}h logged` : "certified by you"}</span></Link>
            </div>
            <div className="cardbox"><h2>Send a new request</h2>
              <div className="grid3">
                <Link href="/portal/requests/new/requirement" className="cardbox" style={{ textDecoration: "none", alignItems: "flex-start", gap: 8, borderColor: "var(--tint-blue-border)", background: "var(--hover)" }}><span className="icbox" style={{ background: "var(--tint-blue-bg)", color: "var(--tint-blue)" }}><Icon n="plus" size={18} /></span><b style={{ color: "var(--navy)", fontSize: 15 }}>New requirement</b><span className="mini">Something new you want built</span></Link>
                <Link href="/portal/requests/new/update" className="cardbox" style={{ textDecoration: "none", alignItems: "flex-start", gap: 8 }}><span className="icbox" style={{ background: "var(--tint-green-bg)", color: "var(--tint-green)" }}><Icon n="pen" size={18} /></span><b style={{ color: "var(--navy)", fontSize: 15 }}>Update request</b><span className="mini">Change something that exists</span></Link>
                <Link href="/portal/requests/new/bug" className="cardbox" style={{ textDecoration: "none", alignItems: "flex-start", gap: 8 }}><span className="icbox" style={{ background: "var(--tint-red-bg)", color: "var(--tint-red)" }}><Icon n="warn" size={18} /></span><b style={{ color: "var(--navy)", fontSize: 15 }}>Report a bug</b><span className="mini">Something is not working</span></Link>
              </div>
            </div>
            <div className="cardbox"><h2>Recent activity</h2>
              {recent.map((k) => (
                <Link key={k.id} href={`/portal/requests?focus=${k.id}`} className="notif" style={{ textDecoration: "none", color: "inherit" }}>
                  <span className="icbox" style={{ background: k.task_state === "completed" ? "var(--tint-green-bg)" : k.task_state === "awaiting_client" ? "var(--tint-violet-bg)" : "var(--tint-blue-bg)", color: k.task_state === "completed" ? "var(--tint-green)" : k.task_state === "awaiting_client" ? "var(--tint-violet)" : "var(--tint-blue)" }}><Icon n={k.task_state === "completed" ? "check" : k.task_state === "awaiting_client" ? "flag" : "play"} size={18} /></span>
                  <div style={{ flex: 1 }}><p>{k.external_ref ? `${k.external_ref} · ` : ""}{k.name}</p><small>{k.project_name || ""}{k.primary_assignee ? ` · ${k.primary_assignee}` : ""}{k.completion_date ? ` · ${k.completion_date}` : ""}</small></div>
                </Link>
              ))}
              {!recent.length && <span className="mini">No tasks yet — send your first request above.</span>}
            </div>
          </>
        )}
      </div>
    </>
  );
}
