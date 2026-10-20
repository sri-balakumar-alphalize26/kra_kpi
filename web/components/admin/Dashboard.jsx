"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMe } from "@/lib/me";
import { useResource } from "@/lib/useFetch";
import * as A from "@/lib/services/admin";
import { Avatar, Button, ErrorState, Skeleton, useOutside, useSpin } from "@/components/ui";
import AiAssistant from "./AiAssistant";
import { downloadSections } from "./aiExport";

/* The Dashboard (/dashboard): the CEO's one page, in plain words. The 369 AI
   Assistant is docked on the left and stays put (sticky, like the sidebar)
   while the details on the right scroll. Every number says in a sentence what
   it means; charts carry their own labels. Three reads:
     /kra_kpi/dashboard/overview     counts and short lists for every area (DASHBOARD_PATH)
     /kpi_owner/live_tracking        presence and what each person is doing now
     /kpi_owner/certified_by_client  per-client sign-off, hours and invoices
   An answer from the assistant highlights the card it is about. Admins only
   (dashboard/layout.jsx). Numbers the backend has no data for are left out. */

const P = {
  board: "M3 4h5v16H3zM10 4h5v10h-5zM17 4h4v13h-4z", check: "M9 11l3 3 8-8M20 12v6a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h9",
  queue: "M4 4h16v6H4zM4 14h16v6H4z", shield: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z", cash: "M3 6h18v13H3zM3 10h18M7 15h4",
  sign: "M5 12l4 4L19 6", clock: "M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0", live: "M3 12h4l3-8 4 16 3-8h4",
  cal: "M3 5h18v16H3zM3 10h18M8 3v4M16 3v4", bell: "M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 003.4 0",
  doc: "M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5", cert: "M12 15a6 6 0 100-12 6 6 0 000 12zM8.5 13.5L7 22l5-3 5 3-1.5-8.5",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2", chat: "M21 12a8 8 0 01-12 7l-6 2 2-5.5A8 8 0 1121 12z",
  refresh: "M3 12a9 9 0 0115-6.7L21 8M21 3v5h-5", download: "M12 3v12M7 10l5 5 5-5M5 21h14",
};
const Svg = ({ d, size = 16, className = "" }) => <svg className={`db-ic ${className}`} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"><path d={d} /></svg>;

const reduceMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const n0 = (v) => Number(v || 0).toLocaleString("en-IN");
const hm = (secs) => { const m = Math.round((secs || 0) / 60); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`; };
const mins = (secs) => { const m = Math.round((secs || 0) / 60); return m < 60 ? `${m} min` : hm(secs); };
const hours = (secs) => Math.round((secs || 0) / 3600);
const money = (list) => (list || []).map((x) => `${x.symbol || ""}${Number(x.amount || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`).join(" + ");
const amount = (x) => `${x.symbol || ""}${Number(x.amount || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const dayName = (iso, opts = { weekday: "short" }) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", opts);
const shortDate = (iso) => (iso ? dayName(iso, { day: "numeric", month: "short" }) : "");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isAre = (n) => (n === 1 ? "is" : "are");
const taskLabel = (t) => `${t.ref ? `${t.ref} · ` : ""}${t.name}`;
function whenLabel(iso, today) {
  if (!iso) return "";
  if (iso === today) return "Today";
  const t = new Date(`${today}T00:00:00`); t.setDate(t.getDate() + 1);
  const tomorrow = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  return iso === tomorrow ? "Tomorrow" : dayName(iso, { weekday: "short", day: "numeric", month: "short" });
}
const STATUS_WORD = { ok: "All good", warn: "Look soon", bad: "Act now" };

/* A number that counts up the first time it arrives (not on every poll). */
function Count({ value }) {
  const [shown, setShown] = useState(value ?? 0);
  const first = useRef(true);
  useEffect(() => {
    if (value == null) return;
    if (!first.current || reduceMotion()) { setShown(value); return; }
    first.current = false;
    const t0 = performance.now(), dur = 1100; let raf;
    const step = (t) => { const p = Math.min(1, (t - t0) / dur); setShown(Math.round(value * (1 - Math.pow(1 - p, 3)))); if (p < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{n0(shown)}</>;
}

/* true one frame after mount, so bars and rings grow from zero. */
function useGrown() {
  const [g, setG] = useState(false);
  useEffect(() => { const r = requestAnimationFrame(() => setG(true)); return () => cancelAnimationFrame(r); }, []);
  return g;
}

/* Which card an assistant answer is about. */
function cardFor(res, question) {
  const q = String(question || "").toLowerCase();
  const st = res?.context?.statuses || [];
  if (st.includes("partially_completed") || q.includes("approv")) return "k3";
  if (q.includes("invoice") || q.includes("unpaid")) return "money";
  if (q.includes("client") || q.includes("quote")) return "clients";
  switch (res?.intent) {
    case "workday": case "leaderboard": case "over_estimate": return "emp";
    case "overdue": return "deadlines";
    case "alerts": return "att";
    case "summary": return "kpis";
    default: break;
  }
  return st.length ? "pipe" : null;
}

export default function Dashboard() {
  const { me } = useMe();
  const ov = useResource(A.DASHBOARD_PATH, {}, { ttl: 30000, pollMs: 60000 });
  const live = useResource(A.LIVE_TRACKING_PATH, {}, { ttl: 5000, pollMs: 30000 });
  const cert = useResource(A.CERTIFIED_PATH, {}, { ttl: 30000 });
  const [spinning, spin] = useSpin();
  const refreshAll = () => spin(ov.refresh, live.refresh, cert.refresh);

  const o = ov.data?.status ? ov.data : null;
  const lt = live.data?.status ? live.data : null;
  const clients = cert.data?.status ? cert.data.clients || [] : null;
  const refused = ov.data?.status === false ? { message: ov.data.message || "Could not load the dashboard." } : null;

  /* Highlight the card an answer is about, and bring it into view. */
  const refs = useRef({});
  const [lit, setLit] = useState(null);
  const onAnswer = useCallback((res, question) => {
    const key = cardFor(res, question);
    const el = key && refs.current[key];
    if (!el) return;
    setLit(null);
    requestAnimationFrame(() => setLit(key));
    el.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "nearest" });
  }, []);
  useEffect(() => { if (!lit) return; const t = setTimeout(() => setLit(null), 1800); return () => clearTimeout(t); }, [lit]);
  const card = (key) => ({ ref: (el) => { refs.current[key] = el; }, "data-lit": lit === key ? "" : undefined });

  const people = useMemo(() => buildPeople(lt, o), [lt, o]);
  const clientRows = useMemo(() => (clients || []).slice().sort((a, b) => b.awaiting_client_count - a.awaiting_client_count || b.completed_count - a.completed_count), [clients]);
  const overQuote = useMemo(() => (clients || []).filter((c) => c.total_quoted_hours > 0 && c.total_actual_hours > c.total_quoted_hours)
    .sort((a, b) => b.total_actual_hours / b.total_quoted_hours - a.total_actual_hours / a.total_quoted_hours), [clients]);
  const alerts = useMemo(() => buildAlerts(o, lt, overQuote), [o, lt, overQuote]);

  const hour = new Date().getHours();
  const hello = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const first = (me?.name || "").trim().split(" ")[0];
  const todayIso = o?.today;

  const report = async (kind) => {
    const blocks = reportBlocks(o, lt, people, clientRows, alerts);
    await downloadSections(kind, [{ question: "Dashboard", res: { title: `Dashboard - ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`, blocks, intent: "summary" } }],
      { user: me?.name, subtitle: "Dashboard report", name: "dashboard" });
  };

  return (
    <div className="db-wrap">
      <AiAssistant variant="panel" onAnswer={onAnswer} />

      <section className="db-det" aria-label="Business details">
        <div className="db-greet">
          <div>
            <h1>{first ? `${hello}, ${first}` : hello}</h1>
            <div className="db-presence">
              {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}
              {o?.as_of && <span className="db-asof">· numbers as of {o.as_of}</span>}
              {lt && <>
                <span className="db-tag in"><i />{lt.present_count} present</span>
                {lt.absent_count > 0 && <span className="db-tag out"><i />{lt.absent_count} absent</span>}
                {lt.late_count > 0 && <span className="db-tag late"><i />{lt.late_count} late</span>}
                {lt.total - lt.present_count - lt.absent_count > 0 && <span className="db-tag out"><i />{lt.total - lt.present_count - lt.absent_count} not in yet</span>}
              </>}
            </div>
          </div>
          <div className="db-gbtns">
            <Button kind="ghost" onClick={refreshAll} aria-busy={spinning || undefined}><Svg d={P.refresh} size={14} className={spinning ? "is-spinning" : ""} /> Refresh</Button>
            <ReportMenu onPick={report} disabled={!o} />
          </div>
        </div>

        {(refused || (ov.error && !ov.data)) && <ErrorState error={refused || ov.error} onRetry={ov.refresh} />}

        {/* ---- headline numbers ---- */}
        <div className="db-kpis" {...card("kpis")}>
          <Headline1 o={o} />
          <Headline2 o={o} />
          <div {...card("k3")} className="db-card db-stat" style={{ animationDelay: ".16s" }} data-lit={lit === "k3" || lit === "kpis" ? "" : undefined}>
            <Headline3 o={o} />
          </div>
          <Headline4 o={o} />
        </div>

        {/* ---- every area at a glance ---- */}
        <div className="db-card db-areas" style={{ animationDelay: ".24s" }}>
          <div className="db-ttlrow">
            <div className="db-ttl">Everything at a glance</div>
            <div className="db-akey"><span className="db-pill ok">All good</span><span className="db-pill warn">Look soon</span><span className="db-pill bad">Act now</span></div>
          </div>
          <p className="db-intro">Every part of the app in one line. Tap a tile to open it.</p>
          {o ? <div className="db-agrid">{areas(o, lt, todayIso).map((a) => (
            <Link key={a.key} href={a.href} className="db-area" title={`Open ${a.title}`}>
              <div className="db-ahead"><span className="db-aic" style={{ "--c": a.color }}><Svg d={a.icon} size={14} /></span><span className="db-aname">{a.title}</span></div>
              <div className="db-anumrow"><div className="db-anum">{a.num}{a.unit && <em>{a.unit}</em>}</div><span className={`db-pill ${a.status}`}>{STATUS_WORD[a.status]}</span></div>
              <div className="db-atxt">{a.text}</div>
            </Link>
          ))}</div> : <Skeleton rows={4} />}
        </div>

        {/* ---- trend + pipeline ---- */}
        <div className="db-row2">
          <Weekly o={o} />
          <div {...card("pipe")} className="db-card db-pipe" style={{ animationDelay: ".3s" }}>
            <Pipeline o={o} />
          </div>
        </div>

        {/* ---- deadlines ---- */}
        <div {...card("deadlines")} className="db-card" style={{ animationDelay: ".32s" }}>
          <Deadlines o={o} />
        </div>

        {/* ---- employees ---- */}
        <div {...card("emp")} className="db-card db-emp" style={{ animationDelay: ".34s" }}>
          <div className="db-ttlrow">
            <div className="db-ttl">Employees {lt && <small>as of {lt.as_of}</small>}</div>
            <Link className="db-link" href="/people">Open Live Tracking ›</Link>
          </div>
          <p className="db-intro">What each person is doing right now, and how their work stands.</p>
          {!people ? <Skeleton rows={5} /> : !people.length ? <p className="db-muted">Nobody on the team roster yet.</p> : (
            <>
              <div className="db-tablewrap"><table className="table db-grid">
                <thead><tr><th>Person</th><th>Doing right now</th><th>Their tasks</th><th className="num">Hours on tasks today</th><th className="num">This week</th><th className="num" title="Their open tasks: hours estimated vs hours already spent">Open tasks: estimated vs spent</th></tr></thead>
                <tbody>{people.map((p) => <PersonRow key={p.user_id} p={p} />)}</tbody>
              </table></div>
              <p className="db-legend">
                <span className="db-lz run">running</span> working on it now · <span className="db-lz pause">paused</span> stopped for now ·{" "}
                <span className="db-lz todo">to do</span> not started · <span className="db-lz appr">approval</span> waiting for your OK ·{" "}
                <span className="db-lz done">done</span> finished in the last 7 days · <b className="db-over">red hours</b> more time spent than estimated
              </p>
            </>
          )}
        </div>

        {/* ---- clients + attention ---- */}
        <div className="db-row3">
          <div {...card("clients")} className="db-card db-clients" style={{ animationDelay: ".4s" }}>
            <div className="db-ttlrow">
              <div className="db-ttl">Clients {clients && <small>{clients.length} active</small>}</div>
              <Link className="db-link" href="/dashboards">Open Client Billing ›</Link>
            </div>
            <p className="db-intro">Clients with the most delivered work waiting for their sign-off come first.</p>
            {!clients && (cert.data?.status === false || cert.error)
              ? <p className="db-muted">Couldn't load the clients{cert.data?.message || cert.error?.message ? `: ${cert.data?.message || cert.error.message}` : "."} <button type="button" className="db-retry" onClick={cert.refresh}>Try again</button></p>
              : !clients ? <Skeleton rows={5} /> : !clients.length ? <p className="db-muted">No clients yet.</p> : (
              <div className="db-tablewrap"><table className="table db-grid db-cgrid">
                <thead><tr><th>Client · last invoice</th><th className="num">Waiting sign-off</th><th className="num">Signed off</th><th className="num">Open</th><th className="num">Hours used of quoted</th></tr></thead>
                <tbody>{clientRows.slice(0, 8).map((c) => {
                  const over = c.total_quoted_hours > 0 && c.total_actual_hours > c.total_quoted_hours;
                  return (
                    <tr key={c.client_id}>
                      <td><div className="db-person"><Avatar name={c.client_name} id={c.client_id} size={26} /><div className="db-cname"><span title={c.client_name}>{c.client_name}</span>
                        <small>{c.last_invoice_name ? `${c.last_invoice_name} · ${c.last_invoice_state}` : "No invoice yet"}</small></div></div></td>
                      <td className="num"><b>{c.awaiting_client_count}</b></td>
                      <td className="num">{c.completed_count}</td>
                      <td className="num">{c.in_progress_count}</td>
                      <td className={`num ${over ? "db-over" : ""}`} title={over ? "More hours used than the client was quoted" : undefined}>
                        {Math.round(c.total_actual_hours)}h of {Math.round(c.total_quoted_hours)}h{over ? ` ▲${Math.round((c.total_actual_hours / c.total_quoted_hours - 1) * 100)}% over` : ""}
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
            )}
          </div>

          <div {...card("att")} className="db-card db-att" style={{ animationDelay: ".44s" }}>
            <div className="db-ttl">Needs your attention</div>
            {!o ? <Skeleton rows={3} /> : !alerts.length ? <p className="db-muted">Nothing needs you right now.</p> : (
              <div className="db-alist">{alerts.map((a) => (
                <Link key={a.key} href={a.href} className={`db-al ${a.tone}`}><b>{a.title}</b>{a.text && <small>{a.text}</small>}<span className="db-act">{a.action} ›</span></Link>
              ))}</div>
            )}
            <div className="db-ttl" style={{ marginTop: 4 }}>Upcoming meetings</div>
            {!o ? <Skeleton rows={2} /> : !o.meetings?.upcoming?.length ? <p className="db-muted">No meetings booked.</p> : o.meetings.upcoming.map((m) => (
              <Link key={m.id} href="/meetings" className="db-meet">
                <span className="db-ci"><Svg d={P.cal} /></span>
                <div><h4>{m.name}</h4><small>{whenLabel(m.date, todayIso)} · {m.time}{m.people?.length ? ` · ${m.people.join(", ")}` : ""}</small></div>
              </Link>
            ))}
          </div>
        </div>

        {/* ---- money + waiting on clients ---- */}
        <div className="db-row3">
          <div {...card("money")} className="db-card" style={{ animationDelay: ".48s" }}>
            <Unpaid o={o} />
          </div>
          <div className="db-card" style={{ animationDelay: ".5s" }}>
            <WaitingOnClients o={o} today={todayIso} />
          </div>
        </div>
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------- headline cards */
function Headline1({ o }) {
  const g = useGrown();
  const c = o?.completed;
  const days = c?.days || [];
  const max = Math.max(4, ...days.map((d) => d.count));
  const delta = c && c.prev_week ? Math.round((c.week / c.prev_week - 1) * 100) : null;
  return (
    <div className="db-card db-stat" style={{ animationDelay: ".04s" }}>
      <div className="db-lbl">Completed this week</div>
      <div className="db-val">{c ? <Count value={c.week} /> : "…"}<em>tasks</em>
        {delta != null && <span className={`db-delta ${delta < 0 ? "down" : ""}`}>{delta < 0 ? "▼" : "▲"} {Math.abs(delta)}%</span>}</div>
      {c && <p className="db-say">Finished in the last 7 days, {c.today} of them today.{delta != null ? ` ${delta < 0 ? "Down" : "Up"} ${Math.abs(delta)}% on the week before.` : ""}{c.month != null ? ` ${n0(c.month)} this month, ${n0(c.prev_month)} last month.` : ""}</p>}
      <div className="db-spark" aria-hidden="true">
        {days.map((d, i) => <i key={d.date} title={`${shortDate(d.date)}: ${d.count}`} className={i === days.length - 1 ? "today" : i >= days.length - 7 ? "hi" : ""} style={{ height: g ? `${Math.max(6, (d.count / max) * 100)}%` : 0, transitionDelay: `${i * 16}ms` }} />)}
      </div>
      <div className="db-cap">Last 4 weeks, day by day · this week in blue</div>
    </div>
  );
}

function Headline2({ o }) {
  const g = useGrown();
  const c = o?.clients;
  const total = c ? c.signoff_waiting + c.certified : 0;
  const pct = total ? Math.round((c.certified / total) * 100) : 0;
  return (
    <div className="db-card db-stat" style={{ animationDelay: ".1s" }}>
      <div className="db-lbl">Client sign-off waiting</div>
      <div className="db-val">{c ? <Count value={c.signoff_waiting} /> : "…"}<em>tasks</em></div>
      {c && <p className="db-say">Delivered work waiting for the client to sign it off. {n0(c.certified)} tasks are already signed.</p>}
      <div className="db-bar2" aria-hidden="true"><i className="ok" style={{ width: g ? `${pct}%` : 0 }} /></div>
      {c && <div className="db-cap split"><span>{n0(c.certified)} signed ({pct}%)</span><span>{n0(c.signoff_waiting)} waiting</span></div>}
    </div>
  );
}

const AGES = ["Today", "1 day", "2 days", "3 days", "4+ days"];
function Headline3({ o }) {
  const g = useGrown();
  const a = o?.approvals;
  const ages = a?.by_age || [0, 0, 0, 0, 0];
  const total = ages.reduce((s, v) => s + v, 0) || 1;
  const old = (ages[3] || 0) + (ages[4] || 0);
  return (
    <>
      <div className="db-lbl">Waiting for your approval</div>
      <div className="db-val">{a ? <Count value={a.count} /> : "…"}<em>tasks</em></div>
      {a && <p className="db-say">{a.count ? `Finished work waiting for you to check and approve. ${old ? `${old} ${isAre(old)} 3 days old or more; the oldest is ${a.oldest_ref || "a task"} (${plural(a.oldest_days, "day")}).` : "None is older than 2 days."}` : "Nothing is waiting for your OK."}</p>}
      <div className="db-bar2 stack" aria-hidden="true">
        {ages.map((v, i) => v > 0 && <i key={i} className={`a${i}`} style={{ width: g ? `${(v / total) * 100}%` : 0 }} title={`${AGES[i]}: ${v}`} />)}
      </div>
      <div className="db-cap ages">{AGES.map((l, i) => <span key={l}><i className={`a${i}`} />{l} <b>{ages[i]}</b></span>)}</div>
    </>
  );
}

function Headline4({ o }) {
  const g = useGrown();
  const h = o?.hours;
  const pct = h && h.week_presence ? Math.round((h.week_productive / h.week_presence) * 100) : 0;
  return (
    <div className="db-card db-stat" style={{ animationDelay: ".22s" }}>
      <div className="db-lbl">Team hours this week</div>
      <div className="db-val">{h ? <Count value={hours(h.week_productive)} /> : "…"}<em>hours on tasks</em></div>
      {h && <p className="db-say">The whole team, last 7 days: {pct}% of the {hours(h.week_presence)}h they were signed in. Today so far: {hm(h.today_productive)}.</p>}
      <div className="db-bar2" aria-hidden="true"><i className="brand" style={{ width: g ? `${pct}%` : 0 }} /></div>
      {h && <div className="db-cap split"><span>On tasks {pct}%</span><span>Not on tasks {100 - pct}%</span></div>}
    </div>
  );
}

/* ---------------------------------------------------------------- trend + pipeline */
function Weekly({ o }) {
  const g = useGrown();
  const [range, setRange] = useState(7);
  const days = (o?.completed?.days || []).slice(-range);
  const top = Math.max(4, ...days.map((d) => d.count));
  const max = Math.ceil(top / 4) * 4;
  const [act, setAct] = useState(null);
  const shown = act != null && act < days.length ? act : days.length - 1;
  const sum = days.reduce((s, d) => s + d.count, 0);
  const best = days.reduce((b, d) => (d.count > (b?.count ?? -1) ? d : b), null);
  const wide = range > 7;
  return (
    <div className="db-card db-weekly" style={{ animationDelay: ".26s" }}>
      <div className="db-ttlrow">
        <div className="db-ttl">Tasks completed per day</div>
        <div className="db-seg2" role="group" aria-label="Period">
          {[[7, "7 days"], [28, "4 weeks"]].map(([n, l]) => <button key={n} type="button" className={range === n ? "on" : ""} aria-pressed={range === n} onClick={() => { setRange(n); setAct(null); }}>{l}</button>)}
        </div>
      </div>
      <div className="db-sub">{o ? <Count value={sum} /> : "…"}<em>{wide ? "in the last 4 weeks" : "in the last 7 days"}{best && best.count > 0 ? ` · best day: ${dayName(best.date, wide ? { day: "numeric", month: "short" } : { weekday: "long" })} with ${best.count}` : ""}</em></div>
      <div className="db-chart">
        <div className="db-ylab"><span>{max}</span><span>{max / 2}</span><span>0</span></div>
        <div className={`db-bars ${wide ? "wide" : ""}`} onMouseLeave={() => setAct(null)}>
          {days.map((d, i) => (
            <button type="button" key={d.date} className={`db-bar ${i === shown ? "act" : ""}`} onMouseEnter={() => setAct(i)} onFocus={() => setAct(i)} onClick={() => setAct(i)}
              aria-label={`${dayName(d.date, { weekday: "long", day: "numeric", month: "short" })}: ${d.count} completed`}>
              <b style={{ height: g ? `${(d.count / max) * 100}%` : 0, transitionDelay: `${i * (wide ? 20 : 80)}ms` }}>
                {i === shown && <span className={`db-tip ${i >= days.length - (wide ? 4 : 1) ? "end" : i < (wide ? 4 : 1) ? "start" : ""}`}>{d.count} completed · {i === days.length - 1 ? "today" : shortDate(d.date)}</span>}
              </b>
              <em>{wide ? (i % 7 === 6 || i === 0 ? shortDate(d.date) : "") : dayName(d.date)}</em>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const PIPE = [
  ["not_started", "Not started yet", "var(--db-todo)"], ["running", "Being worked on", "var(--db-run)"], ["paused", "Paused", "var(--db-pause)"],
  ["on_hold", "On hold or sent back", "var(--db-hold)"], ["pending_approval", "Waiting for your approval", "var(--db-review)"],
  ["awaiting_client", "Waiting for client sign-off", "var(--db-client)"], ["completed_month", "Completed this month", "var(--db-done)"],
];
function Pipeline({ o }) {
  const g = useGrown();
  const p = o?.pipeline;
  const rows = p ? PIPE.map(([k, l, c]) => ({ k, l, c, v: p[k] || 0 })) : [];
  const total = rows.reduce((s, r) => s + r.v, 0) || 1;
  const open = rows.filter((r) => r.k !== "completed_month").reduce((s, r) => s + r.v, 0);
  const shownRows = rows.filter((r) => r.v > 0);
  const gap = shownRows.length > 1 ? 10 : 0;
  const pt = (a) => [150 + 108 * Math.cos(((a - 90) * Math.PI) / 180), 150 + 108 * Math.sin(((a - 90) * Math.PI) / 180)];
  let a0 = gap / 2;
  const segs = shownRows.map((r) => {
    const span = Math.min(359.9, Math.max(4, (r.v / total) * (360 - gap * shownRows.length)));
    const a1 = a0 + span, [x1, y1] = pt(a0), [x2, y2] = pt(a1);
    const d = `M${x1.toFixed(1)} ${y1.toFixed(1)} A108 108 0 ${span > 180 ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    a0 = a1 + gap;
    return { ...r, d };
  });
  return (
    <>
      <div className="db-ttl">Where all tasks stand</div>
      {p && <p className="db-intro">{n0(open)} tasks are still open; {n0(p.completed_month)} were completed this month.</p>}
      {!p ? <Skeleton rows={5} /> : (
        <div className="db-pbody">
          <div className="db-donut">
            <svg viewBox="0 0 300 300" role="img" aria-label="Where all tasks stand">
              {segs.map((s, i) => <path key={s.k} d={s.d} pathLength="1" className="db-seg" stroke={s.c} style={{ strokeDashoffset: g ? 0 : 1, transitionDelay: `${300 + i * 120}ms` }}><title>{`${s.l}: ${s.v}`}</title></path>)}
            </svg>
            <div className="db-center"><div><Count value={open} /></div><small>open tasks</small></div>
          </div>
          <div className="db-plist">{rows.map((r) => <div key={r.k}><i style={{ background: r.c }} /><b title={r.l}>{r.l}</b><span>{n0(r.v)}</span></div>)}</div>
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- deadlines */
function Deadlines({ o }) {
  const d = o?.deadlines;
  const col = (key, title, data, say, empty, tone, extra) => (
    <div className="db-dcol">
      <div className={`db-dhead ${data?.count ? tone : ""}`}><b>{data ? n0(data.count) : "…"}</b>{title}</div>
      <p className="db-say">{data ? (data.count ? say(data.count) : empty) : ""}</p>
      {(data?.rows || []).map((t) => (
        <Link key={t.id} href={`/browse/${t.id}`} className="db-trow">
          <span className="db-tname" title={taskLabel(t)}>{taskLabel(t)}</span>
          <small>{t.person} · {extra(t)}</small>
        </Link>
      ))}
      {data?.count > (data?.rows || []).length && <small className="db-more">+{data.count - data.rows.length} more</small>}
    </div>
  );
  return (
    <>
      <div className="db-ttlrow">
        <div className="db-ttl">Deadlines</div>
        <Link className="db-link" href="/board">Open KPI Actions ›</Link>
      </div>
      <p className="db-intro">Work that is late, due soon, or urgent and not yet begun. Tap a task to open it.</p>
      {!o ? <Skeleton rows={3} /> : !d ? <p className="db-muted">Deadlines could not be read.</p> : (
        <div className="db-dgrid">
          {col("late", "overdue", d.overdue, (n) => `${plural(n, "task")} ${isAre(n)} past the deadline and not finished.`, "No overdue tasks.", "bad", (t) => `${plural(t.days, "day")} late`)}
          {col("soon", "due in the next 7 days", d.due_week, (n) => `${plural(n, "task")} must be finished within a week.`, "Nothing is due in the next 7 days.", "warn", (t) => `due ${shortDate(t.due)}`)}
          {col("urgent", "urgent, not started", d.urgent, (n) => `${plural(n, "urgent task")} ${n === 1 ? "has" : "have"} not been started yet.`, "Every urgent task has been started.", "bad", (t) => `waiting ${plural(t.days, "day")}`)}
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- employees */
/* Live Tracking's roster (presence, current activity) joined with the overview's
   per-person counts. Working people first, then present, then the rest. */
function buildPeople(lt, o) {
  if (!lt) return null;
  const stats = new Map((o?.people || []).map((p) => [p.user_id, p]));
  const rank = (r) => (r.activity_kind === "task" ? 0 : r.started ? 1 : r.attendance === "present" || r.attendance === "late" ? 2 : 3);
  return (lt.rows || []).map((r) => ({ ...r, ...(stats.get(r.user_id) || {}), user_id: r.user_id }))
    .sort((a, b) => rank(a) - rank(b) || (a.name || "").localeCompare(b.name || ""));
}

const ACT = { break: "On a break", lunch: "At lunch", meeting: "In a meeting", no_tasks: "No task to work on", idle: "Idle" };
function PersonRow({ p }) {
  const g = useGrown();
  const status = p.attendance === "present" ? `In since ${p.arrival}` : p.attendance === "late" ? `Late · in at ${p.arrival}` : p.attendance === "absent" ? "Absent today" : "Not in yet";
  const dot = { present: "in", late: "late" }[p.attendance] || "out";
  const tasks = p.active_tasks || [];
  const now = p.activity_kind === "task"
    ? <><b>▶ Working on</b> {tasks.map((t) => t.name).join(", ")}{p.elapsed_seconds ? <span className="db-muted"> · for {mins(p.elapsed_seconds)}</span> : null}</>
    : p.started ? <><b className="pause">⏸ {ACT[p.activity_kind] || p.activity_label || "Paused"}</b>{p.elapsed_seconds ? ` · for ${mins(p.elapsed_seconds)}` : ""}{p.activity_note ? ` · ${p.activity_note}` : ""}</>
    : p.day_done ? <span className="db-muted">Workday ended</span>
    : <span className="db-muted">Has not started the workday</span>;
  const pct = Math.min(100, ((p.productive_today || 0) / (8 * 3600)) * 100);
  const over = p.est_hours > 0 && p.spent_hours > p.est_hours;
  return (
    <tr>
      <td><div className="db-person"><span className="db-ini"><Avatar name={p.name} id={p.user_id} size={30} /><span className={`db-pd ${dot}`} /></span><div>{p.name}<small>{status}</small></div></div></td>
      <td><div className="db-now" title={typeof now === "string" ? now : undefined}>{now}</div></td>
      <td className="db-tasks">
        {p.running > 0 && <span className="db-lz run">{p.running} running</span>}
        {p.paused > 0 && <span className="db-lz pause">{p.paused} paused</span>}
        {p.todo > 0 && <span className="db-lz todo">{p.todo} to do</span>}
        {p.approval > 0 && <span className="db-lz appr">{p.approval} approval</span>}
        <span className="db-lz done" title="Finished in the last 7 days">{p.done_week || 0} done</span>
      </td>
      <td className="num" title="Out of an 8-hour day">{hm(p.productive_today)}<span className="db-hb"><i style={{ width: g ? `${pct}%` : 0 }} /></span></td>
      <td className="num">{hm(p.productive_week)}</td>
      <td className={`num db-est ${over ? "db-over" : ""}`}>{p.est_hours || 0}h estimated<small>{p.spent_hours || 0}h spent{over ? " ▲ over" : ""}</small></td>
    </tr>
  );
}

/* ---------------------------------------------------------------- money + clients */
function Unpaid({ o }) {
  const b = o?.billing;
  const rows = b?.unpaid_rows || [];
  const count = (b?.unpaid || []).reduce((s, x) => s + x.count, 0);
  return (
    <>
      <div className="db-ttlrow">
        <div className="db-ttl">Unpaid invoices</div>
        <Link className="db-link" href="/reports/invoices">Open invoices ›</Link>
      </div>
      <p className="db-intro">{!b ? "" : count ? `${plural(count, "invoice")} not paid yet, ${money(b.unpaid)} in all. Oldest first.` : "Every invoice is paid."}</p>
      {!o ? <Skeleton rows={4} /> : rows.length > 0 && (
        <div className="db-list">{rows.map((r) => (
          <Link key={r.id} href="/reports/invoices" className="db-lrow">
            <span><b>{r.client || "—"}</b><small>{r.name} · sent {shortDate(r.date)}</small></span>
            <span className="db-lr"><b>{amount(r)}</b><small className={r.days > 30 ? "db-over" : ""}>open {plural(r.days, "day")}</small></span>
          </Link>
        ))}</div>
      )}
      {count > rows.length && <small className="db-more">+{count - rows.length} more</small>}
    </>
  );
}

function WaitingOnClients({ o, today }) {
  const w = o?.waiting_on_clients;
  return (
    <>
      <div className="db-ttl">Waiting on clients</div>
      <p className="db-intro">New requests to estimate, and estimates the clients have not answered.</p>
      {!o ? <Skeleton rows={4} /> : !w ? <p className="db-muted">Could not be read.</p> : (
        <>
          <div className="db-subh"><span>New requests</span><Link className="db-link" href="/queue">Open the queue ›</Link></div>
          {!w.queue.length ? <p className="db-muted">No new requests.</p> : <div className="db-list">{w.queue.map((t) => (
            <Link key={t.id} href="/queue" className="db-lrow"><span><b title={taskLabel(t)}>{taskLabel(t)}</b><small>{t.client || "No client"}</small></span><span className="db-lr"><small>{whenLabel(t.date, today)}</small></span></Link>
          ))}</div>}
          <div className="db-subh"><span>Estimates waiting for a reply</span><Link className="db-link" href="/settings/pre-approvals">Open ›</Link></div>
          {!w.pre_approvals.length ? <p className="db-muted">No estimates waiting.</p> : <div className="db-list">{w.pre_approvals.map((t) => (
            <Link key={t.id} href="/settings/pre-approvals" className="db-lrow"><span><b title={taskLabel(t)}>{taskLabel(t)}</b><small>{t.client || "No client"}</small></span>
              <span className="db-lr"><small className={t.overdue ? "db-over" : ""}>{t.reply_by ? `${t.overdue ? "reply was due" : "reply by"} ${shortDate(t.reply_by)}` : "no reply date"}</small></span></Link>
          ))}</div>}
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- areas + alerts */
function areas(o, lt, today) {
  const p = o.pipeline || {}, c = o.clients || {}, a = o.approvals || {}, h = o.hours || {}, b = o.billing || {}, m = o.meetings || {};
  const unpaid = (b.unpaid || []).reduce((s, x) => s + x.count, 0);
  const onBreak = lt ? (lt.rows || []).filter((r) => r.started && r.activity_kind !== "task").length : 0;
  const working = lt ? (lt.rows || []).filter((r) => r.activity_kind === "task").length : 0;
  const prodPct = h.week_presence ? Math.round((h.week_productive / h.week_presence) * 100) : 0;
  const open = (p.not_started || 0) + (p.running || 0) + (p.paused || 0) + (p.on_hold || 0);
  const next = m.upcoming?.[0];
  const wa = o.whatsapp || {};
  const billedNow = money(b.month) || "0";
  return [
    { key: "kpi", title: "KPI Actions", icon: P.board, color: "#1E40AF", href: "/board", num: n0(open), unit: "open tasks",
      text: `${p.running || 0} being worked on now, ${p.paused || 0} paused, ${o.completed?.today ?? 0} finished today.`, status: p.paused > 0 ? "warn" : "ok" },
    { key: "appr", title: "Approvals", icon: P.check, color: "#6D28D9", href: "/approvals", num: n0(a.count), unit: "waiting",
      text: a.count ? `Finished tasks waiting for you to check and approve. The oldest has waited ${plural(a.oldest_days, "day")}.` : "Nothing is waiting for your OK.",
      status: a.oldest_days >= 3 ? "bad" : a.count ? "warn" : "ok" },
    { key: "queue", title: "Client Task Queue", icon: P.queue, color: "#0891B2", href: "/queue", num: n0(c.queue), unit: "new requests",
      text: c.queue ? "New requests from clients need an estimate before work can start." : "No new client requests.", status: c.queue ? "warn" : "ok" },
    { key: "pre", title: "Client Pre-Approvals", icon: P.shield, color: "#0F766E", href: "/settings/pre-approvals", num: n0(c.pre_approvals), unit: "estimates out",
      text: c.pre_approvals ? "Estimates sent to clients. They have not replied yet." : "No estimate is waiting for a client's reply.", status: "ok" },
    { key: "bill", title: "Client Billing", icon: P.cash, color: "#16A34A", href: "/dashboards", num: billedNow, unit: "invoiced this month",
      text: `${(b.prev_month || []).length ? `${money(b.prev_month)} last month. ` : ""}${unpaid ? `${money(b.unpaid)} is still unpaid on ${plural(unpaid, "invoice")}.` : "Every invoice is paid."}`, status: unpaid ? "warn" : "ok" },
    { key: "sign", title: "Client sign-off", icon: P.sign, color: "#0891B2", href: "/dashboards", num: n0(c.signoff_waiting), unit: "waiting",
      text: "Delivered tasks waiting for the client to sign them off.", status: c.signoff_waiting ? "warn" : "ok" },
    { key: "att", title: "Attendance", icon: P.clock, color: "#16A34A", href: "/people/attendance", num: lt ? `${lt.present_count} of ${lt.total}` : "…", unit: "in today",
      text: lt ? `${lt.absent_count} absent and ${lt.late_count} came in late today.` : "Loading…", status: lt && lt.absent_count ? "warn" : "ok" },
    { key: "live", title: "Live Tracking", icon: P.live, color: "#2563EB", href: "/people", num: lt ? String(working) : "…", unit: "working now",
      text: `${plural(working, "person", "people")} on a task right now. ${onBreak} on a break or idle.`, status: "ok" },
    { key: "meet", title: "Meetings", icon: P.cal, color: "#D97706", href: "/meetings", num: n0(m.today), unit: "today",
      text: next ? `Next: ${next.name}, ${whenLabel(next.date, today).toLowerCase()} at ${next.time}.` : "No meetings booked.", status: "ok" },
    { key: "rem", title: "Reminders", icon: P.bell, color: "#DC2626", href: "/reminders", num: o.reminders_today == null ? "—" : n0(o.reminders_today), unit: "due today",
      text: o.reminders_today ? "Reminders set by the team that ring today." : "No reminders ring today.", status: o.reminders_today ? "warn" : "ok" },
    { key: "docs", title: "Documents", icon: P.doc, color: "#1E40AF", href: "/documents", num: o.documents_week == null ? "—" : n0(o.documents_week), unit: "this week",
      text: "Files uploaded to tasks in the last 7 days.", status: "ok" },
    { key: "cert", title: "Certificates", icon: P.cert, color: "#6D28D9", href: "/intake/certificates", num: n0(c.certificates_week), unit: "signed this week",
      text: "Completion certificates signed by clients in the last 7 days.", status: "ok" },
    { key: "rep", title: "Time on tasks", icon: P.chart, color: "#0F766E", href: "/reports/work", num: `${prodPct}%`, unit: "this week",
      text: "Share of the team's signed-in time this week that went on tasks.", status: h.week_presence && prodPct < 50 ? "warn" : "ok" },
    { key: "wa", title: "WhatsApp", icon: P.chat, color: "#16A34A", href: "/settings/whatsapp", num: wa.connected == null ? "—" : wa.connected ? "Connected" : "Not connected", unit: "",
      text: wa.connected === false ? "Messages to clients won't go out until it is connected." : `${plural(wa.client_groups || 0, "client group")} linked.`, status: wa.connected === false ? "bad" : "ok" },
  ];
}

function buildAlerts(o, lt, overQuote) {
  if (!o) return [];
  const out = [];
  const late = o.deadlines?.overdue;
  if (late?.count) out.push({ key: "late", tone: "bad", href: "/board", action: "See overdue tasks",
    title: `${plural(late.count, "task")} ${isAre(late.count)} past the deadline`, text: late.rows?.[0] ? `Most late: ${taskLabel(late.rows[0])} · ${plural(late.rows[0].days, "day")}` : "" });
  const top = overQuote[0];
  if (top) out.push({ key: "quote", tone: "bad", href: "/dashboards", action: "Open Client Billing",
    title: `${top.client_name} has used ${Math.round((top.total_actual_hours / top.total_quoted_hours - 1) * 100)}% more hours than quoted`,
    text: `${Math.round(top.total_actual_hours)}h used of ${Math.round(top.total_quoted_hours)}h quoted${overQuote.length > 1 ? ` · ${overQuote.length - 1} more client${overQuote.length > 2 ? "s" : ""} over quote` : ""}` });
  const a = o.approvals;
  if (a?.count) out.push({ key: "appr", tone: a.oldest_days >= 3 ? "bad" : "rev", href: "/approvals", action: "Approve now",
    title: `${plural(a.count, "finished task")} ${isAre(a.count)} waiting for your approval`, text: `Oldest: ${a.oldest_ref || "a task"}, waiting ${plural(a.oldest_days, "day")}` });
  if (o.doubts_open) out.push({ key: "doubts", tone: "rev", href: "/approvals", action: "Answer",
    title: `${plural(o.doubts_open, "developer question")} ${o.doubts_open === 1 ? "waits" : "wait"} for an answer`, text: "Asked to a manager and not answered yet" });
  const urgent = o.deadlines?.urgent;
  if (urgent?.count) out.push({ key: "urgent", tone: "bad", href: "/board", action: "See urgent tasks",
    title: `${plural(urgent.count, "urgent task")} not started`, text: urgent.rows?.[0] ? taskLabel(urgent.rows[0]) : "" });
  const p = o.paused;
  if (p?.count) out.push({ key: "paused", tone: "warn", href: "/board", action: "See paused tasks",
    title: `${plural(p.count, "task")} ${isAre(p.count)} paused${p.two_days ? `, ${p.two_days} of them for 2 days or more` : ""}`, text: p.top_person ? `Most are with ${p.top_person} (${p.top_count})` : "" });
  if (lt?.absent_count) {
    const names = (lt.rows || []).filter((r) => r.attendance === "absent").map((r) => r.name);
    out.push({ key: "absent", tone: "warn", href: "/people/attendance", action: "See attendance",
      title: `${plural(lt.absent_count, "person", "people")} ${lt.absent_count === 1 ? "has" : "have"} not started the workday`,
      text: names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "") });
  }
  if (o.clients?.queue) out.push({ key: "queue", tone: "rev", href: "/queue", action: "Open the queue",
    title: `${plural(o.clients.queue, "client request")} ${o.clients.queue === 1 ? "needs" : "need"} an estimate`, text: "In the Client Task Queue" });
  return out.slice(0, 5);
}

/* ---------------------------------------------------------------- download */
function reportBlocks(o, lt, people, clientRows, alerts) {
  const h = o.hours || {};
  const blocks = [{ type: "stats", items: [
    { label: "Completed this week", value: o.completed?.week ?? 0 },
    { label: "Completed this month", value: o.completed?.month ?? 0 },
    { label: "Waiting for your approval", value: o.approvals?.count ?? 0 },
    { label: "Client sign-off waiting", value: o.clients?.signoff_waiting ?? 0 },
    { label: "In today", value: lt ? `${lt.present_count} of ${lt.total}` : "-" },
    { label: "Hours on tasks this week", value: `${hours(h.week_productive)}h` },
  ] }];
  if (alerts.length) blocks.push({ type: "list", title: "Needs your attention", items: alerts.map((a) => `${a.title}${a.text ? ` - ${a.text}` : ""}`) });
  const p = o.pipeline || {};
  blocks.push({ type: "table", title: "Where all tasks stand", columns: [{ key: "l", label: "Status" }, { key: "v", label: "Tasks", kind: "num" }],
    rows: PIPE.map(([k, l]) => ({ l, v: p[k] || 0 })) });
  const d = o.deadlines;
  const dl = [...(d?.overdue?.rows || []).map((t) => ({ ...t, kind: "Overdue", when: `${plural(t.days, "day")} late` })),
    ...(d?.due_week?.rows || []).map((t) => ({ ...t, kind: "Due this week", when: shortDate(t.due) })),
    ...(d?.urgent?.rows || []).map((t) => ({ ...t, kind: "Urgent, not started", when: `waiting ${plural(t.days, "day")}` }))];
  if (dl.length) blocks.push({ type: "table", title: "Deadlines", columns: [{ key: "kind", label: "What" }, { key: "task", label: "Task" }, { key: "person", label: "Person" }, { key: "when", label: "When" }],
    rows: dl.map((t) => ({ ...t, task: taskLabel(t) })) });
  if (people?.length) blocks.push({ type: "table", title: "Employees", columns: [
    { key: "name", label: "Person" }, { key: "att", label: "Today" }, { key: "running", label: "Running", kind: "num" }, { key: "paused", label: "Paused", kind: "num" },
    { key: "todo", label: "To do", kind: "num" }, { key: "done_week", label: "Done (7 days)", kind: "num" }, { key: "hrs", label: "Hours today", kind: "num" }, { key: "wk", label: "Hours this week", kind: "num" },
  ], rows: people.map((x) => ({ ...x, att: x.arrival ? `${x.attendance} ${x.arrival}` : x.attendance, hrs: hm(x.productive_today), wk: hm(x.productive_week), running: x.running || 0, paused: x.paused || 0, todo: x.todo || 0, done_week: x.done_week || 0 })) });
  if (clientRows?.length) blocks.push({ type: "table", title: "Clients", columns: [
    { key: "client_name", label: "Client" }, { key: "awaiting_client_count", label: "Waiting sign-off", kind: "num" }, { key: "completed_count", label: "Signed off", kind: "num" },
    { key: "in_progress_count", label: "Open", kind: "num" }, { key: "hrs", label: "Hours used of quoted", kind: "num" },
  ], rows: clientRows.map((c) => ({ ...c, hrs: `${Math.round(c.total_actual_hours)}h of ${Math.round(c.total_quoted_hours)}h` })) });
  const unpaid = o.billing?.unpaid_rows || [];
  if (unpaid.length) blocks.push({ type: "table", title: "Unpaid invoices", columns: [{ key: "name", label: "Invoice" }, { key: "client", label: "Client" }, { key: "amt", label: "Amount", kind: "num" }, { key: "open", label: "Open for" }],
    rows: unpaid.map((r) => ({ ...r, amt: amount(r), open: plural(r.days, "day") })) });
  return blocks;
}

function ReportMenu({ onPick, disabled }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const ref = useOutside(useCallback(() => setOpen(false), []));
  const go = async (kind) => {
    setBusy(kind); setErr("");
    try { await onPick(kind); setOpen(false); } catch (e) { setErr(e.message || "Download failed."); } finally { setBusy(""); }
  };
  return (
    <span className="db-dlwrap" ref={ref}>
      <Button kind="primary" disabled={disabled} onClick={() => setOpen((o) => !o)} aria-expanded={open}><Svg d={P.download} size={14} /> Download report</Button>
      {open && (
        <span className="db-dlmenu" role="menu">
          <button type="button" role="menuitem" disabled={!!busy} onClick={() => go("pdf")}>{busy === "pdf" ? "Preparing…" : "PDF"}</button>
          <button type="button" role="menuitem" disabled={!!busy} onClick={() => go("docx")}>{busy === "docx" ? "Preparing…" : "Word (.docx)"}</button>
          {err && <small className="db-err">{err}</small>}
        </span>
      )}
    </span>
  );
}
